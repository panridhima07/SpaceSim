// Mass, centre of gravity and inertia of a rocket model, optionally with a
// motor at a given burn time.

import type { Component, FinSet, Motor, MassProps, MassPropsFn, NoseCone, RocketModel, Transition, InnerTube } from '../types';

const PI = Math.PI;
const MIN_INERTIA = 1e-9;
/** Integration steps along a nose cone profile (midpoint rule). */
const NOSE_STEPS = 400;

/** One mass element: its mass, CG station, and inertia terms. */
interface Part {
  m: number;
  /** CG station from nose tip, m. */
  cg: number;
  /** Own transverse inertia about the part's own CG (pitch/yaw). */
  ownPitch: number;
  /** Roll inertia about the rocket axis. */
  roll: number;
  /** Extra pitch inertia from radial offset of the part's CG (for fins). */
  radialPitch: number;
}

/** Transverse inertia of a hollow cylinder about its centre: m(3(ro²+ri²)+L²)/12. */
function transverse(m: number, ro: number, ri: number, L: number): number {
  return (m * (3 * (ro * ro + ri * ri) + L * L)) / 12;
}

/** Roll inertia of a hollow cylinder: m(ro²+ri²)/2. */
function rollTube(m: number, ro: number, ri: number): number {
  return (m * (ro * ro + ri * ri)) / 2;
}

// ---------- Nose cone ----------

/**
 * Outer radius of a nose profile at distance s (m) aft of the tip, for a nose of base
 * radius R and length L. Standard profiles; the ogive is the tangent (secant-0) ogive.
 */
export function noseRadius(shape: NoseCone['shape'], R: number, L: number, param: number, s: number): number {
  if (!(L > 0) || !(R > 0)) return 0;
  const t = Math.min(1, Math.max(0, s / L));
  switch (shape) {
    case 'conical':
      return R * t;
    case 'ellipsoid':
      return R * Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    case 'parabolic':
      return R * (2 * t - t * t);
    case 'power':
      return R * t ** (param > 0 ? param : 0.5);
    case 'haack': {
      // Haack series with C = 0 (LD-Haack): theta = acos(1 - 2t).
      const th = Math.acos(1 - 2 * t);
      return R * Math.sqrt(Math.max(0, th - Math.sin(2 * th) / 2) / PI);
    }
    default: {
      // Tangent ogive: circle of radius rho, centred so the profile meets the body tangentially.
      const rho = (R * R + L * L) / (2 * R);
      const x = L - s;
      return Math.sqrt(Math.max(0, rho * rho - x * x)) + R - rho;
    }
  }
}

interface NoseIntegrals {
  /** Lateral (wetted) area, m². */
  lateral: number;
  /** Solid volume, m³. */
  volume: number;
  /** Centroid of the lateral area, m from the nose tip. */
  cgLateral: number;
  /** Centroid of the volume, m from the nose tip. */
  cgVolume: number;
}

/** Numerical lateral area, volume and centroids of a nose cone profile. */
function noseIntegrals(c: NoseCone): NoseIntegrals {
  const R = c.baseRadius;
  const L = c.length;
  const zero: NoseIntegrals = { lateral: 0, volume: 0, cgLateral: L / 2, cgVolume: L / 2 };
  if (!(L > 0) || !(R > 0)) return zero;
  const h = L / NOSE_STEPS;
  const eps = h * 1e-3;
  const r = (s: number): number => noseRadius(c.shape, R, L, c.shapeParam, s);
  let lateral = 0;
  let volume = 0;
  let sLat = 0;
  let sVol = 0;
  for (let i = 0; i < NOSE_STEPS; i++) {
    const s = (i + 0.5) * h;
    const rs = r(s);
    // Central difference slope, clipped at the tip where the profile is vertical.
    const slope = Math.min(
      1e3,
      Math.abs((r(Math.min(L, s + eps)) - r(Math.max(0, s - eps))) / (2 * eps)),
    );
    const dA = 2 * PI * rs * Math.sqrt(1 + slope * slope) * h;
    const dV = PI * rs * rs * h;
    lateral += dA;
    volume += dV;
    sLat += dA * s;
    sVol += dV * s;
  }
  return {
    lateral,
    volume,
    cgLateral: lateral > 0 ? sLat / lateral : L / 2,
    cgVolume: volume > 0 ? sVol / volume : L / 2,
  };
}

/** Lateral (outside) area of a nose cone, m². Used for skin friction. */
export function noseLateralArea(c: NoseCone): number {
  return noseIntegrals(c).lateral;
}

function noseParts(c: NoseCone): Part[] {
  const R = c.baseRadius;
  const L = c.length;
  const solid = !(c.thickness > 0);
  const I = noseIntegrals(c);
  let m: number;
  if (c.massOverride !== undefined) {
    m = c.massOverride;
  } else if (solid) {
    m = c.density * I.volume;
  } else {
    m = c.density * c.thickness * I.lateral;
  }
  const cgFromTip = solid ? I.cgVolume : I.cgLateral;
  const cg = c.cgOverride ?? c.x + cgFromTip;
  const ri = solid ? 0 : Math.max(0, R - c.thickness);
  // Solid cone roll inertia is 3/10 m R²; a thin shell is ~ m R².
  const roll = solid ? 0.3 * m * R * R : rollTube(m, R, ri);
  return [{ m, cg, ownPitch: transverse(m, R, ri, L), roll, radialPitch: 0 }];
}

// ---------- Transition ----------

function transitionParts(c: Transition): Part[] {
  const R1 = c.foreRadius;
  const R2 = c.aftRadius;
  const L = c.length;
  const solid = !(c.thickness > 0);
  let m: number;
  let cgFrac: number;
  if (c.massOverride !== undefined) {
    m = c.massOverride;
  } else if (solid) {
    m = c.density * (PI * L / 3) * (R1 * R1 + R1 * R2 + R2 * R2);
  } else {
    const slant = Math.sqrt((R1 - R2) * (R1 - R2) + L * L);
    m = c.density * c.thickness * PI * (R1 + R2) * slant;
  }
  if (solid) {
    const den = R1 * R1 + R1 * R2 + R2 * R2;
    cgFrac = den > 0 ? (R1 * R1 + 2 * R1 * R2 + 3 * R2 * R2) / (4 * den) : 0.5;
  } else {
    const sum = R1 + R2;
    cgFrac = sum > 0 ? (R1 + 2 * R2) / (3 * sum) : 0.5;
  }
  const cg = c.cgOverride ?? c.x + L * cgFrac;
  const ro = Math.max(R1, R2);
  const ri = solid ? 0 : Math.max(0, ro - c.thickness);
  return [{ m, cg, ownPitch: transverse(m, ro, ri, L), roll: rollTube(m, ro, ri), radialPitch: 0 }];
}

// ---------- Fins ----------

/** Planform area and chordwise centroid (from root leading edge) of a fin set's single fin. */
export function finPlanform(f: FinSet): { area: number; xbar: number } {
  if (f.finShape === 'freeform' && f.points && f.points.length >= 3) {
    const pts = f.points;
    let a2 = 0; // twice signed area
    let cx = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      const cross = x0 * y1 - x1 * y0;
      a2 += cross;
      cx += (x0 + x1) * cross;
    }
    const area = Math.abs(a2) / 2;
    if (area > 0) {
      return { area, xbar: Math.abs(cx / (3 * a2)) };
    }
    return { area: 0, xbar: f.rootChord / 2 };
  }
  if (f.finShape === 'elliptical') {
    return { area: (PI / 4) * f.rootChord * f.span, xbar: f.rootChord / 2 };
  }
  const Cr = f.rootChord;
  const Ct = f.tipChord;
  const s = f.span;
  const m = f.sweepLength;
  const area = ((Cr + Ct) / 2) * s;
  const den = 3 * (Cr + Ct);
  const xbar = den > 0 ? (m * (Cr + 2 * Ct) + Cr * Cr + Cr * Ct + Ct * Ct) / den : Cr / 2;
  return { area, xbar };
}

function finParts(f: FinSet): Part[] {
  const { area, xbar } = finPlanform(f);
  const mEach = f.density * f.thickness * area;
  const N = Math.max(0, f.count);
  const m = f.massOverride !== undefined ? f.massOverride : mEach * N;
  const cg = f.cgOverride ?? f.x + xbar;
  // Radial distance from rocket axis to the fin's span centroid.
  const rFin = f.bodyRadius + f.span / 2;
  // Plate pitching about an axis perpendicular to its span and chord: m(s² + c²)/12.
  const ownPitch = (m * (f.span * f.span + f.rootChord * f.rootChord)) / 12;
  return [
    {
      m,
      cg,
      ownPitch,
      roll: m * rFin * rFin,
      radialPitch: (m * rFin * rFin) / 2,
    },
  ];
}

// ---------- Tubes, rings, point masses ----------

function tubeParts(c: InnerTube | Component): Part[] {
  if (c.kind === 'bodytube' || c.kind === 'innertube') {
    const ro = c.outerRadius;
    const ri = Math.max(0, ro - c.thickness);
    const area = PI * (ro * ro - ri * ri);
    const m = c.massOverride ?? c.density * area * c.length;
    const cg = c.cgOverride ?? c.x + c.length / 2;
    return [{ m, cg, ownPitch: transverse(m, ro, ri, c.length), roll: rollTube(m, ro, ri), radialPitch: 0 }];
  }
  if (c.kind === 'ring') {
    const ro = c.outerRadius;
    const ri = Math.max(0, c.innerRadius);
    const area = PI * (ro * ro - ri * ri);
    const m = c.massOverride ?? c.density * area * c.length;
    const cg = c.cgOverride ?? c.x + c.length / 2;
    return [{ m, cg, ownPitch: transverse(m, ro, ri, c.length), roll: rollTube(m, ro, ri), radialPitch: 0 }];
  }
  return [];
}

function componentParts(c: Component): Part[] {
  switch (c.kind) {
    case 'nosecone':
      return noseParts(c);
    case 'transition':
      return transitionParts(c);
    case 'finset':
      return finParts(c);
    case 'bodytube':
    case 'innertube':
    case 'ring':
      return tubeParts(c);
    case 'parachute': {
      const m = c.massOverride ?? c.mass;
      const cg = c.cgOverride ?? c.x + c.length / 2;
      return [{ m, cg, ownPitch: (m * c.length * c.length) / 12, roll: 0, radialPitch: 0 }];
    }
    case 'mass': {
      const m = c.massOverride ?? c.mass;
      const cg = c.cgOverride ?? c.x + c.length / 2;
      return [{ m, cg, ownPitch: (m * c.length * c.length) / 12, roll: 0, radialPitch: 0 }];
    }
  }
}

// ---------- Motor ----------

/** Total impulse delivered by the curve up to time t (trapezoid integral). */
export function impulseUpTo(curve: [number, number][], t: number): number {
  if (curve.length < 2) return 0;
  let I = 0;
  for (let i = 1; i < curve.length; i++) {
    const [t0, F0] = curve[i - 1];
    const [t1, F1] = curve[i];
    if (t <= t0) break;
    if (t >= t1) {
      I += ((F0 + F1) / 2) * (t1 - t0);
    } else {
      // Partial segment: thrust linearly interpolated at t.
      const Ft = F0 + ((F1 - F0) * (t - t0)) / (t1 - t0);
      I += ((F0 + Ft) / 2) * (t - t0);
      break;
    }
  }
  return I;
}

function curveTotalImpulse(curve: [number, number][]): number {
  if (curve.length < 2) return 0;
  return impulseUpTo(curve, curve[curve.length - 1][0]);
}

/** Fraction of total impulse still to be delivered at time tBurn (1 = full propellant). */
function remainingFraction(motor: Motor, tBurn: number): number {
  if (!(tBurn > 0)) return 1;
  const total = curveTotalImpulse(motor.curve);
  if (!(total > 0)) return 1;
  const delivered = impulseUpTo(motor.curve, tBurn) / total;
  return Math.min(1, Math.max(0, 1 - delivered));
}

function motorParts(rocket: RocketModel, motor: Motor, tBurn: number): Part[] {
  // Find the motor mount: first innertube flagged isMotorMount, else the aft end of the rocket.
  const mount = rocket.components.find(
    (c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount,
  );
  const aft = mount ? mount.x + mount.length + mount.overhang : rocket.length;
  const fore = aft - motor.length;
  const mid = (fore + aft) / 2;

  const d = motor.diameter;
  const ro = d / 2;
  const ri = 0.9 * ro; // casing wall is a thin shell
  const propRadius = 0.9 * ro;

  const frac = remainingFraction(motor, tBurn);
  const mPropRemaining = motor.propellantMass * frac;
  const mCasing = Math.max(0, motor.totalMass - motor.propellantMass);

  const parts: Part[] = [];
  parts.push({
    m: mCasing,
    cg: mid,
    ownPitch: transverse(mCasing, ro, ri, motor.length),
    roll: rollTube(mCasing, ro, ri),
    radialPitch: 0,
  });
  if (mPropRemaining > 0) {
    parts.push({
      m: mPropRemaining,
      cg: mid,
      ownPitch: transverse(mPropRemaining, propRadius, 0, motor.length),
      roll: rollTube(mPropRemaining, propRadius, 0),
      radialPitch: 0,
    });
  }
  return parts;
}

// ---------- Totals ----------

export const massProps: MassPropsFn = (
  rocket: RocketModel,
  motor: Motor | null,
  tBurn: number,
): MassProps => {
  const parts: Part[] = [];
  for (const c of rocket.components) {
    parts.push(...componentParts(c));
  }
  if (motor) {
    parts.push(...motorParts(rocket, motor, tBurn));
  }

  let mass = 0;
  let mx = 0;
  let iRollSum = 0;
  for (const p of parts) {
    mass += p.m;
    mx += p.m * p.cg;
    iRollSum += p.roll;
  }

  const cgX = mass > 0 ? mx / mass : rocket.length / 2;

  let iPitch = 0;
  for (const p of parts) {
    const dx = p.cg - cgX;
    iPitch += p.ownPitch + p.radialPitch + p.m * dx * dx;
  }

  return {
    mass,
    cgX,
    iRoll: Math.max(MIN_INERTIA, iRollSum),
    iPitch: Math.max(MIN_INERTIA, iPitch),
  };
};
