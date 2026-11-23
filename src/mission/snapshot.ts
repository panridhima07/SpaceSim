// Interpolated flight state at any mission time t.

import { quatNormalize } from '../physics/vec';
import type { Quat, Vec3 } from '../types';
import type { FlightFault, FlightRecord, FlightSample } from './record';

export interface FlightSnapshot extends FlightSample {
  lastEvent: { label: string; t: number } | null;
  nextEvent: { label: string; t: number; in: number } | null;
  activeFaults: FlightFault[];
  worstHealth: { key: string; value: number } | null;
  iip: { latDeg: number; lonDeg: number } | null;
}

const OPTIONAL_NUMBER_KEYS = [
  'skinTemp',
  'fairingDeltaP',
  'heatFlux',
  'ambientPressure',
  'latDeg',
  'lonDeg',
  'downrange',
  'verticalSpeed',
  'pitchDeg',
  'alphaDeg',
  'apoapsis',
  'periapsis',
  'dvExpended',
] as const;

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function lerpVec3(a: Vec3, b: Vec3, f: number): Vec3 {
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

function slerpQuat(qa: Quat, qb: Quat, f: number): Quat {
  let dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  let bx = qb[0];
  let by = qb[1];
  let bz = qb[2];
  let bw = qb[3];
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (dot > 0.999999) {
    return quatNormalize([
      lerp(qa[0], bx, f),
      lerp(qa[1], by, f),
      lerp(qa[2], bz, f),
      lerp(qa[3], bw, f),
    ]);
  }
  const theta = Math.acos(Math.min(1, dot));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - f) * theta) / sinTheta;
  const wb = Math.sin(f * theta) / sinTheta;
  return quatNormalize([
    wa * qa[0] + wb * bx,
    wa * qa[1] + wb * by,
    wa * qa[2] + wb * bz,
    wa * qa[3] + wb * bw,
  ]);
}

function copySample(s: FlightSample): FlightSample {
  const out: FlightSample = {
    t: s.t,
    pos: [s.pos[0], s.pos[1], s.pos[2]],
    quat: [s.quat[0], s.quat[1], s.quat[2], s.quat[3]],
    vel: [s.vel[0], s.vel[1], s.vel[2]],
    altitude: s.altitude,
    speed: s.speed,
    mach: s.mach,
    q: s.q,
    accelG: s.accelG,
    mass: s.mass,
    thrust: s.thrust,
    stage: s.stage,
  };
  if (s.stageThrottle !== undefined) out.stageThrottle = s.stageThrottle.slice();
  if (s.propellant !== undefined) out.propellant = s.propellant.slice();
  if (s.phase !== undefined) out.phase = s.phase;
  for (const key of OPTIONAL_NUMBER_KEYS) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  if (s.health !== undefined) out.health = { ...s.health };
  if (s.payloadOffset !== undefined) out.payloadOffset = [s.payloadOffset[0], s.payloadOffset[1], s.payloadOffset[2]];
  return out;
}

function lerpArray(a: number[] | undefined, b: number[] | undefined, f: number): number[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a !== undefined && b !== undefined && a.length === b.length) {
    const out = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) out[i] = lerp(a[i], b[i], f);
    return out;
  }
  return (a ?? b)!.slice();
}

function lerpHealth(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
  f: number,
): Record<string, number> | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return { ...b };
  if (b === undefined) return { ...a };
  const out: Record<string, number> = {};
  for (const key of Object.keys(a)) {
    out[key] = key in b ? lerp(a[key], b[key], f) : a[key];
  }
  for (const key of Object.keys(b)) {
    if (!(key in out)) out[key] = b[key];
  }
  return out;
}

function interpolateSample(a: FlightSample, b: FlightSample, t: number): FlightSample {
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  const out: FlightSample = {
    t,
    pos: lerpVec3(a.pos, b.pos, f),
    quat: slerpQuat(a.quat, b.quat, f),
    vel: lerpVec3(a.vel, b.vel, f),
    altitude: lerp(a.altitude, b.altitude, f),
    speed: lerp(a.speed, b.speed, f),
    mach: lerp(a.mach, b.mach, f),
    q: lerp(a.q, b.q, f),
    accelG: lerp(a.accelG, b.accelG, f),
    mass: lerp(a.mass, b.mass, f),
    thrust: lerp(a.thrust, b.thrust, f),
    stage: a.stage,
  };
  const stageThrottle = lerpArray(a.stageThrottle, b.stageThrottle, f);
  if (stageThrottle !== undefined) out.stageThrottle = stageThrottle;
  const propellant = lerpArray(a.propellant, b.propellant, f);
  if (propellant !== undefined) out.propellant = propellant;
  if (a.phase !== undefined) out.phase = a.phase;
  for (const key of OPTIONAL_NUMBER_KEYS) {
    const va = a[key];
    const vb = b[key];
    if (va !== undefined && vb !== undefined) {
      out[key] = lerp(va, vb, f);
    } else if (va !== undefined) {
      out[key] = va;
    } else if (vb !== undefined) {
      out[key] = vb;
    }
  }
  const health = lerpHealth(a.health, b.health, f);
  if (health !== undefined) out.health = health;
  // The payload sits on the stage (offset zero) until the sample where it has left.
  if (b.payloadOffset !== undefined) out.payloadOffset = lerpVec3(a.payloadOffset ?? [0, 0, 0], b.payloadOffset, f);
  return out;
}

function findEvents(
  record: FlightRecord,
  t: number,
): { lastEvent: { label: string; t: number } | null; nextEvent: { label: string; t: number; in: number } | null } {
  let last: { label: string; t: number } | null = null;
  let next: { label: string; t: number; in: number } | null = null;
  for (let i = 0; i < record.markers.length; i++) {
    const m = record.markers[i];
    if (m.kind !== 'event') continue;
    if (m.t <= t) {
      if (last === null || m.t >= last.t) {
        last = { label: m.label, t: m.t };
      }
    } else if (next === null || m.t < next.t) {
      next = { label: m.label, t: m.t, in: m.t - t };
    }
  }
  return { lastEvent: last, nextEvent: next };
}

function findActiveFaults(record: FlightRecord, t: number): FlightFault[] {
  const faults = record.faults;
  if (!faults || faults.length === 0) return [];
  const active: FlightFault[] = [];
  for (let i = 0; i < faults.length; i++) {
    const f = faults[i];
    const lo = f.tFirst ?? f.t;
    const hi = f.tLast ?? f.t;
    if (lo <= t && t <= hi) active.push(f);
  }
  return active;
}

function findWorstHealth(health: Record<string, number> | undefined): { key: string; value: number } | null {
  if (!health) return null;
  let bestKey: string | null = null;
  let bestVal = -Infinity;
  for (const key of Object.keys(health)) {
    const v = health[key];
    if (v > bestVal) {
      bestVal = v;
      bestKey = key;
    }
  }
  return bestKey !== null ? { key: bestKey, value: bestVal } : null;
}

function findNearestIip(
  track: { t: number; latDeg: number; lonDeg: number }[] | undefined,
  t: number,
): { latDeg: number; lonDeg: number } | null {
  if (!track || track.length === 0) return null;
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const dLo = Math.abs(track[lo].t - t);
  const dHi = Math.abs(track[hi].t - t);
  const best = dLo <= dHi ? track[lo] : track[hi];
  if (Math.min(dLo, dHi) > 10) return null;
  return { latDeg: best.latDeg, lonDeg: best.lonDeg };
}

/** Return the interpolated flight state and surrounding context at mission time t. */
export function snapshotAt(record: FlightRecord, t: number): FlightSnapshot {
  const samples = record.samples;
  const n = samples.length;
  if (n === 0) {
    throw new Error('snapshotAt: cannot sample an empty FlightRecord');
  }

  let sample: FlightSample;
  if (t <= samples[0].t) {
    sample = copySample(samples[0]);
  } else if (t >= samples[n - 1].t) {
    sample = copySample(samples[n - 1]);
  } else {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid].t <= t) lo = mid;
      else hi = mid;
    }
    if (samples[lo].t === t) {
      sample = copySample(samples[lo]);
    } else if (samples[hi].t === t) {
      sample = copySample(samples[hi]);
    } else {
      sample = interpolateSample(samples[lo], samples[hi], t);
    }
  }

  const { lastEvent, nextEvent } = findEvents(record, t);
  return {
    ...sample,
    lastEvent,
    nextEvent,
    activeFaults: findActiveFaults(record, t),
    worstHealth: findWorstHealth(sample.health),
    iip: findNearestIip(record.iipTrack, t),
  };
}
