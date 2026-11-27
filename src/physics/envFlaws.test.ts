import { describe, expect, it } from 'vitest';
import type { RocketModel, SimConfig, SimState } from '../types';
import { thrustAt } from '../ork/motors';
import { aeroProps } from './aero';
import { atmosphere } from './atmosphere';
import { cachedDeps } from './cache';
import {
  analyzeEnvironment,
  ejectionChargeMass,
  finRootStress,
  materialFromDensity,
  recoveryTemp,
  tubeAxialLoads,
  tubeCrushLoad,
} from './envFlaws';
import { FIXTURE_MOTOR, FIXTURE_ROCKET } from './fixture';
import { massProps } from './massprops';
import { createSim } from './sim';

function makeState(over: Partial<SimState> = {}): SimState {
  return {
    t: 0,
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    quat: [0, 0, 0, 1],
    omega: [0, 0, 0],
    phase: 'boost',
    mass: 0.06,
    altitude: 0,
    speed: 0,
    mach: 0,
    alpha: 0,
    dynamicPressure: 0,
    thrust: 0,
    drag: 0,
    accelG: 0,
    cgX: 0.15,
    cpX: 0.25,
    stabilityCal: 2,
    chuteDeployed: false,
    ...over,
  };
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

describe('envFlaws helpers', () => {
  it('maps material densities to AirframeMaterial tiers', () => {
    expect(materialFromDensity(0)).toBeNull();
    expect(materialFromDensity(130)?.name).toBe('balsa');
    expect(materialFromDensity(680)?.name).toBe('paper or plywood');
    expect(materialFromDensity(1250)?.maxTemp).toBe(330);
    expect(materialFromDensity(1850)?.name).toBe('composite');
  });

  it('computes adiabatic recovery temperature', () => {
    expect(Math.abs(recoveryTemp(288.15, 1) - 339.44)).toBeLessThan(0.01);
  });

  it('computes body tube crush load', () => {
    const load = tubeCrushLoad(0.0125, 0.0005, materialFromDensity(680)!);
    expect(load).toBeGreaterThan(300);
    expect(load).toBeLessThan(320);
  });

  it('computes fin root bending stress and handles zero thickness', () => {
    const stress = finRootStress(1000, 0.04, 0.05, 0.025, 0.003);
    expect(Math.abs(stress - 967_900) / 967_900).toBeLessThan(0.005);
    expect(finRootStress(1000, 0.04, 0.05, 0.025, 0)).toBe(0);
  });

  it('computes ejection charge mass', () => {
    const mass = ejectionChargeMass(3.7e-3);
    expect(Math.abs(mass - 1.74e-3) / 1.74e-3).toBeLessThan(0.005);
  });
});

describe('analyzeEnvironment', () => {
  it('returns no flaws on a real flight of FIXTURE_ROCKET with FIXTURE_MOTOR', () => {
    const cfg = makeConfig();
    const sim = createSim(
      FIXTURE_ROCKET,
      FIXTURE_MOTOR,
      cfg,
      cachedDeps({
        atmosphere,
        massProps,
        aeroProps,
        thrust: thrustAt,
      }),
    );
    sim.ignite();
    for (let i = 0; i < 4000 && !sim.done; i++) sim.step(0.5);
    expect(sim.log.length).toBeGreaterThan(0);
    expect(analyzeEnvironment(sim, FIXTURE_ROCKET, cfg)).toEqual([]);
  });

  it('flags sustained aerodynamic heating on a plastic nose as critical', () => {
    const rocket: RocketModel = {
      name: 'Hot nose',
      length: 0.3,
      maxRadius: 0.0125,
      stageCount: 1,
      warnings: [],
      components: [
        {
          kind: 'nosecone',
          id: 'nose',
          name: 'Plastic nose',
          x: 0,
          length: 0.07,
          density: 1250,
          shape: 'ogive',
          shapeParam: 0,
          baseRadius: 0.0125,
          thickness: 0.001,
        },
      ],
    };
    const log = Array.from({ length: 30 }, (_, i) =>
      makeState({ t: i * 0.1, mach: 1.2, altitude: 500 }),
    );
    const flaws = analyzeEnvironment({ log, events: [] }, rocket, makeConfig());
    const heating = flaws.filter((f) => f.id.startsWith('aero-heating:'));
    expect(heating).toHaveLength(1);
    expect(heating[0].severity).toBe('critical');
  });

  it('flags brief aerodynamic heating on a plastic nose as warning', () => {
    const rocket: RocketModel = {
      name: 'Brief hot nose',
      length: 0.3,
      maxRadius: 0.0125,
      stageCount: 1,
      warnings: [],
      components: [
        {
          kind: 'nosecone',
          id: 'nose',
          name: 'Plastic nose',
          x: 0,
          length: 0.07,
          density: 1250,
          shape: 'ogive',
          shapeParam: 0,
          baseRadius: 0.0125,
          thickness: 0.001,
        },
      ],
    };
    const log = Array.from({ length: 30 }, (_, i) =>
      makeState({ t: i * 0.1, mach: i < 3 ? 1.2 : 0.3, altitude: 500 }),
    );
    const flaws = analyzeEnvironment({ log, events: [] }, rocket, makeConfig());
    const heating = flaws.filter((f) => f.id.startsWith('aero-heating:'));
    expect(heating).toHaveLength(1);
    expect(heating[0].severity).toBe('warning');
  });

  it('flags excessive thrust on a paper body tube as critical airframe-crush', () => {
    const rocket: RocketModel = {
      name: 'Paper tube rocket',
      length: 0.3,
      maxRadius: 0.0125,
      stageCount: 1,
      warnings: [],
      components: [
        {
          kind: 'bodytube',
          id: 'body',
          name: 'Paper body tube',
          x: 0,
          length: 0.3,
          density: 680,
          outerRadius: 0.0125,
          thickness: 0.0005,
        },
      ],
    };
    // Thrust raised from 400 N: the tube only carries its own share (~13 %) of it now.
    const log = [makeState({ t: 0.2, thrust: 3000 })];
    const flaws = analyzeEnvironment({ log, events: [] }, rocket, makeConfig());
    const crush = flaws.filter((f) => f.id.startsWith('airframe-crush:'));
    expect(crush).toHaveLength(1);
    expect(crush[0].severity).toBe('critical');
    // Past the crush load the text must not say it merely approaches it.
    expect(crush[0].detail).toContain('exceeds');
  });

  function twoTubeRocket(): RocketModel {
    const tube = (id: string, x: number): RocketModel['components'][number] => ({
      kind: 'bodytube',
      id,
      name: id,
      x,
      length: 0.1,
      density: 680,
      outerRadius: 0.0125,
      thickness: 0.0005,
      massOverride: 0.05,
    });
    return {
      name: 'Two tubes',
      length: 0.27,
      maxRadius: 0.0125,
      stageCount: 1,
      warnings: [],
      components: [
        {
          kind: 'nosecone',
          id: 'nose',
          name: 'Nose',
          x: 0,
          length: 0.07,
          density: 680,
          shape: 'ogive',
          shapeParam: 0,
          baseRadius: 0.0125,
          thickness: 0.001,
          massOverride: 0.01,
        },
        tube('fore', 0.07),
        tube('aft', 0.17),
      ],
    };
  }

  it('loads a forward tube less than an aft tube of the same wall', () => {
    const rocket = twoTubeRocket();
    const log = [makeState({ t: 0.1, mass: 0.2, thrust: 100 })];
    const loads = tubeAxialLoads(log, rocket);
    // fore: nose 0.01 + fore 0.05 = 0.06 kg ahead; aft: all 0.11 kg.
    expect(loads.get('fore')!.massAhead).toBeCloseTo(0.06, 9);
    expect(loads.get('aft')!.massAhead).toBeCloseTo(0.11, 9);
    expect(loads.get('fore')!.peak).toBeLessThan(loads.get('aft')!.peak);
  });

  it('does not flag a forward tube that carries little while the aft tube is flagged', () => {
    const rocket = twoTubeRocket();
    // Crush load of this wall is ~310 N (warning above ~155 N). Fore carries 0.06/0.2 = 30 %
    // of 400 N = 120 N; aft carries 55 % = 220 N.
    const log = [makeState({ t: 0.1, mass: 0.2, thrust: 400 })];
    const crush = analyzeEnvironment({ log, events: [] }, rocket, makeConfig()).filter((f) =>
      f.id.startsWith('airframe-crush:'),
    );
    expect(crush.map((f) => f.id)).toEqual(['airframe-crush:aft']);
  });

  it('equals thrust * mAhead / mass when drag is zero, and adds drag otherwise', () => {
    const rocket = twoTubeRocket();
    const loads = tubeAxialLoads([makeState({ t: 0.3, mass: 0.2, thrust: 100 })], rocket);
    // 100 * 0.06 / 0.2 = 30 N
    expect(loads.get('fore')!.peak).toBeCloseTo(30, 9);
    expect(loads.get('fore')!.t).toBe(0.3);
    const withDrag = tubeAxialLoads([makeState({ mass: 0.2, thrust: 100, drag: 10 })], rocket);
    // 0.3 * (100 - 10) + 10 = 37 N
    expect(withDrag.get('fore')!.peak).toBeCloseTo(37, 9);
    // Unpowered samples carry no crush load.
    expect(tubeAxialLoads([makeState({ thrust: 0, drag: 10 })], rocket).get('fore')!.peak).toBe(0);
  });

  it('flags excessive fin root bending stress on balsa fins as critical', () => {
    const rocket: RocketModel = {
      name: 'Thin balsa fins',
      length: 0.3,
      maxRadius: 0.0125,
      stageCount: 1,
      warnings: [],
      components: [
        {
          kind: 'finset',
          id: 'fins',
          name: 'Balsa fins',
          x: 0.25,
          length: 0.05,
          density: 130,
          count: 3,
          rootChord: 0.05,
          tipChord: 0.025,
          span: 0.04,
          sweepLength: 0.025,
          thickness: 0.001,
          cant: 0,
          bodyRadius: 0.0125,
          finShape: 'trapezoid',
        },
      ],
    };
    const log = [makeState({ t: 0.5, phase: 'boost', dynamicPressure: 60_000, alpha: 0.2 })];
    const flaws = analyzeEnvironment({ log, events: [] }, rocket, makeConfig());
    const bend = flaws.filter((f) => f.id.startsWith('fin-root-bending:'));
    expect(bend).toHaveLength(1);
    expect(bend[0].severity).toBe('critical');
  });
});
