import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildLauncherMesh,
  disposeLauncher,
  setLauncherState,
  type LauncherSpec,
} from './launcherMesh';
import { lvm3 as lvm3Preset, twoStageKerolox } from '../../rocket-physics/src/index.ts';

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

describe('buildLauncherMesh', () => {
  it('1. stageGroups has 3 entries and their names match the spec', () => {
    const mesh = buildLauncherMesh(lvm3);
    expect(mesh.stageGroups).toHaveLength(3);
    expect(mesh.stageGroups.map((g) => g.name)).toEqual([
      'L110 core',
      'S200 boosters',
      'C25 cryogenic stage',
    ]);
    disposeLauncher(mesh);
  });

  it('2. totalLength is 45.6 (21.4 + 13.5 + 10.7) to within 1e-6', () => {
    const mesh = buildLauncherMesh(lvm3);
    expect(mesh.totalLength).toBeCloseTo(45.6, 6);
    disposeLauncher(mesh);
  });

  it('3. bounding box max.y is within 0.05 of 45.6 and min.y is below 0 but above -3', () => {
    const mesh = buildLauncherMesh(lvm3);
    const box = new THREE.Box3().setFromObject(mesh.group);
    expect(Math.abs(box.max.y - 45.6)).toBeLessThan(0.05);
    expect(box.min.y).toBeLessThan(0);
    expect(box.min.y).toBeGreaterThan(-3);
    disposeLauncher(mesh);
  });

  it('4. booster stage group has 2 direct children at 3.6 m from Y axis on opposite sides', () => {
    const mesh = buildLauncherMesh(lvm3);
    const boosterStage = mesh.stageGroups[1];
    expect(boosterStage.children).toHaveLength(2);

    const [b0, b1] = boosterStage.children;
    const r0 = Math.hypot(b0.position.x, b0.position.z);
    const r1 = Math.hypot(b1.position.x, b1.position.z);
    expect(r0).toBeCloseTo(3.6, 6);
    expect(r1).toBeCloseTo(3.6, 6);

    // Opposite sides: sum of x and z positions is ~0
    expect(b0.position.x + b1.position.x).toBeCloseTo(0, 6);
    expect(b0.position.z + b1.position.z).toBeCloseTo(0, 6);
    disposeLauncher(mesh);
  });

  it('5. top of a booster is at y = 25 (max.y within 0.05 of 25)', () => {
    const mesh = buildLauncherMesh(lvm3);
    const boosterBox = new THREE.Box3().setFromObject(mesh.stageGroups[1]);
    expect(Math.abs(boosterBox.max.y - 25)).toBeLessThan(0.05);
    disposeLauncher(mesh);
  });

  it('6. C25 stage sits on L110 (max.y within 0.05 of 34.9)', () => {
    const mesh = buildLauncherMesh(lvm3);
    const c25Box = new THREE.Box3().setFromObject(mesh.stageGroups[2]);
    expect(Math.abs(c25Box.max.y - 34.9)).toBeLessThan(0.05);
    disposeLauncher(mesh);
  });

  it('7. payload bounding box lies within fairing radius (2.5) in x and z, and max.y < totalLength', () => {
    const mesh = buildLauncherMesh(lvm3);
    const payloadBox = new THREE.Box3().setFromObject(mesh.payload);
    expect(Math.abs(payloadBox.min.x)).toBeLessThanOrEqual(2.5 + 1e-6);
    expect(Math.abs(payloadBox.max.x)).toBeLessThanOrEqual(2.5 + 1e-6);
    expect(Math.abs(payloadBox.min.z)).toBeLessThanOrEqual(2.5 + 1e-6);
    expect(Math.abs(payloadBox.max.z)).toBeLessThanOrEqual(2.5 + 1e-6);
    expect(payloadBox.max.y).toBeLessThan(mesh.totalLength);
    disposeLauncher(mesh);
  });

  it('8. setLauncherState hides detached boosters and fairing, and restores them when attached', () => {
    const mesh = buildLauncherMesh(lvm3);
    setLauncherState(mesh, {
      stagesAttached: [true, false, true],
      fairingAttached: false,
    });

    expect(mesh.stageGroups[0].visible).toBe(true);
    expect(mesh.stageGroups[1].visible).toBe(false);
    expect(mesh.stageGroups[2].visible).toBe(true);
    expect(mesh.payload.visible).toBe(true);
    expect(mesh.fairingHalves?.[0].visible).toBe(false);
    expect(mesh.fairingHalves?.[1].visible).toBe(false);

    setLauncherState(mesh, {
      stagesAttached: [true, true, true],
      fairingAttached: true,
    });

    expect(mesh.stageGroups[0].visible).toBe(true);
    expect(mesh.stageGroups[1].visible).toBe(true);
    expect(mesh.stageGroups[2].visible).toBe(true);
    expect(mesh.fairingHalves?.[0].visible).toBe(true);
    expect(mesh.fairingHalves?.[1].visible).toBe(true);
    disposeLauncher(mesh);
  });

  it('9. setLauncherState with empty stagesAttached leaves every stage visible', () => {
    const mesh = buildLauncherMesh(lvm3);
    setLauncherState(mesh, {
      stagesAttached: [],
      fairingAttached: true,
    });
    for (const g of mesh.stageGroups) {
      expect(g.visible).toBe(true);
    }
    disposeLauncher(mesh);
  });

  it('10. spec with no fairing gives fairingHalves === null and totalLength = core + payload', () => {
    const noFairing: LauncherSpec = {
      name: 'NoFairing',
      stages: [
        { name: 'Core 1', length: 20, radius: 2, engineCount: 1 },
        { name: 'Core 2', length: 10, radius: 1.5, engineCount: 1 },
      ],
      payload: { length: 4 },
    };
    const mesh = buildLauncherMesh(noFairing);
    expect(mesh.fairingHalves).toBeNull();
    expect(mesh.totalLength).toBeCloseTo(34, 6);
    disposeLauncher(mesh);
  });

  it('11. spec with one stage, no boosters and no fairing builds without throwing', () => {
    const minimal: LauncherSpec = {
      name: 'Minimal',
      stages: [{ name: 'Single', length: 12, radius: 1, engineCount: 1 }],
      payload: { length: 2 },
    };
    const mesh = buildLauncherMesh(minimal);
    expect(mesh.stageGroups).toHaveLength(1);
    expect(mesh.fairingHalves).toBeNull();
    expect(mesh.totalLength).toBeCloseTo(14, 6);
    disposeLauncher(mesh);
  });

  it('12. booster stage with count 4 has 4 direct children, 90 degrees apart', () => {
    const quad: LauncherSpec = {
      name: 'Quad',
      stages: [
        { name: 'Core', length: 20, radius: 2, engineCount: 1 },
        {
          name: 'Boosters',
          length: 15,
          radius: 1,
          engineCount: 1,
          parallel: { count: 4, radialOffset: 3, attachStation: 0 },
        },
      ],
      payload: { length: 3 },
    };
    const mesh = buildLauncherMesh(quad);
    const boosterStage = mesh.stageGroups[1];
    expect(boosterStage.children).toHaveLength(4);

    const angles = boosterStage.children.map((b) => Math.atan2(b.position.z, b.position.x));
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      let diff = angles[next] - angles[i];
      if (diff < 0) diff += 2 * Math.PI;
      expect(diff).toBeCloseTo(Math.PI / 2, 6);
    }
    disposeLauncher(mesh);
  });

  it('13. calling disposeLauncher twice does not throw', () => {
    const mesh = buildLauncherMesh(lvm3);
    expect(() => {
      disposeLauncher(mesh);
      disposeLauncher(mesh);
    }).not.toThrow();
  });

  it('14. accepts real VehicleSpec presets (lvm3 and twoStageKerolox) without conversion', () => {
    for (const preset of [lvm3Preset(), twoStageKerolox()]) {
      const mesh = buildLauncherMesh(preset);
      const coreLength = preset.stages
        .filter((s) => !s.parallel)
        .reduce((sum, s) => sum + s.length, 0);
      const expectedTotal = coreLength + (preset.fairing ? preset.fairing.length : preset.payload.length);

      expect(mesh.stageGroups).toHaveLength(preset.stages.length);
      expect(mesh.totalLength).toBeGreaterThan(0);
      expect(mesh.totalLength).toBeCloseTo(expectedTotal, 6);
      disposeLauncher(mesh);
    }
  });
});
