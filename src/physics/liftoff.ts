// Thrust against weight at takeoff: how a rocket leaves the rail.

import { G0, type Motor, type RocketModel } from '../types';
import { thrustAt } from '../ork/motors';
import { motorCount } from './cluster';
import { massProps } from './massprops';

/** s, the stretch of the thrust curve that decides how a rocket leaves the rail. */
export const LIFTOFF_WINDOW = 0.5;
const STEP = 0.002; // s
/** Rail lug friction coefficient. Matches RAIL_FRICTION_MU in src/physics/sim.ts. */
const RAIL_FRICTION_MU = 0.25;

export interface LiftoffStats {
  /** kg at ignition. */
  mass: number;
  /** N. */
  weight: number;
  /** Mean thrust of all firing motors over the first LIFTOFF_WINDOW seconds, N. */
  thrust: number;
  /** thrust / weight. */
  twr: number;
  /** Estimated speed leaving the rail, m/s; 0 when the rocket never leaves it. Drag ignored. */
  railExitSpeed: number;
}

/**
 * `mass` is the rocket's mass at ignition (motors included), `motor` the one lighting first,
 * `count` how many of them fire. `railAngle` is the rail tilt from vertical, rad; along the rail
 * gravity is G0 cos(railAngle) and friction adds RAIL_FRICTION_MU G0 sin(railAngle).
 */
export function liftoffFrom(
  mass: number,
  motor: Motor,
  count: number,
  railLength: number,
  railAngle = 0,
): LiftoffStats {
  const window = Math.min(LIFTOFF_WINDOW, motor.burnTime);
  let impulse = 0;
  for (let t = 0; t < window; t += STEP) impulse += thrustAt(motor, t + STEP / 2) * Math.min(STEP, window - t);
  const thrust = window > 0 ? (impulse / window) * count : 0;
  const weight = mass * G0;
  const alongRail = G0 * Math.cos(railAngle) + RAIL_FRICTION_MU * G0 * Math.sin(railAngle);

  let v = 0;
  let s = 0;
  let railExitSpeed = 0;
  for (let t = 0; t < motor.burnTime; t += STEP) {
    v = Math.max(0, v + ((thrustAt(motor, t + STEP / 2) * count) / mass - alongRail) * STEP);
    s += v * STEP;
    if (s >= railLength) {
      railExitSpeed = v;
      break;
    }
  }
  return { mass, weight, thrust, twr: weight > 0 ? thrust / weight : 0, railExitSpeed };
}

/**
 * Takeoff figures for a rocket on its rail. For a staged rocket pass `stageMotors` in firing
 * order: the first one lifts everything, the others ride along as dead weight. `railAngle` is the
 * rail tilt from vertical, rad.
 */
export function liftoffStats(
  rocket: RocketModel,
  motor: Motor,
  railLength: number,
  stageMotors?: { motor: Motor }[],
  railAngle = 0,
): LiftoffStats {
  const first = stageMotors?.[0]?.motor ?? motor;
  let mass = massProps(rocket, first, 0).mass;
  (stageMotors ?? []).slice(1).forEach((stage, i) => {
    const boundary = rocket.stages?.[rocket.stages.length - 1 - i];
    if (!boundary) return;
    const above = { ...rocket, components: rocket.components.slice(0, boundary.startComponent) };
    mass += stage.motor.totalMass * motorCount(above);
  });
  return liftoffFrom(mass, first, motorCount(rocket), railLength, railAngle);
}
