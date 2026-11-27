// Contract every part design follows.
//
// A part design draws ONE component at one of three build-quality tiers. The tier
// changes workmanship and detail only. It never changes a measured dimension: the
// length, radii, chords, span and station of the drawn part are the component's own.
//
// FRAME (same as rocketMesh.ts): rocket axis along +Y, nose toward +Y, origin at the
// nose tip. Station x (metres aft of the tip) is local y = -x, so a component occupies
// y in [-(x + length), -x]. Units are metres, never rescaled.

import * as THREE from 'three';

/** Build quality of one component: precision-made, ordinary kit, or crude. */
export type PartTier = 'best' | 'ok' | 'bad';

export const PART_TIERS: readonly PartTier[] = ['best', 'ok', 'bad'];

export interface PartContext {
  /** True in cutaway view: outer shells must be see-through. */
  cutaway: boolean;
  /** Largest body radius of the whole rocket, metres. */
  maxRadius: number;
  /** Nose tip to aft end of the whole rocket, metres. */
  rocketLength: number;
}

/**
 * Draws one component. Returns a Mesh or a Group of meshes in the rocket frame.
 * The caller names the meshes, tags them with the component and disposes them.
 */
export type PartBuilder<C> = (c: C, tier: PartTier, ctx: PartContext) => THREE.Object3D;

/** A 2D icon per tier: a complete `<svg viewBox="0 0 48 48">…</svg>` string. */
export type PartIconSet = Record<PartTier, string>;

/** Accent colour that marks the tier in icons. */
export const TIER_ACCENT: Record<PartTier, string> = {
  best: '#3ddc97',
  ok: '#f2b84b',
  bad: '#ef5350',
};

export const PART_COLORS = {
  nose: 0xe2552f,
  tube: 0xf2f1ec,
  decoupler: 0xd9a426,
  fin: 0x2b3440,
  transition: 0x8a9099,
  ring: 0xc9c5b8,
  mass: 0x1d1f24,
  chute: 0xf0622a,
  metal: 0x9aa3ad,
  motor: 0x3a3d44,
  nozzle: 0x23252a,
  glue: 0xd8c68a,
  bare: 0xb99a6b,
} as const;

const CUTAWAY_OPACITY = 0.25;

/**
 * How a surface catches the light. Pick the one the real material has:
 * `matte`  bare paper and cardboard, raw wood, fabric, cork, soot, rough casting;
 * `satin`  primer, sanded and sealed wood, phenolic, ordinary moulded plastic, epoxy;
 * `gloss`  paint under clear coat, polished plastic, vinyl decal, mylar film, glass;
 * `metal`  machined or anodised aluminium, steel, brass, lead.
 */
export type PartFinish = 'matte' | 'satin' | 'gloss' | 'metal';

/**
 * What each finish means to the two renderers. `roughness` / `metalness` are for the
 * standard material (model export, part gallery before the flat pass); `shininess` and
 * `specular` (a grey level 0..1, mixed toward the surface colour for metal) are what the
 * app's flat pass draws. Metalness stays low: no scene has an environment map, and a
 * true metal would render black.
 */
export const FINISH_LOOK: Record<PartFinish, { roughness: number; metalness: number; shininess: number; specular: number }> = {
  matte: { roughness: 0.92, metalness: 0, shininess: 0, specular: 0 },
  satin: { roughness: 0.58, metalness: 0.02, shininess: 22, specular: 0.14 },
  gloss: { roughness: 0.24, metalness: 0.04, shininess: 80, specular: 0.38 },
  metal: { roughness: 0.3, metalness: 0.3, shininess: 120, specular: 0.62 },
};

// ---------------------------------------------------------------------------------------
// per-part sharing
//
// One drawn part (one builder call) often makes many meshes of the same colour, and many
// identical small pieces (glue blobs, screws, rails). Within one call they share one
// material per set of parameters and one geometry per shape.
//
// The scope is ONE part, never the whole rocket: the builder view highlights the selected
// part by writing `emissive` on the materials of the meshes named after it, so a material
// shared between two parts would light both. Nothing outlives the call either: the rocket
// is disposed with `disposeGroup`, and the builder rocket and the pad rocket live side by
// side, so a cache that outlived a build would hand out entries another rocket disposed.
// ---------------------------------------------------------------------------------------

interface PartScope {
  materials: Map<string, THREE.MeshStandardMaterial>;
  geometries: Map<string, THREE.BufferGeometry>;
}

/** Sharing scopes, keyed by the context copy `scopedPart` hands one builder call. */
const scopes = new WeakMap<PartContext, PartScope>();

/**
 * Wrap a part builder so each call draws with its own sharing scope: `partMaterial` and
 * `sharedGeometry` reuse entries within that call only. Same signature and output.
 */
export function scopedPart<C>(build: PartBuilder<C>): PartBuilder<C> {
  return (c, tier, ctx) => {
    const own: PartContext = { ...ctx };
    scopes.set(own, { materials: new Map(), geometries: new Map() });
    return build(c, tier, own);
  };
}

/**
 * A geometry shared by every mesh of the current part that asks with the same `key`.
 * Callers place each mesh with its own transform and must never edit the geometry after
 * it is returned. Outside a `scopedPart` call it simply builds a new one.
 */
export function sharedGeometry<G extends THREE.BufferGeometry>(ctx: PartContext, key: string, make: () => G): G {
  const scope = scopes.get(ctx);
  if (!scope) return make();
  const hit = scope.geometries.get(key);
  if (hit) return hit as G;
  const g = make();
  scope.geometries.set(key, g);
  return g;
}

/**
 * The only material part designs use. The app later swaps it for a cheap flat-pass
 * material (see `applyFlatStyle`), so a hand-set roughness or metalness never reaches the
 * screen: say how the surface catches light with `finish`, and express everything else
 * with shape and colour. Without `finish` the surface is drawn with no highlight at all.
 * `shell: true` marks an outer skin, which turns see-through in cutaway view.
 * `offset: true` adds a little polygon offset so thin decoration never z-fights the skin
 * under it.
 *
 * Inside a `scopedPart` call, equal arguments return the same material: never modify
 * the result (ask for what you need through `opts`).
 */
export function partMaterial(
  color: number,
  ctx: PartContext,
  opts: { shell?: boolean; offset?: boolean; finish?: PartFinish } = {},
): THREE.MeshStandardMaterial {
  const see = !!opts.shell && ctx.cutaway;
  const scope = scopes.get(ctx);
  const key = `${color}|${see ? 1 : 0}|${opts.offset ? 1 : 0}|${opts.finish ?? ''}`;
  const hit = scope?.materials.get(key);
  if (hit) return hit;
  const look = opts.finish ? FINISH_LOOK[opts.finish] : undefined;
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: look?.roughness ?? 0.45,
    metalness: look?.metalness ?? 0.05,
    side: THREE.DoubleSide,
  });
  if (opts.finish) m.userData.finish = opts.finish;
  if (see) {
    m.transparent = true;
    m.opacity = CUTAWAY_OPACITY;
    m.depthWrite = false;
  }
  if (opts.offset) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
  }
  scope?.materials.set(key, m);
  return m;
}

/**
 * Finish of a painted outer skin (nose, tube, transition, fin, pod) per tier, so skins
 * drawn by different part files match: clear-coated, primer-and-paint, bare and unsealed.
 */
export const SKIN_FINISH: Record<PartTier, PartFinish> = { best: 'gloss', ok: 'satin', bad: 'matte' };

// ---------------------------------------------------------------------------------------
// radial detail
// ---------------------------------------------------------------------------------------

/**
 * What a radial segment count is for: `outer` skins seen from outside, `inner` parts seen
 * only in cutaway, `small` hardware (lugs, buttons, bells, bolts).
 */
export type SegmentRole = 'outer' | 'inner' | 'small';

/** Most radial segments per role on a touch (phone / tablet) device. All multiples of 4. */
const COARSE_SEGMENT_CAP: Record<SegmentRole, number> = { outer: 32, inner: 24, small: 16 };

let coarsePointer: boolean | undefined;

/** True on a device whose main pointer is a finger. False without a DOM (tests, workers). */
function isCoarsePointer(): boolean {
  if (coarsePointer === undefined) {
    try {
      coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    } catch {
      coarsePointer = false;
    }
  }
  return coarsePointer;
}

/**
 * Radial segments to draw: `n` as the tier asks, capped on touch devices (phone GPUs).
 * The cap only ever lowers the count and keeps it a multiple of 4, so shapes that pin
 * vertices on the four axis directions stay exact. Unchanged where there is no DOM.
 */
export function radialSegments(n: number, role: SegmentRole): number {
  return isCoarsePointer() ? Math.min(n, COARSE_SEGMENT_CAP[role]) : n;
}

/** Mix a colour toward another by t in [0, 1]. */
export function mixColor(a: number, b: number, t: number): number {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}

/** Deterministic pseudo-random in [0, 1) from a string and an index, for repeatable flaws. */
export function seeded(key: string, i: number): number {
  let h = 2166136261 ^ i;
  for (let k = 0; k < key.length; k++) {
    h ^= key.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
