// Shared constants and small vector maths for the lunar landing modules (terrain, route planner,
// lander). Pure TypeScript, no three.js and no DOM. Vectors are plain [x, y, z] arrays in metres
// and m/s.

export type V3 = number[];

export const G0 = 9.80665;
export const MU_M = 4.9048695e12; // Moon GM, m^3/s^2
export const R_MOON = 1737400; // m

/** Throttleable, restartable descent engine carried by the lander. N, fraction, s, N m. */
export const LANDER_ENGINE = { tMax: 26e3, minThrottle: 0.2, isp: 311, rcsTorque: 4e3 };

/** Lander mass budget (kg). `payloadMass` is the whole lander at separation, propellant included. */
export interface LanderSpec {
  payloadMass: number;
  landerProp: number;
  hasRover?: boolean;
  /** Descent engine; LANDER_ENGINE when omitted. */
  engine?: { tMax: number; minThrottle: number; isp: number; rcsTorque: number };
  /** Centre-of-gravity height above the feet and foot-circle radius (m), inertia per kg (m^2). */
  geom?: { cgh: number; foot: number; inertiaPerKg: number };
  /** Fraction of full thrust the braking phase is planned at (0.7 when omitted); the rest is margin. */
  brakeFrac?: number;
  /** Perilune altitude the deorbit burn aims for, m. */
  doiPeri?: number;
}
export const LANDER_SPECS: Record<'lander' | 'roverLander', LanderSpec> = {
  lander: { payloadMass: 7600, landerProp: 4300, hasRover: false },
  roverLander: { payloadMass: 10400, landerProp: 6000, hasRover: true },
};

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const unit = (a: V3): V3 => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Small deterministic PRNG: same seed, same sequence of numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Classical orbital elements from a state vector. Lengths in metres from the body centre. */
export function elements(r: V3, v: V3, mu: number, pole: V3 = [0, 0, 1]) {
  const rr = norm(r), vv = norm(v);
  const h = cross(r, v), hn = norm(h);
  const eps = (vv * vv) / 2 - mu / rr;
  const ev = sub(scale(r, (vv * vv) / mu - 1 / rr), scale(v, dot(r, v) / mu));
  const e = norm(ev);
  const a = Math.abs(eps) < 1e-12 ? Infinity : -mu / (2 * eps);
  const rp = a * (1 - e), ra = eps < 0 ? a * (1 + e) : Infinity;
  const incl = Math.acos(clamp(dot(h, pole) / hn, -1, 1));
  return { a, e, rp, ra, incl, h: hn, eps, period: eps < 0 ? 2 * Math.PI * Math.sqrt(a ** 3 / mu) : Infinity, escape: eps >= 0 };
}

/** What the lander needs to know about the Moon. `t` is seconds since the ephemeris epoch. */
export interface MoonEphemeris {
  /** Geocentric Moon position (m) in an inertial frame. */
  moonAt(t: number): V3;
  /** Geocentric Moon velocity (m/s) in the same frame. */
  moonVelAt(t: number): V3;
  /** Moon-fixed axes in that frame: x to the sub-Earth point, y north, z = x cross y. */
  moonFrame(t: number): { x: V3; y: V3; z: V3 };
  /** Angular velocity of the Moon-fixed axes (rad/s). */
  moonSpin(t: number): V3;
}
