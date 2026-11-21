import { describe, expect, it } from 'vitest';
import {
  type Flaw,
  type Motor,
  type Parachute,
  type PhysicsDeps,
  type RocketModel,
  type Sim,
  type SimConfig,
} from '../types';
import { createSim } from './sim';
import { analyzeFlight } from './flaws';

// Stub models, matching the scale of the sim tests.
const MASS = 0.06;
const IP = 2e-4;
const IR = 5e-6;
const BODY_D = 0.025;
const BODY_R = BODY_D / 2;
const AREF = Math.PI * BODY_R * BODY_R;
const CG = 0.1;
const ROCKET_LENGTH = 0.2;

function makeDeps(cpX: number, cnAlpha = 2): PhysicsDeps {
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

function makeMotor(thrust: number, burn: number): Motor {
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

function makeRocket(withChute: boolean): RocketModel {
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
  ];
  if (withChute) {
    const chute: Parachute = {
      kind: 'parachute',
      id: 'chute',
      name: 'Main chute',
      x: 0.05,
      length: 0.01,
      density: 0,
      diameter: 0.2,
      cd: 0.8,
      deployEvent: 'apogee',
      deployAltitude: 0,
      deployDelay: 0,
      mass: 0.005,
    };
    components.push(chute);
  }
  return { name: 'Test rocket', components, length: ROCKET_LENGTH, maxRadius: BODY_R, stageCount: 1, warnings: [] };
}

function runFlight(
  rocket: RocketModel,
  motor: Motor,
  config: SimConfig,
  deps: PhysicsDeps,
): Sim {
  const sim = createSim(rocket, motor, config, deps);
  sim.ignite();
  for (let i = 0; i < 4000 && !sim.done; i++) sim.step(0.5);
  return sim;
}

function config(over: Partial<SimConfig> = {}): SimConfig {
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

function ids(flaws: Flaw[], severity?: Flaw['severity']): string[] {
  return flaws.filter((f) => !severity || f.severity === severity).map((f) => f.id);
}

describe('analyzeFlight', () => {
  it('flags an unstable rocket (CP ahead of CG) as critical', () => {
    const motor = makeMotor(6, 1.5);
    const rocket = makeRocket(true);
    const cfg = config({ windSpeed: 1 });
    const sim = runFlight(rocket, motor, cfg, makeDeps(0.08));
    const flaws = analyzeFlight(sim, rocket, motor, cfg);
    const unstable = flaws.find((f) => f.id === 'unstable');
    expect(unstable).toBeDefined();
    expect(unstable!.severity).toBe('critical');
    expect(unstable!.value!).toBeLessThan(1);
  });

  it('flags a rocket with no parachute as critical no-deploy', () => {
    const motor = makeMotor(6, 1.5);
    const rocket = makeRocket(false);
    const cfg = config();
    const sim = runFlight(rocket, motor, cfg, makeDeps(0.15));
    expect(sim.events.some((e) => e.type === 'crash')).toBe(true);
    const flaws = analyzeFlight(sim, rocket, motor, cfg);
    expect(ids(flaws, 'critical')).toContain('no-deploy');
  });

  it('flags a slow rail exit as critical', () => {
    // 0.8 N on 0.06 kg clears the 0.59 N rail weight, but leaves the 1 m rail at about 2.7 m/s.
    const motor = makeMotor(0.8, 5);
    const rocket = makeRocket(true);
    const cfg = config();
    const sim = runFlight(rocket, motor, cfg, makeDeps(0.15));
    const exit = sim.events.find((e) => e.type === 'railExit');
    expect(exit).toBeDefined();
    expect(exit!.speed).toBeLessThan(10);
    const flaws = analyzeFlight(sim, rocket, motor, cfg);
    expect(ids(flaws, 'critical')).toContain('rail-exit-slow');
  });

  it('a clean, stable flight with a parachute has no critical flaws', () => {
    const motor = makeMotor(6, 1.5);
    const rocket = makeRocket(true);
    const cfg = config();
    const sim = runFlight(rocket, motor, cfg, makeDeps(0.15));
    expect(sim.state.phase).toBe('landed');
    const flaws = analyzeFlight(sim, rocket, motor, cfg);
    expect(ids(flaws, 'critical')).toEqual([]);
  });

  it('reports no-motor as critical when there is no motor', () => {
    const rocket = makeRocket(true);
    const sim = { log: [], events: [] };
    const flaws = analyzeFlight(sim, rocket, null, config());
    expect(ids(flaws, 'critical')).toEqual(['no-motor']);
  });

  it('sorts critical before warning before info', () => {
    const motor = makeMotor(0.8, 5);
    const rocket = makeRocket(false);
    const cfg = config();
    const sim = runFlight(rocket, motor, cfg, makeDeps(0.15));
    const flaws = analyzeFlight(sim, rocket, motor, cfg);
    const order = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < flaws.length; i++) {
      expect(order[flaws[i].severity]).toBeGreaterThanOrEqual(order[flaws[i - 1].severity]);
    }
  });
});
