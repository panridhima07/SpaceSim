import { machFromAreaRatio } from '../propulsion/nozzle.ts';

export function hoopStress(dp: number, r: number, t: number): number {
  return (dp * r) / t;
}

export function axialPressureStress(dp: number, r: number, t: number): number {
  return (dp * r) / (2 * t);
}

export function knockdown(r: number, t: number): number {
  return 1 - 0.901 * (1 - Math.exp(-Math.sqrt(r / t) / 16));
}

export function shellBucklingStress(E: number, t: number, r: number): number {
  return (knockdown(r, t) * 0.605 * E * t) / r;
}

export function equivalentAxialLoad(force: number, moment: number, r: number): number {
  return force + (2 * moment) / r;
}

export function nozzleExitPressure(pc: number, expansionRatio: number, gamma: number): number {
  const Me = machFromAreaRatio(expansionRatio, gamma);
  return pc * Math.pow(1 + ((gamma - 1) / 2) * Me * Me, -gamma / (gamma - 1));
}

export function separationState(pe: number, pa: number): 'attached' | 'marginal' | 'separated' {
  if (pe < 0.25 * pa) return 'separated';
  if (pe < 0.4 * pa) return 'marginal';
  return 'attached';
}

export function solidPressureFactor(grainTemp: number, refTemp = 300, piK = 0.00277): number {
  return Math.exp(piK * (grainTemp - refTemp));
}

export function ventStep(
  pInt: number,
  pExt: number,
  dt: number,
  volume: number,
  ventArea: number,
  cd = 0.6,
  gasTemp = 288,
): number {
  if (ventArea <= 0 || volume <= 0 || dt <= 0) return pInt;
  const n = Math.min(2000, Math.max(1, Math.ceil(dt / 0.005)));
  const h = dt / n;
  let p = pInt;
  for (let i = 0; i < n; i++) {
    const dp = p - pExt;
    const rho = p / (287.05 * gasTemp);
    if (Math.abs(dp) < 1e-9 || rho <= 0) continue;
    const mdot = cd * ventArea * Math.sqrt(2 * Math.abs(dp) * rho) * Math.sign(dp);
    let change = -((1.4 * p) / (rho * volume)) * mdot * h;
    if (Math.abs(change) > Math.abs(dp)) change = -dp;
    p += change;
  }
  return p;
}
