// Mass, centre of gravity and moments of inertia of the stack as propellant drains and
// stages fall away. The vehicle is treated as axisymmetric, so the inertia tensor is
// diagonal in body axes (X along the vehicle toward the nose).

import { boosterCount, tankOffsets, type StageSpec, type VehicleRuntime, type VehicleSpec } from './types.ts';
import type { Vec3 } from '../math/vec.ts';

export interface MassProps {
  mass: number;
  /** Centre of gravity, station from the base of the current stack, m. */
  cg: number;
  /** Principal moments about the CG: [roll (X), pitch (Y), yaw (Z)], kg m^2. */
  inertia: Vec3;
  /** Total length of the current stack, m. */
  length: number;
  /** Station of the top of the uppermost stage (payload interface). A fixed material point. */
  top: number;
  /** Station of each stage's base (engine gimbal plane); NaN when detached. */
  stageBase: number[];
}

interface Item {
  m: number; // mass of one copy
  x: number; // station of its CG
  ia: number; // own axial inertia
  it: number; // own transverse inertia
  n: number; // copies arranged symmetrically
  d: number; // radial offset of each copy
}

/** Station of each attached stage's base and the top of the stack. */
export function stackLayout(v: VehicleSpec, rt: VehicleRuntime): { base: number[]; top: number; length: number } {
  const base: number[] = v.stages.map(() => NaN);
  let x = 0;
  let coreBase = 0;
  let first = true;
  v.stages.forEach((s, i) => {
    if (s.parallel || !rt.stages[i].attached) return;
    base[i] = x;
    if (first) {
      coreBase = x;
      first = false;
    }
    x += s.length;
  });
  v.stages.forEach((s, i) => {
    if (s.parallel && rt.stages[i].attached) base[i] = coreBase + s.parallel.attachStation;
  });
  const top = x;
  const length = top + (rt.fairingAttached && v.fairing ? v.fairing.length : v.payload.length);
  return { base, top, length };
}

function stageItems(s: StageSpec, base: number, prop: number[], off: number, out: Item[]): void {
  const n = boosterCount(s);
  const d = s.parallel?.radialOffset ?? 0;
  const R = s.radius;
  // Dry structure as a thin-walled cylinder.
  out.push({
    m: s.dryMass,
    x: base + (s.dryCgFraction ?? 0.4) * s.length,
    ia: s.dryMass * R * R,
    it: s.dryMass * ((R * R) / 2 + (s.length * s.length) / 12),
    n,
    d,
  });
  s.tanks.forEach((t, k) => {
    const m = Math.max(0, prop[off + k]);
    if (m <= 0) return;
    const r = t.radius ?? R;
    // Liquid settles under thrust: the column shortens from the top. Solid grain keeps its length.
    const h = (t.kind ?? 'liquid') === 'liquid' ? t.length * Math.min(1, m / t.propellantMass) : t.length;
    out.push({ m, x: base + t.bottom + h / 2, ia: 0.5 * m * r * r, it: m * ((r * r) / 4 + (h * h) / 12), n, d });
  });
}

export function massProperties(v: VehicleSpec, rt: VehicleRuntime, prop: number[]): MassProps {
  const { base, top, length } = stackLayout(v, rt);
  const offs = tankOffsets(v);
  const items: Item[] = [];
  v.stages.forEach((s, i) => {
    if (rt.stages[i].attached) stageItems(s, base[i], prop, offs[i], items);
  });
  const cores = v.stages.filter((s) => !s.parallel);
  const pr = v.payload.radius ?? cores[cores.length - 1].radius * 0.8;
  const pm = v.payload.mass;
  items.push({ m: pm, x: top + v.payload.length / 2, ia: 0.5 * pm * pr * pr, it: pm * ((pr * pr) / 4 + v.payload.length ** 2 / 12), n: 1, d: 0 });
  if (rt.fairingAttached && v.fairing) {
    const f = v.fairing;
    items.push({ m: f.mass, x: top + f.length * 0.45, ia: f.mass * f.radius ** 2, it: f.mass * (f.radius ** 2 / 2 + f.length ** 2 / 12), n: 1, d: 0 });
  }

  let mass = 0;
  let moment = 0;
  for (const it of items) {
    mass += it.m * it.n;
    moment += it.m * it.n * it.x;
  }
  const cg = moment / mass;
  let ixx = 0;
  let iyy = 0;
  let izz = 0;
  for (const it of items) {
    const dx2 = (it.x - cg) ** 2;
    ixx += it.n * (it.ia + it.m * it.d * it.d);
    // Copies sit at angles 2 pi k / n around the axis, starting on +Y.
    let sy = 0;
    let sz = 0;
    for (let k = 0; k < it.n; k++) {
      const a = (2 * Math.PI * k) / it.n;
      sy += (it.d * Math.cos(a)) ** 2;
      sz += (it.d * Math.sin(a)) ** 2;
    }
    iyy += it.n * (it.it + it.m * dx2) + it.m * sz;
    izz += it.n * (it.it + it.m * dx2) + it.m * sy;
  }
  return { mass, cg, inertia: [ixx, iyy, izz], length, top, stageBase: base };
}

/** Propellant a stage can still burn, kg (all tanks, all boosters). */
export function usablePropellant(v: VehicleSpec, stage: number, prop: number[]): number {
  const s = v.stages[stage];
  const off = tankOffsets(v)[stage];
  const res = s.residualFraction ?? 0.005;
  // The stage stops when its first tank runs dry, so the limiting tank sets the total.
  let burnable = Infinity;
  s.tanks.forEach((t, k) => {
    burnable = Math.min(burnable, Math.max(0, prop[off + k] - res * t.propellantMass) / t.flowFraction);
  });
  return burnable * boosterCount(s);
}

/** Wet mass of a whole stage (all boosters) with the given propellant. */
export function stageMass(v: VehicleSpec, stage: number, prop: number[]): number {
  const s = v.stages[stage];
  const off = tankOffsets(v)[stage];
  let m = s.dryMass;
  s.tanks.forEach((_, k) => (m += Math.max(0, prop[off + k])));
  return m * boosterCount(s);
}

/** Ideal (Tsiolkovsky) delta-v of each core stage burning in vacuum with everything above it attached. */
export function deltaVBudget(v: VehicleSpec): { stage: string; deltaV: number; burnTime: number; twr: number }[] {
  const G0 = 9.80665;
  const full = v.stages.flatMap((s) => s.tanks.map((t) => t.propellantMass));
  const out: { stage: string; deltaV: number; burnTime: number; twr: number }[] = [];
  let above = v.payload.mass;
  for (let i = v.stages.length - 1; i >= 0; i--) {
    const s = v.stages[i];
    if (s.parallel) continue;
    const wet = stageMass(v, i, full);
    const usable = usablePropellant(v, i, full);
    const m0 = above + wet;
    const mdot = (s.engine.thrustVac * s.engineCount) / (G0 * s.engine.ispVac);
    out.unshift({
      stage: s.name,
      deltaV: G0 * s.engine.ispVac * Math.log(m0 / (m0 - usable)),
      burnTime: usable / mdot,
      twr: (s.engine.thrustVac * s.engineCount) / (m0 * G0),
    });
    above = m0;
  }
  return out;
}
