// Moon ephemeris for the lander, built on the app's own analytic Moon series (world/ephemeris.ts).
// Frame: geocentric J2000 ecliptic, so +Z is the ecliptic north pole. The Moon is treated as
// tidally locked with its spin axis along ecliptic north (mean libration ignored).

import { moonGeocentricPosition } from '../world/ephemeris';
import { cross, dot, unit, type MoonEphemeris, type V3 } from './core';

const ECLIPTIC_NORTH: V3 = [0, 0, 1];

export function createMoonEphemeris(epochJd: number): MoonEphemeris {
  const moonAt = (t: number): V3 => moonGeocentricPosition(epochJd + t / 86400);

  const moonVelAt = (t: number): V3 => {
    const h = 30;
    const a = moonAt(t - h), b = moonAt(t + h);
    return [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)];
  };

  const moonFrame = (t: number): { x: V3; y: V3; z: V3 } => {
    const mp = moonAt(t), n = ECLIPTIC_NORTH;
    const x = unit([-mp[0], -mp[1], -mp[2]]);
    const d = dot(n, x);
    const y = unit([n[0] - x[0] * d, n[1] - x[1] * d, n[2] - x[2] * d]);
    return { x, y, z: cross(x, y) };
  };

  // omega = 1/2 * sum(e_i x de_i/dt), cached per whole second.
  let spinKey = Number.NaN;
  let spin: V3 = [0, 0, 0];
  const moonSpin = (t: number): V3 => {
    const k = Math.floor(t);
    if (k === spinKey) return spin;
    const h = 40;
    const a = moonFrame(k - h), b = moonFrame(k + h), c = moonFrame(k);
    let w: V3 = [0, 0, 0];
    for (const ax of ['x', 'y', 'z'] as const) {
      const e = c[ax];
      const de: V3 = [(b[ax][0] - a[ax][0]) / (2 * h), (b[ax][1] - a[ax][1]) / (2 * h), (b[ax][2] - a[ax][2]) / (2 * h)];
      const q = cross(e, de);
      w = [w[0] + q[0] / 2, w[1] + q[1] / 2, w[2] + q[2] / 2];
    }
    spinKey = k;
    spin = w;
    return w;
  };

  return { moonAt, moonVelAt, moonFrame, moonSpin };
}
