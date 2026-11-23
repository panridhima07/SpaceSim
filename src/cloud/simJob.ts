// Server-side simulation job, shared by the Vercel function (api/simulate.ts) and the browser
// fallback (remoteSim.ts). Pure TypeScript: no DOM, no Node-only APIs.
//
// Everything in a SimJobRequest is untrusted. parseSimJob validates and sanitises it; runSimJob
// then runs the same stressTestSteps generator the browser UI uses, so both give identical numbers.
//
// Only the 'stress' kind exists. A 'flight' kind was left out on purpose: a single flight in the
// app is interactive (live 3D view, sim clock, pilot controls, replay of sim.log frame by frame),
// and the server cannot stream a whole 6-DOF log cheaply, so main.ts has no use for a finished
// flight result. The stress test is the heavy, non-interactive job.

import { atmosphere } from '../physics/atmosphere';
import { aeroProps } from '../physics/aero';
import { cachedDeps } from '../physics/cache';
import { massProps } from '../physics/massprops';
import { STRESS_FLIGHT_COUNT, stressTestSteps } from '../physics/sweep';
import { toRocketModel } from '../builder/design';
import { sanitizeDesignObject } from '../io/limits';
import { findMotor, thrustAt } from '../ork/motors';
import type {
  InnerTube,
  Motor,
  MotorRef,
  PhysicsDeps,
  RocketModel,
  SimConfig,
  StressReport,
  WindLayer,
} from '../types';

// ---------- Public types ----------

export type SimJobKind = 'stress';

export interface SimJobRequest {
  kind: SimJobKind;
  design: unknown;
  motors: unknown;
  config: unknown;
}

export interface SimJobResult {
  kind: SimJobKind;
  result: StressReport;
  durationMs: number;
  flights: number;
}

export interface ValidJob {
  kind: SimJobKind;
  rocket: RocketModel;
  motor: Motor;
  config: SimConfig;
  /** Non-fatal notes from sanitising the design. */
  warnings: string[];
}

/** The request is unusable (HTTP 400 style). The message is safe to show to the user. */
export class SimJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimJobError';
  }
}

/** The job ran past its wall-clock budget (HTTP 503 style). */
export class SimBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimBudgetError';
  }
}

// ---------- Limits ----------

export const DEFAULT_BUDGET_MS = 25_000;
export const MAX_CURVE_POINTS = 2000;
export const MAX_BURN_TIME_S = 600;
const MAX_THRUST_N = 1e6;
const MAX_MOTOR_MASS_KG = 1000;
const MAX_WIND_LAYERS = 16;
const MAX_SCAN_NODES = 500_000;
const MAX_SCAN_DEPTH = 64;
const MAX_TEXT = 80;
const RAD_PER_DEG = Math.PI / 180;

// ---------- Helpers ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Reject prototype-pollution keys anywhere in the tree; also bounds depth and node count. */
function assertNoForbiddenKeys(root: unknown): void {
  const stack: { v: unknown; depth: number }[] = [{ v: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { v, depth } = stack.pop()!;
    if (typeof v !== 'object' || v === null) continue;
    if (++nodes > MAX_SCAN_NODES) throw new SimJobError('Request is too large.');
    if (depth > MAX_SCAN_DEPTH) throw new SimJobError('Request is nested too deeply.');
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, depth: depth + 1 });
      continue;
    }
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k)) throw new SimJobError(`Request contains a forbidden key "${k}".`);
      stack.push({ v: (v as Record<string, unknown>)[k], depth: depth + 1 });
    }
  }
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Optional number: absent gives the default; present but not finite is an error; else clamped. */
function numField(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  def: number,
  min: number,
  max: number,
): number {
  const v = obj[key];
  if (v === undefined || v === null) return def;
  if (!finite(v)) throw new SimJobError(`${where}.${key} must be a finite number.`);
  return clamp(v, min, max);
}

function optNumField(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  min: number,
  max: number,
): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!finite(v)) throw new SimJobError(`${where}.${key} must be a finite number.`);
  return clamp(v, min, max);
}

function textField(obj: Record<string, unknown>, key: string, where: string, required: boolean): string {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) throw new SimJobError(`${where}.${key} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw new SimJobError(`${where}.${key} must be text.`);
  return v.slice(0, MAX_TEXT);
}

// ---------- Config ----------

/** Clamp ranges follow the launch fields in the UI (units are those of SimConfig: rad, m, m/s, K, Pa). */
function parseConfig(raw: unknown): SimConfig {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) throw new SimJobError('config must be an object.');
  const w = 'config';
  const cfg: SimConfig = {
    railLength: numField(raw, 'railLength', w, 1, 0.1, 50),
    railAngle: numField(raw, 'railAngle', w, 0, 0, 45 * RAD_PER_DEG),
    railAzimuth: numField(raw, 'railAzimuth', w, 0, -4 * Math.PI, 4 * Math.PI),
    windSpeed: numField(raw, 'windSpeed', w, 2, 0, 50),
    windDirection: numField(raw, 'windDirection', w, 270 * RAD_PER_DEG, -4 * Math.PI, 4 * Math.PI),
    gust: numField(raw, 'gust', w, 0.2, 0, 1),
    launchAltitude: numField(raw, 'launchAltitude', w, 0, 0, 10_000),
  };
  const delay = optNumField(raw, 'ejectionDelay', w, 0, 60);
  if (delay !== undefined) cfg.ejectionDelay = delay;
  const temp = optNumField(raw, 'groundTemperature', w, 173.15, 333.15);
  if (temp !== undefined) cfg.groundTemperature = temp;
  const pressure = optNumField(raw, 'groundPressure', w, 30_000, 110_000);
  if (pressure !== undefined) cfg.groundPressure = pressure;

  const layers = raw.windLayers;
  if (layers !== undefined && layers !== null) {
    if (!Array.isArray(layers)) throw new SimJobError('config.windLayers must be a list.');
    const out: WindLayer[] = [];
    for (const l of layers.slice(0, MAX_WIND_LAYERS)) {
      if (!isObject(l)) throw new SimJobError('config.windLayers entries must be objects.');
      out.push({
        altitude: numField(l, 'altitude', 'config.windLayers[]', 0, 0, 30_000),
        speed: numField(l, 'speed', 'config.windLayers[]', 0, 0, 100),
        direction: numField(l, 'direction', 'config.windLayers[]', 0, -4 * Math.PI, 4 * Math.PI),
      });
    }
    out.sort((a, b) => a.altitude - b.altitude);
    if (out.length > 0) cfg.windLayers = out;
  }
  // stageMotors is deliberately not accepted: the app's stress test does not use it.
  return cfg;
}

// ---------- Motors ----------

function parseInlineMotor(raw: Record<string, unknown>): Motor {
  const w = 'motor';
  const curveRaw = raw.curve;
  if (!Array.isArray(curveRaw)) throw new SimJobError('motor.curve must be a list of [time, thrust] points.');
  if (curveRaw.length < 2) throw new SimJobError('motor.curve needs at least 2 points.');
  if (curveRaw.length > MAX_CURVE_POINTS) {
    throw new SimJobError(`motor.curve has too many points (the limit is ${MAX_CURVE_POINTS}).`);
  }
  const curve: [number, number][] = [];
  let prevT = -Infinity;
  for (const p of curveRaw) {
    if (!Array.isArray(p) || p.length < 2 || !finite(p[0]) || !finite(p[1])) {
      throw new SimJobError('motor.curve points must be [time, thrust] with finite numbers.');
    }
    const t = p[0];
    const f = p[1];
    if (t < 0 || t > MAX_BURN_TIME_S) {
      throw new SimJobError(`motor.curve time must be within 0..${MAX_BURN_TIME_S} s.`);
    }
    if (f < 0 || f > MAX_THRUST_N) throw new SimJobError(`motor.curve thrust must be within 0..${MAX_THRUST_N} N.`);
    if (t < prevT) throw new SimJobError('motor.curve times must not decrease.');
    prevT = t;
    curve.push([t, f]);
  }
  const burnTime = curve[curve.length - 1][0];
  if (burnTime <= 0) throw new SimJobError('motor burn time must be greater than 0.');

  // Total impulse is recomputed from the curve rather than trusted.
  let impulse = 0;
  for (let i = 1; i < curve.length; i++) {
    impulse += 0.5 * (curve[i][1] + curve[i - 1][1]) * (curve[i][0] - curve[i - 1][0]);
  }
  const totalMass = numField(raw, 'totalMass', w, NaN, 1e-4, MAX_MOTOR_MASS_KG);
  if (!Number.isFinite(totalMass)) throw new SimJobError('motor.totalMass is required.');
  const propellantMass = numField(raw, 'propellantMass', w, 0, 0, MAX_MOTOR_MASS_KG);
  return {
    manufacturer: textField(raw, 'manufacturer', w, false) || 'Custom',
    designation: textField(raw, 'designation', w, true),
    diameter: numField(raw, 'diameter', w, 0.018, 0.001, 0.5),
    length: numField(raw, 'length', w, 0.07, 0.005, 3),
    totalMass,
    propellantMass: Math.min(propellantMass, totalMass),
    curve,
    burnTime,
    totalImpulse: impulse,
    approximate: raw.approximate === true,
  };
}

/** A motor reference (no curve) is resolved from the built-in database; a curve makes it inline. */
function parseMotorSpec(raw: unknown): Motor {
  if (!isObject(raw)) throw new SimJobError('motors.motor must be an object.');
  if (raw.curve !== undefined) return parseInlineMotor(raw);
  const designation = textField(raw, 'designation', 'motors.motor', true);
  const manufacturer = textField(raw, 'manufacturer', 'motors.motor', false);
  const found = findMotor({ manufacturer: manufacturer || undefined, designation });
  if (!found) throw new SimJobError(`Unknown motor "${designation}". Send its thrust curve instead.`);
  return found;
}

/**
 * Wire form of a motor for SimJobRequest.motors: a small reference when the built-in database
 * resolves it to the same curve, else the whole motor inline (ThrustCurve downloads, .eng files).
 */
export function motorSpec(motor: Motor): { motor: Record<string, unknown> } {
  const found = findMotor({ manufacturer: motor.manufacturer, designation: motor.designation });
  const same =
    found !== null &&
    found.manufacturer === motor.manufacturer &&
    found.curve.length === motor.curve.length &&
    found.totalImpulse === motor.totalImpulse &&
    found.curve.every((p, i) => p[0] === motor.curve[i][0] && p[1] === motor.curve[i][1]);
  if (same) return { motor: { manufacturer: motor.manufacturer, designation: motor.designation } };
  return { motor: { ...motor } };
}

/** The motor-mount motor reference of a rocket, like main.ts findMotorRef. */
function mountMotorRef(r: RocketModel): MotorRef | null {
  const mount = r.components.find((c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount);
  return mount?.motor ?? null;
}

function resolveMotor(rawMotors: unknown, rocket: RocketModel): Motor {
  if (rawMotors !== undefined && rawMotors !== null) {
    if (!isObject(rawMotors)) throw new SimJobError('motors must be an object.');
    if (rawMotors.motor !== undefined && rawMotors.motor !== null) return parseMotorSpec(rawMotors.motor);
  }
  // No motor sent: use the one the design's motor mount names.
  const ref = mountMotorRef(rocket);
  const found = ref ? findMotor(ref) : null;
  if (!found) throw new SimJobError('No motor given and the design has no known motor.');
  return found;
}

// ---------- Parse ----------

/** Validate and sanitise a raw request. Throws SimJobError on anything unusable. */
export function parseSimJob(raw: unknown): ValidJob {
  if (!isObject(raw)) throw new SimJobError('Request must be a JSON object.');
  assertNoForbiddenKeys(raw);
  if (raw.kind !== 'stress') throw new SimJobError('Unknown job kind.');
  if (!isObject(raw.design)) throw new SimJobError('design is required.');

  const warnings: string[] = [];
  let rocket: RocketModel;
  try {
    const design = sanitizeDesignObject(raw.design, 'Rocket', warnings);
    rocket = toRocketModel(design);
  } catch (e) {
    // sanitizeDesignObject throws plain Errors with user-safe messages.
    throw new SimJobError(`Invalid design: ${e instanceof Error ? e.message : 'unreadable'}`);
  }
  if (rocket.components.length === 0) throw new SimJobError('Invalid design: no components.');

  const motor = resolveMotor(raw.motors, rocket);
  const config = parseConfig(raw.config);
  return { kind: 'stress', rocket, motor, config, warnings };
}

// ---------- Run ----------

export interface SimJobRunOptions {
  /** Wall-clock budget in ms. Default 25 000; Infinity disables it. */
  budgetMs?: number;
  /** Clock in ms, injectable for tests. Default performance.now / Date.now. */
  now?: () => number;
}

const defaultNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

function makeDeps(): PhysicsDeps {
  return cachedDeps({ atmosphere, massProps, aeroProps, thrust: thrustAt });
}

/** The job as a generator (one slice per yield), enforcing the time budget between slices. */
export function* simJobSteps(
  job: ValidJob,
  opts: SimJobRunOptions = {},
): Generator<{ done: number; total: number }, SimJobResult, undefined> {
  const now = opts.now ?? defaultNow;
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const start = now();
  const steps = stressTestSteps(job.rocket, job.motor, job.config, makeDeps());
  for (;;) {
    const r = steps.next();
    if (r.done) {
      return { kind: job.kind, result: r.value, durationMs: now() - start, flights: STRESS_FLIGHT_COUNT };
    }
    if (now() - start > budget) {
      throw new SimBudgetError(`Simulation exceeded its ${Math.round(budget / 1000)} s time budget.`);
    }
    yield r.value;
  }
}

/** Run it to completion, synchronously. Same stressTestSteps the browser UI uses. */
export function runSimJob(job: ValidJob, opts: SimJobRunOptions = {}): SimJobResult {
  const gen = simJobSteps(job, opts);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/** Run it without freezing the page: yields to the event loop about every `sliceMs`. */
export async function runSimJobAsync(
  job: ValidJob,
  opts: SimJobRunOptions & { sliceMs?: number; signal?: AbortSignal } = {},
): Promise<SimJobResult> {
  const now = opts.now ?? defaultNow;
  const sliceMs = opts.sliceMs ?? 12;
  const gen = simJobSteps(job, opts);
  let sliceStart = now();
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const r = gen.next();
    if (r.done) return r.value;
    if (now() - sliceStart >= sliceMs) {
      await new Promise<void>((res) => setTimeout(res, 0));
      sliceStart = now();
    }
  }
}

// ---------- JSON with non-finite numbers ----------
// JSON turns NaN into null, but StressReport uses NaN for "unknown" (railExitSpeed, drift, ...),
// and null already means something in maxSafeWind / bestDelay. So non-finite numbers travel as tagged strings.

const NAN_TAG = '__NaN__';
const INF_TAG = '__Infinity__';
const NEG_INF_TAG = '__-Infinity__';

export function stringifyResult(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v !== 'number' || Number.isFinite(v)) return v;
    return Number.isNaN(v) ? NAN_TAG : v > 0 ? INF_TAG : NEG_INF_TAG;
  });
}

export function parseResultJson(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown) => {
    if (v === NAN_TAG) return NaN;
    if (v === INF_TAG) return Infinity;
    if (v === NEG_INF_TAG) return -Infinity;
    return v;
  });
}

/** True when a decoded server response looks like a SimJobResult (shape check only). */
export function isSimJobResult(v: unknown): v is SimJobResult {
  if (!isObject(v) || v.kind !== 'stress' || !isObject(v.result)) return false;
  const r = v.result;
  return Array.isArray(r.wind) && Array.isArray(r.railAngle) && Array.isArray(r.delay) && Array.isArray(r.summary);
}
