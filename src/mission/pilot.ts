// A flight flown live, with a person at the controls.
//
// flyMission() computes a whole flight ahead of time. This steps the same simulation a frame
// at a time instead, and grows a FlightRecord as it goes, so the mission view and HUD read it
// exactly as they read a replay. The ascent autopilot still runs underneath and keeps the
// sequencing (ignition, staging, fairing, cutoff). With manual control on, the pilot's
// attitude and throttle replace the autopilot's commands; with it off, the autopilot flies.

import {
  COUNTDOWN_SAMPLE_S,
  LIFTOFF_TWR_AT_S,
  PAD_SAMPLE_S,
  padSampleAt,
  padStartTime,
  toMarkers,
  toSample,
} from './adapter';
import {
  AscentAutopilot,
  FaultMonitor,
  OMEGA_EARTH,
  RE,
  Simulation,
  classifyOutcome,
  monitored,
  noseDirection,
} from './engine';
import type { FlightFault, FlightRecord, FlightSample } from './record';
import type { MissionDef } from './vehicles';

type V3 = [number, number, number];

const DEG = Math.PI / 180;
/**
 * How fast a held key swings the nose, deg/s, whichever way it goes. Turning left or right
 * moves the nose sideways at this same rate: near vertical that takes a fast change of
 * compass heading, so heading changes are capped at PILOT_MAX_HEADING_RATE.
 */
export const PILOT_TILT_RATE = 6;
export const PILOT_MAX_HEADING_RATE = 30;
/**
 * A key is a switch, but a hand on a stick is not: the steering input eases in over about
 * this long after a key goes down, and lets go a little faster, seconds.
 */
export const PILOT_INPUT_RISE = 0.3;
export const PILOT_INPUT_FALL = 0.1;
/** Below this airspeed, m/s, the airflow says nothing about direction, so prograde hold flies straight up. */
const PROGRADE_MIN_SPEED = 30;
/** Throttle change while a key is held, fraction per second. */
export const PILOT_THROTTLE_RATE = 0.5;
/**
 * How far the commanded direction may run ahead of the nose, degrees. The vehicle turns at a
 * few degrees a second, slower than a held key asks for; without this the command winds up and
 * the nose keeps swinging for seconds after the key is let go.
 */
export const PILOT_MAX_LEAD = 5;
/** Past this the airframe cannot survive: dynamic pressure (Pa) with the nose this far off the airflow. */
const BREAKUP_Q = 5000;
const BREAKUP_ALPHA = 30 * DEG;
/** Nose-off-airflow angles, while the air is thick, at which the readout turns amber and red. */
const AIRFLOW_WARN = 10 * DEG;
const AIRFLOW_DANGER = 20 * DEG;
/** Samples kept in the record are at least this far apart; frames in between replace the newest one. */
const KEEP_INTERVAL = 0.25;

export interface PilotInput {
  /** +1 tips the nose toward the horizon, -1 back toward vertical. */
  pitch: number;
  /** +1 swings the heading clockwise seen from above (toward east from north). */
  yaw: number;
  /** +1 opens the throttle, -1 closes it. */
  throttle: number;
}

/**
 * What the pilot's steering holds when no key is pressed.
 * - attitude: the nose stays where it was left.
 * - prograde: the nose follows the oncoming air, the zero-angle-of-attack gravity turn real
 *   launchers fly through the thick air. Pressing a steering key switches back to attitude.
 */
export type PilotHold = 'attitude' | 'prograde';

export interface PilotState {
  manual: boolean;
  hold: PilotHold;
  /** Commanded nose angle from straight up, degrees. */
  tiltDeg: number;
  /** Commanded compass heading, degrees clockwise from north. */
  headingDeg: number;
  /** Commanded throttle, 0..1. */
  throttle: number;
  /** What the burning liquid engines are really running at, 0..1; null when none burns. */
  engineThrottle: number | null;
  /** The lowest setting the burning liquid engines can run at; 1 means they cannot be throttled. Null when none burns. */
  throttleMin: number | null;
  /** True while a solid motor burns: it follows its own thrust curve and ignores the throttle. */
  solidBurning: boolean;
  /** Where the nose really points now, degrees from straight up. */
  noseTiltDeg: number;
  /** Angle between the nose and the oncoming air, degrees. */
  alphaDeg: number;
  /** Dynamic pressure, Pa. */
  q: number;
  /** How close the vehicle is to breaking up from flying off the airflow. */
  airflow: 'ok' | 'warn' | 'danger';
  ended: boolean;
}

export interface PilotedFlight {
  /** Grows as the flight goes. The same object for the whole flight. */
  readonly record: FlightRecord;
  readonly ended: boolean;
  /** Bumped whenever the timeline markers change. */
  readonly markerVersion: number;
  state(): PilotState;
  setManual(on: boolean): void;
  setHold(hold: PilotHold): void;
  setInput(input: Partial<PilotInput>): void;
  setThrottle(level: number): void;
  /** Fly `dt` more seconds of simulated time. */
  advance(dt: number): void;
  /** Fill in the orbit, outcome and fault report. Call once, when the flight has ended. */
  finish(): FlightRecord;
}

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

function unit(v: V3): V3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * When the clamps will let go, s after ignition. Found by running the countdown on a spare
 * simulation: nothing the pilot does changes it, and the clock needs it to count down.
 */
function padLiftoffTime(def: MissionDef, step: number): number {
  const autopilot = new AscentAutopilot(def.ascent);
  const sim = new Simulation(def.vehicle(), def.config, autopilot);
  while (sim.held && !sim.ended && autopilot.phase !== 'aborted' && sim.t < def.tMax) sim.step(step);
  if (sim.held) throw new Error('The vehicle never left the pad.');
  return sim.liftoffTime;
}

export function startPilotedFlight(def: MissionDef): PilotedFlight {
  const padStep = def.config.dt ?? 0.02;
  const liftoffAt = padLiftoffTime(def, padStep);
  const vehicle = def.vehicle();
  const autopilot = new AscentAutopilot(def.ascent);
  const monitor = def.faults ? new FaultMonitor(vehicle, def.faults()) : undefined;
  const inner = monitor ? monitored(autopilot, monitor) : autopilot;

  const input: PilotInput = { pitch: 0, yaw: 0, throttle: 0 };
  /** The steering input as the stick has it now, easing toward `input`. */
  const stick = { pitch: 0, yaw: 0 };
  let manual = false;
  let hold: PilotHold = 'attitude';
  let tilt = 0;          // rad from local vertical
  let heading = 90 * DEG; // rad clockwise from north
  let throttle = 1;
  let lastT = NaN;
  let brokeUp = false;

  /** Read the commanded attitude off where the nose points now, so taking over does not jerk. */
  const syncToVehicle = (sim: Simulation): void => {
    const d = sim.diag;
    const nose = noseDirection(sim) as V3;
    tilt = Math.acos(clamp(dot(nose, d.up as V3), -1, 1));
    if (tilt > 2 * DEG) {
      heading = Math.atan2(dot(nose, d.east as V3), dot(nose, d.north as V3));
    } else if (d.speedRel > 30) {
      const v = d.vRel as V3;
      const e = dot(v, d.east as V3), n = dot(v, d.north as V3);
      if (Math.hypot(e, n) > 5) heading = Math.atan2(e, n);
    }
    throttle = sim.held ? 1 : clamp(sim.cmd.throttle, 0, 1);
  };

  /** The liquid engines burning now: the throttle range they share and where they have spooled to. */
  const engines = (s: Simulation): { min: number; actual: number; solid: boolean } | { min: null; actual: null; solid: boolean } => {
    let min = 0, actual = NaN, solid = false;
    s.rt.stages.forEach((st, i) => {
      if (!st.attached || !st.engineOn) return;
      const e = vehicle.stages[i].engine;
      if (e.thrustCurve) { solid = true; return; }
      min = Math.max(min, e.minThrottle ?? 1);
      if (!Number.isFinite(actual)) actual = st.throttle;
    });
    return Number.isFinite(actual) ? { min, actual, solid } : { min: null, actual: null, solid };
  };

  const ease = (cur: number, target: number, dt: number): number => {
    const tau = Math.abs(target) > Math.abs(cur) && Math.sign(target) !== -Math.sign(cur) ? PILOT_INPUT_RISE : PILOT_INPUT_FALL;
    return cur + (target - cur) * (1 - Math.exp(-dt / tau));
  };

  const sim = new Simulation(vehicle, def.config, {
    update(s: Simulation): number | void {
      const hint = inner.update(s);
      const dt = Number.isFinite(lastT) ? clamp(s.t - lastT, 0, 0.5) : 0;
      lastT = s.t;
      if (!Number.isFinite(s.liftoffTime)) return hint;

      if (manual) {
        const d = s.diag;
        const up = d.up as V3, east = d.east as V3, north = d.north as V3;
        const direction = (tl: number, hd: number): V3 => {
          const ch = Math.cos(hd), sh = Math.sin(hd);
          const ct = Math.cos(tl), st = Math.sin(tl);
          return unit([
            up[0] * ct + (north[0] * ch + east[0] * sh) * st,
            up[1] * ct + (north[1] * ch + east[1] * sh) * st,
            up[2] * ct + (north[2] * ch + east[2] * sh) * st,
          ]);
        };
        stick.pitch = ease(stick.pitch, input.pitch, dt);
        stick.yaw = ease(stick.yaw, input.yaw, dt);
        if (hold === 'prograde' && (input.pitch !== 0 || input.yaw !== 0)) hold = 'attitude';

        if (hold === 'prograde') {
          // Point along the oncoming air; on the pad and just off it, straight up.
          const v = d.vRel as V3;
          if (d.speedRel > PROGRADE_MIN_SPEED) {
            const dir = unit(v);
            tilt = Math.acos(clamp(dot(dir, up), -1, 1));
            const e = dot(dir, east), n = dot(dir, north);
            if (Math.hypot(e, n) > 1e-3) heading = Math.atan2(e, n);
          } else {
            tilt = 0;
          }
        } else {
          const nose = noseDirection(s) as V3;
          const lead = (v: V3): number => Math.acos(clamp(dot(v, nose), -1, 1));
          const rate = PILOT_TILT_RATE * DEG * dt;
          const headingRate = Math.min(rate / Math.max(Math.sin(tilt), 1e-3), PILOT_MAX_HEADING_RATE * DEG * dt);
          const nextTilt = clamp(tilt + stick.pitch * rate, 0, 150 * DEG);
          const nextHeading = heading + stick.yaw * headingRate;
          const next = direction(nextTilt, nextHeading);
          // Steer only while the nose is keeping up, or when the input brings the command back to it.
          if (lead(next) <= PILOT_MAX_LEAD * DEG || lead(next) <= lead(direction(tilt, heading))) {
            tilt = nextTilt;
            heading = nextHeading;
          }
        }
        throttle = clamp(throttle + input.throttle * PILOT_THROTTLE_RATE * dt, 0, 1);
        // The engines cannot go below their lowest setting, so neither does the lever.
        const eng = engines(s);
        if (eng.min !== null) throttle = clamp(throttle, eng.min, 1);
        s.cmd.attitude = direction(tilt, heading);
        s.cmd.throttle = throttle;
      }

      // Flying sideways through thick air tears the vehicle apart, whoever is steering.
      if (!brokeUp && s.diag.q > BREAKUP_Q && Math.abs(s.diag.alpha) > BREAKUP_ALPHA) {
        brokeUp = true;
        s.event('breakup', 'Aerodynamic breakup: nose too far off the airflow at high dynamic pressure');
        s.ended = true;
      }
      return hint;
    },
  });

  const samples: FlightSample[] = [];
  const stageSeparation: (number | null)[] = sim.rt.stages.map(() => null);
  const record: FlightRecord = {
    source: 'mission',
    samples,
    markers: [],
    vehicleName: def.name,
    stageSeparation,
    fairingSeparation: null,
    earth: { angleAtLiftoff: sim.earthAngle + OMEGA_EARTH * liftoffAt, rate: OMEGA_EARTH },
    epochJD: sim.epochJD,
    liftoffSimTime: liftoffAt,
    iipTrack: [],
  };

  let priorAttached = sim.rt.stages.map((st) => st.attached);
  let priorFairing = sim.rt.fairingAttached;
  let eventCount = 0;
  let markerVersion = 0;
  let lastKeptT = -Infinity;
  let newestIsProvisional = false;
  let twrQuoted = false;
  /** False during the countdown, before the engines light. */
  let lit = false;
  /** Pad time asked for but not yet stepped. */
  let padOwed = 0;

  const done = (): boolean =>
    sim.ended || autopilot.phase === 'done' || autopilot.phase === 'aborted' || sim.t >= def.tMax;

  const keep = (sample: FlightSample, interval: number): void => {
    // Between kept samples the newest one is only the current frame: replace it.
    if (newestIsProvisional) samples.pop();
    samples.push(sample);
    if (sample.t - lastKeptT >= interval - 1e-9 || samples.length === 1) {
      lastKeptT = sample.t;
      newestIsProvisional = false;
    } else {
      newestIsProvisional = true;
    }
  };

  const readSim = (): FlightSample => {
    const sample = toSample(sim);
    // Before release the library has no mission time yet: count back from the known liftoff.
    if (sim.held) sample.t = sim.t - liftoffAt;
    sample.stageThrottle = sim.rt.stages.map((st) => (st.attached && st.engineOn ? st.throttle : 0));
    sample.phase = manual ? 'manual' : autopilot.phase;
    if (monitor) {
      sample.skinTemp = monitor.channels.skinTemp;
      sample.fairingDeltaP = monitor.channels.fairingDeltaP;
      sample.heatFlux = sim.diag.heatFlux;
      sample.ambientPressure = sim.diag.pressure;
      sample.health = { ...monitor.health };
    }
    return sample;
  };

  /** The unlit vehicle at ignition; the countdown samples are this one turned with the Earth. */
  const ignition = readSim();
  const padStart = padStartTime(liftoffAt);
  keep(padSampleAt(ignition, padStart, OMEGA_EARTH), COUNTDOWN_SAMPLE_S);

  const markersNow = (): FlightRecord['markers'] =>
    toMarkers(sim.events, Number.isFinite(sim.liftoffTime) ? sim.liftoffTime : liftoffAt, def.reference, samples);

  const afterStep = (wasHeld: boolean): void => {
    sim.rt.stages.forEach((st, i) => {
      if (priorAttached[i] && !st.attached && Number.isFinite(sim.missionTime)) {
        stageSeparation[i] = sim.missionTime;
      }
      priorAttached[i] = st.attached;
    });
    if (priorFairing && !sim.rt.fairingAttached && Number.isFinite(sim.missionTime)) {
      record.fairingSeparation = sim.missionTime;
    }
    priorFairing = sim.rt.fairingAttached;

    const sample = readSim();
    // The sample at release is always kept.
    keep(sample, sim.held ? PAD_SAMPLE_S : wasHeld ? 0 : KEEP_INTERVAL);
    const twrDue = !twrQuoted && sample.t >= LIFTOFF_TWR_AT_S;
    if (sim.events.length !== eventCount || twrDue) {
      eventCount = sim.events.length;
      twrQuoted ||= twrDue;
      record.markers = markersNow();
      markerVersion++;
    }
  };

  let countdown = padStart;
  const advance = (dt: number): void => {
    if (done() || !(dt > 0)) return;
    if (!lit) {
      const wait = ignition.t - countdown;
      if (dt < wait) {
        countdown += dt;
        keep(padSampleAt(ignition, countdown, OMEGA_EARTH), COUNTDOWN_SAMPLE_S);
        return;
      }
      lit = true;
      dt -= wait;
      keep(ignition, 0);
    }
    if (sim.held) {
      // Whole physics steps only, so release comes at the same instant at any frame rate.
      padOwed += dt;
      while (sim.held && !done() && padOwed > padStep - 1e-9) {
        sim.step(padStep);
        padOwed -= padStep;
        afterStep(true);
      }
      if (sim.held) return;
      dt = padOwed;
      padOwed = 0;
    }
    if (dt > 1e-9) {
      sim.step(dt);
      afterStep(false);
    }
  };

  let finished = false;
  const finish = (): FlightRecord => {
    if (finished) return record;
    finished = true;
    // The frame-by-frame newest sample becomes the flight's last one.
    newestIsProvisional = false;
    const el = sim.elements();
    record.orbit = {
      apoapsis: el.ra - RE,
      periapsis: el.rp - RE,
      inclinationDeg: (el.i * 180) / Math.PI,
    };
    record.reachedTarget = autopilot.reachedTarget;
    record.outcome = classifyOutcome(sim, autopilot);
    // Stopped during the countdown: the pilot called it off, the vehicle did not fail.
    if (sim.held) record.outcome.summary = 'Flight ended before liftoff.';
    record.markers = markersNow();
    if (monitor) {
      const faults: FlightFault[] = monitor.report();
      record.faults = faults;
      record.healthPeaks = monitor.peaks();
      for (const fault of faults) {
        record.markers.push({ t: fault.t, kind: 'flaw', label: fault.title, severity: fault.severity });
      }
      record.markers.sort((a, b) => a.t - b.t);
    }
    markerVersion++;
    return record;
  };

  return {
    record,
    get ended() { return done(); },
    get markerVersion() { return markerVersion; },
    state: (): PilotState => {
      const d = sim.diag;
      const alpha = Math.abs(d.alpha);
      const thick = d.q > BREAKUP_Q;
      const eng = engines(sim);
      return {
        manual,
        hold,
        tiltDeg: tilt / DEG,
        headingDeg: (((heading / DEG) % 360) + 360) % 360,
        throttle,
        engineThrottle: eng.actual,
        throttleMin: eng.min,
        solidBurning: eng.solid,
        noseTiltDeg: Math.acos(clamp(dot(noseDirection(sim) as V3, d.up as V3), -1, 1)) / DEG,
        alphaDeg: alpha / DEG,
        q: d.q,
        airflow: thick && alpha > AIRFLOW_DANGER ? 'danger' : thick && alpha > AIRFLOW_WARN ? 'warn' : 'ok',
        ended: done(),
      };
    },
    setManual(on: boolean): void {
      if (on === manual) return;
      if (on) {
        syncToVehicle(sim);
        stick.pitch = 0;
        stick.yaw = 0;
        hold = 'attitude';
      }
      manual = on;
    },
    setHold(next: PilotHold): void {
      hold = next;
    },
    setInput(next: Partial<PilotInput>): void {
      Object.assign(input, next);
    },
    setThrottle(level: number): void {
      // The engines run at full power until the clamps let go.
      if (sim.held) return;
      const eng = engines(sim);
      throttle = clamp(level, eng.min ?? 0, 1);
    },
    advance,
    finish,
  };
}
