import { P0, R_GAS } from '../constants.ts';

export interface Fluid {
  name: string;
  density: number;        // liquid, kg/m^3
  boilingPoint: number;   // at 101325 Pa, K
  latentHeat: number;     // J/kg
  molarMass: number;      // kg/mol
  storageTemp: number;    // temperature it is loaded at, K
}

export const FLUIDS = {
  LOX:  { name: 'LOX',  density: 1141,  boilingPoint: 90.19, latentHeat: 213e3, molarMass: 0.031999, storageTemp: 90.19 },
  LH2:  { name: 'LH2',  density: 70.85, boilingPoint: 20.28, latentHeat: 446e3, molarMass: 0.002016, storageTemp: 20.28 },
  RP1:  { name: 'RP-1', density: 810,   boilingPoint: 490,   latentHeat: 250e3, molarMass: 0.170,    storageTemp: 300 },
  UH25: { name: 'UH25', density: 850,   boilingPoint: 336,   latentHeat: 583e3, molarMass: 0.0601,   storageTemp: 303 },
  N2O4: { name: 'N2O4', density: 1440,  boilingPoint: 294.3, latentHeat: 414e3, molarMass: 0.09201,  storageTemp: 303 },
} as const satisfies Record<string, Fluid>;

export type FluidId = keyof typeof FLUIDS;

export function vapourPressure(f: Fluid, T: number): number {
  return P0 * Math.exp(((f.latentHeat * f.molarMass) / R_GAS) * (1 / f.boilingPoint - 1 / T));
}

export function isCryogenic(f: Fluid): boolean {
  return f.boilingPoint < 200;
}
