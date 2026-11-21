import { describe, it, expect } from 'vitest';
import { buildLauncherMesh, disposeLauncher, type LauncherSpec } from './launcherMesh';
import {
  buildLauncherPlumes,
  disposeLauncherPlumes,
  updatePlumes,
} from './launcherPlume';

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

describe('launcherPlume', () => {
  it('hides plumes when throttle is 0', () => {
    const mesh = buildLauncherMesh(lvm3);
    const plumes = buildLauncherPlumes(mesh, lvm3, [false, true, false]);

    updatePlumes(plumes, { throttles: [0, 0, 0], ambientPressure: 101325 });
    for (const s of plumes.stages) {
      for (const p of s.plumes) {
        expect(p.group.visible).toBe(false);
      }
    }

    disposeLauncherPlumes(plumes);
    disposeLauncher(mesh);
  });

  it('plume length grows monotonically with throttle', () => {
    const mesh = buildLauncherMesh(lvm3);
    const plumes = buildLauncherPlumes(mesh, lvm3, [false, true, false]);

    updatePlumes(plumes, { throttles: [0.2, 0, 0], ambientPressure: 101325 });
    const lenLow = plumes.stages[0].plumes[0].outer.scale.y;

    updatePlumes(plumes, { throttles: [0.6, 0, 0], ambientPressure: 101325 });
    const lenMid = plumes.stages[0].plumes[0].outer.scale.y;

    updatePlumes(plumes, { throttles: [1.0, 0, 0], ambientPressure: 101325 });
    const lenHigh = plumes.stages[0].plumes[0].outer.scale.y;

    expect(lenMid).toBeGreaterThan(lenLow);
    expect(lenHigh).toBeGreaterThan(lenMid);

    disposeLauncherPlumes(plumes);
    disposeLauncher(mesh);
  });

  it('plume width grows monotonically as ambient pressure falls (~3x wider in vacuum)', () => {
    const mesh = buildLauncherMesh(lvm3);
    const plumes = buildLauncherPlumes(mesh, lvm3, [false, true, false]);

    updatePlumes(plumes, { throttles: [1, 0, 0], ambientPressure: 101325 });
    const wSea = plumes.stages[0].plumes[0].outer.scale.x;

    updatePlumes(plumes, { throttles: [1, 0, 0], ambientPressure: 50000 });
    const wMid = plumes.stages[0].plumes[0].outer.scale.x;

    updatePlumes(plumes, { throttles: [1, 0, 0], ambientPressure: 0 });
    const wVac = plumes.stages[0].plumes[0].outer.scale.x;

    expect(wMid).toBeGreaterThan(wSea);
    expect(wVac).toBeGreaterThan(wMid);
    expect(wVac / wSea).toBeCloseTo(3, 6);

    disposeLauncherPlumes(plumes);
    disposeLauncher(mesh);
  });

  it('hides plumes of a hidden stage even if throttle > 0', () => {
    const mesh = buildLauncherMesh(lvm3);
    const plumes = buildLauncherPlumes(mesh, lvm3, [false, true, false]);

    mesh.stageGroups[1].visible = false;
    updatePlumes(plumes, { throttles: [1, 1, 0], ambientPressure: 101325 });

    expect(plumes.stages[0].plumes[0].group.visible).toBe(true);
    for (const p of plumes.stages[1].plumes) {
      expect(p.group.visible).toBe(false);
    }

    disposeLauncherPlumes(plumes);
    disposeLauncher(mesh);
  });
});
