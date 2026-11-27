import { describe, it, expect } from 'vitest';
import { atmosphere } from './atmosphere';

const within = (actual: number, expected: number, frac: number) =>
  expect(Math.abs(actual - expected) / expected).toBeLessThan(frac);

describe('atmosphere (ISA)', () => {
  it('matches sea-level standard values', () => {
    const a = atmosphere(0);
    expect(a.rho).toBeCloseTo(1.225, 3);
    expect(a.pressure).toBeCloseTo(101325, 0);
    expect(a.temperature).toBeCloseTo(288.15, 6);
    expect(a.soundSpeed).toBeCloseTo(340.29, 1);
  });

  it('matches the 11 km geometric standard values (geopotential 10 981 m, still troposphere)', () => {
    const a = atmosphere(11_000);
    expect(Math.abs(a.temperature - 216.77)).toBeLessThan(0.05);
    expect(Math.abs(a.rho - 0.3648)).toBeLessThan(0.001);
  });

  it('is continuous at every layer boundary', () => {
    // Geometric altitudes of the geopotential boundaries, plus 86 km.
    const r0 = 6356766;
    const geo = (h: number) => (r0 * h) / (r0 - h);
    for (const z of [geo(11_000), geo(20_000), geo(32_000), geo(47_000), geo(51_000), geo(71_000), 86_000]) {
      const below = atmosphere(z - 1e-6);
      const above = atmosphere(z + 1e-6);
      expect(Math.abs(below.rho - above.rho) / below.rho).toBeLessThan(1e-4);
      // At 86 km pressure follows the upper-atmosphere temperature (186.87 K vs 186.95 K from
      // the layer equations), a 0.04 % step; density itself is continuous.
      const tol = z === 86_000 ? 1e-3 : 1e-4;
      expect(Math.abs(below.pressure - above.pressure) / below.pressure).toBeLessThan(tol);
    }
    // Temperature is continuous through the lower layers.
    for (const z of [geo(11_000), geo(20_000), geo(32_000), geo(47_000), geo(51_000), geo(71_000)]) {
      expect(Math.abs(atmosphere(z - 1e-6).temperature - atmosphere(z + 1e-6).temperature)).toBeLessThan(1e-3);
    }
  });

  it('clamps negative altitude to sea level', () => {
    const a = atmosphere(-500);
    const s = atmosphere(0);
    expect(a.rho).toBeCloseTo(s.rho, 12);
    expect(a.pressure).toBeCloseTo(s.pressure, 6);
  });

  it('treats non-finite altitude as sea level', () => {
    const s = atmosphere(0);
    expect(atmosphere(NaN).rho).toBeCloseTo(s.rho, 12);
    expect(atmosphere(-Infinity).rho).toBeCloseTo(s.rho, 12);
  });

  it('decays smoothly above 86 km and stays finite and non-negative', () => {
    let prev = atmosphere(86_000).rho;
    for (const h of [90_000, 100_000, 150_000, 300_000, 1_000_000]) {
      const a = atmosphere(h);
      expect(Number.isFinite(a.rho)).toBe(true);
      expect(a.rho).toBeGreaterThanOrEqual(0);
      expect(a.rho).toBeLessThan(prev);
      prev = a.rho;
    }
    expect(atmosphere(1e7).rho).toBeGreaterThanOrEqual(0);
  });

  it('matches USSA76 density through the stratosphere and mesosphere', () => {
    within(atmosphere(30_000).rho, 1.841e-2, 0.01);
    within(atmosphere(50_000).rho, 1.027e-3, 0.01);
    within(atmosphere(80_000).rho, 1.846e-5, 0.02);
  });

  it('matches thermosphere density to the mean model', () => {
    within(atmosphere(100_000).rho, 5.6e-7, 0.1);
    within(atmosphere(150_000).rho, 2.08e-9, 0.1);
    within(atmosphere(200_000).rho, 2.54e-10, 0.15);
  });

  it('density strictly decreases on a 1 km grid from 0 to 999 km', () => {
    let prev = atmosphere(0).rho;
    for (let km = 1; km <= 999; km++) {
      const rho = atmosphere(km * 1000).rho;
      expect(rho).toBeLessThan(prev);
      prev = rho;
    }
  });

  it('is continuous in density across 86 km', () => {
    for (let z = 85_000; z < 87_000; z += 10) {
      const a = atmosphere(z).rho;
      const b = atmosphere(z + 10).rho;
      expect(Math.abs(a - b) / a).toBeLessThan(0.01);
    }
  });

  it('is vacuum above 1000 km with finite temperature and sound speed', () => {
    const a = atmosphere(2_000_000);
    expect(a.rho).toBe(0);
    expect(a.pressure).toBe(0);
    expect(Number.isFinite(a.temperature)).toBe(true);
    expect(Number.isFinite(a.soundSpeed)).toBe(true);
  });
});
