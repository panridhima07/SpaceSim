import { describe, expect, it } from 'vitest';
import { geodeticToEcef } from '../../rocket-physics/src/env/earth.ts';
import { qnormalize, qrot } from '../../rocket-physics/src/math/vec.ts';
import { cross, quatRotate } from '../physics/vec';
import type { Quat, Vec3 } from '../types';
import { appToEci, attitudeToApp, eciToApp, toMarkers, toSample, type ReferenceEvent } from './adapter';
import { Simulation, SITES, twoStageKerolox } from './engine';

const D2R = Math.PI / 180;

const ATTITUDE_CASES: Quat[] = [
  [0, 0, 0, 1],
  [0.5, 0.5, 0.5, 0.5],
  qnormalize([0.3, -0.4, 0.5, 0.7]),
];

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
    for (const q of ATTITUDE_CASES) {
      const appNose = quatRotate(attitudeToApp(q), [0, 1, 0]);
      const expected = eciToApp(qrot(q, [1, 0, 0]));
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(appNose[i] - expected[i])).toBeLessThan(1e-9);
      }
    }
  });

  it('maps the other two body axes consistently', () => {
    const pairs: [Vec3, Vec3][] = [
      [[0, 0, 1], [0, 0, 1]],
      [[1, 0, 0], [0, -1, 0]],
    ];
    for (const q of ATTITUDE_CASES) {
      const app = attitudeToApp(q);
      for (const [appBody, libBody] of pairs) {
        const got = quatRotate(app, appBody);
        const expected = eciToApp(qrot(q, libBody));
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(got[i] - expected[i])).toBeLessThan(1e-9);
        }
      }
    }
  });
});

describe('toMarkers', () => {
  const events = [
    { t: 10, type: 'ignition', message: 'L110 core ignition' },
    { t: 12.5, type: 'warning', message: 'Range warning' },
    { t: 20, type: 'separation', message: 'L110 core separation' },
    { t: 30, type: 'impact', message: 'Impact at 120 m/s' },
    { t: 31, type: 'abort', message: 'Abort commanded' },
  ];
  const reference: ReferenceEvent[] = [
    { label: 'ignition', pattern: /L110 core ignition/, t: 108.1 },
    { label: 'separation', pattern: /L110 core separation/, t: 305.56 },
  ];

  it('shifts times and maps severities', () => {
    const markers = toMarkers(events, 8, reference);
    expect(markers.map((m) => m.t)).toEqual([2, 4.5, 12, 22, 23]);
    expect(markers.map((m) => m.kind)).toEqual(['event', 'event', 'event', 'event', 'event']);
    expect(markers.map((m) => m.severity)).toEqual(['info', 'warning', 'info', 'critical', 'critical']);
    expect(markers.map((m) => m.label)).toEqual(events.map((e) => e.message));
  });

  it('attaches a matching reference once', () => {
    const markers = toMarkers(events, 8, reference);
    expect(markers[0].reference).toBe(108.1);
    expect(markers[2].reference).toBe(305.56);
    expect(markers[1].reference).toBeUndefined();
    expect(markers[3].reference).toBeUndefined();
    expect(markers[4].reference).toBeUndefined();
  });

  it('uses each reference entry at most once', () => {
    const repeated = [
      { t: 1, type: 'event', message: 'Fairing jettison' },
      { t: 2, type: 'event', message: 'Fairing jettison again' },
    ];
    const markers = toMarkers(repeated, 0, [{ label: 'fairing', pattern: /Fairing jettison/, t: 194.96 }]);
    expect(markers[0].reference).toBe(194.96);
    expect(markers[1].reference).toBeUndefined();
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
