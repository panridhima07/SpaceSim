// PSLV-C61 / EOS-09: the planned flight and the real failure, both flown on the same
// simulator. Sources and the status of each number are in the comments below.

import { pslvXL } from '../../../rocket-physics/src/vehicle/pslv.ts';
import { SITES } from '../engine';
import type { MissionDef, MissionPayload } from '../vehicles';

/** EOS-09 launch mass, kg, from ISRO's PSLV-C61 / EOS-09 mission page (launch mass 1696.24 kg). */
const EOS09_MASS = 1696.24;

/**
 * Liftoff: 18 May 2025, 05:59 IST (ISRO mission page; Wikipedia PSLV-C61 article), which is
 * 00:29 UTC on 18 May 2025 (IST is UTC+5:30). Seconds are not published, so :00 is used.
 */
const LIFTOFF_UTC = new Date('2025-05-18T00:29:00Z');

export const EOS09_PAYLOAD = {
  label: 'EOS-09',
  count: 1,
  unitMass: EOS09_MASS,
  /** Planned separation time, s after liftoff. Not found in any source, so null. */
  realDeployT: null as number | null,
  note:
    'EOS-09 (RISAT-1B), a C-band synthetic aperture radar satellite, 1696.24 kg at launch (ISRO). ' +
    'The planned separation time is not published in the sources used, so it is not shown as a reference. ' +
    'The separation time and spring speed in the simulation are assumed.',
};

const PAYLOAD: MissionPayload = {
  label: EOS09_PAYLOAD.label,
  deployAfter: 30, // assumed: seconds after PS4 cutoff in orbit before the satellite is released
  springSpeed: 0.5, // assumed: typical spring-separation speed, m/s
  watch: 60,
  look: 'satellite',
  count: 1,
  note: EOS09_PAYLOAD.note,
};

export const EOS09_MISSION: MissionDef = {
  id: 'pslv-c61',
  name: 'PSLV-C61 / EOS-09',
  description:
    'PSLV-XL flight C61 launched the EOS-09 radar satellite from Sriharikota on 18 May 2025 (05:59 IST) for a ' +
    'sun-synchronous orbit. PS3 lost chamber pressure in flight and the satellite did not reach orbit.',
  vehicle: () => pslvXL(EOS09_MASS),
  failureCases: [
    {
      id: 'ps3-pressure-loss',
      // The real anomaly: the third stage (PS3, a solid) lost chamber pressure about six minutes
      // after liftoff, mid-burn, and did not deliver its planned impulse (ISRO chairman, via
      // Tribune and Satnews; the "six minutes" figure is from ISRO-quoted reports, not telemetry).
      // The simulator cannot stop a solid motor (stage-shutdown is refused for solids), so this
      // case uses a propellant "leak" that drains the PS3 grain in a few seconds. It cuts thrust
      // at the right time and stops the burn, but the mechanism is a different one: the real
      // motor lost pressure and thrust fell away, rather than losing propellant.
      failures: [{ kind: 'leak', stage: 4, tank: 0, at: 360, rate: 5000 }],
      note:
        'What really happened: PS1 and PS2 performed normally; PS3 lit, and about six minutes after liftoff its ' +
        'chamber pressure fell, so the stage could not finish its burn. The satellite was not delivered to orbit. ' +
        'This case approximates it by draining PS3 propellant at 360 s after liftoff, which ends the burn at once. ' +
        'The simulator cannot reproduce the pressure drop itself, because solid motors cannot be throttled or shut down.',
    },
    {
      id: 'ps2-shutdown',
      failures: [{ kind: 'stage-shutdown', stage: 3, at: 200 }],
      note: 'Plausible case, not a real event: the PS2 Vikas stage shuts down early, at 200 s after liftoff.',
    },
    {
      id: 'fairing-stuck',
      failures: [{ kind: 'fairing-stuck' }],
      note: 'Plausible case, not a real event: the 3.2 m payload fairing does not separate.',
    },
  ],
  payload: PAYLOAD,
  config: { site: SITES.sriharikota, epoch: LIFTOFF_UTC },
  // Target: the sun-synchronous orbit ISRO planned (Wikipedia: 529 km altitude, 97.6 degrees
  // inclination, 140 degree azimuth). ISRO itself says "about 500 km". The simulator does not
  // model the real dog-leg turn that PSLV flies to keep the track clear of Sri Lanka, so the
  // flight is straight south of east.
  ascent: {
    target: { perigeeAltitude: 529e3, apogeeAltitude: 529e3, inclinationDeg: 97.6, southward: true },
    // Tuned by sweeping the kick on the simulator: 0 to 1 degrees miss the orbit (suborbital),
    // 6 to 16 degrees all insert. 9 degrees is used.
    pitchKickDeg: 9,
  },
  tMax: 3000,
  reference: [
    // Times from Telangana Today's report on the flight (planned vs actual). Only the planned
    // values are used here.
    { label: 'PS1 separation', pattern: /PS1 \(S139\) separation/, t: 111.64 },
    { label: 'PS2 ignition', pattern: /PS2 \(Vikas\) ignition/, t: 111.84 },
    { label: 'PS2 separation', pattern: /PS2 \(Vikas\) separation/, t: 264.34 },
  ],
  referenceSource:
    'Planned PS1 separation, PS2 ignition and PS2 separation from Telangana Today ' +
    '(https://www.telanganatoday.com/faulty-isro-pslv-rocket-fails-to-deliver-earth-observation-satellite-in-orbit); ' +
    'orbit and stage data from Wikipedia (PSLV-C61 and PSLV articles); liftoff time and mass from ISRO (https://www.isro.gov.in/Mission_PSLV_C61_EOS_09.html).',
};
