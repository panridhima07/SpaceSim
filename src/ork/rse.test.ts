import { describe, it, expect } from 'vitest';
import { parseRse, embeddedMotors } from './rse';

// Node modules are loaded through variable specifiers so the typecheck does not need @types/node.
const NODE_FS = 'node:fs';
const NODE_URL = 'node:url';
type NodeFs = {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: 'utf-8'): string;
};
const fs = (await import(/* @vite-ignore */ NODE_FS)) as unknown as NodeFs;
const { fileURLToPath } = (await import(/* @vite-ignore */ NODE_URL)) as unknown as {
  fileURLToPath(u: URL): string;
};

const THRUSTCURVE_DIR = fileURLToPath(
  new URL('../../fixtures/external/x/thrustcurves', import.meta.url),
);
const haveFixtures = fs.existsSync(THRUSTCURVE_DIR);

const SAMPLE = `<engine-database>
 <engine-list>
  <engine mfg="Estes" code="A8" Type="single-use" dia="18." len="70." initWt="16.35" propWt="3.12" delays="3,5" auto-calc-mass="0" auto-calc-cg="0">
   <data>
    <eng-data t="0." f="0." m="3.12" cg="35."/>
    <eng-data t="0.1" f="8." m="3.0" cg="35."/>
    <eng-data t="0.5" f="2." m="2.0" cg="35."/>
    <eng-data t="1.0" f="0." m="0." cg="35."/>
   </data>
  </engine>
  <engine mfg="Estes" code="C6" dia="18" len="70" initWt="24" propWt="12.5">
   <data>
    <eng-data t="0.05" f="10." m="12.5" cg="35."/>
    <eng-data t="1.0" f="5." m="6." cg="35."/>
    <eng-data t="2.0" f="0." m="0." cg="35."/>
   </data>
  </engine>
 </engine-list>
</engine-database>`;

describe('parseRse', () => {
  it('parses an inline sample into SI motors', () => {
    const motors = parseRse(SAMPLE);
    expect(motors).toHaveLength(2);

    const a8 = motors[0];
    expect(a8.manufacturer).toBe('Estes');
    expect(a8.designation).toBe('A8');
    expect(a8.diameter).toBeCloseTo(0.018, 9);
    expect(a8.length).toBeCloseTo(0.07, 9);
    expect(a8.totalMass).toBeCloseTo(0.01635, 9);
    expect(a8.propellantMass).toBeCloseTo(0.00312, 9);
    expect(a8.approximate).toBe(false);
    expect(a8.curve[0]).toEqual([0, 0]);
    expect(a8.curve[a8.curve.length - 1]).toEqual([1.0, 0]);
    expect(a8.burnTime).toBeCloseTo(1.0, 9);
    // Trapezoid: 0.1*4 + 0.4*5 + 0.5*1 = 0.4 + 2.0 + 0.5 = 2.9 N s
    expect(a8.totalImpulse).toBeCloseTo(2.9, 6);
  });

  it('prepends [0,0] when the first point is after t=0 and appends a zero end point', () => {
    const c6 = parseRse(SAMPLE)[1];
    expect(c6.curve[0]).toEqual([0, 0]);
    expect(c6.curve[1]).toEqual([0.05, 10]);
    expect(c6.curve[c6.curve.length - 1][1]).toBe(0);
    expect(c6.totalImpulse).toBeGreaterThan(0);
  });

  it('returns [] for malformed or empty input without throwing', () => {
    expect(parseRse('')).toEqual([]);
    expect(parseRse('not xml at all <<<')).toEqual([]);
    expect(parseRse('<engine-database><engine-list/></engine-database>')).toEqual([]);
  });
});

describe('embeddedMotors', () => {
  it('routes .rse entries through parseRse and ignores other files', () => {
    const motors = embeddedMotors({
      'thrustcurves/a.rse': SAMPLE,
      'thrustcurves/readme.txt': 'hello',
      'thrustcurves/bad.rse': '<<<',
    });
    expect(motors.map((m) => m.designation)).toEqual(['A8', 'C6']);
  });

  it('also reads .eng entries', () => {
    const eng = 'C6 18 70 0 12.5 24 Estes\n0.05 10\n1.0 5\n1.86 0\n';
    const motors = embeddedMotors({ 'thrustcurves/c6.eng': eng });
    expect(motors).toHaveLength(1);
    expect(motors[0].designation).toBe('C6');
  });
});

describe.skipIf(!haveFixtures)('embedded .rse fixtures (fixtures/external/x)', () => {
  const files: Record<string, string> = {};
  if (haveFixtures) {
    for (const name of fs.readdirSync(THRUSTCURVE_DIR)) {
      if (name.toLowerCase().endsWith('.rse')) {
        files[`thrustcurves/${name}`] = fs.readFileSync(`${THRUSTCURVE_DIR}/${name}`, 'utf-8');
      }
    }
  }

  it('parses every fixture file into motors with positive impulse', () => {
    const motors = embeddedMotors(files);
    expect(motors.length).toBeGreaterThanOrEqual(3);
    for (const m of motors) {
      expect(m.totalImpulse, m.designation).toBeGreaterThan(0);
      expect(m.burnTime, m.designation).toBeGreaterThan(0);
      expect(m.approximate).toBe(false);
    }
  });

  it('reads the A8 fixture with loaded mass about 0.01635 kg', () => {
    const a8 = embeddedMotors(files).find((m) => m.designation === 'A8');
    expect(a8).toBeDefined();
    expect(a8!.totalMass).toBeCloseTo(0.01635, 6);
  });
});
