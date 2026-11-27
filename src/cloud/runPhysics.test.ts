import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { fromRocketModel } from '../builder/design';
import { parseOrkXml } from '../ork/parser';
import { SAMPLE_ORK_XML } from '../ork/sample';
import { findMotor, thrustAt } from '../ork/motors';
import { MOCK_CASES } from '../validate/mockOrk';
import { RH200_ORK_XML, RH200_STAGE_MOTORS } from '../ork/rh200';
import { flyMission } from '../mission/fly';
import { atmosphere } from '../physics/atmosphere';
import { aeroProps } from '../physics/aero';
import { cachedDeps } from '../physics/cache';
import { massProps } from '../physics/massprops';
import { stressTest } from '../physics/sweep';
import { getMission } from '../mission/vehicles';
import type { RocketModel, Sim, SimConfig } from '../types';
import { prepareFlight, runMissionFlight, runStressTest, runsOnServer, flightMismatch } from './runPhysics';
import { resetServerBusyForTests, runSimJobRemote } from './remoteSim';
import {
  flightRequest,
  parseAnyJob,
  runAnyJob,
  stringifyResult,
  type SimJobRequest,
} from './simJob';

const sample = parseOrkXml(SAMPLE_ORK_XML);
const c6 = findMotor({ designation: 'C6' })!;
const config: SimConfig = {
  railLength: 1.2, railAngle: 0.05, railAzimuth: 0, windSpeed: 3, windDirection: 4.7, gust: 0.1, launchAltitude: 0,
};

/** A stand-in for api/simulate.ts: the same parse and run, through JSON both ways. */
function server() {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const job = parseAnyJob(JSON.parse(init!.body as string));
    return new Response(stringifyResult({ ok: true, ...runAnyJob(job, { budgetMs: Infinity }) }), { status: 200 });
  });
}
const asFetch = (f: unknown): typeof fetch => f as typeof fetch;

function hangingFetch(): typeof fetch {
  return asFetch(
    vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
        }),
    ),
  );
}

function native(): void {
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
}

function finish(sim: Sim): Sim {
  sim.ignite();
  for (let i = 0; i < 10_000 && !sim.done; i++) sim.step(0.5);
  return sim;
}

afterEach(() => {
  // A 429 in one test opens the client's busy window; later tests must start clean.
  resetServerBusyForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runsOnServer', () => {
  it('is true on the web and false in the native app', () => {
    expect(runsOnServer()).toBe(true);
    native();
    expect(runsOnServer()).toBe(false);
  });
});

describe('prepareFlight', () => {
  it('flies on the server on the web, with the token, and returns an unignited sim', async () => {
    const fetchImpl = server();
    const run = await prepareFlight(sample, c6, config, { fetchImpl: asFetch(fetchImpl), accessToken: 'tok' });
    expect(run.ranOn).toBe('server');
    expect(run.fallbackReason).toBeUndefined();
    expect(run.sim.state.phase).toBe('pad');
    expect(run.sim.events).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/simulate');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(finish(run.sim).state.phase).toBe('landed');
  }, 120_000);

  it('runs on the device in the native app without any network call', async () => {
    native();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const run = await prepareFlight(sample, c6, config, { fetchImpl: asFetch(fetchImpl), accessToken: 'tok' });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toBeUndefined();
    expect(finish(run.sim).state.phase).toBe('landed');
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 120_000);

  it.each([
    ['a server error', async () => new Response('{"ok":false}', { status: 500 }), '500'],
    ['a rate limit', async () => new Response('{"ok":false}', { status: 429 }), '429'],
    [
      'an unreachable server',
      async () => {
        throw new TypeError('Failed to fetch');
      },
      'network error',
    ],
    ['a bad response', async () => new Response('{"ok":true,"kind":"flight"}', { status: 200 }), 'unexpected'],
    ['junk', async () => new Response('<html>', { status: 200 }), 'network error'],
  ])('falls back to the device on %s', async (_name, impl, reason) => {
    const run = await prepareFlight(sample, c6, config, { fetchImpl: asFetch(vi.fn(impl)) });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toContain(reason);
    expect(run.sim.state.phase).toBe('pad');
  });

  it('falls back to the device on a timeout', async () => {
    const run = await prepareFlight(sample, c6, config, { fetchImpl: hangingFetch(), timeoutMs: 20 });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toContain('longer than');
  });

  it('flies on the device when the server stopped the flight early', async () => {
    const fake = server();
    const fetchImpl = vi.fn(async (u: unknown, init?: RequestInit) => {
      const body = JSON.parse(await (await fake(u, init)).text()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, complete: false }), { status: 200 });
    });
    const run = await prepareFlight(sample, c6, config, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toContain('time limit');
  }, 120_000);

  it('rejects with an AbortError, without falling back', async () => {
    const early = new AbortController();
    early.abort();
    await expect(prepareFlight(sample, c6, config, { signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const later = new AbortController();
    const p = prepareFlight(sample, c6, config, { signal: later.signal, fetchImpl: hangingFetch() });
    later.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not call the server without a motor', async () => {
    const fetchImpl = vi.fn();
    const run = await prepareFlight(sample, null, config, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('device');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('designs the server would change fly on the device', () => {
  const mock = (name: string): RocketModel => parseOrkXml(MOCK_CASES.find((c) => c.name === name)!.xml);
  const check = (rocket: RocketModel, motor = c6, cfg = config): string | null =>
    flightMismatch(flightRequest(rocket, motor, cfg), rocket, motor, cfg);

  it.each([
    'baseline', 'three-stages', 'strap-on-boosters', 'pods', 'boosters-with-fins-and-gap', 'tube-fins',
    'motor-cluster', 'fins-freeform', 'many-parts',
  ])('%s survives the trip', (name) => {
    expect(check(mock(name))).toBeNull();
  });

  // Fins on a transition get the parent's aft radius; zero-size parts are dropped or defaulted;
  // an empty stage disappears.
  it.each(['fins-on-transition', 'fins-zero', 'zero-length-parts', 'empty-stage'])('%s does not', (name) => {
    expect(check(mock(name))).toMatch(/design/);
  });

  it('notices a motor whose stated total impulse differs from its curve', () => {
    const rocket = parseOrkXml(RH200_ORK_XML);
    const motor = RH200_STAGE_MOTORS[0].motor;
    expect(check(rocket, motor, { ...config, stageMotors: RH200_STAGE_MOTORS })).toMatch(/motor/);
  });

  it('notices a single-stage mass override, which the design form drops', () => {
    const rocket: RocketModel = {
      ...sample,
      stages: [
        { name: 'S', startComponent: 0, componentCount: sample.components.length, massOverride: 0.5, overrideSubcomponentsMass: true },
      ],
    };
    expect(check(rocket)).toMatch(/design/);
  });

  it('notices a zero mass override', () => {
    const rocket = { ...sample, components: sample.components.map((c, i) => (i === 0 ? { ...c, massOverride: 0 } : c)) };
    expect(check(rocket)).toMatch(/design/);
  });

  it('notices settings and motors the server would clamp or rewrite', () => {
    expect(check(sample, c6, { ...config, windSpeed: 80 })).toMatch(/settings/);
    expect(check(sample, c6, { ...config, ejectionDelay: Infinity })).toMatch(/settings/);
    expect(check(sample, { ...c6, designation: 'Q1', totalImpulse: c6.totalImpulse * 2 })).toMatch(/motor would/);
    expect(check(sample, { ...c6, designation: 'Q1', diameter: 0.9 })).toMatch(/motor would/);
    expect(check(sample, c6, { ...config, stageMotors: [{ motor: c6, ignitionDelay: 500 }] })).toMatch(/stage motors/);
    expect(check(sample, c6, { ...config, windLayers: [] })).toBeNull();
    expect(check(sample, c6, { ...config, ejectionDelay: 4, windLayers: [{ altitude: 100, speed: 4, direction: 1 }] })).toBeNull();
  });

  it('prepareFlight reports it and sends nothing', async () => {
    const fetchImpl = vi.fn();
    const run = await prepareFlight(mock('fins-on-transition'), c6, config, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toMatch(/design/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('runMissionFlight', () => {
  const opts = { failureCase: 'gimbal-lock', destructive: true };

  it('uses the server on the web', async () => {
    const fetchImpl = server();
    const run = await runMissionFlight('lvm3-m4', opts, { fetchImpl: asFetch(fetchImpl), accessToken: 'tok' });
    expect(run.ranOn).toBe('server');
    expect(run.record).toEqual(flyMission(getMission('lvm3-m4')!, opts));
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ kind: 'mission', mission: 'lvm3-m4', options: opts });
  }, 120_000);

  it('uses the device in the native app without any network call', async () => {
    native();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const run = await runMissionFlight('lvm3-m4', opts, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toBeUndefined();
    expect(run.record.failureCase).toBe('gimbal-lock');
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 120_000);

  it('falls back to the device when the server fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }));
    const run = await runMissionFlight('lvm3-m4', opts, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toContain('503');
    expect(run.record.failureCase).toBe('gimbal-lock');
  }, 120_000);

  it('keeps custom options on the device', async () => {
    const fetchImpl = vi.fn();
    const run = await runMissionFlight('lvm3-m4', { ...opts, sampleInterval: 2 }, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toContain('custom');
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 120_000);

  it('rejects with an AbortError', async () => {
    const ctl = new AbortController();
    const p = runMissionFlight('lvm3-m4', {}, { signal: ctl.signal, fetchImpl: hangingFetch() });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports an unknown mission', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 400 }));
    await expect(runMissionFlight('nope', {}, { fetchImpl: asFetch(fetchImpl) })).rejects.toThrow(/Unknown mission/);
  });
});

describe('stress test', () => {
  const request: SimJobRequest = {
    kind: 'stress',
    design: JSON.parse(JSON.stringify(fromRocketModel(sample))),
    motors: { motor: { designation: 'C6' } },
    config: {},
  };
  const direct = (rocket: RocketModel) =>
    stressTest(rocket, c6, config, cachedDeps({ atmosphere, massProps, aeroProps, thrust: thrustAt }));

  it('stays on the device in the native app, also through runSimJobRemote', async () => {
    native();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const onFallback = vi.fn();
    const old = await runSimJobRemote(request, { fetchImpl: asFetch(fetchImpl), endpoint: 'https://x.test/api/simulate', onFallback });
    expect(old.ranOn).toBe('browser');
    expect(old.flights).toBe(19);
    expect(onFallback).not.toHaveBeenCalled();
    const run = await runStressTest(sample, c6, config, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toBeUndefined();
    expect(run.result).toEqual(direct(sample));
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 120_000);

  it('uses the server on the web', async () => {
    const fetchImpl = server();
    const run = await runStressTest(sample, c6, config, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('server');
    expect(run.flights).toBe(19);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }, 120_000);

  it('reports why a web run used the device', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }));
    const run = await runStressTest(sample, c6, config, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toContain('500');
  }, 120_000);

  it('flies a design the server would change as it is, on the device', async () => {
    const rocket: RocketModel = {
      ...sample,
      stages: [
        { name: 'S', startComponent: 0, componentCount: sample.components.length, massOverride: 0.09, overrideSubcomponentsMass: true },
      ],
    };
    const fetchImpl = vi.fn();
    const run = await runStressTest(rocket, c6, config, { fetchImpl: asFetch(fetchImpl) });
    expect(run.ranOn).toBe('device');
    expect(run.fallbackReason).toMatch(/design/);
    expect(run.result).toEqual(direct(rocket));
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 120_000);

  it('rejects with an AbortError', async () => {
    native();
    const ctl = new AbortController();
    const p = runStressTest(sample, c6, config, { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
