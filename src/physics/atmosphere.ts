// International Standard Atmosphere (ISA 1976) up to 86 km, with an
// exponential extension above that.

import type { Atmosphere, AtmosphereFn } from '../types';

const G = 9.80665;
const R_AIR = 287.053;
const GAMMA = 1.4;
const T0 = 288.15;
const P0 = 101325;
const H_TOP = 86_000;
const SCALE_HEIGHT_ABOVE = 6_000; // m, for density decay above 86 km

interface Layer {
  /** Base geopotential altitude, m. */
  h: number;
  /** Temperature lapse rate in this layer, K/m. */
  lapse: number;
}

const LAYERS: Layer[] = [
  { h: 0, lapse: -0.0065 },
  { h: 11_000, lapse: 0 },
  { h: 20_000, lapse: 0.001 },
  { h: 32_000, lapse: 0.0028 },
  { h: 47_000, lapse: 0 },
  { h: 51_000, lapse: -0.0028 },
  { h: 71_000, lapse: -0.002 },
];

interface LayerBase {
  h: number;
  lapse: number;
  /** Temperature at the layer base, K. */
  T: number;
  /** Pressure at the layer base, Pa. */
  P: number;
}

/** Precomputed base temperature and pressure of each layer. */
const BASES: LayerBase[] = (() => {
  const out: LayerBase[] = [];
  let T = T0;
  let P = P0;
  for (let i = 0; i < LAYERS.length; i++) {
    const { h, lapse } = LAYERS[i];
    out.push({ h, lapse, T, P });
    const hNext = i + 1 < LAYERS.length ? LAYERS[i + 1].h : H_TOP;
    const dh = hNext - h;
    const Tnext = T + lapse * dh;
    if (lapse === 0) {
      P = P * Math.exp((-G * dh) / (R_AIR * T));
    } else {
      P = P * Math.pow(Tnext / T, -G / (lapse * R_AIR));
    }
    T = Tnext;
  }
  return out;
})();

/** Pressure and temperature at the 86 km top of the standard model. */
const TOP_T = BASES[BASES.length - 1].T + BASES[BASES.length - 1].lapse * (H_TOP - BASES[BASES.length - 1].h);
const TOP_P = (() => {
  const last = BASES[BASES.length - 1];
  const dh = H_TOP - last.h;
  const T = last.T;
  if (last.lapse === 0) return last.P * Math.exp((-G * dh) / (R_AIR * T));
  return last.P * Math.pow(TOP_T / T, -G / (last.lapse * R_AIR));
})();
const TOP_RHO = TOP_P / (R_AIR * TOP_T);

function standardAtTop(h: number): { T: number; P: number } {
  // Find the layer containing h (h in [0, H_TOP]).
  let idx = 0;
  for (let i = BASES.length - 1; i >= 0; i--) {
    if (h >= BASES[i].h) {
      idx = i;
      break;
    }
  }
  const base = BASES[idx];
  const dh = h - base.h;
  const T = base.T + base.lapse * dh;
  let P: number;
  if (base.lapse === 0) {
    P = base.P * Math.exp((-G * dh) / (R_AIR * base.T));
  } else {
    P = base.P * Math.pow(T / base.T, -G / (base.lapse * R_AIR));
  }
  return { T, P };
}

export const atmosphere: AtmosphereFn = (altitude: number): Atmosphere => {
  const h = Number.isFinite(altitude) ? Math.max(0, altitude) : 0;

  let T: number;
  let P: number;
  let rho: number;

  if (h <= H_TOP) {
    ({ T, P } = standardAtTop(h));
    rho = P / (R_AIR * T);
  } else {
    // Above 86 km: exponential decay of density from the model top.
    T = TOP_T;
    rho = TOP_RHO * Math.exp(-(h - H_TOP) / SCALE_HEIGHT_ABOVE);
    // Pressure consistent with the decaying density at the same temperature.
    P = rho * R_AIR * T;
    if (!(rho >= 0)) rho = 0;
  }

  const soundSpeed = Math.sqrt(GAMMA * R_AIR * T);
  return {
    rho: Number.isFinite(rho) && rho > 0 ? rho : 0,
    pressure: Number.isFinite(P) && P > 0 ? P : 0,
    temperature: T,
    soundSpeed,
  };
};
