import { describe, expect, it } from 'vitest';
import { geodeticToEcef } from '../../rocket-physics/src/env/earth.ts';
import { qnormalize, qrot } from '../../rocket-physics/src/math/vec.ts';
import { cross, quatRotate } from '../physics/vec';
import type { Quat, Vec3 } from '../types';
import { appToEci, attitudeToApp, eciToApp, toSample } from './adapter';
import { Simulation, SITES, twoStageKerolox } from './engine';

const D2R = Math.PI / 180;

describe('eciToApp', () => {
  it('maps ECI +Z to app +Y', () => {
    const mapped = eciToApp([0, 0, 1]);
    expect(mapped[0]).toBe(0);
    expect(mapped[1]).toBe(1);
    expect(mapped[2]).toBeCloseTo(0, 12);
  });

  it('round-trips through appToEci', () => {
    const vectors: Vec3[] = [
      [1, 2, 3],
      [-4, 0.5, 9],
      [0, 0, 0],
      [-1.25, 7.5, -2.75],
    ];
    for (const v of vectors) {
      const back = appToEci(eciToApp(v));
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(v[i], 12);
    }
  });

  it('keeps handedness', () => {
    const a: Vec3 = [1, 0, 0];
    const b: Vec3 = [0, 1, 0];
    const mappedCross = eciToApp(cross(a, b));
    const crossMapped = cross(eciToApp(a), eciToApp(b));
    for (let i = 0; i < 3; i++) expect(mappedCross[i]).toBeCloseTo(crossMapped[i], 12);
  });
});

describe('attitudeToApp', () => {
  it('points body +Y along the same direction as the library nose', () => {
    const cases: Quat[] = [
      [0, 0, 0, 1],
      [0.5, 0.5, 0.5, 0.5],
      qnormalize([0.3, -0.4, 0.5, 0.7]),
    ];
    for (const q of cases) {
      const appNose = quatRotate(attitudeToApp(q), [0, 1, 0]);
      const expected = eciToApp(qrot(q, [1, 0, 0]));
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(appNose[i] - expected[i])).toBeLessThan(1e-9);
      }
    }
  });
});

describe('toSample', () => {
  it('samples a fresh simulation at Sriharikota', () => {
    const site = SITES.sriharikota;
    const sim = new Simulation(twoStageKerolox(12000), { site });
    const sample = toSample(sim);

    const surface = geodeticToEcef(site.latDeg * D2R, site.lonDeg * D2R, 0);
    const siteRadius = Math.hypot(...surface);
    const radius = Math.hypot(...sample.pos);
    expect(Math.abs(radius - (siteRadius + (site.altitude ?? 0)))).toBeLessThan(1000);

    for (const vec of [sample.pos, sample.vel, sample.quat]) {
      for (const x of vec) expect(Number.isFinite(x)).toBe(true);
    }
    const numeric = [
      't', 'altitude', 'speed', 'mach', 'q',
      'accelG', 'mass', 'thrust', 'stage',
    ] as const;
    for (const key of numeric) expect(Number.isFinite(sample[key])).toBe(true);
  });
});
