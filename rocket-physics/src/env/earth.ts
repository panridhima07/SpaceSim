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
  const p = Math.hypot(r[0], r[1]);
  const lon = Math.atan2(r[1], r[0]);
  let lat = Math.atan2(r[2], p * (1 - E2));
  let alt = 0;
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat);
    const c = Math.cos(lat);
    const N = RE / Math.sqrt(1 - E2 * s * s);
    alt = p * c + r[2] * s - N * (1 - E2 * s * s); // stable at the poles
    lat = Math.atan2(r[2], p * (1 - (E2 * N) / (N + alt)));
  }
  return { lat, lon, alt };
}

export interface LocalFrame extends Geodetic {
  east: Vec3;
  north: Vec3;
  up: Vec3; // geodetic vertical (normal to the ellipsoid)
}

/** East / north / up unit vectors at r, in the same frame r is given in. */
export function localFrame(r: Vec3): LocalFrame {
  const g = toGeodetic(r);
  const sl = Math.sin(g.lat), cl = Math.cos(g.lat);
  const so = Math.sin(g.lon), co = Math.cos(g.lon);
  return {
    ...g,
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
