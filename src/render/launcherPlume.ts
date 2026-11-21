import * as THREE from 'three';
import type { LauncherMesh, LauncherSpec } from './launcherMesh';

const LIQUID_OUTER = 0xff8a2b;
const LIQUID_INNER = 0xffe9a8;
const SOLID_OUTER = 0xffaa33;
const SOLID_INNER = 0xfff3c4;
const SEA_LEVEL_PA = 101325;

export interface PlumeInstance {
  group: THREE.Group;
  outer: THREE.Mesh;
  inner: THREE.Mesh;
  baseRadius: number;
  baseLength: number;
  solid: boolean;
}

export interface LauncherPlumes {
  stages: {
    stageGroup: THREE.Group;
    plumes: PlumeInstance[];
  }[];
  geometry: THREE.ConeGeometry;
  materials: THREE.Material[];
}

export interface PlumeUpdateState {
  /** Throttle 0..1 per stage (same index as spec.stages). */
  throttles: number[];
  /** Ambient atmospheric pressure in Pa (101325 at sea level, 0 in vacuum). */
  ambientPressure: number;
}

function unitFlameGeometry(): THREE.ConeGeometry {
  const g = new THREE.ConeGeometry(1, 1, 16, 1, true);
  g.rotateX(Math.PI);
  g.translate(0, -0.5, 0);
  return g;
}

function makePlume(
  geometry: THREE.ConeGeometry,
  outerMat: THREE.Material,
  innerMat: THREE.Material,
  baseRadius: number,
  baseLength: number,
  solid: boolean,
): PlumeInstance {
  const group = new THREE.Group();
  group.name = 'plume';
  group.visible = false;

  const outer = new THREE.Mesh(geometry, outerMat);
  outer.name = 'plume-outer';
  const inner = new THREE.Mesh(geometry, innerMat);
  inner.name = 'plume-inner';

  group.add(outer, inner);
  return { group, outer, inner, baseRadius, baseLength, solid };
}

export function buildLauncherPlumes(
  mesh: LauncherMesh,
  spec: LauncherSpec,
  isSolid?: boolean[],
): LauncherPlumes {
  const geometry = unitFlameGeometry();

  const liquidOuter = new THREE.MeshBasicMaterial({
    color: LIQUID_OUTER,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const liquidInner = new THREE.MeshBasicMaterial({
    color: LIQUID_INNER,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const solidOuter = new THREE.MeshBasicMaterial({
    color: SOLID_OUTER,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const solidInner = new THREE.MeshBasicMaterial({
    color: SOLID_INNER,
    transparent: true,
    opacity: 0.98,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const materials: THREE.Material[] = [liquidOuter, liquidInner, solidOuter, solidInner];
  const stages: LauncherPlumes['stages'] = [];

  let coreTopY = 0;

  for (let i = 0; i < spec.stages.length; i++) {
    const stage = spec.stages[i];
    const stageGroup = mesh.stageGroups[i];
    const solid = isSolid ? Boolean(isSolid[i]) : Boolean(stage.parallel);
    const outerMat = solid ? solidOuter : liquidOuter;
    const innerMat = solid ? solidInner : liquidInner;

    const nozzleHeight = 0.6 * stage.radius;
    const nozzleRadius = stage.engineCount === 1 ? 0.32 * stage.radius : 0.24 * stage.radius;
    const baseLength = 6 * stage.radius;
    const ringRadius = 0.5 * stage.radius;

    const stagePlumes: PlumeInstance[] = [];

    if (stage.parallel) {
      for (const booster of stageGroup.children) {
        for (let e = 0; e < stage.engineCount; e++) {
          const p = makePlume(geometry, outerMat, innerMat, nozzleRadius, baseLength, solid);
          if (stage.engineCount === 1) {
            p.group.position.set(0, -nozzleHeight, 0);
          } else {
            const angle = (2 * Math.PI * e) / stage.engineCount;
            p.group.position.set(
              ringRadius * Math.cos(angle),
              -nozzleHeight,
              ringRadius * Math.sin(angle),
            );
          }
          booster.add(p.group);
          stagePlumes.push(p);
        }
      }
    } else {
      const exitY = coreTopY - nozzleHeight;
      for (let e = 0; e < stage.engineCount; e++) {
        const p = makePlume(geometry, outerMat, innerMat, nozzleRadius, baseLength, solid);
        if (stage.engineCount === 1) {
          p.group.position.set(0, exitY, 0);
        } else {
          const angle = (2 * Math.PI * e) / stage.engineCount;
          p.group.position.set(
            ringRadius * Math.cos(angle),
            exitY,
            ringRadius * Math.sin(angle),
          );
        }
        stageGroup.add(p.group);
        stagePlumes.push(p);
      }
      coreTopY += stage.length;
    }

    stages.push({ stageGroup, plumes: stagePlumes });
  }

  return { stages, geometry, materials };
}

export function updatePlumes(plumes: LauncherPlumes, state: PlumeUpdateState): void {
  const pNorm = Math.max(0, Math.min(1, state.ambientPressure / SEA_LEVEL_PA));
  // Narrow (1x) at sea level, ~3x wider in vacuum
  const pressureScale = 1 + 2 * (1 - pNorm);

  for (let i = 0; i < plumes.stages.length; i++) {
    const { stageGroup, plumes: stagePlumes } = plumes.stages[i];
    const throttle = Math.max(0, Math.min(1, state.throttles[i] ?? 0));
    const active = throttle > 0 && stageGroup.visible;

    for (const p of stagePlumes) {
      if (!active) {
        p.group.visible = false;
        continue;
      }
      p.group.visible = true;
      const solidLen = p.solid ? 1.25 : 1;
      const solidWidth = p.solid ? 1.3 : 1;
      const length = p.baseLength * (0.3 + 0.7 * throttle) * solidLen;
      const width = p.baseRadius * pressureScale * solidWidth;
      p.outer.scale.set(width, length, width);
      p.inner.scale.set(width * 0.5, length * 0.6, width * 0.5);
    }
  }
}

export function disposeLauncherPlumes(plumes: LauncherPlumes): void {
  plumes.geometry.dispose();
  for (const m of plumes.materials) {
    m.dispose();
  }
}
