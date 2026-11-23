// Flat, minimal visual effects: exhaust flame, smoke trail, trajectory line,
// parachute, sky dome and small helpers.
//
// Floating origin: every object takes float64 world positions (Earth-centred,
// metres) and is drawn at (worldPos - origin). Subtraction happens in float64
// before anything is stored in a Float32 buffer.

import * as THREE from 'three';
import type { Quat, Vec3 } from '../types';

// ---------- Helpers ----------

/** Quaternion [x, y, z, w] to THREE.Quaternion. */
export function quatToThree(q: Quat): THREE.Quaternion {
  return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
}

/** Float64 world position relative to origin, as a THREE.Vector3 (float64 numbers). */
export function vecRel(p: Vec3, origin: Vec3, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// ---------- Exhaust ----------

const EXHAUST_OUTER = 0xff8a2b;
const EXHAUST_INNER = 0xffe9a8;

/** Cone with base at the origin (y = 0) and tip at y = -1, unit radius. */
function unitFlameGeometry(): THREE.ConeGeometry {
  const g = new THREE.ConeGeometry(1, 1, 16, 1, true);
  g.rotateX(Math.PI); // apex to -Y, base to +Y
  g.translate(0, -0.5, 0); // apex at -1, base at 0
  return g;
}

/**
 * Stylised two-cone flame. Base at the group origin (the nozzle), tip toward -Y.
 * Hidden when thrust is zero or negative.
 */
export function buildExhaust(): {
  group: THREE.Group;
  update(thrustN: number, maxThrustN: number, bodyRadius: number, time: number): void;
} {
  const group = new THREE.Group();
  group.name = 'exhaust';
  const geometry = unitFlameGeometry();

  const outer = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: EXHAUST_OUTER, transparent: true, opacity: 0.9,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  const inner = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: EXHAUST_INNER, transparent: true, opacity: 0.95,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  outer.name = 'exhaust-outer';
  inner.name = 'exhaust-inner';
  group.add(outer, inner);
  group.visible = false;

  return {
    group,
    update(thrustN, maxThrustN, bodyRadius, time) {
      if (!(thrustN > 0) || !(bodyRadius > 0)) {
        group.visible = false;
        return;
      }
      group.visible = true;
      const ratio = maxThrustN > 0 ? thrustN / maxThrustN : 1;
      const flicker = 1 + 0.06 * Math.sin(time * 41) + 0.04 * Math.sin(time * 23.7 + 1.3);
      const length = bodyRadius * (4 + 10 * ratio) * flicker;
      const radius = bodyRadius * 0.9 * (1 + 0.04 * Math.sin(time * 31));
      outer.scale.set(radius, length, radius);
      inner.scale.set(radius * 0.5, length * 0.6, radius * 0.5);
    },
  };
}

// ---------- Smoke trail ----------

const PUFF_LIFE = 6; // seconds
const PUFF_COLOR = 0xd8dce2;

interface Puff {
  x: number;
  y: number;
  z: number;
  age: number;
  size: number;
  alive: boolean;
}

/**
 * Ring buffer of smoke puffs drawn as an InstancedMesh. Each puff grows x3 over
 * its 6 s life and shrinks to zero scale at the end (instance opacity is not
 * available, so the fade is done through scale). Slots are recycled once
 * `maxPuffs` have been emitted.
 */
export function buildSmokeTrail(maxPuffs = 400): {
  object: THREE.Object3D;
  emit(worldPos: Vec3, size: number): void;
  update(dt: number, origin: Vec3): void;
  clear(): void;
} {
  const capacity = Math.max(1, Math.floor(maxPuffs));
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({
    color: PUFF_COLOR, transparent: true, opacity: 0.75, depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'smoke-trail';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const puffs: Puff[] = [];
  for (let i = 0; i < capacity; i++) {
    puffs.push({ x: 0, y: 0, z: 0, age: 0, size: 0, alive: false });
  }
  let head = 0; // next slot to write
  let filled = 0; // number of slots ever used (<= capacity)

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  return {
    object: mesh,

    emit(worldPos, size) {
      const pf = puffs[head];
      pf.x = worldPos[0];
      pf.y = worldPos[1];
      pf.z = worldPos[2];
      pf.age = 0;
      pf.size = size;
      pf.alive = true;
      head = (head + 1) % capacity;
      filled = Math.min(filled + 1, capacity);
      mesh.count = filled;
    },

    update(dt, origin) {
      for (let i = 0; i < filled; i++) {
        const pf = puffs[i];
        if (pf.alive) {
          pf.age += dt;
          if (pf.age >= PUFF_LIFE) pf.alive = false;
        }
        if (pf.alive) {
          const u = pf.age / PUFF_LIFE;
          const grow = 1 + 2 * u;
          const fade = u < 0.7 ? 1 : Math.max(0, (1 - u) / 0.3);
          const sc = pf.size * grow * fade;
          p.set(pf.x - origin[0], pf.y - origin[1], pf.z - origin[2]);
          s.set(sc, sc, sc);
          m.compose(p, q, s);
          mesh.setMatrixAt(i, m);
        } else {
          mesh.setMatrixAt(i, zero);
        }
      }
      mesh.count = filled;
      mesh.instanceMatrix.needsUpdate = true;
    },

    clear() {
      for (const pf of puffs) pf.alive = false;
      head = 0;
      filled = 0;
      mesh.count = 0;
    },
  };
}

// ---------- Trajectory line ----------

/**
 * Thin line through stored float64 points. Vertices are rewritten relative to
 * the origin on every update(); only the first `n` vertices are drawn.
 */
export function buildTrajectoryLine(maxPoints = 5000): {
  line: THREE.Line;
  push(worldPos: Vec3): void;
  setAll(points: Vec3[]): void;
  setFromLog(log: ReadonlyArray<{ t: number; pos: Vec3 }>, maxT?: number): void;
  update(origin: Vec3): void;
  clear(): void;
} {
  const capacity = Math.max(2, Math.floor(maxPoints));
  const positions = new Float32Array(capacity * 3);
  const attr = new THREE.BufferAttribute(positions, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', attr);
  geometry.setDrawRange(0, 0);

  const material = new THREE.LineBasicMaterial({ color: 0xf5a65b });
  const line = new THREE.Line(geometry, material);
  line.name = 'trajectory';
  line.frustumCulled = false;

  // Absolute (float64) positions, packed xyz. Reused across calls.
  const abs = new Float64Array(capacity * 3);
  let count = 0;
  let dirty = true; // abs changed since last update()
  let lastOrigin: Vec3 | null = null;
  // setFromLog memo: skip work when the same log yields the same selection.
  let memoLog: ReadonlyArray<{ t: number; pos: Vec3 }> | null = null;
  let memoEnd = -2;
  let memoLen = -1;

  function invalidateMemo(): void {
    memoLog = null;
    memoEnd = -2;
    memoLen = -1;
  }

  // Same selection as before: all items if they fit, otherwise capacity points
  // evenly spaced by index (first and last kept).
  function decimateInto<T>(
    items: ReadonlyArray<T>,
    endIdx: number,
    pick: (item: T) => Vec3,
  ): void {
    const n = endIdx + 1;
    if (n <= 0) {
      count = 0;
      return;
    }
    if (n <= capacity) {
      for (let i = 0; i < n; i++) {
        const p = pick(items[i]);
        abs[i * 3] = p[0];
        abs[i * 3 + 1] = p[1];
        abs[i * 3 + 2] = p[2];
      }
      count = n;
      return;
    }
    for (let i = 0; i < capacity; i++) {
      const idx = Math.round((i * (n - 1)) / (capacity - 1));
      const p = pick(items[idx]);
      abs[i * 3] = p[0];
      abs[i * 3 + 1] = p[1];
      abs[i * 3 + 2] = p[2];
    }
    count = capacity;
  }

  return {
    line,

    push(worldPos) {
      invalidateMemo();
      if (count >= capacity) {
        abs.copyWithin(0, 3, capacity * 3);
        count = capacity - 1;
      }
      abs[count * 3] = worldPos[0];
      abs[count * 3 + 1] = worldPos[1];
      abs[count * 3 + 2] = worldPos[2];
      count++;
      dirty = true;
    },

    setAll(all) {
      invalidateMemo();
      decimateInto(all, all.length - 1, (p) => p);
      dirty = true;
    },

    setFromLog(log, maxT) {
      if (log.length === 0) {
        if (count !== 0) dirty = true;
        count = 0;
        invalidateMemo();
        return;
      }
      let endIdx = log.length - 1;
      if (maxT !== undefined && maxT < log[endIdx].t) {
        if (maxT < log[0].t) {
          if (count !== 0) dirty = true;
          count = 0;
          invalidateMemo();
          return;
        }
        let lo = 0;
        let hi = endIdx;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (log[mid].t <= maxT) lo = mid;
          else hi = mid - 1;
        }
        endIdx = lo;
      }
      if (log === memoLog && endIdx === memoEnd && log.length === memoLen) return;
      memoLog = log;
      memoEnd = endIdx;
      memoLen = log.length;
      decimateInto(log, endIdx, (s) => s.pos);
      dirty = true;
    },

    update(origin) {
      if (
        !dirty &&
        lastOrigin !== null &&
        lastOrigin[0] === origin[0] &&
        lastOrigin[1] === origin[1] &&
        lastOrigin[2] === origin[2]
      ) {
        return;
      }
      const ox = origin[0];
      const oy = origin[1];
      const oz = origin[2];
      for (let i = 0; i < count; i++) {
        positions[i * 3] = abs[i * 3] - ox;
        positions[i * 3 + 1] = abs[i * 3 + 1] - oy;
        positions[i * 3 + 2] = abs[i * 3 + 2] - oz;
      }
      attr.needsUpdate = true;
      geometry.setDrawRange(0, count);
      lastOrigin = [ox, oy, oz];
      dirty = false;
    },

    clear() {
      invalidateMemo();
      count = 0;
      dirty = true;
      geometry.setDrawRange(0, 0);
    },
  };
}

// ---------- Parachute ----------

const GORE_COUNT = 8;
const CANOPY_SEGMENTS = 16;
const CANOPY_RINGS = 8;

/**
 * Flat hemispherical canopy with alternating gores, 8 shroud lines converging to
 * the group origin (the attachment point). The canopy rim sits 1.2 * diameter
 * above the origin and the dome opens toward -Y (its convex side faces +Y).
 */
export function buildParachute(diameter: number, color = 0xff5a4d): THREE.Group {
  const group = new THREE.Group();
  group.name = 'parachute';
  const r = diameter / 2;
  const rimY = 1.2 * diameter;

  // Canopy: upper hemisphere, non-indexed so each triangle can carry a gore colour.
  const geo = new THREE.SphereGeometry(r, CANOPY_SEGMENTS, CANOPY_RINGS, 0, Math.PI * 2, 0, Math.PI / 2)
    .toNonIndexed();
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c1 = new THREE.Color(color);
  const c2 = new THREE.Color(0xf4f1ea);
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const theta = Math.atan2(cz, cx);
    const gore = Math.floor(((theta + Math.PI) / (2 * Math.PI)) * GORE_COUNT) % 2;
    const c = gore === 0 ? c1 : c2;
    for (let k = 0; k < 3; k++) {
      colors[(t + k) * 3] = c.r;
      colors[(t + k) * 3 + 1] = c.g;
      colors[(t + k) * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const canopy = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      side: THREE.DoubleSide,
    }),
  );
  canopy.name = 'parachute-canopy';
  canopy.position.y = rimY;
  group.add(canopy);

  // Shrouds: from rim points down to the origin.
  const shroud = new Float32Array(GORE_COUNT * 2 * 3);
  for (let k = 0; k < GORE_COUNT; k++) {
    const a = (2 * Math.PI * k) / GORE_COUNT;
    const o = k * 6;
    shroud[o] = r * Math.cos(a);
    shroud[o + 1] = rimY;
    shroud[o + 2] = r * Math.sin(a);
    // origin end is (0, 0, 0): already zero
  }
  const shroudGeo = new THREE.BufferGeometry();
  shroudGeo.setAttribute('position', new THREE.BufferAttribute(shroud, 3));
  const shrouds = new THREE.LineSegments(
    shroudGeo,
    new THREE.LineBasicMaterial({ color: 0xe6e6e6 }),
  );
  shrouds.name = 'parachute-shrouds';
  group.add(shrouds);

  return group;
}

// ---------- Sky ----------

const SKY_HORIZON = new THREE.Color('#bfe3ff');
const SKY_ZENITH = new THREE.Color('#3d8fe0');
const SKY_DUSK = new THREE.Color('#ffa86b');

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uUp;
uniform float uOpacity;
varying vec3 vDir;
void main() {
  float h = dot(normalize(vDir), normalize(uUp));
  float t = smoothstep(0.0, 0.6, max(h, 0.0));
  vec3 col = mix(uHorizon, uZenith, t);
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}
`;

/**
 * Large inverted sphere with a flat vertical gradient along `up`. Fades out
 * between 15 km and 70 km altitude. Warms near the horizon at sunrise/sunset and
 * darkens at night (never fully black). Keep `mesh` centred on the camera.
 */
export function buildSky(): {
  mesh: THREE.Mesh;
  update(altitude: number, sunDir: THREE.Vector3, up: THREE.Vector3): void;
} {
  const geometry = new THREE.SphereGeometry(5e5, 32, 16);
  const material = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uHorizon: { value: SKY_HORIZON.clone() },
      uZenith: { value: SKY_ZENITH.clone() },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uOpacity: { value: 1 },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;

  const tmpUp = new THREE.Vector3();
  const tmpSun = new THREE.Vector3();
  const horizon = new THREE.Color();
  const zenith = new THREE.Color();

  return {
    mesh,
    update(altitude, sunDir, up) {
      tmpUp.copy(up);
      if (tmpUp.lengthSq() > 0) tmpUp.normalize();
      tmpSun.copy(sunDir);
      if (tmpSun.lengthSq() > 0) tmpSun.normalize();
      const sd = tmpSun.dot(tmpUp); // sun elevation sine

      const day = smoothstep(-0.15, 0.15, sd);
      const warmth = (1 - smoothstep(0, 0.25, Math.abs(sd))) * 0.65;
      const lum = 0.05 + 0.95 * day; // near-black at night, never zero

      horizon.copy(SKY_HORIZON).lerp(SKY_DUSK, warmth).multiplyScalar(lum);
      zenith.copy(SKY_ZENITH).lerp(SKY_DUSK, warmth * 0.25).multiplyScalar(lum);

      const u = material.uniforms;
      (u.uHorizon.value as THREE.Color).copy(horizon);
      (u.uZenith.value as THREE.Color).copy(zenith);
      (u.uUp.value as THREE.Vector3).copy(tmpUp);
      u.uOpacity.value = 1 - smoothstep(15_000, 70_000, altitude);
    },
  };
}

// ---------- Flat style ----------

/**
 * Replace MeshStandardMaterial with MeshLambertMaterial across a subtree, keeping
 * colour, emissive, transparency and side. Shared materials stay shared.
 */
export function applyFlatStyle(root: THREE.Object3D): void {
  const cache = new Map<THREE.Material, THREE.Material>();

  const convert = (m: THREE.Material): THREE.Material => {
    if (!(m instanceof THREE.MeshStandardMaterial)) return m;
    const cached = cache.get(m);
    if (cached) return cached;
    const lambert = new THREE.MeshLambertMaterial({
      color: m.color.clone(),
      emissive: m.emissive.clone(),
      emissiveIntensity: m.emissiveIntensity,
      transparent: m.transparent,
      opacity: m.opacity,
      side: m.side,
      depthWrite: m.depthWrite,
      flatShading: false,
    });
    lambert.name = m.name;
    cache.set(m, lambert);
    m.dispose();
    return lambert;
  };

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(convert);
    } else {
      mesh.material = convert(mesh.material);
    }
  });
}
