// Nose cone, transition and fin designs at three build-quality tiers.
//
// A tier changes workmanship and detail only. Every measured dimension (outline,
// radius, station, chords, span, thickness) is the component's own at every tier.
// Frame: axis +Y, nose toward +Y, origin at the nose tip, station x is y = -x.

import * as THREE from 'three';
import type { FinSet, NoseCone, Transition } from '../../types';
import { noseConeProfile, transitionProfile } from './profile';
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
  type PartIconSet,
  type PartTier,
} from './types';

type Pt = [number, number];

// ---------- small helpers ----------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function allFinite(g: THREE.BufferGeometry): boolean {
  const p = g.getAttribute('position');
  if (!p || p.count === 0) return false;
  const a = p.array as ArrayLike<number>;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

function addMesh(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, name: string): void {
  if (!allFinite(geo)) {
    // The material may be shared with other meshes of the part, so it is left alone.
    geo.dispose();
    return;
  }
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  group.add(m);
}

/** Detail material: a hair of polygon offset so thin decoration never z-fights the skin. */
function detailMat(color: number, ctx: PartContext): THREE.MeshStandardMaterial {
  return partMaterial(color, ctx, { offset: true });
}

// ---------- revolved parts (nose cone, transition) ----------

const RADIAL: Record<PartTier, number> = { best: 48, ok: 24, bad: 8 };
const PROFILE_N: Record<PartTier, number> = { best: 100, ok: 40, bad: 8 };
/** Decoration rides this much above the skin (rule: <= 1.5%, and the audit allows 0.5% on radius). */
const PROUD = 1.003;

function cleanProfile(p: Pt[]): Pt[] {
  return p.map(([s, r]) => [isNum(s) ? s : 0, isNum(r) && r > 0 ? r : 0] as Pt);
}

function interpR(prof: Pt[], s: number): number {
  if (prof.length === 0) return 0;
  if (s <= prof[0][0]) return prof[0][1];
  for (let i = 1; i < prof.length; i++) {
    if (s <= prof[i][0]) {
      const [s0, r0] = prof[i - 1];
      const [s1, r1] = prof[i];
      const d = s1 - s0;
      return d > 1e-15 ? r0 + ((r1 - r0) * (s - s0)) / d : r1;
    }
  }
  return prof[prof.length - 1][1];
}

/** The part of the profile between s0 and s1: the true nodes inside, interpolated ends. */
function subProfile(prof: Pt[], s0: number, s1: number): Pt[] {
  const out: Pt[] = [[s0, interpR(prof, s0)]];
  for (const p of prof) if (p[0] > s0 + 1e-12 && p[0] < s1 - 1e-12) out.push(p);
  out.push([s1, interpR(prof, s1)]);
  return out;
}

function lathe(prof: Pt[], x: number, seg: number, scale = 1, phiStart = 0, phiLen = Math.PI * 2) {
  // Profile runs fore to aft (y falling); Lathe wants y rising for outward normals.
  const pts = prof.map(([s, r]) => new THREE.Vector2(r * scale, -(x + s))).reverse();
  return new THREE.LatheGeometry(pts, seg, phiStart, phiLen);
}

/** Radius multiplier that keeps a thin ribbon on an n-sided faceted shell. */
function facetScale(phi: number, seg: number): number {
  const d = (2 * Math.PI) / seg;
  const local = (((phi % d) + d) % d) - d / 2;
  return Math.cos(Math.PI / seg) / Math.cos(local);
}

function ribbon(prof: Pt[], x: number, s0: number, s1: number, phi: number, hw: number, seg: number) {
  const sub = subProfile(prof, s0, s1);
  const pos: number[] = [];
  for (const [s, r] of sub) {
    for (const sign of [-1, 1]) {
      const a = phi + sign * hw;
      const rr = r * PROUD * facetScale(a, seg);
      pos.push(rr * Math.sin(a), -(x + s), rr * Math.cos(a));
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < sub.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

interface RevolvedSpec {
  id: string;
  x: number;
  length: number;
  color?: number;
}

function buildRevolved(
  c: RevolvedSpec,
  prof: Pt[],
  tier: PartTier,
  ctx: PartContext,
  baseColor: number,
  jointEnds: ('fore' | 'aft')[],
  tipCap = false,
  accentBand = false,
): THREE.Group {
  const group = new THREE.Group();
  const color = c.color ?? baseColor;
  const L = c.length;
  const seg = radialSegments(RADIAL[tier], 'outer');
  addMesh(group, lathe(prof, c.x, seg), partMaterial(color, ctx, { shell: true }), 'shell');

  if (tier === 'best') {
    // Precision finish: recoloured skin riding 0.3% proud, never a profile change.
    const w = 0.02 * L;
    const trim = mixColor(color, PART_COLORS.metal, 0.7);
    const dark = mixColor(color, 0x000000, 0.4);
    const light = mixColor(color, 0xffffff, 0.6);
    const band = (s0: number, s1: number, col: number, name: string) => {
      if (s1 - s0 > 1e-9) addMesh(group, lathe(subProfile(prof, s0, s1), c.x, seg, PROUD), detailMat(col, ctx), name);
    };
    if (tipCap) {
      // Blunted-tip look of a real ogive: a contrasting metal cap on the pointed end.
      if (prof[0][1] <= prof[prof.length - 1][1]) band(0, 0.06 * L, PART_COLORS.metal, 'tipcap');
      else band(L - 0.06 * L, L, PART_COLORS.metal, 'tipcap');
    }
    for (const end of jointEnds) {
      // Trim ring plus a fine shoulder line just inboard of it.
      if (end === 'aft') {
        band(L - w, L, trim, 'trim');
        band(L - 3.2 * w, L - 2.6 * w, dark, 'joint');
      } else {
        band(0, w, trim, 'trim');
        band(2.6 * w, 3.2 * w, dark, 'joint');
      }
    }
    if (accentBand) band(0.55 * L, 0.6 * L, light, 'band');
  } else if (tier === 'bad') {
    const d = (2 * Math.PI) / seg;
    // Bare, unpainted patches, snapped to whole facets so they sit on the shell.
    const bare = mixColor(color, PART_COLORS.bare, 0.75);
    for (let i = 0; i < 3; i++) {
      const s0 = L * (0.04 + 0.6 * seeded(c.id, i * 4));
      const s1 = Math.min(L, s0 + L * (0.1 + 0.2 * seeded(c.id, i * 4 + 1)));
      if (!(s1 - s0 > 1e-9)) continue;
      const k = Math.floor(seeded(c.id, i * 4 + 2) * seg);
      const m = 1 + Math.floor(seeded(c.id, i * 4 + 3) * 2);
      addMesh(
        group,
        lathe(subProfile(prof, s0, s1), c.x, m, PROUD, k * d, m * d),
        detailMat(bare, ctx),
        'patch',
      );
    }
    // A mis-registered seam: the two halves are off by a third of a facet.
    const kc = Math.floor(seeded(c.id, 20) * seg);
    const seamColor = mixColor(color, 0x000000, 0.5);
    const hw = 0.07 * d;
    const cut = L * (0.45 + 0.2 * seeded(c.id, 21));
    addMesh(group, ribbon(prof, c.x, 0, cut, (kc + 0.65) * d, hw, seg), detailMat(seamColor, ctx), 'seam');
    addMesh(group, ribbon(prof, c.x, cut, L, (kc + 0.3) * d, hw, seg), detailMat(seamColor, ctx), 'seam');
  }
  return group;
}

export const buildNoseCone: PartBuilder<NoseCone> = scopedPart((c, tier, ctx) => {
  if (!(isNum(c.length) && c.length > 0 && isNum(c.baseRadius) && c.baseRadius > 0 && isNum(c.x))) {
    return new THREE.Group();
  }
  const prof = cleanProfile(noseConeProfile(c, PROFILE_N[tier]));
  return buildRevolved(c, prof, tier, ctx, PART_COLORS.nose, [c.flipped ? 'fore' : 'aft'], true, true);
});

export const buildTransition: PartBuilder<Transition> = scopedPart((c, tier, ctx) => {
  if (
    !(
      isNum(c.length) && c.length > 0 && isNum(c.x) &&
      isNum(c.foreRadius) && c.foreRadius >= 0 &&
      isNum(c.aftRadius) && c.aftRadius >= 0 &&
      Math.max(c.foreRadius, c.aftRadius) > 0
    )
  ) {
    return new THREE.Group();
  }
  const prof = cleanProfile(transitionProfile(c, PROFILE_N[tier]));
  return buildRevolved(c, prof, tier, ctx, PART_COLORS.transition, ['fore', 'aft']);
});

// ---------- fins ----------

type Section = 'square' | 'rounded' | 'airfoil';

function dedupe(p: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const q of p) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - q[0]) > 1e-12 || Math.abs(last[1] - q[1]) > 1e-12) out.push(q);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= 1e-12 && Math.abs(a[1] - b[1]) <= 1e-12) out.pop();
    else break;
  }
  return out;
}

function polyArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return Math.abs(a) / 2;
}

/** Fin outline as [axial from root LE, radial from body] points, or null if unusable. */
function finPlanform(c: FinSet): Pt[] | null {
  let poly: Pt[] | null = null;
  if (
    c.finShape === 'freeform' &&
    Array.isArray(c.points) &&
    c.points.length >= 3 &&
    c.points.every((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]))
  ) {
    poly = dedupe(c.points.map((p) => [p[0], p[1]] as Pt));
  } else if (isNum(c.rootChord) && c.rootChord > 0 && isNum(c.span) && c.span > 0) {
    if (c.finShape === 'elliptical') {
      const half = c.rootChord / 2;
      const n = 48;
      poly = [];
      for (let k = 0; k <= n; k++) {
        const th = (Math.PI * k) / n;
        poly.push([half - half * Math.cos(th), c.span * Math.sin(th)]);
      }
      poly = dedupe(poly);
    } else {
      const tip = isNum(c.tipChord) && c.tipChord > 0 ? c.tipChord : 0;
      const sweep = isNum(c.sweepLength) ? c.sweepLength : 0;
      poly = dedupe([[0, 0], [sweep, c.span], [sweep + tip, c.span], [c.rootChord, 0]]);
    }
  }
  if (!poly || poly.length < 3 || !(polyArea(poly) > 1e-12)) return null;
  return poly;
}

/** Chord interval [aLE, aTE] of the outline at radial position r, or null if r misses it. */
function chordAt(poly: Pt[], r: number): Pt | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [a1, r1] = poly[i];
    const [a2, r2] = poly[(i + 1) % poly.length];
    if (r < Math.min(r1, r2) - 1e-12 || r > Math.max(r1, r2) + 1e-12) continue;
    if (Math.abs(r2 - r1) < 1e-12) {
      lo = Math.min(lo, a1, a2);
      hi = Math.max(hi, a1, a2);
    } else {
      const a = a1 + ((r - r1) / (r2 - r1)) * (a2 - a1);
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
  }
  return hi >= lo ? [lo, hi] : null;
}

/** True when each radial slice of the outline is one chord interval (a simple, loftable fin). */
function loftable(poly: Pt[], rmin: number, rmax: number): boolean {
  const n = 96;
  const dr = (rmax - rmin) / n;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const iv = chordAt(poly, rmin + (i + 0.5) * dr);
    if (!iv) return false;
    area += (iv[1] - iv[0]) * dr;
  }
  const real = polyArea(poly);
  return Math.abs(area - real) <= 0.03 * real;
}

/** Chordwise samples (u in 0..1) and half thickness h, scaled so the thickest sample is t/2. */
function sectionProfile(kind: Section, M: number, t: number, expo: number): { u: number[]; h: number[] } {
  if (kind === 'square') return { u: [0, 1], h: [t / 2, t / 2] };
  const u: number[] = [];
  const h: number[] = [];
  for (let i = 0; i <= M; i++) {
    const x = 0.5 * (1 - Math.cos((Math.PI * i) / M));
    u.push(x);
    if (kind === 'airfoil') {
      h.push(
        Math.max(0, 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4)),
      );
    } else {
      h.push(Math.pow(Math.max(0, 1 - Math.abs(2 * x - 1) ** expo), 1 / expo));
    }
  }
  const mx = Math.max(...h) || 1;
  return { u, h: h.map((v) => (v / mx) * (t / 2)) };
}

function stationList(poly: Pt[], rmin: number, rmax: number, n: number, elliptical: boolean): number[] {
  const rs: number[] = [];
  for (let j = 0; j <= n; j++) {
    const f = j / n;
    rs.push(rmin + (rmax - rmin) * (elliptical ? Math.sin((Math.PI / 2) * f) : f));
  }
  if (!elliptical && poly.length <= 16) {
    for (const [, r] of poly) rs.push(Math.min(rmax, Math.max(rmin, r)));
  }
  rs.sort((a, b) => a - b);
  const out: number[] = [];
  const eps = 1e-9 * Math.max(rmax - rmin, 1e-9);
  for (const r of rs) if (out.length === 0 || r - out[out.length - 1] > eps) out.push(r);
  return out;
}

/** Loft the planform with a chordwise section. Returns null when the outline is not loftable. */
function loftFin(
  poly: Pt[],
  rs: number[],
  sec: { u: number[]; h: number[] },
  R: number,
  x: number,
): THREE.BufferGeometry | null {
  const M = sec.u.length;
  const K = 2 * M;
  const N = rs.length;
  if (N < 2) return null;
  const pos: number[] = [];
  for (const r of rs) {
    const iv = chordAt(poly, r);
    if (!iv) return null;
    const ring = (i: number, sign: number) => {
      const a = iv[0] + sec.u[i] * (iv[1] - iv[0]);
      pos.push(R + r, -(x + a), sign * sec.h[i]);
    };
    for (let i = 0; i < M; i++) ring(i, 1);
    for (let i = M - 1; i >= 0; i--) ring(i, -1);
  }
  const idx: number[] = [];
  for (let j = 0; j < N - 1; j++) {
    for (let k = 0; k < K; k++) {
      const a = j * K + k;
      const b = j * K + ((k + 1) % K);
      const c2 = (j + 1) * K + k;
      const d = (j + 1) * K + ((k + 1) % K);
      idx.push(a, b, c2, b, d, c2);
    }
  }
  // End caps: a fan around each end ring's centre.
  for (const j of [0, N - 1]) {
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < K; k++) {
      cx += pos[(j * K + k) * 3];
      cy += pos[(j * K + k) * 3 + 1];
    }
    const centre = pos.length / 3;
    pos.push(cx / K, cy / K, 0);
    for (let k = 0; k < K; k++) idx.push(centre, j * K + k, j * K + ((k + 1) % K));
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  if (sec.u.length === 2) g = g.toNonIndexed(); // crisp flat faces for a square slab
  g.computeVertexNormals();
  return g;
}

/** Last resort for odd outlines: a flat slab extruded from the polygon. */
function slabFin(poly: Pt[], R: number, x: number, t: number): THREE.BufferGeometry | null {
  try {
    const shape = new THREE.Shape(poly.map(([a, r]) => new THREE.Vector2(a, r)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, steps: 1 });
    g.translate(0, 0, -t / 2);
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1),
    );
    m.setPosition(R, -x, 0);
    g.applyMatrix4(m);
    return g;
  } catch {
    return null;
  }
}

/** Concave root fillet along the root chord, one per fin face. */
function filletGeometry(R: number, x: number, t: number, f: number, a0: number, a1: number, sign: number) {
  const prof: Pt[] = [[R - f, t / 2], [R - f, t / 2 + f], [R, t / 2 + f]];
  const S = 6;
  for (let k = 1; k <= S; k++) {
    const th = (Math.PI / 2) * (k / S);
    prof.push([R + f - f * Math.cos(th), t / 2 + f - f * Math.sin(th)]);
  }
  const shape = new THREE.Shape(prof.map(([px, pz]) => new THREE.Vector2(px, pz)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: a1 - a0, bevelEnabled: false, steps: 1 });
  // shape x -> X, shape y -> Z, extrude depth -> Y (falling aft from the root LE).
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, sign),
    new THREE.Vector3(0, -1, 0),
  );
  m.setPosition(0, -(x + a0), 0);
  g.applyMatrix4(m);
  return g;
}

function pointInPoly(poly: Pt[], a: number, r: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ai, ri] = poly[i];
    const [aj, rj] = poly[j];
    if (ri > r !== rj > r && a < ((aj - ai) * (r - ri)) / (rj - ri) + ai) inside = !inside;
  }
  return inside;
}

/**
 * ONE fin only, lying in the +X half of the XY plane: root leading edge at
 * (bodyRadius, -c.x), chord running toward -Y, span toward +X, thickness along Z, cant
 * applied. The caller clones it `count` times around the axis.
 */
export const buildFin: PartBuilder<FinSet> = scopedPart((c, tier, ctx) => {
  const group = new THREE.Group();
  if (
    !(
      isNum(c.x) && isNum(c.bodyRadius) && c.bodyRadius > 0 &&
      isNum(c.thickness) && c.thickness > 0 &&
      isNum(c.count) && c.count >= 1
    )
  ) {
    return group;
  }
  const poly = finPlanform(c);
  if (!poly) return group;

  const R = c.bodyRadius;
  const t = c.thickness;
  const x = c.x;
  const color = c.color ?? PART_COLORS.fin;
  let rmin = Infinity;
  let rmax = -Infinity;
  for (const [, r] of poly) {
    rmin = Math.min(rmin, r);
    rmax = Math.max(rmax, r);
  }
  const elliptical = c.finShape === 'elliptical' && !(c.finShape === 'elliptical' && poly.length < 8);

  // What edge finish this fin can have: the data's cross-section caps the tier.
  const cs = c.crossSection;
  let kind: Section;
  let M = 14;
  let expo = 6;
  if (tier === 'bad') {
    kind = 'square';
  } else if (cs === 'square') {
    kind = tier === 'best' ? 'square' : 'rounded';
    if (tier === 'ok') {
      M = 10;
      expo = 12; // a barely broken edge
    }
  } else if (tier === 'best') {
    kind = cs === 'rounded' ? 'rounded' : 'airfoil';
    M = 16;
  } else {
    kind = 'rounded';
    M = 10;
  }
  const sec = sectionProfile(kind, M, t, expo);
  const nSt = tier === 'best' ? 24 : tier === 'ok' ? 12 : 4;

  let geo: THREE.BufferGeometry | null = null;
  if (rmax - rmin > 1e-12 && loftable(poly, rmin, rmax)) {
    geo = loftFin(poly, stationList(poly, rmin, rmax, nSt, elliptical), sec, R, x);
  }
  if (!geo || !allFinite(geo)) geo = slabFin(poly, R, x, t);
  if (!geo) return group;

  // Root interval, where fillets and glue sit.
  const root = chordAt(poly, 0);
  const rootOk = !!root && rmin <= 1e-9 && root[1] - root[0] > 1e-9;

  const extras: { name: string; geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];

  if (tier === 'best' && rootOk && root) {
    const want = isNum(c.filletRadius) && c.filletRadius > 0 ? c.filletRadius : 0.01 * R;
    const f = Math.min(want, 0.015 * R);
    const fc = mixColor(color, 0xffffff, 0.04);
    for (const sign of [1, -1]) {
      extras.push({
        name: 'fillet',
        geo: filletGeometry(R, x, t, f, root[0], root[1], sign),
        mat: detailMat(fc, ctx),
      });
    }
  }

  if (tier === 'bad') {
    const bareMix = mixColor(color, PART_COLORS.bare, 0.7);
    if (rootOk && root) {
      const cap = 0.015 * R;
      // Uneven glue blobs along the root, alternating faces.
      for (let i = 0; i < 6; i++) {
        const b = cap * (0.35 + 0.65 * seeded(c.id, i * 3));
        const reach = 2.5 * b;
        if (root[1] - root[0] < 2 * reach) continue;
        const a = root[0] + reach + (root[1] - root[0] - 2 * reach) * seeded(c.id, i * 3 + 1);
        const side = seeded(c.id, i * 3 + 2) < 0.5 ? -1 : 1;
        const g = new THREE.SphereGeometry(1, 6, 4);
        g.applyMatrix4(
          new THREE.Matrix4().makeScale(b, reach, b).setPosition(R + b * 0.3, -(x + a), side * (t / 2)),
        );
        extras.push({ name: 'glue', geo: g, mat: detailMat(PART_COLORS.glue, ctx) });
      }
    }
    // Balsa-style wood grain: pale streaks running along the span on both faces.
    {
      const aLo = Math.min(...poly.map((p) => p[0]));
      const aHi = Math.max(...poly.map((p) => p[0]));
      const gh = 0.006 * R;
      const grain = mixColor(color, PART_COLORS.bare, 0.45);
      for (let i = 0; i < 5; i++) {
        const a = aLo + (aHi - aLo) * (0.12 + 0.76 * seeded(c.id, 100 + i));
        let r0 = Infinity;
        let r1 = -Infinity;
        for (let k = 0; k <= 24; k++) {
          const r = rmin + ((rmax - rmin) * k) / 24;
          if (pointInPoly(poly, a, r) && pointInPoly(poly, a + 0.0006, r) && pointInPoly(poly, a - 0.0006, r)) {
            r0 = Math.min(r0, r);
            r1 = Math.max(r1, r);
          }
        }
        if (!(r1 - r0 > 0.2 * (rmax - rmin))) continue;
        for (const side of [1, -1]) {
          const g = new THREE.BoxGeometry(r1 - r0, 0.0012, gh);
          g.translate(R + (r0 + r1) / 2, -(x + a), side * (t / 2 + gh / 2));
          extras.push({ name: 'grain', geo: g, mat: detailMat(grain, ctx) });
        }
      }
    }
    // Unpainted patches lying on the faces (kept wholly inside the planform).
    const h = 0.008 * R;
    for (let i = 0; i < 3; i++) {
      const da = (rmax - rmin) * 0.25 + 0.0001;
      const dr = (rmax - rmin) * 0.2 + 0.0001;
      const aMin = Math.min(...poly.map((p) => p[0]));
      const aMax = Math.max(...poly.map((p) => p[0]));
      for (let tries = 0; tries < 8; tries++) {
        const a = aMin + (aMax - aMin) * seeded(c.id, 40 + i * 20 + tries * 2);
        const r = rmin + (rmax - rmin) * seeded(c.id, 41 + i * 20 + tries * 2);
        const corners: Pt[] = [[a - da / 2, r - dr / 2], [a + da / 2, r - dr / 2], [a - da / 2, r + dr / 2], [a + da / 2, r + dr / 2]];
        if (!corners.every(([pa, pr]) => pointInPoly(poly, pa, pr))) continue;
        const side = i % 2 === 0 ? 1 : -1;
        const g = new THREE.BoxGeometry(dr, da, h);
        g.translate(R + r, -(x + a), side * (t / 2 + h / 2));
        extras.push({ name: 'patch', geo: g, mat: detailMat(bareMix, ctx) });
        break;
      }
    }
  }

  // Cant about the radial axis through the middle of the root chord.
  const canted = isNum(c.cant) && c.cant !== 0;
  let pivotY = -(x + (isNum(c.rootChord) && c.rootChord > 0 ? c.rootChord / 2 : 0));
  if (root && !(isNum(c.rootChord) && c.rootChord > 0)) pivotY = -(x + (root[0] + root[1]) / 2);
  const cantM = new THREE.Matrix4()
    .makeTranslation(R, pivotY, 0)
    .multiply(new THREE.Matrix4().makeRotationX(canted ? c.cant : 0))
    .multiply(new THREE.Matrix4().makeTranslation(-R, -pivotY, 0));

  const finMat = partMaterial(color, ctx);
  if (canted) geo.applyMatrix4(cantM);
  addMesh(group, geo, finMat, 'fin');
  for (const e of extras) {
    if (canted) e.geo.applyMatrix4(cantM);
    addMesh(group, e.geo, e.mat, e.name);
  }
  return group;
});

// ---------- icons ----------

function svg(tier: PartTier, body: string): string {
  const A = TIER_ACCENT[tier];
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linejoin="round" stroke-linecap="round">' +
    body +
    `<circle cx="41" cy="7" r="3.5" fill="${A}" stroke="none"/></svg>`
  );
}

const A = TIER_ACCENT;

const NOSE_SMOOTH = 'M24 4C29 11 33 22 33 42H15C15 22 19 11 24 4Z';
const TRANS_SMOOTH = 'M18 6H30C30 20 38 28 38 42H10C10 28 18 20 18 6Z';
const FIN_SWEPT = 'M14 12L38 30V40L14 43Z';

export const AERO_ICONS: { nosecone: PartIconSet; transition: PartIconSet; finset: PartIconSet } = {
  nosecone: {
    best: svg(
      'best',
      `<path d="${NOSE_SMOOTH}" stroke="currentColor" fill="${A.best}" fill-opacity="0.15"/>` +
        `<path d="M23 8.5H25M15.4 38H32.6" stroke="currentColor" stroke-width="2.4"/>` +
        `<path d="M15.4 34.5H32.6M18.6 22H29.4" stroke="${A.best}" stroke-width="1.8"/>`,
    ),
    ok: svg('ok', `<path d="${NOSE_SMOOTH}" stroke="currentColor" fill="${A.ok}" fill-opacity="0.25"/>`),
    bad: svg(
      'bad',
      `<path d="M24 4L27.5 12L30 21L32.5 31L33 42L15 41L15.5 31L18 20L21 11Z" stroke="currentColor" fill="${A.bad}" fill-opacity="0.18"/>` +
        `<path d="M22.5 11L25 23L21.5 31L26 41" stroke="${A.bad}" stroke-width="1.8"/>` +
        `<ellipse cx="28.5" cy="29" rx="2.6" ry="1.8" fill="${A.bad}" stroke="none"/>`,
    ),
  },
  transition: {
    best: svg(
      'best',
      `<path d="${TRANS_SMOOTH}" stroke="currentColor" fill="${A.best}" fill-opacity="0.15"/>` +
        `<path d="M18.2 9.5H29.8M10.6 39H37.4" stroke="currentColor" stroke-width="2.2"/>` +
        `<path d="M18.2 13H29.8M10.6 35.5H37.4" stroke="${A.best}" stroke-width="1.8"/>`,
    ),
    ok: svg('ok', `<path d="${TRANS_SMOOTH}" stroke="currentColor" fill="${A.ok}" fill-opacity="0.25"/>`),
    bad: svg(
      'bad',
      `<path d="M18 6L30 7.5L31 20L37 29L39 42L10 40.5L11.5 29L17 20Z" stroke="currentColor" fill="${A.bad}" fill-opacity="0.18"/>` +
        `<path d="M22 8L25 22L20 33L25 41" stroke="${A.bad}" stroke-width="1.8"/>` +
        `<ellipse cx="31" cy="33" rx="2.6" ry="1.8" fill="${A.bad}" stroke="none"/>`,
    ),
  },
  finset: {
    best: svg(
      'best',
      `<path d="M6 4V44M14 4V44" stroke="currentColor" stroke-opacity="0.45"/>` +
        `<path d="${FIN_SWEPT}" stroke="currentColor" fill="${A.best}" fill-opacity="0.15"/>` +
        `<path d="M17 21L35 33.5" stroke="${A.best}" stroke-width="1.6"/>` +
        `<path d="M14 17C17 17.5 17.5 19 17.6 22M14 40C17 40 17.6 38.5 17.6 35" stroke="${A.best}" stroke-width="2"/>`,
    ),
    ok: svg(
      'ok',
      `<path d="M6 4V44M14 4V44" stroke="currentColor" stroke-opacity="0.45"/>` +
        `<path d="M14 12L37 29Q39 30.5 39 33V39Q39 41 37 41.2L14 43Z" stroke="currentColor" fill="${A.ok}" fill-opacity="0.25"/>`,
    ),
    bad: svg(
      'bad',
      `<path d="M6 4V44M14 4V44" stroke="currentColor" stroke-opacity="0.45"/>` +
        `<path d="M14 12L39 27L41 40L14 44Z" stroke="currentColor" fill="${A.bad}" fill-opacity="0.18"/>` +
        `<path d="M20 20L31 27.5M22 27L33 34M24 34L36 38" stroke="${A.bad}" stroke-width="1" stroke-opacity="0.7"/>` +
        `<circle cx="17.5" cy="19" r="2.2" fill="${A.bad}" stroke="none"/>` +
        `<circle cx="18" cy="31" r="1.7" fill="${A.bad}" stroke="none"/>` +
        `<circle cx="17" cy="39.5" r="2.6" fill="${A.bad}" stroke="none"/>`,
    ),
  },
};
