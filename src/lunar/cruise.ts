// Chandrayaan-3 from the pad to lunar orbit: the LVM3 launch, Earth-bound orbit raising,
// trans-lunar injection, lunar orbit insertion, orbit lowering, lander separation and the two
// deboost burns, ending a few minutes before powered descent. src/lunar/lander.ts flies the
// descent from that state, so launch to touchdown is one trajectory with no gap.
//
// What is simulated
//   - The launch is the LVM3 ascent flown by rocket-physics (same mission definition as
//     Mission mode), sampled into the record from the pad; the spacecraft's own flight starts
//     from the exact state the launcher ends in.
//   - Gravity is rocket-physics' force model: oblate Earth (J2 to J4), Moon and Sun as point
//     masses, integrated in the Earth-centred equatorial frame with adaptive Dormand-Prince.
//   - Every burn is a finite burn: constant thrust along or against the velocity relative to the
//     body being orbited, mass flow F / (Isp g0), centred on the apsis. Burn lengths are solved
//     so the orbit after the burn has the published apogee or apolune.
//   - The trans-lunar burn and the last phasing orbit are solved together (Newton, two unknowns)
//     so the spacecraft passes over the Moon's pole at the right height. Nothing is patched in:
//     the Moon's pull bends the path into the capture geometry.
//
// What is not
//   - No lunar mass concentrations, no solar radiation pressure, no attitude dynamics in cruise.
//   - Burn directions are exactly prograde or retrograde. The real flight also made small
//     trajectory corrections; this one needs none because the model has no navigation error.
//   - Dates follow from the physics, so they land near, not on, the real ones.

import { AscentAutopilot, Dopri5, RE, Simulation, accelAt, julianDate, moonPosition, moonVelocity } from '../mission/engine';
import { getMission } from '../mission/vehicles';
import { G0, MU_M as MU_L, R_MOON, add, cross, dot, norm, scale, sub, unit, type LanderSpec, type V3 } from './core';
import { createMoonEphemeris } from './moonEphemeris';
import { llToMF } from './terrain';

const MU_E = 3.986004418e14; // as used by the force model
const DEG = Math.PI / 180;
const DAY = 86400;

/** Chandrayaan-3 hardware. Masses and thrusts are ISRO's published figures unless marked. */
export const CH3 = {
  stackMass: 3900, // kg at separation from the launcher
  pmDry: 448, // propulsion module without propellant
  pmProp: 1696,
  pmEngine: { force: 440, isp: 310 }, // 440 N liquid engine; Isp is typical for the type, not published
  landerMass: 1752, // Vikram with the 26 kg Pragyan rover
  landerProp: 950, // assumed: ISRO has not published the lander's propellant load
  landerEngine: { tMax: 3200, minThrottle: 0.2, isp: 300, rcsTorque: 460 }, // 4 x 800 N; two engines at 40 % is the floor
  deboostEngine: { force: 1600, isp: 300 }, // two of the four descent engines
  site: { latDeg: -69.37, lonDeg: 32.35, name: 'Shiv Shakti point' },
} as const;

/** Vikram as a LanderSim spec. `used` is propellant already spent on the deboost burns. */
export function vikramSpec(used = 0): LanderSpec {
  return {
    payloadMass: CH3.landerMass - used,
    landerProp: CH3.landerProp - used,
    hasRover: true,
    engine: { ...CH3.landerEngine },
    geom: { cgh: 1.25, foot: 2.1, inertiaPerKg: 0.9 },
    // Share of full thrust the braking burn is planned on. The burn starts where this much would
    // just stop the lander at the site; holding height takes thrust too, so at 0.86 the burn ran
    // flat out all the way and any lost second put the site out of reach. 0.78 flies it at 95 %
    // or less, at the cost of about 28 kg more propellant.
    brakeFrac: 0.78,
    doiPeri: 25e3,
  };
}

export type CruiseBody = 'earth' | 'moon';

export interface CruiseEvent {
  /** Seconds since the launch epoch. */
  t: number;
  id: string;
  label: string;
  detail: string;
  /** Delta-v of the burn, m/s, and its length, s. */
  dv?: number;
  burn?: number;
  /** Spacecraft mass after the event, kg. */
  mass: number;
  /** Orbit after the event: altitudes above the body's surface, m. */
  orbit?: { body: CruiseBody; peri: number; apo: number };
  /** What the real flight reported for the same step. */
  real?: string;
}

export interface CruiseRecord {
  /** Julian date of t = 0 (the launch epoch). */
  epochJD: number;
  /**
   * Samples from the pad onward: the launch about once a second, then the integrator's own
   * steps. r and v are Earth-centred equatorial, m and m/s. Mass is the whole launch vehicle
   * until `injectT`, the spacecraft after it.
   */
  n: number;
  t: Float64Array;
  r: Float64Array;
  v: Float64Array;
  mass: Float64Array;
  /** 1 while an engine is firing. */
  burning: Uint8Array;
  events: CruiseEvent[];
  /** When the launcher lets the spacecraft go: the launch ends and the cruise begins. */
  injectT: number;
  /** First sample after lunar orbit insertion begins. */
  loiIndex: number;
  /** State handed to the lander: Moon-centred, ecliptic axes (the lander's frame). */
  handoff: { t: number; r: V3; v: V3; spec: LanderSpec; perilune: number; crossTrack: number };
  site: { latDeg: number; lonDeg: number; name: string };
  pmPropLeft: number;
  ascent: { perigee: number; apogee: number; inclinationDeg: number };
}

interface S { t: number; y: number[] }
interface Thrust { force: number; isp: number; body: CruiseBody; sense: 1 | -1; /** Push along the orbit normal r x v instead of along the velocity. */ normal?: boolean }
type Ev = (t: number, y: number[]) => number;

class Track {
  t: number[] = []; r: number[] = []; v: number[] = []; m: number[] = []; b: number[] = [];
  push(t: number, y: number[], burning: boolean): void {
    this.t.push(t); this.r.push(y[0], y[1], y[2]); this.v.push(y[3], y[4], y[5]); this.m.push(y[6]); this.b.push(burning ? 1 : 0);
  }
}

/** Seconds between samples of the launch. */
const LAUNCH_SAMPLE = 1;

export interface CruiseOptions { /** Which lunar pole the approach passes over; by default whichever needs the smaller correction. */ poleSide?: 1 | -1; onProgress?: (text: string) => void }

export function flyCruise(opts: CruiseOptions = {}): CruiseRecord {
  const def = getMission('lvm3-m4')!;
  // The flight flyAscent makes, step for step; the stop test also reads off the samples.
  const autopilot = new AscentAutopilot(def.ascent);
  const sim = new Simulation(def.vehicle(), def.config, autopilot);
  const launch = new Track();
  let liftoffMass = 0, nextSample = 0;
  const sampleLaunch = (): void => {
    const d = sim.telemetry();
    if (sim.held) liftoffMass = d.mass;
    launch.push(sim.t, [sim.r[0], sim.r[1], sim.r[2], sim.v[0], sim.v[1], sim.v[2], d.mass], d.thrust > 0);
    nextSample = sim.t + LAUNCH_SAMPLE;
  };
  sampleLaunch();
  sim.run(def.tMax, () => {
    if (sim.t >= nextSample) sampleLaunch();
    return autopilot.phase === 'done' || autopilot.phase === 'aborted';
  });
  if (!autopilot.reachedTarget) throw new Error('The launcher did not reach the transfer orbit');
  const ascEl = sim.elements();
  const asc = { perigeeAltitude: ascEl.rp - RE, apogeeAltitude: ascEl.ra - RE, inclinationDeg: (ascEl.i * 180) / Math.PI };
  const epochJD = sim.epochJD;
  const fm = { epochJD };
  const say = opts.onProgress ?? (() => {});

  const moonPos = (t: number): V3 => moonPosition(epochJD + t / DAY);
  // Asked for at each integrator stage and event test, often twice for one time (the last two
  // stages of a step share it). Callers only read the result.
  let mvT = NaN, mvV: V3 = [0, 0, 0];
  const moonVel = (t: number): V3 => (t === mvT ? mvV : ((mvT = t), (mvV = moonVelocity(epochJD + t / DAY))));
  const at = (iso: string): number => (julianDate(new Date(iso)) - epochJD) * DAY;
  const mu = (b: CruiseBody): number => (b === 'moon' ? MU_L : MU_E);
  const rad = (b: CruiseBody): number => (b === 'moon' ? R_MOON : RE);

  const rel = (t: number, y: number[], b: CruiseBody): { r: V3; v: V3 } => {
    const r = [y[0], y[1], y[2]], v = [y[3], y[4], y[5]];
    return b === 'moon' ? { r: sub(r, moonPos(t)), v: sub(v, moonVel(t)) } : { r, v };
  };
  const energy = (s: S, b: CruiseBody): number => {
    const q = rel(s.t, s.y, b), vv = norm(q.v);
    return (vv * vv) / 2 - mu(b) / norm(q.r);
  };
  /** Osculating apsis altitudes about a body. */
  const apsides = (s: S, b: CruiseBody): { peri: number; apo: number } => {
    const q = rel(s.t, s.y, b), rr = norm(q.r), vv = norm(q.v), m = mu(b);
    const eps = (vv * vv) / 2 - m / rr, h = norm(cross(q.r, q.v));
    const e = Math.sqrt(Math.max(0, 1 + (2 * eps * h * h) / (m * m)));
    const a = -m / (2 * eps);
    return { peri: a * (1 - e) - rad(b), apo: eps < 0 ? a * (1 + e) - rad(b) : Infinity };
  };

  const deriv = (th: Thrust | null) => (t: number, y: number[]): number[] => {
    const r: [number, number, number] = [y[0], y[1], y[2]], v: [number, number, number] = [y[3], y[4], y[5]];
    const a = accelAt(t, r, v, fm);
    if (!th) return [v[0], v[1], v[2], a[0], a[1], a[2], 0];
    const vr = th.normal ? cross(r, v) : th.body === 'moon' ? sub(v, moonVel(t)) : v;
    const k = (th.sense * th.force) / (y[6] * norm(vr));
    return [v[0], v[1], v[2], a[0] + vr[0] * k, a[1] + vr[1] * k, a[2] + vr[2] * k, -th.force / (th.isp * G0)];
  };

  // Coasts are flown again and again from the same start state (to find a burn point, to
  // reach the burn's start, inside the burn-length solvers). A fresh Dopri5 run from a given
  // state takes the same steps whatever its end time, up to the step that would reach that
  // end, so each start state keeps the steps taken from it and later runs replay them. The
  // result is bit-for-bit what integrating again would give.
  interface Coast { t: number[]; y: number[][]; /** Solver step size when leaving point i. */ h: number[]; solver: Dopri5 }
  const coastF = deriv(null);
  const coasts = new WeakMap<S, Coast>();
  const coastOf = (s: S): Coast => {
    let c = coasts.get(s);
    if (!c) {
      const solver = new Dopri5(coastF, { rtol: 1e-10, atol: 1e-6, hInit: 10 });
      c = { t: [s.t], y: [s.y], h: [solver.h], solver };
      coasts.set(s, c);
    }
    return c;
  };
  /** Make sure point i + 1 of the coast exists. */
  const coastStep = (c: Coast, i: number): void => {
    while (c.t.length <= i + 1) {
      const k = c.t.length - 1, nx = c.solver.step(c.t[k], c.y[k], Infinity);
      c.t.push(nx.t); c.y.push(nx.y); c.h.push(c.solver.h);
    }
  };

  /** Integrate to tEnd, or to the first upward zero crossing of `stop` after `minT`. */
  function run(s: S, tEnd: number, th: Thrust | null, o: { stop?: Ev; minT?: number; rec?: Track; hMax?: number } = {}): { s: S; hit: boolean } {
    const f = th || o.hMax !== undefined ? deriv(th) : coastF;
    const opts = { rtol: 1e-10, atol: 1e-6, hInit: 10, hMax: o.hMax };
    const coast = f === coastF ? coastOf(s) : null;
    let solver = coast ? null : new Dopri5(f, opts);
    let t = s.t, y = s.y, steps = 0, i = 0;
    let g0 = o.stop ? o.stop(t, y) : 0;
    while (t < tEnd) {
      let nx: { t: number; y: number[] };
      if (solver) nx = solver.step(t, y, tEnd);
      else if (coast!.h[i] < tEnd - t) {
        // A step that does not reach tEnd: the same as the one already taken from here.
        coastStep(coast!, i);
        i++;
        nx = { t: coast!.t[i], y: coast!.y[i] };
      } else {
        solver = new Dopri5(f, opts);
        solver.h = coast!.h[i];
        nx = solver.step(t, y, tEnd);
      }
      if (o.stop) {
        const g1 = o.stop(nx.t, nx.y);
        if (g0 < 0 && g1 >= 0 && nx.t >= (o.minT ?? -Infinity)) {
          let lo = t, hi = nx.t, yh = nx.y;
          // Every try starts from the same point, so its first stage is worked out once.
          const t0 = t, y0 = y;
          let k0: number[] | null = null;
          const f0 = (tt: number, yy: number[]): number[] => (tt === t0 && yy === y0 ? (k0 ??= f(tt, yy)) : f(tt, yy));
          for (let i = 0; i < 60 && hi - lo > 1e-4; i++) {
            const mid = 0.5 * (lo + hi);
            const one = new Dopri5(f0, { rtol: 1e-10, atol: 1e-6, hInit: mid - t });
            let tm = t, ym = y;
            while (tm < mid) { const q = one.step(tm, ym, mid); tm = q.t; ym = q.y; }
            if (o.stop(mid, ym) >= 0) { hi = mid; yh = ym; } else lo = mid;
          }
          o.rec?.push(hi, yh, !!th);
          return { s: { t: hi, y: yh }, hit: true };
        }
        g0 = g1;
      }
      t = nx.t; y = nx.y;
      o.rec?.push(t, y, !!th);
      if (++steps > 3e6) throw new Error('cruise: too many integration steps');
    }
    return { s: { t, y }, hit: false };
  }

  const periEv = (b: CruiseBody): Ev => (t, y) => { const q = rel(t, y, b); return dot(q.r, q.v); };
  const apoEv = (b: CruiseBody): Ev => (t, y) => { const q = rel(t, y, b); return -dot(q.r, q.v); };
  /** Crossing of the Moon-centred direction d, going the way the orbit goes (h is the orbit normal). */
  const dirEv = (d: V3, h: V3): Ev => {
    const side = cross(h, d);
    return (t, y) => { const q = rel(t, y, 'moon'); return dot(q.r, d) > 0 ? dot(q.r, side) : -1; };
  };

  const rec = new Track();
  const events: CruiseEvent[] = [];
  const note = (s: S, id: string, label: string, detail: string, extra: Partial<CruiseEvent> = {}): void => {
    events.push({ t: s.t, id, label, detail, mass: s.y[6], ...extra });
  };

  interface BurnOut { s: S; dv: number; dur: number; t0: number }
  /**
   * Coast to the event, then burn centred on it until the orbit has the target energy.
   * `record` false flies it without writing the track (used inside the solvers).
   */
  function burnAt(s: S, o: { ev: Ev; minT?: number; body: CruiseBody; engine: { force: number; isp: number }; eps: (atEvent: S) => number; fixed?: number; record?: boolean }): BurnOut {
    const hit = run(s, s.t + 40 * DAY, null, { stop: o.ev, minT: o.minT });
    if (!hit.hit) throw new Error('cruise: burn point never reached');
    const tA = hit.s.t, epsT = o.eps(hit.s), q = rel(tA, hit.s.y, o.body);
    const vNow = norm(q.v), vT = Math.sqrt(Math.max(0, 2 * (epsT + mu(o.body) / norm(q.r))));
    const sense: 1 | -1 = vT >= vNow ? 1 : -1;
    const th: Thrust = { ...o.engine, body: o.body, sense };
    const ve = o.engine.isp * G0, mdot = o.engine.force / ve, m0 = hit.s.y[6];
    const d0 = o.fixed ?? (m0 * (1 - Math.exp(-Math.abs(vT - vNow) / ve))) / mdot;
    const pre = run(s, Math.max(s.t, tA - 0.85 * d0 - 30), null).s;
    const fly = (d: number): S => {
      const st = Math.max(pre.t, tA - d / 2);
      return run(run(pre, st, null).s, st + d, th, { hMax: 20 }).s;
    };
    let d = d0;
    if (o.fixed === undefined) {
      // Secant on the energy error. Energy rises (or falls) steadily with burn length.
      let x0 = d0, f0 = energy(fly(x0), o.body) - epsT;
      let x1 = d0 * 1.03 + 0.5, f1 = energy(fly(x1), o.body) - epsT;
      for (let i = 0; i < 30 && Math.abs(x1 - x0) > 1e-5 && f1 !== f0; i++) {
        const x2 = Math.min(1.6 * d0 + 1, Math.max(0.3 * d0, x1 - (f1 * (x1 - x0)) / (f1 - f0)));
        x0 = x1; f0 = f1; x1 = x2; f1 = energy(fly(x1), o.body) - epsT;
      }
      d = x1;
    }
    const st = Math.max(pre.t, tA - d / 2);
    const track = o.record === false ? undefined : rec;
    const a = run(s, st, null, { rec: track }).s;
    const b = run(a, st + d, th, { hMax: 20, rec: track }).s;
    return { s: b, dv: ve * Math.log(a.y[6] / b.y[6]), dur: d, t0: st };
  }

  const orbitText = (o: { peri: number; apo: number }): string => `${(o.peri / 1000).toFixed(0)} × ${(o.apo / 1000).toFixed(0)} km`;
  const pm = CH3.pmEngine;

  // ------------------------------------------------------------------ Earth-bound orbit raising
  let s: S = { t: sim.t, y: [sim.r[0], sim.r[1], sim.r[2], sim.v[0], sim.v[1], sim.v[2], CH3.stackMass] };
  for (let i = 0; i < launch.t.length && launch.t[i] < s.t; i++) {
    rec.t.push(launch.t[i]); rec.r.push(...launch.r.slice(3 * i, 3 * i + 3)); rec.v.push(...launch.v.slice(3 * i, 3 * i + 3));
    rec.m.push(launch.m[i]); rec.b.push(launch.b[i]);
  }
  events.push({
    t: sim.liftoffTime, id: 'liftoff', label: 'Liftoff', mass: liftoffMass, real: '14 July 2023, 09:05 UTC',
    detail: `LVM3-M4 leaves Sriharikota weighing ${(liftoffMass / 1000).toFixed(0)} t, with the ${CH3.stackMass} kg spacecraft on top.`,
  });
  const injectT = s.t;
  rec.push(s.t, s.y, false);
  const inj = apsides(s, 'earth');
  note(s, 'inject', 'Injected by LVM3', `Transfer orbit ${orbitText(inj)}, inclination ${asc.inclinationDeg.toFixed(1)}°.`, { orbit: { body: 'earth', ...inj }, real: '170 × 36 500 km' });

  /** Raise the far apsis from a perigee burn, or the perigee from an apogee burn. */
  const earthBurn = (from: S, gate: number, atPerigee: boolean, targetAlt: number, record = true): BurnOut =>
    burnAt(from, {
      ev: atPerigee ? periEv('earth') : apoEv('earth'), minT: gate, body: 'earth', engine: pm, record,
      eps: (e) => -MU_E / (norm(rel(e.t, e.y, 'earth').r) + RE + targetAlt),
    });
  const earthSteps: [string, string, string, boolean, number, string][] = [
    ['ebn1', 'Earth-bound burn 1', '2023-07-15T00:00:00Z', true, 41762e3, '173 × 41 762 km'],
    ['ebn2', 'Earth-bound burn 2', '2023-07-16T12:00:00Z', false, 226e3, '226 × 41 603 km'],
    ['ebn3', 'Earth-bound burn 3', '2023-07-18T00:00:00Z', true, 51400e3, '228 × 51 400 km'],
    ['ebn4', 'Earth-bound burn 4', '2023-07-20T00:00:00Z', true, 71351e3, '233 × 71 351 km'],
  ];
  say('Raising the orbit around Earth');
  for (const [id, label, gate, atPerigee, alt, real] of earthSteps) {
    const b = earthBurn(s, at(gate), atPerigee, alt);
    s = b.s;
    const o = apsides(s, 'earth');
    note(s, id, label, `${b.dv.toFixed(1)} m/s over ${b.dur.toFixed(0)} s at ${atPerigee ? 'perigee' : 'apogee'}. Orbit ${orbitText(o)}.`, { dv: b.dv, burn: b.dur, orbit: { body: 'earth', ...o }, real });
  }

  // ------------------------------------------------------------------ trans-lunar injection
  // The last phasing orbit is the real one, which puts the injection perigee on 31 July. Two
  // numbers are then solved together (Newton): the length of the injection burn, which sets how
  // far out the path reaches, and a small burn across the orbit plane a day later, which moves
  // the arrival point out of the plane. The two conditions at closest approach to the Moon:
  // the miss vector lies along the Moon's polar axis (a polar orbit) and has the perilune length.
  // A perigee burn cannot do the second job: it turns the plane about the line the Moon sits on.
  const eph = createMoonEphemeris(epochJD);
  const T0 = (epochJD - 2451545) / 36525;
  const obl = (23.439291 - 0.0130042 * T0) * DEG, co = Math.cos(obl), so = Math.sin(obl);
  const toEcl = (p: V3): V3 => [p[0], p[1] * co + p[2] * so, -p[1] * so + p[2] * co];
  const toEq = (p: V3): V3 => [p[0], p[1] * co - p[2] * so, p[1] * so + p[2] * co];
  const POLE = toEq([0, 0, 1]); // the lander's Moon model spins about ecliptic north
  const PERILUNE = R_MOON + 224e3; // the long insertion burn pulls the low point down to about 164 km

  const e5 = earthBurn(s, at('2023-07-25T00:00:00Z'), true, 127609e3);
  s = e5.s;
  {
    const o5 = apsides(s, 'earth');
    note(s, 'ebn5', 'Earth-bound burn 5', `${e5.dv.toFixed(1)} m/s over ${e5.dur.toFixed(0)} s at perigee. Orbit ${orbitText(o5)}.`, { dv: e5.dv, burn: e5.dur, orbit: { body: 'earth', ...o5 }, real: '236 × 127 609 km' });
  }
  // Two more perigees pass; the injection is on the third.
  for (let k = 0; k < 2; k++) s = run(s, s.t + 20 * DAY, null, { stop: periEv('earth'), minT: s.t + 3600, rec }).s;
  const sPre = s;

  interface Arrival { s: S; tli: BurnOut; tcm: { s: S; dv: number; dur: number } | null; res: [number, number]; along: number }
  let poleSide = 1; // which pole the approach passes over: whichever the first guess is nearer to
  const TCM_AFTER = DAY;
  // The solvers below ask for the same flights more than once (a Jacobian column shares the
  // injection burn with the current point; a converged point is asked for again). Unrecorded
  // flights are kept by their exact inputs, so a repeat costs nothing and returns the same numbers.
  const tliMemo = new Map<number, { tli: BurnOut; c: S }>();
  const nearMemo = new Map<string, { near: { s: S; hit: boolean }; tli: BurnOut; tcm: Arrival['tcm'] }>();
  const arrive = (tliBurn: number, tcmBurn: number, record: boolean): Arrival => {
    const track = record ? rec : undefined;
    const key = `${tliBurn}|${tcmBurn}`;
    let flown = record ? undefined : nearMemo.get(key);
    if (!flown) {
      let head = record ? undefined : tliMemo.get(tliBurn);
      if (!head) {
        const tli = burnAt(sPre, { ev: periEv('earth'), minT: sPre.t + 3600, body: 'earth', engine: pm, eps: () => 0, fixed: tliBurn, record });
        head = { tli, c: run(tli.s, tli.s.t + TCM_AFTER, null, { rec: track }).s };
        if (!record) tliMemo.set(tliBurn, head);
      }
      const tli = head.tli;
      let c = head.c;
      let tcm: Arrival['tcm'] = null;
      if (Math.abs(tcmBurn) > 1e-9) {
        const m0 = c.y[6];
        c = run(c, c.t + Math.abs(tcmBurn), { ...pm, body: 'earth', sense: tcmBurn > 0 ? 1 : -1, normal: true }, { hMax: 20, rec: track }).s;
        tcm = { s: c, dv: pm.isp * G0 * Math.log(m0 / c.y[6]), dur: Math.abs(tcmBurn) };
      }
      flown = { near: run(c, c.t + 9 * DAY, null, { stop: periEv('moon'), minT: c.t + DAY, rec: track }), tli, tcm };
      if (!record) nearMemo.set(key, flown);
    }
    const { near, tli, tcm } = flown;
    if (!near.hit) return { s: near.s, tli, tcm, res: [1e3, 1e3], along: 0 };
    const q = rel(near.s.t, near.s.y, 'moon'), vh = unit(q.v);
    const n = unit(sub(POLE, scale(vh, dot(POLE, vh)))), side = unit(cross(vh, POLE));
    return { s: near.s, tli, tcm, res: [dot(q.r, side) / 1e6, (dot(q.r, n) - poleSide * PERILUNE) / 1e6], along: dot(q.r, n) };
  };

  say('Solving the trans-lunar injection');
  // First guess for the injection burn: reach the Moon's distance, as a two-body orbit would.
  const guess = burnAt(sPre, { ev: periEv('earth'), minT: sPre.t + 3600, body: 'earth', engine: pm, record: false, eps: (e) => -MU_E / (norm(rel(e.t, e.y, 'earth').r) + RE + 369328e3) });
  let x: [number, number] = [guess.dur, 0];
  // Line up the in-plane miss first (one unknown), then solve both.
  for (let it = 0, h = 0.05; it < 25; it++) {
    const f0 = arrive(x[0], 0, false).res[0];
    if (Math.abs(f0) < 0.05) break;
    const d = (arrive(x[0] + h, 0, false).res[0] - f0) / h;
    x = [x[0] - Math.max(-6, Math.min(6, f0 / d)), 0];
  }
  const first = arrive(x[0], 0, false);
  poleSide = opts.poleSide ?? (first.along < 0 ? -1 : 1);
  let f = arrive(x[0], 0, false).res;
  for (let it = 0; it < 40 && Math.hypot(f[0], f[1]) > 2e-4; it++) {
    const hD = 0.05, hC = 0.5;
    const fa = arrive(x[0] + hD, x[1], false).res, fd = arrive(x[0], x[1] + hC, false).res;
    const j00 = (fa[0] - f[0]) / hD, j10 = (fa[1] - f[1]) / hD, j01 = (fd[0] - f[0]) / hC, j11 = (fd[1] - f[1]) / hC;
    const det = j00 * j11 - j01 * j10;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-30) throw new Error('cruise: trans-lunar targeting is singular');
    let dD = -(f[0] * j11 - f[1] * j01) / det, dC = -(j00 * f[1] - j10 * f[0]) / det;
    // The Moon focuses nearby paths, so the map is only locally linear: limit the step and back off if it gets worse.
    const lim = Math.max(Math.abs(dD) / 6, Math.abs(dC) / 60, 1);
    dD /= lim; dC /= lim;
    let k = 1, fn = f;
    for (let tries = 0; tries < 8; tries++, k /= 2) {
      fn = arrive(x[0] + k * dD, x[1] + k * dC, false).res;
      if (Math.hypot(fn[0], fn[1]) < Math.hypot(f[0], f[1])) break;
    }
    x = [x[0] + k * dD, x[1] + k * dC];
    f = fn;
  }
  if (Math.hypot(f[0], f[1]) > 5e-3) throw new Error(`cruise: trans-lunar targeting did not converge (miss ${(Math.hypot(f[0], f[1]) * 1000).toFixed(0)} km)`);

  const arr = arrive(x[0], x[1], true);
  {
    const ot = apsides(arr.tli.s, 'earth');
    note(arr.tli.s, 'tli', 'Trans-lunar injection', `${arr.tli.dv.toFixed(1)} m/s over ${arr.tli.dur.toFixed(0)} s at perigee. Now on a ${orbitText(ot)} path that reaches the Moon's distance.`, { dv: arr.tli.dv, burn: arr.tli.dur, orbit: { body: 'earth', ...ot }, real: '288 × 369 328 km' });
    if (arr.tcm) note(arr.tcm.s, 'tcm', 'Course correction', `${arr.tcm.dv.toFixed(1)} m/s across the orbit plane over ${arr.tcm.dur.toFixed(0)} s, so the path passes over the Moon's pole instead of hitting it.`, { dv: arr.tcm.dv, burn: arr.tcm.dur });
  }
  const arrival = arr.s;
  const hyp = rel(arrival.t, arrival.y, 'moon');

  // ------------------------------------------------------------------ lunar orbit insertion and lowering
  say('Braking into lunar orbit');
  // Rewind the recorded track to before the insertion burn begins, then fly the burn centred on perilune.
  const moonBurn = (from: S, ev: Ev, gate: number, targetAlt: number, engine: { force: number; isp: number }): BurnOut =>
    burnAt(from, { ev, minT: gate, body: 'moon', engine, eps: (e) => -MU_L / (norm(rel(e.t, e.y, 'moon').r) + R_MOON + targetAlt) });

  // The arrival coast was recorded up to perilune; drop its last 3 hours and refly them with the burn.
  const cut = arrival.t - 3 * 3600;
  let keep = rec.t.length;
  while (keep > 0 && rec.t[keep - 1] > cut) keep--;
  const back: S = { t: rec.t[keep - 1], y: [rec.r[3 * keep - 3], rec.r[3 * keep - 2], rec.r[3 * keep - 1], rec.v[3 * keep - 3], rec.v[3 * keep - 2], rec.v[3 * keep - 1], rec.m[keep - 1]] };
  rec.t.length = keep; rec.r.length = 3 * keep; rec.v.length = 3 * keep; rec.m.length = keep; rec.b.length = keep;
  const loiIndex = keep;
  const loi = moonBurn(back, periEv('moon'), back.t, 18074e3, pm);
  s = loi.s;
  {
    const o = apsides(s, 'moon');
    note(s, 'loi', 'Lunar orbit insertion', `Arrived at ${norm(hyp.v).toFixed(0)} m/s, ${((norm(hyp.r) - R_MOON) / 1000).toFixed(0)} km over the Moon. ${loi.dv.toFixed(1)} m/s retrograde over ${loi.dur.toFixed(0)} s: captured in ${orbitText(o)}.`, { dv: loi.dv, burn: loi.dur, orbit: { body: 'moon', ...o }, real: '164 × 18 074 km' });
  }
  const lunarSteps: [string, string, string, number, string][] = [
    ['lbn2', 'Lunar burn 2', '2023-08-06T12:00:00Z', 4313e3, '170 × 4 313 km'],
    ['lbn3', 'Lunar burn 3', '2023-08-09T06:00:00Z', 1437e3, '174 × 1 437 km'],
    ['lbn4', 'Lunar burn 4', '2023-08-14T04:00:00Z', 163e3, '151 × 179 km'],
    ['lbn5', 'Lunar burn 5', '2023-08-16T02:00:00Z', 153e3, '153 × 163 km'],
  ];
  for (const [id, label, gate, alt, real] of lunarSteps) {
    const b = moonBurn(s, periEv('moon'), Math.max(at(gate), s.t + 3600), alt, pm);
    s = b.s;
    const o = apsides(s, 'moon');
    note(s, id, label, `${b.dv.toFixed(1)} m/s retrograde over ${b.dur.toFixed(0)} s at perilune. Orbit ${orbitText(o)}.`, { dv: b.dv, burn: b.dur, orbit: { body: 'moon', ...o }, real });
  }
  const pmPropLeft = CH3.pmProp - (CH3.stackMass - s.y[6]);
  if (pmPropLeft < 0) throw new Error('cruise: the propulsion module ran out of propellant');

  // ------------------------------------------------------------------ landing day
  // The orbit plane stays put while the Moon turns under it. The landing has to happen when the
  // site is carried through the plane.
  say('Planning the landing');
  const mf = llToMF(CH3.site.latDeg * DEG, CH3.site.lonDeg * DEG);
  const siteDir = (t: number): V3 => {
    const F = eph.moonFrame(t);
    return toEq([mf[0] * F.x[0] + mf[1] * F.y[0] + mf[2] * F.z[0], mf[0] * F.x[1] + mf[1] * F.y[1] + mf[2] * F.z[1], mf[0] * F.x[2] + mf[1] * F.y[2] + mf[2] * F.z[2]]);
  };
  const normalOf = (st: S): V3 => { const q = rel(st.t, st.y, 'moon'); return unit(cross(q.r, q.v)); };
  let hN = normalOf(s);
  let tLand = NaN;
  for (let t = s.t + 3 * DAY, prev = dot(siteDir(t), hN); t < s.t + 32 * DAY; t += 1800) {
    const g = dot(siteDir(t + 1800), hN);
    if (prev * g <= 0) { tLand = t + (1800 * Math.abs(prev)) / (Math.abs(prev) + Math.abs(g) || 1); break; }
    prev = g;
  }
  if (!Number.isFinite(tLand)) throw new Error('cruise: the landing site never crosses the orbit plane');

  const tSep = Math.max(s.t + 0.4 * DAY, tLand - 6 * DAY);
  s = run(s, tSep, null, { rec }).s;
  s = { t: s.t, y: [...s.y.slice(0, 6), CH3.landerMass] };
  rec.push(s.t, s.y, false);
  note(s, 'sep', 'Lander separation', `Vikram (${CH3.landerMass} kg with the rover) leaves the propulsion module, which has ${pmPropLeft.toFixed(0)} kg of propellant left.`, { real: '17 August 2023' });

  // Perilune goes one braking distance short of the site, measured along the orbit.
  const spec0 = vikramSpec();
  const vPeri = Math.sqrt(MU_L * (2 / (R_MOON + 25e3) - 2 / (2 * R_MOON + 25e3 + 134e3)));
  const arc = brakeDistance(vPeri, CH3.landerMass - 12, spec0) / R_MOON;
  hN = normalOf(s);
  const sL = unit(sub(siteDir(tLand), scale(hN, dot(siteDir(tLand), hN))));
  const dPeri = add(scale(sL, Math.cos(arc)), scale(cross(hN, sL), -Math.sin(arc)));
  const db = CH3.deboostEngine;
  const db1 = moonBurn(s, dirEv(dPeri, hN), Math.max(s.t + 0.4 * DAY, tLand - 5 * DAY), 134e3, db);
  s = db1.s;
  note(s, 'db1', 'Deboost 1', `${db1.dv.toFixed(1)} m/s retrograde over ${db1.dur.toFixed(1)} s on two descent engines. Orbit ${orbitText(apsides(s, 'moon'))}.`, { dv: db1.dv, burn: db1.dur, orbit: { body: 'moon', ...apsides(s, 'moon') }, real: '113 × 157 km' });
  const db2 = moonBurn(s, dirEv(scale(dPeri, -1), normalOf(s)), Math.max(s.t + 0.4 * DAY, tLand - 3 * DAY), 25e3, db);
  s = db2.s;
  note(s, 'db2', 'Deboost 2', `${db2.dv.toFixed(1)} m/s retrograde over ${db2.dur.toFixed(1)} s. Orbit ${orbitText(apsides(s, 'moon'))}, low point just short of the landing site.`, { dv: db2.dv, burn: db2.dur, orbit: { body: 'moon', ...apsides(s, 'moon') }, real: '25 × 134 km' });

  // Pick the pass on which the site is closest to the ground track.
  let best: { s: S; cross: number } | null = null;
  let c = s;
  while (c.t < tLand + 1.5 * DAY) {
    const p = run(c, c.t + DAY, null, { stop: periEv('moon'), minT: c.t + 600 });
    if (!p.hit) break;
    c = p.s;
    if (c.t < tLand - 1.5 * DAY) continue;
    const cr = Math.asin(dot(siteDir(c.t + 500), normalOf(c)));
    if (!best || Math.abs(cr) < Math.abs(best.cross)) best = { s: c, cross: cr };
  }
  if (!best) throw new Error('cruise: no landing pass found');
  const tHand = best.s.t - 900;
  s = run(s, tHand, null, { rec }).s;
  const used = CH3.landerMass - s.y[6];
  const q = rel(s.t, s.y, 'moon');
  note(s, 'pdi', 'Ready for powered descent', `Vikram is 15 minutes from the low point of its orbit, ${(apsides(s, 'moon').peri / 1000).toFixed(1)} km up. The site will pass ${(Math.abs(best.cross) * R_MOON / 1000).toFixed(1)} km from the ground track.`, { real: '23 August 2023, 12:14 UTC' });

  const n = rec.t.length;
  return {
    epochJD, n,
    t: Float64Array.from(rec.t), r: Float64Array.from(rec.r), v: Float64Array.from(rec.v), mass: Float64Array.from(rec.m), burning: Uint8Array.from(rec.b),
    events, injectT, loiIndex,
    handoff: { t: s.t, r: toEcl(q.r), v: toEcl(q.v), spec: vikramSpec(used), perilune: apsides(s, 'moon').peri, crossTrack: best.cross * R_MOON },
    site: { ...CH3.site },
    pmPropLeft,
    ascent: { perigee: asc.perigeeAltitude, apogee: asc.apogeeAltitude, inclinationDeg: asc.inclinationDeg },
  };
}

/**
 * Ground distance covered while braking from speed v at a steady fraction of full thrust
 * (the same estimate the lander's own descent planner uses).
 */
export function brakeDistance(v: number, mass: number, spec: LanderSpec): number {
  const e = spec.engine!, frac = spec.brakeFrac ?? 0.7;
  const mEnd = mass * Math.exp(-(v + 350) / (e.isp * G0));
  return (v * v) / (2 * ((frac * e.tMax) / (0.5 * (mass + mEnd))));
}

/** Position, velocity and mass at time t by cubic Hermite interpolation between samples. */
export function cruiseStateAt(rec: CruiseRecord, t: number): { r: V3; v: V3; mass: number; burning: boolean; index: number } {
  const T = rec.t;
  let lo = 0, hi = rec.n - 1;
  if (t <= T[0]) hi = 0;
  else if (t >= T[hi]) lo = hi;
  else {
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid; }
  }
  const h = T[hi] - T[lo];
  if (lo === hi || h <= 0) {
    const i = t <= T[0] ? 0 : rec.n - 1;
    return { r: [rec.r[3 * i], rec.r[3 * i + 1], rec.r[3 * i + 2]], v: [rec.v[3 * i], rec.v[3 * i + 1], rec.v[3 * i + 2]], mass: rec.mass[i], burning: false, index: i };
  }
  const u = (t - T[lo]) / h, u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const d00 = (6 * u2 - 6 * u) / h, d10 = 3 * u2 - 4 * u + 1, d01 = -d00, d11 = 3 * u2 - 2 * u;
  const r: V3 = [0, 0, 0], v: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const p0 = rec.r[3 * lo + k], p1 = rec.r[3 * hi + k], v0 = rec.v[3 * lo + k], v1 = rec.v[3 * hi + k];
    r[k] = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
    v[k] = d00 * p0 + d10 * v0 + d01 * p1 + d11 * v1;
  }
  return { r, v, mass: rec.mass[lo] + (rec.mass[hi] - rec.mass[lo]) * u, burning: rec.burning[hi] === 1, index: lo };
}

const obliquityAt = (epochJD: number): number => (23.439291 - 0.0130042 * ((epochJD - 2451545) / 36525)) * DEG;

/** Ecliptic axes (the lander's frame) to the Earth-equatorial axes the cruise is flown in. */
export function eclToEq(p: V3, epochJD: number): V3 {
  const o = obliquityAt(epochJD), c = Math.cos(o), s = Math.sin(o);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

// ---------------------------------------------------------------------- keeping a flown record
// flyCruise depends on nothing but fixed constants, so its record can be stored (IndexedDB, or
// a file made at build time) and read back instead of flown again. Bump CRUISE_PHYSICS_REV when
// the flight changes in a way CH3 does not show (force model, integrator, mission design, LVM3).
const CRUISE_PHYSICS_REV = 3;
const CRUISE_MAGIC = 0x43483343; // "CH3C"

/** Changes whenever a stored record may no longer match what flyCruise would fly. */
export const CRUISE_RECORD_VERSION: number = (() => {
  const text = `${CRUISE_PHYSICS_REV}|lvm3-m4|${JSON.stringify(CH3)}`;
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
})();

/** The record as one ArrayBuffer: a small header, the scalar fields as JSON, then the samples. */
export function serializeCruise(rec: CruiseRecord): ArrayBuffer {
  const { t, r, v, mass, burning, ...rest } = rec;
  // JSON has no Infinity (an open orbit's apoapsis), so non-finite numbers go as strings.
  const json = new TextEncoder().encode(JSON.stringify(rest, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? { $num: String(x) } : x)));
  const n = rec.n, head = 12, body = (head + json.length + 7) & ~7;
  const buf = new ArrayBuffer(body + 8 * 8 * n + n);
  const dv = new DataView(buf);
  dv.setUint32(0, CRUISE_MAGIC, true); dv.setUint32(4, CRUISE_RECORD_VERSION, true); dv.setUint32(8, json.length, true);
  new Uint8Array(buf, head, json.length).set(json);
  let o = body;
  for (const a of [t, r, v, mass]) { new Float64Array(buf, o, a.length).set(a); o += 8 * a.length; }
  new Uint8Array(buf, o, n).set(burning);
  return buf;
}

/** Reads back what serializeCruise wrote; null if it is not one, or was made by another version. */
export function deserializeCruise(buf: ArrayBuffer): CruiseRecord | null {
  if (buf.byteLength < 12) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== CRUISE_MAGIC || dv.getUint32(4, true) !== CRUISE_RECORD_VERSION) return null;
  const len = dv.getUint32(8, true);
  const rest = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, len)), (_k, x) => (x && typeof x === 'object' && typeof x.$num === 'string' ? Number(x.$num) : x)) as Omit<CruiseRecord, 't' | 'r' | 'v' | 'mass' | 'burning'>;
  const n = rest.n;
  let o = (12 + len + 7) & ~7;
  if (buf.byteLength !== o + 65 * n) return null;
  const take = (k: number): Float64Array => { const a = new Float64Array(buf.slice(o, o + 8 * k)); o += 8 * k; return a; };
  const t = take(n), r = take(3 * n), v = take(3 * n), mass = take(n);
  return { ...rest, t, r, v, mass, burning: new Uint8Array(buf.slice(o, o + n)) };
}

/** Osculating orbit about a body from a relative state: apsis altitudes (m) and unit orbit normal. */
export function orbitAbout(r: V3, v: V3, body: CruiseBody): { peri: number; apo: number; normal: V3 } {
  const m = body === 'moon' ? MU_L : MU_E, R = body === 'moon' ? R_MOON : RE;
  const rr = norm(r), vv = norm(v), hv = cross(r, v), h = norm(hv);
  const eps = (vv * vv) / 2 - m / rr, e = Math.sqrt(Math.max(0, 1 + (2 * eps * h * h) / (m * m))), a = -m / (2 * eps);
  return { peri: a * (1 - e) - R, apo: eps < 0 ? a * (1 + e) - R : Infinity, normal: unit(hv) };
}
