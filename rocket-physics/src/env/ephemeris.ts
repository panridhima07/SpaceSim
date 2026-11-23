// Low-precision analytic positions of the Sun and Moon, Earth-centred equatorial frame
// (the simulation's ECI frame), metres. Series from the Astronomical Almanac as given in
// Vallado (algorithms 29 and 31). Accuracy: Sun about 0.01 deg, Moon about 0.3 deg in
// longitude and a few thousand km in distance. Enough for third-body perturbations and
// for aiming a lunar transfer that a mid-course correction then cleans up.

import { AU, DEG, RE } from '../constants.ts';
import { scale, sub, type Vec3 } from '../math/vec.ts';

const centuries = (jd: number): number => (jd - 2451545.0) / 36525;

// Last answer of each series, keyed by the Julian Date it was asked for.
let sunJd = NaN;
let sunAt: Vec3 = [0, 0, 0];
let moonJd = NaN;
let moonAt: Vec3 = [0, 0, 0];

function eclipticToEquatorial(lon: number, lat: number, r: number, T: number): Vec3 {
  const eps = (23.439291 - 0.0130042 * T) * DEG;
  const cl = Math.cos(lat);
  const x = r * cl * Math.cos(lon);
  const y = r * cl * Math.sin(lon);
  const z = r * Math.sin(lat);
  return [x, y * Math.cos(eps) - z * Math.sin(eps), y * Math.sin(eps) + z * Math.cos(eps)];
}

/** Geocentric position of the Sun, m. */
export function sunPosition(jd: number): Vec3 {
  // An integrator asks for the same instant several times in a row (stage ends coincide).
  if (jd === sunJd) return [sunAt[0], sunAt[1], sunAt[2]];
  const T = centuries(jd);
  const M = (357.5291092 + 35999.05034 * T) * DEG;
  const lon = (280.46 + 36000.771 * T + 1.914666471 * Math.sin(M) + 0.019994643 * Math.sin(2 * M)) * DEG;
  const r = (1.000140612 - 0.016708617 * Math.cos(M) - 0.000139589 * Math.cos(2 * M)) * AU;
  const out = eclipticToEquatorial(lon, 0, r, T);
  sunJd = jd;
  sunAt = [out[0], out[1], out[2]];
  return out;
}

/** Geocentric position of the Moon, m. */
export function moonPosition(jd: number): Vec3 {
  if (jd === moonJd) return [moonAt[0], moonAt[1], moonAt[2]];
  const T = centuries(jd);
  const s = (deg: number): number => Math.sin(deg * DEG);
  const c = (deg: number): number => Math.cos(deg * DEG);
  const lon =
    218.32 +
    481267.8813 * T +
    6.29 * s(134.9 + 477198.85 * T) -
    1.27 * s(259.2 - 413335.38 * T) +
    0.66 * s(235.7 + 890534.23 * T) +
    0.21 * s(269.9 + 954397.7 * T) -
    0.19 * s(357.5 + 35999.05 * T) -
    0.11 * s(186.6 + 966404.05 * T);
  const lat =
    5.13 * s(93.3 + 483202.03 * T) + 0.28 * s(228.2 + 960400.87 * T) - 0.28 * s(318.3 + 6003.18 * T) - 0.17 * s(217.6 - 407332.2 * T);
  const parallax =
    0.9508 + 0.0518 * c(134.9 + 477198.85 * T) + 0.0095 * c(259.2 - 413335.38 * T) + 0.0078 * c(235.7 + 890534.23 * T) + 0.0028 * c(269.9 + 954397.7 * T);
  const r = RE / Math.sin(parallax * DEG);
  const out = eclipticToEquatorial(lon * DEG, lat * DEG, r, T);
  moonJd = jd;
  moonAt = [out[0], out[1], out[2]];
  return out;
}

/** Geocentric velocity of the Moon, m/s (central difference of the position series). */
export function moonVelocity(jd: number): Vec3 {
  const h = 30 / 86400; // 30 s
  return scale(sub(moonPosition(jd + h), moonPosition(jd - h)), 1 / 60);
}
