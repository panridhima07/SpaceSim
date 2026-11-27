// The 'flight' and 'mission' job kinds: validation, parity with a local run, and response size.
import { beforeAll, describe, expect, it } from 'vitest';
import { atmosphere } from '../physics/atmosphere';
import { aeroProps } from '../physics/aero';
import { cachedDeps } from '../physics/cache';
import { analyzeFlight } from '../physics/flaws';
import { massProps } from '../physics/massprops';
import { createSim } from '../physics/sim';
import { parseOrkXml } from '../ork/parser';
import { SAMPLE_ORK_XML } from '../ork/sample';
import { RH200_ORK_XML, RH200_STAGE_MOTORS } from '../ork/rh200';
import { findMotor, thrustAt } from '../ork/motors';
import { MOCK_CASES } from '../validate/mockOrk';
import { flyMission } from '../mission/fly';
import { getMission } from '../mission/vehicles';
import type { Motor, Parachute, RocketModel, Sim, SimConfig } from '../types';
import {
  FLIGHT_STEP_S,
  LOG_COLUMNS,
  MAX_FLIGHT_SIM_S,
  MAX_LOG_ROWS,
  MAX_RECORD_BYTES,
  MAX_STAGE_MOTORS,
  SimBudgetError,
  SimJobError,
  flightRequest,
  isFlightJobResult,
  isMissionJobResult,
  motorSpec,
  parseAnyJob,
  parseFlightJob,
  parseMissionJob,
  parseResultJson,
  runFlightJob,
  runMissionJob,
  stringifyResult,
  thinRecord,
  unpackLog,
  type FlightJobResult,
} from './simJob';
import { flightMismatch } from './runPhysics';

const sample = parseOrkXml(SAMPLE_ORK_XML);
const c6 = findMotor({ designation: 'C6' })!;
const config: SimConfig = {
  railLength: 1.2, railAngle: 0.05, railAzimuth: 1, windSpeed: 3, windDirection: 4.7, gust: 0.15, launchAltitude: 100,
};

const boosters = parseOrkXml(MOCK_CASES.find((c) => c.name === 'boosters-with-fins-and-gap')!.xml);
const sampleChute = sample.components.find((c): c is Parachute => c.kind === 'parachute')!;

interface Case {
  name: string;
  rocket: RocketModel;
  motor: Motor;
  config: SimConfig;
}

/** The server recomputes total impulse from the curve; RH200's hand-written figures differ from it. */
const stageMotors = RH200_STAGE_MOTORS.map((s) => ({
  ...s,
  motor: {
    ...s.motor,
    totalImpulse: s.motor.curve.reduce((sum, [t, f], i, c) => (i ? sum + 0.5 * (f + c[i - 1][1]) * (t - c[i - 1][0]) : 0), 0),
  },
}));

const cases: Case[] = [
  { name: 'sample rocket', rocket: sample, motor: c6, config },
  {
    name: 'two-stage rocket',
    rocket: parseOrkXml(RH200_ORK_XML),
    motor: stageMotors[0].motor,
    config: { ...config, railLength: 5, stageMotors },
  },
  {
    name: 'rocket with side boosters',
    rocket: { ...boosters, components: [...boosters.components, { ...sampleChute, x: 0.1, deployEvent: 'apogee' }] },
    motor: findMotor({ designation: 'D12' })!,
    config,
  },
];

function flyLocally(c: Case): Sim {
  const sim = createSim(c.rocket, c.motor, c.config, cachedDeps({ atmosphere, massProps, aeroProps, thrust: thrustAt }));
  sim.ignite();
  while (!sim.done && sim.state.t < MAX_FLIGHT_SIM_S) sim.step(FLIGHT_STEP_S);
  return sim;
}

/** What the browser receives: request and response both through JSON. */
function flyOnServer(c: Case): { result: FlightJobResult; bytes: number } {
  const request = JSON.parse(JSON.stringify(flightRequest(c.rocket, c.motor, c.config))) as unknown;
  const text = stringifyResult(runFlightJob(parseFlightJob(request), { budgetMs: Infinity }));
  return { result: parseResultJson(text) as FlightJobResult, bytes: text.length };
}

const apogeeOf = (log: { altitude: number }[]): number => log.reduce((m, s) => Math.max(m, s.altitude), 0);

describe.each(cases)('flight job parity: $name', (c) => {
  let local: Sim;
  let server: FlightJobResult;
  let bytes = 0;

  beforeAll(() => {
    local = flyLocally(c);
    ({ result: server, bytes } = flyOnServer(c));
  }, 120_000);

  it('survives the design round trip', () => {
    expect(flightMismatch(flightRequest(c.rocket, c.motor, c.config), c.rocket, c.motor, c.config)).toBeNull();
  });

  it('has the same events at the same times', () => {
    if (c.config.stageMotors) expect(local.events.map((e) => e.type)).toContain('stage separation');
    expect(server.complete).toBe(true);
    expect(local.done).toBe(true);
    expect(server.events.map((e) => e.type)).toEqual(local.events.map((e) => e.type));
    server.events.forEach((e, i) => {
      expect(e.t).toBeCloseTo(local.events[i].t, 6);
      expect(e.altitude).toBeCloseTo(local.events[i].altitude, 4);
      expect(e.speed).toBeCloseTo(local.events[i].speed, 4);
    });
  });

  it('has the same apogee and rail exit speed', () => {
    const log = unpackLog(server.log);
    expect(apogeeOf(log)).toBeCloseTo(apogeeOf(local.log), 2);
    const exit = (events: Sim['events']) => events.find((e) => e.type === 'railExit')!.speed;
    expect(exit(server.events)).toBeCloseTo(exit(local.events), 6);
  });

  it('gives the same flight review from the thinned log', () => {
    const mine = analyzeFlight(local, c.rocket, c.motor, c.config);
    const theirs = analyzeFlight({ log: unpackLog(server.log), events: server.events }, c.rocket, c.motor, c.config);
    expect(theirs.map((f) => [f.id, f.severity])).toEqual(mine.map((f) => [f.id, f.severity]));
    theirs.forEach((f, i) => {
      const want = mine[i].value;
      if (want !== undefined) expect(Math.abs(f.value! - want)).toBeLessThanOrEqual(0.01 * Math.abs(want) + 1e-3);
    });
  });

  it('keeps full resolution through the powered climb and thins the rest', () => {
    const log = unpackLog(server.log);
    expect(isFlightJobResult(server)).toBe(true);
    expect(log.length).toBeLessThan(local.log.length);
    expect(log.length).toBeLessThanOrEqual(MAX_LOG_ROWS);
    expect(bytes).toBeLessThan(3_000_000);
    const powered = (s: { phase: string }) => s.phase === 'rail' || s.phase === 'boost';
    expect(log.filter(powered).length).toBe(local.log.filter(powered).length);
    for (let i = 1; i < log.length; i++) {
      expect(log[i].t).toBeGreaterThanOrEqual(log[i - 1].t);
      expect(log[i].t - log[i - 1].t).toBeLessThanOrEqual(0.125);
    }
  });
});

describe('flight job limits', () => {
  const slowDescent: RocketModel = {
    ...sample,
    components: sample.components.map((c) => (c.kind === 'parachute' ? { ...c, diameter: 3, deployEvent: 'apogee' } : c)),
  };

  it('stops at the simulated-time cap, marks the flight incomplete and stays small', () => {
    // A huge canopy on a high-impulse motor takes far longer than the cap to come down.
    const motor = findMotor({ designation: 'J350' })!;
    const { result, bytes } = flyOnServer({ name: 'long', rocket: slowDescent, motor, config });
    const log = unpackLog(result.log);
    expect(result.complete).toBe(false);
    expect(log[log.length - 1].t).toBeGreaterThanOrEqual(MAX_FLIGHT_SIM_S - 1);
    expect(log.length).toBeLessThanOrEqual(MAX_LOG_ROWS);
    expect(bytes).toBeLessThan(3_000_000);
  }, 120_000);

  it('ends at burnout for a rocket that never leaves the pad', () => {
    const weak: Motor = { ...c6, designation: 'Z1', curve: [[0, 0], [0.1, 0.01], [1, 0]], burnTime: 1, totalImpulse: 0.0055 };
    const { result } = flyOnServer({ name: 'stuck', rocket: sample, motor: weak, config });
    expect(result.complete).toBe(true);
    expect(result.events.map((e) => e.type)).toEqual(['ignition', 'burnout']);
    expect(unpackLog(result.log).at(-1)!.t).toBeLessThan(2);
  });

  it('respects the wall-clock budget', () => {
    let t = 0;
    const now = (): number => (t += 10_000);
    const job = parseFlightJob(flightRequest(sample, c6, config));
    expect(() => runFlightJob(job, { budgetMs: 25_000, now })).toThrow(SimBudgetError);
  });

  it('writes one finite number per column', () => {
    const { result } = flyOnServer(cases[0]);
    expect(result.log.rows.every((r) => r.length === LOG_COLUMNS.length && r.every(Number.isFinite))).toBe(true);
    expect(isFlightJobResult({ ...result, log: { rows: [[1, 2]] } })).toBe(false);
    expect(isFlightJobResult({ ...result, events: [null] })).toBe(false);
  });
});

describe('parseFlightJob', () => {
  const good = JSON.parse(JSON.stringify(flightRequest(sample, c6, config))) as Record<string, unknown>;
  const withStages = (stages: unknown): unknown => ({ ...good, motors: { ...motorSpec(c6), stages } });

  it('accepts stage motors, by reference or inline, and clamps the ignition delay', () => {
    const inline = motorSpec(RH200_STAGE_MOTORS[0].motor).motor;
    const job = parseFlightJob(withStages([{ motor: inline }, { motor: { designation: 'C6' }, ignitionDelay: 1e9 }]));
    expect(job.config.stageMotors).toHaveLength(2);
    expect(job.config.stageMotors![0].motor.curve).toEqual(RH200_STAGE_MOTORS[0].motor.curve);
    expect(job.config.stageMotors![1].ignitionDelay).toBe(120);
  });

  it('ignores stage motors put in the config', () => {
    const job = parseFlightJob({ ...good, config: { stageMotors: [{ motor: null }] } });
    expect(job.config.stageMotors).toBeUndefined();
  });

  it('rejects hostile stage motors', () => {
    const c6Ref = { motor: { designation: 'C6' } };
    expect(() => parseFlightJob(withStages('x'))).toThrow(SimJobError);
    expect(() => parseFlightJob(withStages([null]))).toThrow(SimJobError);
    expect(() => parseFlightJob(withStages([{}]))).toThrow(SimJobError);
    expect(() => parseFlightJob(withStages([{ motor: { designation: 'NOPE999' } }]))).toThrow(SimJobError);
    expect(() => parseFlightJob(withStages([{ ...c6Ref, ignitionDelay: 'soon' }]))).toThrow(SimJobError);
    expect(() => parseFlightJob(withStages(Array(MAX_STAGE_MOTORS + 1).fill(c6Ref)))).toThrow(/too many/);
    const longCurve = Array.from({ length: 5000 }, (_, i) => [i / 5000, 1]);
    expect(() => parseFlightJob(withStages([{ motor: { designation: 'Z', totalMass: 1, curve: longCurve } }]))).toThrow(
      /too many points/,
    );
    const polluted = JSON.parse('[{"motor":{"designation":"C6"},"__proto__":{"x":1}}]') as unknown;
    expect(() => parseFlightJob(withStages(polluted))).toThrow(/forbidden key/);
  });

  it('applies the shared design and config checks', () => {
    expect(() => parseFlightJob({ ...good, design: undefined })).toThrow(SimJobError);
    expect(() => parseFlightJob({ ...good, config: { windSpeed: 'a' } })).toThrow(SimJobError);
    expect(() => parseFlightJob({ ...good, kind: 'stress' })).toThrow(SimJobError);
    expect(parseAnyJob(good).kind).toBe('flight');
    expect(() => parseAnyJob({ ...good, kind: 'orbit' })).toThrow(SimJobError);
    expect(() => parseAnyJob(null)).toThrow(SimJobError);
  });
});

describe('motorSpec', () => {
  it('sends a motor inline when only its masses differ from the database', () => {
    const heavier = { ...c6, totalMass: c6.totalMass + 0.001 };
    expect(motorSpec(c6).motor.curve).toBeUndefined();
    expect(motorSpec(heavier).motor.curve).toBeDefined();
  });
});

describe('mission job', () => {
  const request = { kind: 'mission', mission: 'lvm3-m4', options: { failureCase: 'vikas-out', destructive: true } };

  it('validates the mission and its options', () => {
    expect(parseMissionJob(request).options).toEqual({ failureCase: 'vikas-out', destructive: true });
    expect(parseMissionJob({ kind: 'mission', mission: 'pslv-c61' }).options).toEqual({});
    expect(parseMissionJob({ kind: 'mission', mission: 'lvm3-m4', options: { scenario: 'hot-grain' } }).options).toEqual({
      scenario: 'hot-grain',
    });
    for (const bad of [
      { ...request, mission: 'constructor' },
      { ...request, mission: 7 },
      { ...request, options: [] },
      { ...request, options: { scenario: 'meteor' } },
      { ...request, options: { failureCase: 'merlin-out-stage1' } }, // another mission's case
      { ...request, options: { destructive: 'yes' } },
      { ...request, options: { sampleInterval: 1e-9 } },
      { ...request, options: { failures: [] } },
    ]) {
      expect(() => parseMissionJob(bad)).toThrow(SimJobError);
    }
  });

  // vikas-out gives the largest record of any mission case (about 2.8 MB).
  it('returns the same record as flyMission, within the size limit', () => {
    const text = stringifyResult(runMissionJob(parseMissionJob(request)));
    expect(text.length).toBeLessThan(MAX_RECORD_BYTES);
    const back = parseResultJson(text);
    expect(isMissionJobResult(back)).toBe(true);
    const direct = flyMission(getMission('lvm3-m4')!, { failureCase: 'vikas-out', destructive: true });
    expect((back as { record: unknown }).record).toEqual(direct);
  }, 120_000);

  it('thins an oversize record, keeping the ends and the samples at markers', () => {
    const record = flyMission(getMission('falcon9-starlink')!, {});
    expect(thinRecord(record)).toBe(record);
    const full = stringifyResult(record).length;
    const small = thinRecord(record, full / 3);
    expect(stringifyResult(small).length).toBeLessThanOrEqual(full / 3);
    expect(small.samples[0]).toBe(record.samples[0]);
    expect(small.samples.at(-1)).toBe(record.samples.at(-1));
    for (const m of record.markers) {
      const next = record.samples.find((s) => s.t >= m.t);
      if (next) expect(small.samples).toContain(next);
    }
    expect(small.markers).toBe(record.markers);
  }, 120_000);
});
