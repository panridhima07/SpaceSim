// Engine thrust and propellant flow.

import { G0, P0 } from '../constants.ts';
import type { EngineSpec } from '../vehicle/types.ts';
import { nozzlePerformance, type ChamberDesign } from './nozzle.ts';

/** Nozzle exit area of one engine, m^2. */
export function exitArea(e: EngineSpec): number {
  if (e.exitArea !== undefined) return e.exitArea;
  if (e.ispSL !== undefined) return (e.thrustVac * (1 - e.ispSL / e.ispVac)) / P0;
  return 0;
}

/**
 * Thrust (N) and mass flow (kg/s) of one engine.
 *
 *   F = throttle * F_vac - p_ambient * A_exit
 *
 * Mass flow depends only on throttle, so the same propellant buys less thrust at sea
 * level: that is the whole difference between sea-level and vacuum Isp.
 */
export function engineOutput(e: EngineSpec, throttle: number, ambientPressure: number): { thrust: number; massFlow: number } {
  if (throttle <= 0) return { thrust: 0, massFlow: 0 };
  return {
    thrust: Math.max(0, throttle * e.thrustVac - ambientPressure * exitArea(e)),
    massFlow: (throttle * e.thrustVac) / (G0 * e.ispVac),
  };
}

/** Value of a solid motor thrust curve at time t since ignition (linear interpolation, 0 outside). */
export function thrustCurveAt(curve: ReadonlyArray<readonly [number, number]>, t: number): number {
  if (t < curve[0][0] || t > curve[curve.length - 1][0]) return 0;
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) {
      const [t0, f0] = curve[i - 1];
      const [t1, f1] = curve[i];
      return t1 === t0 ? f1 : f0 + ((f1 - f0) * (t - t0)) / (t1 - t0);
    }
  }
  return 0;
}

/**
 * Scale a solid motor so that burning along its thrust curve uses exactly `propellant` kg.
 * Returns the vacuum thrust that corresponds to curve value 1.
 */
export function solidReferenceThrust(curve: ReadonlyArray<readonly [number, number]>, propellant: number, ispVac: number): number {
  let area = 0;
  for (let i = 1; i < curve.length; i++) area += 0.5 * (curve[i][1] + curve[i - 1][1]) * (curve[i][0] - curve[i - 1][0]);
  return (propellant * G0 * ispVac) / area;
}

/** Build an EngineSpec from combustion chamber conditions using ideal nozzle theory. */
export function engineFromChamber(name: string, d: ChamberDesign, extra: Partial<EngineSpec> = {}): EngineSpec {
  const p = nozzlePerformance(d);
  return { name, thrustVac: p.thrustVac, ispVac: p.ispVac, exitArea: p.exitArea, ...extra };
}
