import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { FinSet, NoseCone, NoseShape, Transition } from '../../types';
import { AERO_ICONS, buildFin, buildNoseCone, buildTransition } from './aero';
import { PART_TIERS, type PartContext, type PartTier } from './types';

const ctx: PartContext = { cutaway: false, maxRadius: 0.03, rocketLength: 1.2 };
const R = 0.03;

const nose = (over: Partial<NoseCone> = {}): NoseCone => ({
  kind: 'nosecone', id: 'nose1', name: 'Nose', x: 0, length: 0.2, density: 0,
  shape: 'ogive', shapeParam: 1, baseRadius: R, thickness: 0, ...over,
});
const trans = (over: Partial<Transition> = {}): Transition => ({
  kind: 'transition', id: 'tr1', name: 'Transition', x: 0.5, length: 0.1, density: 0,
  foreRadius: 0.03, aftRadius: 0.05, thickness: 0, ...over,
});
const fin = (over: Partial<FinSet> = {}): FinSet => ({
  kind: 'finset', id: 'fin1', name: 'Fins', x: 0.7, length: 0.12, density: 0,
  count: 3, rootChord: 0.12, tipChord: 0.05, span: 0.08, sweepLength: 0.06,
  thickness: 0.003, cant: 0, bodyRadius: R, finShape: 'trapezoid', ...over,
});

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((n) => {
    if ((n as THREE.Mesh).isMesh) out.push(n as THREE.Mesh);
  });
  return out;
}

function verts(o: THREE.Object3D): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const m of meshes(o)) {
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i));
  }
  return out;
}

function tris(o: THREE.Object3D): number {
  let n = 0;
  for (const m of meshes(o)) {
    const g = m.geometry;
    n += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  }
  return n;
}

function noNaN(o: THREE.Object3D): void {
  for (const m of meshes(o)) {
    const a = m.geometry.getAttribute('position').array;
    for (let i = 0; i < a.length; i++) expect(Number.isFinite(a[i])).toBe(true);
  }
}

function mainColor(o: THREE.Object3D, name: string): number {
  const m = meshes(o).find((x) => x.name === name)!;
  return (m.material as THREE.MeshStandardMaterial).color.getHex();
}

const shapes: [NoseShape, number][] = [
  ['conical', 0], ['ogive', 1], ['ogive', 0.5], ['ellipsoid', 0], ['power', 0.5], ['parabolic', 0.5], ['haack', 0],
];

function checkRevolved(o: THREE.Object3D, yMin: number, yMax: number, radius: number): void {
  const v = verts(o);
  noNaN(o);
  const box = new THREE.Box3().setFromObject(o);
  const L = yMax - yMin;
  expect(Math.abs(box.min.y - yMin)).toBeLessThanOrEqual(1e-6 * L);
  expect(Math.abs(box.max.y - yMax)).toBeLessThanOrEqual(1e-6 * L);
  const rmax = Math.max(...v.map((p) => Math.hypot(p.x, p.z)));
  expect(Math.abs(rmax - radius)).toBeLessThanOrEqual(0.005 * radius);
}

describe('nose cone', () => {
  for (const tier of PART_TIERS) {
    for (const [shape, shapeParam] of shapes) {
      it(`${tier} ${shape} keeps the outline`, () => {
        const c = nose({ shape, shapeParam, x: 0.1 });
        const o = buildNoseCone(c, tier, ctx);
        checkRevolved(o, -(0.1 + 0.2), -0.1, R);
        expect(tris(o)).toBeLessThanOrEqual(12000);
      });
    }
    it(`${tier} colour override reaches the shell`, () => {
      expect(mainColor(buildNoseCone(nose({ color: 0x4da3ff }), tier, ctx), 'shell')).toBe(0x4da3ff);
    });
    it(`${tier} flipped nose is wide end forward`, () => {
      const o = buildNoseCone(nose({ flipped: true, x: 0.3 }), tier, ctx);
      checkRevolved(o, -0.5, -0.3, R);
      const v = verts(o);
      const mid = -0.4;
      const fore = Math.max(...v.filter((p) => p.y > mid).map((p) => Math.hypot(p.x, p.z)));
      const aft = Math.max(...v.filter((p) => p.y < mid).map((p) => Math.hypot(p.x, p.z)));
      expect(fore).toBeGreaterThan(aft);
      const tip = Math.min(...v.filter((p) => p.y < -0.499).map((p) => Math.hypot(p.x, p.z)));
      expect(tip).toBeLessThan(1e-6);
    });
  }
  it('cutaway makes the shell transparent', () => {
    const o = buildNoseCone(nose(), 'best', { ...ctx, cutaway: true });
    const m = meshes(o).find((x) => x.name === 'shell')!.material as THREE.MeshStandardMaterial;
    expect(m.transparent).toBe(true);
  });
  it('is deterministic', () => {
    const a = verts(buildNoseCone(nose(), 'bad', ctx));
    const b = verts(buildNoseCone(nose(), 'bad', ctx));
    expect(a.length).toBe(b.length);
    expect(a.every((p, i) => p.equals(b[i]))).toBe(true);
  });
});

describe('transition', () => {
  const cases: Partial<Transition>[] = [
    {},
    { foreRadius: 0.05, aftRadius: 0.03 },
    { shape: 'ogive', shapeParam: 1 },
    { shape: 'haack', shapeParam: 0, clipped: true },
    { shape: 'ellipsoid', shapeParam: 0, foreRadius: 0.05, aftRadius: 0.02 },
  ];
  for (const tier of PART_TIERS) {
    cases.forEach((over, i) => {
      it(`${tier} case ${i} keeps the outline`, () => {
        const c = trans(over);
        const o = buildTransition(c, tier, ctx);
        checkRevolved(o, -(0.5 + 0.1), -0.5, Math.max(c.foreRadius, c.aftRadius));
        expect(tris(o)).toBeLessThanOrEqual(12000);
      });
    });
    it(`${tier} colour override reaches the shell`, () => {
      expect(mainColor(buildTransition(trans({ color: 0x123456 }), tier, ctx), 'shell')).toBe(0x123456);
    });
  }
});

describe('fin', () => {
  const variants: [string, Partial<FinSet>][] = [
    ['trapezoid', {}],
    ['elliptical', { finShape: 'elliptical' }],
    ['freeform', { finShape: 'freeform', points: [[0, 0], [0.07, 0.08], [0.11, 0.08], [0.12, 0]] }],
    ['square section', { crossSection: 'square' }],
    ['rounded section', { crossSection: 'rounded' }],
    ['airfoil section', { crossSection: 'airfoil' }],
    ['freeform without points', { finShape: 'freeform' }],
    ['freeform two points', { finShape: 'freeform', points: [[0, 0], [0.1, 0.1]] }],
    ['canted', { cant: 0.1 }],
    ['fillet radius', { filletRadius: 0.002 }],
  ];
  for (const tier of PART_TIERS) {
    for (const [name, over] of variants) {
      it(`${tier} ${name}`, () => {
        const c = fin(over);
        const o = buildFin(c, tier, ctx);
        noNaN(o);
        expect(tris(o)).toBeLessThanOrEqual(3000);
        const f = meshes(o).find((m) => m.name === 'fin')!;
        expect(f).toBeDefined();
        if (c.cant) return;
        const fb = new THREE.Box3().setFromObject(f);
        // thickness at its thickest
        expect(Math.abs(fb.max.z - fb.min.z - c.thickness)).toBeLessThan(1e-6);
        // span and chord
        expect(Math.abs(fb.max.x - (R + c.span))).toBeLessThan(1e-6);
        expect(Math.abs(fb.max.y - -c.x)).toBeLessThan(1e-6);
        expect(Math.abs(fb.min.y - -(c.x + c.rootChord))).toBeLessThan(1e-6);
        // detail stays within 1.5% of the body radius
        const all = new THREE.Box3().setFromObject(o);
        expect(all.max.z).toBeLessThanOrEqual(c.thickness / 2 + 0.015 * R + 1e-6);
        expect(all.min.x).toBeGreaterThanOrEqual(R - 0.015 * R - 1e-6);
        expect(all.max.y).toBeLessThanOrEqual(-c.x + 1e-6);
        expect(all.min.y).toBeGreaterThanOrEqual(-(c.x + c.rootChord) - 1e-6);
      });
    }
    it(`${tier} colour override reaches the fin`, () => {
      expect(mainColor(buildFin(fin({ color: 0x00ff88 }), tier, ctx), 'fin')).toBe(0x00ff88);
    });
  }
  it('best tier has a root fillet, bad tier has glue blobs', () => {
    expect(meshes(buildFin(fin(), 'best', ctx)).some((m) => m.name === 'fillet')).toBe(true);
    expect(meshes(buildFin(fin(), 'bad', ctx)).some((m) => m.name === 'glue')).toBe(true);
    // A kit fin: the fin, its sanded edges and one glue bead, and nothing cruder or finer.
    const ok = meshes(buildFin(fin(), 'ok', ctx)).map((m) => m.name).sort();
    expect(ok).toEqual(['bead', 'edge', 'fin']);
  });
  it('survives a self-intersecting freeform outline', () => {
    const c = fin({ finShape: 'freeform', points: [[0, 0], [0.1, 0.08], [0.0, 0.08], [0.1, 0], [0.05, 0.04]] });
    for (const tier of PART_TIERS) noNaN(buildFin(c, tier, ctx));
  });
});

const finishOf = (m: THREE.Mesh) => (m.material as THREE.MeshStandardMaterial).userData.finish;
const named = (o: THREE.Object3D, n: string) => meshes(o).filter((m) => m.name === n);

describe('surface detail', () => {
  it('skins carry the tier finish', () => {
    const want: Record<PartTier, string> = { best: 'gloss', ok: 'satin', bad: 'matte' };
    for (const tier of PART_TIERS) {
      expect(finishOf(named(buildNoseCone(nose(), tier, ctx), 'shell')[0])).toBe(want[tier]);
      expect(finishOf(named(buildTransition(trans(), tier, ctx), 'shell')[0])).toBe(want[tier]);
      expect(finishOf(named(buildFin(fin(), tier, ctx), 'fin')[0])).toBe(want[tier]);
    }
  });
  it('ok nose has seams, a joint shadow and a shoulder band; best nose has vents and metal tip', () => {
    const ok = buildNoseCone(nose(), 'ok', ctx);
    const n = 1;
    expect(named(ok, 'seam').length).toBe(n);
    expect(named(ok, 'joint').length).toBe(n);
    expect(named(ok, 'shoulder').length).toBe(n);
    const best = buildNoseCone(nose(), 'best', ctx);
    expect(named(best, 'vent').length).toBe(1);
    expect(finishOf(named(best, 'tipcap')[0])).toBe('metal');
    expect(finishOf(named(best, 'band')[0])).toBe('gloss');
  });
  it('flipped ok nose puts the shadow line at the wide (fore) end', () => {
    const o = buildNoseCone(nose({ flipped: true, x: 0.3 }), 'ok', ctx);
    const box = new THREE.Box3().setFromObject(named(o, 'joint')[0]);
    expect(box.max.y).toBeCloseTo(-0.3, 6);
  });
  it('ok transition has joint lines and shoulders at both ends; best has screws', () => {
    const ok = buildTransition(trans(), 'ok', ctx);
    const box = new THREE.Box3().setFromObject(named(ok, 'joint')[0]);
    expect(box.max.y).toBeCloseTo(-0.5, 6);
    expect(box.min.y).toBeCloseTo(-0.6, 6);
    expect(named(ok, 'shoulder').length).toBe(1);
    const best = buildTransition(trans(), 'best', ctx);
    expect(named(best, 'screws').length).toBe(2);
    expect(finishOf(named(best, 'screws')[0])).toBe('metal');
  });
  it('bad nose has putty and scratches', () => {
    const o = buildNoseCone(nose(), 'bad', ctx);
    expect(named(o, 'putty').length).toBeGreaterThan(0);
    expect(named(o, 'scratch').length).toBe(1);
  });
  it('fin edges: best and bad have edge strips, ok stays a single mesh', () => {
    expect(named(buildFin(fin(), 'best', ctx), 'edge').length).toBe(1);
    expect(named(buildFin(fin(), 'bad', ctx), 'edge').length).toBe(1);
    expect(named(buildFin(fin(), 'bad', ctx), 'grain').length).toBeLessThanOrEqual(1);
    for (const finShape of ['elliptical', 'freeform'] as const) {
      const o = buildFin(fin({ finShape, points: [[0, 0], [0.07, 0.08], [0.11, 0.08], [0.12, 0]] }), 'best', ctx);
      noNaN(o);
    }
  });
  it('mesh counts stay within budget', () => {
    const base = { best: [5, 5, 3], ok: [1, 1, 1], bad: [6, 6, 12] } as const;
    const extra = { best: [8, 8, 4], ok: [5, 5, 2], bad: [6, 6, 4] } as const;
    for (const tier of PART_TIERS) {
      const n = meshes(buildNoseCone(nose(), tier, ctx)).length;
      const t = meshes(buildTransition(trans(), tier, ctx)).length;
      const f = meshes(buildFin(fin(), tier, ctx)).length;
      expect(n).toBeLessThanOrEqual(base[tier][0] + extra[tier][0]);
      expect(t).toBeLessThanOrEqual(base[tier][1] + extra[tier][1]);
      expect(f).toBeLessThanOrEqual(base[tier][2] + extra[tier][2]);
    }
  });
});

describe('degenerate input', () => {
  const bad = [0, -1, NaN, Infinity];
  for (const tier of PART_TIERS) {
    it(`${tier} returns empty groups and never throws`, () => {
      for (const v of bad) {
        for (const o of [
          buildNoseCone(nose({ length: v }), tier, ctx),
          buildNoseCone(nose({ baseRadius: v }), tier, ctx),
          buildNoseCone(nose({ x: v }), tier, ctx),
          buildTransition(trans({ length: v }), tier, ctx),
          buildTransition(trans({ foreRadius: v, aftRadius: v }), tier, ctx),
          buildFin(fin({ span: v }), tier, ctx),
          buildFin(fin({ rootChord: v }), tier, ctx),
          buildFin(fin({ thickness: v }), tier, ctx),
          buildFin(fin({ count: v }), tier, ctx),
          buildFin(fin({ bodyRadius: v }), tier, ctx),
        ]) {
          expect(o).toBeInstanceOf(THREE.Group);
          noNaN(o);
        }
      }
      expect(meshes(buildNoseCone(nose({ length: 0 }), tier, ctx)).length).toBe(0);
      expect(meshes(buildFin(fin({ span: NaN }), tier, ctx)).length).toBe(0);
      expect(() => buildFin(fin({ tipChord: NaN, sweepLength: NaN }), tier, ctx)).not.toThrow();
    });
  }
});

describe('icons', () => {
  for (const kind of ['nosecone', 'transition', 'finset'] as const) {
    for (const tier of PART_TIERS as readonly PartTier[]) {
      it(`${kind} ${tier}`, () => {
        const s = AERO_ICONS[kind][tier];
        expect(s.startsWith('<svg')).toBe(true);
        expect(s).toContain('viewBox="0 0 48 48"');
        expect(s).toContain('xmlns="http://www.w3.org/2000/svg"');
        expect(s).toContain('currentColor');
        expect(s).not.toMatch(/<script|<text|href=/);
        expect(s.endsWith('</svg>')).toBe(true);
      });
    }
  }
  it('tiers differ', () => {
    for (const kind of ['nosecone', 'transition', 'finset'] as const) {
      expect(new Set(PART_TIERS.map((t) => AERO_ICONS[kind][t])).size).toBe(3);
    }
  });
});
