import { describe, it, expect } from 'vitest';
import { parseOrkFile } from '../ork/parser';
import { extractSimulations, readOrkZip } from '../ork/orkExtras';
import { embeddedMotors } from '../ork/rse';
import { findMotor } from '../ork/motors';
import { massProps } from '../physics/massprops';
import { aeroProps } from '../physics/aero';
import type { InnerTube } from '../types';

// Round 5: our static aerodynamics against the values OpenRocket stored, row by row, in the
// flight data of its own example files (columns cna, cp_location, stability). OpenRocket's
// cna and CP include body lift at the current angle of attack, so ours is compared the same
// way: CNα + K (A_planform / A_ref) sin(aoa), acting at the CP and the planform centroid.
// Skips when the GPL example files are not downloaded (node scripts/fetch-data.mjs).

const NODE_FS = 'node:fs';
const NODE_URL = 'node:url';
type NodeFs = { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array };
const fs = (await import(/* @vite-ignore */ NODE_FS)) as unknown as NodeFs;
const { fileURLToPath } = (await import(/* @vite-ignore */ NODE_URL)) as unknown as {
  fileURLToPath(u: URL): string;
};

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/external/${name}.ork`, import.meta.url));

interface Worst {
  rows: number;
  cna: number;
  cpCal: number;
  marginCal: number;
}

/** Worst errors over the stored rows at low Mach and small angle of attack before `tMax`. */
async function compare(name: string, tMax: number): Promise<Worst> {
  const bytes = fs.readFileSync(fixture(name));
  const { xml, files } = await readOrkZip(bytes);
  const sims = extractSimulations(xml);
  const extra = embeddedMotors(files);
  const rocket = await parseOrkFile(bytes);
  const mount = rocket.components.find((c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount);
  const worst: Worst = { rows: 0, cna: 0, cpCal: 0, marginCal: 0 };

  // extractSimulations keeps only simulations with flight data, in document order.
  const branches = xml
    .split('<simulation')
    .slice(1)
    .map((s) => ({ s, types: /<databranch[^>]*types="([^"]*)"/.exec(s)?.[1] }))
    .filter((b) => b.types);

  branches.forEach(({ s, types }, k) => {
    const sim = sims[k];
    const motor = sim?.motor ? findMotor({ manufacturer: sim.motor.manufacturer, designation: sim.motor.designation }, extra) : null;
    if (!motor || !mount) return;
    mount.motor = { manufacturer: motor.manufacturer, designation: motor.designation, diameter: motor.diameter, length: motor.length, delay: 0 };
    const cols = (types as string).split(',');
    const at = (row: number[], col: string): number => row[cols.indexOf(col)];
    for (const m of s.matchAll(/<datapoint>([^<]*)<\/datapoint>/g)) {
      const row = m[1].split(',').map(Number);
      const M = at(row, 'mach_number');
      const aoa = at(row, 'aoa');
      const t = at(row, 'time');
      if (!(M > 0.05 && M < 0.3 && aoa < (4 * Math.PI) / 180 && t < tMax && Number.isFinite(at(row, 'cna')))) continue;
      const mp = massProps(rocket, motor, t);
      const ap = aeroProps(rocket, M, mp.cgX);
      const body = (ap.bodyLift ?? 0) * Math.sin(aoa);
      const cna = ap.cnAlpha + body;
      const cp = (ap.cnAlpha * ap.cpX + body * (ap.bodyLiftX ?? ap.cpX)) / cna;
      worst.rows++;
      worst.cna = Math.max(worst.cna, Math.abs(cna / at(row, 'cna') - 1));
      worst.cpCal = Math.max(worst.cpCal, Math.abs(cp - at(row, 'cp_location')) / ap.refLength);
      worst.marginCal = Math.max(worst.marginCal, Math.abs((cp - mp.cgX) / ap.refLength - at(row, 'stability')));
    }
  });
  return worst;
}

const single = [
  { name: 'A_simple_model_rocket', cna: 0.04, cp: 0.1, margin: 0.3 },
  { name: 'Dual_parachute_deployment', cna: 0.05, cp: 0.2, margin: 0.35 },
];

describe('aerodynamics vs OpenRocket stored flight data', () => {
  for (const d of single) {
    it.skipIf(!fs.existsSync(fixture(d.name)))(`${d.name}: CNα, CP and margin`, async () => {
      const w = await compare(d.name, 3);
      expect(w.rows).toBeGreaterThan(50);
      expect(w.cna).toBeLessThan(d.cna);
      expect(w.cpCal).toBeLessThan(d.cp);
      expect(w.marginCal).toBeLessThan(d.margin);
    });
  }

  // Two fin sets on a 4 in body. Only the first second is compared: our test puts the motor
  // in the first mount only, so the CG (and the margin) is not comparable, but CNα and CP are.
  const two = 'Two_stage_high_power_rocket';
  it.skipIf(!fs.existsSync(fixture(two)))(`${two}: CNα and CP before staging`, async () => {
    const w = await compare(two, 1);
    expect(w.rows).toBeGreaterThan(50);
    expect(w.cna).toBeLessThan(0.04);
    expect(w.cpCal).toBeLessThan(0.1);
  });
});
