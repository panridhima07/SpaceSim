import { describe, it, expect } from 'vitest';
import { parseOrkFile } from './parser';
import { buildStageMotors } from './stageMotors';
import type { Motor } from '../types';

const NODE_FS = 'node:fs';
const NODE_URL = 'node:url';
const fsMod = (await import(/* @vite-ignore */ NODE_FS)) as unknown as {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
};
const { fileURLToPath } = (await import(/* @vite-ignore */ NODE_URL)) as unknown as {
  fileURLToPath(u: URL): string;
};

const TWO_STAGE = fileURLToPath(
  new URL('../../fixtures/external/Two_stage_high_power_rocket.ork', import.meta.url),
);
const THREE_STAGE = fileURLToPath(
  new URL('../../fixtures/external/Three_stage_low_power_rocket.ork', import.meta.url),
);

function dummyMotor(name: string): Motor {
  return {
    manufacturer: 'Test',
    designation: name,
    diameter: 0.018,
    length: 0.07,
    totalMass: 0.024,
    propellantMass: 0.012,
    burnTime: 1.5,
    totalImpulse: 10,
    approximate: true,
    curve: [[0, 0], [0.1, 10], [1.5, 0]],
  };
}

describe.skipIf(!fsMod.existsSync(TWO_STAGE) || !fsMod.existsSync(THREE_STAGE))(
  'buildStageMotors',
  () => {
    it('returns motors in firing order (booster first, sustainer last) for 2-stage and 3-stage rockets', async () => {
      const twoModel = await parseOrkFile(fsMod.readFileSync(TWO_STAGE));
      const mTwo = buildStageMotors(twoModel, [dummyMotor('S1'), dummyMotor('S2')], 1.0);
      expect(mTwo.map((e) => e.motor.designation)).toEqual(['S2', 'S1']);
      expect(mTwo[0].ignitionDelay).toBeUndefined();
      expect(mTwo[1].ignitionDelay).toBe(1.0);

      const threeModel = await parseOrkFile(fsMod.readFileSync(THREE_STAGE));
      const mThree = buildStageMotors(
        threeModel,
        [dummyMotor('S1'), dummyMotor('S2'), dummyMotor('S3')],
        0.5,
      );
      expect(mThree.map((e) => e.motor.designation)).toEqual(['S3', 'S2', 'S1']);
    });
  },
);
