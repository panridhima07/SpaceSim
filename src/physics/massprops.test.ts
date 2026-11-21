import { describe, it, expect } from 'vitest';
import { massProps } from './massprops';
import { FIXTURE_ROCKET, FIXTURE_MOTOR } from './fixture';

describe('massProps', () => {
  it('fixture mass with motor is in the expected range', () => {
    const mp = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, 0);
    expect(mp.mass).toBeGreaterThan(0.04);
    expect(mp.mass).toBeLessThan(0.08);
  });

  it('mass drops by exactly the propellant mass at burnout', () => {
    const full = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, 0);
    const burnt = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, FIXTURE_MOTOR.burnTime + 1);
    expect(full.mass - burnt.mass).toBeCloseTo(FIXTURE_MOTOR.propellantMass, 9);
  });

  it('full-motor mass equals rocket mass plus motor total mass', () => {
    const none = massProps(FIXTURE_ROCKET, null, 0);
    const full = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, 0);
    expect(full.mass - none.mass).toBeCloseTo(FIXTURE_MOTOR.totalMass, 9);
  });

  it('CG moves forward as propellant burns', () => {
    const full = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, 0);
    const mid = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, 1.0);
    const burnt = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, FIXTURE_MOTOR.burnTime + 1);
    expect(mid.cgX).toBeLessThan(full.cgX);
    expect(burnt.cgX).toBeLessThan(mid.cgX);
  });

  it('CG lies inside the rocket and inertias are positive and finite', () => {
    const mp = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, 0);
    expect(mp.cgX).toBeGreaterThan(0);
    expect(mp.cgX).toBeLessThan(FIXTURE_ROCKET.length);
    expect(Number.isFinite(mp.iPitch)).toBe(true);
    expect(Number.isFinite(mp.iRoll)).toBe(true);
    expect(mp.iPitch).toBeGreaterThan(0);
    expect(mp.iRoll).toBeGreaterThan(0);
    // Roll inertia is smaller than pitch inertia for a slender rocket.
    expect(mp.iRoll).toBeLessThan(mp.iPitch);
  });

  it('a body tube alone has the hand-computed mass', () => {
    const rocket = {
      ...FIXTURE_ROCKET,
      components: [
        {
          kind: 'bodytube' as const,
          id: 'b',
          name: 'b',
          x: 0,
          length: 0.3,
          density: 680,
          outerRadius: 0.0125,
          thickness: 0.0005,
        },
      ],
    };
    const mp = massProps(rocket, null, 0);
    const area = Math.PI * (0.0125 ** 2 - 0.012 ** 2);
    expect(mp.mass).toBeCloseTo(680 * area * 0.3, 10);
    expect(mp.cgX).toBeCloseTo(0.15, 10);
  });
});
