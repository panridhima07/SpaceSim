// Reference flight timeline for LVM3-M4 carrying Chandrayaan-3 (14 July 2023).
// Values are taken from rocket-physics/README.md; unprinted fields are left undefined.

export interface FlightReferenceEvent {
  name: string;
  /** Time after liftoff, s. */
  timeS: number;
  /** Altitude above sea level, m (if published in source). */
  altitudeM?: number;
  /** Speed, m/s (if published in source). */
  velocityMS?: number;
  source: string;
}

const SOURCE = 'rocket-physics/README.md (LVM3-M4 / Chandrayaan-3 flight, 14 July 2023)';

export const LVM3_CHANDRAYAAN3_EVENTS: readonly FlightReferenceEvent[] = [
  {
    name: 'S200 separation',
    timeS: 127.0,
    source: SOURCE,
  },
  {
    name: 'Fairing separation',
    timeS: 195.0,
    source: SOURCE,
  },
  {
    name: 'L110 separation',
    timeS: 305.6,
    source: SOURCE,
  },
];
