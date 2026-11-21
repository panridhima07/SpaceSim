import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { InnerTube, MassComponent, Parachute, Ring } from '../../types';
import { PART_TIERS, type PartContext, type PartTier } from './types';
import { INTERNAL_ICONS, buildInnerTube, buildMass, buildPackedChute, buildRing } from './internals';

const MAXR = 0.0125;
const ctx: PartContext = { cutaway: true, maxRadius: MAXR, rocketLength: 0.4 };
const X = 0.12;
const COLOR = 0x4da3ff;

const tube = (o: Partial<InnerTube> = {}): InnerTube => ({
  kind: 'innertube', id: 'it', name: 'tube', x: X, length: 0.2, density: 0,
  outerRadius: 0.0115, thickness: 0.001, isMotorMount: true, overhang: 0, ...o,
});
const ring = (o: Partial<Ring> = {}): Ring => ({
  kind: 'ring', id: 'rg', name: 'ring', x: X, length: 0.004, density: 0,
  outerRadius: 0.0115, innerRadius: 0.006, ringType: 'centeringring', ...o,
});
const mass = (o: Partial<MassComponent> = {}): MassComponent => ({
  kind: 'mass', id: 'ms', name: 'mass', x: X, length: 0.05, density: 0, mass: 0.05, ...o,
});
const chute = (o: Partial<Parachute> = {}): Parachute => ({
  kind: 'parachute', id: 'pc', name: 'chute', x: X, length: 0.1, density: 0,
  diameter: 0.3, cd: 0.8, deployEvent: 'apogee', deployAltitude: 0, deployDelay: 0, mass: 0.02, ...o,
});

const ringCases: { label: string; c: Ring }[] = [
  { label: 'centeringring', c: ring() },
  { label: 'centeringring (narrow)', c: ring({ innerRadius: 0.0105 }) },
  { label: 'bulkhead', c: ring({ ringType: 'bulkhead', innerRadius: 0, length: 0.006 }) },
  { label: 'tubecoupler', c: ring({ ringType: 'tubecoupler', innerRadius: 0.0105, length: 0.05 }) },
  { label: 'engineblock', c: ring({ ringType: 'engineblock', outerRadius: 0.006, innerRadius: 0.0035, length: 0.004 }) },
  { label: 'shoulder', c: ring({ ringType: 'shoulder', innerRadius: 0.0105, length: 0.03 }) },
  { label: 'untyped ring', c: ring({ ringType: undefined }) },
  { label: 'untyped bulkhead', c: ring({ ringType: undefined, innerRadius: 0 }) },
];

function allMeshes(root: THREE.Object3D, skipDetail: boolean): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D) => {
    if (skipDetail && o.userData.detail) return;
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
    o.children.forEach(walk);
  };
  walk(root);
  return out;
}

interface Stats { yMin: number; yMax: number; rMin: number; rMax: number }

function stats(meshes: THREE.Mesh[]): Stats {
  const s: Stats = { yMin: Infinity, yMax: -Infinity, rMin: Infinity, rMax: 0 };
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    const p = m.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      s.yMin = Math.min(s.yMin, v.y);
      s.yMax = Math.max(s.yMax, v.y);
      const r = Math.hypot(v.x, v.z);
      s.rMin = Math.min(s.rMin, r);
      s.rMax = Math.max(s.rMax, r);
    }
  }
  return s;
}

function triangles(root: THREE.Object3D): number {
  let n = 0;
  for (const m of allMeshes(root, false)) {
    const g = m.geometry;
    n += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  }
  return n;
}

function expectFinite(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  for (const m of allMeshes(root, false)) {
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.array.length; i++) {
      expect(Number.isFinite(p.array[i])).toBe(true);
    }
    expect(Number.isFinite(m.position.x + m.position.y + m.position.z)).toBe(true);
  }
}

const near = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-3) + 1e-9;

interface Kind {
  name: string;
  build: (tier: PartTier, color?: number) => THREE.Object3D;
  y0: number;
  y1: number;
  R: number;
  budget: number;
}

const kinds: Kind[] = [
  { name: 'innertube', build: (t, col) => buildInnerTube(tube({ color: col }), t, ctx), y0: -(X + 0.2), y1: -X, R: 0.0115, budget: 4000 },
  { name: 'mass', build: (t, col) => buildMass(mass({ color: col }), t, ctx), y0: -(X + 0.05), y1: -X, R: 0.6 * MAXR, budget: 2000 },
  { name: 'parachute', build: (t, col) => buildPackedChute(chute({ color: col }), t, ctx), y0: -(X + 0.1), y1: -X, R: 0.7 * MAXR, budget: 3000 },
  ...ringCases.map((rc) => ({
    name: `ring:${rc.label}`,
    build: (t: PartTier, col?: number) => buildRing({ ...rc.c, color: col }, t, ctx),
    y0: -(rc.c.x + rc.c.length),
    y1: -rc.c.x,
    R: rc.c.outerRadius,
    budget: 2500,
  })),
];

describe('internals: dimensions, colour, budget', () => {
  for (const k of kinds) {
    for (const tier of PART_TIERS) {
      it(`${k.name} / ${tier}`, () => {
        const o = k.build(tier);
        expectFinite(o);
        o.updateMatrixWorld(true);
        const s = stats(allMeshes(o, true));
        expect(near(s.yMin, k.y0)).toBe(true);
        expect(near(s.yMax, k.y1)).toBe(true);
        expect(s.rMax).toBeLessThanOrEqual(k.R * 1.005);
        expect(s.rMax).toBeGreaterThanOrEqual(k.R * 0.995);
        // details stay inside the axial extent and at most 1.5% proud
        const dm: THREE.Mesh[] = [];
        o.traverse((d) => {
          if (d.userData.detail) dm.push(...allMeshes(d, false));
        });
        if (dm.length) {
          const ds = stats(dm);
          expect(ds.yMin).toBeGreaterThanOrEqual(k.y0 - 1e-6 * Math.abs(k.y0) - 1e-9);
          expect(ds.yMax).toBeLessThanOrEqual(k.y1 + 1e-6 * Math.abs(k.y1) + 1e-9);
          expect(ds.rMax).toBeLessThanOrEqual(k.R * 1.0155);
        }
        expect(triangles(o)).toBeLessThanOrEqual(k.budget);
      });

      it(`${k.name} / ${tier} carries a set colour and is deterministic`, () => {
        const o = k.build(tier, COLOR);
        const mains = allMeshes(o, true);
        expect(mains.length).toBeGreaterThan(0);
        for (const m of mains) {
          expect((m.material as THREE.MeshStandardMaterial).color.getHex()).toBe(COLOR);
        }
        const a = stats(allMeshes(k.build(tier), false));
        const b = stats(allMeshes(k.build(tier), false));
        expect(a).toEqual(b);
      });
    }
  }

  it('ring hole is exactly innerRadius (centering ring, all tiers)', () => {
    for (const tier of PART_TIERS) {
      const s = stats(allMeshes(buildRing(ring(), tier, ctx), true));
      expect(near(s.rMin, 0.006)).toBe(true);
    }
  });

  it('tube wall is shown', () => {
    for (const tier of PART_TIERS) {
      const s = stats(allMeshes(buildInnerTube(tube(), tier, ctx), true));
      expect(near(s.rMin, 0.0105)).toBe(true);
    }
  });

  it('best centering ring has lightening holes inside the annulus', () => {
    const o = buildRing(ring(), 'best', ctx);
    const plain = buildRing(ring(), 'ok', ctx);
    expect(triangles(o)).toBeGreaterThan(triangles(plain));
  });

  it('zero-length mass and chute fall back to a short block', () => {
    for (const tier of PART_TIERS) {
      const m = stats(allMeshes(buildMass(mass({ length: 0 }), tier, ctx), true));
      expect(near(m.yMax - m.yMin, 0.4 * MAXR)).toBe(true);
      expect(near((m.yMax + m.yMin) / 2, -X)).toBe(true);
      const p = stats(allMeshes(buildPackedChute(chute({ length: 0 }), tier, ctx), true));
      expect(near(p.yMax, -X)).toBe(true);
      expect(near(p.yMin, -X - 0.6 * MAXR)).toBe(true);
    }
  });
});

describe('internals: degenerate input', () => {
  const bad = [0, -0.01, NaN, Infinity];
  it('never throws or yields NaN', () => {
    for (const tier of PART_TIERS) {
      const objs: THREE.Object3D[] = [];
      for (const v of bad) {
        objs.push(buildInnerTube(tube({ length: v }), tier, ctx));
        objs.push(buildInnerTube(tube({ outerRadius: v }), tier, ctx));
        objs.push(buildInnerTube(tube({ thickness: v }), tier, ctx));
        objs.push(buildInnerTube(tube({ x: v }), tier, ctx));
        objs.push(buildRing(ring({ length: v }), tier, ctx));
        objs.push(buildRing(ring({ outerRadius: v }), tier, ctx));
        objs.push(buildRing(ring({ innerRadius: v }), tier, ctx));
        objs.push(buildMass(mass({ length: v }), tier, ctx));
        objs.push(buildMass(mass({ x: v }), tier, ctx));
        objs.push(buildPackedChute(chute({ length: v }), tier, ctx));
        objs.push(buildPackedChute(chute({ x: v }), tier, ctx));
      }
      objs.push(buildInnerTube(tube({ thickness: 0.02 }), tier, ctx));
      objs.push(buildRing(ring({ innerRadius: 0.02 }), tier, ctx));
      objs.push(buildRing(ring({ innerRadius: 0.0115 }), tier, ctx));
      objs.push(buildRing(ring({ ringType: 'bulkhead', innerRadius: 0 }), tier, { ...ctx, maxRadius: 0 }));
      objs.push(buildMass(mass(), tier, { ...ctx, maxRadius: 0 }));
      objs.push(buildPackedChute(chute(), tier, { ...ctx, maxRadius: 0 }));
      objs.push(buildMass(mass(), tier, { ...ctx, maxRadius: NaN }));
      for (const o of objs) {
        expect(o).toBeInstanceOf(THREE.Object3D);
        expectFinite(o);
      }
    }
  });

  it('returns an empty group for degenerate parts', () => {
    expect(allMeshes(buildRing(ring({ innerRadius: 0.02 }), 'best', ctx), false)).toHaveLength(0);
    expect(allMeshes(buildInnerTube(tube({ length: 0 }), 'ok', ctx), false)).toHaveLength(0);
    expect(allMeshes(buildMass(mass(), 'bad', { ...ctx, maxRadius: 0 }), false)).toHaveLength(0);
  });
});

describe('internals: icons', () => {
  const keys = Object.keys(INTERNAL_ICONS) as (keyof typeof INTERNAL_ICONS)[];
  it('has all six kinds', () => {
    expect(keys.sort()).toEqual(['bulkhead', 'centeringring', 'innertube', 'mass', 'parachute', 'tubecoupler']);
  });
  for (const key of keys) {
    for (const tier of PART_TIERS) {
      it(`${key} / ${tier}`, () => {
        const s = INTERNAL_ICONS[key][tier];
        expect(s.startsWith('<svg')).toBe(true);
        expect(s).toContain('viewBox="0 0 48 48"');
        expect(s).toContain('xmlns="http://www.w3.org/2000/svg"');
        expect(s).toContain('currentColor');
        expect(s).not.toMatch(/<script|<text|href=|url\(/);
        expect(s.endsWith('</svg>')).toBe(true);
        expect(s).not.toContain('NaN');
      });
    }
  }
});
