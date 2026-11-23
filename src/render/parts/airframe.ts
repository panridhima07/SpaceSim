// Airframe part designs: body tube (and interstage decoupler), launch lug, rail button,
// motor with nozzle, strap-on booster pod. Each is drawn at three build-quality tiers.
//
// A tier changes workmanship and detail only. The measured dimensions (length, radii,
// station, button height) are exact at every tier. Decorative detail (joint rings,
// stripes, bolts, seams, glue) lives under a child group tagged `userData.detail = true`
// and never stands more than 1.5% of the local radius proud of the true surface, nor
// outside the part's axial span (the strap-on pod's nose cap is the only exception, as
// the contract allows).
//
// Frame: rocket axis +Y, nose toward +Y, origin at the nose tip, station x is y = -x.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BodyTube, InnerTube, Ring } from '../../types';
import { PART_COLORS, TIER_ACCENT, mixColor, partMaterial, radialSegments, scopedPart, seeded, sharedGeometry } from './types';
import type { PartBuilder, PartContext, PartIconSet, PartTier } from './types';

// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------

type V3 = [number, number, number];

const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function mesh(
  geo: THREE.BufferGeometry,
  color: number,
  ctx: PartContext,
  shell = false,
): THREE.Mesh {
  return new THREE.Mesh(geo, shell ? partMaterial(color, ctx, { shell: true }) : partMaterial(color, ctx));
}

function detailGroup(): THREE.Group {
  const d = new THREE.Group();
  d.name = 'detail';
  d.userData.detail = true;
  return d;
}

/** Merge geometries into one (uv dropped, everything non-indexed). */
function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geos.length === 0) return null;
  const list = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute('uv');
    if (!n.getAttribute('normal')) n.computeVertexNormals();
    return n;
  });
  return mergeGeometries(list, false);
}

function addMerged(
  parent: THREE.Object3D,
  geos: THREE.BufferGeometry[],
  color: number,
  ctx: PartContext,
  name?: string,
): void {
  const m = merge(geos);
  if (!m) return;
  const mm = mesh(m, color, ctx);
  if (name) mm.name = name;
  parent.add(mm);
}

/** Open cylinder about the Y axis spanning y0..y1. Vertices at angle t are (r sin t, y, r cos t). */
function cyl(r: number, y0: number, y1: number, segs: number, cx = 0, cz = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, y1 - y0, segs, 1, true);
  g.translate(cx, (y0 + y1) / 2, cz);
  return g;
}

/** Flat annulus (or disc when ri = 0) in the XZ plane at height y. */
function annulus(ri: number, ro: number, y: number, segs: number): THREE.BufferGeometry {
  const g = ri > 0 ? new THREE.RingGeometry(ri, ro, segs) : new THREE.CircleGeometry(ro, segs);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

function lathe(pts: [number, number][], segs: number): THREE.BufferGeometry {
  return new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y)), segs);
}

function sphere(rad: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(rad, 8, 6);
  g.translate(x, y, z);
  return g;
}

/** Triangle strips joining successive closed loops of equal length. */
function loft(loops: V3[][]): THREE.BufferGeometry {
  const p: number[] = [];
  const push = (a: V3, b: V3, c: V3) => p.push(...a, ...b, ...c);
  for (let k = 0; k < loops.length - 1; k++) {
    const a = loops[k];
    const b = loops[k + 1];
    const n = a.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      push(a[i], b[i], a[j]);
      push(a[j], b[i], b[j]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

function ringLoop(n: number, y: number, radius: (i: number) => number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const r = radius(i);
    out.push([r * Math.sin(t), y, r * Math.cos(t)]);
  }
  return out;
}

/** Radius of a regular n-gon (circumradius r, vertex at angle 0) at angle t. */
function polyR(r: number, n: number, t: number): number {
  const s = (2 * Math.PI) / n;
  const m = ((t % s) + s) % s;
  return (r * Math.cos(Math.PI / n)) / Math.cos(m - s / 2);
}

/** A thin helical strip (paper seam) hugging a cylinder or an n-gon prism. */
function helixStrip(
  r: number,
  y0: number,
  y1: number,
  pitch: number,
  width: number,
  poly: number,
  lift: number,
): THREE.BufferGeometry | null {
  const len = y1 - y0;
  if (!(len > width * 2) || !(pitch > 0)) return null;
  const turns = (len - width) / pitch;
  const steps = Math.max(16, Math.min(800, Math.ceil(turns * 16)));
  const p: number[] = [];
  const pt = (k: number, side: number): V3 => {
    const f = k / steps;
    const yc = y0 + width / 2 + f * (len - width);
    const t = 2 * Math.PI * turns * f;
    const rad = (poly > 0 ? polyR(r, poly, t) : r) * lift;
    return [rad * Math.sin(t), yc + side * (width / 2), rad * Math.cos(t)];
  };
  for (let k = 0; k < steps; k++) {
    const a = pt(k, -1);
    const b = pt(k, 1);
    const c = pt(k + 1, -1);
    const d = pt(k + 1, 1);
    p.push(...a, ...b, ...c, ...c, ...b, ...d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** An uneven tape band: per-vertex radius jitter, all within the 1.5% rule. */
function lumpyBand(
  r: number,
  ya: number,
  yb: number,
  n: number,
  key: string,
  salt: number,
): THREE.BufferGeometry {
  const rad = (i: number) => r * (1.002 + 0.01 * seeded(key, salt + i));
  const jitter = Array.from({ length: n }, (_, i) => rad(i));
  return loft([ringLoop(n, ya, (i) => jitter[i]), ringLoop(n, yb, (i) => jitter[i])]);
}

const SEG_TUBE: Record<PartTier, number> = { best: 64, ok: 32, bad: 8 };
const SEG_SMALL: Record<PartTier, number> = { best: 32, ok: 24, bad: 8 };

// ---------------------------------------------------------------------------------------
// body tube (and interstage decoupler)
// ---------------------------------------------------------------------------------------

export const buildBodyTube: PartBuilder<BodyTube> = scopedPart((c, tier, ctx) => {
  const g = new THREE.Group();
  const r = c.outerRadius;
  const L = c.length;
  if (!pos(r) || !pos(L) || !fin(c.x)) return g;
  const key = String(c.id ?? '');
  const rnd = (i: number) => seeded(key, i);
  const y1 = -c.x;
  const y0 = -(c.x + L);
  const segs = radialSegments(SEG_TUBE[tier], 'outer');
  const base = c.color ?? (c.isDecoupler ? PART_COLORS.decoupler : PART_COLORS.tube);
  const skinColor =
    tier === 'bad' ? mixColor(base, PART_COLORS.bare, 0.18 + 0.14 * rnd(0)) : base;

  const skin = mesh(cyl(r, y0, y1, segs), skinColor, ctx, true);
  skin.name = 'skin';
  g.add(skin);

  // Cutaway: show the wall as an inner surface plus annular end faces.
  const t = c.thickness;
  if (ctx.cutaway && fin(t) && t > 0 && t < r) {
    const ri = r - t;
    const wallColor = mixColor(base, 0x000000, 0.2);
    // See-through like the skin, or the wall hides everything packed inside the tube.
    const wall = mesh(cyl(ri, y0, y1, segs), wallColor, ctx, true);
    wall.name = 'wall';
    g.add(wall);
    addMerged(g, [annulus(ri, r, y0, segs), annulus(ri, r, y1, segs)], wallColor, ctx, 'ends');
  }

  const d = detailGroup();
  if (tier === 'best') {
    const w = Math.min(0.008, L * 0.03);
    const dark = mixColor(base, 0x000000, 0.3);
    addMerged(d, [cyl(r * 1.008, y1 - w, y1, segs), cyl(r * 1.008, y0, y0 + w, segs)], dark, ctx, 'joints');
    const ph = Math.min(0.0012, L * 0.004);
    const py = y1 - L * 0.6;
    addMerged(d, [cyl(r * 1.004, py - ph / 2, py + ph / 2, segs)], dark, ctx, 'panel');
    if (c.isDecoupler) {
      const n = 16;
      const bh = 0.022 * r;
      const br = Math.min(0.07 * r, L * 0.15);
      const yc = y1 - L / 2;
      const bolts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const b = new THREE.CylinderGeometry(br, br, bh, 8, 1, false);
        b.rotateZ(-Math.PI / 2);
        b.translate(r * 1.001, 0, 0);
        b.rotateY((2 * Math.PI * i) / n);
        b.translate(0, yc, 0);
        bolts.push(b);
      }
      addMerged(d, bolts, PART_COLORS.metal, ctx, 'bolts');
    } else {
      const sh = Math.min(L * 0.06, r * 0.6);
      const sy = y1 - L * 0.22;
      addMerged(
        d,
        [cyl(r * 1.006, sy - sh / 2, sy + sh / 2, segs)],
        mixColor(base, PART_COLORS.nose, 0.8),
        ctx,
        'stripe',
      );
    }
  } else if (tier === 'bad') {
    const seamColor = mixColor(base, 0x3a2f20, 0.5);
    const seam = helixStrip(r, y0, y1, 4.4 * r, Math.min(0.06 * r, L * 0.2), segs, 1.008);
    if (seam) {
      const sm = mesh(seam, seamColor, ctx);
      sm.name = 'seam';
      d.add(sm);
    }
    const patches: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 3; k++) {
      const h = L * (0.08 + 0.12 * rnd(10 + k));
      const yc = y0 + h / 2 + (L - h) * rnd(20 + k);
      const facet = Math.floor(rnd(30 + k) * segs);
      const p = new THREE.CylinderGeometry(
        r * 1.006, r * 1.006, h, 1, 1, true, (facet * 2 * Math.PI) / segs, (2 * Math.PI) / segs,
      );
      p.translate(0, yc, 0);
      patches.push(p);
    }
    addMerged(d, patches, mixColor(base, PART_COLORS.bare, 0.75), ctx, 'patches');
    if (c.isDecoupler) {
      const tape: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 4; k++) {
        const hh = L * (0.04 + 0.05 * rnd(40 + k));
        const yc = y0 + hh / 2 + (L - hh) * rnd(50 + k);
        tape.push(lumpyBand(r, yc - hh / 2, yc + hh / 2, segs, key, 100 + 10 * k));
      }
      addMerged(d, tape, mixColor(base, PART_COLORS.bare, 0.5), ctx, 'tape');
    }
  }
  if (d.children.length) g.add(d);
  return g;
});

// ---------------------------------------------------------------------------------------
// launch lug
// ---------------------------------------------------------------------------------------

export const buildLaunchLug: PartBuilder<Ring> = scopedPart((c, tier, ctx) => {
  const g = new THREE.Group();
  const R = c.outerRadius;
  const L = c.length;
  if (!pos(R) || !pos(L) || !fin(c.x) || !fin(c.innerRadius) || c.innerRadius >= R) return g;
  const rin = Math.max(0, c.innerRadius);
  const mr = c.mountRadius;
  const mount = fin(mr) && mr > 0 ? mr : 0;
  const key = String(c.id ?? '');
  const rnd = (i: number) => seeded(key, i);
  const h = L / 2;
  const yc = -(c.x + h);

  const pts: [number, number][] = [];
  if (tier === 'best') {
    const ch = Math.min(0.3 * (R - rin), 0.12 * L);
    if (rin > 0) {
      pts.push(
        [rin, -h + ch], [rin + ch, -h], [R - ch, -h], [R, -h + ch],
        [R, h - ch], [R - ch, h], [rin + ch, h], [rin, h - ch], [rin, -h + ch],
      );
    } else {
      pts.push([0, -h], [R - ch, -h], [R, -h + ch], [R, h - ch], [R - ch, h], [0, h]);
    }
  } else if (rin > 0) {
    pts.push([rin, -h], [R, -h], [R, h], [rin, h], [rin, -h]);
  } else {
    pts.push([0, -h], [R, -h], [R, h], [0, h]);
  }

  const base = c.color ?? (tier === 'best' ? PART_COLORS.metal : PART_COLORS.ring);
  const color = tier === 'bad' ? mixColor(base, PART_COLORS.bare, 0.2 + 0.15 * rnd(0)) : base;
  const pivot = new THREE.Group();
  pivot.name = 'lug';
  pivot.position.set(mount + R, yc, 0);
  pivot.add(mesh(lathe(pts, radialSegments(SEG_SMALL[tier], 'small')), color, ctx));
  if (tier === 'bad') {
    const ang = ((1 + rnd(1)) * Math.PI) / 180;
    pivot.rotation.x = rnd(2) < 0.5 ? -ang : ang;
  }
  g.add(pivot);

  if (tier === 'best') {
    // a thin glue fillet runs along the line where the lug meets the body
    const d = detailGroup();
    const f = new THREE.BoxGeometry(0.15 * R, L, 0.5 * R);
    f.translate(mount + 0.075 * R, yc, 0);
    addMerged(d, [f], PART_COLORS.glue, ctx, 'fillet');
    g.add(d);
  }
  if (tier === 'bad') {
    const d = detailGroup();
    const gr = Math.min(0.7 * R, L * 0.2);
    const gx = mount + 0.3 * gr;
    addMerged(
      d,
      [sphere(gr, gx, -c.x - gr * 0.8, 0), sphere(gr * (0.7 + 0.3 * rnd(3)), gx, -(c.x + L) + gr * 0.8, 0)],
      PART_COLORS.glue,
      ctx,
      'glue',
    );
    g.add(d);
  }
  return g;
});

// ---------------------------------------------------------------------------------------
// rail button
// ---------------------------------------------------------------------------------------

export const buildRailButton: PartBuilder<Ring> = scopedPart((c, tier, ctx) => {
  const g = new THREE.Group();
  const R = c.outerRadius;
  const L = c.length;
  if (!pos(R) || !pos(L) || !fin(c.x) || !fin(c.innerRadius) || c.innerRadius >= R) return g;
  const rw = c.innerRadius > 0 ? c.innerRadius : 0.55 * R;
  const mr = c.mountRadius;
  const mount = fin(mr) && mr > 0 ? mr : 0;
  const key = String(c.id ?? '');
  const rnd = (i: number) => seeded(key, i);
  const yc = -(c.x + R);

  // Profile in (radius, t) with t = height off the body surface, 0..L.
  let pts: [number, number][];
  if (tier === 'best') {
    const fh = L * 0.25;
    const ch = Math.min(0.25 * fh, 0.2 * (R - rw));
    const rs = 0.35 * R;
    const dp = Math.min(0.1 * L, 0.3 * rs);
    pts = [
      [0, 0], [R - ch, 0], [R, ch], [R, fh], [rw, fh], [rw, L - fh], [R, L - fh],
      [R, L - ch], [R - ch, L], [rs, L], [rs, L - dp], [0, L - dp],
    ];
  } else if (tier === 'ok') {
    const fh = L * 0.3;
    pts = [[0, 0], [R, 0], [R, fh], [rw, fh], [rw, L - fh], [R, L - fh], [R, L], [0, L]];
  } else {
    const f1 = L * (0.14 + 0.06 * rnd(0));
    const f2 = L * (0.34 + 0.08 * rnd(1));
    pts = [[0, 0], [R, 0], [R, f1], [rw, f1], [rw, L - f2], [R, L - f2], [R, L], [0, L]];
  }
  const base = c.color ?? (tier === 'best' ? PART_COLORS.metal : PART_COLORS.ring);
  const color = tier === 'bad' ? mixColor(base, PART_COLORS.bare, 0.2 + 0.15 * rnd(2)) : base;
  const geo = lathe(pts, radialSegments(SEG_SMALL[tier], 'small'));
  geo.rotateZ(-Math.PI / 2); // radial axis along +X, height t becomes x
  geo.translate(mount, yc, 0);
  g.add(mesh(geo, color, ctx));

  if (tier === 'bad') {
    const d = detailGroup();
    const blobs: THREE.BufferGeometry[] = [];
    const br = 0.28 * R;
    for (let i = 0; i < 5; i++) {
      const a = (2 * Math.PI * i) / 5 + rnd(10 + i);
      blobs.push(sphere(br * (0.7 + 0.5 * rnd(20 + i)), mount + 0.12 * L, yc + 0.95 * R * Math.cos(a), 0.95 * R * Math.sin(a)));
    }
    addMerged(d, blobs, PART_COLORS.glue, ctx, 'glue');
    g.add(d);
  }
  return g;
});

// ---------------------------------------------------------------------------------------
// motor and nozzle
// ---------------------------------------------------------------------------------------

/** ASTRA engine clusters: [x, z, bell scale k] for a 1.85 m radius stage. */
const ENGINE_LAYOUT: Record<PartTier, [number, number, number][]> = {
  best: [[0, 0, 0.62], [1, 0, 0.6], [-1, 0, 0.6], [0, 1, 0.6], [0, -1, 0.6]], // Pentad-5
  ok: [[0.95, 0, 0.78], [-0.475, 0.822, 0.78], [-0.475, -0.822, 0.78]], // Triad-3
  bad: [[0, 0, 1.12]], // Kestrel-1
};
/** Bell profile (radius, height) with the throat forward and the exit aft, times k. */
const BELL_PTS: [number, number][] = [
  [0.17, 0], [0.2, 0.12], [0.27, 0.45], [0.4, 0.85], [0.52, 1.2], [0.6, 1.45],
].map(([r, y]) => [r, 1.45 - y] as [number, number]);
const STAGE_R = 1.85;
const BELL_STEEL = 0x6d7480;

export const buildMotor: PartBuilder<InnerTube> = scopedPart((c, tier, ctx) => {
  const g = new THREE.Group();
  if (!pos(c.length) || !fin(c.x)) return g;
  const dia = c.motor?.diameter;
  let rc: number;
  if (fin(dia) && dia > 0) {
    rc = dia / 2;
  } else if (pos(c.outerRadius)) {
    const b = c.outerRadius - (fin(c.thickness) ? c.thickness : 0);
    rc = b > 0 ? b : c.outerRadius;
  } else {
    return g;
  }
  const ovh = fin(c.overhang) ? c.overhang : 0;
  const aftStation = c.x + c.length + ovh;
  if (!(aftStation > c.x)) return g;
  const key = String(c.id ?? '');
  const rnd = (i: number) => seeded(key, i);
  const yAft = -aftStation;
  const mlen = c.motor?.length;
  let lcase = Math.min(4 * rc, aftStation - c.x);
  if (pos(mlen)) lcase = Math.min(lcase, mlen);
  if (!(lcase > 0)) return g;
  const yTop = yAft + lcase;
  const segs = radialSegments(tier === 'best' ? 48 : tier === 'ok' ? 32 : 8, 'outer');
  const skirt =
    c.color ?? (tier === 'bad' ? mixColor(PART_COLORS.motor, PART_COLORS.bare, 0.25 + 0.15 * rnd(0)) : PART_COLORS.motor);

  // thrust-structure skirt
  if (tier === 'bad') {
    const rim: number[] = Array.from({ length: segs }, (_, i) => (i === 0 ? 0 : 0.15 * rc * rnd(10 + i)));
    const topLoop = ringLoop(segs, yTop, () => rc);
    const rimLoop = ringLoop(segs, yAft, () => rc).map((p, i): V3 => [p[0], yAft + rim[i], p[2]]);
    g.add(mesh(loft([topLoop, rimLoop]), skirt, ctx));
  } else {
    g.add(mesh(cyl(rc, yAft, yTop, segs), skirt, ctx));
  }
  // black engine plate, just forward of the bell exits
  const plateY = yAft + (tier === 'bad' ? 0.1 * rc : Math.min(0.04 * rc, lcase * 0.1));
  const plateR = tier === 'bad' ? 0.9 * rc : 0.96 * rc;
  addMerged(g, [annulus(0, plateR, plateY, segs)], 0x0c0d10, ctx, 'plate');

  // bells: scale the whole cluster down if it would not fit the casing or its length
  const layout = ENGINE_LAYOUT[tier];
  const u = rc / STAGE_R;
  let reach = 0;
  for (const [x, z, k] of layout) reach = Math.max(reach, Math.hypot(x, z) + 0.6 * k);
  const maxH = Math.max(...layout.map(([, , k]) => 1.45 * k));
  const s = Math.min(1, (0.95 * rc) / (reach * u), (0.85 * (yTop - yAft)) / (maxH * u));
  const bellColor = tier === 'bad' ? mixColor(BELL_STEEL, PART_COLORS.bare, 0.3) : BELL_STEEL;
  const bsegs = radialSegments(tier === 'bad' ? 8 : 28, 'small');
  layout.forEach(([x, z, k], i) => {
    const kk = k * u * s;
    // Bells of one size share one geometry; each mesh is placed at its own spot.
    const geo = sharedGeometry(ctx, `bell|${kk}|${yAft}|${bsegs}`, () =>
      lathe(BELL_PTS.map(([r, y]) => [r * kk, yAft + y * kk]), bsegs),
    );
    const bell = mesh(geo, bellColor, ctx);
    bell.position.set(x * u * s, 0, z * u * s);
    bell.name = 'bell';
    bell.userData.bell = true;
    bell.userData.index = i;
    g.add(bell);
  });

  if (tier !== 'bad') {
    const d = detailGroup();
    const h = Math.min(0.1 * rc, lcase * 0.15);
    addMerged(d, [cyl(rc * 1.012, yTop - h, yTop, segs)], PART_COLORS.decoupler, ctx, 'accent-ring');
    g.add(d);
  }
  return g;
});

// ---------------------------------------------------------------------------------------
// strap-on booster pod
// ---------------------------------------------------------------------------------------

export const buildBoosterPod: PartBuilder<InnerTube> = scopedPart((c, tier, ctx) => {
  const g = new THREE.Group();
  const r = c.outerRadius;
  const L = c.length;
  if (!pos(r) || !pos(L) || !fin(c.x)) return g;
  const key = String(c.id ?? '');
  const rnd = (i: number) => seeded(key, i);
  const y1 = -c.x;
  const y0 = -(c.x + L);
  const capH = 2.4 * r;
  const segs = radialSegments(tier === 'best' ? 48 : tier === 'ok' ? 24 : 8, 'outer');
  const base = c.color ?? PART_COLORS.tube;
  let capColor = c.color ?? PART_COLORS.nose;
  let bodyColor = base;
  if (tier === 'bad') {
    bodyColor = mixColor(base, PART_COLORS.bare, 0.18 + 0.14 * rnd(0));
    capColor = mixColor(capColor, PART_COLORS.bare, 0.2 + 0.15 * rnd(1));
  }

  g.add(mesh(cyl(r, y0, y1, segs), bodyColor, ctx));
  // best: the aft face carries a recessed bell (exit flush with the face, throat forward)
  const q = Math.min(0.6 * r / 0.72, (0.4 * L) / 1.3);
  const hasBell = tier === 'best';
  addMerged(
    g,
    [annulus(hasBell ? 0.72 * q : 0, r, y0, segs), annulus(0, r, y1, segs)],
    bodyColor,
    ctx,
    'ends',
  );
  if (hasBell) {
    const nz = lathe(
      [[0.18, 1.3], [0.26, 1.0], [0.5, 0.5], [0.72, 0.0]].map(([rr, yy]) => [rr * q, y0 + yy * q] as [number, number]),
      segs,
    );
    const nm = mesh(nz, BELL_STEEL, ctx);
    nm.name = 'bell';
    nm.userData.bell = true;
    g.add(nm);
  }

  // nose cap, forward of station x
  if (tier === 'best') {
    const rho = (r * r + capH * capH) / (2 * r);
    const pts: [number, number][] = [];
    const N = 14;
    for (let k = 0; k <= N; k++) {
      const x = (capH * k) / N; // distance from the tip
      const rad = Math.sqrt(Math.max(0, rho * rho - (capH - x) * (capH - x))) + r - rho;
      pts.push([k === 0 ? 0 : Math.min(rad, r), y1 + capH - x]);
    }
    g.add(mesh(lathe(pts, segs), capColor, ctx));
  } else if (tier === 'ok') {
    g.add(mesh(lathe([[0, y1 + capH], [r, y1]], segs), capColor, ctx));
  } else {
    const wob = (k: number) => (i: number) => 0.85 + 0.3 * rnd(60 + 10 * k + i);
    const loops: V3[][] = [
      ringLoop(segs, y1, () => r),
      ringLoop(segs, y1 + 1.0 * r, (i) => 0.62 * r * wob(1)(i)),
      ringLoop(segs, y1 + 1.8 * r, (i) => 0.25 * r * wob(2)(i)),
      ringLoop(segs, y1 + capH, () => 0),
    ];
    g.add(mesh(loft(loops), capColor, ctx));
  }

  const d = detailGroup();
  if (tier === 'best') {
    const w = Math.min(0.008, L * 0.03);
    const dark = mixColor(base, 0x000000, 0.3);
    addMerged(d, [cyl(r * 1.008, y1 - w, y1, segs), cyl(r * 1.008, y0, y0 + w, segs)], dark, ctx, 'joints');
    // ASTRA accent band at 72% of the length, measured from the aft end
    const sh = Math.min(L * 0.07, r * 0.7);
    const sy = y0 + L * 0.72;
    addMerged(d, [cyl(r * 1.012, sy - sh / 2, sy + sh / 2, segs)], c.color ? mixColor(base, PART_COLORS.nose, 0.8) : PART_COLORS.decoupler, ctx, 'accent-band');
  } else if (tier === 'bad') {
    const seam = helixStrip(r, y0, y1, 4.4 * r, Math.min(0.06 * r, L * 0.2), segs, 1.008);
    if (seam) {
      const sm = mesh(seam, mixColor(base, 0x3a2f20, 0.5), ctx);
      sm.name = 'seam';
      d.add(sm);
    }
    const blobs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const a = (2 * Math.PI * i) / 4 + rnd(80 + i);
      const br = 0.12 * r * (0.7 + 0.6 * rnd(90 + i));
      blobs.push(sphere(br, 0.92 * r * Math.sin(a), y1 - br * 0.3, 0.92 * r * Math.cos(a)));
    }
    addMerged(d, blobs, PART_COLORS.glue, ctx, 'glue');
  }
  if (d.children.length) g.add(d);
  return g;
});

// ---------------------------------------------------------------------------------------
// icons (48 x 48, outline in currentColor, tier accent on the defining detail)
// ---------------------------------------------------------------------------------------

function icon(tier: PartTier, body: string): string {
  const a = TIER_ACCENT[tier];
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    body.replace(/\{a\}/g, a) +
    `<circle cx="41" cy="7" r="3.5" fill="${a}" stroke="none"/></svg>`
  );
}

const TUBE = '<rect x="5" y="17" width="38" height="18" rx="1"/>';

const bodytubeIcons: PartIconSet = {
  best: icon('best', `${TUBE}<path d="M9.5 17V35M38.5 17V35" stroke-width="1.2"/><path d="M24 18V34" stroke="{a}" stroke-width="4"/>`),
  ok: icon('ok', `${TUBE}<path d="M9 22H39" stroke="{a}" stroke-width="1.6"/>`),
  bad: icon('bad', '<path d="M8 17H40L43 21V31L40 35H8L5 31V21Z"/><path d="M5 26H43" stroke-width="1.2"/><path d="M12 35L20 17M24 35L32 17M36 35L40 28" stroke="{a}" stroke-width="1.6"/>'),
};

const decouplerIcons: PartIconSet = {
  best: icon('best', `${TUBE}<path d="M19 17V35M29 17V35" stroke-width="1.4"/><g fill="{a}" stroke="none"><circle cx="21.5" cy="26" r="1.5"/><circle cx="24" cy="26" r="1.5"/><circle cx="26.5" cy="26" r="1.5"/></g>`),
  ok: icon('ok', `${TUBE}<path d="M19 17V35M29 17V35" stroke="{a}" stroke-width="2"/>`),
  bad: icon('bad', `${TUBE}<path d="M19 17C16 21 21 24 18 27S21 32 19 35M29 17C32 21 27 24 30 27S27 32 29 35" stroke="{a}" stroke-width="1.8"/>`),
};

const BODY_LINE = '<path d="M3 38H45"/>';

const launchlugIcons: PartIconSet = {
  best: icon('best', `${BODY_LINE}<path d="M12 22H36L39 25V31L36 34H12L9 31V25Z"/><path d="M11 28H37" stroke="{a}" stroke-width="1.6"/><path d="M12 36H36" stroke="{a}" stroke-width="1.2"/>`),
  ok: icon('ok', `${BODY_LINE}<rect x="9" y="22" width="30" height="12" rx="1"/><path d="M12 28H36" stroke="{a}" stroke-width="1.6" stroke-dasharray="3 2"/>`),
  bad: icon('bad', `${BODY_LINE}<g transform="rotate(-5 24 28)"><rect x="9" y="22" width="30" height="12" rx="1"/></g><g fill="{a}" stroke="none"><circle cx="9" cy="36" r="3"/><circle cx="39" cy="36.5" r="2.6"/></g>`),
};

const railbuttonIcons: PartIconSet = {
  best: icon('best', `${BODY_LINE.replace('H45', 'H45')}<path d="M16 38L15 37V35L16 34H20V24H16L15 23V19L16 18H32L33 19V23L32 24H28V34H32L33 35V37L32 38"/><path d="M20 29H28" stroke="{a}" stroke-width="1.6"/><path d="M22 21H26" stroke="{a}" stroke-width="1.6"/>`),
  ok: icon('ok', `${BODY_LINE}<path d="M15 38V34H20V24H15V18H33V24H28V34H33V38"/><path d="M21 29H27" stroke="{a}" stroke-width="1.6"/>`),
  bad: icon('bad', `${BODY_LINE}<path d="M14 38V35L20 34L19 25L15 24V18L33 19V25L28 26V33L34 35V38"/><g fill="{a}" stroke="none"><ellipse cx="12.5" cy="37" rx="3.2" ry="2"/><ellipse cx="35.5" cy="37" rx="3.2" ry="2"/></g>`),
};

const motorIcons: PartIconSet = {
  // aft view: the casing and its engine cluster (five, three, one bell)
  best: icon('best', '<circle cx="24" cy="25" r="17"/><g stroke="{a}" stroke-width="1.8"><circle cx="24" cy="25" r="4"/><circle cx="24" cy="15.5" r="3.6"/><circle cx="24" cy="34.5" r="3.6"/><circle cx="14.5" cy="25" r="3.6"/><circle cx="33.5" cy="25" r="3.6"/></g>'),
  ok: icon('ok', '<circle cx="24" cy="25" r="17"/><g stroke="{a}" stroke-width="1.8"><circle cx="32" cy="25" r="5.2"/><circle cx="20" cy="18" r="5.2"/><circle cx="20" cy="32" r="5.2"/></g>'),
  bad: icon('bad', '<path d="M14 11L26 9L36 14L40 25L35 35L25 40L14 36L9 25Z"/><circle cx="24" cy="25" r="8" stroke="{a}" stroke-width="1.8" stroke-dasharray="4 2"/>'),
};

const boosterpodIcons: PartIconSet = {
  best: icon('best', '<path d="M16 42V22C16 12 21 7 24 4C27 7 32 12 32 22V42Z"/><path d="M16 22H32" stroke="{a}" stroke-width="1.6"/><path d="M16 33H32" stroke="{a}" stroke-width="3"/>'),
  ok: icon('ok', '<path d="M16 42V22L24 4L32 22V42Z"/><path d="M16 22H32" stroke="{a}" stroke-width="2"/>'),
  bad: icon('bad', '<path d="M16 42V22L18 14L22 11L24 4L27 10L30 13L32 22V42Z"/><path d="M16 22H32" stroke-width="1.2"/><path d="M16 38L32 30M16 31L32 25" stroke="{a}" stroke-width="1.6"/>'),
};

export const AIRFRAME_ICONS: {
  bodytube: PartIconSet;
  decoupler: PartIconSet;
  launchlug: PartIconSet;
  railbutton: PartIconSet;
  motor: PartIconSet;
  boosterpod: PartIconSet;
} = {
  bodytube: bodytubeIcons,
  decoupler: decouplerIcons,
  launchlug: launchlugIcons,
  railbutton: railbuttonIcons,
  motor: motorIcons,
  boosterpod: boosterpodIcons,
};
