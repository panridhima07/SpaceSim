// Mass, centre of gravity and moments of inertia of the stack as propellant drains and
// stages fall away. The vehicle is treated as axisymmetric, so the inertia tensor is
// diagonal in body axes (X along the vehicle toward the nose).

import { boosterCount, tankOffsets, type VehicleRuntime, type VehicleSpec } from './types.ts';
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

interface TankModel {
  /** Station of the tank bottom from the stack base. */
  x0: number;
  radius: number;
  length: number;
  full: number;
  liquid: boolean;
}

interface StageModel {
  /** Index of the stage's first tank in the flat propellant array. */
  off: number;
  /** Copies arranged symmetrically, and the radial offset of each. */
  n: number;
  d: number;
  /** Sum over the copies of (d cos a)^2 and (d sin a)^2: their spread about Z and Y. */
  sy: number;
  sz: number;
  // Dry structure as a thin-walled cylinder.
  dryM: number;
  dryX: number;
  dryIa: number;
  dryIt: number;
  tanks: TankModel[];
}

/** Which parts are attached, as one number. Two runtimes with the same signature have the same layout. */
export function massSignature(rt: VehicleRuntime): number {
  let sig = rt.fairingAttached ? 1 : 0;
  const st = rt.stages;
  // Bit 0 is the fairing, bit i + 1 is stage i (a vehicle has far fewer than 30 stages).
  for (let i = 0; i < st.length; i++) if (st[i].attached) sig |= 2 << i;
  return sig;
}

/**
 * Mass properties of one configuration of the vehicle (one set of attached parts),
 * with everything that does not depend on the propellant worked out once. The simulator
 * evaluates this several times per step; `massProperties` below is the one-shot form.
 */
export class MassModel {
  readonly signature: number;
  readonly stageBase: number[];
  readonly top: number;
  readonly length: number;
  private readonly stages: StageModel[] = [];
  /** Payload and fairing: mass, station, axial and transverse inertia, four numbers each. */
  private readonly fixed: number[] = [];
  /** Scratch: mass, station, axial and transverse inertia of every item found in the last pass. */
  private readonly item: Float64Array;

  constructor(v: VehicleSpec, rt: VehicleRuntime) {
    this.signature = massSignature(rt);
    const { base, top, length } = stackLayout(v, rt);
    this.stageBase = base;
    this.top = top;
    this.length = length;
    const offs = tankOffsets(v);
    let items = 2;
    v.stages.forEach((s, i) => {
      if (!rt.stages[i].attached) return;
      const n = boosterCount(s);
      const d = s.parallel?.radialOffset ?? 0;
      const R = s.radius;
      // Copies sit at angles 2 pi k / n around the axis, starting on +Y.
      let sy = 0;
      let sz = 0;
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        sy += (d * Math.cos(a)) ** 2;
        sz += (d * Math.sin(a)) ** 2;
      }
      this.stages.push({
        off: offs[i],
        n,
        d,
        sy,
        sz,
        dryM: s.dryMass,
        dryX: base[i] + (s.dryCgFraction ?? 0.4) * s.length,
        dryIa: s.dryMass * R * R,
        dryIt: s.dryMass * ((R * R) / 2 + (s.length * s.length) / 12),
        tanks: s.tanks.map((t) => ({
          x0: base[i] + t.bottom,
          radius: t.radius ?? R,
          length: t.length,
          full: t.propellantMass,
          liquid: (t.kind ?? 'liquid') === 'liquid',
        })),
      });
      items += 1 + s.tanks.length;
    });
    const cores = v.stages.filter((s) => !s.parallel);
    const pr = v.payload.radius ?? cores[cores.length - 1].radius * 0.8;
    const pm = v.payload.mass;
    this.fixed.push(pm, top + v.payload.length / 2, 0.5 * pm * pr * pr, pm * ((pr * pr) / 4 + v.payload.length ** 2 / 12));
    if (rt.fairingAttached && v.fairing) {
      const f = v.fairing;
      this.fixed.push(f.mass, top + f.length * 0.45, f.mass * f.radius ** 2, f.mass * (f.radius ** 2 / 2 + f.length ** 2 / 12));
    }
    this.item = new Float64Array(4 * items);
  }

  /**
   * Fill `out` for the propellant masses found at prop[offset], prop[offset + 1], ...
   * (one per tank, in vehicle order). Nothing is allocated; `out.inertia` is written in place.
   */
  evaluate(prop: ArrayLike<number>, offset: number, out: MassProps): void {
    const item = this.item;
    const stages = this.stages;
    let k = 0;
    let mass = 0;
    let moment = 0;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      item[k] = s.dryM;
      item[k + 1] = s.dryX;
      item[k + 2] = s.dryIa;
      item[k + 3] = s.dryIt;
      mass += s.dryM * s.n;
      moment += s.dryM * s.n * s.dryX;
      k += 4;
      const tanks = s.tanks;
      for (let j = 0; j < tanks.length; j++) {
        const t = tanks[j];
        const p = prop[offset + s.off + j];
        const m = p > 0 ? p : 0;
        // Liquid settles under thrust: the column shortens from the top. Solid grain keeps its length.
        const h = t.liquid ? t.length * Math.min(1, m / t.full) : t.length;
        const r = t.radius;
        const x = t.x0 + h / 2;
        item[k] = m;
        item[k + 1] = x;
        item[k + 2] = 0.5 * m * r * r;
        item[k + 3] = m * ((r * r) / 4 + (h * h) / 12);
        if (m > 0) {
          mass += m * s.n;
          moment += m * s.n * x;
        }
        k += 4;
      }
    }
    const fixed = this.fixed;
    for (let j = 0; j < fixed.length; j += 4) {
      mass += fixed[j];
      moment += fixed[j] * fixed[j + 1];
    }
    const cg = moment / mass;

    let ixx = 0;
    let iyy = 0;
    let izz = 0;
    k = 0;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      const count = 1 + s.tanks.length;
      for (let j = 0; j < count; j++, k += 4) {
        const m = item[k];
        if (j > 0 && m <= 0) continue; // an empty tank contributes nothing
        const dx = item[k + 1] - cg;
        const dx2 = dx * dx;
        ixx += s.n * (item[k + 2] + m * s.d * s.d);
        iyy += s.n * (item[k + 3] + m * dx2) + m * s.sz;
        izz += s.n * (item[k + 3] + m * dx2) + m * s.sy;
      }
    }
    for (let j = 0; j < fixed.length; j += 4) {
      const m = fixed[j];
      const dx = fixed[j + 1] - cg;
      ixx += fixed[j + 2];
      iyy += fixed[j + 3] + m * (dx * dx);
      izz += fixed[j + 3] + m * (dx * dx);
    }
    out.mass = mass;
    out.cg = cg;
    out.inertia[0] = ixx;
    out.inertia[1] = iyy;
    out.inertia[2] = izz;
    out.length = this.length;
    out.top = this.top;
    out.stageBase = this.stageBase;
  }
}

export function massProperties(v: VehicleSpec, rt: VehicleRuntime, prop: number[]): MassProps {
  const model = new MassModel(v, rt);
  const out: MassProps = { mass: 0, cg: 0, inertia: [0, 0, 0], length: 0, top: 0, stageBase: model.stageBase };
  model.evaluate(prop, 0, out);
  return out;
}

/** Propellant a stage can still burn, kg (all tanks, all boosters). */
export function usablePropellant(v: VehicleSpec, stage: number, prop: number[]): number {
  const s = v.stages[stage];
  let off = 0;
  for (let i = 0; i < stage; i++) off += v.stages[i].tanks.length;
  const res = s.residualFraction ?? 0.005;
  // The stage stops when its first tank runs dry, so the limiting tank sets the total.
  let burnable = Infinity;
  const tanks = s.tanks;
  for (let k = 0; k < tanks.length; k++) {
    const t = tanks[k];
    burnable = Math.min(burnable, Math.max(0, prop[off + k] - res * t.propellantMass) / t.flowFraction);
  }
  return burnable * boosterCount(s);
}

/** Wet mass of a whole stage (all boosters) with the given propellant. */
export function stageMass(v: VehicleSpec, stage: number, prop: number[]): number {
  // Called several times per step by guidance and the fault monitor: the stage's tank
  // offset is summed here rather than by building the whole tankOffsets array.
  const stages = v.stages;
  let off = 0;
  for (let i = 0; i < stage; i++) off += stages[i].tanks.length;
  const s = stages[stage];
  const n = s.tanks.length;
  let m = s.dryMass;
  for (let k = 0; k < n; k++) m += Math.max(0, prop[off + k]);
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
