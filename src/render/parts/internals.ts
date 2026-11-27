// Inner parts seen in cutaway view: inner / motor-mount tube, rings (centering ring,
// bulkhead, tube coupler, engine block, shoulder), mass component, packed parachute.
//
// A tier changes workmanship and detail only, never a measured dimension. The main
// meshes carry the true size; decoration goes under a child group tagged
// `userData.detail = true`, stays inside the part's axial extent and stands proud of
// the surface by at most ~1.5% of the local radius.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { InnerTube, MassComponent, Parachute, Ring } from '../../types';
import {
  PART_COLORS,
  TIER_ACCENT,
  mixColor,
  partMaterial,
  radialSegments,
  scopedPart,
  seeded,
  type PartBuilder,
  type PartContext,
  type PartFinish,
  type PartIconSet,
  type PartTier,
} from './types';

// ---------------------------------------------------------------------------------
// helpers

const SEGMENTS: Record<PartTier, number> = { best: 64, ok: 32, bad: 12 };
/**
 * Thin decorative bands on these hidden parts stand 1-1.2% proud of the surface, so half
 * the main surface's segments still keep every band facet outside it.
 */
const BAND_SEGMENTS_MAX = 32;

/** Radial segments for a cutaway part at this tier (capped on touch devices). */
function segmentsFor(tier: PartTier): number {
  return radialSegments(SEGMENTS[tier], 'inner');
}
const TWO_PI = Math.PI * 2;

function ok(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function emptyGroup(): THREE.Group {
  return new THREE.Group();
}

function detailGroup(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'detail';
  g.userData.detail = true;
  return g;
}

/** The component colour, or the default (crude builds drift toward bare material). */
function baseColor(color: number | undefined, def: number, tier: PartTier): number {
  if (color !== undefined && color !== null) return color;
  return tier === 'bad' ? mixColor(def, PART_COLORS.bare, 0.25) : def;
}

interface Prof {
  y: number;
  r: number;
}

interface RevolveOpts {
  /** Give every profile segment its own vertices, so edges between segments stay sharp. */
  hard?: boolean;
  /** Radial scale per (profile index, column). */
  radial?: (k: number, j: number) => number;
  /** Flat-shaded facets. */
  flat?: boolean;
}

/** Surface of revolution about +Y through a profile of (y, r) points. */
function revolve(profile: Prof[], seg: number, opts: RevolveOpts = {}): THREE.BufferGeometry {
  const n = profile.length;
  const hard = !!opts.hard;
  const ringCount = hard ? (n - 1) * 2 : n;
  const pos = new Float32Array(ringCount * seg * 3);
  const fillRing = (ringIdx: number, k: number) => {
    const p = profile[k];
    for (let j = 0; j < seg; j++) {
      const th = (TWO_PI * j) / seg;
      const f = opts.radial ? opts.radial(k, j) : 1;
      const r = p.r * f;
      const o = (ringIdx * seg + j) * 3;
      pos[o] = r * Math.cos(th);
      pos[o + 1] = p.y;
      pos[o + 2] = r * Math.sin(th);
    }
  };
  const idx: number[] = [];
  for (let s = 0; s < n - 1; s++) {
    const ra = hard ? s * 2 : s;
    const rb = hard ? s * 2 + 1 : s + 1;
    if (hard) {
      fillRing(ra, s);
      fillRing(rb, s + 1);
    } else if (s === 0) {
      fillRing(0, 0);
    }
    if (!hard) fillRing(rb, s + 1);
    for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      const a = ra * seg + j;
      const b = ra * seg + j1;
      const c = rb * seg + j;
      const d = rb * seg + j1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  if (opts.flat) {
    const f = geo.toNonIndexed();
    geo.dispose();
    f.computeVertexNormals();
    return f;
  }
  geo.computeVertexNormals();
  return geo;
}

/** Profile of a tube or disc between y1 (fore) and y0 (aft). ri <= 0 gives a solid disc. */
function sectionProfile(ro: number, ri: number, y0: number, y1: number): Prof[] {
  if (ri > 0) {
    return [
      { y: y1, r: ri },
      { y: y1, r: ro },
      { y: y0, r: ro },
      { y: y0, r: ri },
      { y: y1, r: ri },
    ];
  }
  return [
    { y: y1, r: 0 },
    { y: y1, r: ro },
    { y: y0, r: ro },
    { y: y0, r: 0 },
  ];
}

/** Rounded-capsule profile with poles exactly at y1 and y0. */
function capsuleProfile(R: number, y1: number, y0: number, a: number, steps: number): Prof[] {
  const pts: Prof[] = [];
  for (let i = 0; i <= steps; i++) {
    const phi = (i / steps) * (Math.PI / 2);
    pts.push({ y: y1 - a * (1 - Math.cos(phi)), r: R * Math.sin(phi) });
  }
  for (let i = steps; i >= 0; i--) {
    const phi = (i / steps) * (Math.PI / 2);
    pts.push({ y: y0 + a * (1 - Math.cos(phi)), r: R * Math.sin(phi) });
  }
  return pts;
}

function circlePts(r: number, n: number, cx = 0, cz = 0): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const th = (TWO_PI * i) / n;
    pts.push(new THREE.Vector2(cx + r * Math.cos(th), cz + r * Math.sin(th)));
  }
  return pts;
}

/** Vertical walls (between ya and yb) along closed loops given as (x, z) points. */
function wallGeo(loops: THREE.Vector2[][], ya: number, yb: number): THREE.BufferGeometry {
  let total = 0;
  for (const l of loops) total += l.length;
  const pos = new Float32Array(total * 2 * 3);
  const idx: number[] = [];
  let base = 0;
  for (const l of loops) {
    const m = l.length;
    for (let i = 0; i < m; i++) {
      const o = (base + i) * 3;
      pos[o] = l[i].x;
      pos[o + 1] = ya;
      pos[o + 2] = l[i].y;
      const o2 = (total + base + i) * 3;
      pos[o2] = l[i].x;
      pos[o2 + 1] = yb;
      pos[o2 + 2] = l[i].y;
    }
    for (let i = 0; i < m; i++) {
      const i1 = (i + 1) % m;
      const a = base + i;
      const b = base + i1;
      const c = total + base + i;
      const d = total + base + i1;
      idx.push(a, c, b, b, c, d);
    }
    base += m;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Flat faces at the given heights over a contour with holes. */
function capGeo(contour: THREE.Vector2[], holes: THREE.Vector2[][], ys: number[]): THREE.BufferGeometry {
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  const all: THREE.Vector2[] = [...contour];
  for (const h of holes) all.push(...h);
  const m = all.length;
  const pos = new Float32Array(m * ys.length * 3);
  const idx: number[] = [];
  ys.forEach((y, yi) => {
    for (let i = 0; i < m; i++) {
      const o = (yi * m + i) * 3;
      pos[o] = all[i].x;
      pos[o + 1] = y;
      pos[o + 2] = all[i].y;
    }
    for (const f of faces) idx.push(yi * m + f[0], yi * m + f[1], yi * m + f[2]);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------------
// real-hardware palette (local: PART_COLORS is shared)

const KRAFT = 0xb08d5e; // spiral-wound kraft paper
const KRAFT_SMOOTH = 0xc4a578; // glassine-smooth tube
const PLY_FACE = 0xcfa972; // birch plywood face
const PLY_DARK = 0x8a6a44; // ply core / glue line
const BURNT = 0x4a3423; // laser-cut edge
const PHENOLIC = 0x5a3b26;
const EPOXY = 0xd8c68a;
const ZINC = 0xb9c0c8; // zinc-plated steel
const NOMEX_OLIVE = 0x6b6f3a;
const NOMEX_ORANGE = 0xd9682a;
const KEVLAR = 0xd8b84a;
const SHROUD = 0xeeeeea;
const CARDBOARD = 0x9a8466;
const STEEL = 0x7c838b;
const CAST = 0x3b3e45;
const LUMP = 0x6a5f50;
const TAPE = 0xd6cfae;
const GRAPHITE = 0x3a3a3c;
const PAPER_WHITE = 0xe8e4d6;

type Fin = PartFinish;

/** Material of a thin decoration lying on a surface (carries a little polygon offset). */
function dm(ctx: PartContext, color: number, fin: Fin, offset = true): THREE.MeshStandardMaterial {
  return partMaterial(color, ctx, { finish: fin, offset });
}

function tag<T extends THREE.Object3D>(o: T, part: string): T {
  o.name = part;
  o.userData.part = part;
  return o;
}

/** One mesh from several same-material shapes (uv dropped so primitives and built shapes merge). */
function mergedMesh(geos: (THREE.BufferGeometry | null)[], material: THREE.Material, part: string): THREE.Mesh | null {
  const list = geos.filter((g): g is THREE.BufferGeometry => !!g && !!g.getAttribute('position') && g.getAttribute('position').count > 0);
  if (!list.length) return null;
  for (const g of list) g.deleteAttribute('uv');
  let out: THREE.BufferGeometry | null = list[0];
  if (list.length > 1) {
    out = mergeGeometries(list, false);
    for (const g of list) g.dispose();
  }
  return out ? tag(new THREE.Mesh(out, material), part) : null;
}

/** An open band around the axis (or an arc of one), kept inside [y0, y1]. */
function bandGeo(r: number, yc: number, h: number, y0: number, y1: number, seg: number, thetaStart = 0, thetaLen = TWO_PI): THREE.BufferGeometry {
  const hh = Math.max(Math.min(h, y1 - y0), 1e-9);
  const yy = Math.min(Math.max(yc, y0 + hh / 2), y1 - hh / 2);
  const g = new THREE.CylinderGeometry(r, r, hh, Math.max(3, Math.min(seg, BAND_SEGMENTS_MAX)), 1, true, thetaStart, thetaLen);
  g.translate(0, yy, 0);
  return g;
}

function bandMesh(r: number, yc: number, h: number, y0: number, y1: number, seg: number, color: number, ctx: PartContext, fin?: Fin): THREE.Mesh {
  return tag(new THREE.Mesh(bandGeo(r, yc, h, y0, y1, seg), partMaterial(color, ctx, { finish: fin, offset: true })), 'band');
}

/** Thin cylinder between two points, as a geometry with the placement baked in. */
function cylGeo(a: THREE.Vector3, b: THREE.Vector3, rad: number): THREE.BufferGeometry | null {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (!(len > 1e-12)) return null;
  const g = new THREE.CylinderGeometry(rad, rad, len, 4, 1);
  const m = new THREE.Matrix4().compose(
    a.clone().add(b).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  return g;
}

/** Flat annulus lying in the plane y (an end face seen as a different material). */
function flatRing(ri: number, ro: number, y: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(ri, ro, Math.max(3, Math.min(seg, BAND_SEGMENTS_MAX)), 1);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** Flat disc lying in the plane y. */
function flatDisc(r: number, y: number, n: number, x = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(r, n);
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function endWalls(ri: number, ro: number, y0: number, y1: number, seg: number): THREE.BufferGeometry[] {
  return [flatRing(ri, ro, y1, seg), flatRing(ri, ro, y0, seg)];
}

/** Radius of a capsule bundle (see capsuleProfile) at height y. */
function capsuleR(R: number, a: number, y1: number, y0: number, y: number): number {
  const d = Math.min(y1 - y, y - y0);
  if (!(a > 0) || d >= a) return R;
  const t = Math.max(0, 1 - d / a);
  return R * Math.sqrt(Math.max(0, 1 - t * t));
}

/** Local frame on a capsule dome: x round the bundle, y down the meridian, z outward. */
function domeFrame(R: number, a: number, y1: number, delta: number, theta: number): THREE.Matrix4 {
  const cp = 1 - delta / a;
  const sp = Math.sqrt(Math.max(0, 1 - cp * cp));
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const n = new THREE.Vector3(a * sp * ct, R * cp, a * sp * st).normalize();
  const t = new THREE.Vector3(R * cp * ct, -a * sp, R * cp * st).normalize();
  const b = new THREE.Vector3().crossVectors(t, n);
  const m = new THREE.Matrix4().makeBasis(b, t, n);
  m.setPosition(R * sp * ct, y1 - delta, R * sp * st);
  return m;
}

/** True when every vertex is inside the axial span [y0, y1] and within radius rMax. */
function fits(g: THREE.BufferGeometry, y0: number, y1: number, rMax: number): boolean {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < y0 || y > y1 || Math.hypot(p.getX(i), p.getZ(i)) > rMax) return false;
  }
  return true;
}

/** Radial factor pinned to 1 on the four axis directions, so the extreme radius is exact. */
function pinned(seg: number, j: number): boolean {
  return j % (seg / 4) === 0;
}

function addAll(parent: THREE.Object3D, ...kids: (THREE.Object3D | null)[]) {
  for (const k of kids) if (k) parent.add(k);
}

function finish(main: THREE.Group, det: THREE.Group): THREE.Group {
  if (det.children.length) main.add(det);
  return main;
}

/**
 * Plywood layers seen on a rim: dark glue layers between the plies when the part is thick
 * enough to show them, else one darker edge band.
 */
function plyLines(r: number, L: number, y0: number, y1: number, seg: number): THREE.BufferGeometry[] {
  const plies = Math.max(1, Math.min(5, Math.round(L / 0.0008)));
  if (plies < 3) return [bandGeo(r, (y0 + y1) / 2, 0.98 * L, y0, y1, seg)];
  const out: THREE.BufferGeometry[] = [];
  const lh = L / plies;
  for (let i = 1; i < plies; i += 2) out.push(bandGeo(r, y1 - (i + 0.5) * lh, lh, y0, y1, seg));
  return out;
}

/** Dried glue blobs sitting on a rim, one merged mesh. */
function glueBlobs(c: { id: string }, ro: number, L: number, y0: number, y1: number, color: number, ctx: PartContext): THREE.Mesh | null {
  const sr = Math.min(0.0125 * ro, L * 0.49);
  const n = 5 + Math.floor(seeded(c.id, 3) * 4);
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const th = seeded(c.id, 50 + i) * TWO_PI;
    const yy = Math.min(Math.max(y0 + sr + (L - 2 * sr) * seeded(c.id, 70 + i), y0 + sr), y1 - sr);
    const sg = new THREE.SphereGeometry(sr, 6, 4);
    sg.translate(ro * Math.cos(th), yy, ro * Math.sin(th));
    geos.push(sg);
  }
  return mergedMesh(geos, dm(ctx, color, 'satin', false), 'glue');
}

/** Flat glue smears on a face between radii rLo and rHi. */
function glueSmears(c: { id: string }, rLo: number, rHi: number, y: number, ctx: PartContext, color: number): THREE.Mesh | null {
  const rad = 0.1 * (rHi - rLo);
  if (!(rad > 0)) return null;
  const geos: THREE.BufferGeometry[] = [];
  const n = 3;
  for (let i = 0; i < n; i++) {
    const ang = seeded(c.id, 400 + i) * TWO_PI;
    const rr = rLo + 1.4 * rad + (rHi - rLo - 2.8 * rad) * seeded(c.id, 410 + i);
    const size = rad * (0.7 + 0.7 * seeded(c.id, 420 + i));
    const g = new THREE.CircleGeometry(size, 7);
    g.scale(1, 0.55 + 0.5 * seeded(c.id, 430 + i), 1);
    g.rotateZ(seeded(c.id, 440 + i) * Math.PI);
    g.rotateX(-Math.PI / 2);
    g.translate(rr * Math.cos(ang), y, rr * Math.sin(ang));
    geos.push(g);
  }
  return mergedMesh(geos, dm(ctx, color, 'satin'), 'smear');
}

// ---------------------------------------------------------------------------------
// inner tube / motor-mount tube

/** Spiral paper seam: a thin ribbon on the outside surface. */
function helixRibbon(r: number, y1: number, y0: number, turns: number, hw: number, start: number, perTurn = 20): THREE.BufferGeometry {
  const N = Math.max(8, Math.min(900, Math.ceil(turns * perTurn)));
  const pos = new Float32Array((N + 1) * 2 * 3);
  const idx: number[] = [];
  const span = Math.max(y1 - y0 - 2 * hw, 0);
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    const th = start + t * turns * TWO_PI;
    const yc = y1 - hw - t * span;
    const c = Math.cos(th) * r;
    const sn = Math.sin(th) * r;
    pos.set([c, yc + hw, sn, c, yc - hw, sn], s * 6);
    if (s < N) {
      const a = s * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export const buildInnerTube: PartBuilder<InnerTube> = scopedPart((c, tier, ctx) => {
  const ro = c.outerRadius;
  const L = c.length;
  if (!(ok(c.x) && ok(L) && L > 0 && ok(ro) && ro > 0)) return emptyGroup();
  const y1 = -c.x;
  const y0 = -(c.x + L);
  const t = ok(c.thickness) && c.thickness > 0 ? c.thickness : 0;
  const solid = t >= ro;
  const ri = t > 0 && t < ro ? ro - t : 0;
  const seg = segmentsFor(tier);
  const base = baseColor(c.color, tier === 'best' ? KRAFT_SMOOTH : KRAFT, tier);

  let profile: Prof[];
  if (ri > 0) profile = sectionProfile(ro, ri, y0, y1);
  else if (solid) profile = sectionProfile(ro, 0, y0, y1);
  else profile = [{ y: y1, r: ro }, { y: y0, r: ro }];

  const g = new THREE.Group();
  const geo = revolve(profile, seg, { hard: true, flat: tier === 'bad' });
  g.add(tag(new THREE.Mesh(geo, partMaterial(base, ctx, { finish: tier === 'best' ? 'satin' : 'matte' })), 'tube'));

  const det = detailGroup();
  const rb = ro * 1.012;
  const hollow = ri > 0;
  const wallColor = mixColor(base, 0x2a1d10, tier === 'best' ? 0.3 : 0.45);
  if (tier === 'best') {
    // crisp squared ends with a thin end band, a thrust-ring lip inside the forward end
    const bandColor = mixColor(base, PART_COLORS.motor, c.isMotorMount ? 0.5 : 0.3);
    const h = Math.min(0.05 * L, 0.3 * ro);
    addAll(
      det,
      bandMesh(rb, y1 - h / 2, h, y0, y1, seg, bandColor, ctx, 'satin'),
      bandMesh(rb, y0 + h / 2, h, y0, y1, seg, bandColor, ctx, 'satin'),
    );
    if (hollow) {
      addAll(det, mergedMesh(endWalls(ri, ro, y0, y1, seg), dm(ctx, wallColor, 'satin'), 'endwall'));
      if (c.isMotorMount) {
        const lh = Math.min(0.05 * L, 0.6 * ri);
        const lip = revolve(sectionProfile(ri, 0.82 * ri, y1 - lh, y1), seg, { hard: true });
        det.add(tag(new THREE.Mesh(lip, dm(ctx, mixColor(base, PHENOLIC, 0.55), 'satin')), 'thrustring'));
      }
    }
  } else if (tier === 'ok') {
    // spiral-wound kraft: a darker winding seam, dark wall annulus at both open ends
    const turns = Math.max(1, Math.min(30, L / (ro * 4)));
    const hw = Math.min(0.04 * ro, 0.015 * L);
    det.add(
      tag(
        new THREE.Mesh(
          helixRibbon(rb, y1, y0, turns, hw, seeded(c.id, 0) * TWO_PI, 32),
          dm(ctx, mixColor(base, 0x3a2a18, 0.3), 'matte'),
        ),
        'seam',
      ),
    );
    if (hollow) addAll(det, mergedMesh(endWalls(ri, ro, y0, y1, seg), dm(ctx, wallColor, 'matte'), 'endwall'));
  } else {
    const patchColor = mixColor(base, PART_COLORS.bare, 0.8);
    const turns = Math.max(1, Math.min(30, L / (ro * 5)));
    const hw = Math.min(0.05 * ro, 0.02 * L);
    det.add(tag(new THREE.Mesh(helixRibbon(ro * 1.008, y1, y0, turns, hw, seeded(c.id, 0) * TWO_PI), dm(ctx, patchColor, 'matte')), 'seam'));
    const patches = 3 + Math.floor(seeded(c.id, 1) * 3);
    const pg: THREE.BufferGeometry[] = [];
    for (let i = 0; i < patches; i++) {
      const h = L * (0.08 + 0.2 * seeded(c.id, 10 + i));
      const hh = Math.min(h, L);
      const yc = y0 + hh / 2 + (L - hh) * seeded(c.id, 20 + i);
      const th0 = seeded(c.id, 30 + i) * TWO_PI;
      const len = 0.6 + seeded(c.id, 40 + i) * 1.2;
      const cg = new THREE.CylinderGeometry(ro * 1.006, ro * 1.006, hh, 8, 1, true, th0, len);
      cg.translate(0, yc, 0);
      pg.push(cg);
    }
    addAll(det, mergedMesh(pg, dm(ctx, patchColor, 'matte'), 'patches'));
    // peeling outer wrap edge: a wide pale strip that has lifted along the winding
    det.add(
      tag(
        new THREE.Mesh(
          helixRibbon(rb, y1, y0, Math.max(1, turns * 0.5), Math.min(0.1 * ro, 0.04 * L), seeded(c.id, 5) * TWO_PI),
          dm(ctx, mixColor(base, 0xffffff, 0.4), 'matte'),
        ),
        'peel',
      ),
    );
    // crushed, darkened ends
    const eh = Math.min(0.035 * L, 0.3 * ro);
    const crush: THREE.BufferGeometry[] = [bandGeo(ro * 1.01, y1 - eh / 2, eh, y0, y1, seg), bandGeo(ro * 1.01, y0 + eh / 2, eh, y0, y1, seg)];
    if (hollow) crush.push(...endWalls(ri, ro, y0, y1, seg));
    addAll(det, mergedMesh(crush, dm(ctx, mixColor(base, 0x2a1d10, 0.55), 'matte'), 'crushed'));
  }
  return finish(g, det);
});

// ---------------------------------------------------------------------------------
// rings

type RingKind = 'centeringring' | 'bulkhead' | 'tubecoupler' | 'engineblock' | 'shoulder' | 'other';

function ringKind(c: Ring, ri: number): RingKind {
  const t = c.ringType;
  if (t === 'centeringring' || t === 'bulkhead' || t === 'tubecoupler' || t === 'engineblock' || t === 'shoulder') return t;
  if (t === undefined || t === null) return ri > 0 ? 'centeringring' : 'bulkhead';
  return 'other';
}

/** Crude bent screw-eye lying in the pocket of a bulkhead; wholly inside the part's axial extent. */
function badEyeBolt(c: Ring, y1: number, d: number, ro: number, pr: number, ctx: PartContext): THREE.Mesh {
  const tr = Math.min(0.04 * ro, 0.2 * d);
  const Re = Math.min(0.13 * ro, pr * 0.6);
  const a = seeded(c.id, 1) * TWO_PI;
  const ox = 0.07 * ro * Math.cos(a);
  const oz = 0.07 * ro * Math.sin(a);
  const tilt = Math.min(0.3 + 0.2 * seeded(c.id, 2), Math.asin(Math.min(1, (0.25 * d) / Re)));
  const lift = Re * Math.sin(tilt);
  const cy = y1 - d + tr + lift + 0.02 * d;
  const geo = new THREE.TorusGeometry(Re, tr, 8, 20);
  geo.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(geo, partMaterial(mixColor(ZINC, 0x7a4a2a, 0.55), ctx, { finish: 'matte' }));
  m.position.set(ox, cy, oz);
  m.rotation.z = tilt;
  return tag(m, 'eyebolt');
}

function cylAt(r: number, h: number, yb: number, n: number, x = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, n);
  g.translate(x, yb + h / 2, z);
  return g;
}

/** Forged eyebolt standing in the pocket: ring on a short neck, nut and washer, all steel. */
function eyeBoltOk(c: Ring, ctx: PartContext, y1: number, d: number, pr: number): THREE.Mesh | null {
  const u = Math.min(d, 2.2 * pr);
  if (!(u > 0)) return null;
  const yf = y1 - d;
  const small = radialSegments(16, 'small');
  const wH = 0.06 * u;
  const nH = 0.16 * u;
  const kH = 0.05 * u;
  const Re = 0.2 * u;
  const tr = 0.06 * u;
  const ring = new THREE.TorusGeometry(Re, tr, 6, small);
  ring.rotateY(seeded(c.id, 5) * Math.PI);
  ring.translate(0, yf + wH + nH + kH + Re + tr, 0);
  return mergedMesh(
    [
      cylAt(0.36 * u, wH, yf, small),
      cylAt(0.3 * u, nH, yf + wH, 6),
      cylAt(0.9 * tr, kH + 0.02 * u, yf + wH + nH - 0.01 * u, 8),
      ring,
    ],
    partMaterial(ZINC, ctx, { finish: 'metal' }),
    'eyebolt',
  );
}

/** U-bolt through a backing plate with two nuts, plus a small vent hole in the sealed face. */
function bulkheadHardware(c: Ring, ctx: PartContext, y0: number, y1: number, d: number, pr: number, ro: number, base: number): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const u = Math.min(d, 2.2 * pr);
  if (u > 0) {
    const yf = y1 - d;
    const small = radialSegments(16, 'small');
    const Rb = 0.27 * u;
    const tr = 0.055 * u;
    const yc = yf + 0.23 * u;
    const bend = new THREE.TorusGeometry(Rb, tr, 6, small, Math.PI);
    bend.translate(0, yc, 0);
    const geos: THREE.BufferGeometry[] = [bend];
    for (const s of [-1, 1]) {
      geos.push(cylAt(tr, yc - yf, yf, 8, s * Rb, 0));
      geos.push(cylAt(0.17 * u, 0.05 * u, yf, 10, s * Rb, 0));
    }
    const ub = mergedMesh(geos, partMaterial(ZINC, ctx, { finish: 'metal' }), 'ubolt');
    if (ub) out.push(ub);
    // aft side: backing plate and the two nuts, flush with the disc
    const place = (g: THREE.BufferGeometry, y: number) => {
      g.rotateX(Math.PI / 2);
      g.translate(0, y, 0);
      return g;
    };
    const plate = new THREE.PlaneGeometry(2 * (Rb + 0.22 * u), 0.5 * u);
    const nutGeos = [-1, 1].map((s) => {
      const n = new THREE.CircleGeometry(0.16 * u, 6);
      n.translate(s * Rb, 0, 0);
      return n;
    });
    const L = y1 - y0;
    const pm = mergedMesh([place(plate, y0 + 0.012 * L)], dm(ctx, ZINC, 'metal'), 'backplate');
    const nm = mergedMesh(nutGeos.map((n) => place(n, y0)), dm(ctx, mixColor(ZINC, 0x000000, 0.2), 'metal'), 'nuts');
    if (pm) out.push(pm);
    if (nm) out.push(nm);
  }
  const va = seeded(c.id, 7) * TWO_PI;
  const vm = mergedMesh([flatDisc(0.06 * ro, y1, 12, 0.6 * ro * Math.cos(va), 0.6 * ro * Math.sin(va))], dm(ctx, mixColor(base, 0x000000, 0.8), 'matte'), 'vent');
  if (vm) out.push(vm);
  return out;
}

export const buildRing: PartBuilder<Ring> = scopedPart((c, tier, ctx) => {
  const ro = c.outerRadius;
  const L = c.length;
  if (!(ok(c.x) && ok(L) && L > 0 && ok(ro) && ro > 0 && ok(c.innerRadius))) return emptyGroup();
  const ri = c.innerRadius > 0 ? c.innerRadius : 0;
  if (ri >= ro) return emptyGroup();
  const y1 = -c.x;
  const y0 = -(c.x + L);
  const ymid = (y0 + y1) / 2;
  const seg = segmentsFor(tier);
  const kind = ringKind(c, ri);
  const tubeLike = kind === 'tubecoupler' || kind === 'shoulder';
  const def = tubeLike ? (tier === 'best' && kind === 'tubecoupler' ? PHENOLIC : KRAFT) : tier === 'bad' ? CARDBOARD : PLY_FACE;
  const base = baseColor(c.color, def, tier);
  const mat = partMaterial(base, ctx, { finish: tier === 'best' ? 'satin' : 'matte' });
  const g = new THREE.Group();
  const det = detailGroup();
  const dark = mixColor(base, 0x000000, 0.45);

  // bulkhead: solid disc with a pocket on the fore face holding the recovery anchor
  const pocketed = kind === 'bulkhead' && ri <= 0;
  const d = (tier === 'bad' ? 0.5 : 0.7) * L;
  const pr = (tier === 'bad' ? 0.3 : 0.22) * ro;

  const holeCenters: { x: number; z: number }[] = [];
  let holeR = 0;
  let holeRc = 0;
  if (tier === 'best' && !pocketed && ri > 0) {
    const w = ro - ri;
    const holes: THREE.Vector2[][] = [];
    if (kind === 'centeringring' && w > 0.3 * ro) {
      const hr = 0.26 * w;
      const rc = (ro + ri) / 2;
      const n = Math.max(3, Math.min(8, Math.floor(Math.PI / Math.asin(Math.min(0.99, (1.5 * hr) / rc)))));
      holeR = hr;
      holeRc = rc;
      for (let i = 0; i < n; i++) {
        const th = (TWO_PI * i) / n + Math.PI / n;
        holeCenters.push({ x: rc * Math.cos(th), z: rc * Math.sin(th) });
        holes.push(circlePts(hr, 16, rc * Math.cos(th), rc * Math.sin(th)));
      }
    }
    const outer = circlePts(ro, seg);
    const inner = circlePts(ri, seg);
    g.add(tag(new THREE.Mesh(capGeo(outer, [inner, ...holes], [y1, y0]), mat), 'ring'));
    g.add(tag(new THREE.Mesh(wallGeo([outer, inner, ...holes], y0, y1), mat), 'ring'));
  } else {
    let profile: Prof[];
    if (pocketed) {
      profile = [
        { y: y1 - d, r: 0 },
        { y: y1 - d, r: pr },
        { y: y1, r: pr },
        { y: y1, r: ro },
        { y: y0, r: ro },
        { y: y0, r: 0 },
      ];
    } else {
      profile = sectionProfile(ro, ri, y0, y1);
    }
    const bad = tier === 'bad';
    const radial = bad
      ? (k: number, j: number) => {
          if (profile[k].r !== ro || pinned(seg, j)) return 1;
          return 1 - 0.004 * seeded(c.id, k * 31 + j);
        }
      : undefined;
    g.add(tag(new THREE.Mesh(revolve(profile, seg, { hard: true, radial, flat: bad }), mat), 'ring'));
  }

  if (pocketed) {
    if (tier === 'bad') det.add(badEyeBolt(c, y1, d, ro, pr, ctx));
    else if (tier === 'ok') addAll(det, eyeBoltOk(c, ctx, y1, d, pr));
    else addAll(det, ...bulkheadHardware(c, ctx, y0, y1, d, pr, ro, base));
  }

  const rb = ro * 1.01;
  const rin = ri * 0.99;
  const wallColor = mixColor(base, 0x2a1d10, 0.4);

  if (kind === 'engineblock') {
    if (tier === 'best') {
      det.add(bandMesh(rb, ymid, 0.8 * L, y0, y1, seg, mixColor(base, PART_COLORS.metal, 0.6), ctx, 'metal'));
      // thrust-ring edge: a bright steel line at the aft end
      det.add(bandMesh(rb, y0 + 0.07 * L, 0.1 * L, y0, y1, seg, PART_COLORS.metal, ctx, 'metal'));
    } else if (tier === 'ok') {
      addAll(det, mergedMesh(endWalls(ri, ro, y0, y1, seg), dm(ctx, wallColor, 'matte'), 'endwall'));
      addAll(det, mergedMesh(plyLines(rb, L, y0, y1, seg), dm(ctx, mixColor(base, PLY_DARK, 0.6), 'matte'), 'plyedge'));
    }
  } else if (tubeLike) {
    const pencil = Math.min(0.035 * ro, 0.03 * L);
    if (tier === 'best') {
      if (kind === 'tubecoupler') {
        det.add(bandMesh(rb, ymid, Math.min(0.06 * ro, 0.1 * L), y0, y1, seg, dark, ctx, 'satin'));
        // stiffener band inside the coupler
        const sh = 0.18 * L;
        const st = revolve(sectionProfile(ri, 0.9 * ri, ymid - sh / 2, ymid + sh / 2), seg, { hard: true });
        det.add(tag(new THREE.Mesh(st, dm(ctx, mixColor(base, 0x000000, 0.25), 'satin')), 'stiffener'));
      } else {
        det.add(bandMesh(rb, y1 - 0.2 * L, Math.min(0.06 * ro, 0.1 * L), y0, y1, seg, dark, ctx, 'satin'));
      }
      if (ri > 0) addAll(det, mergedMesh(endWalls(ri, ro, y0, y1, seg), dm(ctx, mixColor(base, 0x000000, 0.35), 'satin'), 'endwall'));
    } else if (tier === 'ok') {
      const turns = Math.max(1, Math.min(30, L / (ro * 3.5)));
      det.add(
        tag(
          new THREE.Mesh(
            helixRibbon(rb, y1, y0, turns, Math.min(0.05 * ro, 0.02 * L), seeded(c.id, 0) * TWO_PI, 32),
            dm(ctx, mixColor(base, 0x3a2a18, 0.3), 'matte'),
          ),
          'seam',
        ),
      );
      if (kind === 'tubecoupler') det.add(bandMesh(rb, ymid, pencil, y0, y1, seg, GRAPHITE, ctx, 'matte'));
      if (ri > 0) addAll(det, mergedMesh(endWalls(ri, ro, y0, y1, seg), dm(ctx, wallColor, 'matte'), 'endwall'));
    } else {
      // wrinkled wraps: pale lifted patches, dark creases, a peeling seam, stained ends
      const cr: THREE.BufferGeometry[] = [];
      const pa: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 5; i++) {
        cr.push(bandGeo(rb, y0 + L * (0.1 + 0.8 * seeded(c.id, 600 + i)), Math.min(0.012 * ro, 0.02 * L), y0, y1, 8, seeded(c.id, 610 + i) * TWO_PI, 1.2 + seeded(c.id, 620 + i)));
      }
      for (let i = 0; i < 3; i++) {
        pa.push(bandGeo(ro * 1.006, y0 + L * (0.15 + 0.7 * seeded(c.id, 630 + i)), L * (0.12 + 0.15 * seeded(c.id, 640 + i)), y0, y1, 8, seeded(c.id, 650 + i) * TWO_PI, 0.8 + seeded(c.id, 660 + i)));
      }
      addAll(det, mergedMesh(cr, dm(ctx, mixColor(base, 0x2a1d10, 0.6), 'matte'), 'creases'));
      addAll(det, mergedMesh(pa, dm(ctx, mixColor(base, 0xffffff, 0.35), 'matte'), 'patches'));
      det.add(
        tag(
          new THREE.Mesh(
            helixRibbon(rb, y1, y0, Math.max(1, L / (ro * 6)), Math.min(0.09 * ro, 0.04 * L), seeded(c.id, 5) * TWO_PI),
            dm(ctx, mixColor(base, 0xffffff, 0.45), 'matte'),
          ),
          'peel',
        ),
      );
      if (ri > 0) addAll(det, mergedMesh(endWalls(ri, ro, y0, y1, seg), dm(ctx, mixColor(PART_COLORS.glue, base, 0.5), 'satin'), 'endwall'));
    }
  } else if (tier === 'ok') {
    // sanded kit plywood: layered rim, epoxy fillet where the motor tube meets the ring
    const lseg = Math.min(seg, 24);
    const lines = plyLines(rb, L, y0, y1, lseg);
    if (ri > 0) lines.push(...plyLines(rin, L, y0, y1, lseg));
    addAll(det, mergedMesh(lines, dm(ctx, mixColor(base, PLY_DARK, 0.6), 'matte'), 'plyedge'));
    if (ri > 0) {
      const tr = Math.min(0.03 * ro, 0.4 * L);
      const bead = new THREE.TorusGeometry(ri, tr, 3, Math.min(seg, 24));
      bead.rotateX(Math.PI / 2);
      bead.translate(0, y1 - tr, 0);
      addAll(det, mergedMesh([bead], dm(ctx, EPOXY, 'satin'), 'fillet'));
    }
  } else if (tier === 'best') {
    // laser-cut: scorched edges and hole liners, a few flush steel screw heads
    const burnt: THREE.BufferGeometry[] = [bandGeo(rb, ymid, 0.98 * L, y0, y1, seg)];
    if (ri > 0) burnt.push(bandGeo(rin, ymid, 0.98 * L, y0, y1, seg));
    for (const h of holeCenters) {
      const liner = new THREE.CylinderGeometry(0.97 * holeR, 0.97 * holeR, 0.98 * L, 12, 1, true);
      liner.translate(h.x, ymid, h.z);
      burnt.push(liner);
    }
    addAll(det, mergedMesh(burnt, dm(ctx, mixColor(base, BURNT, 0.85), 'matte'), 'burnt'));
    if (holeCenters.length >= 3) {
      const n = holeCenters.length;
      const count = Math.min(4, n);
      const step = Math.floor(n / count);
      const rs = 0.8 * holeR;
      const hh = Math.min(0.12 * L, 0.5 * rs);
      const screws: THREE.BufferGeometry[] = [];
      for (let i = 0; i < count; i++) {
        const th = (TWO_PI * i * step) / n;
        screws.push(cylAt(rs, hh, y1 - hh, 6, holeRc * Math.cos(th), holeRc * Math.sin(th)));
      }
      addAll(det, mergedMesh(screws, dm(ctx, ZINC, 'metal'), 'screws'));
    }
  }

  if (tier === 'bad' && !tubeLike) {
    // glue left as blobs on the rim and smears on the face, a torn cardboard edge
    const glue = mixColor(PART_COLORS.glue, base, 0.2);
    addAll(det, glueBlobs(c, ro, L, y0, y1, glue, ctx));
    addAll(det, glueSmears(c, pocketed ? pr * 1.2 : ri, ro, y1, ctx, glue));
    const torn: THREE.BufferGeometry[] = [
      bandGeo(rb, ymid, 0.9 * L, y0, y1, 8, seeded(c.id, 500) * TWO_PI, 1.1 + seeded(c.id, 501)),
      bandGeo(rb, ymid, 0.9 * L, y0, y1, 8, seeded(c.id, 502) * TWO_PI, 0.6 + seeded(c.id, 503)),
    ];
    if (ri > 0) torn.push(bandGeo(rin, ymid, 0.9 * L, y0, y1, 8, seeded(c.id, 504) * TWO_PI, 1.0 + seeded(c.id, 505)));
    addAll(det, mergedMesh(torn, dm(ctx, mixColor(base, 0x3a2e20, 0.5), 'matte'), 'frayed'));
  }
  return finish(g, det);
});

// ---------------------------------------------------------------------------------
// mass component

export const buildMass: PartBuilder<MassComponent> = scopedPart((c, tier, ctx) => {
  if (!(ok(c.x) && ok(c.length) && c.length >= 0 && ok(ctx.maxRadius) && ctx.maxRadius > 0)) return emptyGroup();
  const R = 0.6 * ctx.maxRadius;
  let y1: number;
  let y0: number;
  if (c.length === 0) {
    const h = 0.4 * ctx.maxRadius;
    y1 = -c.x + h / 2;
    y0 = -c.x - h / 2;
  } else {
    y1 = -c.x;
    y0 = -(c.x + c.length);
  }
  const h = y1 - y0;
  const ymid = (y0 + y1) / 2;
  const seg = segmentsFor(tier);
  const base = baseColor(c.color, tier === 'best' ? STEEL : tier === 'ok' ? CAST : LUMP, tier);
  const mat = partMaterial(base, ctx, { finish: tier === 'best' ? 'metal' : tier === 'ok' ? 'satin' : 'matte' });
  const g = new THREE.Group();
  const det = detailGroup();
  const rb = R * 1.012;

  if (tier === 'best') {
    // machined slug: chamfered ends, two turning grooves, a knurled band, a centre bolt
    const ch = Math.min(0.04 * R, 0.1 * h);
    const profile: Prof[] = [
      { y: y1, r: 0 },
      { y: y1, r: R - ch },
      { y: y1 - ch, r: R },
      { y: y0 + ch, r: R },
      { y: y0, r: R - ch },
      { y: y0, r: 0 },
    ];
    g.add(tag(new THREE.Mesh(revolve(profile, seg, { hard: true }), mat), 'slug'));
    const ya = y0 + ch;
    const yb = y1 - ch;
    const kn = Math.max(Math.min(0.24 * h, yb - ya), 1e-9);
    const knurl = revolve(
      [
        { y: ymid + kn / 2, r: rb },
        { y: ymid - kn / 2, r: rb },
      ],
      seg,
      { flat: true, radial: (_k, j) => (j % 2 === 0 ? 1 : 0.972) },
    );
    det.add(tag(new THREE.Mesh(knurl, dm(ctx, mixColor(base, 0xffffff, 0.18), 'metal')), 'knurl'));
    const gh = 0.02 * h;
    addAll(
      det,
      mergedMesh(
        [bandGeo(rb, ymid + kn / 2 + 0.08 * h, gh, ya, yb, seg), bandGeo(rb, ymid - kn / 2 - 0.08 * h, gh, ya, yb, seg)],
        dm(ctx, mixColor(base, 0x000000, 0.55), 'satin'),
        'grooves',
      ),
    );
    const bh = Math.min(0.1 * h, 0.3 * R);
    addAll(det, mergedMesh([cylAt(0.26 * R, bh, y1 - bh, 6)], dm(ctx, mixColor(ZINC, 0x000000, 0.25), 'metal'), 'bolt'));
  } else if (tier === 'ok') {
    // cast weight: a webbing strap with a buckle, a paper label, a printed stripe
    g.add(tag(new THREE.Mesh(revolve(sectionProfile(R, 0, y0, y1), seg, { hard: true }), mat), 'weight'));
    const sy = 0.2 * h;
    addAll(det, mergedMesh([bandGeo(rb, ymid, sy, y0, y1, seg)], dm(ctx, NOMEX_ORANGE, 'matte'), 'strap'));
    const th = seeded(c.id, 8) * TWO_PI;
    const buckle = new THREE.Mesh(
      new THREE.BoxGeometry(0.16 * R, Math.min(1.15 * sy, 0.98 * h), 0.03 * R),
      dm(ctx, ZINC, 'metal'),
    );
    buckle.position.set(0.995 * R * Math.cos(th), ymid, 0.995 * R * Math.sin(th));
    buckle.rotation.y = Math.PI / 2 - th;
    det.add(tag(buckle, 'buckle'));
    const lt = seeded(c.id, 9) * TWO_PI;
    addAll(det, mergedMesh([bandGeo(R * 1.01, y1 - 0.22 * h, 0.24 * h, y0, y1, 8, lt, 1.0)], dm(ctx, PAPER_WHITE, 'matte'), 'label'));
    addAll(det, mergedMesh([bandGeo(R * 1.012, y1 - 0.22 * h, 0.04 * h, y0, y1, 8, lt + 0.1, 0.8)], dm(ctx, 0x2a2a2a, 'matte'), 'print'));
  } else {
    // lumpy clay: poles and shoulders pulled in, every vertex nudged inward, wrapped in masking tape
    const ts = [0, 0, 0.12, 0.35, 0.6, 0.85, 1, 1];
    const rs = [0, 0.85, 1, 1, 1, 1, 0.85, 0];
    const profile: Prof[] = ts.map((t, i) => ({ y: y1 - t * h, r: R * rs[i] }));
    const mid = 3;
    const radial = (k: number, j: number) =>
      k === mid && pinned(seg, j) ? 1 : 1 - 0.28 * seeded(c.id, k * 53 + j);
    g.add(tag(new THREE.Mesh(revolve(profile, seg, { radial, flat: true }), mat), 'lump'));
    const tape: THREE.BufferGeometry[] = [];
    const widths = [0.1, 0.07, 0.09];
    for (let i = 0; i < 3; i++) {
      tape.push(bandGeo(R * 1.01, y1 - h * (0.3 + 0.2 * i + 0.04 * seeded(c.id, 700 + i)), widths[i] * h, y0, y1, seg));
    }
    for (let i = 0; i < 2; i++) {
      tape.push(bandGeo(R * 1.012, ymid, 0.55 * h, y0, y1, 8, seeded(c.id, 710 + i) * TWO_PI, 0.16));
    }
    addAll(det, mergedMesh(tape, dm(ctx, TAPE, 'matte'), 'tape'));
  }
  return finish(g, det);
});

// ---------------------------------------------------------------------------------
// packed parachute

export const buildPackedChute: PartBuilder<Parachute> = scopedPart((c, tier, ctx) => {
  if (!(ok(c.x) && ok(c.length) && c.length >= 0 && ok(ctx.maxRadius) && ctx.maxRadius > 0)) return emptyGroup();
  const R = 0.7 * ctx.maxRadius;
  const y1 = -c.x;
  let y0: number;
  if (c.length === 0) y0 = y1 - 0.6 * ctx.maxRadius;
  else y0 = -(c.x + c.length);
  const h = y1 - y0;
  const seg = segmentsFor(tier);
  const base = baseColor(c.color, PART_COLORS.chute, tier);
  const mat = partMaterial(base, ctx, { finish: 'matte' });
  const g = new THREE.Group();
  const det = detailGroup();
  const a = Math.min(0.55 * R, h / 2);
  const rAt = (y: number) => capsuleR(R, a, y1, y0, y) * 1.012;

  if (tier === 'best') {
    // z-folded bundle in a deployment bag: even flutes, straps, fold layers, mouth cord, quick link
    const profile = capsuleProfile(R, y1, y0, a, 6);
    const radial = (_k: number, j: number) => 0.94 + 0.06 * Math.cos((8 * TWO_PI * j) / seg);
    g.add(tag(new THREE.Mesh(revolve(profile, seg, { radial }), mat), 'bag'));
    const rb = R * 1.012;
    const strap = mixColor(base, 0x000000, 0.4);
    const sh = 0.05 * h;
    addAll(
      det,
      mergedMesh([bandGeo(rb, y1 - 0.22 * h, sh, y0, y1, seg), bandGeo(rb, y1 - 0.78 * h, sh, y0, y1, seg)], dm(ctx, strap, 'matte'), 'straps'),
    );
    const foldA: THREE.BufferGeometry[] = [];
    const foldB: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const yy = y1 - h * (0.34 + 0.065 * i);
      (i % 2 === 0 ? foldA : foldB).push(bandGeo(rAt(yy), yy, 0.062 * h, y0, y1, seg));
    }
    addAll(det, mergedMesh(foldA, dm(ctx, mixColor(base, 0xffffff, 0.14), 'matte'), 'foldA'));
    addAll(det, mergedMesh(foldB, dm(ctx, mixColor(base, 0x000000, 0.18), 'matte'), 'foldB'));
    const my = y1 - 0.12 * h;
    addAll(det, mergedMesh([bandGeo(rAt(my), my, 0.03 * h, y0, y1, seg)], dm(ctx, KEVLAR, 'matte'), 'mouthcord'));
    // four shroud lines lying along the fold crests between the domes
    const lines: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const lg = new THREE.CylinderGeometry(R * 1.012, R * 1.012, Math.max(h - 2 * a, 1e-9), 3, 1, true, -0.03, 0.06);
      lg.translate(0, (y0 + y1) / 2, 0);
      lg.rotateY((i * Math.PI) / 2);
      lines.push(lg);
    }
    addAll(det, mergedMesh(lines, dm(ctx, SHROUD, 'matte'), 'lines'));
    // metal quick link lying on the shoulder of the bag
    const Rq = Math.min(0.09 * R, 0.3 * a);
    const link = new THREE.TorusGeometry(Rq, 0.22 * Rq, 6, 16);
    link.scale(1, 1.6, 1);
    link.applyMatrix4(domeFrame(R, a, y1, 0.38 * a, (TWO_PI / 8) * Math.floor(seeded(c.id, 11) * 8)));
    if (fits(link, y0, y1, 1.012 * R)) addAll(det, mergedMesh([link], dm(ctx, ZINC, 'metal'), 'quicklink'));
  } else if (tier === 'ok') {
    g.add(tag(new THREE.Mesh(revolve(capsuleProfile(R, y1, y0, a, 5), seg), mat), 'bundle'));
    // white shroud-line turns round the folded canopy
    const wraps: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const yy = y1 - h * (0.38 + 0.08 * i);
      wraps.push(bandGeo(rAt(yy), yy, 0.024 * h, y0, y1, seg));
    }
    addAll(det, mergedMesh(wraps, dm(ctx, SHROUD, 'matte'), 'wraps'));
    // Nomex protector cloth under the bundle
    const hp = Math.min(0.08 * h, 0.35 * R);
    addAll(det, mergedMesh([cylAt(0.97 * R, hp, y0, seg)], dm(ctx, NOMEX_OLIVE, 'matte', false), 'nomex'));
    // coil of kevlar shock cord hugging the top of the bundle
    const coil: THREE.BufferGeometry[] = [];
    const tc = 0.03 * R;
    for (const f of [0.14, 0.3, 0.46]) {
      const yy = y1 - f * a;
      const tg = new THREE.TorusGeometry(capsuleR(R, a, y1, y0, yy) * 1.005, tc, 4, Math.min(seg, 16));
      tg.rotateX(Math.PI / 2);
      tg.translate(0, yy, 0);
      coil.push(tg);
    }
    addAll(det, mergedMesh(coil, dm(ctx, KEVLAR, 'matte'), 'shockcord'));
    // small swivel: barrel with an eye at each end, lying on the dome
    const sw: THREE.BufferGeometry[] = [];
    const barrel = new THREE.CylinderGeometry(0.04 * R, 0.04 * R, 0.2 * R, 8);
    sw.push(barrel);
    for (const s of [-1, 1]) {
      const eye = new THREE.TorusGeometry(0.05 * R, 0.014 * R, 5, 12);
      eye.translate(0, s * 0.14 * R, 0);
      sw.push(eye);
    }
    const swm = mergedMesh(sw, dm(ctx, ZINC, 'metal'), 'swivel');
    if (swm) {
      swm.geometry.rotateZ(Math.PI / 2);
      swm.geometry.applyMatrix4(domeFrame(R, a, y1, 0.6 * a, (TWO_PI / 3) + seeded(c.id, 12)));
      if (fits(swm.geometry, y0, y1, 1.012 * R)) det.add(swm);
      else swm.geometry.dispose();
    }
  } else {
    // crumpled wad: uneven rings, ragged radius, stray and tangled lines
    const ts = [0, 0, 0.1, 0.3, 0.5, 0.7, 0.9, 1, 1];
    const rs = [0, 0.7, 0.95, 1, 1, 0.97, 0.9, 0.7, 0];
    const profile: Prof[] = ts.map((t, i) => ({
      y: y1 - t * h,
      r: R * rs[i] * (i > 0 && i < ts.length - 1 && i !== 4 ? 0.8 + 0.2 * seeded(c.id, 100 + i) : 1),
    }));
    const mid = 4;
    const radial = (k: number, j: number) =>
      k === mid && pinned(seg, j) ? 1 : 1 - 0.4 * seeded(c.id, k * 61 + j);
    const geo = revolve(profile, seg, { radial });
    const pa = geo.getAttribute('position');
    const vtx = (k: number, j: number) =>
      new THREE.Vector3().fromBufferAttribute(pa, k * seg + (((j % seg) + seg) % seg));
    const strays: THREE.BufferGeometry[] = [];
    const lines = 3;
    for (let l = 0; l < lines; l++) {
      const j0 = Math.floor(seeded(c.id, 200 + l) * seg);
      for (let k = 2; k < profile.length - 3; k++) {
        strays.push(...[cylGeo(vtx(k, j0 - (k - 2) + 1), vtx(k + 1, j0 - (k - 2)), 0.008 * R)].filter((x): x is THREE.BufferGeometry => !!x));
      }
    }
    const flat = geo.toNonIndexed();
    geo.dispose();
    flat.computeVertexNormals();
    g.add(tag(new THREE.Mesh(flat, mat), 'wad'));
    const lineColor = mixColor(base, 0xffffff, 0.6);
    addAll(det, mergedMesh(strays, dm(ctx, lineColor, 'matte', false), 'strays'));
    // loose line loops thrown round the wad at odd angles
    const ymid = (y0 + y1) / 2;
    const loops: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const rl = R * (0.9 + 0.05 * seeded(c.id, 300 + i));
      const tr = 0.012 * R;
      const yoff = (seeded(c.id, 305 + i) - 0.5) * 0.3 * h;
      const room = Math.max(0, h / 2 - Math.abs(yoff) - tr - 1e-6);
      const tilt = Math.min(0.6, Math.asin(Math.min(1, room / rl))) * (0.4 + 0.6 * seeded(c.id, 310 + i)) * (i % 2 === 0 ? 1 : -1);
      const tg = new THREE.TorusGeometry(rl, tr, 4, 20);
      tg.rotateX(Math.PI / 2);
      tg.rotateZ(tilt);
      tg.rotateY(seeded(c.id, 315 + i) * TWO_PI);
      tg.translate(0, ymid + yoff, 0);
      loops.push(tg);
    }
    addAll(det, mergedMesh(loops, dm(ctx, lineColor, 'matte', false), 'tangle'));
  }
  return finish(g, det);
});

// ---------------------------------------------------------------------------------
// icons

function pseudo(i: number, seed: number): number {
  const v = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/** Wobbly polygon path, deterministic. */
function wobblyPoly(cx: number, cy: number, r: number, n: number, amp: number, seed: number): string {
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const th = (TWO_PI * i) / n;
    const rr = r * (1 - amp * pseudo(i, seed));
    pts.push(`${(cx + rr * Math.cos(th)).toFixed(1)} ${(cy + rr * Math.sin(th)).toFixed(1)}`);
  }
  return `<path d="M${pts.join('L')}Z"/>`;
}

function icon(tier: PartTier, body: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    body +
    `<circle cx="41" cy="7" r="3.5" fill="${TIER_ACCENT[tier]}" stroke="none"/></svg>`
  );
}

const SOFT = 'fill="currentColor" fill-opacity="0.15"';

function acc(tier: PartTier, extra = 'stroke-width="2"'): string {
  return `stroke="${TIER_ACCENT[tier]}" ${extra}`;
}

function tubeIcon(tier: PartTier): string {
  if (tier === 'best') {
    return icon(
      tier,
      '<rect x="5" y="17" width="32" height="16" rx="1.5"/><path d="M5 21H37M5 29H37" stroke-width="1.2"/>' +
        `<path d="M9 17V33M33 17V33" ${acc(tier, 'stroke-width="2.6"')}/>`,
    );
  }
  if (tier === 'ok') {
    return icon(tier, '<rect x="5" y="17" width="32" height="16" rx="1.5"/><path d="M5 21H37M5 29H37" stroke-width="1.2"/>');
  }
  return icon(
    tier,
    '<path d="M5 18L12 16.5L21 18L30 16L37 17.5L38 25L36 33L28 32L19 33.5L11 32L5 33.5Z"/>' +
      '<path d="M5 22L16 21L37 22.5M5 29L20 30L37 28.5" stroke-width="1.2"/>' +
      `<path d="M12 17L16 33M21 17L26 33M30 16L34 32" ${acc(tier, 'stroke-width="1.8"')}/>`,
  );
}

function centeringRingIcon(tier: PartTier): string {
  if (tier === 'best') {
    const holes = [[11, 0], [-11, 0], [0, 11], [0, -11]]
      .map(([dx, dy]) => `<circle cx="${22 + dx}" cy="${27 + dy}" r="2.2"/>`)
      .join('');
    return icon(tier, `<circle cx="22" cy="27" r="15"/><circle cx="22" cy="27" r="7"/><g ${acc(tier, 'stroke-width="1.6"')}>${holes}</g>`);
  }
  if (tier === 'ok') return icon(tier, '<circle cx="22" cy="27" r="15"/><circle cx="22" cy="27" r="7"/>');
  const blobs = [[22, 12], [36, 24], [28, 40], [9, 30]]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2" fill="${TIER_ACCENT[tier]}" stroke="none"/>`)
    .join('');
  return icon(tier, wobblyPoly(22, 27, 15, 12, 0.12, 3) + wobblyPoly(22, 27, 7, 9, 0.2, 7) + blobs);
}

function bulkheadIcon(tier: PartTier): string {
  if (tier === 'best') {
    return icon(
      tier,
      `<circle cx="22" cy="27" r="15" ${SOFT}/><g ${acc(tier, 'stroke-width="2.2"')}><circle cx="22" cy="27" r="4.5"/></g>`,
    );
  }
  if (tier === 'ok') return icon(tier, `<circle cx="22" cy="27" r="15" ${SOFT}/>`);
  return icon(
    tier,
    wobblyPoly(22, 27, 15, 12, 0.12, 5).replace('<path', `<path ${SOFT}`) +
      `<ellipse cx="26" cy="30" rx="4.5" ry="3" transform="rotate(-30 26 30)" ${acc(tier, 'stroke-width="2.2"')}/>`,
  );
}

function couplerIcon(tier: PartTier): string {
  const body = '<rect x="8" y="12" width="28" height="24" rx="1.5"/><path d="M8 18H36M8 30H36" stroke-width="1.2"/>';
  if (tier === 'best') return icon(tier, body + `<path d="M22 12V36" ${acc(tier, 'stroke-width="2"')}/>`);
  if (tier === 'ok') return icon(tier, body);
  return icon(
    tier,
    '<path d="M8 13L16 11.5L26 13L36 12L37 24L35 36L25 34.5L15 36.5L8 35Z"/><path d="M8 19L22 18L36 19.5M8 30L20 31L36 29.5" stroke-width="1.2"/>' +
      `<circle cx="9" cy="14" r="2" fill="${TIER_ACCENT[tier]}" stroke="none"/><circle cx="35" cy="35" r="2" fill="${TIER_ACCENT[tier]}" stroke="none"/>` +
      `<circle cx="22" cy="12" r="1.6" fill="${TIER_ACCENT[tier]}" stroke="none"/>`,
  );
}

function massIcon(tier: PartTier): string {
  if (tier === 'best') {
    return icon(
      tier,
      `<path d="M9 18V34A13 5 0 0 0 35 34V18" ${SOFT}/><ellipse cx="22" cy="18" rx="13" ry="5"/>` +
        `<path d="M9 25A13 5 0 0 0 35 25M9 30A13 5 0 0 0 35 30" ${acc(tier, 'stroke-width="2"')}/><path d="M16 22V35M28 22V35" stroke-width="1.2"/>`,
    );
  }
  if (tier === 'ok') {
    return icon(tier, `<path d="M9 18V34A13 5 0 0 0 35 34V18" ${SOFT}/><ellipse cx="22" cy="18" rx="13" ry="5"/>`);
  }
  return icon(
    tier,
    `<path d="M10 20Q7 26 11 31Q9 37 17 38Q25 41 32 37Q38 33 34 27Q38 21 31 16Q22 12 14 15Q9 16 10 20Z" ${SOFT}/>` +
      `<path d="M15 24Q20 22 24 27M23 33Q28 31 30 25" ${acc(tier, 'stroke-width="1.8"')}/>`,
  );
}

function chuteIcon(tier: PartTier): string {
  if (tier === 'best') {
    return icon(
      tier,
      '<rect x="14" y="8" width="20" height="34" rx="9"/><path d="M19 12V38M24 10V40M29 12V38" stroke-width="1.2"/>' +
        `<path d="M14.5 19H33.5M14.5 31H33.5" ${acc(tier, 'stroke-width="2.4"')}/><path d="M24 42V46M20 42L18 46M28 42L30 46" stroke-width="1.2"/>`,
    );
  }
  if (tier === 'ok') return icon(tier, '<rect x="14" y="8" width="20" height="34" rx="9"/>');
  return icon(
    tier,
    '<path d="M15 14Q12 8 20 8Q27 6 32 10Q37 16 33 22Q38 30 33 37Q28 44 20 41Q12 42 14 33Q10 26 15 20Z"/>' +
      `<path d="M33 24Q41 27 39 37M15 30Q6 34 8 44" ${acc(tier, 'stroke-width="1.6"')}/>`,
  );
}

const iconSet = (f: (t: PartTier) => string): PartIconSet => ({ best: f('best'), ok: f('ok'), bad: f('bad') });

export const INTERNAL_ICONS: {
  innertube: PartIconSet;
  centeringring: PartIconSet;
  bulkhead: PartIconSet;
  tubecoupler: PartIconSet;
  mass: PartIconSet;
  parachute: PartIconSet;
} = {
  innertube: iconSet(tubeIcon),
  centeringring: iconSet(centeringRingIcon),
  bulkhead: iconSet(bulkheadIcon),
  tubecoupler: iconSet(couplerIcon),
  mass: iconSet(massIcon),
  parachute: iconSet(chuteIcon),
};
