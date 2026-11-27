import { describe, it, expect } from 'vitest';
import { aeroProps, cdAtReynolds, compressibilityFactor, coneWaveCd, dragBreakdown, finCpFraction, noseWaveCd } from './aero';
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


describe('nose wave drag', () => {
  it('is exactly 0 below Mach 0.86, so subsonic drag is unchanged', () => {
    for (const M of [0, 0.5, 0.8, 0.86]) expect(noseWaveCd(M, 'ogive', 0.1, 0.0125, 1)).toBe(0);
  });

  it('a cone follows Hoerner: sin(phi) at Mach 1, 2.1 sin^2 + 0.5 sin / beta from Mach 1.3', () => {
    const s = Math.sin(Math.atan(0.2));
    expect(coneWaveCd(1, s)).toBeCloseTo(s, 12);
    expect(coneWaveCd(2, s)).toBeCloseTo(2.1 * s * s + (0.5 * s) / Math.sqrt(3), 12);
    let prev = coneWaveCd(1, s);
    for (let M = 1.001; M <= 2; M += 0.001) {
      const v = coneWaveCd(M, s);
      expect(Math.abs(v - prev)).toBeLessThan(0.002);
      prev = v;
    }
  });

  it('counts only the excess over the subsonic 0.8 sin^2 for a cone', () => {
    const s = Math.sin(Math.atan(0.0125 / 0.1));
    expect(noseWaveCd(1.2, 'conical', 0.1, 0.0125, 1)).toBeCloseTo(coneWaveCd(1.2, s) - 0.8 * s * s, 12);
  });

  it('is larger for blunter and shorter noses', () => {
    const at = (shape: Parameters<typeof noseWaveCd>[1], L = 0.1, p = 1): number => noseWaveCd(1.2, shape, L, 0.0125, p);
    expect(at('haack')).toBeLessThan(at('ogive'));
    expect(at('ellipsoid')).toBeGreaterThan(at('ogive'));
    expect(at('power', 0.1, 0.5)).toBeGreaterThan(at('power', 0.1, 0.75));
    expect(at('ogive', 0.05)).toBeGreaterThan(at('ogive', 0.1));
  });

  it('raises drag through Mach 1 and has no step', () => {
    let prev = dragBreakdown(FIXTURE_ROCKET, 0.5).total;
    for (let M = 0.505; M <= 2.5; M += 0.005) {
      const v = dragBreakdown(FIXTURE_ROCKET, M).total;
      // Continuous but steep near Mach 0.9, where the rounded fin leading edge drag peaks.
      expect(Math.abs(v - prev), `Mach ${M.toFixed(3)}`).toBeLessThan(0.05);
      prev = v;
    }
    expect(dragBreakdown(FIXTURE_ROCKET, 1.1).pressure).toBeGreaterThan(dragBreakdown(FIXTURE_ROCKET, 0.5).pressure + 0.05);
  });
});

describe('fin lift and CP with Mach', () => {
  it('uses Diederich below Mach 0.9: compressibility inside the root, not a 1/beta multiplier', () => {
    const lo = aeroProps(FIXTURE_ROCKET, 0, 0).cnAlpha;
    const at08 = aeroProps(FIXTURE_ROCKET, 0.8, 0).cnAlpha;
    // A Prandtl-Glauert multiplier would give +67 %; the finite-wing slope of this fin rises ~10 %.
    expect(at08 / lo).toBeGreaterThan(1.02);
    expect(at08 / lo).toBeLessThan(1.2);
  });

  it('CNα and CP have no step from Mach 0.5 to 3', () => {
    let prev = aeroProps(FIXTURE_ROCKET, 0.5, 0);
    for (let M = 0.505; M <= 3; M += 0.005) {
      const a = aeroProps(FIXTURE_ROCKET, M, 0);
      expect(Math.abs(a.cnAlpha / prev.cnAlpha - 1), `CNα at Mach ${M.toFixed(3)}`).toBeLessThan(0.01);
      expect(Math.abs(a.cpX - prev.cpX), `CP at Mach ${M.toFixed(3)}`).toBeLessThan(5e-4);
      prev = a;
    }
  });

  it('fin CP is the quarter MAC subsonic and moves aft supersonic, never past mid-chord', () => {
    expect(finCpFraction(0.3, 0.04, 0.0015)).toBe(0.25);
    expect(finCpFraction(2.5, 0.04, 0.0015)).toBeGreaterThan(0.3);
    for (let M = 0; M <= 4; M += 0.05) {
      const f = finCpFraction(M, 0.04, 0.0015);
      expect(f).toBeGreaterThanOrEqual(0.25);
      expect(f).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('Reynolds number at altitude', () => {
  it('leaves cd unchanged at the reference Reynolds number and raises friction higher up', () => {
    const a = aeroProps(FIXTURE_ROCKET, 0.5, 0);
    const v = 0.5 * 340.3;
    // Reference air: kinematic viscosity 1.5e-5 m²/s.
    const T = 288.15;
    const mu = (1.458e-6 * T * Math.sqrt(T)) / (T + 110.4);
    expect(cdAtReynolds(a, 0.5, v, mu / 1.5e-5, T, FIXTURE_ROCKET.length)).toBeCloseTo(a.cd, 4);
    // 10 km (rho 0.414, 223 K) at Mach 0.05: the Reynolds number is 2.4 times lower and the
    // smooth-turbulent friction higher. (At Mach 0.5 this painted rocket is roughness-limited,
    // where friction does not depend on the Reynolds number.)
    const slow = aeroProps(FIXTURE_ROCKET, 0.05, 0);
    const high = cdAtReynolds(slow, 0.05, 0.05 * 299.5, 0.414, 223.25, FIXTURE_ROCKET.length);
    expect(high).toBeGreaterThan(slow.cd * 1.01);
    expect(high).toBeLessThan(slow.cd * 1.25);
    expect(cdAtReynolds(a, 0.5, 0.5 * 299.5, 0.414, 223.25, FIXTURE_ROCKET.length)).toBeCloseTo(a.cd, 6);
    // No friction information: cd passes through.
    expect(cdAtReynolds({ ...a, cdFriction: undefined }, 0.5, 100, 0.4, 220, 1)).toBe(a.cd);
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
