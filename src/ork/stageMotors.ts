import type { Motor, RocketModel } from '../types';

export interface StageMotorEntry {
  motor: Motor;
  ignitionDelay?: number;
}

/**
 * Given a parsed RocketModel (with stages ordered top-to-bottom) and motors
 * chosen for its stages in top-to-bottom order (or a map by stage index),
 * returns the `stageMotors` array in firing order (booster first, sustainer last).
 */
export function buildStageMotors(
  rocket: RocketModel,
  motorsTopToBottom: (Motor | undefined)[],
  defaultIgnitionDelay = 0.5,
): StageMotorEntry[] {
  const count = rocket.stages ? rocket.stages.length : rocket.stageCount;
  const out: StageMotorEntry[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const motor = motorsTopToBottom[i];
    if (!motor) continue;
    out.push(out.length === 0 ? { motor } : { motor, ignitionDelay: defaultIgnitionDelay });
  }
  return out;
}
