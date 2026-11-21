// Pure orbital math for the solar system and the Moon. No three.js imports.
//
// Frames
// - Heliocentric positions are in the J2000 ecliptic frame (metres).
// - bodyPositionEarthCentred() returns positions in the SIM world frame (Earth-centred,
//   non-rotating, metres). It applies ECLIPTIC_TO_WORLD.
//
// ECLIPTIC_TO_WORLD (v1 simplification): the ecliptic is rotated about the world X axis by
// -30 degrees, so the ecliptic north pole sits 60 degrees away from world +Y (the launch site's
// up). The launch site's real latitude, longitude and sidereal alignment are NOT modelled in v1;
// the sky is therefore not the true sky seen from the pad.

import type { Vec3 } from '../types';

export interface BodyDef {
  name: string;
  radius: number; // m, mean radius
  color: number;
  mu: number; // m^3/s^2
  /** Reference body. Sun is its own reference, so it is listed as 'sun'. */
  parent: 'sun' | 'earth';
}

export const BODIES: BodyDef[] = [
  { name: 'Sun', radius: 6.957e8, color: 0xffd27a, mu: 1.32712440018e20, parent: 'sun' },
  { name: 'Mercury', radius: 2.4397e6, color: 0xb0aca6, mu: 2.2032e13, parent: 'sun' },
  { name: 'Venus', radius: 6.0518e6, color: 0xe8cda2, mu: 3.24859e14, parent: 'sun' },
  { name: 'Earth', radius: 6.371e6, color: 0x3a7bd5, mu: 3.986004418e14, parent: 'sun' },
  { name: 'Mars', radius: 3.3895e6, color: 0xc1440e, mu: 4.282837e13, parent: 'sun' },
  { name: 'Jupiter', radius: 6.9911e7, color: 0xd8ca9d, mu: 1.26686534e17, parent: 'sun' },
  { name: 'Saturn', radius: 5.8232e7, color: 0xead6a0, mu: 3.7931187e16, parent: 'sun' },
  { name: 'Uranus', radius: 2.5362e7, color: 0xa6e8f0, mu: 5.793939e15, parent: 'sun' },
  { name: 'Neptune', radius: 2.4622e7, color: 0x4b70dd, mu: 6.836529e15, parent: 'sun' },
  { name: 'Moon', radius: 1.7374e6, color: 0xcfcfcf, mu: 4.9028e12, parent: 'earth' },
];

export const AU = 149_597_870_700; // m
const J2000 = 2451545.0;
const DEG = Math.PI / 180;

const ANGLE_ECL = -Math.PI / 6; // -30 degrees about X
const C_ECL = Math.cos(ANGLE_ECL);
const S_ECL = Math.sin(ANGLE_ECL);
/** world = ECLIPTIC_TO_WORLD * ecliptic. Row-major 3x3. */
export const ECLIPTIC_TO_WORLD: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]] = [
  [1, 0, 0],
  [0, C_ECL, -S_ECL],
  [0, S_ECL, C_ECL],
];

export function eclipticToWorld(v: Vec3): Vec3 {
  const m = ECLIPTIC_TO_WORLD;
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Julian Date (UT approximation) of a JS Date. */
export function julianDate(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

// JPL "Approximate Positions of the Planets" (Standish), valid 1800-2050.
// Columns: a (AU), a rate (AU/cy), e, e rate, I (deg), I rate, L (deg), L rate (deg/cy),
// longitude of perihelion varpi (deg), varpi rate, longitude of node Omega (deg), Omega rate.
// Earth uses the Earth-Moon barycentre elements.
type ElemRow = [number, number, number, number, number, number, number, number, number, number, number, number];

const ELEMENTS: Record<string, ElemRow> = {
  Mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.2503235, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  Venus: [0.72333566, 0.0000039, 0.00677672, -0.00004107, 3.39467605, -0.0007889, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
  Earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
  Mars: [1.52371034, 0.00001847, 0.0933941, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
  Jupiter: [5.202887, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
  Saturn: [9.53667594, -0.0012506, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
  Uranus: [19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.9542763, 0.40805281, 74.01692503, 0.04240589],
  Neptune: [30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664],
};

/** Wrap degrees into [-180, 180). */
function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** Heliocentric orbital elements at jd, angles in radians, a in AU. */
function elementsAt(name: string, jd: number): { a: number; e: number; I: number; Omega: number; varpi: number; M: number } {
  const row = ELEMENTS[name];
  if (!row) throw new Error(`No orbital elements for body "${name}"`);
  const T = (jd - J2000) / 36525;
  const a = row[0] + row[1] * T;
  const e = row[2] + row[3] * T;
  const I = (row[4] + row[5] * T) * DEG;
  const L = row[6] + row[7] * T;
  const varpi = row[8] + row[9] * T;
  const Omega = (row[10] + row[11] * T) * DEG;
  // Mean anomaly M = L - varpi, reduced to [-pi, pi).
  const M = wrap180(L - varpi) * DEG;
  return { a, e, I, Omega, varpi: varpi * DEG, M };
}

/** Solve Kepler's equation E - e sin E = M by Newton iteration. */
function solveKepler(M: number, e: number): number {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 60; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

/** Ecliptic position (AU) for eccentric anomaly E. */
function ellipsePointAU(el: { a: number; e: number; I: number; Omega: number; varpi: number }, E: number): Vec3 {
  const { a, e, I, Omega, varpi } = el;
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const w = varpi - Omega; // argument of perihelion
  const cw = Math.cos(w), sw = Math.sin(w);
  const cO = Math.cos(Omega), sO = Math.sin(Omega);
  const cI = Math.cos(I), sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}

function heliocentricAU(name: string, jd: number): Vec3 {
  const el = elementsAt(name, jd);
  const E = solveKepler(el.M, el.e);
  return ellipsePointAU(el, E);
}

/**
 * Heliocentric position in metres, J2000 ecliptic frame.
 * Supports the planets, 'Earth' (EM barycentre elements), 'Sun' (origin) and 'Moon'
 * (Earth's heliocentric position plus the geocentric Moon).
 */
export function heliocentricPosition(name: string, jd: number): Vec3 {
  if (name === 'Sun') return [0, 0, 0];
  if (name === 'Moon') {
    const e = heliocentricAU('Earth', jd).map((v) => v * AU) as Vec3;
    const m = moonGeocentricPosition(jd);
    return [e[0] + m[0], e[1] + m[1], e[2] + m[2]];
  }
  const p = heliocentricAU(name, jd);
  return [p[0] * AU, p[1] * AU, p[2] * AU];
}

/**
 * Samples of a body's heliocentric orbit at jd, in metres, ecliptic frame.
 * Uses equally spaced eccentric anomalies; returns n points on one revolution (not closed).
 */
export function heliocentricOrbitSamples(name: string, jd: number, n: number): Vec3[] {
  const el = elementsAt(name, jd);
  const out: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const p = ellipsePointAU(el, (2 * Math.PI * k) / n);
    out.push([p[0] * AU, p[1] * AU, p[2] * AU]);
  }
  return out;
}

// Low-precision lunar theory (Meeus, Astronomical Algorithms ch. 47, main terms only).
// Accuracy about 0.1 to 0.5 degrees in longitude, adequate for v1.
// Longitude/distance terms: [D, M, M', F, sin-coef (1e-6 deg) or cos-coef (1e-3 km)].
const LUNAR_LR: [number, number, number, number, number, number][] = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
];
// Latitude terms: [D, M, M', F, sin-coef (1e-6 deg)].
const LUNAR_B: [number, number, number, number, number][] = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
];

/** Geocentric Moon position, metres, ecliptic frame (ecliptic of date approximated as J2000). */
export function moonGeocentricPosition(jd: number): Vec3 {
  const T = (jd - J2000) / 36525;
  const norm = (d: number) => ((d % 360) + 360) % 360;
  const Lp = norm(218.3164477 + 481267.88123421 * T);
  const D = norm(297.8501921 + 445267.1114034 * T);
  const M = norm(357.5291092 + 35999.0502909 * T);
  const Mp = norm(134.9633964 + 477198.8675055 * T);
  const F = norm(93.272095 + 483202.0175233 * T);
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const eFactor = (m: number) => {
    const a = Math.abs(m);
    return a === 1 ? E : a === 2 ? E * E : 1;
  };

  let sl = 0;
  let sr = 0;
  for (const [d, m, mp, f, l, r] of LUNAR_LR) {
    const arg = (d * D + m * M + mp * Mp + f * F) * DEG;
    const k = eFactor(m);
    sl += k * l * Math.sin(arg);
    sr += k * r * Math.cos(arg);
  }
  let sb = 0;
  for (const [d, m, mp, f, b] of LUNAR_B) {
    const arg = (d * D + m * M + mp * Mp + f * F) * DEG;
    sb += eFactor(m) * b * Math.sin(arg);
  }

  const lon = (Lp + sl / 1e6) * DEG;
  const lat = (sb / 1e6) * DEG;
  const distM = (385000.56 + sr / 1000) * 1000;
  const cb = Math.cos(lat);
  return [
    distM * cb * Math.cos(lon),
    distM * cb * Math.sin(lon),
    distM * Math.sin(lat),
  ];
}

/**
 * Position of a body relative to Earth's centre, metres, in the SIM world frame
 * (see ECLIPTIC_TO_WORLD). Earth returns [0,0,0].
 */
export function bodyPositionEarthCentred(name: string, jd: number): Vec3 {
  if (name === 'Earth') return [0, 0, 0];
  if (name === 'Moon') return eclipticToWorld(moonGeocentricPosition(jd));
  const earth = heliocentricPosition('Earth', jd);
  const p = heliocentricPosition(name, jd);
  return eclipticToWorld([p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]]);
}

const OBLIQUITY_RAD = 23.4392911 * DEG;

/** Greenwich Mean Sidereal Time (rad) from Julian Date (IAU 1982). */
export function gmstFromJd(jd: number): number {
  const d = jd - J2000;
  const gmstDeg = 280.46061837 + 360.98564736629 * d;
  const rad = (gmstDeg % 360) * DEG;
  return rad < 0 ? rad + 2 * Math.PI : rad;
}

/**
 * Transform a J2000 ecliptic vector into the launch-site world frame
 * (+X east, +Y zenith/up, +Z south) for a given latitude, longitude and GMST.
 */
export function eclipticToSiteWorld(
  v: Vec3,
  latDeg: number,
  lonDeg: number,
  gmstRad: number,
): Vec3 {
  // 1. Ecliptic -> Equatorial (rotate about +X by obliquity)
  const ce = Math.cos(OBLIQUITY_RAD);
  const se = Math.sin(OBLIQUITY_RAD);
  const xEq = v[0];
  const yEq = v[1] * ce - v[2] * se;
  const zEq = v[1] * se + v[2] * ce;

  // 2. Equatorial -> ECEF (rotate about +Z by -gmstRad)
  const cg = Math.cos(gmstRad);
  const sg = Math.sin(gmstRad);
  const xEf = xEq * cg + yEq * sg;
  const yEf = -xEq * sg + yEq * cg;
  const zEf = zEq;

  // 3. ECEF -> Site frame (+X east, +Y up, +Z south)
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sLat = Math.sin(lat);
  const cLat = Math.cos(lat);
  const sLon = Math.sin(lon);
  const cLon = Math.cos(lon);

  const east = -sLon * xEf + cLon * yEf;
  const up = cLat * cLon * xEf + cLat * sLon * yEf + sLat * zEf;
  const south = sLat * cLon * xEf + sLat * sLon * yEf - cLat * zEf;
  return [east, up, south];
}
