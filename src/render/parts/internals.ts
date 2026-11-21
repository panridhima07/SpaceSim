// Inner parts seen in cutaway view: inner / motor-mount tube, rings (centering ring,
// bulkhead, tube coupler, engine block, shoulder), mass component, packed parachute.
//
// A tier changes workmanship and detail only, never a measured dimension. The main
// meshes carry the true size; decoration goes under a child group tagged
// `userData.detail = true`, stays inside the part's axial extent and stands proud of
// the surface by at most ~1.5% of the local radius.

import * as THREE from 'three';
import type { InnerTube, MassComponent, Parachute, Ring } from '../../types';
import {
  PART_COLORS,
  TIER_ACCENT,
  mixColor,
  partMaterial,
  seeded,
  type PartBuilder,
  type PartContext,
  type PartIconSet,
  type PartTier,
} from './types';

// ---------------------------------------------------------------------------------
// helpers

const SEGMENTS: Record<PartTier, number> = { best: 64, ok: 32, bad: 12 };
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

/** An open band around the axis, kept inside [y0, y1]. */
function bandMesh(r: number, yc: number, h: number, y0: number, y1: number, seg: number, color: number, ctx: PartContext): THREE.Mesh {
  const hh = Math.max(Math.min(h, y1 - y0), 1e-9);
  const yy = Math.min(Math.max(yc, y0 + hh / 2), y1 - hh / 2);
  const g = new THREE.CylinderGeometry(r, r, hh, seg, 1, true);
  g.translate(0, yy, 0);
  return new THREE.Mesh(g, partMaterial(color, ctx));
}

/** Thin cylinder between two points. */
function cylBetween(a: THREE.Vector3, b: THREE.Vector3, rad: number, color: number, ctx: PartContext): THREE.Mesh | null {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (!(len > 1e-12)) return null;
  const g = new THREE.CylinderGeometry(rad, rad, len, 4, 1);
  const m = new THREE.Mesh(g, partMaterial(color, ctx));
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
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

// ---------------------------------------------------------------------------------
// inner tube / motor-mount tube

/** Spiral paper seam: a thin ribbon on the outside surface. */
function helixRibbon(r: number, y1: number, y0: number, turns: number, hw: number, start: number): THREE.BufferGeometry {
  const N = Math.max(8, Math.min(600, Math.ceil(turns * 20)));
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

export const buildInnerTube: PartBuilder<InnerTube> = (c, tier, ctx) => {
  const ro = c.outerRadius;
  const L = c.length;
  if (!(ok(c.x) && ok(L) && L > 0 && ok(ro) && ro > 0)) return emptyGroup();
  const y1 = -c.x;
  const y0 = -(c.x + L);
  const t = ok(c.thickness) && c.thickness > 0 ? c.thickness : 0;
  const solid = t >= ro;
  const ri = t > 0 && t < ro ? ro - t : 0;
  const seg = SEGMENTS[tier];
  const base = baseColor(c.color, PART_COLORS.tube, tier);

  let profile: Prof[];
  if (ri > 0) profile = sectionProfile(ro, ri, y0, y1);
  else if (solid) profile = sectionProfile(ro, 0, y0, y1);
  else profile = [{ y: y1, r: ro }, { y: y0, r: ro }];

  const g = new THREE.Group();
  const geo = revolve(profile, seg, { hard: true, flat: tier === 'bad' });
  g.add(new THREE.Mesh(geo, partMaterial(base, ctx)));

  const det = detailGroup();
  const rb = ro * 1.012;
  if (tier === 'best') {
    const bandColor = mixColor(base, PART_COLORS.motor, c.isMotorMount ? 0.5 : 0.3);
    const h = Math.min(0.05 * L, 0.3 * ro);
    addAll(
      det,
      bandMesh(rb, y1 - h / 2, h, y0, y1, seg, bandColor, ctx),
      bandMesh(rb, y0 + h / 2, h, y0, y1, seg, bandColor, ctx),
    );
  } else if (tier === 'bad') {
    const patchColor = mixColor(base, PART_COLORS.bare, 0.8);
    const turns = Math.max(1, Math.min(30, L / (ro * 5)));
    const hw = Math.min(0.05 * ro, 0.02 * L);
    det.add(new THREE.Mesh(helixRibbon(ro * 1.008, y1, y0, turns, hw, seeded(c.id, 0) * TWO_PI), partMaterial(patchColor, ctx)));
    const patches = 3 + Math.floor(seeded(c.id, 1) * 3);
    for (let i = 0; i < patches; i++) {
      const h = L * (0.08 + 0.2 * seeded(c.id, 10 + i));
      const hh = Math.min(h, L);
      const yc = y0 + hh / 2 + (L - hh) * seeded(c.id, 20 + i);
      const th0 = seeded(c.id, 30 + i) * TWO_PI;
      const len = 0.6 + seeded(c.id, 40 + i) * 1.2;
      const cg = new THREE.CylinderGeometry(ro * 1.006, ro * 1.006, hh, 8, 1, true, th0, len);
      cg.translate(0, yc, 0);
      det.add(new THREE.Mesh(cg, partMaterial(patchColor, ctx)));
    }
  }
  return finish(g, det);
};

// ---------------------------------------------------------------------------------
// rings

type RingKind = 'centeringring' | 'bulkhead' | 'tubecoupler' | 'engineblock' | 'shoulder' | 'other';

function ringKind(c: Ring, ri: number): RingKind {
  const t = c.ringType;
  if (t === 'centeringring' || t === 'bulkhead' || t === 'tubecoupler' || t === 'engineblock' || t === 'shoulder') return t;
  if (t === undefined || t === null) return ri > 0 ? 'centeringring' : 'bulkhead';
  return 'other';
}

/** Eye-bolt lying in the pocket of a bulkhead; wholly inside the part's axial extent. */
function eyeBolt(c: Ring, tier: PartTier, y1: number, d: number, ro: number, pr: number, ctx: PartContext): THREE.Mesh {
  const tr = Math.min(0.04 * ro, 0.2 * d);
  const Re = Math.min(0.13 * ro, pr * 0.6);
  let tilt = 0;
  let ox = 0;
  let oz = 0;
  if (tier === 'bad') {
    const a = seeded(c.id, 1) * TWO_PI;
    ox = 0.07 * ro * Math.cos(a);
    oz = 0.07 * ro * Math.sin(a);
    tilt = Math.min(0.3 + 0.2 * seeded(c.id, 2), Math.asin(Math.min(1, (0.25 * d) / Re)));
  }
  const lift = Re * Math.sin(tilt);
  const cy = y1 - d + tr + lift + 0.02 * d;
  const geo = new THREE.TorusGeometry(Re, tr, 8, 20);
  geo.rotateX(Math.PI / 2);
  const color = tier === 'bad' ? mixColor(PART_COLORS.metal, PART_COLORS.bare, 0.4) : PART_COLORS.metal;
  const m = new THREE.Mesh(geo, partMaterial(color, ctx));
  m.position.set(ox, cy, oz);
  m.rotation.z = tilt;
  return m;
}

export const buildRing: PartBuilder<Ring> = (c, tier, ctx) => {
  const ro = c.outerRadius;
  const L = c.length;
  if (!(ok(c.x) && ok(L) && L > 0 && ok(ro) && ro > 0 && ok(c.innerRadius))) return emptyGroup();
  const ri = c.innerRadius > 0 ? c.innerRadius : 0;
  if (ri >= ro) return emptyGroup();
  const y1 = -c.x;
  const y0 = -(c.x + L);
  const ymid = (y0 + y1) / 2;
  const seg = SEGMENTS[tier];
  const base = baseColor(c.color, PART_COLORS.ring, tier);
  const mat = partMaterial(base, ctx);
  const kind = ringKind(c, ri);
  const g = new THREE.Group();
  const det = detailGroup();
  const dark = mixColor(base, 0x000000, 0.45);

  // bulkhead: solid disc (best / bad get a pocket on the fore face holding the eye-bolt)
  const pocketed = kind === 'bulkhead' && ri <= 0 && tier !== 'ok';
  const d = 0.5 * L;
  const pr = (tier === 'bad' ? 0.3 : 0.22) * ro;

  if (tier === 'best' && !pocketed && ri > 0) {
    const w = ro - ri;
    const holes: THREE.Vector2[][] = [];
    if (kind === 'centeringring' && w > 0.3 * ro) {
      const hr = 0.26 * w;
      const rc = (ro + ri) / 2;
      const n = Math.max(3, Math.min(8, Math.floor(Math.PI / Math.asin(Math.min(0.99, (1.5 * hr) / rc)))));
      for (let i = 0; i < n; i++) {
        const th = (TWO_PI * i) / n + Math.PI / n;
        holes.push(circlePts(hr, 16, rc * Math.cos(th), rc * Math.sin(th)));
      }
    }
    const outer = circlePts(ro, seg);
    const inner = circlePts(ri, seg);
    g.add(new THREE.Mesh(capGeo(outer, [inner, ...holes], [y1, y0]), mat));
    g.add(new THREE.Mesh(wallGeo([outer, inner, ...holes], y0, y1), mat));
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
    g.add(new THREE.Mesh(revolve(profile, seg, { hard: true, radial, flat: bad }), mat));
  }

  if (pocketed) det.add(eyeBolt(c, tier, y1, d, ro, pr, ctx));

  const rb = ro * 1.01;
  if (tier === 'best') {
    if (kind === 'centeringring' && L > 0) {
      // plywood laminate: two dark ply lines on the rim
      const ply = mixColor(base, 0x5a3d20, 0.5);
      const ph = Math.min(0.04 * ro, 0.08 * L);
      addAll(det, bandMesh(rb, y1 - L / 3, ph, y0, y1, seg, ply, ctx), bandMesh(rb, y1 - (2 * L) / 3, ph, y0, y1, seg, ply, ctx));
    } else if (kind === 'tubecoupler') {
      det.add(bandMesh(rb, ymid, Math.min(0.06 * ro, 0.1 * L), y0, y1, seg, dark, ctx));
    } else if (kind === 'shoulder') {
      det.add(bandMesh(rb, y1 - 0.2 * L, Math.min(0.06 * ro, 0.1 * L), y0, y1, seg, dark, ctx));
    } else if (kind === 'engineblock') {
      det.add(bandMesh(rb, ymid, 0.8 * L, y0, y1, seg, mixColor(base, PART_COLORS.metal, 0.6), ctx));
      // thrust-ring edge: a bright steel line at the aft end
      det.add(bandMesh(rb, y0 + 0.07 * L, 0.1 * L, y0, y1, seg, PART_COLORS.metal, ctx));
    }
  } else if (tier === 'bad') {
    // glue fillets left as blobs on the rim
    const sr = Math.min(0.0125 * ro, L * 0.49);
    const n = 5 + Math.floor(seeded(c.id, 3) * 4);
    const glue = mixColor(PART_COLORS.glue, base, 0.2);
    for (let i = 0; i < n; i++) {
      const th = seeded(c.id, 50 + i) * TWO_PI;
      const yy = Math.min(Math.max(y0 + sr + (L - 2 * sr) * seeded(c.id, 70 + i), y0 + sr), y1 - sr);
      const sg = new THREE.SphereGeometry(sr, 6, 4);
      const m = new THREE.Mesh(sg, partMaterial(glue, ctx));
      m.position.set(ro * Math.cos(th), yy, ro * Math.sin(th));
      det.add(m);
    }
  }
  return finish(g, det);
};

// ---------------------------------------------------------------------------------
// mass component

export const buildMass: PartBuilder<MassComponent> = (c, tier, ctx) => {
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
  const seg = SEGMENTS[tier];
  const base = baseColor(c.color, PART_COLORS.mass, tier);
  const mat = partMaterial(base, ctx);
  const g = new THREE.Group();
  const det = detailGroup();

  if (tier === 'best') {
    const ch = Math.min(0.04 * R, 0.1 * h);
    const profile: Prof[] = [
      { y: y1, r: 0 },
      { y: y1, r: R - ch },
      { y: y1 - ch, r: R },
      { y: y0 + ch, r: R },
      { y: y0, r: R - ch },
      { y: y0, r: 0 },
    ];
    g.add(new THREE.Mesh(revolve(profile, seg, { hard: true }), mat));
    // payload / altimeter-sled look: brass retaining band plus four axial guide rails
    det.add(bandMesh(R * 1.012, (y0 + y1) / 2, Math.max(0.2 * h, 1e-9), y0 + ch, y1 - ch, seg, mixColor(base, 0xc9962b, 0.75), ctx));
    const rh = Math.max(h - 2 * ch, 1e-9);
    for (let i = 0; i < 4; i++) {
      const rg = new THREE.CylinderGeometry(R * 1.012, R * 1.012, rh, 3, 1, true, (i * Math.PI) / 2 - 0.05, 0.1);
      rg.translate(0, (y0 + y1) / 2, 0);
      det.add(new THREE.Mesh(rg, partMaterial(mixColor(base, PART_COLORS.metal, 0.6), ctx)));
    }
  } else if (tier === 'ok') {
    g.add(new THREE.Mesh(revolve(sectionProfile(R, 0, y0, y1), seg, { hard: true }), mat));
  } else {
    // lumpy clay: poles and shoulders pulled in, every vertex nudged inward
    const ts = [0, 0, 0.12, 0.35, 0.6, 0.85, 1, 1];
    const rs = [0, 0.85, 1, 1, 1, 1, 0.85, 0];
    const profile: Prof[] = ts.map((t, i) => ({ y: y1 - t * h, r: R * rs[i] }));
    const mid = 3;
    const radial = (k: number, j: number) =>
      k === mid && pinned(seg, j) ? 1 : 1 - 0.28 * seeded(c.id, k * 53 + j);
    g.add(new THREE.Mesh(revolve(profile, seg, { radial, flat: true }), mat));
  }
  return finish(g, det);
};

// ---------------------------------------------------------------------------------
// packed parachute

export const buildPackedChute: PartBuilder<Parachute> = (c, tier, ctx) => {
  if (!(ok(c.x) && ok(c.length) && c.length >= 0 && ok(ctx.maxRadius) && ctx.maxRadius > 0)) return emptyGroup();
  const R = 0.7 * ctx.maxRadius;
  const y1 = -c.x;
  let y0: number;
  if (c.length === 0) y0 = y1 - 0.6 * ctx.maxRadius;
  else y0 = -(c.x + c.length);
  const h = y1 - y0;
  const seg = SEGMENTS[tier];
  const base = baseColor(c.color, PART_COLORS.chute, tier);
  const mat = partMaterial(base, ctx);
  const g = new THREE.Group();
  const det = detailGroup();
  const a = Math.min(0.55 * R, h / 2);

  if (tier === 'best') {
    // even folds: eight flutes around the bundle, three straps, a tidy wrap
    const profile = capsuleProfile(R, y1, y0, a, 6);
    const radial = (_k: number, j: number) => 0.94 + 0.06 * Math.cos((8 * TWO_PI * j) / seg);
    g.add(new THREE.Mesh(revolve(profile, seg, { radial }), mat));
    const rb = R * 1.012;
    const strap = mixColor(base, 0x000000, 0.4);
    const wrap = mixColor(base, 0xffffff, 0.55);
    const sh = 0.05 * h;
    addAll(
      det,
      bandMesh(rb, y1 - 0.22 * h, sh, y0, y1, seg, strap, ctx),
      bandMesh(rb, y1 - 0.78 * h, sh, y0, y1, seg, strap, ctx),
      bandMesh(rb, y1 - 0.5 * h, 0.26 * h, y0, y1, seg, wrap, ctx),
    );
    // four shroud lines lying along the fold crests between the domes
    const lineColor = mixColor(base, 0xffffff, 0.7);
    for (let i = 0; i < 4; i++) {
      const lg = new THREE.CylinderGeometry(R * 1.012, R * 1.012, Math.max(h - 2 * a, 1e-9), 3, 1, true, (i * Math.PI) / 2 - 0.03, 0.06);
      lg.translate(0, (y0 + y1) / 2, 0);
      det.add(new THREE.Mesh(lg, partMaterial(lineColor, ctx)));
    }
  } else if (tier === 'ok') {
    g.add(new THREE.Mesh(revolve(capsuleProfile(R, y1, y0, a, 5), seg), mat));
  } else {
    // crumpled wad: uneven rings, ragged radius, stray lines along the surface
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
    const lineColor = mixColor(base, 0xffffff, 0.6);
    const lines = 3;
    for (let l = 0; l < lines; l++) {
      const j0 = Math.floor(seeded(c.id, 200 + l) * seg);
      for (let k = 2; k < profile.length - 3; k++) {
        const m = cylBetween(vtx(k, j0 - (k - 2) + 1), vtx(k + 1, j0 - (k - 2)), 0.008 * R, lineColor, ctx);
        if (m) det.add(m);
      }
    }
    const flat = geo.toNonIndexed();
    geo.dispose();
    flat.computeVertexNormals();
    g.add(new THREE.Mesh(flat, mat));
  }
  return finish(g, det);
};

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
