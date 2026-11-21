export const STEFAN_BOLTZMANN = 5.670374419e-8;

export function recoveryTemperature(Tinf: number, mach: number, r = 0.89): number {
  return Tinf * (1 + r * 0.2 * mach * mach);
}

export function radiativeEquilibriumTemp(heatFlux: number, emissivity: number): number {
  if (heatFlux <= 0) return 0;
  return Math.pow(heatFlux / (emissivity * STEFAN_BOLTZMANN), 0.25);
}

export function arealHeatCapacity(density: number, specificHeat: number, thickness: number): number {
  return density * specificHeat * thickness;
}

export function skinStep(
  Tw: number,
  coldWallFlux: number,
  Taw: number,
  dt: number,
  capacity: number,
  emissivity: number,
  sinkTemp = 250,
): number {
  const n = Math.max(1, Math.ceil(dt / 1));
  const h = dt / n;
  let T = Tw;
  for (let i = 0; i < n; i++) {
    const f = Math.min(1, Math.max(0, (Taw - T) / Math.max(Taw - 300, 1)));
    const net = coldWallFlux * f - emissivity * STEFAN_BOLTZMANN * (T ** 4 - sinkTemp ** 4);
    T += (h * net) / capacity;
  }
  return T;
}

export function heatLeak(u: number, area: number, outsideTemp: number, liquidTemp: number): number {
  return Math.max(0, u * area * (outsideTemp - liquidTemp));
}

export function boilOffRate(leak: number, latentHeat: number): number {
  return leak / latentHeat;
}

export function tankSurfaceArea(r: number, length: number): number {
  return 2 * Math.PI * r * length + 2 * Math.PI * r * r;
}
