import { describe, it, expect } from 'vitest';
import { extractSimulations, defaultConfigId, readOrkZip } from './orkExtras';

// Node modules are loaded through a variable specifier so the project's typecheck
// does not need @types/node.
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

const MINI_XML = `<?xml version='1.0' encoding='utf-8'?>
<openrocket>
  <rocket>
    <motorconfiguration configid="a"/>
    <motorconfiguration configid="b" default="true"/>
    <subcomponents><motormount><motor configid="a"><manufacturer>Estes</manufacturer><designation>A8</designation><delay>3.0</delay></motor></motormount>
    <motormount><motor configid="b"><manufacturer>Aerotech</manufacturer><designation>D12</designation><delay>none</delay></motor></motormount></subcomponents>
  </rocket>
  <simulations>
    <simulation status="uptodate"><name>Sim A</name>
      <conditions><configid>a</configid><launchrodlength>1.0</launchrodlength><launchrodangle>0.1</launchrodangle><windaverage>2.5</windaverage></conditions>
      <flightdata maxaltitude="50.5" maxvelocity="29.2" timetoapogee="3.4"/>
    </simulation>
    <simulation status="uptodate"><name>No data</name><conditions><configid>a</configid></conditions></simulation>
  </simulations>
</openrocket>`;

describe('extractSimulations (synthetic)', () => {
  it('keeps only simulations with flightdata and resolves the motor by configid', () => {
    const sims = extractSimulations(MINI_XML);
    expect(sims).toHaveLength(1);
    expect(sims[0].name).toBe('Sim A');
    expect(sims[0].motor).toEqual({ manufacturer: 'Estes', designation: 'A8', delay: 3 });
    expect(sims[0].rodLength).toBe(1);
    expect(sims[0].rodAngle).toBeCloseTo(0.1);
    expect(sims[0].windSpeed).toBe(2.5);
    expect(sims[0].maxAltitude).toBeCloseTo(50.5);
    expect(sims[0].maxVelocity).toBeCloseTo(29.2);
    expect(Number.isNaN(sims[0].optimumDelay)).toBe(true);
  });

  it('returns NaN delay for "none" and finds the default configuration', () => {
    expect(defaultConfigId(MINI_XML)).toBe('b');
    const xml = MINI_XML.replace('<name>Sim A</name>', '<name>Sim A</name>').replace(
      '<configid>a</configid><launchrodlength>',
      '<configid>b</configid><launchrodlength>',
    );
    const sims = extractSimulations(xml);
    expect(sims[0].motor?.designation).toBe('D12');
    expect(Number.isNaN(sims[0].motor?.delay)).toBe(true);
  });

  it('defaultConfigId returns null when no default is flagged', () => {
    expect(defaultConfigId('<openrocket><rocket/></openrocket>')).toBeNull();
  });

  it('readOrkZip returns raw text for non-zip input', async () => {
    const bytes = new TextEncoder().encode(MINI_XML);
    const res = await readOrkZip(bytes);
    expect(res.xml).toBe(MINI_XML);
    expect(res.files).toEqual({});
  });
});

describe.skipIf(!haveFixture)('extractSimulations (A simple model rocket)', () => {
  it('finds at least 3 simulations and the first matches OpenRocket', async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const { xml } = await readOrkZip(bytes);
    const sims = extractSimulations(xml);

    console.log(
      sims.map((s) => ({
        name: s.name,
        motor: s.motor ? `${s.motor.manufacturer} ${s.motor.designation}` : '(none)',
        delay: s.motor?.delay,
        maxAltitude: s.maxAltitude,
        maxVelocity: s.maxVelocity,
        timeToApogee: s.timeToApogee,
        flightTime: s.flightTime,
        groundHitVelocity: s.groundHitVelocity,
        launchRodVelocity: s.launchRodVelocity,
      })),
    );
    console.table(
      sims.map((s) => ({
        name: s.name,
        motor: s.motor ? `${s.motor.manufacturer} ${s.motor.designation}` : '(none)',
        maxAltitude: s.maxAltitude,
        maxVelocity: s.maxVelocity,
        timeToApogee: s.timeToApogee,
        launchRodVelocity: s.launchRodVelocity,
      })),
    );

    expect(sims.length).toBeGreaterThanOrEqual(3);
    expect(sims[0].maxAltitude).toBeCloseTo(50.55, 1);
    expect(typeof sims[0].motor?.designation).toBe('string');
    expect(sims[0].motor!.designation.length).toBeGreaterThan(0);
  });
});
