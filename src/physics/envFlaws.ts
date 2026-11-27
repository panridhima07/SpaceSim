// Environmental and structural design-review rules for model rockets:
// aerodynamic heating, airframe crushing under thrust, and fin root bending.

import type { Flaw, FlightEvent, RocketModel, SimConfig, SimState } from '../types';
import { atmosphere } from './atmosphere';

export interface AirframeMaterial {
  name: string;
  youngsModulus: number;
  compressive: number;
  bending: number;
  maxTemp: number;
}

const BALSA: AirframeMaterial = {
  name: 'balsa',
  youngsModulus: 3.0e9,
  compressive: 7e6,
  bending: 20e6,
  maxTemp: 450,
};

const PAPER_OR_PLYWOOD: AirframeMaterial = {
  name: 'paper or plywood',
  youngsModulus: 2.5e9,
  compressive: 8e6,
  bending: 40e6,
  maxTemp: 450,
};

const PLASTIC: AirframeMaterial = {
  name: 'plastic',
  youngsModulus: 2.5e9,
  compressive: 40e6,
  bending: 50e6,
  maxTemp: 330,
};

const COMPOSITE: AirframeMaterial = {
  name: 'composite',
  youngsModulus: 15e9,
  compressive: 150e6,
  bending: 250e6,
  maxTemp: 400,
};

export function materialFromDensity(density: number): AirframeMaterial | null {
  if (!Number.isFinite(density) || density <= 0) return null;
  if (density < 300) return BALSA;
  if (density < 900) return PAPER_OR_PLYWOOD;
  if (density < 1400) return PLASTIC;
  return COMPOSITE;
}

/** Adiabatic recovery temperature (K) for turbulent boundary layer (r = 0.89). */
export function recoveryTemp(Tinf: number, mach: number): number {
  return Tinf * (1 + 0.178 * mach * mach);
}

/** Axial compressive load (N) that crushes or buckles a cylindrical body tube. */
export function tubeCrushLoad(outerRadius: number, thickness: number, mat: AirframeMaterial): number {
  const r = outerRadius - thickness / 2;
  if (thickness <= 0 || r <= 0) return 0;
  const g = 1 - 0.901 * (1 - Math.exp(-Math.sqrt(r / thickness) / 16));
  const sigma = Math.min((g * 0.605 * mat.youngsModulus * thickness) / r, mat.compressive);
  return sigma * 2 * Math.PI * r * thickness;
}

/** Peak bending stress (Pa) at a fin root for dynamic-pressure-times-alpha load. */
export function finRootStress(
  qAlpha: number,
  span: number,
  rootChord: number,
  tipChord: number,
  thickness: number,
): number {
  if (qAlpha <= 0 || span <= 0 || rootChord <= 0 || tipChord < 0 || thickness <= 0) return 0;
  const S = (span * (rootChord + tipChord)) / 2;
  const AR = (2 * span * span) / S;
  const cn = (2 * Math.PI * AR) / (2 + Math.sqrt(4 + AR * AR));
  const lambda = tipChord / rootChord;
  const arm = (span * (1 + 2 * lambda)) / (3 * (1 + lambda));
  return (6 * qAlpha * S * cn * arm) / (rootChord * thickness * thickness);
}

/** Black-powder ejection charge mass (kg) to reach targetPressure (Pa) in volume (m^3). */
export function ejectionChargeMass(volume: number, targetPressure = 103e3): number {
  return (targetPressure * volume) / 2.19e5;
}

export function analyzeEnvironment(
  sim: { log: SimState[]; events: FlightEvent[] },
  rocket: RocketModel,
  config: SimConfig,
): Flaw[] {
  const flaws: Flaw[] = [];
  const { log } = sim;
  if (log.length === 0) return flaws;

  // 1. Aerodynamic heating on nose cones and fin sets.
  for (const c of rocket.components) {
    if (c.kind !== 'nosecone' && c.kind !== 'finset') continue;
    const mat = materialFromDensity(c.density);
    if (!mat) continue;

    let peakTr = 0;
    let peakT = 0;
    let peakMach = 0;
    let timeAbove = 0;

    for (let i = 0; i < log.length; i++) {
      const s = log[i];
      const Tinf = atmosphere(config.launchAltitude + s.altitude).temperature;
      const Tr = recoveryTemp(Tinf, s.mach);
      if (Tr > peakTr) {
        peakTr = Tr;
        peakT = s.t;
        peakMach = s.mach;
      }
      if (Tr > mat.maxTemp && i > 0) {
        timeAbove += Math.max(0, s.t - log[i - 1].t);
      }
    }

    if (peakTr > mat.maxTemp) {
      const peakC = peakTr - 273.15;
      const limitC = mat.maxTemp - 273.15;
      flaws.push({
        id: `aero-heating:${c.id}`,
        severity: timeAbove >= 1.0 ? 'critical' : 'warning',
        title: `Aerodynamic heating: ${c.name}`,
        detail: `Peak recovery temperature reaches ${peakC.toFixed(1)} °C at Mach ${peakMach.toFixed(2)}, exceeding the ${limitC.toFixed(0)} °C limit for ${mat.name}.`,
        fix: 'Use a fibreglass or metal-tipped part, or fly slower.',
        t: peakT,
        value: peakTr,
        limit: mat.maxTemp,
        unit: 'K',
      });
    }
  }

  // 2. Airframe crushing on body tubes under axial thrust.
  let maxThrust = 0;
  let maxThrustT = 0;
  for (const s of log) {
    if (s.thrust > maxThrust) {
      maxThrust = s.thrust;
      maxThrustT = s.t;
    }
  }

  for (const c of rocket.components) {
    if (c.kind !== 'bodytube' || c.thickness <= 0) continue;
    const mat = materialFromDensity(c.density);
    if (!mat) continue;

    const crush = tubeCrushLoad(c.outerRadius, c.thickness, mat);
    if (crush <= 0) continue;
    const util = maxThrust / crush;
    if (util > 0.5) {
      flaws.push({
        id: `airframe-crush:${c.id}`,
        severity: util > 1 ? 'critical' : 'warning',
        title: `Airframe crush load: ${c.name}`,
        detail: `Peak thrust of ${maxThrust.toFixed(1)} N ${util > 1 ? 'exceeds' : 'approaches'} the ${crush.toFixed(1)} N crush load of ${c.name}.`,
        fix: 'Use a thicker wall, a stiffer tube, or a lower-thrust motor.',
        t: maxThrustT,
        value: maxThrust,
        limit: crush,
        unit: 'N',
      });
    }
  }

  // 3. Fin root bending during boost and coast.
  let maxQAlpha = 0;
  let maxQAlphaT = 0;
  for (const s of log) {
    if (s.phase === 'boost' || s.phase === 'coast') {
      const qa = s.dynamicPressure * Math.min(s.alpha, 0.26);
      if (qa > maxQAlpha) {
        maxQAlpha = qa;
        maxQAlphaT = s.t;
      }
    }
  }

  for (const c of rocket.components) {
    if (c.kind !== 'finset') continue;
    const mat = materialFromDensity(c.density);
    if (!mat) continue;

    const stress = finRootStress(maxQAlpha, c.span, c.rootChord, c.tipChord, c.thickness);
    const util = stress / mat.bending;
    if (util > 0.5) {
      flaws.push({
        id: `fin-root-bending:${c.id}`,
        severity: util > 1 ? 'critical' : 'warning',
        title: `Fin root bending: ${c.name}`,
        detail: `Fin root bending stress reaches ${(stress / 1e6).toFixed(1)} MPa against the ${(mat.bending / 1e6).toFixed(0)} MPa bending strength of ${mat.name}.`,
        fix: 'Use thicker fins, shorter span, or a stronger material.',
        t: maxQAlphaT,
        value: stress,
        limit: mat.bending,
        unit: 'Pa',
      });
    }
  }

  return flaws;
}
