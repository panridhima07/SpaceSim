import { describe, it, expect } from 'vitest';
import { aeroProps, compressibilityFactor, dragBreakdown, transonicWaveCd } from './aero';
import { massProps } from './massprops';
import { FIXTURE_ROCKET, FIXTURE_MOTOR } from './fixture';

describe('aeroProps (Barrowman)', () => {
  const cg = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, 0).cgX;

  it('reference area and length follow maxRadius', () => {
    const a = aeroProps(FIXTURE_ROCKET, 0.3, cg);
    expect(a.refArea).toBeCloseTo(Math.PI * 0.0125 ** 2, 12);
    expect(a.refLength).toBeCloseTo(0.025, 12);
  });

  it('fixture normal force slope is between 6 and 25 per rad', () => {
    const a = aeroProps(FIXTURE_ROCKET, 0.3, cg);
    expect(a.cnAlpha).toBeGreaterThan(6);
    expect(a.cnAlpha).toBeLessThan(25);
  });

  it('body lift acts at the body planform centroid, ahead of the CP', () => {
    const a = aeroProps(FIXTURE_ROCKET, 0.3, cg);
    // Body lift factor K * A_planform / A_ref is below the bounding-rectangle value
    // (the nose tapers) but well above half of it.
    const rect = (1.1 * 2 * FIXTURE_ROCKET.maxRadius * FIXTURE_ROCKET.length) / a.refArea;
    expect(a.bodyLift).toBeGreaterThan(0.5 * rect);
    expect(a.bodyLift).toBeLessThan(rect);
    expect(a.bodyLiftX).toBeGreaterThan(0);
    expect(a.bodyLiftX).toBeLessThan(a.cpX);
  });

  it('fin CNα matches the hand-computed Barrowman value', () => {
    // Hand calculation for the fixture fin set at M=0 (no compressibility correction).
    // Body-fin interference Kfb is applied twice, as OpenRocket's stored results do.
    const N = 3;
    const s = 0.04; // span
    const Cr = 0.05;
    const Ct = 0.025;
    const m = 0.025; // sweep
    const rb = 0.0125;
    const d = 0.025; // reference diameter
    const Kfb = 1 + rb / (s + rb);
    const l = Math.sqrt(s * s + (m + Ct / 2 - Cr / 2) ** 2);
    const denom = 1 + Math.sqrt(1 + (2 * l / (Cr + Ct)) ** 2);
    const finCn = (Kfb * Kfb * 4 * N * (s / d) ** 2) / denom;
    const nose = 2; // ogive nose with base radius equal to maxRadius

    const a = aeroProps(FIXTURE_ROCKET, 0, cg);
    expect(a.cnAlpha).toBeCloseTo(nose + finCn, 6);
  });

  it('centre of pressure is aft of the CG with 1 to 3 calibres of stability at launch', () => {
    const a = aeroProps(FIXTURE_ROCKET, 0.3, cg);
    const margin = (a.cpX - cg) / a.refLength;
    expect(a.cpX).toBeGreaterThan(cg);
    expect(margin).toBeGreaterThan(1);
    expect(margin).toBeLessThan(3);
  });

  it('dampSum is positive and finite', () => {
    const a = aeroProps(FIXTURE_ROCKET, 0.3, cg);
    expect(Number.isFinite(a.dampSum)).toBe(true);
    expect(a.dampSum).toBeGreaterThan(0);
  });

  it('drag coefficient is finite and within 0.2 to 1.2 in the subsonic range', () => {
    // The Niskanen rounded-edge fin formula is defined below M 0.9. Above that the
    // fixture's large fin frontal area gives a transonic value outside this band (see
    // the next test), so the band is only asserted subsonically.
    for (const M of [0.05, 0.3]) {
      const cd = aeroProps(FIXTURE_ROCKET, M, cg).cd;
      expect(Number.isFinite(cd)).toBe(true);
      expect(cd).toBeGreaterThan(0.2);
      expect(cd).toBeLessThan(1.2);
    }
  });

  it('drag coefficient stays finite and positive at transonic and supersonic Mach', () => {
    for (const M of [0.9, 1.5]) {
      const cd = aeroProps(FIXTURE_ROCKET, M, cg).cd;
      expect(Number.isFinite(cd)).toBe(true);
      expect(cd).toBeGreaterThan(0.2);
    }
  });
});

describe('external rings and fin cross-section drag', () => {
  // Fixture with the fin set's cross-section replaced.
  const withFins = (cs: 'square' | 'rounded' | 'airfoil') => ({
    ...FIXTURE_ROCKET,
    components: FIXTURE_ROCKET.components.map((c) => (c.kind === 'finset' ? { ...c, crossSection: cs } : c)),
  });
  const A = Math.PI * FIXTURE_ROCKET.maxRadius ** 2;

  it('a launch lug adds its protrusion pressure drag and skin friction', () => {
    const ro = 0.0035;
    const ri = 0.0025;
    const lug = { id: 'lug', name: 'Lug', kind: 'ring' as const, x: 0.2, length: 0.035, density: 680,
      outerRadius: ro, innerRadius: ri, external: true };
    const withLug = { ...FIXTURE_ROCKET, components: [...FIXTURE_ROCKET.components, lug] };
    const M = 0.1;
    const before = dragBreakdown(FIXTURE_ROCKET, M);
    const after = dragBreakdown(withLug, M);
    const pressure = 0.8 * (1 + (M * M) / 4 + M ** 4 / 40) * (Math.PI * (ro * ro - ri * ri)) / A;
    expect(after.pressure - before.pressure).toBeCloseTo(pressure, 9);
    expect(after.friction).toBeGreaterThan(before.friction);
    // The calibration rocket's lug adds roughly 0.04 Cd at low Mach.
    expect(after.total - before.total).toBeGreaterThan(0.03);
    expect(after.total - before.total).toBeLessThan(0.05);
  });

  it('an internal ring adds no drag', () => {
    const ring = { id: 'r', name: 'CR', kind: 'ring' as const, x: 0.2, length: 0.002, density: 680,
      outerRadius: 0.0115, innerRadius: 0.0095 };
    const withRing = { ...FIXTURE_ROCKET, components: [...FIXTURE_ROCKET.components, ring] };
    expect(dragBreakdown(withRing, 0.3).total).toBeCloseTo(dragBreakdown(FIXTURE_ROCKET, 0.3).total, 12);
  });

  it('square fins have more pressure drag and base drag than rounded; airfoil has no fin base drag', () => {
    const sq = dragBreakdown(withFins('square'), 0.3);
    const rd = dragBreakdown(withFins('rounded'), 0.3);
    const af = dragBreakdown(withFins('airfoil'), 0.3);
    expect(sq.pressure).toBeGreaterThan(rd.pressure);
    expect(sq.base).toBeGreaterThan(rd.base);
    expect(af.base).toBeLessThan(rd.base);
    expect(af.pressure).toBeCloseTo(rd.pressure, 12);
  });

  it('undefined cross-section behaves as rounded', () => {
    expect(dragBreakdown(FIXTURE_ROCKET, 0.3).total).toBeCloseTo(dragBreakdown(withFins('rounded'), 0.3).total, 12);
  });
});


describe('transonicWaveCd', () => {
  it('is exact 0 below drag-divergence Mach 0.8', () => {
    expect(transonicWaveCd(0)).toBe(0);
    expect(transonicWaveCd(0.5)).toBe(0);
    expect(transonicWaveCd(0.8)).toBe(0);
  });

  it('rises across Mach 0.8..1.15 and decays supersonically', () => {
    expect(transonicWaveCd(0.95)).toBeGreaterThan(0);
    expect(transonicWaveCd(1.15)).toBeCloseTo(0.30, 6);
    expect(transonicWaveCd(1.5)).toBeLessThan(transonicWaveCd(1.15));
    expect(transonicWaveCd(2.0)).toBeLessThan(transonicWaveCd(1.5));
  });
});

describe('fin compressibility factor', () => {
  it('follows Prandtl-Glauert below Mach 0.8 and 1/sqrt(M^2-1) above Mach 1.2', () => {
    expect(compressibilityFactor(0)).toBe(1);
    expect(compressibilityFactor(0.6)).toBeCloseTo(1 / Math.sqrt(1 - 0.36), 12);
    expect(compressibilityFactor(2)).toBeCloseTo(1 / Math.sqrt(3), 12);
  });

  it('has no step anywhere from Mach 0.5 to 3 (it used to drop 9.5% at Mach 1.2)', () => {
    let prev = compressibilityFactor(0.5);
    for (let M = 0.501; M <= 3; M += 0.001) {
      const f = compressibilityFactor(M);
      expect(Math.abs(f - prev)).toBeLessThan(0.01);
      prev = f;
    }
  });

  it('centre of pressure moves smoothly through Mach 1.2', () => {
    const below = aeroProps(FIXTURE_ROCKET, 1.1999, 0).cpX;
    const above = aeroProps(FIXTURE_ROCKET, 1.2001, 0).cpX;
    expect(Math.abs(above - below)).toBeLessThan(1e-4);
  });
});
