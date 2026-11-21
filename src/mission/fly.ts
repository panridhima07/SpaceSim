// Fly a mission definition and record the whole flight as plain data.

import { toMarkers, toSample } from './adapter';
import { AscentAutopilot, OMEGA_EARTH, RE, Simulation } from './engine';
import type { FlightRecord, FlightSample } from './record';
import type { MissionDef } from './vehicles';

export interface FlyOptions { sampleInterval?: number }   // s, default 0.5

/** Fly a mission under its ascent autopilot and return the recorded flight. */
export function flyMission(def: MissionDef, opts: FlyOptions = {}): FlightRecord {
  const sampleInterval = opts.sampleInterval ?? 0.5;
  const autopilot = new AscentAutopilot(def.ascent);
  const sim = new Simulation(def.vehicle(), def.config, autopilot);

  const samples: FlightSample[] = [];
  const stageSeparation: (number | null)[] = sim.rt.stages.map(() => null);
  let fairingSeparation: number | null = null;
  let priorAttached = sim.rt.stages.map((st) => st.attached);
  let priorFairing = sim.rt.fairingAttached;

  while (!sim.ended && autopilot.phase !== 'done' && autopilot.phase !== 'aborted' && sim.t < def.tMax) {
    sim.step(sampleInterval);

    // A part that was attached before this step and is gone now separated inside it.
    sim.rt.stages.forEach((st, i) => {
      if (priorAttached[i] && !st.attached && Number.isFinite(sim.missionTime)) {
        stageSeparation[i] = sim.missionTime;
      }
      priorAttached[i] = st.attached;
    });
    if (priorFairing && !sim.rt.fairingAttached && Number.isFinite(sim.missionTime)) {
      fairingSeparation = sim.missionTime;
    }
    priorFairing = sim.rt.fairingAttached;

    if (Number.isFinite(sim.liftoffTime)) {
      const sample = toSample(sim);
      sample.stageThrottle = sim.rt.stages.map((st) => (st.attached && st.engineOn ? st.throttle : 0));
      samples.push(sample);
    }
  }

  const liftedOff = Number.isFinite(sim.liftoffTime);
  const liftoffTime = liftedOff ? sim.liftoffTime : 0;
  const el = sim.elements();

  return {
    source: 'mission',
    samples,
    markers: toMarkers(sim.events, liftoffTime, def.reference),
    orbit: {
      apoapsis: el.ra - RE,
      periapsis: el.rp - RE,
      inclinationDeg: (el.i * 180) / Math.PI,
    },
    vehicleName: def.name,
    stageSeparation,
    fairingSeparation,
    earth: {
      // earthAngle is the angle at the current time, so rewind it to liftoff.
      angleAtLiftoff: liftedOff ? sim.earthAngle - OMEGA_EARTH * (sim.t - sim.liftoffTime) : sim.earthAngle,
      rate: OMEGA_EARTH,
    },
    reachedTarget: autopilot.reachedTarget,
  };
}
