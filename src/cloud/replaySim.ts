// Plays a flight the server computed back on the app clock, behind the same Sim interface a live
// createSim run has: step() moves the clock, the state is interpolated from the log, and events and
// log samples appear as their time passes. Pure TypeScript.

import type { FlightEvent, Quat, Sim, SimState, Vec3 } from '../types';
import { unpackLog, type FlightJobResult } from './simJob';

const EPS = 1e-6; // s; log times are rounded to a microsecond on the wire

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function lerpVec(a: Vec3, b: Vec3, f: number): Vec3 {
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

/** Normalised linear interpolation along the shorter arc. */
function nlerp(a: Quat, b: Quat, f: number): Quat {
  const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q: Quat = [
    lerp(a[0], sign * b[0], f),
    lerp(a[1], sign * b[1], f),
    lerp(a[2], sign * b[2], f),
    lerp(a[3], sign * b[3], f),
  ];
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 0)) return [a[0], a[1], a[2], a[3]];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Continuous values are interpolated; phase and parachute state stay those of the earlier sample. */
function between(a: SimState, b: SimState, t: number): SimState {
  const span = b.t - a.t;
  const f = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
  return {
    t,
    pos: lerpVec(a.pos, b.pos, f),
    vel: lerpVec(a.vel, b.vel, f),
    quat: nlerp(a.quat, b.quat, f),
    omega: lerpVec(a.omega, b.omega, f),
    phase: a.phase,
    mass: lerp(a.mass, b.mass, f),
    altitude: lerp(a.altitude, b.altitude, f),
    speed: lerp(a.speed, b.speed, f),
    airspeed: lerp(a.airspeed ?? a.speed, b.airspeed ?? b.speed, f),
    mach: lerp(a.mach, b.mach, f),
    alpha: lerp(a.alpha, b.alpha, f),
    dynamicPressure: lerp(a.dynamicPressure, b.dynamicPressure, f),
    thrust: lerp(a.thrust, b.thrust, f),
    drag: lerp(a.drag, b.drag, f),
    accelG: lerp(a.accelG, b.accelG, f),
    cgX: lerp(a.cgX, b.cgX, f),
    cpX: lerp(a.cpX, b.cpX, f),
    stabilityCal: lerp(a.stabilityCal, b.stabilityCal, f),
    chuteDeployed: a.chuteDeployed,
  };
}

export function replaySim(result: FlightJobResult): Sim {
  const samples = unpackLog(result.log);
  if (samples.length === 0) throw new Error('The flight log is empty.');
  const source = result.events;
  const tEnd = source.reduce((m, e) => Math.max(m, e.t), samples[samples.length - 1].t);

  // Like createSim: one state object that is updated in place, and a log that starts with the pad.
  const state: SimState = { ...samples[0] };
  const events: FlightEvent[] = [];
  const log: SimState[] = [samples[0]];
  let clock = 0;
  let ignited = false;
  let done = false;

  /** Reveal everything up to the clock. Events keep their order, so a later-listed one waits its turn. */
  function reveal(): void {
    while (log.length < samples.length && samples[log.length].t <= clock + EPS) log.push(samples[log.length]);
    while (events.length < source.length && source[events.length].t <= clock + EPS) events.push(source[events.length]);
  }

  function ignite(): void {
    if (ignited || done) return;
    ignited = true;
    reveal();
    Object.assign(state, log[log.length - 1], { t: clock });
  }

  function step(dt: number): void {
    // The recorded flight starts at ignition, so nothing moves before it.
    if (!ignited || done || !(dt > 0)) return;
    clock += dt;
    if (clock >= tEnd - EPS) {
      clock = tEnd;
      done = true;
    }
    reveal();
    const at = log[log.length - 1];
    const next = samples[log.length];
    Object.assign(state, next ? between(at, next, clock) : at);
  }

  return {
    get state() {
      return state;
    },
    get events() {
      return events;
    },
    get log() {
      return log;
    },
    get done() {
      return done;
    },
    ignite,
    step,
    // A recorded flight cannot be flown by hand.
    deployChutes: () => false,
    separateStage: () => false,
  };
}
