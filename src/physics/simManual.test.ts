// Hand-flown flights: throttle, steering, manual parachute and staging.
import { describe, expect, it } from 'vitest';
import type { Controls, Sim, SimConfig, Vec3 } from '../types';
import { atmosphere } from './atmosphere';
import { massProps } from './massprops';
import { aeroProps } from './aero';
import { thrustAt } from '../ork/motors';
import { FIXTURE_MOTOR, FIXTURE_ROCKET } from './fixture';
import { createSim } from './sim';
import { quatRotate } from './vec';

const DEPS = { atmosphere, massProps, aeroProps, thrust: thrustAt };
const CONFIG: SimConfig = {
  railLength: 1, railAngle: 0, railAzimuth: 0, windSpeed: 0, windDirection: 0, gust: 0, launchAltitude: 0,
};
const HOLD: Vec3 = [0, 0, 0];
const ctl = (over: Partial<Controls> = {}): Controls => ({ gimbalPitch: 0, gimbalYaw: 0, ...over });

function flying(): Sim {
  const sim = createSim(FIXTURE_ROCKET, FIXTURE_MOTOR, CONFIG, DEPS);
  sim.ignite();
  return sim;
}
function fly(sim: Sim, seconds: number, controls?: Controls): void {
  const n = Math.round(seconds / 0.05);
  for (let i = 0; i < n && !sim.done; i++) sim.step(0.05, controls);
}
function finish(sim: Sim, controls?: Controls): void {
  for (let i = 0; i < 4000 && !sim.done; i++) sim.step(0.5, controls);
}
const nose = (sim: Sim): Vec3 => quatRotate(sim.state.quat, [0, 1, 0]);
const time = (sim: Sim, type: string): number => {
  const e = sim.events.find((x) => x.type === type);
  if (!e) throw new Error(`missing event ${type}`);
  return e.t;
};

describe('manual flight', () => {
  it('flies exactly as before at full throttle with no steering, until recovery', () => {
    // The two part ways only where the automatic flight fires its ejection charge and parachute.
    const whole = flying();
    finish(whole);
    const recoveryT = Math.min(
      ...whole.events.filter((e) => e.type === 'ejection' || e.type === 'chuteDeploy').map((e) => e.t),
    );
    expect(recoveryT).toBeGreaterThan(time(whole, 'burnout'));
    const auto = flying();
    const manual = flying();
    while (auto.state.t < recoveryT - 0.1) {
      auto.step(0.05);
      manual.step(0.05, ctl({ throttle: 1 }));
    }
    expect(manual.state.t).toBe(auto.state.t);
    expect(manual.state.pos).toEqual(auto.state.pos);
    expect(manual.events.map((e) => [e.type, e.t])).toEqual(auto.events.map((e) => [e.type, e.t]));
  });

  it('burns the same propellant more slowly at part throttle', () => {
    const full = flying();
    const half = flying();
    fly(full, 0.5, ctl({ throttle: 1 }));
    fly(half, 1, ctl({ throttle: 0.5 }));
    // Same burn-clock position, so the same mass is left.
    expect(half.state.mass).toBeCloseTo(full.state.mass, 6);
    expect(half.state.thrust).toBeCloseTo(full.state.thrust * 0.5, 2);
    finish(full, ctl({ throttle: 1 }));
    finish(half, ctl({ throttle: 0.75 }));
    expect(time(half, 'burnout')).toBeGreaterThan(time(full, 'burnout') + 0.4);
  });

  it('stays on the pad with the engine off, burning nothing', () => {
    const sim = flying();
    const mass = sim.state.mass;
    fly(sim, 3, ctl({ throttle: 0 }));
    expect(sim.state.phase).toBe('pad');
    expect(sim.state.thrust).toBe(0);
    expect(sim.state.mass).toBeCloseTo(mass, 9);
    fly(sim, 0.5, ctl({ throttle: 1 }));
    expect(['rail', 'boost']).toContain(sim.state.phase);
  });

  it('ends the flight if the motor burns out on the pad', () => {
    const sim = flying();
    finish(sim, ctl({ throttle: 0.02 }));
    expect(sim.done).toBe(true);
    expect(sim.state.phase).toBe('landed');
    expect(sim.events.some((e) => e.type === 'liftoff')).toBe(false);
    expect(sim.events.some((e) => e.type === 'burnout')).toBe(true);
  });

  it('shuts the engine down in flight and relights it', () => {
    const sim = flying();
    fly(sim, 0.6, ctl({ throttle: 1 }));
    const mass = sim.state.mass;
    fly(sim, 0.8, ctl({ throttle: 0 }));
    expect(sim.state.thrust).toBe(0);
    expect(sim.state.mass).toBeCloseTo(mass, 9);
    fly(sim, 0.2, ctl({ throttle: 1 }));
    expect(sim.state.thrust).toBeGreaterThan(0);
    expect(sim.events.some((e) => e.type === 'burnout')).toBe(false);
  });

  it('turns the nose at the commanded rate and holds it when the command returns to zero', () => {
    const sim = flying();
    fly(sim, 0.4, ctl({ throttle: 1, rate: HOLD }));
    // Rotation about +Z carries the nose from +Y toward -X.
    fly(sim, 0.5, ctl({ throttle: 1, rate: [0, 0, 0.8] }));
    const tilted = nose(sim);
    expect(tilted[0]).toBeLessThan(-0.25);
    expect(Math.abs(tilted[2])).toBeLessThan(0.05);
    fly(sim, 0.9, ctl({ throttle: 1, rate: HOLD }));
    const settled = nose(sim);
    fly(sim, 0.3, ctl({ throttle: 1, rate: HOLD }));
    expect(nose(sim)[0]).toBeCloseTo(settled[0], 2);
    expect(Math.hypot(...sim.state.omega)).toBeLessThan(0.05);
  });

  it('steers while coasting, with no thrust', () => {
    const sim = flying();
    fly(sim, 2.2, ctl({ throttle: 1, rate: HOLD }));
    expect(sim.state.thrust).toBe(0);
    const before = nose(sim);
    fly(sim, 0.5, ctl({ rate: [0, 0, 1] }));
    expect(nose(sim)[0]).toBeLessThan(before[0] - 0.25);
  });

  it('fires the parachute on demand, cutting the engine', () => {
    const sim = flying();
    expect(sim.deployChutes()).toBe(false); // still on the pad
    fly(sim, 0.8, ctl({ throttle: 1 }));
    expect(sim.deployChutes()).toBe(true);
    expect(sim.state.chuteDeployed).toBe(true);
    expect(sim.deployChutes()).toBe(false);
    fly(sim, 0.2, ctl({ throttle: 1 }));
    expect(sim.state.thrust).toBe(0);
    expect(sim.state.phase).toBe('descent');
    expect(sim.events.filter((e) => e.type === 'chuteDeploy')).toHaveLength(1);
  });

  it('never opens the parachute on its own when hand-flown', () => {
    const auto = flying();
    finish(auto);
    expect(auto.events.some((e) => e.type === 'chuteDeploy')).toBe(true);

    const sim = flying();
    finish(sim, ctl({ throttle: 1, rate: HOLD }));
    expect(sim.done).toBe(true);
    expect(sim.state.chuteDeployed).toBe(false);
    expect(sim.events.some((e) => e.type === 'chuteDeploy' || e.type === 'ejection')).toBe(false);
  });

  it('still opens it from the pilot after apogee', () => {
    const sim = flying();
    for (let i = 0; i < 4000 && !sim.events.some((e) => e.type === 'apogee'); i++) {
      sim.step(0.05, ctl({ throttle: 1, rate: HOLD }));
    }
    fly(sim, 1, ctl({ rate: HOLD }));
    expect(sim.state.chuteDeployed).toBe(false);
    expect(sim.deployChutes()).toBe(true);
    expect(sim.state.phase).toBe('descent');
  });

  it('has no stage to drop on a single-stage rocket', () => {
    const sim = flying();
    fly(sim, 0.8, ctl({ throttle: 1 }));
    expect(sim.separateStage()).toBe(false);
  });

  it('refuses manual actions on a flight that was never hand-flown', () => {
    const sim = flying();
    fly(sim, 0.8);
    expect(sim.deployChutes()).toBe(false);
  });
});
