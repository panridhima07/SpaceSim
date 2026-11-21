// Tests for the numerical orbit propagator (src/orbit/propagate.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEG, MU_EARTH, RE } from '../src/constants.ts';
import { cross, dot, norm, sub, type Vec3 } from '../src/math/vec.ts';
import { ecefToEci, geodeticToEcef, gmst, groundVelocity, toGeodetic } from '../src/env/earth.ts';
import { inShadow, propagate, propagateToImpact, type ForceModel } from '../src/orbit/propagate.ts';

const EPOCH_JD = 2451545.0;
const TWO_BODY = { j2: false, j3j4: false, sun: false, moon: false };
const twoBody: ForceModel = { epochJD: EPOCH_JD, gravity: TWO_BODY };

const energy = (r: Vec3, v: Vec3): number => dot(v, v) / 2 - MU_EARTH / norm(r);

/** Argument of the ascending node from the angular momentum vector (rad). */
const nodeAngle = (r: Vec3, v: Vec3): number => {
  const h = cross(r, v);
  return Math.atan2(h[0], -h[1]);
};

test('two-body: circular orbit returns to its start after one period (within 1 m)', () => {
  const a = RE + 500e3;
  const T = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
  const r0: Vec3 = [a, 0, 0];
  const v0: Vec3 = [0, Math.sqrt(MU_EARTH / a), 0];
  const res = propagate(r0, v0, 0, T, twoBody);
  assert.equal(res.t, T);
  const miss = norm(sub(res.r, r0));
  assert.ok(miss < 1, `position miss after one period: ${miss} m`);
});

// e = 0.3 orbit with perigee 300 km: shared setup for the energy tests.
function eccentricOrbit(): { r0: Vec3; v0: Vec3; T: number } {
  const rp = RE + 300e3;
  const e = 0.3;
  const a = rp / (1 - e);
  const vp = Math.sqrt((MU_EARTH * (1 + e)) / rp);
  const T = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
  return { r0: [rp, 0, 0], v0: [0, vp, 0], T };
}

test('two-body: specific energy conserved to 1e-8 relative over 10 orbits (e = 0.3), default tolerances', () => {
  const { r0, v0, T } = eccentricOrbit();
  const E0 = energy(r0, v0);
  const res = propagate(r0, v0, 0, 10 * T, twoBody);
  const relErr = Math.abs(energy(res.r, res.v) - E0) / Math.abs(E0);
  // Observed: about 2e-9 at the default rtol 1e-10. The error scales with rtol (see next test).
  assert.ok(relErr < 1e-8, `relative energy error ${relErr}`);
});

test('two-body: energy error over 10 orbits scales with rtol (1e-12 meets 1e-9 comfortably)', () => {
  const { r0, v0, T } = eccentricOrbit();
  const E0 = energy(r0, v0);
  const res = propagate(r0, v0, 0, 10 * T, twoBody, { rtol: 1e-12 });
  const relErr = Math.abs(energy(res.r, res.v) - E0) / Math.abs(E0);
  assert.ok(relErr < 1e-9, `relative energy error ${relErr}`);
});

test('J2 only: node regression of a 500 km, 51.6 deg circular orbit matches -1.5 n J2 (RE/a)^2 cos i within 3 %', () => {
  const J2 = 1.08262668e-3;
  const a = RE + 500e3;
  const i = 51.6 * DEG;
  const n = Math.sqrt(MU_EARTH / (a * a * a));
  const vc = Math.sqrt(MU_EARTH / a);
  const r0: Vec3 = [a, 0, 0];
  const v0: Vec3 = [0, vc * Math.cos(i), vc * Math.sin(i)];
  const fm: ForceModel = { epochJD: EPOCH_JD, gravity: { j2: true, j3j4: false, sun: false, moon: false } };
  const day = 86400;
  const res = propagate(r0, v0, 0, day, fm);

  let dRaan = nodeAngle(res.r, res.v) - nodeAngle(r0, v0);
  dRaan = Math.atan2(Math.sin(dRaan), Math.cos(dRaan)); // unwrap to (-pi, pi]
  const rateDeg = (dRaan / DEG) / (day / 86400);
  // Analytic secular rate. For this 500 km orbit it is -4.75 deg/day (the "about -5.0" of
  // the brief is the ISS-altitude value).
  const expectedDeg = ((-1.5 * n * J2 * (RE / a) ** 2 * Math.cos(i)) / DEG) * 86400;
  assert.ok(Math.abs(rateDeg - expectedDeg) / Math.abs(expectedDeg) < 0.03, `rate ${rateDeg} deg/day vs ${expectedDeg}`);
});

test('backward propagation: forward 3000 s then backward 3000 s returns to start within 1 mm', () => {
  const a = RE + 500e3;
  const vc = Math.sqrt(MU_EARTH / a);
  const r0: Vec3 = [a * 0.6, a * 0.8, 0];
  const dir = unitXY(r0);
  const v0: Vec3 = [-vc * dir[1], vc * dir[0], 0.3 * vc];
  const fm: ForceModel = { epochJD: EPOCH_JD };
  const tol = { rtol: 1e-12, atol: 1e-9 };
  const fwd = propagate(r0, v0, 0, 3000, fm, tol);
  const back = propagate(fwd.r, fwd.v, 3000, 0, fm, tol);
  assert.equal(back.t, 0);
  const miss = norm(sub(back.r, r0));
  assert.ok(miss < 1e-3, `position miss ${miss} m`);
});

function unitXY(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1]);
  return [v[0] / l, v[1] / l, 0];
}

test('drag lowers specific energy over one orbit at 200 km; without drag energy is conserved (1e-6)', () => {
  const a = RE + 200e3;
  const vc = Math.sqrt(MU_EARTH / a);
  const T = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
  const r0: Vec3 = [a, 0, 0];
  const v0: Vec3 = [0, vc, 0];
  const E0 = energy(r0, v0);

  const withDrag: ForceModel = { epochJD: EPOCH_JD, gravity: TWO_BODY, drag: { cdAOverM: 0.01 } };
  const dragged = propagate(r0, v0, 0, T, withDrag);
  const E1 = energy(dragged.r, dragged.v);
  assert.ok(E1 < E0, `energy should drop: ${E0} -> ${E1}`);

  const noDrag = propagate(r0, v0, 0, T, twoBody);
  const relErr = Math.abs(energy(noDrag.r, noDrag.v) - E0) / Math.abs(E0);
  assert.ok(relErr < 1e-6, `no-drag relative energy change ${relErr}`);
});

test('inShadow: behind the Earth is shadowed, sunward side is not, far off-axis is not', () => {
  const sun: Vec3 = [1.496e11, 0, 0];
  assert.equal(inShadow([-7e6, 0, 0], sun), true, 'directly behind Earth');
  assert.equal(inShadow([7e6, 0, 0], sun), false, 'sunward side');
  assert.equal(inShadow([-7e6, 7e6, 0], sun), false, 'behind but far off-axis');
});

test('SRP: changes the GEO trajectory after one orbit by more than 0 and less than 1 km', () => {
  const a = 42164e3;
  const T = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
  const r0: Vec3 = [a, 0, 0];
  const v0: Vec3 = [0, Math.sqrt(MU_EARTH / a), 0];
  const none = propagate(r0, v0, 0, T, twoBody);
  const srpModel: ForceModel = { epochJD: EPOCH_JD, gravity: TWO_BODY, srp: { crAOverM: 0.02 } };
  const withSrp = propagate(r0, v0, 0, T, srpModel);
  const diff = norm(sub(withSrp.r, none.r));
  assert.ok(diff > 0 && diff < 1000, `SRP displacement after one orbit: ${diff} m`);
});

test('propagateToImpact: object dropped from 100 km at rest over the ground lands near its start point', () => {
  const jd = EPOCH_JD;
  const lon0 = 80 * DEG;
  const rEcef = geodeticToEcef(0, lon0, 100e3);
  const r0 = ecefToEci(rEcef, gmst(jd));
  const v0 = groundVelocity(r0);
  const fm: ForceModel = { epochJD: jd };
  const hit = propagateToImpact(r0, v0, 0, fm);
  assert.ok(hit !== null, 'should impact');
  if (hit === null) return;
  assert.ok(hit.t > 143 && hit.t < 146, `time of flight ${hit.t} s`);
  // The crossing is located to 0.01 s, so the reported state can sit up to speed * 0.01 s past the ground.
  const altTol = norm(hit.v) * 0.01 + 1e-6;
  assert.ok(Math.abs(toGeodetic(hit.r).alt) <= altTol, `altitude at impact ${toGeodetic(hit.r).alt} m (tol ${altTol})`);
  assert.ok(Math.abs(hit.latDeg - 0) < 0.1, `latitude ${hit.latDeg} deg`);
  assert.ok(Math.abs(hit.lonDeg - 80) < 0.1, `geographic longitude ${hit.lonDeg} deg`);
});

test('propagateToImpact: a 500 km orbit returns null within tMax = t0 + 3000 s', () => {
  const a = RE + 500e3;
  const vc = Math.sqrt(MU_EARTH / a);
  const r0: Vec3 = [a, 0, 0];
  const v0: Vec3 = [0, vc, 0];
  const t0 = 0;
  const res = propagateToImpact(r0, v0, t0, { epochJD: EPOCH_JD }, t0 + 3000);
  assert.equal(res, null);
});
