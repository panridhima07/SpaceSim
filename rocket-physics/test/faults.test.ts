import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FLUIDS, isCryogenic, vapourPressure } from '../src/faults/fluids.ts';
import { MATERIALS } from '../src/faults/materials.ts';
import {
  axialPressureStress,
  equivalentAxialLoad,
  hoopStress,
  knockdown,
  nozzleExitPressure,
  separationState,
  shellBucklingStress,
  solidPressureFactor,
  ventStep,
} from '../src/faults/pressure.ts';
import {
  arealHeatCapacity,
  boilOffRate,
  heatLeak,
  radiativeEquilibriumTemp,
  recoveryTemperature,
  skinStep,
  tankSurfaceArea,
} from '../src/faults/thermal.ts';
import { applyScenario, lvm3FaultSpec } from '../src/faults/spec.ts';
import { lvm3 } from '../src/vehicle/presets.ts';

function close(actual: number, expected: number, tol: number, msg = ''): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} actual=${actual} expected=${expected} diff=${actual - expected} tol=${tol}`);
}

function relClose(actual: number, expected: number, tol: number, msg = ''): void {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(rel <= tol, `${msg} actual=${actual} expected=${expected} relErr=${rel} tol=${tol}`);
}

describe('fluids', () => {
  test('vapourPressure at boiling point and reference temperatures', () => {
    relClose(vapourPressure(FLUIDS.LOX, 90.19), 101325, 1e-9, 'LOX at boiling point');
    relClose(vapourPressure(FLUIDS.N2O4, 303), 158430, 0.01, 'N2O4 at 303 K');
    relClose(vapourPressure(FLUIDS.UH25, 303), 25851, 0.01, 'UH25 at 303 K');
    relClose(vapourPressure(FLUIDS.LH2, 22), 153700, 0.01, 'LH2 at 22 K');
    assert.ok(vapourPressure(FLUIDS.RP1, 300) < 500, `RP-1 vapour pressure should be < 500 Pa, got ${vapourPressure(FLUIDS.RP1, 300)}`);
  });

  test('isCryogenic identifies LOX and LH2 only', () => {
    assert.equal(isCryogenic(FLUIDS.LOX), true);
    assert.equal(isCryogenic(FLUIDS.LH2), true);
    assert.equal(isCryogenic(FLUIDS.RP1), false);
    assert.equal(isCryogenic(FLUIDS.UH25), false);
    assert.equal(isCryogenic(FLUIDS.N2O4), false);
  });
});

describe('materials', () => {
  test('material properties are defined and consistent', () => {
    close(MATERIALS.AL2219.warnTemp, 423, 0);
    close(MATERIALS.M250.maxTemp, 700, 0);
  });
});

describe('pressure', () => {
  test('thin-wall shell stresses and buckling', () => {
    relClose(hoopStress(0.35e6, 2, 0.004), 175e6, 1e-9, 'hoopStress');
    relClose(axialPressureStress(0.35e6, 2, 0.004), 87.5e6, 1e-9, 'axialPressureStress');
    relClose(knockdown(2, 0.004), 0.32173, 0.001, 'knockdown');
    relClose(shellBucklingStress(73.1e9, 0.004, 2), 28.46e6, 0.005, 'shellBucklingStress');
    relClose(equivalentAxialLoad(1e6, 7.4e5, 2), 1.74e6, 1e-9, 'equivalentAxialLoad');
  });

  test('nozzleExitPressure and separationState', () => {
    relClose(nozzleExitPressure(5.85e6, 13.88, 1.2), 47666, 0.01, 'Vikas');
    relClose(nozzleExitPressure(6.0e6, 100, 1.2), 3945, 0.01, 'CE-20');
    relClose(nozzleExitPressure(5.69e6, 12.1, 1.18), 58818, 0.01, 'S200');
    assert.equal(separationState(47666, 101325), 'attached');
    assert.equal(separationState(3945, 101325), 'separated');
    assert.equal(separationState(37400, 101325), 'marginal');
  });

  test('solidPressureFactor', () => {
    relClose(solidPressureFactor(318), 1.05112, 0.0001, 'grainTemp 318 K');
    assert.equal(solidPressureFactor(300), 1);
  });

  test('ventStep', () => {
    assert.equal(ventStep(101325, 50000, 10, 110, 0), 101325);
    close(ventStep(101325, 50000, 1000, 110, 0.08), 50000, 1, 'vent equilibrium');
    const out = ventStep(101325, 50000, 0.1, 110, 0.08);
    assert.ok(out > 50000 && out < 101325, `vent outflow expected in (50000, 101325), got ${out}`);
    const inflow = ventStep(50000, 101325, 0.1, 110, 0.08);
    assert.ok(inflow > 50000 && inflow < 101325, `vent inflow expected in (50000, 101325), got ${inflow}`);
  });
});

describe('thermal', () => {
  test('recoveryTemperature and radiativeEquilibriumTemp', () => {
    relClose(recoveryTemperature(288.15, 2), 493.31, 0.0001, 'recoveryTemperature Mach 2');
    assert.equal(recoveryTemperature(288.15, 0), 288.15);
    relClose(radiativeEquilibriumTemp(28448, 0.8), 889.9, 0.001, 'radiativeEquilibriumTemp');
    assert.equal(radiativeEquilibriumTemp(0, 0.8), 0);
  });

  test('arealHeatCapacity and skinStep', () => {
    relClose(arealHeatCapacity(2840, 864, 0.006), 14722.56, 1e-9, 'arealHeatCapacity');
    close(skinStep(300, 20000, 1000, 1, 14722.56, 0.8), 301.3455, 0.001, 'skinStep heating');
    assert.ok(skinStep(300, 0, 300, 100, 14722.56, 0.8) < 300, 'skinStep radiates only');
    assert.ok(skinStep(900, 20000, 600, 1, 14722.56, 0.8) < 900, 'skinStep hotter than recovery');
  });

  test('tankSurfaceArea, heatLeak, and boilOffRate', () => {
    relClose(tankSurfaceArea(2, 8), 125.66, 0.0001, 'tankSurfaceArea');
    relClose(heatLeak(0.8, 125.66, 303, 20.28), 28421, 0.001, 'heatLeak');
    relClose(boilOffRate(28421, 446e3), 0.06372, 0.001, 'boilOffRate');
  });
});

describe('spec', () => {
  test('lvm3FaultSpec matches lvm3 stages and tanks', () => {
    const vehicle = lvm3();
    const spec = lvm3FaultSpec();
    assert.equal(spec.stages.length, vehicle.stages.length);
    for (let i = 0; i < vehicle.stages.length; i++) {
      assert.equal(spec.stages[i].tanks.length, vehicle.stages[i].tanks.length);
    }
  });

  test('applyScenario returns a deep copy and modifies only the expected field', () => {
    const base = lvm3FaultSpec();

    const blocked = applyScenario(base, 'blocked-vent');
    assert.equal(blocked.fairing!.ventArea, base.fairing!.ventArea * 0.25);
    assert.equal(base.fairing!.ventArea, 0.08);

    const low = applyScenario(base, 'regulator-low');
    assert.equal(low.stages[0].tanks[0].ullagePressure, base.stages[0].tanks[0].ullagePressure * 0.5);
    assert.equal(low.stages[1].tanks[0].ullagePressure, 0);
    assert.equal(base.stages[0].tanks[0].ullagePressure, 0.35e6);

    const high = applyScenario(base, 'regulator-high');
    relClose(high.stages[0].tanks[1].ullagePressure, base.stages[0].tanks[1].ullagePressure * 2.2, 1e-12);
    assert.equal(base.stages[0].tanks[1].ullagePressure, 0.35e6);

    const hot = applyScenario(base, 'hot-grain');
    assert.equal(hot.stages[1].solid!.grainTemp, 318);
    assert.equal(base.stages[1].solid!.grainTemp, 300);

    const thin = applyScenario(base, 'thin-nose');
    assert.equal(thin.noseSkin.thickness, 0.003);
    assert.equal(base.noseSkin.thickness, 0.006);

    const hold = applyScenario(base, 'long-hold');
    assert.equal(hold.padHoldSeconds, 3600);
    assert.equal(base.padHoldSeconds, 0);
  });
});
