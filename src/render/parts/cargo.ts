// Payload-bay cargo seen in cutaway view: ballast, flight computer, camera, streamer.
//
// Frame (see types.ts): rocket axis +Y, nose at the origin; a component at station x with
// length L occupies y in [-(x + L), -x]. Metres, never rescaled.
//
// Tiers change workmanship only. 'best' is tidy and precise, 'ok' is ordinary kit, 'bad'
// is crude: lopsided, taped, glue blobs, bent. Mass components carry no radius, so, like
// buildMass, they are sized from ctx.maxRadius (0.6 x it). A streamer is sized like a
// packed chute (0.7 x it). Every mesh stays inside that radius and inside the axial span.
// Details sit under a child group tagged `userData.detail = true`.
//
// Small same-colour pieces (IC packages, screws, pin rows, wires, rings) are baked into one
// merged geometry per colour and finish, so a part stays at a handful of draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MassComponent, Parachute } from '../../types';
import {
  PART_COLORS,
  mixColor,
  partMaterial,
  radialSegments,
  scopedPart,
  seeded,
  sharedGeometry,
  type PartBuilder,
  type PartContext,
  type PartFinish,
  type PartTier,
} from './types';

// ---------------------------------------------------------------------------------
// classification

export type CargoKind = 'ballast' | 'computer' | 'camera' | 'generic';

/** What a mass component is, from its name (case-insensitive). */
export function cargoKind(c: MassComponent): CargoKind {
  const n = String((c as { name?: unknown } | null | undefined)?.name ?? '').toLowerCase();
  if (/ballast|weight/.test(n)) return 'ballast';
  if (/computer|altimeter|avionics/.test(n)) return 'computer';
  if (/camera/.test(n)) return 'camera';
  return 'generic';
}

/** True for a streamer (a parachute whose name contains "streamer"). */
export function isStreamer(c: Parachute): boolean {
  return String((c as { name?: unknown } | null | undefined)?.name ?? '').toLowerCase().includes('streamer');
}

// ---------------------------------------------------------------------------------
// helpers

const SEG: Record<PartTier, number> = { best: 32, ok: 24, bad: 10 };
const TWO_PI = Math.PI * 2;
const EPS = 1e-9;

/** Real hobby-rocketry tones used by this file. */
const K = {
  pcb: 0x1f6b3a,
  pcbEdge: 0x154a28,
  ic: 0x18191c,
  gold: 0xc9a14a,
  zinc: 0xb9c0c8,
  brass: 0xb8963e,
  termGreen: 0x3fae5a,
  termBlue: 0x2f6fb5,
  lipo: 0x2d5fa8,
  wireRed: 0xc23a2f,
  wireBlack: 0x1c1c1c,
  plywood: 0xcfa972,
  fr4: 0xb7c4a0,
  lead: 0x5d6168,
  glass: 0x10141f,
  mylar: 0xc9ced4,
  streamer: 0xf0622a,
  band: 0xb58a5a,
  tape: 0xe8dfc0,
  nylon: 0xe9e6dc,
  label: 0xe6e8ec,
  led: 0x3dff7a,
  ledRed: 0xd33a2c,
} as const;

type Geo = THREE.BufferGeometry;

function fin(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
const mx = (v: number) => Math.max(v, EPS);

function keyOf(c: { id?: unknown }): string {
  return typeof c.id === 'string' ? c.id : '';
}

function detailGroup(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'detail';
  g.userData.detail = true;
  return g;
}

function finish(main: THREE.Group, det: THREE.Group): THREE.Group {
  if (det.children.length) main.add(det);
  return main;
}

/** The component colour, or the default (crude builds drift toward bare material). */
function baseColor(color: number | undefined, def: number, tier: PartTier): number {
  if (color !== undefined && color !== null) return color;
  return tier === 'bad' ? mixColor(def, PART_COLORS.bare, 0.25) : def;
}

interface Span {
  y0: number;
  y1: number;
  h: number;
  yc: number;
  R: number;
}

/** Axial span and radius of a mass component, as buildMass picks them. */
function massSpan(c: MassComponent, ctx: PartContext): Span | null {
  if (!(fin(c.x) && fin(c.length) && c.length >= 0 && fin(ctx.maxRadius) && ctx.maxRadius > 0)) return null;
  const R = 0.6 * ctx.maxRadius;
  let y1: number;
  let y0: number;
  if (c.length === 0) {
    const hh = 0.4 * ctx.maxRadius;
    y1 = -c.x + hh / 2;
    y0 = -c.x - hh / 2;
  } else {
    y1 = -c.x;
    y0 = -(c.x + c.length);
  }
  return { y0, y1, h: y1 - y0, yc: (y0 + y1) / 2, R };
}

// Pieces of one part with the same shape (discs, lens barrels, plates) share one geometry;
// every mesh carries its own position and rotation.

function box(
  ctx: PartContext,
  color: number,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  look?: PartFinish,
): THREE.Mesh {
  const bx = mx(sx);
  const by = mx(sy);
  const bz = mx(sz);
  const m = new THREE.Mesh(
    sharedGeometry(ctx, `box|${bx}|${by}|${bz}`, () => new THREE.BoxGeometry(bx, by, bz)),
    partMaterial(color, ctx, { finish: look }),
  );
  m.position.set(x, y, z);
  return m;
}

/** Cylinder (or cone, r2 at the +axis end) of length len centred at (x, y, z). */
function cyl(
  ctx: PartContext,
  color: number,
  r: number,
  len: number,
  seg: number,
  x: number,
  y: number,
  z: number,
  axis: 'x' | 'y' | 'z' = 'y',
  r2: number = r,
  look?: PartFinish,
): THREE.Mesh {
  const rTop = mx(r2);
  const rBot = mx(r);
  const h = mx(len);
  const n = radialSegments(Math.max(3, seg), 'inner');
  const g = sharedGeometry(ctx, `cyl|${rTop}|${rBot}|${h}|${n}|${axis}`, () => {
    const cg = new THREE.CylinderGeometry(rTop, rBot, h, n, 1);
    if (axis === 'x') cg.rotateZ(-Math.PI / 2);
    else if (axis === 'z') cg.rotateX(Math.PI / 2);
    return cg;
  });
  const m = new THREE.Mesh(g, partMaterial(color, ctx, { finish: look }));
  m.position.set(x, y, z);
  return m;
}

// Baked geometry builders: each returns a fresh, indexed geometry (position, normal, uv) already
// placed, so a list of them can be merged into one mesh with `addMerged`.

function gBox(sx: number, sy: number, sz: number, x: number, y: number, z: number, ry = 0): Geo {
  const g = new THREE.BoxGeometry(mx(sx), mx(sy), mx(sz));
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** Cylinder or cone of length len centred at (x, y, z); `open` leaves the ends off. */
function gCyl(
  r: number,
  len: number,
  seg: number,
  x: number,
  y: number,
  z: number,
  axis: 'x' | 'y' | 'z' = 'y',
  open = false,
  r2: number = r,
): Geo {
  const g = new THREE.CylinderGeometry(mx(r2), mx(r), mx(len), Math.max(3, seg), 1, open);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function gSph(r: number, x: number, y: number, z: number): Geo {
  const g = new THREE.SphereGeometry(mx(r), 6, 4);
  g.translate(x, y, z);
  return g;
}

/** Flat disc facing +axis. */
function gDisc(r: number, seg: number, facing: 'x' | 'y' | 'z', x: number, y: number, z: number): Geo {
  const g = new THREE.CircleGeometry(mx(r), Math.max(3, seg));
  if (facing === 'x') g.rotateY(Math.PI / 2);
  else if (facing === 'y') g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** Flat rectangle w x hgt facing +z (rot turns it in its plane), or lying flat (facing y). */
function gPlane(w: number, hgt: number, facing: 'y' | 'z', x: number, y: number, z: number, rot = 0): Geo {
  const g = new THREE.PlaneGeometry(mx(w), mx(hgt));
  if (facing === 'z') {
    if (rot) g.rotateZ(rot);
  } else {
    g.rotateX(-Math.PI / 2);
    if (rot) g.rotateY(rot);
  }
  g.translate(x, y, z);
  return g;
}

/** Flat annulus lying at height y (faces +y). */
function gRingY(rIn: number, rOut: number, seg: number, y: number): Geo {
  const g = new THREE.RingGeometry(mx(rIn), mx(Math.max(rOut, rIn + EPS)), Math.max(3, seg), 1);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** A thin strip lying flat at height y, running radially from the axis at angle a. */
function gRadial(len: number, wd: number, rMid: number, a: number, y: number): Geo {
  const g = new THREE.PlaneGeometry(mx(len), mx(wd));
  g.rotateX(-Math.PI / 2);
  g.rotateY(-a);
  g.translate(rMid * Math.cos(a), y, rMid * Math.sin(a));
  return g;
}

/** Thin 3-sided wire between two points. */
function gWire(a: THREE.Vector3, b: THREE.Vector3, rad: number): Geo | null {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (!(len > 1e-12)) return null;
  const g = new THREE.CylinderGeometry(mx(rad), mx(rad), len, 3, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

/** A polyline of wires through the points. */
function gWirePath(pts: THREE.Vector3[], rad: number): Geo[] {
  const out: Geo[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const w = gWire(pts[i], pts[i + 1], rad);
    if (w) out.push(w);
  }
  return out;
}

/** A rectangular wrap (four slabs) around the footprint sx x sz, height sy, centred at (x, y, z). */
function gFrame(sx: number, sy: number, sz: number, t: number, x: number, y: number, z: number): Geo[] {
  const tt = Math.min(t, sx / 2, sz / 2);
  return [
    gBox(sx, sy, tt, x, y, z + sz / 2 - tt / 2),
    gBox(sx, sy, tt, x, y, z - sz / 2 + tt / 2),
    gBox(tt, sy, Math.max(sz - 2 * tt, EPS), x + sx / 2 - tt / 2, y, z),
    gBox(tt, sy, Math.max(sz - 2 * tt, EPS), x - sx / 2 + tt / 2, y, z),
  ];
}

/**
 * A thin pad on the side of a cylinder: radial thickness t, tangential width w, height hh,
 * at angle a, centred at height y. Its outer corners lie exactly on radius rOut.
 */
function gSurfBox(rOut: number, t: number, w: number, hh: number, a: number, y: number): Geo {
  const xf = Math.sqrt(Math.max(rOut * rOut - (w / 2) * (w / 2), 0));
  const g = new THREE.BoxGeometry(mx(t), mx(hh), mx(w));
  g.translate(xf - t / 2, 0, 0);
  g.rotateY(-a);
  g.translate(0, y, 0);
  return g;
}

/** A toothed band: peaks at rOut, valleys at rIn, height hgt, centred at height y. */
function gKnurl(rOut: number, rIn: number, hgt: number, teeth: number, y: number): Geo {
  const n = teeth * 2;
  const pos = new Float32Array(2 * n * 3);
  for (let ring = 0; ring < 2; ring++) {
    for (let j = 0; j < n; j++) {
      const th = (TWO_PI * j) / n;
      const r = j % 2 === 0 ? rOut : rIn;
      const o = (ring * n + j) * 3;
      pos[o] = r * Math.cos(th);
      pos[o + 1] = y + (ring === 0 ? hgt / 2 : -hgt / 2);
      pos[o + 2] = r * Math.sin(th);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) {
    const j1 = (j + 1) % n;
    idx.push(j, n + j, j1, j1, n + j, n + j1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(2 * n * 2), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Merge baked geometries into one mesh with one material; null when there is nothing to draw. */
function mergedMesh(
  ctx: PartContext,
  geos: (Geo | null)[],
  color: number,
  look: PartFinish,
  offset = false,
): THREE.Mesh | null {
  const list = geos.filter((g): g is Geo => !!g);
  if (!list.length) return null;
  let geo: Geo | null = list[0];
  if (list.length > 1) {
    geo = mergeGeometries(list, false);
    for (const g of list) g.dispose();
  }
  if (!geo) return null;
  return new THREE.Mesh(geo, partMaterial(color, ctx, { finish: look, offset }));
}

function addMerged(
  parent: THREE.Object3D,
  ctx: PartContext,
  geos: (Geo | null)[],
  color: number,
  look: PartFinish,
  offset = false,
): void {
  const m = mergedMesh(ctx, geos, color, look, offset);
  if (m) parent.add(m);
}

/** Surface of revolution about +Y through (y, r) points; radial scale per (ring, column). */
function lathe(
  profile: [number, number][],
  seg: number,
  radial?: (k: number, j: number) => number,
): THREE.BufferGeometry {
  const n = profile.length;
  const pos = new Float32Array(n * seg * 3);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < seg; j++) {
      const th = (TWO_PI * j) / seg;
      const r = profile[k][1] * (radial ? radial(k, j) : 1);
      const o = (k * seg + j) * 3;
      pos[o] = r * Math.cos(th);
      pos[o + 1] = profile[k][0];
      pos[o + 2] = r * Math.sin(th);
    }
  }
  const idx: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      const a = k * seg + j;
      const b = k * seg + j1;
      const c2 = (k + 1) * seg + j;
      const d = (k + 1) * seg + j1;
      idx.push(a, c2, b, b, c2, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const flat = geo.toNonIndexed();
  geo.dispose();
  flat.computeVertexNormals();
  return flat;
}

// ---------------------------------------------------------------------------------
// ballast: machined slugs on a threaded rod (best), a lead disc stack with washer and nut (ok),
// taped coins and a lump of clay (bad)

export const buildBallast: PartBuilder<MassComponent> = scopedPart((c, tier, ctx) => {
  const sp = massSpan(c, ctx);
  if (!sp) return new THREE.Group();
  const { y0, y1, h, yc, R } = sp;
  const id = keyOf(c);
  const seg = radialSegments(SEG[tier], 'inner');
  const g = new THREE.Group();
  const det = detailGroup();

  if (tier === 'best') {
    const steel = baseColor(c.color, mixColor(PART_COLORS.metal, PART_COLORS.mass, 0.25), tier);
    const hb = Math.min(0.08 * h, 0.35 * R);
    const body = h - 2 * hb;
    const n = clamp(Math.round(body / (0.5 * R)), 2, 6);
    const slot = body / n;
    const rd = 0.97 * R; // slug body; the knurl peaks reach R
    const dh = slot * 0.92;
    const knurls: Geo[] = [];
    const marks: Geo[] = [];
    for (let i = 0; i < n; i++) {
      const y = y1 - hb - slot * (i + 0.5);
      g.add(cyl(ctx, steel, rd, dh, seg, 0, y, 0, 'y', rd, 'metal'));
      knurls.push(gKnurl(R, 0.955 * R, dh * 0.34, 12, y));
      // stamped mass mark above the knurled band, every other slug
      if (i % 2 === 0) marks.push(gSurfBox(0.998 * R, 0.04 * R, 0.3 * R, dh * 0.18, seeded(id, 5 + i) * TWO_PI, y + dh * 0.31));
    }
    addMerged(det, ctx, knurls, mixColor(steel, 0x000000, 0.22), 'metal');
    addMerged(det, ctx, marks, mixColor(steel, 0xffffff, 0.55), 'metal');
    // neat threaded rod, washers and a lock-nut (nylon collar) on top
    addMerged(det, ctx, [gCyl(0.11 * R, h, 8, 0, yc, 0)], K.zinc, 'metal');
    const brass = c.color !== undefined ? mixColor(steel, K.brass, 0.8) : K.brass;
    addMerged(
      det,
      ctx,
      [
        gCyl(0.36 * R, 0.3 * hb, 12, 0, y1 - 0.85 * hb, 0),
        gCyl(0.3 * R, 0.42 * hb, 6, 0, y1 - 0.49 * hb, 0),
        gCyl(0.36 * R, 0.3 * hb, 12, 0, y0 + 0.15 * hb, 0),
        gCyl(0.3 * R, 0.7 * hb, 6, 0, y0 + 0.65 * hb, 0),
      ],
      brass,
      'metal',
    );
    addMerged(det, ctx, [gCyl(0.22 * R, 0.28 * hb, 8, 0, y1 - 0.14 * hb, 0)], 0x2a2d34, 'satin');
  } else if (tier === 'ok') {
    const lead = baseColor(c.color, K.lead, tier);
    const dark = mixColor(lead, 0x000000, 0.14);
    const hb = Math.min(0.1 * h, 0.3 * R); // washer and nut on top
    const hd = h - hb;
    const n = clamp(Math.round(hd / (0.7 * R)), 1, 4);
    const dh = hd / n;
    const rd = 0.985 * R;
    const edges: Geo[] = [];
    for (let i = 0; i < n; i++) {
      const y = y1 - hb - dh * (i + 0.5);
      if (i % 2 === 0) g.add(cyl(ctx, lead, rd, dh * 0.96, seg, 0, y, 0, 'y', rd, 'satin'));
      else det.add(cyl(ctx, dark, rd, dh * 0.96, seg, 0, y, 0, 'y', rd, 'satin'));
      // lighter chamfer line round the top edge
      edges.push(gCyl(R, dh * 0.12, seg, 0, y + dh * 0.42, 0, 'y', true));
    }
    addMerged(det, ctx, edges, mixColor(lead, 0xffffff, 0.32), 'metal');
    addMerged(
      det,
      ctx,
      [
        gCyl(0.1 * R, h, 6, 0, yc, 0),
        gCyl(0.34 * R, 0.4 * hb, 8, 0, y1 - 0.8 * hb, 0),
        gCyl(0.28 * R, 0.6 * hb, 6, 0, y1 - 0.3 * hb, 0),
      ],
      K.zinc,
      'metal',
    );
  } else {
    // a lump of modelling clay: poles and shoulders pulled in, every vertex nudged inward
    const clay = baseColor(c.color, mixColor(PART_COLORS.bare, 0x7a4a2a, 0.4), tier);
    const ts = [0, 0, 0.12, 0.4, 0.7, 0.9, 1, 1];
    const rs = [0, 0.85, 1, 1, 1, 0.97, 0.85, 0];
    const profile: [number, number][] = ts.map((t, i) => [y1 - t * h, R * rs[i]]);
    const radial = (k: number, j: number) => 1 - 0.3 * seeded(id, k * 53 + j);
    g.add(new THREE.Mesh(lathe(profile, seg, radial), partMaterial(clay, ctx, { finish: 'matte' })));

    // two strips of masking tape and a loose tail
    const tape = mixColor(K.tape, clay, 0.15);
    const th = Math.min(0.18 * h, 0.5 * R);
    const fr1 = 0.3 + 0.4 * seeded(id, 1);
    const fr2 = fr1 > 0.5 ? fr1 - 0.3 : fr1 + 0.3;
    const tyOf = (f: number) => y0 + th / 2 + (h - th) * f;
    const ty = tyOf(fr1);
    const ty2 = tyOf(fr2);
    const tapeGeos: Geo[] = [
      gCyl(R * 0.97, th, seg, 0, ty, 0, 'y', true),
      gCyl(R * 0.955, th * 0.8, seg, 0, ty2, 0, 'y', true),
    ];
    const tailH = Math.min(0.35 * h, 0.6 * R);
    tapeGeos.push(gSurfBox(0.985 * R, 0.01 * R, 0.18 * R, tailH, seeded(id, 2) * TWO_PI, clamp(ty - th / 2 - tailH / 2, y0 + tailH / 2, y1 - tailH / 2)));
    addMerged(det, ctx, tapeGeos, tape, 'matte');

    // coins stuck on with tape and glue
    const rc = Math.min(0.28 * R, 0.45 * h);
    const tc = 0.12 * R;
    const dOut = 0.95 * Math.sqrt(Math.max(R * R - rc * rc, 0));
    const silver: Geo[] = [];
    const copper: Geo[] = [];
    for (let j = 0; j < 3; j++) {
      const a = seeded(id, 30 + j) * TWO_PI;
      const y = clamp(y0 + rc + (h - 2 * rc) * seeded(id, 40 + j), y0 + rc, y1 - rc);
      const cg = new THREE.CylinderGeometry(mx(rc), mx(rc), mx(tc), radialSegments(10, 'small'), 1);
      cg.rotateZ(-Math.PI / 2);
      cg.translate(dOut - tc / 2, 0, 0);
      cg.rotateY(-a);
      cg.translate(0, y, 0);
      (j === 1 ? copper : silver).push(cg);
    }
    addMerged(det, ctx, silver, K.zinc, 'satin');
    addMerged(det, ctx, copper, 0xa5703c, 'satin');

    const sr = Math.min(0.1 * R, 0.2 * h);
    const glue = mixColor(PART_COLORS.glue, clay, 0.2);
    const blobs: Geo[] = [];
    for (let i = 0; i < 6; i++) {
      const a = seeded(id, 10 + i) * TWO_PI;
      const y = clamp(y0 + sr + (h - 2 * sr) * seeded(id, 20 + i), y0 + sr, y1 - sr);
      blobs.push(gSph(sr, 0.8 * R * Math.cos(a), y, 0.8 * R * Math.sin(a)));
    }
    addMerged(det, ctx, blobs, glue, 'satin');
  }
  return finish(g, det);
});

// ---------------------------------------------------------------------------------
// flight computer: an altimeter board on a sled with chips, a barometer can, screw terminals,
// a battery with wires and standoffs

export const buildFlightComputer: PartBuilder<MassComponent> = scopedPart((c, tier, ctx) => {
  const sp = massSpan(c, ctx);
  if (!sp) return new THREE.Group();
  const { y0, y1, h, R } = sp;
  const id = keyOf(c);
  const rnd = (i: number) => seeded(id, i);
  const best = tier === 'best';
  const bad = tier === 'bad';
  const g = new THREE.Group();
  const det = detailGroup();
  const asm = new THREE.Group();
  const asmDet = new THREE.Group();
  asmDet.name = 'detail';
  asmDet.userData.detail = true;
  asm.add(asmDet);

  const pcbColor = baseColor(c.color, K.pcb, tier);
  const chipColor = bad ? 0x2a2a26 : K.ic;
  const hw = 0.7 * R;
  const tb = 0.07 * R;
  const ru = Math.min(R, 0.25 * h); // unit for round details that reach along the axis

  // axial room for the board
  let ya = y0;
  let yb = y1;
  if (best) {
    const tp = Math.min(0.05 * h, 0.2 * R);
    ya = y0 + tp;
    yb = y1 - tp;
    const plate = mixColor(PART_COLORS.ring, 0x000000, 0.1);
    const pseg = radialSegments(24, 'inner');
    addMerged(det, ctx, [gCyl(0.96 * R, tp, pseg, 0, y1 - tp / 2, 0), gCyl(0.96 * R, tp, pseg, 0, y0 + tp / 2, 0)], plate, 'satin');
  } else {
    const m = (bad ? 0.05 : 0.02) * h;
    ya = y0 + m;
    yb = y1 - m;
  }
  const Lfull = Math.max(yb - ya, EPS);
  let Lb = Lfull;
  let T = 0;
  if (bad) {
    T = Math.min(0.06, (0.1 * Lfull) / hw, (0.1 * R) / (0.5 * Lfull));
    Lb = Math.max((Lfull - 2 * hw * Math.sin(T)) / Math.cos(T), EPS);
    T *= rnd(2) > 0.5 ? 1 : -1;
  }
  const yBoard = (ya + yb) / 2;
  const board = box(ctx, pcbColor, 2 * hw, Lb, tb, 0, yBoard, 0, 'satin');
  board.rotation.z = T;
  asm.add(board);
  const ztop = tb / 2;
  const zbot = -tb / 2;
  const chipSpan = Lfull;
  const yAt = (f: number) => yb - f * chipSpan;

  // z layout under the board: battery, then the sled it rides on
  const gap = bad ? 0 : 0.03 * R;
  const bt = 0.26 * R;
  const bzTop = zbot - gap;
  const bzc = bzTop - bt / 2;
  const bzBot = bzTop - bt;
  const ts = 0.05 * R;
  const zs = bzBot - ts / 2;
  const sw = hw + 0.08 * R;

  // sled: plywood (kit), fibreglass (best), a crooked offcut (bad)
  {
    const sledL = bad ? 0.9 * Lfull : Lfull;
    const sx = bad ? (rnd(45) - 0.5) * 0.08 * R : 0;
    const sy = bad ? yBoard + (rnd(46) - 0.5) * 0.05 * Lfull : yBoard;
    const col = best ? K.fr4 : bad ? mixColor(K.plywood, PART_COLORS.bare, 0.3) : K.plywood;
    asmDet.add(box(ctx, col, 2 * sw, sledL, ts, sx, sy, zs, best ? 'satin' : 'matte'));
  }

  // darker edge border on the board's top face
  if (!bad) {
    const ew = 0.05 * R;
    const zt = ztop + 0.001 * R;
    addMerged(
      asmDet,
      ctx,
      [
        gPlane(2 * hw, ew, 'z', 0, yBoard + Lb / 2 - ew / 2, zt),
        gPlane(2 * hw, ew, 'z', 0, yBoard - Lb / 2 + ew / 2, zt),
        gPlane(ew, Math.max(Lb - 2 * ew, EPS), 'z', -hw + ew / 2, yBoard, zt),
        gPlane(ew, Math.max(Lb - 2 * ew, EPS), 'z', hw - ew / 2, yBoard, zt),
      ],
      K.pcbEdge,
      'satin',
      true,
    );
  }

  // IC packages (black), their pin pads, the barometer can
  const icGeos: Geo[] = [];
  const pads: Geo[] = [];
  const zincSolid: Geo[] = [];
  const chips: { f: number; w: number; l: number; t: number; x: number }[] = [
    { f: 0.2, w: 0.3 * R, l: Math.min(0.1 * chipSpan, 0.5 * R), t: 0.07 * R, x: -0.2 * R },
    { f: 0.5, w: 0.46 * R, l: Math.min(0.16 * chipSpan, 0.8 * R), t: 0.09 * R, x: 0.12 * R },
    { f: 0.76, w: 0.34 * R, l: Math.min(0.1 * chipSpan, 0.5 * R), t: 0.07 * R, x: -0.18 * R },
  ];
  chips.forEach((ch, i) => {
    const dx = bad ? (rnd(10 + i) - 0.5) * 0.2 * R : 0;
    const dy = bad ? (rnd(20 + i) - 0.5) * 0.06 * chipSpan : 0;
    const ry = bad ? (rnd(30 + i) - 0.5) * 1.0 : 0;
    icGeos.push(gBox(ch.w, ch.l, ch.t, ch.x + dx, yAt(ch.f) + dy, ztop + ch.t / 2, ry));
    if (!bad) {
      for (const s of [-1, 1]) pads.push(gPlane(0.09 * R, ch.l * 0.8, 'z', ch.x + s * (ch.w / 2 + 0.04 * R), yAt(ch.f), ztop + 0.0015 * R));
    }
  });
  if (!bad) {
    const bx0 = 0.32 * R;
    const by0 = yAt(0.34);
    zincSolid.push(gCyl(0.16 * ru, 0.1 * R, radialSegments(8, 'small'), bx0, by0, ztop + 0.05 * R, 'z'));
    icGeos.push(gBox(0.07 * R, 0.07 * ru, 0.02 * R, bx0, by0, ztop + 0.105 * R));
  }

  // battery under the board
  const bw = 0.62 * R;
  const bl = Math.min(0.34 * Lfull, 3 * R);
  const bx = -0.05 * R + (bad ? (rnd(40) - 0.5) * 0.16 * R : 0);
  const by = yb - 0.66 * Lfull;
  asmDet.add(box(ctx, K.lipo, bw, bl, bt, bx, by, bzc, 'satin'));
  if (best) {
    asmDet.add(box(ctx, K.label, bw * 0.7, bl * 0.5, bt * 1.04, bx, by, bzc, 'gloss'));
    // zip tie round the battery
    const zt = 0.022 * R;
    const zw = Math.min(0.08 * bl, 0.12 * R);
    const zy = by - 0.3 * bl;
    const tie = gFrame(bw + 0.06 * R, zw, bt + 0.06 * R, zt, bx, zy, bzc);
    tie.push(gBox(0.07 * R, zw, 0.12 * R, bx + bw / 2 + 0.07 * R, zy, bzc - bt / 2));
    addMerged(asmDet, ctx, tie, K.nylon, 'satin');
  } else if (bad) {
    addMerged(asmDet, ctx, gFrame(bw + 0.08 * R, 0.2 * bl, bt + 0.08 * R, 0.03 * R, bx, by + 0.1 * bl, bzc), K.tape, 'matte');
  } else {
    asmDet.add(box(ctx, K.label, bw + 0.02 * R, bl * 0.3, bt + 0.02 * R, bx, by + 0.16 * bl, bzc, 'gloss'));
  }

  // screw terminals near the aft end
  const tl = Math.min(0.09 * chipSpan, 0.5 * R);
  const tz = ztop + 0.08 * R;
  const termY = ya + 0.12 * Lfull;
  const termGeos: Geo[] = [];
  const termX: number[] = [];
  [-0.3, 0.26].forEach((tx, i) => {
    const dx = bad ? (rnd(50 + i) - 0.5) * 0.1 * R : 0;
    termX.push(tx * R + dx);
    termGeos.push(gBox(0.3 * R, tl, 0.16 * R, tx * R + dx, termY, tz));
    zincSolid.push(gCyl(0.08 * ru, 0.04 * R, 6, tx * R + dx, termY, ztop + 0.18 * R, 'z'));
  });

  // wires from the battery up to the terminals: red and black
  const rw = 0.035 * ru;
  const bAft = by - bl / 2;
  const redGeos: Geo[] = [];
  const blackGeos: Geo[] = [];
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  if (bad) {
    // loose wires that cross each other over the board
    const loop = (xs: number, xt: number, i: number) => {
      const p0 = V(xs, bAft, bzc);
      const pm = V((xs + xt) / 2 + (rnd(80 + i) - 0.5) * 0.3 * R, (bAft + termY) / 2 + (rnd(85 + i) - 0.5) * 0.1 * Lfull, ztop + (0.3 + 0.2 * rnd(90 + i)) * R);
      return gWirePath([p0, pm, V(xt, termY, ztop + 0.2 * R)], rw);
    };
    redGeos.push(...loop(bx + 0.12 * R, termX[0], 0));
    blackGeos.push(...loop(bx - 0.12 * R, termX[1], 1));
  } else {
    redGeos.push(...gWirePath([V(bx + 0.12 * R, bAft, bzc), V(termX[1], termY, bzc), V(termX[1], termY, ztop + 0.1 * R)], rw));
    blackGeos.push(...gWirePath([V(bx - 0.12 * R, bAft, bzc), V(termX[0], termY, bzc), V(termX[0], termY, ztop + 0.1 * R)], rw));
  }

  // antenna wire standing off the top face
  const az = ztop + 0.12 * R;
  const aTop = yb - 0.1 * Lfull;
  const aLen = 0.45 * Lfull;
  const ar = Math.max(0.03 * ru, EPS);
  zincSolid.push(gCyl(ar, 0.12 * R, 4, 0.56 * R, aTop, ztop + 0.06 * R, 'z'));
  if (bad) {
    const mid = V(0.56 * R, aTop - aLen * 0.5, az);
    const kink = V(0.4 * R, aTop - aLen * 0.62, az + 0.05 * R);
    const end = V(0.45 * R, aTop - aLen, az);
    addMerged(asmDet, ctx, gWirePath([V(0.56 * R, aTop, az), mid, kink, end], ar * 1.4), 0xb04a2a, 'satin');
    // loose jumper from a chip to a terminal
    redGeos.push(...gWirePath([V(-0.2 * R, yAt(0.2), ztop + 0.12 * R), V(-0.3 * R, ya + 0.14 * Lfull, ztop + 0.3 * R)], ar));
  } else {
    zincSolid.push(gCyl(ar, aLen, 4, 0.56 * R, aTop - aLen / 2, az));
  }

  if (!bad) {
    // four brass standoffs with screw heads
    const sxs = hw - 0.07 * R;
    const sH = Math.max(zbot - bzBot, EPS);
    const stand: Geo[] = [];
    const heads: Geo[] = [];
    for (const sxx of [-1, 1]) {
      for (const syy of [yb - 0.05 * Lfull, ya + 0.05 * Lfull]) {
        stand.push(gCyl(0.055 * ru, sH, 6, sxx * sxs, syy, (zbot + bzBot) / 2, 'z', true));
        heads.push(gDisc(0.06 * ru, 6, 'z', sxx * sxs, syy, ztop + 0.002 * R));
      }
    }
    addMerged(asmDet, ctx, stand, K.brass, 'metal');
    addMerged(asmDet, ctx, heads, K.zinc, 'metal', true);
  } else {
    // glue between the board and the sled instead of standoffs, and glue blobs on the board
    const sr = Math.min(0.07 * R, 0.04 * Lfull);
    const glue = mixColor(PART_COLORS.glue, pcbColor, 0.15);
    const blobs: Geo[] = [];
    for (let i = 0; i < 3; i++) blobs.push(gSph(sr, (rnd(60 + i) - 0.5) * 1.0 * R, yAt(0.1 + 0.8 * rnd(70 + i)), ztop + sr * 0.5));
    for (const sxx of [-1, 1]) blobs.push(gSph(sr * 1.3, sxx * (0.62 * R), yAt(0.2 + 0.6 * rnd(95 + sxx)), zbot - sr * 0.6));
    addMerged(asmDet, ctx, blobs, glue, 'satin');
  }

  if (best) {
    // threaded rods along the sled edges, with a nut at each end
    const rx = sw + 0.045 * R;
    const rl = Math.max(yb - ya, EPS);
    const nt = 0.06 * R;
    const rods: Geo[] = [];
    for (const sxx of [-1, 1]) {
      rods.push(gCyl(0.04 * R, rl, 6, sxx * rx, (ya + yb) / 2, zs, 'y', true));
      rods.push(gCyl(0.062 * R, nt, 6, sxx * rx, ya + nt / 2, zs));
      rods.push(gCyl(0.062 * R, nt, 6, sxx * rx, yb - nt / 2, zs));
    }
    zincSolid.push(...rods);
    // header row (black base, gold pins) and gold pads
    const hy = yb - 0.07 * Lfull;
    icGeos.push(gBox(0.7 * R, 0.1 * ru, 0.08 * R, 0, hy, ztop + 0.04 * R));
    const goldSolid: Geo[] = [];
    for (let i = 0; i < 6; i++) goldSolid.push(gBox(0.05 * R, 0.05 * ru, 0.12 * R, (-0.3 + 0.12 * i) * R, hy, ztop + 0.14 * R));
    addMerged(asmDet, ctx, goldSolid, K.gold, 'metal');
    for (let i = 0; i < 4; i++) pads.push(gPlane(0.08 * R, 0.08 * ru, 'z', (-0.35 + 0.233 * i) * R, ya + 0.04 * Lfull, ztop + 0.0015 * R));
    // arming screw-switch: green block, brass screw with a slot
    const swx = 0.42 * R;
    const swy = yAt(0.68);
    termGeos.push(gBox(0.28 * R, 0.22 * ru, 0.1 * R, swx, swy, ztop + 0.05 * R));
    addMerged(asmDet, ctx, [gCyl(0.07 * ru, 0.05 * R, 8, swx, swy, ztop + 0.125 * R, 'z')], K.brass, 'metal');
    icGeos.push(gBox(0.11 * R, 0.016 * R, 0.01 * R, swx, swy, ztop + 0.153 * R));
    // status LED
    const led = new THREE.Mesh(
      sharedGeometry(ctx, `led|${R}`, () => new THREE.SphereGeometry(mx(0.05 * ru), 6, 4)),
      partMaterial(K.led, ctx, { finish: 'gloss' }),
    );
    led.position.set(-0.5 * R, yb - 0.1 * Lfull, ztop + 0.04 * R);
    asmDet.add(led);
  }

  addMerged(asmDet, ctx, icGeos, chipColor, 'satin');
  addMerged(asmDet, ctx, pads, best ? K.gold : K.zinc, 'metal', true);
  addMerged(asmDet, ctx, termGeos, bad ? K.termBlue : K.termGreen, 'satin');
  addMerged(asmDet, ctx, zincSolid, K.zinc, 'metal');
  addMerged(asmDet, ctx, redGeos, K.wireRed, 'satin');
  addMerged(asmDet, ctx, blackGeos, K.wireBlack, 'satin');

  if (bad) asm.rotation.y = (rnd(0) - 0.5) * 1.2;
  g.add(asm);
  return finish(g, det);
});

// ---------------------------------------------------------------------------------
// camera: a body with a lens barrel pointing radially (+X), on a mounting plate

export const buildCamera: PartBuilder<MassComponent> = scopedPart((c, tier, ctx) => {
  const sp = massSpan(c, ctx);
  if (!sp) return new THREE.Group();
  const { h, yc, R } = sp;
  const id = keyOf(c);
  const rnd = (i: number) => seeded(id, i);
  const best = tier === 'best';
  const bad = tier === 'bad';
  const g = new THREE.Group();
  const asm = new THREE.Group();
  const det = detailGroup();

  const ru = Math.min(R, 0.25 * h); // unit for round details that reach along the axis
  const bodyColor = baseColor(c.color, 0x30343b, tier);
  const bodyW = 0.9 * R;
  const bodyZ = 0.8 * R;
  const bodyL = Math.min(0.62 * h, 2.4 * R);
  const xb = -0.17 * R;
  const xFace = xb + bodyW / 2;
  const mount = mixColor(PART_COLORS.ring, 0x000000, bad ? 0.2 : 0.1);

  // body and mounting plate (the plate is the sled that carries it)
  asm.add(box(ctx, bodyColor, bodyW, bodyL, bodyZ, xb, yc, 0, bad ? 'matte' : 'satin'));
  const plateL = (bad ? 0.88 : 0.94) * h;
  const pt = 0.06 * R;
  const pz = -(bodyZ / 2 + pt / 2);
  det.add(box(ctx, best ? K.zinc : mount, 1.05 * R, plateL, pt, -0.175 * R, yc, pz, best ? 'metal' : bad ? 'matte' : 'satin'));

  // lens barrel pointing out of the +X face
  const rl = Math.min(0.28 * R, 0.4 * bodyL);
  const lens = new THREE.Group();
  lens.position.set(xFace, yc, bad ? (rnd(4) - 0.5) * 0.3 * R : 0);
  if (bad) lens.rotation.z = (rnd(3) > 0.5 ? 1 : -1) * Math.min(0.14, (0.1 * h) / R);
  const barrel = 0.34 * R;
  lens.add(cyl(ctx, mixColor(bodyColor, 0x000000, 0.25), rl, barrel, SEG[tier], barrel / 2, 0, 0, 'x', rl, 'satin'));
  // bezel ring (machined metal; cheap plastic on a crude build), then the glass
  lens.add(cyl(ctx, bad ? mixColor(bodyColor, 0xffffff, 0.3) : K.zinc, rl * 0.9, 0.12 * R, SEG[tier], barrel + 0.06 * R, 0, 0, 'x', rl * 0.9, bad ? 'satin' : 'metal'));
  lens.add(cyl(ctx, K.glass, rl * 0.65, 0.03 * R, SEG[tier], barrel + 0.135 * R, 0, 0, 'x', rl * 0.65, bad ? 'matte' : 'gloss'));
  if (!bad) {
    // a small reflection dot on the glass, off-centre
    addMerged(lens, ctx, [gDisc(0.12 * rl, 8, 'x', barrel + 0.152 * R, 0.28 * rl, 0.28 * rl)], 0x8896b8, 'gloss', true);
  }
  if (best) {
    // machined shroud round the lens base
    addMerged(lens, ctx, [gCyl(1.3 * rl, 0.22 * R, SEG.best, 0.11 * R, 0, 0, 'x', true)], K.zinc, 'metal');
  }
  det.add(lens);

  if (!bad) {
    // record LED on top and a second dot on the front, a button on the end
    const ledGeos: Geo[] = [
      gBox(0.1 * R, Math.min(0.08 * bodyL, 0.12 * R), 0.03 * R, xb - 0.2 * R, yc + 0.3 * bodyL, bodyZ / 2 + 0.015 * R),
      gDisc(Math.min(0.04 * R, 0.05 * bodyL), 8, 'x', xFace + 0.002 * R, yc + 0.44 * bodyL, 0.3 * R),
    ];
    addMerged(det, ctx, ledGeos, K.ledRed, 'gloss', true);
    const bh = Math.min(0.04 * R, 0.08 * h);
    det.add(cyl(ctx, mixColor(bodyColor, 0xffffff, 0.18), 0.07 * R, bh, 8, xb + 0.12 * R, yc + bodyL / 2 + bh / 2, 0, 'y', 0.07 * R, 'satin'));
  }
  if (best) {
    det.add(box(ctx, mixColor(bodyColor, 0xffffff, 0.12), bodyW + 0.06 * R, 0.12 * bodyL, 0.04 * R, xb, yc, bodyZ / 2 + 0.02 * R, 'satin'));
    // microSD slot line
    addMerged(det, ctx, [gPlane(0.28 * R, 0.03 * R, 'z', xb + 0.12 * R, yc - 0.34 * bodyL, bodyZ / 2 + 0.002 * R)], 0x0a0b0d, 'satin', true);
    const screws: Geo[] = [];
    for (const bxx of [-0.55, 0.2]) {
      for (const sy of [-1, 1]) {
        screws.push(gCyl(0.07 * ru, 0.04 * R, 6, bxx * R, yc + sy * 0.42 * h, pz - pt / 2 - 0.02 * R, 'z'));
      }
    }
    addMerged(det, ctx, screws, K.zinc, 'metal');
    const cableA = new THREE.Vector3(xb - 0.3 * R, yc - bodyL / 2, 0);
    const cableB = new THREE.Vector3(xb - 0.3 * R, yc - Math.max(0.46 * h, bodyL / 2 + 1e-9), pz);
    const cable = gWire(cableA, cableB, 0.04 * ru);
    if (cable) addMerged(det, ctx, [cable], 0xd8d2c0, 'satin');
  } else if (bad) {
    // masking tape round body and plate, glue blobs round the lens base, scuffs on the body
    const tapeH = 0.2 * bodyL;
    addMerged(det, ctx, gFrame(1.06 * R, tapeH, bodyZ + pt + 0.04 * R, 0.03 * R, -0.175 * R, yc + 0.18 * bodyL, -0.03 * R), K.tape, 'matte');
    const sr = Math.min(0.07 * R, 0.15 * h);
    const blobs: Geo[] = [];
    for (let i = 0; i < 3; i++) {
      blobs.push(gSph(sr, xFace + 0.02 * R, yc + (rnd(11 + i) - 0.5) * 2 * Math.max(rl, EPS), (rnd(21 + i) - 0.5) * 0.5 * R));
    }
    addMerged(det, ctx, blobs, mixColor(PART_COLORS.glue, bodyColor, 0.2), 'satin');
    const scuffs: Geo[] = [];
    for (let i = 0; i < 4; i++) {
      scuffs.push(gPlane(Math.min(0.2 * R, 0.25 * bodyL), 0.014 * R, 'z', xb + (rnd(120 + i) - 0.5) * 0.6 * R, yc + (rnd(125 + i) - 0.5) * 0.6 * bodyL, bodyZ / 2 + 0.002 * R, (rnd(130 + i) - 0.5) * 2.2));
    }
    addMerged(det, ctx, scuffs, mixColor(bodyColor, 0xffffff, 0.35), 'satin', true);
    asm.rotation.y = (rnd(0) - 0.5) * 0.8;
  } else {
    // webbing strap round body and plate
    const sx = 1.07 * R;
    const sz = bodyZ + pt + 0.02 * R;
    addMerged(det, ctx, gFrame(sx, 0.1 * bodyL, sz, 0.035 * R, -0.175 * R, yc - 0.42 * bodyL, -pt / 2), 0x25282d, 'matte');
  }
  asm.add(det);
  g.add(asm);
  return g;
});

// ---------------------------------------------------------------------------------
// streamer: a tight roll of film held by rubber bands on an attachment line, with a loose
// tail (best, ok); a crumpled accordion wad (bad)

export const buildStreamer: PartBuilder<Parachute> = scopedPart((c, tier, ctx) => {
  if (!(fin(c.x) && fin(c.length) && c.length >= 0 && fin(ctx.maxRadius) && ctx.maxRadius > 0)) return new THREE.Group();
  const R = 0.7 * ctx.maxRadius;
  const y1 = -c.x;
  const y0 = c.length === 0 ? y1 - 0.6 * ctx.maxRadius : -(c.x + c.length);
  const h = y1 - y0;
  const id = keyOf(c);
  const rnd = (i: number) => seeded(id, i);
  const best = tier === 'best';
  const bad = tier === 'bad';
  const g = new THREE.Group();
  const det = detailGroup();

  const base = baseColor(c.color, K.streamer, tier);
  const look: PartFinish = best ? 'gloss' : bad ? 'matte' : 'satin';
  const bHalf = 0.3 * R; // half the ribbon width

  /** Loose tail: a ribbon strip from yTop to the aft end, twisting as it falls. */
  const tail = (yTop: number, ns: number, A: number, B: number, twist: number, f1: number, jitter: boolean, color: number) => {
    const p1 = rnd(1) * TWO_PI;
    const p2 = rnd(2) * TWO_PI;
    const pos = new Float32Array((ns + 1) * 2 * 3);
    const idx: number[] = [];
    for (let s = 0; s <= ns; s++) {
      const u = s / ns;
      const y = s === ns ? y0 : yTop - u * (yTop - y0);
      const grow = 0.2 + 0.8 * u;
      const cx = A * grow * Math.sin(TWO_PI * f1 * u + p1) + (jitter ? (rnd(130 + s) - 0.5) * 0.12 * R : 0);
      const cz = B * grow * Math.sin(TWO_PI * f1 * u + p2);
      const phi = Math.PI / 2 + twist * u * (jitter ? 0.6 + rnd(140 + s) : 1);
      const wx = Math.cos(phi) * bHalf;
      const wz = Math.sin(phi) * bHalf;
      pos.set([cx + wx, y, cz + wz, cx - wx, y, cz - wz], s * 6);
      if (s < ns) {
        const o = s * 2;
        idx.push(o, o + 1, o + 2, o + 2, o + 1, o + 3);
      }
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tg.setIndex(idx);
    tg.computeVertexNormals();
    g.add(new THREE.Mesh(tg, partMaterial(color, ctx, { finish: look })));
  };

  if (!bad) {
    // ---- a tight roll, axis along the rocket
    const lc = Math.min(0.14 * h, 2.2 * R); // attachment line / swivel zone at the fore end
    const yR1 = y1 - 0.9 * lc;
    const Lz = y1 - yR1;
    const Lr = 0.62 * h;
    const yR0 = yR1 - Lr;
    const yRc = (yR1 + yR0) / 2;
    const rr = (best ? 0.56 : 0.6) * R;
    g.add(cyl(ctx, base, rr, Lr, SEG[tier], 0, yRc, 0, 'y', rr, look));

    // concentric wrap edges and the start of the spiral on both roll ends
    const nr = best ? 5 : 3;
    const rseg = radialSegments(best ? 24 : 16, 'inner');
    const wrap: Geo[] = [];
    const aStart = rnd(4) * TWO_PI;
    for (const yEnd of [yR1, yR0]) {
      for (let k = 0; k < nr; k++) {
        const rk = rr * (0.2 + 0.72 * (k / Math.max(nr - 1, 1)));
        const w = rr * (best ? 0.03 : 0.045);
        wrap.push(gRingY(rk - w / 2, rk + w / 2, rseg, yEnd));
      }
      wrap.push(gRadial(0.75 * rr, rr * 0.04, 0.575 * rr, aStart, yEnd));
    }
    addMerged(det, ctx, wrap, best ? K.mylar : mixColor(base, 0x000000, 0.3), best ? 'gloss' : 'satin', true);

    // the loose outer edge of the film: a tangent lip running the length of the roll
    {
      const aLip = rnd(5) * TWO_PI;
      const s = 0.45 * rr;
      const lip = new THREE.BoxGeometry(mx(s), mx(Lr * 0.98), mx(0.03 * rr));
      lip.translate(s / 2, 0, 0);
      lip.rotateY(-(aLip + Math.PI / 2));
      lip.translate(rr * Math.cos(aLip), yRc, rr * Math.sin(aLip));
      addMerged(det, ctx, [lip], mixColor(base, 0xffffff, 0.15), look);
    }

    // rubber bands: one on a kit build, two neat ones on a best build
    const bw = Math.min(0.09 * Lr, 0.35 * R);
    const bandAt = best ? [yR1 - 0.27 * Lr, yR1 - 0.73 * Lr] : [yRc];
    addMerged(det, ctx, bandAt.map((yy) => gCyl(rr * 1.035, bw, SEG[tier], 0, yy, 0, 'y', true)), K.band, 'satin');

    // attachment line
    if (best) {
      const re = Math.min(0.09 * R, 0.18 * Lz);
      const tube = 0.22 * re;
      const yEyeBot = y1 - 2 * (re + tube);
      const sl = 0.35 * Lz;
      const eye = new THREE.TorusGeometry(mx(re), mx(tube), 4, 8);
      eye.translate(0, y1 - re - tube, 0);
      addMerged(det, ctx, [gCyl(0.07 * R, sl, 6, 0, yEyeBot - sl / 2, 0), eye], K.zinc, 'metal');
      const cl = Math.max(yEyeBot - sl - yR1, EPS);
      addMerged(det, ctx, [gCyl(0.03 * R, cl, 4, 0, yR1 + cl / 2, 0)], K.nylon, 'satin');
    } else {
      addMerged(det, ctx, [gCyl(0.03 * R, Lz, 4, 0, y1 - Lz / 2, 0), gSph(Math.min(0.07 * R, 0.2 * Lz), 0, y1 - 0.45 * Lz, 0)], K.nylon, 'matte');
    }

    // loose tail from the aft end of the roll
    tail(yR0, best ? 10 : 7, (best ? 0.12 : 0.2) * R, (best ? 0.05 : 0.1) * R, best ? 0.4 : 0.8, best ? 1.0 : 1.3, false, mixColor(base, 0xffffff, 0.12));
    return finish(g, det);
  }

  // ---- bad: an accordion-folded wad that has been crumpled together
  const aNom = 0.78 * R; // half length of a fold (across the bundle)
  const Hb = 0.68 * h;
  const yb = y1 - Hb;
  const n = clamp(Math.round(Hb / (0.2 * R)), 3, 14);
  const weights: number[] = [];
  for (let i = 0; i < n; i++) weights.push(0.6 + 0.8 * rnd(100 + i));
  const wsum = weights.reduce((s, v) => s + v, 0);
  const centres: number[] = [];
  const pitches: number[] = [];
  let top = y1;
  for (let i = 0; i < n; i++) {
    const p = (Hb * weights[i]) / wsum;
    centres.push(top - p / 2);
    pitches.push(p);
    top -= p;
  }
  const evenLayers: Geo[] = [];
  const oddLayers: Geo[] = [];
  const folds: Geo[] = [];
  for (let i = 0; i < n; i++) {
    const t = pitches[i] * 0.7;
    const a = aNom * (0.8 + 0.2 * rnd(110 + i));
    const dx = (rnd(120 + i) - 0.5) * 0.12 * R;
    (i % 2 === 0 ? evenLayers : oddLayers).push(gBox(2 * a, t, 2 * bHalf, dx, centres[i], 0));
    if (i < n - 1) {
      // rounded fold joining this layer to the next, alternating sides
      const rf = Math.min((centres[i] - centres[i + 1]) / 2, 0.3 * R);
      const side = i % 2 === 0 ? 1 : -1;
      const fx = side * Math.max(a - rf, 0);
      folds.push(gCyl(rf, 2 * bHalf, 8, fx, (centres[i] + centres[i + 1]) / 2, 0, 'z'));
    }
  }
  addMerged(g, ctx, evenLayers, base, look);
  addMerged(det, ctx, oddLayers, mixColor(base, 0xffffff, 0.35), look);
  addMerged(det, ctx, folds, base, look);

  tail(Math.min(centres[n - 1], yb), 9, 0.4 * R, 0.25 * R, 2.5, 1.8, true, mixColor(base, 0xffffff, 0.12));

  // crumpled lumps on the sides of the wad
  const lr = Math.min(0.14 * R, 0.2 * Hb);
  const lumps: Geo[] = [];
  for (let i = 0; i < 4; i++) {
    const sx = (rnd(170 + i) > 0.5 ? 1 : -1) * aNom * (0.6 + 0.3 * rnd(175 + i));
    lumps.push(gSph(lr, sx, clamp(y1 - Hb * rnd(180 + i), yb + lr, y1 - lr), (rnd(185 + i) - 0.5) * 0.4 * R));
  }
  addMerged(det, ctx, lumps, mixColor(base, 0x000000, 0.12), look);

  // a short, knotted scrap of cord
  const lcb = Math.min(0.12 * h, 1.5 * R);
  addMerged(det, ctx, [gCyl(0.04 * R, lcb, 4, 0, y1 - lcb / 2, 0), gSph(Math.min(0.08 * R, 0.2 * lcb), 0, y1 - 0.6 * lcb, 0)], K.nylon, 'matte');

  // masking tape round the wad and glue blobs
  addMerged(
    det,
    ctx,
    gFrame(2 * aNom + 0.06 * R, Math.min(0.16 * Hb, 0.4 * R), 2 * bHalf + 0.06 * R, 0.03 * R, 0, y1 - (0.3 + 0.4 * rnd(3)) * Hb, 0),
    K.tape,
    'matte',
  );
  const sr = Math.min(0.08 * R, 0.1 * h);
  const glue = mixColor(PART_COLORS.glue, base, 0.2);
  const blobs: Geo[] = [];
  for (let i = 0; i < 3; i++) {
    const sx = (rnd(150 + i) > 0.5 ? 1 : -1) * aNom * 0.9;
    blobs.push(gSph(sr, sx, clamp(y1 - Hb * rnd(160 + i), y1 - Hb + sr, y1 - sr), 0));
  }
  addMerged(det, ctx, blobs, glue, 'satin');
  return finish(g, det);
});
