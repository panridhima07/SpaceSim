import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  eclipticToApp,
  sunDirectionApp,
  ECLIPTIC_NORTH_APP,
  buildMissionSolar,
} from './missionSolar';

const OBLIQUITY_DEG = 23.4392911;
const AU_M = 1.495978707e11;

const deg = (rad: number) => (rad * 180) / Math.PI;

describe('eclipticToApp', () => {
  it('preserves vector length', () => {
    const vs: [number, number, number][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [3, -4, 12],
      [-1.5e11, 2.2e10, -7.7e9],
    ];
    for (const v of vs) {
      const a = eclipticToApp(v);
      const lenIn = Math.hypot(v[0], v[1], v[2]);
      const lenOut = Math.hypot(a[0], a[1], a[2]);
      expect(Math.abs(lenOut - lenIn)).toBeLessThanOrEqual(1e-12 * lenIn);
    }
  });

  it('maps ecliptic +Z to a unit vector about 23.44 degrees from app +Y', () => {
    const a = eclipticToApp([0, 0, 1]);
    expect(Math.hypot(a[0], a[1], a[2])).toBeCloseTo(1, 12);
    const angle = deg(Math.acos(Math.max(-1, Math.min(1, a[1]))));
    expect(angle).toBeCloseTo(OBLIQUITY_DEG, 3);
  });

  it('ECLIPTIC_NORTH_APP is a unit vector about 23.44 degrees from app +Y', () => {
    expect(ECLIPTIC_NORTH_APP.length()).toBeCloseTo(1, 12);
    const angle = deg(Math.acos(ECLIPTIC_NORTH_APP.y));
    expect(angle).toBeCloseTo(OBLIQUITY_DEG, 3);
  });

  it('keeps the ecliptic x axis in place (app x)', () => {
    const a = eclipticToApp([1, 0, 0]);
    expect(a[0]).toBeCloseTo(1, 12);
    expect(a[1]).toBeCloseTo(0, 12);
    expect(a[2]).toBeCloseTo(0, 12);
  });
});

describe('sunDirectionApp', () => {
  it('returns a unit vector', () => {
    const d = sunDirectionApp(2460482.4);
    expect(d).toBeInstanceOf(THREE.Vector3);
    expect(d.length()).toBeCloseTo(1, 9);
  });

  it('has declination about +23.4 degrees at the June solstice (2024-06-20)', () => {
    const d = sunDirectionApp(2460482.4);
    const dec = deg(Math.asin(d.y));
    expect(Math.abs(dec - 23.4)).toBeLessThan(0.5);
  });

  it('has declination about -23.4 degrees at the December solstice', () => {
    const d = sunDirectionApp(2460665.9);
    const dec = deg(Math.asin(d.y));
    expect(Math.abs(dec + 23.4)).toBeLessThan(0.5);
  });
});

describe('buildMissionSolar', () => {
  it('update() places the Sun about 1 AU from Earth', { timeout: 30_000 }, () => {
    const solar = buildMissionSolar();
    try {
      solar.update(2460140.88, new THREE.Vector3(1e12, 0, 0), 1, new THREE.Vector3());
      const len = solar.sunPos.length();
      expect(Math.abs(len - AU_M) / AU_M).toBeLessThan(0.03);
      expect(solar.group.name).toBe('mission-solar');
    } finally {
      solar.dispose();
    }
  });

  it('dispose() does not throw', { timeout: 30_000 }, () => {
    const solar = buildMissionSolar();
    solar.update(2460482.4, new THREE.Vector3(0, 0, 2e7), 0);
    expect(() => solar.dispose()).not.toThrow();
  });
});
