import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { NoseShape, RocketModel } from '../types';
import { buildCgCpMarkers, buildRocketMesh, disposeGroup, noseProfile } from './rocketMesh';

const R = 0.0125;

const rocket: RocketModel = {
  name: 'test',
  length: 0.37,
  maxRadius: R,
  stageCount: 1,
  warnings: [],
  components: [
    {
      kind: 'nosecone', id: 'nose', name: 'Nose', x: 0, length: 0.07, density: 0,
      shape: 'ogive', shapeParam: 0, baseRadius: R, thickness: 0,
    },
    {
      kind: 'bodytube', id: 'body', name: 'Body', x: 0.07, length: 0.30, density: 0,
      outerRadius: R, thickness: 0.001,
    },
    {
      kind: 'finset', id: 'fins', name: 'Fins', x: 0.32, length: 0.05, density: 0,
      count: 3, rootChord: 0.05, tipChord: 0.025, span: 0.04, sweepLength: 0.025,
      thickness: 0.003, cant: 0, bodyRadius: R, finShape: 'trapezoid',
    },
    {
      kind: 'innertube', id: 'itube', name: 'Inner tube', x: 0.07, length: 0.20, density: 0,
      outerRadius: 0.006, thickness: 0.001, isMotorMount: true, overhang: 0,
    },
    {
      kind: 'parachute', id: 'chute', name: 'Parachute', x: 0.08, length: 0.10, density: 0,
      diameter: 0.2, cd: 0.8, deployEvent: 'apogee', deployAltitude: 0, deployDelay: 0, mass: 0.02,
    },
  ],
};

function countMeshes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) n++;
  });
  return n;
}

describe('noseProfile', () => {
  const shapes: [NoseShape, number][] = [
    ['conical', 0],
    ['ogive', 0],
    ['ellipsoid', 0],
    ['power', 0.5],
    ['parabolic', 0.5],
    ['haack', 0],
  ];

  for (const [shape, p] of shapes) {
    it(`${shape} starts at r=0 and ends at r=R`, () => {
      const prof = noseProfile(shape, p, R, 0.07, 64);
      expect(prof.length).toBe(64);
      expect(prof[0][1]).toBeCloseTo(0, 6);
      expect(prof[prof.length - 1][1]).toBeCloseTo(R, 6);
      expect(prof[prof.length - 1][0]).toBeCloseTo(0.07, 9);
    });
  }

  for (const shape of ['ogive', 'conical', 'ellipsoid'] as NoseShape[]) {
    it(`${shape} is monotonic non-decreasing`, () => {
      const prof = noseProfile(shape, 0, R, 0.07, 64);
      for (let i = 1; i < prof.length; i++) {
        expect(prof[i][1]).toBeGreaterThanOrEqual(prof[i - 1][1] - 1e-12);
      }
    });
  }
});

describe('buildRocketMesh', () => {
  it('builds nose, tube and three fins without cutaway', () => {
    const g = buildRocketMesh(rocket);
    expect(countMeshes(g)).toBe(5);
    const names = new Set<string>();
    g.traverse((o) => { if (o instanceof THREE.Mesh) names.add(o.name); });
    expect(names).toEqual(new Set(['nose', 'body', 'fins']));
  });

  it('spans y from about -0.37 to 0 (nose tip at origin)', () => {
    const g = buildRocketMesh(rocket);
    const box = new THREE.Box3().setFromObject(g);
    expect(box.max.y).toBeCloseTo(0, 3);
    expect(box.min.y).toBeGreaterThan(-0.37 * 1.1);
    expect(box.min.y).toBeLessThan(-0.37 * 0.9);
  });

  it('fin tips reach about bodyRadius + span radially (within 10 %)', () => {
    const g = buildRocketMesh(rocket);
    g.updateMatrixWorld(true);
    const target = R + 0.04;
    let maxRad = 0;
    const v = new THREE.Vector3();
    g.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        maxRad = Math.max(maxRad, Math.hypot(v.x, v.z));
      }
    });
    expect(maxRad).toBeGreaterThan(target * 0.9);
    expect(maxRad).toBeLessThan(target * 1.1);

    // Fin at angle 0 lies along +X, so max X reaches the fin tip.
    const box = new THREE.Box3().setFromObject(g);
    expect(box.max.x).toBeGreaterThan(target * 0.9);
    expect(box.max.x).toBeLessThan(target * 1.1);
  });

  it('cutaway adds internal meshes', () => {
    const plain = countMeshes(buildRocketMesh(rocket));
    const cut = countMeshes(buildRocketMesh(rocket, { cutaway: true }));
    expect(cut).toBeGreaterThan(plain);
    expect(cut).toBe(7); // plain 5 + inner tube + parachute
  });

  it('cutaway makes external nose and tube transparent', () => {
    const g = buildRocketMesh(rocket, { cutaway: true });
    const nose = g.getObjectByName('nose') as THREE.Mesh;
    const mat = nose.material as THREE.MeshStandardMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.25);
  });

  it('disposeGroup runs without throwing', () => {
    const g = buildRocketMesh(rocket, { cutaway: true });
    expect(() => disposeGroup(g)).not.toThrow();
  });
});

describe('buildCgCpMarkers', () => {
  it('moves rings to -cgX and -cpX in local y', () => {
    const markers = buildCgCpMarkers(R);
    markers.update(0.2, 0.25);
    const cg = markers.group.getObjectByName('cg')!;
    const cp = markers.group.getObjectByName('cp')!;
    expect(cg.position.y).toBeCloseTo(-0.2, 9);
    expect(cp.position.y).toBeCloseTo(-0.25, 9);

    markers.update(0.1, 0.3);
    expect(cg.position.y).toBeCloseTo(-0.1, 9);
    expect(cp.position.y).toBeCloseTo(-0.3, 9);
  });
});
