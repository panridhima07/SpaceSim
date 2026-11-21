import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { BodyTube, InnerTube, Ring } from '../../types';
import {
  AIRFRAME_ICONS,
  buildBoosterPod,
  buildBodyTube,
  buildLaunchLug,
  buildMotor,
  buildRailButton,
} from './airframe';
import { PART_COLORS, PART_TIERS, TIER_ACCENT } from './types';
import type { PartContext, PartTier } from './types';

const ctx: PartContext = { cutaway: false, maxRadius: 0.05, rocketLength: 1.5 };
const cut: PartContext = { ...ctx, cutaway: true };

const tube: BodyTube = {
  kind: 'bodytube', id: 'bt1', name: 'Tube', x: 0.3, length: 0.6, density: 0,
  outerRadius: 0.05, thickness: 0.002,
};
const decoupler: BodyTube = { ...tube, id: 'dc1', isDecoupler: true };
const lug: Ring = {
  kind: 'ring', id: 'lug1', name: 'Lug', x: 0.5, length: 0.03, density: 0,
  outerRadius: 0.004, innerRadius: 0.003, external: true, ringType: 'launchlug', mountRadius: 0.05,
};
const button: Ring = {
  kind: 'ring', id: 'rb1', name: 'Button', x: 0.4, length: 0.008, density: 0,
  outerRadius: 0.005, innerRadius: 0.003, external: true, ringType: 'railbutton', mountRadius: 0.05,
};
const motor: InnerTube = {
  kind: 'innertube', id: 'm1', name: 'Mount', x: 0.3, length: 0.2, density: 0,
  outerRadius: 0.015, thickness: 0.001, isMotorMount: true, overhang: 0.01,
  motor: { manufacturer: 'X', designation: 'F32', diameter: 0.028, length: 0.12, delay: 5 },
};
const pod: InnerTube = {
  kind: 'innertube', id: 'p1', name: 'Pod', x: 0.3, length: 0.4, density: 0,
  outerRadius: 0.02, thickness: 0.001, isMotorMount: false, overhang: 0,
  radialCount: 2, radialOffset: 0.06,
};

function meshes(root: THREE.Object3D, skipDetail: boolean): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D) => {
    if (skipDetail && o.userData.detail) return;
    if (o instanceof THREE.Mesh) out.push(o);
    o.children.forEach(walk);
  };
  walk(root);
  return out;
}

function box(root: THREE.Object3D, skipDetail: boolean): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const b = new THREE.Box3();
  for (const m of meshes(root, skipDetail)) b.union(new THREE.Box3().setFromObject(m, true));
  return b;
}

function tris(root: THREE.Object3D): number {
  let n = 0;
  for (const m of meshes(root, false)) {
    const g = m.geometry as THREE.BufferGeometry;
    n += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  }
  return n;
}

function allFinite(root: THREE.Object3D): boolean {
  for (const m of meshes(root, false)) {
    const a = m.geometry.getAttribute('position');
    for (let i = 0; i < a.array.length; i++) if (!Number.isFinite(a.array[i])) return false;
  }
  return true;
}

const dist = (a: number, b: number) => {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return Math.hypot(ca.r - cb.r, ca.g - cb.g, ca.b - cb.b);
};

const builders = {
  bodytube: (t: PartTier, cx = ctx, c: BodyTube = tube) => buildBodyTube(c, t, cx),
  decoupler: (t: PartTier, cx = ctx) => buildBodyTube(decoupler, t, cx),
  launchlug: (t: PartTier, cx = ctx) => buildLaunchLug(lug, t, cx),
  railbutton: (t: PartTier, cx = ctx) => buildRailButton(button, t, cx),
  motor: (t: PartTier, cx = ctx) => buildMotor(motor, t, cx),
  boosterpod: (t: PartTier, cx = ctx) => buildBoosterPod(pod, t, cx),
};
const kinds = Object.keys(builders) as (keyof typeof builders)[];

describe('airframe parts: sanity', () => {
  for (const k of kinds) {
    for (const t of PART_TIERS) {
      it(`${k}/${t}: has meshes and finite vertices, deterministic`, () => {
        const g = builders[k](t);
        expect(meshes(g, false).length).toBeGreaterThan(0);
        expect(allFinite(g)).toBe(true);
        const a = box(g, false);
        const b = box(builders[k](t), false);
        expect(a.equals(b)).toBe(true);
      });
    }
  }
});

describe('body tube', () => {
  for (const t of PART_TIERS) {
    for (const c of [tube, decoupler]) {
      it(`${c.id}/${t}: exact length and radius, detail inside the allowance`, () => {
        const g = buildBodyTube(c, t, ctx);
        const main = box(g, true);
        const L = c.length;
        expect(Math.abs(main.min.y - -(c.x + L))).toBeLessThanOrEqual(1e-6 * L);
        expect(Math.abs(main.max.y - -c.x)).toBeLessThanOrEqual(1e-6 * L);
        expect(Math.abs(main.max.x - c.outerRadius)).toBeLessThanOrEqual(0.005 * c.outerRadius);
        const all = box(g, false);
        expect(all.min.y).toBeGreaterThanOrEqual(main.min.y - 1e-7);
        expect(all.max.y).toBeLessThanOrEqual(main.max.y + 1e-7);
        expect(all.max.x).toBeLessThanOrEqual(c.outerRadius * 1.015 + 1e-7);
        expect(all.max.z).toBeLessThanOrEqual(c.outerRadius * 1.015 + 1e-7);
      });
    }
    it(`${t}: cutaway makes the skin transparent and adds the wall`, () => {
      const solid = buildBodyTube(tube, t, ctx);
      const skin = meshes(solid, true).find((m) => m.name === 'skin')!;
      expect((skin.material as THREE.Material).transparent).toBe(false);
      const open = buildBodyTube(tube, t, cut);
      const skin2 = meshes(open, true).find((m) => m.name === 'skin')!;
      expect((skin2.material as THREE.Material).transparent).toBe(true);
      expect(meshes(open, true).length).toBeGreaterThan(meshes(solid, true).length);
      const inner = box(open, true);
      expect(inner.max.x).toBeLessThanOrEqual(tube.outerRadius + 1e-7);
    });
  }

  it('decoupler keeps its band colour; set colour overrides', () => {
    for (const t of ['best', 'ok'] as const) {
      const skin = meshes(buildBodyTube(decoupler, t, ctx), true)[0];
      expect((skin.material as THREE.MeshStandardMaterial).color.getHex()).toBe(PART_COLORS.decoupler);
    }
  });

  it('best decoupler has bolts, ok has none, bad has lumpy tape', () => {
    const names = (t: PartTier) => buildBodyTube(decoupler, t, ctx).children.flatMap((o) => o.children.map((m) => m.name));
    expect(names('best')).toContain('bolts');
    expect(names('ok')).toEqual([]);
    expect(names('bad')).toContain('tape');
  });

  it('bad tube is visibly faceted', () => {
    const skin = meshes(buildBodyTube(tube, 'bad', ctx), true)[0];
    const best = meshes(buildBodyTube(tube, 'best', ctx), true)[0];
    expect(skin.geometry.getAttribute('position').count).toBeLessThan(best.geometry.getAttribute('position').count / 4);
  });
});

describe('launch lug', () => {
  for (const t of PART_TIERS) {
    it(`${t}: axis at mountRadius + outerRadius, fore end at x, length exact`, () => {
      const g = buildLaunchLug(lug, t, ctx);
      const b = box(g, true);
      const X0 = lug.mountRadius! + lug.outerRadius;
      expect(Math.abs(b.min.x - (X0 - lug.outerRadius))).toBeLessThan(1e-7);
      expect(Math.abs(b.max.x - (X0 + lug.outerRadius))).toBeLessThan(1e-7);
      const tol = t === 'bad' ? 0.01 * lug.length : 1e-7;
      expect(Math.abs(b.min.y - -(lug.x + lug.length))).toBeLessThanOrEqual(tol);
      expect(Math.abs(b.max.y - -lug.x)).toBeLessThanOrEqual(tol);
      expect(Math.abs((b.min.y + b.max.y) / 2 + lug.x + lug.length / 2)).toBeLessThan(1e-6);
    });
  }
  it('bad lug is tilted by at most 2 degrees, others are straight', () => {
    const pivot = (t: PartTier) => buildLaunchLug(lug, t, ctx).children[0];
    expect(pivot('best').rotation.x).toBe(0);
    expect(pivot('ok').rotation.x).toBe(0);
    const a = Math.abs(pivot('bad').rotation.x);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual((2 * Math.PI) / 180 + 1e-9);
  });
  it('bad lug has glue under a detail group', () => {
    const g = buildLaunchLug(lug, 'bad', ctx);
    expect(g.children.some((o) => o.userData.detail === true)).toBe(true);
  });
  it('missing mountRadius puts the axis at outerRadius', () => {
    const b = box(buildLaunchLug({ ...lug, mountRadius: undefined }, 'ok', ctx), true);
    expect(Math.abs(b.min.x)).toBeLessThan(1e-9);
    expect(Math.abs(b.max.x - 2 * lug.outerRadius)).toBeLessThan(1e-9);
  });
});

describe('rail button', () => {
  for (const t of PART_TIERS) {
    it(`${t}: stands exactly length off the surface, widest diameter and centre right`, () => {
      const b = box(buildRailButton(button, t, ctx), true);
      expect(Math.abs(b.min.x - button.mountRadius!)).toBeLessThan(1e-7);
      expect(Math.abs(b.max.x - (button.mountRadius! + button.length))).toBeLessThan(1e-7);
      const yc = -(button.x + button.outerRadius);
      expect(Math.abs(b.min.y - (yc - button.outerRadius))).toBeLessThan(1e-7);
      expect(Math.abs(b.max.y - (yc + button.outerRadius))).toBeLessThan(1e-7);
      expect(Math.abs(b.max.z - button.outerRadius)).toBeLessThan(1e-7);
      const all = box(buildRailButton(button, t, ctx), false);
      expect(all.min.x).toBeLessThanOrEqual(b.min.x + 1e-9);
    });
  }
  it('bad button glue is under a detail group', () => {
    const g = buildRailButton(button, 'bad', ctx);
    expect(g.children.some((o) => o.userData.detail === true)).toBe(true);
  });
});

describe('motor', () => {
  const aft = -(motor.x + motor.length + motor.overhang);
  for (const t of PART_TIERS) {
    it(`${t}: nothing aft of the aft face, face present, casing radius from motor`, () => {
      const g = buildMotor(motor, t, ctx);
      const all = box(g, false);
      expect(all.min.y).toBeGreaterThanOrEqual(aft - 1e-7);
      const main = box(g, true);
      expect(Math.abs(main.min.y - aft)).toBeLessThan(1e-7);
      expect(main.max.y).toBeLessThanOrEqual(-motor.x + 1e-7);
      expect(Math.abs(main.max.x - motor.motor!.diameter / 2)).toBeLessThanOrEqual(0.005 * 0.014);
      expect(all.max.x).toBeLessThanOrEqual((motor.motor!.diameter / 2) * 1.015 + 1e-7);
    });
    it(`${t}: missing motor uses the mount bore`, () => {
      const g = buildMotor({ ...motor, motor: undefined }, t, ctx);
      const main = box(g, true);
      expect(Math.abs(main.max.x - (motor.outerRadius - motor.thickness))).toBeLessThanOrEqual(0.005 * 0.014);
    });
  }
});

describe('engine clusters', () => {
  const bells = (o: THREE.Object3D) => meshes(o, false).filter((m) => m.userData.bell === true);
  it('best has five bells, ok three, bad one', () => {
    expect(bells(buildMotor(motor, 'best', ctx))).toHaveLength(5);
    expect(bells(buildMotor(motor, 'ok', ctx))).toHaveLength(3);
    expect(bells(buildMotor(motor, 'bad', ctx))).toHaveLength(1);
  });
  for (const t of PART_TIERS) {
    it(`${t}: bells stay inside the casing and exit on the aft face`, () => {
      const rc = motor.motor!.diameter / 2;
      const aft = -(motor.x + motor.length + motor.overhang);
      for (const b of bells(buildMotor(motor, t, ctx))) {
        const bb = new THREE.Box3().setFromObject(b, true);
        expect(Math.abs(bb.min.y - aft)).toBeLessThan(1e-7);
        expect(Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.z), Math.abs(bb.max.z))).toBeLessThanOrEqual(rc + 1e-7);
      }
    });
  }
  it('a very short casing scales the cluster down instead of overflowing', () => {
    const short = { ...motor, length: 0.01, overhang: 0, motor: { ...motor.motor!, length: 0.02 } };
    const g = buildMotor(short, 'bad', ctx);
    expect(box(g, false).min.y).toBeGreaterThanOrEqual(-(short.x + short.length) - 1e-7);
    expect(box(g, false).max.y).toBeLessThanOrEqual(-short.x + 1e-7);
  });
});

describe('booster pod', () => {
  it('best has a recessed bell in the aft face, ok/bad none', () => {
    const n = (t: PartTier) => meshes(buildBoosterPod(pod, t, ctx), false).filter((m) => m.userData.bell).length;
    expect(n('best')).toBe(1);
    expect(n('ok')).toBe(0);
    expect(n('bad')).toBe(0);
  });
  for (const t of PART_TIERS) {
    it(`${t}: cylinder span exact, only the nose cap is forward of station x`, () => {
      const g = buildBoosterPod(pod, t, ctx);
      const all = box(g, false);
      expect(Math.abs(all.min.y - -(pod.x + pod.length))).toBeLessThan(1e-6);
      expect(Math.abs(all.max.y - (-pod.x + 2.4 * pod.outerRadius))).toBeLessThan(1e-6);
      expect(all.max.x).toBeLessThanOrEqual(pod.outerRadius * 1.015 + 1e-7);
      expect(Math.abs(box(g, true).max.x - pod.outerRadius)).toBeLessThanOrEqual(0.005 * pod.outerRadius + 1e-7);
      expect(all.min.x).toBeGreaterThanOrEqual(-pod.outerRadius * 1.015 - 1e-7);
    });
  }
});

describe('colour override', () => {
  const COLOR = 0x4da3ff;
  const cases: [string, (t: PartTier) => THREE.Object3D][] = [
    ['bodytube', (t) => buildBodyTube({ ...tube, color: COLOR }, t, ctx)],
    ['decoupler', (t) => buildBodyTube({ ...decoupler, color: COLOR }, t, ctx)],
    ['lug', (t) => buildLaunchLug({ ...lug, color: COLOR }, t, ctx)],
    ['button', (t) => buildRailButton({ ...button, color: COLOR }, t, ctx)],
    ['motor', (t) => buildMotor({ ...motor, color: COLOR }, t, ctx)],
    ['pod', (t) => buildBoosterPod({ ...pod, color: COLOR }, t, ctx)],
  ];
  for (const [name, make] of cases) {
    for (const t of PART_TIERS) {
      it(`${name}/${t}: the set colour reaches the main material`, () => {
        const mats = meshes(make(t), true).map((m) => (m.material as THREE.MeshStandardMaterial).color.getHex());
        if (t === 'bad') {
          expect(mats.some((h) => dist(h, COLOR) < dist(h, PART_COLORS.bare))).toBe(true);
        } else {
          expect(mats).toContain(COLOR);
        }
      });
    }
  }
});

describe('degenerate input', () => {
  const bad = [0, -1, NaN, Infinity];
  const run = (fn: () => THREE.Object3D) => {
    let g: THREE.Object3D | undefined;
    expect(() => { g = fn(); }).not.toThrow();
    expect(allFinite(g!)).toBe(true);
    return g!;
  };
  for (const t of PART_TIERS) {
    for (const v of bad) {
      it(`${t}: length/radius ${v} gives an empty group`, () => {
        expect(run(() => buildBodyTube({ ...tube, length: v }, t, ctx)).children).toHaveLength(0);
        expect(run(() => buildBodyTube({ ...tube, outerRadius: v }, t, ctx)).children).toHaveLength(0);
        expect(run(() => buildLaunchLug({ ...lug, length: v }, t, ctx)).children).toHaveLength(0);
        expect(run(() => buildLaunchLug({ ...lug, outerRadius: v }, t, ctx)).children).toHaveLength(0);
        expect(run(() => buildRailButton({ ...button, length: v }, t, ctx)).children).toHaveLength(0);
        expect(run(() => buildRailButton({ ...button, outerRadius: v }, t, ctx)).children).toHaveLength(0);
        expect(run(() => buildMotor({ ...motor, length: v }, t, ctx)).children).toHaveLength(0);
        expect(run(() => buildBoosterPod({ ...pod, length: v }, t, ctx)).children).toHaveLength(0);
        expect(run(() => buildBoosterPod({ ...pod, outerRadius: v }, t, ctx)).children).toHaveLength(0);
      });
    }
    it(`${t}: odd but non-fatal input never throws or yields NaN`, () => {
      run(() => buildBodyTube({ ...tube, thickness: 1 }, t, cut));
      run(() => buildBodyTube({ ...tube, thickness: NaN }, t, cut));
      run(() => buildBodyTube({ ...tube, thickness: -1 }, t, cut));
      expect(run(() => buildLaunchLug({ ...lug, innerRadius: lug.outerRadius }, t, ctx)).children).toHaveLength(0);
      expect(run(() => buildRailButton({ ...button, innerRadius: 1 }, t, ctx)).children).toHaveLength(0);
      run(() => buildLaunchLug({ ...lug, innerRadius: 0, mountRadius: undefined }, t, ctx));
      run(() => buildRailButton({ ...button, innerRadius: 0, mountRadius: NaN }, t, ctx));
      run(() => buildMotor({ ...motor, motor: undefined, thickness: 1 }, t, ctx));
      run(() => buildMotor({ ...motor, motor: { ...motor.motor!, diameter: NaN }, overhang: NaN }, t, ctx));
      run(() => buildMotor({ ...motor, outerRadius: NaN, motor: undefined }, t, ctx));
      run(() => buildBodyTube({ ...tube, x: NaN }, t, ctx));
    });
  }
});

describe('triangle budgets at the best tier', () => {
  const limit: Record<string, number> = {
    bodytube: 6000, decoupler: 6000, launchlug: 1500, railbutton: 1500, motor: 4000, boosterpod: 5000,
  };
  for (const k of kinds) {
    it(`${k} within ${limit[k]}`, () => {
      expect(tris(builders[k]('best'))).toBeLessThanOrEqual(limit[k]);
      expect(tris(builders[k]('best', cut))).toBeLessThanOrEqual(limit[k]);
    });
  }
});

describe('icons', () => {
  for (const k of Object.keys(AIRFRAME_ICONS) as (keyof typeof AIRFRAME_ICONS)[]) {
    for (const t of PART_TIERS) {
      it(`${k}/${t}: well-formed svg marked with the tier accent`, () => {
        const s = AIRFRAME_ICONS[k][t];
        expect(s.startsWith('<svg')).toBe(true);
        expect(s).toContain('viewBox="0 0 48 48"');
        expect(s).toContain('xmlns="http://www.w3.org/2000/svg"');
        expect(s).toContain(TIER_ACCENT[t]);
        expect(s).toContain('currentColor');
        expect(s).not.toMatch(/<script|href=|<text|\{a\}/i);
        expect(s.trim().endsWith('</svg>')).toBe(true);
      });
    }
    it(`${k}: the three tiers differ`, () => {
      const set = new Set(PART_TIERS.map((t) => AIRFRAME_ICONS[k][t]));
      expect(set.size).toBe(3);
    });
  }
});
