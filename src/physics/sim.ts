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
import { makeWindInto, siteAtmosphere } from './wind';
import { firingMotors, motorCount } from './cluster';
import { cdAtReynolds } from './aero';

const MAX_SUBSTEP = 0.002; // s, while in atmosphere or thrusting
const COAST_SUBSTEP = 0.1; // s, above HIGH_ALTITUDE and not thrusting: the shortest coast step
/**
 * s, longest coast step above HIGH_ALTITUDE. The air is too thin to steer the rocket there, so
 * the step only has to follow the orbit (period of an hour or more) and the body's own spin:
 * it is held to COAST_TURN rad of rotation per step, and to COAST_SUBSTEP while hand-flown.
 */
const COAST_SUBSTEP_MAX = 1;
const COAST_TURN = 0.1; // rad of body rotation per coast step
/** Pa. Above this the fins can still swing the rocket (around 100 km at orbital-class speeds), so coast steps stay short. */
const COAST_MAX_Q = 1;
const HIGH_ALTITUDE = 100_000; // m
/**
 * s, substep once every deployed canopy is open and has settled. The slowest dynamics under a
 * canopy (pendulum swing, CHUTE_DAMPING_RATE) are tens of times slower than this, and the descent
 * is most of a flight's sim time, so this is where most of the compute goes.
 */
const CANOPY_SUBSTEP = 0.02;
/** s after full inflation before the canopy substep is used, so the opening shock is resolved finely. */
const CANOPY_SETTLE_TIME = 1;
const LOG_INTERVAL = 0.02; // s of sim time
const MAX_SUBSTEPS_PER_CALL = 20_000;
const CHUTE_DAMPING_RATE = 10; // 1/s, angular damping rate under canopy (torque = -rate * I * omega)
const CHUTE_INFLATE_TIME = 0.6; // s, gradual canopy inflation time to model realistic opening shock
const RAIL_FRICTION_MU = 0.25; // kinetic friction coefficient of rail lugs/buttons under lateral force
const SAFE_LANDING_SPEED = 8; // m/s, canopy impact speed still counted as a landing
const ZERO: Vec3 = [0, 0, 0];
const NO_CONTROLS: Controls = { gimbalPitch: 0, gimbalYaw: 0 };
/** s, how quickly a hand-flown rocket reaches the commanded turn rate. */
const STEER_TAU = 0.15;
/** A powered, chute-less touchdown counts as a landing only with the nose within this of vertical, cos. */
const UPRIGHT_COS = Math.cos((25 * Math.PI) / 180);

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
  /** Speed relative to the air. */
  airspeed: number;
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
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

/** quatRotate(q, v) written to out: v + w(2 u x v) + u x (2 u x v), same operation order as vec.ts. */
function rotate(qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number, out: Vec3): void {
  const c0 = qy * vz - qz * vy;
  const c1 = qz * vx - qx * vz;
  const c2 = qx * vy - qy * vx;
  const t0 = c0 * 2;
  const t1 = c1 * 2;
  const t2 = c2 * 2;
  const d0 = qy * t2 - qz * t1;
  const d1 = qz * t0 - qx * t2;
  const d2 = qx * t1 - qy * t0;
  out[0] = vx + qw * t0 + d0;
  out[1] = vy + qw * t1 + d1;
  out[2] = vz + qw * t2 + d2;
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
  /** Motors lighting together in the stage now at the bottom. */
  let activeCount = motorCount(rocket);
  /** For each firing stage, in firing order: how many motors it carries and where they sit. */
  const carried = (stageMotors ?? []).map(({ motor: m }, s) => {
    if (s === 0 || !rocket.stages) return { count: activeCount, station: undefined };
    const boundary = rocket.stages[rocket.stages.length - s];
    const upper = { ...rocket, components: rocket.components.slice(0, boundary.startComponent) };
    const mount = firingMotors(upper)[0].mount;
    // Station of the motor's middle: it sits at the aft end of its mount.
    return {
      count: motorCount(upper),
      station: mount ? mount.x + mount.length + mount.overhang - m.length / 2 : undefined,
    };
  });
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

  // Hand flying. The motor has its own burn clock, which runs at the throttle setting: burnLag is
  // how far it has fallen behind the wall clock, and throttle is the rate for the substep in hand.
  // With the throttle never touched both stay 0 and 1, and the numbers are those of an auto flight.
  let handFlown = false;
  let engineCut = false; // the parachute was fired by hand
  let burnLag = 0;
  let throttle = 1;

  /** Seconds of motor burn used up at time t, or -1 before ignition. */
  function burnTimeAt(t: number): number {
    return ignited ? t - tIgnition - burnLag - (t - state.t) * (1 - throttle) : -1;
  }

  /** The burn-clock rate to use from now: the commanded throttle while there is propellant left. */
  function commandedThrottle(): number {
    if (!handFlown || !activeMotor || burnTimeAt(state.t) >= activeMotor.burnTime) return 1;
    if (engineCut) return 0;
    const c = controls.throttle;
    return c === undefined || !Number.isFinite(c) ? 1 : clamp(c, 0, 1);
  }

  /** Propellant left in a motor that has been lit. */
  function motorUnburnt(): boolean {
    return ignited && activeMotor !== null && burnTimeAt(state.t) < activeMotor.burnTime;
  }

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

  const windInto = makeWindInto(config);
  // Standard air, shifted to the temperature and pressure measured at the pad when given.
  const airAt = siteAtmosphere(deps.atmosphere, config);

  // Scratch vectors for evaluateInto. The function never re-enters itself, so one set is enough.
  const sW: Vec3 = [0, 0, 0]; // air velocity
  const sA: Vec3 = [0, 0, 0]; // nose direction, world
  const sO: Vec3 = [0, 0, 0]; // rotated angular velocity / body torque
  const sT: Vec3 = [0, 0, 0]; // thrust direction, world

  function makeEval(): Eval {
    return {
      acc: [0, 0, 0],
      omegaDot: [0, 0, 0],
      mass: 0,
      cgX: 0,
      cpX: 0,
      refLength: 0,
      thrust: 0,
      drag: 0,
      accelG: 0,
      mach: 0,
      alpha: 0,
      q: 0,
      altitude: 0,
      speed: 0,
      airspeed: 0,
    };
  }

  /** Forces and torques at a given kinematic state. Does not apply rail or pad constraints. */
  function evaluate(pos: Vec3, vel: Vec3, omega: Vec3, quat: Quat, t: number): Eval {
    return evaluateInto(makeEval(), pos, vel, omega, quat, t);
  }

  // Same arithmetic, in the same order, as the vector-helper form (add/sub/scale/cross/quatRotate),
  // written out per component so no temporary arrays are allocated.
  function evaluateInto(o: Eval, pos: Vec3, vel: Vec3, omega: Vec3, quat: Quat, t: number): Eval {
    const px = pos[0];
    const py = pos[1];
    const pz = pos[2];
    const r = Math.sqrt(px * px + py * py + pz * pz);
    const altitude = r - R_EARTH - config.launchAltitude;
    const atm = airAt(r - R_EARTH);
    const tBurn = burnTimeAt(t);
    let mp: MassProps = deps.massProps(activeRocket, activeMotor, tBurn);
    if (isMultiStage && stageMotors) {
      // Between separation and ignition the next motor is not yet the active one: still count it.
      for (let s = activeMotor ? firingStageIdx + 1 : firingStageIdx; s < stageMotors.length; s++) {
        const um = stageMotors[s].motor;
        const mExtra = um.totalMass * carried[s].count;
        const cgExtra = carried[s].station ?? activeRocket.length * 0.5;
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
      activeMotor && ignited && tBurn < activeMotor.burnTime
        ? deps.thrust(activeMotor, tBurn) * activeCount * throttle
        : 0;
    const mass = mp.mass;

    const gk = -MU_EARTH / (r * r * r);
    const gx = px * gk;
    const gy = py * gk;
    const gz = pz * gk;
    windInto(sW, altitude, t);
    const vrx = vel[0] - sW[0];
    const vry = vel[1] - sW[1];
    const vrz = vel[2] - sW[2];
    const v = Math.sqrt(vrx * vrx + vry * vry + vrz * vrz);
    const qx = quat[0];
    const qy = quat[1];
    const qz = quat[2];
    const qw = quat[3];
    rotate(qx, qy, qz, qw, 0, 1, 0, sA); // nose direction, world
    const ax = sA[0];
    const ay = sA[1];
    const az = sA[2];
    const mach = atm.soundSpeed > 0 ? v / atm.soundSpeed : 0;
    const q = 0.5 * atm.rho * v * v;
    const aero: AeroProps = deps.aeroProps(activeRocket, mach, mp.cgX);
    const cd = cdAtReynolds(aero, mach, v, atm.rho, atm.temperature, activeRocket.length);
    const vDotA = vrx * ax + vry * ay + vrz * az;
    const alpha = v < 0.1 ? 0 : Math.acos(clamp(vDotA / v, -1, 1));

    let fx = 0;
    let fy = 0;
    let fz = 0;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    let drag: number;

    let chuteCdA = 0;
    for (let i = 0; i < chutes.length; i++) {
      const c = chutes[i];
      if (c.deployedAt === undefined) continue;
      const dtOpen = Math.max(0, t - c.deployedAt);
      const u = clamp(dtOpen / CHUTE_INFLATE_TIME, 0, 1);
      // Smooth S-curve canopy inflation (0.05 initial line stretch -> 1.0 full canopy)
      const inflate = 0.05 + 0.95 * (u * u * (3 - 2 * u));
      chuteCdA = chuteCdA + Math.PI * (c.chute.diameter / 2) ** 2 * c.chute.cd * inflate;
    }

    if (chuteCdA > 0) {
      // Canopy drag acts along the air-relative wind; body aerodynamics add residual damping
      // and right the rocket under the suspension lines during landing descent.
      const cs = -0.5 * atm.rho * v * chuteCdA;
      const cfx = vrx * cs;
      const cfy = vry * cs;
      const cfz = vrz * cs;
      const bodyDrag = q * aero.refArea * cd;
      let bfx = 0;
      let bfy = 0;
      let bfz = 0;
      if (v > 0) {
        const bs = -bodyDrag / v;
        bfx = vrx * bs;
        bfy = vry * bs;
        bfz = vrz * bs;
      }
      fx = cfx + bfx;
      fy = cfy + bfy;
      fz = cfz + bfz;
      drag = Math.sqrt(fx * fx + fy * fy + fz * fz);

      // Suspension lines attach fore of CG, pulling the rocket upright against the drag vector,
      // while rotational drag damps out post-deployment pendulum and tumble rates.
      const attachOffset = Math.max(0.02, mp.cgX * 0.4);
      const lx = ax * attachOffset;
      const ly = ay * attachOffset;
      const lz = az * attachOffset;
      const pendX = ly * cfz - lz * cfy;
      const pendY = lz * cfx - lx * cfz;
      const pendZ = lx * cfy - ly * cfx;
      // The rotational damping (CHUTE_DAMPING_RATE on each body axis) is added in the body frame
      // below, so a slender rocket's small roll inertia does not turn it into a stiff term.
      tx = pendX;
      ty = pendY;
      tz = pendZ;
    } else {
      drag = q * aero.refArea * cd;
      if (v > 0) {
        const ds = -drag / v;
        fx = vrx * ds;
        fy = vry * ds;
        fz = vrz * ds;
      }

      // Normal force opposes the lateral part of the relative wind.
      const latX = vrx - ax * vDotA;
      const latY = vry - ay * vDotA;
      const latZ = vrz - az * vDotA;
      const nx = latX * -1;
      const ny = latY * -1;
      const nz = latZ * -1;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      let ndx = 0;
      let ndy = 0;
      let ndz = 0;
      if (nl > 0) {
        const inv = 1 / nl;
        ndx = nx * inv;
        ndy = ny * inv;
        ndz = nz * inv;
      }
      const sa = Math.sin(alpha);
      const bodyLiftK = aero.bodyLift ?? (1.1 * (2 * rocket.maxRadius * rocket.length)) / aero.refArea;
      const finNoseS = q * aero.refArea * aero.cnAlpha * sa;
      const bodyS = q * aero.refArea * bodyLiftK * sa * sa;
      const fnS = finNoseS + bodyS;
      const fnx = ndx * fnS;
      const fny = ndy * fnS;
      const fnz = ndz * fnS;
      fx = fx + fnx;
      fy = fy + fny;
      fz = fz + fnz;
      // Torque about the CG. Barrowman lift acts at the CP and body lift at the body planform
      // centroid; a station aft of the CG gives a restoring torque. The force direction is
      // shared, so the two parts combine into one lever arm weighted by their size.
      const bodyX = aero.bodyLiftX ?? aero.cpX;
      const lev = fnS !== 0 ? mp.cgX - (finNoseS * aero.cpX + bodyS * bodyX) / fnS : mp.cgX - aero.cpX;
      const lx = ax * lev;
      const ly = ay * lev;
      const lz = az * lev;
      tx = tx + (ly * fnz - lz * fny);
      ty = ty + (lz * fnx - lx * fnz);
      tz = tz + (lx * fny - ly * fnx);

      // Pitch damping from the transverse part of the angular velocity.
      rotate(qx, qy, qz, qw, omega[0], omega[1], omega[2], sO);
      const owx = sO[0];
      const owy = sO[1];
      const owz = sO[2];
      const owDotA = owx * ax + owy * ay + owz * az;
      const otx = owx - ax * owDotA;
      const oty = owy - ay * owDotA;
      const otz = owz - az * owDotA;
      const dk = -0.5 * atm.rho * v * aero.refArea * aero.dampSum;
      tx = tx + otx * dk;
      ty = ty + oty * dk;
      tz = tz + otz * dk;
    }

    if (thrust > 0) {
      // Small-angle gimbal: rotate the nose direction about body X (pitch) then body Z (yaw).
      const p = controls.gimbalPitch;
      const y = controls.gimbalYaw;
      rotate(qx, qy, qz, qw, -Math.cos(p) * Math.sin(y), Math.cos(p) * Math.cos(y), Math.sin(p), sT);
      const ftx = sT[0] * thrust;
      const fty = sT[1] * thrust;
      const ftz = sT[2] * thrust;
      fx = fx + ftx;
      fy = fy + fty;
      fz = fz + ftz;
      // Nozzle sits (length - cgX) aft of the CG: the length of what is still attached.
      const nozzle = -(activeRocket.length - mp.cgX);
      const lx = ax * nozzle;
      const ly = ay * nozzle;
      const lz = az * nozzle;
      tx = tx + (ly * ftz - lz * fty);
      ty = ty + (lz * ftx - lx * ftz);
      tz = tz + (lx * fty - ly * ftx);
    }

    const invMass = 1 / mass;
    const acc = o.acc;
    acc[0] = gx + fx * invMass;
    acc[1] = gy + fy * invMass;
    acc[2] = gz + fz * invMass;
    // Torque to the body frame: rotate by the conjugate quaternion.
    rotate(-qx, -qy, -qz, qw, tx, ty, tz, sO);
    const iP = mp.iPitch;
    const iR = mp.iRoll;
    const o0 = omega[0];
    const o1 = omega[1];
    const o2 = omega[2];
    const iw0 = iP * o0;
    const iw1 = iR * o1;
    const iw2 = iP * o2;
    const g0 = o1 * iw2 - o2 * iw1;
    const g1 = o2 * iw0 - o0 * iw2;
    const g2 = o0 * iw1 - o1 * iw0;
    const od = o.omegaDot;
    od[0] = (sO[0] - g0) / iP;
    od[1] = (sO[1] - g1) / iR;
    od[2] = (sO[2] - g2) / iP;
    if (chuteCdA > 0) {
      // Under a canopy: torque = -CHUTE_DAMPING_RATE * I * omega about each body axis.
      od[0] -= CHUTE_DAMPING_RATE * o0;
      od[1] -= CHUTE_DAMPING_RATE * o1;
      od[2] -= CHUTE_DAMPING_RATE * o2;
    }

    // A hand-flown rocket turns as commanded, in the air or coasting; under a parachute it hangs.
    const rate = controls.rate;
    if (rate && handFlown && chuteCdA <= 0) {
      rotate(-qx, -qy, -qz, qw, rate[0], rate[1], rate[2], sO);
      od[0] = (sO[0] - o0) / STEER_TAU;
      od[1] = -o1 / STEER_TAU; // no roll command
      od[2] = (sO[2] - o2) / STEER_TAU;
    }

    o.mass = mass;
    o.cgX = mp.cgX;
    o.cpX = aero.cpX;
    o.refLength = aero.refLength;
    o.thrust = thrust;
    o.drag = drag;
    o.accelG = Math.sqrt(fx * fx + fy * fy + fz * fz) / (mass * G0);
    o.mach = mach;
    o.alpha = alpha;
    o.q = q;
    o.altitude = altitude;
    o.speed = len(vel);
    o.airspeed = v;
    return o;
  }

  function evalFinite(e: Eval): boolean {
    const a = e.acc;
    const w = e.omegaDot;
    return (
      Number.isFinite(a[0]) &&
      Number.isFinite(a[1]) &&
      Number.isFinite(a[2]) &&
      Number.isFinite(w[0]) &&
      Number.isFinite(w[1]) &&
      Number.isFinite(w[2]) &&
      Number.isFinite(e.mass) &&
      Number.isFinite(e.cgX) &&
      Number.isFinite(e.cpX) &&
      Number.isFinite(e.refLength) &&
      Number.isFinite(e.thrust) &&
      Number.isFinite(e.drag) &&
      Number.isFinite(e.accelG) &&
      Number.isFinite(e.mach) &&
      Number.isFinite(e.alpha) &&
      Number.isFinite(e.q) &&
      Number.isFinite(e.altitude) &&
      Number.isFinite(e.speed)
    );
  }

  function railDeriv(s: number, v: number, t: number): [number, number] {
    const pos = add(railStart, scale(railDir, s));
    const e = evaluate(pos, scale(railDir, v), ZERO, railQuat, t);
    let acc = dot(e.acc, railDir);
    // Lateral normal load on the launch rail (from rail tilt and crosswind) induces lug friction.
    const accParallel = scale(railDir, acc);
    const accLateral = len(sub(e.acc, accParallel));
    const frictionAcc = RAIL_FRICTION_MU * accLateral;
    if (v > 0) {
      acc -= frictionAcc;
    } else if (acc > 0) {
      acc = Math.max(0, acc - frictionAcc);
    }
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

  // RK4 scratch: one Eval per stage (its acc / omegaDot are that stage's k.v / k.w) and the
  // stage input vectors. Stage k.p is the velocity fed to that stage, so those must persist
  // until the final combination.
  let K1 = makeEval();
  const K2 = makeEval();
  const K3 = makeEval();
  const K4 = makeEval();
  const P2: Vec3 = [0, 0, 0];
  const V2: Vec3 = [0, 0, 0];
  const W2: Vec3 = [0, 0, 0];
  const P3: Vec3 = [0, 0, 0];
  const V3: Vec3 = [0, 0, 0];
  const W3: Vec3 = [0, 0, 0];
  const P4: Vec3 = [0, 0, 0];
  const V4: Vec3 = [0, 0, 0];
  const W4: Vec3 = [0, 0, 0];
  let evalMain = makeEval();
  // State at the start of the last committed substep, for locating the ground crossing.
  let prevT = 0;
  let prevPos: Vec3 | undefined;
  let prevVel: Vec3 | undefined;
  let prevAltitude = NaN;

  // evalMain holds the evaluation of the committed state. The next step's first RK4 stage
  // evaluates exactly that state again, so it is reused unless something evaluate() reads from
  // the closure changed in between (epoch), the state arrays were replaced, or the controls moved.
  let epoch = 0;
  let evalEpoch = -1;
  let evalT = NaN;
  let evalPos: Vec3 | undefined;
  let evalVel: Vec3 | undefined;
  let evalOmega: Vec3 | undefined;
  let evalQuat: Quat | undefined;
  let evalPitch = NaN;
  let evalYaw = NaN;

  function stage(
    P: Vec3,
    V: Vec3,
    W: Vec3,
    p0: Vec3,
    v0: Vec3,
    w0: Vec3,
    kp: Vec3,
    kv: Vec3,
    kw: Vec3,
    s: number,
  ): void {
    for (let i = 0; i < 3; i++) {
      P[i] = p0[i] + kp[i] * s;
      V[i] = v0[i] + kv[i] * s;
      W[i] = w0[i] + kw[i] * s;
    }
  }

  function integrateFree(h: number, t0: number): Kin {
    const p0 = state.pos;
    const v0 = state.vel;
    const w0 = state.omega;
    const q0 = state.quat;
    if (
      evalEpoch === epoch &&
      evalT === t0 &&
      evalPos === p0 &&
      evalVel === v0 &&
      evalOmega === w0 &&
      evalQuat === q0 &&
      evalPitch === controls.gimbalPitch &&
      evalYaw === controls.gimbalYaw
    ) {
      const reuse = evalMain;
      evalMain = K1;
      K1 = reuse;
    } else {
      evaluateInto(K1, p0, v0, w0, q0, t0);
    }
    evalEpoch = -1;
    stage(P2, V2, W2, p0, v0, w0, v0, K1.acc, K1.omegaDot, h / 2);
    evaluateInto(K2, P2, V2, W2, q0, t0 + h / 2);
    stage(P3, V3, W3, p0, v0, w0, V2, K2.acc, K2.omegaDot, h / 2);
    evaluateInto(K3, P3, V3, W3, q0, t0 + h / 2);
    stage(P4, V4, W4, p0, v0, w0, V3, K3.acc, K3.omegaDot, h);
    evaluateInto(K4, P4, V4, W4, q0, t0 + h);
    const pos = rk4(p0, v0, V2, V3, V4, h);
    const vel = rk4(v0, K1.acc, K2.acc, K3.acc, K4.acc, h);
    const omega = rk4(w0, K1.omegaDot, K2.omegaDot, K3.omegaDot, K4.omegaDot, h);
    // Orientation advances with the trapezoidal mean body rate, then renormalises.
    const quat = quatIntegrate(q0, scale(add(w0, omega), 0.5), h);
    return { pos, vel, omega, quat };
  }

  function applyDerived(e: Eval): void {
    state.mass = e.mass;
    state.altitude = e.altitude;
    state.speed = e.speed;
    state.airspeed = e.airspeed;
    state.mach = e.mach;
    state.alpha = e.alpha;
    state.dynamicPressure = e.q;
    state.thrust = e.thrust;
    state.drag = e.drag;
    // An accelerometer on the pad reads 1 g until the thrust takes the weight.
    state.accelG = state.phase === 'pad' ? Math.max(e.accelG, 1) : e.accelG;
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
    // The step that crossed the ground ended below it: move back to where the altitude was zero
    // (linear in the step), so the landing time, point and speed do not depend on the step size.
    if (prevPos && prevVel && prevAltitude > 0 && state.altitude < 0 && prevT < state.t) {
      const f = prevAltitude / (prevAltitude - state.altitude);
      const p = state.pos;
      const v = state.vel;
      state.pos = [
        prevPos[0] + (p[0] - prevPos[0]) * f,
        prevPos[1] + (p[1] - prevPos[1]) * f,
        prevPos[2] + (p[2] - prevPos[2]) * f,
      ];
      state.vel = [
        prevVel[0] + (v[0] - prevVel[0]) * f,
        prevVel[1] + (v[1] - prevVel[1]) * f,
        prevVel[2] + (v[2] - prevVel[2]) * f,
      ];
      state.speed = len(state.vel);
      state.t = prevT + (state.t - prevT) * f;
    }
    const impact = state.speed;
    const vDown = Math.max(0, -radialVelocity(state.pos, state.vel));
    const vHoriz = Math.sqrt(Math.max(0, impact * impact - vDown * vDown));
    const k = (R_EARTH + config.launchAltitude) / len(state.pos);
    // Clamp to the ground and stop.
    state.pos = scale(state.pos, k);
    state.vel = [0, 0, 0];
    state.omega = [0, 0, 0];
    // A pilot may also set the rocket down gently on its tail, with no parachute.
    const upright = (): boolean =>
      dot(quatRotate(state.quat, [0, 1, 0]), normalize(state.pos)) >= UPRIGHT_COS;
    const ok =
      (state.chuteDeployed || (handFlown && upright())) &&
      vDown <= SAFE_LANDING_SPEED &&
      impact <= SAFE_LANDING_SPEED * 1.5;
    state.phase = ok ? 'landed' : 'crashed';
    isDone = true;
    applyDerived(evaluate(state.pos, state.vel, state.omega, state.quat, state.t));
    if (ok) {
      emit(
        'landing',
        `Landed at ${impact.toFixed(1)} m/s (${vDown.toFixed(1)} m/s vertical, ${vHoriz.toFixed(1)} m/s drift)`,
        state.t,
        0,
        impact,
      );
    } else {
      emit(
        'crash',
        `Impact at ${impact.toFixed(1)} m/s (${vDown.toFixed(1)} m/s vertical)`,
        state.t,
        0,
        impact,
      );
    }
  }

  /** A motor that ran out before the rocket could leave: the flight is over. */
  function burntOutOnTheGround(): void {
    burnoutT = state.t;
    emit('burnout', 'Motor burned out before the rocket left the pad');
    state.phase = 'landed';
    state.vel = [0, 0, 0];
    state.speed = 0;
    state.accelG = 1;
    isDone = true;
  }

  function hasStageToDrop(): boolean {
    return Boolean(isMultiStage && stageMotors && rocket.stages && firingStageIdx + 1 < stageMotors.length);
  }

  /** Separate the firing stage at time t; the next one lights after its ignition delay. */
  function dropStage(t: number): void {
    if (!stageMotors || !rocket.stages) return;
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
    // Boosters, pods and tube fins leave with the stage they are mounted on.
    const keptSide = (activeRocket.sideBodies ?? []).filter((sb) => {
      const x0 = Math.min(...sb.components.map((c) => c.x));
      const x1 = Math.max(...sb.components.map((c) => c.x + c.length));
      return (x0 + x1) / 2 <= newLen;
    });
    epoch++;
    activeRocket = { ...activeRocket, components: kept, length: newLen, maxRadius: newMaxR, sideBodies: keptSide };
    activeCount = motorCount(activeRocket);
    const keptSet = new Set<Component>(kept);
    for (let ci = chutes.length - 1; ci >= 0; ci--) {
      if (!keptSet.has(chutes[ci].chute)) chutes.splice(ci, 1);
    }
    emit('stage separation', `Stage ${firingStageIdx + 1} separation at ${state.altitude.toFixed(1)} m`);
    firingStageIdx++;
    const nextStage = stageMotors[firingStageIdx];
    nextStageIgnitionT = t + (nextStage.ignitionDelay ?? 0);
    activeMotor = null;
  }

  function separateStage(): boolean {
    if (!handFlown || isDone || !hasStageToDrop() || nextStageIgnitionT !== undefined) return false;
    if (state.phase !== 'boost' && state.phase !== 'coast') return false;
    state.phase = 'coast';
    dropStage(state.t);
    applyDerived(evaluate(state.pos, state.vel, state.omega, state.quat, state.t));
    return true;
  }

  function deployChutes(): boolean {
    if (!handFlown || isDone || state.phase === 'pad' || state.phase === 'rail') return false;
    // Between separation and the next ignition a second press of Stage must not end the climb.
    if (nextStageIgnitionT !== undefined) return false;
    const packed = chutes.filter((c) => c.deployedAt === undefined);
    if (packed.length === 0) return false;
    epoch++;
    engineCut = true;
    throttle = commandedThrottle();
    for (const run of packed) run.deployedAt = state.t;
    state.chuteDeployed = true;
    state.phase = 'descent';
    emit('chuteDeploy', `Parachute fired by hand at ${state.altitude.toFixed(0)} m, speed ${state.speed.toFixed(1)} m/s`);
    return true;
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
      } else if (ignited && !motorUnburnt()) {
        burntOutOnTheGround();
      }
      return;
    }

    if (state.phase === 'rail') {
      if (railS >= config.railLength) {
        railExited = true;
        // A motor shut off by hand still has a boost to finish.
        state.phase = e.thrust > 0 || (handFlown && motorUnburnt()) ? 'boost' : 'coast';
        prevRadialV = radialVelocity(state.pos, state.vel);
        emit('railExit', `Left rail at ${state.speed.toFixed(1)} m/s`);
      } else if (railV <= 0 && ignited && !motorUnburnt()) {
        burntOutOnTheGround();
      }
      return;
    }

    const tBurn = burnTimeAt(t);

    if (nextStageIgnitionT !== undefined && t >= nextStageIgnitionT && stageMotors) {
      epoch++;
      activeMotor = stageMotors[firingStageIdx].motor;
      tIgnition = t;
      burnLag = 0;
      nextStageIgnitionT = undefined;
      state.phase = 'boost';
      emit('stage ignition', `Stage ${firingStageIdx + 1} ignition at ${state.altitude.toFixed(1)} m`);
    }

    if (state.phase === 'boost' && activeMotor && tBurn >= activeMotor.burnTime) {
      state.phase = 'coast';
      if (hasStageToDrop()) {
        dropStage(t);
      } else {
        burnoutT = t;
        emit('burnout', `Burnout at ${state.speed.toFixed(1)} m/s, ${state.altitude.toFixed(1)} m`);
      }
    }

    const rv = radialVelocity(state.pos, state.vel);

    if (apogeeT === undefined && railExited && prevRadialV > 0 && rv <= 0) {
      // The vertical speed changed sign inside the last substep: place the apex there, with the
      // vertical speed taken as linear over the substep, so long coast steps do not blur it.
      const h = t - prevT;
      const f = prevRadialV / (prevRadialV - rv);
      const after = (1 - f) * h;
      const altApex = h > 0 ? state.altitude + (0.5 * (prevRadialV - rv) * after * after) / h : state.altitude;
      apogeeT = h > 0 ? prevT + f * h : t;
      emit('apogee', `Apogee at ${altApex.toFixed(1)} m`, apogeeT, altApex);
    }
    prevRadialV = rv;

    // A hand-flown rocket has no automatic recovery: the pilot fires the parachute (deployChutes).
    if (
      !handFlown &&
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
      if (handFlown || run.deployedAt !== undefined) continue;
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
        epoch++;
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
    const next = commandedThrottle();
    if (next !== throttle) {
      epoch++;
      throttle = next;
    }
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
    const e = evaluateInto(evalMain, cand.pos, cand.vel, cand.omega, cand.quat, t1);
    if (
      !isFiniteVec(cand.pos) ||
      !isFiniteVec(cand.vel) ||
      !isFiniteVec(cand.omega) ||
      !isFiniteVec(cand.quat) ||
      !evalFinite(e)
    ) {
      diverge();
      return;
    }

    if (railNext) {
      railS = railNext.s;
      railV = railNext.v;
    }
    if (ignited) burnLag += h * (1 - throttle);
    prevT = t0;
    prevPos = state.pos;
    prevVel = state.vel;
    prevAltitude = state.altitude;
    state.t = t1;
    state.pos = cand.pos;
    state.vel = cand.vel;
    state.omega = cand.omega;
    state.quat = cand.quat;
    evalEpoch = epoch;
    evalT = t1;
    evalPos = cand.pos;
    evalVel = cand.vel;
    evalOmega = cand.omega;
    evalQuat = cand.quat;
    evalPitch = controls.gimbalPitch;
    evalYaw = controls.gimbalYaw;
    applyDerived(e);
    transitions(e);
    tickLog();
  }

  // Initial derived values and first log sample.
  applyDerived(evaluate(state.pos, state.vel, state.omega, state.quat, 0));
  pushLog();

  function ignite(): void {
    if (!motor || ignited || isDone) return;
    epoch++;
    ignited = true;
    tIgnition = state.t;
    const lit = activeMotor ?? motor;
    const many = activeCount > 1 ? `${activeCount} x ` : '';
    emit('ignition', `Ignition: ${many}${lit.manufacturer} ${lit.designation}`);
  }

  /** Coast step above HIGH_ALTITUDE: long while the body turns slowly, COAST_SUBSTEP when hand-flown. */
  function coastSubstep(): number {
    if ((handFlown && controls.rate) || state.dynamicPressure > COAST_MAX_Q) return COAST_SUBSTEP;
    const w = state.omega;
    const rate = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
    return clamp(rate > 0 ? COAST_TURN / rate : COAST_SUBSTEP_MAX, COAST_SUBSTEP, COAST_SUBSTEP_MAX);
  }

  /** True when at least one canopy is deployed and every deployed one has opened and settled. */
  function canopySettled(): boolean {
    let any = false;
    for (let i = 0; i < chutes.length; i++) {
      const d = chutes[i].deployedAt;
      if (d === undefined) continue;
      if (state.t < d + CHUTE_INFLATE_TIME + CANOPY_SETTLE_TIME) return false;
      any = true;
    }
    return any;
  }

  function step(dt: number, ctrl?: Controls): void {
    const next = ctrl ?? NO_CONTROLS;
    // The cached evaluation of the current state is stale once the commands change.
    const a = controls.rate;
    const b = next.rate;
    const sameRate = a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
    controls = next;
    if (!sameRate) epoch++;
    if (next.throttle !== undefined || next.rate !== undefined) handFlown = true;
    if (isDone || !(dt > 0)) return;
    let remaining = dt;
    let n = 0;
    while (remaining > 1e-12 && !isDone && n < MAX_SUBSTEPS_PER_CALL) {
      const unpowered = state.thrust <= 0;
      const coasting = unpowered && state.altitude >= HIGH_ALTITUDE;
      const hMax = coasting ? coastSubstep() : unpowered && canopySettled() ? CANOPY_SUBSTEP : MAX_SUBSTEP;
      const h = Math.min(remaining, hMax);
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
    deployChutes,
    separateStage,
  };
}
