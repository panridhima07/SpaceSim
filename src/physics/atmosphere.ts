// Atmosphere model used by the model-rocket simulator. It shares the orbital library's model
// (rocket-physics/src/env/atmosphere.ts) so both simulators agree:
//
// 0 - 86 km   : US Standard Atmosphere 1976 layer equations, evaluated in geopotential height
//               (the altitude passed in is geometric, converted with r0 = 6356766 m).
// 86 - 90 km  : log-density blend between the USSA76 value at 86 km and the table at 90 km.
// 90 - 1000 km: Vallado piecewise-exponential density table; USSA76 upper temperatures
//               (rising to about 1000 K).
// > 1000 km   : vacuum (rho = 0, pressure = 0, finite temperature and speed of sound).
//
// Mean conditions only; the real thermosphere varies by an order of magnitude with solar
// activity. Negative and non-finite altitudes are clamped to sea level.

import type { Atmosphere, AtmosphereFn } from '../types';
import { atmosphereInto, type AtmosphereState } from '../../rocket-physics/src/env/atmosphere.ts';

// Reused by every call so the hot path allocates only the returned object.
const scratch: AtmosphereState = {
  temperature: 0,
  pressure: 0,
  density: 0,
  speedOfSound: 0,
  viscosity: 0,
  meanFreePath: 0,
};

export const atmosphere: AtmosphereFn = (altitude: number): Atmosphere => {
  const z = Number.isFinite(altitude) ? Math.max(0, altitude) : 0;
  const s = atmosphereInto(scratch, z);
  return {
    rho: Number.isFinite(s.density) && s.density > 0 ? s.density : 0,
    pressure: Number.isFinite(s.pressure) && s.pressure > 0 ? s.pressure : 0,
    temperature: s.temperature,
    soundSpeed: s.speedOfSound,
  };
};
