// Physical constants, SI units throughout.

export const G0 = 9.80665; // standard gravity, m/s^2 (defines specific impulse)
export const R_GAS = 8.314462618; // universal gas constant, J/(mol K)
export const P0 = 101325; // sea-level standard pressure, Pa

// Earth, WGS-84 and EGM96 zonal harmonics
export const MU_EARTH = 3.986004418e14; // m^3/s^2
export const RE = 6378137.0; // equatorial radius, m
export const FLATTENING = 1 / 298.257223563;
export const E2 = FLATTENING * (2 - FLATTENING); // first eccentricity squared
export const OMEGA_EARTH = 7.292115e-5; // sidereal rotation rate, rad/s
export const J2 = 1.08262668e-3;
export const J3 = -2.53265649e-6;
export const J4 = -1.61962159e-6;

// Other bodies
export const MU_SUN = 1.32712440018e20;
export const MU_MOON = 4.9028e12;
export const R_MOON = 1.7374e6;
export const AU = 149_597_870_700;
export const MOON_SOI = 6.61e7; // lunar sphere of influence radius, m
export const SOLAR_PRESSURE = 4.56e-6; // solar radiation pressure at 1 AU, N/m^2

export const DEG = Math.PI / 180;
