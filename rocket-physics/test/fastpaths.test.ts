// Regression tests for the hot-path rewrites. Each fast function is checked against a slow,
// obviously-correct reference written in this file: the trigonometric geodetic iteration,
// the rotation-matrix form of a quaternion, a per-item parallel-axis mass model, a
// finite-difference gradient, the direct third-body formula, and fresh (uncached) solvers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEG, E2, MU_EARTH, MU_MOON, MU_SUN, RE } from '../src/constants.ts';
import { cross, dot, norm, qrot, qrotInv, rotateByQuat, sub, type Quat, type Vec3 } from '../src/math/vec.ts';
import { Dopri5, integrateAdaptive } from '../src/math/integrators.ts';
import { geodeticAltitude, geodeticToEcef, localFrame, toGeodetic } from '../src/env/earth.ts';
import { earthGravity, earthPotential, gravityAccel, gravityInto, thirdBodyAccel } from '../src/env/gravity.ts';
import { moonPosition, sunPosition } from '../src/env/ephemeris.ts';
import { MassModel, massProperties, massSignature, type MassProps } from '../src/vehicle/massprops.ts';
import { initialPropellant, initialRuntime, type VehicleRuntime, type VehicleSpec } from '../src/vehicle/types.ts';
import { lvm3, twoStageKerolox } from '../src/vehicle/presets.ts';

// ---- helpers ---------------------------------------------------------------

// Deterministic pseudo-random numbers in [-1, 1) (LCG), so failures reproduce.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

/** Relative closeness: |actual - expected| <= tol * max(|expected|, 1e-300). */
function near(actual: number, expected: number, relTol: number, msg = ''): void {
  const denom = Math.abs(expected) > 0 ? Math.abs(expected) : 1;
  assert.ok(Math.abs(actual - expected) / denom <= relTol, `${msg} actual=${actual} expected=${expected} relTol=${relTol}`);
}

/** Vector closeness relative to the length of the expected vector. */
function assertVecRel(actual: Vec3, expected: Vec3, tol: number, msg = ''): void {
  const err = norm(sub(actual, expected));
  const scale = norm(expected);
  assert.ok(err <= tol * scale, `${msg} |diff|=${err} |expected|=${scale} relTol=${tol} actual=${actual} expected=${expected}`);
}

const randomUnit = (rng: () => number): Vec3 => {
  const v: Vec3 = [rng(), rng(), rng()];
  const l = norm(v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Uniform in [0, 1). */
const unitInterval = (rng: () => number): number => (rng() + 1) / 2;

/** Random Earth-centred position between the surface and 60 Earth radii. */
function randomPosition(rng: () => number): Vec3 {
  const u = randomUnit(rng);
  const r = RE * (1 + 59 * unitInterval(rng));
  return [u[0] * r, u[1] * r, u[2] * r];
}

const LATS_DEG: number[] = Array.from({ length: 25 }, (_, k) => -90 + 7.5 * k); // includes -90, 0, 90
const LONS_DEG: number[] = Array.from({ length: 13 }, (_, k) => -180 + 30 * k);
const ALTS: number[] = [-5000, 0, 10, 8848, 120e3, 400e3, 35786e3, 384400e3];

// ---- 1. earth: geodetic conversions and local frame ------------------------

/** The classic trigonometric iteration. Slow, but obviously right. */
function refGeodetic(x: number, y: number, z: number): { lat: number; alt: number } {
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let alt = 0;
  for (let i = 0; i < 10; i++) {
    const s = Math.sin(lat);
    const c = Math.cos(lat);
    const N = RE / Math.sqrt(1 - E2 * s * s);
    alt = p * c + z * s - N * (1 - E2 * s * s);
    lat = Math.atan2(z, p * (1 - (E2 * N) / (N + alt)));
  }
  return { lat, alt };
}

test('earth: toGeodetic matches the trigonometric reference and round-trips over a grid', () => {
  for (const latDeg of LATS_DEG) {
    for (const lonDeg of LONS_DEG) {
      for (const alt of ALTS) {
        const lat = latDeg * DEG;
        const p = geodeticToEcef(lat, lonDeg * DEG, alt);
        const g = toGeodetic(p);
        const ref = refGeodetic(p[0], p[1], p[2]);
        const tolAlt = alt >= 35786e3 ? 1e-3 : 1e-6;
        const tag = `lat=${latDeg} lon=${lonDeg} alt=${alt}`;

        assert.ok(Math.abs(ref.lat - lat) < 1e-12, `reference lat ${tag}: ${ref.lat}`);
        assert.ok(Math.abs(ref.alt - alt) < tolAlt, `reference alt ${tag}: ${ref.alt}`);
        assert.ok(Math.abs(g.lat - ref.lat) < 1e-12, `lat vs reference ${tag}: ${g.lat} vs ${ref.lat}`);
        assert.ok(Math.abs(g.alt - ref.alt) < tolAlt, `alt vs reference ${tag}: ${g.alt} vs ${ref.alt}`);
        assert.ok(Math.abs(g.lat - lat) < 1e-12, `round-trip lat ${tag}: ${g.lat}`);
        assert.ok(Math.abs(g.alt - alt) < tolAlt, `round-trip alt ${tag}: ${g.alt}`);
      }
    }
  }
});

test('earth: geodeticAltitude equals toGeodetic().alt exactly', () => {
  const rng = makeRng(3);
  const points: Vec3[] = [];
  for (const latDeg of LATS_DEG) for (const lonDeg of LONS_DEG) for (const alt of ALTS) points.push(geodeticToEcef(latDeg * DEG, lonDeg * DEG, alt));
  for (let k = 0; k < 200; k++) points.push(randomPosition(rng));
  for (const p of points) {
    assert.equal(geodeticAltitude(p[0], p[1], p[2]), toGeodetic(p).alt, `point ${p}`);
  }
});

test('earth: localFrame is orthonormal, matches the geodetic up vector and is right-handed', () => {
  for (const latDeg of LATS_DEG) {
    for (const lonDeg of LONS_DEG) {
      for (const alt of [0, 400e3]) {
        const lat = latDeg * DEG;
        const lon = lonDeg * DEG;
        const f = localFrame(geodeticToEcef(lat, lon, alt));
        const tag = `lat=${latDeg} lon=${lonDeg} alt=${alt}`;

        near(norm(f.east), 1, 1e-12, `|east| ${tag}`);
        near(norm(f.north), 1, 1e-12, `|north| ${tag}`);
        near(norm(f.up), 1, 1e-12, `|up| ${tag}`);
        assert.ok(Math.abs(dot(f.east, f.north)) < 1e-12, `east.north ${tag}`);
        assert.ok(Math.abs(dot(f.east, f.up)) < 1e-12, `east.up ${tag}`);
        assert.ok(Math.abs(dot(f.north, f.up)) < 1e-12, `north.up ${tag}`);

        const expUp: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(f.up[i] - expUp[i]) < 1e-12, `up[${i}] ${tag}: ${f.up[i]} vs ${expUp[i]}`);

        const en = cross(f.east, f.north);
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(en[i] - f.up[i]) < 1e-12, `east x north = up [${i}] ${tag}`);
      }
    }
  }
});

test('earth: degenerate on-axis inputs give finite latitude +-pi/2 and finite altitude', () => {
  const north = localFrame([0, 0, RE]);
  assert.ok(Number.isFinite(north.lat) && Math.abs(north.lat - Math.PI / 2) < 1e-12, `lat(+Z) ${north.lat}`);
  assert.ok(Number.isFinite(north.alt), `alt(+Z) ${north.alt}`);
  near(north.alt, RE * (1 - Math.sqrt(1 - E2)), 1e-9, 'alt at +Z is RE - b');

  const south = localFrame([0, 0, -7e6]);
  assert.ok(Number.isFinite(south.lat) && Math.abs(south.lat + Math.PI / 2) < 1e-12, `lat(-7e6 Z) ${south.lat}`);
  assert.ok(Number.isFinite(south.alt), `alt(-7e6 Z) ${south.alt}`);

  const g1 = toGeodetic([0, 0, RE]);
  const g2 = toGeodetic([0, 0, -7e6]);
  assert.ok(Number.isFinite(g1.alt) && Number.isFinite(g2.alt) && Number.isFinite(g1.lat) && Number.isFinite(g2.lat));
  assert.ok(Number.isFinite(geodeticAltitude(0, 0, RE)) && Number.isFinite(geodeticAltitude(0, 0, -7e6)));
  for (const f of [north, south]) {
    for (const vec of [f.east, f.north, f.up]) for (const c of vec) assert.ok(Number.isFinite(c), 'finite frame vector');
  }
});

// ---- 2. gravity -------------------------------------------------------------

const JD = 2460000.5;
const OPT_SETS = [
  { j2: true, j3j4: true },
  { j2: true, j3j4: false },
  { j2: false, j3j4: true },
  { j2: false, j3j4: false },
];

test('gravity: gravityInto is identical to gravityAccel for every option and third-body combination', () => {
  const sun = sunPosition(JD);
  const moon = moonPosition(JD);
  const rng = makeRng(101);
  for (let k = 0; k < 200; k++) {
    const r = randomPosition(rng);
    for (const opts of OPT_SETS) {
      const bodySets = [{}, { sun }, { moon }, { sun, moon }];
      const plain = gravityAccel(r, opts, {});
      for (const bodies of bodySets) {
        const out: Vec3 = [0, 0, 0];
        gravityInto(out, r[0], r[1], r[2], opts, bodies.sun, bodies.moon);
        const ref = gravityAccel(r, opts, bodies);
        assert.deepStrictEqual(out, ref, `point ${k} opts ${JSON.stringify(opts)} bodies ${Object.keys(bodies)}`);
      }
      // Sanity: the third bodies really change the result.
      const withBoth = gravityAccel(r, opts, { sun, moon });
      assert.notDeepStrictEqual(withBoth, plain, 'third bodies are applied');
    }
  }
});

test('gravity: earthGravity matches the numerical gradient of earthPotential to 1e-6 relative', () => {
  const rng = makeRng(202);
  for (let k = 0; k < 200; k++) {
    const r = randomPosition(rng);
    const h = norm(r) / RE; // 1 m at the surface, scaled with radius
    for (const opts of OPT_SETS) {
      const a = earthGravity(r, opts);
      const grad: Vec3 = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const rp: Vec3 = [r[0], r[1], r[2]];
        const rm: Vec3 = [r[0], r[1], r[2]];
        rp[i] += h;
        rm[i] -= h;
        grad[i] = (earthPotential(rp, opts) - earthPotential(rm, opts)) / (2 * h);
      }
      const err = norm(sub(a, grad));
      assert.ok(err <= 1e-6 * norm(a), `point ${k} opts ${JSON.stringify(opts)}: |a-grad|=${err} |a|=${norm(a)}`);
    }
  }
});

/** Direct formula: mu * ((rb - r)/|rb - r|^3 - rb/|rb|^3). */
function refThirdBody(r: Vec3, rb: Vec3, mu: number): Vec3 {
  const d = sub(rb, r);
  const dn = norm(d);
  const bn = norm(rb);
  return [
    mu * (d[0] / dn ** 3 - rb[0] / bn ** 3),
    mu * (d[1] / dn ** 3 - rb[1] / bn ** 3),
    mu * (d[2] / dn ** 3 - rb[2] / bn ** 3),
  ];
}

// The tidal result is a difference of two terms that are each much larger than it (ratio
// about |r| / |rb|), so round-off in those terms is amplified. The bound is therefore taken
// relative to the size of the terms being subtracted, mu / |rb|^2, which is the honest
// floating-point scale; it still holds at 1e-12 of the result for the non-cancelling cases.
function assertThirdBodyClose(r: Vec3, rb: Vec3, mu: number, msg: string): void {
  const actual = thirdBodyAccel(r, rb, mu);
  const expected = refThirdBody(r, rb, mu);
  const err = norm(sub(actual, expected));
  const termScale = mu / (norm(rb) * norm(rb));
  assert.ok(err <= 1e-12 * termScale, `${msg} |diff|=${err} termScale=${termScale} actual=${actual} expected=${expected}`);
  // Where the tidal result is not much smaller than its terms, the 1e-12 relative bound holds directly.
  if (norm(expected) > 1e-3 * termScale) assertVecRel(actual, expected, 1e-12, msg);
}

test('gravity: thirdBodyAccel matches the direct formula to 1e-12 relative', () => {
  const rng = makeRng(303);
  const sun = sunPosition(JD);
  const moon = moonPosition(JD);
  for (let k = 0; k < 200; k++) {
    const r = randomPosition(rng);
    assertThirdBodyClose(r, sun, MU_SUN, `sun point ${k}`);
    assertThirdBodyClose(r, moon, MU_MOON, `moon point ${k}`);
  }
});

// ---- 3. quaternion rotations ------------------------------------------------

function randomQuat(rng: () => number): Quat {
  const q = [rng(), rng(), rng(), rng()];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Rotation matrix of a unit quaternion [x, y, z, w], body -> world. Row-major. */
function quatMatrix(q: Quat): number[][] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

const matVec = (m: number[][], v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

const transpose = (m: number[][]): number[][] => m[0].map((_, i) => m.map((row) => row[i]));

test('vec: qrot matches the rotation-matrix form of the quaternion', () => {
  const rng = makeRng(404);
  for (let k = 0; k < 200; k++) {
    const q = randomQuat(rng);
    const v: Vec3 = [rng(), rng(), rng()];
    const M = quatMatrix(q);
    assertVecRel(qrot(q, v), matVec(M, v), 1e-12, `qrot ${k}`);
  }
});

test('vec: qrotInv inverts qrot, is the transpose matrix, and preserves length', () => {
  const rng = makeRng(505);
  for (let k = 0; k < 200; k++) {
    const q = randomQuat(rng);
    const v: Vec3 = [rng(), rng(), rng()];
    const back = qrotInv(q, qrot(q, v));
    assertVecRel(back, v, 1e-12, `qrotInv(qrot) ${k}`);
    assertVecRel(qrotInv(q, v), matVec(transpose(quatMatrix(q)), v), 1e-12, `qrotInv vs transpose ${k}`);
    near(norm(qrot(q, v)), norm(v), 1e-12, `length ${k}`);
  }
});

test('vec: rotateByQuat deep-equals qrot, and norm([3,4,12]) is 13', () => {
  const rng = makeRng(606);
  for (let k = 0; k < 200; k++) {
    const q = randomQuat(rng);
    const v: Vec3 = [rng(), rng(), rng()];
    assert.deepStrictEqual(rotateByQuat(q[0], q[1], q[2], q[3], v[0], v[1], v[2]), qrot(q, v));
  }
  assert.equal(norm([3, 4, 12]), 13);
});

// ---- 4. MassModel vs massProperties ----------------------------------------

const blankProps = (): MassProps => ({ mass: 0, cg: 0, inertia: [0, 0, 0], length: 0, top: 0, stageBase: [] });

const VEHICLES: Array<[string, () => VehicleSpec]> = [
  ['twoStageKerolox(12000)', () => twoStageKerolox(12000)],
  ['lvm3()', () => lvm3()],
];

/**
 * Independent mass properties. Every physical item (each booster copy's dry mass and
 * tanks, the core, payload and fairing) is an explicit body with its own mass, centre
 * station, local inertias and radial offset, summed with the parallel-axis theorem.
 * Only the rules that define the vehicle (stacking, liquid column, fairing station)
 * are taken from the model description.
 */
interface RefBody {
  m: number;
  x: number; // station along the vehicle, m
  Ia: number; // about the vehicle axis, about the body's own centre
  It: number; // transverse, about the body's own centre
  y: number; // offset from the vehicle axis, m
  z: number;
}

function refMassProps(v: VehicleSpec, rt: VehicleRuntime, prop: number[]): { mass: number; cg: number; inertia: number[] } {
  // Stations: attached core stages stack bottom-up; attached boosters hang from the first core's base.
  const base: number[] = v.stages.map(() => NaN);
  let station = 0;
  let firstCoreBase = NaN;
  for (let i = 0; i < v.stages.length; i++) {
    const s = v.stages[i];
    if (s.parallel || !rt.stages[i].attached) continue;
    base[i] = station;
    if (Number.isNaN(firstCoreBase)) firstCoreBase = station;
    station += s.length;
  }
  for (let i = 0; i < v.stages.length; i++) {
    const s = v.stages[i];
    if (s.parallel && rt.stages[i].attached) base[i] = firstCoreBase + s.parallel.attachStation;
  }
  const top = station;

  const bodies: RefBody[] = [];
  let tank = 0;
  for (let i = 0; i < v.stages.length; i++) {
    const s = v.stages[i];
    const firstTank = tank;
    tank += s.tanks.length;
    if (!rt.stages[i].attached) continue;
    const copies = s.parallel ? s.parallel.count : 1;
    const d = s.parallel ? s.parallel.radialOffset : 0;
    const R = s.radius;
    const L = s.length;
    for (let k = 0; k < copies; k++) {
      // Copies sit on a ring, the first on +Y, then every 2 pi / n.
      const ang = (2 * Math.PI * k) / copies;
      const y = d * Math.cos(ang);
      const z = d * Math.sin(ang);
      bodies.push({
        m: s.dryMass,
        x: base[i] + (s.dryCgFraction ?? 0.4) * L,
        Ia: s.dryMass * R * R,
        It: s.dryMass * ((R * R) / 2 + (L * L) / 12),
        y,
        z,
      });
      s.tanks.forEach((t, j) => {
        const m = Math.max(0, prop[firstTank + j]);
        if (m === 0) return;
        // A liquid column drains from the top: its bottom stays at the tank floor.
        const h = (t.kind ?? 'liquid') === 'liquid' ? t.length * Math.min(1, m / t.propellantMass) : t.length;
        const r = t.radius ?? R;
        bodies.push({ m, x: base[i] + t.bottom + h / 2, Ia: 0.5 * m * r * r, It: m * ((r * r) / 4 + (h * h) / 12), y, z });
      });
    }
  }

  const cores = v.stages.filter((s) => !s.parallel);
  const pr = v.payload.radius ?? cores[cores.length - 1].radius * 0.8;
  const pm = v.payload.mass;
  const pL = v.payload.length;
  bodies.push({ m: pm, x: top + pL / 2, Ia: 0.5 * pm * pr * pr, It: pm * ((pr * pr) / 4 + (pL * pL) / 12), y: 0, z: 0 });
  if (rt.fairingAttached && v.fairing) {
    const f = v.fairing;
    bodies.push({
      m: f.mass,
      x: top + 0.45 * f.length,
      Ia: f.mass * f.radius * f.radius,
      It: f.mass * ((f.radius * f.radius) / 2 + (f.length * f.length) / 12),
      y: 0,
      z: 0,
    });
  }

  let mass = 0;
  let moment = 0;
  for (const b of bodies) {
    mass += b.m;
    moment += b.m * b.x;
  }
  const cg = moment / mass;
  let ixx = 0;
  let iyy = 0;
  let izz = 0;
  for (const b of bodies) {
    const dx = b.x - cg;
    ixx += b.Ia + b.m * (b.y * b.y + b.z * b.z);
    iyy += b.It + b.m * (dx * dx + b.z * b.z);
    izz += b.It + b.m * (dx * dx + b.y * b.y);
  }
  return { mass, cg, inertia: [ixx, iyy, izz] };
}

function assertMatchesReference(actual: MassProps, ref: { mass: number; cg: number; inertia: number[] }, tol: number, msg: string): void {
  near(actual.mass, ref.mass, tol, `${msg} mass`);
  near(actual.cg, ref.cg, tol, `${msg} cg`);
  for (let i = 0; i < 3; i++) near(actual.inertia[i], ref.inertia[i], tol, `${msg} inertia[${i}]`);
}

test('MassModel.evaluate matches massProperties exactly (mass, cg, inertia, length, top, stageBase)', () => {
  for (const [name, make] of VEHICLES) {
    const v = make();
    const rt = initialRuntime(v);
    const prop = initialPropellant(v);
    const out = blankProps();
    new MassModel(v, rt).evaluate(prop, 0, out);
    assert.deepStrictEqual(out, massProperties(v, rt, prop), name);
  }
});

test('MassModel.evaluate honours the offset argument', () => {
  for (const [name, make] of VEHICLES) {
    const v = make();
    const rt = initialRuntime(v);
    const prop = initialPropellant(v).map((m, i) => m * (1 - 0.1 * i));
    const long = new Float64Array(5 + prop.length + 3);
    long.fill(-9999);
    for (let i = 0; i < prop.length; i++) long[5 + i] = prop[i];
    const out = blankProps();
    new MassModel(v, rt).evaluate(long, 5, out);
    assert.deepStrictEqual(out, massProperties(v, rt, prop), `${name} offset 5`);
  }
});

test('MassModel.evaluate agrees with the independent parallel-axis reference (full, half, 1 %)', () => {
  for (const [name, make] of VEHICLES) {
    const v = make();
    const rt = initialRuntime(v);
    const full = initialPropellant(v);
    const model = new MassModel(v, rt);
    for (const frac of [1, 0.5, 0.01]) {
      const prop = full.map((m) => m * frac);
      const out = blankProps();
      model.evaluate(prop, 0, out);
      assertMatchesReference(out, refMassProps(v, rt, prop), 1e-9, `${name} frac=${frac}`);
    }
  }
});

test('MassModel: after detaching a stage and the fairing the signature changes and a new model agrees', () => {
  for (const [name, make] of VEHICLES) {
    const v = make();
    const rt = initialRuntime(v);
    const prop = initialPropellant(v);
    const sig0 = massSignature(rt);
    const oldModel = new MassModel(v, rt);
    const oldProps = massProperties(v, rt, prop);

    rt.stages[0].attached = false;
    const sig1 = massSignature(rt);
    assert.notEqual(sig1, sig0, `${name}: stage detach changes signature`);
    const m1 = new MassModel(v, rt);
    assert.equal(m1.signature, sig1, `${name}: model signature`);
    const out1 = blankProps();
    m1.evaluate(prop, 0, out1);
    assert.deepStrictEqual(out1, massProperties(v, rt, prop), `${name}: new model after detach`);
    assertMatchesReference(out1, refMassProps(v, rt, prop), 1e-9, `${name}: after detach`);

    // A model built before the change keeps describing the configuration it was built for.
    const outOld = blankProps();
    oldModel.evaluate(prop, 0, outOld);
    assert.deepStrictEqual(outOld, oldProps, `${name}: old model unchanged`);

    rt.fairingAttached = false;
    const sig2 = massSignature(rt);
    assert.notEqual(sig2, sig1, `${name}: fairing removal changes signature`);
    const m2 = new MassModel(v, rt);
    assert.equal(m2.signature, sig2);
    const out2 = blankProps();
    m2.evaluate(prop, 0, out2);
    assert.deepStrictEqual(out2, massProperties(v, rt, prop), `${name}: new model after fairing`);
    assertMatchesReference(out2, refMassProps(v, rt, prop), 1e-9, `${name}: after fairing`);
  }
});

test('MassModel: repeated evaluation on one model has no stale scratch state', () => {
  for (const [name, make] of VEHICLES) {
    const v = make();
    const rt = initialRuntime(v);
    const full = initialPropellant(v);
    const empty = full.map(() => 0);
    const model = new MassModel(v, rt);
    const a = blankProps();
    model.evaluate(full, 0, a);
    const b = blankProps();
    model.evaluate(empty, 0, b);
    const c = blankProps();
    model.evaluate(full, 0, c);
    assert.ok(b.mass < a.mass, `${name}: empty is lighter`);
    assert.deepStrictEqual(c, a, `${name}: full again equals first full`);
  }
});

// ---- 5. Dopri5 first-same-as-last ------------------------------------------

const R0 = 7000e3;
const V0 = Math.sqrt(MU_EARTH / R0);
const PERIOD = 2 * Math.PI * Math.sqrt(R0 ** 3 / MU_EARTH);
const Y0: number[] = [R0, 0, 0, 0, V0, 0];
const TOL = { rtol: 1e-12, atol: 1e-6 };

/** Point-mass two-body right-hand side that counts its own calls. */
function makeTwoBody(): { f: (t: number, y: number[]) => number[]; calls: () => number } {
  let n = 0;
  const f = (_t: number, y: number[]): number[] => {
    n++;
    const r = Math.sqrt(y[0] * y[0] + y[1] * y[1] + y[2] * y[2]);
    const k = -MU_EARTH / (r * r * r);
    return [y[3], y[4], y[5], k * y[0], k * y[1], k * y[2]];
  };
  return { f, calls: () => n };
}

/** Manual stepping loop to the period, feeding each returned state straight back in. */
function runManual(fsal: boolean, copy: boolean): { y: number[]; calls: number; steps: number } {
  const tb = makeTwoBody();
  const solver = new Dopri5(tb.f, { ...TOL, fsal, hInit: 1 });
  let t = 0;
  let y = Y0.slice();
  let steps = 0;
  while (t !== PERIOD) {
    const s = solver.step(t, y, PERIOD);
    t = s.t;
    y = copy ? s.y.slice() : s.y;
    steps++;
    if (steps > 1_000_000) throw new Error('runaway loop');
  }
  return { y, calls: tb.calls(), steps };
}

test('integrators: integrateAdaptive returns to the start after one period (1 m, 1e-3 m/s)', () => {
  const tb = makeTwoBody();
  const res = integrateAdaptive(tb.f, 0, Y0, PERIOD, TOL);
  assert.equal(res.t, PERIOD, 'lands on the period');
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(res.y[i] - Y0[i]) < 1, `position ${i}: ${res.y[i]} vs ${Y0[i]}`);
  for (let i = 3; i < 6; i++) assert.ok(Math.abs(res.y[i] - Y0[i]) < 1e-3, `velocity ${i}: ${res.y[i]} vs ${Y0[i]}`);
});

test('integrators: fsal uses fewer right-hand-side calls and the same final state as fsal off', () => {
  const on = runManual(true, false);
  const off = runManual(false, false);
  assert.ok(on.calls < off.calls, `fsal on ${on.calls} calls, off ${off.calls}`);
  assert.equal(on.steps, off.steps, 'same step sequence');
  assertVecRel([on.y[0], on.y[1], on.y[2]], [off.y[0], off.y[1], off.y[2]], 1e-9, 'final state fsal on vs off (position)');
  assertVecRel([on.y[3], on.y[4], on.y[5]], [off.y[3], off.y[4], off.y[5]], 1e-9, 'final state fsal on vs off (velocity)');
});

test('integrators: invalidate forces the first stage to be re-evaluated', () => {
  // Two identical solvers take the same first step; one reuses the stage on the second step,
  // the other is invalidated first. The invalidated step must cost exactly one call more.
  const a = makeTwoBody();
  const solverA = new Dopri5(a.f, { ...TOL, fsal: true, hInit: 1 });
  const s1A = solverA.step(0, Y0, PERIOD);
  const beforeA = a.calls();
  const s2A = solverA.step(s1A.t, s1A.y, PERIOD);
  const reuseDelta = a.calls() - beforeA;

  const b = makeTwoBody();
  const solverB = new Dopri5(b.f, { ...TOL, fsal: true, hInit: 1 });
  const s1B = solverB.step(0, Y0, PERIOD);
  solverB.invalidate();
  const beforeB = b.calls();
  const s2B = solverB.step(s1B.t, s1B.y, PERIOD);
  const invalidDelta = b.calls() - beforeB;

  assert.ok(invalidDelta >= 7, `after invalidate the step calls f at least 7 times, got ${invalidDelta}`);
  assert.equal(invalidDelta, reuseDelta + 1, `invalidated step costs one extra call (reuse ${reuseDelta}, invalid ${invalidDelta})`);
  assert.equal(s2B.t, s2A.t);
  assert.deepStrictEqual(s2B.y, s2A.y, 'same step result either way');
});

test('integrators: fsal with y.slice() copies still gives the correct answer', () => {
  const copied = runManual(true, true);
  const off = runManual(false, false);
  assertVecRel([copied.y[0], copied.y[1], copied.y[2]], [off.y[0], off.y[1], off.y[2]], 1e-9, 'copied fsal vs fsal off (position)');
  assertVecRel([copied.y[3], copied.y[4], copied.y[5]], [off.y[3], off.y[4], off.y[5]], 1e-9, 'copied fsal vs fsal off (velocity)');
});

// ---- 6. ephemeris memo ------------------------------------------------------

test('ephemeris: repeated calls return equal values in distinct arrays', () => {
  for (const [name, fn] of [
    ['sun', sunPosition],
    ['moon', moonPosition],
  ] as const) {
    const jd = 2460000.5;
    const a = fn(jd);
    const b = fn(jd);
    assert.notStrictEqual(a, b, `${name}: distinct objects`);
    assert.deepStrictEqual(a, b, `${name}: equal values`);
    const snapshot = b.slice();
    a[0] = 1e30;
    a[1] = -1e30;
    assert.deepStrictEqual(b, snapshot, `${name}: mutating one result leaves the other alone`);
    const c = fn(jd);
    assert.deepStrictEqual(c, snapshot, `${name}: mutation does not leak into the memo`);
  }
});

test('ephemeris: jd, jd+1, jd gives the original values', () => {
  const jd = 2460000.5;
  const sunA = sunPosition(jd).slice();
  sunPosition(jd + 1);
  assert.deepStrictEqual(sunPosition(jd), sunA, 'sun');
  const moonA = moonPosition(jd).slice();
  moonPosition(jd + 1);
  assert.deepStrictEqual(moonPosition(jd), moonA, 'moon');
});
