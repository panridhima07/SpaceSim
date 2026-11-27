// Airframe part designs: body tube (and interstage decoupler), launch lug, rail button,
// motor with nozzle, strap-on booster pod. Each is drawn at three build-quality tiers.
//
// A tier changes workmanship and detail only. The measured dimensions (length, radii,
// station, button height) are exact at every tier. Decorative detail (joint rings,
// stripes, bolts, seams, glue, labels) is tagged `userData.detail = true` (on a child group,
// or on the mesh itself where the part keeps it loose) and never stands more than 1.5% of
// the local radius proud of the true surface, nor outside the part's axial span (the
// strap-on pod's nose cap is the only exception, as the contract allows).
//
// Surface cues follow the real hardware: spiral-wound paper tubes with a faint seam under
// the paint, kraft wall at the open ends, plated bolts, brass or paper lugs with a dark
// bore, Delrin spool buttons on a screw, paper or anodised motor cases with clay or
// graphite nozzles. Highlights come only from `finish`.
//
// Frame: rocket axis +Y, nose toward +Y, origin at the nose tip, station x is y = -x.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BodyTube, InnerTube, Ring } from '../../types';
import { PART_COLORS, SKIN_FINISH, TIER_ACCENT, mixColor, partMaterial, radialSegments, scopedPart, seeded, sharedGeometry } from './types';
import type { PartBuilder, PartContext, PartFinish, PartIconSet, PartTier } from './types';

// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------

type V3 = [number, number, number];

const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** How a mesh is drawn: material options, plus whether it is decoration. */
interface Look {
  shell?: boolean;
  offset?: boolean;
  finish?: PartFinish;
  detail?: boolean;
}

/** Decoration lying on a skin: offset material, tagged as detail. */
const D = (finish: PartFinish, offset = true): Look => ({ offset, detail: true, finish });
/** Detail lying on an outer skin: it turns see-through with that skin in cutaway view. */
const S = (finish: PartFinish, offset = true): Look => ({ ...D(finish, offset), shell: true });

// local colours (PART_COLORS is shared and not ours to extend)
const BRASS = 0xb08a46;
const KRAFT_TAN = 0xc8a878;
const ANODISED = 0x4b5563;
const GRAPHITE = 0x2c2e33;
const CLAY = 0xd2c3a4;
const SOOT = 0x141416;
const BORE_DARK = 0x0b0b0d;
const LABEL_RED = 0xc23b22;
const TAPE = 0xd8cfa8;
const PLASTIC_DARK = 0x23262b;

function mesh(geo: THREE.BufferGeometry, color: number, ctx: PartContext, o: Look = {}): THREE.Mesh {
  const m = new THREE.Mesh(geo, partMaterial(color, ctx, { shell: o.shell, offset: o.offset, finish: o.finish }));
  if (o.detail) m.userData.detail = true;
  return m;
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
  look: Look = {},
): void {
  const m = merge(geos);
  if (!m) return;
  const mm = mesh(m, color, ctx, look);
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

/**
 * A thin helical strip (paper seam) hugging a cylinder or an n-gon prism. `phase` turns the
 * start angle; `jit` (0..1 per step) makes the strip's width and lift uneven.
 */
function helixStrip(
  r: number,
  y0: number,
  y1: number,
  pitch: number,
  width: number,
  poly: number,
  lift: number,
  opt: { phase?: number; jit?: (k: number) => number } = {},
): THREE.BufferGeometry | null {
  const len = y1 - y0;
  if (!(len > width * 2) || !(pitch > 0)) return null;
  const turns = (len - width) / pitch;
  const steps = Math.max(16, Math.min(800, Math.ceil(turns * 16)));
  const p: number[] = [];
  const pt = (k: number, side: number): V3 => {
    const f = k / steps;
    const yc = y0 + width / 2 + f * (len - width);
    const t = 2 * Math.PI * turns * f + (opt.phase ?? 0);
    const j = opt.jit ? opt.jit(k) : 1;
    const l = opt.jit ? lift + 0.003 * (2 * j - 1) : lift;
    const w = opt.jit ? 0.4 + 0.6 * j : 1;
    const rad = (poly > 0 ? polyR(r, poly, t) : r) * l;
    return [rad * Math.sin(t), yc + side * (width / 2) * w, rad * Math.cos(t)];
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

/** A ragged paper edge: a ring whose inner edge is torn to an uneven depth. */
function frayedEnd(
  r: number,
  yEdge: number,
  inward: 1 | -1,
  h: number,
  n: number,
  key: string,
  salt: number,
): THREE.BufferGeometry {
  const rad = (i: number) => r * (1.004 + 0.008 * seeded(key, salt + i));
  const edge = ringLoop(n, yEdge, rad);
  const torn = ringLoop(n, yEdge, rad).map((p, i): V3 => [p[0], yEdge + inward * h * (0.15 + 0.85 * seeded(key, salt + 50 + i)), p[2]]);
  return loft([edge, torn]);
}

/** Paint-patch strips, one facet wide, scattered along a faceted body. */
function patchStrips(r: number, y0: number, L: number, segs: number, key: string, n: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let k = 0; k < n; k++) {
    const h = L * (0.08 + 0.12 * seeded(key, 10 + k));
    const yc = y0 + h / 2 + (L - h) * seeded(key, 20 + k);
    const facet = Math.floor(seeded(key, 30 + k) * segs);
    const p = new THREE.CylinderGeometry(
      r * 1.006, r * 1.006, h, 1, 1, true, (facet * 2 * Math.PI) / segs, (2 * Math.PI) / segs,
    );
    p.translate(0, yc, 0);
    out.push(p);
  }
  return out;
}

/**
 * A short cylinder (bolt head, rivet, boss) whose axis points radially out of a body at
 * polar angle `t` (same convention as `ringLoop`), `rad` from the axis, at height `y`.
 */
function stud(br: number, bh: number, sides: number, t: number, y: number, rad: number): THREE.BufferGeometry {
  const b = new THREE.CylinderGeometry(br, br, bh, sides, 1, false);
  b.rotateZ(-Math.PI / 2);
  b.translate(rad, 0, 0);
  b.rotateY(t - Math.PI / 2);
  b.translate(0, y, 0);
  return b;
}

/**
 * A ring of `n` studs sitting on an n-gon skin of `segs` sides: each is seated on the
 * actual facet at its angle, standing 0.65 bh proud (so never past 1.5% of r when bh is
 * 0.02 r). `keep` drops studs, `scale` varies their size.
 */
function boltRing(
  n: number,
  br: number,
  bh: number,
  y: number,
  r: number,
  segs: number,
  sides: number,
  o: { t0?: number; keep?: (i: number) => boolean; scale?: (i: number) => number } = {},
): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    if (o.keep && !o.keep(i)) continue;
    const t = (o.t0 ?? 0) + (2 * Math.PI * i) / n;
    out.push(stud(br * (o.scale ? o.scale(i) : 1), bh, sides, t, y, polyR(r, segs, t) + 0.15 * bh));
  }
  return out;
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

  const skin = mesh(cyl(r, y0, y1, segs), skinColor, ctx, { shell: true, finish: SKIN_FINISH[tier] });
  skin.name = 'skin';
  g.add(skin);

  // Cutaway: show the wall as an inner surface plus annular end faces.
  const t = c.thickness;
  const wallKnown = fin(t) && t > 0 && t < r;
  if (ctx.cutaway && wallKnown) {
    const ri = r - t;
    const wallColor = mixColor(base, 0x000000, 0.2);
    // See-through like the skin, or the wall hides everything packed inside the tube.
    const wall = mesh(cyl(ri, y0, y1, segs), wallColor, ctx, { shell: true, finish: 'matte' });
    wall.name = 'wall';
    g.add(wall);
    addMerged(g, [annulus(ri, r, y0, segs), annulus(ri, r, y1, segs)], wallColor, ctx, 'ends', { finish: 'matte' });
  }

  // An ok decoupler keeps its decoration loose (each mesh tagged detail) instead of in a group.
  const loose = tier === 'ok' && !!c.isDecoupler;
  const d: THREE.Object3D = loose ? g : detailGroup();

  if (tier === 'best') {
    const w = Math.min(0.008, L * 0.03);
    const dark = mixColor(base, 0x000000, 0.3);
    const ph = Math.min(0.0012, L * 0.004);
    const line = (y: number) => cyl(r * 1.004, y - ph / 2, y + ph / 2, segs);
    if (c.isDecoupler) {
      // metal flanges, a hairline separation groove, plated bolts and two pyro connectors
      addMerged(d, [cyl(r * 1.012, y1 - w, y1, segs), cyl(r * 1.012, y0, y0 + w, segs)], PART_COLORS.metal, ctx, 'flanges', S('metal'));
      addMerged(d, [line(y1 - L * 0.5)], dark, ctx, 'panel', S('satin'));
      const br = Math.min(0.06 * r, L * 0.12);
      const bh = 0.02 * r;
      addMerged(d, boltRing(12, br, bh, y1 - L * 0.3, r, segs, 8, { t0: 0.13 }), PART_COLORS.metal, ctx, 'bolts', S('metal'));
      const pr = Math.min(0.09 * r, L * 0.08);
      const py = y1 - L * 0.72;
      addMerged(
        d,
        [0.5, 1.5].map((f) => stud(pr, bh, 12, f * Math.PI, py, polyR(r, segs, f * Math.PI) + 0.15 * bh)),
        PLASTIC_DARK, ctx, 'pyro', S('satin'),
      );
    } else {
      addMerged(d, [cyl(r * 1.008, y1 - w, y1, segs), cyl(r * 1.008, y0, y0 + w, segs)], dark, ctx, 'joints', S('satin'));
      addMerged(d, [line(y1 - L * 0.6), line(y1 - L * 0.4)], dark, ctx, 'panel', S('satin'));
      const sh = Math.min(L * 0.06, r * 0.6);
      const sy = y1 - L * 0.22;
      addMerged(d, [cyl(r * 1.006, sy - sh / 2, sy + sh / 2, segs)], mixColor(base, PART_COLORS.nose, 0.8), ctx, 'stripe', S('gloss'));
      // slim pinstripes either side of the roll-pattern band
      const pw = Math.min(0.0016, L * 0.005);
      const off = sh / 2 + 2.5 * pw;
      if (sy - off - pw > y0 + w && sy + off + pw < y1 - w) {
        addMerged(
          d,
          [cyl(r * 1.007, sy + off - pw / 2, sy + off + pw / 2, segs), cyl(r * 1.007, sy - off - pw / 2, sy - off + pw / 2, segs)],
          PART_COLORS.fin, ctx, 'pinstripe', S('gloss'),
        );
      }
      // one small vent hole: a dark opening inside a metal rim
      const vr = Math.min(0.05 * r, L * 0.03);
      const vt = 0.8 * Math.PI;
      const vy = y1 - L * 0.5;
      const vs = polyR(r, segs, vt);
      addMerged(d, [stud(vr * 1.6, 0.016 * r, 16, vt, vy, vs + 0.15 * 0.016 * r)], PART_COLORS.metal, ctx, 'vent-rim', S('metal'));
      addMerged(d, [stud(vr, 0.02 * r, 16, vt, vy, vs + 0.15 * 0.02 * r)], BORE_DARK, ctx, 'vent', S('matte'));
      // a ring of shear-pin heads near the aft end
      const rr = Math.min(0.02 * r, L * 0.01);
      addMerged(d, boltRing(6, rr, 0.014 * r, y0 + w + 2 * rr, r, segs, 6, { t0: 0.3 }), PART_COLORS.metal, ctx, 'rivets', S('metal'));
    }
  } else if (tier === 'ok') {
    if (c.isDecoupler) {
      const w = Math.min(0.01, L * 0.05);
      const lips = mixColor(base, 0x000000, 0.18);
      addMerged(d, [cyl(r * 1.01, y1 - w, y1, segs), cyl(r * 1.01, y0, y0 + w, segs)], lips, ctx, 'lips', S('satin'));
      const gh = Math.min(0.0025, L * 0.01);
      const gy = y1 - L * 0.5;
      addMerged(d, [cyl(r * 1.004, gy - gh / 2, gy + gh / 2, segs)], mixColor(base, 0x000000, 0.75), ctx, 'groove', S('matte'));
      const br = Math.min(0.07 * r, L * 0.15);
      addMerged(d, boltRing(6, br, 0.02 * r, y1 - L * 0.27, r, segs, 6, { t0: 0.2 }), PART_COLORS.metal, ctx, 'bolts', S('metal'));
    } else {
      // faint spiral winding showing through the paint, dark joint lines, kraft wall at the ends
      const w = Math.min(0.004, L * 0.02);
      addMerged(
        d,
        [cyl(r * 1.003, y1 - w, y1, segs), cyl(r * 1.003, y0, y0 + w, segs)],
        mixColor(base, 0x000000, 0.25), ctx, 'joints', S('satin'),
      );
      // Kit-tier detail stays within 0.3% of the true radius (the render audit measures it).
      const seam = helixStrip(r, y0, y1, 3.6 * r, Math.min(0.03 * r, L * 0.2), segs, 1.002);
      if (seam) {
        const sm = mesh(seam, mixColor(base, 0x000000, 0.09), ctx, S('satin'));
        sm.name = 'seam';
        d.add(sm);
      }
      if (!ctx.cutaway) {
        const tw = wallKnown ? t : 0.05 * r;
        addMerged(d, [annulus(r - tw, r, y0, segs), annulus(r - tw, r, y1, segs)], PART_COLORS.bare, ctx, 'kraft-ends', S('matte', false));
      }
    }
  } else {
    const seamColor = mixColor(base, 0x3a2f20, 0.5);
    const seam = helixStrip(r, y0, y1, 4.4 * r, Math.min(0.08 * r, L * 0.2), segs, 1.008, { jit: (k) => rnd(200 + k) });
    if (seam) {
      const sm = mesh(seam, seamColor, ctx, S('matte'));
      sm.name = 'seam';
      d.add(sm);
    }
    addMerged(d, patchStrips(r, y0, L, segs, key, 3), mixColor(base, PART_COLORS.bare, 0.75), ctx, 'patches', S('matte'));
    // a frayed, rough aft end
    const fh = Math.min(0.5 * r, L * 0.08);
    addMerged(d, [frayedEnd(r, y0, 1, fh, segs, key, 300)], mixColor(base, PART_COLORS.bare, 0.7), ctx, 'fray', S('matte'));
    if (c.isDecoupler) {
      const tape: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 4; k++) {
        const hh = L * (0.04 + 0.05 * rnd(40 + k));
        const yc = y0 + hh / 2 + (L - hh) * rnd(50 + k);
        tape.push(lumpyBand(r, yc - hh / 2, yc + hh / 2, segs, key, 100 + 10 * k));
      }
      addMerged(d, tape, mixColor(base, PART_COLORS.bare, 0.5), ctx, 'tape', S('matte'));
      // mismatched and missing bolts
      const br = Math.min(0.07 * r, L * 0.1);
      addMerged(
        d,
        boltRing(8, br, 0.02 * r, y1 - L * 0.5, r, segs, 6, {
          t0: Math.PI / segs,
          keep: (i) => rnd(60 + i) > 0.35,
          scale: (i) => 0.6 + 0.9 * rnd(70 + i),
        }),
        mixColor(PART_COLORS.metal, PART_COLORS.bare, 0.4), ctx, 'bolts', S('metal'),
      );
    }
  }
  if (d !== g && d.children.length) g.add(d);
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
  const segs = radialSegments(SEG_SMALL[tier], 'small');

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

  const base = c.color ?? (tier === 'best' ? BRASS : PART_COLORS.ring);
  const color = tier === 'bad' ? mixColor(base, PART_COLORS.bare, 0.2 + 0.15 * rnd(0)) : base;
  const pivot = new THREE.Group();
  pivot.name = 'lug';
  pivot.position.set(mount + R, yc, 0);
  pivot.add(mesh(lathe(pts, segs), color, ctx, { finish: tier === 'best' ? 'metal' : 'matte' }));
  if (rin > 0) {
    // the bore: a dark liner just inside the wall, so both ends read as hollow
    const bore = mesh(cyl(rin * 0.97, -h, h, segs), BORE_DARK, ctx, { finish: 'matte', detail: true });
    bore.name = 'bore';
    pivot.add(bore);
  }
  if (tier === 'bad') {
    const ang = ((1 + rnd(1)) * Math.PI) / 180;
    pivot.rotation.x = rnd(2) < 0.5 ? -ang : ang;
  }
  g.add(pivot);

  if (tier === 'best') {
    // chamfered end rings, and a slim standoff foot where the lug meets the body
    const d = detailGroup();
    const hr = Math.min(0.07 * L, 0.5 * R);
    addMerged(
      d,
      [cyl(R * 1.012, -c.x - hr, -c.x, segs, mount + R, 0), cyl(R * 1.012, -(c.x + L), -(c.x + L) + hr, segs, mount + R, 0)],
      PART_COLORS.metal, ctx, 'end-rings', D('metal'),
    );
    const f = new THREE.BoxGeometry(0.15 * R, L * 0.8, 0.5 * R);
    f.translate(mount + 0.075 * R, yc, 0);
    addMerged(d, [f], PART_COLORS.metal, ctx, 'standoff', D('metal', false));
    g.add(d);
  }
  if (tier === 'ok') {
    // neat glue beads along both sides where the lug meets the body
    const d = detailGroup();
    const beads = [-1, 1].map((s) => {
      const b = new THREE.CylinderGeometry(0.2 * R, 0.2 * R, L * 0.96, 6, 1, false);
      b.translate(mount + 0.1 * R, yc, s * 0.8 * R);
      return b;
    });
    addMerged(d, beads, PART_COLORS.glue, ctx, 'fillet', D('satin', false));
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
      D('satin', false),
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
  const segs = radialSegments(SEG_SMALL[tier], 'small');

  // Profile in (radius, t) with t = height off the body surface, 0..L.
  let pts: [number, number][];
  let rs = 0;
  let dp = 0;
  if (tier === 'best') {
    const fh = L * 0.25;
    const ch = Math.min(0.25 * fh, 0.2 * (R - rw));
    rs = 0.35 * R;
    dp = Math.min(0.1 * L, 0.3 * rs);
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
  // radial axis along +X, height t becomes x
  const place = (geo: THREE.BufferGeometry, dz = 0): THREE.BufferGeometry => {
    geo.rotateZ(-Math.PI / 2);
    geo.translate(mount, yc, dz);
    return geo;
  };
  g.add(mesh(place(lathe(pts, segs)), color, ctx, { finish: tier === 'bad' ? 'matte' : 'satin' }));

  const d = detailGroup();
  if (tier === 'best') {
    // a metal washer and a screw head seated in the recess, with a dark hex socket
    const tw = L - dp + 0.4 * dp;
    const th = L - 0.15 * dp;
    const screw = lathe(
      [[0, L - dp], [0.97 * rs, L - dp], [0.97 * rs, tw], [0.62 * rs, tw], [0.62 * rs, th - 0.2 * dp], [0.5 * rs, th], [0, th]],
      radialSegments(24, 'small'),
    );
    addMerged(d, [place(screw)], PART_COLORS.metal, ctx, 'screw', D('metal'));
    const hex = new THREE.CircleGeometry(0.26 * rs, 6);
    hex.rotateY(Math.PI / 2);
    hex.translate(mount + th + 0.03 * dp, yc, 0);
    addMerged(d, [hex], BORE_DARK, ctx, 'socket', D('matte'));
  } else if (tier === 'ok') {
    // countersunk metal screw head with a slot
    const head = lathe(
      [[0, L + 0.01 * R], [0.24 * R, L + 0.01 * R], [0.3 * R, L + 0.002 * R], [0.3 * R, L - 0.004 * R], [0, L - 0.004 * R]],
      radialSegments(16, 'small'),
    );
    addMerged(d, [place(head)], PART_COLORS.metal, ctx, 'screw', D('metal'));
    const slot = new THREE.BoxGeometry(0.003 * R, 0.4 * R, 0.06 * R);
    slot.translate(mount + L + 0.0115 * R, yc, 0);
    addMerged(d, [slot], BORE_DARK, ctx, 'slot', D('matte'));
  } else {
    // off-centre screw, chewed flange edge, glue blobs
    const head = lathe(
      [[0, L + 0.01 * R], [0.22 * R, L + 0.01 * R], [0.28 * R, L + 0.002 * R], [0.28 * R, L - 0.004 * R], [0, L - 0.004 * R]],
      8,
    );
    addMerged(d, [place(head, (0.14 + 0.08 * rnd(5)) * R)], mixColor(PART_COLORS.metal, PART_COLORS.bare, 0.4), ctx, 'screw', D('metal'));
    const bites: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (2 * Math.PI * i) / 3 + rnd(30 + i);
      const b = new THREE.BoxGeometry(0.012 * R, (0.2 + 0.15 * rnd(40 + i)) * R, (0.16 + 0.1 * rnd(50 + i)) * R);
      b.translate(mount + L + 0.006 * R, yc + 0.78 * R * Math.cos(a), 0.78 * R * Math.sin(a));
      bites.push(b);
    }
    addMerged(d, bites, mixColor(color, 0x000000, 0.55), ctx, 'bites', D('matte'));
    const blobs: THREE.BufferGeometry[] = [];
    const br = 0.28 * R;
    for (let i = 0; i < 5; i++) {
      const a = (2 * Math.PI * i) / 5 + rnd(10 + i);
      blobs.push(sphere(br * (0.7 + 0.5 * rnd(20 + i)), mount + 0.12 * L, yc + 0.95 * R * Math.cos(a), 0.95 * R * Math.sin(a)));
    }
    addMerged(d, blobs, PART_COLORS.glue, ctx, 'glue', D('satin', false));
  }
  if (d.children.length) g.add(d);
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
    c.color ??
    (tier === 'bad'
      ? mixColor(PART_COLORS.motor, PART_COLORS.bare, 0.25 + 0.15 * rnd(0))
      : tier === 'ok'
        ? KRAFT_TAN
        : ANODISED);
  const caseFinish: PartFinish = tier === 'best' ? 'metal' : 'matte';

  // thrust-structure skirt
  if (tier === 'bad') {
    const rim: number[] = Array.from({ length: segs }, (_, i) => (i === 0 ? 0 : 0.15 * rc * rnd(10 + i)));
    const topLoop = ringLoop(segs, yTop, () => rc);
    const rimLoop = ringLoop(segs, yAft, () => rc).map((p, i): V3 => [p[0], yAft + rim[i], p[2]]);
    g.add(mesh(loft([topLoop, rimLoop]), skirt, ctx, { finish: caseFinish }));
  } else {
    g.add(mesh(cyl(rc, yAft, yTop, segs), skirt, ctx, { finish: caseFinish }));
  }
  // black engine plate, just forward of the bell exits
  const plateY = yAft + (tier === 'bad' ? 0.1 * rc : Math.min(0.04 * rc, lcase * 0.1));
  const plateR = tier === 'bad' ? 0.9 * rc : 0.96 * rc;
  addMerged(g, [annulus(0, plateR, plateY, segs)], 0x0c0d10, ctx, 'plate', { finish: 'matte' });

  // bells: scale the whole cluster down if it would not fit the casing or its length
  const layout = ENGINE_LAYOUT[tier];
  const u = rc / STAGE_R;
  let reach = 0;
  for (const [x, z, k] of layout) reach = Math.max(reach, Math.hypot(x, z) + 0.6 * k);
  const maxH = Math.max(...layout.map(([, , k]) => 1.45 * k));
  const s = Math.min(1, (0.95 * rc) / (reach * u), (0.85 * (yTop - yAft)) / (maxH * u));
  const bellColor =
    tier === 'best' ? GRAPHITE : tier === 'ok' ? CLAY : mixColor(BELL_STEEL, PART_COLORS.bare, 0.3);
  const bellFinish: PartFinish = tier === 'best' ? 'satin' : 'matte';
  const bsegs = radialSegments(tier === 'bad' ? 8 : 28, 'small');
  const spots = layout.map(([x, z, k]) => ({ x: x * u * s, z: z * u * s, kk: k * u * s }));
  spots.forEach(({ x, z, kk }, i) => {
    // Bells of one size share one geometry; each mesh is placed at its own spot.
    const geo = sharedGeometry(ctx, `bell|${kk}|${yAft}|${bsegs}`, () =>
      lathe(BELL_PTS.map(([r, y]) => [r * kk, yAft + y * kk]), bsegs),
    );
    const bell = mesh(geo, bellColor, ctx, { finish: bellFinish });
    bell.position.set(x, 0, z);
    bell.name = 'bell';
    bell.userData.bell = true;
    bell.userData.index = i;
    g.add(bell);
  });

  const d = detailGroup();
  if (tier !== 'bad') {
    // dark throat inside every bell
    const throats = spots.map(({ x, z, kk }) => annulus(0, 0.165 * kk, yAft + 1.41 * kk, bsegs).translate(x, 0, z));
    addMerged(d, throats, BORE_DARK, ctx, 'throat', D('matte'));
  }
  if (tier === 'best') {
    // stepped aft closure: screw-on retainer ring, then a thrust ring, then the gold ring forward
    const hb = Math.min(0.12 * lcase, 0.5 * rc);
    const ht = Math.min(0.025 * lcase, 0.2 * rc);
    addMerged(d, [cyl(rc * 1.006, yAft, yAft + hb, segs)], mixColor(PART_COLORS.metal, 0x000000, 0.3), ctx, 'retainer', D('metal'));
    addMerged(d, [cyl(rc * 1.012, yAft + hb, yAft + hb + ht, segs)], PART_COLORS.metal, ctx, 'thrust-ring', D('metal'));
    const h = Math.min(0.1 * rc, lcase * 0.15);
    addMerged(d, [cyl(rc * 1.012, yTop - h, yTop, segs)], PART_COLORS.decoupler, ctx, 'accent-ring', D('metal'));
  } else if (tier === 'ok') {
    // printed label wrap, soot at each exit, and the motor hook strip
    const ya = yAft + 0.2 * lcase;
    const yb = yTop - 0.12 * lcase;
    addMerged(d, [cyl(rc * 1.008, ya, yb, segs)], LABEL_RED, ctx, 'label', D('gloss'));
    const soot = spots.map(({ x, z, kk }) => annulus(0.5 * kk, 0.575 * kk, yAft + 0.03 * kk, bsegs).translate(x, 0, z));
    addMerged(d, soot, SOOT, ctx, 'soot', D('matte'));
    const hook = new THREE.BoxGeometry(0.02 * rc, lcase * 0.94, 0.14 * rc);
    hook.translate(1.002 * rc, 0, 0);
    hook.rotateY(0.75 * Math.PI - Math.PI / 2);
    hook.translate(0, (yAft + yTop) / 2, 0);
    addMerged(d, [hook], PART_COLORS.metal, ctx, 'hook', D('metal'));
  } else {
    // taped joint and a scorched exit end
    const ta = yAft + 0.45 * lcase;
    addMerged(d, [lumpyBand(rc, ta, ta + 0.13 * lcase, segs, key, 100)], TAPE, ctx, 'tape', D('matte'));
    const sa = yAft + 0.16 * rc;
    const sb = sa + 0.22 * rc;
    if (sb < yTop) addMerged(d, [lumpyBand(rc, sa, sb, segs, key, 140)], 0x1a1713, ctx, 'scorch', D('matte'));
  }
  if (d.children.length) g.add(d);
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
  const skinFinish = SKIN_FINISH[tier];
  let capColor = c.color ?? PART_COLORS.nose;
  let bodyColor = base;
  if (tier === 'bad') {
    bodyColor = mixColor(base, PART_COLORS.bare, 0.18 + 0.14 * rnd(0));
    capColor = mixColor(capColor, PART_COLORS.bare, 0.2 + 0.15 * rnd(1));
  }

  g.add(mesh(cyl(r, y0, y1, segs), bodyColor, ctx, { finish: skinFinish }));
  // best and ok: the aft face carries a recessed bell (exit flush with the face, throat forward)
  const q = Math.min(0.6 * r / 0.72, (0.4 * L) / 1.3);
  const hasBell = tier !== 'bad';
  addMerged(
    g,
    [annulus(hasBell ? 0.72 * q : 0, r, y0, segs), annulus(0, r, y1, segs)],
    bodyColor,
    ctx,
    'ends',
    { finish: skinFinish },
  );
  const bellSegs = tier === 'best' ? segs : radialSegments(16, 'small');
  if (hasBell) {
    const nz = lathe(
      [[0.18, 1.3], [0.26, 1.0], [0.5, 0.5], [0.72, 0.0]].map(([rr, yy]) => [rr * q, y0 + yy * q] as [number, number]),
      bellSegs,
    );
    const nm = mesh(nz, BELL_STEEL, ctx, { finish: tier === 'best' ? 'metal' : 'satin' });
    if (tier === 'best') {
      nm.name = 'bell';
      nm.userData.bell = true;
    } else {
      nm.name = 'nozzle';
    }
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
    g.add(mesh(lathe(pts, segs), capColor, ctx, { finish: skinFinish }));
  } else if (tier === 'ok') {
    g.add(mesh(lathe([[0, y1 + capH], [r, y1]], segs), capColor, ctx, { finish: skinFinish }));
  } else {
    const wob = (k: number) => (i: number) => 0.85 + 0.3 * rnd(60 + 10 * k + i);
    const loops: V3[][] = [
      ringLoop(segs, y1, () => r),
      ringLoop(segs, y1 + 1.0 * r, (i) => 0.62 * r * wob(1)(i)),
      ringLoop(segs, y1 + 1.8 * r, (i) => 0.25 * r * wob(2)(i)),
      ringLoop(segs, y1 + capH, () => 0),
    ];
    g.add(mesh(loft(loops), capColor, ctx, { finish: skinFinish }));
  }

  const d = detailGroup();
  if (hasBell) {
    addMerged(d, [annulus(0, 0.17 * q, y0 + 1.27 * q, bellSegs)], BORE_DARK, ctx, 'throat', D('matte'));
  }
  if (tier === 'best') {
    const w = Math.min(0.008, L * 0.03);
    const dark = mixColor(base, 0x000000, 0.3);
    addMerged(d, [cyl(r * 1.008, y1 - w, y1, segs), cyl(r * 1.008, y0, y0 + w, segs)], dark, ctx, 'joints', D('satin'));
    // metal trim ring just aft of the nose joint
    const hm = Math.min(0.006, L * 0.02);
    addMerged(d, [cyl(r * 1.011, y1 - w - hm, y1 - w, segs)], PART_COLORS.metal, ctx, 'trim', D('metal'));
    // ASTRA accent band at 72% of the length, measured from the aft end, with pinstripes
    const sh = Math.min(L * 0.07, r * 0.7);
    const sy = y0 + L * 0.72;
    addMerged(d, [cyl(r * 1.012, sy - sh / 2, sy + sh / 2, segs)], c.color ? mixColor(base, PART_COLORS.nose, 0.8) : PART_COLORS.decoupler, ctx, 'accent-band', D('gloss'));
    const pw = Math.min(0.0016, L * 0.005);
    const off = sh / 2 + 2.5 * pw;
    if (sy - off - pw > y0 + w && sy + off + pw < y1 - w - hm) {
      addMerged(
        d,
        [cyl(r * 1.012, sy + off - pw / 2, sy + off + pw / 2, segs), cyl(r * 1.012, sy - off - pw / 2, sy - off + pw / 2, segs)],
        0xf2f2f0, ctx, 'pinstripe', D('gloss'),
      );
    }
  } else if (tier === 'ok') {
    // nose/body joint line and a painted aft band
    const w = Math.min(0.004, L * 0.02);
    addMerged(d, [cyl(r * 1.006, y1 - w, y1, segs)], mixColor(base, 0x000000, 0.3), ctx, 'joint', D('satin'));
    const hb = Math.min(L * 0.08, r * 0.9);
    addMerged(
      d,
      [cyl(r * 1.008, y0, y0 + hb, segs)],
      c.color ? mixColor(base, 0x000000, 0.35) : PART_COLORS.fin,
      ctx, 'aft-band', D('satin'),
    );
  } else {
    const seam = helixStrip(r, y0, y1, 4.4 * r, Math.min(0.08 * r, L * 0.2), segs, 1.008, { jit: (k) => rnd(200 + k) });
    if (seam) {
      const sm = mesh(seam, mixColor(base, 0x3a2f20, 0.5), ctx, D('matte'));
      sm.name = 'seam';
      d.add(sm);
    }
    addMerged(d, patchStrips(r, y0, L, segs, key, 3), mixColor(base, PART_COLORS.bare, 0.75), ctx, 'patches', D('matte'));
    const blobs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const a = (2 * Math.PI * i) / 4 + rnd(80 + i);
      const br = 0.12 * r * (0.7 + 0.6 * rnd(90 + i));
      blobs.push(sphere(br, 0.92 * r * Math.sin(a), y1 - br * 0.3, 0.92 * r * Math.cos(a)));
    }
    addMerged(d, blobs, PART_COLORS.glue, ctx, 'glue', D('satin', false));
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
