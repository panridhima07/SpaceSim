// Diagnostic: compares the motor OpenRocket actually flew (its stored thrust_force / motor_mass
// series) with (a) the embedded .rse motor from the same .ork and (b) our database motor.
// Prints tables only; asserts just that the fixture produced rows.

import { describe, it, expect } from 'vitest';
import { findMotor } from '../ork/motors';
import { embeddedMotors } from '../ork/rse';
import { extractSimulations, readOrkZip, type OrkSimulation } from '../ork/orkExtras';
import { extractSeries } from './series';
import type { Motor } from '../types';

// Node modules are loaded through variable specifiers so the typecheck does not need @types/node.
const NODE_FS = 'node:fs';
const NODE_URL = 'node:url';
type NodeFs = { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array };
const fs = (await import(/* @vite-ignore */ NODE_FS)) as unknown as NodeFs;
const { fileURLToPath } = (await import(/* @vite-ignore */ NODE_URL)) as unknown as {
  fileURLToPath(u: URL): string;
};

const FIXTURE = fileURLToPath(
  new URL('../../fixtures/external/A_simple_model_rocket.ork', import.meta.url),
);
const haveFixture = fs.existsSync(FIXTURE);

interface MotorNumbers {
  /** Total impulse, N s. */
  impulse: number;
  /** Burn time (last instant with thrust > 0), s. */
  burn: number;
  /** Peak thrust, N. */
  peak: number;
  /** Loaded mass at ignition, kg. */
  mass0: number;
}

function trapezoidSeries(t: number[], f: number[]): number {
  let sum = 0;
  for (let i = 0; i < t.length - 1; i++) {
    const dt = t[i + 1] - t[i];
    const a = f[i];
    const b = f[i + 1];
    if (!Number.isFinite(dt) || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    sum += ((a + b) / 2) * dt;
  }
  return sum;
}

/** Numbers from OpenRocket's stored series for one simulation. */
function fromOpenRocket(series: Record<string, number[]>): MotorNumbers {
  const t = series['time'] ?? [];
  const f = series['thrust_force'] ?? [];
  const m = series['motor_mass'] ?? [];
  let burn = 0;
  let peak = 0;
  for (let i = 0; i < f.length; i++) {
    if (Number.isFinite(f[i]) && f[i] > 0 && Number.isFinite(t[i])) burn = Math.max(burn, t[i]);
    if (Number.isFinite(f[i]) && f[i] > peak) peak = f[i];
  }
  const mass0 = m.find((v) => Number.isFinite(v)) ?? NaN;
  return { impulse: trapezoidSeries(t, f), burn, peak, mass0 };
}

/** Numbers from one of our Motor records. */
function fromMotor(m: Motor | null): MotorNumbers | null {
  if (!m) return null;
  let peak = 0;
  for (const [, f] of m.curve) if (f > peak) peak = f;
  return { impulse: m.totalImpulse, burn: m.burnTime, peak, mass0: m.totalMass };
}

function r(v: number | undefined, digits = 3): number {
  if (v === undefined || !Number.isFinite(v)) return NaN;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

describe.skipIf(!haveFixture)('motor check: OpenRocket flown motor vs embedded vs database', () => {
  it('tabulates impulse, burn time, peak thrust and initial mass per simulation', async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const { xml, files } = await readOrkZip(bytes);
    const sims: OrkSimulation[] = extractSimulations(xml);
    const embedded = embeddedMotors(files);

    const rows: Record<string, string | number>[] = [];
    sims.forEach((sim, i) => {
      const or = fromOpenRocket(extractSeries(xml, i));
      const ref = sim.motor
        ? { manufacturer: sim.motor.manufacturer, designation: sim.motor.designation }
        : null;

      const emb = ref ? findMotor(ref, embedded) : null;
      const embIsEmbedded = emb !== null && embedded.includes(emb);
      const db = ref ? findMotor(ref) : null;
      const e = fromMotor(embIsEmbedded ? emb : null);
      const d = fromMotor(db);

      rows.push({
        sim: sim.name,
        motor: ref ? `${ref.manufacturer} ${ref.designation}` : '(none)',
        'OR impulse (Ns)': r(or.impulse),
        'OR burn (s)': r(or.burn),
        'OR peak (N)': r(or.peak),
        'OR mass0 (kg)': r(or.mass0, 5),
        'emb impulse': r(e?.impulse),
        'emb burn': r(e?.burn),
        'emb peak': r(e?.peak),
        'emb mass0': r(e?.mass0, 5),
        'db impulse': r(d?.impulse),
        'db burn': r(d?.burn),
        'db peak': r(d?.peak),
        'db mass0': r(d?.mass0, 5),
        'db approx': db ? String(db.approximate) : '',
      });
    });

    console.table(rows);

    expect(sims.length).toBeGreaterThan(0);
    expect(rows.length).toBe(sims.length);
  }, 60_000);
});
