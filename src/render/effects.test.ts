import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  applyFlatStyle,
  buildExhaust,
  buildParachute,
  buildSky,
  buildSmokeTrail,
  buildTrajectoryLine,
  quatToThree,
  vecRel,
} from './effects';

describe('buildExhaust', () => {
  it('is hidden at zero thrust', () => {
    const ex = buildExhaust();
    ex.update(0, 10, 0.0125, 0);
    expect(ex.group.visible).toBe(false);
  });

  it('is visible and longer at higher thrust', () => {
    const ex = buildExhaust();
    const outer = ex.group.children[0];

    ex.update(2, 10, 0.0125, 0);
    expect(ex.group.visible).toBe(true);
    const low = outer.scale.y;

    ex.update(10, 10, 0.0125, 0);
    expect(outer.scale.y).toBeGreaterThan(low);
  });
});

describe('buildSmokeTrail', () => {
  it('places an instance at pos - origin', () => {
    const smoke = buildSmokeTrail(3);
    const mesh = smoke.object as THREE.InstancedMesh;
    smoke.emit([10, 20, 30], 1);
    smoke.update(0, [9, 19, 29]);

    expect(mesh.count).toBe(1);
    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, 0);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(1, 5);
    expect(p.y).toBeCloseTo(1, 5);
    expect(p.z).toBeCloseTo(1, 5);
  });

  it('recycles slots after maxPuffs and never exceeds the capacity', () => {
    const smoke = buildSmokeTrail(3);
    const mesh = smoke.object as THREE.InstancedMesh;
    for (let i = 0; i < 5; i++) smoke.emit([i * 100, 0, 0], 1);
    smoke.update(0, [0, 0, 0]);
    expect(mesh.count).toBe(3);

    // The 5th emit (index 4) went into slot 1 (4 % 3), so slot 1 holds x = 400.
    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, 1 * 16);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBeCloseTo(400, 3);
  });

  it('grows and then shrinks to zero scale at end of life', () => {
    const smoke = buildSmokeTrail(2);
    const mesh = smoke.object as THREE.InstancedMesh;
    smoke.emit([0, 0, 0], 1);
    // At age 5.9 s: u = 0.983, grow = 2.97, fade = (1 - u) / 0.3 ~ 0.056, scale ~ 0.17.
    smoke.update(5.9, [0, 0, 0]);
    const late = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, 0);
    const lateScale = new THREE.Vector3().setFromMatrixScale(late).x;
    expect(lateScale).toBeGreaterThan(0);
    expect(lateScale).toBeLessThan(2.97);

    smoke.update(0.5, [0, 0, 0]); // age 6.4 s -> dead
    const dead = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, 0);
    expect(dead.elements[0]).toBe(0);
    expect(dead.elements[5]).toBe(0);
  });
});

describe('buildTrajectoryLine', () => {
  it('draw range grows and vertices are relative to origin', () => {
    const tr = buildTrajectoryLine(10);
    const origin: [number, number, number] = [1e6, 0, 0];
    tr.push([1e6 + 1, 2, 3]);
    tr.push([1e6 + 4, 5, 6]);
    tr.update(origin);

    const geo = tr.line.geometry;
    expect(geo.drawRange.count).toBe(2);
    const arr = geo.getAttribute('position').array as Float32Array;
    expect(arr[0]).toBeCloseTo(1, 5);
    expect(arr[1]).toBeCloseTo(2, 5);
    expect(arr[2]).toBeCloseTo(3, 5);
    expect(arr[3]).toBeCloseTo(4, 5);

    tr.push([1e6, 0, 0]);
    tr.update(origin);
    expect(geo.drawRange.count).toBe(3);
    expect(tr.line.frustumCulled).toBe(false);

    tr.clear();
    tr.update(origin);
    expect(geo.drawRange.count).toBe(0);
  });

  it('setAll replaces points and caps at maxPoints', () => {
    const tr = buildTrajectoryLine(2);
    tr.setAll([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    tr.update([0, 0, 0]);
    expect(tr.line.geometry.drawRange.count).toBe(2);
  });

  it('setFromLog keeps first and last points when log exceeds capacity', () => {
    const tr = buildTrajectoryLine(4);
    const log = Array.from({ length: 10 }, (_, i) => ({
      t: i,
      pos: [i * 10, i * 20, 0] as [number, number, number],
    }));
    tr.setFromLog(log);
    tr.update([0, 0, 0]);
    expect(tr.line.geometry.drawRange.count).toBe(4);
    const arr = tr.line.geometry.getAttribute('position').array as Float32Array;
    expect(arr[0]).toBeCloseTo(0, 5);
    expect(arr[1]).toBeCloseTo(0, 5);
    expect(arr[9]).toBeCloseTo(90, 5);
    expect(arr[10]).toBeCloseTo(180, 5);
  });

  it('identical setFromLog + update does not re-upload the buffer', () => {
    const tr = buildTrajectoryLine(20);
    const log = Array.from({ length: 6 }, (_, i) => ({
      t: i,
      pos: [i, 0, 0] as [number, number, number],
    }));
    const origin: [number, number, number] = [0, 0, 0];
    tr.setFromLog(log);
    tr.update(origin);
    const attr = tr.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const v = attr.version;
    tr.setFromLog(log);
    tr.update([0, 0, 0]);
    expect(attr.version).toBe(v);
    tr.update([1, 0, 0]); // origin moved -> rewrite
    expect(attr.version).toBe(v + 1);
    log.push({ t: 6, pos: [6, 0, 0] });
    tr.setFromLog(log);
    tr.update([1, 0, 0]);
    expect(attr.version).toBe(v + 2);
    expect(tr.line.geometry.drawRange.count).toBe(7);
  });

  it('setFromLog with maxT shows no point later than t', () => {
    const tr = buildTrajectoryLine(20);
    const log = Array.from({ length: 6 }, (_, i) => ({
      t: i * 2,
      pos: [i * 5, 0, 0] as [number, number, number],
    }));
    tr.setFromLog(log, 5);
    tr.update([0, 0, 0]);
    // Samples at t = 0, 2, 4 are <= 5 (3 points); t = 6, 8, 10 are excluded.
    expect(tr.line.geometry.drawRange.count).toBe(3);
    const arr = tr.line.geometry.getAttribute('position').array as Float32Array;
    expect(arr[6]).toBeCloseTo(10, 5);
  });
});

describe('buildParachute', () => {
  it('has a bounding box width of about the diameter', () => {
    const d = 0.3;
    const chute = buildParachute(d);
    const box = new THREE.Box3().setFromObject(chute);
    const size = box.getSize(new THREE.Vector3());
    expect(Math.abs(size.x - d)).toBeLessThan(d * 0.01);
    expect(Math.abs(size.z - d)).toBeLessThan(d * 0.01);
  });

  it('opens upward with the canopy rim 1.2 * diameter above the origin', () => {
    const d = 0.5;
    const chute = buildParachute(d);
    const box = new THREE.Box3().setFromObject(chute);
    // Canopy dome top is rim + radius; shrouds reach the origin at y = 0.
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(box.max.y).toBeCloseTo(1.2 * d + d / 2, 3);
  });
});

describe('buildSky', () => {
  it('does not throw and sets uniforms', () => {
    const sky = buildSky();
    expect(() =>
      sky.update(30_000, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)),
    ).not.toThrow();
    const mat = sky.mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.uOpacity.value).toBeGreaterThan(0);
    expect(mat.uniforms.uOpacity.value).toBeLessThan(1);
    expect(mat.side).toBe(THREE.BackSide);
    expect(mat.depthWrite).toBe(false);
    expect(sky.mesh.renderOrder).toBe(-1);
  });

  it('fades out fully above 70 km and is opaque below 15 km', () => {
    const sky = buildSky();
    const mat = sky.mesh.material as THREE.ShaderMaterial;
    const up = new THREE.Vector3(0, 1, 0);
    const sun = new THREE.Vector3(0, 1, 0);
    sky.update(5_000, sun, up);
    expect(mat.uniforms.uOpacity.value).toBe(1);
    sky.update(100_000, sun, up);
    expect(mat.uniforms.uOpacity.value).toBe(0);
  });

  it('is darker at night but never black', () => {
    const sky = buildSky();
    const mat = sky.mesh.material as THREE.ShaderMaterial;
    const up = new THREE.Vector3(0, 1, 0);
    sky.update(0, new THREE.Vector3(0, 1, 0), up);
    const dayLum = (mat.uniforms.uHorizon.value as THREE.Color).r;
    sky.update(0, new THREE.Vector3(0, -1, 0), up);
    const nightLum = (mat.uniforms.uHorizon.value as THREE.Color).r;
    expect(nightLum).toBeLessThan(dayLum);
    expect(nightLum).toBeGreaterThan(0);
  });
});

describe('applyFlatStyle', () => {
  it('swaps MeshStandardMaterial for MeshLambertMaterial and keeps colour', () => {
    const root = new THREE.Group();
    const std = new THREE.MeshStandardMaterial({ color: 0xe2552f, transparent: true, opacity: 0.5 });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), std));
    applyFlatStyle(root);
    const mesh = root.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.MeshLambertMaterial;
    expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mat.color.getHex()).toBe(0xe2552f);
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBe(0.5);
    expect(mat.flatShading).toBe(false);
  });
});

describe('helpers', () => {
  it('vecRel subtracts in float64', () => {
    const v = vecRel([1e6 + 0.25, 2, 3], [1e6, 1, 1]);
    expect(v.x).toBeCloseTo(0.25, 9);
    expect(v.y).toBe(1);
    expect(v.z).toBe(2);
  });

  it('quatToThree maps [x,y,z,w]', () => {
    const q = quatToThree([0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    expect(q.z).toBeCloseTo(Math.SQRT1_2, 9);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 9);
  });
});
