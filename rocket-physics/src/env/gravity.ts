// Gravity: central body, oblateness (zonal harmonics J2-J4) and third bodies.

import { J2, J3, J4, MU_EARTH, MU_MOON, MU_SUN, RE } from '../constants.ts';
import { add, norm, sub, type Vec3 } from '../math/vec.ts';

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
  const [x, y, z] = r;
  const r2 = x * x + y * y + z * z;
  const rm = Math.sqrt(r2);
  const k = -MU_EARTH / (r2 * rm);
  let ax = k * x;
  let ay = k * y;
  let az = k * z;
  const zr2 = (z * z) / r2;
  if (opts.j2 ?? true) {
    const f = 1.5 * J2 * (RE * RE) / r2;
    ax += k * x * f * (1 - 5 * zr2);
    ay += k * y * f * (1 - 5 * zr2);
    az += k * z * f * (3 - 5 * zr2);
  }
  if (opts.j3j4 ?? true) {
    const r7 = r2 * r2 * r2 * rm;
    const c3 = (-5 * J3 * MU_EARTH * RE ** 3) / (2 * r7);
    ax += c3 * x * (3 * z - (7 * z * z * z) / r2);
    ay += c3 * y * (3 * z - (7 * z * z * z) / r2);
    az += c3 * (6 * z * z - (7 * z ** 4) / r2 - (3 / 5) * r2);
    const c4 = (15 * J4 * MU_EARTH * RE ** 4) / (8 * r7);
    ax += c4 * x * (1 - 14 * zr2 + 21 * zr2 * zr2);
    ay += c4 * y * (1 - 14 * zr2 + 21 * zr2 * zr2);
    az += c4 * z * (5 - (70 / 3) * zr2 + 21 * zr2 * zr2);
  }
  return [ax, ay, az];
}

/**
 * Perturbing acceleration on a spacecraft at r from a body of parameter mu at rb, both
 * measured from the Earth's centre. The second term is the body's pull on the Earth
 * itself: the frame is centred on a falling Earth, so only the difference is felt.
 */
export function thirdBodyAccel(r: Vec3, rb: Vec3, mu: number): Vec3 {
  const d = sub(rb, r);
  const d3 = norm(d) ** 3;
  const b3 = norm(rb) ** 3;
  return [mu * (d[0] / d3 - rb[0] / b3), mu * (d[1] / d3 - rb[1] / b3), mu * (d[2] / d3 - rb[2] / b3)];
}

/** Total gravitational acceleration at ECI position r. */
export function gravityAccel(r: Vec3, opts: GravityOptions = {}, bodies: ThirdBodies = {}): Vec3 {
  let a = earthGravity(r, opts);
  if (bodies.sun && (opts.sun ?? true)) a = add(a, thirdBodyAccel(r, bodies.sun, MU_SUN));
  if (bodies.moon && (opts.moon ?? true)) a = add(a, thirdBodyAccel(r, bodies.moon, MU_MOON));
  return a;
}
