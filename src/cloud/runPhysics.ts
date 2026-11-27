// The one door to non-interactive physics runs. On the website they run on the server; in the
// Android app they run on the device. Whenever the server cannot be used, or could not reproduce
// the run exactly, the device does it and the result says why.
//
// Hand-flown flights (manual flight, piloted mission, lunar descent) do not come through here:
// they need a control loop on the device, so they call createSim and friends directly.

import type { Component, Motor, PhysicsDeps, RocketModel, Sim, SimConfig } from '../types';
import { atmosphere } from '../physics/atmosphere';
import { aeroProps } from '../physics/aero';
import { cachedDeps } from '../physics/cache';
import { massProps } from '../physics/massprops';
import { createSim } from '../physics/sim';
import { thrustAt } from '../ork/motors';
import { runMission } from '../mission/client';
import type { FlyOptions } from '../mission/fly';
import type { FlightRecord } from '../mission/record';
import { abortError, postSimJob, runsOnServer, type RemoteSimOptions } from './remoteSim';
import { replaySim } from './replaySim';
import {
  flightRequest,
  isFlightJobResult,
  isMissionJobResult,
  isSimJobResult,
  parseFlightJob,
  runSimJobAsync,
  type FlightJobRequest,
  type SimJobRequest,
  type SimJobResult,
  type ValidFlightJob,
} from './simJob';

export { runsOnServer };

export type RunPhysicsOptions = Omit<RemoteSimOptions, 'onFallback'>;

export type RanOn = 'server' | 'device';

export interface FlightRun {
  /** Not ignited yet, whichever side computed it. */
  sim: Sim;
  ranOn: RanOn;
  /** Set when a website run had to use the device. */
  fallbackReason?: string;
}

export interface MissionRun {
  record: FlightRecord;
  ranOn: RanOn;
  fallbackReason?: string;
}

/** How long a launch waits for the server before flying on the device, ms. */
export const FLIGHT_TIMEOUT_MS = 12_000;
/** api/simulate.ts rejects bodies above 1 MB. */
const MAX_REQUEST_BYTES = 1_000_000;

// ---------- Does the flight survive the trip? ----------

/** Equal within float rounding. Non-finite numbers all mean "none" (a plugged motor's delay). */
function close(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return !Number.isFinite(a) && !Number.isFinite(b);
    return Math.abs(a - b) <= 1e-12 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => close(x[k], y[k]));
  }
  return a === b || (a === undefined && b === undefined);
}

/** A part without what physics never reads. */
function bare(c: Component): Record<string, unknown> {
  const { id: _id, name: _name, color: _color, ...rest } = c;
  return rest;
}

function sortKey(c: Record<string, unknown>): string {
  return Object.keys(c)
    .sort()
    .map((k) => {
      const v = c[k];
      return `${k}=${typeof v === 'number' ? v.toPrecision(7) : JSON.stringify(v)}`;
    })
    .join(';');
}

/** The same parts, in any order. */
function sameParts(a: Component[], b: Component[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = (list: Component[]): Record<string, unknown>[] =>
    list
      .map(bare)
      .map((part) => ({ part, key: sortKey(part) }))
      .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
      .map((e) => e.part);
  const other = sorted(b);
  return sorted(a).every((part, i) => close(part, other[i]));
}

/** What the sim and mass model see of the stages. One stage without a mass override is no stages. */
function stageShape(r: RocketModel): { start: number; parts: Component[]; mass?: number }[] {
  const stages = r.stages ?? [];
  const overrides = stages.some((s) => s.massOverride !== undefined && s.overrideSubcomponentsMass);
  if (stages.length <= 1 && !overrides) return [{ start: 0, parts: r.components }];
  return stages.map((s) => ({
    start: s.startComponent,
    parts: r.components.slice(s.startComponent, s.startComponent + s.componentCount),
    ...(s.massOverride !== undefined && s.overrideSubcomponentsMass ? { mass: s.massOverride } : {}),
  }));
}

/** The ejection delay the sim reads from the design (see resolveEjectionDelay in sim.ts). */
function mountDelay(r: RocketModel): number | undefined {
  const tubes = r.components.flatMap((c) => (c.kind === 'innertube' ? [c] : []));
  const mount = tubes.find((t) => t.isMotorMount && t.motor) ?? tubes.find((t) => t.motor);
  return mount ? mount.motor?.delay : 0;
}

function sameRocket(a: RocketModel, b: RocketModel, motor: Motor): boolean {
  if (!close(a.length, b.length) || !close(a.maxRadius, b.maxRadius)) return false;
  if (!close(mountDelay(a), mountDelay(b))) return false;

  const sa = stageShape(a);
  const sb = stageShape(b);
  if (sa.length !== sb.length) return false;
  if (!sa.every((s, i) => s.start === sb[i].start && close(s.mass, sb[i].mass) && sameParts(s.parts, sb[i].parts))) {
    return false;
  }

  const sideA = a.sideBodies ?? [];
  const sideB = b.sideBodies ?? [];
  if (sideA.length !== sideB.length) return false;
  const sidesMatch = sideA.every((s, i) => {
    const o = sideB[i];
    return (
      s.type === o.type &&
      s.count === o.count &&
      close(s.radialOffset, o.radialOffset) &&
      close(s.angle, o.angle) &&
      sameParts(s.components, o.components)
    );
  });
  if (!sidesMatch) return false;

  // Part order can matter to the physics models, so compare what they compute too: for the whole
  // rocket and for what is left after each separation.
  const cuts = [a.components.length, ...sa.map((s) => s.start).filter((start) => start > 0)];
  return cuts.every((cut) => {
    const x = { ...a, components: a.components.slice(0, cut) };
    const y = { ...b, components: b.components.slice(0, cut) };
    const mx = massProps(x, motor, 0);
    const my = massProps(y, motor, 0);
    return close(mx, my) && [0.1, 0.9, 1.5].every((mach) => close(aeroProps(x, mach, mx.cgX), aeroProps(y, mach, mx.cgX)));
  });
}

function sameMotor(a: Motor, b: Motor): boolean {
  const flown = (m: Motor): unknown => [
    m.manufacturer, m.designation, m.diameter, m.length, m.totalMass, m.propellantMass, m.burnTime,
    m.totalImpulse, m.curve,
  ];
  return close(flown(a), flown(b));
}

const CONFIG_KEYS = [
  'railLength', 'railAngle', 'railAzimuth', 'windSpeed', 'windDirection', 'gust', 'launchAltitude',
  'groundTemperature', 'groundPressure', 'windLayers', 'ejectionDelay',
] as const;

function sameConfig(a: SimConfig, b: SimConfig): boolean {
  return CONFIG_KEYS.every((key) => {
    let x: unknown = a[key];
    const y: unknown = b[key];
    if (key === 'windLayers' && Array.isArray(x) && x.length === 0) x = undefined;
    // Unlike motor delays, an unset setting and a non-finite one fly differently.
    if (typeof x === 'number' && !Number.isFinite(x)) return Object.is(x, y);
    return close(x, y);
  });
}

/**
 * Rebuilds the request exactly as the server will and compares it with the original.
 * null: the server flies the same flight. Otherwise, why it would not.
 */
export function flightMismatch(
  request: FlightJobRequest,
  rocket: RocketModel,
  motor: Motor,
  config: SimConfig,
): string | null {
  const body = JSON.stringify(request);
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) return 'the design is too large to send';
  let job: ValidFlightJob;
  try {
    job = parseFlightJob(JSON.parse(body));
  } catch (e) {
    return `the server cannot take this flight: ${e instanceof Error ? e.message : 'unreadable'}`;
  }
  if (!sameRocket(rocket, job.rocket, motor)) return 'the design would change on the way to the server';
  if (!sameMotor(motor, job.motor)) return 'the motor would change on the way to the server';
  const mine = config.stageMotors ?? [];
  const theirs = job.config.stageMotors ?? [];
  const stagesMatch =
    mine.length === theirs.length &&
    mine.every((s, i) => sameMotor(s.motor, theirs[i].motor) && (s.ignitionDelay ?? 0) === (theirs[i].ignitionDelay ?? 0));
  if (!stagesMatch) return 'the stage motors would change on the way to the server';
  if (!sameConfig(config, job.config)) return 'the launch settings would change on the way to the server';
  return null;
}

// ---------- Runs ----------

function deviceDeps(): PhysicsDeps {
  return cachedDeps({ atmosphere, massProps, aeroProps, thrust: thrustAt });
}

/**
 * A flight of `rocket`, ready to ignite. On the website the server computes the whole flight and
 * the returned sim replays it; otherwise it is a live createSim run on the device.
 * Rejects only with an AbortError, when opts.signal is aborted.
 */
export async function prepareFlight(
  rocket: RocketModel,
  motor: Motor | null,
  config: SimConfig,
  opts: RunPhysicsOptions = {},
): Promise<FlightRun> {
  if (opts.signal?.aborted) throw abortError();
  const onDevice = (fallbackReason?: string): FlightRun => ({
    sim: createSim(rocket, motor, config, deviceDeps()),
    ranOn: 'device',
    ...(fallbackReason ? { fallbackReason } : {}),
  });

  if (!runsOnServer()) return onDevice();
  if (!motor) return onDevice('there is no motor to fly');

  let request: FlightJobRequest;
  try {
    request = flightRequest(rocket, motor, config);
    const mismatch = flightMismatch(request, rocket, motor, config);
    if (mismatch) return onDevice(mismatch);
  } catch {
    return onDevice('the design could not be prepared for the server');
  }

  const attempt = await postSimJob(request, isFlightJobResult, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? FLIGHT_TIMEOUT_MS,
  });
  if (!attempt.ok) return onDevice(attempt.reason);
  // A cut-off log would end mid-air; the live sim has no time limit.
  if (!attempt.result.complete) return onDevice('the flight does not finish within the server time limit');
  return { sim: replaySim(attempt.result), ranOn: 'server' };
}

/** True when the server accepts these options (the app's own scenario and failure cases). */
function sendable(opts: FlyOptions): boolean {
  return opts.sampleInterval === undefined && opts.failures === undefined;
}

/**
 * Fly a mission. Website: on the server, falling back to the mission worker. Native: the worker.
 * Rejects with an AbortError when run.signal is aborted, or with the worker's error (such as an
 * unknown mission).
 */
export async function runMissionFlight(
  id: string,
  opts: FlyOptions = {},
  run: RunPhysicsOptions = {},
): Promise<MissionRun> {
  if (run.signal?.aborted) throw abortError();
  let fallbackReason: string | undefined;
  if (runsOnServer()) {
    if (sendable(opts)) {
      const { scenario, failureCase, destructive } = opts;
      const attempt = await postSimJob(
        { kind: 'mission', mission: id, options: { scenario, failureCase, destructive } },
        isMissionJobResult,
        run,
      );
      if (attempt.ok) return { record: attempt.result.record, ranOn: 'server' };
      fallbackReason = attempt.reason;
    } else {
      fallbackReason = 'the server does not take custom mission options';
    }
  }
  const record = await runMission(id, opts, run.signal);
  return { record, ranOn: 'device', ...(fallbackReason ? { fallbackReason } : {}) };
}

/**
 * The stress test, by the same rule. The device flies the rocket as it is; the server only gets it
 * when its rebuild would be the same rocket. Like the server, it flies one motor (no stage motors).
 * Rejects with an AbortError when opts.signal is aborted.
 */
export async function runStressTest(
  rocket: RocketModel,
  motor: Motor,
  config: SimConfig,
  opts: RunPhysicsOptions = {},
): Promise<SimJobResult & { ranOn: RanOn; fallbackReason?: string }> {
  if (opts.signal?.aborted) throw abortError();
  const { stageMotors: _stageMotors, ...single } = config;
  let fallbackReason: string | undefined;
  if (runsOnServer()) {
    const request: SimJobRequest = { ...flightRequest(rocket, motor, single), kind: 'stress' };
    fallbackReason = flightMismatch({ ...request, kind: 'flight' }, rocket, motor, single) ?? undefined;
    if (!fallbackReason) {
      const attempt = await postSimJob(request, isSimJobResult, opts);
      if (attempt.ok) {
        const { kind, result, durationMs, flights } = attempt.result;
        return { kind, result, durationMs, flights, ranOn: 'server' };
      }
      fallbackReason = attempt.reason;
    }
  }
  // No wall-clock cap, and sliced so the page stays responsive.
  const local = await runSimJobAsync(
    { kind: 'stress', rocket, motor, config: single, warnings: [] },
    { budgetMs: Infinity, signal: opts.signal },
  );
  return { ...local, ranOn: 'device', ...(fallbackReason ? { fallbackReason } : {}) };
}
