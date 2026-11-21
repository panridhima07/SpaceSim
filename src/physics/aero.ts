// Aerodynamic coefficients: Barrowman method for normal force and centre of
// pressure, plus a component build-up of zero-alpha drag following OpenRocket
// (Niskanen 2009): skin friction, base drag and pressure drag.

import type { AeroProps, AeroPropsFn, Component, FinSet, NoseCone, RocketModel, Transition } from '../types';
import { finPlanform, noseLateralArea } from './massprops';

const PI = Math.PI;
const NU_SEA_LEVEL = 1.5e-5; // m^2/s, kinematic viscosity used for Reynolds number
const SOUND_SPEED_REF = 340.3; // m/s, converts Mach to speed for Reynolds number
/** Regular paint ("normal" finish) surface roughness, m. */
const SURFACE_ROUGHNESS = 60e-6;
/** Fin cross-section used when a fin set does not state one. */
const DEFAULT_FIN_SECTION: NonNullable<FinSet['crossSection']> = 'rounded';

/** Trapezoidal fin equivalent used by the Barrowman formulas. */
interface TrapFin {
  Cr: number;
  Ct: number;
  /** Semi-span, m. */
  s: number;
  /** Sweep length (tip LE aft of root LE), m. */
  m: number;
  /** Body radius at the fin root, m. */
  rb: number;
}

// ---------- Nose and transition ----------

function noseCnAlpha(c: NoseCone, maxR: number): number {
  // Barrowman nose normal force slope is 2 referenced to the nose base area;
  // scale by base area relative to the reference area.
  const ratio = maxR > 0 ? (c.baseRadius / maxR) ** 2 : 1;
  return 2 * ratio;
}

function noseCpFraction(shape: NoseCone['shape']): number {
  switch (shape) {
    case 'conical':
      return 2 / 3;
    case 'ogive':
      return 0.466;
    case 'ellipsoid':
      return 1 / 3;
    case 'parabolic':
      return 0.5;
    case 'power':
      return 0.5;
    case 'haack':
      return 0.437;
  }
}

function transitionCnAlpha(c: Transition, maxR: number): number {
  if (c.foreRadius === c.aftRadius || maxR <= 0) return 0;
  const R = maxR;
  return 2 * ((c.aftRadius / R) ** 2 - (c.foreRadius / R) ** 2);
}

/**
 * Transition CP fraction from fore end. With rF = foreDia/aftDia, the Barrowman
 * expression (1 - rF)/(1 - rF²) simplifies to 1/(1 + rF).
 */
function transitionCpX(c: Transition): number {
  const dF = 2 * c.foreRadius;
  const dR = 2 * c.aftRadius;
  if (dF <= 0 || dR <= 0) return c.x + c.length / 2;
  const r = dF / dR;
  return c.x + (c.length / 3) * (1 + 1 / (1 + r));
}

// ---------- Fins ----------

/** Equivalent trapezoid for a freeform outline: span from max radial, chords from sections. */
function freeformTrap(f: FinSet): TrapFin | null {
  const pts = f.points;
  if (!pts || pts.length < 3) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = maxY - minY;
  if (!(span > 0)) return null;

  /** Min and max axial coordinates where the outline crosses horizontal line y. */
  const section = (y: number): { lo: number; hi: number } | null => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) {
        const x = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      } else if (y0 === y && y1 === y) {
        lo = Math.min(lo, x0, x1);
        hi = Math.max(hi, x0, x1);
      }
    }
    return lo <= hi ? { lo, hi } : null;
  };

  const root = section(minY);
  const tip = section(maxY - 1e-6 * span);
  if (!root || !tip) return null;
  const Cr = root.hi - root.lo;
  const Ct = tip.hi - tip.lo;
  const sweep = tip.lo - root.lo;
  if (!(Cr > 0)) return null;
  return { Cr, Ct: Math.max(0, Ct), s: span, m: sweep, rb: f.bodyRadius };
}

/** Convert a fin set to the trapezoid used for the Barrowman formulas. */
function trapOf(f: FinSet): TrapFin {
  if (f.finShape === 'freeform') {
    const t = freeformTrap(f);
    if (t) return t;
  }
  if (f.finShape === 'elliptical') {
    // Ellipse area pi/4 Cr s equals a trapezoid with Ct = (pi/2 - 1) Cr.
    return {
      Cr: f.rootChord,
      Ct: (PI / 2 - 1) * f.rootChord,
      s: f.span,
      m: f.sweepLength,
      rb: f.bodyRadius,
    };
  }
  return { Cr: f.rootChord, Ct: f.tipChord, s: f.span, m: f.sweepLength, rb: f.bodyRadius };
}

/** Fin-count correction for N > 4 (interference), interpolated from OpenRocket-like table. */
function finCountFactor(N: number): number {
  if (N <= 4) return 1;
  const table: [number, number][] = [
    [4, 1],
    [5, 0.948],
    [6, 0.913],
    [8, 0.854],
  ];
  if (N >= 8) return 0.854;
  for (let i = 1; i < table.length; i++) {
    const [n1, f1] = table[i];
    const [n0, f0] = table[i - 1];
    if (N <= n1) return f0 + ((f1 - f0) * (N - n0)) / (n1 - n0);
  }
  return 0.854;
}

/** Incompressible Barrowman CNα of a fin set (per radian), referenced to refArea. */
function finCnAlphaIncompressible(f: FinSet, d: number): number {
  const t = trapOf(f);
  const { Cr, Ct, s, m, rb } = t;
  const N = Math.max(0, f.count);
  if (!(s > 0) || !(Cr + Ct > 0) || !(d > 0) || N === 0) return 0;
  const l = Math.sqrt(s * s + (m + Ct / 2 - Cr / 2) ** 2);
  const Kfb = 1 + rb / (s + rb);
  const denom = 1 + Math.sqrt(1 + (2 * l / (Cr + Ct)) ** 2);
  return (Kfb * (4 * N * (s / d) ** 2)) / denom * finCountFactor(N);
}

/** Fin CP station, from the body nose tip. */
function finCpX(f: FinSet): number {
  const t = trapOf(f);
  const { Cr, Ct, m } = t;
  if (!(Cr + Ct > 0)) return f.x + f.rootChord / 2;
  const xp = (m / 3) * ((Cr + 2 * Ct) / (Cr + Ct)) + (1 / 6) * (Cr + Ct - (Cr * Ct) / (Cr + Ct));
  return f.x + xp;
}

/**
 * Compressibility factor applied to fin CNα.
 * Subsonic: Prandtl-Glauert 1/sqrt(1-M²). Transonic 0.8..1.2: held at the M=0.8 value.
 * Supersonic: 1/sqrt(M²-1), never above the M=0.8 value.
 */
function compressibilityFactor(M: number): number {
  const hold = 1 / Math.sqrt(1 - 0.8 * 0.8);
  if (M < 0.8) return 1 / Math.sqrt(1 - M * M);
  if (M <= 1.2) return hold;
  return Math.min(1 / Math.sqrt(M * M - 1), hold);
}

// ---------- Drag (OpenRocket / Niskanen 2009 build-up) ----------

export interface DragBreakdown {
  /** Skin friction Cd referenced to refArea, zero alpha. */
  friction: number;
  /** Fin leading-edge and nose pressure drag, referenced to refArea. */
  pressure: number;
  /** Base drag including the rounded fin trailing-edge term, referenced to refArea. */
  base: number;
  /** Sum of the three. */
  total: number;
  /** Skin friction coefficient Cf (before the fineness and wetted-area factors). */
  cf: number;
  /** Reynolds number on the full rocket length. */
  reynolds: number;
}

/**
 * Skin friction coefficient on a flat plate of length L (m) with the given roughness,
 * at Mach M. Laminar below Re 1e4, Schlichting-type turbulent below the roughness
 * critical Reynolds number, roughness-limited above it. Compressibility per Niskanen.
 */
export function skinFriction(Re: number, M: number, L: number): number {
  const rs = SURFACE_ROUGHNESS / L;
  const cfRough = 0.032 * rs ** 0.2;
  const Rcrit = 51 * rs ** -1.039;
  const rough = Re > Rcrit;
  let cf: number;
  if (!(Re >= 1e4)) {
    cf = 1.48e-2;
  } else if (!rough) {
    cf = 1 / (1.5 * Math.log(Re) - 5.6) ** 2;
  } else {
    cf = cfRough;
  }
  if (M < 1) return cf * (1 - 0.1 * M * M);
  const floor = cfRough / (1 + 0.18 * M * M);
  return rough ? floor : Math.max(cf / (1 + 0.15 * M * M) ** 0.58, floor);
}

/** Mean aerodynamic chord of one fin's planform, m. */
function meanAerodynamicChord(f: FinSet): number {
  if (f.finShape === 'freeform') {
    const { area } = finPlanform(f);
    return f.span > 0 ? area / f.span : 0;
  }
  const Cr = f.rootChord;
  const Ct = f.finShape === 'elliptical' ? (PI / 2 - 1) * Cr : f.tipChord;
  if (!(Cr > 0)) return 0;
  const lambda = Ct / Cr;
  return (2 / 3) * Cr * (1 + lambda + lambda * lambda) / (1 + lambda);
}

/** Stagnation pressure ratio (1 + M²/4 + M⁴/40), valid for M < 1; held at M = 1 above. */
function stagnationRatio(M: number): number {
  const m = Math.min(M, 1);
  return 1 + (m * m) / 4 + m ** 4 / 40;
}

/**
 * Leading-edge pressure coefficient referenced to the fin frontal area t·s·N.
 * Square: blunt edge, 0.85 × stagnation ratio. Rounded and airfoil: rounded edge (Niskanen),
 * held at its M = 0.9 value above that.
 */
function finLeadingEdgeCd(M: number, section: NonNullable<FinSet['crossSection']>): number {
  if (section === 'square') return 0.85 * stagnationRatio(M);
  const m = Math.min(M, 0.9);
  return (1 - m * m) ** -0.417 - 1;
}

/**
 * Base-drag weight of the fin trailing edge, relative to its frontal area: a square edge
 * is a full blunt base, a rounded edge half, and an airfoil has no base drag.
 */
function finBaseWeight(section: NonNullable<FinSet['crossSection']>): number {
  switch (section) {
    case 'square': return 1;
    case 'airfoil': return 0;
    default: return 0.5;
  }
}

/**
 * Full zero-alpha drag build-up. Note: while the motor burns, OpenRocket removes the
 * nozzle part of the base area. aeroProps does not know the thrust, so the full body
 * base is kept here, which overstates base drag during boost by the nozzle share.
 * External rings (launch lugs, rail buttons) add protuberance pressure drag and skin friction.
 */
export function dragBreakdown(rocket: RocketModel, mach: number): DragBreakdown {
  const maxR = rocket.maxRadius;
  const A = PI * maxR * maxR;
  const L = rocket.length;
  const M = Math.max(0, mach);
  const invalid: DragBreakdown = { friction: 0.5, pressure: 0, base: 0, total: 0.5, cf: 0, reynolds: 0 };
  if (!(A > 0) || !(L > 0)) return invalid;

  const V = M * SOUND_SPEED_REF;
  const Re = (V * L) / NU_SEA_LEVEL;
  const cf = skinFriction(Re, M, L);

  const d = 2 * maxR;
  const fineness = L / d;
  const bodyFactor = 1 + 1 / (2 * Math.max(fineness, 1e-6));

  let wettedBody = 0; // nose, transitions and tubes
  let wettedFins = 0;
  let finFactorTerm = 0; // (1 + 2t/c) weighted fin wetted area
  let pressureNose = 0;
  let finLE = 0; // fin leading-edge drag, already referenced to A
  let finTrailing = 0; // fin trailing-edge area, base-drag weight applied below
  let protrusionPressure = 0; // external rings (lugs, rail buttons), referenced to A
  let aftRadius = 0;
  let sideBase = 0; // aft-facing area of side bodies, m^2

  /** Add one component, `n` times over. `aft` remembers the aft-most body radius of its stack. */
  const addPart = (c: Component, n: number, aft: { x: number; r: number }, openTube: boolean): void => {
    switch (c.kind) {
      case 'nosecone': {
        wettedBody += n * noseLateralArea(c);
        if (c.shape === 'conical' && M >= 0 && c.length > 0 && c.baseRadius > 0) {
          // Conical nose pressure drag, 0.8 sin²(half-angle), referenced to the nose base.
          const half = Math.atan(c.baseRadius / c.length);
          pressureNose += n * 0.8 * Math.sin(half) ** 2 * (c.baseRadius / maxR) ** 2;
        }
        if (c.x + c.length > aft.x) {
          aft.x = c.x + c.length;
          aft.r = c.baseRadius;
        }
        break;
      }
      case 'bodytube': {
        if (openTube) {
          // A tube fin is wetted inside and out; its blunt ends are thin rings.
          const ri = Math.max(0, c.outerRadius - c.thickness);
          wettedBody += n * 2 * PI * (c.outerRadius + ri) * c.length;
          const rim = PI * (c.outerRadius * c.outerRadius - ri * ri);
          protrusionPressure += (n * 0.8 * stagnationRatio(M) * rim) / A;
          sideBase += n * rim;
          break;
        }
        wettedBody += n * 2 * PI * c.outerRadius * c.length;
        if (c.x + c.length > aft.x) {
          aft.x = c.x + c.length;
          aft.r = c.outerRadius;
        }
        break;
      }
      case 'transition': {
        const R1 = c.foreRadius;
        const R2 = c.aftRadius;
        wettedBody += n * PI * (R1 + R2) * Math.sqrt((R1 - R2) ** 2 + c.length ** 2);
        if (c.x + c.length > aft.x) {
          aft.x = c.x + c.length;
          aft.r = c.aftRadius;
        }
        break;
      }
      case 'finset': {
        const { area } = finPlanform(c);
        const N = Math.max(0, c.count) * n;
        const wetted = 2 * area * N;
        wettedFins += wetted;
        const mac = meanAerodynamicChord(c);
        const thickFactor = mac > 0 ? 1 + (2 * c.thickness) / mac : 1;
        finFactorTerm += thickFactor * wetted;
        const section = c.crossSection ?? DEFAULT_FIN_SECTION;
        const frontal = c.thickness * c.span * N;
        finLE += (finLeadingEdgeCd(M, section) * frontal) / A;
        finTrailing += finBaseWeight(section) * frontal;
        break;
      }
      case 'ring': {
        if (!c.external) break;
        // Protuberance on the outside of the body: its wetted outer surface and its frontal
        // area (annulus for a tube, disc if solid) see the flow.
        const ro = c.outerRadius;
        const ri = Math.max(0, c.innerRadius);
        wettedBody += n * 2 * PI * ro * c.length;
        const frontalArea = ri > 0 ? PI * (ro * ro - ri * ri) : PI * ro * ro;
        protrusionPressure += (n * 0.8 * stagnationRatio(M) * frontalArea) / A;
        break;
      }
      default:
        break;
    }
  };

  const mainAft = { x: -Infinity, r: 0 };
  for (const c of rocket.components) addPart(c, 1, mainAft, false);
  aftRadius = mainAft.r;

  // Boosters, pods and tube fins: their skin, noses, fins and blunt aft ends all drag.
  for (const sb of rocket.sideBodies ?? []) {
    const n = Math.max(1, Math.round(sb.count) || 1);
    const aft = { x: -Infinity, r: 0 };
    for (const c of sb.components) addPart(c, n, aft, sb.type === 'tubefin');
    sideBase += n * PI * aft.r * aft.r;
  }

  // Skin friction: body (with fineness correction) plus fins, referenced to A.
  const friction = (cf * (bodyFactor * wettedBody + finFactorTerm)) / A;

  // Base drag on the full aft body disc plus the fin trailing-edge area.
  const aftArea = PI * aftRadius * aftRadius + finTrailing + sideBase;
  const cdBase0 = M < 1 ? 0.12 + 0.13 * M * M : 0.25 / Math.max(M, 1e-6);
  const base = (cdBase0 * aftArea) / A;

  const pressure = pressureNose + finLE + protrusionPressure + transonicWaveCd(M);
  const total = friction + pressure + base;
  const ok = Number.isFinite(total) && total > 0;
  return {
    friction: ok ? friction : 0.5,
    pressure: ok ? pressure : 0,
    base: ok ? base : 0,
    total: ok ? total : 0.5,
    cf,
    reynolds: Re,
  };
}

/**
 * Transonic and supersonic wave-drag increment (referenced to body frontal area).
 * Uncalibrated placeholder with a typical magnitude (0.30 peak at Mach 1.15):
 * exact 0 below drag-divergence Mach 0.8 so subsonic results are unchanged,
 * smoothstep rise across Mach 0.8..1.15, and 1 / sqrt(M^2 - 1) decay above 1.15.
 */
export function transonicWaveCd(M: number): number {
  if (!(M > 0.8)) return 0;
  const peakCd = 0.30;
  const mPeak = 1.15;
  if (M < mPeak) {
    const t = (M - 0.8) / (mPeak - 0.8);
    return peakCd * t * t * (3 - 2 * t);
  }
  return peakCd * Math.sqrt((mPeak * mPeak - 1) / (M * M - 1));
}

// ---------- Public ----------

export const aeroProps: AeroPropsFn = (rocket: RocketModel, mach: number, cgX: number): AeroProps => {
  const maxR = rocket.maxRadius;
  const refArea = PI * maxR * maxR;
  const refLength = 2 * maxR;
  const d = refLength;
  const L = rocket.length;

  const comps: { cn: number; cp: number }[] = [];
  const comp = (c: Component): void => {
    switch (c.kind) {
      case 'nosecone':
        comps.push({ cn: noseCnAlpha(c, maxR), cp: c.x + c.length * noseCpFraction(c.shape) });
        break;
      case 'transition':
        comps.push({ cn: transitionCnAlpha(c, maxR), cp: transitionCpX(c) });
        break;
      case 'finset': {
        const cnInc = finCnAlphaIncompressible(c, d);
        comps.push({ cn: cnInc * compressibilityFactor(Math.max(0, mach)), cp: finCpX(c) });
        break;
      }
      default:
        // Body tubes contribute no CNα at zero alpha; the sim adds body lift separately.
        break;
    }
  };
  for (const c of rocket.components) comp(c);

  // Side bodies. Each copy's nose, transitions and fins lift as they would alone
  // (Barrowman, no interference between neighbours). Tube fins use slender-body theory:
  // the cluster lifts like the circle that encloses it, less the body it surrounds.
  for (const sb of rocket.sideBodies ?? []) {
    const n = Math.max(1, Math.round(sb.count) || 1);
    if (sb.type === 'tubefin') {
      const t = sb.components[0];
      if (!t || t.kind !== 'bodytube' || !(maxR > 0)) continue;
      const a = sb.radialOffset - t.outerRadius; // body radius the tubes sit on
      const s = sb.radialOffset + t.outerRadius; // radius of the enclosing circle
      const full = (2 * (s * s - a * a)) / (maxR * maxR);
      comps.push({
        cn: full * Math.min(1, n / 3) * compressibilityFactor(Math.max(0, mach)),
        cp: t.x + t.length / 4,
      });
      continue;
    }
    const before = comps.length;
    for (const c of sb.components) comp(c);
    for (let k = before; k < comps.length; k++) comps[k].cn *= n;
  }

  let cnAlpha = 0;
  let cpNum = 0;
  for (const e of comps) {
    cnAlpha += e.cn;
    cpNum += e.cn * e.cp;
  }
  const cpX = Math.abs(cnAlpha) > 1e-12 ? cpNum / cnAlpha : L / 2;

  let dampSum = 0;
  for (const e of comps) {
    const dx = e.cp - cgX;
    dampSum += e.cn * dx * dx;
  }

  return {
    refArea,
    refLength,
    cnAlpha,
    cpX,
    cd: dragBreakdown(rocket, mach).total,
    dampSum,
  };
};
