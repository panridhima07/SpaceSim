import type { FluidId } from './fluids.ts';
import type { MaterialId } from './materials.ts';

export interface TankFaultSpec {
  fluid: FluidId | null;        // null for a solid grain
  wallThickness: number;        // m
  material: MaterialId;
  ullagePressure: number;       // regulated gas pressure above the liquid, Pa absolute
  npshRequired: number;         // pressure the pump inlet needs above vapour pressure, Pa
  insulationU: number;          // heat transfer coefficient through the wall, W/(m^2 K); 0 = ignore
}

export interface SolidFaultSpec {
  meop: number;                 // maximum expected operating pressure, Pa
  grainTemp: number;            // K
  refTemp: number;              // K, temperature the nominal curve was measured at
  piK: number;                  // per K
  caseThickness: number;        // m
  caseRadius: number;           // m
  caseMaterial: MaterialId;
}

export interface StageFaultSpec {
  tanks: TankFaultSpec[];       // same order and count as VehicleSpec.stages[i].tanks
  chamberPressure: number;      // at full throttle (solid: at thrust-curve value 1), Pa
  expansionRatio: number;
  gamma: number;
  solid?: SolidFaultSpec;
  maxSeparationQ: number;       // Pa
}

export interface FaultSpec {
  stages: StageFaultSpec[];     // same order and count as VehicleSpec.stages
  fairing?: { volume: number; ventArea: number; maxDeltaP: number; maxDepressRate: number };
  noseSkin: { material: MaterialId; thickness: number; emissivity: number };
  limits: { maxQ: number; maxQAlpha: number; maxG: number; payloadHeatFlux: number };
  ambientTemp: number;          // K
  padHoldSeconds: number;       // time tanked on the pad before liftoff with no topping-up
}

// Representative engineering estimates sized to give realistic margins. Not ISRO data.
export function lvm3FaultSpec(): FaultSpec {
  return {
    stages: [
      {
        tanks: [
          { fluid: 'UH25', wallThickness: 0.004, material: 'AL2219', ullagePressure: 0.35e6, npshRequired: 0.10e6, insulationU: 0 },
          { fluid: 'N2O4', wallThickness: 0.004, material: 'AL2219', ullagePressure: 0.35e6, npshRequired: 0.10e6, insulationU: 0 },
        ],
        chamberPressure: 5.85e6,
        expansionRatio: 13.88,
        gamma: 1.2,
        maxSeparationQ: 1000,
      },
      {
        tanks: [
          { fluid: null, wallThickness: 0.0078, material: 'M250', ullagePressure: 0, npshRequired: 0, insulationU: 0 },
        ],
        chamberPressure: 5.69e6,
        expansionRatio: 12.1,
        gamma: 1.18,
        solid: {
          meop: 5.88e6,
          grainTemp: 300,
          refTemp: 300,
          piK: 0.00277,
          caseThickness: 0.0078,
          caseRadius: 1.5,
          caseMaterial: 'M250',
        },
        maxSeparationQ: 1000,
      },
      {
        tanks: [
          { fluid: 'LOX', wallThickness: 0.003, material: 'AL2219', ullagePressure: 0.25e6, npshRequired: 0.05e6, insulationU: 0.8 },
          { fluid: 'LH2', wallThickness: 0.003, material: 'AL2219', ullagePressure: 0.20e6, npshRequired: 0.05e6, insulationU: 0.8 },
        ],
        chamberPressure: 6.0e6,
        expansionRatio: 100,
        gamma: 1.2,
        maxSeparationQ: 1000,
      },
    ],
    fairing: { volume: 110, ventArea: 0.08, maxDeltaP: 7000, maxDepressRate: 3500 },
    noseSkin: { material: 'AL2219', thickness: 0.006, emissivity: 0.8 },
    limits: { maxQ: 55000, maxQAlpha: 3000, maxG: 4.0, payloadHeatFlux: 1135 },
    ambientTemp: 303,
    padHoldSeconds: 0,
  };
}

export const SCENARIOS = [
  'blocked-vent',
  'regulator-low',
  'regulator-high',
  'hot-grain',
  'thin-nose',
  'long-hold',
] as const;

export type ScenarioId = (typeof SCENARIOS)[number];

export function applyScenario(spec: FaultSpec, id: ScenarioId): FaultSpec {
  const copy = structuredClone(spec);
  switch (id) {
    case 'blocked-vent':
      if (copy.fairing) copy.fairing.ventArea *= 0.25;
      break;
    case 'regulator-low':
      for (const stage of copy.stages) {
        for (const tank of stage.tanks) {
          if (tank.fluid !== null) tank.ullagePressure *= 0.5;
        }
      }
      break;
    case 'regulator-high':
      for (const stage of copy.stages) {
        for (const tank of stage.tanks) {
          if (tank.fluid !== null) tank.ullagePressure *= 2.2;
        }
      }
      break;
    case 'hot-grain':
      for (const stage of copy.stages) {
        if (stage.solid) stage.solid.grainTemp = 318;
      }
      break;
    case 'thin-nose':
      copy.noseSkin.thickness = 0.003;
      break;
    case 'long-hold':
      copy.padHoldSeconds = 3600;
      break;
  }
  return copy;
}
