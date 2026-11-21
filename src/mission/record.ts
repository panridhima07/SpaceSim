import type { Quat, Vec3 } from '../types';

export interface FlightSample {
  t: number;              // s since liftoff
  pos: Vec3;              // app frame, metres, Earth-centred
  quat: Quat;             // app convention, body +Y is the nose
  vel: Vec3;              // app frame, m/s
  altitude: number; speed: number; mach: number; q: number;
  accelG: number; mass: number; thrust: number;
  stage: number;          // index of the active stage
}

export interface FlightMarker {  // an event or a flaw, shown on the timeline
  t: number; kind: 'event' | 'flaw'; label: string;
  severity?: 'info' | 'warning' | 'critical';
  reference?: number;     // real-flight time for the same event, if known
}

export interface FlightRecord {
  source: 'design' | 'mission';
  samples: FlightSample[]; markers: FlightMarker[];
  orbit?: { apoapsis: number; periapsis: number; inclinationDeg: number };
}
