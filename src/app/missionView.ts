// 3D viewport for Mission mode.
//
// World: a textured, normal-mapped globe with night lights, clouds and a scattering atmosphere;
// a 300 km procedural terrain patch around the pad (coast, lagoon, forest, hills, spaceport
// buildings) that blends into the globe; a sun-aware sky; the real Sun, Moon and planets for the
// flight date. Vehicle: the staged launcher with livery, bell nozzles, glowing plumes, a plume
// light and sun shadows near the ground.
//
// Camera: one continuous zoom from a few metres off the pad out past Neptune, plus presets that
// fly smoothly between framings: Pad (ground camera), Chase and Track (follow the rocket close
// and from afar), Earth (globe view that follows the rocket around the planet) and Solar.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadSharedTexture } from '../render/textureCache';
import type { Vec3 } from '../types';
import { appToEci } from '../mission/adapter';
import type { VehicleSpec } from '../mission/engine';
import { coastPathCapacity, coastPathInto } from '../mission/predict';
import type { FlightRecord } from '../mission/record';
import { snapshotAt } from '../mission/snapshot';
import type { MissionDef, MissionPayload } from '../mission/vehicles';
import { buildLaunchComplex, disposeLaunchComplex } from '../render/launchComplex';
import {
  buildLauncherMesh,
  disposeLauncher,
  type LauncherMesh,
  type LauncherSpec,
} from '../render/launcherMesh';
import {
  buildLauncherPlumes,
  disposeLauncherPlumes,
  setPlumeTime,
  updatePlumes,
  type LauncherPlumes,
} from '../render/launcherPlume';
import { updateLauncherStaging, type SeparationState } from '../render/launcherStaging';
import { buildOrbitLine, orbitPoints, type OrbitElementsInput } from '../render/orbitLine';
import { buildExhaustTrail } from '../render/exhaustTrail';
import { buildPadTerrain, terrainHeightAt, TERRAIN_RADIUS_M, type PadTerrain } from '../render/padTerrain';
import { buildMissionSolar, ECLIPTIC_NORTH_APP, eclipticToApp, type MissionSolar } from '../render/missionSolar';
import { ECLIPTIC_TO_WORLD } from '../world/ephemeris';
import { buildStarBuffers } from '../world/skyData';

export type MissionCameraMode = 'pad' | 'chase' | 'track' | 'earth' | 'solar';

export const MISSION_CAMERAS: { mode: MissionCameraMode; label: string; hint: string }[] = [
  { mode: 'pad', label: 'Pad', hint: 'Fixed camera on the ground beside the pad' },
  { mode: 'chase', label: 'Chase', hint: 'Close behind the rocket' },
  { mode: 'track', label: 'Track', hint: 'Long-range tracking camera following the rocket' },
  { mode: 'earth', label: 'Earth', hint: 'Whole planet, turning to keep the rocket in view' },
  { mode: 'solar', label: 'Solar', hint: 'The Sun, planets and their orbits' },
];

export interface MissionView {
  setRecord(record: FlightRecord, def: MissionDef): void;
  setTime(t: number): void;
  /** A live flight has added samples to the record given to setRecord: redraw its flown path. */
  refreshPath(): void;
  setCamera(mode: MissionCameraMode): void;
  setEnabled(on: boolean): void;
  resize(width: number, height: number): void;
  render(renderer: THREE.WebGLRenderer): void;
  /** True while a camera move or the sea needs frames even with the flight paused. */
  isAnimating(): boolean;
  /** Camera distance from what it is looking at, metres. */
  viewDistance(): number;
  /** Detail tier chosen when the view was created. */
  readonly quality: MissionQuality;
  dispose(): void;
}

export type MissionQuality = 'high' | 'low';

/**
 * Detail tier, decided once per view. `localStorage['astra-quality']` ('high' | 'low') forces it;
 * otherwise touch-first or small devices (<= 4 cores or <= 4 GB reported memory) get 'low'.
 */
function chooseQuality(): MissionQuality {
  try {
    const forced = localStorage.getItem('astra-quality');
    if (forced === 'high' || forced === 'low') return forced;
  } catch {
    // Storage can be unavailable (private mode, sandboxed frames): fall through to detection.
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
    return 'low';
  }
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const cores = nav?.hardwareConcurrency ?? 0;
  const memory = (nav as { deviceMemory?: number } | undefined)?.deviceMemory ?? Infinity;
  if ((cores > 0 && cores <= 4) || memory <= 4) return 'low';
  return 'high';
}

const RE_EQ = 6_378_137;
const RE_POLAR = 6_356_752;
const E2 = 1 - (RE_POLAR * RE_POLAR) / (RE_EQ * RE_EQ);
// The globe is tessellated 256 x 128 (chord sag <= ~480 m): sink it under the terrain patch.
const EARTH_SINK_M = 650;
const DEG_TO_RAD = Math.PI / 180;
const DEFAULT_FOV = 45;
const AU = 149_597_870_700;
const FAR = 6e13;
const MAX_VIEW_DIST = 3e13;
const TRANSITION_S = 1.6;

// ---------- Pure helpers (tested without WebGL) ----------

/**
 * Convert geodetic latitude (deg), longitude (deg), and Earth rotation angle (rad)
 * into an app-frame inertial position (Y-up, lon 0 on +X and 90 E on -Z at angle 0).
 */
export function latLonToApp(
  latDeg: number,
  lonDeg: number,
  earthAngleRad: number,
  radius = RE_EQ,
): Vec3 {
  const lat = latDeg * DEG_TO_RAD;
  const lon = lonDeg * DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = radius / Math.sqrt(1 - E2 * sinLat * sinLat);
  const xf = N * cosLat * Math.cos(lon);
  const yf = N * (1 - E2) * sinLat;
  const zf = -N * cosLat * Math.sin(lon);

  const c = Math.cos(earthAngleRad);
  const s = Math.sin(earthAngleRad);
  return [xf * c + zf * s, yf, -xf * s + zf * c];
}

/** Build a LauncherSpec and per-stage solid-propellant flags from a mission VehicleSpec. */
export function vehicleToLauncherSpec(v: VehicleSpec): {
  spec: LauncherSpec;
  isSolid: boolean[];
} {
  const stages = v.stages.map((st) => ({
    name: st.name,
    length: st.length,
    radius: st.radius,
    engineCount: st.engineCount,
    ...(st.parallel ? { parallel: { ...st.parallel } } : {}),
  }));
  const isSolid = v.stages.map((st) => st.engine.thrustCurve !== undefined);
  return {
    spec: {
      name: v.name,
      stages,
      payload: { ...v.payload },
      ...(v.fairing ? { fairing: { ...v.fairing } } : {}),
    },
    isSolid,
  };
}

/** Compute separation ages (seconds since separation, or null while attached) at mission time t. */
export function separationAges(record: FlightRecord, t: number): SeparationState {
  const stages = (record.stageSeparation ?? []).map((sep) =>
    sep !== null && t >= sep ? t - sep : null,
  );
  const fSep = record.fairingSeparation;
  const fairing = fSep !== null && fSep !== undefined && t >= fSep ? t - fSep : null;
  return { stages, fairing };
}

/** Allocation-free separationAges: fills and returns `out`, reusing its stages array. */
function separationAgesInto(record: FlightRecord, t: number, out: SeparationState): SeparationState {
  const seps = record.stageSeparation;
  const n = seps ? seps.length : 0;
  out.stages.length = n;
  for (let i = 0; i < n; i++) {
    const sep = seps![i];
    out.stages[i] = sep !== null && t >= sep ? t - sep : null;
  }
  const fSep = record.fairingSeparation;
  out.fairing = fSep !== null && fSep !== undefined && t >= fSep ? t - fSep : null;
  return out;
}

const COAST_HORIZON_S = 1800;
const COAST_STEP_S = 30;
const COAST_CAPACITY = coastPathCapacity(COAST_HORIZON_S, COAST_STEP_S);
const COAST_MIN_INTERVAL_MS = 500;
const EMPTY_THROTTLES: number[] = [];

/**
 * Last mission time up to which an engines-off prediction made at `t0` stays valid: the end of the run
 * of zero-thrust samples that brackets `t0`, cut short by any stage, fairing or payload separation after
 * `t0`. Returns -Infinity when thrust is (or may be) on at `t0`, so the caller recomputes.
 */
export function coastValidUntil(record: FlightRecord, t0: number): number {
  const samples = record.samples;
  const n = samples.length;
  if (n === 0 || !(t0 >= samples[0].t)) return -Infinity;
  // Last sample with t <= t0.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= t0) lo = mid;
    else hi = mid - 1;
  }
  if (!(samples[lo].thrust === 0)) return -Infinity;
  // Interpolation between two zero-thrust samples is zero, so the run ends at the last zero sample.
  let k = lo;
  while (k + 1 < n && samples[k + 1].thrust === 0) k++;
  let until = k === n - 1 ? Infinity : samples[k].t;
  const events: (number | null | undefined)[] = [...(record.stageSeparation ?? []), record.fairingSeparation, record.payloadSeparation];
  for (const e of events) {
    if (e !== null && e !== undefined && e > t0 && e < until) until = e;
  }
  return until;
}

/**
 * Build Earth-fixed flown-path vertices relative to the first sample so 32-bit floats
 * retain centimetre precision. Each sample is rotated about Y by -earthAngle(s.t).
 */
export function buildFlownPathPoints(record: FlightRecord): {
  origin: Vec3;
  offsets: Float32Array;
  times: Float64Array;
} {
  const n = record.samples.length;
  if (n === 0) {
    return { origin: [0, 0, 0], offsets: new Float32Array(0), times: new Float64Array(0) };
  }
  const a0 = record.earth?.angleAtLiftoff ?? 0;
  const rate = record.earth?.rate ?? 0;

  const toFixed = (pos: Vec3, t: number): Vec3 => {
    const angle = -(a0 + rate * t);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [pos[0] * c + pos[2] * s, pos[1], -pos[0] * s + pos[2] * c];
  };

  const origin = toFixed(record.samples[0].pos, record.samples[0].t);
  const offsets = new Float32Array(n * 3);
  const times = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const sample = record.samples[i];
    const p = toFixed(sample.pos, sample.t);
    offsets[i * 3] = p[0] - origin[0];
    offsets[i * 3 + 1] = p[1] - origin[1];
    offsets[i * 3 + 2] = p[2] - origin[2];
    times[i] = sample.t;
  }

  return { origin, offsets, times };
}

/**
 * Compute classical Keplerian elements (in Z-up ECI, matching orbitPoints) from an
 * app-frame position and velocity.
 */
export function elementsFromAppState(
  pos: Vec3,
  vel: Vec3,
  mu = 3.986004418e14,
): OrbitElementsInput & { perigeeAltitude: number; apogeeAltitude: number } {
  const r = appToEci(pos);
  const v = appToEci(vel);
  const rMag = Math.hypot(r[0], r[1], r[2]);
  const vMagSq = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const rDotV = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];

  // Specific angular momentum h = r x v
  const hx = r[1] * v[2] - r[2] * v[1];
  const hy = r[2] * v[0] - r[0] * v[2];
  const hz = r[0] * v[1] - r[1] * v[0];
  const hMag = Math.hypot(hx, hy, hz);

  // Node vector n = k x h = [-hy, hx, 0]
  const nx = -hy;
  const ny = hx;
  const nMag = Math.hypot(nx, ny);

  // Eccentricity vector
  const c1 = vMagSq - mu / rMag;
  const ex = (c1 * r[0] - rDotV * v[0]) / mu;
  const ey = (c1 * r[1] - rDotV * v[1]) / mu;
  const ez = (c1 * r[2] - rDotV * v[2]) / mu;
  const e = Math.hypot(ex, ey, ez);

  const eps = 0.5 * vMagSq - mu / rMag;
  const a = -mu / (2 * eps);
  const inc = hMag > 0 ? Math.acos(Math.max(-1, Math.min(1, hz / hMag))) : 0;

  let raan = 0;
  if (nMag > 1e-12) {
    raan = Math.atan2(ny, nx);
    if (raan < 0) raan += 2 * Math.PI;
  }

  let argp = 0;
  if (nMag > 1e-12 && e > 1e-12) {
    const cosW = (nx * ex + ny * ey) / (nMag * e);
    argp = Math.acos(Math.max(-1, Math.min(1, cosW)));
    if (ez < 0) argp = 2 * Math.PI - argp;
  } else if (e > 1e-12) {
    argp = Math.atan2(ey, ex);
    if (argp < 0) argp += 2 * Math.PI;
  }

  const rp = a * (1 - e);
  const ra = a * (1 + e);
  return {
    a,
    e,
    i: inc,
    raan,
    argp,
    perigeeAltitude: rp - RE_EQ,
    apogeeAltitude: ra - RE_EQ,
  };
}

/**
 * Redraw the payload on top of the launcher to look like what the mission carries: a flat
 * stack of satellites, or one boxy satellite with its antenna folded against it. The outline
 * (height, radius, position) stays what the vehicle spec says.
 */
export function stylePayload(mesh: LauncherMesh, pay: MissionPayload | undefined): void {
  if (!pay || pay.look === 'spacecraft') return;
  const old = mesh.payload.children[0];
  if (!(old instanceof THREE.Mesh)) return;
  const box = new THREE.Box3().setFromObject(old);
  const height = box.max.y - box.min.y;
  const radius = (box.max.x - box.min.x) / 2;
  const midY = old.position.y;
  mesh.payload.remove(old);
  old.geometry.dispose();
  (old.material as THREE.Material).dispose();

  const mat = (color: number, metalness = 0.3) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness, flatShading: true });
  if (pay.look === 'stack') {
    const n = Math.max(1, Math.min(pay.count ?? 20, 40));
    const pitch = height / n;
    // One shared box geometry, drawn as two instanced meshes: even plates light, odd plates dark.
    const plateGeom = new THREE.BoxGeometry(1.5 * radius, pitch * 0.72, 1.05 * radius);
    const tmp = new THREE.Matrix4();
    for (let parity = 0; parity < 2; parity++) {
      const count = Math.floor((n - parity + 1) / 2);
      if (count === 0) continue;
      const plates = new THREE.InstancedMesh(plateGeom, mat(parity ? 0x3a4250 : 0xc9cdd3), count);
      for (let k = 0; k < count; k++) {
        const i = 2 * k + parity;
        tmp.makeTranslation(0, midY - height / 2 + (i + 0.5) * pitch, 0);
        plates.setMatrixAt(k, tmp);
      }
      plates.instanceMatrix.needsUpdate = true;
      mesh.payload.add(plates);
    }
    return;
  }
  const bus = new THREE.Mesh(new THREE.BoxGeometry(1.1 * radius, 0.85 * height, 1.1 * radius), mat(0xd4a438, 0.45));
  bus.position.y = midY;
  const antenna = new THREE.Mesh(new THREE.BoxGeometry(1.3 * radius, 0.8 * height, 0.06 * radius), mat(0x2b3440));
  antenna.position.set(0, midY, 0.6 * radius);
  const panelA = new THREE.Mesh(new THREE.BoxGeometry(0.05 * radius, 0.75 * height, 1.0 * radius), mat(0x1b2a55, 0.6));
  panelA.position.set(0.6 * radius, midY, 0);
  const panelB = panelA.clone();
  panelB.position.x = -0.6 * radius;
  mesh.payload.add(bus, antenna, panelA, panelB);
}


// ---------- Asset & shader helpers ----------

function assetsEnabled(): boolean {
  const env = (import.meta as { env?: { MODE?: string } }).env;
  return typeof document !== 'undefined' && typeof fetch === 'function' && env?.MODE !== 'test';
}

function assetUrl(file: string): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  return `${base}assets/space/${file}`;
}

function loadSpaceTexture(file: string, onLoad: (tex: THREE.Texture) => void, srgb = true): void {
  if (!assetsEnabled()) return;
  loadSharedTexture(assetUrl(file), onLoad, srgb ? {} : { colorSpace: THREE.NoColorSpace });
}

function loadJson(file: string, onLoad: (data: unknown) => void): void {
  if (!assetsEnabled()) return;
  fetch(assetUrl(file))
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d) onLoad(d);
    })
    .catch(() => {});
}

const LOGDEPTH = {
  vp: '#include <common>\n#include <logdepthbuf_pars_vertex>',
  v: '#include <logdepthbuf_vertex>',
  fp: '#include <common>\n#include <logdepthbuf_pars_fragment>',
  f: '#include <logdepthbuf_fragment>',
};

function radialDot(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(255 * Math.pow(Math.max(0, 1 - r), 1.8));
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** Sky dome drawn first, behind everything: haze, blue, sunset glow and night, all from the Sun's elevation. */
function makeSkyDome(): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uK: { value: 1 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(mat3(modelMatrix) * position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uUp;
      uniform vec3 uSun;
      uniform float uK;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = dot(d, uUp);
        float se = dot(uSun, uUp);
        float day = smoothstep(-0.18, 0.10, se);
        float t = clamp(h, 0.0, 1.0);
        vec3 zen = vec3(0.07, 0.24, 0.60);
        vec3 mid = vec3(0.27, 0.50, 0.85);
        vec3 haze = vec3(0.76, 0.85, 0.95);
        vec3 col = mix(haze, mid, smoothstep(0.0, 0.2, t));
        col = mix(col, zen, smoothstep(0.15, 0.9, t));
        vec3 night = mix(vec3(0.04, 0.055, 0.10), vec3(0.006, 0.01, 0.025), smoothstep(0.0, 0.5, t));
        col = mix(night, col, day);
        float cs = max(dot(d, uSun), 0.0);
        // Sunrise / sunset: warm band toward the Sun, dimmer pinkish sky elsewhere.
        float sunset = smoothstep(-0.22, 0.0, se) * (1.0 - smoothstep(0.03, 0.38, se));
        col = mix(col, col * vec3(1.0, 0.8, 0.78), sunset * (1.0 - t) * 0.7);
        col += vec3(1.0, 0.46, 0.16) * sunset * pow(cs, 3.0) * pow(1.0 - t, 2.5) * 1.3;
        col += vec3(0.9, 0.35, 0.45) * sunset * pow(1.0 - t, 6.0) * 0.18;
        // Forward scattering around the Sun.
        float up = smoothstep(-0.08, 0.02, se);
        col += vec3(1.0, 0.9, 0.72) * (pow(cs, 12.0) * 0.18 + pow(cs, 120.0) * 0.55) * up;
        if (h < 0.0) col = mix(col, haze * 0.38 * day + night * 0.6, smoothstep(0.0, -0.1, h));
        // Thin air: the zenith goes dark before the horizon does.
        float k = uK * mix(1.0, uK, t);
        gl_FragColor = vec4(col * k, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), material);
  mesh.name = 'mission-sky';
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return { mesh, material };
}

/**
 * Atmosphere shell seen from space: for each view ray, glow by how deep its closest approach to
 * the planet dips into the air, coloured blue on the day side and orange at the terminator.
 */
function makeAtmosphere(radius: number, seg: { w: number; h: number }): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uRe: { value: RE_EQ },
      uRa: { value: radius },
      uOpacity: { value: 0 },
    },
    vertexShader: `${LOGDEPTH.vp}
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH.v}
      }`,
    fragmentShader: `${LOGDEPTH.fp}
      uniform vec3 uCenter;
      uniform vec3 uSun;
      uniform float uRe;
      uniform float uRa;
      uniform float uOpacity;
      varying vec3 vWorld;
      void main() {
        ${LOGDEPTH.f}
        vec3 rd = normalize(vWorld - cameraPosition);
        vec3 oc = cameraPosition - uCenter;
        float b = dot(oc, rd);
        vec3 closest = oc + rd * max(-b, 0.0);
        float d = length(closest);
        float h = clamp((d - uRe) / (uRa - uRe), 0.0, 1.0);
        float dens = exp(-h * 5.5) * (1.0 - smoothstep(0.85, 1.0, h));
        float mu = dot(normalize(closest), uSun);
        float lit = smoothstep(-0.28, 0.2, mu);
        vec3 col = mix(vec3(1.0, 0.42, 0.18), vec3(0.32, 0.58, 1.0), smoothstep(-0.05, 0.3, mu));
        float a = dens * lit * uOpacity;
        gl_FragColor = vec4(col * a * 1.6, a);
      }`,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, seg.w, seg.h), material);
  mesh.name = 'earth-atmosphere';
  mesh.frustumCulled = false;
  return { mesh, material };
}

/** Fallback star field (until the catalogue arrives): Fibonacci sphere, varied brightness. */
function fallbackStars(count: number, radius: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = ((i * 0.61803398875) % 1) * 2 - 1;
    const phi = i * 2.399963229728653;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    positions[i * 3] = radius * s * Math.cos(phi);
    positions[i * 3 + 1] = radius * u;
    positions[i * 3 + 2] = radius * s * Math.sin(phi);
    const b = 0.25 + 0.75 * Math.pow(((i * 0.7548776662) % 1), 3);
    colors[i * 3] = b;
    colors[i * 3 + 1] = b;
    colors[i * 3 + 2] = b * 1.05;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Rotation from the sky-catalogue "sim world" frame (skyData.ts) into the mission app frame. */
function catalogueToAppQuaternion(): THREE.Quaternion {
  const E = ECLIPTIC_TO_WORLD;
  // ecliptic = E^T * world, so world basis vector i maps to ecliptic row i of E.
  const cols = [0, 1, 2].map((i) => eclipticToApp([E[i][0], E[i][1], E[i][2]]));
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...cols[0]),
    new THREE.Vector3(...cols[1]),
    new THREE.Vector3(...cols[2]),
  );
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function rotateYVec(v: Vec3, angleRad: number): THREE.Vector3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return new THREE.Vector3(v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- MissionView implementation ----------

type TargetKind = 'rocket' | 'earth' | 'sun';

interface Transition {
  start: number;
  duration: number;
  fromKind: TargetKind;
  fromOffset: THREE.Vector3;
  fromUp: THREE.Vector3;
  fromFov: number;
  toMode: MissionCameraMode;
}

export function createMissionView(domElement: HTMLElement): MissionView {
  const quality = chooseQuality();
  const high = quality === 'high';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const aspect =
    typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 16 / 9;
  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, aspect, 0.3, FAR);
  camera.position.set(0, 20, 110);

  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enabled = false;
  controls.enablePan = false;
  controls.zoomSpeed = 4.5;
  controls.rotateSpeed = 0.6;
  controls.minDistance = 6;
  controls.maxDistance = MAX_VIEW_DIST;
  const controlsInternals = controls as unknown as { _quat: THREE.Quaternion; _quatInverse: THREE.Quaternion };

  // ---- Lights ----
  const sunLight = new THREE.DirectionalLight(0xffffff, 3);
  sunLight.castShadow = high;
  sunLight.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
  const sc = sunLight.shadow.camera as THREE.OrthographicCamera;
  sc.left = -110;
  sc.right = 110;
  sc.top = 110;
  sc.bottom = -110;
  sc.near = 10;
  sc.far = 4000;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.06;
  scene.add(sunLight, sunLight.target);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4f4a3c, 0.6);
  const ambient = new THREE.AmbientLight(0x8091b5, 0.05);
  scene.add(hemi, ambient);
  const plumeLight = new THREE.PointLight(0xffa04a, 0, 0, 2);
  plumeLight.name = 'plume-light';

  // ---- Background: sky dome and stars, both centred on the camera ----
  const { mesh: skyDome, material: skyMat } = makeSkyDome();
  scene.add(skyDome);

  const dotTex = radialDot();
  const starsGroup = new THREE.Group();
  starsGroup.name = 'mission-stars';
  starsGroup.quaternion.copy(catalogueToAppQuaternion());
  const starMat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 1.4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });
  const brightStarMat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 3.6,
    map: dotTex,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });
  const STAR_R = 400;
  const faintStars = new THREE.Points(fallbackStars(2400, STAR_R), starMat);
  const brightStars = new THREE.Points(new THREE.BufferGeometry(), brightStarMat);
  for (const p of [faintStars, brightStars]) {
    p.frustumCulled = false;
    p.renderOrder = -9;
    starsGroup.add(p);
  }
  scene.add(starsGroup);
  loadJson('stars.6.json', (data) => {
    const { faint, bright } = buildStarBuffers(data as Parameters<typeof buildStarBuffers>[0], STAR_R);
    if (faint.count + bright.count < 100) return;
    const set = (pts: THREE.Points, pos: Float32Array, col: Float32Array): void => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      pts.geometry.dispose();
      pts.geometry = g;
    };
    set(faintStars, faint.positions, faint.colors);
    set(brightStars, bright.positions, bright.colors);
  });

  // ---- Floating-origin world (Earth-centred, positioned at -vehiclePos each frame) ----
  const worldGroup = new THREE.Group();
  worldGroup.name = 'mission-world';
  scene.add(worldGroup);

  const solar: MissionSolar = buildMissionSolar();
  worldGroup.add(solar.group);

  // Rotating Earth.
  const earthGroup = new THREE.Group();
  earthGroup.name = 'mission-earth';
  worldGroup.add(earthGroup);

  const sunDirWorld = new THREE.Vector3(1, 0, 0);
  const sunView = { value: new THREE.Vector3(1, 0, 0) };
  const rimStrength = { value: 0 };
  const earthGeo = new THREE.SphereGeometry(RE_EQ - EARTH_SINK_M, high ? 256 : 160, high ? 128 : 80);
  const earthMat = new THREE.MeshPhongMaterial({ color: 0x2f6fb5, specular: 0x000000, shininess: 16 });
  earthMat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirView = sunView;
    shader.uniforms.uRim = rimStrength;
    shader.fragmentShader =
      'uniform vec3 uSunDirView;\nuniform float uRim;\n' +
      shader.fragmentShader
        .replace(
          '#include <emissivemap_fragment>',
          `#ifdef USE_EMISSIVEMAP
            vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
            float nightF = smoothstep( 0.05, -0.2, dot( normalize( vNormal ), uSunDirView ) );
            // The lights map has a faint grey land glow: keep only the cities.
            totalEmissiveRadiance *= max( emissiveColor.rgb - 0.07, 0.0 ) * 1.2 * nightF;
          #endif`,
        )
        .replace(
          '#include <tonemapping_fragment>',
          `{
            vec3 nV = normalize( vNormal );
            float ndl = dot( nV, uSunDirView );
            float rim = pow( 1.0 - max( dot( nV, normalize( vViewPosition ) ), 0.0 ), 2.4 );
            float lit = smoothstep( -0.15, 0.35, ndl );
            float dusk = smoothstep( -0.3, 0.0, ndl ) * ( 1.0 - smoothstep( 0.0, 0.3, ndl ) );
            gl_FragColor.rgb += ( vec3( 0.30, 0.55, 1.0 ) * lit + vec3( 1.0, 0.45, 0.2 ) * dusk * 0.6 ) * rim * 0.6 * uRim;
          }
          #include <tonemapping_fragment>`,
        );
  };
  const earthMesh = new THREE.Mesh(earthGeo, earthMat);
  earthMesh.name = 'earth-sphere';
  earthMesh.scale.y = RE_POLAR / RE_EQ;
  earthMesh.onBeforeRender = (_r, _s, cam) => {
    sunView.value.copy(sunDirWorld).transformDirection(cam.matrixWorldInverse);
  };
  earthGroup.add(earthMesh);

  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(RE_EQ + 9_000, high ? 192 : 128, high ? 96 : 64), cloudMat);
  clouds.name = 'earth-clouds';
  clouds.scale.y = RE_POLAR / RE_EQ;
  clouds.visible = false;
  clouds.renderOrder = 2;
  earthGroup.add(clouds);

  const { mesh: atmosphere, material: atmoMat } = makeAtmosphere(RE_EQ + 110_000, high ? { w: 128, h: 64 } : { w: 96, h: 48 });
  atmosphere.visible = false;
  earthGroup.add(atmosphere);

  let dayImage: (CanvasImageSource & { width: number; height: number }) | null = null;
  loadSpaceTexture('earth_atmos_2048.jpg', (tex) => {
    earthMat.map = tex;
    earthMat.color.setHex(0xffffff);
    earthMat.needsUpdate = true;
    dayImage = tex.image as CanvasImageSource & { width: number; height: number };
    blendTerrainWithGlobe();
    loadSpaceTexture('earth_specular_2048.jpg', (t) => {
      earthMat.specularMap = t;
      earthMat.specular.set(0x262626);
      earthMat.shininess = 30;
      earthMat.needsUpdate = true;
    }, false);
    loadSpaceTexture('earth_normal_2048.jpg', (t) => {
      earthMat.normalMap = t;
      earthMat.normalScale.set(0.85, 0.85);
      earthMat.needsUpdate = true;
    }, false);
    loadSpaceTexture('earth_lights_2048.png', (t) => {
      earthMat.emissiveMap = t;
      earthMat.emissive.setRGB(1.0, 0.8, 0.55);
      earthMat.emissiveIntensity = 1.6;
      earthMat.needsUpdate = true;
    });
    loadSpaceTexture('earth_clouds_1024.png', (t) => {
      cloudMat.map = t;
      cloudMat.alphaMap = t;
      cloudMat.needsUpdate = true;
    });
  });

  // Pad anchor (terrain, launch complex, flood lights) inside the rotating Earth.
  const padGroup = new THREE.Group();
  padGroup.name = 'mission-pad-group';
  earthGroup.add(padGroup);
  let terrain: PadTerrain | null = null;
  const floodLight = new THREE.PointLight(0xfff0d8, 0, 0, 2);
  floodLight.position.set(-60, 45, 50);
  padGroup.add(floodLight);
  // The second flood is a desktop extra: phones keep one.
  const floodLight2 = high ? new THREE.PointLight(0xfff0d8, 0, 0, 2) : null;
  if (floodLight2) {
    floodLight2.position.set(55, 40, -55);
    padGroup.add(floodLight2);
  }
  let blendedPadKey = '';

  function blendTerrainWithGlobe(): void {
    if (!terrain || !dayImage) return;
    padGroup.updateMatrix();
    const key = padGroup.matrix.elements.map((v) => v.toFixed(1)).join(',');
    if (key === blendedPadKey) return;
    blendedPadKey = key;
    terrain.blendGlobe(dayImage, padGroup.matrix);
  }

  const exhaust = buildExhaustTrail(high ? 700 : 300);
  earthGroup.add(exhaust.trail);
  padGroup.add(exhaust.groundCloud);

  // Aerial perspective: distant ground fades into the horizon haze while low in the air.
  const fog = new THREE.FogExp2(0xbfd4ea, 0);
  scene.fog = fog;

  // Breakup fireball at scene origin (hidden except at breakup end).
  const fireballGeo = new THREE.SphereGeometry(1, 24, 16);
  const fireballMat = new THREE.MeshBasicMaterial({ color: 0xff7b29, transparent: true, opacity: 0.9 });
  const fireball = new THREE.Mesh(fireballGeo, fireballMat);
  fireball.name = 'breakup-fireball';
  fireball.visible = false;
  scene.add(fireball);

  let record: FlightRecord | null = null;
  let launcherSpec: LauncherSpec | null = null;
  let launcherMesh: LauncherMesh | null = null;
  let launcherPlumes: LauncherPlumes | null = null;
  let launchComplex: THREE.Group | null = null;

  let flownLine: THREE.Line | null = null;
  let flownTimes: Float64Array = new Float64Array(0);
  let coastLine: THREE.Line | null = null;
  let lastCoastT = NaN;
  let lastCoastMs = -Infinity;
  let coastPositions: THREE.BufferAttribute | null = null;
  let coastDistances: THREE.BufferAttribute = new THREE.BufferAttribute(new Float32Array(0), 1);
  const coastTimes = new Float64Array(COAST_CAPACITY);
  const coastOrigin: Vec3 = [0, 0, 0];
  let coastCount = 0;
  let coastValidT = -Infinity;
  let orbitLine: THREE.Line | null = null;

  const iipGeo = new THREE.RingGeometry(60_000, 120_000, 32);
  iipGeo.rotateX(-Math.PI / 2);
  const iipMat = new THREE.MeshBasicMaterial({ color: 0xff5d6c, side: THREE.DoubleSide, depthTest: false });
  const iipRing = new THREE.Mesh(iipGeo, iipMat);
  iipRing.name = 'impact-marker';
  iipRing.renderOrder = 5;
  iipRing.visible = false;
  earthGroup.add(iipRing);

  let cameraMode: MissionCameraMode = 'chase';
  let anchorKind: TargetKind = 'rocket';
  let transition: Transition | null = null;
  let placed = false;
  let enabled = false;
  let currentT = 0;
  let breakupStartedAt: number | null = null;
  let jd = 2451545;
  let altitudeNow = 0;
  let throttleSum = 0;
  let padZoom = 1;
  const prevRocketDir = new THREE.Vector3();
  let havePrevRocketDir = false;

  // Pad camera position in padGroup coordinates (south-west of the pad, eye height above ground).
  const padCamLocal = new THREE.Vector3(-300, 0, 240);
  padCamLocal.y = terrainHeightAt(padCamLocal.x, padCamLocal.z) + 1.7;
  const localUpVec = new THREE.Vector3(0, 1, 0);
  const vehicleWorldPos = new THREE.Vector3();
  const payloadQuat = new THREE.Quaternion();
  const Y_AXIS = new THREE.Vector3(0, 1, 0);
  const scratchTarget = new THREE.Vector3();
  const sepScratch: SeparationState = { stages: [], fairing: null };
  const plumeScratch = { throttles: EMPTY_THROTTLES, ambientPressure: 0 };
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const q1 = new THREE.Quaternion();
  const camEarth = new THREE.Vector3();
  const upCam = new THREE.Vector3();

  // Environment map for metallic and glossy surfaces: a soft sky gradient, built on first render.
  let envTarget: THREE.WebGLRenderTarget | null = null;
  function buildEnvironment(renderer: THREE.WebGLRenderer): void {
    if (envTarget) return;
    const envScene = new THREE.Scene();
    const envMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vP; void main(){
        float h = normalize(vP).y;
        vec3 sky = mix(vec3(0.85,0.9,0.96), vec3(0.25,0.45,0.85), smoothstep(0.0,0.7,h));
        vec3 ground = mix(vec3(0.42,0.42,0.36), vec3(0.2,0.22,0.18), smoothstep(0.0,-0.6,h));
        gl_FragColor = vec4(h > 0.0 ? sky : ground, 1.0);
      }`,
    });
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), envMat));
    const pmrem = new THREE.PMREMGenerator(renderer);
    envTarget = pmrem.fromScene(envScene, 0.02);
    pmrem.dispose();
    envMat.dispose();
    scene.environment = envTarget.texture;
  }

  function clearVehicle(): void {
    if (launcherPlumes) {
      disposeLauncherPlumes(launcherPlumes);
      launcherPlumes = null;
    }
    if (launcherMesh) {
      launcherMesh.group.remove(plumeLight);
      scene.remove(launcherMesh.group);
      disposeLauncher(launcherMesh);
      launcherMesh = null;
    }
    if (launchComplex) {
      padGroup.remove(launchComplex);
      disposeLaunchComplex(launchComplex);
      launchComplex = null;
    }
    if (flownLine) {
      earthGroup.remove(flownLine);
      flownLine.geometry.dispose();
      (flownLine.material as THREE.Material).dispose();
      flownLine = null;
      flownTimes = new Float64Array(0);
    }
    if (coastLine) {
      earthGroup.remove(coastLine);
      coastLine.geometry.dispose();
      (coastLine.material as THREE.Material).dispose();
      coastLine = null;
    }
    if (orbitLine) {
      worldGroup.remove(orbitLine);
      orbitLine.geometry.dispose();
      (orbitLine.material as THREE.Material).dispose();
      orbitLine = null;
    }
    lastCoastT = NaN;
    lastCoastMs = -Infinity;
    coastPositions = null;
    coastCount = 0;
    coastValidT = -Infinity;
    iipRing.visible = false;
  }

  // ---------- Camera rig ----------

  const kindOf = (m: MissionCameraMode): TargetKind => (m === 'earth' ? 'earth' : m === 'solar' ? 'sun' : 'rocket');

  function targetOf(kind: TargetKind, out: THREE.Vector3): THREE.Vector3 {
    if (kind === 'rocket') return rocketCentre(out);
    if (kind === 'earth') return out.copy(worldGroup.position);
    return out.copy(worldGroup.position).add(solar.sunPos);
  }

  /** Middle of the vehicle stack in scene space (the scene origin is the vehicle base). */
  function rocketCentre(out: THREE.Vector3): THREE.Vector3 {
    if (!launcherMesh || !launcherMesh.group.visible) return out.set(0, 0, 0);
    return out.set(0, 0.45 * launcherMesh.totalLength, 0).applyQuaternion(launcherMesh.group.quaternion);
  }

  function upFor(mode: MissionCameraMode, out: THREE.Vector3): THREE.Vector3 {
    if (mode === 'earth') return out.set(0, 1, 0);
    if (mode === 'solar') return out.copy(ECLIPTIC_NORTH_APP);
    return out.copy(localUpVec);
  }

  function setUp(v: THREE.Vector3): void {
    if (camera.up.distanceToSquared(v) < 1e-12) return;
    camera.up.copy(v).normalize();
    controlsInternals._quat.setFromUnitVectors(camera.up, Y_AXIS);
    controlsInternals._quatInverse.copy(controlsInternals._quat).invert();
  }

  /** Horizontal east and south at the vehicle. */
  function horizonBasis(east: THREE.Vector3, south: THREE.Vector3): void {
    east.crossVectors(Y_AXIS, localUpVec);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    south.crossVectors(east, localUpVec).normalize();
  }

  function padCameraWorld(out: THREE.Vector3): THREE.Vector3 {
    padGroup.updateWorldMatrix(true, false);
    return out.copy(padCamLocal).applyMatrix4(padGroup.matrixWorld);
  }

  // Scratch owned by presetOffset, so callers may pass any of v1..v3 as `out`.
  const pv1 = new THREE.Vector3();
  const pv2 = new THREE.Vector3();
  const pv3 = new THREE.Vector3();
  /** Where a preset puts the camera, as an offset from its target. */
  function presetOffset(mode: MissionCameraMode, out: THREE.Vector3): THREE.Vector3 {
    const L = launcherMesh?.totalLength ?? 45;
    const east = pv1, south = pv2;
    horizonBasis(east, south);
    switch (mode) {
      case 'pad':
        return padCameraWorld(out).sub(rocketCentre(pv3)); // relative to the rocket target
      case 'chase':
        return out.copy(east).multiplyScalar(0.9).addScaledVector(south, 0.35).addScaledVector(localUpVec, 0.22)
          .normalize().multiplyScalar(2.4 * L);
      case 'track':
        return out.copy(east).multiplyScalar(0.7).addScaledVector(south, 0.68).addScaledVector(localUpVec, 0.1)
          .normalize().multiplyScalar(Math.max(1800, 45 * L));
      case 'earth':
        return out.copy(localUpVec).multiplyScalar(0.86).addScaledVector(south, 0.42).normalize().multiplyScalar(3.1 * RE_EQ);
      case 'solar': {
        const fromSun = pv3.copy(solar.sunPos).negate().normalize();
        return out.copy(ECLIPTIC_NORTH_APP).multiplyScalar(0.62).addScaledVector(fromSun, 0.78).normalize().multiplyScalar(3.4 * AU);
      }
    }
  }

  function fovFor(mode: MissionCameraMode): number {
    if (mode !== 'pad') return DEFAULT_FOV;
    const dist = padCameraWorld(pv1).distanceTo(rocketCentre(pv2));
    // Keep the whole vehicle (and a bit of plume) in frame as it climbs away from the camera.
    const L = launcherMesh?.totalLength ?? 45;
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan((0.85 * L) / Math.max(1, dist)));
    return Math.max(1.5, Math.min(60, fov * padZoom));
  }

  function applyLimits(): void {
    controls.minDistance =
      cameraMode === 'earth' ? RE_EQ * 1.06 : cameraMode === 'solar' ? 4 * 6.957e8 : Math.max(4, 0.35 * (launcherMesh?.totalLength ?? 20));
    controls.maxDistance = MAX_VIEW_DIST;
    controls.enabled = enabled && cameraMode !== 'pad' && transition === null;
  }

  function placeDirect(mode: MissionCameraMode): void {
    anchorKind = kindOf(mode);
    targetOf(anchorKind, controls.target);
    presetOffset(mode, v3);
    camera.position.copy(controls.target).add(v3);
    setUp(upFor(mode, v1));
    camera.fov = fovFor(mode);
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    havePrevRocketDir = false;
  }

  function startTransition(mode: MissionCameraMode): void {
    const fromKind = anchorKind;
    const from = targetOf(fromKind, v1);
    transition = {
      start: performance.now() / 1000,
      duration: TRANSITION_S,
      fromKind,
      fromOffset: camera.position.clone().sub(from),
      fromUp: camera.up.clone(),
      fromFov: camera.fov,
      toMode: mode,
    };
    // Long hops (to and from the Solar view) take a little longer.
    const toDist = presetOffset(mode, v2).length();
    const ratio = Math.abs(Math.log10(Math.max(1, toDist) / Math.max(1, transition.fromOffset.length())));
    transition.duration = TRANSITION_S * (0.8 + Math.min(1.2, ratio / 6));
  }

  const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

  /** Advance a preset transition. Returns true while it is still running. */
  function stepTransition(): boolean {
    const tr = transition;
    if (!tr) return false;
    const raw = Math.min(1, (performance.now() / 1000 - tr.start) / tr.duration);
    const e = ease(raw);
    const toKind = kindOf(tr.toMode);
    const T0 = targetOf(tr.fromKind, new THREE.Vector3());
    const T1 = targetOf(toKind, new THREE.Vector3());
    const toOffset = presetOffset(tr.toMode, new THREE.Vector3());
    const d0 = Math.max(1e-3, tr.fromOffset.length());
    const d1 = Math.max(1e-3, toOffset.length());
    const dir0 = tr.fromOffset.clone().divideScalar(d0);
    const dir1 = toOffset.clone().divideScalar(d1);
    q1.setFromUnitVectors(dir0, dir1);
    const dir = dir0.applyQuaternion(new THREE.Quaternion().slerp(q1, e));
    // Distance moves in log space (so a pad-to-planets hop is smooth); while the look-at point slides
    // between two far-apart targets, stay far enough back to keep both in view.
    const sep = T0.distanceTo(T1);
    const dist = Math.max(Math.exp(Math.log(d0) + (Math.log(d1) - Math.log(d0)) * e), 1.5 * sep * 4 * e * (1 - e));
    const target = T0.lerp(T1, e);
    camera.position.copy(target).addScaledVector(dir, dist);
    const up = upFor(tr.toMode, v1).lerp(tr.fromUp, 1 - e).normalize();
    setUp(up);
    camera.lookAt(target);
    camera.fov = tr.fromFov + (fovFor(tr.toMode) - tr.fromFov) * e;
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    if (raw >= 1) {
      transition = null;
      cameraMode = tr.toMode;
      anchorKind = toKind;
      havePrevRocketDir = false;
      applyLimits();
      return false;
    }
    return true;
  }

  /** Keep the camera above the ground near the pad and above the sea elsewhere. */
  function clampAboveGround(): void {
    const earthC = worldGroup.position;
    if (altitudeNow < 60_000 || camera.position.distanceTo(earthC) < RE_EQ + 60_000) {
      padGroup.updateWorldMatrix(true, false);
      const local = v1.copy(camera.position);
      padGroup.worldToLocal(local);
      if (Math.hypot(local.x, local.z) < TERRAIN_RADIUS_M * 0.9) {
        const g = terrainHeightAt(local.x, local.z) + 1.5;
        if (local.y < g) {
          local.y = g;
          camera.position.copy(local.applyMatrix4(padGroup.matrixWorld));
        }
        return;
      }
    }
    const rel = v2.copy(camera.position).sub(earthC);
    const r = rel.length();
    const yN = rel.y / Math.max(1, r);
    const surface = RE_EQ * (1 - 0.00335 * yN * yN) + 15;
    if (r < surface) camera.position.copy(earthC).addScaledVector(rel, surface / r);
  }

  /** Per-frame camera work: preset transitions, following, damping, ground clamp. */
  function updateCamera(): void {
    if (!placed) return;
    if (stepTransition()) return;
    if (cameraMode === 'pad') {
      padCameraWorld(camera.position);
      setUp(localUpVec);
      rocketCentre(controls.target);
      camera.lookAt(controls.target);
      const fov = fovFor('pad');
      if (Math.abs(camera.fov - fov) > 0.02) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      return;
    }
    // Carry the camera with its anchor so the user's orbit offset is kept.
    const T = targetOf(anchorKind, v3);
    camera.position.add(T).sub(controls.target);
    controls.target.copy(T);
    if (cameraMode === 'earth') {
      // Turn with the rocket around the planet so it stays under the camera.
      const dir = v1.copy(localUpVec);
      if (havePrevRocketDir && prevRocketDir.distanceToSquared(dir) > 1e-14) {
        q1.setFromUnitVectors(prevRocketDir, dir);
        camera.position.sub(T).applyQuaternion(q1).add(T);
      }
      prevRocketDir.copy(dir);
      havePrevRocketDir = true;
    }
    setUp(upFor(cameraMode, v1));
    if (camera.fov !== DEFAULT_FOV) {
      camera.fov = DEFAULT_FOV;
      camera.updateProjectionMatrix();
    }
    controls.update();
    clampAboveGround();
  }

  function onWheel(e: WheelEvent): void {
    if (!enabled || cameraMode !== 'pad' || transition) return;
    padZoom = Math.max(0.08, Math.min(1.6, padZoom * Math.exp(e.deltaY * 0.0012)));
  }
  domElement.addEventListener('wheel', onWheel, { passive: true });

  // ---------- Record and time ----------

  function setRecord(nextRecord: FlightRecord, def: MissionDef): void {
    clearVehicle();
    record = nextRecord;
    breakupStartedAt = null;
    fireball.visible = false;

    const vehicle = def.vehicle();
    const { spec, isSolid } = vehicleToLauncherSpec(vehicle);
    launcherSpec = spec;
    launcherMesh = buildLauncherMesh(spec);
    stylePayload(launcherMesh, def.payload);
    launcherPlumes = buildLauncherPlumes(launcherMesh, spec, isSolid);
    launcherMesh.group.add(plumeLight);
    plumeLight.position.set(0, -Math.max(12, 0.3 * launcherMesh.totalLength), 0);
    scene.add(launcherMesh.group);

    const maxRadius = spec.stages.reduce((m, s) => Math.max(m, s.radius + (s.parallel?.radialOffset ?? 0)), 1);
    launchComplex = buildLaunchComplex({ vehicleHeight: launcherMesh.totalLength, maxRadius });
    launchComplex.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
    });
    padGroup.add(launchComplex);
    exhaust.setRecord(nextRecord, spec.stages.find((st) => !st.parallel)?.radius ?? 2);
    if (!terrain) {
      terrain = buildPadTerrain({ trees: high ? 3500 : 900 });
      padGroup.add(terrain.group);
    }

    if (nextRecord.samples.length > 0) {
      const s0 = nextRecord.samples[0];
      const angle0 = (nextRecord.earth?.angleAtLiftoff ?? 0) + (nextRecord.earth?.rate ?? 0) * s0.t;
      const p0Earth = rotateYVec(s0.pos, -angle0);
      const box = new THREE.Box3().setFromObject(launcherMesh.group);
      const baseOffset = Math.max(0, box.min.y);
      const padUp = p0Earth.clone().normalize();
      padGroup.position.copy(p0Earth).addScaledVector(padUp, -baseOffset);

      // Basis: X = East, Y = padUp, Z = South.
      const east = new THREE.Vector3(0, 1, 0).cross(padUp);
      if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
      east.normalize();
      const south = east.clone().cross(padUp).normalize();
      padGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, padUp, south));
      blendTerrainWithGlobe();

      const flown = buildFlownPathPoints(nextRecord);
      flownTimes = flown.times;
      const flownGeo = new THREE.BufferGeometry();
      flownGeo.setAttribute('position', new THREE.BufferAttribute(flown.offsets, 3));
      flownGeo.setDrawRange(0, 0);
      flownLine = new THREE.Line(flownGeo, new THREE.LineBasicMaterial({ color: 0xf5a65b }));
      flownLine.name = 'mission-flown-path';
      flownLine.frustumCulled = false;
      flownLine.position.set(flown.origin[0], flown.origin[1], flown.origin[2]);
      earthGroup.add(flownLine);

      const coastGeo = new THREE.BufferGeometry();
      coastPositions = new THREE.BufferAttribute(new Float32Array(COAST_CAPACITY * 3), 3);
      coastPositions.setUsage(THREE.DynamicDrawUsage);
      coastGeo.setAttribute('position', coastPositions);
      coastDistances = new THREE.BufferAttribute(new Float32Array(COAST_CAPACITY), 1);
      coastDistances.setUsage(THREE.DynamicDrawUsage);
      coastGeo.setAttribute('lineDistance', coastDistances);
      coastGeo.setDrawRange(0, 0);
      coastLine = new THREE.Line(coastGeo, new THREE.LineDashedMaterial({ color: 0xffb454, dashSize: 20_000, gapSize: 12_000 }));
      coastLine.name = 'mission-coast-path';
      coastLine.frustumCulled = false;
      coastLine.visible = false;
      earthGroup.add(coastLine);

      const perigeeAlt = nextRecord.outcome?.perigeeAltitude ?? nextRecord.orbit?.periapsis ?? -Infinity;
      if (perigeeAlt > 80_000) {
        const last = nextRecord.samples[nextRecord.samples.length - 1];
        const el = elementsFromAppState(last.pos, last.vel);
        if (Number.isFinite(el.a) && el.a > 0 && el.e < 1) {
          orbitLine = buildOrbitLine(orbitPoints(el, 256), 0xf5a65b);
          orbitLine.frustumCulled = false;
          worldGroup.add(orbitLine);
        }
      }
    }

    setTime(nextRecord.samples[0]?.t ?? 0);
    // A new flight starts from the current preset's framing (no fly-in).
    transition = null;
    placed = true;
    placeDirect(cameraMode);
    applyLimits();
  }

  function refreshPath(): void {
    if (!record || !flownLine || record.samples.length === 0) return;
    const flown = buildFlownPathPoints(record);
    flownTimes = flown.times;
    const old = flownLine.geometry;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(flown.offsets, 3));
    geo.setDrawRange(0, 0);
    flownLine.geometry = geo;
    old.dispose();
  }

  function setTime(t: number): void {
    if (!record || record.samples.length === 0) {
      currentT = t;
      return;
    }
    // Before the first sample the snapshot is clamped, so the Earth angle must be too.
    t = Math.max(t, record.samples[0].t);
    currentT = t;

    const snap = snapshotAt(record, t);
    const earthAngle = (record.earth?.angleAtLiftoff ?? 0) + (record.earth?.rate ?? 0) * t;
    jd = (record.epochJD ?? 2460140.0) + ((record.liftoffSimTime ?? 0) + t) / 86400;
    altitudeNow = snap.altitude;

    vehicleWorldPos.set(snap.pos[0], snap.pos[1], snap.pos[2]);
    worldGroup.position.copy(vehicleWorldPos).negate();
    earthGroup.rotation.y = earthAngle;
    localUpVec.copy(vehicleWorldPos).normalize();
    clouds.rotation.y = ((jd % 9) / 9) * Math.PI * 2 * 0.05;

    throttleSum = 0;
    if (launcherMesh && launcherSpec) {
      launcherMesh.group.quaternion.set(snap.quat[0], snap.quat[1], snap.quat[2], snap.quat[3]);
      if (snap.payloadOffset) {
        payloadQuat.copy(launcherMesh.group.quaternion).invert();
        launcherMesh.payload.position.set(snap.payloadOffset[0], snap.payloadOffset[1], snap.payloadOffset[2]).applyQuaternion(payloadQuat);
      } else {
        launcherMesh.payload.position.set(0, 0, 0);
      }

      const lastT = record.samples[record.samples.length - 1].t;
      const isBreakupEnd = record.outcome?.outcome === 'breakup' && t >= lastT - 1e-6;
      if (isBreakupEnd) {
        launcherMesh.group.visible = false;
        fireball.visible = true;
        if (breakupStartedAt === null) breakupStartedAt = performance.now();
        const age = Math.min(1.5, (performance.now() - breakupStartedAt) / 1000);
        fireball.scale.setScalar(12 + 45 * (age / 1.5));
        fireballMat.opacity = Math.max(0.25, 0.95 - 0.55 * (age / 1.5));
      } else {
        breakupStartedAt = null;
        launcherMesh.group.visible = true;
        fireball.visible = false;
        updateLauncherStaging(launcherMesh, launcherSpec, separationAgesInto(record, t, sepScratch));
        if (launcherPlumes) {
          plumeScratch.throttles = snap.stageThrottle ?? EMPTY_THROTTLES;
          plumeScratch.ambientPressure = snap.ambientPressure ?? 0;
          updatePlumes(launcherPlumes, plumeScratch);
          for (let i = 0; i < plumeScratch.throttles.length; i++) {
            if (launcherMesh.stageGroups[i]?.visible) throttleSum += plumeScratch.throttles[i];
          }
        }
      }
    }

    if (flownLine && flownTimes.length > 0) {
      let count = 0;
      if (t >= flownTimes[0]) {
        let lo = 0;
        let hi = flownTimes.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (flownTimes[mid] <= t) lo = mid;
          else hi = mid - 1;
        }
        count = lo + 1;
      }
      flownLine.geometry.setDrawRange(0, count);
    }

    // Predicted coast line (see coastValidUntil): trim while coasting, otherwise recompute at most 2 Hz.
    if (coastLine && coastPositions) {
      if (snap.periapsis !== undefined && snap.periapsis > 100_000) {
        coastLine.visible = false;
      } else if (coastCount >= 2 && t >= lastCoastT && t <= coastValidT) {
        let lo = 0;
        let hi = coastCount - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (coastTimes[mid] <= t) lo = mid;
          else hi = mid - 1;
        }
        const start = Math.min(lo, coastCount - 2);
        coastLine.geometry.setDrawRange(start, coastCount - start);
        coastLine.visible = true;
      } else {
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!(Math.abs(t - lastCoastT) <= 1e-4) && nowMs - lastCoastMs >= COAST_MIN_INTERVAL_MS) {
          lastCoastT = t;
          lastCoastMs = nowMs;
          const n = coastPathInto(record, t, COAST_HORIZON_S, COAST_STEP_S, { positions: coastPositions.array as Float32Array, times: coastTimes }, coastOrigin);
          coastCount = n;
          if (n >= 2) {
            coastPositions.needsUpdate = true;
            coastLine.geometry.setDrawRange(0, n);
            coastLine.position.set(coastOrigin[0], coastOrigin[1], coastOrigin[2]);
            const pos = coastPositions.array as Float32Array;
            const dist = coastDistances.array as Float32Array;
            dist[0] = 0;
            for (let i = 1; i < n; i++) {
              dist[i] = dist[i - 1] + Math.hypot(pos[i * 3] - pos[i * 3 - 3], pos[i * 3 + 1] - pos[i * 3 - 2], pos[i * 3 + 2] - pos[i * 3 - 1]);
            }
            coastDistances.needsUpdate = true;
            coastLine.visible = true;
            coastValidT = coastValidUntil(record, t);
          } else {
            coastLine.visible = false;
            coastValidT = -Infinity;
          }
        }
      }
    }

    if (snap.iip) {
      const p = latLonToApp(snap.iip.latDeg, snap.iip.lonDeg, 0, RE_EQ + 500);
      iipRing.position.set(p[0], p[1], p[2]);
      iipRing.quaternion.setFromUnitVectors(Y_AXIS, scratchTarget.copy(iipRing.position).normalize());
      iipRing.visible = cameraMode === 'earth';
    } else {
      iipRing.visible = false;
    }
  }

  // ---------- Per-frame look: sky, lights, fades ----------

  const warmSun = new THREE.Color(0xffb070);
  const whiteSun = new THREE.Color(0xfff6ea);
  const skyDay = new THREE.Color(0xbfd8ff);
  const skyNight = new THREE.Color(0x26324a);

  function updateLook(): void {
    const earthC = worldGroup.position;
    camEarth.copy(camera.position).sub(earthC);
    const camR = camEarth.length();
    const camAlt = camR - RE_EQ;
    upCam.copy(camEarth).divideScalar(Math.max(1, camR));

    solar.update(jd, camEarth, 1);
    sunDirWorld.copy(solar.sunPos).normalize();

    const skyFactor = Math.exp(-Math.max(0, camAlt) / 12_000);
    const sunElevCam = upCam.dot(sunDirWorld);
    const dayCam = smoothstep(-0.18, 0.1, sunElevCam);

    // Stars: hidden by a lit sky, visible at night and in space.
    const starA = Math.max(0, Math.min(1, 1 - skyFactor * (0.35 + 1.6 * dayCam)));
    starMat.opacity = starA;
    brightStarMat.opacity = starA;
    starsGroup.visible = starA > 0.01;
    starsGroup.position.copy(camera.position);
    solar.update(jd, camEarth, starA, earthC);

    skyDome.visible = skyFactor > 0.004;
    skyDome.position.copy(camera.position);
    skyMat.uniforms.uK.value = skyFactor;
    (skyMat.uniforms.uUp.value as THREE.Vector3).copy(upCam);
    (skyMat.uniforms.uSun.value as THREE.Vector3).copy(sunDirWorld);

    // Sunlight at the vehicle: dimmed in Earth's shadow (below the horizon, allowing for height),
    // warm near the horizon at low altitude. Far from the rocket the globe is lit by the full Sun.
    const elevV = localUpVec.dot(sunDirWorld);
    const dip = Math.sqrt(Math.max(0, 1 - Math.pow(RE_EQ / (RE_EQ + Math.max(0, altitudeNow)), 2)));
    let sunVis = smoothstep(-dip - 0.03, -dip + 0.03, elevV);
    const camFromRocket = camera.position.length();
    sunVis = sunVis + (1 - sunVis) * smoothstep(80_000, 3_000_000, camFromRocket);
    const lowAir = Math.exp(-Math.max(0, altitudeNow) / 15_000);
    const warmth = (1 - smoothstep(0.02, 0.35, elevV)) * lowAir;
    sunLight.color.copy(whiteSun).lerp(warmSun, warmth);
    sunLight.intensity = 3.2 * sunVis;
    sunLight.position.copy(sunDirWorld).multiplyScalar(1500);
    sunLight.target.position.set(0, 0, 0);
    sunLight.castShadow = high && altitudeNow < 1500 && sunVis > 0.05 && camFromRocket < 3000;

    const dayV = smoothstep(-0.15, 0.12, elevV);
    hemi.position.copy(localUpVec);
    const airV = Math.exp(-Math.max(0, altitudeNow) / 30_000);
    hemi.color.copy(skyNight).lerp(skyDay, dayV);
    hemi.intensity = (0.08 + 0.75 * dayV) * airV + 0.04;
    ambient.intensity = 0.05 + 0.06 * (1 - airV);

    scene.environmentIntensity = 0.15 + 0.85 * dayV * airV;
    q1.setFromUnitVectors(Y_AXIS, localUpVec);
    scene.environmentRotation.setFromQuaternion(q1);

    // Plume light on the pad and the vehicle; flood lights at night.
    const night = 1 - dayV;
    plumeLight.intensity = throttleSum > 0 ? Math.min(3, throttleSum) * 9000 * (0.35 + 0.65 * night) : 0;
    const floodI = camAlt < 60_000 ? 9000 * night : 0;
    floodLight.intensity = floodI;
    if (floodLight2) floodLight2.intensity = floodI;

    // Space look: limb glow and clouds fade in above the weather.
    atmoMat.uniforms.uOpacity.value = smoothstep(15_000, 90_000, camAlt) * (1 - smoothstep(5e8, 2e9, camR));
    (atmoMat.uniforms.uCenter.value as THREE.Vector3).copy(earthC);
    (atmoMat.uniforms.uSun.value as THREE.Vector3).copy(sunDirWorld);
    atmosphere.visible = atmoMat.uniforms.uOpacity.value > 0.005;
    rimStrength.value = smoothstep(20_000, 250_000, camAlt);
    cloudMat.opacity = 0.9 * smoothstep(12_000, 60_000, camAlt);
    clouds.visible = cloudMat.opacity > 0.01 && cloudMat.map !== null;

    // Haze: thick near the ground, gone above the stratosphere; tinted by sunrise / sunset.
    const sunset = smoothstep(-0.2, 0.0, sunElevCam) * (1 - smoothstep(0.03, 0.38, sunElevCam));
    fog.density = 2.2e-5 * Math.exp(-Math.max(0, camAlt) / 9000);
    fog.color.setRGB(
      0.035 + (0.74 - 0.035) * dayCam + 0.05 * sunset,
      0.05 + (0.83 - 0.05) * dayCam - 0.04 * sunset,
      0.09 + (0.93 - 0.09) * dayCam - 0.08 * sunset,
      THREE.SRGBColorSpace,
    );
    exhaust.update(currentT, Math.max(0.15, sunVis * (0.3 + 0.7 * dayV)), sunDirWorld);

    // Near-field detail only while it can be seen.
    padGroup.updateWorldMatrix(true, false);
    const padHeight = v2.copy(camera.position).applyMatrix4(v3Matrix.copy(padGroup.matrixWorld).invert()).y;
    if (terrain) {
      terrain.group.visible = camAlt < 2_500_000;
      terrain.update(performance.now() / 1000, Math.max(0, padHeight));
    }
    if (launchComplex) launchComplex.visible = camAlt < 300_000;
    // The final orbit is a map overlay: from low down it is just a stray line across the sky.
    if (orbitLine) orbitLine.visible = camAlt > 40_000;
    setPlumeTime(performance.now() / 1000);
  }
  const v3Matrix = new THREE.Matrix4();

  function setCamera(mode: MissionCameraMode): void {
    if (!placed) {
      cameraMode = mode;
      return;
    }
    if (mode === cameraMode && !transition) {
      // Pressing the active preset again re-frames it.
      if (mode === 'pad') padZoom = 1;
    }
    controls.enabled = false;
    startTransition(mode);
    cameraMode = mode;
    if (record) setTime(currentT);
  }

  function setEnabled(on: boolean): void {
    enabled = on;
    if (!on) restoreResolution();
    applyLimits();
  }

  function resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  // ---- Adaptive pixel ratio (both tiers) ----
  // Frame time is the gap between consecutive render() calls, smoothed by an EMA with a ~1 s time
  // constant. Sustained slow frames lower the ratio; sustained fast frames raise it back, never
  // above the ratio the renderer had when this view was first drawn. Gaps over 1 s are idle, not frames.
  const SLOW_FRAME_MS = 24;
  const FAST_FRAME_MS = 12;
  const SLOW_FOR_MS = 2000;
  const FAST_FOR_MS = 4000;
  const RATIO_STEP = 0.85;
  const RATIO_COOLDOWN_MS = 1000;
  const IDLE_GAP_MS = 1000;
  let adaptRenderer: THREE.WebGLRenderer | null = null;
  let startRatio = 1;
  let minRatio = 1;
  let curRatio = 1;
  let lastFrameMs: number | null = null;
  let frameAvgMs: number | null = null;
  let lastRatioChangeMs = -Infinity;
  let slowSince: number | null = null;
  let fastSince: number | null = null;

  function setRatio(next: number, now: number): void {
    curRatio = next;
    lastRatioChangeMs = now;
    adaptRenderer?.setPixelRatio(next);
  }

  function trackFrameTime(renderer: THREE.WebGLRenderer): void {
    if (adaptRenderer !== renderer) {
      adaptRenderer = renderer;
      startRatio = curRatio = renderer.getPixelRatio();
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      minRatio = Math.min(startRatio, 1, 0.6 * dpr);
    }
    const now = performance.now();
    const dt = lastFrameMs === null ? Infinity : now - lastFrameMs;
    lastFrameMs = now;
    if (dt > IDLE_GAP_MS) {
      frameAvgMs = null;
      slowSince = fastSince = null;
      return;
    }
    if (!Number.isFinite(dt)) return;
    const alpha = 1 - Math.exp(-dt / 1000);
    frameAvgMs = frameAvgMs === null ? dt : frameAvgMs + alpha * (dt - frameAvgMs);
    const cooled = now - lastRatioChangeMs >= RATIO_COOLDOWN_MS;

    if (frameAvgMs > SLOW_FRAME_MS) {
      fastSince = null;
      if (slowSince === null) slowSince = now;
      if (cooled && now - slowSince >= SLOW_FOR_MS && curRatio > minRatio + 1e-6) {
        setRatio(Math.max(minRatio, curRatio * RATIO_STEP), now);
        slowSince = null;
      }
    } else if (frameAvgMs < FAST_FRAME_MS) {
      slowSince = null;
      if (fastSince === null) fastSince = now;
      if (cooled && now - fastSince >= FAST_FOR_MS && curRatio < startRatio - 1e-6) {
        setRatio(Math.min(startRatio, curRatio / RATIO_STEP), now);
        fastSince = null;
      }
    } else {
      slowSince = fastSince = null;
    }
  }

  /** Put the renderer back at the ratio it had before this view adapted it (other app modes rely on it). */
  function restoreResolution(): void {
    if (adaptRenderer && curRatio !== startRatio) adaptRenderer.setPixelRatio(startRatio);
    adaptRenderer = null;
    curRatio = startRatio;
    lastFrameMs = null;
    frameAvgMs = null;
    lastRatioChangeMs = -Infinity;
    slowSince = fastSince = null;
  }

  function render(renderer: THREE.WebGLRenderer): void {
    trackFrameTime(renderer);
    buildEnvironment(renderer);
    updateCamera();
    updateLook();
    const prevTone = renderer.toneMapping;
    const prevExposure = renderer.toneMappingExposure;
    // Shadows are a desktop-only feature: on 'low' the renderer's shadow setup is never touched.
    const prevShadow = renderer.shadowMap.enabled;
    const prevShadowType = renderer.shadowMap.type;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    if (high) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    renderer.render(scene, camera);
    renderer.toneMapping = prevTone;
    renderer.toneMappingExposure = prevExposure;
    if (high) {
      renderer.shadowMap.enabled = prevShadow;
      renderer.shadowMap.type = prevShadowType;
    }
  }

  function isAnimating(): boolean {
    return transition !== null;
  }

  function viewDistance(): number {
    if (cameraMode === 'pad') return camera.position.distanceTo(rocketCentre(v1));
    return camera.position.distanceTo(controls.target);
  }

  function dispose(): void {
    clearVehicle();
    controls.dispose();
    domElement.removeEventListener('wheel', onWheel);
    terrain?.dispose();
    exhaust.dispose();
    solar.dispose();
    earthGeo.dispose();
    earthMat.dispose();
    clouds.geometry.dispose();
    cloudMat.dispose();
    skyDome.geometry.dispose();
    skyMat.dispose();
    atmosphere.geometry.dispose();
    atmoMat.dispose();
    iipGeo.dispose();
    iipMat.dispose();
    faintStars.geometry.dispose();
    brightStars.geometry.dispose();
    starMat.dispose();
    brightStarMat.dispose();
    dotTex.dispose();
    fireballGeo.dispose();
    fireballMat.dispose();
    envTarget?.dispose();
  }

  return {
    setRecord,
    setTime,
    refreshPath,
    setCamera,
    setEnabled,
    resize,
    render,
    isAnimating,
    viewDistance,
    quality,
    dispose,
  };
}
