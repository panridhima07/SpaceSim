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
