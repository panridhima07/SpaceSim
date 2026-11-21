// Reference launch vehicles. The numbers are rounded public figures, good enough to
// reproduce the real vehicles' performance to within several percent. They are not
// manufacturer data.

import { DEG } from '../constants.ts';
import { solidReferenceThrust } from '../propulsion/engine.ts';
import type { VehicleSpec } from './types.ts';

/**
 * A two-stage kerosene / liquid-oxygen launcher in the Falcon 9 class (expendable):
 * nine gas-generator engines on the first stage, one vacuum engine on the second.
 */
export function twoStageKerolox(payloadMass = 15000): VehicleSpec {
  return {
    name: 'Two-stage kerolox launcher (Falcon 9 class)',
    stages: [
      {
        name: 'Stage 1',
        dryMass: 25600,
        length: 44,
        radius: 1.83,
        tanks: [
          { name: 'RP-1', propellantMass: 117800, bottom: 3, length: 12, flowFraction: 0.2977 },
          { name: 'LOX', propellantMass: 277900, bottom: 16, length: 24, flowFraction: 0.7023 },
        ],
        engine: {
          name: 'Merlin 1D class',
          thrustVac: 914e3,
          ispVac: 311,
          ispSL: 282,
          minThrottle: 0.57,
          maxGimbal: 5 * DEG,
          gimbalRate: 20 * DEG,
          spoolTime: 2,
        },
        engineCount: 9,
        separationDelay: 3,
      },
      {
        name: 'Stage 2',
        dryMass: 4000,
        length: 13.8,
        radius: 1.83,
        tanks: [
          { name: 'RP-1', propellantMass: 32000, bottom: 2, length: 3.2, flowFraction: 0.2977 },
          { name: 'LOX', propellantMass: 75500, bottom: 5.6, length: 7, flowFraction: 0.7023 },
        ],
        engine: {
          name: 'Merlin Vacuum class',
          thrustVac: 934e3,
          ispVac: 348,
          exitArea: 6,
          minThrottle: 0.39,
          maxGimbal: 5 * DEG,
          gimbalRate: 20 * DEG,
          spoolTime: 1.5,
          ignitions: 4,
        },
        engineCount: 1,
        ignitionDelay: 5,
        rcsTorque: 4000,
      },
    ],
    payload: { mass: payloadMass, length: 6, radius: 2 },
    fairing: { mass: 1900, length: 13.1, radius: 2.6 },
  };
}

// Shape of the S200 thrust history: fast rise, long regressive burn, sharp tail-off.
const S200_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.4, 0.9],
  [3, 1],
  [20, 0.98],
  [50, 0.92],
  [80, 0.8],
  [100, 0.68],
  [112, 0.55],
  [118, 0.25],
  [123, 0],
];

/**
 * ISRO's LVM3 (GSLV Mk III): two S200 solid strap-ons, the L110 storable liquid core
 * that lights in flight, and the C25 hydrogen / oxygen upper stage. The default payload
 * is the Chandrayaan-3 stack (3900 kg), which flew to a 170 x 36 500 km transfer orbit.
 */
export function lvm3(payloadMass = 3900): VehicleSpec {
  const s200Propellant = 205000;
  return {
    name: 'LVM3',
    stages: [
      {
        name: 'L110 core',
        dryMass: 10000,
        length: 21.4,
        radius: 2,
        tanks: [
          { name: 'UH25', propellantMass: 41000, bottom: 2.5, length: 7, flowFraction: 0.3707 },
          { name: 'N2O4', propellantMass: 69500, bottom: 10.5, length: 8.5, flowFraction: 0.6293 },
        ],
        engine: { name: 'Vikas', thrustVac: 799e3, ispVac: 293, ispSL: 262, maxGimbal: 6 * DEG, gimbalRate: 15 * DEG, spoolTime: 1.5 },
        engineCount: 2,
        ignition: { afterLiftoff: 108 },
        separationDelay: 1,
      },
      {
        name: 'S200 boosters',
        dryMass: 31000,
        length: 25,
        radius: 1.6,
        tanks: [{ name: 'HTPB', kind: 'solid', propellantMass: s200Propellant, bottom: 1.5, length: 21, radius: 1.5, flowFraction: 1 }],
        engine: {
          name: 'S200',
          thrustVac: solidReferenceThrust(S200_CURVE, s200Propellant, 274.5),
          ispVac: 274.5,
          ispSL: 227,
          maxGimbal: 7.8 * DEG,
          gimbalRate: 10 * DEG,
          thrustCurve: S200_CURVE,
        },
        engineCount: 1,
        residualFraction: 0,
        parallel: { count: 2, radialOffset: 3.6, attachStation: 0 },
        separationDelay: 4,
      },
      {
        name: 'C25 cryogenic stage',
        dryMass: 5000,
        length: 13.5,
        radius: 2,
        tanks: [
          { name: 'LOX', propellantMass: 23400, bottom: 1, length: 2.5, flowFraction: 0.8357 },
          { name: 'LH2', propellantMass: 4600, bottom: 4.2, length: 8, flowFraction: 0.1643 },
        ],
        engine: { name: 'CE-20', thrustVac: 186.4e3, ispVac: 442, exitArea: 1.8, maxGimbal: 4 * DEG, gimbalRate: 10 * DEG, spoolTime: 2.5, ignitions: 2 },
        engineCount: 1,
        ignitionDelay: 2.4,
        rcsTorque: 3000,
      },
    ],
    payload: { mass: payloadMass, length: 4, radius: 1.8 },
    fairing: { mass: 1800, length: 10.7, radius: 2.5 },
  };
}
