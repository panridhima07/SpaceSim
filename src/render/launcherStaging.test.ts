import { describe, it, expect } from 'vitest';
import { buildLauncherMesh, disposeLauncher, type LauncherSpec } from './launcherMesh';
import { updateLauncherStaging } from './launcherStaging';

const lvm3: LauncherSpec = {
  name: 'LVM3',
  stages: [
    { name: 'L110 core', length: 21.4, radius: 2, engineCount: 2 },
    {
      name: 'S200 boosters',
      length: 25,
      radius: 1.6,
      engineCount: 1,
      parallel: { count: 2, radialOffset: 3.6, attachStation: 0 },
    },
    { name: 'C25 cryogenic stage', length: 13.5, radius: 2, engineCount: 1 },
  ],
  payload: { length: 4, radius: 1.8 },
  fairing: { length: 10.7, radius: 2.5 },
};

describe('updateLauncherStaging', () => {
  it('with all-null input keeps the mesh exactly as built', () => {
    const mesh = buildLauncherMesh(lvm3);
    updateLauncherStaging(mesh, lvm3, {
      stages: [null, null, null],
      fairing: null,
    });

    for (const g of mesh.stageGroups) {
      expect(g.visible).toBe(true);
      expect(g.position.x).toBe(0);
      expect(g.position.y).toBe(0);
      expect(g.position.z).toBe(0);
    }
    const [b0, b1] = mesh.stageGroups[1].children;
    expect(b0.position.x).toBeCloseTo(3.6, 6);
    expect(b1.position.x).toBeCloseTo(-3.6, 6);
    expect(mesh.fairingHalves?.[0].visible).toBe(true);
    expect(mesh.fairingHalves?.[1].visible).toBe(true);
    expect(mesh.fairingHalves?.[0].position.x).toBe(0);
    expect(mesh.fairingHalves?.[1].position.x).toBe(0);
    disposeLauncher(mesh);
  });

  it('at t = 0 all separated parts remain visible at initial positions', () => {
    const mesh = buildLauncherMesh(lvm3);
    updateLauncherStaging(mesh, lvm3, {
      stages: [0, 0, 0],
      fairing: 0,
    });

    for (const g of mesh.stageGroups) {
      expect(g.visible).toBe(true);
      expect(g.position.y).toBe(0);
    }
    expect(mesh.stageGroups[1].children[0].position.x).toBeCloseTo(3.6, 6);
    expect(mesh.fairingHalves?.[0].visible).toBe(true);
    expect(mesh.fairingHalves?.[0].position.x).toBe(0);
    disposeLauncher(mesh);
  });

  it('at t = 1 boosters move outward, fall back and tilt; core falls straight back; fairing swings apart', () => {
    const mesh = buildLauncherMesh(lvm3);
    updateLauncherStaging(mesh, lvm3, {
      stages: [1, 1, null],
      fairing: 1,
    });

    // Core stage 0 falls straight back (-Y)
    expect(mesh.stageGroups[0].visible).toBe(true);
    expect(mesh.stageGroups[0].position.x).toBe(0);
    expect(mesh.stageGroups[0].position.y).toBeLessThan(0);
    expect(mesh.stageGroups[0].position.z).toBe(0);

    // Boosters move outward radially, fall back, and tilt
    const [b0, b1] = mesh.stageGroups[1].children;
    expect(mesh.stageGroups[1].visible).toBe(true);
    expect(b0.position.x).toBeGreaterThan(3.6);
    expect(b1.position.x).toBeLessThan(-3.6);
    expect(b0.position.y).toBeLessThan(0);
    expect(b0.rotation.z).not.toBe(0);

    // Attached stage 2 never moves
    expect(mesh.stageGroups[2].visible).toBe(true);
    expect(mesh.stageGroups[2].position.x).toBe(0);
    expect(mesh.stageGroups[2].position.y).toBe(0);
    expect(mesh.stageGroups[2].position.z).toBe(0);

    // Fairing halves swing apart sideways
    const [left, right] = mesh.fairingHalves!;
    expect(left.visible).toBe(true);
    expect(right.visible).toBe(true);
    expect(left.position.x).toBeGreaterThan(0);
    expect(right.position.x).toBeLessThan(0);
    expect(left.position.y).toBeLessThan(0);
    expect(left.rotation.z).not.toBe(0);
    expect(right.rotation.z).not.toBe(0);

    disposeLauncher(mesh);
  });

  it('at t >= 8 separated parts become invisible while attached parts stay visible and unmoved', () => {
    const mesh = buildLauncherMesh(lvm3);
    updateLauncherStaging(mesh, lvm3, {
      stages: [8, 8.5, null],
      fairing: 9,
    });

    expect(mesh.stageGroups[0].visible).toBe(false);
    expect(mesh.stageGroups[1].visible).toBe(false);
    expect(mesh.stageGroups[2].visible).toBe(true);
    expect(mesh.stageGroups[2].position.y).toBe(0);
    expect(mesh.fairingHalves?.[0].visible).toBe(false);
    expect(mesh.fairingHalves?.[1].visible).toBe(false);
    disposeLauncher(mesh);
  });
});
