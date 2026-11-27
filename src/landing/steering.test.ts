// Pins the sign convention behind the Moon landing deck's captions (main.ts):
// W = "Pitch forward" (+pitch), D = "Roll right" (+roll), both relative to the approach track.

import { describe, expect, it } from 'vitest';
import { MU_M, R_MOON, add, cross, dot, unit } from '../lunar/core';
import { CH3 } from '../lunar/cruise';
import { LanderSim, qFromY, qrot } from '../lunar/lander';
import { createMoonEphemeris } from '../lunar/moonEphemeris';

/** An upright lander in manual flight 10 km over the Moon, with a landing site planned ahead. */
function upright(): LanderSim {
  const eph = createMoonEphemeris(2460180.5);
  const rm = eph.moonAt(0), vm = eph.moonVelAt(0), ra = R_MOON + 100e3;
  const v = Math.sqrt(MU_M * (2 / ra - 2 / (ra + R_MOON + 15e3)));
  const sim = new LanderSim(eph, { t: 0, r: add([ra, 0, 0], rm), v: add([0, v, 0], vm), a: [0, -1, 0] }, { payloadMass: CH3.landerMass, landerProp: 800 });
  expect(sim.planDescent()).not.toBeNull();
  sim.r = sim.inertialAt(0, 0, 10_000);
  sim.v = cross(sim.W, sim.r);
  sim.q = qFromY(unit(sim.r), sim.basis().E);
  sim.w = [0, 0, 0];
  sim.phase = 'TERMINAL';
  sim.mode = 'MANUAL';
  return sim;
}

/** How far the thrust axis leans forward and to the right of the approach track. */
function lean(input: { pitch: number; roll: number }): { forward: number; right: number } {
  const sim = upright();
  sim.setInput({ ...input, thr: 0 });
  sim.advance(2);
  const up = unit(sim.r), forward = sim.heading(up), axis = qrot(sim.q, [0, 1, 0]);
  return { forward: dot(axis, forward), right: dot(axis, cross(forward, up)) };
}

describe('manual steering directions', () => {
  it('positive pitch tips the thrust axis forward', () => {
    const l = lean({ pitch: 1, roll: 0 });
    expect(l.forward).toBeGreaterThan(0.1);
    expect(Math.abs(l.right)).toBeLessThan(0.01);
  });

  it('positive roll tips the thrust axis to the right', () => {
    const l = lean({ pitch: 0, roll: 1 });
    expect(l.right).toBeGreaterThan(0.1);
    expect(Math.abs(l.forward)).toBeLessThan(0.01);
  });
});
