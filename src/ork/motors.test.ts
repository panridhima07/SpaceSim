import { describe, it, expect } from 'vitest';
import {
  parseEng,
  BUILTIN_MOTORS,
  CERTIFIED_MOTORS,
  ALL_MOTORS,
  designationKey,
  findMotor,
  thrustAt,
  propellantRemaining,
} from './motors';

const SAMPLE = `; Test file
; comment line
C6 18 70 0 12.5 24 Estes
0.050 10
0.100 12
0.200 14
1.000 5
1.860 0
D12 24 70 0 21 42 Estes
0.000 0
0.100 20
1.650 0
`;

describe('parseEng', () => {
  it('parses multiple motors, units and totals', () => {
    const motors = parseEng(SAMPLE);
    expect(motors).toHaveLength(2);

    const c6 = motors[0];
    expect(c6.designation).toBe('C6');
    expect(c6.manufacturer).toBe('Estes');
    expect(c6.diameter).toBeCloseTo(0.018, 9);
    expect(c6.length).toBeCloseTo(0.07, 9);
    expect(c6.propellantMass).toBeCloseTo(0.0125, 9);
    expect(c6.totalMass).toBeCloseTo(0.024, 9);
    expect(c6.approximate).toBe(false);
    expect(motors[1].curve[0]).toEqual([0, 0]);
    expect(motors[1].burnTime).toBeCloseTo(1.65, 9);
    expect(c6.burnTime).toBeCloseTo(1.86, 9);
    // First point was at t > 0, so [0, 0] is prepended.
    expect(c6.curve[0]).toEqual([0, 0]);
    expect(c6.curve[c6.curve.length - 1]).toEqual([1.86, 0]);
    // Trapezoid: 0.5*(0+10)*0.05 + ... , cross-checked against a direct sum.
    const expected =
      0.05 * 5 + 0.05 * 11 + 0.1 * 13 + 0.8 * 9.5 + 0.86 * 2.5;
    expect(c6.totalImpulse).toBeCloseTo(expected, 6);

    const d12 = motors[1];
    expect(d12.designation).toBe('D12');
    expect(d12.curve[0]).toEqual([0, 0]);
    expect(d12.burnTime).toBeCloseTo(1.65, 9);
  });

  it('returns an empty list for text without motors', () => {
    expect(parseEng('; nothing here\n')).toEqual([]);
  });
});

describe('BUILTIN_MOTORS', () => {
  it('includes the required designations as approximate motors', () => {
    const names = BUILTIN_MOTORS.map((m) => m.designation);
    for (const d of ['A8', 'B6', 'C6', 'D12', 'E12', 'F40', 'G80', 'H128', 'I284', 'J350']) {
      expect(names).toContain(d);
    }
    for (const m of BUILTIN_MOTORS) expect(m.approximate).toBe(true);
  });

  it.each(BUILTIN_MOTORS.map((m) => [m.designation, m] as const))(
    '%s trapezoid integral matches totalImpulse within 0.5 %%',
    (_name, m) => {
      let sum = 0;
      for (let i = 0; i < m.curve.length - 1; i++) {
        const [t0, f0] = m.curve[i];
        const [t1, f1] = m.curve[i + 1];
        sum += ((f0 + f1) / 2) * (t1 - t0);
      }
      expect(Math.abs(sum - m.totalImpulse) / m.totalImpulse).toBeLessThan(0.005);
      expect(m.curve[0]).toEqual([0, 0]);
      expect(m.curve[m.curve.length - 1][1]).toBe(0);
      expect(m.curve[m.curve.length - 1][0]).toBeCloseTo(m.burnTime, 9);
    },
  );

  it('C6 matches its published figures', () => {
    const c6 = BUILTIN_MOTORS.find((m) => m.designation === 'C6')!;
    expect(c6.totalImpulse).toBeCloseTo(8.8, 9);
    expect(c6.burnTime).toBeCloseTo(1.86, 9);
    expect(c6.propellantMass).toBeCloseTo(0.0125, 9);
    expect(c6.totalMass).toBeCloseTo(0.024, 9);
  });
});

describe('thrustAt', () => {
  const motor = parseEng(SAMPLE)[0];

  it('is zero before ignition and after burnout', () => {
    expect(thrustAt(motor, -0.001)).toBe(0);
    expect(thrustAt(motor, motor.burnTime + 0.001)).toBe(0);
  });

  it('returns the curve value at the boundaries', () => {
    expect(thrustAt(motor, 0)).toBe(0);
    expect(thrustAt(motor, motor.burnTime)).toBe(0);
    expect(thrustAt(motor, 0.2)).toBeCloseTo(14, 9);
  });

  it('linearly interpolates between points', () => {
    // Between (0.1, 12) and (0.2, 14): midpoint 0.15 -> 13.
    expect(thrustAt(motor, 0.15)).toBeCloseTo(13, 9);
    // Between (0, 0) and (0.05, 10): 0.025 -> 5.
    expect(thrustAt(motor, 0.025)).toBeCloseTo(5, 9);
  });
});

describe('propellantRemaining', () => {
  it('starts at propellantMass, ends at 0, and decreases monotonically', () => {
    for (const m of [...parseEng(SAMPLE), ...BUILTIN_MOTORS]) {
      expect(propellantRemaining(m, 0)).toBeCloseTo(m.propellantMass, 12);
      expect(propellantRemaining(m, m.burnTime)).toBeCloseTo(0, 12);
      expect(propellantRemaining(m, m.burnTime + 1)).toBe(0);

      let prev = Infinity;
      const steps = 400;
      for (let i = 0; i <= steps; i++) {
        const t = (m.burnTime * i) / steps;
        const p = propellantRemaining(m, t);
        expect(p).toBeLessThanOrEqual(prev + 1e-15);
        expect(p).toBeGreaterThanOrEqual(0);
        prev = p;
      }
    }
  });

  it('is half the propellant when half the impulse has been delivered', () => {
    const m = parseEng(SAMPLE)[0];
    // Find the time where half the impulse is out by bisection on the same integral.
    let lo = 0;
    let hi = m.burnTime;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const remaining = propellantRemaining(m, mid);
      if (remaining > m.propellantMass / 2) lo = mid;
      else hi = mid;
    }
    expect(propellantRemaining(m, lo)).toBeCloseTo(m.propellantMass / 2, 6);
  });
});

describe('CERTIFIED_MOTORS and ALL_MOTORS', () => {
  it('CERTIFIED_MOTORS is non-empty and every motor is certified', () => {
    expect(CERTIFIED_MOTORS.length).toBeGreaterThan(0);
    for (const m of CERTIFIED_MOTORS) expect(m.approximate).toBe(false);
  });

  it.each(CERTIFIED_MOTORS.map((m) => [m.designation, m] as const))(
    '%s certified curve integral matches totalImpulse within 0.5 %%',
    (_name, m) => {
      expect(m.curve[0][0]).toBe(0);
      expect(m.curve[m.curve.length - 1][1]).toBe(0);
      expect(Math.abs(trapezoid(m.curve) - m.totalImpulse) / m.totalImpulse).toBeLessThan(0.005);
    },
  );

  it('findMotor returns the certified C6 for C6-5', () => {
    const c6 = findMotor({ designation: 'C6-5' })!;
    expect(c6.approximate).toBe(false);
    expect(CERTIFIED_MOTORS).toContain(c6);
  });

  it('ALL_MOTORS has no duplicate designations and is sorted by impulse', () => {
    const keys = ALL_MOTORS.map((m) => designationKey(m.designation));
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 1; i < ALL_MOTORS.length; i++) {
      expect(ALL_MOTORS[i].totalImpulse).toBeGreaterThanOrEqual(ALL_MOTORS[i - 1].totalImpulse);
    }
  });
});

/** Trapezoid integral of a thrust curve, N s. */
function trapezoid(curve: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    sum += ((curve[i][1] + curve[i + 1][1]) / 2) * (curve[i + 1][0] - curve[i][0]);
  }
  return sum;
}

describe('findMotor', () => {
  it.each([
    [{ designation: 'C6' }],
    [{ designation: 'c6' }],
    [{ designation: 'C6-5' }],
    [{ designation: 'Estes C6' }],
    [{ manufacturer: 'Estes', designation: 'C6-5' }],
  ])('finds Estes C6 from %o', (ref) => {
    const m = findMotor(ref);
    expect(m).not.toBeNull();
    expect(m!.designation).toBe('C6');
    expect(m!.manufacturer).toBe('Estes');
  });

  it('returns null for unknown designations', () => {
    expect(findMotor({ designation: 'Z99' })).toBeNull();
  });

  it('prefers extra motors over built-in ones', () => {
    const custom = { ...parseEng(SAMPLE)[0], manufacturer: 'Custom' };
    const found = findMotor({ designation: 'C6' }, [custom]);
    expect(found).toBe(custom);
  });

  it('uses the manufacturer to choose between same-designation motors', () => {
    const extra = { ...parseEng(SAMPLE)[0], manufacturer: 'Custom', designation: 'F40' };
    const aero = findMotor({ manufacturer: 'Aerotech', designation: 'F40' }, [extra]);
    expect(aero!.manufacturer.toLowerCase()).toBe('aerotech');
    const custom = findMotor({ manufacturer: 'Custom', designation: 'F40' }, [extra]);
    expect(custom).toBe(extra);
  });
});
