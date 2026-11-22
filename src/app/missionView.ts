// 3D viewport for Mission mode: rotating Earth, Sriharikota pad, staged launcher,
// plumes, breakup fireball, and chase / pad / map cameras.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Vec3 } from '../types';
import type { VehicleSpec } from '../mission/engine';
import type { FlightRecord } from '../mission/record';
import { snapshotAt } from '../mission/snapshot';
import type { MissionDef } from '../mission/vehicles';
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
  updatePlumes,
  type LauncherPlumes,
} from '../render/launcherPlume';
import { updateLauncherStaging, type SeparationState } from '../render/launcherStaging';

export type MissionCameraMode = 'chase' | 'pad' | 'map';

export interface MissionView {
  setRecord(record: FlightRecord, def: MissionDef): void;
  setTime(t: number): void;
  setCamera(mode: MissionCameraMode): void;
  setEnabled(on: boolean): void;
  resize(width: number, height: number): void;
  render(renderer: THREE.WebGLRenderer): void;
  dispose(): void;
}

const RE_EQ = 6_378_137;
const RE_POLAR = 6_356_752;
const E2 = 1 - (RE_POLAR * RE_POLAR) / (RE_EQ * RE_EQ);
const EARTH_SINK_M = 2000;
const PAD_DISC_RADIUS_M = 80_000;
const DEG_TO_RAD = Math.PI / 180;
const SKY_BLUE = new THREE.Color(0x5fa4e8);
const SPACE_BLACK = new THREE.Color(0x000000);
const DEFAULT_FOV = 45;

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

// ---------- Asset & geometry helpers ----------

function assetsEnabled(): boolean {
  const env = (import.meta as { env?: { MODE?: string } }).env;
  return typeof document !== 'undefined' && typeof fetch === 'function' && env?.MODE !== 'test';
}

function loadEarthTexture(onLoad: (tex: THREE.Texture) => void): void {
  if (!assetsEnabled()) return;
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  const loader = new THREE.TextureLoader();
  loader.load(
    `${base}assets/space/earth_atmos_2048.jpg`,
    (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      onLoad(t);
    },
    undefined,
    () => {},
  );
}

function makeRadialAlphaTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size) * 2 - 1;
      const dy = ((y + 0.5) / size) * 2 - 1;
      const r = Math.hypot(dx, dy);
      const t = Math.max(0, Math.min(1, (1 - r) / 0.55));
      const a = Math.round(t * t * (3 - 2 * t) * 255);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = a;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

function makeStarField(count = 1600): { points: THREE.Points; material: THREE.PointsMaterial } {
  const positions = new Float32Array(count * 3);
  const radius = 1.2e8;
  // Deterministic Fibonacci-like hash so stars are reproducible without Math.random jitter.
  for (let i = 0; i < count; i++) {
    const u = ((i * 0.61803398875) % 1) * 2 - 1;
    const phi = i * 2.399963229728653;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    positions[i * 3] = radius * s * Math.cos(phi);
    positions[i * 3 + 1] = radius * u;
    positions[i * 3 + 2] = radius * s * Math.sin(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.5,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, material);
  points.name = 'mission-stars';
  points.frustumCulled = false;
  return { points, material };
}

function rotateYVec(v: Vec3, angleRad: number): THREE.Vector3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return new THREE.Vector3(v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c);
}

// ---------- MissionView implementation ----------

export function createMissionView(domElement: HTMLElement): MissionView {
  const scene = new THREE.Scene();
  const bgColor = new THREE.Color(SKY_BLUE);
  scene.background = bgColor;

  const aspect =
    typeof window !== 'undefined' && window.innerHeight > 0
      ? window.innerWidth / window.innerHeight
      : 16 / 9;
  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, aspect, 0.5, 2.5e8);
  camera.position.set(0, 20, 110);

  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enabled = false;
  controls.minDistance = 8;
  controls.maxDistance = 5e7;

  // Fixed inertial lighting. Direction is aimed at the pad once a record is set.
  const ambient = new THREE.AmbientLight(0xd0e2ff, 0.35);
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
  sunLight.position.set(1, 1, 1).normalize().multiplyScalar(1e7);
  scene.add(ambient, sunLight);

  const { points: stars, material: starMat } = makeStarField();
  scene.add(stars);

  // Floating-origin world group (positioned at -vehiclePos each frame).
  const worldGroup = new THREE.Group();
  worldGroup.name = 'mission-world';
  scene.add(worldGroup);

  // Rotating Earth group inside worldGroup.
  const earthGroup = new THREE.Group();
  earthGroup.name = 'mission-earth';
  worldGroup.add(earthGroup);

  const earthGeo = new THREE.SphereGeometry(RE_EQ - EARTH_SINK_M, 128, 64);
  const earthMat = new THREE.MeshLambertMaterial({ color: 0x2f6fb5 });
  const earthMesh = new THREE.Mesh(earthGeo, earthMat);
  earthMesh.name = 'earth-sphere';
  earthMesh.scale.y = RE_POLAR / RE_EQ;
  earthGroup.add(earthMesh);

  loadEarthTexture((tex) => {
    earthMat.map = tex;
    earthMat.color.setHex(0xffffff);
    earthMat.needsUpdate = true;
  });

  // Pad anchor group in earthGroup (disc + launch complex).
  const padGroup = new THREE.Group();
  padGroup.name = 'mission-pad-group';
  earthGroup.add(padGroup);

  const discAlpha = makeRadialAlphaTexture();
  const discGeo = new THREE.CircleGeometry(PAD_DISC_RADIUS_M, 64);
  discGeo.rotateX(-Math.PI / 2);
  const discMat = new THREE.MeshLambertMaterial({
    color: 0x57754e,
    transparent: true,
    alphaMap: discAlpha,
    depthWrite: false,
  });
  const groundDisc = new THREE.Mesh(discGeo, discMat);
  groundDisc.name = 'pad-ground-disc';
  // Sit just below the launch-complex apron top (y = -2 in launchComplex).
  groundDisc.position.y = -2.02;
  padGroup.add(groundDisc);

  // Breakup fireball at scene origin (hidden except at breakup end).
  const fireballGeo = new THREE.SphereGeometry(1, 24, 16);
  const fireballMat = new THREE.MeshBasicMaterial({
    color: 0xff7b29,
    transparent: true,
    opacity: 0.9,
  });
  const fireball = new THREE.Mesh(fireballGeo, fireballMat);
  fireball.name = 'breakup-fireball';
  fireball.visible = false;
  scene.add(fireball);

  let record: FlightRecord | null = null;
  let launcherSpec: LauncherSpec | null = null;
  let launcherMesh: LauncherMesh | null = null;
  let launcherPlumes: LauncherPlumes | null = null;
  let launchComplex: THREE.Group | null = null;

  let cameraMode: MissionCameraMode = 'chase';
  let enabled = false;
  let currentT = 0;
  let breakupStartedAt: number | null = null;

  // Pad camera position in earthGroup local coordinates (250 m east of pad).
  const padCamEarthPos = new THREE.Vector3(250, 5, 0);
  const localUpVec = new THREE.Vector3(0, 1, 0);
  const vehicleWorldPos = new THREE.Vector3();
  const padWorldPos = new THREE.Vector3();

  function clearVehicle(): void {
    if (launcherPlumes) {
      disposeLauncherPlumes(launcherPlumes);
      launcherPlumes = null;
    }
    if (launcherMesh) {
      scene.remove(launcherMesh.group);
      disposeLauncher(launcherMesh);
      launcherMesh = null;
    }
    if (launchComplex) {
      padGroup.remove(launchComplex);
      disposeLaunchComplex(launchComplex);
      launchComplex = null;
    }
  }

  function applyControlsEnabled(): void {
    controls.enabled = enabled && cameraMode !== 'pad';
  }

  function resetCameraForMode(): void {
    if (cameraMode === 'chase') {
      camera.fov = DEFAULT_FOV;
      camera.updateProjectionMatrix();
      const len = launcherMesh?.totalLength ?? 43;
      camera.up.copy(localUpVec);
      controls.target.set(0, 0, 0);
      const side = new THREE.Vector3(0, 1, 0).cross(localUpVec);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      camera.position
        .copy(side)
        .multiplyScalar(len * 2.4)
        .addScaledVector(localUpVec, len * 0.7);
      controls.minDistance = 8;
      controls.maxDistance = 5e5;
      controls.update();
    } else if (cameraMode === 'map') {
      camera.fov = DEFAULT_FOV;
      camera.updateProjectionMatrix();
      camera.up.set(0, 1, 0);
      controls.target.copy(worldGroup.position);
      const dir = localUpVec.clone().normalize();
      camera.position.copy(worldGroup.position).addScaledVector(dir, RE_EQ * 3);
      controls.minDistance = RE_EQ * 1.15;
      controls.maxDistance = RE_EQ * 20;
      controls.update();
    }
    applyControlsEnabled();
  }

  function setRecord(nextRecord: FlightRecord, def: MissionDef): void {
    clearVehicle();
    record = nextRecord;
    breakupStartedAt = null;
    fireball.visible = false;

    const vehicle = def.vehicle();
    const { spec, isSolid } = vehicleToLauncherSpec(vehicle);
    launcherSpec = spec;
    launcherMesh = buildLauncherMesh(spec);
    launcherPlumes = buildLauncherPlumes(launcherMesh, spec, isSolid);
    scene.add(launcherMesh.group);

    const maxRadius = spec.stages.reduce((m, s) => Math.max(m, s.radius + (s.parallel?.radialOffset ?? 0)), 1);
    launchComplex = buildLaunchComplex({
      vehicleHeight: launcherMesh.totalLength,
      maxRadius,
    });
    padGroup.add(launchComplex);

    // Anchor the pad group so the base of the launcher sits on the pedestal at the first sample.
    if (nextRecord.samples.length > 0) {
      const s0 = nextRecord.samples[0];
      const angle0 = (nextRecord.earth?.angleAtLiftoff ?? 0) + (nextRecord.earth?.rate ?? 0) * s0.t;
      const p0Earth = rotateYVec(s0.pos, -angle0);
      // Measure vehicle base offset in local +Y (core base is at y = 0 in launcherMesh).
      const box = new THREE.Box3().setFromObject(launcherMesh.group);
      const baseOffset = Math.max(0, box.min.y);
      const padUp = p0Earth.clone().normalize();
      // Move pad along -padUp if mesh min.y > 0, so base sits flush at y = 0 of padGroup.
      padGroup.position.copy(p0Earth).addScaledVector(padUp, -baseOffset);

      // Basis: X = East, Y = padUp, Z = South.
      const east = new THREE.Vector3(0, 1, 0).cross(padUp);
      if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
      east.normalize();
      const south = east.clone().cross(padUp).normalize();
      const basis = new THREE.Matrix4().makeBasis(east, padUp, south);
      padGroup.quaternion.setFromRotationMatrix(basis);

      // Pad camera sits 250 m east and 5 m up in padGroup, stored in earthGroup coords.
      padCamEarthPos.set(250, 5, 0).applyMatrix4(
        new THREE.Matrix4().compose(padGroup.position, padGroup.quaternion, new THREE.Vector3(1, 1, 1)),
      );

      // Aim fixed inertial sunlight so the pad is well lit at liftoff.
      const s0Dir = new THREE.Vector3(s0.pos[0], s0.pos[1], s0.pos[2]).normalize();
      sunLight.position
        .copy(s0Dir)
        .addScaledVector(east.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle0), 0.5)
        .add(new THREE.Vector3(0, 0.4, 0))
        .normalize()
        .multiplyScalar(1e7);
    }

    setTime(nextRecord.samples[0]?.t ?? 0);
    resetCameraForMode();
  }

  function setTime(t: number): void {
    currentT = t;
    if (!record || record.samples.length === 0) return;

    const snap = snapshotAt(record, t);
    const earthAngle = (record.earth?.angleAtLiftoff ?? 0) + (record.earth?.rate ?? 0) * t;

    vehicleWorldPos.set(snap.pos[0], snap.pos[1], snap.pos[2]);
    worldGroup.position.copy(vehicleWorldPos).negate();
    earthGroup.rotation.y = earthAngle;

    localUpVec.copy(vehicleWorldPos).normalize();

    if (launcherMesh && launcherSpec) {
      launcherMesh.group.quaternion.set(snap.quat[0], snap.quat[1], snap.quat[2], snap.quat[3]);

      const lastT = record.samples[record.samples.length - 1].t;
      const isBreakupEnd = record.outcome?.outcome === 'breakup' && t >= lastT - 1e-6;
      if (isBreakupEnd) {
        launcherMesh.group.visible = false;
        fireball.visible = true;
        if (breakupStartedAt === null) breakupStartedAt = performance.now();
        const age = Math.min(1.5, (performance.now() - breakupStartedAt) / 1000);
        const r = 12 + 45 * (age / 1.5);
        fireball.scale.setScalar(r);
        fireballMat.opacity = Math.max(0.25, 0.95 - 0.55 * (age / 1.5));
      } else {
        breakupStartedAt = null;
        launcherMesh.group.visible = true;
        fireball.visible = false;
        updateLauncherStaging(launcherMesh, launcherSpec, separationAges(record, t));
        if (launcherPlumes) {
          updatePlumes(launcherPlumes, {
            throttles: snap.stageThrottle ?? [],
            ambientPressure: snap.ambientPressure ?? 0,
          });
        }
      }
    }

    // Update sky and stars using the higher of vehicle altitude and camera altitude.
    const camDistFromEarth = camera.position.distanceTo(worldGroup.position);
    const effectiveAlt = Math.max(snap.altitude, camDistFromEarth - RE_EQ);
    const skyFactor = Math.exp(-Math.max(0, effectiveAlt) / 12_000);
    bgColor.copy(SPACE_BLACK).lerp(SKY_BLUE, skyFactor);
    starMat.opacity = Math.max(0, Math.min(1, 1 - skyFactor * 1.4));
    stars.visible = starMat.opacity > 0.01;

    // Update camera framing.
    if (cameraMode === 'chase') {
      camera.up.copy(localUpVec);
      controls.target.set(0, 0, 0);
      // Prevent chase camera from dipping below the ground near the pad.
      if (snap.altitude < 5000) {
        const minHeight = -snap.altitude + 2;
        const h = camera.position.dot(localUpVec);
        if (h < minHeight) {
          camera.position.addScaledVector(localUpVec, minHeight - h);
        }
      }
    } else if (cameraMode === 'pad') {
      padWorldPos.copy(padCamEarthPos).applyAxisAngle(new THREE.Vector3(0, 1, 0), earthAngle);
      camera.position.copy(padWorldPos).add(worldGroup.position);
      camera.up.copy(localUpVec);
      camera.lookAt(0, 0, 0);
      const dist = camera.position.length();
      const targetFov = Math.max(4, Math.min(DEFAULT_FOV, DEFAULT_FOV * (260 / Math.max(260, dist))));
      if (Math.abs(camera.fov - targetFov) > 0.05) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }
    } else if (cameraMode === 'map') {
      const prevTarget = controls.target.clone();
      controls.target.copy(worldGroup.position);
      camera.position.add(worldGroup.position).sub(prevTarget);
    }
  }

  function setCamera(mode: MissionCameraMode): void {
    cameraMode = mode;
    resetCameraForMode();
    if (record) setTime(currentT);
  }

  function setEnabled(on: boolean): void {
    enabled = on;
    applyControlsEnabled();
  }

  function resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function render(renderer: THREE.WebGLRenderer): void {
    if (cameraMode !== 'pad') controls.update();
    renderer.render(scene, camera);
  }

  function dispose(): void {
    clearVehicle();
    controls.dispose();
    earthGeo.dispose();
    earthMat.dispose();
    discGeo.dispose();
    discMat.dispose();
    discAlpha.dispose();
    stars.geometry.dispose();
    starMat.dispose();
    fireballGeo.dispose();
    fireballMat.dispose();
  }

  return {
    setRecord,
    setTime,
    setCamera,
    setEnabled,
    resize,
    render,
    dispose,
  };
}
