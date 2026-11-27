// Motor parsing, built-in motor table, and thrust / propellant helpers.
// All outputs use SI units (m, kg, s, N, N s) as defined in src/types.ts.

import type { Motor } from '../types';
import motorData from './motorData.json';

export type MotorCurve = [number, number][];

// ---------- RASP .eng parsing ----------

/**
 * Parse RASP .eng text. A file may contain several motors.
 *
 * Header: `name diameter(mm) length(mm) delays propellantWeight(g) totalWeight(g) manufacturer`
 * Note: the RASP format records masses in grams even though some docs label them kg;
 * this parser treats them as grams.
 */
export function parseEng(text: string): Motor[] {
  const motors: Motor[] = [];
  let header: string[] | null = null;
  let curve: MotorCurve = [];
  let finished = false;

  const flush = () => {
    if (header && curve.length > 0) {
      const motor = buildMotor(header, curve);
      if (motor) motors.push(motor);
    }
    header = null;
    curve = [];
    finished = false;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';')) continue;
    const tokens = line.split(/\s+/);

    if (tokens.length >= 6 && isNum(tokens[1]) && isNum(tokens[2])) {
      flush();
      header = tokens;
      continue;
    }

    if (tokens.length >= 2 && isNum(tokens[0]) && isNum(tokens[1])) {
      if (!header || finished) continue;
      const t = Number(tokens[0]);
      const f = Number(tokens[1]);
      curve.push([t, f]);
      // Burn-out is the first zero-thrust point after the motor has fired.
      if (f === 0 && curve.some(([, thrust]) => thrust > 0)) finished = true;
    }
  }
  flush();
  return motors;
}

function isNum(s: string): boolean {
  return s !== '' && Number.isFinite(Number(s));
}

function buildMotor(header: string[], points: MotorCurve): Motor | null {
  const [name, diaMm, lenMm, , propG, totalG] = header;
  const manufacturer = header.slice(6).join(' ');

  const curve: MotorCurve = points.map(([t, f]) => [t, f] as [number, number]);
  if (curve[0][0] > 0) curve.unshift([0, 0]);
  if (curve[curve.length - 1][1] !== 0) {
    curve.push([curve[curve.length - 1][0], 0]);
  }

  const burnTime = curve[curve.length - 1][0];
  const motor: Motor = {
    manufacturer,
    designation: name,
    diameter: Number(diaMm) / 1000,
    length: Number(lenMm) / 1000,
    totalMass: Number(totalG) / 1000,
    propellantMass: Number(propG) / 1000,
    curve,
    burnTime,
    totalImpulse: trapezoid(curve),
    approximate: false,
  };
  return usableMotor(motor) ? motor : null;
}

/** A motor the simulator can fly: finite, positive sizes and impulse, sane masses, ordered curve. */
export function usableMotor(m: Motor): boolean {
  const positive = (x: number) => Number.isFinite(x) && x > 0;
  if (![m.diameter, m.length, m.totalImpulse, m.burnTime].every(positive)) return false;
  if (!Number.isFinite(m.propellantMass) || m.propellantMass < 0) return false;
  if (!Number.isFinite(m.totalMass) || m.totalMass < m.propellantMass) return false;
  if (!Array.isArray(m.curve) || m.curve.length === 0) return false;

  let prevT = -Infinity;
  for (const [t, f] of m.curve) {
    if (!Number.isFinite(t) || !Number.isFinite(f) || f < 0) return false;
    if (t < prevT) return false;
    prevT = t;
  }
  return true;
}

// ---------- Integration helpers ----------

function trapezoid(curve: MotorCurve): number {
  let sum = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const [t0, f0] = curve[i];
    const [t1, f1] = curve[i + 1];
    sum += ((f0 + f1) / 2) * (t1 - t0);
  }
  return sum;
}

/** Impulse delivered from t=0 up to tEnd (tEnd clamped to the curve span). */
function impulseTo(curve: MotorCurve, tEnd: number): number {
  let sum = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const [t0, f0] = curve[i];
    const [t1, f1] = curve[i + 1];
    if (tEnd <= t0) break;
    if (tEnd >= t1) {
      sum += ((f0 + f1) / 2) * (t1 - t0);
    } else {
      const fAtEnd = f0 + ((f1 - f0) * (tEnd - t0)) / (t1 - t0);
      sum += ((f0 + fAtEnd) / 2) * (tEnd - t0);
      break;
    }
  }
  return sum;
}

// ---------- Built-in motor table ----------

interface BuiltinSpec {
  manufacturer: string;
  designation: string;
  /** Diameter, mm. */
  dMm: number;
  /** Length, mm. */
  lMm: number;
  /** Total impulse, N s (the curve is scaled to match this exactly). */
  impulse: number;
  /** Burn time, s. */
  burn: number;
  /** Peak thrust, N. */
  peak: number;
  /** Plateau (sustain) thrust before scaling, N. */
  sustain: number;
  /** Time of the initial spike, s. */
  spikeT: number;
  /** Propellant mass, g. */
  propG: number;
  /** Loaded total motor mass, g. */
  totalG: number;
}

/**
 * Build a thrust curve from key points: a ramp to an initial spike, a decay to a
 * plateau, a tail-off, and zero at burn-out. The whole curve is then scaled so
 * the trapezoid integral equals the published total impulse.
 */
function curveFromSpec(s: BuiltinSpec): MotorCurve {
  const b = s.burn;
  const keyPoints: [number, number][] = [
    [0, 0],
    [s.spikeT, s.peak],
    [Math.min(s.spikeT * 2.5, b * 0.3), s.sustain * 1.15],
    [b * 0.9, s.sustain],
    [b * 0.97, s.sustain * 0.5],
    [b, 0],
  ];
  const raw = trapezoid(keyPoints);
  const scale = s.impulse / raw;
  return keyPoints.map(([t, f]) => [t, f * scale] as [number, number]);
}

function builtin(s: BuiltinSpec): Motor {
  const curve = curveFromSpec(s);
  return {
    manufacturer: s.manufacturer,
    designation: s.designation,
    diameter: s.dMm / 1000,
    length: s.lMm / 1000,
    totalMass: s.totalG / 1000,
    propellantMass: s.propG / 1000,
    curve,
    burnTime: s.burn,
    totalImpulse: s.impulse,
    approximate: true,
  };
}

const BUILTIN_SPECS: BuiltinSpec[] = [
  // Estes A-E: figures are approximate. C6 and D12 follow published totals.
  { manufacturer: 'Estes', designation: 'A8', dMm: 18, lMm: 70, impulse: 2.5, burn: 0.8, peak: 8.5, sustain: 2.8, spikeT: 0.1, propG: 3.3, totalG: 16.6 },
  { manufacturer: 'Estes', designation: 'B6', dMm: 18, lMm: 70, impulse: 4.9, burn: 0.9, peak: 11, sustain: 4.0, spikeT: 0.1, propG: 5.3, totalG: 21 },
  { manufacturer: 'Estes', designation: 'C6', dMm: 18, lMm: 70, impulse: 8.8, burn: 1.86, peak: 14, sustain: 4.5, spikeT: 0.2, propG: 12.5, totalG: 24 },
  { manufacturer: 'Estes', designation: 'D12', dMm: 24, lMm: 70, impulse: 16.8, burn: 1.65, peak: 30, sustain: 9.5, spikeT: 0.1, propG: 21, totalG: 42 },
  { manufacturer: 'Estes', designation: 'E12', dMm: 24, lMm: 70, impulse: 31, burn: 2.2, peak: 35, sustain: 13, spikeT: 0.15, propG: 33, totalG: 57 },
  // Aerotech F-J: figures are rough estimates, not certified data.
  { manufacturer: 'Aerotech', designation: 'F40', dMm: 29, lMm: 124, impulse: 112, burn: 2.8, peak: 60, sustain: 36, spikeT: 0.15, propG: 110, totalG: 190 },
  { manufacturer: 'Aerotech', designation: 'G80', dMm: 29, lMm: 124, impulse: 230, burn: 2.5, peak: 110, sustain: 90, spikeT: 0.15, propG: 150, totalG: 260 },
  { manufacturer: 'Aerotech', designation: 'H128', dMm: 29, lMm: 124, impulse: 490, burn: 3.8, peak: 160, sustain: 120, spikeT: 0.15, propG: 230, totalG: 420 },
  { manufacturer: 'Aerotech', designation: 'I284', dMm: 38, lMm: 240, impulse: 1150, burn: 4.1, peak: 330, sustain: 260, spikeT: 0.2, propG: 500, totalG: 850 },
  { manufacturer: 'Aerotech', designation: 'J350', dMm: 54, lMm: 300, impulse: 2450, burn: 7.0, peak: 480, sustain: 340, spikeT: 0.25, propG: 900, totalG: 1500 },
];

export const BUILTIN_MOTORS: Motor[] = BUILTIN_SPECS.map(builtin);

// ---------- Certified motors ----------

/** Shape of motorData.json before the curve tuples are typed. */
interface RawMotor extends Omit<Motor, 'curve'> {
  curve: number[][];
}

/** Certified thrust curves fetched from ThrustCurve.org by scripts/fetch-data.mjs. */
export const CERTIFIED_MOTORS: Motor[] = (motorData as unknown as RawMotor[]).map((m) => ({
  ...m,
  curve: m.curve.map(([t, f]) => [t, f] as [number, number]),
}));

// ---------- Lookup ----------

/**
 * Reduce a designation to its core code: "C6-5" -> "C6", "Estes C6" -> "C6",
 * "c6" -> "C6", "F40-4" -> "F40". Falls back to the alphanumeric string.
 */
export function designationKey(s: string): string {
  const upper = s.toUpperCase().trim();
  const tokens = upper.split(/[\s\-_/]+/).filter(Boolean);
  const code = tokens.find((t) => /^[A-Z]\d+[A-Z]?$/.test(t));
  return code ?? upper.replace(/[^A-Z0-9]/g, '');
}

/**
 * Every known motor: certified data, plus built-in approximations whose designation
 * has no certified curve. Sorted by total impulse.
 */
export const ALL_MOTORS: Motor[] = (() => {
  const certifiedKeys = new Set(CERTIFIED_MOTORS.map((m) => designationKey(m.designation)));
  const approximations = BUILTIN_MOTORS.filter(
    (m) => !certifiedKeys.has(designationKey(m.designation)),
  );
  return [...CERTIFIED_MOTORS, ...approximations].sort((a, b) => a.totalImpulse - b.totalImpulse);
})();

/**
 * Find a motor by designation (case-insensitive, delay suffix and manufacturer prefix
 * ignored). Search order: `extra`, then certified motors, then the approximate built-in
 * table as a last resort. Within that order, when a manufacturer is given, a candidate
 * from that manufacturer is preferred over any other match.
 */
export function findMotor(
  ref: { manufacturer?: string; designation: string },
  extra: Motor[] = [],
): Motor | null {
  const key = designationKey(ref.designation);
  const candidates = [...extra, ...CERTIFIED_MOTORS, ...BUILTIN_MOTORS].filter(
    (m) => designationKey(m.designation) === key,
  );
  if (candidates.length === 0) return null;

  if (ref.manufacturer) {
    const want = ref.manufacturer.trim().toLowerCase();
    const match = candidates.find((m) => m.manufacturer.trim().toLowerCase() === want);
    if (match) return match;
  }
  return candidates[0];
}

// ---------- Runtime helpers ----------

/** Thrust in N at tBurn seconds after ignition. Zero outside [0, burnTime]. */
export function thrustAt(motor: Motor, tBurn: number): number {
  const curve = motor.curve;
  if (tBurn < 0 || tBurn > motor.burnTime || curve.length === 0) return 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const [t0, f0] = curve[i];
    const [t1, f1] = curve[i + 1];
    if (tBurn <= t1) {
      if (t1 === t0) return f1;
      return f0 + ((f1 - f0) * (tBurn - t0)) / (t1 - t0);
    }
  }
  return curve[curve.length - 1][1];
}

/**
 * Propellant mass (kg) remaining at tBurn, proportional to the impulse not yet delivered.
 */
export function propellantRemaining(motor: Motor, tBurn: number): number {
  if (tBurn <= 0) return motor.propellantMass;
  if (tBurn >= motor.burnTime) return 0;
  const delivered = impulseTo(motor.curve, tBurn);
  const fraction = Math.min(1, Math.max(0, delivered / motor.totalImpulse));
  return motor.propellantMass * (1 - fraction);
}
