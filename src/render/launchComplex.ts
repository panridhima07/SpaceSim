import * as THREE from 'three';

export interface LaunchComplexParams {
  /** Total height of the launch vehicle, m. */
  vehicleHeight: number;
  /** Maximum radius of the launch vehicle including boosters, m. */
  maxRadius: number;
}

const COLORS = {
  concrete: 0x8b8e93,
  pedestal: 0x525760,
  tower: 0xc94a38,
  lightning: 0xd8dce3,
  trench: 0x2c3038,
} as const;

function makeMat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0.1,
    flatShading: true,
  });
}

export function buildLaunchComplex(params: LaunchComplexParams): THREE.Group {
  const { vehicleHeight, maxRadius } = params;
  const group = new THREE.Group();
  group.name = 'launch-complex';

  const concreteMat = makeMat(COLORS.concrete);
  const pedestalMat = makeMat(COLORS.pedestal);
  const towerMat = makeMat(COLORS.tower);
  const lightningMat = makeMat(COLORS.lightning);
  const trenchMat = makeMat(COLORS.trench);

  // Pad apron (sits at y <= 0)
  const apronSize = Math.max(50, maxRadius * 8);
  const apron = new THREE.Mesh(new THREE.BoxGeometry(apronSize, 2, apronSize), concreteMat);
  apron.name = 'pad-apron';
  apron.position.set(0, -3, 0);
  group.add(apron);

  // Mobile launch pedestal (top at y = 0)
  const pedWidth = Math.max(14, maxRadius * 2.8);
  const ped = new THREE.Mesh(new THREE.BoxGeometry(pedWidth, 2, pedWidth), pedestalMat);
  ped.name = 'launch-pedestal';
  ped.position.set(0, -1, 0);
  group.add(ped);

  // Flame trench (below pedestal)
  const trench = new THREE.Mesh(
    new THREE.BoxGeometry(maxRadius * 2.2, 2, apronSize * 0.8),
    trenchMat,
  );
  trench.name = 'flame-trench';
  trench.position.set(0, -4, 0);
  group.add(trench);

  // Umbilical tower (taller than vehicle, clear of maxRadius)
  const towerHeight = vehicleHeight + 6;
  const towerWidth = 4;
  const towerX = -(maxRadius + 5 + towerWidth / 2);
  const umbilical = new THREE.Mesh(
    new THREE.BoxGeometry(towerWidth, towerHeight, towerWidth),
    towerMat,
  );
  umbilical.name = 'umbilical-tower';
  umbilical.position.set(towerX, towerHeight / 2, 0);
  group.add(umbilical);

  // Two lightning towers
  const lightningHeight = vehicleHeight + 12;
  const ltOffset = maxRadius + 14;
  for (const [idx, zSign] of [
    [1, 1],
    [2, -1],
  ] as const) {
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 1.0, lightningHeight, 8),
      lightningMat,
    );
    mast.name = `lightning-tower-${idx}`;
    mast.position.set(ltOffset, lightningHeight / 2, zSign * ltOffset);
    group.add(mast);
  }

  return group;
}

export function disposeLaunchComplex(group: THREE.Group): void {
  const materials = new Set<THREE.Material>();
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.dispose();
    if (Array.isArray(obj.material)) {
      for (const m of obj.material) materials.add(m);
    } else if (obj.material) {
      materials.add(obj.material);
    }
  });
  for (const m of materials) {
    m.dispose();
  }
}
