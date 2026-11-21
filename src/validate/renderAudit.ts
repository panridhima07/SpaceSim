// Measures a built rocket mesh against the RocketModel it was built from.
// Every check is geometric: it reads vertex positions, never the builder's own inputs.

import * as THREE from 'three';
import type { Component, RocketModel } from '../types';

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

/** Outer radius of the airframe at a station, from the external parts. NaN off the rocket. */
export function bodyRadiusAt(rocket: RocketModel, x: number): number {
  let best = NaN;
  for (const c of rocket.components) {
    if (c.kind !== 'nosecone' && c.kind !== 'bodytube' && c.kind !== 'transition') continue;
    if (x < c.x - 1e-9 || x > c.x + c.length + 1e-9 || !(c.length > 0)) continue;
    const u = (x - c.x) / c.length;
    let r: number;
    if (c.kind === 'bodytube') r = c.outerRadius;
    else if (c.kind === 'transition') r = c.foreRadius + (c.aftRadius - c.foreRadius) * u;
    else r = c.baseRadius * (c.flipped ? 1 - u : u); // linear estimate; only used for mounts
    if (!(r >= best)) best = Number.isNaN(best) ? r : Math.max(best, r);
  }
  return best;
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

/** Aft-most station anything on the rocket reaches, including motor overhang. */
export function trueAftStation(rocket: RocketModel): number {
  let aft = 0;
  for (const c of rocket.components) {
    if (c.kind === 'nosecone' || c.kind === 'bodytube' || c.kind === 'transition') {
      aft = Math.max(aft, c.x + c.length);
    } else if (c.kind === 'finset') {
      aft = Math.max(aft, c.x + Math.max(c.rootChord, c.sweepLength + c.tipChord));
    } else if (c.kind === 'innertube' && c.isMotorMount && c.motor) {
      aft = Math.max(aft, c.x + c.length + c.overhang);
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

  const whole = measure(root, (m) => !!m.userData.component);
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
      const degenerate = !(c.length > 0) && c.kind !== 'mass' && c.kind !== 'parachute';
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
        if (!c.cant && !near(core.yMax, -c.x, scale, tol * 0.05)) {
          add('fault', 'fin-station', c.id, `${label} leading edge at ${mm(-core.yMax)}, model says ${mm(c.x)}.`);
        }
        const mid = c.x + c.rootChord / 2;
        const surface = bodyRadiusAt(rocket, mid);
        const fore = bodyRadiusAt(rocket, c.x);
        const aft = bodyRadiusAt(rocket, c.x + c.rootChord);
        if (Number.isNaN(surface)) {
          add('warn', 'fin-off-body', c.id, `${label} sits at station ${mm(mid)}, beyond the airframe.`);
        } else {
          const worst = [fore, surface, aft].filter((v) => !Number.isNaN(v))
            .reduce((m, v) => Math.max(m, Math.abs(v - c.bodyRadius)), 0);
          if (worst > Math.max(tol * c.bodyRadius, 2e-4)) {
            add('fault', 'fin-root-gap', c.id,
              `${label} root is drawn at ${mm(c.bodyRadius)} radius but the body there is ${mm(fore)}–${mm(aft)}: the fin floats or is buried by up to ${mm(worst)}.`);
          }
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
        if (c.isMotorMount && c.motor && !opts.cutaway) {
          const aft = c.x + c.length + c.overhang;
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

  if (whole.vertices > 0) {
    const aft = trueAftStation(rocket);
    if (!near(-whole.yMin, aft, scale, tol * 0.25)) {
      add('fault', 'overall-length', '', `Rocket drawn ${mm(-whole.yMin)} long, real aft end is at ${mm(aft)}.`);
    }
    if (whole.yMax > tol * 0.25 * scale) {
      const pods = rocket.components.some((c) => c.kind === 'innertube' && !!c.radialCount);
      if (!pods) add('fault', 'ahead-of-tip', '', `Geometry extends ${mm(whole.yMax)} ahead of the nose tip.`);
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
