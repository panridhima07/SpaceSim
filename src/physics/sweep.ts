// Headless stress test: many complete flights over wind speed, rail tilt and ejection delay.
// Pure TypeScript with no DOM and no three.js, so it runs in the browser and under vitest.

import {
  R_EARTH,
  type Component,
  type FlawSeverity,
  type InnerTube,
  type Motor,
  type PhysicsDeps,
  type RocketModel,
  type SimConfig,
  type StressReport,
  type SweepResult,
  type Vec3,
} from '../types';
import { createSim } from './sim';
import { analyzeFlight } from './flaws';

export const WIND_SPEEDS_MS = [0, 2, 4, 6, 8, 10, 12];
export const RAIL_ANGLES_DEG = [0, 5, 10, 15, 20];
export const EJECTION_DELAYS_S = [2, 3, 4, 5, 6, 7, 8];
/** Total number of flights in one stress test. */
export const STRESS_FLIGHT_COUNT =
  WIND_SPEEDS_MS.length + RAIL_ANGLES_DEG.length + EJECTION_DELAYS_S.length;

const RAD_PER_DEG = Math.PI / 180;
const DEG_PER_RAD = 180 / Math.PI;
const STEP_S = 0.05; // s of sim time per step() call
const MAX_FLIGHT_S = 300; // s of sim time before a case is marked 'timeout'
const SEVERITY_RANK: Record<FlawSeverity, number> = { info: 1, warning: 2, critical: 3 };

export interface StressProgress {
  done: number;
  total: number;
}

/** One finished flight plus the speed at parachute deployment (not part of SweepResult). */
interface CaseRun {
  result: SweepResult;
  deploySpeed: number;
}

function runCaseDetailed(
  rocket: RocketModel,
  motor: Motor,
  config: SimConfig,
  deps: PhysicsDeps,
  label: string,
): CaseRun {
  const sim = createSim(rocket, motor, config, deps);
  sim.ignite();
  while (!sim.done && sim.state.t < MAX_FLIGHT_S) sim.step(STEP_S);

  const { log, events } = sim;
  let apogee = 0;
  let maxSpeed = 0;
  let maxAlpha = 0;
  for (const s of log) {
    if (s.altitude > apogee) apogee = s.altitude;
    if (s.speed > maxSpeed) maxSpeed = s.speed;
    if (s.phase === 'boost' && s.alpha > maxAlpha) maxAlpha = s.alpha;
  }

  const railExit = events.find((e) => e.type === 'railExit');
  const touchdown = events.find((e) => e.type === 'landing' || e.type === 'crash');
  const chute = events.find((e) => e.type === 'chuteDeploy');

  // Horizontal distance of the final position from the pad. Unknown values are NaN.
  const pad: Vec3 = [0, R_EARTH + config.launchAltitude, 0];
  const end = sim.state.pos;
  const drift = Math.hypot(end[0] - pad[0], end[2] - pad[2]);

  const flaws = analyzeFlight(sim, rocket, motor, config);
  let worst: SweepResult['worst'] = 'ok';
  for (const f of flaws) {
    if (worst === 'ok' || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }

  const outcome: SweepResult['outcome'] = !sim.done
    ? 'timeout'
    : sim.state.phase === 'crashed'
      ? 'crashed'
      : 'landed';

  const result: SweepResult = {
    label,
    config: { ...config },
    apogee,
    maxSpeed,
    railExitSpeed: railExit ? railExit.speed : NaN,
    landingSpeed: touchdown ? touchdown.speed : NaN,
    drift,
    maxAlpha,
    outcome,
    flaws,
    worst,
  };
  return { result, deploySpeed: chute ? chute.speed : NaN };
}

/** Fly one configuration and summarise it. */
export function runCase(
  rocket: RocketModel,
  motor: Motor,
  config: SimConfig,
  deps: PhysicsDeps,
  label: string,
): SweepResult {
  return runCaseDetailed(rocket, motor, config, deps, label).result;
}

/** Ejection delay the motor-mount motor carries, or undefined. */
function mountMotorDelay(rocket: RocketModel): number | undefined {
  const tubes = rocket.components.filter(
    (c: Component): c is InnerTube => c.kind === 'innertube',
  );
  const mount = tubes.find((t) => t.isMotorMount && t.motor) ?? tubes.find((t) => t.motor);
  const d = mount?.motor?.delay;
  return d !== undefined && Number.isFinite(d) ? d : undefined;
}

function num(v: number, digits: number): string {
  return Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

function degrees(rad: number): string {
  return String(Math.round(rad * DEG_PER_RAD));
}

/** Title of the most severe flaw (flaws are sorted worst first), or a fallback. */
function topFlawTitle(r: SweepResult): string {
  return r.flaws[0]?.title ?? 'no flaws';
}

function summarize(
  rocket: RocketModel,
  base: SimConfig,
  wind: SweepResult[],
  rail: SweepResult[],
  delay: CaseRun[],
  maxSafeWind: number | null,
  bestDelay: number | null,
): string[] {
  const out: string[] = [];
  const calm = wind[0];
  const top = wind[wind.length - 1];

  // Wind limit, most important.
  if (maxSafeWind === null) {
    out.push(`Unsafe even in calm air (${topFlawTitle(calm).toLowerCase()}).`);
  } else {
    const next = wind.find((r) => r.config.windSpeed > maxSafeWind);
    if (next) {
      out.push(
        `Safe to fly up to ${maxSafeWind} m/s wind; at ${next.config.windSpeed} m/s it leaves the rail at ${num(next.railExitSpeed, 1)} m/s and weathercocks ${degrees(next.maxAlpha)} deg.`,
      );
    } else {
      out.push(`Safe to fly up to ${maxSafeWind} m/s wind, the highest speed tested.`);
    }
  }

  // Ejection delay.
  if (bestDelay === null) {
    out.push('No tested ejection delay deploys the parachute.');
  } else {
    const best = delay.find((r) => r.result.config.ejectionDelay === bestDelay);
    if (best) {
      out.push(
        `Best ejection delay is ${bestDelay} s (deploys at ${num(best.deploySpeed, 1)} m/s).`,
      );
    }
    const current = base.ejectionDelay ?? mountMotorDelay(rocket);
    if (current !== undefined && current !== bestDelay) {
      const cur = delay.find((r) => Math.abs((r.result.config.ejectionDelay ?? NaN) - current) < 1e-6);
      if (cur) {
        out.push(
          `The current ${current} s delay deploys at ${num(cur.deploySpeed, 1)} m/s.`,
        );
      }
    }
  }

  // Apogee and drift at the strongest wind tested.
  if (calm.apogee > top.apogee) {
    out.push(
      `Apogee falls from ${calm.apogee.toFixed(0)} m in calm air to ${top.apogee.toFixed(0)} m at ${top.config.windSpeed} m/s wind.`,
    );
  } else {
    out.push(
      `Apogee is ${calm.apogee.toFixed(0)} m in calm air and ${top.apogee.toFixed(0)} m at ${top.config.windSpeed} m/s wind.`,
    );
  }
  out.push(`Lands ${top.drift.toFixed(0)} m from the pad at ${top.config.windSpeed} m/s wind.`);

  // Rail tilt.
  const badRail = rail.find((r) => r.worst === 'critical');
  if (badRail) {
    out.push(
      `A rail tilt of ${degrees(badRail.config.railAngle)} deg triggers "${topFlawTitle(badRail)}".`,
    );
  } else {
    const last = rail[rail.length - 1];
    out.push(
      `Rail tilts up to ${degrees(last.config.railAngle)} deg have no critical flaws.`,
    );
  }

  return out.slice(0, 6);
}

function buildReport(
  rocket: RocketModel,
  base: SimConfig,
  wind: CaseRun[],
  rail: CaseRun[],
  delay: CaseRun[],
): StressReport {
  const windR = wind.map((r) => r.result);
  const railR = rail.map((r) => r.result);

  // Winds are tested in ascending order; stop at the first critical one.
  let maxSafeWind: number | null = null;
  for (const r of windR) {
    if (r.worst === 'critical') break;
    maxSafeWind = r.config.windSpeed;
  }

  let bestDelay: number | null = null;
  let bestSpeed = Infinity;
  for (const r of delay) {
    if (Number.isFinite(r.deploySpeed) && r.deploySpeed < bestSpeed) {
      bestSpeed = r.deploySpeed;
      bestDelay = r.result.config.ejectionDelay ?? null;
    }
  }

  const delayR = delay.map((r) => r.result);
  return {
    wind: windR,
    railAngle: railR,
    delay: delayR,
    maxSafeWind,
    bestDelay,
    summary: summarize(rocket, base, windR, railR, delay, maxSafeWind, bestDelay),
  };
}

/**
 * The stress test as a generator: one flight per step, yielding progress after each.
 * Returns the report when every case is done.
 */
export function* stressTestSteps(
  rocket: RocketModel,
  motor: Motor,
  base: SimConfig,
  deps: PhysicsDeps,
): Generator<StressProgress, StressReport, undefined> {
  const total = STRESS_FLIGHT_COUNT;
  let done = 0;

  const wind: CaseRun[] = [];
  for (const w of WIND_SPEEDS_MS) {
    wind.push(runCaseDetailed(rocket, motor, { ...base, windSpeed: w }, deps, `Wind ${w} m/s`));
    yield { done: ++done, total };
  }

  const rail: CaseRun[] = [];
  for (const deg of RAIL_ANGLES_DEG) {
    rail.push(
      runCaseDetailed(
        rocket,
        motor,
        { ...base, railAngle: deg * RAD_PER_DEG },
        deps,
        `Rail ${deg} deg`,
      ),
    );
    yield { done: ++done, total };
  }

  const delay: CaseRun[] = [];
  for (const d of EJECTION_DELAYS_S) {
    delay.push(
      runCaseDetailed(rocket, motor, { ...base, ejectionDelay: d }, deps, `Delay ${d} s`),
    );
    yield { done: ++done, total };
  }

  return buildReport(rocket, base, wind, rail, delay);
}

/** Run the whole stress test synchronously. */
export function stressTest(
  rocket: RocketModel,
  motor: Motor,
  base: SimConfig,
  deps: PhysicsDeps,
): StressReport {
  const steps = stressTestSteps(rocket, motor, base, deps);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}
