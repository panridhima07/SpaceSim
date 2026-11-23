import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildBuildStand } from './buildStand';

function allMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) out.push(obj);
  });
  return out;
}

function insideRod(obj: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    if (o.name === 'rod') return true;
  }
  return false;
}

function triangleCount(root: THREE.Object3D): number {
  let n = 0;
  for (const m of allMeshes(root)) {
    const geo = m.geometry;
    n += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  }
  return n;
}

describe('buildStand', () => {
  const R = 0.5;
  const L = 2;

  it('has the group and named children', () => {
    const stand = buildBuildStand({ maxRadius: R, rocketLength: L });
    expect(stand.name).toBe('build-stand');
    for (const name of ['deflector', 'legs', 'rod', 'base']) {
      expect(stand.getObjectByName(name)).toBeDefined();
    }
  });

  it('every non-rod mesh stays at or below y = 0', () => {
    const stand = buildBuildStand({ maxRadius: R, rocketLength: L });
    stand.updateMatrixWorld(true);
    let checked = 0;
    for (const m of allMeshes(stand)) {
      if (insideRod(m)) continue;
      const box = new THREE.Box3().setFromObject(m);
      expect(box.max.y).toBeLessThanOrEqual(1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('lowest point is about -H where H = max(0.25 * length, 0.08)', () => {
    const stand = buildBuildStand({ maxRadius: R, rocketLength: L });
    stand.updateMatrixWorld(true);
    let minY = Infinity;
    for (const m of allMeshes(stand)) {
      if (insideRod(m)) continue;
      minY = Math.min(minY, new THREE.Box3().setFromObject(m).min.y);
    }
    expect(minY).toBeCloseTo(-Math.max(0.25 * L, 0.08), 3);
  });

  it('rod top is about 0.9 * length and sits beyond the rocket body on +X', () => {
    const stand = buildBuildStand({ maxRadius: R, rocketLength: L });
    stand.updateMatrixWorld(true);
    const rod = stand.getObjectByName('rod')!;
    const rodBox = new THREE.Box3().setFromObject(rod);
    expect(rodBox.max.y).toBeCloseTo(0.9 * L, 3);

    const shaft = stand.getObjectByName('rod-shaft')!;
    const center = new THREE.Box3().setFromObject(shaft).getCenter(new THREE.Vector3());
    expect(center.x).toBeGreaterThan(R);
    expect(center.z).toBeCloseTo(0, 6);
  });

  it('model scales with a bigger rocket', () => {
    const small = buildBuildStand({ maxRadius: 0.5, rocketLength: 2 });
    const big = buildBuildStand({ maxRadius: 1.0, rocketLength: 4 });
    small.updateMatrixWorld(true);
    big.updateMatrixWorld(true);
    const sSize = new THREE.Box3().setFromObject(small).getSize(new THREE.Vector3());
    const bSize = new THREE.Box3().setFromObject(big).getSize(new THREE.Vector3());
    expect(bSize.x / sSize.x).toBeCloseTo(2, 1);
    expect(bSize.y / sSize.y).toBeCloseTo(2, 1);
    const sRod = new THREE.Box3().setFromObject(small.getObjectByName('rod')!).max.y;
    const bRod = new THREE.Box3().setFromObject(big.getObjectByName('rod')!).max.y;
    expect(bRod / sRod).toBeCloseTo(2, 3);
  });

  it('stays under 1200 triangles', () => {
    expect(triangleCount(buildBuildStand({ maxRadius: R, rocketLength: L }))).toBeLessThan(1200);
    expect(triangleCount(buildBuildStand({ maxRadius: 0.0125, rocketLength: 0.4 }))).toBeLessThan(1200);
  });

  it('degenerate inputs do not throw and give finite bounds', () => {
    const bad = [0, -1, NaN, Infinity];
    for (const v of bad) {
      for (const input of [
        { maxRadius: v, rocketLength: 1 },
        { maxRadius: 0.5, rocketLength: v },
      ]) {
        let stand: THREE.Group | undefined;
        expect(() => {
          stand = buildBuildStand(input);
        }).not.toThrow();
        stand!.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(stand!);
        expect(Number.isFinite(box.min.x) && Number.isFinite(box.max.x)).toBe(true);
        expect(Number.isFinite(box.min.y) && Number.isFinite(box.max.y)).toBe(true);
        expect(Number.isFinite(box.min.z) && Number.isFinite(box.max.z)).toBe(true);
      }
    }
  });
});
