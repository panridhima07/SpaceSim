// Mock imports: every sample .ork and every hand-written edge case goes through the
// same path the app uses (file bytes -> parser -> 3D mesh), and the mesh is measured
// against the model. A dimension fault at any tier fails the run.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import JSZip from 'jszip';
import { parseOrkFile, parseOrkXml, clusterOffsets } from '../ork/parser';
import { readOrkZip } from '../ork/orkExtras';
import { buildRocketMesh, disposeGroup, type RocketMeshOptions } from '../render/rocketMesh';
import { gradeRocket, PART_ICONS, partKey } from '../render/parts/grade';
import { noseRadius } from '../render/parts/profile';
import { PART_TIERS } from '../render/parts/types';
import type { Component, FinSet, InnerTube, NoseCone, Ring, RocketModel, Transition } from '../types';
import { auditRender, measure } from './renderAudit';
import { MOCK_CASES, fins, nose, ork, stage, tube } from './mockOrk';

const NODE_FS = 'node:fs';
const NODE_ZLIB = 'node:zlib';
const fs = (await import(/* @vite-ignore */ NODE_FS)) as unknown as {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string): Uint8Array;
};
const zlib = (await import(/* @vite-ignore */ NODE_ZLIB)) as unknown as { gzipSync(b: Uint8Array): Uint8Array };

const TIER_CHOICES: NonNullable<RocketMeshOptions['tiers']>[] = ['auto', ...PART_TIERS];

/** Faults from building the model at every tier, with and without cutaway. */
function faultsOf(model: RocketModel, tiers = TIER_CHOICES): string[] {
  const out = new Set<string>();
  for (const t of tiers) {
    for (const cutaway of [false, true]) {
      const g = buildRocketMesh(model, { cutaway, tiers: t });
      for (const f of auditRender(model, g, { cutaway })) {
        if (f.level === 'fault') out.add(`[${String(t)}${cutaway ? ' cutaway' : ''}] ${f.code}: ${f.detail}`);
      }
      disposeGroup(g);
    }
  }
  return [...out];
}

function byKind<K extends Component['kind']>(m: RocketModel, kind: K): Extract<Component, { kind: K }>[] {
  return m.components.filter((c) => c.kind === kind) as Extract<Component, { kind: K }>[];
}

const meshesOf = (g: THREE.Object3D, id: string): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name === id) out.push(o as THREE.Mesh); });
  return out;
};

/** Centre of a mesh's bounding box in the rocket frame. */
function centreOf(mesh: THREE.Mesh, root: THREE.Object3D): THREE.Vector3 {
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
}

// ---------- Real OpenRocket files ----------

const FIXTURE_DIRS = ['fixtures/external', 'rocket-viewer/samples'];
const files = FIXTURE_DIRS.flatMap((d) =>
  fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.ork')).map((n) => `${d}/${n}`) : []);

describe.skipIf(files.length === 0)('real .ork files render to their own dimensions', () => {
  for (const path of files) {
    it(path, async () => {
      const { xml } = await readOrkZip(fs.readFileSync(path));
      const model = parseOrkXml(xml);
      expect(model.components.length).toBeGreaterThan(0);
      expect(faultsOf(model)).toEqual([]);
      // Every part has a grade and an icon for it.
      for (const g of gradeRocket(model)) expect(PART_ICONS[g.key][g.tier]).toContain('<svg');
    }, 60_000);
  }
});

// ---------- Mock designs ----------

describe('mock designs', () => {
  for (const c of MOCK_CASES) {
    it(`${c.name}: ${c.probes}`, () => {
      const e = c.expect ?? {};
      if (e.throws) {
        expect(() => parseOrkXml(c.xml)).toThrow();
        return;
      }
      const model = parseOrkXml(c.xml);
      if (e.length !== undefined) expect(model.length).toBeCloseTo(e.length, 6);
      if (e.maxRadius !== undefined) expect(model.maxRadius).toBeCloseTo(e.maxRadius, 9);
      if (e.stageCount !== undefined) expect(model.stageCount).toBe(e.stageCount);
      for (const [k, n] of Object.entries(e.kinds ?? {})) {
        expect(model.components.filter((x) => x.kind === k).length, `${k} count`).toBe(n);
      }
      if (e.warns) expect(model.warnings.join('\n')).toContain(e.warns);

      // No NaN reaches the model (a motor's delay may be NaN by design).
      for (const comp of model.components) {
        for (const [k, v] of Object.entries(comp)) {
          if (typeof v === 'number') expect(Number.isNaN(v), `${comp.kind}.${k}`).toBe(false);
        }
      }
      // Big designs are measured at the automatic tier only, to keep the run short.
      const big = model.components.length > 100;
      expect(faultsOf(model, big ? ['auto'] : TIER_CHOICES)).toEqual([]);
    }, 60_000);
  }
});

// ---------- Things a bounding box cannot see ----------

const one = (name: string): RocketModel => parseOrkXml(MOCK_CASES.find((c) => c.name === name)!.xml);

describe('details carried from the file to the render', () => {
  it('paint colours and finish reach the model and the mesh', () => {
    const m = one('painted');
    const [n] = byKind(m, 'nosecone');
    const [t] = byKind(m, 'bodytube');
    expect(n.color).toBe((10 << 16) | (200 << 8) | 30);
    expect(t.color).toBe(0x0000ff);
    expect(t.finish).toBe('polished');
    const g = buildRocketMesh(m, { tiers: 'ok' });
    const colours = meshesOf(g, t.id).map((x) => (x.material as THREE.MeshStandardMaterial).color.getHex());
    expect(colours).toContain(0x0000ff);
  });

  it('a tail cone is drawn wide end forward', () => {
    const m = one('tail-cone');
    const tail = byKind(m, 'nosecone')[1] as NoseCone;
    expect(tail.flipped).toBe(true);
    expect(tail.baseRadius).toBeCloseTo(0.025, 9);
    const g = buildRocketMesh(m, { tiers: 'best' });
    const fore = measure(g, (x) => x.name === tail.id && centreOf(x, g).y > -(tail.x + tail.length / 2));
    expect(fore.rMax).toBeGreaterThan(0.024);
  });

  it('a curved, clipped transition bulges past the straight cone', () => {
    const m = one('transition-ogive-clipped');
    const [tr] = byKind(m, 'transition') as Transition[];
    expect(tr.shape).toBe('ogive');
    expect(tr.clipped).toBe(true);
    const g = buildRocketMesh(m, { tiers: 'best' });
    const mid = -(tr.x + tr.length / 2);
    let rMid = 0;
    for (const mesh of meshesOf(g, tr.id)) {
      const pos = mesh.geometry.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        if (Math.abs(v.y - mid) < tr.length * 0.03) rMid = Math.max(rMid, Math.hypot(v.x, v.z));
      }
    }
    const straight = (tr.foreRadius + tr.aftRadius) / 2;
    expect(rMid).toBeGreaterThan(straight * 1.05);
    expect(rMid).toBeLessThan(tr.aftRadius);
  });

  it('a secant ogive follows the OpenRocket arc, not the tangent one', () => {
    // R = 25 mm, L = 100 mm, parameter 0.3, at mid-length. Worked by hand from the
    // circle through tip and base whose centre is L/p aft of the tip: 13.67 mm.
    expect(noseRadius('ogive', 0.3, 0.025, 0.1, 0.05) * 1000).toBeCloseTo(13.67, 1);
    // The tangent ogive is fuller there (19.03 mm) and a cone is 12.5 mm.
    expect(noseRadius('ogive', 1, 0.025, 0.1, 0.05) * 1000).toBeCloseTo(19.03, 1);
    expect(noseRadius('ogive', 0, 0.025, 0.1, 0.05) * 1000).toBeCloseTo(12.5, 6);
  });

  it('fins on a taper mount at the radius under their leading edge', () => {
    const m = one('fins-on-transition');
    const [f] = byKind(m, 'finset') as FinSet[];
    // Transition 25 -> 40 mm over 100 mm; fins bottom-mounted, root 80 mm: leading edge 20 mm in.
    expect(f.bodyRadius).toBeCloseTo(0.025 + 0.015 * 0.2, 6);
  });

  it('fin rotation turns the whole set', () => {
    const m = one('fins-rotated');
    const [f] = byKind(m, 'finset') as FinSet[];
    expect(f.angleOffset).toBeCloseTo(Math.PI / 4, 9);
    const g = buildRocketMesh(m, { tiers: 'ok' });
    const angles = meshesOf(g, f.id).map((x) => { const c = centreOf(x, g); return Math.atan2(-c.z, c.x); });
    // No fin lies on the +X axis any more.
    expect(angles.every((a) => Math.abs(Math.sin(2 * a)) > 0.9)).toBe(true);
  });

  it('a launch lug sits on the surface at its angle, once per instance', () => {
    const m = one('launch-lug');
    const [lug] = byKind(m, 'ring') as Ring[];
    expect(lug.ringType).toBe('launchlug');
    expect(lug.mountRadius).toBeCloseTo(0.025, 9);
    expect(lug.angle).toBeCloseTo(Math.PI / 2, 9);
    expect(lug.instanceCount).toBe(2);
    const g = buildRocketMesh(m, { tiers: 'ok' });
    const centres = meshesOf(g, lug.id).map((x) => centreOf(x, g));
    expect(centres.length).toBe(2);
    for (const c of centres) {
      expect(Math.hypot(c.x, c.z)).toBeCloseTo(0.025 + 0.003, 4);
      expect(Math.abs(c.x)).toBeLessThan(1e-4); // 90° from the +X axis
    }
    expect(Math.abs(centres[0].y - centres[1].y)).toBeCloseTo(0.1, 5);
  });

  it('rail buttons come in pairs on the far side of the body', () => {
    const m = one('rail-buttons');
    const [b] = byKind(m, 'ring') as Ring[];
    expect(b.ringType).toBe('railbutton');
    const g = buildRocketMesh(m, { tiers: 'ok' });
    const e = measure(g, (x) => x.name === b.id);
    expect(e.rMin).toBeGreaterThan(0.025 * 0.98);
    expect(e.rMax).toBeLessThan(0.025 + 0.0097 * 1.2);
    expect(e.yMax - e.yMin).toBeCloseTo(0.15 + 0.0097, 3);
  });

  it('a motor cluster draws every motor', () => {
    const m = one('motor-cluster');
    const [mt] = byKind(m, 'innertube') as InnerTube[];
    expect(mt.cluster?.length).toBe(3);
    const g = buildRocketMesh(m, { tiers: 'ok' });
    const e = measure(g, (x) => x.name === mt.id);
    // Three 19 mm tubes in a ring: centres 0.577 diameters out.
    expect(e.rMax).toBeGreaterThan(0.019 * 0.577);
    expect(clusterOffsets('3-ring', 1, 0)![0][0]).toBeCloseTo(0.5774, 3);
    expect(clusterOffsets('single', 1, 0)).toBeUndefined();
    expect(clusterOffsets('7-star', 1, 0)!.length).toBe(7);
  });

  it('a motor that hangs out of the mount lengthens the drawn rocket', () => {
    const m = one('motor-overhang');
    const g = buildRocketMesh(m, { tiers: 'ok' });
    const [mt] = byKind(m, 'innertube');
    expect(-measure(g, (x) => x.name === mt.id).yMin).toBeCloseTo(0.415, 4);
  });

  it('every mesh is named after its component, for picking and highlighting', () => {
    const m = one('baseline');
    const ids = new Set(m.components.map((c) => c.id));
    const g = buildRocketMesh(m, { cutaway: true });
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) expect(ids.has(o.name)).toBe(true); });
  });
});

// ---------- Grading ----------

describe('tier selection', () => {
  const graded = (subs: string): ReturnType<typeof gradeRocket> => gradeRocket(parseOrkXml(ork(stage('S', subs))));

  it('grades the same part differently as its data changes', () => {
    const good = graded(nose({ shape: 'haack', length: 0.25 }) + tube({}, fins({ crosssection: 'airfoil', filletradius: 0.004 })));
    const plain = graded(nose({ length: 0.12 }) + tube({ thickness: 0.0003 }, fins({ crosssection: 'rounded' })));
    const poor = graded(nose({ shape: 'conical', length: 0.04 }) + tube({ radius: 0.03 }, fins({ crosssection: 'square', fincount: 2 })));
    const tierOf = (g: typeof good, key: string): string => g.find((x) => x.key === key)!.tier;
    expect([tierOf(good, 'nosecone'), tierOf(plain, 'nosecone'), tierOf(poor, 'nosecone')]).toEqual(['best', 'ok', 'bad']);
    expect([tierOf(good, 'finset'), tierOf(plain, 'finset'), tierOf(poor, 'finset')]).toEqual(['best', 'ok', 'bad']);
    expect(tierOf(poor, 'bodytube')).toBe('bad'); // 5 mm step behind the nose
    expect(poor.find((x) => x.key === 'bodytube')!.reasons.some((r) => r.text.includes('step'))).toBe(true);
  });

  it('the chosen tier is the one drawn, and can be overridden', () => {
    const m = one('baseline');
    const auto = buildRocketMesh(m);
    const grades = auto.userData.grades as ReturnType<typeof gradeRocket>;
    expect(grades.map((g) => g.tier)).toEqual(gradeRocket(m).map((g) => g.tier));
    const forced = buildRocketMesh(m, { tiers: 'bad' });
    expect((forced.userData.grades as typeof grades).every((g) => g.tier === 'bad')).toBe(true);
    // The three designs really differ: triangle counts are not the same.
    const tri = (t: 'best' | 'ok' | 'bad'): number => measure(buildRocketMesh(m, { tiers: t }), () => true).triangles;
    expect(new Set([tri('best'), tri('ok'), tri('bad')]).size).toBe(3);
  });

  it('every kind has an icon at every tier', () => {
    for (const set of Object.values(PART_ICONS)) {
      for (const t of PART_TIERS) expect(set[t].startsWith('<svg')).toBe(true);
    }
    for (const c of one('missing-fields').components) expect(PART_ICONS[partKey(c)]).toBeDefined();
  });
});

// ---------- File containers ----------

describe('file containers', () => {
  const xml = ork(stage('S', nose() + tube({}, fins())));
  const utf8 = new TextEncoder().encode(xml);

  it('plain XML', async () => {
    expect((await parseOrkFile(utf8)).length).toBeCloseTo(0.4, 6);
  });

  it('zip with rocket.ork, and zip with a differently named .ork', async () => {
    for (const name of ['rocket.ork', 'My Design.ork']) {
      const zip = new JSZip();
      zip.file(name, xml);
      const bytes = await zip.generateAsync({ type: 'uint8array' });
      expect((await parseOrkFile(bytes)).length).toBeCloseTo(0.4, 6);
      expect(parseOrkXml((await readOrkZip(bytes)).xml).length).toBeCloseTo(0.4, 6);
    }
  });

  it('gzip-compressed XML (OpenRocket 1.0 and 1.1 files)', async () => {
    const gz = zlib.gzipSync(utf8);
    expect((await parseOrkFile(gz)).length).toBeCloseTo(0.4, 6);
    expect(parseOrkXml((await readOrkZip(gz)).xml).length).toBeCloseTo(0.4, 6);
  });

  it('UTF-16 with a byte-order mark', async () => {
    const body = xml.replace('UTF-8', 'UTF-16');
    const bytes = new Uint8Array(2 + body.length * 2);
    bytes[0] = 0xff; bytes[1] = 0xfe;
    for (let i = 0; i < body.length; i++) {
      bytes[2 + i * 2] = body.charCodeAt(i) & 0xff;
      bytes[3 + i * 2] = body.charCodeAt(i) >> 8;
    }
    expect((await parseOrkFile(bytes)).length).toBeCloseTo(0.4, 6);
  });

  it('a zip with no design inside, and a corrupt zip, fail with a message', async () => {
    const zip = new JSZip();
    zip.file('notes.txt', 'hello');
    await expect(readOrkZip(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/rocket\.ork/);
    await expect(readOrkZip(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9]))).rejects.toThrow(/damaged/);
  });
});

// ---------- Speed ----------

describe('speed', () => {
  it('a 460-part design parses and builds in well under a second per view', () => {
    const xml = MOCK_CASES.find((c) => c.name === 'many-parts')!.xml;
    const t0 = performance.now();
    const m = parseOrkXml(xml);
    const t1 = performance.now();
    const g = buildRocketMesh(m);
    const t2 = performance.now();
    const tris = measure(g, () => true).triangles;
    console.log(`many-parts: parse ${(t1 - t0).toFixed(0)} ms, build ${(t2 - t1).toFixed(0)} ms, ${tris} triangles`);
    expect(t2 - t1).toBeLessThan(1500);
    expect(tris).toBeLessThan(400_000);
  });
});

// ---------- Bodies beside the main stack ----------

describe('boosters, pods and tube fins', () => {
  it('two boosters rest on the body surface, at the bottom', () => {
    const m = one('strap-on-boosters');
    const [sb] = m.sideBodies!;
    expect(sb.type).toBe('booster');
    expect(sb.count).toBe(2);
    expect(sb.radialOffset).toBeCloseTo(0.025 + 0.012, 9); // surfaces touching
    const [n, t] = sb.components;
    expect(n.x).toBeCloseTo(0.4 - 0.19, 9); // 40 + 150 mm stack, aft ends level
    expect(t.x + t.length).toBeCloseTo(0.4, 9);
    // The main stack is untouched: boosters do not lengthen or widen it.
    expect(m.length).toBeCloseTo(0.4, 9);
    expect(m.maxRadius).toBeCloseTo(0.025, 9);
    const g = buildRocketMesh(m, { tiers: 'ok' });
    const e = measure(g, (x) => x.name === t.id);
    expect(e.rMax).toBeCloseTo(0.025 + 0.024, 4);
    expect(e.rMin).toBeCloseTo(0.025, 4);
  });

  it('boosters keep their gap, angle, fins and motors, and hang below the body', () => {
    const m = one('boosters-with-fins-and-gap');
    const [sb] = m.sideBodies!;
    expect(sb.count).toBe(4);
    expect(sb.radialOffset).toBeCloseTo(0.025 + 0.012 + 0.005, 9);
    expect(sb.angle).toBeCloseTo(Math.PI / 4, 9);
    expect(sb.components.map((c) => c.kind)).toEqual(['nosecone', 'bodytube', 'finset', 'innertube']);
    expect((sb.components[0] as NoseCone).baseRadius).toBeCloseTo(0.012, 9); // automatic, from its tube
    const g = buildRocketMesh(m, { tiers: 'ok' });
    // Aft end 30 mm below the main body.
    expect(-measure(g, (x) => x.name === sb.components[1].id).yMin).toBeCloseTo(0.43, 4);
    // No booster sits on the +X axis: they are turned 45°.
    const centres = meshesOf(g, sb.components[1].id).map((x) => x.getWorldPosition(new THREE.Vector3()));
    expect(centres.length).toBe(4);
    for (const c of centres) expect(Math.abs(Math.abs(c.x) - Math.abs(c.z))).toBeLessThan(1e-5);
    // Booster fins are graded and drawn too.
    expect(gradeRocket(m).some((x) => x.name.startsWith('Strap-ons: ') && x.key === 'finset')).toBe(true);
    expect(meshesOf(g, sb.components[2].id).length).toBeGreaterThanOrEqual(12);
  });

  it('pods at a fixed radius sit where the file says', () => {
    const m = one('pods-free-radius');
    expect(m.sideBodies!.length).toBe(1);
    const [sb] = m.sideBodies!;
    expect(sb.type).toBe('pod');
    expect(sb.radialOffset).toBeCloseTo(0.08, 9);
    expect(sb.components[0].x).toBeCloseTo(0.1 + 0.05, 9);
  });

  it('tube fins lie against the body, and an automatic radius makes them touch', () => {
    const fixed = one('tube-fins').sideBodies![0];
    expect(fixed.type).toBe('tubefin');
    expect(fixed.count).toBe(6);
    expect(fixed.radialOffset).toBeCloseTo(0.025 + 0.0125, 9);
    const auto = one('tube-fins-auto').sideBodies![0];
    const r = (auto.components[0] as { outerRadius: number }).outerRadius;
    // Six equal tubes around a tube all touch when they are the same size as it.
    expect(r).toBeCloseTo(0.025, 9);
    expect(2 * auto.radialOffset * Math.sin(Math.PI / 6)).toBeCloseTo(2 * r, 9);
  });

  it('side bodies survive a trip through the builder', async () => {
    const { fromRocketModel, toRocketModel } = await import('../builder/design');
    const m = one('strap-on-boosters');
    const back = toRocketModel(fromRocketModel(m));
    expect(back.sideBodies?.[0].count).toBe(2);
    expect(faultsOf(back, ['auto'])).toEqual([]);
  });
});
