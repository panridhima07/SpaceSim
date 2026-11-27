// @ts-nocheck
// Ported from the ASTRA Spaceflight prototype. The numeric code below is unchanged from the
// tested original, so its bodies are not type-checked; the declared class fields and the
// tests in this folder are the contract. Type the internals before changing the maths.
// Lunar lander: separation → deorbit burn → coast to perilune → powered descent (E-guidance braking, approach, hazard-avoiding
// terminal descent) → touchdown. Everything is simulated in a Moon-centred inertial frame with point-mass gravity, a finite-thrust
// throttleable engine (min throttle, spool lag, Isp-based mass flow), RCS-limited attitude dynamics and a four-foot contact model
// against the procedural terrain. AUTO flies the guidance; MANUAL gives rate-commanded attitude and a throttle level.
// Pure module (no DOM / three.js): used by the game and by `npm test`.
import * as P from './core';
import { LANDER_ENGINE, type LanderSpec, type MoonEphemeris } from './core';
import { Terrain, HazardMap, siteBasis, mfToLL, regionAt, fmtLatLon, pickTargets, R_MOON, type ScienceTarget } from './terrain';

const { MU_M, G0, dot, cross, norm, unit, add, sub, scale, clamp } = P;
const DEG = Math.PI / 180, LE = LANDER_ENGINE;

export const LD = {
  CGH: 2.4, FOOT: 3.9,                         // CG height above the foot plane, foot-circle radius (m) — matches the 3-D model
  I_K: 2.0, TAU: 0.25, DT: 0.05,               // inertia per kg (kg·m² / kg), throttle lag (s), step (s)
  W_MAX: 0.45, W_MAN: 0.2,                     // autopilot slew-rate limit, manual rate-command limit (rad/s)
  DOI_PERI: 15e3,                              // descent-orbit periapsis altitude (m)
  HG: { back: 5500, h: 1800, vh: 85, vz: -18 },   // "high gate": end of the braking phase
  LG: { back: 90, h: 120, vh: 9, vz: -4.5 },      // "low gate": start of terminal descent
  LIM: { vv: 4.5, vh: 2.5, tilt: 22, slope: 20 }, // beyond these the lander is destroyed on contact
};

// ------------------------------------------------------------------------------------------------ quaternions [x, y, z, w], body → inertial
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qnorm = (q) => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };
export function qrot(q, v) {
  const [x, y, z, w] = q, tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function qFromBasis(x, y, z) {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2], tr = m00 + m11 + m22; let s;
  if (tr > 0) { s = Math.sqrt(tr + 1) * 2; return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]; }
  if (m00 > m11 && m00 > m22) { s = Math.sqrt(1 + m00 - m11 - m22) * 2; return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  if (m11 > m22) { s = Math.sqrt(1 + m11 - m00 - m22) * 2; return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  s = Math.sqrt(1 + m22 - m00 - m11) * 2; return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}
// body +y → d, body +x as close as possible to `ref`
export function qFromY(d, ref = [0, 0, 1]) {
  const y = unit(d); let x = sub(ref, scale(y, dot(ref, y))); if (norm(x) < 1e-6) x = sub([1, 0, 0], scale(y, y[0])); if (norm(x) < 1e-6) x = sub([0, 1, 0], scale(y, y[1]));
  x = unit(x); return qnorm(qFromBasis(x, y, cross(x, y)));
}

const rk4 = (r, v, a, h) => {                                   // point-mass gravity + constant extra acceleration `a`
  const g = (p) => { const n = norm(p), k = -MU_M / (n * n * n); return [p[0] * k + a[0], p[1] * k + a[1], p[2] * k + a[2]]; };
  const k1v = g(r), k1r = v;
  const k2v = g(madd(r, k1r, h / 2)), k2r = madd(v, k1v, h / 2);
  const k3v = g(madd(r, k2r, h / 2)), k3r = madd(v, k2v, h / 2);
  const k4v = g(madd(r, k3r, h)), k4r = madd(v, k3v, h);
  return [[r[0] + (h / 6) * (k1r[0] + 2 * k2r[0] + 2 * k3r[0] + k4r[0]), r[1] + (h / 6) * (k1r[1] + 2 * k2r[1] + 2 * k3r[1] + k4r[1]), r[2] + (h / 6) * (k1r[2] + 2 * k2r[2] + 2 * k3r[2] + k4r[2])],
          [v[0] + (h / 6) * (k1v[0] + 2 * k2v[0] + 2 * k3v[0] + k4v[0]), v[1] + (h / 6) * (k1v[1] + 2 * k2v[1] + 2 * k3v[1] + k4v[1]), v[2] + (h / 6) * (k1v[2] + 2 * k2v[2] + 2 * k3v[2] + k4v[2])]];
};
const madd = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const grav = (p) => { const n = norm(p), k = -MU_M / (n * n * n); return [p[0] * k, p[1] * k, p[2] * k]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export type LanderPhase = 'SEP' | 'DOI' | 'COAST' | 'BRAKE' | 'APPROACH' | 'TERMINAL' | 'LANDED' | 'CRASHED';
export type LanderMode = 'AUTO' | 'MANUAL';
/** Start state in the ephemeris frame (geocentric): position, velocity and thrust-axis direction. */
export interface LanderStart { t: number; r: number[]; v: number[]; a: number[] }
export interface LanderEvent { t: number; text: string; level: 'info' | 'ok' | 'am' | 'bad' }
export interface LandingSite {
  /** rad */ lat: number; /** rad */ lon: number; U: number[]; E: number[]; N: number[];
  /** Approach direction as (east, north), unit length. */ appr: [number, number];
  name: string; mare: boolean; label: string;
}
export interface LandingResult {
  /** Downward and sideways touchdown speed, m/s. */ vv: number; vh: number;
  /** deg */ tilt?: number; /** deg */ slope?: number; /** m from the target */ miss?: number;
  x?: number; y?: number; propLeft?: number; mass?: number; hda?: boolean; t?: number; dvUsed?: number;
  destroyed?: boolean; hard?: boolean; score?: number; rating?: string;
}
export interface DescentPlan {
  /** Time of powered-descent initiation (perilune). */ tPDI: number; hPDI: number; vPDI: number;
  range: number; /** Site offset from the ground track at ignition, m (planTo only). */ cross?: number; site: LandingSite; pred: (LandingResult & { ok: boolean; reason?: string; dvMargin?: number }) | null;
}
/** Outcome of a flight the autopilot predicted before committing to it. */
export interface AutopilotForecast {
  /** 3 soft landing on the chosen spot with propellant to spare, 2 soft landing short of that, 1 hard landing, 0 destroyed. */ grade: number;
  phase: LanderPhase; /** Touchdown speeds, m/s. */ vv: number; vh: number;
  /** m from the aim point flown to, and from the planned site; null where the site map does not reach. */ miss: number | null; off: number | null;
  /** kg */ propLeft: number; /** Seconds of flight to touchdown. */ time: number;
}
/** COAST: wait for the (re-planned) ignition point. RESUME: fly the planned approach from here. DIVERT: brake at once and land on the nearest safe ground. */
export interface AutopilotDecision extends AutopilotForecast { choice: 'COAST' | 'RESUME' | 'DIVERT'; /** Every option that was flown ahead, in the order tried. */ tried: ({ choice: 'COAST' | 'RESUME' | 'DIVERT' } & AutopilotForecast)[] }
export interface LanderTelemetry {
  phase: LanderPhase; mode: LanderMode; alt: number; agl: number | null; vv: number; vh: number; speed: number;
  prop: number; propPct: number; mass: number; thr: number; level: number; tiltF: number; tiltR: number; twr: number;
  pitch: number; dv: number; engine: boolean; w: number; hold: 'RETRO' | 'UP' | null; toPDI: number | null; peri: number;
  site: string | null; hazard: number | null; range: number | null; x: number; y: number;
}

export class LanderSim {
  eph: MoonEphemeris; spec: LanderSpec; dt: number;
  /** Seconds since the ephemeris epoch. */ t: number;
  /** Moon-centred inertial position (m) and velocity (m/s). */ r: number[]; v: number[];
  /** Attitude quaternion [x, y, z, w], body to inertial; body +Y is the thrust axis. */ q: number[];
  w: number[];
  dry: number; prop0: number; prop: number; mass: number; hasRover: boolean;
  /** Engine and geometry in use (from the spec, or the defaults). */
  E: { tMax: number; minThrottle: number; isp: number; rcsTorque: number }; G: { cgh: number; foot: number; ik: number };
  brakeFrac: number; doiPeri: number;
  engine: boolean; thr: number; cmdThr: number; level: number; dCmd: number[] | null; slewing: boolean;
  phase: LanderPhase; mode: LanderMode; input: { pitch: number; roll: number; thr: number };
  hold: 'RETRO' | 'UP' | null; rateCmd: boolean;
  events: LanderEvent[]; site: LandingSite | null; terrain: Terrain | null; map: HazardMap | null;
  targets: ScienceTarget[] | null; /** Aim point in site metres (east, north). */ tgt: number[];
  plan: DescentPlan | null;
  hda: boolean; landing: LandingResult | null; reason: string | null;
  /** Height of the feet plane above the ground under the craft (m). */ agl: number; hFoot: number;
  tPhase: number; dvUsed: number; pendingDt: number; landed: boolean; silent: boolean;
  F: { x: number[]; y: number[]; z: number[] }; W: number[];
  /** True while the autopilot is flying a contingency descent to the nearest safe ground instead of the planned approach. */
  divert: boolean;
  /** What the autopilot decided when it was last engaged, and the flight it predicted for that choice. */
  engaged: AutopilotDecision | null;
  constructor(eph, s, spec) {
    this.eph = eph; this.spec = spec; this.dt = LD.DT;
    this.E = spec.engine ?? LE; this.G = { cgh: spec.geom?.cgh ?? LD.CGH, foot: spec.geom?.foot ?? LD.FOOT, ik: spec.geom?.inertiaPerKg ?? LD.I_K };
    this.brakeFrac = spec.brakeFrac ?? 0.7; this.doiPeri = spec.doiPeri ?? LD.DOI_PERI;
    this.t = s.t; const rm = eph.moonAt(s.t), vm = eph.moonVelAt(s.t);
    this.r = sub(s.r, rm); this.v = sub(s.v, vm);
    this.dry = spec.payloadMass - spec.landerProp; this.prop0 = this.prop = spec.landerProp; this.mass = this.dry + this.prop; this.hasRover = !!spec.hasRover;
    this.q = qFromY(unit(s.a), unit(this.v)); this.w = [0, 0, 0];
    this.engine = false; this.thr = 0; this.cmdThr = 0; this.level = 0; this.dCmd = null; this.slewing = false;
    this.phase = 'SEP'; this.mode = 'AUTO'; this.input = { pitch: 0, roll: 0, thr: 0 }; this.hold = null; this.rateCmd = false;
    this.events = []; this.site = null; this.terrain = null; this.map = null; this.targets = null; this.tgt = [0, 0]; this.plan = null;
    this.hda = false; this.dryTold = false; this.warnedLow = false; this.landing = null; this.reason = null; this.agl = 1e9; this.hFoot = 1e9; this.tPhase = this.t; this.dvUsed = 0; this.pendingDt = 0; this.landed = false; this.pose = null; this.silent = false;
    this.divert = false; this.dvSpot = false; this.dvAimed = false; this.dvTop = null; this.engaged = null;
    this.frame();
  }

  // ------------------------------------------------------------------ frames
  frame() { this.F = this.eph.moonFrame(this.t); this.W = this.eph.moonSpin(this.t); }
  toMF(v, F = this.F) { return [dot(v, F.x), dot(v, F.y), dot(v, F.z)]; }
  fromMF(m, F = this.F) { return [m[0] * F.x[0] + m[1] * F.y[0] + m[2] * F.z[0], m[0] * F.x[1] + m[1] * F.y[1] + m[2] * F.z[1], m[0] * F.x[2] + m[1] * F.y[2] + m[2] * F.z[2]]; }
  say(text, level = 'info') { if (!this.silent) this.events.push({ t: this.t, text, level }); }
  vrel() { return sub(this.v, cross(this.W, this.r)); }                      // velocity relative to the rotating surface
  alt() { return norm(this.r) - R_MOON; }
  // site-local coordinates (x east, y north, tangent plane at the site; h above the reference sphere)
  local(r, F = this.F) {
    const S = this.site, m = this.toMF(r, F), n = norm(m), p = scale(m, 1 / n), u = dot(p, S.U);
    return { x: (R_MOON * dot(p, S.E)) / u, y: (R_MOON * dot(p, S.N)) / u, h: n - R_MOON };
  }
  inertialAt(x, y, h, F = this.F) {
    const S = this.site, d = unit([R_MOON * S.U[0] + x * S.E[0] + y * S.N[0], R_MOON * S.U[1] + x * S.E[1] + y * S.N[1], R_MOON * S.U[2] + x * S.E[2] + y * S.N[2]]);
    return this.fromMF(scale(d, R_MOON + h), F);
  }
  basis(F = this.F) { const S = this.site; return { U: this.fromMF(S.U, F), E: this.fromMF(S.E, F), N: this.fromMF(S.N, F) }; }
  feet() {                                                                 // inertial positions of the four foot soles
    const out = []; for (let k = 0; k < 4; k++) { const a = (k * Math.PI) / 2, b = [Math.cos(a) * this.G.foot, -this.G.cgh, Math.sin(a) * this.G.foot]; out.push(add(this.r, qrot(this.q, b))); }
    return out;
  }
  periAlt() { return P.elements(this.r, this.v, MU_M, [0, 0, 1]).rp - R_MOON; }
  dvLeft() { return this.E.isp * G0 * Math.log(this.mass / this.dry); }

  // approximate ground arc (rad) between perilune and the end of the braking phase for a lander of this spec, deorbiting from a circular orbit at altAbove (m)
  static brakeArc(spec, altAbove = 100e3) {
    const E = spec.engine ?? LE, ra = R_MOON + altAbove, rp = R_MOON + (spec.doiPeri ?? LD.DOI_PERI), vp = Math.sqrt(MU_M * (2 / rp - 2 / (ra + rp))), m0 = spec.payloadMass - 60;
    const mEnd = m0 * Math.exp(-(vp + 350) / (E.isp * G0)), aD = ((spec.brakeFrac ?? 0.7) * E.tMax) / (0.5 * (m0 + mEnd)); return (vp * vp) / (2 * aD) / R_MOON;
  }
  // ------------------------------------------------------------------ plan: descent orbit → perilune → site → terrain
  planDescent() {
    let r = this.r.slice(), v = this.v.slice(), t = this.t, prev = dot(r, v), found = null;
    for (let i = 0; i < 4000 && !found; i++) {
      const [r1, v1] = rk4(r, v, [0, 0, 0], 5), rd = dot(r1, v1);
      if (prev < 0 && rd >= 0) { let lo = 0, hi = 5, a = [r, v]; for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2, [rm, vm] = rk4(r, v, [0, 0, 0], mid); if (dot(rm, vm) < 0) lo = mid; else hi = mid; a = [rm, vm]; } found = { t: t + hi, r: a[0], v: a[1] }; }
      r = r1; v = v1; t += 5; prev = rd;
    }
    if (!found) return null;
    // braking arc: distance covered while decelerating from perilune speed at ~70 % of the available thrust
    const vp = norm(found.v), mEnd = this.mass * Math.exp(-(vp + 350) / (this.E.isp * G0)), aD = (this.brakeFrac * this.E.tMax) / (0.5 * (this.mass + mEnd)), dist = (vp * vp) / (2 * aD), ang = dist / R_MOON;
    const rh = unit(found.r), th = unit(found.v), siteDir = add(scale(rh, Math.cos(ang)), scale(th, Math.sin(ang))), tdir = add(scale(rh, -Math.sin(ang)), scale(th, Math.cos(ang)));
    const tL = found.t + vp / aD, F = this.eph.moonFrame(tL), toMF = (x) => [dot(x, F.x), dot(x, F.y), dot(x, F.z)];
    const mf = toMF(siteDir), { lat, lon } = mfToLL(mf), reg = regionAt(lat / DEG, lon / DEG), B = siteBasis(lat, lon);
    const tm = toMF(tdir), ap = [dot(tm, B.E), dot(tm, B.N)], an = Math.hypot(ap[0], ap[1]) || 1;
    this.site = { lat, lon, ...B, appr: [ap[0] / an, ap[1] / an], name: reg.name, mare: reg.mare, label: `${reg.name} · ${fmtLatLon(lat / DEG, lon / DEG)}` };
    const seed = (Math.round(lat / DEG * 20) * 73856093) ^ (Math.round(lon / DEG * 20) * 19349663);
    this.terrain = new Terrain({ seed, mare: reg.mare }); this.map = new HazardMap(this.terrain); this.targets = pickTargets(this.map, this.terrain); this.tgt = [0, 0];
    this.plan = { tPDI: found.t, hPDI: norm(found.r) - R_MOON, vPDI: vp, range: dist, site: this.site, pred: null };
    return this.plan;
  }
  // Descent to a chosen site from the orbit the lander is already in. Powered descent starts when the ground distance
  // still to go equals the braking distance; the guidance then takes out the cross-track offset on the way down.
  // Returns null if the orbit does not pass within `reach` metres of the site in the next `horizon` seconds.
  planTo(lat, lon, name = 'Landing site', reach = 60e3, horizon = 4 * 3600) {
    const B = siteBasis(lat, lon), E = this.E;
    const look = (r, v, t) => {
      const F = this.eph.moonFrame(t), sd = this.fromMF(B.U, F), vr = sub(v, cross(this.eph.moonSpin(t), r)), vp = norm(vr);
      const mEnd = this.mass * Math.exp(-(vp + 350) / (E.isp * G0)), aD = (this.brakeFrac * E.tMax) / (0.5 * (this.mass + mEnd)), dist = (vp * vp) / (2 * aD);
      const ang = Math.acos(clamp(dot(unit(r), sd), -1, 1));
      return { gap: ang * R_MOON - dist, dist, vp, aD, sd, closing: dot(vr, sd) > 0 && ang < 1.2 };
    };
    let r = this.r.slice(), v = this.v.slice(), t = this.t, prev = look(r, v, t), found = null;
    for (let i = 0; i * 5 < horizon && !found; i++) {
      const [r1, v1] = rk4(r, v, [0, 0, 0], 5), now = look(r1, v1, t + 5);
      if (prev.closing && now.closing && prev.gap > 0 && now.gap <= 0) {
        let lo = 0, hi = 5, a = [r1, v1];
        for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2, [rm, vm] = rk4(r, v, [0, 0, 0], mid); if (look(rm, vm, t + mid).gap > 0) lo = mid; else { hi = mid; a = [rm, vm]; } }
        const L = look(a[0], a[1], t + hi), cr = Math.asin(clamp(dot(L.sd, unit(cross(a[0], a[1]))), -1, 1)) * R_MOON;
        if (Math.abs(cr) <= reach) found = { t: t + hi, r: a[0], v: a[1], ...L, cross: cr };
      }
      r = r1; v = v1; t += 5; prev = now;
    }
    if (!found) return null;
    const rh = this.toMF(unit(found.r), this.eph.moonFrame(found.t)), tm = unit(sub(scale(B.U, dot(rh, B.U)), rh)), ap = [dot(tm, B.E), dot(tm, B.N)], an = Math.hypot(ap[0], ap[1]) || 1;
    const reg = regionAt(lat / DEG, lon / DEG);
    this.site = { lat, lon, ...B, appr: [ap[0] / an, ap[1] / an], name, mare: reg.mare, label: `${name} · ${fmtLatLon(lat / DEG, lon / DEG)}` };
    const seed = (Math.round(lat / DEG * 20) * 73856093) ^ (Math.round(lon / DEG * 20) * 19349663);
    this.terrain = new Terrain({ seed, mare: reg.mare }); this.map = new HazardMap(this.terrain); this.targets = pickTargets(this.map, this.terrain); this.tgt = [0, 0];
    this.plan = { tPDI: found.t, hPDI: norm(found.r) - R_MOON, vPDI: found.vp, range: found.dist, site: this.site, pred: null, cross: found.cross };
    return this.plan;
  }
  // Skip the deorbit burn: the lander is already in its descent orbit and coasts to powered descent at the given site.
  beginDescentTo(lat, lon, name) {
    this.frame(); if (!this.planTo(lat, lon, name)) return false;
    this.phase = 'COAST'; this.tPhase = this.t; this.planned = true; this.dCmd = scale(unit(this.v), -1);
    this.say(`DESCENT ORBIT · TARGET ${this.site.label}`, 'ok'); return true;
  }
  clone() {
    const c = Object.create(LanderSim.prototype); Object.assign(c, this);
    for (const k of ['r', 'v', 'q', 'w', 'tgt']) c[k] = this[k].slice();
    c.input = { ...this.input }; c.events = []; c.plan = this.plan ? { ...this.plan } : null; c.landing = null; c.silent = true; return c;
  }
  // flight the autopilot would fly from here (same code, coarser step); yields to the event loop so the UI stays responsive
  async predict(onDone) {
    const c = this.clone(); c.mode = 'AUTO'; c.hold = null; c.dt = 0.1; let t0 = performance.now(), n = 0;
    while (c.phase !== 'LANDED' && c.phase !== 'CRASHED' && c.t < this.plan.tPDI + 1800 && n++ < 400000) {
      c.advance(1); if (performance.now() - t0 > 30) { await sleep(0); t0 = performance.now(); }
    }
    const ok = c.phase === 'LANDED', res = ok ? { ...c.landing, ok: true, t: c.t - this.plan.tPDI } : { ok: false, reason: c.reason || (c.prop <= 0 ? 'propellant exhausted before touchdown' : 'no touchdown within 30 minutes of PDI'), t: c.t - this.plan.tPDI, propLeft: c.prop };
    res.dvMargin = ok ? this.E.isp * G0 * Math.log(c.mass / c.dry) : 0; res.x = c.landing?.x; res.y = c.landing?.y;
    this.plan.pred = res; if (onDone) onDone(res); return res;
  }

  // ------------------------------------------------------------------ guidance
  grav(r) { return grav(r); }
  targetState(spec, T) {                                                  // gate state (inertial) at t + T, given in site coordinates
    const F = this.eph.moonFrame(this.t + T), B = this.basis(F), ap = this.site.appr, x = this.tgt[0] - spec.back * ap[0], y = this.tgt[1] - spec.back * ap[1];
    const rT = this.inertialAt(x, y, this.terrain.height(x, y) + spec.h, F);
    const hor = add(scale(B.E, ap[0]), scale(B.N, ap[1])), vT = add(cross(this.W, rT), add(scale(hor, spec.vh), scale(B.U, spec.vz)));
    return { rT, vT, x, y };
  }
  timeToGo(spec) {                                                        // constant-deceleration estimate from remaining ground distance and speeds
    const ap = this.site.appr, x = this.tgt[0] - spec.back * ap[0], y = this.tgt[1] - spec.back * ap[1], p = this.inertialAt(x, y, 0);
    const d = Math.acos(clamp(dot(unit(this.r), unit(p)), -1, 1)) * R_MOON, vr = this.vrel(), ur = unit(this.r), vh = norm(sub(vr, scale(ur, dot(vr, ur))));
    return { d, T: clamp(vh + spec.vh > 3 ? (2 * d) / (vh + spec.vh) : 6, 4, 900) };
  }
  eguide(rT, vT, T) {                                                     // E-guidance: cubic position profile meeting (rT, vT) at t + T
    const r = this.r, v = this.v, g = scale(add(grav(r), grav(rT)), 0.5), a = [0, 0, 0];
    for (let k = 0; k < 3; k++) a[k] = (6 * (rT[k] - r[k])) / (T * T) - (4 * v[k] + 2 * vT[k]) / T - g[k];
    return a;                                                             // thrust acceleration (inertial)
  }
  setThrustCmd(aT) {                                                     // thrust acceleration → throttle + pointing
    const need = norm(aT) * this.mass; this.dCmd = need > 1e-6 ? unit(aT) : this.dCmd;
    this.cmdThr = need <= 1 ? this.E.minThrottle : clamp(need / this.E.tMax, this.E.minThrottle, 1);
    // Thrust is only useful along the commanded direction: while the craft is still turning towards it (after hand flying), hold the engine back.
    const off = this.pointErr(); if (off > 90 * DEG) this.cmdThr = 0; else if (off > 50 * DEG) this.cmdThr = this.E.minThrottle;
  }
  retarget() {                                                            // hazard detection & avoidance: nearest footprint that is flat and boulder-free
    this.hda = true; const [tx, ty] = this.tgt, k = this.map.idx(tx, ty);
    if (k >= 0 && this.map.hzFoot[k] === 0) { this.say('HAZARD CHECK · TARGET AREA CLEAR', 'ok'); return; }
    const sp = this.map.safeSpot(tx, ty, 160);
    if (!sp) { this.say('NO SAFE FOOTPRINT WITHIN 160 m · HOLDING TARGET', 'am'); return; }
    const dx = sp[0] - tx, dy = sp[1] - ty, d = Math.hypot(dx, dy), dirs = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'], c = dirs[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
    this.tgt = sp; this.say(`HAZARD AVOIDANCE · RETARGET ${d.toFixed(0)} m ${c}`, 'am');
  }
  autoGuide(h) {
    if (this.divert) { this.divertGuide(); return; }
    const alt = this.alt(), l = this.local(this.r), ground = this.terrain.ground(l.x, l.y); this.agl = l.h - ground - this.G.cgh;
    if (this.phase === 'BRAKE') {
      const { d, T } = this.timeToGo(LD.HG);
      if (d < 500 || (T < 8 && d < 4000)) { this.phase = 'APPROACH'; this.tPhase = this.t; this.say('HIGH GATE · APPROACH PHASE', 'ok'); }
      else { const g = this.targetState(LD.HG, T); this.setThrustCmd(this.eguide(g.rT, g.vT, T)); return; }
    }
    if (this.phase === 'APPROACH') {
      if (this.agl < 420 && !this.hda) this.retarget();
      const { d, T } = this.timeToGo(LD.LG);
      if (this.agl < 135 || d < 25 || (T < 6 && d < 300)) { this.phase = 'TERMINAL'; this.tPhase = this.t; this.say('LOW GATE · TERMINAL DESCENT', 'ok'); }
      else { const g = this.targetState(LD.LG, T); this.setThrustCmd(this.eguide(g.rT, g.vT, T)); return; }
    }
    if (this.phase === 'TERMINAL') {
      if (!this.hda) this.retarget();
      const B = this.basis(), vr = this.vrel(), vE = dot(vr, B.E), vN = dot(vr, B.N), vU = dot(vr, B.U), ex = this.tgt[0] - l.x, ey = this.tgt[1] - l.y, e = Math.hypot(ex, ey);
      const hv = clamp(0.2 * e, 0, 6) * (0.15 + 0.85 * clamp(this.agl / 50, 0, 1)), cE = e > 0.05 ? (ex / e) * hv : 0, cN = e > 0.05 ? (ey / e) * hv : 0;
      const vzc = -clamp(0.5 + 0.034 * this.agl, 0.5, 5.0), g = MU_M / (norm(this.r) ** 2);
      let aE = 0.7 * (cE - vE), aN = 0.7 * (cN - vN), aU = Math.max(g + 1.1 * (vzc - vU), 0.1);   // never thrust downwards to lose height: gravity does that
      const lim = Math.tan(24 * DEG) * Math.max(aU, 0.3), ah = Math.hypot(aE, aN); if (ah > lim) { aE *= lim / ah; aN *= lim / ah; }
      this.setThrustCmd(add(add(scale(B.E, aE), scale(B.N, aN)), scale(B.U, aU)));
    }
  }
  manualGuide(dt) {
    const I = this.input; this.level = clamp(this.level + I.thr * 0.5 * dt, 0, 1);
    this.cmdThr = this.level > 0.02 && this.prop > 0 ? clamp(this.level, this.E.minThrottle, 1) : 0;
    const active = Math.abs(I.pitch) + Math.abs(I.roll) > 0.01;
    this.rateCmd = active; if (active) this.hold = null;
    if (!active && this.hold) { const vr = this.vrel(); this.dCmd = this.hold === 'RETRO' ? (norm(vr) > 0.5 ? scale(unit(vr), -1) : unit(this.r)) : unit(this.r); } else if (!active) this.dCmd = null;
    if (this.site) { const l = this.local(this.r), ground = this.terrain.ground(l.x, l.y); this.agl = l.h - ground - this.G.cgh; }
  }
  guidance(dt) {
    const mu = this.phase;
    if (mu === 'SEP') {
      this.dCmd = scale(unit(this.v), -1); this.cmdThr = 0;
      if (this.t - this.tPhase > 5 && this.pointErr() < 2 * DEG) { this.phase = 'DOI'; this.tPhase = this.t; this.say('DEORBIT BURN · IGNITION', 'am'); }
      return;
    }
    if (mu === 'DOI') {
      this.dCmd = scale(unit(this.v), -1);
      if (this.periAlt() <= this.doiPeri + 150 || this.prop <= 0) {
        this.cmdThr = 0; this.engine = false; this.thr = 0; this.say(`DEORBIT BURN COMPLETE · PERILUNE ${(this.periAlt() / 1000).toFixed(1)} km`, 'ok');
        if (!this.planDescent()) { this.phase = 'CRASHED'; this.reason = 'Descent orbit could not be established'; return; }
        this.phase = 'COAST'; this.tPhase = this.t; this.say(`DESCENT ORBIT SET · TARGET ${this.site.label}`, 'ok'); this.planned = true;
      } else this.cmdThr = clamp(0.2 + (this.periAlt() - this.doiPeri) / 1.5e5, this.E.minThrottle, 0.6);
      return;
    }
    if (mu === 'COAST') {
      const left = this.plan.tPDI - this.t;
      if (this.mode === 'AUTO') {
        this.dCmd = scale(unit(this.v), -1); this.cmdThr = 0;
        if (left <= 1e-6) { this.phase = 'BRAKE'; this.tPhase = this.t; this.say('POWERED DESCENT INITIATED', 'ok'); this.cmdThr = this.E.minThrottle; }
      } else { this.manualGuide(dt); if (this.cmdThr > 0) { this.phase = 'BRAKE'; this.tPhase = this.t; this.say('ENGINE START · POWERED DESCENT (MANUAL)', 'ok'); } }
      return;
    }
    // powered descent
    if (this.mode === 'AUTO') this.autoGuide(dt);
    else {
      this.manualGuide(dt);
      const a = this.agl; if (this.phase === 'BRAKE' && a < 2000 && this.alt() < 5000) this.phase = 'APPROACH'; if (a < 135 && this.phase !== 'TERMINAL') this.phase = 'TERMINAL';
    }
  }
  // ------------------------------------------------------------------ autopilot re-engagement
  // The planned descent only works from the state it was planned for: the braking burn runs the engine at its limit, so a
  // few seconds of hand flying (a late ignition, a cut engine, a tilt) leave the original gates out of reach. Whenever the
  // autopilot is engaged it therefore re-plans from where the lander actually is. It flies each option ahead on a copy of
  // itself (same physics, same guidance code) and commits to the first one that lands softly:
  //   COAST   engine off until the ignition point for the site, re-computed for the present orbit (this pass or a later one)
  //   RESUME  the planned approach, picked up in the phase that fits the present height and speed
  //   DIVERT  brake at once, then set down on the nearest safe ground (divertGuide)
  // When nothing lands softly it takes the gentlest outcome; the crash is still reported as one.
  nearSite(r = this.r) { return !!this.site && dot(unit(this.toMF(r)), this.site.U) > 0.9; }   // within reach of the site's map projection (~780 km)
  // Next point on the present orbit where the ground distance still to go equals the braking distance (the rule planTo uses).
  findIgnition(contingency = false, reach = 60e3, horizon = 4 * 3600) {
    const S = this.site, E = this.E;
    const look = (r, v, t) => {
      const F = this.eph.moonFrame(t), sd = this.fromMF(S.U, F), vr = sub(v, cross(this.eph.moonSpin(t), r)), vp = norm(vr);
      const mEnd = this.mass * Math.exp(-(vp + 350) / (E.isp * G0)), aD = (this.brakeFrac * E.tMax) / (0.5 * (this.mass + mEnd));
      const dist = contingency ? this.brakeRun(vp).s / 0.9 : (vp * vp) / (2 * aD);          // the contingency descent starts with a tenth of its braking in hand
      const ang = Math.acos(clamp(dot(unit(r), sd), -1, 1));
      return { gap: ang * R_MOON - dist, dist, vp, sd, closing: dot(vr, sd) > 0 && ang < 1.2 };
    };
    let r = this.r.slice(), v = this.v.slice(), t = this.t, prev = look(r, v, t); const thisPass = prev.closing && prev.gap > 0;
    for (let i = 0; i * 5 < horizon; i++) {
      const [r1, v1] = rk4(r, v, [0, 0, 0], 5), now = look(r1, v1, t + 5);
      if (norm(r1) - R_MOON < 6000) return null;                          // the coast would reach the ground first
      if (prev.closing && now.closing && prev.gap > 0 && now.gap <= 0) {
        let lo = 0, hi = 5, a = [r1, v1];
        for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2, [rm, vm] = rk4(r, v, [0, 0, 0], mid); if (look(rm, vm, t + mid).gap > 0) lo = mid; else { hi = mid; a = [rm, vm]; } }
        const L = look(a[0], a[1], t + hi), cr = Math.asin(clamp(dot(L.sd, unit(cross(a[0], a[1]))), -1, 1)) * R_MOON;
        if (Math.abs(cr) <= reach) return { t: t + hi, r: a[0], v: a[1], vp: L.vp, dist: L.dist, cross: cr, thisPass };
      }
      r = r1; v = v1; t += 5; prev = now;
    }
    return null;
  }
  coastTo(ign) {                                                          // engine off until the re-planned ignition point
    const S = this.site, rh = this.toMF(unit(ign.r), this.eph.moonFrame(ign.t)), tm = unit(sub(scale(S.U, dot(rh, S.U)), rh)), ap = [dot(tm, S.E), dot(tm, S.N)], an = Math.hypot(ap[0], ap[1]) || 1;
    this.site = { ...S, appr: [ap[0] / an, ap[1] / an] };
    this.plan = { ...this.plan, tPDI: ign.t, hPDI: norm(ign.r) - R_MOON, vPDI: ign.vp, range: ign.dist, cross: ign.cross, site: this.site, pred: null };
    this.phase = 'COAST'; this.tPhase = this.t; this.cmdThr = 0; this.hda = false; this.dCmd = scale(unit(this.v), -1);
  }
  resumePowered() {                                                       // the planned approach, in the phase that fits the present state
    if (!this.nearSite()) return false;
    const l = this.local(this.r), agl = l.h - this.terrain.ground(l.x, l.y) - this.G.cgh, vr = this.vrel(), up = unit(this.r), vh = norm(sub(vr, scale(up, dot(vr, up))));
    const d = Math.hypot(this.tgt[0] - l.x, this.tgt[1] - l.y), ph = agl < 135 ? 'TERMINAL' : d < 9000 && vh < 230 && l.h < 6000 ? 'APPROACH' : 'BRAKE';
    if (ph !== 'TERMINAL' || this.phase !== 'TERMINAL') this.hda = false;
    this.agl = agl; if (ph !== this.phase) { this.phase = ph; this.tPhase = this.t; }
    return true;
  }
  startDivert(flatOut = false) {                                          // contingency descent; flatOut: brake at once without aiming for the site
    const ign = flatOut ? null : this.findIgnition(true); this.dvSpot = false; this.dvAimed = false; this.dvTop = null; this.dvFloor = null; this.dvFlat = flatOut; this.hda = false;
    if (ign && ign.thisPass && ign.t - this.t > 20) this.coastTo(ign); else if (this.phase === 'COAST') { this.phase = 'BRAKE'; this.tPhase = this.t; }
    this.divert = true;
  }
  // Fly a copy of the lander to touchdown under the autopilot and grade the result. Long coasts are integrated in 5 s steps.
  foresee(c) {
    c.silent = true; c.mode = 'AUTO'; c.hold = null; const t0 = c.t; let n = 0, tPow = 0;
    while (c.phase !== 'LANDED' && c.phase !== 'CRASHED' && n++ < 400000 && tPow < 3600) {
      if (c.phase === 'COAST' && !c.engine && c.plan.tPDI - c.t > 130) {
        const h = Math.min(5, c.plan.tPDI - c.t - 120); [c.r, c.v] = rk4(c.r, c.v, [0, 0, 0], h); c.t += h; c.q = qFromY(scale(unit(c.v), -1), unit(c.v)); c.w = [0, 0, 0];
        if (norm(c.r) - R_MOON < 3000) { c.frame(); c.crash('Impact while coasting'); }
        continue;
      }
      c.advance(1); if (c.phase !== 'COAST') tPow += 1;
    }
    const g = c.landing, ok = c.phase === 'LANDED', soft = ok && !g.hard, onSpot = soft && c.prop >= 2 && (g.miss == null || g.miss <= 12);   // on the vetted footprint, not merely somewhere on the way to it
    return {
      grade: onSpot ? 3 : soft ? 2 : ok ? 1 : 0, phase: c.phase, vv: g ? g.vv : -dot(c.vrel(), unit(c.r)), vh: g ? g.vh : 0,
      miss: g && g.miss != null ? g.miss : null, off: g && g.x != null ? Math.hypot(g.x, g.y) : null, propLeft: c.prop, time: c.t - t0,
    };
  }
  replan() {
    this.divert = false; this.dvSpot = false; this.dvAimed = false; this.dvTop = null; this.dvFloor = null; this.dvFlat = false; this.hold = null; this.engaged = null;
    if (!this.site || !this.plan || !this.terrain || this.landed || this.phase === 'CRASHED' || this.phase === 'SEP' || this.phase === 'DOI') return null;
    const ign = this.findIgnition(), tried = [];
    const set = { COAST: (c) => c.coastTo(ign), RESUME: (c) => c.resumePowered(), DIVERT: (c) => c.startDivert(), FLATOUT: (c) => c.startDivert(true) };
    const attempt = (how) => { const c = this.clone(); if (set[how](c) === false) return null; const f = { choice: how === 'FLATOUT' ? 'DIVERT' : how, how, ...this.foresee(c) }; tried.push(f); return f; };
    const good = (f) => !!f && f.grade === 3, impact = (f) => Math.hypot(f.vv, f.vh);
    let pick = null;
    if (ign && ign.thisPass && (ign.t - this.t > 20 || (this.phase === 'COAST' && !this.engine))) pick = attempt('COAST');   // the site is still ahead: nothing to do until the ignition point
    if (!good(pick)) pick = attempt('RESUME');
    if (!good(pick)) {
      let dv = attempt('DIVERT'); if (!good(dv)) dv = attempt('FLATOUT');
      // Setting down more than 20 km from the site leaves the mapped terrain; when the orbit is still good, going round for another pass is the better landing.
      const round = ign && !ign.thisPass && (!good(dv) || dv.off === null || dv.off > 20e3) ? attempt('COAST') : null;
      pick = good(round) ? round : good(dv) ? dv : null;
    }
    if (!pick) pick = tried.slice().sort((a, b) => b.grade - a.grade || impact(a) - impact(b))[0];   // nothing lands softly: take the gentlest end
    set[pick.how](this);
    for (const f of tried) delete f.how;
    this.engaged = { ...pick, tried };
    if (pick.choice === 'COAST') { const left = this.plan.tPDI - this.t; this.say(`AUTOPILOT · ${ign.thisPass ? 'COASTING TO IGNITION' : 'IGNITION POINT PASSED · GOING ROUND'} · IGNITION IN ${left >= 600 ? (left / 60).toFixed(0) + ' min' : left.toFixed(0) + ' s'}`, ign.thisPass ? 'info' : 'am'); }
    else if (pick.choice === 'DIVERT') this.say(pick.off !== null && pick.off < 500 ? 'AUTOPILOT · PLANNED APPROACH OUT OF REACH · CONTINGENCY DESCENT TO THE SITE' : `AUTOPILOT · SITE OUT OF REACH · LANDING ON THE NEAREST SAFE GROUND${pick.off !== null && pick.grade > 0 ? ` · ${(pick.off / 1000).toFixed(1)} km AWAY` : ''}`, 'am');
    if (pick.grade === 0) this.say('AUTOPILOT · NO SAFE LANDING FROM HERE · BRAKING AS HARD AS IT CAN', 'bad');
    return this.engaged;
  }
  // Nearest ground a lander can stand on. Inside the hazard map that is its vetted footprint search; beyond it the terrain model is tested directly.
  safeGround(x, y, reach = 900) {
    if (this.map.inside(x, y)) { const s = this.map.safeSpot(x, y, Math.min(200, reach)); if (s) return s; }
    const T = this.terrain; if (Math.max(Math.abs(x), Math.abs(y)) > T.half) return [x, y];   // past the modelled patch the Moon is a smooth sphere
    const f = this.G.foot + 1, worst = (px, py) => {                       // steepest slope under the footprint, deg; 99 with a boulder under it
      let w = T.slopeDeg(px, py, 4); if (T.rockH(px, py) > 0) return 99;
      for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4, qx = px + Math.cos(a) * f, qy = py + Math.sin(a) * f; if (T.rockH(qx, qy) > 0.2) return 99; w = Math.max(w, 0.7 * T.slopeDeg(qx, qy, 2)); }
      return w;
    };
    let best = null, bw = 14;                                              // nothing level in reach: the least steep ground under 14 deg
    for (let R = 0; R <= reach; R += 12) {
      const n = Math.max(1, Math.round((2 * Math.PI * R) / 12));
      for (let k = 0; k < n; k++) { const a = (2 * Math.PI * k) / n, px = x + R * Math.cos(a), py = y + R * Math.sin(a), w = worst(px, py); if (w <= 7) return [px, py]; if (w < bw) { bw = w; best = [px, py]; } }
    }
    return best;
  }
  // Time and ground distance to shed a ground speed v with the engine at full thrust, a share eta of it horizontal (rocket equation, closed form).
  brakeRun(v, eta = 0.93) {
    const ve = this.E.isp * G0, md = this.E.tMax / ve, m0 = this.mass, m1 = m0 * Math.exp(-v / (eta * ve));
    return { t: (m0 - m1) / md, s: (v * (m0 - m1)) / md - ((eta * ve) / md) * (m0 - m1 - m1 * Math.log(m0 / m1)) };
  }
  // Contingency descent. Braking: thrust against the ground speed, throttled so that the lander stops over the aim point when
  // that is still ahead and within reach, flat out when it is not (it then stops as soon as it can, beyond the aim point);
  // meanwhile the height follows a cubic that ends ~150 m above the highest ground on the way. Once the ground speed is nearly
  // gone it picks a safe spot under the stopping point (the aim point itself when that is within 250 m) and comes down on it,
  // falling freely while it is high and braking at a rate the remaining propellant can pay for.
  divertGuide() {
    const E = this.E, up = unit(this.r), rn = norm(this.r), vr = this.vrel(), vv = dot(vr, up), vhV = sub(vr, scale(up, vv)), vh = norm(vhV);
    const g = MU_M / (rn * rn), aMax = E.tMax / this.mass, ve = E.isp * G0, vi = sub(this.v, scale(up, dot(this.v, up))), gEff = g - dot(vi, vi) / rn;   // weight less the centrifugal relief of the speed over the ground
    const near = this.nearSite(), l = near ? this.local(this.r) : null, ground = near ? this.terrain.ground(l.x, l.y) : 0, agl = rn - R_MOON - ground - this.G.cgh; this.agl = agl;
    const e0 = this.fromMF(this.site.E), eL = unit(sub(e0, scale(up, dot(e0, up)))), nL = cross(up, eL);                 // local east and north
    const pT = unit(this.inertialAt(this.tgt[0], this.tgt[1], 0)), cT = dot(pT, up), wT = sub(pT, scale(up, cT)), nw = norm(wT);
    const D = nw > 1e-12 ? scale(wT, (Math.acos(clamp(cT, -1, 1)) * R_MOON) / nw) : [0, 0, 0];                            // ground offset of the aim point from the craft
    const setPhase = (p) => { if (p !== this.phase) { this.phase = p; this.tPhase = this.t; } };
    if (!this.dvSpot && vh > (this.dvAimed ? 10 : 25)) {
      const tH = scale(vhV, 1 / vh), along = dot(D, tH) - 40, run = this.brakeRun(vh); let eta = 1, vl = null; this.dvAimed = false;
      if (along > 0 && cT > 0.2 && !this.dvFlat) {                         // aim point ahead: brake no harder than needed to stop over it
        const rho = run.s / along; this.dvAimed = rho < 1.3; if (rho < 1) eta = 0.93 * rho;   // run.s keeps 7 % of the thrust in hand
        const u = unit(D); vl = sub(vhV, scale(u, dot(vhV, u)));           // ground speed across the line to the aim point
      }
      const T = Math.max(this.brakeRun(vh, clamp(eta, 0.25, 0.93)).t, 12), mEnd = this.mass * Math.exp(-vh / (0.9 * ve));
      if (!this.dvTop || Math.abs(this.t - this.dvTop.t) > 1) {            // highest ground under the braking run, re-surveyed once a second
        let top = ground; if (near) { const ux = dot(tH, eL), uy = dot(tH, nL), sb = 1.2 * Math.max(run.s, along > 0 ? Math.min(along, 60e3) : 0); for (let k = 1; k <= 8; k++) top = Math.max(top, this.terrain.height(l.x + (ux * sb * k) / 8, l.y + (uy * sb * k) / 8)); }
        this.dvTop = { t: this.t, top };
      }
      const dh = rn - R_MOON - (Math.max(this.dvTop.top, ground) + this.G.cgh + 150);          // height above where the braking should end
      let aU = (-6 * dh) / (T * T) - (4 * vv - 8) / T + gEff;                                  // cubic height profile reaching dh = 0 at -4 m/s when the ground speed is gone
      const aNet = Math.max((0.8 * E.tMax) / mEnd - g, 0.15), vSafe = Math.sqrt(2 * aNet * Math.max(dh + 100, 0)) + 2;
      if (vv < -vSafe) aU = Math.max(aU, gEff + (-vSafe - vv));                               // never sink faster than the engine can still arrest
      aU = clamp(aU, 0, 0.98 * aMax);
      const aBr = Math.min(eta * aMax, Math.sqrt(aMax * aMax - aU * aU), 0.5 * vh);
      let aT = add(scale(up, aU), scale(tH, -aBr));
      if (vl) { const k = Math.min(3 / T, (0.15 * aMax) / Math.max(norm(vl), 1e-6)); aT = add(aT, scale(vl, -k)); }
      this.setThrustCmd(aT);
      if (eta < 0.6 * E.minThrottle && aU < 0.3 * E.minThrottle * aMax) { this.cmdThr = 0; this.dCmd = scale(tH, -1); }   // well short of the aim point with height in hand: coast, engine off
      setPhase(vh > 150 || agl > 6000 ? 'BRAKE' : agl < 135 ? 'TERMINAL' : 'APPROACH');
      return;
    }
    const dvL = this.dvLeft(), aCap = Math.max(0.92 * aMax - g, 0.05);
    if (!this.dvSpot) {                                                    // ground speed nearly gone: choose where to set down
      this.dvSpot = true;
      if (near) {
        const sx = (vh * vh) / 1.2, px = l.x + (dot(vhV, eL) / (vh || 1)) * sx, py = l.y + (dot(vhV, nL) / (vh || 1)) * sx;   // where the remaining drift ends
        const fall = Math.sqrt(vv * vv + 2 * g * Math.max(agl, 0)), spare = dvL > 2.2 * fall + 90;                           // propellant for a sideways move as well as the descent
        if (spare && !this.dvFlat && Math.hypot(px - this.tgt[0], py - this.tgt[1]) <= 250) this.retarget();
        else { const sp = this.safeGround(px, py, spare ? 900 : clamp((4 * (vv + fall)) / g, 30, 900)); this.tgt = sp || [px, py]; this.hda = true; this.say(sp ? `LANDING POINT SET · ${(Math.hypot(this.tgt[0], this.tgt[1]) / 1000).toFixed(1)} km FROM THE PLANNED SITE` : 'NO SAFE GROUND FOUND NEARBY · LANDING HERE', sp ? 'am' : 'bad'); }
      }
    }
    let ex = 0, ey = 0;
    if (near) { const pS = unit(this.inertialAt(this.tgt[0], this.tgt[1], 0)), c = dot(pS, up), w = sub(pS, scale(up, c)), n = norm(w), k = n > 1e-12 ? (Math.acos(clamp(c, -1, 1)) * R_MOON) / n : 0; ex = dot(w, eL) * k; ey = dot(w, nL) * k; }
    const e = Math.hypot(ex, ey), vE = dot(vr, eL), vN = dot(vr, nL);
    let floor = ground;                                                    // ground to stay clear of: under the craft and, until it is over the spot, on the way there
    if (near && e > 3) {
      if (!this.dvFloor || Math.abs(this.t - this.dvFloor.t) > 0.5) { let top = -1e9; for (let k = 1; k <= 8; k++) top = Math.max(top, this.terrain.ground(l.x + ((this.tgt[0] - l.x) * k) / 8, l.y + ((this.tgt[1] - l.y) * k) / 8)); this.dvFloor = { t: this.t, top }; }
      floor = Math.max(floor, this.dvFloor.top);
    }
    const hEff = rn - R_MOON - floor - this.G.cgh - clamp(e - 3, 0, 40);   // and up to 40 m higher than that while still off to one side
    // Descent rate: a constant deceleration aB down to 0.6 m/s for the last 1.5 m. Gentle while there is propellant to spare, the engine's limit when there is not.
    const vFall = Math.sqrt(vv * vv + 2 * g * Math.max(hEff, 0)), R = (dvL - 20 - vh) / Math.max(vFall, 1);
    const aB = clamp(R > 1.05 ? (1.15 * g) / (R - 1) : aCap, 0.35 * aCap, aCap);
    const vzc = hEff >= 0 ? -Math.sqrt(0.36 + 2 * aB * Math.max(hEff - 1.5, 0)) : Math.min(2, -0.3 * hEff);
    const hv = Math.min(0.2 * e, Math.sqrt(0.8 * e), 6 + 0.01 * clamp(agl, 0, 1400)) * (0.3 + 0.7 * clamp(agl / 30, 0, 1)) * clamp(1 + hEff / 15, 0, 1);   // no sideways move below the ground ahead
    const cE = e > 0.05 ? (ex / e) * hv : 0, cN = e > 0.05 ? (ey / e) * hv : 0;
    const want = g + (hEff > 1.5 && vv < 0 ? aB * clamp(vv / vzc, 0, 1) : 0) + 1.1 * (vzc - vv), aU = clamp(want, 0.1, 0.98 * aMax);
    let aE = 0.7 * (cE - vE), aN = 0.7 * (cN - vN);
    const room = Math.sqrt(Math.max(aMax * aMax - aU * aU, 0)), lim = agl > 300 ? 0.9 * room : Math.min(Math.tan(24 * DEG) * Math.max(aU, 0.3), room), ah = Math.hypot(aE, aN); if (ah > lim) { aE *= lim / ah; aN *= lim / ah; }
    this.setThrustCmd(add(add(scale(eL, aE), scale(nL, aN)), scale(up, aU)));
    if (want < 0.3 * E.minThrottle * aMax && agl > 200 && ah < 0.2) this.cmdThr = 0;         // far too high or still climbing: let gravity do the work, relight on the way down
    setPhase(agl < 135 ? 'TERMINAL' : 'APPROACH');
  }
  heading(up) {                                                           // horizontal reference direction ("forward"): the planned approach track, else the direction of travel
    let f; if (this.site) { const B = this.basis(); f = add(scale(B.E, this.site.appr[0]), scale(B.N, this.site.appr[1])); } else f = this.vrel();
    f = sub(f, scale(up, dot(f, up))); return norm(f) > 1e-9 ? unit(f) : unit(cross(up, [0, 0, 1]));
  }
  followVertical(up0) {                                                   // attitude hold relative to the local horizon: the craft turns with the horizon as it moves around the Moon
    const up1 = unit(this.r), ax = cross(up0, up1), s = norm(ax); if (s < 1e-12) return; const th = Math.atan2(s, dot(up0, up1)), k = Math.sin(th / 2) / s;
    this.q = qnorm(qmul([ax[0] * k, ax[1] * k, ax[2] * k, Math.cos(th / 2)], this.q));
  }
  pointErr() { const by = qrot(this.q, [0, 1, 0]); return this.dCmd ? Math.acos(clamp(dot(by, this.dCmd), -1, 1)) : 0; }

  // ------------------------------------------------------------------ modes / inputs
  // choose a new aim point (site coordinates, m); hazard detection still vets the final footprint at ~400 m
  aim(x, y) {
    if (!this.site || !this.map || this.landed || this.phase === 'CRASHED' || this.phase === 'LANDED' || this.phase === 'TERMINAL' || this.phase === 'SEP' || this.phase === 'DOI') return false;
    const lim = this.map.half - 24; this.tgt = [clamp(x, -lim, lim), clamp(y, -lim, lim)]; this.hda = false; if (this.plan) this.plan.pred = null;
    this.say(`AIM POINT SET · ${Math.round(this.tgt[0])} E ${Math.round(this.tgt[1])} N`, 'info'); return true;
  }
  setMode(m) {
    if (m === this.mode || this.landed || this.phase === 'CRASHED') return false;
    if (m === 'MANUAL' && (this.phase === 'SEP' || this.phase === 'DOI')) return false;   // the deorbit burn is always automatic
    this.mode = m; if (m === 'MANUAL') { this.level = this.engine ? clamp(this.thr, 0, 1) : 0; this.hold = null; this.say('MANUAL CONTROL', 'am'); } else { this.hda = this.phase === 'TERMINAL' ? this.hda : false; this.say('AUTOPILOT ENGAGED', 'ok'); this.replan(); }
    return true;
  }
  setInput(i) { Object.assign(this.input, i); }                           // {pitch, roll} ∈ [-1, 1] rate commands, thr ∈ [-1, 1] throttle slew
  setThrottle(v) { if (this.mode === 'MANUAL' && !this.landed) this.level = clamp(v, 0, 1); }
  setHold(h) { if (this.mode === 'MANUAL' && !this.landed) { this.hold = h; this.input.pitch = 0; this.input.roll = 0; } }
  cutEngine() { if (this.mode === 'MANUAL') this.level = 0; }

  // ------------------------------------------------------------------ integration
  fine() { return this.engine || this.thr > 0 || this.phase === 'SEP' || this.phase === 'DOI' || this.phase === 'BRAKE' || this.phase === 'APPROACH' || this.phase === 'TERMINAL' || this.slewing || (this.plan && this.mode === 'AUTO' && this.plan.tPDI - this.t < 90) || (this.mode === 'MANUAL' && (this.rateCmd || this.level > 0 || this.input.thr > 0)); }
  stepSize(rem) {
    let h;
    if (this.fine() || this.alt() < 30e3) h = this.dt; else h = clamp((0.012 * norm(this.r)) / Math.max(norm(this.v), 1), 1, 12);
    if (this.phase === 'COAST' && this.plan && this.mode === 'AUTO') h = Math.min(h, Math.max(this.dt, this.plan.tPDI - this.t) + 1e-9);
    return Math.min(h, rem);
  }
  advance(simDt) {
    let rem = simDt + (this.pendingDt || 0), guard = 0; this.pendingDt = 0;
    while (rem > 1e-9 && guard++ < 20000) {
      if (this.landed || this.phase === 'CRASHED') { this.t += rem; this.frame(); this.rest(); rem = 0; break; }
      const h = this.stepSize(rem); this.stepOnce(h); rem -= h;
    }
    this.pendingDt = rem > 1e-9 ? Math.min(rem, 5) : 0;                  // step budget ran out: carry the rest into the next call instead of dropping it
  }
  stepOnce(h) {
    this.frame(); this.guidance(h);
    // engine: ignition at minimum throttle, first-order throttle response, flame-out when the tank is empty
    if (this.cmdThr > 0 && this.prop > 0) { if (!this.engine) { this.engine = true; this.thr = this.E.minThrottle; } this.thr += (this.cmdThr - this.thr) * (1 - Math.exp(-h / LD.TAU)); this.thr = clamp(this.thr, this.E.minThrottle, 1); }
    else { if (this.engine && this.prop <= 0 && !this.dryTold) { this.dryTold = true; this.say('PROPELLANT DEPLETED', 'bad'); } this.engine = false; this.thr = 0; }
    let thrust = this.thr * this.E.tMax;
    if (thrust > 0) { const dm0 = (thrust / (this.E.isp * G0)) * h; if (dm0 > this.prop) thrust *= this.prop / dm0; }   // tank runs dry mid-step: thrust only for the propellant left
    const by = qrot(this.q, [0, 1, 0]), aT = scale(by, thrust / this.mass), up0 = unit(this.r);
    [this.r, this.v] = rk4(this.r, this.v, aT, h);
    if (this.mode === 'MANUAL' && !this.rateCmd && !this.dCmd) this.followVertical(up0);
    if (thrust > 0) { const dm = (thrust / (this.E.isp * G0)) * h; const m0 = this.mass; this.prop = Math.max(0, this.prop - dm); this.mass = this.dry + this.prop; this.dvUsed += this.E.isp * G0 * Math.log(m0 / this.mass); if (!this.warnedLow && this.prop < 0.1 * this.prop0) { this.warnedLow = true; this.say('LOW PROPELLANT', 'bad'); } }
    this.attitude(h); this.t += h;
    if (this.alt() < 6000) this.contact();
  }
  attitude(h) {
    if (h > 0.5) { if (this.dCmd) this.q = qFromY(this.dCmd, unit(this.v)); this.w = [0, 0, 0]; this.slewing = false; return; }       // coarse coast step: snap to the commanded pointing (an RCS slew takes seconds, the coast an hour)
    const by = qrot(this.q, [0, 1, 0]), amax = this.E.rcsTorque / (this.mass * this.G.ik); let wDes = [0, 0, 0];
    if (this.mode === 'MANUAL' && this.rateCmd) { const up = unit(this.r), f = this.heading(up); wDes = add(scale(cross(up, f), this.input.pitch * LD.W_MAN), scale(f, this.input.roll * LD.W_MAN)); this.slewing = true; }
    else if (this.dCmd) {
      const ax = cross(by, this.dCmd), s = norm(ax), ang = Math.atan2(s, dot(by, this.dCmd)), mag = Math.min(LD.W_MAX, Math.sqrt(1.4 * amax * ang), 2.5 * ang);
      wDes = s > 1e-9 ? scale(ax, mag / s) : [0, 0, 0]; this.slewing = ang > 0.5 * DEG || norm(this.w) > 0.01;
    } else this.slewing = norm(this.w) > 0.01;
    let al = scale(sub(wDes, this.w), 3.0); const an = norm(al); if (an > amax) al = scale(al, amax / an);
    this.w = add(this.w, scale(al, h));
    const dq = qmul([this.w[0] * 0.5 * h, this.w[1] * 0.5 * h, this.w[2] * 0.5 * h, 0], this.q); this.q = qnorm([this.q[0] + dq[0], this.q[1] + dq[1], this.q[2] + dq[2], this.q[3] + dq[3]]);
  }

  // ------------------------------------------------------------------ contact, touchdown, rest
  contact() {
    if (!this.site) { if (norm(this.r) - R_MOON < this.G.cgh) this.crash(`Impact before a landing site was established (${(norm(this.vrel())).toFixed(0)} m/s)`); return; }
    if (!this.nearSite()) {                                                // beyond the site's map projection the Moon is a smooth sphere
      let hmin = 1e9; for (const f of this.feet()) hmin = Math.min(hmin, norm(f) - R_MOON);
      this.agl = norm(this.r) - R_MOON - this.G.cgh; this.hFoot = hmin; if (hmin <= 0) this.touchdown(null); return;
    }
    const l = this.local(this.r);
    this.agl = l.h - this.terrain.ground(l.x, l.y) - this.G.cgh;
    let hmin = 1e9; const F = this.F;
    for (const f of this.feet()) { const fl = this.local(f, F); hmin = Math.min(hmin, fl.h - this.terrain.ground(fl.x, fl.y)); }
    this.hFoot = hmin; if (hmin <= 0) this.touchdown(l);
  }
  touchdown(l) {                                                          // l: site coordinates of the craft, or null where the site map does not reach
    const vr = this.vrel(), up = unit(this.r), vv = dot(vr, up), vh = norm(sub(vr, scale(up, vv))), B = this.basis();
    const flat = !l || Math.max(Math.abs(l.x), Math.abs(l.y)) > this.terrain.half, nl = flat ? null : this.terrain.normal(l.x, l.y, this.G.foot);   // past the modelled patch the ground is the bare sphere
    const n = flat ? up : unit(add(add(scale(B.E, nl[0]), scale(B.N, nl[1])), scale(B.U, nl[2]))), by = qrot(this.q, [0, 1, 0]);
    const tilt = Math.acos(clamp(dot(by, n), -1, 1)) / DEG, slope = Math.acos(clamp(dot(n, up), -1, 1)) / DEG, down = -vv, miss = l ? Math.hypot(l.x - this.tgt[0], l.y - this.tgt[1]) : undefined;
    const m = { vv: down, vh, tilt, slope, miss, x: l ? l.x : undefined, y: l ? l.y : undefined, propLeft: this.prop, mass: this.mass, hda: this.hda, t: this.t, dvUsed: this.dvUsed };
    const bad = [];
    if (down > LD.LIM.vv) bad.push(`vertical speed ${down.toFixed(1)} m/s (limit ${LD.LIM.vv})`); if (vh > LD.LIM.vh) bad.push(`horizontal speed ${vh.toFixed(1)} m/s (limit ${LD.LIM.vh})`);
    if (tilt > LD.LIM.tilt) bad.push(`tilt ${tilt.toFixed(0)}° from the surface normal (limit ${LD.LIM.tilt}°)`); if (slope > LD.LIM.slope) bad.push(`${slope.toFixed(0)}° slope (limit ${LD.LIM.slope}°)`);
    // settle: align the body with the ground plane, centre of gravity one leg-length above it
    const cgPos = l ? add(this.inertialAt(l.x, l.y, this.terrain.ground(l.x, l.y)), scale(n, this.G.cgh)) : scale(up, R_MOON + this.G.cgh), xRef = qrot(this.q, [1, 0, 0]);
    this.pose = { pMF: this.toMF(cgPos), nMF: this.toMF(n), xMF: this.toMF(xRef), x: m.x, y: m.y };
    this.engine = false; this.thr = 0; this.cmdThr = 0; this.w = [0, 0, 0];
    if (bad.length) { m.destroyed = true; this.landing = m; this.reason = 'LANDER DESTROYED ON IMPACT — ' + bad.join('; '); this.phase = 'CRASHED'; this.say('IMPACT', 'bad'); }
    else {
      const hard = down > 3.0 || vh > 1.5 || tilt > 12;
      m.hard = hard; m.score = Math.round(clamp(100 - 8 * Math.max(0, down - 0.7) - 18 * Math.max(0, vh - 0.2) - 1.8 * Math.max(0, tilt - 2) - 1.5 * Math.max(0, slope - 5) - Math.min(15, 0.05 * Math.max(0, (miss ?? 1e9) - 30)) + 10 * (this.prop / this.prop0), 0, 100));
      m.rating = hard ? 'HARD LANDING' : m.score >= 90 ? 'PERFECT' : m.score >= 75 ? 'EXCELLENT' : m.score >= 55 ? 'GOOD' : 'ROUGH';
      this.landing = m; this.landed = true; this.phase = 'LANDED'; this.say(hard ? `HARD LANDING · ${down.toFixed(1)} m/s` : `TOUCHDOWN · ${down.toFixed(2)} m/s · ${m.rating}`, hard ? 'am' : 'ok');
    }
    this.rest();
  }
  crash(why) { this.engine = false; this.thr = 0; this.phase = 'CRASHED'; this.reason = this.reason || `LANDER DESTROYED — ${why}`; this.landing = this.landing || { destroyed: true, vv: -dot(this.vrel(), unit(this.r)), vh: 0 }; this.say('IMPACT', 'bad'); this.pose = { pMF: this.toMF(this.r), nMF: this.toMF(unit(this.r)), xMF: this.toMF(unit(this.v)) }; this.rest(); }
  rest() {                                                                // after touchdown the lander is fixed to the rotating surface
    if (!this.pose) return; const F = this.F, P0 = this.pose;
    this.r = this.fromMF(P0.pMF, F); this.v = cross(this.W, this.r); this.w = [0, 0, 0];
    this.q = qFromY(this.fromMF(P0.nMF, F), this.fromMF(P0.xMF, F));
  }

  // ------------------------------------------------------------------ outputs
  eci() { const rm = this.eph.moonAt(this.t), vm = this.eph.moonVelAt(this.t); return { r: add(rm, this.r), v: add(vm, this.v), a: qrot(this.q, [0, 1, 0]), t: this.t }; }
  maxWarp() {
    if (this.phase === 'COAST' && this.plan && this.mode === 'AUTO') { const left = this.plan.tPDI - this.t; return left < 90 ? 1 : left < 300 ? 10 : left < 1200 ? 50 : left < 2400 ? 100 : 500; }
    if (this.phase === 'COAST') { const left = this.plan ? this.plan.tPDI - this.t : 1e9; return left > 1200 ? 100 : left > 300 ? 50 : left > 90 ? 10 : left > -30 ? 1 : 10; }   // by hand: slow down for the ignition point as the autopilot does
    return this.landed ? 5 : 1;
  }
  telemetry() {
    const vr = this.vrel(), up = unit(this.r), vv = dot(vr, up), vh = norm(sub(vr, scale(up, vv))), by = qrot(this.q, [0, 1, 0]), g = MU_M / norm(this.r) ** 2, out = {
      phase: this.phase, mode: this.mode, alt: this.alt(), agl: this.site && this.alt() < 6000 ? this.agl : null, vv, vh, speed: norm(vr), prop: this.prop, propPct: this.prop / this.prop0, mass: this.mass, thr: this.thr, level: this.level,
      tiltF: 0, tiltR: 0, twr: (this.thr * this.E.tMax) / (this.mass * g), pitch: Math.asin(clamp(dot(by, up), -1, 1)) / DEG, dv: this.dvLeft(), engine: this.engine, w: norm(this.w), hold: this.hold,
      toPDI: this.plan && this.phase === 'COAST' ? this.plan.tPDI - this.t : null, peri: this.periAlt(), site: this.site ? this.site.label : null, hazard: null, range: null, x: 0, y: 0,
    };
    { const f = this.heading(up), rt = cross(f, up); out.tiltF = Math.asin(clamp(dot(by, f), -1, 1)) / DEG; out.tiltR = Math.asin(clamp(dot(by, rt), -1, 1)) / DEG; }
    if (this.site && this.alt() < 40e3) { const l = this.local(this.r); out.x = l.x; out.y = l.y; out.range = Math.hypot(this.tgt[0] - l.x, this.tgt[1] - l.y); if (this.map && this.map.inside(l.x, l.y)) { const k = this.map.idx(l.x, l.y); out.hazard = this.map.hzFoot[k]; } }
    return out;
  }
  save() { const o = { ...this }; delete o.eph; delete o.terrain; delete o.map; delete o.F; delete o.W; return structuredClone({ ...o, events: [] }); }
  static restore(eph, data, from) { const c = Object.create(LanderSim.prototype); Object.assign(c, structuredClone(data)); c.eph = eph; c.terrain = from.terrain; c.map = from.map; c.targets = from.targets; c.site = from.site || c.site; c.events = []; c.frame(); return c; }
}
