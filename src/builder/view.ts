// Three.js 3D viewport for Build Mode.
// Reuses buildRocketMesh and buildCgCpMarkers on a neutral dark-slate studio
// background with a vertical height ruler.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { RocketModel } from '../types';
import { buildCgCpMarkers, buildRocketMesh, disposeGroup } from '../render/rocketMesh';
import { applyFlatStyle } from '../render/effects';

export interface BuilderViewUpdate {
  rocket: RocketModel;
  cutaway?: boolean;
  cgX?: number;
  cpX?: number;
  selectedId?: string | null;
  refitCamera?: boolean;
}

export interface BuilderView {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  updateRocket(opts: BuilderViewUpdate): void;
  setEnabled(on: boolean): void;
  resize(width: number, height: number): void;
  render(renderer: THREE.WebGLRenderer): void;
  frameRocket(): void;
  /** Raycast the rocket mesh at client coordinates and return the hit component id, or null. */
  pickPart(clientX: number, clientY: number): string | null;
  dispose(): void;
}

const BG_COLOR = 0x0c1320;
const RULER_COLOR = 0x4da3ff;
const GRID_MAIN = 0x24344d;
const GRID_SUB = 0x162234;
const SELECT_EMISSIVE = new THREE.Color(0x1f5f99);

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 40;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '600 22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = '#9cc6f0';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width - 8, canvas.height / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  return sprite;
}

function buildRuler(height: number, maxRadius: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'height-ruler';

  const h = Math.max(0.3, Math.ceil(height * 10) / 10 + 0.1);
  const offsetX = -(Math.max(maxRadius * 2.6, 0.08));

  // Choose nice tick spacing: 5 cm, 10 cm, 25 cm, 50 cm, or 1 m.
  let step = 0.05;
  if (h > 0.6) step = 0.1;
  if (h > 1.5) step = 0.25;
  if (h > 3.0) step = 0.5;
  if (h > 6.0) step = 1.0;

  const tickLen = Math.max(0.012, h * 0.028);
  const linePts: THREE.Vector3[] = [
    new THREE.Vector3(offsetX, 0, 0),
    new THREE.Vector3(offsetX, h, 0),
  ];

  const count = Math.floor(h / step + 1e-6);
  for (let i = 0; i <= count; i++) {
    const y = i * step;
    const major = i % 2 === 0;
    const len = major ? tickLen * 1.4 : tickLen * 0.75;
    linePts.push(new THREE.Vector3(offsetX - len, y, 0), new THREE.Vector3(offsetX, y, 0));

    if (major) {
      const label = h >= 1.5 ? `${y.toFixed(2)}m` : `${Math.round(y * 100)}cm`;
      const sp = makeLabelSprite(label);
      const scaleH = Math.max(0.022, h * 0.048);
      sp.scale.set(scaleH * 3.2, scaleH, 1);
      sp.position.set(offsetX - len - scaleH * 1.55, y, 0);
      group.add(sp);
    }
  }

  const geom = new THREE.BufferGeometry().setFromPoints(linePts);
  const mat = new THREE.LineBasicMaterial({ color: RULER_COLOR, transparent: true, opacity: 0.65 });
  group.add(new THREE.LineSegments(geom, mat));
  return group;
}

export function createBuilderView(domElement: HTMLElement): BuilderView {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG_COLOR);

  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.005, 500);
  camera.position.set(0.3, 0.25, 0.75);

  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enabled = false;
  controls.minDistance = 0.08;
  controls.maxDistance = 30;
  controls.target.set(0, 0.2, 0);

  // Neutral studio lighting.
  const hemi = new THREE.HemisphereLight(0xdcebff, 0x1b2638, 1.1);
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(2, 4, 3);
  const rim = new THREE.DirectionalLight(0x7fb8ff, 0.5);
  rim.position.set(-3, 2, -2);
  scene.add(hemi, key, rim);

  // Studio floor grid at y = 0.
  const grid = new THREE.GridHelper(2, 20, GRID_MAIN, GRID_SUB);
  scene.add(grid);

  let rocketGroup: THREE.Group | null = null;
  let markers: ReturnType<typeof buildCgCpMarkers> | null = null;
  let rulerGroup: THREE.Group | null = null;
  let currentLength = 0.4;
  let currentMaxR = 0.02;
  let hasFramed = false;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function frameRocket(): void {
    const h = Math.max(currentLength, 0.25);
    const midY = h * 0.5;
    const dist = Math.max(h * 1.75, currentMaxR * 12, 0.45);
    controls.target.set(0, midY, 0);
    camera.position.set(dist * 0.22, midY + dist * 0.12, dist);
    controls.update();
    hasFramed = true;
  }

  function applySelectionHighlight(group: THREE.Group, selectedId: string | null): void {
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat || !('emissive' in mat)) return;
      if (selectedId && mesh.name === selectedId) {
        mat.emissive.copy(SELECT_EMISSIVE);
        mat.emissiveIntensity = 0.55;
      } else {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
      }
    });
  }

  function updateRocket(opts: BuilderViewUpdate): void {
    const { rocket, cutaway = false, cgX, cpX, selectedId = null, refitCamera = false } = opts;

    if (rocketGroup) {
      scene.remove(rocketGroup);
      disposeGroup(rocketGroup);
      rocketGroup = null;
      markers = null;
    }
    if (rulerGroup) {
      scene.remove(rulerGroup);
      disposeGroup(rulerGroup);
      rulerGroup = null;
    }

    currentLength = Math.max(rocket.length, 0.1);
    currentMaxR = Math.max(rocket.maxRadius, 0.012);

    const body = buildRocketMesh(rocket, { cutaway });
    applyFlatStyle(body);
    // Stand rocket upright with aft end on the y = 0 floor.
    body.position.y = rocket.length;
    applySelectionHighlight(body, selectedId);

    if (rocket.components.length > 0 && Number.isFinite(cgX) && Number.isFinite(cpX)) {
      markers = buildCgCpMarkers(currentMaxR);
      markers.update(cgX as number, cpX as number);
      body.add(markers.group);
    }

    rocketGroup = body;
    scene.add(body);

    rulerGroup = buildRuler(currentLength, currentMaxR);
    scene.add(rulerGroup);

    // Resize floor grid proportionally to rocket size.
    const gridScale = Math.max(0.4, Math.min(8, currentLength * 2.5));
    grid.scale.set(gridScale, 1, gridScale);

    if (!hasFramed || refitCamera) {
      frameRocket();
    }
  }

  function pickPart(clientX: number, clientY: number): string | null {
    if (!rocketGroup) return null;
    const rect = domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(rocketGroup.children, true);
    for (const h of hits) {
      const comp = h.object.userData?.component as { id?: string } | undefined;
      if (comp?.id) return comp.id;
    }
    return null;
  }

  function setEnabled(on: boolean): void {
    controls.enabled = on;
    if (on) controls.update();
  }

  function resize(width: number, height: number): void {
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  }

  function render(renderer: THREE.WebGLRenderer): void {
    controls.update();
    renderer.render(scene, camera);
  }

  function dispose(): void {
    controls.dispose();
    if (rocketGroup) disposeGroup(rocketGroup);
    if (rulerGroup) disposeGroup(rulerGroup);
  }

  return {
    scene,
    camera,
    updateRocket,
    setEnabled,
    resize,
    render,
    frameRocket,
    pickPart,
    dispose,
  };
}
