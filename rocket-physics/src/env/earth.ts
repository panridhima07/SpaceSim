// Earth shape, rotation and reference frames.
//
// ECI  : Earth-centred inertial. +Z is the rotation axis, +X the vernal equinox. All
//        dynamics are integrated here, so Coriolis and centrifugal effects need no
//        special terms: they appear because the ground and the air move.
// ECEF : Earth-centred, Earth-fixed. ECI rotated about +Z by the sidereal angle.
// ENU  : local east / north / up at a point on the WGS-84 ellipsoid.
//
// Precession, nutation and polar motion are not modelled (they move the pole by
// arc-seconds, far below every other error in a launch simulation).

import { DEG, E2, OMEGA_EARTH, RE } from '../constants.ts';
import { rotZ, type Vec3 } from '../math/vec.ts';

/** Julian Date of a JavaScript Date (UTC). */
export function julianDate(d: Date): number {
  return d.getTime() / 86400000 + 2440587.5;
}

/** Greenwich mean sidereal time, rad, for a Julian Date (IAU 1982). */
export function gmst(jd: number): number {
  const d = jd - 2451545.0;
  const T = d / 36525;
  const deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38710000;
  const r = (deg * DEG) % (2 * Math.PI);
  return r < 0 ? r + 2 * Math.PI : r;
}

export const eciToEcef = (r: Vec3, theta: number): Vec3 => rotZ(r, -theta);
export const ecefToEci = (r: Vec3, theta: number): Vec3 => rotZ(r, theta);

/** Geodetic latitude / longitude (rad) and height (m) to ECEF. */
export function geodeticToEcef(lat: number, lon: number, h: number): Vec3 {
  const s = Math.sin(lat);
  const c = Math.cos(lat);
  const N = RE / Math.sqrt(1 - E2 * s * s);
  return [(N + h) * c * Math.cos(lon), (N + h) * c * Math.sin(lon), (N * (1 - E2) + h) * s];
}

export interface Geodetic {
  lat: number; // geodetic latitude, rad
  lon: number; // longitude of the input vector, rad (inertial if the input was ECI)
  alt: number; // height above the WGS-84 ellipsoid, m
}

/**
 * Cartesian to geodetic. Because the ellipsoid is symmetric about Z, latitude and
 * height are the same whether the input is ECI or ECEF; only `lon` differs.
 */
export function toGeodetic(r: Vec3): Geodetic {
  solveGeodetic(r[0], r[1], r[2]);
  return { lat: Math.atan2(r[2], gDen), lon: Math.atan2(r[1], r[0]), alt: gAlt };
}

/** Height above the WGS-84 ellipsoid, m. The cheap call when latitude and longitude are not needed. */
export function geodeticAltitude(x: number, y: number, z: number): number {
  solveGeodetic(x, y, z);
  return gAlt;
}

// Result slots of solveGeodetic. Module-level so the hot path allocates nothing.
// tan(lat) = z / gDen, and gHyp = hypot(z, gDen).
let gDen = 1;
let gHyp = 1;
let gAlt = 0;

/**
 * Latitude and height by fixed-point iteration on the pair (sin lat, cos lat), so the loop
 * needs square roots only, no trigonometry. Stops as soon as the latitude has settled to
 * about 1e-15 rad; that takes two or three passes for anything from the ground to the Moon.
 */
function solveGeodetic(x: number, y: number, z: number): void {
  const p = Math.sqrt(x * x + y * y);
  let den = p * (1 - E2);
  let h = Math.sqrt(z * z + den * den);
  let alt = 0;
  for (let i = 0; i < 6; i++) {
    const s = h > 0 ? z / h : 0;
    const c = h > 0 ? den / h : 1;
    const w = 1 - E2 * s * s;
    const N = RE / Math.sqrt(w);
    alt = p * c + z * s - N * w; // stable at the poles
    const next = p * (1 - (E2 * N) / (N + alt));
    const moved = Math.abs(next - den);
    den = next;
    h = Math.sqrt(z * z + den * den);
    if (moved <= 1e-15 * h) break;
  }
  gDen = den;
  gHyp = h;
  gAlt = alt;
}

export interface LocalFrame extends Geodetic {
  east: Vec3;
  north: Vec3;
  up: Vec3; // geodetic vertical (normal to the ellipsoid)
}

/** East / north / up unit vectors at r, in the same frame r is given in. */
export function localFrame(r: Vec3): LocalFrame {
  const x = r[0];
  const y = r[1];
  const z = r[2];
  solveGeodetic(x, y, z);
  const sl = gHyp > 0 ? z / gHyp : 0;
  const cl = gHyp > 0 ? gDen / gHyp : 1;
  const p = Math.sqrt(x * x + y * y);
  const so = p > 0 ? y / p : 0;
  const co = p > 0 ? x / p : 1;
  return {
    lat: Math.atan2(z, gDen),
    lon: Math.atan2(y, x),
    alt: gAlt,
    east: [-so, co, 0],
    north: [-sl * co, -sl * so, cl],
    up: [cl * co, cl * so, sl],
  };
}

/** Velocity of the co-rotating ground / atmosphere at ECI position r. */
export function groundVelocity(r: Vec3): Vec3 {
  return [-OMEGA_EARTH * r[1], OMEGA_EARTH * r[0], 0];
}

/** Great-circle distance over a sphere of radius RE between two lat/lon points (rad). */
export function greatCircleDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * RE * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface LaunchSite {
  name?: string;
  latDeg: number;
  lonDeg: number;
  /** Height of the pad above the ellipsoid, m. */
  altitude?: number;
}

export const SITES = {
  sriharikota: { name: 'Satish Dhawan Space Centre (SDSC SHAR)', latDeg: 13.72, lonDeg: 80.23, altitude: 10 },
  capeCanaveral: { name: 'Cape Canaveral', latDeg: 28.5618, lonDeg: -80.577, altitude: 5 },
  kourou: { name: 'Guiana Space Centre', latDeg: 5.236, lonDeg: -52.775, altitude: 10 },
  baikonur: { name: 'Baikonur', latDeg: 45.965, lonDeg: 63.305, altitude: 90 },
} satisfies Record<string, LaunchSite>;
