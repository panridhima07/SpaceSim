// 6-DOF point-mass-plus-attitude simulator for a model rocket.
//
// Frames and conventions are those in src/types.ts: SI units, station x measured
// aft from the nose tip, body +Y toward the nose, Earth-centred non-rotating world
// frame with the launch site at (0, R_EARTH + launchAltitude, 0), quaternions [x,y,z,w]
// rotating body -> world.
//
// Mass, aero and atmosphere models are injected through PhysicsDeps so this module
// never imports them.

import {
  G0,
  MU_EARTH,
  R_EARTH,
  type AeroProps,
  type Component,
  type Controls,
  type FlightEvent,
  type FlightEventType,
  type InnerTube,
  type MassProps,
  type Motor,
  type Parachute,
  type PhysicsDeps,
  type Quat,
  type RocketModel,
  type Sim,
  type SimConfig,
  type SimState,
  type Vec3,
} from '../types';
import {
  add,
  cross,
  dot,
  len,
  normalize,
  quatConj,
  quatFromAxisAngle,
  quatIntegrate,
  quatRotate,
  scale,
  sub,
} from './vec';

const MAX_SUBSTEP = 0.002; // s, while in atmosphere or thrusting
const COAST_SUBSTEP = 0.1; // s, above HIGH_ALTITUDE and not thrusting
const HIGH_ALTITUDE = 100_000; // m
const LOG_INTERVAL = 0.02; // s of sim time
const MAX_SUBSTEPS_PER_CALL = 20_000;
const CHUTE_DAMPING_RATE = 10; // 1/s, angular damping rate under canopy (torque = -rate * I * omega)
const SAFE_LANDING_SPEED = 8; // m/s, canopy impact speed still counted as a landing
const ZERO: Vec3 = [0, 0, 0];
const NO_CONTROLS: Controls = { gimbalPitch: 0, gimbalYaw: 0 };

/** Forces, torques and derived quantities at one instant. */
interface Eval {
  /** Total acceleration including gravity, world frame. */
  acc: Vec3;
  /** Body-frame angular acceleration. */
  omegaDot: Vec3;
  mass: number;
  cgX: number;
  cpX: number;
  refLength: number;
  thrust: number;
  drag: number;
  accelG: number;
  mach: number;
  alpha: number;
  q: number;
  altitude: number;
  speed: number;
}

interface Kin {
  pos: Vec3;
  vel: Vec3;
  omega: Vec3;
  quat: Quat;
}

interface ChuteRun {
  chute: Parachute;
  /** Time the altitude trigger armed (altitude chutes only). */
  armedT?: number;
  deployedAt?: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function isFiniteVec(v: readonly number[]): boolean {
  return v.every((x) => Number.isFinite(x));
}

function rk4(x0: Vec3, k1: Vec3, k2: Vec3, k3: Vec3, k4: Vec3, h: number): Vec3 {
  const f = h / 6;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = x0[i] + f * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
  return out;
}

function radialVelocity(pos: Vec3, vel: Vec3): number {
  const r = len(pos);
  return r > 0 ? dot(vel, pos) / r : 0;
}

/**
 * Ejection delay in seconds, or undefined if ejection never happens.
 * Precedence: config override, then the motor-mount motor's delay, then 0.
 */
function resolveEjectionDelay(rocket: RocketModel, config: SimConfig): number | undefined {
  const tubes = rocket.components.filter(
    (c: Component): c is InnerTube => c.kind === 'innertube',
  );
  const mount = tubes.find((t) => t.isMotorMount && t.motor) ?? tubes.find((t) => t.motor);
  const d = config.ejectionDelay ?? mount?.motor?.delay ?? 0;
  return Number.isFinite(d) ? d : undefined;
}

export function createSim(
  rocket: RocketModel,
  motor: Motor | null,
  config: SimConfig,
  deps: PhysicsDeps,
): Sim {
  // Rail geometry. h is the horizontal unit vector toward the compass azimuth
  // (north = -Z, east = +X). The rail direction tilts railAngle from +Y toward h.
  const hx = Math.sin(config.railAzimuth);
  const hz = -Math.cos(config.railAzimuth);
  const railDir: Vec3 = [
    Math.sin(config.railAngle) * hx,
    Math.cos(config.railAngle),
    Math.sin(config.railAngle) * hz,
  ];
  // Rotation taking +Y onto railDir: axis Y x h, angle railAngle.
  const railQuat = quatFromAxisAngle(cross([0, 1, 0], [hx, 0, hz]), config.railAngle);
  const railStart: Vec3 = [0, R_EARTH + config.launchAltitude, 0];

  const stageMotors = config.stageMotors;
  const isMultiStage = Boolean(
    stageMotors && stageMotors.length > 1 && rocket.stages && rocket.stages.length >= stageMotors.length,
  );
  let activeRocket: RocketModel = rocket;
  let activeMotor: Motor | null = stageMotors && stageMotors.length > 0 ? stageMotors[0].motor : motor;
  let firingStageIdx = 0;
  let nextStageIgnitionT: number | undefined;

  const ejectionDelay = resolveEjectionDelay(rocket, config);
  const chutes: ChuteRun[] = rocket.components
    .filter((c: Component): c is Parachute => c.kind === 'parachute')
    .map((chute) => ({ chute }));

  let controls: Controls = NO_CONTROLS;
  let ignited = false;
  let tIgnition = 0;
  let isDone = false;

  // Rail state: distance along the rail and speed along it.
  let railS = 0;
  let railV = 0;
  let railExited = false;
  let prevRadialV = 0;

  let burnoutT: number | undefined;
  let apogeeT: number | undefined;
  let ejectionT: number | undefined;

  let maxQ = 0;
  let maxQT = 0;
  let maxQAlt = 0;
  let maxQSpeed = 0;
  let maxQEmitted = false;

  let nextLogT = LOG_INTERVAL;
  const events: FlightEvent[] = [];
  const log: SimState[] = [];

  // Shared arrays are never mutated in place; every update assigns a new array.
  const state: SimState = {
    t: 0,
    pos: [railStart[0], railStart[1], railStart[2]],
    vel: [0, 0, 0],
    quat: railQuat,
    omega: [0, 0, 0],
    phase: 'pad',
    mass: 0,
    altitude: 0,
    speed: 0,
    mach: 0,
    alpha: 0,
    dynamicPressure: 0,
    thrust: 0,
    drag: 0,
    accelG: 0,
    cgX: 0,
    cpX: 0,
    stabilityCal: 0,
    chuteDeployed: false,
  };

  function windAt(altitude: number, t: number): Vec3 {
    if (altitude <= 0 || config.windSpeed === 0) return [0, 0, 0];
    const gust = 1 + config.gust * Math.sin(1.7 * t) * Math.sin(0.31 * t + 1);
    const profile = clamp(Math.pow(altitude / 10, 0.14), 0, 2);
    const s = config.windSpeed * gust * profile;
    // Wind blows FROM the compass direction, so the air moves toward its opposite.
    return [-Math.sin(config.windDirection) * s, 0, Math.cos(config.windDirection) * s];
  }

  /** Forces and torques at a given kinematic state. Does not apply rail or pad constraints. */
  function evaluate(pos: Vec3, vel: Vec3, omega: Vec3, quat: Quat, t: number): Eval {
    const r = len(pos);
    const altitude = r - R_EARTH - config.launchAltitude;
    const atm = deps.atmosphere(r - R_EARTH);
    const tBurn = ignited ? t - tIgnition : -1;
    let mp: MassProps = deps.massProps(activeRocket, activeMotor, tBurn);
    if (isMultiStage && stageMotors) {
      for (let s = firingStageIdx + 1; s < stageMotors.length; s++) {
        const um = stageMotors[s].motor;
        const mExtra = um.totalMass;
        const cgExtra = activeRocket.length * 0.5;
        const totalM = mp.mass + mExtra;
        if (totalM > 0) {
          mp = {
            ...mp,
            mass: totalM,
            cgX: (mp.mass * mp.cgX + mExtra * cgExtra) / totalM,
          };
        }
      }
    }
    const thrust =
      activeMotor && ignited && tBurn < activeMotor.burnTime ? deps.thrust(activeMotor, tBurn) : 0;
    const mass = mp.mass;

    const gravity = scale(pos, -MU_EARTH / (r * r * r));
    const vRel = sub(vel, windAt(altitude, t));
    const v = len(vRel);
    const a = quatRotate(quat, [0, 1, 0]); // nose direction, world
    const mach = atm.soundSpeed > 0 ? v / atm.soundSpeed : 0;
    const q = 0.5 * atm.rho * v * v;
    const aero: AeroProps = deps.aeroProps(activeRocket, mach, mp.cgX);
    const alpha = v < 0.1 ? 0 : Math.acos(clamp(dot(vRel, a) / v, -1, 1));

    let force: Vec3 = [0, 0, 0];
    let torque: Vec3 = [0, 0, 0];
    let drag: number;

    const chuteCdA = chutes.reduce(
      (sum, c) =>
        c.deployedAt !== undefined
          ? sum + Math.PI * (c.chute.diameter / 2) ** 2 * c.chute.cd
          : sum,
      0,
    );

    if (chuteCdA > 0) {
      // Canopy replaces the rocket's aerodynamics; strong angular damping stops the tumble.
      force = scale(vRel, -0.5 * atm.rho * v * chuteCdA);
      drag = len(force);
      torque = scale(quatRotate(quat, omega), -CHUTE_DAMPING_RATE * mp.iPitch);
    } else {
      drag = q * aero.refArea * aero.cd;
      if (v > 0) force = scale(vRel, -drag / v);

      // Normal force opposes the lateral part of the relative wind.
      const lateral = sub(vRel, scale(a, dot(vRel, a)));
      const nDir = normalize(scale(lateral, -1));
      const planform = 2 * rocket.maxRadius * rocket.length;
      const sa = Math.sin(alpha);
      const bodyLift = 1.1 * (planform / aero.refArea) * sa * sa;
      const fn = scale(nDir, q * aero.refArea * (aero.cnAlpha * sa + bodyLift));
      force = add(force, fn);
      // Lever arm from CG to CP: CP aft of CG (cpX > cgX) gives a restoring torque.
      torque = add(torque, cross(scale(a, mp.cgX - aero.cpX), fn));

      // Pitch damping from the transverse part of the angular velocity.
      const omegaW = quatRotate(quat, omega);
      const omegaT = sub(omegaW, scale(a, dot(omegaW, a)));
      torque = add(torque, scale(omegaT, -0.5 * atm.rho * v * aero.refArea * aero.dampSum));
    }

    if (thrust > 0) {
      // Small-angle gimbal: rotate the nose direction about body X (pitch) then body Z (yaw).
      const p = controls.gimbalPitch;
      const y = controls.gimbalYaw;
      const dirBody: Vec3 = [-Math.cos(p) * Math.sin(y), Math.cos(p) * Math.cos(y), Math.sin(p)];
      const ft = scale(quatRotate(quat, dirBody), thrust);
      force = add(force, ft);
      // Nozzle sits (length - cgX) aft of the CG.
      torque = add(torque, cross(scale(a, -(rocket.length - mp.cgX)), ft));
    }

    const acc = add(gravity, scale(force, 1 / mass));
    const tauBody = quatRotate(quatConj(quat), torque);
    const iP = mp.iPitch;
    const iR = mp.iRoll;
    const iw: Vec3 = [iP * omega[0], iR * omega[1], iP * omega[2]];
    const gyro = cross(omega, iw);
    const omegaDot: Vec3 = [
      (tauBody[0] - gyro[0]) / iP,
      (tauBody[1] - gyro[1]) / iR,
      (tauBody[2] - gyro[2]) / iP,
    ];

    return {
      acc,
      omegaDot,
      mass,
      cgX: mp.cgX,
      cpX: aero.cpX,
      refLength: aero.refLength,
      thrust,
      drag,
      accelG: len(force) / (mass * G0),
      mach,
      alpha,
      q,
      altitude,
      speed: len(vel),
    };
  }

  function evalFinite(e: Eval): boolean {
    return (
      isFiniteVec(e.acc) &&
      isFiniteVec(e.omegaDot) &&
      [e.mass, e.cgX, e.cpX, e.refLength, e.thrust, e.drag, e.accelG, e.mach, e.alpha, e.q, e.altitude, e.speed].every(
        (x) => Number.isFinite(x),
      )
    );
  }

  function railDeriv(s: number, v: number, t: number): [number, number] {
    const pos = add(railStart, scale(railDir, s));
    const e = evaluate(pos, scale(railDir, v), ZERO, railQuat, t);
    let acc = dot(e.acc, railDir);
    // The launch-rail lug cannot pull the rocket back down the rail.
    if (v <= 0 && acc < 0) acc = 0;
    return [v, acc];
  }

  function integrateRail(h: number, t0: number): { s: number; v: number } {
    const [k1s, k1v] = railDeriv(railS, railV, t0);
    const [k2s, k2v] = railDeriv(railS + 0.5 * h * k1s, railV + 0.5 * h * k1v, t0 + 0.5 * h);
    const [k3s, k3v] = railDeriv(railS + 0.5 * h * k2s, railV + 0.5 * h * k2v, t0 + 0.5 * h);
    const [k4s, k4v] = railDeriv(railS + h * k3s, railV + h * k3v, t0 + h);
    const s = railS + (h / 6) * (k1s + 2 * k2s + 2 * k3s + k4s);
    const v = Math.max(0, railV + (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v));
    return { s, v };
  }

  function freeDeriv(pos: Vec3, vel: Vec3, omega: Vec3, quat: Quat, t: number) {
    const e = evaluate(pos, vel, omega, quat, t);
    return { p: vel, v: e.acc, w: e.omegaDot };
  }

  function integrateFree(h: number, t0: number): Kin {
    const p0 = state.pos;
    const v0 = state.vel;
    const w0 = state.omega;
    const q0 = state.quat;
    const k1 = freeDeriv(p0, v0, w0, q0, t0);
    const k2 = freeDeriv(
      add(p0, scale(k1.p, h / 2)),
      add(v0, scale(k1.v, h / 2)),
      add(w0, scale(k1.w, h / 2)),
      q0,
      t0 + h / 2,
    );
    const k3 = freeDeriv(
      add(p0, scale(k2.p, h / 2)),
      add(v0, scale(k2.v, h / 2)),
      add(w0, scale(k2.w, h / 2)),
      q0,
      t0 + h / 2,
    );
    const k4 = freeDeriv(
      add(p0, scale(k3.p, h)),
      add(v0, scale(k3.v, h)),
      add(w0, scale(k3.w, h)),
      q0,
      t0 + h,
    );
    const pos = rk4(p0, k1.p, k2.p, k3.p, k4.p, h);
    const vel = rk4(v0, k1.v, k2.v, k3.v, k4.v, h);
    const omega = rk4(w0, k1.w, k2.w, k3.w, k4.w, h);
    // Orientation advances with the trapezoidal mean body rate, then renormalises.
    const quat = quatIntegrate(q0, scale(add(w0, omega), 0.5), h);
    return { pos, vel, omega, quat };
  }

  function applyDerived(e: Eval): void {
    state.mass = e.mass;
    state.altitude = e.altitude;
    state.speed = e.speed;
    state.mach = e.mach;
    state.alpha = e.alpha;
    state.dynamicPressure = e.q;
    state.thrust = e.thrust;
    state.drag = e.drag;
    state.accelG = e.accelG;
    state.cgX = e.cgX;
    state.cpX = e.cpX;
    state.stabilityCal = (e.cpX - e.cgX) / e.refLength;
    state.chuteDeployed = chutes.some((c) => c.deployedAt !== undefined);
  }

  function pushLog(): void {
    log.push({
      ...state,
      pos: [state.pos[0], state.pos[1], state.pos[2]],
      vel: [state.vel[0], state.vel[1], state.vel[2]],
      omega: [state.omega[0], state.omega[1], state.omega[2]],
      quat: [state.quat[0], state.quat[1], state.quat[2], state.quat[3]],
    });
  }

  function emit(
    type: FlightEventType,
    message: string,
    t: number = state.t,
    altitude: number = state.altitude,
    speed: number = state.speed,
  ): void {
    events.push({ t, type, altitude, speed, message });
    pushLog();
  }

  function diverge(): void {
    state.phase = 'crashed';
    isDone = true;
    emit('crash', 'simulation diverged');
  }

  function touchdown(): void {
    const impact = state.speed;
    const k = (R_EARTH + config.launchAltitude) / len(state.pos);
    // Clamp to the ground and stop.
    state.pos = scale(state.pos, k);
    state.vel = [0, 0, 0];
    state.omega = [0, 0, 0];
    const ok = state.chuteDeployed && impact <= SAFE_LANDING_SPEED;
    state.phase = ok ? 'landed' : 'crashed';
    isDone = true;
    applyDerived(evaluate(state.pos, state.vel, state.omega, state.quat, state.t));
    if (ok) {
      emit('landing', `Landed at ${impact.toFixed(1)} m/s impact speed`, state.t, 0, impact);
    } else {
      emit('crash', `Impact at ${impact.toFixed(1)} m/s impact speed`, state.t, 0, impact);
    }
  }

  /** Phase transitions and discrete events for the state just committed. */
  function transitions(e: Eval): void {
    const t = state.t;

    if (state.phase === 'pad') {
      if (ignited && e.thrust > e.mass * G0 * Math.cos(config.railAngle)) {
        state.phase = 'rail';
        railS = 0;
        railV = 0;
        emit('liftoff', `Liftoff with thrust ${e.thrust.toFixed(2)} N`);
      }
      return;
    }

    if (state.phase === 'rail') {
      if (railS >= config.railLength) {
        railExited = true;
        state.phase = e.thrust > 0 ? 'boost' : 'coast';
        prevRadialV = radialVelocity(state.pos, state.vel);
        emit('railExit', `Left rail at ${state.speed.toFixed(1)} m/s`);
      }
      return;
    }

    const tBurn = ignited ? t - tIgnition : -1;

    if (nextStageIgnitionT !== undefined && t >= nextStageIgnitionT && stageMotors) {
      activeMotor = stageMotors[firingStageIdx].motor;
      tIgnition = t;
      nextStageIgnitionT = undefined;
      state.phase = 'boost';
      emit('stage ignition', `Stage ${firingStageIdx + 1} ignition at ${state.altitude.toFixed(1)} m`);
    }

    if (state.phase === 'boost' && activeMotor && tBurn >= activeMotor.burnTime) {
      state.phase = 'coast';
      if (isMultiStage && stageMotors && rocket.stages && firingStageIdx + 1 < stageMotors.length) {
        const dropBoundary = rocket.stages[rocket.stages.length - 1 - firingStageIdx];
        const kept = activeRocket.components.slice(0, dropBoundary.startComponent);
        let newLen = 0;
        let newMaxR = 0;
        for (const c of kept) {
          if (c.kind === 'nosecone' || c.kind === 'bodytube' || c.kind === 'transition' || c.kind === 'finset') {
            newLen = Math.max(newLen, c.x + c.length);
          }
          if (c.kind === 'nosecone') newMaxR = Math.max(newMaxR, c.baseRadius);
          else if (c.kind === 'bodytube') newMaxR = Math.max(newMaxR, c.outerRadius);
          else if (c.kind === 'transition') newMaxR = Math.max(newMaxR, c.foreRadius, c.aftRadius);
        }
        activeRocket = { ...activeRocket, components: kept, length: newLen, maxRadius: newMaxR };
        const keptSet = new Set<Component>(kept);
        for (let ci = chutes.length - 1; ci >= 0; ci--) {
          if (!keptSet.has(chutes[ci].chute)) chutes.splice(ci, 1);
        }
        emit('stage separation', `Stage ${firingStageIdx + 1} separation at ${state.altitude.toFixed(1)} m`);
        firingStageIdx++;
        const nextStage = stageMotors[firingStageIdx];
        nextStageIgnitionT = t + (nextStage.ignitionDelay ?? 0);
        activeMotor = null;
      } else {
        burnoutT = t;
        emit('burnout', `Burnout at ${state.speed.toFixed(1)} m/s, ${state.altitude.toFixed(1)} m`);
      }
    }

    const rv = radialVelocity(state.pos, state.vel);

    if (apogeeT === undefined && railExited && prevRadialV > 0 && rv <= 0) {
      apogeeT = t;
      emit('apogee', `Apogee at ${state.altitude.toFixed(1)} m`);
    }
    prevRadialV = rv;

    if (
      ejectionT === undefined &&
      activeMotor &&
      ignited &&
      nextStageIgnitionT === undefined &&
      ejectionDelay !== undefined &&
      tBurn >= activeMotor.burnTime + ejectionDelay
    ) {
      ejectionT = t;
      emit('ejection', `Ejection charge fired at ${state.altitude.toFixed(1)} m`);
    }

    for (const run of chutes) {
      if (run.deployedAt !== undefined) continue;
      const c = run.chute;
      let trigger: number | undefined;
      if (c.deployEvent === 'ejection') {
        trigger = ejectionT;
      } else if (c.deployEvent === 'apogee') {
        trigger = apogeeT;
      } else if (apogeeT !== undefined) {
        if (run.armedT === undefined && rv < 0 && state.altitude <= c.deployAltitude) {
          run.armedT = t;
        }
        trigger = run.armedT;
      }
      if (trigger !== undefined && t >= trigger + (c.deployDelay || 0)) {
        const first = !state.chuteDeployed;
        run.deployedAt = t;
        state.chuteDeployed = true;
        if (first) {
          if (state.phase === 'coast') state.phase = 'descent';
          emit(
            'chuteDeploy',
            `${c.name} deployed at ${state.altitude.toFixed(0)} m, speed ${state.speed.toFixed(1)} m/s`,
          );
        }
      }
    }

    if (state.phase === 'boost' || state.phase === 'coast') {
      if (e.q > maxQ) {
        maxQ = e.q;
        maxQT = t;
        maxQAlt = state.altitude;
        maxQSpeed = state.speed;
      }
    }
    if (burnoutT !== undefined && !maxQEmitted && maxQ > 0 && e.q < 0.9 * maxQ) {
      maxQEmitted = true;
      emit(
        'maxQ',
        `Peak dynamic pressure ${maxQ.toFixed(0)} Pa at ${maxQT.toFixed(2)} s`,
        maxQT,
        maxQAlt,
        maxQSpeed,
      );
    }

    if (state.altitude <= 0) touchdown();
  }

  function tickLog(): void {
    if (state.t + 1e-9 >= nextLogT) {
      pushLog();
      while (nextLogT <= state.t + 1e-9) nextLogT += LOG_INTERVAL;
    }
  }

  function substep(h: number): void {
    const t0 = state.t;
    const t1 = t0 + h;
    let cand: Kin;
    let railNext: { s: number; v: number } | undefined;

    if (state.phase === 'pad') {
      cand = { pos: state.pos, vel: state.vel, omega: state.omega, quat: state.quat };
    } else if (state.phase === 'rail') {
      railNext = integrateRail(h, t0);
      cand = {
        pos: add(railStart, scale(railDir, railNext.s)),
        vel: scale(railDir, railNext.v),
        omega: ZERO,
        quat: railQuat,
      };
    } else {
      cand = integrateFree(h, t0);
    }

    // Check the candidate before committing so a NaN never reaches the state or log.
    const e = evaluate(cand.pos, cand.vel, cand.omega, cand.quat, t1);
    if (
      !isFiniteVec(cand.pos) ||
      !isFiniteVec(cand.vel) ||
      !isFiniteVec(cand.omega) ||
      !cand.quat.every((x) => Number.isFinite(x)) ||
      !evalFinite(e)
    ) {
      diverge();
      return;
    }

    if (railNext) {
      railS = railNext.s;
      railV = railNext.v;
    }
    state.t = t1;
    state.pos = cand.pos;
    state.vel = cand.vel;
    state.omega = cand.omega;
    state.quat = cand.quat;
    applyDerived(e);
    transitions(e);
    tickLog();
  }

  // Initial derived values and first log sample.
  applyDerived(evaluate(state.pos, state.vel, state.omega, state.quat, 0));
  pushLog();

  function ignite(): void {
    if (!motor || ignited || isDone) return;
    ignited = true;
    tIgnition = state.t;
    emit('ignition', `Ignition: ${motor.manufacturer} ${motor.designation}`);
  }

  function step(dt: number, ctrl?: Controls): void {
    controls = ctrl ?? NO_CONTROLS;
    if (isDone || !(dt > 0)) return;
    let remaining = dt;
    let n = 0;
    while (remaining > 1e-12 && !isDone && n < MAX_SUBSTEPS_PER_CALL) {
      const coasting = state.altitude >= HIGH_ALTITUDE && state.thrust <= 0;
      const h = Math.min(remaining, coasting ? COAST_SUBSTEP : MAX_SUBSTEP);
      substep(h);
      remaining -= h;
      n++;
    }
  }

  return {
    get state() {
      return state;
    },
    get events() {
      return events;
    },
    get log() {
      return log;
    },
    get done() {
      return isDone;
    },
    ignite,
    step,
  };
}
