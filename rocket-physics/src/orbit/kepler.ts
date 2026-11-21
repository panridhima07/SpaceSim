// Two-body (Keplerian) orbital mechanics: classical orbital elements <-> Cartesian state,
// Kepler's equation for elliptic and hyperbolic orbits, and universal-variable propagation.
// Pure functions. SI units (m, s, rad). mu defaults to Earth's gravitational parameter.

import { MU_EARTH } from '../constants.ts';
import { add, cross, dot, norm, rotZ, scale, sub, type Vec3 } from '../math/vec.ts';

export interface OrbitalElements {
  a: number; // semi-major axis, m (negative for hyperbola, Infinity for parabola)
  e: number; // eccentricity
  i: number; // inclination, rad, 0..pi
  raan: number; // right ascension of ascending node, rad, 0..2pi (0 if equatorial)
  argp: number; // argument of periapsis, rad, 0..2pi (from node; from +X if equatorial; 0 if circular)
  nu: number; // true anomaly, rad, 0..2pi (circular: argument of latitude, or true longitude if equatorial)
  h: number; // specific angular momentum magnitude, m^2/s
  energy: number; // specific orbital energy, J/kg
  period: number; // s, Infinity if e >= 1
  rp: number; // periapsis radius, m
  ra: number; // apoapsis radius, m, Infinity if e >= 1
  p: number; // semi-latus rectum, m
}

const TAU = 2 * Math.PI;
/** Eccentricity below which an orbit is treated as circular (periapsis undefined). */
const CIRCULAR_TOL = 1e-10;
/** Node-vector length (relative to h) below which an orbit is treated as equatorial. */
const EQUATORIAL_TOL = 1e-12;

/** Wrap an angle into [0, 2pi). */
function wrap(x: number): number {
  const y = x % TAU;
  const w = y < 0 ? y + TAU : y;
  return w >= TAU ? 0 : w;
}

/** Stumpff C(z) = (1 - cos sqrt z)/z (z > 0) or (cosh sqrt(-z) - 1)/(-z) (z < 0); Taylor series near 0. */
function stumpffC(z: number): number {
  if (Math.abs(z) < 0.5) {
    let p = 1, tc = 0.5, c = 0;
    for (let n = 0; n < 30; n++) {
      c += p * tc;
      p *= -z;
      tc /= (2 * n + 3) * (2 * n + 4);
    }
    return c;
  }
  if (z > 0) return (1 - Math.cos(Math.sqrt(z))) / z;
  return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
}

/** Stumpff S(z) = (sqrt z - sin sqrt z)/(sqrt z)^3 (z > 0) or (sinh sqrt(-z) - sqrt(-z))/(sqrt(-z))^3; series near 0. */
function stumpffS(z: number): number {
  if (Math.abs(z) < 0.5) {
    let p = 1, ts = 1 / 6, s = 0;
    for (let n = 0; n < 30; n++) {
      s += p * ts;
      p *= -z;
      ts /= (2 * n + 4) * (2 * n + 5);
    }
    return s;
  }
  if (z > 0) {
    const r = Math.sqrt(z);
    return (r - Math.sin(r)) / (r * r * r);
  }
  const r = Math.sqrt(-z);
  return (Math.sinh(r) - r) / (r * r * r);
}

/** Rotation about +X by angle (active, right-handed). */
function rotX(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}

/** Orbital elements and derived quantities from a Cartesian state (ECI, m and m/s). */
export function elementsFromState(r: Vec3, v: Vec3, mu = MU_EARTH): OrbitalElements {
  const rn = norm(r);
  const v2 = dot(v, v);
  const h = cross(r, v);
  const hn = norm(h);
  if (hn === 0) throw new Error('elementsFromState: rectilinear orbit (zero angular momentum)');
  const W = scale(h, 1 / hn); // orbit normal
  // Eccentricity vector: e = ((v^2 - mu/r) r - (r.v) v) / mu
  const eVec = scale(sub(scale(r, v2 - mu / rn), scale(v, dot(r, v))), 1 / mu);
  const e = norm(eVec);
  const energy = v2 / 2 - mu / rn;
  const a = Math.abs(energy) <= 1e-14 * (mu / rn) ? Infinity : -mu / (2 * energy);
  const p = (hn * hn) / mu;
  const i = Math.acos(Math.min(1, Math.max(-1, W[2])));

  // Node vector (ascending node direction); equatorial orbits use +X as the reference.
  const n = cross([0, 0, 1], h);
  const nn = norm(n);
  const equatorial = nn < EQUATORIAL_TOL * hn;
  const N: Vec3 = equatorial ? [1, 0, 0] : scale(n, 1 / nn);
  const raan = equatorial ? 0 : wrap(Math.atan2(n[1], n[0]));

  const rhat = scale(r, 1 / rn);
  let argp = 0;
  let nu: number;
  if (e < CIRCULAR_TOL) {
    // Circular: argument of latitude (true longitude if equatorial).
    nu = wrap(Math.atan2(dot(cross(N, rhat), W), dot(N, rhat)));
  } else {
    const P = scale(eVec, 1 / e);
    argp = wrap(Math.atan2(dot(cross(N, P), W), dot(N, P)));
    nu = wrap(Math.atan2(dot(cross(P, rhat), W), dot(P, rhat)));
  }

  const elliptic = e < 1;
  return {
    a,
    e,
    i,
    raan,
    argp,
    nu,
    h: hn,
    energy,
    period: elliptic ? TAU * Math.sqrt((a * a * a) / mu) : Infinity,
    rp: p / (1 + e),
    ra: elliptic ? p / (1 - e) : Infinity,
    p,
  };
}

/** Cartesian state (ECI) from classical elements, via the perifocal frame and the 3-1-3 rotation. */
export function stateFromElements(
  el: { a: number; e: number; i: number; raan: number; argp: number; nu: number },
  mu = MU_EARTH,
): { r: Vec3; v: Vec3 } {
  if (!Number.isFinite(el.a)) {
    throw new Error('stateFromElements: parabolic orbits (a = Infinity) are not representable; use a finite a');
  }
  const { a, e, i, raan, argp, nu } = el;
  const p = a * (1 - e * e);
  const cnu = Math.cos(nu);
  const snu = Math.sin(nu);
  const rmag = p / (1 + e * cnu);
  const rPf: Vec3 = [rmag * cnu, rmag * snu, 0];
  const k = Math.sqrt(mu / p);
  const vPf: Vec3 = [-k * snu, k * (e + cnu), 0];
  // perifocal -> ECI: R3(-raan) R1(-i) R3(-argp), applied as active rotations
  const toEci = (q: Vec3): Vec3 => rotZ(rotX(rotZ(q, argp), i), raan);
  return { r: toEci(rPf), v: toEci(vPf) };
}

/**
 * Solves Kepler's equation M = E - e sin E for the eccentric anomaly E (elliptic, 0 <= e < 1).
 * Safeguarded Newton with bisection fallback. The returned E keeps M's winding (E = M + periodic term).
 */
export function solveKepler(M: number, e: number): number {
  const Mw = wrap(M);
  const shift = M - Mw;
  let lo = 0;
  let hi = TAU;
  let E = e < 0.8 ? Mw : Math.PI;
  for (let it = 0; it < 200; it++) {
    const f = E - e * Math.sin(E) - Mw; // increasing in E since e < 1
    if (f === 0) return E + shift;
    if (f > 0) hi = E;
    else lo = E;
    let En = it < 30 ? E - f / (1 - e * Math.cos(E)) : 0.5 * (lo + hi);
    if (!(En > lo && En < hi)) En = 0.5 * (lo + hi);
    if (Math.abs(En - E) < 1e-13) return En + shift;
    E = En;
  }
  return E + shift;
}

/** Solves M = e sinh F - F for the hyperbolic anomaly F (e > 1). */
export function solveKeplerHyperbolic(M: number, e: number): number {
  const g = (F: number): number => e * Math.sinh(F) - F - M; // increasing for e > 1
  let hi = 1;
  let lo = -1;
  for (let k = 0; k < 2000 && g(hi) < 0; k++) hi *= 2;
  for (let k = 0; k < 2000 && g(lo) > 0; k++) lo *= 2;
  let F = Math.min(hi, Math.max(lo, Math.asinh(M / e)));
  for (let it = 0; it < 200; it++) {
    const f = g(F);
    if (f === 0) return F;
    if (f > 0) hi = F;
    else lo = F;
    let Fn = it < 30 ? F - f / (e * Math.cosh(F) - 1) : 0.5 * (lo + hi);
    if (!(Fn > lo && Fn < hi)) Fn = 0.5 * (lo + hi);
    if (Math.abs(Fn - F) < 1e-13 * Math.max(1, Math.abs(F))) return Fn;
    F = Fn;
  }
  return F;
}

/** True anomaly to eccentric anomaly E (e < 1, result in [0, 2pi)) or hyperbolic anomaly F (e > 1). */
export function trueToEccentric(nu: number, e: number): number {
  if (e < 1) return wrap(Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu), e + Math.cos(nu)));
  return Math.asinh((Math.sqrt(e * e - 1) * Math.sin(nu)) / (1 + e * Math.cos(nu)));
}

/** Eccentric anomaly E (e < 1) or hyperbolic anomaly F (e > 1) to true anomaly. Elliptic result in [0, 2pi). */
export function eccentricToTrue(E: number, e: number): number {
  if (e < 1) return wrap(Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e));
  return Math.atan2(Math.sqrt(e * e - 1) * Math.sinh(E), e - Math.cosh(E));
}

/** True anomaly to mean anomaly (elliptic: result in [0, 2pi); hyperbolic: M = e sinh F - F). */
export function trueToMean(nu: number, e: number): number {
  if (e < 1) {
    const E = trueToEccentric(nu, e);
    return wrap(E - e * Math.sin(E));
  }
  const F = trueToEccentric(nu, e);
  return e * Math.sinh(F) - F;
}

/** Mean anomaly to true anomaly (elliptic, result in [0, 2pi)). */
export function meanToTrue(M: number, e: number): number {
  if (e < 1) return eccentricToTrue(solveKepler(wrap(M), e), e);
  return eccentricToTrue(solveKeplerHyperbolic(M, e), e);
}

/**
 * Propagates a state by dt using universal variables: Stumpff functions C(z), S(z) and the
 * Lagrange f, g coefficients. Works for elliptic, parabolic and hyperbolic orbits and for
 * negative dt. Elliptic dt is reduced modulo the period first. The universal anomaly is found
 * by Newton iteration safeguarded by a bracket (bisection fallback).
 */
export function propagateKepler(r: Vec3, v: Vec3, dt: number, mu = MU_EARTH): { r: Vec3; v: Vec3 } {
  const r0 = norm(r);
  const alpha = 2 / r0 - dot(v, v) / mu; // 1/a
  let t = dt;
  if (alpha > 0) {
    const period = TAU * Math.sqrt(1 / (alpha * alpha * alpha * mu));
    t = dt - period * Math.floor(dt / period);
  }
  if (t === 0) return { r: [r[0], r[1], r[2]], v: [v[0], v[1], v[2]] };

  const sqrtMu = Math.sqrt(mu);
  const A = dot(r, v) / sqrtMu; // r0 * vr0 / sqrt(mu)
  const B = 1 - alpha * r0;
  const target = sqrtMu * t;
  // Universal Kepler equation F(x) = sqrt(mu) dt; dF/dx = r(x) > 0 so F is monotone.
  const timeEq = (x: number): number => {
    const z = alpha * x * x;
    return A * x * x * stumpffC(z) + B * x * x * x * stumpffS(z) + r0 * x - target;
  };
  const dTimeEq = (x: number): number => {
    const z = alpha * x * x;
    return A * x * (1 - z * stumpffS(z)) + B * x * x * stumpffC(z) + r0;
  };

  // Bracket the root: F(0) = -target.
  const s0 = Math.sqrt(r0);
  let lo = 0;
  let hi = 0;
  if (t > 0) {
    hi = s0;
    for (let k = 0; k < 200 && timeEq(hi) < 0; k++) hi *= 2;
  } else {
    lo = -s0;
    for (let k = 0; k < 200 && timeEq(lo) > 0; k++) lo *= 2;
  }

  let x = target / r0; // linear first guess
  if (!(x > lo && x < hi)) x = 0.5 * (lo + hi);
  for (let it = 0; it < 200; it++) {
    const f = timeEq(x);
    if (f === 0) break;
    if (f < 0) lo = x;
    else hi = x;
    let xn = x - f / dTimeEq(x);
    if (!(xn > lo && xn < hi)) xn = 0.5 * (lo + hi);
    const done = Math.abs(xn - x) <= 1e-13 * Math.max(1, Math.abs(x));
    x = xn;
    if (done) break;
  }

  const z = alpha * x * x;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const rr = x * x * C + A * x * (1 - z * S) + r0 * (1 - z * C); // radius at the new point
  const f = 1 - (x * x * C) / r0;
  const g = t - (x * x * x * S) / sqrtMu;
  const fdot = ((sqrtMu / (rr * r0)) * x * (z * S - 1));
  const gdot = 1 - (x * x * C) / rr;
  return { r: add(scale(r, f), scale(v, g)), v: add(scale(r, fdot), scale(v, gdot)) };
}

/** Seconds from the current position to the next passage through true anomaly nuTarget (elliptic), in [0, period). */
export function timeToTrueAnomaly(el: OrbitalElements, nuTarget: number, mu = MU_EARTH): number {
  if (!(el.e < 1)) throw new Error('timeToTrueAnomaly: elliptic orbits only');
  const n = Math.sqrt(mu / (el.a * el.a * el.a));
  const period = TAU / n;
  const dM = wrap(trueToMean(nuTarget, el.e) - trueToMean(el.nu, el.e));
  const t = dM / n;
  return t >= period ? t - period : t;
}

/** Seconds until the next apoapsis passage (elliptic). */
export function timeToApoapsis(el: OrbitalElements, mu = MU_EARTH): number {
  return timeToTrueAnomaly(el, Math.PI, mu);
}

/** Seconds until the next periapsis passage (elliptic). */
export function timeToPeriapsis(el: OrbitalElements, mu = MU_EARTH): number {
  return timeToTrueAnomaly(el, 0, mu);
}
