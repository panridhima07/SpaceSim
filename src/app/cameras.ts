// Camera rig for the flight view. Four modes built on OrbitControls.
//
// All positions are in scene space (physics world minus the floating origin). The controls
// target is re-anchored every frame, and the camera moves with it so the user's orbit offset
// is kept. Chase and map anchor on the scene origin (the rocket CG) and on Earth's centre
// respectively. Pad follows the nose with smoothing so the rocket can fly away from the pad.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraMode } from './uiTypes';

export interface CameraContext {
  /** Nose tip, scene space. */
  nose: THREE.Vector3;
  /** Unit vector along the rocket axis (nose direction, body +Y in world). */
  up: THREE.Vector3;
  /** Earth's centre, scene space. Used as the map-mode target. Defaults to the origin. */
  earthCentre?: THREE.Vector3;
  /** Scene-space height of the pad surface. Defaults to 0. */
  groundY?: number;
}

export interface CameraRig {
  /** Switch mode. The camera is re-placed on the next update. */
  setMode(mode: CameraMode, rocketLength: number): void;
  update(dt: number, ctx: CameraContext): void;
  setEnabled(on: boolean): void;
  readonly mode: CameraMode;
}

const PAD_DISTANCE_L = 4;
const PAD_EYE_HEIGHT = 1.5; // m above the pad surface
const PAD_FOLLOW_RATE = 3; // 1/s, how quickly the pad view tracks the rocket
const CHASE_DISTANCE_L = 6;
const MAP_DISTANCE = 2e7; // m
const MAP_MAX_DISTANCE = 1e12; // m, far enough to see the solar system

const Y_UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();

/** Unit vector perpendicular to the unit vector u. */
function perpendicular(u: THREE.Vector3): THREE.Vector3 {
  const helper = Math.abs(u.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3().crossVectors(u, helper).normalize();
}

export function createCameraRig(camera: THREE.PerspectiveCamera, dom: HTMLElement): CameraRig {
  const controls = new OrbitControls(camera, dom);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.target.set(0, 0, 0);

  let mode: CameraMode = 'chase';
  let length = 1;
  let placePending = true;
  const shift = new THREE.Vector3();
  const next = new THREE.Vector3();

  /**
   * OrbitControls dollies multiplicatively, so wheel zoom already scales with distance.
   * Per-mode limits keep each view inside a sensible range.
   */
  function applyLimits(): void {
    controls.enabled = mode !== 'onboard';
    switch (mode) {
      case 'pad':
        controls.minDistance = 0.5;
        controls.maxDistance = 5e4;
        controls.zoomSpeed = 1;
        break;
      case 'chase':
        controls.minDistance = 0.2;
        controls.maxDistance = 5e4;
        controls.zoomSpeed = 1;
        break;
      case 'map':
        controls.minDistance = 1e5;
        controls.maxDistance = MAP_MAX_DISTANCE;
        controls.zoomSpeed = 1.5;
        break;
      case 'onboard':
        controls.minDistance = 0;
        controls.maxDistance = Infinity;
        break;
    }
  }

  /** Move the target and carry the camera with it, keeping the orbit offset. */
  function moveTargetTo(p: THREE.Vector3): void {
    shift.copy(p).sub(controls.target);
    controls.target.copy(p);
    camera.position.add(shift);
  }

  /** One-off placement when the mode changes. */
  function place(ctx: CameraContext): void {
    const L = length;
    camera.up.copy(Y_UP);
    switch (mode) {
      case 'pad':
        controls.target.copy(ctx.nose);
        camera.position.set(0, (ctx.groundY ?? 0) + PAD_EYE_HEIGHT, PAD_DISTANCE_L * L);
        break;
      case 'chase':
        controls.target.copy(ZERO);
        camera.position.set(0, 0.5 * L, CHASE_DISTANCE_L * L);
        break;
      case 'map': {
        const earth = ctx.earthCentre ?? ZERO;
        controls.target.copy(earth);
        camera.position.copy(earth).add(new THREE.Vector3(0, 0, MAP_DISTANCE));
        break;
      }
      case 'onboard':
        break;
    }
  }

  /** Pinned camera just outside the body, looking along the nose. */
  function placeOnboard(ctx: CameraContext): void {
    const f = ctx.up.lengthSq() > 0 ? ctx.up.clone().normalize() : Y_UP.clone();
    const s = perpendicular(f);
    camera.up.copy(s);
    camera.position
      .copy(ctx.nose)
      .addScaledVector(f, -0.3 * length)
      .addScaledVector(s, 0.1 * length);
    camera.lookAt(next.copy(ctx.nose).addScaledVector(f, 2 * length));
  }

  function update(dt: number, ctx: CameraContext): void {
    if (placePending) {
      place(ctx);
      placePending = false;
    }
    if (mode === 'onboard') {
      placeOnboard(ctx);
      return;
    }
    if (mode === 'pad') {
      const k = 1 - Math.exp(-PAD_FOLLOW_RATE * Math.max(dt, 0));
      next.copy(controls.target).lerp(ctx.nose, k);
      moveTargetTo(next);
    } else if (mode === 'map') {
      moveTargetTo(ctx.earthCentre ?? ZERO);
    } else {
      moveTargetTo(ZERO);
    }
    controls.update();
  }

  function setMode(nextMode: CameraMode, rocketLength: number): void {
    mode = nextMode;
    length = Math.max(rocketLength, 1e-3);
    camera.up.copy(Y_UP);
    applyLimits();
    placePending = true;
  }

  return {
    setMode,
    update,
    setEnabled(on: boolean) {
      controls.enabled = on;
    },
    get mode() {
      return mode;
    },
  };
}
