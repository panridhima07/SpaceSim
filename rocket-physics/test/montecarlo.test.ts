import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SITES } from '../src/env/earth.ts';
import { DEFAULT_CD_TABLE } from '../src/aero/aero.ts';
import type { AscentOptions } from '../src/gnc/autopilot.ts';
import { twoStageKerolox } from '../src/vehicle/presets.ts';
import type { VehicleSpec } from '../src/vehicle/types.ts';
import { gaussian, mulberry32, perturbVehicle, runDispersions, summarize } from '../src/sim/montecarlo.ts';

function close(actual: number, expected: number, tol: number, msg = ''): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} actual=${actual} expected=${expected} tol=${tol}`);
}

describe('random number generation', () => {
  test('mulberry32 is deterministic and stays in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    assert.deepEqual(seqA, seqB);
    assert.notDeepEqual(seqA, Array.from({ length: 5 }, () => mulberry32(43)()));

    const r = mulberry32(7);
    for (let i = 0; i < 10000; i++) {
      const x = r();
      assert.ok(x >= 0 && x < 1, `out of range: ${x}`);
    }
  });

  test('gaussian has mean ~0 and std ~1', () => {
    const r = mulberry32(123);
    const n = 20000;
    const xs = Array.from({ length: n }, () => gaussian(r));
    const s = summarize(xs);
    close(s.mean, 0, 0.03, 'mean');
    close(s.std, 1, 0.03, 'std');
  });
});

describe('summarize', () => {
  test('statistics of a known array', () => {
    const s = summarize([1, 2, 3, 4, 5]);
    close(s.mean, 3, 1e-12, 'mean');
    close(s.std, Math.sqrt(2.5), 1e-12, 'sample std');
    assert.equal(s.min, 1);
    assert.equal(s.max, 5);
    close(s.p05, 1.2, 1e-12, 'p05');
    close(s.p50, 3, 1e-12, 'p50');
    close(s.p95, 4.8, 1e-12, 'p95');
  });

  test('std is 0 for a single value', () => {
    assert.equal(summarize([9]).std, 0);
  });
});

describe('perturbVehicle', () => {
  test('does not mutate its input', () => {
    const v = twoStageKerolox(12000);
    const before = JSON.stringify(v);
    const out = perturbVehicle(v, { thrust: 0.05, isp: 3, dryMass: 0.02, propellant: 0.01, drag: 0.1 }, mulberry32(5));
    assert.equal(JSON.stringify(v), before);
    assert.notEqual(out, v);
    assert.notEqual(out.stages[0], v.stages[0]);
    assert.notEqual(out.stages[0].engine.thrustVac, v.stages[0].engine.thrustVac);
  });

  test('an all-zero spec returns equal values', () => {
    const v: VehicleSpec = twoStageKerolox(12000);
    v.aero = { cdTable: [[0, 0.3], [1, 0.5], [5, 0.25]] };
    const zero = { thrust: 0, isp: 0, dryMass: 0, propellant: 0, drag: 0, wind: 0 };
    assert.deepStrictEqual(perturbVehicle(v, zero, mulberry32(9)), v);
  });

  test('a vehicle without aero gets the default drag table, scaled', () => {
    const v = twoStageKerolox(12000);
    const out = perturbVehicle(v, { drag: 0 }, mulberry32(1));
    assert.deepStrictEqual(out.aero?.cdTable, DEFAULT_CD_TABLE);
  });
});

describe('runDispersions', () => {
  const cfg = { site: SITES.sriharikota, epoch: new Date('2026-11-21T09:00:00Z') };
  const opts: AscentOptions = {
    target: { perigeeAltitude: 200e3, apogeeAltitude: 600e3, compensateOblateness: true },
    pitchKickDeg: 6,
    maxG: 4.5,
  };
  const mc = { runs: 3, seed: 7, tMax: 1500 };
  const makeVehicle = (): VehicleSpec => twoStageKerolox(12000);

  test('is reproducible for a given seed and varies between runs', () => {
    const first = runDispersions(makeVehicle, cfg, opts, mc);
    const second = runDispersions(makeVehicle, cfg, opts, mc);
    assert.deepStrictEqual(second, first);

    assert.equal(first.runs.length, 3);
    assert.ok(first.successRate >= 0 && first.successRate <= 1, `successRate=${first.successRate}`);
    const perigees = new Set(first.runs.map((r) => r.perigeeAltitude));
    assert.ok(perigees.size > 1, 'runs should differ from each other');
  });
});
