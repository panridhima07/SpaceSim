import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AscentAutopilot,
  FailureInjector,
  FaultMonitor,
  SITES,
  Simulation,
  applyScenario,
  classifyOutcome,
  lvm3,
  lvm3FaultSpec,
  supervised,
  tankOffsets,
  type AscentOptions,
  type Failure,
  type FaultSpec,
} from '../src/index.ts';

const LAUNCH_CFG = { site: SITES.sriharikota, epoch: new Date('2023-07-14T09:05:17Z') };
const BASE_ASCENT: AscentOptions = {
  target: { perigeeAltitude: 170e3, apogeeAltitude: 36500e3 },
  pitchKickDeg: 8,
};

function flyPlain() {
  const vehicle = lvm3();
  const autopilot = new AscentAutopilot({ ...BASE_ASCENT });
  const sim = new Simulation(vehicle, LAUNCH_CFG, autopilot);
  sim.run(3000, () => autopilot.phase === 'done' || autopilot.phase === 'aborted');
  return { sim, autopilot, elements: sim.elements(), outcome: classifyOutcome(sim, autopilot) };
}

function flyCase(opts: {
  spec?: FaultSpec;
  failures?: Failure[];
  destructive?: boolean;
}) {
  const vehicle = lvm3();
  const injector = opts.failures ? new FailureInjector(opts.failures) : undefined;
  const overrides = injector ? injector.ascentOverrides() : {};
  const autopilot = new AscentAutopilot({ ...BASE_ASCENT, ...overrides });
  const monitor = new FaultMonitor(vehicle, opts.spec ?? lvm3FaultSpec());
  const sim = new Simulation(
    vehicle,
    LAUNCH_CFG,
    supervised(autopilot, { monitor, injector, destructive: opts.destructive }),
  );
  let allHealthValid = true;
  let allHealthBelowOne = true;
  let firstSkinOverOne = NaN;
  let firstSkinCritical = NaN;
  let badHealthDetail = '';

  sim.run(3000, () => {
    const mt = Number.isFinite(sim.liftoffTime) ? sim.t - sim.liftoffTime : 0;
    for (const [k, v] of Object.entries(monitor.health)) {
      if (!Number.isFinite(v) || v < 0) {
        allHealthValid = false;
        badHealthDetail = `${k}=${v} at t=${mt}`;
      }
      if (v >= 1) {
        allHealthBelowOne = false;
      }
    }
    if (!Number.isFinite(firstSkinOverOne) && monitor.health.skin > 1) {
      firstSkinOverOne = mt;
    }
    if (!Number.isFinite(firstSkinCritical)) {
      const skinFault = monitor.report().find((f) => f.id === 'skin-temp' && f.severity === 'critical');
      if (skinFault) firstSkinCritical = mt;
    }
    return autopilot.phase === 'done' || autopilot.phase === 'aborted';
  });

  const outcome = classifyOutcome(sim, autopilot);
  const faults = monitor.report();
  const peaks = monitor.peaks();
  const endMt = Number.isFinite(sim.liftoffTime) ? sim.t - sim.liftoffTime : sim.t;
  return {
    sim,
    autopilot,
    monitor,
    outcome,
    faults,
    peaks,
    elements: sim.elements(),
    endMt,
    allHealthValid,
    allHealthBelowOne,
    badHealthDetail,
    firstSkinOverOne,
    firstSkinCritical,
  };
}

function peakOf(peaks: { key: string; value: number; t: number }[], key: string) {
  const p = peaks.find((x) => x.key === key);
  assert.ok(p, `missing health peak for ${key}`);
  return p;
}

const plain = flyPlain();
const nominalDestructive = flyCase({ destructive: true });
const thinNose = flyCase({ spec: applyScenario(lvm3FaultSpec(), 'thin-nose'), destructive: false });
const vikasOut = flyCase({
  failures: [{ kind: 'engine-out', stage: 0, at: 200, engines: 1 }],
  destructive: true,
});
const l110Shutdown = flyCase({
  failures: [{ kind: 'stage-shutdown', stage: 0, at: 200 }],
  destructive: true,
});
const c25Shutdown = flyCase({
  failures: [{ kind: 'stage-shutdown', stage: 2, at: 600 }],
  destructive: true,
});
const fairingStuck = flyCase({
  failures: [{ kind: 'fairing-stuck' }],
  destructive: true,
});
const gimbalLockSafe = flyCase({
  failures: [{ kind: 'gimbal-lock', at: 40 }],
  destructive: false,
});
const gimbalLockDestructive = flyCase({
  failures: [{ kind: 'gimbal-lock', at: 40 }],
  destructive: true,
});
const blockedVentDestructive = flyCase({
  spec: applyScenario(lvm3FaultSpec(), 'blocked-vent'),
  destructive: true,
});
const regulatorLowDestructive = flyCase({
  spec: applyScenario(lvm3FaultSpec(), 'regulator-low'),
  destructive: true,
});
const hotGrainDestructive = flyCase({
  spec: applyScenario(lvm3FaultSpec(), 'hot-grain'),
  destructive: true,
});

const allCases = [
  { name: 'nominalDestructive', run: nominalDestructive },
  { name: 'thinNose', run: thinNose },
  { name: 'vikasOut', run: vikasOut },
  { name: 'l110Shutdown', run: l110Shutdown },
  { name: 'c25Shutdown', run: c25Shutdown },
  { name: 'fairingStuck', run: fairingStuck },
  { name: 'gimbalLockSafe', run: gimbalLockSafe },
  { name: 'gimbalLockDestructive', run: gimbalLockDestructive },
  { name: 'blockedVentDestructive', run: blockedVentDestructive },
  { name: 'regulatorLowDestructive', run: regulatorLowDestructive },
  { name: 'hotGrainDestructive', run: hotGrainDestructive },
];

describe('Continuous health and fault intervals', () => {
  test('nominal flight health values are finite, >= 0, and < 1', () => {
    assert.equal(nominalDestructive.allHealthValid, true, nominalDestructive.badHealthDetail);
    assert.equal(nominalDestructive.allHealthBelowOne, true, 'expected all nominal health values < 1');
    const worst = nominalDestructive.monitor.worst();
    assert.ok(Number.isFinite(worst.value) && worst.value >= 0 && worst.value < 1);
  });

  test('nominal health peaks match expected bands', () => {
    const pMaxQ = peakOf(nominalDestructive.peaks, 'maxQ');
    assert.ok(pMaxQ.value >= 0.69 && pMaxQ.value <= 0.82, `maxQ peak=${pMaxQ.value}`);
    assert.ok(pMaxQ.t >= 50 && pMaxQ.t <= 65, `maxQ t=${pMaxQ.t}`);

    const pAxialG = peakOf(nominalDestructive.peaks, 'axialG');
    assert.ok(pAxialG.value >= 0.62 && pAxialG.value <= 0.75, `axialG peak=${pAxialG.value}`);

    const pSkin = peakOf(nominalDestructive.peaks, 'skin');
    assert.ok(pSkin.value >= 0.55 && pSkin.value <= 0.87, `skin peak=${pSkin.value}`);

    const pFairingDp = peakOf(nominalDestructive.peaks, 'fairingDp');
    assert.ok(pFairingDp.value >= 0.14 && pFairingDp.value <= 0.32, `fairingDp peak=${pFairingDp.value}`);

    const pTankBurst = peakOf(nominalDestructive.peaks, 'tankBurst');
    assert.ok(pTankBurst.value >= 0.60 && pTankBurst.value <= 0.74, `tankBurst peak=${pTankBurst.value}`);

    const pCavitation = peakOf(nominalDestructive.peaks, 'cavitation');
    assert.ok(pCavitation.value >= 0.42 && pCavitation.value <= 0.62, `cavitation peak=${pCavitation.value}`);
  });

  test('thin-nose skin health exceeds 1 within 1 s of skin-temp becoming critical', () => {
    const pSkin = peakOf(thinNose.peaks, 'skin');
    assert.ok(pSkin.value > 1, `expected thin-nose skin peak > 1, got ${pSkin.value}`);
    assert.ok(Number.isFinite(thinNose.firstSkinOverOne), 'expected skin health > 1 sample');
    assert.ok(Number.isFinite(thinNose.firstSkinCritical), 'expected skin-temp critical fault');
    assert.ok(
      Math.abs(thinNose.firstSkinOverOne - thinNose.firstSkinCritical) <= 1.0,
      `firstSkinOverOne=${thinNose.firstSkinOverOne} firstSkinCritical=${thinNose.firstSkinCritical}`,
    );
  });

  test('every fault in every run satisfies tFirst <= t <= tLast', () => {
    for (const { name, run } of allCases) {
      for (const f of run.faults) {
        assert.ok(
          f.tFirst <= f.t && f.t <= f.tLast,
          `${name} ${f.id}: tFirst=${f.tFirst} t=${f.t} tLast=${f.tLast}`,
        );
      }
    }
  });
});

describe('Failure injection, destructive consequences, and outcome classification', () => {
  test('nominal destructive: true is bit-for-bit identical to plain run', () => {
    assert.equal(nominalDestructive.outcome.outcome, 'nominal');
    assert.equal(nominalDestructive.sim.log.length, plain.sim.log.length);
    assert.equal(nominalDestructive.elements.a, plain.elements.a);
    assert.equal(nominalDestructive.elements.e, plain.elements.e);
    assert.equal(nominalDestructive.elements.i, plain.elements.i);
    assert.equal(nominalDestructive.elements.rp, plain.elements.rp);
    assert.equal(nominalDestructive.elements.ra, plain.elements.ra);
  });

  test('vikas-out saves the mission with expected burnout and cutoff times', () => {
    assert.equal(vikasOut.outcome.outcome, 'nominal');
    const l110Burnout = vikasOut.sim.rt.stages[0].burnoutTime - vikasOut.sim.liftoffTime;
    assert.ok(l110Burnout >= 395 && l110Burnout <= 430, `L110 burnout=${l110Burnout}`);
    const c25Cutoff = vikasOut.autopilot.insertionTime - vikasOut.sim.liftoffTime;
    assert.ok(c25Cutoff >= 1040 && c25Cutoff <= 1085, `C25 cutoff=${c25Cutoff}`);
  });

  test('l110-shutdown ends suborbital with eastbound impact', () => {
    assert.equal(l110Shutdown.outcome.outcome, 'suborbital');
    assert.ok(
      l110Shutdown.outcome.apogeeAltitude >= 150e3 && l110Shutdown.outcome.apogeeAltitude <= 190e3,
      `apogee=${l110Shutdown.outcome.apogeeAltitude}`,
    );
    assert.ok(l110Shutdown.outcome.perigeeAltitude < 0, `perigee=${l110Shutdown.outcome.perigeeAltitude}`);
    assert.ok(l110Shutdown.outcome.impact !== null, 'expected impact point');
    assert.ok(l110Shutdown.outcome.impact.lonDeg > 85, `lonDeg=${l110Shutdown.outcome.impact.lonDeg}`);
  });

  test('c25-shutdown ends suborbital with expected apogee', () => {
    assert.equal(c25Shutdown.outcome.outcome, 'suborbital');
    assert.ok(
      c25Shutdown.outcome.apogeeAltitude >= 270e3 && c25Shutdown.outcome.apogeeAltitude <= 320e3,
      `apogee=${c25Shutdown.outcome.apogeeAltitude}`,
    );
  });

  test('fairing-stuck reaches degraded orbit with no fairing event', () => {
    assert.equal(fairingStuck.outcome.outcome, 'degraded-orbit');
    assert.ok(
      fairingStuck.outcome.perigeeAltitude >= 160e3 && fairingStuck.outcome.perigeeAltitude <= 180e3,
      `perigee=${fairingStuck.outcome.perigeeAltitude}`,
    );
    assert.ok(
      fairingStuck.outcome.apogeeAltitude >= 20000e3 && fairingStuck.outcome.apogeeAltitude <= 30000e3,
      `apogee=${fairingStuck.outcome.apogeeAltitude}`,
    );
    assert.equal(
      fairingStuck.sim.events.some((e) => e.type === 'fairing'),
      false,
      'expected no fairing event',
    );
  });

  test('gimbal-lock with destructive: false ends in ground impact between 120 and 180 s', () => {
    assert.equal(gimbalLockSafe.outcome.outcome, 'impact');
    assert.ok(
      gimbalLockSafe.endMt >= 120 && gimbalLockSafe.endMt <= 180,
      `endMt=${gimbalLockSafe.endMt}`,
    );
  });

  test('gimbal-lock with destructive: true ends in breakup before 120 s', () => {
    assert.equal(gimbalLockDestructive.outcome.outcome, 'breakup');
    assert.ok(gimbalLockDestructive.endMt < 120, `endMt=${gimbalLockDestructive.endMt}`);
  });

  test('blocked-vent with destructive: true breaks up between 20 and 90 s from fairing-dp', () => {
    assert.equal(blockedVentDestructive.outcome.outcome, 'breakup');
    assert.ok(
      blockedVentDestructive.endMt >= 20 && blockedVentDestructive.endMt <= 90,
      `endMt=${blockedVentDestructive.endMt}`,
    );
    const breakup = blockedVentDestructive.sim.events.find((e) => e.type === 'breakup');
    assert.ok(breakup, 'expected breakup event');
    assert.ok(
      blockedVentDestructive.faults.some((f) => f.id === 'fairing-dp' && f.severity === 'critical'),
      'expected critical fairing-dp fault',
    );
  });

  test('regulator-low with destructive: true breaks up before 108 s', () => {
    assert.equal(regulatorLowDestructive.outcome.outcome, 'breakup');
    assert.ok(regulatorLowDestructive.endMt < 108, `endMt=${regulatorLowDestructive.endMt}`);
  });

  test('hot-grain with destructive: true breaks up between 2 and 5 s', () => {
    assert.equal(hotGrainDestructive.outcome.outcome, 'breakup');
    assert.ok(
      hotGrainDestructive.endMt >= 2 && hotGrainDestructive.endMt <= 5,
      `endMt=${hotGrainDestructive.endMt}`,
    );
  });

  test('lh2-leak drains ~40 kg over 20 s by T+340 s', () => {
    const runTo340 = (failures?: Failure[]) => {
      const vehicle = lvm3();
      const autopilot = new AscentAutopilot({ ...BASE_ASCENT });
      const injector = failures ? new FailureInjector(failures) : undefined;
      const sim = new Simulation(
        vehicle,
        LAUNCH_CFG,
        supervised(autopilot, { injector }),
      );
      sim.run(1000, () => Number.isFinite(sim.liftoffTime) && sim.t - sim.liftoffTime >= 340);
      const offs = tankOffsets(vehicle);
      return sim.prop[offs[2] + 1];
    };
    const withoutLeak = runTo340();
    const withLeak = runTo340([{ kind: 'leak', stage: 2, tank: 1, at: 320, rate: 2 }]);
    const diff = withoutLeak - withLeak;
    assert.ok(Math.abs(diff - 40) <= 5, `expected ~40 kg diff, got ${diff.toFixed(2)} kg`);
  });

  test('every outcome has non-empty summary and round-trips through JSON', () => {
    for (const { name, run } of allCases) {
      assert.ok(run.outcome.summary.trim().length > 0, `${name} empty outcome summary`);
      const parsed = JSON.parse(JSON.stringify(run.outcome));
      assert.equal(parsed.outcome, run.outcome.outcome, `${name} JSON round-trip mismatch`);
    }
  });
});
