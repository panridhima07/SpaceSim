// Boosters, pods and tube fins in the flight model: mass, inertia, drag and lift.
// Expected values are worked by hand from the mock designs' dimensions.

import { describe, expect, it } from 'vitest';
import { parseOrkXml } from '../ork/parser';
import { MOCK_CASES, nose, ork, stage, tube } from '../validate/mockOrk';
import { aeroProps, dragBreakdown } from './aero';
import { massProps } from './massprops';
import type { RocketModel } from '../types';

const one = (name: string): RocketModel => parseOrkXml(MOCK_CASES.find((c) => c.name === name)!.xml);
const without = (m: RocketModel): RocketModel => ({ ...m, sideBodies: undefined });

describe('side bodies in the flight model', () => {
  it('a rocket with none is unchanged', () => {
    const m = one('baseline');
    expect(massProps(m, null, 0)).toEqual(massProps({ ...m, sideBodies: [] }, null, 0));
    expect(aeroProps(m, 0.3, 0.2)).toEqual(aeroProps({ ...m, sideBodies: [] }, 0.3, 0.2));
  });

  it('two boosters add twice their own mass, at their own station', () => {
    const m = one('strap-on-boosters');
    const base = massProps(without(m), null, 0);
    const full = massProps(m, null, 0);
    // One booster alone, flown as its own little rocket.
    const sb = m.sideBodies![0];
    const alone = massProps({ ...without(m), components: sb.components }, null, 0);
    expect(alone.mass).toBeGreaterThan(0);
    expect(full.mass).toBeCloseTo(base.mass + 2 * alone.mass, 12);
    expect(full.cgX).toBeCloseTo((base.mass * base.cgX + 2 * alone.mass * alone.cgX) / full.mass, 12);
    // Roll inertia gains m·d² for the two boosters 37 mm off the axis.
    expect(full.iRoll).toBeCloseTo(base.iRoll + 2 * alone.iRoll + 2 * alone.mass * 0.037 ** 2, 12);
    expect(full.iPitch).toBeGreaterThan(base.iPitch);
  });

  it('booster tube mass matches the wall volume by hand', () => {
    // One bare 150 mm cardboard tube, 12 mm radius, 2 mm wall, density 680: three copies.
    const xml = ork(stage('S', nose() + tube({}, `<podset><name>P</name><instancecount>3</instancecount><radiusoffset method="surface">0</radiusoffset><subcomponents>${tube({ radius: 0.012, length: 0.15 })}</subcomponents></podset>`)));
    const m = parseOrkXml(xml);
    const each = 680 * Math.PI * (0.012 ** 2 - 0.010 ** 2) * 0.15;
    expect(massProps(m, null, 0).mass - massProps(without(m), null, 0).mass).toBeCloseTo(3 * each, 12);
  });

  it('boosters add skin, nose and base drag', () => {
    const m = one('strap-on-boosters');
    const base = dragBreakdown(without(m), 0.3);
    const full = dragBreakdown(m, 0.3);
    expect(full.friction).toBeGreaterThan(base.friction);
    // Two 12 mm base discs against a 25 mm reference: base drag grows by 2·(12/25)².
    expect(full.base / base.base).toBeCloseTo(1 + 2 * (12 / 25) ** 2, 9);
    expect(full.total).toBeGreaterThan(base.total);
    expect(Number.isFinite(full.total)).toBe(true);
  });

  it('booster noses add Barrowman lift ahead of the fins, moving the CP forward', () => {
    const m = one('strap-on-boosters');
    const base = aeroProps(without(m), 0.1, 0.2);
    const full = aeroProps(m, 0.1, 0.2);
    // Each ogive nose gives 2·(12/25)²; there are two.
    expect(full.cnAlpha - base.cnAlpha).toBeCloseTo(2 * 2 * (12 / 25) ** 2, 9);
  });

  it('booster fins lift once per booster', () => {
    const m = one('boosters-with-fins-and-gap');
    const sb = m.sideBodies![0];
    const finless: RocketModel = { ...m, sideBodies: [{ ...sb, components: sb.components.filter((c) => c.kind !== 'finset') }] };
    const oneCopy: RocketModel = { ...m, sideBodies: [{ ...sb, count: 1 }] };
    const oneFinless: RocketModel = { ...finless, sideBodies: [{ ...finless.sideBodies![0], count: 1 }] };
    const perBooster = aeroProps(oneCopy, 0.1, 0.2).cnAlpha - aeroProps(oneFinless, 0.1, 0.2).cnAlpha;
    expect(perBooster).toBeGreaterThan(0);
    expect(aeroProps(m, 0.1, 0.2).cnAlpha - aeroProps(finless, 0.1, 0.2).cnAlpha).toBeCloseTo(4 * perBooster, 9);
  });

  it('tube fins stabilise: lift at the tail, by the enclosing-circle estimate', () => {
    const m = one('tube-fins'); // six 12.5 mm tubes on a 25 mm body
    const base = aeroProps(without(m), 0, 0.2);
    const full = aeroProps(m, 0, 0.2);
    // Enclosing circle 50 mm, body 25 mm: 2·(50² − 25²)/25² = 6.
    expect(full.cnAlpha - base.cnAlpha).toBeCloseTo(6, 9);
    expect(full.cpX).toBeGreaterThan(base.cpX);
    // Wetted inside and out, with thin rims: more friction, almost no extra base drag.
    const d0 = dragBreakdown(without(m), 0.3);
    const d1 = dragBreakdown(m, 0.3);
    expect(d1.friction).toBeGreaterThan(d0.friction);
    expect(d1.base / d0.base).toBeLessThan(1.15);
  });
});

describe('flying with side bodies', () => {
  it('a rocket with strap-on boosters flies to a lower apogee than without, with no NaN', async () => {
    const { runCase } = await import('./sweep');
    const { atmosphere } = await import('./atmosphere');
    const { thrustAt, findMotor } = await import('../ork/motors');
    const m = one('boosters-with-fins-and-gap');
    const motor = findMotor({ manufacturer: 'Estes', designation: 'C6' }, [])!;
    expect(motor).toBeTruthy();
    const deps = { atmosphere, massProps, aeroProps, thrust: thrustAt };
    const config = { railLength: 1, railAngle: 0, railAzimuth: 0, windSpeed: 0, windDirection: 0, gust: 0, launchAltitude: 0 };
    const plain = runCase(without(m), motor, config, deps, 'plain');
    const loaded = runCase(m, motor, config, deps, 'boosters');
    for (const r of [plain, loaded]) {
      expect(Number.isFinite(r.apogee)).toBe(true);
      expect(Number.isFinite(r.maxSpeed)).toBe(true);
    }
    expect(plain.apogee).toBeGreaterThan(10);
    expect(loaded.apogee).toBeLessThan(plain.apogee);
    console.log(`apogee without boosters ${plain.apogee.toFixed(1)} m, with four ${loaded.apogee.toFixed(1)} m`);
  }, 60_000);
});
