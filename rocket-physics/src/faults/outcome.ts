import { RE } from '../constants.ts';
import type { AscentAutopilot } from '../gnc/autopilot.ts';
import { propagateToImpact } from '../orbit/propagate.ts';
import type { Simulation } from '../sim/simulation.ts';

export type Outcome = 'nominal' | 'degraded-orbit' | 'suborbital' | 'impact' | 'breakup' | 'pad-abort';

export interface OutcomeReport {
  outcome: Outcome;
  summary: string;
  perigeeAltitude: number;
  apogeeAltitude: number;
  apogeeShortfall: number;
  impact: { latDeg: number; lonDeg: number; t: number } | null;
}

function fmtKm(m: number): string {
  return Number.isFinite(m) ? `${(m / 1e3).toFixed(1)} km` : 'escape';
}

export function classifyOutcome(sim: Simulation, autopilot: AscentAutopilot): OutcomeReport {
  const lifted = Number.isFinite(sim.liftoffTime);
  const targetApogee = autopilot.opts.target.apogeeAltitude ?? autopilot.opts.target.perigeeAltitude;

  let perigeeAltitude = sim.diag.altitude;
  let apogeeAltitude = sim.diag.altitude;
  if (lifted) {
    const el = sim.elements();
    perigeeAltitude = el.rp - RE;
    apogeeAltitude = Number.isFinite(el.ra) ? el.ra - RE : Infinity;
  }

  const breakupEvent = sim.events.find((e) => e.type === 'breakup');
  const impactEvent = sim.events.find((e) => e.type === 'impact');

  let outcome: Outcome;
  if (!lifted) {
    outcome = 'pad-abort';
  } else if (breakupEvent) {
    outcome = 'breakup';
  } else if (impactEvent) {
    outcome = 'impact';
  } else if (autopilot.reachedTarget) {
    outcome = 'nominal';
  } else if (perigeeAltitude >= 120e3) {
    outcome = 'degraded-orbit';
  } else {
    outcome = 'suborbital';
  }

  const apogeeShortfall = outcome === 'nominal' ? 0 : Math.max(0, targetApogee - apogeeAltitude);

  let impact: { latDeg: number; lonDeg: number; t: number } | null = null;
  if (outcome === 'suborbital' || outcome === 'breakup') {
    const hit = propagateToImpact(
      sim.r,
      sim.v,
      sim.t,
      { epochJD: sim.epochJD, gravity: sim.cfg.gravity },
      sim.t + 7200,
    );
    if (hit) {
      impact = { latDeg: hit.latDeg, lonDeg: hit.lonDeg, t: hit.t - sim.liftoffTime };
    }
  }

  const endMt = lifted ? sim.t - sim.liftoffTime : sim.t;
  // A flight that ended on the ground already knows where it came down: the last state.
  const endLatDeg = (sim.diag.lat * 180) / Math.PI;
  const endLonDeg = (sim.diag.lon * 180) / Math.PI;
  if (outcome === 'impact') {
    impact = { latDeg: endLatDeg, lonDeg: endLonDeg, t: endMt };
  }
  let summary: string;
  switch (outcome) {
    case 'pad-abort':
      summary = `Pad abort: vehicle never lifted off (ended at t=${sim.t.toFixed(1)} s).`;
      break;
    case 'breakup':
      summary = `Vehicle breakup at T+${endMt.toFixed(1)} s: ${breakupEvent?.message ?? 'structural failure'}.`;
      break;
    case 'impact':
      summary = `Ground impact at T+${endMt.toFixed(1)} s (${endLatDeg.toFixed(2)} deg N, ${endLonDeg.toFixed(2)} deg E).`;
      break;
    case 'nominal':
      summary = `Nominal orbit insertion at T+${endMt.toFixed(1)} s: ${fmtKm(perigeeAltitude)} x ${fmtKm(apogeeAltitude)}.`;
      break;
    case 'degraded-orbit':
      summary = `Degraded orbit achieved at T+${endMt.toFixed(1)} s: ${fmtKm(perigeeAltitude)} x ${fmtKm(apogeeAltitude)} (apogee short by ${fmtKm(apogeeShortfall)}).`;
      break;
    case 'suborbital':
      summary = `Suborbital trajectory ending at T+${endMt.toFixed(1)} s: apogee ${fmtKm(apogeeAltitude)}, perigee ${fmtKm(perigeeAltitude)}.`;
      break;
  }

  return {
    outcome,
    summary,
    perigeeAltitude,
    apogeeAltitude,
    apogeeShortfall,
    impact,
  };
}
