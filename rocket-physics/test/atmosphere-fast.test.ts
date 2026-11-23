// Checks the allocation-free atmosphereInto and the optimised atmosphere against a private
// copy of the original implementation (referenceAtmosphere below), field by field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atmosphere, atmosphereInto, type AtmosphereState } from '../src/env/atmosphere.ts';

// ---- reference: original implementation, copied verbatim (model code, unchanged) ----------

const G0P = 9.80665;
const M_AIR = 0.0289644; // kg/mol
const R_STAR = 8.31432; // J/(mol K), the value USSA76 uses
const R_SPECIFIC = R_STAR / M_AIR;
const R_EARTH_GEOPOT = 6356766; // m
const GAMMA = 1.4;
const AVOGADRO = 6.02214076e23;
const MOLECULE_DIAMETER = 3.65e-10; // effective collision diameter of air, m

const LAYERS: ReadonlyArray<readonly [number, number]> = [
  [0, -0.0065],
  [11000, 0],
  [20000, 0.001],
  [32000, 0.0028],
  [47000, 0],
  [51000, -0.0028],
  [71000, -0.002],
  [84852, 0],
];
const BASE_T: number[] = [288.15];
const BASE_P: number[] = [101325];
for (let i = 1; i < LAYERS.length; i++) {
  const [h0, L] = LAYERS[i - 1];
  const dh = LAYERS[i][0] - h0;
  const T0 = BASE_T[i - 1];
  const T1 = T0 + L * dh;
  BASE_T.push(T1);
  BASE_P.push(
    L === 0 ? BASE_P[i - 1] * Math.exp((-G0P * dh) / (R_SPECIFIC * T0)) : BASE_P[i - 1] * Math.pow(T1 / T0, -G0P / (L * R_SPECIFIC)),
  );
}

const EXPO: ReadonlyArray<readonly [number, number, number]> = [
  [90, 3.396e-6, 5.382],
  [100, 5.297e-7, 5.877],
  [110, 9.661e-8, 7.263],
  [120, 2.438e-8, 9.473],
  [130, 8.484e-9, 12.636],
  [140, 3.845e-9, 16.149],
  [150, 2.07e-9, 22.523],
  [180, 5.464e-10, 29.74],
  [200, 2.789e-10, 37.105],
  [250, 7.248e-11, 45.546],
  [300, 2.418e-11, 53.628],
  [350, 9.518e-12, 53.298],
  [400, 3.725e-12, 58.515],
  [450, 1.585e-12, 60.828],
  [500, 6.967e-13, 63.822],
  [600, 1.454e-13, 71.835],
  [700, 3.614e-14, 88.667],
  [800, 1.17e-14, 124.64],
  [900, 5.245e-15, 181.05],
  [1000, 3.019e-15, 268.0],
];

const REF_VACUUM: AtmosphereState = {
  temperature: 1000,
  pressure: 0,
  density: 0,
  speedOfSound: 634,
  viscosity: 0,
  meanFreePath: Infinity,
};

function refLower(z: number): { T: number; p: number } {
  const h = (R_EARTH_GEOPOT * z) / (R_EARTH_GEOPOT + z);
  let i = LAYERS.length - 1;
  while (i > 0 && h < LAYERS[i][0]) i--;
  const [h0, L] = LAYERS[i];
  const dh = h - h0;
  const T = BASE_T[i] + L * dh;
  const p = L === 0 ? BASE_P[i] * Math.exp((-G0P * dh) / (R_SPECIFIC * BASE_T[i])) : BASE_P[i] * Math.pow(T / BASE_T[i], -G0P / (L * R_SPECIFIC));
  return { T, p };
}

function refUpperTemperature(zkm: number): number {
  if (zkm < 91) return 186.8673;
  if (zkm < 110) {
    const x = (zkm - 91) / -19.9429;
    return 263.1905 - 76.3232 * Math.sqrt(Math.max(0, 1 - x * x));
  }
  if (zkm < 120) return 240 + 12 * (zkm - 110);
  const xi = ((zkm - 120) * (6356.766 + 120)) / (6356.766 + zkm);
  return 1000 - (1000 - 360) * Math.exp(-0.01875 * xi);
}

function refUpperDensity(zkm: number): number {
  let i = EXPO.length - 1;
  while (i > 0 && zkm < EXPO[i][0]) i--;
  const [h0, rho0, H] = EXPO[i];
  return rho0 * Math.exp(-(zkm - h0) / H);
}

const REF_RHO_86 = (() => {
  const { T, p } = refLower(86000);
  return p / (R_SPECIFIC * T);
})();

function referenceAtmosphere(z: number): AtmosphereState {
  if (z > 1.0e6) return { ...REF_VACUUM };
  let T: number;
  let rho: number;
  let p: number;
  if (z <= 86000) {
    const s = refLower(Math.max(z, -2000));
    T = s.T;
    p = s.p;
    rho = p / (R_SPECIFIC * T);
  } else {
    const zkm = z / 1000;
    T = refUpperTemperature(zkm);
    if (zkm < 90) {
      const f = (zkm - 86) / 4;
      rho = Math.exp(Math.log(REF_RHO_86) * (1 - f) + Math.log(refUpperDensity(90)) * f);
    } else {
      rho = refUpperDensity(zkm);
    }
    p = rho * R_SPECIFIC * T;
  }
  const n = (rho / M_AIR) * AVOGADRO;
  return {
    temperature: T,
    pressure: p,
    density: rho,
    speedOfSound: Math.sqrt(GAMMA * R_SPECIFIC * T),
    viscosity: (1.458e-6 * T * Math.sqrt(T)) / (T + 110.4),
    meanFreePath: 1 / (Math.SQRT2 * Math.PI * MOLECULE_DIAMETER * MOLECULE_DIAMETER * n),
  };
}

// ---- helpers ---------------------------------------------------------------------------

const FIELDS: ReadonlyArray<keyof AtmosphereState> = ['temperature', 'pressure', 'density', 'speedOfSound', 'viscosity', 'meanFreePath'];

// Relative agreement to 1e-12. Infinity === Infinity and 0 === 0 count as equal.
function assertStateClose(actual: AtmosphereState, expected: AtmosphereState, msg: string): void {
  for (const k of FIELDS) {
    const a = actual[k];
    const e = expected[k];
    if (a === e) continue;
    const ok = Math.abs(a - e) <= 1e-12 * Math.abs(e);
    assert.ok(ok, `${msg} field ${k}: actual=${a} expected=${e}`);
  }
}

const BOUNDARIES = [0, 11000, 20000, 32000, 47000, 51000, 71000, 86000, 90000, 91000, 110000, 120000, 1e6, 1e6 + 1];

// ---- tests -----------------------------------------------------------------------------

test('atmosphere: matches the original on a 137 m sweep from -3000 m to 1100 km', () => {
  const out = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, viscosity: 0, meanFreePath: 0 };
  for (let z = -3000; z <= 1100000; z += 137) {
    const ref = referenceAtmosphere(z);
    assertStateClose(atmosphere(z), ref, `atmosphere z=${z}`);
    assertStateClose(atmosphereInto(out, z), ref, `atmosphereInto z=${z}`);
  }
});

test('atmosphere: matches the original at exact layer, blend and vacuum boundaries', () => {
  const out = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, viscosity: 0, meanFreePath: 0 };
  for (const z of BOUNDARIES) {
    const ref = referenceAtmosphere(z);
    assertStateClose(atmosphere(z), ref, `atmosphere z=${z}`);
    assertStateClose(atmosphereInto(out, z), ref, `atmosphereInto z=${z}`);
  }
});

test('atmosphereInto: returns the same object it was given', () => {
  const out = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, viscosity: 0, meanFreePath: 0 };
  assert.equal(atmosphereInto(out, 30000), out);
  assert.equal(atmosphereInto(out, 2e6), out, 'vacuum branch also returns out');
  assert.equal(atmosphereInto(out, -500), out);
});

test('atmosphereInto: reusing one out across calls leaves no stale fields', () => {
  const out = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, viscosity: 0, meanFreePath: 0 };
  atmosphereInto(out, 2e6);
  assertStateClose(out, referenceAtmosphere(2e6), 'after vacuum');
  assert.equal(out.density, 0);
  assert.equal(out.meanFreePath, Infinity);

  atmosphereInto(out, 0);
  assertStateClose(out, referenceAtmosphere(0), 'after sea level');
  assert.ok(out.density > 1.2 && out.density < 1.25, `rho 0 = ${out.density}`);
  assert.ok(Number.isFinite(out.meanFreePath), 'mean free path finite again after vacuum');

  atmosphereInto(out, 100000);
  atmosphereInto(out, 1.5e6);
  atmosphereInto(out, 90000);
  assertStateClose(out, referenceAtmosphere(90000), 'after mixed sequence');
});

test('atmosphere: returned object is independent of atmosphereInto scratch use', () => {
  const a = atmosphere(50000);
  const out = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, viscosity: 0, meanFreePath: 0 };
  atmosphereInto(out, 120000);
  assertStateClose(a, referenceAtmosphere(50000), 'earlier result unchanged');
});

test('atmosphere: vacuum above 1000 km returns the shared VACUUM constant', () => {
  const v1 = atmosphere(1.5e6);
  const v2 = atmosphere(2e6);
  assert.equal(v1, v2, 'same shared object');
  assert.equal(v1.density, 0);
  assert.equal(v1.temperature, 1000);
  assert.equal(v1.speedOfSound, 634);
  assert.equal(v1.meanFreePath, Infinity);
});
