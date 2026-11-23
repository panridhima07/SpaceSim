import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { R_EARTH } from '../types';
import { buildLaunchSite } from './launchSite';
import { buildSolarSystem } from './solarSystem';
import { julianDate } from './ephemeris';
import { PAD_GROUND_Y, terrainHeightAt } from '../render/padTerrain';

const J2000 = julianDate(new Date('2000-01-01T12:00:00Z'));

describe('buildSolarSystem', () => {
  it('places the Earth mesh at -origin', () => {
    const s = buildSolarSystem();
    s.update(J2000, [0, R_EARTH, 0]);
    const earth = s.group.getObjectByName('Earth')!;
    expect(earth.position.x).toBeCloseTo(0, 6);
    expect(earth.position.y).toBeCloseTo(-R_EARTH, 6);
    expect(earth.position.z).toBeCloseTo(0, 6);
  });

  it('sunDirection is a unit vector', () => {
    const s = buildSolarSystem();
    s.update(J2000, [0, R_EARTH, 0]);
    expect(s.sunDirection.length()).toBeCloseTo(1, 6);
  });

  it('gives Earth a dot and a label sprite', () => {
    const s = buildSolarSystem();
    expect(s.group.getObjectByName('EarthDot')).toBeInstanceOf(THREE.Sprite);
    expect(s.group.getObjectByName('EarthLabel')).toBeInstanceOf(THREE.Sprite);
  });

  it('has a Moon orbit centred on Earth and a Mars orbit', () => {
    const s = buildSolarSystem();
    s.update(J2000, [0, R_EARTH, 0]);
    expect(s.group.getObjectByName('MoonOrbit')).toBeInstanceOf(THREE.Line);
    expect(s.group.getObjectByName('MarsOrbit')).toBeInstanceOf(THREE.Line);
  });

  it('hides all labels and dots when the camera is 100 m above the pad', () => {
    const s = buildSolarSystem();
    const origin: [number, number, number] = [0, R_EARTH, 0];
    s.update(J2000, origin, new THREE.Vector3(0, 100, 0));
    for (const name of ['EarthLabel', 'MarsLabel', 'MoonLabel', 'SunLabel']) {
      expect(s.group.getObjectByName(name)!.visible).toBe(false);
    }
    for (const name of ['EarthDot', 'MarsDot', 'SunGlow']) {
      expect(s.group.getObjectByName(name)!.visible).toBe(false);
    }
  });

  it('shows a far planet label with the camera 1e8 m away', () => {
    const s = buildSolarSystem();
    const origin: [number, number, number] = [0, R_EARTH, 0];
    s.update(J2000, origin, new THREE.Vector3(0, 1e8, 0));
    expect(s.group.getObjectByName('MarsLabel')!.visible).toBe(true);
    expect(s.group.getObjectByName('MarsDot')!.visible).toBe(true);
  });

  it('shows the Earth label from far away and hides it when closer than 20 radii', () => {
    const s = buildSolarSystem();
    const origin: [number, number, number] = [0, R_EARTH, 0];
    s.update(J2000, origin, new THREE.Vector3(0, 1e9, 0));
    expect(s.group.getObjectByName('EarthLabel')!.visible).toBe(true);
    // 1e8 m altitude is inside 20 Earth radii of the centre, so the Earth label is hidden there.
    s.update(J2000, origin, new THREE.Vector3(0, 1e8, 0));
    expect(s.group.getObjectByName('EarthLabel')!.visible).toBe(false);
  });
});

describe('buildLaunchSite', () => {
  it('positions the group at (0, R_EARTH + alt, 0) - origin', () => {
    const site = buildLaunchSite({ railLength: 1 });
    site.update([10, R_EARTH + 5, -20], 100);
    expect(site.group.position.x).toBeCloseTo(-10, 6);
    expect(site.group.position.y).toBeCloseTo(R_EARTH + 100 - (R_EARTH + 5), 6);
    expect(site.group.position.z).toBeCloseTo(20, 6);
  });

  it('setRail tilts toward +X for azimuth 90 degrees', () => {
    const site = buildLaunchSite({ railLength: 2 });
    site.setRail(2, (10 * Math.PI) / 180, Math.PI / 2);
    const rail = site.group.getObjectByName('rail') as THREE.Mesh;
    rail.updateMatrixWorld(true);
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(rail.quaternion);
    expect(dir.x).toBeGreaterThan(0.1);
    expect(Math.abs(dir.z)).toBeLessThan(1e-6);
    expect(rail.scale.y).toBeCloseTo(2, 9);
  });

  it('a vertical rail stays vertical', () => {
    const site = buildLaunchSite({ railLength: 1 });
    site.setRail(1, 0, 0);
    const rail = site.group.getObjectByName('rail') as THREE.Mesh;
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(rail.quaternion);
    expect(dir.y).toBeCloseTo(1, 9);
  });

  it('has a PadKeyLight directional light under the launch-site group', () => {
    const site = buildLaunchSite({ railLength: 1 });
    const key = site.group.getObjectByName('PadKeyLight');
    expect(key).toBeInstanceOf(THREE.DirectionalLight);
    expect(key!.parent).toBe(site.group);
  });

  it('keeps the rail cross-section at or below 1 cm', () => {
    const site = buildLaunchSite({ railLength: 1 });
    const rail = site.group.getObjectByName('rail') as THREE.Mesh;
    rail.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    rail.geometry.boundingBox!.getSize(size);
    expect(size.x).toBeLessThanOrEqual(0.01);
    expect(size.z).toBeLessThanOrEqual(0.01);
  });

  it('keeps the reference pole 0.6 m from the rail', () => {
    const site = buildLaunchSite({ railLength: 1 });
    site.setRail(1, 0, 0);
    const pivot = site.group.getObjectByName('railPivot')!;
    const pole = site.group.getObjectByName('referencePole')!;
    const d = Math.hypot(pole.position.x - pivot.position.x, pole.position.z - pivot.position.z);
    expect(d).toBeCloseTo(0.6, 6);
  });

  it('puts the flat pad ground of the shared terrain at y = 0 and keeps the pad above it', () => {
    const site = buildLaunchSite({ railLength: 1 });
    const terrain = site.group.getObjectByName('groundTerrain')!;
    expect(terrain).toBeDefined();
    // Pad-local ground height is PAD_GROUND_Y at the origin; the shift lifts it onto y = 0.
    expect(terrainHeightAt(0, 0) + terrain.position.y).toBeCloseTo(0, 9);
    // The slab is centred on pad.position.y; its top face (centre + half the 3 cm thickness) sits just above ground.
    const pad = site.group.getObjectByName('pad')!;
    const padTop = pad.position.y + 0.015;
    expect(padTop).toBeGreaterThan(0);
    expect(padTop).toBeLessThan(0.01);
    const sand = site.group.getObjectByName('sandClearing')!;
    expect(sand.position.y).toBeGreaterThan(0);
  });

  it('updates and disposes the terrain without errors', () => {
    const site = buildLaunchSite({ railLength: 1 });
    expect(() => site.updateTerrain?.(1.5, 10)).not.toThrow();
    expect(() => site.dispose?.()).not.toThrow();
  });
});
