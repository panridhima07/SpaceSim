// Aerodynamic coefficients: Barrowman method for normal force and centre of
// pressure, plus a component build-up of zero-alpha drag following OpenRocket
// (Niskanen 2009): skin friction, base drag and pressure drag.

import type { AeroProps, AeroPropsFn, Component, FinSet, NoseCone, RocketModel, Transition } from '../types';
import { finPlanform, noseLateralArea, noseRadius } from './massprops';

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

/**
 * Incompressible Barrowman CNα of a fin set (per radian), referenced to refArea.
 *
 * Body-fin interference: the classical Barrowman report multiplies by Kfb = 1 + rb/(s + rb)
 * once. The CNα that OpenRocket stores in its own flight data (the `cna` column of the
 * example .ork files) equals this slope multiplied by Kfb twice: within 0.4 % on "A simple
 * model rocket" (Kfb 1.294), "Dual parachute deployment" (1.271) and the "Two stage high
 * power rocket" (1.250 and 1.235), once its body lift term is taken out. A single Kfb read
 * 18 to 24 % low on all three. OpenRocket is the validation reference, so it is matched
 * here; src/validate/aeroOpenRocket.test.ts pins it.
 */
/** Below this Mach the subsonic fin lift formula is used, above CNA_SUPERSONIC the supersonic one. */
const CNA_SUBSONIC = 0.9;
const CNA_SUPERSONIC = 1.5;

/** Cubic Hermite through (x0, y0) with slope m0 and (x1, y1) with slope m1, evaluated at x. */
function hermite(x: number, x0: number, y0: number, m0: number, x1: number, y1: number, m1: number): number {
  const h = x1 - x0;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1;
}

/**
 * CNα of a fin set (per radian, referenced to the body frontal area) at Mach M, following
 * OpenRocket (FinSetCalc), which is this project's validation reference:
 * - M <= 0.9: Diederich's finite-wing slope with the compressibility inside the root,
 *   2π s² / (1 + sqrt(1 + (1 - M²) X²)), X = s² / (A cosΓ) = 2 l / (Cr + Ct). It stays finite at
 *   Mach 1, unlike a Prandtl-Glauert multiplier, which overstated a typical fin by 50 % at Mach 0.8.
 * - M >= 1.5: linear supersonic theory per fin, A K1 with K1 = 2 / sqrt(M² - 1).
 * - Between: a cubic matching both values and slopes.
 * Body-fin interference Kfb is applied twice and the fin-count table once, as before (see the note
 * on Kfb above). Checked against the stored flight data of OpenRocket's "Dual parachute deployment"
 * example up to Mach 1.13 in src/validate/aeroOpenRocket.test.ts.
 */
function finCnAlpha(f: FinSet, d: number, M: number): number {
  const t = trapOf(f);
  const { Cr, Ct, s, m, rb } = t;
  const N = Math.max(0, f.count);
  if (!(s > 0) || !(Cr + Ct > 0) || !(d > 0) || N === 0) return 0;
  const l = Math.sqrt(s * s + (m + Ct / 2 - Cr / 2) ** 2);
  const Kfb = 1 + rb / (s + rb);
  const X2 = (2 * l / (Cr + Ct)) ** 2;
  const scale = Kfb * Kfb * finCountFactor(N);
  const sub = (mach: number): number => (4 * N * (s / d) ** 2) / (1 + Math.sqrt(1 + (1 - mach * mach) * X2));
  if (!(M > CNA_SUBSONIC)) return scale * sub(Math.max(0, M));
  // Planform area of one fin; Aref = π d² / 4.
  const area = f.finShape === 'freeform' ? finPlanform(f).area : ((t.Cr + t.Ct) / 2) * s;
  const aRef = (PI * d * d) / 4;
  const sup = (mach: number): number => (N * area) / (Math.sqrt(mach * mach - 1) * aRef);
  if (M >= CNA_SUPERSONIC) return scale * sup(M);
  const e = 1e-4;
  const m0 = (sub(CNA_SUBSONIC) - sub(CNA_SUBSONIC - e)) / e;
  const m1 = (sup(CNA_SUPERSONIC + e) - sup(CNA_SUPERSONIC)) / e;
  return scale * hermite(M, CNA_SUBSONIC, sub(CNA_SUBSONIC), m0, CNA_SUPERSONIC, sup(CNA_SUPERSONIC), m1);
}

/** Body lift constant K in CN = K (A_planform / A_ref) sin²α (Galejs; OpenRocket uses 1.1). */
const BODY_LIFT_K = 1.1;

/**
 * Side-view (planform) area of the main body, m², and its centroid station from the nose tip.
 * Body lift acts at that centroid, not at the Barrowman CP. Falls back to the bounding
 * rectangle when the stack has no body parts.
 */
function bodyPlanform(rocket: RocketModel): { area: number; x: number } {
  let area = 0;
  let moment = 0;
  const add = (a: number, x: number): void => {
    if (a > 0 && Number.isFinite(a) && Number.isFinite(x)) {
      area += a;
      moment += a * x;
    }
  };
  for (const c of rocket.components) {
    if (c.kind === 'bodytube') {
      add(2 * c.outerRadius * c.length, c.x + c.length / 2);
    } else if (c.kind === 'transition') {
      const rf = c.foreRadius;
      const ra = c.aftRadius;
      const sum = rf + ra;
      if (sum > 0) add(sum * c.length, c.x + (c.length * (rf + 2 * ra)) / (3 * sum));
    } else if (c.kind === 'nosecone' && c.length > 0) {
      // Midpoint rule over the profile; 32 slices is well under 0.1 % for every shape.
      const n = 32;
      const h = c.length / n;
      let a = 0;
      let mx = 0;
      for (let i = 0; i < n; i++) {
        const s = (i + 0.5) * h;
        const w = 2 * noseRadius(c.shape, c.baseRadius, c.length, c.shapeParam, s) * h;
        a += w;
        mx += w * s;
      }
      if (a > 0) {
        const fromTip = mx / a;
        add(a, c.flipped ? c.x + c.length - fromTip : c.x + fromTip);
      }
    }
  }
  if (area > 0) return { area, x: moment / area };
  return { area: 2 * rocket.maxRadius * rocket.length, x: rocket.length / 2 };
}

/**
 * Fin CP station from the body nose tip, at Mach M. Barrowman's subsonic CP is the quarter chord of
 * the mean aerodynamic chord (MAC). Supersonic lift moves aft towards mid-chord; OpenRocket uses
 * (AR β - 0.67) / (2 AR β - 1) of the MAC at Mach 2 and above (AR = 2 s² / A) and blends from the
 * quarter chord at Mach 0.5, which is what is done here (cubic, flat at 0.5).
 */
function finCpX(f: FinSet, M = 0): number {
  const t = trapOf(f);
  const { Cr, Ct, m, s } = t;
  if (!(Cr + Ct > 0)) return f.x + f.rootChord / 2;
  const mac = (2 / 3) * (Cr + Ct - (Cr * Ct) / (Cr + Ct));
  const macLe = (m / 3) * ((Cr + 2 * Ct) / (Cr + Ct));
  return f.x + macLe + finCpFraction(M, s, ((Cr + Ct) / 2) * s) * mac;
}

/** Fin CP as a fraction of the MAC behind its leading edge (0.25 subsonic). */
export function finCpFraction(M: number, span: number, area: number): number {
  if (!(M > 0.5) || !(span > 0) || !(area > 0)) return 0.25;
  const ar = (2 * span * span) / area;
  const sup = (mach: number): number => {
    const x = ar * Math.sqrt(mach * mach - 1);
    // Very low aspect ratios make the formula fall below the quarter chord; it is not used there.
    return x > 1 ? Math.min(0.5, Math.max(0.25, (x - 0.67) / (2 * x - 1))) : 0.25;
  };
  if (M >= 2) return sup(M);
  const e = 1e-4;
  return hermite(M, 0.5, 0.25, 0, 2, sup(2), (sup(2 + e) - sup(2)) / e);
}

/**
 * Compressibility factor applied to fin CNα.
 * Subsonic: Prandtl-Glauert 1/sqrt(1-M²). Supersonic: 1/sqrt(M²-1).
 * Transonic 0.8..1.2: a straight line between the two ends, so the factor (and with it the
 * centre of pressure) has no step. Both formulas blow up at Mach 1, which is why neither is
 * used there.
 */
export function compressibilityFactor(M: number): number {
  if (M < 0.8) return 1 / Math.sqrt(1 - M * M);
  if (M > 1.2) return 1 / Math.sqrt(M * M - 1);
  const lo = 1 / Math.sqrt(1 - 0.8 * 0.8);
  const hi = 1 / Math.sqrt(1.2 * 1.2 - 1);
  return lo + ((hi - lo) * (M - 0.8)) / 0.4;
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

/**
 * Stagnation pressure over dynamic pressure (Niskanen 2009): 1 + M²/4 + M⁴/40 below Mach 1, and
 * behind the normal shock above it, 1.84 - 0.76/M² + 0.166/M⁴ + 0.035/M⁶.
 */
function stagnationRatio(M: number): number {
  if (M <= 1) return 1 + (M * M) / 4 + M ** 4 / 40;
  const m2 = M * M;
  return 1.84 - 0.76 / m2 + 0.166 / (m2 * m2) + 0.035 / (m2 * m2 * m2);
}

/**
 * Leading-edge pressure coefficient referenced to the fin frontal area t·s·N (Niskanen 2009).
 * Square: blunt edge, 0.85 × stagnation ratio. Rounded and airfoil: rounded edge,
 * (1 - M²)^-0.417 - 1 to Mach 0.9, a straight line to Mach 1, and 1.214 - 0.502/M² + 0.1095/M⁴ above.
 */
function finLeadingEdgeCd(M: number, section: NonNullable<FinSet['crossSection']>): number {
  if (section === 'square') return 0.85 * stagnationRatio(M);
  if (M < 0.9) return (1 - M * M) ** -0.417 - 1;
  if (M < 1) return 1 - 1.785 * (M - 0.9);
  const m2 = M * M;
  return 1.214 - 0.502 / m2 + 0.1095 / (m2 * m2);
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
        pressureNose += n * noseWaveCd(M, c.shape, c.length, c.baseRadius, c.shapeParam) * (c.baseRadius / maxR) ** 2;
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
        if (R2 > R1 && c.length > 0) {
          // A shoulder makes wave drag like the cone it is cut from, on its annulus.
          pressureNose += n * noseWaveCd(M, 'conical', c.length, R2 - R1, 1) * ((R2 * R2 - R1 * R1) / (maxR * maxR));
        }
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

  const pressure = pressureNose + finLE + protrusionPressure;
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

// ---------- Nose and shoulder wave drag ----------

/** Wave drag starts rising here (drag-divergence Mach) and is fully developed at WAVE_M1. */
const WAVE_M0 = 0.86;
const WAVE_M1 = 1.1;

/**
 * Pressure drag of a cone with half angle φ (sin φ given), referenced to its base area, at
 * Mach 1 and above (Hoerner; Niskanen 2009): sin φ at Mach 1, 2.1 sin²φ + 0.5 sin φ / sqrt(M² - 1)
 * from Mach 1.3, a cubic in between. Below Mach 1 the Mach 1 value is returned.
 */
export function coneWaveCd(M: number, sinPhi: number): number {
  const s2 = sinPhi * sinPhi;
  const sup = (m: number): number => 2.1 * s2 + (0.5 * sinPhi) / Math.sqrt(m * m - 1);
  if (M >= 1.3) return sup(M);
  if (!(M > 1)) return sinPhi;
  const e = 1e-4;
  return hermite(M, 1, sinPhi, 0, 1.3, sup(1.3), (sup(1.3 + e) - sup(1.3)) / e);
}

/**
 * Transonic and supersonic drag of a nose shape relative to a cone of the same length and base
 * (the cone itself follows Hoerner, coneWaveCd). Ogive 1.6 is fitted to OpenRocket's stored data
 * for a fineness-5 tangent ogive (Dual parachute deployment, J570W flight to Mach 1.13). The others
 * are set relative to the ogive from the published ranking of nose shapes near Mach 1 (Stoney,
 * fineness 3: Haack, parabolic and 3/4-power noses below the ogive, half-power and ellipsoid
 * noses above). They have no reference data in this project and are estimates.
 */
function noseWaveFactor(shape: NoseCone['shape'], param: number): number {
  switch (shape) {
    case 'conical': return 1;
    case 'ogive': return 1.6;
    case 'haack': return 1.2;
    case 'parabolic': return 1.3;
    case 'ellipsoid': return 2.4;
    case 'power': {
      const n = param > 0 ? param : 0.5;
      if (n >= 1) return 1;
      if (n >= 0.75) return 1.3 - 1.2 * (n - 0.75);
      if (n >= 0.5) return 1.9 - 2.4 * (n - 0.5);
      return Math.min(2.4, 1.9 + 2 * (0.5 - n));
    }
  }
}

/**
 * Wave drag a nose adds above its subsonic pressure drag, referenced to the nose base area.
 * It rises from Mach 0.86 to 1.1 (smoothstep, fitted to the same OpenRocket flight) towards the
 * shape factor times the cone value. A cone's subsonic 0.8 sin²φ is counted separately, so only
 * the excess is returned for it.
 */
export function noseWaveCd(M: number, shape: NoseCone['shape'], length: number, baseRadius: number, param: number): number {
  if (!(M > WAVE_M0) || !(length > 0) || !(baseRadius > 0)) return 0;
  const sinPhi = Math.sin(Math.atan(baseRadius / length));
  const t = Math.min(1, (M - WAVE_M0) / (WAVE_M1 - WAVE_M0));
  const rise = t * t * (3 - 2 * t);
  const cone = coneWaveCd(M, sinPhi);
  if (shape === 'conical') return rise * Math.max(0, cone - 0.8 * sinPhi * sinPhi);
  return rise * noseWaveFactor(shape, param) * cone;
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
        const M = Math.max(0, mach);
        comps.push({ cn: finCnAlpha(c, d, M), cp: finCpX(c, M) });
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

  const body = bodyPlanform(rocket);
  const drag = dragBreakdown(rocket, mach);

  return {
    refArea,
    refLength,
    cnAlpha,
    cpX,
    cd: drag.total,
    dampSum,
    bodyLift: refArea > 0 ? (BODY_LIFT_K * body.area) / refArea : 0,
    bodyLiftX: body.x,
    cdFriction: drag.friction,
    cfRef: drag.cf,
  };
};

/**
 * Drag coefficient with the skin friction recomputed at the actual Reynolds number. aeroProps
 * evaluates friction at a sea-level Reynolds number for the Mach number (it is cached by Mach
 * alone); higher up the air is thinner and colder, the Reynolds number drops (2.4 times lower at
 * 10 km for the same Mach) and turbulent friction rises. Viscosity from Sutherland's law.
 */
export function cdAtReynolds(
  aero: AeroProps,
  mach: number,
  speed: number,
  rho: number,
  temperature: number,
  length: number,
): number {
  const fr = aero.cdFriction;
  const cf0 = aero.cfRef;
  if (!(fr !== undefined && fr > 0) || !(cf0 !== undefined && cf0 > 0) || !(speed > 0) || !(rho > 0) || !(temperature > 0) || !(length > 0)) {
    return aero.cd;
  }
  const mu = (1.458e-6 * temperature * Math.sqrt(temperature)) / (temperature + 110.4);
  const cf = skinFriction((rho * speed * length) / mu, Math.max(0, mach), length);
  const cd = aero.cd + fr * (cf / cf0 - 1);
  return Number.isFinite(cd) && cd > 0 ? cd : aero.cd;
}
