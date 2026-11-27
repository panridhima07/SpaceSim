// Rule-based design review of a simulated flight. Each rule reads the sampled log
// and the discrete events and emits at most one Flaw (or a small set for per-fin rules).

import {
  G0,
  type Flaw,
  type FlawSeverity,
  type FlightEvent,
  type Motor,
  type RocketModel,
  type SimConfig,
  type SimState,
} from '../types';
import { analyzeEnvironment } from './envFlaws';
import { atmosphere } from './atmosphere';

const SEVERITY_ORDER: Record<FlawSeverity, number> = { critical: 0, warning: 1, info: 2 };
const RAD2DEG = 180 / Math.PI;
const SEA_LEVEL_PRESSURE = 101_325; // Pa
const SOUND_SPEED = 340; // m/s
const AIR_DENSITY = 1.225; // kg/m^3
const DRAG_CD = 0.8;

function findEvent(events: FlightEvent[], type: FlightEvent['type']): FlightEvent | undefined {
  return events.find((e) => e.type === type);
}

/** Log sample closest in time to t. */
function nearestSample(log: SimState[], t: number): SimState | undefined {
  let best: SimState | undefined;
  let bestDt = Infinity;
  for (const s of log) {
    const d = Math.abs(s.t - t);
    if (d < bestDt) {
      bestDt = d;
      best = s;
    }
  }
  return best;
}

/** Shear modulus (Pa) chosen from fin material density (kg/m^3). */
function shearModulus(density: number): number {
  if (density < 300) return 2.6e8; // balsa
  if (density < 800) return 6e8; // plywood-like
  return 2.6e10; // fibreglass / carbon-like
}

/**
 * Flutter speed (m/s) from the classic fin flutter estimate. `air.pressure` is in Pa, so the
 * term x = 1.337 AR^3 P (lambda + 1) / (2 (AR + 2) (t/c)^3) is in Pa and G / x is dimensionless;
 * the flutter speed is then `air.soundSpeed` (m/s) times sqrt(G / x). Infinity if thickness is zero.
 */
function flutterSpeed(
  span: number,
  rootChord: number,
  tipChord: number,
  thickness: number,
  density: number,
  air: { pressure: number; soundSpeed: number },
): number {
  const area = (span * (rootChord + tipChord)) / 2;
  if (area <= 0 || rootChord <= 0 || thickness <= 0) return Infinity;
  const ar = (span * span) / area;
  const lambda = tipChord / rootChord;
  const tc = thickness / rootChord;
  const G = shearModulus(density);
  const x =
    (1.337 * ar ** 3 * air.pressure * (lambda + 1)) / (2 * (ar + 2) * tc ** 3);
  return air.soundSpeed * Math.sqrt(G / x);
}

export function analyzeFlight(
  sim: { log: SimState[]; events: FlightEvent[] },
  rocket: RocketModel,
  motor: Motor | null,
  config: SimConfig,
): Flaw[] {
  const flaws: Flaw[] = [];

  if (!motor) {
    flaws.push({
      id: 'no-motor',
      severity: 'critical',
      title: 'No motor selected',
      detail: 'The rocket has no motor, so there is no flight to analyse.',
      fix: 'Select a motor that fits the motor mount and has a certified thrust curve.',
    });
    return flaws;
  }

  const { log, events } = sim;
  const liftoff = findEvent(events, 'liftoff');
  const railExit = findEvent(events, 'railExit');
  const burnout = findEvent(events, 'burnout');
  const apogee = findEvent(events, 'apogee');
  const chute = findEvent(events, 'chuteDeploy');
  const landing = findEvent(events, 'landing');
  const crash = findEvent(events, 'crash');

  const peakTwr = log.reduce((m, s) => Math.max(m, s.thrust / (s.mass * G0)), 0);

  // Thrust-to-weight on the pad. Never lifting off is critical.
  if (!liftoff) {
    flaws.push({
      id: 'low-twr',
      severity: 'critical',
      title: 'Rocket does not lift off',
      detail: `Peak thrust-to-weight is ${peakTwr.toFixed(2)}, which never exceeds the weight along the launch rail.`,
      fix: 'Use a motor with more thrust for this rocket mass, or reduce mass.',
      value: peakTwr,
      limit: 1,
      unit: 'ratio',
    });
  } else {
    // The mean over the first half second, not the ignition spike, is what moves the rocket.
    const early = log.filter((s) => s.t >= liftoff.t && s.t <= liftoff.t + 0.5);
    const twr = early.reduce((sum, s) => sum + s.thrust / (s.mass * G0), 0) / Math.max(1, early.length);
    if (twr < 5) {
      flaws.push({
        id: 'low-twr',
        severity: 'warning',
        title: 'Low thrust-to-weight at liftoff',
        detail: `Thrust-to-weight averages ${twr.toFixed(2)} in the first 0.5 s after liftoff, so the rocket is slow off the rail.`,
        fix: 'Use a higher-thrust motor or reduce mass so the early thrust-to-weight is at least 5.',
        t: liftoff.t,
        value: twr,
        limit: 5,
        unit: 'ratio',
      });
    }
  }

  // Static stability before apogee, while the rocket is still under powered or ballistic flight.
  const flightEnd = apogee ? apogee.t : Infinity;
  let minCal = Infinity;
  let minCalT = 0;
  let minCp = 0;
  let minCg = 0;
  for (const s of log) {
    if (
      (s.phase === 'rail' || s.phase === 'boost' || s.phase === 'coast') &&
      s.t <= flightEnd &&
      s.stabilityCal < minCal
    ) {
      minCal = s.stabilityCal;
      minCalT = s.t;
      minCp = s.cpX;
      minCg = s.cgX;
    }
  }
  if (Number.isFinite(minCal)) {
    if (minCal < 1.0) {
      flaws.push({
        id: 'unstable',
        severity: 'critical',
        title: minCal < 0 ? 'Unstable: CP ahead of CG' : 'Unstable: stability margin under 1 calibre',
        detail: `The stability margin falls to ${minCal.toFixed(2)} calibres at t = ${minCalT.toFixed(2)} s (CP at ${minCp.toFixed(3)} m, CG at ${minCg.toFixed(3)} m from the nose). An unstable rocket can flip or weathercock badly.`,
        fix: 'Move the CG forward (nose weight) or move the CP aft (larger or further-aft fins) until the margin is at least 1 calibre, ideally 1.5.',
        t: minCalT,
        value: minCal,
        limit: 1,
        unit: 'cal',
      });
    } else if (minCal < 1.5) {
      flaws.push({
        id: 'unstable',
        severity: 'warning',
        title: 'Marginal stability',
        detail: `The stability margin is ${minCal.toFixed(2)} calibres at t = ${minCalT.toFixed(2)} s, which leaves little room for wind gusts.`,
        fix: 'Aim for a margin of 1.5 calibres or more by adding nose weight or enlarging the fins.',
        t: minCalT,
        value: minCal,
        limit: 1.5,
        unit: 'cal',
      });
    }
  }

  if (railExit) {
    const sample = nearestSample(log, railExit.t);
    if (sample && sample.stabilityCal > 3) {
      flaws.push({
        id: 'overstable',
        severity: 'warning',
        title: 'Overstable at rail exit',
        detail: `The stability margin is ${sample.stabilityCal.toFixed(2)} calibres when the rocket leaves the rail, so it will weathercock hard into the wind.`,
        fix: 'Reduce fin area or move fins forward to bring the margin toward 1.5 to 2.5 calibres.',
        t: railExit.t,
        value: sample.stabilityCal,
        limit: 3,
        unit: 'cal',
      });
    }

    const v = railExit.speed;
    if (v < 10) {
      flaws.push({
        id: 'rail-exit-slow',
        severity: 'critical',
        title: 'Rail exit speed too low',
        detail: `The rocket leaves the rail at ${v.toFixed(1)} m/s, below the 10 m/s minimum, so it may not be stable when it leaves the rail.`,
        fix: 'Use a higher-thrust motor, reduce mass, or lengthen the launch rail.',
        t: railExit.t,
        value: v,
        limit: 10,
        unit: 'm/s',
      });
    } else if (v < 15 || v < 4 * config.windSpeed) {
      const limit = v < 15 ? 15 : 4 * config.windSpeed;
      flaws.push({
        id: 'rail-exit-slow',
        severity: 'warning',
        title: 'Marginal rail exit speed',
        detail: `The rocket leaves the rail at ${v.toFixed(1)} m/s; the target is 15 m/s and at least 4 times the wind speed (${(4 * config.windSpeed).toFixed(1)} m/s).`,
        fix: 'Increase thrust-to-weight or lengthen the rail so exit speed is at least 15 m/s and above four times the wind speed.',
        t: railExit.t,
        value: v,
        limit,
        unit: 'm/s',
      });
    }
  }

  // Fin flutter, one check per fin set. Sound speed and pressure are taken at the altitude of
  // the fastest sample (through-air speed, falling back to ground speed); sea level with no log.
  let fastest: SimState | undefined;
  for (const s of log) {
    if (!fastest || (s.airspeed ?? s.speed) > (fastest.airspeed ?? fastest.speed)) fastest = s;
  }
  const air = fastest
    ? atmosphere(config.launchAltitude + fastest.altitude)
    : { pressure: SEA_LEVEL_PRESSURE, soundSpeed: SOUND_SPEED };
  for (const c of rocket.components) {
    if (c.kind !== 'finset') continue;
    const vf = flutterSpeed(c.span, c.rootChord, c.tipChord, c.thickness, c.density, air);
    if (!Number.isFinite(vf)) continue;
    const vMax = log.reduce((m, s) => Math.max(m, s.speed), 0);
    if (vMax > 0.8 * vf) {
      const critical = vMax > vf;
      flaws.push({
        id: `fin-flutter:${c.id}`,
        severity: critical ? 'critical' : 'warning',
        title: critical ? `Fin flutter: ${c.name} fails` : `Fin flutter margin: ${c.name}`,
        detail: `Peak speed ${vMax.toFixed(0)} m/s against an estimated flutter speed of ${vf.toFixed(0)} m/s for ${c.name}.`,
        fix: 'Make the fins thicker, shorten the span, or use a stiffer material (plywood or fibreglass instead of balsa).',
        value: vMax,
        limit: vf,
        unit: 'm/s',
      });
    }
  }

  // Angle of attack during boost.
  let maxAlphaBoost = 0;
  let maxAlphaBoostT = 0;
  for (const s of log) {
    if (s.phase === 'boost' && s.alpha > maxAlphaBoost) {
      maxAlphaBoost = s.alpha;
      maxAlphaBoostT = s.t;
    }
  }
  const aoaDeg = maxAlphaBoost * RAD2DEG;
  if (aoaDeg > 10) {
    flaws.push({
      id: 'high-aoa',
      severity: aoaDeg > 30 ? 'critical' : 'warning',
      title: aoaDeg > 30 ? 'Very high angle of attack under thrust' : 'High angle of attack under thrust',
      detail: `Angle of attack reaches ${aoaDeg.toFixed(1)} degrees at t = ${maxAlphaBoostT.toFixed(2)} s during boost, so drag and bending loads rise sharply.`,
      fix: 'Improve stability, reduce wind exposure by flying in calmer conditions, or move the CG forward.',
      t: maxAlphaBoostT,
      value: aoaDeg,
      limit: aoaDeg > 30 ? 30 : 10,
      unit: 'deg',
    });
  }

  if (chute) {
    const v = chute.speed;
    if (v > 20) {
      const critical = v > 35;
      let fix = 'Delay the ejection charge so the canopy opens nearer apogee, or use a bigger canopy.';
      if (burnout && apogee) {
        const ideal = apogee.t - burnout.t;
        fix = `Set the ejection delay to about ${ideal.toFixed(1)} s (time from burnout to apogee) so the canopy opens near apogee, or use an apogee-triggered chute.`;
      }
      flaws.push({
        id: 'deploy-speed',
        severity: critical ? 'critical' : 'warning',
        title: critical ? 'Zipper risk: deployment speed too high' : 'High speed at parachute deployment',
        detail: `The canopy opens at ${v.toFixed(1)} m/s, which risks a zipper failure or a torn canopy.`,
        fix,
        t: chute.t,
        value: v,
        limit: critical ? 35 : 20,
        unit: 'm/s',
      });
    }
  }

  if (crash && !chute) {
    flaws.push({
      id: 'no-deploy',
      severity: 'critical',
      title: 'No parachute deployed',
      detail: `The rocket hits the ground at ${crash.speed.toFixed(1)} m/s with no recovery system.`,
      fix: 'Add a parachute with a deploy event that fires near apogee, and check the ejection delay.',
      t: crash.t,
      value: crash.speed,
      unit: 'm/s',
    });
  }

  if (landing && landing.speed > 6) {
    const finalMass = log.length ? log[log.length - 1].mass : 0;
    const areaFor5 = (2 * finalMass * G0) / (AIR_DENSITY * DRAG_CD * 25);
    const dReq = Math.sqrt((4 * areaFor5) / Math.PI);
    flaws.push({
      id: 'hard-landing',
      severity: 'warning',
      title: 'Hard landing',
      detail: `Touchdown at ${landing.speed.toFixed(1)} m/s. A canopy about ${dReq.toFixed(2)} m across would bring the ${finalMass.toFixed(3)} kg rocket down at 5 m/s.`,
      fix: `Use a canopy of at least ${dReq.toFixed(2)} m diameter, or add drag area.`,
      t: landing.t,
      value: landing.speed,
      limit: 6,
      unit: 'm/s',
    });
  }

  let maxG = 0;
  for (const s of log) maxG = Math.max(maxG, s.accelG);
  if (maxG > 15) {
    flaws.push({
      id: 'high-g',
      severity: maxG > 30 ? 'warning' : 'info',
      title: 'High acceleration load',
      detail: `Peak non-gravitational acceleration is ${maxG.toFixed(1)} g, which stresses the airframe and motor retention.`,
      fix: 'Check the airframe and motor mount for this load. A lower-impulse motor reduces it.',
      value: maxG,
      limit: maxG > 30 ? 30 : 15,
      unit: 'g',
    });
  }

  let maxMach = 0;
  let maxAlphaOutside = 0;
  for (const s of log) {
    maxMach = Math.max(maxMach, s.mach);
    if (s.phase !== 'descent' && s.phase !== 'landed' && s.phase !== 'crashed') {
      maxAlphaOutside = Math.max(maxAlphaOutside, s.alpha);
    }
  }
  const alphaOutsideDeg = maxAlphaOutside * RAD2DEG;
  const reasons: string[] = [];
  if (maxMach > 0.8) {
    reasons.push(
      `peak Mach ${maxMach.toFixed(2)} is above 0.8, where transonic and supersonic drag is an uncalibrated estimate`,
    );
  }
  if (alphaOutsideDeg > 15) reasons.push(`angle of attack reaches ${alphaOutsideDeg.toFixed(1)} degrees outside descent`);
  if (reasons.length) {
    flaws.push({
      id: 'low-confidence',
      severity: 'info',
      title: 'Simulation less reliable in this regime',
      detail: `The Barrowman-style aerodynamics assume subsonic, small-angle flight, and ${reasons.join(' and ')}.`,
      fix: 'Treat the predicted loads and apogee with caution, or confirm them with a flight test or a CFD study.',
      value: maxMach > 0.8 ? maxMach : alphaOutsideDeg,
      limit: maxMach > 0.8 ? 0.8 : 15,
      unit: maxMach > 0.8 ? 'Mach' : 'deg',
    });
  }

  if (landing && log.length) {
    const last = log[log.length - 1];
    // The pad sits directly below the launch site at x = z = 0.
    const drift = Math.sqrt(last.pos[0] ** 2 + last.pos[2] ** 2);
    if (drift > 500) {
      flaws.push({
        id: 'drift',
        severity: 'info',
        title: 'Large drift',
        detail: `The rocket lands ${drift.toFixed(0)} m from the pad, which may take it out of a recovery area.`,
        fix: 'Fly in lower wind, reduce the flight time under canopy, or plan a larger recovery area.',
        t: landing.t,
        value: drift,
        limit: 500,
        unit: 'm',
      });
    }
  }

  flaws.push(...analyzeEnvironment(sim, rocket, config));

  return flaws.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
