import { describe, it, expect } from 'vitest';
import { evaluateChallenges, loadCompletedChallenges, markChallengesCompleted } from './challenges';
import { findMotor } from '../ork/motors';
import type { RocketModel, SimState } from '../types';
import type { StorageLike } from './storage';

const dummyState = (over: Partial<SimState> = {}): SimState => ({
  t: 1,
  pos: [0, 0, 0],
  vel: [0, 0, 0],
  quat: [0, 0, 0, 1],
  omega: [0, 0, 0],
  phase: 'coast',
  mass: 0.08,
  altitude: 340,
  speed: 80,
  mach: 0.25,
  alpha: 0,
  dynamicPressure: 1000,
  thrust: 0,
  drag: 0,
  accelG: 1,
  cgX: 0.2,
  cpX: 0.28,
  stabilityCal: 2.0,
  chuteDeployed: false,
  ...over,
});

const dummyRocket: RocketModel = {
  name: 'Test',
  components: [],
  length: 0.4,
  maxRadius: 0.0124,
  stageCount: 1,
  warnings: [],
};

describe('builder/challenges', () => {
  it('passes c-class-300 when apogee >= 300 m, landing < 6 m/s, C motor, no critical flaws', () => {
    const c6 = findMotor({ manufacturer: 'Estes', designation: 'C6' })!;
    const results = evaluateChallenges({
      rocket: dummyRocket,
      motor: c6,
      log: [dummyState({ altitude: 320 })],
      events: [{ t: 25, type: 'landing', altitude: 0, speed: 4.5, message: 'Landed' }],
      flaws: [],
    });
    const c300 = results.find((r) => r.challenge.id === 'c-class-300')!;
    expect(c300.passed).toBe(true);

    // Fails with a D12 motor
    const d12 = findMotor({ manufacturer: 'Estes', designation: 'D12' })!;
    const resultsD = evaluateChallenges({
      rocket: dummyRocket,
      motor: d12,
      log: [dummyState({ altitude: 320 })],
      events: [{ t: 25, type: 'landing', altitude: 0, speed: 4.5, message: 'Landed' }],
      flaws: [],
    });
    expect(resultsD.find((r) => r.challenge.id === 'c-class-300')!.passed).toBe(false);
  });

  it('persists completed challenges in storage', () => {
    const map = new Map<string, string>();
    const store: StorageLike = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
    };
    expect(loadCompletedChallenges(store).size).toBe(0);
    markChallengesCompleted(['c-class-300', 'feather-touch'], store);
    const loaded = loadCompletedChallenges(store);
    expect(loaded.has('c-class-300')).toBe(true);
    expect(loaded.has('feather-touch')).toBe(true);
  });
});
