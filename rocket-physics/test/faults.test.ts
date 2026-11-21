import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FLUIDS, isCryogenic, vapourPressure } from '../src/faults/fluids.ts';
import { MATERIALS } from '../src/faults/materials.ts';

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
