// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createCameraRig, PAD_MAX_OFF_CENTRE, PAD_MIN_FOV, type CameraContext } from './cameras';

const FOV = 50;
const DT = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);

/** A model rocket on the pad: pad surface at -padLift, nose one length above it. */
function setup(length = 0.5, aspect = 16 / 9) {
  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.01, 1e13);
  const dom = document.createElement('div');
  const rig = createCameraRig(camera, dom);
  const groundY = -0.6 * length;
  const nose = new THREE.Vector3(0, groundY + length, 0);
  const ctx: CameraContext = { nose, up: UP, groundY };
  rig.setMode('pad', length);
  rig.update(DT, ctx);
  return { camera, rig, ctx, nose, dom, groundY };
}

/** Angle between the view centre and a point, as a share of the smaller half field of view. */
function offCentre(camera: THREE.PerspectiveCamera, p: THREE.Vector3): number {
  const view = camera.getWorldDirection(new THREE.Vector3());
  const angle = view.angleTo(p.clone().sub(camera.position));
  const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * Math.min(1, camera.aspect));
  return angle / half;
}

describe('camera rig', () => {
  it('starts in pad mode', () => {
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1e13);
    expect(createCameraRig(camera, document.createElement('div')).mode).toBe('pad');
  });

  for (const [name, aspect] of [['landscape', 16 / 9], ['portrait', 9 / 19.5]] as const) {
    it(`pad view keeps a 100 m/s climb in frame from a fixed spot (${name})`, () => {
      const { camera, rig, ctx, nose, groundY } = setup(0.5, aspect);
      const stand = camera.position.clone();
      const y0 = nose.y;
      let worst = 0;
      const samples: Record<number, number> = {};
      let lastFov = camera.fov;
      for (let i = 1; i <= 1200; i++) {
        const t = i * DT;
        // 10 g up to 100 m/s, then steady, with a little wind drift.
        const h = t < 1 ? 50 * t * t : 50 + 100 * (t - 1);
        nose.set(0.05 * h, y0 + h, -0.02 * h);
        rig.update(DT, ctx);
        camera.updateMatrixWorld();
        const off = offCentre(camera, nose);
        worst = Math.max(worst, off);
        if (i === 6 || i === 30) samples[i] = off;
        // No jumps in the lens.
        expect(Math.abs(camera.fov - lastFov)).toBeLessThan(1.5);
        lastFov = camera.fov;
        // Inside the frustum.
        const ndc = nose.clone().project(camera);
        expect(Math.abs(ndc.x)).toBeLessThan(1);
        expect(Math.abs(ndc.y)).toBeLessThan(1);
      }
      expect(worst).toBeLessThanOrEqual(PAD_MAX_OFF_CENTRE + 1e-6);
      // It climbs in frame rather than being pinned to the centre.
      expect(samples[6]).toBeGreaterThan(0.02);
      expect(samples[30]).toBeGreaterThan(samples[6] - 1e-6);
      expect(samples[6]).toBeLessThanOrEqual(PAD_MAX_OFF_CENTRE + 1e-6);
      expect(camera.position.distanceTo(stand)).toBeLessThan(1e-6);
      expect(camera.position.y).toBeGreaterThan(groundY);
      expect(camera.fov).toBeCloseTo(PAD_MIN_FOV, 1);
    });
  }

  it('does not pull the camera toward a rocket beyond maxDistance', () => {
    const { camera, rig, ctx, nose } = setup();
    const stand = camera.position.clone();
    nose.set(40_000, 120_000, -10_000);
    for (let i = 0; i < 300; i++) rig.update(DT, ctx);
    camera.updateMatrixWorld();
    expect(camera.position.distanceTo(stand)).toBeLessThan(1e-6);
    expect(offCentre(camera, nose)).toBeLessThan(0.01);
  });

  it('switching to pad mid-flight stands on the ground and aims straight at the rocket', () => {
    const { camera, rig, ctx, nose, groundY } = setup();
    nose.set(30, 400, 5);
    rig.setMode('pad', 0.5);
    rig.update(DT, ctx);
    camera.updateMatrixWorld();
    expect(camera.position.x).toBeCloseTo(0, 9);
    expect(camera.position.y).toBeCloseTo(groundY + 1.5, 9);
    expect(camera.position.z).toBeCloseTo(2, 9);
    expect(offCentre(camera, nose)).toBeLessThan(0.01);
    expect(camera.fov).toBeCloseTo(PAD_MIN_FOV, 1);
  });

  it('wheel zoom still works and never puts the camera underground', () => {
    const { camera, rig, ctx, nose, dom, groundY } = setup();
    nose.set(0, 800, -20);
    for (let i = 0; i < 300; i++) rig.update(DT, ctx);
    const stand = camera.position.clone();
    const fov = camera.fov;
    for (let i = 0; i < 20; i++) {
      dom.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    }
    for (let i = 0; i < 300; i++) rig.update(DT, ctx);
    camera.updateMatrixWorld();
    expect(camera.fov).toBeGreaterThan(fov + 3);
    expect(camera.position.y).toBeGreaterThanOrEqual(groundY + 0.1 - 1e-9);
    expect(camera.position.distanceTo(stand)).toBeLessThan(10);
    expect(offCentre(camera, nose)).toBeLessThan(0.01);
  });

  it('restores the base field of view in every other mode', () => {
    for (const mode of ['chase', 'onboard', 'map'] as const) {
      const { camera, rig, ctx, nose } = setup();
      nose.set(0, 2000, 0);
      for (let i = 0; i < 300; i++) rig.update(DT, ctx);
      expect(camera.fov).toBeLessThan(FOV);
      rig.setMode(mode, 0.5);
      rig.update(DT, ctx);
      expect(camera.fov).toBe(FOV);
    }
  });
});
