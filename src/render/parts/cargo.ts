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

import * as THREE from 'three';
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

function fin(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

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

// Pieces of one part with the same shape (discs, screws, blobs, tape slabs) share one
// geometry; every mesh carries its own position and rotation.

function box(ctx: PartContext, color: number, sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.Mesh {
  const bx = Math.max(sx, EPS);
  const by = Math.max(sy, EPS);
  const bz = Math.max(sz, EPS);
  const m = new THREE.Mesh(
    sharedGeometry(ctx, `box|${bx}|${by}|${bz}`, () => new THREE.BoxGeometry(bx, by, bz)),
    partMaterial(color, ctx),
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
): THREE.Mesh {
  const rTop = Math.max(r2, EPS);
  const rBot = Math.max(r, EPS);
  const h = Math.max(len, EPS);
  const n = radialSegments(Math.max(3, seg), 'inner');
  const g = sharedGeometry(ctx, `cyl|${rTop}|${rBot}|${h}|${n}|${axis}`, () => {
    const cg = new THREE.CylinderGeometry(rTop, rBot, h, n, 1);
    if (axis === 'x') cg.rotateZ(-Math.PI / 2);
    else if (axis === 'z') cg.rotateX(Math.PI / 2);
    return cg;
  });
  const m = new THREE.Mesh(g, partMaterial(color, ctx));
  m.position.set(x, y, z);
  return m;
}

function blob(ctx: PartContext, color: number, r: number, x: number, y: number, z: number): THREE.Mesh {
  const rr = Math.max(r, EPS);
  const m = new THREE.Mesh(sharedGeometry(ctx, `blob|${rr}`, () => new THREE.SphereGeometry(rr, 6, 4)), partMaterial(color, ctx));
  m.position.set(x, y, z);
  return m;
}

/** Thin cylinder between two points. */
function wire(ctx: PartContext, a: THREE.Vector3, b: THREE.Vector3, rad: number, color: number): THREE.Mesh | null {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (!(len > 1e-12)) return null;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 4, 1), partMaterial(color, ctx));
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

/** A rectangular wrap (four slabs) around the axis-aligned footprint sx x sz, height sy. */
function frame(ctx: PartContext, color: number, sx: number, sy: number, sz: number, t: number, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const tt = Math.min(t, sx / 2, sz / 2);
  g.add(box(ctx, color, sx, sy, tt, x, y, z + sz / 2 - tt / 2));
  g.add(box(ctx, color, sx, sy, tt, x, y, z - sz / 2 + tt / 2));
  g.add(box(ctx, color, tt, sy, Math.max(sz - 2 * tt, EPS), x + sx / 2 - tt / 2, y, z));
  g.add(box(ctx, color, tt, sy, Math.max(sz - 2 * tt, EPS), x - sx / 2 + tt / 2, y, z));
  return g;
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
// ballast: steel discs on a bolt (best), lead discs (ok), a lump of clay (bad)

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
    for (let i = 0; i < n; i++) {
      g.add(cyl(ctx, steel, R, slot * 0.92, seg, 0, y1 - hb - slot * (i + 0.5), 0));
    }
    const brass = mixColor(steel, 0xc9962b, 0.8);
    det.add(cyl(ctx, brass, 0.11 * R, h, 8, 0, yc, 0));
    det.add(cyl(ctx, brass, 0.3 * R, hb, 6, 0, y1 - hb / 2, 0));
    det.add(cyl(ctx, brass, 0.3 * R, hb, 6, 0, y0 + hb / 2, 0));
  } else if (tier === 'ok') {
    const lead = baseColor(c.color, 0x5c6068, tier);
    const n = clamp(Math.round(h / (0.7 * R)), 1, 4);
    const dh = h / n;
    for (let i = 0; i < n; i++) {
      const y = y1 - dh * (i + 0.5);
      if (i % 2 === 0) g.add(cyl(ctx, lead, R, dh, seg, 0, y, 0));
      else det.add(cyl(ctx, mixColor(lead, 0x000000, 0.14), R, dh, seg, 0, y, 0));
    }
  } else {
    // a lump of modelling clay: poles and shoulders pulled in, every vertex nudged inward
    const clay = baseColor(c.color, mixColor(PART_COLORS.bare, 0x7a4a2a, 0.4), tier);
    const ts = [0, 0, 0.12, 0.4, 0.7, 0.9, 1, 1];
    const rs = [0, 0.85, 1, 1, 1, 0.97, 0.85, 0];
    const profile: [number, number][] = ts.map((t, i) => [y1 - t * h, R * rs[i]]);
    const radial = (k: number, j: number) => 1 - 0.3 * seeded(id, k * 53 + j);
    g.add(new THREE.Mesh(lathe(profile, seg, radial), partMaterial(clay, ctx)));
    // a strip of tape and some glue blobs
    const tape = mixColor(0xe8dfc0, clay, 0.15);
    const th = Math.min(0.18 * h, 0.5 * R);
    const ty = y0 + th / 2 + (h - th) * (0.3 + 0.4 * seeded(id, 1));
    const band = new THREE.CylinderGeometry(R * 0.97, R * 0.97, Math.max(th, EPS), seg, 1, true);
    band.translate(0, ty, 0);
    det.add(new THREE.Mesh(band, partMaterial(tape, ctx)));
    const sr = Math.min(0.1 * R, 0.2 * h);
    const glue = mixColor(PART_COLORS.glue, clay, 0.2);
    for (let i = 0; i < 4; i++) {
      const a = seeded(id, 10 + i) * TWO_PI;
      const y = clamp(y0 + sr + (h - 2 * sr) * seeded(id, 20 + i), y0 + sr, y1 - sr);
      det.add(blob(ctx, glue, sr, 0.8 * R * Math.cos(a), y, 0.8 * R * Math.sin(a)));
    }
  }
  return finish(g, det);
});

// ---------------------------------------------------------------------------------
// flight computer: a PCB sled with chips, a battery, screw terminals and an antenna

export const buildFlightComputer: PartBuilder<MassComponent> = scopedPart((c, tier, ctx) => {
  const sp = massSpan(c, ctx);
  if (!sp) return new THREE.Group();
  const { y0, y1, h, yc, R } = sp;
  const id = keyOf(c);
  const rnd = (i: number) => seeded(id, i);
  const best = tier === 'best';
  const bad = tier === 'bad';
  const g = new THREE.Group();
  const det = detailGroup();
  const asm = new THREE.Group();
  const asmDet = new THREE.Group();
  asm.add(asmDet);

  const pcbColor = baseColor(c.color, 0x1f7a4d, tier);
  const chipColor = bad ? 0x2a2a26 : 0x1a1b1f;
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
    det.add(cyl(ctx, plate, 0.96 * R, tp, SEG.best, 0, y1 - tp / 2, 0));
    det.add(cyl(ctx, plate, 0.96 * R, tp, SEG.best, 0, y0 + tp / 2, 0));
    for (const sx of [-1, 1]) det.add(cyl(ctx, PART_COLORS.metal, 0.035 * R, Math.max(yb - ya, EPS), 6, sx * (hw + 0.04 * R), (ya + yb) / 2, 0));
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
  const board = box(ctx, pcbColor, 2 * hw, Lb, tb, 0, yBoard, 0);
  board.rotation.z = T;
  asm.add(board);
  const ztop = tb / 2;
  const zbot = -tb / 2;
  const chipSpan = Lfull;
  const yAt = (f: number) => yb - f * chipSpan;

  // chips on the top face
  const chips: { f: number; w: number; l: number; t: number; x: number }[] = [
    { f: 0.2, w: 0.3 * R, l: Math.min(0.1 * chipSpan, 0.5 * R), t: 0.07 * R, x: -0.2 * R },
    { f: 0.5, w: 0.46 * R, l: Math.min(0.16 * chipSpan, 0.8 * R), t: 0.09 * R, x: 0.12 * R },
    { f: 0.76, w: 0.34 * R, l: Math.min(0.1 * chipSpan, 0.5 * R), t: 0.07 * R, x: -0.18 * R },
  ];
  chips.forEach((ch, i) => {
    const dx = bad ? (rnd(10 + i) - 0.5) * 0.2 * R : 0;
    const dy = bad ? (rnd(20 + i) - 0.5) * 0.06 * chipSpan : 0;
    const m = box(ctx, chipColor, ch.w, ch.l, ch.t, ch.x + dx, yAt(ch.f) + dy, ztop + ch.t / 2);
    if (bad) m.rotation.y = (rnd(30 + i) - 0.5) * 1.0;
    asmDet.add(m);
    if (best) {
      // gold pin strip along each long side of the chip
      const pin = mixColor(PART_COLORS.metal, 0xc9962b, 0.5);
      asmDet.add(box(ctx, pin, ch.w * 1.08, ch.l * 0.7, ch.t * 0.4, ch.x, yAt(ch.f), ztop + ch.t * 0.2));
    }
  });

  // battery under the board
  const bt = 0.3 * R;
  const bw = 0.62 * R;
  const bl = Math.min(0.34 * Lfull, 3 * R);
  const bx = -0.05 * R + (bad ? (rnd(40) - 0.5) * 0.16 * R : 0);
  const by = yb - 0.66 * Lfull;
  const bzc = zbot - bt / 2;
  const battery = box(ctx, 0x2d5fa8, bw, bl, bt, bx, by, bzc);
  asmDet.add(battery);
  if (best) {
    asmDet.add(box(ctx, 0xe6e8ec, bw * 0.7, bl * 0.5, bt * 1.04, bx, by, bzc));
  } else if (bad) {
    asmDet.add(frame(ctx, 0xe8dfc0, bw + 0.08 * R, 0.2 * bl, bt + 0.08 * R, 0.03 * R, bx, by + 0.1 * bl, bzc));
  }

  // screw terminals near the aft end
  const tl = Math.min(0.09 * chipSpan, 0.5 * R);
  const tz = ztop + 0.08 * R;
  [-0.3, 0.26].forEach((tx, i) => {
    const dx = bad ? (rnd(50 + i) - 0.5) * 0.1 * R : 0;
    asmDet.add(box(ctx, 0x2f6fd0, 0.3 * R, tl, 0.16 * R, tx * R + dx, ya + 0.12 * Lfull, tz));
    asmDet.add(cyl(ctx, PART_COLORS.metal, 0.06 * ru, 0.04 * R, 6, tx * R + dx, ya + 0.12 * Lfull, ztop + 0.18 * R, 'z'));
  });

  // antenna wire standing off the top face
  const az = ztop + 0.12 * R;
  const aTop = yb - 0.1 * Lfull;
  const aLen = 0.45 * Lfull;
  const ar = Math.max(0.03 * ru, EPS);
  asmDet.add(cyl(ctx, PART_COLORS.metal, ar, 0.12 * R, 4, 0.56 * R, aTop, ztop + 0.06 * R, 'z'));
  if (bad) {
    const mid = new THREE.Vector3(0.56 * R, aTop - aLen * 0.5, az);
    const kink = new THREE.Vector3(0.4 * R, aTop - aLen * 0.62, az + 0.05 * R);
    const end = new THREE.Vector3(0.45 * R, aTop - aLen, az);
    const w1 = wire(ctx, new THREE.Vector3(0.56 * R, aTop, az), mid, ar, 0xb04a2a);
    const w2 = wire(ctx, mid, kink, ar, 0xb04a2a);
    const w3 = wire(ctx, kink, end, ar, 0xb04a2a);
    for (const w of [w1, w2, w3]) if (w) asmDet.add(w);
    // loose jumper wires from a chip to a terminal, and solder / glue blobs
    const j = wire(ctx, new THREE.Vector3(-0.2 * R, yAt(0.2), ztop + 0.12 * R), new THREE.Vector3(-0.3 * R, ya + 0.14 * Lfull, ztop + 0.3 * R), ar, 0xc0392b);
    if (j) asmDet.add(j);
    const sr = Math.min(0.07 * R, 0.04 * Lfull);
    const glue = mixColor(PART_COLORS.glue, pcbColor, 0.15);
    for (let i = 0; i < 3; i++) {
      asmDet.add(blob(ctx, glue, sr, (rnd(60 + i) - 0.5) * 1.0 * R, yAt(0.1 + 0.8 * rnd(70 + i)), ztop + sr * 0.5));
    }
    asm.rotation.y = (rnd(0) - 0.5) * 1.2;
  } else {
    asmDet.add(cyl(ctx, PART_COLORS.metal, ar, aLen, 4, 0.56 * R, aTop - aLen / 2, az));
  }

  g.add(asm);
  asmDet.userData.detail = true;
  asmDet.name = 'detail';
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
  const det = new THREE.Group();
  det.name = 'detail';
  det.userData.detail = true;

  const ru = Math.min(R, 0.25 * h); // unit for round details that reach along the axis
  const bodyColor = baseColor(c.color, 0x30343b, tier);
  const bodyW = 0.9 * R;
  const bodyZ = 0.8 * R;
  const bodyL = Math.min(0.62 * h, 2.4 * R);
  const xb = -0.17 * R;
  const xFace = xb + bodyW / 2;
  const mount = mixColor(PART_COLORS.ring, 0x000000, bad ? 0.2 : 0.1);

  // body and mounting plate (the plate is the sled that carries it)
  asm.add(box(ctx, bodyColor, bodyW, bodyL, bodyZ, xb, yc, 0));
  const plateL = (bad ? 0.88 : 0.94) * h;
  const pt = 0.06 * R;
  const pz = -(bodyZ / 2 + pt / 2);
  det.add(box(ctx, mount, 1.05 * R, plateL, pt, -0.175 * R, yc, pz));

  // lens barrel pointing out of the +X face
  const rl = Math.min(0.28 * R, 0.4 * bodyL);
  const lens = new THREE.Group();
  lens.position.set(xFace, yc, 0);
  if (bad) lens.rotation.z = (rnd(3) > 0.5 ? 1 : -1) * Math.min(0.14, (0.1 * h) / R);
  const barrel = 0.34 * R;
  lens.add(cyl(ctx, mixColor(bodyColor, 0x000000, 0.25), rl, barrel, SEG[tier], barrel / 2, 0, 0, 'x'));
  lens.add(cyl(ctx, PART_COLORS.metal, rl * 0.9, 0.12 * R, SEG[tier], barrel + 0.06 * R, 0, 0, 'x'));
  lens.add(cyl(ctx, 0x1b2a55, rl * 0.65, 0.03 * R, SEG[tier], barrel + 0.135 * R, 0, 0, 'x'));
  if (best) lens.add(cyl(ctx, mixColor(bodyColor, 0xffffff, 0.2), rl * 1.2, 0.08 * R, SEG[tier], 0.12 * R, 0, 0, 'x'));
  det.add(lens);

  if (!bad) {
    // record LED on top, a ribbon cable out of the back
    det.add(box(ctx, 0xd33a2c, 0.1 * R, Math.min(0.08 * bodyL, 0.12 * R), 0.03 * R, xb - 0.2 * R, yc + 0.3 * bodyL, bodyZ / 2 + 0.015 * R));
  }
  if (best) {
    det.add(box(ctx, mixColor(bodyColor, 0xffffff, 0.12), bodyW + 0.06 * R, 0.12 * bodyL, 0.04 * R, xb, yc, bodyZ / 2 + 0.02 * R));
    for (const bxx of [-0.55, 0.2]) {
      for (const sy of [-1, 1]) {
        det.add(cyl(ctx, PART_COLORS.metal, 0.07 * ru, 0.04 * R, 6, bxx * R, yc + sy * 0.42 * h, pz - pt / 2 - 0.02 * R, 'z'));
      }
    }
    const cable = wire(
      ctx,
      new THREE.Vector3(xb - 0.3 * R, yc - bodyL / 2, 0),
      new THREE.Vector3(xb - 0.3 * R, yc - Math.max(0.46 * h, bodyL / 2 + 1e-9), pz),
      0.04 * ru,
      0xd8d2c0,
    );
    if (cable) det.add(cable);
  } else if (bad) {
    // masking tape round body and plate, and glue blobs around the lens base
    const tapeH = 0.2 * bodyL;
    det.add(frame(ctx, 0xe8dfc0, 1.06 * R, tapeH, bodyZ + pt + 0.04 * R, 0.03 * R, -0.175 * R, yc + 0.18 * bodyL, -0.03 * R));
    const sr = Math.min(0.07 * R, 0.15 * h);
    const glue = mixColor(PART_COLORS.glue, bodyColor, 0.2);
    for (let i = 0; i < 3; i++) {
      det.add(blob(ctx, glue, sr, xFace + 0.02 * R, yc + (rnd(11 + i) - 0.5) * 2 * Math.max(rl, EPS), (rnd(21 + i) - 0.5) * 0.5 * R));
    }
    asm.rotation.y = (rnd(0) - 0.5) * 0.8;
  }
  asm.add(det);
  g.add(asm);
  return g;
});

// ---------------------------------------------------------------------------------
// streamer: an accordion-folded ribbon bundle with a loose tail

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

  const base = baseColor(c.color, 0xf5c518, tier);
  const alt = mixColor(base, 0xffffff, 0.35);
  const aNom = 0.78 * R; // half length of a fold (across the bundle)
  const bHalf = 0.3 * R; // half the ribbon width

  // accordion bundle in the fore 68 % of the span
  const Hb = 0.68 * h;
  const yb = y1 - Hb;
  const n = clamp(Math.round(Hb / (0.2 * R)), 3, 14);
  const weights: number[] = [];
  for (let i = 0; i < n; i++) weights.push(bad ? 0.6 + 0.8 * rnd(100 + i) : 1);
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
  for (let i = 0; i < n; i++) {
    const t = pitches[i] * (bad ? 0.7 : 0.5);
    const a = bad ? aNom * (0.8 + 0.2 * rnd(110 + i)) : aNom;
    const dx = bad ? (rnd(120 + i) - 0.5) * 0.12 * R : 0;
    const m = box(ctx, i % 2 === 0 ? base : alt, 2 * a, t, 2 * bHalf, dx, centres[i], 0);
    if (i % 2 === 0) g.add(m);
    else det.add(m);
    if (i < n - 1) {
      // rounded fold joining this layer to the next, alternating sides
      const rf = Math.min((centres[i] - centres[i + 1]) / 2, 0.3 * R);
      const side = i % 2 === 0 ? 1 : -1;
      const fx = side * Math.max(a - rf, 0);
      det.add(cyl(ctx, base, rf, 2 * bHalf, 8, fx, (centres[i] + centres[i + 1]) / 2, 0, 'z'));
    }
  }

  // loose tail: a ribbon strip from the last fold to the aft end
  const ns = best ? 10 : bad ? 9 : 7;
  const yTop = Math.min(centres[n - 1], yb + 0.0 * h);
  const A = (best ? 0.12 : bad ? 0.4 : 0.2) * R;
  const B = (best ? 0.05 : bad ? 0.25 : 0.1) * R;
  const twist = best ? 0.4 : bad ? 2.5 : 0.8;
  const f1 = best ? 1.0 : bad ? 1.8 : 1.3;
  const p1 = rnd(1) * TWO_PI;
  const p2 = rnd(2) * TWO_PI;
  const pos = new Float32Array((ns + 1) * 2 * 3);
  const idx: number[] = [];
  for (let s = 0; s <= ns; s++) {
    const u = s / ns;
    const y = s === ns ? y0 : yTop - u * (yTop - y0);
    const grow = 0.2 + 0.8 * u;
    const cx = A * grow * Math.sin(TWO_PI * f1 * u + p1) + (bad ? (rnd(130 + s) - 0.5) * 0.12 * R : 0);
    const cz = B * grow * Math.sin(TWO_PI * f1 * u + p2);
    const phi = Math.PI / 2 + twist * u * (bad ? 0.6 + rnd(140 + s) : 1);
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
  g.add(new THREE.Mesh(tg, partMaterial(mixColor(base, 0xffffff, 0.12), ctx)));

  const bandY = y1 - 0.5 * Hb;
  if (best) {
    // rubber band round the middle of the bundle and the shock-cord stub
    det.add(frame(ctx, mixColor(base, 0x000000, 0.65), 2 * aNom + 0.05 * R, Math.min(0.12 * Hb, 0.3 * R), 2 * bHalf + 0.05 * R, 0.025 * R, 0, bandY, 0));
    det.add(cyl(ctx, 0xc9c5b8, 0.04 * R, Math.min(0.12 * h, 2 * R), 6, 0, y1 - Math.min(0.12 * h, 2 * R) / 2, 0));
  } else if (bad) {
    det.add(frame(ctx, 0xe8dfc0, 2 * aNom + 0.06 * R, Math.min(0.16 * Hb, 0.4 * R), 2 * bHalf + 0.06 * R, 0.03 * R, 0, y1 - (0.3 + 0.4 * rnd(3)) * Hb, 0));
    const sr = Math.min(0.08 * R, 0.1 * h);
    const glue = mixColor(PART_COLORS.glue, base, 0.2);
    for (let i = 0; i < 3; i++) {
      const sx = (rnd(150 + i) > 0.5 ? 1 : -1) * aNom * 0.9;
      det.add(blob(ctx, glue, sr, sx, clamp(y1 - Hb * rnd(160 + i), y1 - Hb + sr, y1 - sr), 0));
    }
  }
  return finish(g, det);
});
