import type { Quat, Vec3 } from '../types';

export interface FlightSample {
  t: number;              // s since liftoff
  pos: Vec3;              // app frame, metres, Earth-centred
  quat: Quat;             // app convention, body +Y is the nose
  vel: Vec3;              // app frame, m/s
  altitude: number; speed: number; mach: number; q: number;
  accelG: number; mass: number; thrust: number;
  stage: number;          // index of the active stage
  stageThrottle?: number[];   // one entry per vehicle stage, 0..1; 0 when the engine is off or the stage is gone
  skinTemp?: number;          // K
  fairingDeltaP?: number;     // Pa
  heatFlux?: number;          // W/m^2
  ambientPressure?: number;   // Pa
  latDeg?: number;
  lonDeg?: number;
  downrange?: number;         // m
  verticalSpeed?: number;     // m/s
  pitchDeg?: number;
  alphaDeg?: number;
  apoapsis?: number;          // m above equatorial radius
  periapsis?: number;         // m above equatorial radius
  dvExpended?: number;        // m/s
  phase?: string;             // autopilot phase string
  propellant?: number[];      // kg remaining per vehicle stage, 0 once gone
  health?: Record<string, number>;
  /** After payload separation: payload position minus vehicle position, app frame, metres. */
  payloadOffset?: Vec3;
}

export interface FlightMarker {  // an event or a flaw, shown on the timeline
  t: number; kind: 'event' | 'flaw'; label: string;
  severity?: 'info' | 'warning' | 'critical';
  reference?: number;     // real-flight time for the same event, if known
}

export interface FlightFault {
  id: string;
  system: 'pressure' | 'thermal' | 'structure' | 'propulsion';
  severity: 'info' | 'warning' | 'critical';
  stage?: number;
  t: number;
  tFirst?: number;
  tLast?: number;
  value: number;
  limit: number;
  unit: string;
  title: string;
  detail: string;
  fix: string;
}

export type FlightOutcomeKind = 'nominal' | 'degraded-orbit' | 'suborbital' | 'impact' | 'breakup' | 'pad-abort';

export interface FlightOutcome {
  outcome: FlightOutcomeKind;
  summary: string;
  perigeeAltitude: number;
  apogeeAltitude: number;
  apogeeShortfall: number;
  impact: { latDeg: number; lonDeg: number; t: number } | null;
}

export interface FlightRecord {
  source: 'design' | 'mission';
  samples: FlightSample[]; markers: FlightMarker[];
  orbit?: { apoapsis: number; periapsis: number; inclinationDeg: number };
  vehicleName?: string;
  /** Seconds since liftoff when each stage separated, same index as the vehicle's stages; null if it never did. */
  stageSeparation?: (number | null)[];
  /** Seconds since liftoff when the fairing was jettisoned; null if never or if there is none. */
  fairingSeparation?: number | null;
  /** Earth rotation: angle (rad) of the prime meridian from the inertial X axis at liftoff, and rate (rad/s). */
  earth?: { angleAtLiftoff: number; rate: number };
  reachedTarget?: boolean;
  /** Seconds since liftoff when the payload left the upper stage; null or absent if it never did. */
  payloadSeparation?: number | null;
  faults?: FlightFault[];
  scenario?: string;
  epochJD?: number;
  liftoffSimTime?: number;
  healthPeaks?: { key: string; value: number; t: number }[];
  iipTrack?: { t: number; latDeg: number; lonDeg: number }[];
  outcome?: FlightOutcome;
  failureCase?: string;
}
