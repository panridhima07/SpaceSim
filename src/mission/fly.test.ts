import { beforeAll, describe, expect, it } from 'vitest';
import { lvm3 } from './engine';
import { flyMission } from './fly';
import type { FlightRecord, FlightSample } from './record';
import { getMission, type MissionDef } from './vehicles';

const mission = getMission('lvm3-m4')!;
let record: FlightRecord;
let thinNoseRecord: FlightRecord;

beforeAll(() => {
  record = flyMission(mission);
  thinNoseRecord = flyMission(mission, { scenario: 'thin-nose' });
}, 120_000);

function sampleNear(t: number): FlightSample {
  let best = record.samples[0];
  for (const s of record.samples) {
    if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  }
  return best;
}

function markerFor(text: string) {
  const marker = record.markers.find((m) => m.label.includes(text));
  expect(marker, `missing marker for ${text}`).toBeDefined();
  return marker!;
}

function expectFinite(value: number, what: string) {
  expect(Number.isFinite(value), `${what} is not finite: ${value}`).toBe(true);
}

describe('flyMission lvm3-m4', () => {
  it('reaches the target transfer orbit', () => {
    expect(record.reachedTarget).toBe(true);
    const orbit = record.orbit!;
    expect(Math.abs(orbit.periapsis - 170e3)).toBeLessThan(5e3);
    expect(Math.abs(orbit.apoapsis - 36500e3)).toBeLessThan(300e3);
    expect(orbit.inclinationDeg).toBeGreaterThan(10);
    expect(orbit.inclinationDeg).toBeLessThan(25);
  });

  it('records a dense, monotonic flight', () => {
    expect(record.samples.length).toBeGreaterThan(500);
    for (let i = 1; i < record.samples.length; i++) {
      expect(record.samples[i].t).toBeGreaterThan(record.samples[i - 1].t);
    }
    expect(record.samples[0].t).toBeGreaterThanOrEqual(0);
    expect(record.samples[0].t).toBeLessThanOrEqual(1);
  });

  it('keeps every sample finite', () => {
    for (const s of record.samples) {
      expectFinite(s.t, 't');
      for (const [i, x] of s.pos.entries()) expectFinite(x, `pos[${i}]`);
      for (const [i, x] of s.vel.entries()) expectFinite(x, `vel[${i}]`);
      for (const [i, x] of s.quat.entries()) expectFinite(x, `quat[${i}]`);
      for (const k of ['altitude', 'speed', 'mach', 'q', 'accelG', 'mass', 'thrust', 'stage'] as const) {
        expectFinite(s[k], k);
      }
      expect(s.stageThrottle).toBeDefined();
      for (const [i, x] of s.stageThrottle!.entries()) expectFinite(x, `stageThrottle[${i}]`);
    }
  });

  it('starts on the pad and ends above the atmosphere', () => {
    const first = record.samples[0];
    const radius = Math.hypot(...first.pos);
    expect(Math.abs(radius - 6371e3)).toBeLessThan(30e3);
    expect(first.altitude).toBeLessThan(100);
    expect(record.samples[record.samples.length - 1].altitude).toBeGreaterThan(150e3);
  });

  it('matches the six reference events', () => {
    const events: [string, number][] = [
      ['L110 core ignition', 108.0],
      ['S200 boosters separation', 126.7],
      ['Fairing jettison', 153.2],
      ['L110 core separation', 307.1],
      ['C25 cryogenic stage ignition', 309.5],
      ['C25 cryogenic stage cutoff', 935.7],
    ];
    for (const [text, simulated] of events) {
      const marker = markerFor(text);
      expect(Math.abs(marker.t - simulated), `${text} at T+${marker.t.toFixed(1)}`).toBeLessThanOrEqual(2);
      const reference = mission.reference.find((r) => r.pattern.test(text))!;
      expect(marker.reference).toBe(reference.t);
    }
  });

  it('records staging and fairing separation', () => {
    const stages = record.stageSeparation!;
    expect(stages).toHaveLength(3);
    expect(Math.abs(stages[0]! - 307.1)).toBeLessThanOrEqual(2);
    expect(Math.abs(stages[1]! - 126.7)).toBeLessThanOrEqual(2);
    expect(stages[2]).toBeNull();
    expect(Math.abs(record.fairingSeparation! - 153.2)).toBeLessThanOrEqual(2);
  });

  it('reports the thrusting stage at each point', () => {
    const at50 = sampleNear(50);
    expect(at50.stageThrottle![1]).toBeGreaterThan(0);
    expect(at50.stageThrottle![0]).toBe(0);

    const at200 = sampleNear(200);
    expect(at200.stageThrottle![0]).toBeGreaterThan(0);
    expect(at200.stageThrottle![1]).toBe(0);

    const at600 = sampleNear(600);
    expect(at600.stageThrottle![0]).toBe(0);
    expect(at600.stageThrottle![1]).toBe(0);
    expect(at600.stageThrottle![2]).toBeGreaterThan(0);
  });

  it('is plain data that survives JSON', () => {
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('reaches the same orbit with a coarser sample interval', () => {
    const coarse = flyMission(mission, { sampleInterval: 2 });
    const a = record.orbit!;
    const b = coarse.orbit!;
    expect(Math.abs(b.periapsis - a.periapsis)).toBeLessThan(1e3);
    expect(Math.abs(b.apoapsis - a.apoapsis)).toBeLessThan(50e3);
  }, 60_000);

  it('returns without throwing when the vehicle cannot lift off', () => {
    const tooHeavy: MissionDef = { ...mission, vehicle: () => lvm3(400000) };
    const aborted = flyMission(tooHeavy);
    expect(aborted.reachedTarget).toBe(false);
    expect(aborted.samples).toHaveLength(0);
  }, 60_000);

  it('records fault monitor telemetry and no warning or critical faults on nominal flight', () => {
    expect(record.reachedTarget).toBe(true);
    expect(record.faults).toBeDefined();
    const bad = record.faults!.filter((f) => f.severity === 'warning' || f.severity === 'critical');
    expect(bad).toEqual([]);
    for (const s of record.samples) {
      expectFinite(s.skinTemp!, 'skinTemp');
      expectFinite(s.fairingDeltaP!, 'fairingDeltaP');
      expectFinite(s.heatFlux!, 'heatFlux');
      expectFinite(s.ambientPressure!, 'ambientPressure');
    }
  });

  it('flags critical skin-temp fault and flaw marker on thin-nose scenario', () => {
    expect(thinNoseRecord.scenario).toBe('thin-nose');
    expect(thinNoseRecord.faults).toBeDefined();
    const skinFault = thinNoseRecord.faults!.find((f) => f.id === 'skin-temp');
    expect(skinFault).toBeDefined();
    expect(skinFault!.severity).toBe('critical');
    const flawMarker = thinNoseRecord.markers.find((m) => m.kind === 'flaw' && m.severity === 'critical');
    expect(flawMarker).toBeDefined();
    expect(JSON.parse(JSON.stringify(thinNoseRecord))).toEqual(thinNoseRecord);

    const skinPeak = thinNoseRecord.healthPeaks!.find((p) => p.key === 'skin')!;
    expect(skinPeak.value).toBeGreaterThan(1);
    const firstOver = thinNoseRecord.samples.find((s) => (s.health?.skin ?? 0) > 1);
    const firstCritTemp = thinNoseRecord.samples.find((s) => (s.skinTemp ?? 0) > 450);
    expect(firstOver).toBeDefined();
    expect(firstCritTemp).toBeDefined();
    expect(Math.abs(firstOver!.t - firstCritTemp!.t)).toBeLessThanOrEqual(1);
  });

  it('records continuous health in [0, 1) and expected peaks on nominal flight', () => {
    for (const s of record.samples) {
      expect(s.health).toBeDefined();
      for (const [k, v] of Object.entries(s.health!)) {
        expectFinite(v, `health.${k}`);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }

    const peak = (key: string) => {
      const p = record.healthPeaks!.find((h) => h.key === key);
      expect(p, `missing healthPeak ${key}`).toBeDefined();
      return p!;
    };

    const maxQ = peak('maxQ');
    expect(maxQ.value).toBeGreaterThanOrEqual(0.69);
    expect(maxQ.value).toBeLessThanOrEqual(0.82);
    expect(maxQ.t).toBeGreaterThanOrEqual(50);
    expect(maxQ.t).toBeLessThanOrEqual(65);

    expect(peak('axialG').value).toBeGreaterThanOrEqual(0.62);
    expect(peak('axialG').value).toBeLessThanOrEqual(0.75);

    expect(peak('skin').value).toBeGreaterThanOrEqual(0.55);
    expect(peak('skin').value).toBeLessThanOrEqual(0.87);

    expect(peak('fairingDp').value).toBeGreaterThanOrEqual(0.14);
    expect(peak('fairingDp').value).toBeLessThanOrEqual(0.32);

    expect(peak('tankBurst').value).toBeGreaterThanOrEqual(0.60);
    expect(peak('tankBurst').value).toBeLessThanOrEqual(0.74);

    expect(peak('cavitation').value).toBeGreaterThanOrEqual(0.42);
    expect(peak('cavitation').value).toBeLessThanOrEqual(0.62);

    for (const rec of [record, thinNoseRecord]) {
      for (const f of rec.faults ?? []) {
        expect(f.tFirst).toBeDefined();
        expect(f.tLast).toBeDefined();
        expect(f.tFirst!).toBeLessThanOrEqual(f.t);
        expect(f.t).toBeLessThanOrEqual(f.tLast!);
      }
    }
  });

  it('classifies nominal outcome and exposes all six failure cases', () => {
    expect(record.outcome).toBeDefined();
    expect(record.outcome!.outcome).toBe('nominal');
    expect(record.outcome!.summary.length).toBeGreaterThan(0);

    const ids = (mission.failureCases ?? []).map((c) => c.id);
    expect(ids).toEqual([
      'vikas-out',
      'l110-shutdown',
      'c25-shutdown',
      'fairing-stuck',
      'gimbal-lock',
      'lh2-leak',
    ]);
  });

  it('handles failureCase gimbal-lock with destructive breakup', () => {
    const failed = flyMission(mission, { failureCase: 'gimbal-lock', destructive: true });
    expect(failed.failureCase).toBe('gimbal-lock');
    expect(failed.outcome).toBeDefined();
    expect(failed.outcome!.outcome).toBe('breakup');
    expect(failed.outcome!.summary.length).toBeGreaterThan(0);
    expect(failed.samples[failed.samples.length - 1].t).toBeLessThan(120);
    expect(JSON.parse(JSON.stringify(failed))).toEqual(failed);
  }, 60_000);
});

describe('payload separation', () => {
  it('releases the payload after cutoff and lets it drift at the spring speed', () => {
    const def = getMission('lvm3-m4')!;
    const pay = def.payload!;
    const record = flyMission(def);
    expect(record.reachedTarget).toBe(true);
    const tSep = record.payloadSeparation!;
    expect(tSep).toBeGreaterThan(0);
    // Separation comes `deployAfter` seconds after the last engine stops.
    const lastBurn = record.samples.filter((s) => s.thrust > 0).pop()!;
    expect(Math.abs(tSep - lastBurn.t - pay.deployAfter)).toBeLessThan(2);
    const before = record.samples.filter((s) => s.t <= tSep);
    expect(before.every((s) => s.payloadOffset === undefined)).toBe(true);
    // Two free bodies in nearly the same orbit separate at the relative speed the springs gave them.
    const last = record.samples[record.samples.length - 1];
    const gap = Math.hypot(...last.payloadOffset!);
    expect(gap / (last.t - tSep)).toBeGreaterThan(pay.springSpeed * 0.9);
    expect(gap / (last.t - tSep)).toBeLessThan(pay.springSpeed * 1.1);
    // The stage is lighter by the payload afterwards.
    expect(Math.abs(before[before.length - 1].mass - last.mass - def.vehicle().payload.mass)).toBeLessThan(1);
    expect(record.markers.some((m) => /Chandrayaan-3 separation/.test(m.label) && m.reference === pay.realDeployT)).toBe(true);
  }, 60000);

  it('keeps the payload on a vehicle that never reaches orbit', () => {
    const record = flyMission(getMission('lvm3-m4')!, { failureCase: 'c25-shutdown' });
    expect(record.payloadSeparation ?? null).toBeNull();
    expect(record.samples.every((s) => s.payloadOffset === undefined)).toBe(true);
  }, 60000);
});
