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
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
}

export interface PlumeUpdateState {
  /** Throttle 0..1 per stage (same index as spec.stages). */
  throttles: number[];
  /** Ambient atmospheric pressure in Pa (101325 at sea level, 0 in vacuum). */
  ambientPressure: number;
}

/**
 * Unit flame: nozzle exit at y = 0, tip at y = -1, radius 1 at the exit. The profile bulges a
 * little past the exit (the plume expands) then tapers to the tip. uv.y is 0 at the exit, 1 at
 * the tip, which the flame shader uses for its colour ramp.
 */
function unitFlameGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const n = 20;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const r = (0.92 + 0.45 * Math.sin(Math.min(1, s * 2.2) * Math.PI * 0.5)) * Math.pow(1 - s, 0.75) + 0.02;
    pts.push(new THREE.Vector2(r, -s));
  }
  const g = new THREE.LatheGeometry(pts.reverse(), 24);
  // LatheGeometry's uv.y runs along the profile (tip first after the reverse): flip so 0 = exit.
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return g;
}

const flameTime = { value: 0 };
/** Advance the flame flicker (seconds). Shared by every plume. */
export function setPlumeTime(t: number): void {
  flameTime.value = t % 1000;
}

function flameMaterial(outer: number, inner: number, core: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uOuter: { value: new THREE.Color(outer) },
      uInner: { value: new THREE.Color(inner) },
      uTime: flameTime,
      uCore: { value: core ? 1 : 0 },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vFacing = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uOuter;
      uniform vec3 uInner;
      uniform float uTime;
      uniform float uCore;
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        #include <logdepthbuf_fragment>
        float v = vUv.y;
        // Flicker and shock-diamond banding along the length.
        float flick = 0.85 + 0.15 * sin(uTime * 47.0 + v * 23.0) * sin(uTime * 31.0 + vUv.x * 40.0);
        float diamonds = 0.82 + 0.18 * pow(abs(sin(v * 26.0 - uTime * 2.0)), 6.0) * (1.0 - v);
        float body = pow(1.0 - v, mix(1.6, 2.6, uCore)) * smoothstep(0.0, 0.04, v + 0.02);
        float edge = pow(vFacing, mix(1.2, 0.6, uCore));
        vec3 col = mix(uInner * 1.6, uOuter, smoothstep(0.0, mix(0.55, 0.3, uCore), v));
        float a = body * edge * flick * diamonds;
        gl_FragColor = vec4(col * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function makePlume(
  geometry: THREE.BufferGeometry,
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

  const liquidOuter = flameMaterial(LIQUID_OUTER, LIQUID_INNER, false);
  const liquidInner = flameMaterial(LIQUID_INNER, 0xffffff, true);
  const solidOuter = flameMaterial(SOLID_OUTER, SOLID_INNER, false);
  const solidInner = flameMaterial(SOLID_INNER, 0xffffff, true);

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
    const baseLength = 10 * stage.radius;
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
      // Plumes are wider than the nozzle exit even at sea level.
      const width = p.baseRadius * 1.7 * pressureScale * solidWidth;
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
