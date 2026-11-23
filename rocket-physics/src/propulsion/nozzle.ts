// Ideal rocket theory: a calorically perfect gas expanding isentropically through a
// converging-diverging nozzle. This is where thrust and specific impulse come from.

import { G0, R_GAS } from '../constants.ts';

/** Area ratio A/A* for a given Mach number. */
export function areaRatio(mach: number, gamma: number): number {
  const g1 = (gamma + 1) / 2;
  return (1 / mach) * Math.pow((1 + ((gamma - 1) / 2) * mach * mach) / g1, g1 / (gamma - 1));
}

// The fault monitor asks for the same few (expansion ratio, gamma) pairs on every step, and
// the bisection below costs 80+ powers. The function is pure, so remembering the last few
// answers returns exactly the same numbers.
const MACH_CACHE_SIZE = 8;
const machEps: number[] = [];
const machGamma: number[] = [];
const machValue: number[] = [];
let machNext = 0;

/** Supersonic Mach number at a given expansion ratio (bisection: the relation has no closed inverse). */
export function machFromAreaRatio(eps: number, gamma: number): number {
  for (let i = 0; i < machEps.length; i++) {
    if (machEps[i] === eps && machGamma[i] === gamma) return machValue[i];
  }
  const m = solveMachFromAreaRatio(eps, gamma);
  machEps[machNext] = eps;
  machGamma[machNext] = gamma;
  machValue[machNext] = m;
  machNext = (machNext + 1) % MACH_CACHE_SIZE;
  return m;
}

function solveMachFromAreaRatio(eps: number, gamma: number): number {
  let lo = 1;
  let hi = 2;
  while (areaRatio(hi, gamma) < eps) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (areaRatio(mid, gamma) < eps) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export interface ChamberDesign {
  chamberPressure: number; // Pa
  chamberTemperature: number; // K
  gamma: number; // ratio of specific heats of the exhaust
  molarMass: number; // kg/mol
  throatArea: number; // m^2
  expansionRatio: number; // exit area / throat area
  /** Real engines reach about 0.92 - 0.98 of the ideal thrust. */
  efficiency?: number;
}

export interface NozzlePerformance {
  massFlow: number; // kg/s
  characteristicVelocity: number; // c*, m/s
  exitMach: number;
  exitPressure: number; // Pa
  exitVelocity: number; // m/s
  exitArea: number; // m^2
  thrustVac: number; // N
  ispVac: number; // s
  /** Thrust and Isp at an ambient pressure. */
  at(ambient: number): { thrust: number; isp: number; thrustCoefficient: number; separated: boolean };
}

export function nozzlePerformance(d: ChamberDesign): NozzlePerformance {
  const { gamma: g, chamberPressure: pc, throatArea: At } = d;
  const eff = d.efficiency ?? 1;
  const Rs = R_GAS / d.molarMass;
  const Gamma = Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
  const cstar = Math.sqrt(Rs * d.chamberTemperature) / Gamma;
  const mdot = (pc * At) / cstar;
  const Me = machFromAreaRatio(d.expansionRatio, g);
  const pe = pc * Math.pow(1 + ((g - 1) / 2) * Me * Me, -g / (g - 1));
  const ve = Math.sqrt(((2 * g) / (g - 1)) * Rs * d.chamberTemperature * (1 - Math.pow(pe / pc, (g - 1) / g)));
  const Ae = At * d.expansionRatio;
  const thrustAt = (pa: number): number => eff * (mdot * ve + (pe - pa) * Ae);
  const thrustVac = thrustAt(0);
  return {
    massFlow: mdot,
    characteristicVelocity: cstar,
    exitMach: Me,
    exitPressure: pe,
    exitVelocity: ve,
    exitArea: Ae,
    thrustVac,
    ispVac: thrustVac / (mdot * G0),
    at(pa: number) {
      const thrust = Math.max(0, thrustAt(pa));
      return {
        thrust,
        isp: thrust / (mdot * G0),
        thrustCoefficient: thrust / (pc * At),
        // Summerfield criterion: the jet detaches from the wall when badly over-expanded.
        separated: pe < 0.4 * pa,
      };
    },
  };
}
