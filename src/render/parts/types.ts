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
 * The only material part designs use. The app later swaps it for a flat Lambert
 * material, so roughness and metalness never reach the screen: express a tier with
 * shape and colour. `shell: true` marks an outer skin, which turns see-through in
 * cutaway view.
 */
export function partMaterial(
  color: number,
  ctx: PartContext,
  opts: { shell?: boolean } = {},
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  if (opts.shell && ctx.cutaway) {
    m.transparent = true;
    m.opacity = CUTAWAY_OPACITY;
    m.depthWrite = false;
  }
  return m;
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
