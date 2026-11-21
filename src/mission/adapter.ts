// Frame adapter between the physics library and the app.
//
// Quaternion orders found:
//   rocket-physics/src/math/vec.ts: [x, y, z, w], rotating BODY vectors into the
//     WORLD frame. Body +X points along the nose, world is ECI (Z-up).
//   src/physics/vec.ts:            [x, y, z, w], rotating BODY vectors into the
//     WORLD frame. Body +Y points along the nose, world is app Y-up.
//
// eciToApp is the active rotation about X by -90 degrees, [x, y, z] -> [x, z, -y],
// whose quaternion is Cq = [-sqrt(1/2), 0, 0, sqrt(1/2)].
// The app body frame is the library body frame turned -90 degrees about Z, so
// Bq = [0, 0, -sqrt(1/2), sqrt(1/2)] maps app body vectors to library body vectors.
// The attitude therefore converts as qApp = Cq * q * Bq.

import { quatMul } from '../physics/vec';
import type { Quat, Vec3 } from '../types';
import type { Simulation } from './engine';
import type { FlightMarker, FlightSample } from './record';

export interface ReferenceEvent { label: string; pattern: RegExp; t: number }  // t = real-flight seconds after liftoff

const SQRT_HALF = Math.SQRT1_2;
const ECI_TO_APP: Quat = [-SQRT_HALF, 0, 0, SQRT_HALF];
const APP_BODY_TO_LIB_BODY: Quat = [0, 0, -SQRT_HALF, SQRT_HALF];

/** Earth-centred inertial (Z-up) to the app world frame (Y-up). */
export function eciToApp(v: Vec3): Vec3 {
  return [v[0], v[2], -v[1]];
}

/** App world frame (Y-up) to Earth-centred inertial (Z-up). */
export function appToEci(v: Vec3): Vec3 {
  return [v[0], -v[2], v[1]];
}

/** Library attitude (body +X nose, body-to-ECI) to app attitude (body +Y nose, body-to-app). */
export function attitudeToApp(q: Quat): Quat {
  return quatMul(quatMul(ECI_TO_APP, q), APP_BODY_TO_LIB_BODY);
}

/** Convert library flight events into timeline markers, attaching real-flight reference times. */
export function toMarkers(
  events: ReadonlyArray<{ t: number; type: string; message: string }>,
  liftoffTime: number,
  reference: ReadonlyArray<ReferenceEvent> = [],
): FlightMarker[] {
  const used = new Set<number>();
  return events.map((e) => {
    const severity: FlightMarker['severity'] =
      e.type === 'abort' || e.type === 'impact' || e.type === 'failure' || e.type === 'breakup' ? 'critical'
        : e.type === 'warning' ? 'warning'
          : 'info';
    const marker: FlightMarker = {
      t: e.t - liftoffTime,
      kind: 'event',
      label: e.message,
      severity,
    };
    const idx = reference.findIndex((r, i) => !used.has(i) && r.pattern.test(e.message));
    if (idx >= 0) {
      used.add(idx);
      marker.reference = reference[idx].t;
    }
    return marker;
  });
}

/** Fill a flight sample from a library simulation at its current state. */
export function toSample(sim: Simulation): FlightSample {
  const tm = sim.telemetry();
  const core = sim.lowestCore();
  const propellant: number[] = [];
  let off = 0;
  for (let i = 0; i < sim.vehicle.stages.length; i++) {
    const nTanks = sim.vehicle.stages[i].tanks.length;
    if (!sim.rt.stages[i].attached) {
      propellant.push(0);
    } else {
      let sum = 0;
      for (let k = 0; k < nTanks; k++) sum += sim.prop[off + k];
      propellant.push(sum);
    }
    off += nTanks;
  }
  return {
    // missionTime is NaN before liftoff, so fall back to elapsed pad time.
    t: Number.isFinite(sim.missionTime) ? sim.missionTime : sim.t,
    pos: eciToApp(sim.r),
    quat: attitudeToApp(sim.q),
    vel: eciToApp(sim.v),
    altitude: tm.altitude,
    speed: tm.speed,
    mach: tm.mach,
    q: tm.q,
    accelG: tm.accelG,
    mass: tm.mass,
    thrust: tm.thrust,
    stage: core >= 0 ? core : Math.max(0, sim.vehicle.stages.length - 1),
    latDeg: tm.latDeg,
    lonDeg: tm.lonDeg,
    downrange: tm.downrange,
    verticalSpeed: tm.verticalSpeed,
    pitchDeg: tm.pitchDeg,
    alphaDeg: tm.alphaDeg,
    apoapsis: tm.apoapsis,
    periapsis: tm.periapsis,
    dvExpended: sim.dvExpended,
    propellant,
  };
}
