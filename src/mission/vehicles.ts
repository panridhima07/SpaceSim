// Mission definitions for the app. Every number here is copied from
// rocket-physics/examples/lvm3-gto.ts.

import type { ReferenceEvent } from './adapter';
import { lvm3, SITES, type AscentOptions, type SimConfig, type VehicleSpec } from './engine';

export interface MissionDef {
  id: string;
  name: string;
  description: string;
  vehicle: () => VehicleSpec;
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
