import { describe, it, expect } from 'vitest';
import { compareWithOpenRocket, type ComparisonRow } from './compare';

// Node modules are loaded through variable specifiers so the typecheck does not need @types/node.
const NODE_FS = 'node:fs';
const NODE_URL = 'node:url';
type NodeFs = { existsSync(p: string): boolean };
const fs = (await import(/* @vite-ignore */ NODE_FS)) as unknown as NodeFs;
const { fileURLToPath } = (await import(/* @vite-ignore */ NODE_URL)) as unknown as {
  fileURLToPath(u: URL): string;
};

const FIXTURE = fileURLToPath(
  new URL('../../fixtures/external/A_simple_model_rocket.ork', import.meta.url),
);
const haveFixture = fs.existsSync(FIXTURE);

function pct(ours: number, ref: number): number {
  if (!Number.isFinite(ours) || !Number.isFinite(ref) || ref === 0) return NaN;
  return ((ours - ref) / ref) * 100;
}

function round(v: number, digits = 2): number {
  if (!Number.isFinite(v)) return NaN;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function toRow(r: ComparisonRow) {
  const o = r.ours;
  const s = r.sim;
  return {
    sim: s.name,
    motor: s.motor ? `${s.motor.manufacturer} ${s.motor.designation}` : '(none)',
    'alt OR (m)': round(s.maxAltitude),
    'alt ours': o ? round(o.maxAltitude) : NaN,
    'alt err %': o ? round(pct(o.maxAltitude, s.maxAltitude), 1) : NaN,
    'vmax OR (m/s)': round(s.maxVelocity),
    'vmax ours': o ? round(o.maxVelocity) : NaN,
    'vmax err %': o ? round(pct(o.maxVelocity, s.maxVelocity), 1) : NaN,
    'tApo OR (s)': round(s.timeToApogee),
    'tApo ours': o ? round(o.timeToApogee) : NaN,
    'tApo err %': o ? round(pct(o.timeToApogee, s.timeToApogee), 1) : NaN,
    'rodV OR (m/s)': round(s.launchRodVelocity),
    'rodV ours': o ? round(o.launchRodVelocity) : NaN,
    'rodV err %': o ? round(pct(o.launchRodVelocity, s.launchRodVelocity), 1) : NaN,
    note: r.note ?? '',
  };
}

describe.skipIf(!haveFixture)('our sim vs OpenRocket (A simple model rocket)', () => {
  it('measures each simulation against OpenRocket and reports the table', async () => {
    const rows = await compareWithOpenRocket(FIXTURE);
    const table = rows.map(toRow);
    console.table(table);

    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      if (!r.sim.motor || r.note === 'motor not in database') continue;
      expect(r.ours, r.note).not.toBeNull();
      expect(Number.isFinite(r.ours!.maxAltitude)).toBe(true);
      expect(r.ours!.maxAltitude).toBeGreaterThan(0);
      // Every motor in this design is embedded in the .ork, so the designer's exact motor is flown.
      expect(r.note ?? '').toContain('motor from embedded');
    }
  }, 120_000);
});
