import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AscentAutopilot,
  FaultMonitor,
  SITES,
  Simulation,
  applyScenario,
  lvm3,
  lvm3FaultSpec,
  monitored,
  type AscentOptions,
  type Fault,
  type FaultSpec,
} from '../src/index.ts';

function fly(spec: FaultSpec, ascent: Partial<AscentOptions> = {}) {
  const vehicle = lvm3();
  const autopilot = new AscentAutopilot({
    target: { perigeeAltitude: 170e3, apogeeAltitude: 36500e3 },
    pitchKickDeg: 8,
    ...ascent,
  });
  const monitor = new FaultMonitor(vehicle, spec);
  const sim = new Simulation(
    vehicle,
    { site: SITES.sriharikota, epoch: new Date('2023-07-14T09:05:17Z') },
    monitored(autopilot, monitor),
  );
  let peakSkin = 0;
  let peakDp = 0;
  let peakRate = 0;
  sim.run(3000, () => {
    peakSkin = Math.max(peakSkin, monitor.channels.skinTemp);
    peakDp = Math.max(peakDp, monitor.channels.fairingDeltaP);
    peakRate = Math.max(peakRate, monitor.channels.depressRate);
    return autopilot.phase === 'done' || autopilot.phase === 'aborted';
  });
  return { sim, autopilot, faults: monitor.report(), peakSkin, peakDp, peakRate };
}

function findFault(faults: Fault[], id: string): Fault | undefined {
  return faults.find((f) => f.id === id);
}

function isAtLeastWarning(f: Fault | undefined): boolean {
  return f !== undefined && (f.severity === 'warning' || f.severity === 'critical');
}

const nominal = fly(lvm3FaultSpec());
const blockedVent = fly(applyScenario(lvm3FaultSpec(), 'blocked-vent'));
const regulatorLow = fly(applyScenario(lvm3FaultSpec(), 'regulator-low'));
const regulatorHigh = fly(applyScenario(lvm3FaultSpec(), 'regulator-high'));
const hotGrain = fly(applyScenario(lvm3FaultSpec(), 'hot-grain'));
const thinNose = fly(applyScenario(lvm3FaultSpec(), 'thin-nose'));
const longHold = fly(applyScenario(lvm3FaultSpec(), 'long-hold'));
const earlyFairing = fly(lvm3FaultSpec(), { fairingHeatFlux: 20000 });

const allRuns = [
  { name: 'nominal', run: nominal },
  { name: 'blocked-vent', run: blockedVent },
  { name: 'regulator-low', run: regulatorLow },
  { name: 'regulator-high', run: regulatorHigh },
  { name: 'hot-grain', run: hotGrain },
  { name: 'thin-nose', run: thinNose },
  { name: 'long-hold', run: longHold },
  { name: 'early-fairing', run: earlyFairing },
];

describe('FaultMonitor on nominal LVM3-M4 flight', () => {
  test('reaches target orbit without disturbing the flight', () => {
    assert.equal(nominal.autopilot.reachedTarget, true);
  });

  test('triggers no warning or critical faults', () => {
    const offending = nominal.faults.filter((f) => f.severity === 'warning' || f.severity === 'critical');
    assert.equal(
      offending.length,
      0,
      `Unexpected warning/critical faults: ${JSON.stringify(offending)}`,
    );
  });

  test('telemetry peaks and max-Q stay within expected bands', () => {
    assert.ok(
      nominal.peakSkin >= 385 && nominal.peakSkin <= 430,
      `peakSkin=${nominal.peakSkin} expected 385..430 K`,
    );
    assert.ok(
      nominal.peakDp >= 1000 && nominal.peakDp <= 2200,
      `peakDp=${nominal.peakDp} expected 1000..2200 Pa`,
    );
    assert.ok(
      nominal.peakRate >= 1400 && nominal.peakRate <= 2600,
      `peakRate=${nominal.peakRate} expected 1400..2600 Pa/s`,
    );
    assert.ok(
      nominal.sim.maxQ.value >= 38000 && nominal.sim.maxQ.value <= 45000,
      `maxQ=${nominal.sim.maxQ.value} expected 38000..45000 Pa`,
    );
  });

  test('records info-level LH2 boil-off', () => {
    const boil = findFault(nominal.faults, 'boil-off:2:1');
    assert.ok(boil, 'expected boil-off:2:1 fault');
    assert.equal(boil.severity, 'info');
  });
});

describe('FaultMonitor on fault scenarios', () => {
  test('blocked-vent raises critical fairing-dp', () => {
    const f = findFault(blockedVent.faults, 'fairing-dp');
    assert.ok(f, 'expected fairing-dp');
    assert.equal(f.severity, 'critical');
  });

  test('regulator-low raises cavitation and core tank buckling', () => {
    const cav01 = findFault(regulatorLow.faults, 'cavitation:0:1');
    assert.ok(cav01, 'expected cavitation:0:1');
    assert.equal(cav01.severity, 'critical');

    const cav21 = findFault(regulatorLow.faults, 'cavitation:2:1');
    assert.ok(cav21, 'expected cavitation:2:1');
    assert.equal(cav21.severity, 'critical');

    const buckle00 = findFault(regulatorLow.faults, 'tank-buckling:0:0');
    assert.ok(isAtLeastWarning(buckle00), `expected tank-buckling:0:0 >= warning, got ${buckle00?.severity}`);
  });

  test('regulator-high raises tank-burst:0:1 at least warning', () => {
    const burst = findFault(regulatorHigh.faults, 'tank-burst:0:1');
    assert.ok(isAtLeastWarning(burst), `expected tank-burst:0:1 >= warning, got ${burst?.severity}`);
  });

  test('hot-grain raises critical chamber-overpressure:1', () => {
    const f = findFault(hotGrain.faults, 'chamber-overpressure:1');
    assert.ok(f, 'expected chamber-overpressure:1');
    assert.equal(f.severity, 'critical');
  });

  test('thin-nose raises critical skin-temp', () => {
    const f = findFault(thinNose.faults, 'skin-temp');
    assert.ok(f, 'expected skin-temp');
    assert.equal(f.severity, 'critical');
  });

  test('long-hold raises warning boil-off:2:1', () => {
    const f = findFault(longHold.faults, 'boil-off:2:1');
    assert.ok(f, 'expected boil-off:2:1');
    assert.equal(f.severity, 'warning');
  });

  test('early fairing jettison raises payload-heating at least warning', () => {
    const f = findFault(earlyFairing.faults, 'payload-heating');
    assert.ok(isAtLeastWarning(f), `expected payload-heating >= warning, got ${f?.severity}`);
  });
});

describe('Fault report structure', () => {
  test('every fault in every report has non-empty detail/fix and finite value/limit', () => {
    for (const { name, run } of allRuns) {
      for (const f of run.faults) {
        assert.ok(typeof f.detail === 'string' && f.detail.trim().length > 0, `${name} ${f.id} empty detail`);
        assert.ok(typeof f.fix === 'string' && f.fix.trim().length > 0, `${name} ${f.id} empty fix`);
        assert.ok(Number.isFinite(f.value), `${name} ${f.id} non-finite value: ${f.value}`);
        assert.ok(Number.isFinite(f.limit), `${name} ${f.id} non-finite limit: ${f.limit}`);
      }
    }
  });
});
