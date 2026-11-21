import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Motor,
  type Parachute,
  type PhysicsDeps,
  type RocketModel,
  type SimConfig,
  type StressReport,
} from '../types';
import { EJECTION_DELAYS_S, RAIL_ANGLES_DEG, WIND_SPEEDS_MS, runCase, stressTest } from './sweep';

// ---- Stub models (same approach as sim.test.ts) ------------------------------

const MASS = 0.06; // kg, constant
const IP = 2e-4; // kg m^2, pitch inertia
const IR = 5e-6; // kg m^2, roll inertia
const BODY_R = 0.0125; // m
const AREF = Math.PI * BODY_R * BODY_R;
const CG = 0.1; // station, m from nose
const ROCKET_LENGTH = 0.2;
const BURN = 1.5; // s
const THRUST = 6; // N

interface StubOpts {
  cpX?: number;
}

function makeDeps(opts: StubOpts = {}): PhysicsDeps {
  const cpX = opts.cpX ?? 0.15;
  const cnAlpha = 2;
  return {
    atmosphere: (h) => ({
      rho: 1.225 * Math.exp(-h / 8500),
      pressure: 101_325 * Math.exp(-h / 8500),
      temperature: 288.15,
      soundSpeed: 340,
    }),
    massProps: () => ({ mass: MASS, cgX: CG, iRoll: IR, iPitch: IP }),
    aeroProps: () => ({
      refArea: AREF,
      refLength: 2 * BODY_R,
      cnAlpha,
      cpX,
      cd: 0.5,
      dampSum: cnAlpha * (cpX - CG) ** 2,
    }),
    thrust: (m, t) => (t >= 0 && t < m.burnTime ? m.curve[0][1] : 0),
  };
}

function makeMotor(): Motor {
  return {
    manufacturer: 'Test',
    designation: 'T1',
    diameter: 0.0125,
    length: 0.05,
    totalMass: 0.01,
    propellantMass: 0.005,
    curve: [
      [0, THRUST],
      [BURN, THRUST],
      [BURN, 0],
    ],
    burnTime: BURN,
    totalImpulse: THRUST * BURN,
    approximate: true,
  };
}

/** Chute deploys on the ejection event so the delay sweep changes the result. */
function makeRocket(): RocketModel {
  const chute: Parachute = {
    kind: 'parachute',
    id: 'chute',
    name: 'Main chute',
    x: 0.05,
    length: 0.01,
    density: 0,
    // Small canopy: faster descent keeps each simulated flight short.
    diameter: 0.05,
    cd: 0.8,
    deployEvent: 'ejection',
    deployAltitude: 0,
    deployDelay: 0,
    mass: 0.005,
  };
  return {
    name: 'Test rocket',
    components: [
      {
        kind: 'bodytube',
        id: 'body',
        name: 'Body tube',
        x: 0,
        length: ROCKET_LENGTH,
        density: 0,
        outerRadius: BODY_R,
        thickness: 0.001,
      },
      chute,
    ],
    length: ROCKET_LENGTH,
    maxRadius: BODY_R,
    stageCount: 1,
    warnings: [],
  };
}

function makeConfig(over: Partial<SimConfig> = {}): SimConfig {
  return {
    railLength: 1,
    railAngle: 0,
    railAzimuth: 0,
    windSpeed: 2,
    windDirection: 0,
    gust: 0,
    launchAltitude: 0,
    ejectionDelay: 4,
    ...over,
  };
}

// ---- Tests -------------------------------------------------------------------

describe('runCase', () => {
  it('fills every result field for one flight', () => {
    const r = runCase(makeRocket(), makeMotor(), makeConfig({ ejectionDelay: 4 }), makeDeps(), 'calm');
    expect(r.label).toBe('calm');
    expect(r.apogee).toBeGreaterThan(0);
    expect(r.maxSpeed).toBeGreaterThan(r.railExitSpeed - 1e-9);
    expect(Number.isFinite(r.railExitSpeed)).toBe(true);
    expect(['landed', 'crashed', 'timeout']).toContain(r.outcome);
    expect(Number.isFinite(r.drift)).toBe(true);
    expect(r.maxAlpha).toBeGreaterThanOrEqual(0);
    expect(['ok', 'info', 'warning', 'critical']).toContain(r.worst);
  });
});

describe('stressTest', () => {
  let report: StressReport;

  beforeAll(() => {
    report = stressTest(makeRocket(), makeMotor(), makeConfig(), makeDeps());
  }, 120_000);

  it('returns one result per sweep value', () => {
    expect(report.wind).toHaveLength(WIND_SPEEDS_MS.length);
    expect(report.railAngle).toHaveLength(RAIL_ANGLES_DEG.length);
    expect(report.delay).toHaveLength(EJECTION_DELAYS_S.length);
    expect(report.wind.map((r) => r.config.windSpeed)).toEqual(WIND_SPEEDS_MS);
  });

  it('drift grows with wind', () => {
    const calm = report.wind[0].drift;
    const windy = report.wind[report.wind.length - 1].drift;
    expect(windy).toBeGreaterThan(calm);
  });

  it('produces a non-empty plain-language summary', () => {
    expect(report.summary.length).toBeGreaterThan(0);
    expect(report.summary.length).toBeLessThanOrEqual(6);
    for (const line of report.summary) expect(line.trim().length).toBeGreaterThan(0);
  });

  it('a stable rocket has a safe wind limit', () => {
    expect(report.maxSafeWind).not.toBeNull();
  });
});

describe('stressTest with an unstable rocket', () => {
  it('maxSafeWind is null when CP is ahead of CG', () => {
    const report = stressTest(makeRocket(), makeMotor(), makeConfig(), makeDeps({ cpX: 0.08 }));
    expect(report.maxSafeWind).toBeNull();
    expect(report.summary.length).toBeGreaterThan(0);
  }, 120_000);
});
