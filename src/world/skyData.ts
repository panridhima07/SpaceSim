// Real-sky data helpers: star catalogue, constellation lines and the Earth texture orientation.
// Pure math, no three.js and no DOM, so everything here is unit tested in node.
//
// Catalogue files (public/assets/space) are d3-celestial GeoJSON: coordinates are
// [RA in degrees wrapped to -180..180, Dec in degrees], J2000 equatorial.
//
// Frame chain: J2000 equatorial -> J2000 ecliptic (obliquity) -> sim world (ECLIPTIC_TO_WORLD).
// The stars therefore share the frame of the planets from ephemeris.ts. The world frame itself is
// still the v1 simplification described there, so this is the real sky, not yet the sky as seen
// from the pad at the launch date.

import type { Vec3 } from '../types';
import { eclipticToWorld } from './ephemeris';

const DEG = Math.PI / 180;
const OBLIQUITY = 23.4392911 * DEG;
const C_OBL = Math.cos(OBLIQUITY);
const S_OBL = Math.sin(OBLIQUITY);

/** Satish Dhawan Space Centre, Sriharikota. The pad sits at world +Y. */
export const PAD_LAT_DEG = 13.72;
export const PAD_LON_DEG = 80.23;

/** J2000 equatorial vector to the sim world frame. */
export function equatorialToWorld(v: Vec3): Vec3 {
  return eclipticToWorld([v[0], C_OBL * v[1] + S_OBL * v[2], -S_OBL * v[1] + C_OBL * v[2]]);
}

/** Unit vector in the sim world frame for a J2000 right ascension and declination in degrees. */
export function raDecToWorld(raDeg: number, decDeg: number): Vec3 {
  const a = raDeg * DEG, d = decDeg * DEG;
  return equatorialToWorld([Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]);
}

/** Unit vector of the ecliptic north pole in the sim world frame. */
export function eclipticNorthWorld(): Vec3 {
  return eclipticToWorld([0, 0, 1]);
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Star colour from the B-V colour index (black-body approximation). Components are 0..1. */
export function bvToRgb(bvIn: number): Vec3 {
  const bv = clamp(bvIn, -0.4, 2.0);
  const T = (4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))) / 100;
  const r = T <= 66 ? 255 : 329.7 * Math.pow(T - 60, -0.1332);
  const g = T <= 66 ? 99.47 * Math.log(T) - 161.1 : 288.1 * Math.pow(T - 60, -0.0755);
  const b = T >= 66 ? 255 : T <= 19 ? 0 : 138.5 * Math.log(T - 10) - 305.0;
  return [clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255];
}

/** Display brightness 0.25..1 for an apparent magnitude (mag 1 and brighter saturate). */
export function magnitudeBrightness(mag: number): number {
  return clamp(Math.pow(10, -0.16 * (mag - 1)), 0.25, 1);
}

interface PointFeature {
  properties?: { mag?: number; bv?: string | number };
  geometry?: { coordinates?: number[] };
}
interface LineFeature {
  geometry?: { coordinates?: number[][][] };
}

export interface StarBuffers {
  /** xyz per star, scaled to `radius`. */
  positions: Float32Array;
  /** rgb per star, already multiplied by brightness. */
  colors: Float32Array;
  count: number;
}

/**
 * Splits a star catalogue into a faint set and a bright set (mag < brightMag), so the two can be
 * drawn with different point sizes. Malformed entries are skipped.
 */
export function buildStarBuffers(
  geojson: { features?: PointFeature[] } | null | undefined,
  radius: number,
  brightMag = 2.6,
): { faint: StarBuffers; bright: StarBuffers } {
  const faintPos: number[] = [], faintCol: number[] = [];
  const brightPos: number[] = [], brightCol: number[] = [];
  for (const f of geojson?.features ?? []) {
    const c = f.geometry?.coordinates;
    const mag = f.properties?.mag;
    if (!c || c.length < 2 || typeof mag !== 'number' || !Number.isFinite(mag)) continue;
    const d = raDecToWorld(c[0], c[1]);
    const bv = Number.parseFloat(String(f.properties?.bv ?? ''));
    const rgb = bvToRgb(Number.isFinite(bv) ? bv : 0.4);
    const isBright = mag < brightMag;
    const b = isBright ? 1 : magnitudeBrightness(mag);
    const pos = isBright ? brightPos : faintPos;
    const col = isBright ? brightCol : faintCol;
    pos.push(d[0] * radius, d[1] * radius, d[2] * radius);
    col.push(rgb[0] * b, rgb[1] * b, rgb[2] * b);
  }
  const pack = (p: number[], c: number[]): StarBuffers => ({
    positions: new Float32Array(p),
    colors: new Float32Array(c),
    count: p.length / 3,
  });
  return { faint: pack(faintPos, faintCol), bright: pack(brightPos, brightCol) };
}

/** Constellation stick figures as line-segment vertex pairs (xyz, xyz, ...), scaled to `radius`. */
export function buildConstellationSegments(
  geojson: { features?: LineFeature[] } | null | undefined,
  radius: number,
): Float32Array {
  const out: number[] = [];
  for (const f of geojson?.features ?? []) {
    for (const line of f.geometry?.coordinates ?? []) {
      for (let i = 0; i + 1 < line.length; i++) {
        for (const p of [line[i], line[i + 1]]) {
          const d = raDecToWorld(p[0], p[1]);
          out.push(d[0] * radius, d[1] * radius, d[2] * radius);
        }
      }
    }
  }
  return new Float32Array(out);
}

/**
 * Rotation that turns an equirectangular-textured sphere so the given site sits at world +Y with
 * east along +X and north along -Z (the launch-site frame).
 *
 * Sphere-local frame (three.js SphereGeometry with a standard equirectangular map):
 * +Y is the north pole, longitude 0 is +X, longitude 90 E is -Z.
 * Returned row-major: world = M * local.
 */
export function siteAlignment(latDeg: number, lonDeg: number): [Vec3, Vec3, Vec3] {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const cl = Math.cos(lat), sl = Math.sin(lat), co = Math.cos(lon), so = Math.sin(lon);
  const up: Vec3 = [cl * co, sl, -cl * so];
  const east: Vec3 = [-so, 0, -co];
  const north: Vec3 = [-sl * co, cl, sl * so];
  return [east, up, [-north[0], -north[1], -north[2]]];
}
