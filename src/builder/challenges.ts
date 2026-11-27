// Engineering challenges for Build Mode + automatic flight evaluation.
// Pure TypeScript — no DOM, no three.js.

import type { Flaw, FlightEvent, Motor, RocketModel, SimState } from '../types';
import type { StorageLike } from './storage';

export interface Challenge {
  id: string;
  title: string;
  description: string;
  check(ctx: ChallengeContext): { passed: boolean; reason: string };
}

export interface ChallengeContext {
  rocket: RocketModel;
  motor: Motor | null;
  log: SimState[];
  events: FlightEvent[];
  flaws: Flaw[];
}

export interface ChallengeResult {
  challenge: Challenge;
  passed: boolean;
  reason: string;
}

const COMPLETED_KEY = 'sfb.builder.challenges.v1';

function maxOf(log: SimState[], fn: (s: SimState) => number): number {
  let m = 0;
  for (const s of log) m = Math.max(m, fn(s));
  return m;
}

function landingSpeed(events: FlightEvent[]): number | null {
  const land = events.find((e) => e.type === 'landing');
  return land ? land.speed : null;
}

function hasCritical(flaws: Flaw[]): boolean {
  return flaws.some((f) => f.severity === 'critical');
}

export const CHALLENGES: readonly Challenge[] = [
  {
    id: 'c-class-300',
    title: '300 m on a C Motor',
    description: 'Reach 300 m apogee and land under 6 m/s using a C-class motor (≤ 10 N·s).',
    check({ motor, log, events, flaws }) {
      const apo = maxOf(log, (s) => s.altitude);
      const land = landingSpeed(events);
      if (!motor) return { passed: false, reason: 'No motor selected.' };
      if (motor.totalImpulse > 10.5) {
        return { passed: false, reason: `Motor impulse ${motor.totalImpulse.toFixed(1)} N·s exceeds C class (≤ 10 N·s).` };
      }
      if (hasCritical(flaws)) return { passed: false, reason: 'Flight had a critical design flaw.' };
      if (apo < 300) return { passed: false, reason: `Apogee ${apo.toFixed(0)} m (need ≥ 300 m).` };
      if (land === null || land >= 6) {
        return { passed: false, reason: land === null ? 'Did not land safely.' : `Landing ${land.toFixed(1)} m/s (need < 6 m/s).` };
      }
      return { passed: true, reason: `Reached ${apo.toFixed(0)} m and landed at ${land.toFixed(1)} m/s!` };
    },
  },
  {
    id: 'feather-touch',
    title: 'Feather Touch Recovery',
    description: 'Reach 150 m apogee and touch down at 4.0 m/s or slower with no critical flaws.',
    check({ log, events, flaws }) {
      const apo = maxOf(log, (s) => s.altitude);
      const land = landingSpeed(events);
      if (hasCritical(flaws)) return { passed: false, reason: 'Flight had a critical design flaw.' };
      if (apo < 150) return { passed: false, reason: `Apogee ${apo.toFixed(0)} m (need ≥ 150 m).` };
      if (land === null || land > 4.0) {
        return { passed: false, reason: land === null ? 'Did not land safely.' : `Landing ${land.toFixed(1)} m/s (need ≤ 4.0 m/s).` };
      }
      return { passed: true, reason: `Soft touchdown at ${land.toFixed(1)} m/s from ${apo.toFixed(0)} m!` };
    },
  },
  {
    id: 'payload-delivery',
    title: 'Payload Delivery',
    description: 'Carry at least 50 g of payload mass to 200 m and land safely under 6 m/s.',
    check({ rocket, log, events, flaws }) {
      const payloadKg = rocket.components
        .filter((c) => c.kind === 'mass')
        .reduce((s, c) => s + c.mass, 0);
      const apo = maxOf(log, (s) => s.altitude);
      const land = landingSpeed(events);
      if (payloadKg < 0.0499) {
        return { passed: false, reason: `Payload is ${(payloadKg * 1000).toFixed(0)} g (need ≥ 50 g).` };
      }
      if (hasCritical(flaws)) return { passed: false, reason: 'Flight had a critical design flaw.' };
      if (apo < 200) return { passed: false, reason: `Apogee ${apo.toFixed(0)} m (need ≥ 200 m).` };
      if (land === null || land >= 6) {
        return { passed: false, reason: land === null ? 'Did not land safely.' : `Landing ${land.toFixed(1)} m/s (need < 6 m/s).` };
      }
      return { passed: true, reason: `Delivered ${(payloadKg * 1000).toFixed(0)} g to ${apo.toFixed(0)} m!` };
    },
  },
  {
    id: 'two-stage-flight',
    title: 'Two-Stage Ascent',
    description: 'Fly a 2+ stage rocket with a decoupler to 500 m and land safely under 6 m/s.',
    check({ rocket, log, events, flaws }) {
      const apo = maxOf(log, (s) => s.altitude);
      const land = landingSpeed(events);
      const staged = events.some((e) => e.type === 'stage separation');
      if (rocket.stageCount < 2 || !staged) {
        return { passed: false, reason: 'Requires a 2+ stage rocket with stage separation.' };
      }
      if (hasCritical(flaws)) return { passed: false, reason: 'Flight had a critical design flaw.' };
      if (apo < 500) return { passed: false, reason: `Apogee ${apo.toFixed(0)} m (need ≥ 500 m).` };
      if (land === null || land >= 6) {
        return { passed: false, reason: land === null ? 'Did not land safely.' : `Landing ${land.toFixed(1)} m/s (need < 6 m/s).` };
      }
      return { passed: true, reason: `2-stage flight reached ${apo.toFixed(0)} m!` };
    },
  },
  {
    id: 'high-speed',
    title: 'Transonic Sprint',
    description: 'Reach Mach 0.7+ with a stable rocket (no critical flaws) and recover safely.',
    check({ log, events, flaws }) {
      const peakMach = maxOf(log, (s) => s.mach);
      const land = landingSpeed(events);
      if (hasCritical(flaws)) return { passed: false, reason: 'Flight had a critical design flaw.' };
      if (peakMach < 0.7) return { passed: false, reason: `Peak Mach ${peakMach.toFixed(2)} (need ≥ 0.70).` };
      if (land === null) return { passed: false, reason: 'Did not land safely.' };
      return { passed: true, reason: `Hit Mach ${peakMach.toFixed(2)} and landed safely!` };
    },
  },
];

export function evaluateChallenges(ctx: ChallengeContext): ChallengeResult[] {
  return CHALLENGES.map((challenge) => {
    const res = challenge.check(ctx);
    return { challenge, passed: res.passed, reason: res.reason };
  });
}

function resolveStorage(store?: StorageLike): StorageLike | null {
  if (store) return store;
  try {
    return typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

export function loadCompletedChallenges(store?: StorageLike): Set<string> {
  const s = resolveStorage(store);
  if (!s) return new Set();
  try {
    const raw = s.getItem(COMPLETED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function markChallengesCompleted(ids: string[], store?: StorageLike): Set<string> {
  const done = loadCompletedChallenges(store);
  for (const id of ids) done.add(id);
  const s = resolveStorage(store);
  try {
    if (s) s.setItem(COMPLETED_KEY, JSON.stringify([...done]));
  } catch {
    // Storage full or blocked: the challenge still counts for this visit.
  }
  return done;
}
