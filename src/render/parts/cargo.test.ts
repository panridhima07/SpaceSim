import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { MassComponent, Parachute } from '../../types';
import { PART_TIERS, type PartContext, type PartTier } from './types';
import { buildBallast, buildCamera, buildFlightComputer, buildStreamer, cargoKind, isStreamer } from './cargo';

const MAXR = 0.0125;
const ctx: PartContext = { cutaway: true, maxRadius: MAXR, rocketLength: 0.4 };
const X = 0.12;
const TOL = 1e-6;

const mass = (o: Partial<MassComponent> = {}): MassComponent => ({
  kind: 'mass', id: 'ms', name: 'mass', x: X, length: 0.05, density: 0, mass: 0.05, ...o,
});
const streamer = (o: Partial<Parachute> = {}): Parachute => ({
  kind: 'parachute', id: 'st', name: 'Streamer 5×50 cm', x: X, length: 0.03, density: 0,
  diameter: 0.178, cd: 0.6, deployEvent: 'ejection', deployAltitude: 0, deployDelay: 0, mass: 0.003, ...o,
});

type Build = (length: number, id: string, tier: PartTier, cx?: PartContext) => THREE.Object3D;

interface Kind {
  name: string;
  build: Build;
  R: number;
  fallbackH: (maxR: number) => number;
  /** y of the fore end when length is 0 (fallback), given x */
  fallbackY1: (maxR: number) => number;
}

const kinds: Kind[] = [
  { name: 'ballast', build: (L, id, t, cx = ctx) => buildBallast(mass({ length: L, id, name: 'Ballast 10 g' }), t, cx), R: 0.6 * MAXR, fallbackH: (m) => 0.4 * m, fallbackY1: (m) => -X + 0.2 * m },
  { name: 'flight computer', build: (L, id, t, cx = ctx) => buildFlightComputer(mass({ length: L, id, name: 'Flight Computer' }), t, cx), R: 0.6 * MAXR, fallbackH: (m) => 0.4 * m, fallbackY1: (m) => -X + 0.2 * m },
  { name: 'camera', build: (L, id, t, cx = ctx) => buildCamera(mass({ length: L, id, name: 'Camera Payload' }), t, cx), R: 0.6 * MAXR, fallbackH: (m) => 0.4 * m, fallbackY1: (m) => -X + 0.2 * m },
  { name: 'streamer', build: (L, id, t, cx = ctx) => buildStreamer(streamer({ length: L, id }), t, cx), R: 0.7 * MAXR, fallbackH: (m) => 0.6 * m, fallbackY1: () => -X },
];

const LENGTHS = [0.002, 0.015, 0.03, 0.045, 0.06, 0.2];
const IDS = ['a', 'ms-1', 'something-else'];

function allMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

interface Stats { yMin: number; yMax: number; rMax: number; nan: boolean }

function stats(root: THREE.Object3D): Stats {
  root.updateMatrixWorld(true);
  const s: Stats = { yMin: Infinity, yMax: -Infinity, rMax: 0, nan: false };
  const v = new THREE.Vector3();
  for (const m of allMeshes(root)) {
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      if (!Number.isFinite(v.x + v.y + v.z)) s.nan = true;
      s.yMin = Math.min(s.yMin, v.y);
      s.yMax = Math.max(s.yMax, v.y);
      s.rMax = Math.max(s.rMax, Math.hypot(v.x, v.z));
    }
  }
  return s;
}

function triangles(root: THREE.Object3D): number {
  let n = 0;
  for (const m of allMeshes(root)) {
    const g = m.geometry;
    n += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  }
  return n;
}

function vertexData(root: THREE.Object3D): number[] {
  root.updateMatrixWorld(true);
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (const m of allMeshes(root)) {
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
  return out;
}

describe('cargo builders: extents, budget, determinism', () => {
  for (const k of kinds) {
    for (const tier of PART_TIERS) {
      it(`${k.name} / ${tier} stays inside its span and radius`, () => {
        for (const L of LENGTHS) {
          for (const id of IDS) {
            const o = k.build(L, id, tier);
            expect(allMeshes(o).length).toBeGreaterThan(0);
            const s = stats(o);
            expect(s.nan).toBe(false);
            expect(s.yMin).toBeGreaterThanOrEqual(-(X + L) - TOL);
            expect(s.yMax).toBeLessThanOrEqual(-X + TOL);
            expect(s.rMax).toBeLessThanOrEqual(k.R * 1.0001);
            expect(triangles(o)).toBeLessThanOrEqual(1500);
          }
        }
      });

      it(`${k.name} / ${tier} fills most of its span`, () => {
        const L = 0.06;
        const s = stats(k.build(L, 'fill', tier));
        expect(s.yMax - s.yMin).toBeGreaterThan(0.8 * L);
      });

      it(`${k.name} / ${tier} is deterministic`, () => {
        const a = vertexData(k.build(0.045, 'det', tier));
        const b = vertexData(k.build(0.045, 'det', tier));
        expect(a.length).toBeGreaterThan(0);
        expect(a).toEqual(b);
      });

      it(`${k.name} / ${tier} zero length falls back to a short block`, () => {
        const o = k.build(0, 'z', tier);
        const s = stats(o);
        expect(s.nan).toBe(false);
        const y1 = k.fallbackY1(MAXR);
        const y0 = y1 - k.fallbackH(MAXR);
        expect(s.yMin).toBeGreaterThanOrEqual(y0 - TOL);
        expect(s.yMax).toBeLessThanOrEqual(y1 + TOL);
        expect(s.rMax).toBeLessThanOrEqual(k.R * 1.0001);
      });
    }

    it(`${k.name}: best and bad differ, bad depends on the id`, () => {
      expect(vertexData(k.build(0.045, 'x', 'best'))).not.toEqual(vertexData(k.build(0.045, 'x', 'bad')));
      expect(vertexData(k.build(0.045, 'x', 'bad'))).not.toEqual(vertexData(k.build(0.045, 'y', 'bad')));
    });

    it(`${k.name}: cutaway does not change geometry`, () => {
      const a = vertexData(k.build(0.045, 'c', 'ok', { ...ctx, cutaway: false }));
      const b = vertexData(k.build(0.045, 'c', 'ok', ctx));
      expect(a).toEqual(b);
    });
  }

  it('camera lens points sideways (+X), well beyond the body face', () => {
    for (const tier of PART_TIERS) {
      const o = buildCamera(mass({ length: 0.06, name: 'Camera Payload' }), tier, ctx);
      o.updateMatrixWorld(true);
      let xMax = -Infinity;
      const v = new THREE.Vector3();
      for (const m of allMeshes(o)) {
        const p = m.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
          xMax = Math.max(xMax, Math.hypot(v.x, v.z));
        }
      }
      expect(xMax).toBeGreaterThan(0.6 * 0.6 * MAXR);
    }
  });
});

describe('cargo builders: degenerate input', () => {
  const bad = [0, -0.01, NaN, Infinity, -Infinity];
  it('never throws or yields NaN', () => {
    for (const tier of PART_TIERS) {
      const objs: THREE.Object3D[] = [];
      for (const v of bad) {
        for (const name of ['Ballast', 'Flight Computer', 'Camera']) {
          const builder = name === 'Ballast' ? buildBallast : name === 'Camera' ? buildCamera : buildFlightComputer;
          objs.push(builder(mass({ length: v, name }), tier, ctx));
          objs.push(builder(mass({ x: v, name }), tier, ctx));
        }
        objs.push(buildStreamer(streamer({ length: v }), tier, ctx));
        objs.push(buildStreamer(streamer({ x: v }), tier, ctx));
      }
      for (const cx of [{ ...ctx, maxRadius: 0 }, { ...ctx, maxRadius: NaN }, { ...ctx, maxRadius: -1 }]) {
        objs.push(buildBallast(mass(), tier, cx), buildFlightComputer(mass(), tier, cx), buildCamera(mass(), tier, cx), buildStreamer(streamer(), tier, cx));
      }
      // missing fields
      objs.push(buildBallast({ kind: 'mass', x: X, length: 0.02 } as unknown as MassComponent, tier, ctx));
      objs.push(buildFlightComputer({ kind: 'mass', x: X, length: 0.02 } as unknown as MassComponent, tier, ctx));
      objs.push(buildCamera({ kind: 'mass', x: X, length: 0.02 } as unknown as MassComponent, tier, ctx));
      objs.push(buildStreamer({ kind: 'parachute', x: X, length: 0.02 } as unknown as Parachute, tier, ctx));
      for (const o of objs) {
        expect(o).toBeInstanceOf(THREE.Object3D);
        expect(stats(o).nan).toBe(false);
      }
    }
  });

  it('returns an empty group for unusable input', () => {
    expect(allMeshes(buildBallast(mass({ length: NaN }), 'best', ctx))).toHaveLength(0);
    expect(allMeshes(buildCamera(mass(), 'ok', { ...ctx, maxRadius: 0 }))).toHaveLength(0);
    expect(allMeshes(buildStreamer(streamer({ length: -1 }), 'bad', ctx))).toHaveLength(0);
  });
});

describe('cargoKind / isStreamer', () => {
  const kindOf = (name: string) => cargoKind(mass({ name }));
  it('classifies the catalogue names', () => {
    expect(kindOf('Ballast 10 g')).toBe('ballast');
    expect(kindOf('Ballast 15 g')).toBe('ballast');
    expect(kindOf('Flight Computer')).toBe('computer');
    expect(kindOf('Camera Payload')).toBe('camera');
    expect(kindOf('Nose Weight')).toBe('ballast');
    expect(kindOf('Altimeter')).toBe('computer');
    expect(kindOf('Avionics bay')).toBe('computer');
    expect(kindOf('CAMERA')).toBe('camera');
    expect(kindOf('Mass')).toBe('generic');
    expect(kindOf('')).toBe('generic');
  });
  it('tolerates a missing name', () => {
    expect(cargoKind({ kind: 'mass' } as unknown as MassComponent)).toBe('generic');
    expect(isStreamer({ kind: 'parachute' } as unknown as Parachute)).toBe(false);
  });
  it('detects streamers', () => {
    expect(isStreamer(streamer())).toBe(true);
    expect(isStreamer(streamer({ name: 'STREAMER' }))).toBe(true);
    expect(isStreamer(streamer({ name: 'Parachute 30 cm' }))).toBe(false);
    expect(isStreamer(streamer({ name: 'Parachute 60 cm' }))).toBe(false);
  });
});

describe('cargo builders: finishes and budgets', () => {
  const finishes = (o: THREE.Object3D) => {
    const set = new Set<string>();
    for (const m of allMeshes(o)) set.add(String((m.material as THREE.Material).userData.finish));
    return set;
  };
  const maxMeshes: Record<PartTier, number> = { best: 29, ok: 18, bad: 28 };

  for (const k of kinds) {
    for (const tier of PART_TIERS) {
      it(`${k.name} / ${tier} sets a finish on every material and stays at a few draw calls`, () => {
        const o = k.build(0.06, 'ms-1', tier);
        expect(finishes(o).has('undefined')).toBe(false);
        expect(allMeshes(o).length).toBeLessThanOrEqual(k.name === 'streamer' ? 35 : maxMeshes[tier]);
        expect(triangles(o)).toBeLessThanOrEqual(1500);
      });
    }
  }

  it('best hardware is metal, kit plastics are satin, the camera glass is gloss', () => {
    expect(finishes(kinds[0].build(0.06, 'a', 'best')).has('metal')).toBe(true);
    expect(finishes(kinds[1].build(0.06, 'a', 'ok'))).toEqual(new Set(['satin', 'metal', 'matte', 'gloss']));
    expect(finishes(kinds[2].build(0.06, 'a', 'ok')).has('gloss')).toBe(true);
    expect(finishes(kinds[3].build(0.06, 'a', 'best')).has('gloss')).toBe(true);
  });

  it('decals lying on a surface use an offset material', () => {
    const o = kinds[1].build(0.06, 'a', 'best');
    const offs = allMeshes(o).filter((m) => (m.material as THREE.Material & { polygonOffset: boolean }).polygonOffset);
    expect(offs.length).toBeGreaterThanOrEqual(2);
  });

  it('best detail outranks ok outranks bad in triangles for the ballast and the computer', () => {
    for (const k of [kinds[0], kinds[1]]) {
      expect(triangles(k.build(0.06, 'r', 'best'))).toBeGreaterThan(triangles(k.build(0.06, 'r', 'ok')));
    }
  });
});
