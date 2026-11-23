// Fly a mission definition and record the whole flight as plain data.

import { eciToApp, toMarkers, toSample } from './adapter';
import {
  AscentAutopilot,
  FailureInjector,
  FaultMonitor,
  OMEGA_EARTH,
  RE,
  Simulation,
  applyScenario,
  classifyOutcome,
  noseDirection,
  propagate,
  propagateToImpact,
  supervised,
  type Failure,
  type ScenarioId,
} from './engine';
import type { FlightFault, FlightRecord, FlightSample } from './record';
import type { MissionDef } from './vehicles';

export interface FlyOptions {
  sampleInterval?: number;   // s, default 0.5
  scenario?: ScenarioId;
  failures?: Failure[];
  failureCase?: string;
  destructive?: boolean;
}

/** Fly a mission under its ascent autopilot and return the recorded flight. */
export function flyMission(def: MissionDef, opts: FlyOptions = {}): FlightRecord {
  const sampleInterval = opts.sampleInterval ?? 0.5;
  const vehicle = def.vehicle();

  let combinedFailures: Failure[] = [];
  if (opts.failureCase) {
    const fc = def.failureCases?.find((c) => c.id === opts.failureCase);
    if (!fc) throw new Error(`Unknown failure case: ${opts.failureCase}`);
    combinedFailures = combinedFailures.concat(fc.failures);
  }
  if (opts.failures && opts.failures.length > 0) {
    combinedFailures = combinedFailures.concat(opts.failures);
  }

  const injector = combinedFailures.length > 0 ? new FailureInjector(combinedFailures) : undefined;
  const ascentOpts = injector ? { ...def.ascent, ...injector.ascentOverrides() } : def.ascent;
  const autopilot = new AscentAutopilot(ascentOpts);

  let monitor: FaultMonitor | undefined;
  if (def.faults) {
    let spec = def.faults();
    if (opts.scenario) spec = applyScenario(spec, opts.scenario);
    monitor = new FaultMonitor(vehicle, spec);
  }

  const computer =
    monitor || injector || opts.destructive
      ? supervised(autopilot, { monitor, injector, destructive: opts.destructive })
      : autopilot;
  const sim = new Simulation(vehicle, def.config, computer);

  const samples: FlightSample[] = [];
  const iipTrack: { t: number; latDeg: number; lonDeg: number }[] = [];
  let nextIipT = 10;

  const stageSeparation: (number | null)[] = sim.rt.stages.map(() => null);
  let fairingSeparation: number | null = null;
  let priorAttached = sim.rt.stages.map((st) => st.attached);
  let priorFairing = sim.rt.fairingAttached;

  const takeSample = (): FlightSample => {
    const sample = toSample(sim);
    sample.stageThrottle = sim.rt.stages.map((st) => (st.attached && st.engineOn ? st.throttle : 0));
    sample.phase = autopilot.phase;
    if (monitor) {
      sample.skinTemp = monitor.channels.skinTemp;
      sample.fairingDeltaP = monitor.channels.fairingDeltaP;
      sample.heatFlux = sim.diag.heatFlux;
      sample.ambientPressure = sim.diag.pressure;
      sample.health = { ...monitor.health };
    }
    samples.push(sample);
    return sample;
  };

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
      const sample = takeSample();

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

  // In orbit: coast, then let the payload go. The separation springs push the payload forward
  // and the stage back, sharing momentum by mass; after that each one coasts on its own under
  // the same gravity model, so the gap between them is computed, not animated.
  let payloadSeparation: number | null = null;
  const pay = def.payload;
  if (pay && autopilot.phase === 'done' && autopilot.reachedTarget && !sim.ended) {
    const tCut = sim.t;
    while (sim.t < tCut + pay.deployAfter - 1e-9 && !sim.ended) {
      sim.step(Math.min(sampleInterval, tCut + pay.deployAfter - sim.t));
      takeSample();
    }
    const nose = noseDirection(sim);
    const total = samples[samples.length - 1].mass;
    const mPayload = Math.min(vehicle.payload.mass, total);
    const mStage = total - mPayload;
    let pr = sim.r, pv = sim.v, pt = sim.t;
    pv = [pv[0] + nose[0] * pay.springSpeed * (mStage / total), pv[1] + nose[1] * pay.springSpeed * (mStage / total), pv[2] + nose[2] * pay.springSpeed * (mStage / total)];
    const kick = -pay.springSpeed * (mPayload / total);
    sim.v = [sim.v[0] + nose[0] * kick, sim.v[1] + nose[1] * kick, sim.v[2] + nose[2] * kick];
    payloadSeparation = sim.missionTime;
    const fm = { epochJD: sim.epochJD, gravity: sim.cfg.gravity };
    const tSep = sim.t;
    while (sim.t < tSep + pay.watch - 1e-9 && !sim.ended) {
      sim.step(Math.min(sampleInterval, tSep + pay.watch - sim.t));
      const p = propagate(pr, pv, pt, sim.t, fm);
      pr = p.r; pv = p.v; pt = sim.t;
      const sample = takeSample();
      sample.mass = mStage;
      sample.payloadOffset = eciToApp([pr[0] - sim.r[0], pr[1] - sim.r[1], pr[2] - sim.r[2]]);
    }
  }

  const liftedOff = Number.isFinite(sim.liftoffTime);
  const liftoffTime = liftedOff ? sim.liftoffTime : 0;
  const el = sim.elements();
  const markers = toMarkers(sim.events, liftoffTime, def.reference);

  if (pay && payloadSeparation !== null) {
    markers.push({
      t: payloadSeparation,
      kind: 'event',
      label: `${pay.label} separation`,
      severity: 'info',
      ...(pay.realDeployT !== undefined ? { reference: pay.realDeployT } : {}),
    });
  }

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
    payloadSeparation,
    epochJD: sim.epochJD,
    liftoffSimTime: liftoffTime,
    iipTrack,
    outcome: classifyOutcome(sim, autopilot),
  };

  if (monitor) {
    record.faults = faults;
    record.healthPeaks = monitor.peaks();
  }
  if (opts.scenario) record.scenario = opts.scenario;
  if (opts.failureCase) record.failureCase = opts.failureCase;

  return record;
}
