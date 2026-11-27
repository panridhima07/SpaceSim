// Thrust against weight at takeoff: motor counting, staging mass, weak motors.
import { describe, expect, it } from 'vitest';
import type { InnerTube, Motor, RocketModel, SimConfig } from '../types';
import { atmosphere } from './atmosphere';
import { massProps } from './massprops';
import { aeroProps } from './aero';
import { thrustAt } from '../ork/motors';
import { FIXTURE_MOTOR, FIXTURE_ROCKET } from './fixture';
import { createSim } from './sim';
import { motorCount } from './cluster';
import { liftoffFrom, liftoffStats } from './liftoff';

const DEPS = { atmosphere, massProps, aeroProps, thrust: thrustAt };
const CONFIG: SimConfig = {
  railLength: 1, railAngle: 0, railAzimuth: 0, windSpeed: 0, windDirection: 0, gust: 0, launchAltitude: 0,
};

const withMount = (change: Partial<InnerTube>): RocketModel => ({
  ...FIXTURE_ROCKET,
  components: FIXTURE_ROCKET.components.map((c) =>
    c.kind === 'innertube' && c.isMotorMount ? { ...c, ...change } : c,
  ),
});
const CLUSTER = withMount({ cluster: [[-0.012, 0], [0.012, 0], [0, 0.02]] });
const HEAVY: RocketModel = {
  ...FIXTURE_ROCKET,
  components: [
    ...FIXTURE_ROCKET.components,
    { kind: 'mass', id: 'ballast', name: 'Ballast', x: 0.2, length: 0.02, density: 0, mass: 3 },
  ],
};

function flight(rocket: RocketModel, motor: Motor = FIXTURE_MOTOR, seconds = 60) {
  const sim = createSim(rocket, motor, CONFIG, DEPS);
  sim.ignite();
  for (let i = 0; i < seconds * 20 && !sim.done; i++) sim.step(0.05);
  return sim;
}

describe('motor count', () => {
  it('is one for a single mount', () => {
    expect(motorCount(FIXTURE_ROCKET)).toBe(1);
  });
  it('counts every tube of a cluster', () => {
    expect(motorCount(CLUSTER)).toBe(3);
  });
  it('gives a cluster the thrust and the motor mass of all its motors', () => {
    const one = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, 0).mass;
    const bare = massProps(FIXTURE_ROCKET, null, 0).mass;
    const three = massProps(CLUSTER, FIXTURE_MOTOR, 0).mass;
    expect(three - massProps(CLUSTER, null, 0).mass).toBeCloseTo(3 * (one - bare), 9);
    const a = createSim(FIXTURE_ROCKET, FIXTURE_MOTOR, CONFIG, DEPS);
    const b = createSim(CLUSTER, FIXTURE_MOTOR, CONFIG, DEPS);
    for (const s of [a, b]) { s.ignite(); s.step(0.2); }
    expect(b.state.thrust).toBeCloseTo(3 * a.state.thrust, 6);
  });
});

describe('liftoff stats', () => {
  it('uses the thrust of the first half second, not the spike', () => {
    const s = liftoffStats(FIXTURE_ROCKET, FIXTURE_MOTOR, 1);
    const weight = massProps(FIXTURE_ROCKET, FIXTURE_MOTOR, 0).mass * 9.80665;
    expect(s.weight).toBeCloseTo(weight, 6);
    expect(s.thrust).toBeLessThan(14);
    expect(s.thrust).toBeGreaterThan(5);
    expect(s.twr).toBeCloseTo(s.thrust / s.weight, 9);
  });
  it('predicts the rail exit speed the simulator then reaches', () => {
    const predicted = liftoffStats(FIXTURE_ROCKET, FIXTURE_MOTOR, 1).railExitSpeed;
    const actual = flight(FIXTURE_ROCKET).events.find((e) => e.type === 'railExit')!.speed;
    expect(Math.abs(predicted - actual) / actual).toBeLessThan(0.1);
  });
  it('reports no rail exit for a rocket too heavy to leave', () => {
    const s = liftoffStats(HEAVY, FIXTURE_MOTOR, 1);
    expect(s.twr).toBeLessThan(1);
    expect(s.railExitSpeed).toBe(0);
  });
});

describe('rail tilt and friction', () => {
  it('a 20 degree rail exits slower than vertical, matching the tilted-rail formula', () => {
    // Constant 9.9 N on 0.5 kg for 5 s, so the rail is cleared well inside the burn.
    const motor: Motor = { ...FIXTURE_MOTOR, curve: [[0, 9.9], [5, 9.9], [5, 0]] as Motor['curve'], burnTime: 5 };
    const mass = 0.5;
    const L = 2;
    const tilt = (20 * Math.PI) / 180;
    const vertical = liftoffFrom(mass, motor, 1, L).railExitSpeed;
    const tilted = liftoffFrom(mass, motor, 1, L, tilt).railExitSpeed;
    // Net acceleration along the rail is T/m - G0 (cos + 0.25 sin); v^2 = 2 a L.
    const aTilt = 9.9 / mass - 9.80665 * (Math.cos(tilt) + 0.25 * Math.sin(tilt));
    expect(tilted).toBeLessThan(vertical);
    expect(Math.abs(tilted - Math.sqrt(2 * aTilt * L)) / Math.sqrt(2 * aTilt * L)).toBeLessThan(0.005);
  });
});

describe('flights that cannot leave', () => {
  it('ends after burnout with the rocket still on the pad', () => {
    const sim = flight(HEAVY);
    expect(sim.done).toBe(true);
    expect(sim.state.phase).toBe('landed');
    expect(sim.events.some((e) => e.type === 'liftoff')).toBe(false);
  });
  it('reads 1 g while it sits on the pad', () => {
    const sim = createSim(HEAVY, FIXTURE_MOTOR, CONFIG, DEPS);
    expect(sim.state.accelG).toBeCloseTo(1, 6);
    sim.ignite();
    sim.step(0.5);
    expect(sim.state.accelG).toBeCloseTo(1, 6);
  });
});

describe('staged rockets', () => {
  const body = (id: string, x: number): RocketModel['components'][number] =>
    ({ kind: 'bodytube', id, name: id, x, length: 0.2, density: 600, outerRadius: 0.0125, thickness: 0.001 });
  const mount = (id: string, x: number): InnerTube => ({
    kind: 'innertube', id, name: id, x, length: 0.07, density: 600, outerRadius: 0.0095, thickness: 0.0005,
    isMotorMount: true, overhang: 0,
  });
  const STAGED: RocketModel = {
    name: 'Two stages', length: 0.4, maxRadius: 0.0125, stageCount: 2, warnings: [],
    components: [body('upper', 0), mount('upper-mount', 0.13), body('lower', 0.2), mount('lower-mount', 0.33)],
    stages: [
      { name: 'Sustainer', startComponent: 0, componentCount: 2 },
      { name: 'Booster', startComponent: 2, componentCount: 2 },
    ],
  };
  const stageMotors = [{ motor: FIXTURE_MOTOR }, { motor: FIXTURE_MOTOR }];

  it('carries the unlit upper motor in its own mount, not at mid-length', () => {
    const sim = createSim(STAGED, FIXTURE_MOTOR, { ...CONFIG, stageMotors }, DEPS);
    // The booster's motor in its mount, plus the sustainer's centred in the mount 0.13 to 0.20 m.
    const lower = massProps(STAGED, FIXTURE_MOTOR, -1);
    const m = FIXTURE_MOTOR.totalMass;
    const expected = (lower.mass * lower.cgX + m * (0.2 - FIXTURE_MOTOR.length / 2)) / (lower.mass + m);
    expect(sim.state.cgX).toBeCloseTo(expected, 9);
    expect(sim.state.mass).toBeCloseTo(lower.mass + m, 9);
  });
});
