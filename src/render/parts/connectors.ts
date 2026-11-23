// Lego-style connection visuals for the builder: snap sockets, a hologram ghost of the
// part being dragged, a clicked-together joint collar and a snap "pop" animation.
//
// FRAME (same as rocketMesh.ts): rocket axis along +Y, nose toward +Y. Every group here
// is centred on its own origin with its axis along Y; the caller positions it.

import * as THREE from 'three';
import type { Component, RocketModel } from '../../types';
import { buildRocketMesh } from '../rocketMesh';
import { PART_COLORS, partMaterial, type PartContext, type PartTier } from './types';

export type SocketKind = 'external' | 'internal';
export type SocketState = 'idle' | 'hover' | 'mismatch';

export const SOCKET_COLORS: Record<SocketState, number> = {
  idle: 0x4da3ff,
  hover: 0x3ddc97,
  mismatch: 0xf2b84b,
};

/** Smallest visual ring radius, metres: keeps the marker readable on tiny tubes. */
const MIN_SOCKET_RADIUS = 0.012;
const MAX_SOCKET_RADIUS = 0.75;
const STUD_COUNT = 10;

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function overlayMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * A 3D connection marker: ring, Lego-like teeth and a soft disc, axis along Y.
 * External sockets (stacking) carry studs standing up off the ring. Internal sockets
 * (inside a tube) carry notch teeth pointing inward toward the axis and a dashed-look
 * double ring, so the two never read alike.
 */
export function buildSnapSocket(
  radius: number,
  opts: { kind: SocketKind; state: SocketState },
): THREE.Group {
  const r = Math.min(MAX_SOCKET_RADIUS, Math.max(MIN_SOCKET_RADIUS, finiteOr(radius, 0) * 1.18));
  const color = SOCKET_COLORS[opts.state] ?? SOCKET_COLORS.idle;
  const g = new THREE.Group();
  g.name = `snap-socket-${opts.kind}-${opts.state}`;
  g.userData.kind = opts.kind;
  g.userData.state = opts.state;
  g.userData.color = color;
  g.userData.radius = r;

  const emphasis = opts.state === 'hover' ? 1.35 : 1;
  const tube = Math.max(r * 0.055 * emphasis, 0.0012);

  // Ring.
  const ringGeo = new THREE.TorusGeometry(r, tube, 6, 28);
  ringGeo.rotateX(Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, overlayMaterial(color, opts.state === 'hover' ? 0.98 : 0.85));
  ring.name = 'socket-ring';
  ring.renderOrder = 20;
  g.add(ring);

  // Soft translucent disc.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(r * (opts.kind === 'internal' ? 0.92 : 1), 28).rotateX(-Math.PI / 2),
    overlayMaterial(color, opts.state === 'hover' ? 0.22 : 0.12),
  );
  disc.name = 'socket-disc';
  disc.renderOrder = 19;
  g.add(disc);

  const studMat = overlayMaterial(color, 0.95);
  if (opts.kind === 'external') {
    // Studs: short round pegs standing up off the ring, like Lego studs.
    const sr = Math.max(r * 0.075, 0.0016);
    const sh = Math.max(r * 0.13, 0.0022);
    const studGeo = new THREE.CylinderGeometry(sr, sr, sh, 8);
    for (let i = 0; i < STUD_COUNT; i++) {
      const a = (2 * Math.PI * i) / STUD_COUNT;
      const s = new THREE.Mesh(studGeo, studMat);
      s.name = 'socket-stud';
      s.position.set(Math.cos(a) * r, sh / 2 + tube * 0.5, Math.sin(a) * r);
      s.renderOrder = 21;
      g.add(s);
    }
  } else {
    // Notches: flat teeth pointing inward from the ring, plus an inner guide ring.
    const tl = Math.max(r * 0.16, 0.003);
    const tw = Math.max(r * 0.12, 0.002);
    const th = Math.max(r * 0.07, 0.0015);
    const toothGeo = new THREE.BoxGeometry(tl, th, tw);
    for (let i = 0; i < STUD_COUNT; i++) {
      const a = (2 * Math.PI * i) / STUD_COUNT;
      const t = new THREE.Mesh(toothGeo, studMat);
      t.name = 'socket-notch';
      t.position.set(Math.cos(a) * (r - tl / 2), 0, Math.sin(a) * (r - tl / 2));
      t.rotation.y = -a;
      t.renderOrder = 21;
      g.add(t);
    }
    const innerGeo = new THREE.TorusGeometry(r * 0.62, Math.max(tube * 0.55, 0.0008), 5, 24);
    innerGeo.rotateX(Math.PI / 2);
    const inner = new THREE.Mesh(innerGeo, overlayMaterial(color, 0.55));
    inner.name = 'socket-inner';
    inner.renderOrder = 20;
    g.add(inner);
  }
  return g;
}

/** Kinds the builder only draws in cutaway view. */
function needsCutaway(c: Component): boolean {
  if (c.kind === 'mass' || c.kind === 'parachute') return true;
  if (c.kind === 'innertube') return !(c.radialCount && c.radialCount >= 2);
  if (c.kind === 'ring') return !c.external;
  return false;
}

function widestRadius(c: Component): number {
  switch (c.kind) {
    case 'nosecone': return c.baseRadius;
    case 'bodytube': return c.outerRadius;
    case 'transition': return Math.max(c.foreRadius, c.aftRadius);
    case 'finset': return c.bodyRadius + c.span;
    case 'innertube': return (c.radialOffset ?? 0) + c.outerRadius;
    case 'ring': return Math.max(c.outerRadius, c.mountRadius ?? 0);
    case 'parachute': return c.diameter / 2;
    default: return 0;
  }
}

/**
 * A translucent hologram of one catalogue part, its top at the origin, for previewing
 * at a hovered snap point. Disposal: use disposeGroup (it disposes the shared material
 * and the edge geometries).
 */
export function buildGhostPart(
  component: Component,
  opts: { color?: number; opacity?: number; hostRadius?: number } = {},
): THREE.Group {
  const color = opts.color ?? 0x3ddc97;
  const opacity = opts.opacity ?? 0.35;
  const c: Component = { ...component, x: 0 };
  const length = Math.max(finiteOr(c.length, 0), 0);
  const model: RocketModel = {
    name: 'ghost',
    components: [c],
    length,
    // Internal parts (mass, chute) size themselves from the host tube: give them one.
    maxRadius: Math.max(finiteOr(widestRadius(c), 0), finiteOr(opts.hostRadius ?? 0, 0), c.kind === 'mass' || c.kind === 'parachute' ? 0.02 : 0),
    stageCount: 1,
    warnings: [],
  };

  let built: THREE.Group;
  try {
    built = buildRocketMesh(model, { cutaway: needsCutaway(c) });
  } catch {
    built = new THREE.Group();
  }
  built.name = 'ghost-part';

  const ghostMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const edgeMat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: Math.min(1, opacity + 0.45),
    depthWrite: false,
  });

  const meshes: THREE.Mesh[] = [];
  built.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  for (const m of meshes) {
    const old = m.material as THREE.Material | THREE.Material[];
    if (Array.isArray(old)) old.forEach((x) => x.dispose());
    else old?.dispose();
    m.material = ghostMat;
    m.renderOrder = 10;
    // Outline as a child so it follows the mesh's own transform.
    try {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), edgeMat);
      edges.name = 'ghost-edges';
      edges.renderOrder = 11;
      m.add(edges);
    } catch {
      /* a mesh with unusable geometry just goes without an outline */
    }
  }
  built.userData.ghost = true;
  return built;
}

/**
 * A thin coupler band with small stud teeth, centred on the origin, drawn at a joint to
 * show two parts are clicked together. Height ~6% of radius (min 1.5 mm); sticks out at
 * most 3% of radius. `ctx` is only used for the material.
 */
export function buildJointCollar(
  radius: number,
  tier: PartTier = 'ok',
  ctx: PartContext = { cutaway: false, maxRadius: 0, rocketLength: 0 },
): THREE.Group {
  const r = Math.min(MAX_SOCKET_RADIUS, Math.max(0.002, finiteOr(radius, 0)));
  const height = Math.max(0.0015, 0.06 * r);
  const bandR = r * 1.02;
  const g = new THREE.Group();
  g.name = 'joint-collar';
  g.userData.tier = tier;
  g.userData.height = height;

  const mat = partMaterial(PART_COLORS.metal, ctx);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(bandR, bandR, height, 32, 1, false), mat);
  band.name = 'collar-band';
  g.add(band);

  const count = tier === 'best' ? 12 : tier === 'ok' ? 8 : 5;
  const radial = r * 0.01;
  const wide = Math.max(r * 0.1, 0.0015);
  const studGeo = new THREE.BoxGeometry(radial, height * 1.0, wide);
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count + (tier === 'bad' ? 0.15 * (i % 2) : 0);
    const s = new THREE.Mesh(studGeo, mat);
    s.name = 'collar-stud';
    const rr = r * 1.025;
    s.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
    s.rotation.y = -a;
    g.add(s);
  }
  return g;
}

const POP_PEAK = 1.12;
const POP_RISE = 0.35;

/**
 * Snap "pop": scale starts at 1, rises quickly to ~1.12 at t = 0.35, then eases back and
 * is exactly 1 for t >= 1. `t` is clamped to [0, 1]; the caller drives time.
 */
export function playSnapPop(obj: THREE.Object3D, t: number): void {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1;
  let s: number;
  if (x >= 1) s = 1;
  else if (x < POP_RISE) s = 1 + (POP_PEAK - 1) * Math.sin((Math.PI / 2) * (x / POP_RISE));
  else s = 1 + (POP_PEAK - 1) * (0.5 + 0.5 * Math.cos((Math.PI * (x - POP_RISE)) / (1 - POP_RISE)));
  obj.scale.set(s, s, s);
}
