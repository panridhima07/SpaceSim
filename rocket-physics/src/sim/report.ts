// Helpers that run a whole flight and summarise it.

import { RE } from '../constants.ts';
import { AscentAutopilot, type AscentOptions } from '../gnc/autopilot.ts';
import { deltaVBudget, usablePropellant } from '../vehicle/massprops.ts';
import type { VehicleSpec } from '../vehicle/types.ts';
import { propagateToImpact } from '../orbit/propagate.ts';
import { Simulation, type SimConfig } from './simulation.ts';

export interface FlightResult {
  sim: Simulation;
  autopilot: AscentAutopilot;
  reachedTarget: boolean;
  /** Usable propellant left in the final stage at the end, kg. */
  propellantMargin: number;
  perigeeAltitude: number;
  apogeeAltitude: number;
  inclinationDeg: number;
}

/** Fly a complete ascent (and any maneuver nodes) under the autopilot. */
export function flyAscent(vehicle: VehicleSpec, cfg: SimConfig, opts: AscentOptions, tMax = 6000): FlightResult {
  const autopilot = new AscentAutopilot(opts);
  const sim = new Simulation(vehicle, cfg, autopilot);
  sim.run(tMax, () => autopilot.phase === 'done' || autopilot.phase === 'aborted');
  const el = sim.elements();
  const last = sim.lowestCore();
  return {
    sim,
    autopilot,
    reachedTarget: autopilot.reachedTarget,
    propellantMargin: last >= 0 ? usablePropellant(vehicle, last, sim.prop) : 0,
    perigeeAltitude: el.rp - RE,
    apogeeAltitude: el.ra - RE,
    inclinationDeg: (el.i * 180) / Math.PI,
  };
}

/**
 * Find the pitch-kick angle that leaves the most propellant in the final stage: the
 * classic one-parameter ascent optimisation. Too small a kick flies too steep and wastes
 * fuel fighting gravity; too large flies too flat and wastes it on drag (or hits the ground).
 */
export function tunePitchKick(
  vehicle: VehicleSpec,
  cfg: SimConfig,
  opts: AscentOptions,
  range: [number, number] = [0.5, 12],
  samples = 12,
): { pitchKickDeg: number; result: FlightResult } {
  const score = (kick: number): { s: number; res: FlightResult } => {
    const res = flyAscent(vehicle, cfg, { ...opts, pitchKickDeg: kick, nodes: [] });
    // Reaching orbit with fuel to spare beats falling short; falling short is ranked by apogee energy.
    const s = res.reachedTarget ? 1e9 + res.propellantMargin : res.sim.elements().energy;
    return { s, res };
  };
  let best = { kick: range[0], ...score(range[0]) };
  for (let k = 1; k < samples; k++) {
    const kick = range[0] + ((range[1] - range[0]) * k) / (samples - 1);
    const sc = score(kick);
    if (sc.s > best.s) best = { kick, ...sc };
  }
  // Refine around the best sample by golden-section search.
  const step = (range[1] - range[0]) / (samples - 1);
  let lo = Math.max(range[0], best.kick - step);
  let hi = Math.min(range[1], best.kick + step);
  const gr = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - gr * (hi - lo);
  let x2 = lo + gr * (hi - lo);
  let f1 = score(x1);
  let f2 = score(x2);
  for (let i = 0; i < 8; i++) {
    if (f1.s > f2.s) {
      hi = x2; x2 = x1; f2 = f1;
      x1 = hi - gr * (hi - lo);
      f1 = score(x1);
    } else {
      lo = x1; x1 = x2; f1 = f2;
      x2 = lo + gr * (hi - lo);
      f2 = score(x2);
    }
    if (f1.s > best.s) best = { kick: x1, ...f1 };
    if (f2.s > best.s) best = { kick: x2, ...f2 };
  }
  return { pitchKickDeg: best.kick, result: best.res };
}

/** Where each dropped stage comes down (ballistic, with drag). */
export function debrisImpacts(sim: Simulation): { name: string; latDeg: number; lonDeg: number; t: number }[] {
  const out: { name: string; latDeg: number; lonDeg: number; t: number }[] = [];
  for (const d of sim.debris) {
    const hit = propagateToImpact(d.r, d.v, d.t, { epochJD: sim.epochJD, gravity: sim.cfg.gravity, drag: { cdAOverM: (1.0 * d.refArea) / d.mass } }, d.t + 7200);
    if (hit) out.push({ name: d.name, latDeg: hit.latDeg, lonDeg: hit.lonDeg, t: hit.t });
  }
  return out;
}

const pad = (s: string | number, n: number): string => String(s).padStart(n);

/** A plain-text flight report: budget, event timeline, sampled telemetry and the final orbit. */
export function formatReport(res: FlightResult, every = 20): string {
  const { sim } = res;
  const lines: string[] = [];
  lines.push(`Vehicle: ${sim.vehicle.name}`);
  lines.push(`Site: ${sim.cfg.site.name ?? ''} (${sim.cfg.site.latDeg} N, ${sim.cfg.site.lonDeg} E)`);
  lines.push('', 'Ideal delta-v budget (vacuum, core stages):');
  for (const b of deltaVBudget(sim.vehicle)) {
    lines.push(`  ${b.stage.padEnd(22)} ${pad(b.deltaV.toFixed(0), 6)} m/s   burn ${pad(b.burnTime.toFixed(0), 4)} s   T/W ${b.twr.toFixed(2)}`);
  }
  lines.push('', 'Events:');
  for (const e of sim.events) lines.push(`  T+${pad((e.t - sim.liftoffTime).toFixed(1), 8)} s  ${e.message}`);
  lines.push('', '   T+ s   alt km  speed m/s   Mach    q kPa   g   pitch  mass t   apo km   peri km');
  let next = 0;
  for (const s of sim.log) {
    const tl = s.t - sim.liftoffTime;
    if (!(tl >= next)) continue;
    next = tl + every;
    lines.push(
      `${pad(tl.toFixed(0), 7)} ${pad((s.altitude / 1000).toFixed(1), 8)} ${pad(s.speed.toFixed(0), 10)} ${pad(s.mach.toFixed(2), 6)} ${pad((s.q / 1000).toFixed(2), 8)} ${pad(s.accelG.toFixed(2), 5)} ${pad(s.pitchDeg.toFixed(1), 6)} ${pad((s.mass / 1000).toFixed(1), 7)} ${pad((s.apoapsis / 1000).toFixed(0), 8)} ${pad((s.periapsis / 1000).toFixed(0), 9)}`,
    );
  }
  lines.push('');
  lines.push(`Max Q        ${(sim.maxQ.value / 1000).toFixed(1)} kPa at T+${(sim.maxQ.t - sim.liftoffTime).toFixed(0)} s, ${(sim.maxQ.altitude / 1000).toFixed(1)} km`);
  lines.push(`Max g        ${sim.maxG.value.toFixed(2)}`);
  lines.push(`Peak heating ${(sim.maxHeatFlux.value / 1000).toFixed(0)} kW/m^2, heat load ${(sim.heatLoad / 1e6).toFixed(1)} MJ/m^2`);
  lines.push(`Delta-v spent ${sim.dvExpended.toFixed(0)} m/s`);
  lines.push(`Final orbit  ${(res.perigeeAltitude / 1000).toFixed(1)} x ${(res.apogeeAltitude / 1000).toFixed(1)} km, inclination ${res.inclinationDeg.toFixed(2)} deg`);
  lines.push(`Target ${res.reachedTarget ? 'reached' : 'NOT reached'}; ${res.propellantMargin.toFixed(0)} kg usable propellant left`);
  return lines.join('\n');
}
