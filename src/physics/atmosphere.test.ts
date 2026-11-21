import { describe, it, expect } from 'vitest';
import { atmosphere } from './atmosphere';

describe('atmosphere (ISA)', () => {
  it('matches sea-level standard values', () => {
    const a = atmosphere(0);
    expect(a.rho).toBeCloseTo(1.225, 3);
    expect(a.pressure).toBeCloseTo(101325, 0);
    expect(a.temperature).toBeCloseTo(288.15, 6);
    expect(a.soundSpeed).toBeCloseTo(340.29, 1);
  });

  it('matches the 11 km standard density', () => {
    const a = atmosphere(11_000);
    expect(a.temperature).toBeCloseTo(216.65, 2);
    expect(a.rho).toBeCloseTo(0.3639, 3);
  });

  it('is continuous at every layer boundary', () => {
    for (const h of [11_000, 20_000, 32_000, 47_000, 51_000, 71_000, 86_000]) {
      const below = atmosphere(h - 1e-6);
      const above = atmosphere(h + 1e-6);
      expect(Math.abs(below.rho - above.rho) / below.rho).toBeLessThan(1e-4);
      expect(Math.abs(below.pressure - above.pressure) / below.pressure).toBeLessThan(1e-4);
      expect(Math.abs(below.temperature - above.temperature)).toBeLessThan(1e-3);
    }
  });

  it('clamps negative altitude to sea level', () => {
    const a = atmosphere(-500);
    const s = atmosphere(0);
    expect(a.rho).toBeCloseTo(s.rho, 12);
    expect(a.pressure).toBeCloseTo(s.pressure, 6);
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
});
