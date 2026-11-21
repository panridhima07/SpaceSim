import { describe, expect, it } from 'vitest';
import {
  AU,
  bodyPositionEarthCentred,
  heliocentricPosition,
  julianDate,
  moonGeocentricPosition,
} from './ephemeris';

const norm = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
const dist = (a: number[], b: number[]) => norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
const angle = (a: number[], b: number[]) => {
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

const J2000 = julianDate(new Date('2000-01-01T12:00:00Z'));

describe('julianDate', () => {
  it('J2000 epoch is 2451545.0', () => {
    expect(julianDate(new Date('2000-01-01T12:00:00Z'))).toBeCloseTo(2451545.0, 6);
  });
});

describe('heliocentric positions', () => {
  it('Earth is about 1 AU from the Sun at J2000', () => {
    const d = norm(heliocentricPosition('Earth', J2000)) / AU;
    expect(d).toBeGreaterThan(0.983);
    expect(d).toBeLessThan(1.017);
  });

  it('Mars, Jupiter and Neptune distances at J2000', () => {
    const mars = norm(heliocentricPosition('Mars', J2000)) / AU;
    const jup = norm(heliocentricPosition('Jupiter', J2000)) / AU;
    const nep = norm(heliocentricPosition('Neptune', J2000)) / AU;
    expect(mars).toBeGreaterThan(1.38);
    expect(mars).toBeLessThan(1.67);
    expect(jup).toBeGreaterThan(4.95);
    expect(jup).toBeLessThan(5.46);
    expect(nep).toBeGreaterThan(29.8);
    expect(nep).toBeLessThan(30.4);
  });

  it('Sun is at the origin', () => {
    expect(heliocentricPosition('Sun', J2000)).toEqual([0, 0, 0]);
  });

  it('Earth returns to nearly the same position after one year', () => {
    const p0 = heliocentricPosition('Earth', J2000);
    const p1 = heliocentricPosition('Earth', J2000 + 365.256);
    expect(dist(p0, p1) / AU).toBeLessThan(0.01);
  });
});

describe('moon', () => {
  it('geocentric distance stays in 356000-407000 km over 30 days', () => {
    for (let d = 0; d < 30; d++) {
      const km = norm(moonGeocentricPosition(J2000 + d)) / 1000;
      expect(km).toBeGreaterThan(356000);
      expect(km).toBeLessThan(407000);
    }
  });

  it('returns near the same direction after one sidereal month', () => {
    const a = moonGeocentricPosition(J2000);
    const b = moonGeocentricPosition(J2000 + 27.32);
    expect(angle(a, b)).toBeLessThan(15);
  });
});

describe('bodyPositionEarthCentred', () => {
  it('Earth is at the centre', () => {
    expect(bodyPositionEarthCentred('Earth', J2000)).toEqual([0, 0, 0]);
  });

  it('Sun distance from Earth is about 1 AU', () => {
    const d = norm(bodyPositionEarthCentred('Sun', J2000)) / AU;
    expect(d).toBeGreaterThan(0.983);
    expect(d).toBeLessThan(1.017);
  });
});
