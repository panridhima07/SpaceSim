export interface Material {
  name: string;
  youngsModulus: number;  // Pa
  ultimate: number;       // tensile ultimate, Pa
  density: number;        // kg/m^3
  specificHeat: number;   // J/(kg K)
  warnTemp: number;       // K, strength starts to fall
  maxTemp: number;        // K, do not exceed
}

export const MATERIALS = {
  AL2219: { name: 'Aluminium 2219', youngsModulus: 73.1e9, ultimate: 440e6,  density: 2840, specificHeat: 864, warnTemp: 423, maxTemp: 450 },
  M250:   { name: 'M250 maraging steel', youngsModulus: 186e9, ultimate: 1760e6, density: 8000, specificHeat: 460, warnTemp: 600, maxTemp: 700 },
} as const satisfies Record<string, Material>;

export type MaterialId = keyof typeof MATERIALS;
