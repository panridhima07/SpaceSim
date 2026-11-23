import { G0 } from '../constants.ts';
import { atmosphereInto, type AtmosphereState } from '../env/atmosphere.ts';
import { thrustCurveAt } from '../propulsion/engine.ts';
import type { FlightComputer, Simulation } from '../sim/simulation.ts';
import { stageMass } from '../vehicle/massprops.ts';
import { tankOffsets, type VehicleSpec } from '../vehicle/types.ts';
import { FLUIDS, isCryogenic, vapourPressure } from './fluids.ts';
import { MATERIALS } from './materials.ts';
import {
  axialPressureStress,
  equivalentAxialLoad,
  hoopStress,
  nozzleExitPressure,
  separationState,
  shellBucklingStress,
  solidPressureFactor,
  ventStep,
} from './pressure.ts';
import type { FaultSpec } from './spec.ts';
import {
  arealHeatCapacity,
  boilOffRate,
  heatLeak,
  recoveryTemperature,
  skinStep,
  tankSurfaceArea,
} from './thermal.ts';

export type FaultSeverity = 'info' | 'warning' | 'critical';
export type FaultSystem = 'pressure' | 'thermal' | 'structure' | 'propulsion';

export interface Fault {
  id: string;
  system: FaultSystem;
  severity: FaultSeverity;
  stage?: number;
  t: number;
  tFirst: number;
  tLast: number;
  value: number;
  limit: number;
  unit: string;
  title: string;
  detail: string;
  fix: string;
}

export interface FaultChannels {
  skinTemp: number;
  fairingDeltaP: number;
  fairingPressure: number;
  depressRate: number;
}

export interface HealthPeak {
  key: string;
  value: number;
  t: number;
}

const HEALTH_KEYS = [
  'maxQ',
  'qAlpha',
  'axialG',
  'skin',
  'fairingDp',
  'depressRate',
  'tankBurst',
  'caseBurst',
  'tankBuckling',
  'cavitation',
  'nozzle',
  'payloadHeat',
] as const;

const SEVERITY_RANK: Record<FaultSeverity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

type FaultInput = Omit<Fault, 'tFirst' | 'tLast'>;

export class FaultMonitor {
  channels: FaultChannels;
  health: Record<string, number>;

  private readonly vehicle: VehicleSpec;
  private readonly spec: FaultSpec;
  private readonly offs: number[];
  private readonly skinCapacity: number;
  private readonly boilOff: number[];
  // Per-tank numbers that depend only on the vehicle and the spec, worked out once
  // (same expressions as before, so the same values). Indexed like the propellant array.
  private readonly vapour: number[];
  private readonly buckleStress: number[];
  private readonly boilRate: number[];
  private readonly sepTimers: number[];
  private readonly faults = new Map<string, Fault>();
  private readonly criticalSeen = new Set<string>();
  private readonly newCriticals: Fault[] = [];
  private readonly healthPeaks = new Map<string, HealthPeak>();
  /** The same peak records as `healthPeaks`, in HEALTH_KEYS order, for the per-step update. */
  private readonly peakList: HealthPeak[] = [];
  /** Scratch atmosphere state for the skin-temperature model. */
  private readonly air: AtmosphereState = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, viscosity: 0, meanFreePath: 0 };

  private initialized = false;
  private prevAttached: boolean[];
  private prevFairingAttached: boolean;
  private fairingJettisoned = false;
  private skinTemp: number;
  private fairingPressure = NaN;
  private fairingDeltaP = 0;
  private depressRate = 0;
  private depressDrop = 0;
  private depressTime = 0;
  private lastT = NaN;

  constructor(vehicle: VehicleSpec, spec: FaultSpec) {
    this.vehicle = vehicle;
    this.spec = spec;
    this.offs = tankOffsets(vehicle);
    this.skinTemp = spec.ambientTemp;
    const skinMat = MATERIALS[spec.noseSkin.material];
    this.skinCapacity = arealHeatCapacity(skinMat.density, skinMat.specificHeat, spec.noseSkin.thickness);

    const totalTanks = vehicle.stages.reduce((acc, s) => acc + s.tanks.length, 0);
    this.boilOff = new Array<number>(totalTanks).fill(0);
    this.vapour = new Array<number>(totalTanks).fill(0);
    this.buckleStress = new Array<number>(totalTanks).fill(0);
    this.boilRate = new Array<number>(totalTanks).fill(0);
    for (let i = 0; i < vehicle.stages.length; i++) {
      const stage = vehicle.stages[i];
      const stageSpec = spec.stages[i];
      for (let k = 0; k < stage.tanks.length; k++) {
        const ts = stageSpec.tanks[k];
        if (ts.fluid === null) continue;
        const tk = stage.tanks[k];
        const r = tk.radius ?? stage.radius;
        const fluid = FLUIDS[ts.fluid];
        const idx = this.offs[i] + k;
        this.vapour[idx] = vapourPressure(fluid, fluid.storageTemp);
        this.buckleStress[idx] = shellBucklingStress(MATERIALS[ts.material].youngsModulus, ts.wallThickness, r);
        if (isCryogenic(fluid) && ts.insulationU > 0) {
          const leak = heatLeak(ts.insulationU, tankSurfaceArea(r, tk.length), spec.ambientTemp, fluid.storageTemp);
          this.boilRate[idx] = boilOffRate(leak, fluid.latentHeat);
        }
      }
    }
    for (let i = 0; i < vehicle.stages.length; i++) {
      const stage = vehicle.stages[i];
      const stageSpec = spec.stages[i];
      for (let k = 0; k < stage.tanks.length; k++) {
        const ts = stageSpec.tanks[k];
        if (ts.fluid === null || ts.insulationU <= 0) continue;
        const fluid = FLUIDS[ts.fluid];
        if (!isCryogenic(fluid)) continue;
        const tk = stage.tanks[k];
        const r = tk.radius ?? stage.radius;
        const area = tankSurfaceArea(r, tk.length);
        const leak = heatLeak(ts.insulationU, area, spec.ambientTemp, fluid.storageTemp);
        this.boilOff[this.offs[i] + k] = boilOffRate(leak, fluid.latentHeat) * spec.padHoldSeconds;
      }
    }

    this.sepTimers = vehicle.stages.map(() => 0);
    this.prevAttached = vehicle.stages.map(() => true);
    this.prevFairingAttached = !!vehicle.fairing;
    this.channels = {
      skinTemp: this.skinTemp,
      fairingDeltaP: 0,
      fairingPressure: NaN,
      depressRate: 0,
    };
    // One literal with the keys in HEALTH_KEYS order (the order the loop used to create
    // them in), so the object keeps a fixed shape and the per-step writes stay fast.
    this.health = {
      maxQ: 0,
      qAlpha: 0,
      axialG: 0,
      skin: 0,
      fairingDp: 0,
      depressRate: 0,
      tankBurst: 0,
      caseBurst: 0,
      tankBuckling: 0,
      cavitation: 0,
      nozzle: 0,
      payloadHeat: 0,
    };
    for (const key of HEALTH_KEYS) {
      const peak: HealthPeak = { key, value: 0, t: 0 };
      this.healthPeaks.set(key, peak);
      this.peakList.push(peak);
    }
  }

  private raise(input: FaultInput, lowerIsWorse = false): void {
    const existing = this.faults.get(input.id);
    let stored: Fault;
    if (!existing) {
      stored = { ...input, tFirst: input.t, tLast: input.t };
      this.faults.set(input.id, stored);
    } else {
      const tFirst = Math.min(existing.tFirst, input.t);
      const tLast = Math.max(existing.tLast, input.t);
      existing.tFirst = tFirst;
      existing.tLast = tLast;

      const newRank = SEVERITY_RANK[input.severity];
      const oldRank = SEVERITY_RANK[existing.severity];
      const shouldReplace =
        newRank > oldRank ||
        (newRank === oldRank && (lowerIsWorse ? input.value < existing.value : input.value > existing.value));
      if (shouldReplace) {
        stored = { ...input, tFirst, tLast };
        this.faults.set(input.id, stored);
      } else {
        stored = existing;
      }
    }

    if (input.severity === 'critical' && !this.criticalSeen.has(input.id)) {
      this.criticalSeen.add(input.id);
      this.newCriticals.push(stored);
    }
  }

  /** Clamp a health value, update its peak record, and return the value to store. */
  private track(peak: HealthPeak, value: number, mt: number): number {
    const v = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (v > peak.value) {
      peak.value = v;
      peak.t = mt;
    }
    return v;
  }

  drainNewCriticals(): Fault[] {
    if (this.newCriticals.length === 0) return [];
    const out = this.newCriticals.slice();
    this.newCriticals.length = 0;
    return out;
  }

  worst(): { key: string; value: number } {
    let bestKey: string = HEALTH_KEYS[0];
    let bestVal = this.health[bestKey] ?? 0;
    for (const key of HEALTH_KEYS) {
      const v = this.health[key] ?? 0;
      if (v > bestVal) {
        bestVal = v;
        bestKey = key;
      }
    }
    return { key: bestKey, value: bestVal };
  }

  peaks(): HealthPeak[] {
    return HEALTH_KEYS.map((key) => {
      const p = this.healthPeaks.get(key)!;
      return { key: p.key, value: p.value, t: p.t };
    });
  }

  observe(sim: Simulation): void {
    const d = sim.diag;
    const { limits } = this.spec;

    if (!this.initialized) {
      this.initialized = true;
      this.prevAttached = sim.rt.stages.map((s) => s.attached);
      this.prevFairingAttached = sim.rt.fairingAttached;
      if (this.spec.fairing) {
        this.fairingPressure = d.pressure;
      }
      // Static solid chamber overpressure check
      for (let i = 0; i < this.spec.stages.length; i++) {
        const ss = this.spec.stages[i];
        if (!ss.solid) continue;
        const solid = ss.solid;
        const pcMax = ss.chamberPressure * solidPressureFactor(solid.grainTemp, solid.refTemp, solid.piK);
        if (pcMax > 0.98 * solid.meop) {
          const severity: FaultSeverity = pcMax > solid.meop ? 'critical' : 'warning';
          const stageName = this.vehicle.stages[i].name;
          this.raise({
            id: `chamber-overpressure:${i}`,
            system: 'propulsion',
            severity,
            stage: i,
            t: 0,
            value: pcMax,
            limit: solid.meop,
            unit: 'Pa',
            title: `${stageName} chamber overpressure`,
            detail: `${stageName} predicted peak chamber pressure is ${(pcMax / 1e6).toFixed(2)} MPa at ${solid.grainTemp.toFixed(0)} K grain temperature, against a ${(solid.meop / 1e6).toFixed(2)} MPa MEOP.`,
            fix: 'Condition the motor to its qualified temperature range before launch.',
          });
        }
      }
    }

    const lifted = Number.isFinite(sim.liftoffTime);
    const mt = lifted ? sim.t - sim.liftoffTime : 0;
    const dt = Number.isFinite(this.lastT) ? sim.t - this.lastT : 0;
    this.lastT = sim.t;
    const a = lifted ? d.accelG * G0 : G0;
    const moment = Math.hypot(d.aeroMoment[1], d.aeroMoment[2]);

    // 1. max-q
    const hMaxQ = lifted ? d.q / limits.maxQ : 0;
    if (lifted && d.q > 0.9 * limits.maxQ) {
      const severity: FaultSeverity = d.q > limits.maxQ ? 'critical' : 'warning';
      this.raise({
        id: 'max-q',
        system: 'structure',
        severity,
        t: mt,
        value: d.q,
        limit: limits.maxQ,
        unit: 'Pa',
        title: 'Dynamic pressure limit',
        detail: `Dynamic pressure reached ${(d.q / 1e3).toFixed(1)} kPa, against a ${(limits.maxQ / 1e3).toFixed(1)} kPa structural limit.`,
        fix: 'Throttle down through max-Q or fly a steeper trajectory to reduce atmospheric airspeed.',
      });
    }

    // 2. q-alpha
    let hQAlpha = 0;
    if (lifted && d.q > 1000) {
      const qa = d.q * Math.abs(d.alpha);
      hQAlpha = qa / limits.maxQAlpha;
      if (qa > 0.7 * limits.maxQAlpha) {
        const severity: FaultSeverity = qa > limits.maxQAlpha ? 'critical' : 'warning';
        this.raise({
          id: 'q-alpha',
          system: 'structure',
          severity,
          t: mt,
          value: qa,
          limit: limits.maxQAlpha,
          unit: 'Pa rad',
          title: 'Aerodynamic bending load (q-alpha)',
          detail: `Bending load q*alpha reached ${qa.toFixed(0)} Pa rad, against a ${limits.maxQAlpha.toFixed(0)} Pa rad limit.`,
          fix: 'Keep angle of attack near zero during the gravity turn or stiffen the airframe.',
        });
      }
    }

    // 3. axial-g
    const hAxialG = d.accelG / (1.25 * limits.maxG);
    if (d.accelG > limits.maxG) {
      const severity: FaultSeverity = d.accelG > 1.25 * limits.maxG ? 'critical' : 'warning';
      this.raise({
        id: 'axial-g',
        system: 'structure',
        severity,
        t: mt,
        value: d.accelG,
        limit: limits.maxG,
        unit: 'g',
        title: 'Axial acceleration limit',
        detail: `Sensed axial acceleration reached ${d.accelG.toFixed(2)} g, exceeding the ${limits.maxG.toFixed(2)} g limit.`,
        fix: 'Throttle back engines near stage burnout or reinforce the payload adapter.',
      });
    }

    // 4. Per tank
    let hTankBurst = 0;
    let hTankBuckling = 0;
    let hCavitation = 0;

    for (let i = 0; i < this.vehicle.stages.length; i++) {
      if (!sim.rt.stages[i].attached) continue;
      const stage = this.vehicle.stages[i];
      const stageSpec = this.spec.stages[i];
      const st = sim.rt.stages[i];

      for (let k = 0; k < stage.tanks.length; k++) {
        const ts = stageSpec.tanks[k];
        if (ts.fluid === null) continue;
        const tk = stage.tanks[k];
        const r = tk.radius ?? stage.radius;
        const m = Math.max(0, sim.prop[this.offs[i] + k]);
        const mat = MATERIALS[ts.material];
        const fluid = FLUIDS[ts.fluid];
        const hLiq = Math.min(tk.length, m / (fluid.density * Math.PI * r * r));
        const head = fluid.density * a * hLiq;
        const pBottom = ts.ullagePressure + head;
        const tankLabel = tk.name ?? fluid.name;

        // tank-burst:i:k
        const dpTank = pBottom - d.pressure;
        if (dpTank > 0) {
          const fos = mat.ultimate / hoopStress(dpTank, r, ts.wallThickness);
          hTankBurst = Math.max(hTankBurst, 1.1 / fos);
          if (fos < 1.4) {
            const severity: FaultSeverity = fos < 1.1 ? 'critical' : 'warning';
            this.raise(
              {
                id: `tank-burst:${i}:${k}`,
                system: 'pressure',
                severity,
                stage: i,
                t: mt,
                value: fos,
                limit: 1.4,
                unit: 'factor of safety',
                title: `${stage.name} ${tankLabel} tank burst margin`,
                detail: `${stage.name} ${tankLabel} tank hoop stress factor of safety dropped to ${fos.toFixed(2)} (minimum 1.40, burst below 1.10).`,
                fix: 'Lower ullage pressure, thicken the tank wall, or use a higher-strength alloy.',
              },
              true,
            );
          }
        }

        // tank-buckling:i:k (core stages only)
        if (!stage.parallel) {
          let mAbove = this.vehicle.payload.mass;
          if (sim.rt.fairingAttached && this.vehicle.fairing) {
            mAbove += this.vehicle.fairing.mass;
          }
          for (let j = i + 1; j < this.vehicle.stages.length; j++) {
            if (!this.vehicle.stages[j].parallel && sim.rt.stages[j].attached) {
              mAbove += stageMass(this.vehicle, j, sim.prop);
            }
          }
          for (let k2 = 0; k2 < stage.tanks.length; k2++) {
            if (stage.tanks[k2].bottom > tk.bottom) {
              mAbove += Math.max(0, sim.prop[this.offs[i] + k2]);
            }
          }
          const load = equivalentAxialLoad(mAbove * a + Math.max(0, d.drag), moment, r);
          const compress = load / (2 * Math.PI * r * ts.wallThickness);
          const relief = axialPressureStress(ts.ullagePressure - d.pressure, r, ts.wallThickness);
          const util = (compress - relief) / this.buckleStress[this.offs[i] + k];
          hTankBuckling = Math.max(hTankBuckling, Math.max(0, util));
          if (util > 0.6) {
            const severity: FaultSeverity = util > 1.0 ? 'critical' : 'warning';
            this.raise({
              id: `tank-buckling:${i}:${k}`,
              system: 'structure',
              severity,
              stage: i,
              t: mt,
              value: util,
              limit: 1,
              unit: 'utilisation',
              title: `${stage.name} ${tankLabel} tank buckling`,
              detail: `${stage.name} ${tankLabel} tank axial buckling utilisation reached ${(util * 100).toFixed(1)}% (limit 100%).`,
              fix: 'Raise tank pressure or thicken the wall; this tank only stands up because it is pressurised.',
            });
          }
        }

        // cavitation:i:k
        if (st.engineOn && st.throttle > 0) {
          const pAvail = ts.ullagePressure + head - this.vapour[this.offs[i] + k];
          const cavUtil = pAvail <= 0 ? 2 : ts.npshRequired / pAvail;
          hCavitation = Math.max(hCavitation, cavUtil);
          const margin = pAvail - ts.npshRequired;
          if (margin < 0.25 * ts.npshRequired) {
            const severity: FaultSeverity = margin < 0 ? 'critical' : 'warning';
            this.raise(
              {
                id: `cavitation:${i}:${k}`,
                system: 'propulsion',
                severity,
                stage: i,
                t: mt,
                value: margin,
                limit: 0,
                unit: 'Pa',
                title: `${stage.name} ${tankLabel} pump cavitation`,
                detail: `${stage.name} ${tankLabel} pump NPSH margin fell to ${(margin / 1e3).toFixed(1)} kPa (required above 0 kPa).`,
                fix: 'The pump inlet pressure is at or below the propellant vapour pressure, so the pump would cavitate; raise ullage pressure or chill the propellant.',
              },
              true,
            );
          }
        }

        // boil-off:i:k
        if (isCryogenic(fluid) && ts.insulationU > 0) {
          if (dt > 0) {
            this.boilOff[this.offs[i] + k] += this.boilRate[this.offs[i] + k] * dt;
          }
          const frac = this.boilOff[this.offs[i] + k] / tk.propellantMass;
          if (frac > 0.01) {
            const severity: FaultSeverity = frac > 0.03 ? 'warning' : 'info';
            this.raise({
              id: `boil-off:${i}:${k}`,
              system: 'thermal',
              severity,
              stage: i,
              t: mt,
              value: frac * 100,
              limit: 3,
              unit: '%',
              title: `${stage.name} ${tankLabel} cryogenic boil-off`,
              detail: `${stage.name} ${tankLabel} lost ${(frac * 100).toFixed(2)}% of its propellant load to boil-off (warning above 3%).`,
              fix: 'Improve cryogenic tank insulation or shorten the pre-launch pad hold.',
            });
          }
        }
      }
    }

    // 5. Per burning stage
    let hCaseBurst = 0;
    let hNozzle = 0;

    for (let i = 0; i < this.vehicle.stages.length; i++) {
      const st = sim.rt.stages[i];
      if (!st.attached || !st.engineOn) {
        this.sepTimers[i] = 0;
        continue;
      }
      const stage = this.vehicle.stages[i];
      const ss = this.spec.stages[i];
      const e = stage.engine;
      const thr = e.thrustCurve ? thrustCurveAt(e.thrustCurve, sim.t - st.ignitionTime) : st.throttle;
      const factor = ss.solid ? solidPressureFactor(ss.solid.grainTemp, ss.solid.refTemp, ss.solid.piK) : 1;
      const pc = ss.chamberPressure * thr * factor;

      // flow-separation:i
      if (thr >= 0.5) {
        const pe = nozzleExitPressure(pc, ss.expansionRatio, ss.gamma);
        if (pe > 0) {
          hNozzle = Math.max(hNozzle, (0.25 * d.pressure) / pe);
        }
        const state = separationState(pe, d.pressure);
        if (state !== 'attached') {
          this.sepTimers[i] += dt;
          if (this.sepTimers[i] >= 1.0) {
            const severity: FaultSeverity = state === 'separated' ? 'critical' : 'warning';
            this.raise(
              {
                id: `flow-separation:${i}`,
                system: 'propulsion',
                severity,
                stage: i,
                t: mt,
                value: pe,
                limit: 0.4 * d.pressure,
                unit: 'Pa',
                title: `${stage.name} nozzle flow separation`,
                detail: `${stage.name} nozzle exit pressure ${(pe / 1e3).toFixed(1)} kPa is below 40% of ambient ${(d.pressure / 1e3).toFixed(1)} kPa (${state}).`,
                fix: 'The nozzle is over-expanded for this altitude; the jet detaches from the wall and shakes the engine sideways. Light this engine higher or use a smaller expansion ratio.',
              },
              true,
            );
          }
        } else {
          this.sepTimers[i] = 0;
        }
      } else {
        this.sepTimers[i] = 0;
      }

      // case-burst:i
      if (ss.solid) {
        const dpCase = pc - d.pressure;
        if (dpCase > 1e5) {
          const fos =
            MATERIALS[ss.solid.caseMaterial].ultimate /
            hoopStress(dpCase, ss.solid.caseRadius, ss.solid.caseThickness);
          hCaseBurst = Math.max(hCaseBurst, 1.1 / fos);
          if (fos < 1.4) {
            const severity: FaultSeverity = fos < 1.1 ? 'critical' : 'warning';
            this.raise(
              {
                id: `case-burst:${i}`,
                system: 'pressure',
                severity,
                stage: i,
                t: mt,
                value: fos,
                limit: 1.4,
                unit: 'factor of safety',
                title: `${stage.name} motor case burst margin`,
                detail: `${stage.name} motor case hoop factor of safety fell to ${fos.toFixed(2)} (minimum 1.40, burst below 1.10).`,
                fix: 'Lower motor MEOP, condition the grain cooler, or thicken the motor case.',
              },
              true,
            );
          }
        }
      }
    }

    // 6. Fairing vent
    const fairingJustJettisoned = this.prevFairingAttached && !sim.rt.fairingAttached;
    if (fairingJustJettisoned) {
      this.fairingJettisoned = true;
    }

    let hFairingDp = 0;
    let hDepressRate = 0;
    if (this.spec.fairing) {
      const f = this.spec.fairing;
      if (sim.rt.fairingAttached && dt > 0) {
        const before = this.fairingPressure;
        this.fairingPressure = ventStep(before, d.pressure, dt, f.volume, f.ventArea);
        this.fairingDeltaP = this.fairingPressure - d.pressure;

        this.depressDrop += before - this.fairingPressure;
        this.depressTime += dt;
        if (this.depressTime >= 0.5) {
          this.depressRate = this.depressDrop / this.depressTime;
          this.depressDrop = 0;
          this.depressTime = 0;
          if (this.depressRate > 0.8 * f.maxDepressRate) {
            const severity: FaultSeverity = this.depressRate > f.maxDepressRate ? 'critical' : 'warning';
            this.raise({
              id: 'depress-rate',
              system: 'pressure',
              severity,
              t: mt,
              value: this.depressRate,
              limit: f.maxDepressRate,
              unit: 'Pa/s',
              title: 'Fairing depressurisation rate',
              detail: `Fairing internal pressure dropped at ${this.depressRate.toFixed(0)} Pa/s, exceeding the ${f.maxDepressRate.toFixed(0)} Pa/s payload limit.`,
              fix: 'The payload own vents cannot keep up with a pressure drop this fast; reduce fairing vent area or add payload venting.',
            });
          }
        }

        if (this.fairingDeltaP > 0.5 * f.maxDeltaP) {
          const severity: FaultSeverity = this.fairingDeltaP > f.maxDeltaP ? 'critical' : 'warning';
          this.raise({
            id: 'fairing-dp',
            system: 'pressure',
            severity,
            t: mt,
            value: this.fairingDeltaP,
            limit: f.maxDeltaP,
            unit: 'Pa',
            title: 'Fairing differential pressure',
            detail: `Fairing internal overpressure reached ${this.fairingDeltaP.toFixed(0)} Pa against a ${f.maxDeltaP.toFixed(0)} Pa limit.`,
            fix: 'Open more vent area; the trapped air is pushing the fairing outward.',
          });
        }
      } else if (fairingJustJettisoned) {
        if (this.fairingDeltaP > 1000) {
          const severity: FaultSeverity = this.fairingDeltaP > 5000 ? 'critical' : 'warning';
          this.raise({
            id: 'fairing-jettison-dp',
            system: 'pressure',
            severity,
            t: mt,
            value: this.fairingDeltaP,
            limit: 1000,
            unit: 'Pa',
            title: 'Fairing jettison differential pressure',
            detail: `Fairing separated with ${this.fairingDeltaP.toFixed(0)} Pa of residual differential pressure (limit 1000 Pa).`,
            fix: 'Increase fairing vent area or delay jettison until internal pressure equalises.',
          });
        }
        this.fairingDeltaP = 0;
        this.depressRate = 0;
      }

      if (sim.rt.fairingAttached) {
        hFairingDp = this.fairingDeltaP / f.maxDeltaP;
        hDepressRate = this.depressRate / f.maxDepressRate;
      }
    }

    // 7. payload-heating
    let hPayloadHeat = 0;
    if (this.fairingJettisoned && d.altitude < 200e3) {
      hPayloadHeat = d.fmHeatFlux / (2 * limits.payloadHeatFlux);
      if (d.fmHeatFlux > limits.payloadHeatFlux) {
        const severity: FaultSeverity = d.fmHeatFlux > 2 * limits.payloadHeatFlux ? 'critical' : 'warning';
        this.raise({
          id: 'payload-heating',
          system: 'thermal',
          severity,
          t: mt,
          value: d.fmHeatFlux,
          limit: limits.payloadHeatFlux,
          unit: 'W/m^2',
          title: 'Payload free-molecular heating',
          detail: `Exposed payload free-molecular heat flux reached ${d.fmHeatFlux.toFixed(0)} W/m^2 against a ${limits.payloadHeatFlux.toFixed(0)} W/m^2 limit.`,
          fix: 'Keep the fairing on until free-molecular heating falls below the limit.',
        });
      }
    }

    // 8. skin-temp
    const skinMat = MATERIALS[this.spec.noseSkin.material];
    if ((sim.rt.fairingAttached || !this.vehicle.fairing) && dt > 0) {
      const Tinf = Math.min(300, atmosphereInto(this.air, d.altitude).temperature);
      const Taw = recoveryTemperature(Tinf, d.mach);
      this.skinTemp = skinStep(
        this.skinTemp,
        d.heatFlux,
        Taw,
        dt,
        this.skinCapacity,
        this.spec.noseSkin.emissivity,
      );
      if (this.skinTemp > skinMat.warnTemp) {
        const severity: FaultSeverity = this.skinTemp > skinMat.maxTemp ? 'critical' : 'warning';
        this.raise({
          id: 'skin-temp',
          system: 'thermal',
          severity,
          t: mt,
          value: this.skinTemp,
          limit: skinMat.warnTemp,
          unit: 'K',
          title: 'Nose skin temperature',
          detail: `Nose skin temperature reached ${this.skinTemp.toFixed(1)} K (warning ${skinMat.warnTemp} K, max ${skinMat.maxTemp} K for ${skinMat.name}).`,
          fix: 'Thicken the nose cap or add thermal protection.',
        });
      }
    }
    const hSkin = (this.skinTemp - this.spec.ambientTemp) / (skinMat.maxTemp - this.spec.ambientTemp);

    // 9. separation-q:i
    for (let i = 0; i < this.vehicle.stages.length; i++) {
      if (this.prevAttached[i] && !sim.rt.stages[i].attached) {
        const maxSepQ = this.spec.stages[i].maxSeparationQ;
        if (d.q > maxSepQ) {
          const severity: FaultSeverity = d.q > 5 * maxSepQ ? 'critical' : 'warning';
          const stageName = this.vehicle.stages[i].name;
          this.raise({
            id: `separation-q:${i}`,
            system: 'structure',
            severity,
            stage: i,
            t: mt,
            value: d.q,
            limit: maxSepQ,
            unit: 'Pa',
            title: `${stageName} separation dynamic pressure`,
            detail: `${stageName} separated at dynamic pressure ${d.q.toFixed(0)} Pa against a ${maxSepQ.toFixed(0)} Pa limit.`,
            fix: 'Separating in thick air risks the stages colliding; stage higher.',
          });
        }
      }
      this.prevAttached[i] = sim.rt.stages[i].attached;
    }

    this.prevFairingAttached = sim.rt.fairingAttached;

    const health = this.health;
    const pk = this.peakList;
    health.maxQ = this.track(pk[0], hMaxQ, mt);
    health.qAlpha = this.track(pk[1], hQAlpha, mt);
    health.axialG = this.track(pk[2], hAxialG, mt);
    health.skin = this.track(pk[3], hSkin, mt);
    health.fairingDp = this.track(pk[4], hFairingDp, mt);
    health.depressRate = this.track(pk[5], hDepressRate, mt);
    health.tankBurst = this.track(pk[6], hTankBurst, mt);
    health.caseBurst = this.track(pk[7], hCaseBurst, mt);
    health.tankBuckling = this.track(pk[8], hTankBuckling, mt);
    health.cavitation = this.track(pk[9], hCavitation, mt);
    health.nozzle = this.track(pk[10], hNozzle, mt);
    health.payloadHeat = this.track(pk[11], hPayloadHeat, mt);

    this.channels = {
      skinTemp: this.skinTemp,
      fairingDeltaP: this.fairingDeltaP,
      fairingPressure: this.fairingPressure,
      depressRate: this.depressRate,
    };
  }

  report(): Fault[] {
    return Array.from(this.faults.values()).sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.t - b.t,
    );
  }
}

export function monitored(inner: FlightComputer, monitor: FaultMonitor): FlightComputer {
  return {
    update(sim: Simulation): number | void {
      monitor.observe(sim);
      return inner.update(sim);
    },
  };
}
