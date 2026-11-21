import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../types';
import { eclipticToWorld } from './ephemeris';
import {
  PAD_LAT_DEG,
  PAD_LON_DEG,
  buildConstellationSegments,
  buildStarBuffers,
  bvToRgb,
  eclipticNorthWorld,
  magnitudeBrightness,
  raDecToWorld,
  siteAlignment,
} from './skyData';

const DEG = Math.PI / 180;
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const apply = (m: [Vec3, Vec3, Vec3], v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

describe('raDecToWorld', () => {
  it('returns unit vectors', () => {
    expect(len(raDecToWorld(101.287, -16.716))).toBeCloseTo(1, 12);
  });

  it('maps the ecliptic north pole (RA 18h, Dec 66.56) to the ecliptic normal', () => {
    const p = raDecToWorld(270, 90 - 23.4392911);
    const n = eclipticNorthWorld();
    for (let i = 0; i < 3; i++) expect(p[i]).toBeCloseTo(n[i], 9);
  });

  it('maps the vernal equinox (RA 0, Dec 0) to the ecliptic X axis', () => {
    const p = raDecToWorld(0, 0);
    const x = eclipticToWorld([1, 0, 0]);
    for (let i = 0; i < 3; i++) expect(p[i]).toBeCloseTo(x[i], 12);
  });

  it('accepts right ascension wrapped to negative degrees', () => {
    const a = raDecToWorld(-90, 20), b = raDecToWorld(270, 20);
    for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 12);
  });
});

describe('star appearance', () => {
  it('makes hot stars bluer and cool stars redder', () => {
    const hot = bvToRgb(-0.2), cool = bvToRgb(1.6);
    expect(hot[2]).toBeGreaterThan(hot[0] - 1e-9);
    expect(cool[0]).toBeGreaterThan(cool[2]);
  });

  it('brightness falls with magnitude and stays in range', () => {
    expect(magnitudeBrightness(0)).toBe(1);
    expect(magnitudeBrightness(3)).toBeGreaterThan(magnitudeBrightness(5));
    expect(magnitudeBrightness(9)).toBe(0.25);
  });
});

describe('buildStarBuffers', () => {
  const catalogue = {
    features: [
      { properties: { mag: -1.44, bv: '0.009' }, geometry: { coordinates: [101.287, -16.716] } },
      { properties: { mag: 5.7, bv: '0.911' }, geometry: { coordinates: [0.2691, -48.8099] } },
      { properties: { mag: 4.0 }, geometry: { coordinates: [-30, 10] } },
      { properties: { bv: '1' }, geometry: { coordinates: [1, 2] } }, // no magnitude: skipped
    ],
  };

  it('splits bright from faint stars and skips malformed entries', () => {
    const { faint, bright } = buildStarBuffers(catalogue, 1000);
    expect(bright.count).toBe(1);
    expect(faint.count).toBe(2);
    expect(bright.positions.length).toBe(3);
    expect(faint.colors.length).toBe(6);
  });

  it('places stars on the sphere of the given radius', () => {
    const { bright } = buildStarBuffers(catalogue, 1000);
    expect(Math.hypot(bright.positions[0], bright.positions[1], bright.positions[2])).toBeCloseTo(1000, 2);
  });

  it('handles a missing catalogue', () => {
    expect(buildStarBuffers(null, 1).faint.count).toBe(0);
  });
});

describe('buildConstellationSegments', () => {
  it('emits two vertices per segment', () => {
    const lines = { features: [{ geometry: { coordinates: [[[0, 0], [10, 0], [10, 10]], [[50, 5], [60, 5]]] } }] };
    const seg = buildConstellationSegments(lines, 5);
    expect(seg.length).toBe(3 * 2 * 3); // three segments
    expect(Math.hypot(seg[0], seg[1], seg[2])).toBeCloseTo(5, 5);
  });
});

describe('siteAlignment', () => {
  const lat = PAD_LAT_DEG * DEG, lon = PAD_LON_DEG * DEG;
  // Sphere-local direction of a latitude/longitude: lon 0 at +X, north at +Y, 90 E at -Z.
  const local = (la: number, lo: number): Vec3 => [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
  const m = siteAlignment(PAD_LAT_DEG, PAD_LON_DEG);

  it('puts the pad at world +Y', () => {
    const p = apply(m, local(lat, lon));
    expect(p[0]).toBeCloseTo(0, 12);
    expect(p[1]).toBeCloseTo(1, 12);
    expect(p[2]).toBeCloseTo(0, 12);
  });

  it('puts ground east of the pad toward +X and ground north of it toward -Z', () => {
    expect(apply(m, local(lat, lon + 0.01))[0]).toBeGreaterThan(0);
    expect(apply(m, local(lat + 0.01, lon))[2]).toBeLessThan(0);
  });

  it('is a proper rotation', () => {
    const [a, b, c] = m;
    const det =
      a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    expect(det).toBeCloseTo(1, 12);
  });
});
