// Orbital maneuvers and mission-design rules of thumb: circular and escape speeds, Hohmann and
// bi-elliptic transfers, plane changes, the rocket equation, J2 secular drift and launch azimuth.
// Pure functions. SI units (m, s, kg, rad). mu defaults to Earth's gravitational parameter.

import { G0, J2, MU_EARTH, OMEGA_EARTH, RE } from '../constants.ts';

/** Speed of a circular orbit at radius r: sqrt(mu/r). */
export function circularVelocity(r: number, mu = MU_EARTH): number {
  return Math.sqrt(mu / r);
}

/** Parabolic (escape) speed at radius r: sqrt(2 mu / r). */
export function escapeVelocity(r: number, mu = MU_EARTH): number {
  return Math.sqrt((2 * mu) / r);
}

/** Vis-viva equation: speed at radius r on an orbit of semi-major axis a, sqrt(mu (2/r - 1/a)). */
export function visViva(r: number, a: number, mu = MU_EARTH): number {
  return Math.sqrt(mu * (2 / r - 1 / a));
}

/** Orbital period of an ellipse with semi-major axis a: 2 pi sqrt(a^3/mu). */
export function orbitalPeriod(a: number, mu = MU_EARTH): number {
  return 2 * Math.PI * Math.sqrt((a * a * a) / mu);
}

/**
 * Hohmann transfer between coplanar circular orbits r1 and r2 (two tangential burns).
 * dv values are magnitudes; tof is half the period of the transfer ellipse.
 */
export function hohmann(r1: number, r2: number, mu = MU_EARTH): { dv1: number; dv2: number; total: number; tof: number } {
  const a = (r1 + r2) / 2;
  const dv1 = Math.abs(visViva(r1, a, mu) - circularVelocity(r1, mu));
  const dv2 = Math.abs(circularVelocity(r2, mu) - visViva(r2, a, mu));
  const tof = Math.PI * Math.sqrt((a * a * a) / mu);
  return { dv1, dv2, total: dv1 + dv2, tof };
}

/**
 * Bi-elliptic transfer r1 -> rb -> r2 (three burns, with the apocentre rb beyond both radii).
 * Can beat a Hohmann transfer when r2/r1 is large (about 15.58 or more) and rb is large.
 */
export function biElliptic(
  r1: number,
  r2: number,
  rb: number,
  mu = MU_EARTH,
): { dv1: number; dv2: number; dv3: number; total: number; tof: number } {
  const a1 = (r1 + rb) / 2;
  const a2 = (r2 + rb) / 2;
  const dv1 = Math.abs(visViva(r1, a1, mu) - circularVelocity(r1, mu));
  const dv2 = Math.abs(visViva(rb, a2, mu) - visViva(rb, a1, mu));
  const dv3 = Math.abs(circularVelocity(r2, mu) - visViva(r2, a2, mu));
  const tof = Math.PI * (Math.sqrt((a1 * a1 * a1) / mu) + Math.sqrt((a2 * a2 * a2) / mu));
  return { dv1, dv2, dv3, total: dv1 + dv2 + dv3, tof };
}

/** Delta-v for a pure plane change of angle deltaInclination at speed v: 2 v sin(di/2). */
export function planeChange(v: number, deltaInclination: number): number {
  return 2 * v * Math.sin(deltaInclination / 2);
}

/** Delta-v for a plane change combined with a speed change (v1 -> v2), by the law of cosines. */
export function combinedPlaneChange(v1: number, v2: number, deltaInclination: number): number {
  return Math.sqrt(Math.max(0, v1 * v1 + v2 * v2 - 2 * v1 * v2 * Math.cos(deltaInclination)));
}

/** Ideal rocket equation: delta-v = g0 Isp ln(m0/m1). */
export function tsiolkovsky(isp: number, m0: number, m1: number): number {
  return G0 * isp * Math.log(m0 / m1);
}

/**
 * Finite-burn duration for a delta-v, starting from mass `mass` with constant thrust:
 * mass flow = thrust / (g0 Isp), and the mass consumed is mass (1 - exp(-dv/(g0 Isp))).
 */
export function burnTime(deltaV: number, mass: number, thrust: number, isp: number): number {
  const ve = G0 * isp;
  return (mass * ve * (1 - Math.exp(-deltaV / ve))) / thrust;
}

/** Radius of the sphere of influence of a small body about a large one: a (mu_small/mu_big)^(2/5). */
export function sphereOfInfluence(a: number, mSmallMu: number, mBigMu: number): number {
  return a * Math.pow(mSmallMu / mBigMu, 0.4);
}

/** J2 secular nodal precession rate, rad/s: d(raan)/dt = -1.5 n J2 (RE/p)^2 cos i. */
export function nodalPrecessionRate(a: number, e: number, i: number, mu = MU_EARTH): number {
  const n = Math.sqrt(mu / (a * a * a));
  const p = a * (1 - e * e);
  return -1.5 * n * J2 * (RE / p) ** 2 * Math.cos(i);
}

/** J2 secular apsidal precession rate, rad/s: d(argp)/dt = 0.75 n J2 (RE/p)^2 (5 cos^2 i - 1). */
export function apsidalPrecessionRate(a: number, e: number, i: number, mu = MU_EARTH): number {
  const n = Math.sqrt(mu / (a * a * a));
  const p = a * (1 - e * e);
  const c = Math.cos(i);
  return 0.75 * n * J2 * (RE / p) ** 2 * (5 * c * c - 1);
}

/**
 * Sun-synchronous inclination (rad) at a given altitude above the equator: the J2 nodal drift
 * equals one revolution per tropical year (+2 pi / 365.2422 days). Circular by default.
 */
export function sunSynchronousInclination(altitude: number, e = 0): number {
  const MU = MU_EARTH;
  const a = RE + altitude;
  const n = Math.sqrt(MU / (a * a * a));
  const p = a * (1 - e * e);
  const required = (2 * Math.PI) / (365.2422 * 86400); // rad/s, eastward
  const c = -required / (1.5 * n * J2 * (RE / p) ** 2);
  if (Math.abs(c) > 1) throw new Error('sunSynchronousInclination: no solution at this altitude');
  return Math.acos(c);
}

/**
 * Launch azimuth (rad, clockwise from north) for a site at latitude `latitude` to reach
 * inclination `inclination` at burnout speed `orbitalSpeed` (inertial, relative to the Earth's centre).
 * inertial: the azimuth in inertial space, sin(beta) = cos(i)/cos(lat), NE (ascending) solution.
 * rotating: the azimuth to fly relative to the pad, which moves east at OMEGA_EARTH RE cos(lat).
 */
export function launchAzimuth(
  latitude: number,
  inclination: number,
  orbitalSpeed: number,
): { inertial: number; rotating: number } {
  const ratio = Math.cos(inclination) / Math.cos(latitude);
  if (!(Math.abs(ratio) <= 1)) {
    throw new Error('launchAzimuth: inclination is below the site latitude; no launch azimuth exists');
  }
  const sinB = ratio;
  const cosB = Math.sqrt(1 - sinB * sinB);
  const vGround = OMEGA_EARTH * RE * Math.cos(latitude);
  return {
    inertial: Math.asin(sinB),
    rotating: Math.atan2(orbitalSpeed * sinB - vGround, orbitalSpeed * cosB),
  };
}

/** Hyperbolic excess speed after burnout: sqrt(v^2 - 2 mu / r), 0 if the orbit is bound. */
export function hyperbolicExcess(vBurnout: number, r: number, mu = MU_EARTH): number {
  return Math.sqrt(Math.max(0, vBurnout * vBurnout - (2 * mu) / r));
}

/** Characteristic energy C3 = v^2 - 2 mu / r, m^2/s^2 (equals v_inf^2 for a hyperbolic trajectory). */
export function c3(v: number, r: number, mu = MU_EARTH): number {
  return v * v - (2 * mu) / r;
}
