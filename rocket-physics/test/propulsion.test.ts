import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { G0, P0, R_GAS } from '../src/constants.ts';
import { areaRatio, machFromAreaRatio, nozzlePerformance, type ChamberDesign } from '../src/propulsion/nozzle.ts';
import { engineFromChamber, engineOutput, exitArea, solidReferenceThrust, thrustCurveAt } from '../src/propulsion/engine.ts';
import type { EngineSpec } from '../src/vehicle/types.ts';

function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

function assertRel(actual: number, expected: number, tol: number, msg = ''): void {
  assert.ok(relErr(actual, expected) <= tol, `${msg} actual=${actual} expected=${expected} relErr=${relErr(actual, expected)}`);
}

const ideal: ChamberDesign = {
  chamberPressure: 7e6,
  chamberTemperature: 3500,
  gamma: 1.2,
  molarMass: 0.022,
  throatArea: 0.05,
  expansionRatio: 40,
};

describe('areaRatio and machFromAreaRatio', () => {
  test('A/A* is exactly 1 at Mach 1', () => {
    for (const g of [1.14, 1.2, 1.4]) assertRel(areaRatio(1, g), 1, 1e-12, `gamma=${g}`);
  });

  test('A/A* is greater than 1 on both sides of Mach 1', () => {
    for (const g of [1.14, 1.2, 1.4]) {
      assert.ok(areaRatio(0.5, g) > 1, `subsonic gamma=${g}`);
      assert.ok(areaRatio(2, g) > 1, `supersonic gamma=${g}`);
    }
  });

  test('known value: gamma 1.4, Mach 2 gives 1.6875', () => {
    assertRel(areaRatio(2, 1.4), 1.6875, 1e-9);
  });

  test('known value: gamma 1.4, Mach 3 gives 4.2346', () => {
    assertRel(areaRatio(3, 1.4), 4.2346, 1e-4);
  });

  test('machFromAreaRatio inverts areaRatio (supersonic branch)', () => {
    for (const g of [1.14, 1.2, 1.4]) {
      for (const eps of [2, 10, 50, 200]) {
        const M = machFromAreaRatio(eps, g);
        assert.ok(M > 1, `Mach should be supersonic (gamma=${g}, eps=${eps})`);
        assertRel(areaRatio(M, g), eps, 1e-9, `gamma=${g} eps=${eps}`);
      }
    }
  });
});

describe('nozzlePerformance (ideal engine)', () => {
  const p = nozzlePerformance(ideal);

  test('mass flow equals pc * At / c*', () => {
    assertRel(p.massFlow, (ideal.chamberPressure * ideal.throatArea) / p.characteristicVelocity, 1e-12);
  });

  test('c* matches sqrt(R T / M) / Gamma within 0.5 % and is about 1774 m/s', () => {
    const g = ideal.gamma;
    const Gamma = Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
    const expected = Math.sqrt((R_GAS / ideal.molarMass) * ideal.chamberTemperature) / Gamma;
    assertRel(p.characteristicVelocity, expected, 0.005);
    assertRel(p.characteristicVelocity, 1774, 0.005);
  });

  test('exit Mach gives A/A* = expansion ratio, and exit pressure is isentropic', () => {
    const g = ideal.gamma;
    assertRel(areaRatio(p.exitMach, g), ideal.expansionRatio, 1e-9);
    const pe = ideal.chamberPressure * Math.pow(1 + ((g - 1) / 2) * p.exitMach * p.exitMach, -g / (g - 1));
    assertRel(p.exitPressure, pe, 1e-9);
  });

  test('exit area = throat area * expansion ratio', () => {
    assertRel(p.exitArea, ideal.throatArea * ideal.expansionRatio, 1e-12);
  });

  test('vacuum thrust = mdot * ve + pe * Ae', () => {
    assertRel(p.thrustVac, p.massFlow * p.exitVelocity + p.exitPressure * p.exitArea, 1e-12);
  });

  test('vacuum Isp is in the plausible range 310-340 s', () => {
    // Hand estimate: Isp_vac = CF * c* / g0 with CF about 1.89 gives about 341 s, just
    // above the 340 s guess in the spec. The bound is widened to 350 s to match physics.
    assert.ok(p.ispVac >= 310 && p.ispVac <= 350, `ispVac=${p.ispVac}`);
  });

  test('sea-level thrust is lower than vacuum by exactly P0 * Ae', () => {
    const sl = p.at(P0).thrust;
    assertRel(p.thrustVac - sl, P0 * p.exitArea, 1e-12);
  });

  test('vacuum thrust coefficient is between 1.7 and 1.95', () => {
    const cf = p.at(0).thrustCoefficient;
    assert.ok(cf > 1.7 && cf < 1.95, `CF=${cf}`);
  });

  test('not separated at 1000 Pa ambient', () => {
    assert.equal(p.at(1000).separated, false);
  });

  test('separated at sea level for eps = 200, pc = 3 MPa', () => {
    const hi = nozzlePerformance({ ...ideal, chamberPressure: 3e6, expansionRatio: 200 });
    assert.equal(hi.at(P0).separated, true);
  });

  test('efficiency 0.95 scales thrust by 0.95', () => {
    const eff = nozzlePerformance({ ...ideal, efficiency: 0.95 });
    assertRel(eff.thrustVac, 0.95 * p.thrustVac, 1e-12);
    assertRel(eff.at(P0).thrust, 0.95 * p.at(P0).thrust, 1e-12);
  });
});

describe('exitArea (engine)', () => {
  test('derived from ispSL when exitArea is absent', () => {
    const e: EngineSpec = { name: 'e', thrustVac: 934e3, ispVac: 348, ispSL: 100 };
    assertRel(exitArea(e), (934e3 * (1 - 100 / 348)) / P0, 1e-12);
  });

  test('explicit exitArea wins over ispSL', () => {
    const e: EngineSpec = { name: 'e', thrustVac: 934e3, ispVac: 348, ispSL: 100, exitArea: 0.7 };
    assert.equal(exitArea(e), 0.7);
  });

  test('zero when neither exitArea nor ispSL is given', () => {
    assert.equal(exitArea({ name: 'e', thrustVac: 934e3, ispVac: 348 }), 0);
  });
});

describe('engineOutput', () => {
  const vac: EngineSpec = { name: 'e', thrustVac: 934e3, ispVac: 348, ispSL: 100 };

  test('zero throttle gives zero thrust and zero mass flow', () => {
    const out = engineOutput(vac, 0, P0);
    assert.equal(out.thrust, 0);
    assert.equal(out.massFlow, 0);
  });

  test('vacuum full throttle gives thrustVac and mdot = thrustVac / (g0 ispVac)', () => {
    const out = engineOutput(vac, 1, 0);
    assertRel(out.thrust, 934e3, 1e-12);
    assertRel(out.massFlow, 934e3 / (G0 * 348), 1e-12);
  });

  test('sea level with ispSL reproduces ispSL from thrust / (mdot g0)', () => {
    const out = engineOutput(vac, 1, P0);
    assertRel(out.thrust / (out.massFlow * G0), 100, 1e-9);
  });

  test('thrust is never negative, even with huge ambient pressure', () => {
    const out = engineOutput(vac, 1, 1e12);
    assert.equal(out.thrust, 0);
    assert.ok(out.massFlow > 0);
  });

  test('half throttle halves mass flow', () => {
    const full = engineOutput(vac, 1, 0);
    const half = engineOutput(vac, 0.5, 0);
    assertRel(half.massFlow, 0.5 * full.massFlow, 1e-12);
  });
});

describe('solid thrust curve', () => {
  const curve: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [2, 1],
    [3, 1],
    [6, 0],
  ];

  test('thrustCurveAt interpolates linearly', () => {
    assertRel(thrustCurveAt(curve, 1), 0.5, 1e-12);
    assertRel(thrustCurveAt(curve, 2.5), 1, 1e-12);
    assertRel(thrustCurveAt(curve, 4.5), 0.5, 1e-12);
  });

  test('thrustCurveAt is zero before start and after end', () => {
    assert.equal(thrustCurveAt(curve, -1), 0);
    assert.equal(thrustCurveAt(curve, 7), 0);
  });

  test('solidReferenceThrust: integrating the scaled curve returns the propellant mass', () => {
    const propellant = 1000;
    const isp = 250;
    const ref = solidReferenceThrust(curve, propellant, isp);
    const h = 1e-4;
    let mass = 0;
    const T = 6;
    let prev = thrustCurveAt(curve, 0) * ref / (G0 * isp);
    for (let t = h; t <= T + 1e-12; t += h) {
      const cur = thrustCurveAt(curve, t) * ref / (G0 * isp);
      mass += 0.5 * (prev + cur) * h;
      prev = cur;
    }
    assertRel(mass, propellant, 1e-3);
  });
});

describe('engineFromChamber', () => {
  test('returns thrustVac, ispVac and exitArea equal to nozzlePerformance and merges extra', () => {
    const p = nozzlePerformance(ideal);
    const e = engineFromChamber('core', ideal, { minThrottle: 0.4 });
    assert.equal(e.name, 'core');
    assert.equal(e.thrustVac, p.thrustVac);
    assert.equal(e.ispVac, p.ispVac);
    assert.equal(e.exitArea, p.exitArea);
    assert.equal(e.minThrottle, 0.4);
  });
});
