// Monte Carlo dispersion runner. Real launches never fly exactly the vehicle on the drawing
// board: engines deliver a few percent more or less thrust, propellant loads and dry masses
// scatter a little, the drag of the airframe is not exactly the handbook value, and the jet
// stream blows from a different direction and speed every day. This module flies the same
// ascent many times with those quantities drawn at random, so the spread of the injection
// orbit (perigee, apogee, inclination, propellant left over, peak dynamic pressure and load
// factor) can be read off as statistics instead of guessed from one nominal flight.
//
// Every run is reproducible: the same seed gives the same numbers, and run i draws from its
// own generator, so its result does not depend on how many runs were requested.

import type { AscentOptions } from '../gnc/autopilot.ts';
import { jetStreamWind } from '../env/atmosphere.ts';
import { DEFAULT_CD_TABLE } from '../aero/aero.ts';
import type { VehicleSpec } from '../vehicle/types.ts';
import { flyAscent, type FlightResult } from './report.ts';
import type { SimConfig } from './simulation.ts';

export interface DispersionSpec {
  /** 1-sigma fractional scatter of every engine's vacuum thrust (each stage drawn independently). Default 0.01. */
  thrust?: number;
  /** 1-sigma absolute scatter of vacuum Isp, seconds. Default 1. */
  isp?: number;
  /** 1-sigma fractional scatter of each stage's dry mass. Default 0.005. */
  dryMass?: number;
  /** 1-sigma fractional scatter of each tank's loaded propellant. Default 0.002. */
  propellant?: number;
  /** 1-sigma fractional scatter of the drag coefficient table. Default 0.05. */
  drag?: number;
  /** 1-sigma jet-stream speed, m/s (direction uniform over the compass). 0 turns wind off. Default 20. */
  wind?: number;
}

export interface DispersionOptions {
  runs: number;
  /** Seed for the whole campaign. Default 1. */
  seed?: number;
  spec?: DispersionSpec;
  /** Simulated time limit per flight, s. Default 6000. */
  tMax?: number;
  /** Called after each flight with its index and full result (for logging or plotting). */
  onRun?: (index: number, result: FlightResult) => void;
}

export interface Stat {
  mean: number;
  std: number;
  min: number;
  max: number;
  p05: number;
  p50: number;
  p95: number;
}

export interface DispersionRun {
  index: number;
  reachedTarget: boolean;
  perigeeAltitude: number;
  apogeeAltitude: number;
  inclinationDeg: number;
  propellantMargin: number;
  maxQ: number;
  maxG: number;
}

export interface DispersionResult {
  runs: DispersionRun[];
  successRate: number;
  perigeeAltitude: Stat;
  apogeeAltitude: Stat;
  inclinationDeg: Stat;
  propellantMargin: Stat;
  maxQ: Stat;
  maxG: Stat;
}

const DEFAULTS: Required<DispersionSpec> = {
  thrust: 0.01,
  isp: 1,
  dryMass: 0.005,
  propellant: 0.002,
  drag: 0.05,
  wind: 20,
};

/** Seeded uniform generator on [0, 1) (Mulberry32). The same seed always gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal deviate by the Box-Muller transform (one of each pair is used). */
export function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A perturbed copy of the vehicle. The input is never modified. Thrust and Isp are scaled
 * per engine (the Isp sea-level ratio is kept), dry mass per stage, propellant per tank, and
 * the drag table by one common factor.
 */
export function perturbVehicle(vehicle: VehicleSpec, spec: DispersionSpec, rand: () => number): VehicleSpec {
  const s: Required<DispersionSpec> = { ...DEFAULTS, ...definedOnly(spec) };
  const v: VehicleSpec = structuredClone(vehicle);

  for (const stage of v.stages) {
    const e = stage.engine;
    const thrustFactor = Math.max(0, 1 + s.thrust * gaussian(rand));
    e.thrustVac *= thrustFactor;

    const oldIsp = e.ispVac;
    const newIsp = oldIsp + s.isp * gaussian(rand);
    e.ispVac = newIsp;
    if (e.ispSL !== undefined) e.ispSL = e.ispSL * (newIsp / oldIsp);

    stage.dryMass *= Math.max(0, 1 + s.dryMass * gaussian(rand));

    for (const tank of stage.tanks) {
      tank.propellantMass *= Math.max(0, 1 + s.propellant * gaussian(rand));
    }
  }

  const dragFactor = Math.max(0, 1 + s.drag * gaussian(rand));
  const table = v.aero?.cdTable ?? DEFAULT_CD_TABLE;
  const scaled = table.map(([mach, cd]): [number, number] => [mach, cd * dragFactor]);
  v.aero = { ...v.aero, cdTable: scaled };

  return v;
}

/** Summary statistics. std is the sample standard deviation; percentiles interpolate linearly. */
export function summarize(values: number[]): Stat {
  const n = values.length;
  if (n === 0) return { mean: NaN, std: NaN, min: NaN, max: NaN, p05: NaN, p50: NaN, p95: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const x of sorted) sum += x;
  const mean = sum / n;
  let ss = 0;
  for (const x of sorted) ss += (x - mean) * (x - mean);
  const std = n < 2 ? 0 : Math.sqrt(ss / (n - 1));
  const pct = (q: number): number => {
    const pos = q * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  return { mean, std, min: sorted[0], max: sorted[n - 1], p05: pct(0.05), p50: pct(0.5), p95: pct(0.95) };
}

/**
 * Fly the ascent `mc.runs` times, each with a freshly built and perturbed vehicle and, unless
 * the caller set one, a random jet-stream wind. makeVehicle is a factory because fault
 * injection mutates a VehicleSpec, so no spec may be shared between flights.
 */
export function runDispersions(
  makeVehicle: () => VehicleSpec,
  cfg: SimConfig,
  opts: AscentOptions,
  mc: DispersionOptions,
): DispersionResult {
  const seed = mc.seed ?? 1;
  const spec: Required<DispersionSpec> = { ...DEFAULTS, ...definedOnly(mc.spec ?? {}) };
  const tMax = mc.tMax ?? 6000;
  const runs: DispersionRun[] = [];

  for (let i = 0; i < mc.runs; i++) {
    const rand = mulberry32((seed + Math.imul(0x9e3779b9, i + 1)) | 0);
    const vehicle = perturbVehicle(makeVehicle(), spec, rand);

    // Wind is drawn every run so that the vehicle draws are the same whatever the wind setting.
    const windSpeed = Math.abs(spec.wind * gaussian(rand));
    const towardDeg = 360 * rand();
    const runCfg: SimConfig =
      cfg.wind !== undefined || spec.wind === 0
        ? cfg
        : { ...cfg, wind: jetStreamWind({ jetSpeed: windSpeed, towardDeg, surfaceSpeed: 0.25 * windSpeed }) };

    const res = flyAscent(vehicle, runCfg, structuredClone(opts), tMax);
    runs.push({
      index: i,
      reachedTarget: res.reachedTarget,
      perigeeAltitude: res.perigeeAltitude,
      apogeeAltitude: res.apogeeAltitude,
      inclinationDeg: res.inclinationDeg,
      propellantMargin: res.propellantMargin,
      maxQ: res.sim.maxQ.value,
      maxG: res.sim.maxG.value,
    });
    mc.onRun?.(i, res);
  }

  const pick = (f: (r: DispersionRun) => number): number[] => runs.map(f);
  const hits = runs.filter((r) => r.reachedTarget).length;
  return {
    runs,
    successRate: runs.length ? hits / runs.length : NaN,
    perigeeAltitude: summarize(pick((r) => r.perigeeAltitude)),
    apogeeAltitude: summarize(pick((r) => r.apogeeAltitude)),
    inclinationDeg: summarize(pick((r) => r.inclinationDeg)),
    propellantMargin: summarize(pick((r) => r.propellantMargin)),
    maxQ: summarize(pick((r) => r.maxQ)),
    maxG: summarize(pick((r) => r.maxG)),
  };
}

/** Drop keys that are explicitly undefined so they do not overwrite the defaults. */
function definedOnly(spec: DispersionSpec): DispersionSpec {
  const out: DispersionSpec = {};
  for (const k of Object.keys(spec) as (keyof DispersionSpec)[]) {
    if (spec[k] !== undefined) out[k] = spec[k];
  }
  return out;
}
