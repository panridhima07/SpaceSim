import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface LaunchComplexParams {
  /** Total height of the launch vehicle, m. */
  vehicleHeight: number;
  /** Maximum radius of the launch vehicle including boosters, m. */
  maxRadius: number;
}

const COLORS = {
  concrete: 0xa3a39d,
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

  // Umbilical tower: a steel lattice (columns, ring beams, X-bracing, platforms) taller than the
  // vehicle, clear of maxRadius, with short swing arms reaching toward the stack.
  const towerHeight = vehicleHeight + 6;
  const towerWidth = 6;
  const towerX = -(maxRadius + 5 + towerWidth / 2);
  const umbilical = new THREE.Mesh(latticeTower(towerWidth, towerHeight), towerMat);
  umbilical.name = 'umbilical-tower';
  umbilical.position.set(towerX, 0, 0);
  group.add(umbilical);
  const armStart = towerX + towerWidth / 2;
  const armEnd = -(maxRadius + 1.2);
  if (armEnd > armStart) {
    for (const frac of [0.42, 0.78]) {
      const len = armEnd - armStart;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(len, 1.6, 2.2), towerMat);
      arm.name = 'umbilical-tower';
      arm.position.set(armStart + len / 2, vehicleHeight * frac, 0);
      group.add(arm);
    }
  }

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

/** Merged lattice geometry for a square tower of side w and height h, base at y = 0, centred on x = z = 0. */
function latticeTower(w: number, h: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const half = w / 2;
  const col = 0.5;
  const beam = 0.28;
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void => {
    g.rotateX(rx);
    g.rotateY(ry);
    g.rotateZ(rz);
    g.translate(x, y, z);
    parts.push(g);
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.BoxGeometry(col, h, col), sx * half, h / 2, sz * half);
  const level = 4;
  const levels = Math.floor(h / level);
  for (let i = 0; i <= levels; i++) {
    const y = Math.min(h - beam / 2, i * level + beam / 2);
    for (const sz of [-1, 1]) add(new THREE.BoxGeometry(w, beam, beam), 0, y, sz * half);
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(beam, beam, w), sx * half, y, 0);
    if (i < levels) {
      // X-bracing on each face of the bay above this level.
      const diag = Math.hypot(w, level);
      const ang = Math.atan2(level, w);
      for (const sz of [-1, 1]) {
        add(new THREE.BoxGeometry(diag, beam * 0.8, beam * 0.8), 0, y + level / 2, sz * half, 0, 0, ang);
        add(new THREE.BoxGeometry(diag, beam * 0.8, beam * 0.8), 0, y + level / 2, sz * half, 0, 0, -ang);
      }
      for (const sx of [-1, 1]) {
        add(new THREE.BoxGeometry(beam * 0.8, beam * 0.8, diag), sx * half, y + level / 2, 0, ang, 0, 0);
        add(new THREE.BoxGeometry(beam * 0.8, beam * 0.8, diag), sx * half, y + level / 2, 0, -ang, 0, 0);
      }
    }
    if (i % 3 === 0 && i > 0) add(new THREE.BoxGeometry(w + 1.2, 0.25, w + 1.2), 0, y, 0);
  }
  // Mast on top.
  add(new THREE.BoxGeometry(0.3, 6, 0.3), 0, h + 3, 0);
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged ?? new THREE.BoxGeometry(w, h, w).translate(0, h / 2, 0);
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
