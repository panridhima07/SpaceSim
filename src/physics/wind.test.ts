import { describe, it, expect } from 'vitest';
import { siteAtmosphere, windVector } from './wind';
import { atmosphere } from './atmosphere';

const calmGust = { gust: 0 };

describe('windVector', () => {
  it('is still at and below the ground and in calm air', () => {
    expect(windVector({ windSpeed: 5, windDirection: 0, ...calmGust }, 0, 0)).toEqual([0, 0, 0]);
    expect(windVector({ windSpeed: 0, windDirection: 0, ...calmGust }, 50, 0)).toEqual([0, 0, 0]);
  });

  it('blows away from the bearing it comes from', () => {
    // From the west (270°): the air moves east, +X.
    const [x, , z] = windVector({ windSpeed: 4, windDirection: (270 * Math.PI) / 180, ...calmGust }, 10, 0);
    expect(x).toBeCloseTo(4);
    expect(z).toBeCloseTo(0);
  });

  it('follows the power law without winds aloft', () => {
    const [, , z] = windVector({ windSpeed: 4, windDirection: 0, ...calmGust }, 100, 0);
    expect(z).toBeCloseTo(4 * Math.pow(10, 0.14));
  });

  it('interpolates between layers and holds above the top one', () => {
    const cfg = {
      windSpeed: 2,
      windDirection: 0, // from north, moves south (+Z)
      ...calmGust,
      windLayers: [
        { altitude: 110, speed: 6, direction: 0 },
        { altitude: 1510, speed: 10, direction: Math.PI / 2 }, // from east, moves west (-X)
      ],
    };
    expect(windVector(cfg, 10, 0)[2]).toBeCloseTo(2);
    expect(windVector(cfg, 60, 0)[2]).toBeCloseTo(4);
    expect(windVector(cfg, 110, 0)[2]).toBeCloseTo(6);
    const mid = windVector(cfg, 810, 0);
    expect(mid[0]).toBeCloseTo(-5);
    expect(mid[2]).toBeCloseTo(3);
    const high = windVector(cfg, 5000, 0);
    expect(high[0]).toBeCloseTo(-10);
    expect(high[2]).toBeCloseTo(0);
  });

  it('still blows aloft when the surface is calm', () => {
    const cfg = { windSpeed: 0, windDirection: 0, ...calmGust, windLayers: [{ altitude: 100, speed: 5, direction: 0 }] };
    expect(windVector(cfg, 100, 0)[2]).toBeCloseTo(5);
  });
});

describe('siteAtmosphere', () => {
  it('returns the standard model untouched when nothing is measured', () => {
    expect(siteAtmosphere(atmosphere, { launchAltitude: 0 })).toBe(atmosphere);
  });

  it('thins the air and raises the speed of sound on a hot day', () => {
    const hot = siteAtmosphere(atmosphere, { launchAltitude: 0, groundTemperature: 308.15 });
    const std = atmosphere(0);
    const a = hot(0);
    expect(a.temperature).toBeCloseTo(308.15);
    expect(a.rho).toBeCloseTo(std.rho * (288.15 / 308.15), 4);
    expect(a.soundSpeed).toBeGreaterThan(std.soundSpeed);
    // The lapse with height is kept.
    expect(hot(1000).temperature).toBeCloseTo(308.15 - 6.5);
  });

  it('scales density with the measured pressure', () => {
    const low = siteAtmosphere(atmosphere, { launchAltitude: 0, groundPressure: 85000 });
    expect(low(0).pressure).toBeCloseTo(85000);
    expect(low(0).rho).toBeCloseTo(atmosphere(0).rho * (85000 / 101325), 4);
  });

  it('fades back to the standard model in the stratosphere', () => {
    const hot = siteAtmosphere(atmosphere, { launchAltitude: 0, groundTemperature: 308.15, groundPressure: 99000 });
    expect(hot(30_000)).toEqual(atmosphere(30_000));
  });
});
