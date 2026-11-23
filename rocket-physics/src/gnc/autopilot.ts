// Ascent autopilot: the flight program a real launcher runs.
//
//   1. Ignition and hold-down release once thrust exceeds weight.
//   2. Vertical rise to clear the pad.
//   3. Pitch-over: a small programmed tilt toward the launch azimuth.
//   4. Gravity turn: nose held on the air-relative velocity (zero angle of attack) so
//      gravity bends the path while the airframe carries no bending load.
//   5. Closed-loop guidance once the air is thin, across staging, to the target orbit.
//   6. Cutoff when the orbit's angular momentum is reached.
//   7. Optional coast and further burns (circularise, raise, plane change).
//
// It also runs the sequencer: staging, air-lit stages, fairing jettison on a heating
// criterion, and throttling to respect acceleration and dynamic-pressure limits.

import { G0, MU_EARTH, RE } from '../constants.ts';
import { add, angleBetween, clamp, cross, dot, norm, scale, sub, unit, type Vec3 } from '../math/vec.ts';
import { engineOutput } from '../propulsion/engine.ts';
import { stageMass, usablePropellant } from '../vehicle/massprops.ts';
import { boosterCount } from '../vehicle/types.ts';
import { elementsFromState, timeToApoapsis, timeToPeriapsis } from '../orbit/kepler.ts';
import { burnTime, launchAzimuth } from '../orbit/maneuvers.ts';
import { propagate } from '../orbit/propagate.ts';
import { groundVelocity, localFrame } from '../env/earth.ts';
import type { FlightComputer, Simulation } from '../sim/simulation.ts';
import { solveSteering, type BurnSegment, type SteeringLaw } from './guidance.ts';

export interface AscentTarget {
  /** Altitude of the insertion point (perigee) above the equatorial radius, m. */
  perigeeAltitude: number;
  /** Apogee altitude, m. Defaults to the perigee altitude (circular orbit). */
  apogeeAltitude?: number;
  /** Orbit inclination, degrees. Defaults to the site latitude (launch due east). */
  inclinationDeg?: number;
  /**
   * Fly the south-of-east launch azimuth for that inclination instead of the north-of-east one.
   * Sriharikota launches go this way (the north-east track crosses land).
   */
  southward?: boolean;
  /**
   * By default the target is met in osculating (instantaneous Keplerian) elements at cutoff,
   * which is how injection orbits are normally quoted. The Earth's oblateness then pulls the
   * real far-side apsis lower than that figure (about 18 km for a 200 x 600 km orbit).
   * Set this to make the cutoff speed aim for the far apsis the vehicle will actually reach.
   */
  compensateOblateness?: boolean;
}

export type BurnDirection = 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radialOut' | 'radialIn' | Vec3;

export interface ManeuverNode {
  name?: string;
  /** When the middle of the burn should fall. */
  at: 'apoapsis' | 'periapsis' | { time: number } | { afterInsertion: number };
  /** Delta-v in m/s, or 'circularize' to make the orbit circular at that apsis. */
  deltaV: number | 'circularize';
  direction?: BurnDirection;
}

export interface AscentOptions {
  target: AscentTarget;
  /** Size of the programmed tilt, degrees. The main tuning knob of an ascent. */
  pitchKickDeg?: number;
  /** Vertical speed at which pitch-over starts, m/s. */
  kickSpeed?: number;
  kickRateDegPerS?: number;
  /** Throttle back to keep the acceleration felt on board below this many g. */
  maxG?: number;
  /** Throttle back to keep dynamic pressure below this, Pa. */
  maxQ?: number;
  /** Closed-loop guidance takes over once dynamic pressure has fallen below this, Pa. */
  closedLoopQ?: number;
  /**
   * In wind, the turn follows the velocity over the ground below this dynamic pressure and
   * leans into the air-relative velocity above it (fully at 2.5 times this). Pa, default 10 000.
   * Infinity turns load relief off.
   */
  loadReliefQ?: number;
  closedLoopMinAltitude?: number;
  /** Drop the fairing when free-molecular heating falls below this, W/m^2. */
  fairingHeatFlux?: number;
  /** Burns to perform after orbit insertion. */
  nodes?: ManeuverNode[];
}

export type AscentPhase = 'prelaunch' | 'vertical' | 'pitchover' | 'gravityTurn' | 'closedLoop' | 'coast' | 'burn' | 'done' | 'aborted';

export class AscentAutopilot implements FlightComputer {
  phase: AscentPhase = 'prelaunch';
  readonly opts: AscentOptions;
  /** Guidance time-to-go, s (closed loop only). */
  tgo = NaN;
  /** Target orbit normal, ECI. */
  planeNormal: Vec3 = [0, 0, 1];
  /** Compass azimuth flown off the pad, rad. */
  azimuth = Math.PI / 2;
  insertionTime = NaN;
  /** False if the vehicle ran out of propellant before reaching the target. */
  reachedTarget = false;

  private started = false;
  private tKick = 0;
  private lastSepTime = -Infinity;
  private law: SteeringLaw | null = null;
  private tSolve = -Infinity;
  private frozen = false;
  private lastSegCount = -1;
  private lastDir: Vec3 | null = null;
  private nodeIndex = 0;
  private burnStart = NaN;
  private dv0 = 0;
  private dvGoal = 0;
  private warnedInfeasible = false;
  private burnDir: BurnDirection = 'prograde';
  private cutoffSpeed: number | null = null;

  constructor(opts: AscentOptions) {
    this.opts = opts;
  }

  /** Target radius and angular momentum at insertion. */
  targetState(): { r: number; rdot: number; h: number; speed: number } {
    const hp = this.opts.target.perigeeAltitude;
    const ha = this.opts.target.apogeeAltitude ?? hp;
    const r = RE + hp;
    const a = RE + (hp + ha) / 2;
    const speed = this.cutoffSpeed ?? Math.sqrt(MU_EARTH * (2 / r - 1 / a));
    return { r, rdot: 0, h: r * speed, speed };
  }

  update(sim: Simulation): number | void {
    const veh = sim.vehicle;
    const d = sim.diag;
    if (this.phase === 'aborted') return;

    if (!this.started) {
      this.started = true;
      const first = sim.lowestCore();
      veh.stages.forEach((s, i) => {
        const mode = s.ignition ?? (s.parallel || i === first ? 'liftoff' : 'stack');
        if (mode === 'liftoff') sim.ignite(i);
      });
    }

    if (sim.held) {
      sim.cmd.attitude = null;
      sim.cmd.throttle = 1;
      const ready = sim.rt.stages.every((st, i) => !st.engineOn || !!veh.stages[i].engine.thrustCurve || st.throttle > 0.97);
      if (ready && d.thrust > 1.02 * d.mass * G0) {
        this.setupTargetPlane(sim);
        sim.release();
        this.phase = 'vertical';
      } else if (sim.t > 15) {
        sim.event('abort', 'Thrust never exceeded weight: launch aborted on the pad');
        sim.rt.stages.forEach((_, i) => sim.shutdown(i, 'abort'));
        this.phase = 'aborted';
        sim.ended = true;
      }
      return;
    }

    const timer = this.sequence(sim);
    this.throttle(sim);
    const hint = this.guide(sim);
    // Never step past a pending staging event or the guidance law's own deadline.
    const limit = Math.min(timer, typeof hint === 'number' && hint > 0 ? hint : Infinity);
    return isFinite(limit) ? Math.max(limit, 1e-4) : undefined;
  }

  private guide(sim: Simulation): number | void {
    const veh = sim.vehicle;
    const d = sim.diag;
    // Velocity over the ground, not through the air. The open-loop turn follows this one:
    // `d.vRel` includes the wind, and early in the turn a few metres per second of wind is a
    // large share of the horizontal speed, so following it would swing the whole trajectory
    // off its azimuth (or, with a tailwind, tip the vehicle over backwards).
    const vGround = sub(sim.v, groundVelocity(sim.r));
    let turnDir = vGround;
    if (sim.cfg.wind) {
      // Load relief: where the air is thick, lean the nose toward the air-relative velocity so
      // a jet stream does not bend the vehicle. Only there, because nose-into-wind steering
      // pushes the vehicle further upwind the longer it is held; by then the speed is high,
      // so the lean is a few degrees and closed-loop guidance removes the drift afterwards.
      const lo = this.opts.loadReliefQ ?? 10e3;
      const x = isFinite(lo) ? clamp((d.q - lo) / (1.5 * lo), 0, 1) : 0;
      const relief = x * x * (3 - 2 * x);
      turnDir = add(scale(vGround, 1 - relief), scale(d.vRel, relief));
    }
    switch (this.phase) {
      case 'vertical':
        sim.cmd.attitude = d.up;
        if (d.verticalSpeed >= (this.opts.kickSpeed ?? 50)) {
          this.phase = 'pitchover';
          this.tKick = sim.t;
          sim.event('guidance', 'Pitch-over');
        }
        return;
      case 'pitchover': {
        const kick = ((this.opts.pitchKickDeg ?? 3) * Math.PI) / 180;
        const rate = ((this.opts.kickRateDegPerS ?? 1) * Math.PI) / 180;
        const ang = Math.min(kick, rate * (sim.t - this.tKick));
        const az = add(scale(d.east, Math.sin(this.azimuth)), scale(d.north, Math.cos(this.azimuth)));
        sim.cmd.attitude = unit(add(scale(d.up, Math.cos(ang)), scale(az, Math.sin(ang))));
        if (ang >= kick && angleBetween(vGround, d.up) >= kick) {
          this.phase = 'gravityTurn';
          sim.event('guidance', 'Gravity turn');
        }
        return;
      }
      case 'gravityTurn': {
        if (norm(vGround) > 1) sim.cmd.attitude = unit(turnDir);
        const boosters = veh.stages.some((s, i) => s.parallel && sim.rt.stages[i].attached);
        if (!boosters && d.q < (this.opts.closedLoopQ ?? 1000) && d.altitude > (this.opts.closedLoopMinAltitude ?? 40e3)) {
          this.phase = 'closedLoop';
          sim.event('guidance', 'Closed-loop guidance');
        }
        return;
      }
      case 'closedLoop':
        return this.closedLoop(sim);
      case 'coast':
        return this.coast(sim);
      case 'burn':
        return this.burn(sim);
      case 'done':
        sim.cmd.attitude = unit(sim.v);
        return;
    }
  }

  private setupTargetPlane(sim: Simulation): void {
    const lf = localFrame(sim.r);
    const lat = lf.lat;
    const inc = Math.max(((this.opts.target.inclinationDeg ?? 0) * Math.PI) / 180, Math.abs(lat) + 1e-9);
    const az = launchAzimuth(lat, inc, this.targetState().speed, this.opts.target.southward);
    this.azimuth = az.rotating;
    const heading = add(scale(lf.east, Math.sin(az.inertial)), scale(lf.north, Math.cos(az.inertial)));
    this.planeNormal = unit(cross(unit(sim.r), heading));
    if (this.opts.target.compensateOblateness) this.cutoffSpeed = this.speedForFarApsis(sim);
  }

  /**
   * Cutoff speed at the insertion point for which the opposite apsis, flown under the real
   * gravity field, comes out at the requested altitude. Found by shooting: propagate half
   * an orbit, compare, adjust (secant method).
   */
  private speedForFarApsis(sim: Simulation): number {
    const hp = this.opts.target.perigeeAltitude;
    const ha = this.opts.target.apogeeAltitude ?? hp;
    const rT = RE + hp;
    const n = this.planeNormal;
    const r0hat = unit(sim.r);
    const along = unit(cross(n, r0hat));
    // A representative insertion point: in the target plane, 20 degrees down-range.
    const phat = unit(add(scale(r0hat, Math.cos(0.35)), scale(along, Math.sin(0.35))));
    const pos = scale(phat, rT);
    const vdir = unit(cross(n, phat));
    const fm = { epochJD: sim.epochJD, gravity: { ...sim.cfg.gravity, sun: false, moon: false } };
    const miss = (v: number): number => {
      const a = 1 / (2 / rT - (v * v) / MU_EARTH);
      const half = Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
      return norm(propagate(pos, scale(vdir, v), 0, half, fm).r) - (RE + ha);
    };
    let v0 = Math.sqrt(MU_EARTH * (2 / rT - 1 / (RE + (hp + ha) / 2)));
    let f0 = miss(v0);
    let v1 = v0 * 1.0005;
    for (let i = 0; i < 8 && Math.abs(f0) > 1; i++) {
      const f1 = miss(v1);
      if (f1 === f0) break;
      const v2 = v1 - (f1 * (v1 - v0)) / (f1 - f0);
      v0 = v1;
      f0 = f1;
      v1 = v2;
    }
    return Math.abs(miss(v1)) < Math.abs(f0) ? v1 : v0;
  }

  // ---- sequencer -----------------------------------------------------------

  /** Run the staging sequencer. Returns the time until its next scheduled action, s. */
  private sequence(sim: Simulation): number {
    const veh = sim.vehicle;
    const d = sim.diag;
    const tl = sim.missionTime;
    let next = Infinity;
    const due = (wait: number): boolean => {
      if (wait <= 1e-9) return true;
      next = Math.min(next, wait);
      return false;
    };
    for (let i = 0; i < veh.stages.length; i++) {
      const s = veh.stages[i];
      const st = sim.rt.stages[i];
      if (!st.attached) continue;
      if (typeof s.ignition === 'object' && st.ignitionsUsed === 0 && due(s.ignition.afterLiftoff - tl)) sim.ignite(i);
      const droppable = s.parallel || (i === sim.lowestCore() && veh.stages.some((x, k) => k > i && !x.parallel && sim.rt.stages[k].attached));
      if (st.burnedOut && droppable && due(st.burnoutTime + (s.separationDelay ?? 2) - sim.t)) {
        sim.jettison(i);
        if (!s.parallel) this.lastSepTime = sim.t;
      }
    }
    const low = sim.lowestCore();
    if (low >= 0) {
      const s = veh.stages[low];
      const st = sim.rt.stages[low];
      const mode = s.ignition ?? 'stack';
      const ascending = this.phase !== 'coast' && this.phase !== 'burn' && this.phase !== 'done';
      if (mode === 'stack' && ascending && st.ignitionsUsed === 0 && isFinite(this.lastSepTime) && due(this.lastSepTime + (s.ignitionDelay ?? 3) - sim.t)) {
        sim.ignite(low);
      }
    }
    if (sim.rt.fairingAttached && d.altitude > 80e3 && d.fmHeatFlux < (this.opts.fairingHeatFlux ?? 1135)) sim.jettisonFairing();
    return next;
  }

  private throttle(sim: Simulation): void {
    const d = sim.diag;
    let thr = 1;
    const maxG = this.opts.maxG ?? Infinity;
    if (isFinite(maxG)) {
      let solid = 0;
      let liquid = 0;
      let lag = 0;
      sim.rt.stages.forEach((st, i) => {
        if (!st.attached || !st.engineOn) return;
        const s = sim.vehicle.stages[i];
        if (s.engine.thrustCurve) solid += d.stageThrust[i];
        else {
          liquid += engineOutput(s.engine, 1, d.pressure).thrust * s.engineCount * boosterCount(s);
          lag = Math.max(lag, (s.engine.spoolTime ?? 1) / 3);
        }
      });
      // Mass keeps falling while the engines respond, so aim at the mass a moment ahead.
      if (liquid > 0) thr = Math.min(thr, (maxG * G0 * (d.mass - d.massFlow * (lag + 2 * sim.dt)) - solid) / liquid);
    }
    const maxQ = this.opts.maxQ;
    if (maxQ && d.q > 0.9 * maxQ) thr = Math.min(thr, 1 - 3 * (d.q / maxQ - 0.9));
    sim.cmd.throttle = clamp(thr, 0, 1);
  }

  // ---- closed-loop ascent --------------------------------------------------

  /** The thrust still to come: the burning stage, then every stage above it. */
  private segments(sim: Simulation): BurnSegment[] {
    const veh = sim.vehicle;
    const segs: BurnSegment[] = [];
    let m = sim.diag.mass;
    let t0 = 0;
    const cores = veh.stages.map((s, i) => i).filter((i) => !veh.stages[i].parallel && sim.rt.stages[i].attached);
    cores.forEach((i, idx) => {
      const s = veh.stages[i];
      const st = sim.rt.stages[i];
      const next = idx + 1 < cores.length ? veh.stages[cores[idx + 1]] : undefined;
      const wet = stageMass(veh, i, sim.prop);
      if (st.burnedOut) {
        // Spent and about to be dropped.
        t0 += Math.max(0, (s.separationDelay ?? 2) - (sim.t - st.burnoutTime)) + (next?.ignitionDelay ?? 3);
        m -= wet;
        return;
      }
      if (!st.engineOn) {
        if (st.ignitionsUsed > 0) return; // already cut off by guidance
        if (idx === 0) t0 += Math.max(0, (s.ignitionDelay ?? 3) - (sim.t - this.lastSepTime));
      }
      const mdot = (s.engine.thrustVac * s.engineCount) / (G0 * s.engine.ispVac);
      const usable = usablePropellant(veh, i, sim.prop);
      const duration = usable / mdot;
      if (duration > 0.05) segs.push({ start: t0, duration, ve: G0 * s.engine.ispVac, tau: m / mdot });
      t0 += duration + (s.separationDelay ?? 2) + (next?.ignitionDelay ?? 3);
      m -= wet;
      if (idx === 0 && next && sim.rt.fairingAttached && veh.fairing) m -= veh.fairing.mass;
    });
    return segs;
  }

  private closedLoop(sim: Simulation): number | void {
    const d = sim.diag;
    const n = this.planeNormal;
    const rmag = norm(sim.r);
    const rhat = scale(sim.r, 1 / rmag);
    const theta = unit(cross(n, rhat));
    const rdot = dot(sim.v, rhat);
    const h = dot(cross(sim.r, sim.v), n);
    const target = this.targetState();
    const burning = sim.rt.stages.some((st) => st.attached && st.engineOn);
    const segs = this.segments(sim);

    if (segs.length === 0) {
      if (!burning) {
        sim.event('guidance', `Propellant exhausted ${(target.h - h) / rmag > 0 ? ((target.h - h) / rmag).toFixed(0) : 0} m/s short of the target orbit`);
        this.finishAscent(sim, false);
      }
      return;
    }

    // Re-solve twice a second, and at once when the thrust schedule changes (staging).
    if (!this.frozen && (sim.t - this.tSolve >= 0.5 || segs.length !== this.lastSegCount)) {
      const dtS = sim.t - this.tSolve;
      const guess = this.law ? { k1: this.law.k1 + this.law.k2 * dtS, k2: this.law.k2, T: this.law.T - dtS } : undefined;
      let sol = solveSteering({ r: rmag, rdot, h }, target, MU_EARTH, segs, guess, d.pitch);
      if (!sol.converged && guess) sol = solveSteering({ r: rmag, rdot, h }, target, MU_EARTH, segs, undefined, d.pitch);
      this.lastSegCount = segs.length;
      if (sol.converged || !this.law) {
        this.law = sol.law;
        this.tSolve = sim.t;
        this.tgo = sol.law.T;
        if (!sol.feasible && !this.warnedInfeasible) {
          this.warnedInfeasible = true;
          sim.event('guidance', 'Guidance predicts the target orbit is out of reach; burning to depletion');
        }
        // Close to cutoff the solution becomes ill-conditioned: hold the last steering law.
        if (sol.law.T < 8 && segs.length === 1 && burning) this.frozen = true;
      }
    }
    if (!this.law) return;
    const elapsed = sim.t - this.tSolve;
    this.tgo = this.law.T - elapsed;
    const k = this.law.k1 + this.law.k2 * elapsed;
    const cosP = 1 / Math.sqrt(1 + k * k);
    const inPlane = add(scale(rhat, k * cosP), scale(theta, cosP));
    const a = d.thrust / d.mass;
    // Yaw steering: null the out-of-plane position and velocity by cutoff.
    const T = Math.max(this.tgo, 20);
    const aSide = -(4 * dot(sim.v, n) * T + 6 * dot(sim.r, n)) / (T * T);
    const fh = a > 0.05 ? clamp(aSide / a, -0.3, 0.3) : 0;
    this.lastDir = unit(add(scale(inPlane, Math.sqrt(1 - fh * fh)), scale(n, fh)));
    sim.cmd.attitude = this.lastDir;

    if (a > 0.05) {
      // Cutoff on angular momentum, landing the last step exactly on it.
      const hdot = a * cosP * Math.sqrt(1 - fh * fh) * rmag;
      if (h >= target.h) {
        sim.shutdown(sim.lowestCore(), 'cutoff');
        this.finishAscent(sim, true);
        return;
      }
      const dtc = (target.h - h) / Math.max(hdot, 1e-6);
      if (dtc < sim.dt * 1.5) return Math.max(dtc, 1e-4);
    }
  }

  private finishAscent(sim: Simulation, ok: boolean): void {
    this.reachedTarget = ok;
    this.insertionTime = sim.t;
    this.tgo = 0;
    const el = sim.elements();
    sim.event(
      'orbit',
      `${ok ? 'Orbit insertion' : 'Final state'}: ${((el.rp - RE) / 1000).toFixed(1)} x ${((el.ra - RE) / 1000).toFixed(1)} km, inclination ${((el.i * 180) / Math.PI).toFixed(2)} deg`,
    );
    this.phase = 'coast';
  }

  // ---- orbital burns -------------------------------------------------------

  private direction(sim: Simulation, dir: BurnDirection): Vec3 {
    if (typeof dir !== 'string') return unit(dir);
    const vhat = unit(sim.v);
    const hvec = unit(cross(sim.r, sim.v));
    const out = unit(cross(sim.v, cross(sim.r, sim.v)));
    switch (dir) {
      case 'prograde': return vhat;
      case 'retrograde': return scale(vhat, -1);
      case 'normal': return hvec;
      case 'antinormal': return scale(hvec, -1);
      case 'radialOut': return out;
      case 'radialIn': return scale(out, -1);
    }
  }

  private coast(sim: Simulation): number | void {
    const node = this.opts.nodes?.[this.nodeIndex];
    if (!node) {
      this.phase = 'done';
      sim.cmd.attitude = unit(sim.v);
      return;
    }
    const stage = sim.lowestCore();
    const s = sim.vehicle.stages[stage];
    const el = elementsFromState(sim.r, sim.v, MU_EARTH);
    let dv: number;
    let dir: BurnDirection = node.direction ?? 'prograde';
    if (node.deltaV === 'circularize') {
      const rA = node.at === 'periapsis' ? el.rp : el.ra;
      dv = Math.sqrt(MU_EARTH / rA) - Math.sqrt(MU_EARTH * (2 / rA - 1 / el.a));
      if (dv < 0) {
        dv = -dv;
        dir = 'retrograde';
      }
    } else {
      dv = node.deltaV;
    }
    sim.cmd.attitude = this.direction(sim, dir);
    const duration = burnTime(dv, sim.diag.mass, s.engine.thrustVac * s.engineCount, s.engine.ispVac);

    // Re-estimate the start while far away (the orbit drifts under J2), then commit.
    if (!isFinite(this.burnStart) || this.burnStart - sim.t > 60) {
      let tNode: number;
      if (node.at === 'apoapsis') tNode = timeToApoapsis(el, MU_EARTH);
      else if (node.at === 'periapsis') tNode = timeToPeriapsis(el, MU_EARTH);
      else if ('time' in node.at) tNode = node.at.time - sim.t;
      else tNode = this.insertionTime + node.at.afterInsertion - sim.t;
      let start = tNode - duration / 2;
      if (start < 0 && typeof node.at === 'string') start += el.period;
      this.burnStart = sim.t + Math.max(start, 0);
    }
    const wait = this.burnStart - sim.t;
    if (wait > 1e-6) return wait;

    this.burnStart = NaN;
    if (!sim.ignite(stage)) {
      sim.event('warning', `${node.name ?? 'Burn'} skipped: ${s.name} cannot ignite`);
      this.nodeIndex++;
      return;
    }
    this.dv0 = sim.dvExpended;
    this.dvGoal = dv;
    this.burnDir = dir;
    this.phase = 'burn';
    sim.event('burn', `${node.name ?? 'Burn'} start: ${dv.toFixed(1)} m/s ${typeof dir === 'string' ? dir : 'fixed direction'}`);
  }

  private burn(sim: Simulation): number | void {
    const node = this.opts.nodes![this.nodeIndex];
    const stage = sim.lowestCore();
    const dir = this.burnDir;
    sim.cmd.attitude = this.direction(sim, dir);
    const remaining = this.dvGoal - (sim.dvExpended - this.dv0);
    const st = sim.rt.stages[stage];
    const finish = (msg: string): void => {
      const el = sim.elements();
      sim.event(
        'burn',
        `${node.name ?? 'Burn'} ${msg}: ${((el.rp - RE) / 1000).toFixed(1)} x ${((el.ra - RE) / 1000).toFixed(1)} km, inclination ${((el.i * 180) / Math.PI).toFixed(2)} deg`,
      );
      this.nodeIndex++;
      this.phase = 'coast';
    };
    if (remaining <= 0) {
      sim.shutdown(stage, 'cutoff');
      finish('complete');
      return;
    }
    if (!st.engineOn) {
      finish(`ended ${remaining.toFixed(1)} m/s short (propellant depleted)`);
      return;
    }
    const a = sim.diag.thrust / sim.diag.mass;
    if (a > 0 && remaining / a < sim.dt * 1.5) return Math.max(remaining / a, 1e-4);
  }
}
