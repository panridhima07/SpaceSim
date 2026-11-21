import { DEG } from '../constants.ts';
import type { AscentOptions } from '../gnc/autopilot.ts';
import type { FlightComputer, Simulation } from '../sim/simulation.ts';
import { tankOffsets } from '../vehicle/types.ts';
import type { Fault, FaultMonitor } from './monitor.ts';

// Note: engine-out and gimbal-lock mutate sim.vehicle in place. That is safe only
// because each flight constructs a fresh VehicleSpec; never share a VehicleSpec
// between flights.

export type Failure =
  | { kind: 'engine-out'; stage: number; at: number; engines: number }
  | { kind: 'stage-shutdown'; stage: number; at: number }
  | { kind: 'gimbal-lock'; at: number; stage?: number }
  | { kind: 'leak'; stage: number; tank: number; at: number; rate: number }
  | { kind: 'fairing-stuck' };

function shutdownStage(sim: Simulation, stageIndex: number): void {
  const stage = sim.vehicle.stages[stageIndex];
  if (!stage) return;
  if (stage.engine.thrustCurve) {
    sim.event('warning', `${stage.name}: solid motor cannot be shut down`);
    return;
  }
  const st = sim.rt.stages[stageIndex];
  st.burnedOut = true;
  st.burnoutTime = sim.t;
  sim.shutdown(stageIndex, 'failure');
}

export class FailureInjector {
  private readonly failures: readonly Failure[];
  private readonly triggered: boolean[];
  private lastT = NaN;

  constructor(failures: Failure[]) {
    this.failures = failures.slice();
    this.triggered = this.failures.map(() => false);
  }

  apply(sim: Simulation): void {
    const dt = Number.isFinite(this.lastT) ? sim.t - this.lastT : 0;
    this.lastT = sim.t;

    if (!Number.isFinite(sim.liftoffTime)) return;
    const mt = sim.t - sim.liftoffTime;

    for (let idx = 0; idx < this.failures.length; idx++) {
      const f = this.failures[idx];
      if (f.kind === 'fairing-stuck') continue;
      if (mt < f.at) continue;

      if (f.kind === 'leak') {
        if (!this.triggered[idx]) {
          this.triggered[idx] = true;
          const stage = sim.vehicle.stages[f.stage];
          const tankName = stage?.tanks[f.tank]?.name ?? `tank ${f.tank}`;
          sim.event('failure', `${stage?.name ?? `Stage ${f.stage}`} ${tankName} leak (${f.rate} kg/s)`);
        }
        if (dt > 0) {
          const offs = tankOffsets(sim.vehicle);
          const propIdx = offs[f.stage] + f.tank;
          if (propIdx >= 0 && propIdx < sim.prop.length) {
            sim.prop[propIdx] = Math.max(0, sim.prop[propIdx] - f.rate * dt);
          }
        }
        continue;
      }

      if (this.triggered[idx]) continue;
      this.triggered[idx] = true;

      if (f.kind === 'stage-shutdown') {
        shutdownStage(sim, f.stage);
      } else if (f.kind === 'engine-out') {
        const stage = sim.vehicle.stages[f.stage];
        if (!stage) continue;
        const remaining = Math.max(0, stage.engineCount - f.engines);
        stage.engineCount = remaining;
        if (remaining <= 0) {
          shutdownStage(sim, f.stage);
        } else {
          sim.event('failure', `${stage.name}: ${f.engines} engine(s) out (${remaining} remaining)`);
        }
      } else if (f.kind === 'gimbal-lock') {
        if (f.stage !== undefined) {
          const stage = sim.vehicle.stages[f.stage];
          if (stage) {
            stage.engine.maxGimbal = 0;
            sim.event('failure', `${stage.name}: gimbal lock`);
          }
        } else {
          for (const stage of sim.vehicle.stages) {
            stage.engine.maxGimbal = 0;
          }
          sim.event('failure', 'Gimbal lock on all stages');
        }
      }
    }
  }

  ascentOverrides(): Partial<AscentOptions> {
    if (this.failures.some((f) => f.kind === 'fairing-stuck')) {
      return { fairingHeatFlux: -1 };
    }
    return {};
  }
}

const BREAKUP_PREFIXES = [
  'tank-burst',
  'case-burst',
  'tank-buckling',
  'max-q',
  'q-alpha',
  'fairing-dp',
];

function isBreakupFault(id: string): boolean {
  return BREAKUP_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function supervised(
  inner: FlightComputer,
  parts: { monitor?: FaultMonitor; injector?: FailureInjector; destructive?: boolean },
): FlightComputer {
  let pendingChamberOverpressure: Fault | null = null;
  const cavitatedStages = new Set<number>();

  return {
    update(sim: Simulation): number | void {
      parts.injector?.apply(sim);
      parts.monitor?.observe(sim);

      if (parts.destructive && Number.isFinite(sim.liftoffTime)) {
        const mt = sim.t - sim.liftoffTime;

        if (parts.monitor) {
          const criticals = parts.monitor.drainNewCriticals();
          for (const fault of criticals) {
            if (fault.id.startsWith('chamber-overpressure:')) {
              pendingChamberOverpressure = fault;
            } else if (isBreakupFault(fault.id)) {
              sim.event('breakup', fault.title);
              sim.ended = true;
              return;
            } else if (fault.id.startsWith('cavitation:') && fault.stage !== undefined) {
              if (!cavitatedStages.has(fault.stage)) {
                cavitatedStages.add(fault.stage);
                shutdownStage(sim, fault.stage);
              }
            }
          }
        }

        if (pendingChamberOverpressure && mt >= 3) {
          sim.event('breakup', pendingChamberOverpressure.title);
          sim.ended = true;
          return;
        }

        if (sim.diag.q > 5000 && Math.abs(sim.diag.alpha) > 30 * DEG) {
          sim.event('breakup', 'Aerodynamic breakup: lost attitude control at high dynamic pressure');
          sim.ended = true;
          return;
        }
      }

      return inner.update(sim);
    },
  };
}
