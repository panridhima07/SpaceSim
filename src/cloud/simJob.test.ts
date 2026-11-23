import { beforeAll, describe, expect, it } from 'vitest';
import { fromRocketModel } from '../builder/design';
import { parseOrkXml } from '../ork/parser';
import { SAMPLE_ORK_XML } from '../ork/sample';
import { findMotor, thrustAt } from '../ork/motors';
import { atmosphere } from '../physics/atmosphere';
import { aeroProps } from '../physics/aero';
import { cachedDeps } from '../physics/cache';
import { massProps } from '../physics/massprops';
import { STRESS_FLIGHT_COUNT, stressTest } from '../physics/sweep';
import {
  MAX_CURVE_POINTS,
  SimBudgetError,
  SimJobError,
  motorSpec,
  parseResultJson,
  parseSimJob,
  runSimJob,
  runSimJobAsync,
  stringifyResult,
  type SimJobRequest,
} from './simJob';

const model = parseOrkXml(SAMPLE_ORK_XML);
const design = JSON.parse(JSON.stringify(fromRocketModel(model))) as unknown;
const motor = findMotor({ designation: 'C6' })!;

function request(over: Partial<SimJobRequest> = {}): SimJobRequest {
  return {
    kind: 'stress',
    design,
    motors: motorSpec(motor),
    config: { windSpeed: 3, railLength: 1.2, railAngle: 0.05, gust: 0.1 },
    ...over,
  };
}

function inlineMotor(points: number): Record<string, unknown> {
  const curve = Array.from({ length: points }, (_, i) => [(i / (points - 1)) * 2, i === points - 1 ? 0 : 10]);
  return { manufacturer: 'X', designation: 'Z1', diameter: 0.018, length: 0.07, totalMass: 0.03, propellantMass: 0.01, curve };
}

describe('parseSimJob', () => {
  it('accepts a real design and resolves the motor by reference', () => {
    const job = parseSimJob(request());
    expect(job.motor.designation).toBe(motor.designation);
    expect(job.rocket.components.length).toBeGreaterThan(0);
    expect(job.config.windSpeed).toBe(3);
  });

  it('falls back to the design motor mount when no motor is sent', () => {
    const job = parseSimJob(request({ motors: undefined }));
    expect(job.motor.curve.length).toBeGreaterThan(1);
  });

  it('rejects hostile or malformed requests', () => {
    expect(() => parseSimJob(null)).toThrow(SimJobError);
    expect(() => parseSimJob(request({ design: undefined }))).toThrow(SimJobError);
    expect(() => parseSimJob(request({ design: { stack: 'x' } }))).toThrow(SimJobError);
    expect(() => parseSimJob({ ...request(), kind: 'flight' })).toThrow(SimJobError);
    expect(() => parseSimJob(request({ config: { windSpeed: NaN } }))).toThrow(SimJobError);
    expect(() => parseSimJob(request({ config: { railLength: 'a' } }))).toThrow(SimJobError);
    expect(() => parseSimJob(request({ motors: { motor: { designation: 'NOPE999' } } }))).toThrow(SimJobError);
  });

  it('rejects prototype-pollution keys', () => {
    const evil = JSON.parse('{"kind":"stress","design":{"stack":[],"__proto__":{"x":1}},"config":{}}');
    expect(() => parseSimJob(evil)).toThrow(/forbidden key/);
    const evilConfig = JSON.parse('{"windSpeed":1,"constructor":{"prototype":{"x":1}}}');
    expect(() => parseSimJob(request({ config: evilConfig }))).toThrow(SimJobError);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('rejects a 10 000-point motor curve and bad inline motors', () => {
    expect(() => parseSimJob(request({ motors: { motor: inlineMotor(10_000) } }))).toThrow(/too many points/);
    const ok = parseSimJob(request({ motors: { motor: inlineMotor(MAX_CURVE_POINTS) } }));
    expect(ok.motor.curve).toHaveLength(MAX_CURVE_POINTS);
    const bad = inlineMotor(10);
    (bad.curve as number[][])[3][1] = Infinity;
    expect(() => parseSimJob(request({ motors: { motor: bad } }))).toThrow(SimJobError);
    const slow = inlineMotor(10);
    (slow.curve as number[][])[9][0] = 601;
    expect(() => parseSimJob(request({ motors: { motor: slow } }))).toThrow(SimJobError);
    const heavy = { ...inlineMotor(10), totalMass: 1e9 };
    expect(parseSimJob(request({ motors: { motor: heavy } })).motor.totalMass).toBe(1000);
  });

  it('clamps out-of-range config values', () => {
    const job = parseSimJob(request({ config: { windSpeed: 1e6, gust: 5, railLength: -3, groundPressure: 1 } }));
    expect(job.config.windSpeed).toBe(50);
    expect(job.config.gust).toBe(1);
    expect(job.config.railLength).toBe(0.1);
    expect(job.config.groundPressure).toBe(30_000);
  });
});

describe('runSimJob', () => {
  let direct: ReturnType<typeof stressTest>;
  let viaJob: ReturnType<typeof runSimJob>;

  beforeAll(() => {
    const job = parseSimJob(request());
    viaJob = runSimJob(job);
    direct = stressTest(
      job.rocket,
      job.motor,
      job.config,
      cachedDeps({ atmosphere, massProps, aeroProps, thrust: thrustAt }),
    );
  }, 120_000);

  it('gives the same result as calling the sweep directly', () => {
    expect(viaJob.result).toEqual(direct);
    expect(viaJob.flights).toBe(STRESS_FLIGHT_COUNT);
    expect(viaJob.kind).toBe('stress');
    expect(viaJob.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('survives a JSON round trip including NaN fields', () => {
    const back = parseResultJson(stringifyResult(viaJob)) as typeof viaJob;
    expect(back.result).toEqual(direct);
  });

  it('async run matches the sync run', async () => {
    const r = await runSimJobAsync(parseSimJob(request()), { budgetMs: Infinity, sliceMs: 300 });
    expect(r.result).toEqual(direct);
  }, 120_000);
});

describe('time budget', () => {
  it('throws SimBudgetError when the injected clock passes the budget', () => {
    let t = 0;
    const now = (): number => (t += 10_000);
    expect(() => runSimJob(parseSimJob(request()), { budgetMs: 25_000, now })).toThrow(SimBudgetError);
  });
});
