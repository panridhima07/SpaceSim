// Camera rig for the flight view. Four modes built on OrbitControls.
//
// All positions are in scene space (physics world minus the floating origin). Chase and map
// anchor on the scene origin (the rocket CG) and on Earth's centre respectively: the target is
// re-anchored every frame and the camera moves with it, so the user's orbit offset is kept.
//
// Pad is a ground observer. The camera stays where it stands (only user orbit/zoom moves it)
// and turns to follow the nose. The aim lags, so the rocket visibly climbs in frame, but is
// never allowed to drift far from the centre. As the rocket recedes the lens narrows. The orbit
// target sits a short way along the line of sight rather than on the rocket, so OrbitControls'
// distance limits and zoom never haul the camera toward a rocket kilometres away.

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
const PAD_MIN_HEIGHT = 0.1; // m, orbit and zoom cannot push the pad camera into the ground
const PAD_FOLLOW_RATE = 3; // 1/s, how quickly the pad view turns after the rocket
/** The nose never sits further than this share of the (smaller) half field of view off centre. */
export const PAD_MAX_OFF_CENTRE = 0.6;
const PAD_LENS_START = 3; // the lens narrows beyond this many stand-off distances
export const PAD_MIN_FOV = 2; // degrees, the longest lens: a 37 cm rocket stays visible at 200 m
const PAD_LENS_RATE = 2; // 1/s, how quickly the lens follows
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

/** tan of half a field of view given in degrees. */
function halfTan(fovDeg: number): number {
  return Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
}

export function createCameraRig(camera: THREE.PerspectiveCamera, dom: HTMLElement): CameraRig {
  const controls = new OrbitControls(camera, dom);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.target.set(0, 0, 0);

  const baseFov = camera.fov;
  let mode: CameraMode = 'pad';
  let length = 1;
  let placePending = true;
  /** Pad orbit radius as placed; a different radius later means the user has zoomed. */
  let padRadius = 1;
  const shift = new THREE.Vector3();
  const next = new THREE.Vector3();
  const want = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const axis = new THREE.Vector3();

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

  function setFov(fov: number): void {
    if (Math.abs(camera.fov - fov) < 1e-3) return;
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  /** Move the target and carry the camera with it, keeping the orbit offset. */
  function moveTargetTo(p: THREE.Vector3): void {
    shift.copy(p).sub(controls.target);
    controls.target.copy(p);
    camera.position.add(shift);
  }

  /**
   * Lens for a rocket `distance` away: the base field of view near the pad, narrowing as the
   * rocket recedes. User zoom also acts on the long lens, where moving the camera shows little.
   */
  function padFov(distance: number, orbitRadius: number): number {
    const wide = halfTan(baseFov);
    const standOff = Math.hypot(PAD_DISTANCE_L * length, PAD_EYE_HEIGHT);
    const long = halfTan(Math.min(PAD_MIN_FOV, baseFov));
    const reach = (PAD_LENS_START * standOff) / Math.max(distance, 1e-6);
    const auto = THREE.MathUtils.clamp(wide * reach, long, wide);
    const zoom = 1 + (orbitRadius / padRadius - 1) * (1 - auto / wide);
    const t = THREE.MathUtils.clamp(auto * zoom, long, wide);
    return THREE.MathUtils.radToDeg(2 * Math.atan(t));
  }

  /** Apply user orbit/zoom, then turn from wherever the camera now stands toward the nose. */
  function followFromPad(dt: number, ctx: CameraContext): void {
    controls.update();
    const radius = camera.position.distanceTo(controls.target);
    aim.copy(controls.target).sub(camera.position).normalize();
    camera.position.y = Math.max(camera.position.y, (ctx.groundY ?? 0) + PAD_MIN_HEIGHT);

    want.copy(ctx.nose).sub(camera.position);
    const distance = want.length();
    const k = 1 - Math.exp(-PAD_LENS_RATE * dt);
    setFov(camera.fov + (padFov(distance, radius) - camera.fov) * k);

    if (distance > 1e-6) {
      want.divideScalar(distance);
      // The narrower of the two half angles, so portrait screens keep the rocket too.
      const t = halfTan(camera.fov) * Math.min(1, camera.aspect);
      const limit = PAD_MAX_OFF_CENTRE * Math.atan(t);
      const off = Math.min(aim.angleTo(want) * Math.exp(-PAD_FOLLOW_RATE * dt), limit);
      axis.crossVectors(want, aim);
      if (axis.lengthSq() < 1e-20) axis.copy(perpendicular(want));
      aim.copy(want).applyAxisAngle(axis.normalize(), off);
    }
    controls.target.copy(camera.position).addScaledVector(aim, radius);
    camera.lookAt(controls.target);
  }

  /** One-off placement when the mode changes. */
  function place(ctx: CameraContext): void {
    const L = length;
    camera.up.copy(Y_UP);
    switch (mode) {
      case 'pad': {
        camera.position.set(0, (ctx.groundY ?? 0) + PAD_EYE_HEIGHT, PAD_DISTANCE_L * L);
        aim.copy(ctx.nose).sub(camera.position);
        const distance = aim.length();
        // On the pad the orbit target is the nose itself; mid-flight it stays near the camera.
        padRadius = Math.max(
          0.5,
          Math.min(distance, Math.hypot(PAD_DISTANCE_L * L, PAD_EYE_HEIGHT + L)),
        );
        controls.target.copy(camera.position).addScaledVector(aim.normalize(), padRadius);
        setFov(padFov(distance, padRadius));
        break;
      }
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
      followFromPad(Math.max(dt, 0), ctx);
      return;
    }
    moveTargetTo(mode === 'map' ? (ctx.earthCentre ?? ZERO) : ZERO);
    controls.update();
  }

  function setMode(nextMode: CameraMode, rocketLength: number): void {
    mode = nextMode;
    length = Math.max(rocketLength, 1e-3);
    camera.up.copy(Y_UP);
    if (mode !== 'pad') setFov(baseFov);
    applyLimits();
    placePending = true;
  }

  applyLimits();

  return {
    setMode,
    update,
    setEnabled(on: boolean) {
      // The onboard view is pinned to the rocket: dragging must not build up for the next view.
      controls.enabled = on && mode !== 'onboard';
    },
    get mode() {
      return mode;
    },
  };
}
