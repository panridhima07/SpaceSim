// Gravity: central body, oblateness (zonal harmonics J2-J4) and third bodies.

import { J2, J3, J4, MU_EARTH, MU_MOON, MU_SUN, RE } from '../constants.ts';
import { norm, type Vec3 } from '../math/vec.ts';

const RE2 = RE * RE;
const RE3 = RE ** 3;
const RE4 = RE ** 4;

export interface GravityOptions {
  /** Earth oblateness. The dominant perturbation in low orbit: it turns the orbit plane. */
  j2?: boolean;
  /** Pear shape and higher flattening terms, about 1000 times smaller than J2. */
  j3j4?: boolean;
  /** Tidal pull of the Sun. */
  sun?: boolean;
  /** Tidal pull of the Moon. Also what captures or deflects a lunar transfer. */
  moon?: boolean;
}

/** Positions of perturbing bodies, Earth-centred, m. */
export interface ThirdBodies {
  sun?: Vec3;
  moon?: Vec3;
}

/** Gravitational potential of the oblate Earth, J/kg (positive convention U = mu/r ...). */
export function earthPotential(r: Vec3, opts: GravityOptions = {}): number {
  const rm = norm(r);
  const s = r[2] / rm; // sine of geocentric latitude
  const q = RE / rm;
  let sum = 0;
  if (opts.j2 ?? true) sum += J2 * q ** 2 * 0.5 * (3 * s * s - 1);
  if (opts.j3j4 ?? true) {
    sum += J3 * q ** 3 * 0.5 * (5 * s ** 3 - 3 * s);
    sum += J4 * q ** 4 * 0.125 * (35 * s ** 4 - 30 * s * s + 3);
  }
  return (MU_EARTH / rm) * (1 - sum);
}

/** Acceleration from the Earth's gravity field at r (ECI or ECEF: zonals are symmetric about Z). */
export function earthGravity(r: Vec3, opts: GravityOptions = {}): Vec3 {
  const out: Vec3 = [0, 0, 0];
  gravityInto(out, r[0], r[1], r[2], opts);
  return out;
}

/**
 * Perturbing acceleration on a spacecraft at r from a body of parameter mu at rb, both
 * measured from the Earth's centre. The second term is the body's pull on the Earth
 * itself: the frame is centred on a falling Earth, so only the difference is felt.
 */
export function thirdBodyAccel(r: Vec3, rb: Vec3, mu: number): Vec3 {
  const out: Vec3 = [0, 0, 0];
  addThirdBody(out, r[0], r[1], r[2], rb, mu);
  return out;
}

function addThirdBody(out: Vec3, x: number, y: number, z: number, rb: Vec3, mu: number): void {
  const dx = rb[0] - x;
  const dy = rb[1] - y;
  const dz = rb[2] - z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const d3 = d2 * Math.sqrt(d2);
  const b2 = rb[0] * rb[0] + rb[1] * rb[1] + rb[2] * rb[2];
  const b3 = b2 * Math.sqrt(b2);
  out[0] += mu * (dx / d3 - rb[0] / b3);
  out[1] += mu * (dy / d3 - rb[1] / b3);
  out[2] += mu * (dz / d3 - rb[2] / b3);
}

/** Total gravitational acceleration at ECI position r. */
export function gravityAccel(r: Vec3, opts: GravityOptions = {}, bodies: ThirdBodies = {}): Vec3 {
  const out: Vec3 = [0, 0, 0];
  gravityInto(out, r[0], r[1], r[2], opts, bodies.sun, bodies.moon);
  return out;
}

/**
 * The same as gravityAccel, written into `out` with nothing allocated. This is the form
 * the integrators call, several times per step.
 */
export function gravityInto(out: Vec3, x: number, y: number, z: number, opts: GravityOptions = {}, sun?: Vec3, moon?: Vec3): void {
  const r2 = x * x + y * y + z * z;
  const rm = Math.sqrt(r2);
  const k = -MU_EARTH / (r2 * rm);
  let ax = k * x;
  let ay = k * y;
  let az = k * z;
  const zr2 = (z * z) / r2;
  if (opts.j2 ?? true) {
    const f = (1.5 * J2 * RE2) / r2;
    ax += k * x * f * (1 - 5 * zr2);
    ay += k * y * f * (1 - 5 * zr2);
    az += k * z * f * (3 - 5 * zr2);
  }
  if (opts.j3j4 ?? true) {
    const r7 = r2 * r2 * r2 * rm;
    const c3 = (-5 * J3 * MU_EARTH * RE3) / (2 * r7);
    const z3 = (7 * z * z * z) / r2;
    ax += c3 * x * (3 * z - z3);
    ay += c3 * y * (3 * z - z3);
    az += c3 * (6 * z * z - z3 * z - (3 / 5) * r2);
    const c4 = (15 * J4 * MU_EARTH * RE4) / (8 * r7);
    const p4 = 1 - 14 * zr2 + 21 * zr2 * zr2;
    ax += c4 * x * p4;
    ay += c4 * y * p4;
    az += c4 * z * (5 - (70 / 3) * zr2 + 21 * zr2 * zr2);
  }
  out[0] = ax;
  out[1] = ay;
  out[2] = az;
  if (sun && (opts.sun ?? true)) addThirdBody(out, x, y, z, sun, MU_SUN);
  if (moon && (opts.moon ?? true)) addThirdBody(out, x, y, z, moon, MU_MOON);
}
