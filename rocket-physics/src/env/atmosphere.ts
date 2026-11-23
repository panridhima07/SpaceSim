// Atmosphere model.
//
// 0 - 86 km   : US Standard Atmosphere 1976, exact layer equations in geopotential height.
// 86 - 1000 km: density from the piecewise-exponential fit to USSA76 / CIRA-72 (Vallado,
//               "Fundamentals of Astrodynamics", table 8-4); temperature from the USSA76
//               upper-atmosphere equations. Pressure follows from the ideal gas law.
// > 1000 km   : vacuum.
//
// The real upper atmosphere swings by an order of magnitude with solar activity; this is
// the mean. Good for ascent, staging and decay estimates, not for precise orbit lifetime.

const G0P = 9.80665;
const M_AIR = 0.0289644; // kg/mol
const R_STAR = 8.31432; // J/(mol K), the value USSA76 uses
const R_SPECIFIC = R_STAR / M_AIR;
const R_EARTH_GEOPOT = 6356766; // m
const GAMMA = 1.4;
const GAMMA_R = GAMMA * R_SPECIFIC;
const AVOGADRO = 6.02214076e23;
const MOLECULE_DIAMETER = 3.65e-10; // effective collision diameter of air, m
// Mean free path = MFP_K / rho  (lambda = 1 / (sqrt2 pi d^2 n), n = rho N_A / M).
const MFP_K = M_AIR / (Math.SQRT2 * Math.PI * MOLECULE_DIAMETER * MOLECULE_DIAMETER * AVOGADRO);

// Geopotential base height (m), lapse rate (K/m)
const LAYERS: ReadonlyArray<readonly [number, number]> = [
  [0, -0.0065],
  [11000, 0],
  [20000, 0.001],
  [32000, 0.0028],
  [47000, 0],
  [51000, -0.0028],
  [71000, -0.002],
  [84852, 0],
];
const BASE_T: number[] = [288.15];
const BASE_P: number[] = [101325];
for (let i = 1; i < LAYERS.length; i++) {
  const [h0, L] = LAYERS[i - 1];
  const dh = LAYERS[i][0] - h0;
  const T0 = BASE_T[i - 1];
  const T1 = T0 + L * dh;
  BASE_T.push(T1);
  BASE_P.push(
    L === 0 ? BASE_P[i - 1] * Math.exp((-G0P * dh) / (R_SPECIFIC * T0)) : BASE_P[i - 1] * Math.pow(T1 / T0, -G0P / (L * R_SPECIFIC)),
  );
}

// Per-layer constants used by the hot path.
// LAYER_EXP: exponent of the pressure power law for a gradient layer (unused when L = 0).
// LAYER_INV_RT: 1 / (R_SPECIFIC * T_base), used by the isothermal exponential (L = 0).
const LAYER_EXP: number[] = LAYERS.map(([, L]) => (L === 0 ? 0 : -G0P / (L * R_SPECIFIC)));
const LAYER_INV_RT: number[] = BASE_T.map((T) => 1 / (R_SPECIFIC * T));

// Base altitude (km), density (kg/m^3), scale height (km)
const EXPO: ReadonlyArray<readonly [number, number, number]> = [
  [90, 3.396e-6, 5.382],
  [100, 5.297e-7, 5.877],
  [110, 9.661e-8, 7.263],
  [120, 2.438e-8, 9.473],
  [130, 8.484e-9, 12.636],
  [140, 3.845e-9, 16.149],
  [150, 2.07e-9, 22.523],
  [180, 5.464e-10, 29.74],
  [200, 2.789e-10, 37.105],
  [250, 7.248e-11, 45.546],
  [300, 2.418e-11, 53.628],
  [350, 9.518e-12, 53.298],
  [400, 3.725e-12, 58.515],
  [450, 1.585e-12, 60.828],
  [500, 6.967e-13, 63.822],
  [600, 1.454e-13, 71.835],
  [700, 3.614e-14, 88.667],
  [800, 1.17e-14, 124.64],
  [900, 5.245e-15, 181.05],
  [1000, 3.019e-15, 268.0],
];
// 1 / scale height, precomputed per table row.
const EXPO_INV_H: number[] = EXPO.map((row) => 1 / row[2]);

export interface AtmosphereState {
  temperature: number; // K
  pressure: number; // Pa
  density: number; // kg/m^3
  speedOfSound: number; // m/s
  viscosity: number; // dynamic viscosity, Pa s (Sutherland)
  meanFreePath: number; // m
}

const VACUUM: AtmosphereState = {
  temperature: 1000,
  pressure: 0,
  density: 0,
  speedOfSound: 634,
  viscosity: 0,
  meanFreePath: Infinity,
};

function upperTemperature(zkm: number): number {
  if (zkm < 91) return 186.8673;
  if (zkm < 110) {
    const x = (zkm - 91) / -19.9429;
    return 263.1905 - 76.3232 * Math.sqrt(Math.max(0, 1 - x * x));
  }
  if (zkm < 120) return 240 + 12 * (zkm - 110);
  const xi = ((zkm - 120) * (6356.766 + 120)) / (6356.766 + zkm);
  return 1000 - (1000 - 360) * Math.exp(-0.01875 * xi);
}

function upperDensity(zkm: number): number {
  let i = EXPO.length - 1;
  while (i > 0 && zkm < EXPO[i][0]) i--;
  return EXPO[i][1] * Math.exp(-(zkm - EXPO[i][0]) * EXPO_INV_H[i]);
}

const RHO_86 = (() => {
  // Sea-level-style lower-atmosphere evaluation at 86 km (same as the hot path below).
  const h = (R_EARTH_GEOPOT * 86000) / (R_EARTH_GEOPOT + 86000);
  let i = LAYERS.length - 1;
  while (i > 0 && h < LAYERS[i][0]) i--;
  const L = LAYERS[i][1];
  const dh = h - LAYERS[i][0];
  const T = BASE_T[i] + L * dh;
  const p = L === 0 ? BASE_P[i] * Math.exp(-G0P * dh * LAYER_INV_RT[i]) : BASE_P[i] * Math.pow(T / BASE_T[i], LAYER_EXP[i]);
  return p / (R_SPECIFIC * T);
})();
const LOG_RHO_86 = Math.log(RHO_86);
const LOG_RHO_90 = Math.log(upperDensity(90));

/**
 * Writes the atmospheric state at geometric altitude z (m) into `out` and returns `out`.
 * Allocates nothing. Above 1000 km the VACUUM values are copied in (the shared constant
 * is never handed out here).
 */
export function atmosphereInto(out: AtmosphereState, z: number): AtmosphereState {
  if (z > 1.0e6) {
    out.temperature = VACUUM.temperature;
    out.pressure = VACUUM.pressure;
    out.density = VACUUM.density;
    out.speedOfSound = VACUUM.speedOfSound;
    out.viscosity = VACUUM.viscosity;
    out.meanFreePath = VACUUM.meanFreePath;
    return out;
  }
  let T: number;
  let rho: number;
  let p: number;
  if (z <= 86000) {
    const zc = Math.max(z, -2000);
    const h = (R_EARTH_GEOPOT * zc) / (R_EARTH_GEOPOT + zc);
    let i = LAYERS.length - 1;
    while (i > 0 && h < LAYERS[i][0]) i--;
    const L = LAYERS[i][1];
    const dh = h - LAYERS[i][0];
    T = BASE_T[i] + L * dh;
    p = L === 0 ? BASE_P[i] * Math.exp(-G0P * dh * LAYER_INV_RT[i]) : BASE_P[i] * Math.pow(T / BASE_T[i], LAYER_EXP[i]);
    rho = p / (R_SPECIFIC * T);
  } else {
    const zkm = z / 1000;
    T = upperTemperature(zkm);
    if (zkm < 90) {
      // Blend log-density between the two models so density stays continuous.
      const f = (zkm - 86) / 4;
      rho = Math.exp(LOG_RHO_86 * (1 - f) + LOG_RHO_90 * f);
    } else {
      rho = upperDensity(zkm);
    }
    p = rho * R_SPECIFIC * T;
  }
  out.temperature = T;
  out.pressure = p;
  out.density = rho;
  out.speedOfSound = Math.sqrt(GAMMA_R * T);
  out.viscosity = (1.458e-6 * T * Math.sqrt(T)) / (T + 110.4);
  out.meanFreePath = MFP_K / rho;
  return out;
}

/** Atmospheric state at geometric altitude z (m) above the ellipsoid. */
export function atmosphere(z: number): AtmosphereState {
  if (z > 1.0e6) return VACUUM;
  return atmosphereInto({ temperature: 0, pressure: 0, density: 0, speedOfSound: 0, viscosity: 0, meanFreePath: 0 }, z);
}

/** Horizontal wind, m/s, blowing TOWARD east / north. */
export type WindModel = (altitude: number, lat: number, lon: number) => { east: number; north: number };

/**
 * A simple wind profile: a surface wind that grows with a 1/7 power law through the
 * boundary layer, plus a Gaussian jet stream.
 */
export function jetStreamWind(opts: {
  surfaceSpeed?: number;
  jetSpeed?: number;
  jetAltitude?: number;
  jetThickness?: number;
  /** Direction the wind blows toward, degrees clockwise from north. */
  towardDeg?: number;
} = {}): WindModel {
  const surface = opts.surfaceSpeed ?? 5;
  const jet = opts.jetSpeed ?? 40;
  const hJet = opts.jetAltitude ?? 11000;
  const w = opts.jetThickness ?? 3500;
  const dir = ((opts.towardDeg ?? 90) * Math.PI) / 180;
  return (alt) => {
    const a = Math.max(alt, 0);
    const boundary = surface * Math.pow(Math.min(a, 1000) / 10 + 1e-9, 1 / 7) * Math.exp(-a / 30000);
    const speed = boundary + jet * Math.exp(-(((a - hJet) / w) ** 2));
    return { east: speed * Math.sin(dir), north: speed * Math.cos(dir) };
  };
}
