// Vector and quaternion helpers. Vectors are [x, y, z] tuples. Quaternions are
// [x, y, z, w] and rotate BODY vectors into the WORLD (inertial) frame.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
/** a + b * s */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
/** Unit vector; the zero vector stays zero (never NaN). */
export function unit(a: Vec3): Vec3 {
  const l = norm(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** Angle between two vectors, rad, stable near 0 and pi. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.atan2(norm(cross(a, b)), dot(a, b));
}
/** Rotate v about unit axis k by angle (Rodrigues). */
export function rotateAbout(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kxv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kxv[0] * s + k[0] * kd, v[1] * c + kxv[1] * s + k[1] * kd, v[2] * c + kxv[2] * s + k[2] * kd];
}
/** Rotate about the +Z axis by angle. */
export function rotZ(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}
/** Move unit vector `from` toward unit vector `to` by at most maxAngle rad. */
export function slerpToward(from: Vec3, to: Vec3, maxAngle: number): Vec3 {
  const ang = angleBetween(from, to);
  if (ang <= maxAngle) return to;
  let axis = cross(from, to);
  if (norm(axis) < 1e-12) {
    // Antiparallel: any perpendicular axis will do.
    axis = cross(from, Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  }
  return unit(rotateAbout(from, unit(axis), maxAngle));
}

// ---- quaternions -----------------------------------------------------------

/** Hamilton product a * b. */
export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export function qnormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 0 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
}
/** Body -> world. */
export function qrot(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}
/** World -> body. */
export function qrotInv(q: Quat, v: Vec3): Vec3 {
  return qrot(qconj(q), v);
}
export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const k = unit(axis);
  const s = Math.sin(angle / 2);
  return [k[0] * s, k[1] * s, k[2] * s, Math.cos(angle / 2)];
}
/** Quaternion whose body axes, expressed in the world frame, are the given orthonormal x, y, z. */
export function qFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m00 = x[0], m10 = x[1], m20 = x[2];
  const m01 = y[0], m11 = y[1], m21 = y[2];
  const m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return qnormalize(q);
}
/** A quaternion pointing body +X along `dir`, with body +Z as close as possible to `zHint`. */
export function qPointing(dir: Vec3, zHint: Vec3): Quat {
  const x = unit(dir);
  let y = cross(zHint, x);
  if (norm(y) < 1e-9) y = cross(Math.abs(x[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], x);
  y = unit(y);
  return qFromBasis(x, y, cross(x, y));
}
/** dq/dt for body angular velocity w (rad/s, body frame). */
export function qderiv(q: Quat, w: Vec3): Quat {
  const [x, y, z, s] = q;
  return [
    0.5 * (s * w[0] + y * w[2] - z * w[1]),
    0.5 * (s * w[1] + z * w[0] - x * w[2]),
    0.5 * (s * w[2] + x * w[1] - y * w[0]),
    0.5 * (-x * w[0] - y * w[1] - z * w[2]),
  ];
}
