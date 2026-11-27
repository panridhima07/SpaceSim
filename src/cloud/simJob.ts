// Server-side simulation jobs, shared by the Vercel function (api/simulate.ts) and the browser
// client (remoteSim.ts, runPhysics.ts). Pure TypeScript: no DOM, no Node-only APIs.
//
// Everything in a request is untrusted. The parse functions validate and sanitise it; the run
// functions then use the same physics code the app uses, so both sides give the same numbers.
//
// Three kinds, all non-interactive:
// - 'stress'  the stress test (many headless flights)
// - 'flight'  one 6-DOF flight of a built or imported rocket, returned as events plus a thinned
//             log that replaySim.ts plays back on the app clock
// - 'mission' one flyMission run, returned as its FlightRecord
// Hand-flown flights cannot run here: a serverless function cannot close a real-time control loop.

import { atmosphere } from '../physics/atmosphere';
import { aeroProps } from '../physics/aero';
import { cachedDeps } from '../physics/cache';
import { massProps } from '../physics/massprops';
import { createSim } from '../physics/sim';
import { STRESS_FLIGHT_COUNT, stressTestSteps } from '../physics/sweep';
import { fromRocketModel, toRocketModel } from '../builder/design';
import { sanitizeDesignObject } from '../io/limits';
import { findMotor, thrustAt } from '../ork/motors';
import { SCENARIOS, type ScenarioId } from '../mission/engine';
import { flyMission, type FlyOptions } from '../mission/fly';
import type { FlightRecord } from '../mission/record';
import { getMission, type MissionDef } from '../mission/vehicles';
import type {
  FlightEvent,
  FlightPhase,
  InnerTube,
  Motor,
  MotorRef,
  PhysicsDeps,
  RocketModel,
  SimConfig,
  SimState,
  StressReport,
  WindLayer,
} from '../types';

// ---------- Public types ----------

export type SimJobKind = 'stress' | 'flight' | 'mission';

/** The stress test request. */
export interface SimJobRequest {
  kind: 'stress';
  design: unknown;
  motors: unknown;
  config: unknown;
}

export interface FlightJobRequest {
  kind: 'flight';
  design: unknown;
  /** { motor, stages?: [{ motor, ignitionDelay? }] }, stages in firing order. */
  motors: unknown;
  /** SimConfig without stageMotors (those travel in `motors.stages`). */
  config: unknown;
}

export interface MissionJobRequest {
  kind: 'mission';
  mission: unknown;
  /** { scenario?, failureCase?, destructive? } */
  options: unknown;
}

export type AnyJobRequest = SimJobRequest | FlightJobRequest | MissionJobRequest;

export interface SimJobResult {
  kind: 'stress';
  result: StressReport;
  durationMs: number;
  flights: number;
}

/** The flight log on the wire: one row of numbers per sample, columns as in LOG_COLUMNS. */
export interface PackedLog {
  rows: number[][];
}

export interface FlightJobResult {
  kind: 'flight';
  /** True when the flight reached landing or crash. False: the server stopped it early. */
  complete: boolean;
  events: FlightEvent[];
  log: PackedLog;
  durationMs: number;
}

export interface MissionJobResult {
  kind: 'mission';
  record: FlightRecord;
  durationMs: number;
}

export type AnyJobResult = SimJobResult | FlightJobResult | MissionJobResult;

export interface ValidJob {
  kind: 'stress';
  rocket: RocketModel;
  motor: Motor;
  config: SimConfig;
  /** Non-fatal notes from sanitising the design. */
  warnings: string[];
}

export interface ValidFlightJob {
  kind: 'flight';
  rocket: RocketModel;
  motor: Motor;
  /** Includes stageMotors when the request had stages. */
  config: SimConfig;
  warnings: string[];
}

export interface ValidMissionJob {
  kind: 'mission';
  mission: MissionDef;
  options: FlyOptions;
}

export type AnyValidJob = ValidJob | ValidFlightJob | ValidMissionJob;

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
export const MAX_STAGE_MOTORS = 8;
const MAX_IGNITION_DELAY_S = 120;
/** Longest flight the server simulates, s of sim time. */
export const MAX_FLIGHT_SIM_S = 1800;
/** Most log samples in one flight response; about 220 bytes each, so under 3 MB. */
export const MAX_LOG_ROWS = 12_000;
/** A mission record above this many characters of JSON is thinned (Vercel allows 4.5 MB). */
export const MAX_RECORD_BYTES = 3_500_000;
/** Sim time per step() call in a server flight, s. Equals the sim's log interval. */
export const FLIGHT_STEP_S = 0.02;
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
 * Wire form of a motor for a request's motors: a small reference when the built-in database
 * resolves it to the same motor, else the whole motor inline (ThrustCurve downloads, .eng files).
 */
export function motorSpec(motor: Motor): { motor: Record<string, unknown> } {
  const found = findMotor({ manufacturer: motor.manufacturer, designation: motor.designation });
  const same =
    found !== null &&
    found.manufacturer === motor.manufacturer &&
    found.designation === motor.designation &&
    found.diameter === motor.diameter &&
    found.length === motor.length &&
    found.totalMass === motor.totalMass &&
    found.propellantMass === motor.propellantMass &&
    found.burnTime === motor.burnTime &&
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

function parseDesign(raw: unknown, warnings: string[]): RocketModel {
  if (!isObject(raw)) throw new SimJobError('design is required.');
  let rocket: RocketModel;
  try {
    const design = sanitizeDesignObject(raw, 'Rocket', warnings);
    rocket = toRocketModel(design);
  } catch (e) {
    // sanitizeDesignObject throws plain Errors with user-safe messages. Internal bugs
    // (TypeError etc.) must not become a 400 that leaks property names.
    if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError) throw e;
    throw new SimJobError(`Invalid design: ${e instanceof Error ? e.message : 'unreadable'}`);
  }
  if (rocket.components.length === 0) throw new SimJobError('Invalid design: no components.');
  return rocket;
}

/** Common first checks: an object, no pollution keys, the expected kind. */
function checkRequest(raw: unknown, kind: SimJobKind): Record<string, unknown> {
  if (!isObject(raw)) throw new SimJobError('Request must be a JSON object.');
  assertNoForbiddenKeys(raw);
  if (raw.kind !== kind) throw new SimJobError('Unknown job kind.');
  return raw;
}

/** Validate and sanitise a raw stress request. Throws SimJobError on anything unusable. */
export function parseSimJob(input: unknown): ValidJob {
  const raw = checkRequest(input, 'stress');
  const warnings: string[] = [];
  const rocket = parseDesign(raw.design, warnings);
  const motor = resolveMotor(raw.motors, rocket);
  // The stress test flies one motor, so stage motors are not read.
  const config = parseConfig(raw.config);
  return { kind: 'stress', rocket, motor, config, warnings };
}

function parseStageMotors(rawMotors: unknown): SimConfig['stageMotors'] {
  if (!isObject(rawMotors)) return undefined;
  const list = rawMotors.stages;
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new SimJobError('motors.stages must be a list.');
  if (list.length > MAX_STAGE_MOTORS) {
    throw new SimJobError(`motors.stages has too many entries (the limit is ${MAX_STAGE_MOTORS}).`);
  }
  const out = list.map((entry: unknown) => {
    if (!isObject(entry)) throw new SimJobError('motors.stages entries must be objects.');
    const motor = parseMotorSpec(entry.motor);
    const delay = optNumField(entry, 'ignitionDelay', 'motors.stages[]', 0, MAX_IGNITION_DELAY_S);
    return delay === undefined ? { motor } : { motor, ignitionDelay: delay };
  });
  return out.length > 0 ? out : undefined;
}

/** Validate and sanitise a raw flight request. Throws SimJobError on anything unusable. */
export function parseFlightJob(input: unknown): ValidFlightJob {
  const raw = checkRequest(input, 'flight');
  const warnings: string[] = [];
  const rocket = parseDesign(raw.design, warnings);
  const motor = resolveMotor(raw.motors, rocket);
  const config = parseConfig(raw.config);
  const stageMotors = parseStageMotors(raw.motors);
  if (stageMotors) config.stageMotors = stageMotors;
  return { kind: 'flight', rocket, motor, config, warnings };
}

const MISSION_OPTION_KEYS = new Set(['scenario', 'failureCase', 'destructive']);

/** Validate a raw mission request: a known mission and the options the app itself sends. */
export function parseMissionJob(input: unknown): ValidMissionJob {
  const raw = checkRequest(input, 'mission');
  const mission = typeof raw.mission === 'string' ? getMission(raw.mission) : undefined;
  if (!mission) throw new SimJobError('Unknown mission.');
  const options: FlyOptions = {};
  const rawOpts = raw.options;
  if (rawOpts !== undefined && rawOpts !== null) {
    if (!isObject(rawOpts)) throw new SimJobError('options must be an object.');
    for (const key of Object.keys(rawOpts)) {
      if (!MISSION_OPTION_KEYS.has(key)) throw new SimJobError(`Unsupported option "${key.slice(0, MAX_TEXT)}".`);
    }
    const { scenario, failureCase, destructive } = rawOpts;
    if (scenario !== undefined && scenario !== null) {
      if (!(SCENARIOS as readonly unknown[]).includes(scenario)) throw new SimJobError('Unknown scenario.');
      options.scenario = scenario as ScenarioId;
    }
    if (failureCase !== undefined && failureCase !== null) {
      const known = mission.failureCases?.find((c) => c.id === failureCase);
      if (!known) throw new SimJobError('Unknown failure case.');
      options.failureCase = known.id;
    }
    if (destructive !== undefined && destructive !== null) {
      if (typeof destructive !== 'boolean') throw new SimJobError('options.destructive must be true or false.');
      options.destructive = destructive;
    }
  }
  return { kind: 'mission', mission, options };
}

/** Parse a request of any kind. */
export function parseAnyJob(raw: unknown): AnyValidJob {
  if (isObject(raw) && raw.kind === 'flight') return parseFlightJob(raw);
  if (isObject(raw) && raw.kind === 'mission') return parseMissionJob(raw);
  return parseSimJob(raw);
}

/**
 * The wire request for a flight. Send it only if the rocket, motors and config survive the trip
 * unchanged (runPhysics.ts checks that).
 */
export function flightRequest(rocket: RocketModel, motor: Motor, config: SimConfig): FlightJobRequest {
  const { stageMotors, ...rest } = config;
  const stages = stageMotors?.map((s) => ({ ...motorSpec(s.motor), ignitionDelay: s.ignitionDelay }));
  return {
    kind: 'flight',
    design: fromRocketModel(rocket),
    motors: stages && stages.length > 0 ? { ...motorSpec(motor), stages } : motorSpec(motor),
    config: rest,
  };
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

// ---------- Flight log packing ----------

/** [name, decimals kept] of every column in a packed log row, in order. */
export const LOG_COLUMNS: readonly (readonly [string, number])[] = [
  ['t', 6],
  ['px', 3], ['py', 3], ['pz', 3],
  ['vx', 4], ['vy', 4], ['vz', 4],
  ['qx', 7], ['qy', 7], ['qz', 7], ['qw', 7],
  ['ox', 5], ['oy', 5], ['oz', 5],
  ['mass', 7], ['altitude', 3], ['speed', 4], ['airspeed', 4], ['mach', 6], ['alpha', 6],
  ['dynamicPressure', 3], ['thrust', 4], ['drag', 5], ['accelG', 5], ['cgX', 6], ['cpX', 6],
  ['stabilityCal', 5], ['phase', 0], ['chute', 0],
];
const PHASES: readonly FlightPhase[] = ['pad', 'rail', 'boost', 'coast', 'descent', 'landed', 'crashed'];
const COLUMN_SCALE = LOG_COLUMNS.map(([, decimals]) => 10 ** decimals);

function packRow(s: SimState): number[] {
  const row = [
    s.t,
    s.pos[0], s.pos[1], s.pos[2],
    s.vel[0], s.vel[1], s.vel[2],
    s.quat[0], s.quat[1], s.quat[2], s.quat[3],
    s.omega[0], s.omega[1], s.omega[2],
    s.mass, s.altitude, s.speed, s.airspeed ?? s.speed, s.mach, s.alpha,
    s.dynamicPressure, s.thrust, s.drag, s.accelG, s.cgX, s.cpX,
    s.stabilityCal, PHASES.indexOf(s.phase), s.chuteDeployed ? 1 : 0,
  ];
  for (let i = 0; i < row.length; i++) row[i] = Math.round(row[i] * COLUMN_SCALE[i]) / COLUMN_SCALE[i];
  return row;
}

export function unpackLog(log: PackedLog): SimState[] {
  return log.rows.map((r) => ({
    t: r[0],
    pos: [r[1], r[2], r[3]],
    vel: [r[4], r[5], r[6]],
    quat: [r[7], r[8], r[9], r[10]],
    omega: [r[11], r[12], r[13]],
    mass: r[14],
    altitude: r[15],
    speed: r[16],
    airspeed: r[17],
    mach: r[18],
    alpha: r[19],
    dynamicPressure: r[20],
    thrust: r[21],
    drag: r[22],
    accelG: r[23],
    cgX: r[24],
    cpX: r[25],
    stabilityCal: r[26],
    phase: PHASES[r[27]],
    chuteDeployed: r[28] === 1,
  }));
}

/** Kept at full resolution around each event, seconds before and after. */
const EVENT_LEAD_S = 0.5;
const EVENT_TAIL_S = 1.5;
/** A change in load factor this large between samples (a second canopy opening) is kept in full. */
const SHOCK_DELTA_G = 0.02;
const COARSE_INTERVAL_S = 0.1;

/**
 * The samples worth sending. Full resolution on the pad, rail and boost, around events and at load
 * shocks; about 0.1 s in coast and descent. The samples that flight analysis takes extremes from
 * are always kept. A very long flight widens the intervals until it fits in `maxRows`.
 */
export function thinLog(log: SimState[], events: FlightEvent[], maxRows: number = MAX_LOG_ROWS): SimState[] {
  const n = log.length;
  if (n <= 2) return log.slice();
  const must = new Uint8Array(n);
  const fine = new Uint8Array(n);
  must[0] = 1;
  must[n - 1] = 1;

  const eventTimes = events.map((e) => e.t).sort((a, b) => a - b);
  let next = 0; // first event whose window has not ended
  for (let i = 0; i < n; i++) {
    const s = log[i];
    if (s.phase === 'pad' || s.phase === 'rail' || s.phase === 'boost') fine[i] = 1;
    while (next < eventTimes.length && eventTimes[next] + EVENT_TAIL_S < s.t) next++;
    for (let k = next; k < eventTimes.length && eventTimes[k] - EVENT_LEAD_S <= s.t; k++) {
      fine[i] = 1;
      if (s.t === eventTimes[k]) must[i] = 1;
    }
    if (i > 0) {
      const p = log[i - 1];
      if (Math.abs(s.accelG - p.accelG) > SHOCK_DELTA_G) fine[i - 1] = fine[i] = 1;
      if (s.phase !== p.phase || s.chuteDeployed !== p.chuteDeployed) must[i - 1] = must[i] = 1;
    }
  }

  const keepMax = (score: (s: SimState) => number): void => {
    let best = -1;
    let value = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = score(log[i]);
      if (v > value) {
        value = v;
        best = i;
      }
    }
    if (best >= 0) must[best] = 1;
  };
  const powered = (s: SimState): boolean => s.phase === 'boost' || s.phase === 'coast';
  const falling = (s: SimState): boolean => s.phase === 'descent' || s.phase === 'landed' || s.phase === 'crashed';
  keepMax((s) => s.altitude);
  keepMax((s) => s.speed);
  keepMax((s) => s.mach);
  keepMax((s) => s.accelG);
  keepMax((s) => s.thrust);
  keepMax((s) => s.thrust / s.mass);
  keepMax((s) => s.dynamicPressure);
  keepMax((s) => (s.phase === 'boost' ? s.alpha : -Infinity));
  keepMax((s) => (falling(s) ? -Infinity : s.alpha));
  keepMax((s) => (powered(s) ? s.dynamicPressure * Math.min(s.alpha, 0.26) : -Infinity));
  keepMax((s) => (s.phase === 'rail' || powered(s) ? -s.stabilityCal : -Infinity));

  let fineStep = 0; // 0 keeps every full-resolution sample
  let coarseStep = COARSE_INTERVAL_S;
  for (;;) {
    const out: SimState[] = [];
    let lastT = -Infinity;
    for (let i = 0; i < n; i++) {
      if (must[i] || log[i].t - lastT >= (fine[i] ? fineStep : coarseStep) - 1e-6) {
        out.push(log[i]);
        lastT = log[i].t;
      }
    }
    // Past the last widening only the must-keep samples are left, a few dozen.
    if (out.length <= maxRows || coarseStep > MAX_FLIGHT_SIM_S) return out;
    // Widen coast and descent first; touch the full-resolution parts only if that is not enough.
    if (coarseStep >= 1) fineStep = fineStep === 0 ? 0.04 : fineStep * 2;
    coarseStep *= 2;
  }
}

// ---------- Flight ----------

const STEPS_PER_BUDGET_CHECK = 50;

/** One flight from ignition to landing or crash, stepped like a local createSim run. */
export function runFlightJob(job: ValidFlightJob, opts: SimJobRunOptions = {}): FlightJobResult {
  const now = opts.now ?? defaultNow;
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const start = now();
  const sim = createSim(job.rocket, job.motor, job.config, makeDeps());
  sim.ignite();
  let steps = 0;
  while (!sim.done && sim.state.t < MAX_FLIGHT_SIM_S) {
    sim.step(FLIGHT_STEP_S);
    if (++steps % STEPS_PER_BUDGET_CHECK === 0 && now() - start > budget) {
      throw new SimBudgetError(`Simulation exceeded its ${Math.round(budget / 1000)} s time budget.`);
    }
  }

  return {
    kind: 'flight',
    complete: sim.done,
    events: sim.events,
    log: { rows: thinLog(sim.log, sim.events).map(packRow) },
    durationMs: now() - start,
  };
}

// ---------- Mission ----------

/**
 * Drop samples until the record's JSON fits. The first and last samples and those next to a
 * timeline marker stay. The mission views interpolate between samples, so gaps only cost detail.
 */
export function thinRecord(record: FlightRecord, maxBytes: number = MAX_RECORD_BYTES): FlightRecord {
  let out = record;
  const all = record.samples;
  const keep = new Set<number>([0, all.length - 1]);
  let i = 0;
  for (const t of record.markers.map((m) => m.t).sort((a, b) => a - b)) {
    while (i < all.length && all[i].t < t) i++;
    if (i > 0) keep.add(i - 1);
    if (i < all.length) keep.add(i);
  }
  for (let stride = 2; stride <= 64; stride *= 2) {
    if (stringifyResult(out).length <= maxBytes) break;
    out = { ...record, samples: all.filter((_s, k) => k % stride === 0 || keep.has(k)) };
  }
  if (stringifyResult(out).length > maxBytes) throw new SimBudgetError('Record too large');
  return out;
}

/** flyMission takes about a second at most and cannot be interrupted, so there is no budget here. */
export function runMissionJob(job: ValidMissionJob, opts: SimJobRunOptions = {}): MissionJobResult {
  const now = opts.now ?? defaultNow;
  const start = now();
  const record = thinRecord(flyMission(job.mission, job.options));
  return { kind: 'mission', record, durationMs: now() - start };
}

/** Run a parsed job of any kind to completion. */
export function runAnyJob(job: AnyValidJob, opts: SimJobRunOptions = {}): AnyJobResult {
  if (job.kind === 'flight') return runFlightJob(job, opts);
  if (job.kind === 'mission') return runMissionJob(job, opts);
  return runSimJob(job, opts);
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

function isLogRow(row: unknown): boolean {
  return (
    Array.isArray(row) &&
    row.length === LOG_COLUMNS.length &&
    row.every(finite) &&
    PHASES[row[LOG_COLUMNS.length - 2] as number] !== undefined
  );
}

/** Shape check of a decoded flight response, thorough enough that replaying it cannot throw. */
export function isFlightJobResult(v: unknown): v is FlightJobResult {
  if (!isObject(v) || v.kind !== 'flight' || typeof v.complete !== 'boolean') return false;
  const events = v.events;
  if (!Array.isArray(events) || !events.every((e: unknown) => isObject(e) && finite(e.t) && typeof e.type === 'string')) {
    return false;
  }
  const rows = isObject(v.log) ? v.log.rows : undefined;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every(isLogRow)) return false;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i] as number[])[0] < (rows[i - 1] as number[])[0]) return false;
  }
  // Events are NOT required to be sorted: the sim logs maxQ after burnout when both fall in one step.
  return true;
}

/** Shape check of a decoded mission response. */
export function isMissionJobResult(v: unknown): v is MissionJobResult {
  if (!isObject(v) || v.kind !== 'mission' || !isObject(v.record)) return false;
  const r = v.record;
  // samples is empty for a vehicle that never left the pad.
  return (
    Array.isArray(r.samples) &&
    Array.isArray(r.markers) &&
    r.samples.every((s: unknown) => isObject(s) && finite(s.t)) &&
    r.markers.every((m: unknown) => isObject(m))
  );
}
