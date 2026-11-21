import { describe, it, expect } from 'vitest';
import type * as THREE from 'three';
import { buildOrbitLine, groundTrackPoints, orbitPoints } from './orbitLine';

describe('orbitPoints', () => {
  it('circular equatorial orbit has constant radius and lies in the app XZ plane', () => {
    const a = 7_000_000;
    const pts = orbitPoints({ a, e: 0, i: 0, raan: 0, argp: 0 }, 64);
    expect(pts).toHaveLength(64);
    for (const [x, y, z] of pts) {
      expect(y).toBeCloseTo(0, 6);
      expect(Math.hypot(x, y, z)).toBeCloseTo(a, 1);
    }
  });

  it('periapsis and apoapsis radii equal a(1-e) and a(1+e)', () => {
    const a = 10_000_000;
    const e = 0.2;
    const pts = orbitPoints({ a, e, i: 0.4, raan: 0.5, argp: 0.3 }, 128);
    const radii = pts.map(([x, y, z]) => Math.hypot(x, y, z));
    const minR = Math.min(...radii);
    const maxR = Math.max(...radii);
    expect(minR).toBeCloseTo(a * (1 - e), 1);
    expect(maxR).toBeCloseTo(a * (1 + e), 1);
  });

  it('90 degree inclination orbit passes over the +Y pole', () => {
    const a = 7_000_000;
    const pts = orbitPoints({ a, e: 0, i: Math.PI / 2, raan: 0, argp: 0 }, 64);
    const maxY = Math.max(...pts.map(([, y]) => y));
    expect(maxY).toBeCloseTo(a, 1);
  });
});

describe('groundTrackPoints', () => {
  it('computes lat/lon and accounts for Earth rotation', () => {
    const track = groundTrackPoints([
      { position: [7_000_000, 0, 0], earthRotationRad: 0 },
      { position: [0, 7_000_000, 0], earthRotationRad: 0 },
      { position: [7_000_000, 0, 0], earthRotationRad: Math.PI / 2 },
    ]);
    expect(track[0].latDeg).toBeCloseTo(0, 6);
    expect(track[0].lonDeg).toBeCloseTo(0, 6);
    expect(track[1].latDeg).toBeCloseTo(90, 6);
    expect(track[2].latDeg).toBeCloseTo(0, 6);
    expect(track[2].lonDeg).toBeCloseTo(-90, 6);
  });
});

describe('buildOrbitLine', () => {
  it('builds a closed loop THREE.Line', () => {
    const pts = orbitPoints({ a: 7_000_000, e: 0, i: 0, raan: 0, argp: 0 }, 16);
    const line = buildOrbitLine(pts);
    const pos = line.geometry.getAttribute('position');
    expect(pos.count).toBe(17);
    expect(pos.getX(0)).toBeCloseTo(pos.getX(16), 3);
    expect(pos.getY(0)).toBeCloseTo(pos.getY(16), 3);
    expect(pos.getZ(0)).toBeCloseTo(pos.getZ(16), 3);
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  });
});
