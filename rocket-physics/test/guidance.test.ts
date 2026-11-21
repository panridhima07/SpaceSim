import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MU_EARTH,
  RE,
  G0,
  deltaVUntil,
  predictCutoff,
  solveSteering,
  thrustAccelAt,
  timeForDeltaV,
  type BurnSegment,
  type PlanarState,
  type SteeringLaw,
} from '../src/index.ts';

const MU = MU_EARTH;

function close(actual: number, expected: number, tol: number, msg = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} actual=${actual} expected=${expected} diff=${actual - expected} tol=${tol}`,
  );
}

function relClose(actual: number, expected: number, tol: number, msg = ''): void {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(rel <= tol, `${msg} actual=${actual} expected=${expected} relErr=${rel} tol=${tol}`);
}

/** The target circular orbit at radius r. */
function circularTarget(r: number): PlanarState {
  return { r, rdot: 0, h: Math.sqrt(MU * r) };
}

/** Miss of the predicted cutoff state against the target, in metres, m/s and m^2/s. */
function assertHitsTarget(state: PlanarState, law: SteeringLaw, segs: BurnSegment[], target: PlanarState): void {
  const p = predictCutoff(state, law, MU, segs);
  assert.ok(Math.abs(p.r - target.r) < 10, `radius miss ${p.r - target.r} m`);
  assert.ok(Math.abs(p.rdot - target.rdot) < 0.1, `radial speed miss ${p.rdot - target.rdot} m/s`);
  assert.ok(Math.abs(p.h - target.h) / target.r < 0.1, `angular momentum miss ${(p.h - target.h) / target.r} m/s`);
}

describe('burn segment bookkeeping', () => {
  const single: BurnSegment[] = [{ start: 0, duration: 40, ve: 3050, tau: 160000 / 2700 }];
  const twoWithGap: BurnSegment[] = [
    { start: 0, duration: 40, ve: 3050, tau: 160000 / 2700 },
    { start: 48, duration: 380, ve: 3413, tau: 121000 / 273.7 },
  ];
  const gapShifted: BurnSegment[] = [
    twoWithGap[0],
    { ...twoWithGap[1], start: 300 },
  ];

  test('deltaVUntil of one segment is -ve ln(1 - d/tau)', () => {
    const d = 25;
    const seg = single[0];
    const expected = -seg.ve * Math.log(1 - d / seg.tau);
    close(deltaVUntil(single, d), expected, 1e-9);
  });

  test('deltaVUntil sums both segments and ignores the gap length', () => {
    const d1 = -twoWithGap[0].ve * Math.log(1 - twoWithGap[0].duration / twoWithGap[0].tau);
    const d2 = -twoWithGap[1].ve * Math.log(1 - 100 / twoWithGap[1].tau);
    close(deltaVUntil(twoWithGap, 148), d1 + d2, 1e-9, 'two segments');
    // The second segment starts at 48 s in one case and at 300 s in the other: once the
    // time limit is past both starts, the delta-v must be the same.
    // Once both burns are over, the delta-v is the same whatever the coast length.
    const dvFull = d1 + -twoWithGap[1].ve * Math.log(1 - 380 / twoWithGap[1].tau);
    close(deltaVUntil(twoWithGap, 428), dvFull, 1e-9, 'both burns complete');
    close(deltaVUntil(gapShifted, 680), dvFull, 1e-9, 'gap insensitivity');
  });

  test('timeForDeltaV inverts deltaVUntil inside the first segment', () => {
    for (const t of [5, 20, 39]) {
      const dv = deltaVUntil(twoWithGap, t);
      close(timeForDeltaV(twoWithGap, dv), t, 1e-6, `t=${t}`);
    }
  });

  test('timeForDeltaV inverts deltaVUntil inside the second segment', () => {
    for (const t of [60, 150, 300, 420]) {
      const dv = deltaVUntil(twoWithGap, t);
      close(timeForDeltaV(twoWithGap, dv), t, 1e-6, `t=${t}`);
    }
  });

  test('thrustAccelAt is ve/(tau - s) inside a burn and zero in the gap and after the end', () => {
    const seg = twoWithGap[0];
    for (const s of [0, 10, 30]) {
      close(thrustAccelAt(twoWithGap, s), seg.ve / (seg.tau - s), 1e-9, `burn s=${s}`);
    }
    const s2 = twoWithGap[1];
    close(thrustAccelAt(twoWithGap, 100), s2.ve / (s2.tau - (100 - s2.start)), 1e-9, 'second burn');
    assert.equal(thrustAccelAt(twoWithGap, 44), 0, 'in the gap');
    assert.equal(thrustAccelAt(twoWithGap, 500), 0, 'after the end');
  });
});

describe('predictCutoff', () => {
  const burn: BurnSegment[] = [{ start: 0, duration: 380, ve: 348 * G0, tau: 121000 / 273.7 }];

  test('zero thrust time returns the input state', () => {
    const r = RE + 120e3;
    const state: PlanarState = { r, rdot: 900, h: r * 2800 };
    const p = predictCutoff(state, { k1: 0.5, k2: -0.001, T: 1e-6 }, MU, burn);
    close(p.r, state.r, 1e-3, 'r');
    // Thrust acts for 1 us: about 8e-6 m/s of change is physical here.
    close(p.rdot, state.rdot, 1e-4, 'rdot');
    // Thrust over 1 us adds about 45 m^2/s to h (a r T): compare relatively.
    relClose(p.h, state.h, 1e-8, 'h');
  });

  test('a pure coast from a circular orbit keeps radius and angular momentum', () => {
    // One segment that starts at t=100, with cutoff at t=100: only the coast is integrated.
    const coast: BurnSegment[] = [{ start: 100, duration: 100, ve: 3000, tau: 100 }];
    const r = RE + 200e3;
    const h = Math.sqrt(MU * r);
    const p = predictCutoff({ r, rdot: 0, h }, { k1: 0, k2: 0, T: 100 }, MU, coast);
    relClose(p.r, r, 1e-6, 'radius');
    close(p.rdot, 0, 1e-3, 'radial speed stays zero');
    relClose(p.h, h, 1e-6, 'angular momentum');
  });

  // Regression: predictCutoff once returned the input state when every burn started after T.
  test('a 10 s radial coast from rest drops by about 0.5 g t^2', () => {
    // Launch-like state at h = 0 and rdot = 0, 100 km up; the burn does not start until t=100.
    const r = RE + 100e3;
    const g = MU / (r * r);
    const later: BurnSegment[] = [{ start: 100, duration: 50, ve: 3000, tau: 100 }];
    const p = predictCutoff({ r, rdot: 0, h: 0 }, { k1: 0, k2: 0, T: 10 }, MU, later);
    const drop = r - p.r;
    relClose(drop, 0.5 * g * 10 * 10, 0.01, 'drop distance');
    relClose(p.rdot, -g * 10, 0.01, 'vertical speed');
  });

  test('a horizontal 5 s burn adds angular momentum of r times delta-v', () => {
    const r = RE + 200e3;
    const h0 = Math.sqrt(MU * r);
    const short: BurnSegment[] = [{ start: 0, duration: 5, ve: 3000, tau: 200 }];
    const dv = deltaVUntil(short, 5);
    const p = predictCutoff({ r, rdot: 0, h: h0 }, { k1: 0, k2: 0, T: 5 }, MU, short);
    relClose(p.h - h0, r * dv, 0.005, 'delta-h');
  });
});

describe('solveSteering: upper stage to a circular orbit', () => {
  const rT = RE + 200e3;
  const target = circularTarget(rT);
  const segs: BurnSegment[] = [{ start: 0, duration: 380, ve: 348 * G0, tau: 121000 / 273.7 }];
  const state: PlanarState = { r: RE + 120e3, rdot: 900, h: (RE + 120e3) * 2800 };
  let first: ReturnType<typeof solveSteering>;

  test('converges, is feasible and predicts a cutoff on the target', () => {
    first = solveSteering(state, target, MU, segs);
    assert.equal(first.converged, true);
    assert.equal(first.feasible, true);
    assert.ok(first.law.T > 250 && first.law.T < 380, `T=${first.law.T}`);
    assertHitsTarget(state, first.law, segs, target);
  });

  test('the initial pitch is between 0 and 45 degrees, and pitch falls with time', () => {
    const pitch0 = Math.atan(first.law.k1);
    assert.ok(pitch0 > 0 && pitch0 < Math.PI / 4, `pitch0=${(pitch0 * 180) / Math.PI} deg`);
    assert.ok(first.law.k2 < 0, `k2=${first.law.k2}`);
  });

  test('a warm start from the previous law converges in at most 2 iterations', () => {
    const again = solveSteering(state, target, MU, segs, first.law);
    assert.equal(again.converged, true);
    assert.ok(again.iterations <= 2, `iterations=${again.iterations}`);
  });

  test('an infeasible 150 s stage is flagged, and its cutoff is the end of the burn', () => {
    const short: BurnSegment[] = [{ start: 0, duration: 150, ve: 348 * G0, tau: 121000 / 273.7 }];
    const sol = solveSteering(state, target, MU, short);
    assert.equal(sol.feasible, false);
    close(sol.law.T, 150, 1e-6, 'cutoff time');
  });
});

describe('solveSteering: two burns with a coast between', () => {
  const rT = RE + 200e3;
  const target = circularTarget(rT);
  const segs: BurnSegment[] = [
    { start: 0, duration: 40, ve: 3050, tau: 160000 / 2700 },
    { start: 48, duration: 380, ve: 3413, tau: 121000 / 273.7 },
  ];
  const state: PlanarState = { r: RE + 60e3, rdot: 1000, h: (RE + 60e3) * 1700 };

  test('converges, predicts the target and cuts off after the coast', () => {
    const sol = solveSteering(state, target, MU, segs);
    assert.equal(sol.converged, true);
    assert.ok(sol.law.T > 48, `T=${sol.law.T}`);
    assertHitsTarget(state, sol.law, segs, target);
  });
});
