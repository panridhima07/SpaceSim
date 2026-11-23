// Falcon 9 Block 5 launching Starlink Group 6-1 from Cape Canaveral SLC-40 on 27 February 2023.
// Sources are listed next to each number. Anything without a source is marked "assumed".

import type { ReferenceEvent } from '../adapter';
import { SITES, type Failure } from '../engine';
import { falcon9Block5 } from '../../../rocket-physics/src/vehicle/falcon9.ts';
import type { FailureCase, MissionDef } from '../vehicles';

/**
 * The payload facts. Group 6-1 is the first flight of the second-generation "V2 Mini"
 * satellites. The 16 000 kg payload mass is from the Everyday Astronaut flight page
 * (https://everydayastronaut.com/falcon-9-block-5-starlink-group-6-1/). The per-satellite
 * mass is that total divided by 21. It is not a published per-satellite figure, so it is
 * assumed, and it includes the dispenser.
 * realDeployT is the planned deployment time (T+1:04:36) from the SpaceX press kit
 * (https://sky-brokers.com/wp-content/uploads/2025/09/Starlink-74-Group-6.1-Press-Kit.pdf).
 * The press kit is a pre-flight document, so this time is not confirmed by the flight.
 */
export const STARLINK_PAYLOAD = {
  label: 'Starlink V2 Mini, Group 6-1',
  count: 21,
  unitMass: 762, // assumed: 16 000 kg / 21, including the dispenser share
  realDeployT: 3876, // s after liftoff, planned T+1:04:36 in the press kit; not confirmed
  note:
    'Twenty-one second-generation Starlink V2 Mini satellites on a single dispenser stack. ' +
    'The first flight of the V2 Mini design, released as a group into a 365 x 373 km orbit at 43 degrees.',
};

const TOTAL_PAYLOAD_MASS = 16000; // kg, Everyday Astronaut flight page

const failureCases: FailureCase[] = [
  {
    id: 'merlin-out-stage1',
    failures: [{ kind: 'engine-out', stage: 0, at: 60, engines: 1 }] as Failure[],
    note: 'One of the nine first-stage Merlin 1D engines shuts down at T+60 s. The other eight burn on.',
  },
  {
    id: 's2-early-shutdown',
    failures: [{ kind: 'stage-shutdown', stage: 1, at: 400 }] as Failure[],
    note: 'The Merlin Vacuum shuts down early, at T+400 s, before the injection burn is complete.',
  },
  {
    id: 'fairing-stuck',
    failures: [{ kind: 'fairing-stuck' }] as Failure[],
    note: 'The fairing does not separate, so the stack carries the fairing mass to orbit.',
  },
];

export const STARLINK_MISSION: MissionDef = {
  id: 'falcon9-starlink',
  name: 'Falcon 9 Block 5 / Starlink Group 6-1',
  description:
    'Falcon 9 Block 5 launched 21 Starlink V2 Mini satellites from Cape Canaveral SLC-40 on 27 February 2023 into a 365 x 373 km orbit at 43 degrees.',
  vehicle: () => falcon9Block5(TOTAL_PAYLOAD_MASS),
  failureCases,
  config: { site: SITES.capeCanaveral, epoch: new Date('2023-02-27T23:13:00Z') }, // assumed seconds: the minute is from Everyday Astronaut
  // Target from the Everyday Astronaut flight page ("373 km x 365 km at 43 degrees").
  // Southward: the south-east azimuth for 43 degrees, as flown from the Cape.
  ascent: {
    target: { perigeeAltitude: 365e3, apogeeAltitude: 373e3, inclinationDeg: 43, southward: true },
    pitchKickDeg: 8,
  },
  tMax: 3000,
  // Times are the planned timeline from the SpaceX press kit. The press kit is pre-flight and
  // says "all times approximate", so these are planned values, not flown ones.
  reference: [
    { label: 'Stage 1 MECO', pattern: /Stage 1 burnout/, t: 146 },
    { label: 'Stage 1 separation', pattern: /Stage 1 separation/, t: 150 },
    { label: 'Stage 2 ignition', pattern: /Stage 2 ignition/, t: 157 },
    { label: 'Stage 2 cutoff', pattern: /Stage 2 cutoff/, t: 517 },
  ] as ReferenceEvent[],
  referenceSource:
    'Planned times from the SpaceX Starlink Group 6-1 press kit (MECO T+2:26, stage separation T+2:30, SES-1 T+2:37, SECO-1 T+8:37); pre-flight, not flown times.',
  payload: {
    label: 'Starlink stack',
    deployAfter: 20,
    springSpeed: 0.5, // assumed
    watch: 60,
    look: 'stack',
    count: STARLINK_PAYLOAD.count,
    note:
      'The simulator releases the stack 20 s after orbit insertion. The real flight coasts for about an hour first; the press kit plans release at T+1:04:36.',
  },
};
