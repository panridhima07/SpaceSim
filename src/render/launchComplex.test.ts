import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildLaunchComplex, disposeLaunchComplex } from './launchComplex';

describe('launchComplex', () => {
  const params = { vehicleHeight: 45.6, maxRadius: 5.2 };

  it('umbilical and lightning towers are taller than the vehicle', () => {
    const complex = buildLaunchComplex(params);
    const umbilical = complex.getObjectByName('umbilical-tower')!;
    const lt1 = complex.getObjectByName('lightning-tower-1')!;
    const lt2 = complex.getObjectByName('lightning-tower-2')!;

    expect(new THREE.Box3().setFromObject(umbilical).max.y).toBeGreaterThan(params.vehicleHeight);
    expect(new THREE.Box3().setFromObject(lt1).max.y).toBeGreaterThan(params.vehicleHeight);
    expect(new THREE.Box3().setFromObject(lt2).max.y).toBeGreaterThan(params.vehicleHeight);

    disposeLaunchComplex(complex);
  });

  it('no pad mesh bounding box overlaps the vehicle bounding cylinder above y = 0', () => {
    const complex = buildLaunchComplex(params);
    complex.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const box = new THREE.Box3().setFromObject(obj);
      if (box.max.y <= 0) return;

      // Closest point in XZ of the mesh's AABB to the vehicle axis (0, 0)
      const cx = Math.max(box.min.x, Math.min(0, box.max.x));
      const cz = Math.max(box.min.z, Math.min(0, box.max.z));
      const dist = Math.hypot(cx, cz);
      expect(dist).toBeGreaterThan(params.maxRadius);
    });
    disposeLaunchComplex(complex);
  });

  it('everything sits at or below y = 0 except towers', () => {
    const complex = buildLaunchComplex(params);
    complex.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const box = new THREE.Box3().setFromObject(obj);
      const isTower =
        obj.name === 'umbilical-tower' || obj.name.startsWith('lightning-tower-');
      if (!isTower) {
        expect(box.max.y).toBeLessThanOrEqual(0);
      }
    });
    disposeLaunchComplex(complex);
  });
});
