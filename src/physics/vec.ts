// Small pure vector and quaternion helpers. Quaternions are [x, y, z, w] and
// rotate body vectors into the world frame (see src/types.ts).

import type { Quat, Vec3 } from '../types';

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function len(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/** Unit vector; the zero vector maps to the zero vector (never NaN). */
export function normalize(a: Vec3): Vec3 {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
}

/** Hamilton product a * b. Applying quatMul(q, p) then rotating equals rotating by p then q. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Rotate vector v by unit quaternion q: v' = v + 2w(u x v) + 2u x (u x v). */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const w = q[3];
  const t = scale(cross(u, v), 2);
  const c = cross(u, t);
  return [
    v[0] + w * t[0] + c[0],
    v[1] + w * t[1] + c[1],
    v[2] + w * t[2] + c[2],
  ];
}

/** Rotation of `angle` radians about `axis` (need not be unit). Zero axis gives identity. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = normalize(axis);
  if (len(n) === 0) return [0, 0, 0, 1];
  const s = Math.sin(angle / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (!(n > 0)) return [0, 0, 0, 1];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/**
 * Advance orientation q (body -> world) by body angular velocity omegaBody (rad/s)
 * for dt seconds. Exact for constant omega; result is renormalised.
 * Body rates post-multiply: q_new = q * dq(omega_body, |omega| dt).
 */
export function quatIntegrate(q: Quat, omegaBody: Vec3, dt: number): Quat {
  const w = len(omegaBody);
  if (w * dt < 1e-15) return quatNormalize(q);
  const dq = quatFromAxisAngle(omegaBody, w * dt);
  return quatNormalize(quatMul(q, dq));
}
