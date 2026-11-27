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
// A slow descent from a high apogee takes many minutes, so the limit on a flight is generous
// (the loop ends at touchdown anyway). A rocket still on the pad or rail gets a short one.
const MAX_FLIGHT_S = 1800; // s of sim time before an airborne case is marked 'timeout'
const MAX_GROUND_S = 300; // s of sim time before a case that never left the ground is marked 'timeout'
const SEVERITY_RANK: Record<FlawSeverity, number> = { info: 1, warning: 2, critical: 3 };
/** Deploy speeds closer than this (m/s) count as the same. */
const DEPLOY_SPEED_TIE = 1e-6;

export interface StressProgress {
  done: number;
  total: number;
}

/** One finished flight plus the speed at parachute deployment (not part of SweepResult). */
interface CaseRun {
  result: SweepResult;
  deploySpeed: number;
}

/**
 * Outer step() calls per generator slice. One step(0.05) is up to 25 substeps of 2 ms in the
 * atmosphere, so 2 steps is about 50 substeps: roughly 1-3 ms on a slow phone.
 */
const STEPS_PER_SLICE = 2;

/** Fly one case, yielding after every STEPS_PER_SLICE sim steps so callers can budget time. */
function* runCaseSteps(
  rocket: RocketModel,
  motor: Motor,
  config: SimConfig,
  deps: PhysicsDeps,
  label: string,
  progress: StressProgress,
): Generator<StressProgress, CaseRun, undefined> {
  const sim = createSim(rocket, motor, config, deps);
  sim.ignite();
  let n = 0;
  for (;;) {
    const phase = sim.state.phase;
    const limit = phase === 'pad' || phase === 'rail' ? MAX_GROUND_S : MAX_FLIGHT_S;
    if (sim.done || sim.state.t >= limit) break;
    sim.step(STEP_S);
    if (++n % STEPS_PER_SLICE === 0) yield progress;
  }

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

function runCaseDetailed(
  rocket: RocketModel,
  motor: Motor,
  config: SimConfig,
  deps: PhysicsDeps,
  label: string,
): CaseRun {
  const gen = runCaseSteps(rocket, motor, config, deps, label, { done: 0, total: 0 });
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
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
  const speeds = delay.map((r) => r.deploySpeed).filter((v) => Number.isFinite(v));
  const delayIrrelevant =
    speeds.length === delay.length &&
    speeds.length > 1 &&
    Math.max(...speeds) - Math.min(...speeds) < DEPLOY_SPEED_TIE;
  if (bestDelay === null) {
    out.push('No tested ejection delay deploys the parachute.');
  } else if (delayIrrelevant) {
    // The parachute opens on altitude or apogee, not on the motor's ejection charge.
    out.push(
      `Ejection delay makes no difference: the parachute deploys at ${num(speeds[0], 1)} m/s with every delay tested.`,
    );
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
  if (!Number.isFinite(top.railExitSpeed)) {
    // No rail exit: the motor burned out with the rocket still on the pad or the rail. The
    // simulator ends such a flight as 'landed', but nothing flew, so there is no landing point.
    out.push(`Never left the launch rail at ${top.config.windSpeed} m/s wind.`);
  } else if (top.outcome === 'timeout') {
    // The case ran out of time, so its last position is not a landing point.
    out.push(
      `Did not land within the time limit at ${top.config.windSpeed} m/s wind; last seen ${top.drift.toFixed(0)} m from the pad.`,
    );
  } else {
    out.push(`Lands ${top.drift.toFixed(0)} m from the pad at ${top.config.windSpeed} m/s wind.`);
  }

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

  // Lowest deploy speed wins; among equal speeds, the delay closest to the one already fitted,
  // so a rocket whose delay does not matter is not told to change it.
  const current = base.ejectionDelay ?? mountMotorDelay(rocket);
  let bestDelay: number | null = null;
  let bestSpeed = Infinity;
  for (const r of delay) {
    if (!Number.isFinite(r.deploySpeed)) continue;
    const d = r.result.config.ejectionDelay ?? null;
    const better = r.deploySpeed < bestSpeed - DEPLOY_SPEED_TIE;
    const tied = !better && r.deploySpeed < bestSpeed + DEPLOY_SPEED_TIE;
    const closer =
      tied && d !== null && bestDelay !== null && current !== undefined &&
      Math.abs(d - current) < Math.abs(bestDelay - current);
    if (better || closer) {
      bestSpeed = Math.min(bestSpeed, r.deploySpeed);
      bestDelay = d;
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

  // Intra-flight slices repeat the progress of the flights already finished.
  const wind: CaseRun[] = [];
  for (const w of WIND_SPEEDS_MS) {
    wind.push(
      yield* runCaseSteps(
        rocket,
        motor,
        withSurfaceWind(base, w),
        deps,
        `Wind ${w} m/s`,
        { done, total },
      ),
    );
    yield { done: ++done, total };
  }

  const rail: CaseRun[] = [];
  for (const deg of RAIL_ANGLES_DEG) {
    rail.push(
      yield* runCaseSteps(
        rocket,
        motor,
        { ...base, railAngle: deg * RAD_PER_DEG },
        deps,
        `Rail ${deg} deg`,
        { done, total },
      ),
    );
    yield { done: ++done, total };
  }

  const delay: CaseRun[] = [];
  for (const d of EJECTION_DELAYS_S) {
    delay.push(
      yield* runCaseSteps(
        rocket,
        motor,
        { ...base, ejectionDelay: d },
        deps,
        `Delay ${d} s`,
        { done, total },
      ),
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

/** `base` at a different surface wind. Winds aloft keep their shape and scale with it. */
function withSurfaceWind(base: SimConfig, windSpeed: number): SimConfig {
  const k = base.windSpeed > 0 ? windSpeed / base.windSpeed : 0;
  const windLayers =
    base.windLayers && k > 0
      ? base.windLayers.map((l) => ({ ...l, speed: l.speed * k }))
      : undefined;
  return { ...base, windSpeed, windLayers };
}
