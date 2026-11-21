// Fly a mission definition and record the whole flight as plain data.

import { toMarkers, toSample } from './adapter';
import {
  AscentAutopilot,
  FaultMonitor,
  OMEGA_EARTH,
  RE,
  Simulation,
  applyScenario,
  monitored,
  propagateToImpact,
  type ScenarioId,
} from './engine';
import type { FlightFault, FlightRecord, FlightSample } from './record';
import type { MissionDef } from './vehicles';

export interface FlyOptions {
  sampleInterval?: number;   // s, default 0.5
  scenario?: ScenarioId;
}

/** Fly a mission under its ascent autopilot and return the recorded flight. */
export function flyMission(def: MissionDef, opts: FlyOptions = {}): FlightRecord {
  const sampleInterval = opts.sampleInterval ?? 0.5;
  const vehicle = def.vehicle();
  const autopilot = new AscentAutopilot(def.ascent);

  let monitor: FaultMonitor | undefined;
  if (def.faults) {
    let spec = def.faults();
    if (opts.scenario) spec = applyScenario(spec, opts.scenario);
    monitor = new FaultMonitor(vehicle, spec);
  }

  const computer = monitor ? monitored(autopilot, monitor) : autopilot;
  const sim = new Simulation(vehicle, def.config, computer);

  const samples: FlightSample[] = [];
  const iipTrack: { t: number; latDeg: number; lonDeg: number }[] = [];
  let nextIipT = 0;

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
      sample.phase = autopilot.phase;
      if (monitor) {
        sample.skinTemp = monitor.channels.skinTemp;
        sample.fairingDeltaP = monitor.channels.fairingDeltaP;
        sample.heatFlux = sim.diag.heatFlux;
        sample.ambientPressure = sim.diag.pressure;
      }
      samples.push(sample);

      if (sample.t >= nextIipT - 1e-9) {
        while (nextIipT <= sample.t + 1e-9) nextIipT += 10;
        if (sample.periapsis !== undefined && sample.periapsis < 100e3) {
          const hit = propagateToImpact(
            sim.r,
            sim.v,
            sim.t,
            { epochJD: sim.epochJD, gravity: sim.cfg.gravity },
            sim.t + 7200,
          );
          if (hit) {
            iipTrack.push({ t: sample.t, latDeg: hit.latDeg, lonDeg: hit.lonDeg });
          }
        }
      }
    }
  }

  const liftedOff = Number.isFinite(sim.liftoffTime);
  const liftoffTime = liftedOff ? sim.liftoffTime : 0;
  const el = sim.elements();
  const markers = toMarkers(sim.events, liftoffTime, def.reference);

  let faults: FlightFault[] | undefined;
  if (monitor) {
    faults = monitor.report();
    for (const fault of faults) {
      markers.push({
        t: fault.t,
        kind: 'flaw',
        label: fault.title,
        severity: fault.severity,
      });
    }
    markers.sort((a, b) => a.t - b.t);
  }

  const record: FlightRecord = {
    source: 'mission',
    samples,
    markers,
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
    epochJD: sim.epochJD,
    liftoffSimTime: liftoffTime,
    iipTrack,
  };

  if (faults) record.faults = faults;
  if (opts.scenario) record.scenario = opts.scenario;

  return record;
}
