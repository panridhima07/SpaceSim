// Three.js 3D viewport for Build Mode.
// Reuses buildRocketMesh and buildCgCpMarkers on a neutral dark-slate studio
// background with a vertical height ruler.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Component, RocketModel } from '../types';
import type { SnapPoint } from './snap';
import { buildCgCpMarkers, buildRocketMesh, disposeGroup } from '../render/rocketMesh';
import { applyFlatStyle } from '../render/effects';
import { buildBuildStand } from '../render/buildStand';
import { buildGhostPart, buildJointCollar, buildSnapSocket, playSnapPop } from '../render/parts/connectors';
import { aftRadiusOf, foreRadiusOf, isExternal } from './design';

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
  /**
   * Bring the whole rocket into view. With `keepAngle` the camera keeps the direction the
   * user turned it to and only re-centres and backs off as far as needed.
   */
  frameRocket(keepAngle?: boolean): void;
  /** Raycast the rocket mesh at client coordinates and return the hit component id, or null. */
  pickPart(clientX: number, clientY: number): string | null;
  /**
   * Render 3D snap sockets at valid snap points. With `ghost`, a see-through preview of
   * that part is shown at the hovered snap point.
   */
  setSnapPoints(snaps: SnapPoint[], hoveredId?: string | null, ghost?: Component | null): void;
  /**
   * Pick the snap point under client coordinates (generous hit sphere for touch).
   * `maxDist` is how far (px) the pointer may be from a ring and still catch it; pass
   * Infinity to always return the closest ring (used while dragging a part).
   */
  pickSnapPoint(clientX: number, clientY: number, maxDist?: number): SnapPoint | null;
  /** Move the camera toward (factor < 1) or away from (factor > 1) the rocket. */
  zoomBy(factor: number): void;
  /** Metres along the rocket axis covered by one screen pixel at the current zoom. */
  metersPerPixel(): number;
  /** Capture a small thumbnail data URL of the current build scene. */
  captureThumbnail(renderer: THREE.WebGLRenderer): string | undefined;
  /** True while a view-driven animation (joint pop) needs continuous rendering. */
  isAnimating?(): boolean;
  dispose(): void;
}

const BG_COLOR = 0x0b0b0d;
const RULER_COLOR = 0x4da3ff;
const GRID_MAIN = 0x2c2c31;
const GRID_SUB = 0x19191c;
const SELECT_EMISSIVE = new THREE.Color(0x1f5f99);
/** How long the click-together pop of a new joint lasts, ms. */
const POP_MS = 240;

/** Shared ruler-label textures keyed by text; never disposed per sprite. */
const LABEL_CACHE_MAX = 200;
const labelTextures = new Map<string, THREE.CanvasTexture>();

function disposeLabelTextures(): void {
  for (const t of labelTextures.values()) t.dispose();
  labelTextures.clear();
}

function labelTexture(text: string): THREE.CanvasTexture {
  const hit = labelTextures.get(text);
  if (hit) return hit;
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
  if (labelTextures.size >= LABEL_CACHE_MAX) {
    const oldest = labelTextures.keys().next().value;
    if (oldest !== undefined) {
      labelTextures.get(oldest)?.dispose();
      labelTextures.delete(oldest);
    }
  }
  labelTextures.set(text, tex);
  return tex;
}

function makeLabelSprite(text: string): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({ map: labelTexture(text), transparent: true, depthTest: false });
  return new THREE.Sprite(mat);
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
  let standGroup: THREE.Group | null = null;
  let snapGroup: THREE.Group | null = null;
  let activeSnaps: SnapPoint[] = [];
  let rocketLengthActual = 0;
  let currentLength = 0.4;
  let currentMaxR = 0.02;
  let hasFramed = false;
  let collars: THREE.Group[] = [];
  let knownIds: Set<string> | null = null;
  let popIds = new Set<string>();
  let popStart = 0;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function frameRocket(keepAngle = false): void {
    const h = Math.max(currentLength, 0.25);
    const midY = h * 0.5;
    const dist = Math.max(h * 1.75, currentMaxR * 12, 0.45);
    if (keepAngle && hasFramed) {
      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() > 1e-9) {
        dir.setLength(dist);
        controls.target.set(0, midY, 0);
        camera.position.copy(controls.target).add(dir);
        controls.update();
        return;
      }
    }
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

    if (standGroup) {
      scene.remove(standGroup);
      disposeGroup(standGroup);
      standGroup = null;
    }

    rocketLengthActual = rocket.length;
    currentLength = Math.max(rocket.length, 0.1);
    currentMaxR = Math.max(rocket.maxRadius, 0.012);

    const body = buildRocketMesh(rocket, { cutaway });

    // A coupler band at every joint between stacked parts, so they read as clicked together.
    collars = [];
    const stack = rocket.components.filter(isExternal).sort((a, b) => a.x - b.x);
    for (let i = 0; i + 1 < stack.length; i++) {
      const fore = stack[i];
      const aft = stack[i + 1];
      const joint = fore.x + fore.length;
      if (Math.abs(joint - aft.x) > 1e-4) continue;
      const r = Math.min(aftRadiusOf(fore), foreRadiusOf(aft));
      if (!(r > 0)) continue;
      const collar = buildJointCollar(r, 'ok');
      collar.position.y = -joint;
      collar.userData.partIds = [fore.id, aft.id];
      collars.push(collar);
      body.add(collar);
    }
    // Parts that were not there last time pop as they click in.
    const ids = new Set(rocket.components.map((c) => c.id));
    if (knownIds) {
      const added = [...ids].filter((id) => !knownIds!.has(id));
      if (added.length > 0 && added.length <= 2) {
        popIds = new Set(added);
        popStart = performance.now();
      }
    }
    knownIds = ids;

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

    // Launch pad under the tail; its rod stands in the gap between fins.
    standGroup = buildBuildStand({ maxRadius: currentMaxR, rocketLength: currentLength });
    applyFlatStyle(standGroup);
    standGroup.rotation.y = 0.9;
    scene.add(standGroup);

    // Resize floor grid proportionally to rocket size; the pad's feet stand on it.
    const gridScale = Math.max(0.4, Math.min(8, currentLength * 2.5));
    grid.scale.set(gridScale, 1, gridScale);
    grid.position.y = new THREE.Box3().setFromObject(standGroup).min.y;

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

  function setSnapPoints(snaps: SnapPoint[], hoveredId: string | null = null, ghost: Component | null = null): void {
    activeSnaps = snaps;
    if (snapGroup) {
      scene.remove(snapGroup);
      disposeGroup(snapGroup);
      snapGroup = null;
    }
    if (snaps.length === 0) return;

    const grp = new THREE.Group();
    grp.name = 'snap-points';
    for (const s of snaps) {
      const y = rocketLengthActual - s.stationX;
      const isHovered = hoveredId === s.id;
      const ringR = Math.max(s.radius * 1.18, 0.016);
      const socket = buildSnapSocket(s.radius, {
        kind: s.kind === 'inside' ? 'internal' : 'external',
        state: isHovered ? 'hover' : s.diameterMatch ? 'idle' : 'mismatch',
      });
      socket.position.y = y;
      grp.add(socket);

      if (isHovered && ghost) {
        const preview = buildGhostPart(ghost, {
          color: s.diameterMatch ? 0x3ddc97 : 0xf2b84b,
          hostRadius: s.radius,
        });
        // On top of the stack the new part sits above the nose; elsewhere it hangs from the joint.
        const len = Number.isFinite(ghost.length) ? Math.max(ghost.length, 0) : 0;
        preview.position.y = s.kind === 'top' ? y + len : y;
        grp.add(preview);
      }

      // Generous invisible hit sphere for effortless touch tapping & drag-over.
      const hitR = Math.max(ringR * 1.7, currentLength * 0.09, 0.032);
      const hitGeo = new THREE.SphereGeometry(hitR, 12, 8);
      const hitMat = new THREE.MeshBasicMaterial({ visible: false });
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.y = y;
      hit.userData.snap = s;
      grp.add(hit);
    }
    snapGroup = grp;
    scene.add(grp);
  }

  function pickSnapPoint(clientX: number, clientY: number, maxDist = 56): SnapPoint | null {
    if (!snapGroup || activeSnaps.length === 0) return null;
    const rect = domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(snapGroup.children, false);
    for (const h of hits) {
      const snap = h.object.userData?.snap as SnapPoint | undefined;
      if (snap) return snap;
    }
    // Fallback: closest snap point projected to screen within maxDist px.
    let best: SnapPoint | null = null;
    let bestDist = maxDist;
    const v = new THREE.Vector3();
    for (const s of activeSnaps) {
      v.set(0, rocketLengthActual - s.stationX, 0).project(camera);
      const sx = rect.left + ((v.x + 1) * 0.5) * rect.width;
      const sy = rect.top + ((-v.y + 1) * 0.5) * rect.height;
      const d = Math.hypot(clientX - sx, clientY - sy);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  function zoomBy(factor: number): void {
    const offset = camera.position.clone().sub(controls.target);
    const dist = Math.min(controls.maxDistance, Math.max(controls.minDistance, offset.length() * factor));
    offset.setLength(dist);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }

  function metersPerPixel(): number {
    const rect = domElement.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    const dist = camera.position.distanceTo(controls.target);
    const visible = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    return visible / rect.height;
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
    if (popIds.size > 0) {
      const t = (performance.now() - popStart) / POP_MS;
      for (const c of collars) {
        if ((c.userData.partIds as string[]).some((id) => popIds.has(id))) playSnapPop(c, t);
      }
      if (t >= 1) popIds = new Set();
    }
    renderer.render(scene, camera);
  }

  function captureThumbnail(renderer: THREE.WebGLRenderer): string | undefined {
    try {
      controls.update();
      renderer.render(scene, camera);
      const src = renderer.domElement;
      const w = 160;
      const h = 120;
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) return undefined;
      ctx.fillStyle = '#0c1320';
      ctx.fillRect(0, 0, w, h);
      const aspect = src.width / Math.max(src.height, 1);
      let dw = w;
      let dh = h;
      let dx = 0;
      let dy = 0;
      if (aspect > w / h) {
        dw = h * aspect;
        dx = (w - dw) / 2;
      } else {
        dh = w / aspect;
        dy = (h - dh) / 2;
      }
      ctx.drawImage(src, dx, dy, dw, dh);
      return out.toDataURL('image/jpeg', 0.72);
    } catch {
      return undefined;
    }
  }

  function dispose(): void {
    controls.dispose();
    if (rocketGroup) disposeGroup(rocketGroup);
    if (rulerGroup) disposeGroup(rulerGroup);
    if (standGroup) disposeGroup(standGroup);
    if (snapGroup) disposeGroup(snapGroup);
    disposeLabelTextures();
  }

  function isAnimating(): boolean {
    return popIds.size > 0;
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
    setSnapPoints,
    pickSnapPoint,
    zoomBy,
    metersPerPixel,
    captureThumbnail,
    isAnimating,
    dispose,
  };
}
