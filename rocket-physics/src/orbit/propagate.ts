// Numerical orbit propagator. ECI point-mass dynamics with zonal and third-body gravity,
// atmospheric drag (co-rotating atmosphere) and solar radiation pressure, integrated with
// adaptive Dormand-Prince 5(4) on the state [rx, ry, rz, vx, vy, vz].

import type { GravityOptions } from '../env/gravity.ts';
import { AU, DEG, OMEGA_EARTH, RE, SOLAR_PRESSURE } from '../constants.ts';
import { atmosphereInto, type AtmosphereState } from '../env/atmosphere.ts';
import { moonPosition, sunPosition } from '../env/ephemeris.ts';
import { geodeticAltitude, gmst, toGeodetic } from '../env/earth.ts';
import { gravityInto } from '../env/gravity.ts';
import { integrateAdaptive } from '../math/integrators.ts';
import { dot, norm, sub, unit, type Vec3 } from '../math/vec.ts';

const DRAG_RADIUS2 = (RE + 1.0e6) ** 2;
const AIR: AtmosphereState = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, viscosity: 0, meanFreePath: 0 };

export interface ForceModel {
  /** Julian Date that corresponds to t = 0. Needed for Sun / Moon positions. */
  epochJD: number;
  gravity?: GravityOptions; // defaults inside gravity.ts: j2, j3j4, sun, moon all on
  /** Atmospheric drag: Cd * A / m in m^2/kg. Omit for none. */
  drag?: { cdAOverM: number };
  /** Solar radiation pressure: Cr * A / m in m^2/kg. Omit for none. */
  srp?: { crAOverM: number };
}

/** True when r is inside the Earth's cylindrical shadow (sun = geocentric Sun position). */
export function inShadow(r: Vec3, sun: Vec3): boolean {
  const s = unit(sun);
  const along = dot(r, s);
  if (along >= 0) return false;
  const perp: Vec3 = [r[0] - along * s[0], r[1] - along * s[1], r[2] - along * s[2]];
  return norm(perp) < RE;
}

/** Acceleration of a point mass at time t (s since epoch), ECI position r, velocity v. */
export function accelAt(t: number, r: Vec3, v: Vec3, fm: ForceModel): Vec3 {
  const jd = fm.epochJD + t / 86400;
  const needSun = fm.gravity?.sun !== false || fm.srp !== undefined;
  const needMoon = fm.gravity?.moon !== false;
  const sun = needSun ? sunPosition(jd) : undefined;
  const moon = needMoon ? moonPosition(jd) : undefined;

  const a: Vec3 = [0, 0, 0];
  gravityInto(a, r[0], r[1], r[2], fm.gravity, sun, moon);

  // The ellipsoid lies inside the sphere of radius RE, so height above it is at least
  // |r| - RE. Past 1000 km on that measure there is no air and the geodetic solve is skipped.
  if (fm.drag && r[0] * r[0] + r[1] * r[1] + r[2] * r[2] <= DRAG_RADIUS2) {
    const alt = geodeticAltitude(r[0], r[1], r[2]);
    if (alt <= 1.0e6) {
      const rho = atmosphereInto(AIR, alt).density;
      const ux = v[0] + OMEGA_EARTH * r[1];
      const uy = v[1] - OMEGA_EARTH * r[0];
      const uz = v[2];
      const k = -0.5 * rho * Math.sqrt(ux * ux + uy * uy + uz * uz) * fm.drag.cdAOverM;
      a[0] += ux * k;
      a[1] += uy * k;
      a[2] += uz * k;
    }
  }

  if (fm.srp && sun && !inShadow(r, sun)) {
    const d = sub(r, sun); // Sun -> spacecraft: pushes away from the Sun
    const dn = norm(d);
    const k = (SOLAR_PRESSURE * fm.srp.crAOverM * (AU / dn) ** 2) / dn;
    a[0] += d[0] * k;
    a[1] += d[1] * k;
    a[2] += d[2] * k;
  }

  return a;
}

export interface PropagateOptions {
  rtol?: number;
  atol?: number;
  hMax?: number;
  hInit?: number;
  onStep?: (t: number, r: Vec3, v: Vec3) => boolean | void;
}

/** Integrate from t0 to t1 (either direction) with adaptive Dormand-Prince. onStep returning true stops early. */
export function propagate(
  r: Vec3,
  v: Vec3,
  t0: number,
  t1: number,
  fm: ForceModel,
  opts: PropagateOptions = {},
): { r: Vec3; v: Vec3; t: number; steps: number } {
  const f = (t: number, y: number[]): number[] => {
    const rr: Vec3 = [y[0], y[1], y[2]];
    const vv: Vec3 = [y[3], y[4], y[5]];
    const a = accelAt(t, rr, vv, fm);
    return [vv[0], vv[1], vv[2], a[0], a[1], a[2]];
  };
  const onStep = opts.onStep;
  const res = integrateAdaptive(
    f,
    t0,
    [r[0], r[1], r[2], v[0], v[1], v[2]],
    t1,
    { rtol: opts.rtol ?? 1e-10, atol: opts.atol ?? 1e-6, hMax: opts.hMax, hInit: opts.hInit },
    onStep ? (t, y) => onStep(t, [y[0], y[1], y[2]], [y[3], y[4], y[5]]) : undefined,
  );
  const y = res.y;
  return {
    r: [y[0], y[1], y[2]],
    v: [y[3], y[4], y[5]],
    t: res.t,
    steps: res.steps,
  };
}

function impactRecord(
  r: Vec3,
  v: Vec3,
  t: number,
  epochJD: number,
): { r: Vec3; v: Vec3; t: number; latDeg: number; lonDeg: number } {
  const latDeg = toGeodetic(r).lat / DEG;
  // Geographic (Earth-fixed) longitude: inertial longitude minus the sidereal angle.
  let lonDeg = ((Math.atan2(r[1], r[0]) - gmst(epochJD) - OMEGA_EARTH * t) / DEG) % 360;
  if (lonDeg <= -180) lonDeg += 360;
  if (lonDeg > 180) lonDeg -= 360;
  return { r, v, t, latDeg, lonDeg };
}

/** Fly a passive object down to the ground (geodetic altitude 0). Returns the impact state, or null if it is still up at tMax. */
export function propagateToImpact(
  r: Vec3,
  v: Vec3,
  t0: number,
  fm: ForceModel,
  tMax: number = t0 + 86400,
): { r: Vec3; v: Vec3; t: number; latDeg: number; lonDeg: number } | null {
  const altOf = (x: Vec3): number => geodeticAltitude(x[0], x[1], x[2]);
  if (altOf(r) <= 0) return impactRecord(r, v, t0, fm.epochJD);

  // Track the last above-ground state and the time of the first below-ground step.
  const hit: { t: number | null } = { t: null };
  let base: { t: number; r: Vec3; v: Vec3 } = { t: t0, r, v };
  propagate(r, v, t0, tMax, fm, {
    hMax: 5,
    onStep: (t, rr, vv) => {
      if (altOf(rr) <= 0) {
        hit.t = t;
        return true;
      }
      base = { t, r: rr, v: vv };
      return false;
    },
  });
  if (hit.t === null) return null;

  // Bisect the crossing in time, always re-propagating from the last above-ground state.
  let lo = base.t;
  let hi = hit.t;
  while (hi - lo > 0.01) {
    const mid = 0.5 * (lo + hi);
    const s = propagate(base.r, base.v, base.t, mid, fm, { hMax: 5 });
    if (altOf(s.r) > 0) lo = mid;
    else hi = mid;
  }
  const s = propagate(base.r, base.v, base.t, hi, fm, { hMax: 5 });
  return impactRecord(s.r, s.v, hi, fm.epochJD);
}
