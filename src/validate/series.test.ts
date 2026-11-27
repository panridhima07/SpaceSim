import { describe, it, expect } from 'vitest';
import { extractSeries } from './series';
import { readOrkZip, extractSimulations } from '../ork/orkExtras';
import { parseOrkFile } from '../ork/parser';
import { findMotor, parseEng } from '../ork/motors';
import { aeroProps, dragBreakdown } from '../physics/aero';
import { massProps } from '../physics/massprops';
import type { InnerTube, Motor, MotorRef, RocketModel } from '../types';

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
if (!haveFixture) console.warn('[validate] OpenRocket fixtures missing: run node scripts/fetch-data.mjs; accuracy tests are skipped.');

const SIM_INDEX = 2; // "Simulation 3", Estes C6
const SAMPLES = 10;

function r(v: number, d = 4): number {
  if (!Number.isFinite(v)) return NaN;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function pct(ours: number, ref: number): number {
  if (!Number.isFinite(ours) || !Number.isFinite(ref) || ref === 0) return NaN;
  return ((ours - ref) / ref) * 100;
}

/** Rocket with the motor mount pointing at the given motor, as compare.ts does. */
function withMotorRef(rocket: RocketModel, motor: Motor, delay: number): RocketModel {
  const mounts = rocket.components.filter(
    (c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount,
  );
  const ref: MotorRef = {
    manufacturer: motor.manufacturer,
    designation: motor.designation,
    diameter: motor.diameter,
    length: motor.length,
    delay,
  };
  if (mounts[0]) mounts[0].motor = ref;
  return rocket;
}

describe.skipIf(!haveFixture)('aero and mass vs OpenRocket series (A simple model rocket, sim 3)', () => {
  it('prints OpenRocket vs ours at sampled boost and coast points', async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const { xml, files } = await readOrkZip(bytes);
    const sims = extractSimulations(xml);
    const sim = sims[SIM_INDEX];
    expect(sim.motor?.designation).toBe('C6');

    const series = extractSeries(xml, SIM_INDEX);
    const t = series.time;
    const vel = series.velocity_total;
    expect(t.length).toBeGreaterThan(100);

    const extra: Motor[] = [];
    for (const text of Object.values(files)) {
      try {
        extra.push(...parseEng(text));
      } catch {
        // skip unparseable embedded motor
      }
    }
    const motor = findMotor({ manufacturer: sim.motor!.manufacturer, designation: sim.motor!.designation }, extra);    expect(motor).not.toBeNull();
    if (!motor) return;
    const rocket = withMotorRef(await parseOrkFile(bytes), motor, sim.motor!.delay);

    // Dry structure at t=0: OpenRocket (mass - motor_mass) vs ours with no motor.
    const dryOr = series.mass[0] - series.motor_mass[0];
    const dryOurs = massProps(rocket, null, 0).mass;
    console.table([
      { quantity: 'dry structure mass (kg)', openrocket: r(dryOr, 6), ours: r(dryOurs, 6), err_pct: r(pct(dryOurs, dryOr), 1) },
      { quantity: 'motor mass at t=0 (kg)', openrocket: r(series.motor_mass[0], 6), ours: r(motor.totalMass, 6), err_pct: r(pct(motor.totalMass, series.motor_mass[0]), 1) },
    ]);

    // Samples: boost and coast before apogee, velocity above 5 m/s.
    const apogee = sim.timeToApogee;
    const candidates: number[] = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] > 0 && t[i] < apogee && vel[i] > 5) candidates.push(i);
    }
    const picks: number[] = [];
    for (let k = 0; k < SAMPLES && candidates.length > 0; k++) {
      picks.push(candidates[Math.floor((k * (candidates.length - 1)) / Math.max(1, SAMPLES - 1))]);
    }

    // Per-row Cd error for the bound below: { t, err% }.
    const cdChecks: { t: number; err: number; ref: number }[] = [];
    const rows = picks.map((i) => {
      const mach = series.mach_number[i];
      const tb = t[i];
      const cgOurs = massProps(rocket, motor, tb).cgX;
      const ours = aeroProps(rocket, mach, cgOurs);
      const db = dragBreakdown(rocket, mach);
      const mpOurs = massProps(rocket, motor, tb);
      cdChecks.push({ t: tb, err: pct(ours.cd, series.drag_coeff[i]), ref: series.drag_coeff[i] });
      return {
        't (s)': r(tb, 3),
        Mach: r(mach, 3),
        Re: r(series.reynolds_number[i], 0),
        'Cd OR': r(series.drag_coeff[i], 4),
        'Cd ours': r(ours.cd, 4),
        'Cd err %': r(pct(ours.cd, series.drag_coeff[i]), 1),
        'Cf OR': r(series.friction_drag_coeff[i], 4),
        'Cf ours': r(db.friction, 4),
        'Cp OR': r(series.pressure_drag_coeff[i], 4),
        'Cp ours': r(db.pressure, 4),
        'Cb OR': r(series.base_drag_coeff[i], 4),
        'Cb ours': r(db.base, 4),
        'CP OR (m)': r(series.cp_location[i], 4),
        'CP ours (m)': r(ours.cpX, 4),
        'CNa OR': r(series.cna[i], 3),
        'CNa ours': r(ours.cnAlpha, 3),
        'mass OR (kg)': r(series.mass[i], 5),
        'mass ours (kg)': r(mpOurs.mass, 5),
        'motor OR (kg)': r(series.motor_mass[i], 5),
        'CG OR (m)': r(series.cg_location[i], 4),
        'CG ours (m)': r(mpOurs.cgX, 4),
      };
    });
    console.table(rows);

    expect(rows.length).toBeGreaterThan(0);
    // Bound: 1.5 x the worst valid-row Cd error (1.7%), floored at 5.
    // Excluded: the sample at t=5.05 s, where OpenRocket reports Cd 115.2 with Cf and Cb at zero
    // (a degenerate reference value, not a model error). Only sane reference Cd values are checked.
    const checked = cdChecks.filter((c) => c.ref > 0 && c.ref < 2);
    expect(checked.length).toBeGreaterThan(0);
    for (const c of checked) {
      expect(Math.abs(c.err), `Cd error at t=${c.t}`).toBeLessThan(5);
    }
  });
});
