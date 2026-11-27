// Exhaust smoke for the mission view: a column of puffs along the flown path while the engines fire
// low in the atmosphere, plus the ground cloud that rolls out of the flame trench at liftoff.
//
// Stateless: everything is rebuilt from the flight record for the current mission time, so
// scrubbing backwards and forwards shows the same smoke. Puff positions are Earth-fixed (they drift
// slowly east with the wind) and stored relative to the first sample for float precision.
//
// Rendering: each puff is a camera-facing quad (billboard) shaded by a small procedural shader that
// gives a soft round falloff, a lumpy fbm density and a fake sun-side light. No textures are needed.

import * as THREE from 'three';
import type { FlightRecord } from '../mission/record';

const TRAIL_LIFE_S = 75;
const MAX_ALT_M = 32_000;
const GROUND_CLOUD_S = 7;
const GROUND_LIFE_S = 60;
/** Soft edges look smaller than hard spheres of the same size, so the quads are drawn a bit larger. */
const SPRITE_GAIN = 1.7;

export interface ExhaustTrail {
  /** Add to the rotating Earth group. */
  trail: THREE.InstancedMesh;
  /** Add to the pad group (pad-local frame: +X east, +Y up, +Z south). */
  groundCloud: THREE.InstancedMesh;
  setRecord(record: FlightRecord, vehicleRadius: number): void;
  /**
   * Rebuild the smoke for mission time t. `sunLit` is 0..1 (night..day). `sunDirWorld` is an optional
   * world-space unit vector pointing from the scene toward the sun, used for the sun-side highlight.
   */
  update(t: number, sunLit: number, sunDirWorld?: THREE.Vector3): void;
  dispose(): void;
}

function hash(i: number): number {
  const h = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return h - Math.floor(h);
}

const PUFF_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>

uniform vec3 uSunDir;
varying vec2 vLocal;
varying float vSeed;
varying vec3 vSunS;

void main() {
  mat4 im = mat4(1.0);
#ifdef USE_INSTANCING
  im = instanceMatrix;
#endif
  // Centre in world space; the Earth group's rotation is already in modelMatrix.
  vec3 centre = (modelMatrix * im * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  // Seed from the instance-local position so the look does not shimmer while the Earth turns.
  vec3 lp = im[3].xyz;
  float seed = fract(sin(dot(lp, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float ang = seed * 6.2831853 + fract(seed * 91.7) * 2.0;
  float ca = cos(ang), sa = sin(ang);
  vec2 r = vec2(ca * position.x - sa * position.y, sa * position.x + ca * position.y);

  // Camera axes in world space (rows of the view matrix).
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float sx = length(im[0].xyz) * ${SPRITE_GAIN.toFixed(2)};
  float sy = length(im[1].xyz) * ${SPRITE_GAIN.toFixed(2)};
  vec3 wpos = centre + camRight * (r.x * sx) + camUp * (r.y * sy);

  vec4 mvPosition = viewMatrix * vec4(wpos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Sun direction expressed in the billboard frame: (right, up, towards viewer).
  vec3 toCam = normalize(cameraPosition - centre);
  vec3 sd = normalize(uSunDir);
  vSunS = vec3(dot(sd, camRight), dot(sd, camUp), dot(sd, toCam));

  vLocal = r;
  vSeed = seed;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const PUFF_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

uniform float uSunLit;
varying vec2 vLocal;
varying float vSeed;
varying vec3 vSunS;

float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash2(i);
  float b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0));
  float d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Four octaves, normalised to about 0..1.
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int k = 0; k < 4; k++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v / 0.9375;
}

void main() {
  #include <logdepthbuf_fragment>
  float r2 = dot(vLocal, vLocal);
  float r = sqrt(r2);
  // Soft round mask: 1 at the centre, fading to 0 at the quad's inscribed circle.
  float mask = 1.0 - smoothstep(0.25, 1.0, r);
  // Lumpy cauliflower density, different for every sprite.
  float n = fbm(vLocal * 1.7 + vec2(vSeed * 31.0, vSeed * 17.0));
  float dens = clamp(mask * (0.85 + 0.6 * (n - 0.5)), 0.0, 1.0);
  float alpha = min(1.0, dens * 0.85);
  if (alpha < 0.003) discard;

  // Fake sphere normal in the billboard frame; the sun-facing side is brighter.
  vec3 nrm = vec3(vLocal, sqrt(max(0.0, 1.0 - min(r2, 1.0))));
  float diff = dot(nrm, normalize(vSunS));
  float wrap = clamp(diff * 0.5 + 0.5, 0.0, 1.0);
  float light = clamp((0.38 + 0.62 * wrap) * mix(0.82, 1.05, n), 0.0, 1.0);

  vec3 shadowTint = vec3(0.26, 0.28, 0.32);
  vec3 litTint = vec3(0.97, 0.96, 0.93);
  // Keep a floor so the smoke still reads at night rather than vanishing.
  vec3 col = mix(shadowTint, litTint, light) * (0.3 + 0.7 * uSunLit);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export function buildExhaustTrail(maxPuffs = 700): ExhaustTrail {
  // Unit quad, billboarded and shaded per instance by the puff shader.
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: PUFF_VERT,
    fragmentShader: PUFF_FRAG,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: new THREE.Vector3(0.5, 0.6, 0.6).normalize() },
        uSunLit: { value: 1 },
      },
    ]),
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const trail = new THREE.InstancedMesh(geo, mat, maxPuffs);
  trail.name = 'exhaust-trail';
  trail.frustumCulled = false;
  trail.count = 0;
  trail.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const groundMax = 320;
  const groundCloud = new THREE.InstancedMesh(geo, mat, groundMax);
  groundCloud.name = 'exhaust-ground-cloud';
  groundCloud.frustumCulled = false;
  groundCloud.count = 0;
  groundCloud.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  let rec: FlightRecord | null = null;
  let radius = 2;
  // Earth-fixed sample positions relative to the first sample, plus the local east and up there.
  let fixed: Float64Array = new Float64Array(0);
  let times: Float64Array = new Float64Array(0);
  let firing: Uint8Array = new Uint8Array(0);
  let alts: Float64Array = new Float64Array(0);
  const east = new THREE.Vector3();
  const up = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  let lastT = NaN;
  /** Record time the engines light; the ground cloud starts then, while the vehicle is still held. */
  let ignitionT = 0;

  function setRecord(record: FlightRecord, vehicleRadius: number): void {
    rec = record;
    radius = vehicleRadius;
    lastT = NaN;
    const n = record.samples.length;
    fixed = new Float64Array(n * 3);
    times = new Float64Array(n);
    firing = new Uint8Array(n);
    alts = new Float64Array(n);
    ignitionT = Math.min(0, record.samples.find((s) => s.thrust > 0)?.t ?? 0);
    if (n === 0) return;
    const a0 = record.earth?.angleAtLiftoff ?? 0;
    const rate = record.earth?.rate ?? 0;
    let ox = 0, oy = 0, oz = 0;
    for (let i = 0; i < n; i++) {
      const s = record.samples[i];
      const ang = -(a0 + rate * s.t);
      const c = Math.cos(ang), sn = Math.sin(ang);
      const x = s.pos[0] * c + s.pos[2] * sn, y = s.pos[1], z = -s.pos[0] * sn + s.pos[2] * c;
      if (i === 0) {
        ox = x; oy = y; oz = z;
        up.set(x, y, z).normalize();
        east.set(0, 1, 0).cross(up).normalize();
      }
      fixed[i * 3] = x - ox;
      fixed[i * 3 + 1] = y - oy;
      fixed[i * 3 + 2] = z - oz;
      times[i] = s.t;
      firing[i] = s.thrust > 0 ? 1 : 0;
      alts[i] = s.altitude;
    }
    trail.position.set(ox, oy, oz);
  }

  function update(t: number, sunLit: number, sunDirWorld?: THREE.Vector3): void {
    mat.uniforms.uSunLit.value = sunLit;
    if (sunDirWorld) mat.uniforms.uSunDir.value.copy(sunDirWorld);
    if (!rec || times.length === 0) {
      trail.count = groundCloud.count = 0;
      return;
    }
    if (t === lastT) return;
    lastT = t;
    let count = 0;
    const n = times.length;
    // Walk the samples that were emitted within the trail's life, oldest first.
    let i0 = 0;
    while (i0 < n && times[i0] < t - TRAIL_LIFE_S) i0++;
    const cap = trail.instanceMatrix.count;
    const emitSegment = (
      ax: number, ay: number, az: number, bx: number, by: number, bz: number,
      age: number, alt: number, idBase: number,
    ): void => {
      const seg = Math.hypot(bx - ax, by - ay, bz - az);
      const altK = 1 + alt / 6000;
      const size = (radius * 2.6 + 2.4 * Math.pow(age, 0.8)) * altK;
      const k = Math.max(1, Math.min(14, Math.ceil(seg / (size * 0.55))));
      for (let j = 0; j < k && count < cap; j++) {
        const f = (j + 0.5) / k;
        const id = idBase + j;
        const jitter = size * 0.45;
        // Wind: drift east, a little more higher up.
        const drift = age * (2.5 + alt / 2500);
        p.set(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f)
          .addScaledVector(east, drift + (hash(id) - 0.5) * jitter)
          .addScaledVector(up, (hash(id + 7) - 0.5) * jitter);
        // Puffs shrink to nothing at the end of their life (instances have no opacity).
        const fade = 1 - Math.pow(Math.max(0, age / TRAIL_LIFE_S), 3);
        // The newest puffs start small, right behind the nozzles.
        const young = Math.min(1, 0.45 + age * 0.6);
        const s = size * fade * young * (0.8 + 0.4 * hash(id + 3));
        sc.set(s, s, s);
        trail.setMatrixAt(count++, m.compose(p, q, sc));
      }
    };
    let last = -1;
    for (let i = Math.max(i0, 1); i < n && times[i] <= t && count < cap; i++) {
      last = i;
      if (!firing[i] || alts[i] > MAX_ALT_M) continue;
      emitSegment(
        fixed[i * 3 - 3], fixed[i * 3 - 2], fixed[i * 3 - 1],
        fixed[i * 3], fixed[i * 3 + 1], fixed[i * 3 + 2],
        t - times[i], alts[i], i * 16,
      );
    }
    // Close the gap between the last sample and where the vehicle is now.
    if (last >= 0 && last + 1 < n && firing[last + 1] && alts[last] <= MAX_ALT_M) {
      const f = (t - times[last]) / Math.max(1e-6, times[last + 1] - times[last]);
      const ax = fixed[last * 3], ay = fixed[last * 3 + 1], az = fixed[last * 3 + 2];
      const bx = ax + (fixed[last * 3 + 3] - ax) * f;
      const by = ay + (fixed[last * 3 + 4] - ay) * f;
      const bz = az + (fixed[last * 3 + 5] - az) * f;
      emitSegment(ax, ay, az, bx, by, bz, 0, alts[last], (last + 1) * 16 + 8);
    }
    trail.count = count;
    trail.instanceMatrix.needsUpdate = true;

    // Ground cloud: billows out north and south along the flame trench for the first seconds.
    let g = 0;
    const burning = t - ignitionT;
    if (burning > 0 && burning < GROUND_CLOUD_S + GROUND_LIFE_S) {
      const emitEnd = Math.min(burning, GROUND_CLOUD_S);
      for (let e = 0; e < emitEnd && g < groundMax - 6; e += 0.15) {
        const age = burning - e;
        if (age > GROUND_LIFE_S) continue;
        for (const dir of [1, -1]) {
          for (let j = 0; j < 3; j++) {
            const id = Math.round(e * 100) * 8 + (dir > 0 ? 0 : 4) + j;
            // Rolls out of the trench exits fast, then slows and spreads sideways and up.
            const out = 10 + 85 * Math.pow(Math.min(age, 30), 0.5) * (0.55 + 0.7 * hash(id));
            const side = (hash(id + 11) - 0.5) * (8 + 14 * Math.pow(age, 0.8));
            const s = (3 + 4 * Math.pow(age, 0.6)) * (0.7 + 0.6 * hash(id + 5)) * (1 - Math.pow(age / GROUND_LIFE_S, 3));
            p.set(side + age * 2.5, -2 + s * 0.6 + age * 0.6 * hash(id + 9), dir * out);
            sc.set(s * 1.35, s, s * 1.35);
            groundCloud.setMatrixAt(g++, m.compose(p, q, sc));
          }
        }
      }
    }
    groundCloud.count = g;
    groundCloud.instanceMatrix.needsUpdate = true;
  }

  function dispose(): void {
    trail.dispose();
    groundCloud.dispose();
    geo.dispose();
    mat.dispose();
  }

  return { trail, groundCloud, setRecord, update, dispose };
}
