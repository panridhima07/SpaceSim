// Builds three.js geometry for a staged orbital launch vehicle (LauncherSpec).
//
// Local frame: vehicle axis along +Y, nose pointing +Y, origin at the base of
// the first core stage. Units are metres.

import * as THREE from 'three';

export interface LauncherStage {
  name: string;
  length: number;        // m
  radius: number;        // m
  engineCount: number;
  /** Present on strap-on boosters: `count` copies around the first core stage. */
  parallel?: { count: number; radialOffset: number; attachStation: number };
}

export interface LauncherSpec {
  name: string;
  /** Core stages from the bottom up, plus strap-on boosters (those with `parallel`), in any order. */
  stages: LauncherStage[];
  payload: { length: number; radius?: number };
  fairing?: { length: number; radius: number; noseLength?: number };
}

export interface LauncherMesh {
  /** Everything. Add this to the scene. */
  group: THREE.Group;
  /** One group per entry of spec.stages, same index. A booster stage's
      group has one direct child per booster. */
  stageGroups: THREE.Group[];
  /** [left half, right half], or null when the spec has no fairing. */
  fairingHalves: [THREE.Group, THREE.Group] | null;
  payload: THREE.Group;
  /** Height from y = 0 to the tip of the nose, m. */
  totalLength: number;
}

export interface LauncherState {
  /** Same length and index as spec.stages. false = separated, hide it. */
  stagesAttached: boolean[];
  fairingAttached: boolean;
}

const COLORS = {
  coreA: 0xf2f1ec,
  coreB: 0xe3e1d8,
  booster: 0xc8ccd2,
  nozzle: 0x2b3440,
  fairing: 0xffffff,
  payload: 0xd4a438,
} as const;

const RADIAL_SEGMENTS = 32;
const NOSE_POINTS = 24;

interface MaterialSet {
  coreA: THREE.MeshStandardMaterial;
  coreB: THREE.MeshStandardMaterial;
  booster: THREE.MeshStandardMaterial;
  nozzle: THREE.MeshStandardMaterial;
  fairing: THREE.MeshStandardMaterial;
  payload: THREE.MeshStandardMaterial;
}

function makeMaterial(color: number, doubleSided = false): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.05,
    flatShading: true,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

function createMaterials(): MaterialSet {
  return {
    coreA: makeMaterial(COLORS.coreA),
    coreB: makeMaterial(COLORS.coreB),
    booster: makeMaterial(COLORS.booster),
    nozzle: makeMaterial(COLORS.nozzle),
    fairing: makeMaterial(COLORS.fairing, true),
    payload: makeMaterial(COLORS.payload),
  };
}

function addNozzles(
  parent: THREE.Group,
  baseY: number,
  stageRadius: number,
  engineCount: number,
  material: THREE.MeshStandardMaterial,
): void {
  if (engineCount <= 0) return;

  const nozzleHeight = 0.6 * stageRadius;
  const nozzleRadius = engineCount === 1 ? 0.32 * stageRadius : 0.24 * stageRadius;
  const ringRadius = 0.5 * stageRadius;
  const centerY = baseY - nozzleHeight / 2;

  for (let i = 0; i < engineCount; i++) {
    const geom = new THREE.ConeGeometry(nozzleRadius, nozzleHeight, 16, 1, true);
    const mesh = new THREE.Mesh(geom, material);
    if (engineCount === 1) {
      mesh.position.set(0, centerY, 0);
    } else {
      const angle = (2 * Math.PI * i) / engineCount;
      mesh.position.set(
        ringRadius * Math.cos(angle),
        centerY,
        ringRadius * Math.sin(angle),
      );
    }
    parent.add(mesh);
  }
}

function buildBoosterStage(
  stage: LauncherStage,
  mats: MaterialSet,
): THREE.Group {
  const stageGroup = new THREE.Group();
  stageGroup.name = stage.name;

  const parallel = stage.parallel;
  if (!parallel) return stageGroup;

  const coneHeight = Math.min(stage.length, 2 * stage.radius);
  const cylHeight = Math.max(0, stage.length - coneHeight);

  for (let k = 0; k < parallel.count; k++) {
    const angle = (2 * Math.PI * k) / parallel.count;
    const x = parallel.radialOffset * Math.cos(angle);
    const z = parallel.radialOffset * Math.sin(angle);

    const booster = new THREE.Group();
    booster.name = `${stage.name}-${k}`;
    booster.position.set(x, parallel.attachStation, z);

    if (cylHeight > 0) {
      const cylGeom = new THREE.CylinderGeometry(
        stage.radius,
        stage.radius,
        cylHeight,
        RADIAL_SEGMENTS,
      );
      const cylMesh = new THREE.Mesh(cylGeom, mats.booster);
      cylMesh.position.y = cylHeight / 2;
      booster.add(cylMesh);
    }

    if (coneHeight > 0) {
      const coneGeom = new THREE.ConeGeometry(stage.radius, coneHeight, RADIAL_SEGMENTS);
      const coneMesh = new THREE.Mesh(coneGeom, mats.booster);
      coneMesh.position.y = cylHeight + coneHeight / 2;
      booster.add(coneMesh);
    }

    addNozzles(booster, 0, stage.radius, stage.engineCount, mats.nozzle);
    stageGroup.add(booster);
  }

  return stageGroup;
}

function buildOgiveProfile(radius: number, length: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const rho = (radius * radius + length * length) / (2 * radius);
  for (let i = 0; i < NOSE_POINTS; i++) {
    // s = length at base (y = 0), s = 0 at tip (y = length)
    const y = (length * i) / (NOSE_POINTS - 1);
    const s = length - y;
    const r = Math.sqrt(Math.max(0, rho * rho - (length - s) * (length - s))) + radius - rho;
    pts.push(new THREE.Vector2(Math.max(0, r), y));
  }
  return pts;
}

function buildFairingHalf(
  name: string,
  baseY: number,
  radius: number,
  cylLength: number,
  noseLength: number,
  phiStart: number,
  material: THREE.MeshStandardMaterial,
): THREE.Group {
  const half = new THREE.Group();
  half.name = name;

  if (cylLength > 0) {
    const cylGeom = new THREE.CylinderGeometry(
      radius,
      radius,
      cylLength,
      RADIAL_SEGMENTS / 2,
      1,
      false,
      phiStart,
      Math.PI,
    );
    const cylMesh = new THREE.Mesh(cylGeom, material);
    cylMesh.position.y = baseY + cylLength / 2;
    half.add(cylMesh);
  }

  if (noseLength > 0) {
    const profile = buildOgiveProfile(radius, noseLength);
    const noseGeom = new THREE.LatheGeometry(profile, RADIAL_SEGMENTS / 2, phiStart, Math.PI);
    const noseMesh = new THREE.Mesh(noseGeom, material);
    noseMesh.position.y = baseY + cylLength;
    half.add(noseMesh);
  }

  return half;
}

export function buildLauncherMesh(spec: LauncherSpec): LauncherMesh {
  const group = new THREE.Group();
  group.name = spec.name;

  const mats = createMaterials();
  const stageGroups: THREE.Group[] = [];

  let coreTopY = 0;
  let coreIndex = 0;
  let lastCoreRadius = 1;

  for (const stage of spec.stages) {
    if (stage.parallel) {
      const boosterGroup = buildBoosterStage(stage, mats);
      stageGroups.push(boosterGroup);
      group.add(boosterGroup);
    } else {
      const stageGroup = new THREE.Group();
      stageGroup.name = stage.name;

      const mat = coreIndex % 2 === 0 ? mats.coreA : mats.coreB;
      const cylGeom = new THREE.CylinderGeometry(
        stage.radius,
        stage.radius,
        stage.length,
        RADIAL_SEGMENTS,
      );
      const cylMesh = new THREE.Mesh(cylGeom, mat);
      cylMesh.position.y = coreTopY + stage.length / 2;
      stageGroup.add(cylMesh);

      addNozzles(stageGroup, coreTopY, stage.radius, stage.engineCount, mats.nozzle);

      coreTopY += stage.length;
      lastCoreRadius = stage.radius;
      coreIndex++;

      stageGroups.push(stageGroup);
      group.add(stageGroup);
    }
  }

  // Payload
  const payload = new THREE.Group();
  payload.name = 'payload';
  const payloadRadius = spec.payload.radius ?? 0.8 * lastCoreRadius;
  const payloadGeom = new THREE.CylinderGeometry(
    payloadRadius,
    payloadRadius,
    spec.payload.length,
    RADIAL_SEGMENTS,
  );
  const payloadMesh = new THREE.Mesh(payloadGeom, mats.payload);
  payloadMesh.position.y = coreTopY + spec.payload.length / 2;
  payload.add(payloadMesh);
  group.add(payload);

  // Fairing
  let fairingHalves: [THREE.Group, THREE.Group] | null = null;
  let totalLength = coreTopY + spec.payload.length;

  if (spec.fairing) {
    const noseLength = spec.fairing.noseLength ?? 0.4 * spec.fairing.length;
    const cylLength = Math.max(0, spec.fairing.length - noseLength);
    const left = buildFairingHalf(
      'fairing-left',
      coreTopY,
      spec.fairing.radius,
      cylLength,
      noseLength,
      0,
      mats.fairing,
    );
    const right = buildFairingHalf(
      'fairing-right',
      coreTopY,
      spec.fairing.radius,
      cylLength,
      noseLength,
      Math.PI,
      mats.fairing,
    );
    group.add(left, right);
    fairingHalves = [left, right];
    totalLength = coreTopY + spec.fairing.length;
  }

  return {
    group,
    stageGroups,
    fairingHalves,
    payload,
    totalLength,
  };
}

/** Shows or hides parts to match the flight state.
    Missing array entries count as attached. */
export function setLauncherState(mesh: LauncherMesh, state: LauncherState): void {
  for (let i = 0; i < mesh.stageGroups.length; i++) {
    mesh.stageGroups[i].visible = state.stagesAttached[i] ?? true;
  }
  if (mesh.fairingHalves) {
    mesh.fairingHalves[0].visible = state.fairingAttached;
    mesh.fairingHalves[1].visible = state.fairingAttached;
  }
}

/** Disposes every geometry and material under the group.
    Safe to call twice. */
export function disposeLauncher(mesh: LauncherMesh): void {
  const materials = new Set<THREE.Material>();
  mesh.group.traverse((obj) => {
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
