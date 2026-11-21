// Measures a built rocket mesh against the RocketModel it was built from.
// Every check is geometric: it reads vertex positions, never the builder's own inputs.

import * as THREE from 'three';
import type { Component, FinSet, RocketModel } from '../types';
import { airframeOutline, surfaceRadiusAt } from '../render/parts/profile';

export type FindingLevel = 'fault' | 'warn';

export interface Finding {
  level: FindingLevel;
  /** Short stable code, e.g. 'nan-vertex', 'axial-extent'. */
  code: string;
  /** Component id, or '' for whole-rocket findings. */
  component: string;
  detail: string;
}

interface Extent {
  yMin: number;
  yMax: number;
  rMin: number;
  rMax: number;
  vertices: number;
  triangles: number;
  nan: number;
}

function emptyExtent(): Extent {
  return { yMin: Infinity, yMax: -Infinity, rMin: Infinity, rMax: -Infinity, vertices: 0, triangles: 0, nan: 0 };
}

function isDetail(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData?.detail) return true;
  return false;
}

/** Extent of every mesh that satisfies `pick`, in the rocket frame. */
export function measure(root: THREE.Object3D, pick: (m: THREE.Mesh) => boolean): Extent {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const e = emptyExtent();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !pick(mesh)) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const index = mesh.geometry.getIndex();
    e.triangles += Math.floor((index ? index.count : pos.count) / 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
        e.nan++;
        continue;
      }
      e.vertices++;
      const r = Math.hypot(v.x, v.z);
      if (v.y < e.yMin) e.yMin = v.y;
      if (v.y > e.yMax) e.yMax = v.y;
      if (r < e.rMin) e.rMin = r;
      if (r > e.rMax) e.rMax = r;
    }
  });
  return e;
}

function near(a: number, b: number, scale: number, tol: number): boolean {
  return Math.abs(a - b) <= tol * Math.max(scale, 1e-9);
}

const mm = (v: number): string => `${(v * 1000).toFixed(2)} mm`;

/** Outer radius of the airframe at a station. NaN off the rocket. */
export function bodyRadiusAt(rocket: RocketModel, x: number): number {
  return surfaceRadiusAt(airframeOutline(rocket), x);
}

/** Area of one fin's outline, m^2. Zero for a fin that cannot be drawn. */
function planformArea(c: FinSet): number {
  if (c.finShape === 'freeform') {
    const p = c.points ?? [];
    if (p.length < 3) return 0;
    let a = 0;
    for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
    return Math.abs(a) / 2;
  }
  if (c.finShape === 'elliptical') return (Math.PI / 4) * c.rootChord * c.span;
  return 0.5 * (c.rootChord + c.tipChord) * c.span;
}

/** Axial span of one fin's outline, metres aft of the root leading edge: [fore, aft]. */
function finAxialSpan(c: FinSet): [number, number] {
  if (c.finShape === 'freeform' && c.points && c.points.length >= 3) {
    return [Math.min(...c.points.map((q) => q[0])), Math.max(...c.points.map((q) => q[0]))];
  }
  if (c.finShape === 'elliptical') return [0, c.rootChord];
  return [Math.min(0, c.sweepLength), Math.max(c.rootChord, c.sweepLength + c.tipChord)];
}

function isVisibleOutside(c: Component): boolean {
  switch (c.kind) {
    case 'nosecone':
    case 'bodytube':
    case 'transition':
    case 'finset':
      return true;
    case 'ring':
      return !!c.external;
    case 'innertube':
      return (!!c.radialCount && c.radialCount >= 2 && !!c.radialOffset) || (c.isMotorMount && !!c.motor);
    default:
      return false;
  }
}

/** Aft-most station anything on the rocket reaches, including motor overhang and side bodies. */
export function trueAftStation(rocket: RocketModel): number {
  let aft = 0;
  for (const c of [...rocket.components, ...(rocket.sideBodies ?? []).flatMap((sb) => sb.components)]) {
    if (c.kind === 'nosecone' || c.kind === 'bodytube' || c.kind === 'transition') {
      aft = Math.max(aft, c.x + c.length);
    } else if (c.kind === 'finset') {
      if (c.span > 0 && c.rootChord > 0) aft = Math.max(aft, c.x + finAxialSpan(c)[1]);
    } else if (c.kind === 'innertube') {
      // A tube or motor that sticks out of the back of the airframe is part of the outside.
      aft = Math.max(aft, c.x + c.length + (c.isMotorMount && c.motor ? Math.max(0, c.overhang) : 0));
    }
  }
  return aft;
}

export interface AuditOptions {
  cutaway?: boolean;
  /** Relative tolerance on dimensions. Default 2%. */
  tol?: number;
  /** Triangle ceiling for the whole rocket. Default 400k. */
  maxTriangles?: number;
}

/** Compare a mesh with its model. An empty result means the render is dimensionally right. */
export function auditRender(rocket: RocketModel, root: THREE.Object3D, opts: AuditOptions = {}): Finding[] {
  const tol = opts.tol ?? 0.02;
  const out: Finding[] = [];
  const add = (level: FindingLevel, code: string, component: string, detail: string): void => {
    out.push({ level, code, component, detail });
  };

  const whole = measure(root, (m) => {
    const c = m.userData.component as Component | undefined;
    // Parts inside the body may legitimately be placed anywhere; only the outside defines the envelope.
    return !!c && (isVisibleOutside(c) || c.kind === 'innertube');
  });
  if (whole.nan > 0) add('fault', 'nan-vertex', '', `${whole.nan} vertices are NaN or infinite.`);
  if (whole.triangles > (opts.maxTriangles ?? 400_000)) {
    add('warn', 'triangle-budget', '', `${whole.triangles} triangles in one rocket.`);
  }

  const scale = Math.max(rocket.length, rocket.maxRadius, 1e-6);

  for (const c of rocket.components) {
    const label = `${c.kind} "${c.name}"`;
    const all = measure(root, (m) => (m.userData.component as Component | undefined)?.id === c.id);
    const core = measure(root, (m) => (m.userData.component as Component | undefined)?.id === c.id && !isDetail(m));
    if (all.nan > 0) add('fault', 'nan-vertex', c.id, `${label}: ${all.nan} bad vertices.`);

    const drawn = core.vertices > 0;
    const shouldDraw = isVisibleOutside(c) || !!opts.cutaway;
    if (!drawn) {
      const degenerate = (!(c.length > 0) && c.kind !== 'mass' && c.kind !== 'parachute') ||
        (c.kind === 'finset' && !(planformArea(c) > 1e-10));
      if (shouldDraw && isVisibleOutside(c) && !degenerate) {
        add('fault', 'not-drawn', c.id, `${label} is visible on the real rocket but nothing was drawn.`);
      }
      continue;
    }

    switch (c.kind) {
      case 'nosecone':
      case 'bodytube':
      case 'transition': {
        if (!near(core.yMax, -c.x, scale, tol * 0.05) || !near(core.yMin, -(c.x + c.length), scale, tol * 0.05)) {
          add('fault', 'axial-extent', c.id,
            `${label} drawn from ${mm(-core.yMax)} to ${mm(-core.yMin)}, model says ${mm(c.x)} to ${mm(c.x + c.length)}.`);
        }
        const r = c.kind === 'nosecone' ? c.baseRadius : c.kind === 'bodytube' ? c.outerRadius : Math.max(c.foreRadius, c.aftRadius);
        if (!near(core.rMax, r, r, tol)) {
          add('fault', 'radius', c.id, `${label} drawn ${mm(core.rMax)} radius, model says ${mm(r)}.`);
        }
        if (all.rMax > r * 1.02 + 1e-9) {
          add('fault', 'detail-proud', c.id, `${label} detail stands ${mm(all.rMax - r)} proud of the surface.`);
        }
        break;
      }
      case 'finset': {
        const tipR = c.bodyRadius + c.span;
        // Cant and thickness move the tip slightly; allow for them.
        const slack = Math.hypot(tipR, c.thickness / 2 + Math.abs(Math.sin(c.cant)) * c.rootChord) - tipR;
        if (Math.abs(core.rMax - tipR) > tol * tipR + slack) {
          add('fault', 'fin-span', c.id, `${label} tip at ${mm(core.rMax)} radius, model says ${mm(tipR)}.`);
        }
        const [foreA, aftA] = finAxialSpan(c);
        if (!c.cant && !near(core.yMax, -(c.x + foreA), scale, tol * 0.05)) {
          add('fault', 'fin-station', c.id, `${label} foremost point at ${mm(-core.yMax)}, model says ${mm(c.x + foreA)}.`);
        }
        if (!c.cant && !near(core.yMin, -(c.x + aftA), scale, tol * 0.05)) {
          add('fault', 'fin-station', c.id, `${label} aftmost point at ${mm(-core.yMin)}, model says ${mm(c.x + aftA)}.`);
        }
        // The root must reach the body surface along its whole length.
        let lowest = Infinity;
        let off = 0;
        for (let k = 0; k <= 8; k++) {
          const r = bodyRadiusAt(rocket, c.x + (c.rootChord * k) / 8);
          if (Number.isNaN(r)) off++;
          else lowest = Math.min(lowest, r);
        }
        if (off === 9) {
          add('warn', 'fin-off-body', c.id, `${label} sits at station ${mm(c.x)}, beyond the airframe.`);
        } else if (core.rMin > lowest + Math.max(tol * lowest, 2e-4)) {
          add('fault', 'fin-root-gap', c.id,
            `${label} root stops at ${mm(core.rMin)} radius but the body under it narrows to ${mm(lowest)}: a ${mm(core.rMin - lowest)} gap shows.`);
        }
        break;
      }
      case 'ring': {
        if (!c.external) break;
        const mount = c.mountRadius ?? bodyRadiusAt(rocket, c.x + c.length / 2);
        if (Number.isFinite(mount) && core.rMin < mount * (1 - tol) - 1e-6) {
          add('fault', 'external-inside', c.id,
            `${label} is an external part but is drawn ${mm(mount - core.rMin)} inside the body surface.`);
        }
        break;
      }
      case 'innertube': {
        if (c.isMotorMount && c.motor) {
          const aft = c.x + c.length + Math.max(0, c.overhang);
          if (core.yMin < -aft - tol * 0.05 * scale) {
            add('fault', 'motor-extent', c.id, `${label} motor drawn to ${mm(-core.yMin)}, model says ${mm(aft)}.`);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Side bodies: each part at its own station, the right distance from the axis, once per copy.
  for (const sb of rocket.sideBodies ?? []) {
    for (const c of sb.components) {
      if (c.kind !== 'nosecone' && c.kind !== 'bodytube' && c.kind !== 'transition') continue;
      const r = c.kind === 'nosecone' ? c.baseRadius : c.kind === 'bodytube' ? c.outerRadius : Math.max(c.foreRadius, c.aftRadius);
      if (!(c.length > 0) || !(r > 0)) continue;
      const label = `${sb.name} ${c.kind} "${c.name}"`;
      const mine = (m: THREE.Mesh): boolean => (m.userData.component as Component | undefined)?.id === c.id && !isDetail(m);
      const e = measure(root, mine);
      if (e.vertices === 0) {
        add('fault', 'not-drawn', c.id, `${label} is visible on the real rocket but nothing was drawn.`);
        continue;
      }
      if (e.nan > 0) add('fault', 'nan-vertex', c.id, `${label}: ${e.nan} bad vertices.`);
      if (!near(e.yMax, -c.x, scale, tol * 0.05) || !near(e.yMin, -(c.x + c.length), scale, tol * 0.05)) {
        add('fault', 'axial-extent', c.id,
          `${label} drawn from ${mm(-e.yMax)} to ${mm(-e.yMin)}, model says ${mm(c.x)} to ${mm(c.x + c.length)}.`);
      }
      const far = sb.radialOffset + r;
      if (!near(e.rMax, far, far, tol)) {
        add('fault', 'side-offset', c.id, `${label} reaches ${mm(e.rMax)} from the axis, model says ${mm(far)}.`);
      }
      if (sb.radialOffset > r && e.rMin < (sb.radialOffset - r) * (1 - tol) - 1e-6) {
        add('fault', 'side-offset', c.id, `${label} comes within ${mm(e.rMin)} of the axis, model says ${mm(sb.radialOffset - r)}.`);
      }
      if (sb.radialOffset > 1e-6) {
        const spots = new Set<string>();
        const v = new THREE.Vector3();
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !mine(m)) return;
          m.getWorldPosition(v);
          spots.add(`${v.x.toFixed(5)},${v.z.toFixed(5)}`);
        });
        if (spots.size !== sb.count) {
          add('fault', 'side-count', c.id, `${label} drawn ${spots.size} times, model says ${sb.count}.`);
        }
      }
    }
  }

  if (whole.vertices > 0) {
    const aft = trueAftStation(rocket);
    if (!near(-whole.yMin, aft, scale, tol * 0.25)) {
      add('fault', 'overall-length', '', `Rocket drawn ${mm(-whole.yMin)} long, real aft end is at ${mm(aft)}.`);
    }
    if (whole.yMax > tol * 0.25 * scale) {
      const ahead = rocket.components.some((c) =>
        (c.kind === 'innertube' && (!!c.radialCount || c.x < 0)) || (c.kind === 'finset' && c.x + finAxialSpan(c)[0] < 0));
      const sideAhead = (rocket.sideBodies ?? []).some((sb) => sb.components.some((c) => c.x < 0));
      if (!ahead && !sideAhead) add('fault', 'ahead-of-tip', '', `Geometry extends ${mm(whole.yMax)} ahead of the nose tip.`);
    }
  }

  // Steps between neighbouring external parts are real design features, but worth showing.
  const ext = rocket.components.filter((c) => c.kind === 'nosecone' || c.kind === 'bodytube' || c.kind === 'transition');
  for (let i = 1; i < ext.length; i++) {
    const a = ext[i - 1];
    const b = ext[i];
    const aAft = a.kind === 'nosecone' ? (a.flipped ? 0 : a.baseRadius) : a.kind === 'bodytube' ? a.outerRadius : a.aftRadius;
    const bFore = b.kind === 'nosecone' ? (b.flipped ? b.baseRadius : 0) : b.kind === 'bodytube' ? b.outerRadius : b.foreRadius;
    if (Math.abs(aAft - bFore) > Math.max(1e-5, 0.01 * Math.max(aAft, bFore))) {
      add('warn', 'radius-step', b.id, `"${a.name}" ends at ${mm(aAft)} radius but "${b.name}" starts at ${mm(bFore)}.`);
    }
  }
  return out;
}
