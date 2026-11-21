import { describe, it, expect } from 'vitest';
import { parseOrkFile } from './parser';
import { RH200_ORK_XML, RH200_STAGE_MOTORS } from './rh200';
import { thrustAt } from './motors';
import { createSim } from '../physics/sim';
import { massProps } from '../physics/massprops';
import { aeroProps } from '../physics/aero';
import { atmosphere } from '../physics/atmosphere';

describe('RH-200 sounding rocket sample', () => {
  it('parses into 2 stages and flies without crashing', async () => {
    const bytes = new TextEncoder().encode(RH200_ORK_XML);
    const rocket = await parseOrkFile(bytes);

    expect(rocket.name).toBe('ISRO RH-200');
    expect(rocket.stageCount).toBe(2);
    expect(rocket.stages).toHaveLength(2);
    expect(rocket.length).toBeCloseTo(3.6, 2);

    const sim = createSim(
      rocket,
      RH200_STAGE_MOTORS[0].motor,
      {
        railLength: 5,
        railAngle: 0.05,
        railAzimuth: 0,
        windSpeed: 0,
        windDirection: 0,
        gust: 0,
        launchAltitude: 0,
        stageMotors: RH200_STAGE_MOTORS,
      },
      { massProps, aeroProps, thrust: thrustAt, atmosphere },
    );

    sim.ignite();
    sim.step(120);

    expect(Number.isFinite(sim.state.altitude)).toBe(true);
    expect(sim.state.altitude).toBeGreaterThan(1000);
    const types = sim.events.map((e) => e.type);
    expect(types).toContain('stage separation');
    expect(types).toContain('stage ignition');
  });
});
