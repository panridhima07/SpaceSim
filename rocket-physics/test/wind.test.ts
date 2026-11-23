// Ascent guidance in wind. The open-loop turn used to follow the velocity through the air,
// so a few metres per second of low-level wind swung the whole trajectory off its azimuth:
// a 20 m/s northward jet stream left the orbit 3 degrees off in inclination and 120 km high,
// and a 30 m/s tailwind tipped the vehicle over backwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITES, flyAscent, jetStreamWind, twoStageKerolox } from '../src/index.ts';

const fly = (jetSpeed: number, towardDeg: number) =>
  flyAscent(
    twoStageKerolox(12000),
    {
      site: SITES.sriharikota,
      epoch: new Date('2026-11-21T09:00:00Z'),
      wind: jetSpeed > 0 ? jetStreamWind({ jetSpeed, towardDeg, surfaceSpeed: jetSpeed / 4 }) : undefined,
    },
    { target: { perigeeAltitude: 200e3, apogeeAltitude: 600e3 }, pitchKickDeg: 6, maxG: 4.5 },
    1500,
  );

const calm = fly(0, 0);

test('calm air: the reference flight reaches 200 x 600 km', () => {
  assert.equal(calm.reachedTarget, true);
  assert.ok(Math.abs(calm.perigeeAltitude - 200e3) < 1e3);
  assert.ok(Math.abs(calm.apogeeAltitude - 600e3) < 1e3);
});

for (const [name, jet, toward] of [
  ['crosswind toward north', 20, 0],
  ['crosswind toward south', 20, 180],
  ['tailwind', 30, 90],
  ['headwind', 30, 270],
] as const) {
  test(`${name}, ${jet} m/s jet stream: same orbit as in calm air`, () => {
    const res = fly(jet, toward);
    assert.equal(res.reachedTarget, true);
    assert.ok(Math.abs(res.perigeeAltitude - 200e3) < 1e3, `perigee ${res.perigeeAltitude}`);
    assert.ok(Math.abs(res.apogeeAltitude - 600e3) < 1e3, `apogee ${res.apogeeAltitude}`);
    assert.ok(Math.abs(res.inclinationDeg - calm.inclinationDeg) < 0.05, `inclination ${res.inclinationDeg} vs ${calm.inclinationDeg}`);
    // Fighting the wind costs propellant, but not much.
    assert.ok(res.propellantMargin > 0.8 * calm.propellantMargin, `margin ${res.propellantMargin} vs ${calm.propellantMargin}`);
  });
}
