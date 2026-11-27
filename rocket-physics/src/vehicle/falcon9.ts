// Falcon 9 Block 5, expendable configuration, with rounded public figures. These are not
// manufacturer data. Where a number is not published it is marked "assumed".

import { DEG } from '../constants.ts';
import type { VehicleSpec } from './types.ts';

/**
 * Falcon 9 Block 5: nine Merlin 1D engines on the first stage, one Merlin Vacuum on the
 * second, 3.66 m diameter, 5.2 m fairing.
 *
 * Sources for the figures (see the Starlink mission file for the flight itself):
 *   - propellant, dry mass, stage length, diameter, payload to LEO: Wikipedia, "Falcon 9 Block 5"
 *   - thrust: Wikipedia (981 kN Block 5 Merlin Vacuum, 7 607 kN first-stage total); Merlin 1D vacuum
 *     914 kN and Isp 311 s / 282 s SL from the Spaceflight 101 Falcon 9 pages
 *   - fairing diameter 5.2 m: Wikipedia; fairing mass, length and payload envelope: assumed
 *
 * The real booster shuts its engines down early, around T+2:26 on a Starlink flight, and
 * keeps propellant to fly back and land. The simulator does not fly the landing. The
 * `residualFraction` below is the unburned share that the real booster lands with, and it
 * is tuned so that main engine cutoff falls near the real time. The landing itself is not
 * simulated.
 */
export function falcon9Block5(payloadMass: number): VehicleSpec {
  return {
    name: 'Falcon 9 Block 5',
    stages: [
      {
        name: 'Stage 1',
        // Empty mass per Wikipedia (22 200 kg). Includes the nine engines and the structure.
        dryMass: 22200,
        length: 42.6,
        radius: 1.83,
        tanks: [
          // RP-1 123 500 kg and LOX 287 400 kg, Wikipedia tank capacities (410 900 kg in all).
          // Flow shares follow the propellant mass split.
          { name: 'RP-1', propellantMass: 123500, bottom: 3, length: 12, flowFraction: 0.3005 },
          { name: 'LOX', propellantMass: 287400, bottom: 16, length: 24, flowFraction: 0.6995 },
        ],
        engine: {
          name: 'Merlin 1D',
          thrustVac: 914e3,
          ispVac: 311,
          ispSL: 282,
          minThrottle: 0.57,
          maxGimbal: 5 * DEG,
          gimbalRate: 20 * DEG,
          spoolTime: 2,
        },
        engineCount: 9,
        // Tuned, not published: the share of stage-1 propellant left unburned at cutoff, which
        // a real Block 5 booster keeps for its boostback and landing burns. The landing itself
        // is not simulated. 0.035 puts MECO at about T+2:25, against the real T+2:26.
        residualFraction: 0.035,
        separationDelay: 3,
      },
      {
        name: 'Stage 2',
        // Empty mass per Wikipedia (4 000 kg). Propellant: LOX 75 200 kg and RP-1 32 300 kg.
        dryMass: 4000,
        length: 12.6,
        radius: 1.83,
        tanks: [
          { name: 'RP-1', propellantMass: 32300, bottom: 2, length: 3.2, flowFraction: 0.3005 },
          { name: 'LOX', propellantMass: 75200, bottom: 5.6, length: 7, flowFraction: 0.6995 },
        ],
        engine: {
          name: 'Merlin Vacuum',
          thrustVac: 981e3,
          ispVac: 348,
          exitArea: 6,
          minThrottle: 0.39,
          maxGimbal: 5 * DEG,
          gimbalRate: 20 * DEG,
          spoolTime: 1.5,
          ignitions: 4,
        },
        engineCount: 1,
        ignitionDelay: 8,
        rcsTorque: 4000,
      },
    ],
    // The payload is the whole Starlink stack, passed in by the caller.
    // Envelope length and radius are assumed.
    payload: { mass: payloadMass, length: 4, radius: 1.8 },
    // Fairing diameter 5.2 m (Wikipedia). Length and mass are assumed.
    fairing: { mass: 1900, length: 13.1, radius: 2.6 },
  };
}
