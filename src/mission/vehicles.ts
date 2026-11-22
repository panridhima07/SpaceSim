// Mission definitions for the app. Every number here is copied from
// rocket-physics/examples/lvm3-gto.ts.

import type { ReferenceEvent } from './adapter';
import {
  lvm3,
  lvm3FaultSpec,
  SITES,
  type AscentOptions,
  type Failure,
  type FaultSpec,
  type SimConfig,
  type VehicleSpec,
} from './engine';

export interface FailureCase {
  id: string;
  failures: Failure[];
  note: string;
}

export interface MissionDef {
  id: string;
  name: string;
  description: string;
  vehicle: () => VehicleSpec;
  faults?: () => FaultSpec;
  failureCases?: FailureCase[];
  config: SimConfig;
  ascent: AscentOptions;
  tMax: number;                         // s, safety limit
  reference: ReferenceEvent[];          // real-flight event times
  referenceSource: string;
}

export const MISSIONS: MissionDef[] = [
  {
    id: 'lvm3-m4',
    name: 'LVM3-M4 / Chandrayaan-3',
    description: 'LVM3-M4 launched Chandrayaan-3 from Sriharikota on 14 July 2023 into a 170 x 36 500 km transfer orbit.',
    vehicle: () => lvm3(),
    faults: () => lvm3FaultSpec(),
    failureCases: [
      {
        id: 'vikas-out',
        failures: [{ kind: 'engine-out', stage: 0, at: 200, engines: 1 }],
        note: 'One of the two Vikas engines shuts down in flight.',
      },
      {
        id: 'l110-shutdown',
        failures: [{ kind: 'stage-shutdown', stage: 0, at: 200 }],
        note: 'The liquid core stage shuts down early.',
      },
      {
        id: 'c25-shutdown',
        failures: [{ kind: 'stage-shutdown', stage: 2, at: 600 }],
        note: 'The cryogenic stage shuts down early. Comparable in kind to GSLV-F10 (2021), where the cryogenic stage failed.',
      },
      {
        id: 'fairing-stuck',
        failures: [{ kind: 'fairing-stuck' }],
        note: 'The payload fairing does not separate. Comparable in kind to PSLV-C39 (2017).',
      },
      {
        id: 'gimbal-lock',
        failures: [{ kind: 'gimbal-lock', at: 40 }],
        note: 'Thrust-vector control freezes just before max-Q.',
      },
      {
        id: 'lh2-leak',
        failures: [{ kind: 'leak', stage: 2, tank: 1, at: 320, rate: 2 }],
        note: 'The hydrogen tank leaks 2 kg/s.',
      },
    ],
    config: { site: SITES.sriharikota, epoch: new Date('2023-07-14T09:05:17Z') },
    ascent: { target: { perigeeAltitude: 170e3, apogeeAltitude: 36500e3 }, pitchKickDeg: 8 },
    tMax: 3000,
    reference: [
      { label: 'L110 ignition', pattern: /L110 core ignition/, t: 108.1 },
      { label: 'S200 separation', pattern: /S200 boosters separation/, t: 127.0 },
      { label: 'Fairing separation', pattern: /Fairing jettison/, t: 194.96 },
      { label: 'L110 separation', pattern: /L110 core separation/, t: 305.56 },
      { label: 'C25 ignition', pattern: /C25 cryogenic stage ignition/, t: 307.96 },
      { label: 'C25 cutoff', pattern: /C25 cryogenic stage cutoff/, t: 954.42 },
    ],
    referenceSource: 'Published LVM3-M4 flight events, as listed in rocket-physics/examples/lvm3-gto.ts',
  },
];

export function getMission(id: string): MissionDef | undefined {
  return MISSIONS.find((m) => m.id === id);
}
