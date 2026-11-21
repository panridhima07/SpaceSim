// The flight simulator: a six-degree-of-freedom rigid body with changing mass, flown in
// an Earth-centred inertial frame from the launch pad to orbit and beyond.
//
// Body axes: +X along the vehicle toward the nose, +Y and +Z lateral. On the pad +X is
// up and +Z points down-range, so after pitch-over +Z faces the ground like an aircraft.
//
// Integrated state: position, velocity, attitude quaternion, body rates, propellant in
// every tank, plus two bookkeeping integrals (stagnation heat load and delta-v spent).
// Discrete things (what is attached, which engines are lit, throttle and gimbal position)
// are held constant across each step and changed between steps.

import { G0, MU_EARTH, OMEGA_EARTH, RE } from '../constants.ts';
import {
  add,
  clamp,
  cross,
  dot,
  norm,
  qPointing,
  qderiv,
  qnormalize,
  qrot,
  qrotInv,
  scale,
  slerpToward,
  sub,
  unit,
  type Quat,
  type Vec3,
} from '../math/vec.ts';
import { Dopri5, rk4Step } from '../math/integrators.ts';
import { atmosphere, type WindModel } from '../env/atmosphere.ts';
import { ecefToEci, geodeticToEcef, gmst, greatCircleDistance, groundVelocity, julianDate, localFrame, type LaunchSite } from '../env/earth.ts';
import { gravityAccel, type GravityOptions, type ThirdBodies } from '../env/gravity.ts';
import { moonPosition, sunPosition } from '../env/ephemeris.ts';
import { engineOutput, thrustCurveAt } from '../propulsion/engine.ts';
import { aeroForces, aeroGeometry, freeMolecularHeatFlux, stagnationHeatFlux, type AeroGeometry } from '../aero/aero.ts';
import { massProperties, stageMass, type MassProps } from '../vehicle/massprops.ts';
import { boosterCount, initialPropellant, initialRuntime, tankOffsets, type VehicleRuntime, type VehicleSpec } from '../vehicle/types.ts';
import { elementsFromState, type OrbitalElements } from '../orbit/kepler.ts';
import { accelAt, type ForceModel } from '../orbit/propagate.ts';

export interface SimConfig {
  site: LaunchSite;
  /** Launch date (sets Earth orientation and where the Sun and Moon are). Default J2000. */
  epoch?: Date | number;
  /** Integration step while thrusting or in the atmosphere, s. Default 0.02. */
  dt?: number;
  gravity?: GravityOptions;
  wind?: WindModel;
  /** Direction the vehicle's pitch plane faces on the pad, degrees clockwise from north. */
  padAzimuthDeg?: number;
  /** Seconds of simulated time between telemetry records. Default 1. */
  logInterval?: number;
  /** Above this altitude an unpowered vehicle is flown with large adaptive steps. Default 150 km. */
  coastAltitude?: number;
  control?: { kp?: number; kd?: number; kdRoll?: number; maxSlewRate?: number };
}

export interface FlightEvent {
  t: number;
  type: string;
  message: string;
}

/** Decides what the vehicle does. May return the longest step it can tolerate before being called again, s. */
export interface FlightComputer {
  update(sim: Simulation): number | void;
}

export interface Debris {
  name: string;
  t: number;
  r: Vec3;
  v: Vec3;
  mass: number;
  refArea: number;
}

/** Everything worth knowing about the instant, refreshed before every step. */
export interface Diagnostics {
  altitude: number;
  lat: number;
  /** Geographic longitude, rad. */
  lon: number;
  up: Vec3;
  east: Vec3;
  north: Vec3;
  /** Velocity relative to the air, ECI components. */
  vRel: Vec3;
  speedRel: number;
  speedInertial: number;
  verticalSpeed: number;
  mach: number;
  /** Dynamic pressure, Pa. */
  q: number;
  /** Angle of attack, rad. */
  alpha: number;
  thrust: number;
  stageThrust: number[];
  massFlow: number;
  mass: number;
  /** Acceleration felt on board (everything but gravity), in g. */
  accelG: number;
  drag: number;
  pressure: number;
  density: number;
  heatFlux: number;
  fmHeatFlux: number;
  knudsen: number;
  /** Pitch of the nose above the local horizon, rad. */
  pitch: number;
  /** Compass heading of the nose, rad from north. */
  heading: number;
  massProps: MassProps;
  cp: number;
  /** Aerodynamic moment about the CG, body axes, N m. */
  aeroMoment: Vec3;
}

export interface Telemetry {
  t: number;
  altitude: number;
  latDeg: number;
  lonDeg: number;
  downrange: number;
  speed: number;
  speedRel: number;
  verticalSpeed: number;
  mach: number;
  q: number;
  alphaDeg: number;
  pitchDeg: number;
  accelG: number;
  thrust: number;
  mass: number;
  heatFlux: number;
  apoapsis: number;
  periapsis: number;
  inclinationDeg: number;
}

const IR = 0, IV = 3, IQ = 6, IW = 10, IHEAT = 13, IDV = 14, IPROP = 15;

export class Simulation {
  readonly vehicle: VehicleSpec;
  readonly cfg: SimConfig;
  readonly epochJD: number;
  readonly dt: number;

  t = 0;
  r: Vec3 = [0, 0, 0];
  v: Vec3 = [0, 0, 0];
  q: Quat = [0, 0, 0, 1];
  w: Vec3 = [0, 0, 0];
  prop: number[];
  /** Integrated stagnation-point heat, J/m^2. */
  heatLoad = 0;
  /** Integrated thrust acceleration, m/s: the delta-v actually spent. */
  dvExpended = 0;

  rt: VehicleRuntime;
  /** True while the hold-down clamps keep the vehicle on the pad. */
  held = true;
  liftoffTime = NaN;
  ended = false;

  /** Commands. Set by the flight computer, or by hand for manual flight. */
  cmd: { throttle: number; attitude: Vec3 | null } = { throttle: 1, attitude: null };
  /** Thrust deflection (sine of the gimbal angle about body Y and Z). */
  gimbal: [number, number] = [0, 0];
  flightComputer?: FlightComputer;

  diag!: Diagnostics;
  events: FlightEvent[] = [];
  log: Telemetry[] = [];
  debris: Debris[] = [];
  maxQ = { value: 0, t: 0, altitude: 0 };
  maxG = { value: 0, t: 0 };
  maxHeatFlux = { value: 0, t: 0 };

  private readonly theta0: number;
  private readonly padEcef: Vec3;
  private readonly offs: number[];
  private bodies: ThirdBodies = {};
  private geom: AeroGeometry;
  private rcs: Vec3 = [0, 0, 0];
  private attRef: Vec3 | null = null;
  private nextLog = 0;
  private coastSolver: Dopri5;
  private coastModel: ForceModel;

  constructor(vehicle: VehicleSpec, cfg: SimConfig, flightComputer?: FlightComputer) {
    this.vehicle = vehicle;
    this.cfg = cfg;
    this.flightComputer = flightComputer;
    this.dt = cfg.dt ?? 0.02;
    const ep = cfg.epoch ?? 2451545.0;
    this.epochJD = typeof ep === 'number' ? ep : julianDate(ep);
    this.theta0 = gmst(this.epochJD);
    const d2r = Math.PI / 180;
    this.padEcef = geodeticToEcef(cfg.site.latDeg * d2r, cfg.site.lonDeg * d2r, cfg.site.altitude ?? 0);
    this.rt = initialRuntime(vehicle);
    this.prop = initialPropellant(vehicle);
    this.offs = tankOffsets(vehicle);
    this.geom = aeroGeometry(vehicle, this.rt);
    this.coastModel = { epochJD: this.epochJD, gravity: cfg.gravity };
    this.coastSolver = new Dopri5(
      (t, y) => {
        const a = accelAt(t, [y[0], y[1], y[2]], [y[3], y[4], y[5]], this.coastModel);
        return [y[3], y[4], y[5], a[0], a[1], a[2]];
      },
      { rtol: 1e-10, atol: 1e-6, hInit: 1, hMax: 60 },
    );
    this.applyPadState();
    this.refresh();
  }

  // ---- public controls -----------------------------------------------------

  /** Sidereal angle of the Earth at the current time. */
  get earthAngle(): number {
    return this.theta0 + OMEGA_EARTH * this.t;
  }
  /** Time since liftoff, s (NaN before). */
  get missionTime(): number {
    return this.t - this.liftoffTime;
  }

  ignite(stage: number): boolean {
    const st = this.rt.stages[stage];
    const s = this.vehicle.stages[stage];
    if (!st.attached || st.engineOn || st.burnedOut) return false;
    if (st.ignitionsUsed >= (s.engine.ignitions ?? 1)) {
      this.event('warning', `${s.name}: no ignitions left`);
      return false;
    }
    st.engineOn = true;
    st.ignitionTime = this.t;
    st.ignitionsUsed++;
    this.event('ignition', `${s.name} ignition (${s.engineCount * boosterCount(s)} x ${s.engine.name})`);
    return true;
  }

  shutdown(stage: number, reason = 'cutoff'): void {
    const st = this.rt.stages[stage];
    if (!st.engineOn) return;
    if (this.vehicle.stages[stage].engine.thrustCurve && reason !== 'burnout') return; // solids cannot be stopped
    st.engineOn = false;
    st.throttle = 0;
    this.event(reason, `${this.vehicle.stages[stage].name} ${reason}`);
  }

  /** Let go of the pad. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    this.liftoffTime = this.t;
    this.event('liftoff', `Liftoff, thrust-to-weight ${(this.diag.thrust / (this.diag.mass * G0)).toFixed(2)}`);
  }

  jettison(stage: number): void {
    const st = this.rt.stages[stage];
    if (!st.attached) return;
    const s = this.vehicle.stages[stage];
    const before = massProperties(this.vehicle, this.rt, this.prop);
    st.attached = false;
    st.engineOn = false;
    st.throttle = 0;
    this.debris.push({
      name: s.name,
      t: this.t,
      r: this.r,
      v: this.v,
      mass: stageMass(this.vehicle, stage, this.prop),
      refArea: Math.PI * s.radius ** 2 * boosterCount(s),
    });
    this.afterMassChange(before);
    this.event('separation', `${s.name} separation`);
  }

  jettisonFairing(): void {
    if (!this.rt.fairingAttached || !this.vehicle.fairing) return;
    const before = massProperties(this.vehicle, this.rt, this.prop);
    this.rt.fairingAttached = false;
    this.debris.push({ name: 'Fairing', t: this.t, r: this.r, v: this.v, mass: this.vehicle.fairing.mass, refArea: 20 });
    this.afterMassChange(before);
    this.event('fairing', 'Fairing jettison');
  }

  /** Manual staging: drop spent boosters, or drop the lowest core stage and light the next. */
  stage(): void {
    const stages = this.vehicle.stages;
    if (this.held) {
      stages.forEach((s, i) => {
        if ((s.ignition ?? (s.parallel || i === this.lowestCore() ? 'liftoff' : 'stack')) === 'liftoff') this.ignite(i);
      });
      return;
    }
    const spent = stages.findIndex((s, i) => s.parallel && this.rt.stages[i].attached && this.rt.stages[i].burnedOut);
    if (spent >= 0) {
      this.jettison(spent);
      return;
    }
    const low = this.lowestCore();
    const next = stages.findIndex((s, i) => i > low && !s.parallel && this.rt.stages[i].attached);
    if (next >= 0) {
      this.jettison(low);
      this.ignite(next);
    }
  }

  /** Index of the lowest core (non-booster) stage still attached, or -1. */
  lowestCore(): number {
    return this.vehicle.stages.findIndex((s, i) => !s.parallel && this.rt.stages[i].attached);
  }

  event(type: string, message: string): void {
    this.events.push({ t: this.t, type, message });
  }

  elements(): OrbitalElements {
    return elementsFromState(this.r, this.v, MU_EARTH);
  }

  // ---- stepping ------------------------------------------------------------

  /** Advance the simulation by dt seconds (any size; it is subdivided internally). */
  step(dt: number): void {
    const tEnd = this.t + dt;
    let guard = 0;
    while (!this.ended && this.t < tEnd - 1e-9) {
      this.substep(tEnd - this.t);
      if (++guard > 50_000_000) throw new Error('Simulation.step: runaway');
    }
  }

  /** Run until `until(sim)` is true, the flight ends, or tMax is reached. */
  run(tMax: number, until?: (sim: Simulation) => boolean): void {
    while (!this.ended && this.t < tMax) {
      this.substep(tMax - this.t);
      if (until && until(this)) break;
    }
  }

  private substep(remaining: number): void {
    let hint = Infinity;
    if (this.flightComputer) {
      const r = this.flightComputer.update(this);
      if (typeof r === 'number' && r > 0) hint = r;
    }
    if (this.ended) return;
    this.checkBurnout();

    if (this.held) {
      const h = Math.max(1e-6, Math.min(this.dt, remaining, hint));
      this.updateThrottles(h);
      const p = atmosphere(this.cfg.site.altitude ?? 0).pressure;
      this.forEachBurning((i, thr) => {
        const s = this.vehicle.stages[i];
        const rate = engineOutput(s.engine, thr, p).massFlow * s.engineCount;
        s.tanks.forEach((tk, k) => (this.prop[this.offs[i] + k] = Math.max(0, this.prop[this.offs[i] + k] - rate * tk.flowFraction * h)));
      });
      this.t += h;
      this.applyPadState();
    } else {
      const burning = this.rt.stages.some((s) => s.attached && s.engineOn);
      if (!burning && this.diag.altitude > (this.cfg.coastAltitude ?? 150e3)) {
        this.coastStep(Math.min(remaining, hint));
      } else {
        const h = Math.max(1e-6, Math.min(this.dt, remaining, hint, this.timeToDepletion()));
        this.updateThrottles(h);
        this.control(h);
        const y = rk4Step((t, yy) => this.evaluate(t, yy, false), this.t, this.pack(), h);
        this.unpack(y);
        this.t += h;
      }
    }
    this.refresh();
    this.bookkeeping();
  }

  /** Unpowered flight above the atmosphere: translation only, large adaptive steps. */
  private coastStep(maxDt: number): void {
    const d = this.diag;
    const floor = this.cfg.coastAltitude ?? 150e3;
    // Do not step so far that a descending vehicle skips the atmosphere.
    const safe = d.verticalSpeed < 0 ? 1 + (0.5 * (d.altitude - floor)) / -d.verticalSpeed : Infinity;
    const H = Math.max(1e-3, Math.min(maxDt, safe));
    this.coastModel.drag = { cdAOverM: (2.2 * this.geom.refArea) / d.mass };
    const s = this.coastSolver.step(this.t, [...this.r, ...this.v], this.t + H);
    this.r = [s.y[0], s.y[1], s.y[2]];
    this.v = [s.y[3], s.y[4], s.y[5]];
    this.t = s.t;
    if (this.cmd.attitude) {
      // Attitude is assumed held by the reaction control system while coasting.
      const dir = unit(this.cmd.attitude);
      this.q = qPointing(dir, scale(unit(this.r), -1));
      this.w = [0, 0, 0];
      this.attRef = dir;
    }
  }

  // ---- internals -----------------------------------------------------------

  private pack(): number[] {
    return [...this.r, ...this.v, ...this.q, ...this.w, this.heatLoad, this.dvExpended, ...this.prop];
  }

  private unpack(y: number[]): void {
    this.r = [y[IR], y[IR + 1], y[IR + 2]];
    this.v = [y[IV], y[IV + 1], y[IV + 2]];
    this.q = qnormalize([y[IQ], y[IQ + 1], y[IQ + 2], y[IQ + 3]]);
    this.w = [y[IW], y[IW + 1], y[IW + 2]];
    this.heatLoad = y[IHEAT];
    this.dvExpended = y[IDV];
    for (let k = 0; k < this.prop.length; k++) this.prop[k] = Math.max(0, y[IPROP + k]);
  }

  /** The vehicle clamped to the rotating Earth. */
  private applyPadState(): void {
    const th = this.earthAngle;
    this.r = ecefToEci(this.padEcef, th);
    this.v = groundVelocity(this.r);
    const lf = localFrame(this.r);
    const az = ((this.cfg.padAzimuthDeg ?? 90) * Math.PI) / 180;
    const downrange = add(scale(lf.east, Math.sin(az)), scale(lf.north, Math.cos(az)));
    this.q = qPointing(lf.up, downrange);
    this.w = qrotInv(this.q, [0, 0, OMEGA_EARTH]);
  }

  private forEachBurning(fn: (stage: number, throttle: number) => void): void {
    this.rt.stages.forEach((st, i) => {
      if (!st.attached || !st.engineOn) return;
      const e = this.vehicle.stages[i].engine;
      const thr = e.thrustCurve ? thrustCurveAt(e.thrustCurve, this.t - st.ignitionTime) : st.throttle;
      if (thr > 0) fn(i, thr);
    });
  }

  private updateThrottles(h: number): void {
    this.rt.stages.forEach((st, i) => {
      if (!st.attached || !st.engineOn) return;
      const e = this.vehicle.stages[i].engine;
      if (e.thrustCurve) {
        st.throttle = thrustCurveAt(e.thrustCurve, this.t - st.ignitionTime);
        return;
      }
      const target = clamp(this.cmd.throttle, e.minThrottle ?? 1, 1);
      const tau = (e.spoolTime ?? 1) / 3;
      st.throttle += (target - st.throttle) * (1 - Math.exp(-h / tau));
    });
  }

  /** Shut down any stage whose propellant has run out. */
  private checkBurnout(): void {
    this.rt.stages.forEach((st, i) => {
      if (!st.attached || !st.engineOn) return;
      const s = this.vehicle.stages[i];
      const res = s.residualFraction ?? 0.005;
      let dry = s.tanks.some((tk, k) => this.prop[this.offs[i] + k] <= res * tk.propellantMass + 1e-6);
      const curve = s.engine.thrustCurve;
      if (curve && this.t - st.ignitionTime >= curve[curve.length - 1][0]) dry = true;
      if (dry) {
        st.burnedOut = true;
        st.burnoutTime = this.t;
        this.shutdown(i, 'burnout');
      }
    });
  }

  /** Seconds until the first burning tank reaches its residual level at the present flow. */
  private timeToDepletion(): number {
    let tMin = Infinity;
    this.forEachBurning((i, thr) => {
      const s = this.vehicle.stages[i];
      const rate = engineOutput(s.engine, thr, 0).massFlow * s.engineCount;
      const res = s.residualFraction ?? 0.005;
      s.tanks.forEach((tk, k) => {
        const left = this.prop[this.offs[i] + k] - res * tk.propellantMass;
        tMin = Math.min(tMin, left / (rate * tk.flowFraction));
      });
    });
    return Math.max(tMin, 1e-5);
  }

  /** Keep the centre of mass continuous when part of the vehicle is dropped. */
  private afterMassChange(before: MassProps): void {
    const after = massProperties(this.vehicle, this.rt, this.prop);
    // Stations are measured from the stack base, which moves; the payload interface does not.
    const shift = after.cg - after.top - (before.cg - before.top);
    const d: Vec3 = [shift, 0, 0];
    this.r = add(this.r, qrot(this.q, d));
    this.v = add(this.v, qrot(this.q, cross(this.w, d)));
    this.geom = aeroGeometry(this.vehicle, this.rt);
    this.refresh();
  }

  /**
   * Attitude control. A PD law asks for an angular acceleration; the torque it needs is
   * produced by swivelling the engines (thrust-vector control) and, when no engine burns
   * or for roll, by reaction-control thrusters. Limits and slew rates are respected.
   */
  private control(h: number): void {
    const c = this.cfg.control ?? {};
    const d = this.diag;
    const target = this.cmd.attitude;
    const xAxis = qrot(this.q, [1, 0, 0]);
    let gimbalRate = Infinity;
    let maxSin = 0;
    let authority = 0;
    let rcsLimit = 0;
    this.rt.stages.forEach((st, i) => {
      if (!st.attached) return;
      const s = this.vehicle.stages[i];
      rcsLimit = Math.max(rcsLimit, s.rcsTorque ?? 0);
      const g = s.engine.maxGimbal ?? 0;
      if (g > 0 && d.stageThrust[i] > 0) {
        authority += d.stageThrust[i] * (d.massProps.cg - d.massProps.stageBase[i]);
        maxSin = Math.max(maxSin, Math.sin(g));
        gimbalRate = Math.min(gimbalRate, s.engine.gimbalRate ?? 0.35);
      }
    });
    if (!target) {
      this.attRef = null;
      this.gimbal = [0, 0];
      this.rcs = [0, 0, 0];
      return;
    }
    const slew = c.maxSlewRate ?? 0.06;
    this.attRef = slerpToward(this.attRef ?? xAxis, unit(target), slew * h);
    const db = qrotInv(this.q, this.attRef);
    // Rotation vector that takes body X onto the reference direction.
    const s = Math.hypot(db[1], db[2]);
    const ang = Math.atan2(s, db[0]);
    const ey = s > 1e-9 ? (-db[2] / s) * ang : 0;
    const ez = s > 1e-9 ? (db[1] / s) * ang : 0;
    const kp = c.kp ?? 1.5;
    const kd = c.kd ?? 2.2;
    const I = d.massProps.inertia;
    const w = this.w;
    // Feed-forward cancels the gyroscopic coupling and the (known, scheduled) aerodynamic
    // moment. A finless launcher is aerodynamically unstable; without this the gain would
    // have to out-muscle the air at max Q.
    const tau: Vec3 = [
      I[0] * -(c.kdRoll ?? 1) * w[0] + (I[2] - I[1]) * w[1] * w[2],
      I[1] * (kp * ey - kd * w[1]) + (I[0] - I[2]) * w[2] * w[0] - d.aeroMoment[1],
      I[2] * (kp * ez - kd * w[2]) + (I[1] - I[0]) * w[0] * w[1] - d.aeroMoment[2],
    ];
    let achievedY = 0;
    let achievedZ = 0;
    if (authority > 1) {
      // tau_y = authority * u_z, tau_z = -authority * u_y
      let uy = -tau[2] / authority;
      let uz = tau[1] / authority;
      const mag = Math.hypot(uy, uz);
      if (mag > maxSin) {
        uy *= maxSin / mag;
        uz *= maxSin / mag;
      }
      const dy = uy - this.gimbal[0];
      const dz = uz - this.gimbal[1];
      const dm = Math.hypot(dy, dz);
      const lim = gimbalRate * h;
      const f = dm > lim ? lim / dm : 1;
      this.gimbal = [this.gimbal[0] + dy * f, this.gimbal[1] + dz * f];
      achievedY = authority * this.gimbal[1];
      achievedZ = -authority * this.gimbal[0];
    } else {
      this.gimbal = [0, 0];
    }
    this.rcs = [
      clamp(tau[0], -rcsLimit, rcsLimit),
      clamp(tau[1] - achievedY, -rcsLimit, rcsLimit),
      clamp(tau[2] - achievedZ, -rcsLimit, rcsLimit),
    ];
  }

  /** Equations of motion: time derivative of the packed state. */
  private evaluate(t: number, y: number[], fillDiag: boolean): number[] {
    const r: Vec3 = [y[IR], y[IR + 1], y[IR + 2]];
    const v: Vec3 = [y[IV], y[IV + 1], y[IV + 2]];
    const q = qnormalize([y[IQ], y[IQ + 1], y[IQ + 2], y[IQ + 3]]);
    const w: Vec3 = [y[IW], y[IW + 1], y[IW + 2]];
    const nProp = this.prop.length;
    const prop = y.slice(IPROP, IPROP + nProp);
    const veh = this.vehicle;
    const mp = massProperties(veh, this.rt, prop);
    const lf = localFrame(r);
    const atm = atmosphere(lf.alt);

    // Thrust
    let fx = 0, fy = 0, fz = 0, ty = 0, tz = 0;
    let mdot = 0, jet = 0, thrust = 0;
    const propRate = new Array<number>(nProp).fill(0);
    const stageThrust = fillDiag ? new Array<number>(veh.stages.length).fill(0) : null;
    for (let i = 0; i < veh.stages.length; i++) {
      const st = this.rt.stages[i];
      if (!st.attached || !st.engineOn) continue;
      const s = veh.stages[i];
      const e = s.engine;
      const thr = e.thrustCurve ? thrustCurveAt(e.thrustCurve, t - st.ignitionTime) : st.throttle;
      if (thr <= 0) continue;
      const off = this.offs[i];
      if (s.tanks.some((_, k) => prop[off + k] <= 0)) continue;
      const out = engineOutput(e, thr, atm.pressure);
      const n = s.engineCount * boosterCount(s);
      const F = out.thrust * n;
      const maxSin = Math.sin(e.maxGimbal ?? 0);
      let uy = this.gimbal[0];
      let uz = this.gimbal[1];
      const mag = Math.hypot(uy, uz);
      if (mag > maxSin) {
        const k = mag > 0 ? maxSin / mag : 0;
        uy *= k;
        uz *= k;
      }
      const ux = Math.sqrt(1 - uy * uy - uz * uz);
      const arm = mp.stageBase[i] - mp.cg; // engines sit aft of the CG: negative
      fx += F * ux;
      fy += F * uy;
      fz += F * uz;
      ty += -arm * F * uz;
      tz += arm * F * uy;
      mdot += out.massFlow * n;
      jet += out.massFlow * n * arm * arm;
      thrust += F;
      if (stageThrust) stageThrust[i] = F;
      s.tanks.forEach((tk, k) => (propRate[off + k] = -out.massFlow * s.engineCount * tk.flowFraction));
    }

    // Aerodynamics: the air turns with the Earth, plus wind.
    let vRel = sub(v, groundVelocity(r));
    if (this.cfg.wind) {
      const wind = this.cfg.wind(lf.alt, lf.lat, lf.lon - (this.theta0 + OMEGA_EARTH * t));
      vRel = sub(vRel, add(scale(lf.east, wind.east), scale(lf.north, wind.north)));
    }
    const vb = qrotInv(q, vRel);
    const aero = aeroForces(vb, w, atm.density, atm.speedOfSound, atm.meanFreePath, this.geom, mp.cg);

    // Translation
    const g = gravityAccel(r, this.cfg.gravity, this.bodies);
    const fBody: Vec3 = [fx + aero.force[0], fy + aero.force[1], fz + aero.force[2]];
    const aNonGrav = scale(qrot(q, fBody), 1 / mp.mass);
    const a = add(g, aNonGrav);

    // Rotation: Euler's equations for a body that is losing mass.
    const I = mp.inertia;
    let Idot: Vec3 = [0, 0, 0];
    if (mdot > 0) {
      const eps = 0.05;
      const I2 = massProperties(veh, this.rt, prop.map((p, k) => p + propRate[k] * eps)).inertia;
      Idot = [(I2[0] - I[0]) / eps, (I2[1] - I[1]) / eps, (I2[2] - I[2]) / eps];
    }
    const rm = norm(r);
    const rb = scale(qrotInv(q, r), 1 / rm);
    // Gravity-gradient torque: the lower end of the vehicle is pulled slightly harder.
    const gg = scale(cross(rb, [I[0] * rb[0], I[1] * rb[1], I[2] * rb[2]]), (3 * MU_EARTH) / rm ** 3);
    const tx = this.rcs[0] + gg[0];
    // Jet damping: exhaust leaving the nozzle carries away angular momentum.
    const tY = ty + aero.moment[1] + this.rcs[1] + gg[1] - jet * w[1];
    const tZ = tz + aero.moment[2] + this.rcs[2] + gg[2] - jet * w[2];
    const wdot: Vec3 = [
      (tx - (I[2] - I[1]) * w[1] * w[2] - Idot[0] * w[0]) / I[0],
      (tY - (I[0] - I[2]) * w[2] * w[0] - Idot[1] * w[1]) / I[1],
      (tZ - (I[1] - I[0]) * w[0] * w[1] - Idot[2] * w[2]) / I[2],
    ];
    const qd = qderiv(q, w);
    const speedRel = norm(vRel);
    const heat = stagnationHeatFlux(atm.density, speedRel, this.geom.noseRadius);

    if (fillDiag) {
      const nose = qrot(q, [1, 0, 0]);
      const lon = lf.lon - (this.theta0 + OMEGA_EARTH * t);
      this.diag = {
        altitude: lf.alt,
        lat: lf.lat,
        lon: Math.atan2(Math.sin(lon), Math.cos(lon)),
        up: lf.up,
        east: lf.east,
        north: lf.north,
        vRel,
        speedRel,
        speedInertial: norm(v),
        verticalSpeed: dot(vRel, lf.up),
        mach: aero.mach,
        q: aero.dynamicPressure,
        alpha: aero.alpha,
        thrust,
        stageThrust: stageThrust!,
        massFlow: mdot,
        mass: mp.mass,
        accelG: norm(aNonGrav) / G0,
        drag: -aero.force[0],
        pressure: atm.pressure,
        density: atm.density,
        heatFlux: heat,
        fmHeatFlux: freeMolecularHeatFlux(atm.density, speedRel),
        knudsen: aero.knudsen,
        pitch: Math.asin(clamp(dot(nose, lf.up), -1, 1)),
        heading: Math.atan2(dot(nose, lf.east), dot(nose, lf.north)),
        massProps: mp,
        cp: aero.cp,
        aeroMoment: aero.moment,
      };
    }

    const dy = new Array<number>(y.length);
    dy[IR] = v[0]; dy[IR + 1] = v[1]; dy[IR + 2] = v[2];
    dy[IV] = a[0]; dy[IV + 1] = a[1]; dy[IV + 2] = a[2];
    dy[IQ] = qd[0]; dy[IQ + 1] = qd[1]; dy[IQ + 2] = qd[2]; dy[IQ + 3] = qd[3];
    dy[IW] = wdot[0]; dy[IW + 1] = wdot[1]; dy[IW + 2] = wdot[2];
    dy[IHEAT] = heat;
    dy[IDV] = thrust / mp.mass;
    for (let k = 0; k < nProp; k++) dy[IPROP + k] = propRate[k];
    return dy;
  }

  /** Recompute diagnostics (and Sun / Moon positions) for the current state. */
  refresh(): void {
    const gopt = this.cfg.gravity ?? {};
    const jd = this.epochJD + this.t / 86400;
    this.bodies = {
      sun: (gopt.sun ?? true) ? sunPosition(jd) : undefined,
      moon: (gopt.moon ?? true) ? moonPosition(jd) : undefined,
    };
    this.evaluate(this.t, this.pack(), true);
  }

  private bookkeeping(): void {
    const d = this.diag;
    if (!this.held) {
      if (d.q > this.maxQ.value) this.maxQ = { value: d.q, t: this.t, altitude: d.altitude };
      if (d.accelG > this.maxG.value) this.maxG = { value: d.accelG, t: this.t };
      if (d.heatFlux > this.maxHeatFlux.value) this.maxHeatFlux = { value: d.heatFlux, t: this.t };
      if (d.altitude < 0 && this.t - this.liftoffTime > 1) {
        this.ended = true;
        this.event('impact', `Impact at ${d.speedRel.toFixed(0)} m/s`);
      }
    }
    if (this.t >= this.nextLog) {
      this.log.push(this.telemetry());
      this.nextLog = this.t + (this.cfg.logInterval ?? 1);
    }
  }

  telemetry(): Telemetry {
    const d = this.diag;
    const el = this.elements();
    const d2r = Math.PI / 180;
    return {
      t: this.t,
      altitude: d.altitude,
      latDeg: d.lat / d2r,
      lonDeg: d.lon / d2r,
      downrange: greatCircleDistance(this.cfg.site.latDeg * d2r, this.cfg.site.lonDeg * d2r, d.lat, d.lon),
      speed: d.speedInertial,
      speedRel: d.speedRel,
      verticalSpeed: d.verticalSpeed,
      mach: d.mach,
      q: d.q,
      alphaDeg: d.alpha / d2r,
      pitchDeg: d.pitch / d2r,
      accelG: d.accelG,
      thrust: d.thrust,
      mass: d.mass,
      heatFlux: d.heatFlux,
      apoapsis: el.ra - RE,
      periapsis: el.rp - RE,
      inclinationDeg: el.i / d2r,
    };
  }
}

/** Unit vector along the vehicle's nose, ECI. */
export function noseDirection(sim: Simulation): Vec3 {
  return qrot(sim.q, [1, 0, 0]);
}
