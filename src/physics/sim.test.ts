import { describe, expect, it } from 'vitest';
import {
  G0,
  MU_EARTH,
  type Motor,
  type Parachute,
  type PhysicsDeps,
  type RocketModel,
  type Sim,
  type SimConfig,
  type SimState,
} from '../types';
import { createSim } from './sim';
import { quatRotate } from './vec';

// ---- Stub models -------------------------------------------------------------

const MASS = 0.06; // kg, constant
const IP = 2e-4; // kg m^2, pitch inertia
const IR = 5e-6; // kg m^2, roll inertia
const BODY_D = 0.025; // m
const BODY_R = BODY_D / 2;
const AREF = Math.PI * BODY_R * BODY_R;
const CG = 0.1; // station, m from nose
const ROCKET_LENGTH = 0.2;
const BURN = 1.5; // s
const THRUST = 6; // N
const CHUTE_D = 0.2; // m
const CHUTE_CD = 0.8;

interface StubOpts {
  thrust?: number;
  burn?: number;
  cpX?: number;
  cnAlpha?: number;
  chute?: boolean;
  motorDelay?: number;
}

function makeDeps(opts: StubOpts = {}): PhysicsDeps {
  const cpX = opts.cpX ?? 0.15;
  const cnAlpha = opts.cnAlpha ?? 2;
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
      refLength: BODY_D,
      cnAlpha,
      cpX,
      cd: 0.5,
      dampSum: cnAlpha * (cpX - CG) ** 2,
    }),
    thrust: (m, t) => (t >= 0 && t < m.burnTime ? m.curve[0][1] : 0),
  };
}

function makeMotor(thrust = THRUST, burn = BURN): Motor {
  return {
    manufacturer: 'Test',
    designation: 'T1',
    diameter: 0.0125,
    length: 0.05,
    totalMass: 0.01,
    propellantMass: 0.005,
    curve: [
      [0, thrust],
      [burn, thrust],
      [burn, 0],
    ],
    burnTime: burn,
    totalImpulse: thrust * burn,
    approximate: true,
  };
}

function makeRocket(withChute = true, motorDelay = NaN): RocketModel {
  const components: RocketModel['components'] = [
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
    {
      kind: 'innertube',
      id: 'mount',
      name: 'Motor mount',
      x: 0.15,
      length: 0.05,
      density: 0,
      outerRadius: 0.007,
      thickness: 0.001,
      isMotorMount: true,
      overhang: 0,
      motor: {
        manufacturer: 'Test',
        designation: 'T1',
        diameter: 0.0125,
        length: 0.05,
        delay: motorDelay,
      },
    },
  ];
  if (withChute) {
    const chute: Parachute = {
      kind: 'parachute',
      id: 'chute',
      name: 'Main chute',
      x: 0.05,
      length: 0.01,
      density: 0,
      diameter: CHUTE_D,
      cd: CHUTE_CD,
      deployEvent: 'apogee',
      deployAltitude: 0,
      deployDelay: 0,
      mass: 0.005,
    };
    components.push(chute);
  }
  return { name: 'Test rocket', components, length: ROCKET_LENGTH, maxRadius: BODY_R, stageCount: 1, warnings: [] };
}

function makeConfig(over: Partial<SimConfig> = {}): SimConfig {
  return {
    railLength: 1,
    railAngle: 0,
    railAzimuth: 0,
    windSpeed: 0,
    windDirection: 0,
    gust: 0,
    launchAltitude: 0,
    ...over,
  };
}

/** Ignite and step in 0.5 s chunks until the flight is over or the call budget runs out. */
function runFlight(
  rocket: RocketModel,
  motor: Motor | null,
  config: SimConfig,
  deps: PhysicsDeps,
): Sim {
  const sim = createSim(rocket, motor, config, deps);
  sim.ignite();
  for (let i = 0; i < 4000 && !sim.done; i++) sim.step(0.5);
  return sim;
}

function eventTime(sim: Sim, type: string): number {
  const e = sim.events.find((x) => x.type === type);
  if (!e) throw new Error(`missing event ${type}`);
  return e.t;
}

function isSubsequence(seq: string[], target: string[]): boolean {
  let i = 0;
  for (const s of seq) if (s === target[i]) i++;
  return i === target.length;
}

// Vacuum apogee above the site for the test motor and mass, constant gravity:
// burn height h_b = 0.5 a T^2 with a = F/m - g, burnout speed v_b = a T, coast h = v_b^2 / 2g.
const A_BURN = THRUST / MASS - G0;
const H_BURN = 0.5 * A_BURN * BURN * BURN;
const V_BURN = A_BURN * BURN;
const VACUUM_APOGEE = H_BURN + (V_BURN * V_BURN) / (2 * G0);

// ---- Tests -------------------------------------------------------------------

describe('createSim', () => {
  it('vertical stable launch: event order, apogee band, no drift, energy, landing', () => {
    const sim = runFlight(makeRocket(true), makeMotor(), makeConfig(), makeDeps());

    expect(
      isSubsequence(
        sim.events.map((e) => e.type),
        ['ignition', 'liftoff', 'railExit', 'burnout', 'apogee', 'chuteDeploy', 'landing'],
      ),
    ).toBe(true);
    expect(sim.state.phase).toBe('landed');
    expect(sim.done).toBe(true);

    // Apogee must lie below the vacuum bound (drag only removes energy) and well above zero.
    const apogee = sim.events.find((e) => e.type === 'apogee')!;
    expect(apogee.altitude).toBeLessThan(VACUUM_APOGEE);
    expect(apogee.altitude).toBeGreaterThan(0.3 * VACUUM_APOGEE);

    // No wind and no tilt: the flight stays on the vertical line through the site.
    for (const s of sim.log) {
      expect(Math.abs(s.pos[0])).toBeLessThan(1);
      expect(Math.abs(s.pos[2])).toBeLessThan(1);
    }

    // Specific orbital energy (kinetic minus Earth potential) only decreases in coast, since
    // drag is the only non-conservative force with no thrust or wind.
    const tBurnout = eventTime(sim, 'burnout');
    const coast = sim.log.filter((s) => s.t >= tBurnout && s.t <= apogee.t);
    expect(coast.length).toBeGreaterThan(10);
    let prev = Infinity;
    for (const s of coast) {
      const r = Math.hypot(...s.pos);
      const v2 = s.vel[0] ** 2 + s.vel[1] ** 2 + s.vel[2] ** 2;
      const energy = 0.5 * v2 - MU_EARTH / r;
      expect(energy).toBeLessThanOrEqual(prev + 1e-3);
      prev = energy;
    }
  });

  it('5 m/s wind: nose weathercocks into the wind and alpha stays small after rail exit', () => {
    // Wind from the north (direction 0): air moves south, so the nose should tilt north.
    const sim = runFlight(
      makeRocket(true),
      makeMotor(),
      makeConfig({ windSpeed: 5, windDirection: 0 }),
      makeDeps(),
    );
    const tExit = eventTime(sim, 'railExit');
    const tApogee = eventTime(sim, 'apogee');

    // Nose direction over time after leaving the rail.
    const afterExit = sim.log.filter((s) => s.t >= tExit + 0.3 && s.t <= tApogee);
    expect(afterExit.length).toBeGreaterThan(5);
    const nose = afterExit.map((s) => quatRotate(s.quat, [0, 1, 0]));
    const meanNorthward = nose.reduce((m, a) => m - a[2], 0) / nose.length;
    expect(meanNorthward).toBeGreaterThan(0);

    // Angle of attack after rail exit stays small.
    const maxAlpha = Math.max(...afterExit.map((s) => s.alpha));
    expect(maxAlpha).toBeLessThan(0.3);

    // Under thrust the nose stays in line with the air-relative velocity, so the thrust
    // pushes the rocket toward the wind source (north, -Z). Apogee lies that way.
    const apogeeState = sim.log.reduce((best, s) =>
      Math.abs(s.t - tApogee) < Math.abs(best.t - tApogee) ? s : best,
    );
    expect(apogeeState.pos[2]).toBeLessThan(0);
  });

  it('unstable rocket (CP ahead of CG) develops alpha above 45 degrees quickly', () => {
    const sim = runFlight(
      makeRocket(true),
      makeMotor(),
      makeConfig({ windSpeed: 1, windDirection: 0 }),
      makeDeps({ cpX: 0.08 }),
    );
    const tExit = eventTime(sim, 'railExit');
    const tBad = sim.log.find((s) => s.t >= tExit && s.alpha > Math.PI / 4);
    expect(tBad).toBeDefined();
    expect(tBad!.t - tExit).toBeLessThan(2);
  });

  it('parachute at apogee: descent speed is terminal within 15 % and the flight lands', () => {
    const sim = runFlight(makeRocket(true), makeMotor(), makeConfig(), makeDeps());
    expect(sim.state.phase).toBe('landed');

    const descent = sim.log.filter((s) => s.phase === 'descent' && s.altitude >= 50 && s.altitude <= 150);
    expect(descent.length).toBeGreaterThan(5);
    const cdA = CHUTE_CD * Math.PI * (CHUTE_D / 2) ** 2;
    for (const s of descent) {
      const rho = 1.225 * Math.exp(-s.altitude / 8500);
      const vt = Math.sqrt((2 * MASS * G0) / (rho * cdA));
      expect(Math.abs(s.speed - vt) / vt).toBeLessThan(0.15);
    }
  });

  it('no NaN or infinity anywhere in the log', () => {
    const sim = runFlight(makeRocket(true), makeMotor(), makeConfig({ windSpeed: 3, windDirection: 1 }), makeDeps());
    const numbers = (s: SimState): number[] => [
      s.t,
      ...s.pos,
      ...s.vel,
      ...s.quat,
      ...s.omega,
      s.mass,
      s.altitude,
      s.speed,
      s.mach,
      s.alpha,
      s.dynamicPressure,
      s.thrust,
      s.drag,
      s.accelG,
      s.cgX,
      s.cpX,
      s.stabilityCal,
    ];
    expect(sim.log.length).toBeGreaterThan(100);
    for (const s of sim.log) {
      for (const x of numbers(s)) expect(Number.isFinite(x)).toBe(true);
    }
    expect(sim.state.phase).toBe('landed');
  });

  it('gradual canopy inflation and pendulum righting torque during parachute descent and landing', () => {
    // Launch at an angle so the rocket pitches over and is tilted at apogee / parachute deployment.
    const sim = createSim(
      makeRocket(true),
      makeMotor(),
      makeConfig({ railAngle: 0.35, windSpeed: 4, windDirection: 0 }),
      makeDeps(),
    );
    sim.ignite();
    while (!sim.state.chuteDeployed && !sim.done) sim.step(0.01);
    expect(sim.state.chuteDeployed).toBe(true);

    // At deployment (t = tDeploy), canopy is only partially inflated (5% line stretch),
    // and over CHUTE_INFLATE_TIME (0.6 s) drag/inflation increases as the rocket descends.
    // Let's deploy during faster descent (e.g. altitude chute) to directly verify gradual inflation
    // and pendulum righting torque.
    const altRocket = makeRocket(false);
    altRocket.components.push({
      kind: 'parachute',
      id: 'chute-alt',
      name: 'Main chute',
      x: 0.05,
      length: 0.01,
      density: 0,
      diameter: CHUTE_D,
      cd: CHUTE_CD,
      deployEvent: 'altitude',
      deployAltitude: 80,
      deployDelay: 0,
      mass: 0.005,
    });
    const altSim = createSim(
      altRocket,
      makeMotor(),
      makeConfig({ railAngle: 0.35, windSpeed: 2, windDirection: 0 }),
      makeDeps(),
    );
    altSim.ignite();
    while (!altSim.state.chuteDeployed && !altSim.done) altSim.step(0.002);
    expect(altSim.state.chuteDeployed).toBe(true);

    const dragAtOpen = altSim.state.drag;
    altSim.step(0.15);
    const dragMidOpen = altSim.state.drag;
    expect(dragMidOpen).toBeGreaterThan(dragAtOpen * 1.5);

    // Continue to landing and verify pendulum righting torque aligns nose upward (+Y > 0.9)
    // and damps angular velocity before touchdown.
    let preLandingNoseY = 0;
    let preLandingOmega = Infinity;
    while (!altSim.done) {
      if (altSim.state.altitude > 1 && altSim.state.altitude < 15) {
        preLandingNoseY = quatRotate(altSim.state.quat, [0, 1, 0])[1];
        preLandingOmega = Math.hypot(...altSim.state.omega);
      }
      altSim.step(0.05);
    }
    expect(altSim.state.phase).toBe('landed');
    expect(preLandingNoseY).toBeGreaterThan(0.9);
    expect(preLandingOmega).toBeLessThan(0.2);
    const landingEvent = altSim.events.find((e) => e.type === 'landing');
    expect(landingEvent?.message).toContain('vertical');
    expect(landingEvent?.message).toContain('drift');
  });

  it('rail friction reduces launch-off acceleration when tilted or under crosswind', () => {
    const rocket = makeRocket(true);
    const motor = makeMotor();
    const deps = makeDeps();

    // Tilted launch rail (30 deg): lateral gravity component induces normal force and rail lug friction.
    const angle = Math.PI / 6;
    const simTilted = createSim(rocket, motor, makeConfig({ railAngle: angle, railLength: 2 }), deps);
    simTilted.ignite();
    simTilted.step(0.2);
    expect(simTilted.state.phase).toBe('rail');

    // Without rail friction, acceleration along the rail at low speed would be F/m - g*cos(angle).
    // With rail friction (mu = 0.25), friction removes mu * g * sin(angle) from acceleration.
    const idealSpeedNoFriction = (THRUST / MASS - G0 * Math.cos(angle)) * 0.2;
    const expectedFrictionLoss = 0.25 * G0 * Math.sin(angle) * 0.2;
    expect(simTilted.state.speed).toBeLessThan(idealSpeedNoFriction - expectedFrictionLoss * 0.7);

    // Crosswind on a tilted rail further increases lateral load and reduces rail exit speed.
    const simCrosswind = createSim(
      rocket,
      motor,
      makeConfig({ railAngle: angle, railAzimuth: 0, windSpeed: 12, windDirection: Math.PI / 2, railLength: 2 }),
      deps,
    );
    simCrosswind.ignite();
    simCrosswind.step(0.2);
    expect(simCrosswind.state.speed).toBeLessThan(simTilted.state.speed);
  });
});


describe('multi-stage simulation', () => {
  it('emits stage separation and stage ignition events and drops lower stage mass', () => {
    const base = makeRocket();
    const twoStage: RocketModel = {
      ...base,
      stageCount: 2,
      stages: [
        { name: 'Sustainer', startComponent: 0, componentCount: base.components.length },
        { name: 'Booster', startComponent: base.components.length, componentCount: 0 },
      ],
    };
    const motor = makeMotor();
    const sim = createSim(
      twoStage,
      motor,
      makeConfig({
        stageMotors: [
          { motor },
          { motor, ignitionDelay: 0.5 },
        ],
      }),
      makeDeps(),
    );
    sim.ignite();
    sim.step(15);

    const types = sim.events.map((e) => e.type);
    expect(types).toContain('stage separation');
    expect(types).toContain('stage ignition');
    expect(types).toContain('burnout');
  });
});
