// Procedural terrain around the launch pad for the mission view.
//
// Local frame (same as the mission pad group): +X east, +Y up, +Z south, origin on the launch
// pedestal top. The patch follows Earth's curvature, so its rim drops ~1.8 km below the tangent
// plane, and at the rim it bends down into a skirt that tucks under the (slightly sunk) globe.
//
// Layout is generic for an east-coast launch site (Sriharikota and Cape Canaveral both are):
// a beach and sea to the east, a coastal plain with scrub forest and a lagoon to the west, and
// hills rising far inland. Colours blend into the globe's own day map near the rim, so the patch
// meets the textured planet without a visible seam.

import * as THREE from 'three';

export const TERRAIN_RADIUS_M = 150_000;
/** Pad-local height of the open ground around the pad (the apron top sits at -2). */
export const PAD_GROUND_Y = -2.1;
/** Pad-local sea level. */
export const SEA_LEVEL_Y = -4;
const EARTH_R = 6_371_000;
const RINGS = 280;
const SEGMENTS = 340;
const RING_K = 9; // exponential ring spacing: ~1 m at the pad, ~8 km at the rim
const SKIRT_DROP_M = 1800;
const PAD_FLAT_R = 650;
const PAD_FLAT_BLEND = 500;
const DETAIL_TILE_M = 36;
/** Texels in the 1D shoreline lookup texture (z from -TERRAIN_RADIUS_M to +TERRAIN_RADIUS_M). */
const SHORE_LUT_N = 4096;
const SHORE_LUT_SCALE = SHORE_LUT_N / (2 * TERRAIN_RADIUS_M); // texels per metre
/** Lagoon membership is scaled to a signed distance (m) for the shoreline: 0.5 membership = 0 m. */
const SHORE_LAGOON_SCALE_M = 1000;
/** Mesh heights are pulled within this distance (m) of the shoreline so the coarse triangles agree with it. */
const SHORE_BAND_M = 400;
/** Water-side ground is pushed below the water plane (pad-local, above sea level), land-side above it. */
const SHORE_WATER_CLAMP_M = -0.9;
const SHORE_LAND_CLAMP_M = 0.6;

// ---------- Deterministic noise (pure, testable) ----------

function hash2(ix: number, iy: number, seed: number): number {
  let h = ix * 374761393 + iy * 668265263 + seed * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal value noise in [0, 1). */
export function fbm(x: number, y: number, octaves = 5, seed = 1): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, y * f, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Ridged noise in [0, 1): sharp crests, used for the inland hills. */
function ridged(x: number, y: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < 5; o++) {
    const n = 1 - Math.abs(2 * valueNoise(x * f, y * f, seed + o * 31) - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return sum / norm;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- Terrain field ----------

export interface TerrainSample {
  /** Ground height above local sea level, m (negative under water). */
  height: number;
  /** Signed distance to the shoreline, m: negative on land, positive out at sea. */
  coast: number;
  /** 0..1, how much of the lagoon is here. */
  lagoon: number;
}

/** x of the shoreline (east of the pad) at a given z. */
export function coastX(z: number): number {
  return 1600 + 450 * (fbm(z / 3800, 3.7, 3, 5) - 0.5) * 2 + 2200 * Math.sin(z / 41_000);
}

/** Lagoon centre x (west of the pad) at a given z. */
function lagoonCentreX(z: number): number {
  return -9000 + 2600 * (fbm(z / 11_000, 1.3, 3, 21) - 0.5) * 2;
}

/** Lagoon half-width at a given z. */
function lagoonHalfWidth(z: number): number {
  return 2600 + 1800 * fbm(z / 6000, 7.1, 3, 22);
}

/** 0..1 along-lagoon mask: the lagoon runs roughly from z = -46 km to +27 km. */
function lagoonAlong(z: number): number {
  return smooth(-52_000, -40_000, z) * (1 - smooth(20_000, 34_000, z));
}

/** 0..1 lagoon membership at (x, z): soft edge from 0.75 to 1 of the half-width. */
function lagoonMask(x: number, z: number): number {
  const hw = lagoonHalfWidth(z);
  return (1 - smooth(hw * 0.75, hw, Math.abs(x - lagoonCentreX(z)))) * lagoonAlong(z);
}

/** Raw terrain field at a pad-local (x, z), before the pad flattening and the curvature drop. */
export function sampleTerrain(x: number, z: number): TerrainSample {
  const coast = x - coastX(z);
  if (coast > 0) {
    // Continental shelf: shallow near the beach, then deeper.
    // Continuous with the beach (0 m at the shoreline), so the waterline follows the true coast
    // instead of stepping along the mesh triangles.
    const depth = Math.min(1.5, coast * 0.012) + Math.min(60, coast * 0.004) + 3 * fbm(x / 2500, z / 2500, 3, 9) * smooth(0, 600, coast);
    return { height: -depth, coast, lagoon: 0 };
  }
  const inland = -coast;
  // Low dunes just behind the beach, then a gently undulating plain.
  const dunes = 4 * smooth(20, 160, inland) * (1 - smooth(500, 1400, inland)) * fbm(x / 140, z / 140, 3, 3);
  const plain = 1.5 + 3.5 * fbm(x / 900, z / 900, 4, 2) + 6 * fbm(x / 7000, z / 7000, 3, 4);
  // Hills far inland (west), with ridged crests.
  const west = Math.max(0, -x - 28_000);
  const hillMask = smooth(0, 60_000, west);
  const hills = hillMask * (80 + 620 * ridged(x / 26_000, z / 26_000, 11)) * (0.6 + 0.4 * fbm(x / 9000, z / 9000, 3, 12));
  let h = Math.min(1.6, inland / 60) * 0.6 + smooth(30, 300, inland) * (plain + dunes) + hills;
  // Lagoon west of the pad: a long shallow body of water running north-south.
  const lagoon = lagoonMask(x, z);
  if (lagoon > 0) h = h * (1 - lagoon) + (-1.8) * lagoon;
  return { height: h, coast, lagoon };
}

/** Pad-local y of the ground surface (includes the flattened pad area and the Earth's curvature). */
export function terrainHeightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  return groundY(shoreHeight(x, z, sampleTerrain(x, z).height), r);
}

/**
 * Signed distance (m) to the water edge, positive over water: the sea or the lagoon, whichever
 * reaches further in. The shader computes the same thing (plus a little wobble) per pixel.
 */
function shoreSignedDistance(x: number, z: number): number {
  return Math.max(x - coastX(z), (lagoonMask(x, z) - 0.5) * SHORE_LAGOON_SCALE_M);
}

/**
 * Ground height used for the mesh. Within SHORE_BAND_M of the shoreline the height is pulled to a
 * fixed value on each side of the water plane, so the triangles of the coarse grid cannot rise above
 * the water on the water side (or sink below it on the land side). The weight is 1 at the shore and
 * 0 beyond the band, so the field is unchanged away from the coast.
 */
function shoreHeight(x: number, z: number, height: number): number {
  const sd = shoreSignedDistance(x, z);
  const b = 1 - smooth(SHORE_BAND_M * 0.5, SHORE_BAND_M, Math.abs(sd));
  if (b <= 0) return height;
  const target = sd > 0 ? Math.min(height, SHORE_WATER_CLAMP_M) : Math.max(height, SHORE_LAND_CLAMP_M);
  return height + (target - height) * b;
}

/** Bakes coastX, the lagoon centre, half-width and along mask into a 1D RGBA float lookup. */
function buildShoreLut(): THREE.DataTexture {
  const data = new Float32Array(SHORE_LUT_N * 4);
  for (let i = 0; i < SHORE_LUT_N; i++) {
    const z = -TERRAIN_RADIUS_M + (i + 0.5) / SHORE_LUT_SCALE;
    data[i * 4] = coastX(z);
    data[i * 4 + 1] = lagoonCentreX(z);
    data[i * 4 + 2] = lagoonHalfWidth(z);
    data[i * 4 + 3] = lagoonAlong(z);
  }
  const tex = new THREE.DataTexture(data, SHORE_LUT_N, 1, THREE.RGBAFormat, THREE.FloatType);
  // Nearest sampling plus a manual lerp in the shader: float textures are not linearly filterable
  // on every WebGL2 device without OES_texture_float_linear.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function groundY(height: number, r: number): number {
  const flat = 1 - smooth(PAD_FLAT_R, PAD_FLAT_R + PAD_FLAT_BLEND, r);
  const natural = SEA_LEVEL_Y + height;
  const y = natural * (1 - flat) + PAD_GROUND_Y * flat;
  return y - curvatureDrop(r) - skirt(r);
}

function curvatureDrop(r: number): number {
  return (r * r) / (2 * EARTH_R);
}

function skirt(r: number): number {
  return SKIRT_DROP_M * smooth(TERRAIN_RADIUS_M * 0.93, TERRAIN_RADIUS_M, r);
}

/** Radius of ring i of the polar grid (ring 0 is the centre point). */
export function ringRadius(i: number): number {
  return (TERRAIN_RADIUS_M * (Math.exp((RING_K * i) / RINGS) - 1)) / (Math.exp(RING_K) - 1);
}

// ---------- Colours ----------

const C = {
  sand: new THREE.Color(0xd9c79b),
  wetSand: new THREE.Color(0xa99a78),
  scrub: new THREE.Color(0x6d7f45),
  forest: new THREE.Color(0x3c5a2c),
  dry: new THREE.Color(0x9a8f5d),
  field: new THREE.Color(0x87a04f),
  fieldB: new THREE.Color(0xb3a46a),
  rock: new THREE.Color(0x857a68),
  hillGreen: new THREE.Color(0x4f6a37),
  mud: new THREE.Color(0x7b7458),
  concrete: new THREE.Color(0x8e8c86),
  deep: new THREE.Color(0x0b3554),
  shelf: new THREE.Color(0x1a6a86),
  shallow: new THREE.Color(0x3fa3a6),
  lagoonWater: new THREE.Color(0x4d7f7a),
};

function landColour(x: number, z: number, s: TerrainSample, r: number, out: THREE.Color): THREE.Color {
  const inland = -s.coast;
  const n1 = fbm(x / 700, z / 700, 4, 41);
  const n2 = fbm(x / 4200, z / 4200, 3, 42);
  // Base: scrub with darker forest clumps and drier patches.
  out.copy(C.scrub).lerp(C.forest, smooth(0.45, 0.7, n1)).lerp(C.dry, smooth(0.55, 0.8, n2) * 0.7);
  // Farmland quilt further inland.
  if (r > 14_000) {
    const cell = 650;
    const fx = Math.floor(x / cell), fz = Math.floor(z / cell);
    const pick = hash2(fx, fz, 77);
    const fieldMask = smooth(14_000, 22_000, r) * (1 - smooth(0.55, 0.75, n2)) * (pick > 0.35 ? 1 : 0);
    out.lerp(pick > 0.7 ? C.fieldB : C.field, fieldMask * 0.75);
  }
  // Hills: greener on the slopes, rock on the crests.
  if (s.height > 60) {
    out.lerp(C.hillGreen, smooth(60, 200, s.height) * 0.7).lerp(C.rock, smooth(350, 650, s.height) * 0.8);
  }
  // Lagoon margins are mudflats.
  out.lerp(C.mud, smooth(0.0, 0.6, s.lagoon) * 0.8);
  // Beach.
  out.lerp(C.sand, 1 - smooth(60, 220, inland));
  out.lerp(C.wetSand, 1 - smooth(0, 25, inland));
  // Cleared spaceport ground around the pad.
  const cleared = 1 - smooth(PAD_FLAT_R - 50, PAD_FLAT_R + PAD_FLAT_BLEND, r);
  out.lerp(C.dry, cleared * 0.55);
  return out;
}

function waterColour(s: TerrainSample, out: THREE.Color): THREE.Color {
  if (s.coast <= 0) return out.copy(C.lagoonWater);
  out.copy(C.shallow).lerp(C.shelf, smooth(0, 900, s.coast)).lerp(C.deep, smooth(2500, 30_000, s.coast));
  return out;
}

// ---------- Geometry ----------

function polarGrid(
  fill: (x: number, z: number, r: number, pos: Float32Array, col: Float32Array, k: number) => void,
  extra?: (k: number, x: number, z: number) => [number, number, number],
): THREE.BufferGeometry {
  const vertCount = 1 + RINGS * SEGMENTS;
  const pos = new Float32Array(vertCount * 3);
  const col = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  const rim = new Float32Array(vertCount);
  const field = extra ? new Float32Array(vertCount * 3) : null;
  const putExtra = (k: number, x: number, z: number): void => {
    if (!extra || !field) return;
    const e = extra(k, x, z);
    field[k * 3] = e[0];
    field[k * 3 + 1] = e[1];
    field[k * 3 + 2] = e[2];
  };
  fill(0, 0, 0, pos, col, 0);
  putExtra(0, 0, 0);
  let k = 1;
  for (let i = 1; i <= RINGS; i++) {
    const r = ringRadius(i);
    // Stagger alternate rings by half a segment so triangles stay well shaped.
    const off = (i % 2) * 0.5;
    for (let j = 0; j < SEGMENTS; j++) {
      const a = ((j + off) / SEGMENTS) * Math.PI * 2;
      const x = r * Math.cos(a), z = r * Math.sin(a);
      fill(x, z, r, pos, col, k);
      putExtra(k, x, z);
      uv[k * 2] = x / DETAIL_TILE_M;
      uv[k * 2 + 1] = z / DETAIL_TILE_M;
      rim[k] = r / TERRAIN_RADIUS_M;
      k++;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < SEGMENTS; j++) idx.push(0, 1 + ((j + 1) % SEGMENTS), 1 + j);
  for (let i = 1; i < RINGS; i++) {
    const a0 = 1 + (i - 1) * SEGMENTS, b0 = 1 + i * SEGMENTS;
    for (let j = 0; j < SEGMENTS; j++) {
      const j1 = (j + 1) % SEGMENTS;
      const a = a0 + j, a1 = a0 + j1, b = b0 + j, b1 = b0 + j1;
      idx.push(a, a1, b, a1, b1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('rim', new THREE.BufferAttribute(rim, 1));
  if (field) {
    g.setAttribute('aField', new THREE.BufferAttribute(field, 3));
    g.setAttribute('aGlobeW', new THREE.BufferAttribute(new Float32Array(vertCount), 1));
  }
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Tiling ground detail, mean ~0.86 so it darkens the vertex colours only a little. */
function makeDetailTexture(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const tiled = (x: number, y: number, cells: number, seed: number): number => {
    // Wrapped value noise so the tile repeats seamlessly.
    const fx = (x / size) * cells, fy = (y / size) * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const h = (a: number, b: number) => hash2(((a % cells) + cells) % cells, ((b % cells) + cells) % cells, seed);
    const a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = 0.45 * tiled(x, y, 8, 1) + 0.3 * tiled(x, y, 24, 2) + 0.25 * tiled(x, y, 64, 3);
      const v = Math.round(255 * (0.68 + 0.36 * n));
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = Math.round(v * (0.98 + 0.04 * tiled(x, y, 16, 4)));
      data[i + 2] = Math.round(v * 0.95);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const GLSL_NOISE = `
  float tHash(vec2 p) {
    p = mod(p, 1024.0);
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float tNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Fractal noise whose octaves fade out once they are smaller than a pixel (no shimmer far away).
  float tFbm(vec2 p, float footprint) {
    float s = 0.0, a = 0.5, n = 0.0, f = 1.0;
    for (int i = 0; i < 5; i++) {
      float keep = 1.0 - smoothstep(0.3, 0.7, footprint * f);
      s += a * mix(0.5, tNoise(p * f + float(i) * 17.3), keep);
      n += a;
      a *= 0.5;
      f *= 2.03;
    }
    return s / n;
  }
`;

const glslVec = (c: THREE.Color) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

/**
 * Per-pixel shoreline. shoreRow() reads the baked 1D lookup (coastX, lagoon centre, half-width,
 * along mask) with a manual linear lerp between texel centres. shoreSD() is the signed distance to
 * the water edge in metres (positive over water), with a small wobble from tFbm so the edge is not
 * a perfect curve. shoreWater() is the 0..1 "is water" value, anti-aliased over one pixel.
 */
const SHORE_GLSL = `${GLSL_NOISE}
  uniform sampler2D uShoreLUT;
  vec4 shoreRow(float z) {
    float f = clamp((z + ${TERRAIN_RADIUS_M.toFixed(1)}) * ${SHORE_LUT_SCALE.toFixed(10)} - 0.5, 0.0, ${SHORE_LUT_N - 1}.0);
    float i0 = floor(f);
    float t = f - i0;
    vec4 a = texture2D(uShoreLUT, vec2((i0 + 0.5) / ${SHORE_LUT_N}.0, 0.5));
    vec4 b = texture2D(uShoreLUT, vec2((i0 + 1.5) / ${SHORE_LUT_N}.0, 0.5));
    return mix(a, b, t);
  }
  float shoreWobble(vec2 xz) {
    float fw = length(fwidth(xz));
    return (tFbm(xz / 14.0, fw / 14.0) - 0.5) * 5.0;
  }
  float shoreSeaSD(vec2 xz) {
    return xz.x - shoreRow(xz.y).r;
  }
  float shoreSD(vec2 xz) {
    vec4 L = shoreRow(xz.y);
    float lagoon = (L.a * (1.0 - smoothstep(0.75 * L.b, L.b, abs(xz.x - L.g))) - 0.5) * ${SHORE_LAGOON_SCALE_M.toFixed(1)};
    return max(xz.x - L.r, lagoon) + shoreWobble(xz);
  }
  float shoreWater(vec2 xz) {
    float fw = max(length(fwidth(xz)), 0.05);
    return smoothstep(-fw, fw, shoreSD(xz));
  }
`;

/**
 * Land shading: biome colour is computed per pixel from the pad-local position plus the smooth
 * per-vertex lagoon and height fields, so it stays crisp at any distance. Far from the pad it blends
 * into the globe's own colours (vertex colours weighted by aGlobeW), and the tiling detail texture
 * fades out with distance. Land is discarded on the water side of the per-pixel shoreline, so the
 * water mesh shows the exact contour instead of the coarse triangle crossing.
 */
function patchLandShader(mat: THREE.MeshStandardMaterial, shoreTex: THREE.DataTexture): void {
  const lin = glslVec;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uShoreLUT = { value: shoreTex };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aField;
        attribute float aGlobeW;
        varying vec3 vField;
        varying float vGlobeW;
        varying vec2 vXZ;
        varying float vViewDist;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vViewDist = -mvPosition.z;
        vXZ = position.xz;
        vField = aField;
        vGlobeW = aGlobeW;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vField;
        varying float vGlobeW;
        varying vec2 vXZ;
        varying float vViewDist;
        ${SHORE_GLSL}
        vec3 landColour(vec2 xz, float lagoon, float h) {
          float fw = length(fwidth(xz));
          float inland = -shoreSeaSD(xz) - shoreWobble(xz);
          float n1 = tFbm(xz / 700.0, fw / 700.0);
          float n2 = tFbm(xz / 4200.0, fw / 4200.0);
          float n3 = tFbm(xz / 60.0, fw / 60.0);
          vec3 c = mix(${lin(C.scrub)}, ${lin(C.forest)}, smoothstep(0.42, 0.68, n1));
          c = mix(c, ${lin(C.dry)}, smoothstep(0.55, 0.8, n2) * 0.7);
          float r = length(xz);
          if (r > 12000.0) {
            // Irregular field blocks: rows of varying depth, each row's fields offset and sized differently.
            float rowH = 420.0 + 380.0 * tHash(vec2(floor(xz.y / 900.0), 3.0));
            float rowId = floor(xz.y / rowH);
            float fieldW = 380.0 + 520.0 * tHash(vec2(rowId, 9.0));
            vec2 cell = vec2(floor((xz.x + tHash(vec2(rowId, 5.0)) * fieldW) / fieldW), rowId);
            float pick = tHash(cell + 71.0);
            // Patchy: farmland comes in clusters (n1) and thins out where the land is dry (n2).
            float fieldMask = smoothstep(12000.0, 20000.0, r) * (1.0 - smoothstep(0.5, 0.72, n2)) * smoothstep(0.35, 0.6, n1 + 0.15) * step(0.4, pick);
            vec3 fc = pick > 0.7 ? ${lin(C.fieldB)} : ${lin(C.field)};
            // Plough lines inside each field.
            float rows = 0.9 + 0.1 * sin(dot(xz, pick > 0.5 ? vec2(0.9, 0.0) : vec2(0.0, 0.9)) * 0.5);
            // Fields only tint the ground (no hard checkerboard), and fade out with viewing distance.
            fc = mix(c, fc, 0.45 + 0.4 * tHash(cell + 13.0));
            c = mix(c, fc * mix(1.0, rows, 1.0 - smoothstep(30.0, 200.0, fw * 40.0)), fieldMask * 0.5 * (1.0 - smoothstep(60.0, 400.0, fw)));
          }
          c = mix(c, ${lin(C.hillGreen)}, smoothstep(60.0, 200.0, h) * 0.7);
          c = mix(c, ${lin(C.rock)}, smoothstep(350.0, 650.0, h) * 0.8);
          c = mix(c, ${lin(C.mud)}, smoothstep(0.0, 0.6, lagoon) * 0.8);
          c *= 0.82 + 0.36 * n3;
          float beach = 1.0 - smoothstep(40.0 + 60.0 * n2, 220.0, inland);
          c = mix(c, ${lin(C.sand)}, beach);
          // Wet sand hugs the per-pixel waterline, lagoon margins included.
          c = mix(c, ${lin(C.wetSand)}, 1.0 - smoothstep(-5.0, 25.0, -shoreSD(xz)));
          float cleared = 1.0 - smoothstep(${PAD_FLAT_R - 50}.0, ${PAD_FLAT_R + PAD_FLAT_BLEND}.0, r);
          c = mix(c, ${lin(C.dry)} * (0.9 + 0.2 * n3), cleared * 0.55);
          return c;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `// Water side of the shoreline: the water mesh covers this pixel.
        if (shoreWater(vXZ) >= 1.0) discard;
        vec3 bio = landColour(vXZ, vField.y, vField.z);
        diffuseColor.rgb *= mix(bio, vColor, vGlobeW);`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          float detailFade = 1.0 - smoothstep( 300.0, 4000.0, vViewDist );
          diffuseColor.rgb *= mix( vec3( 0.86 ), sampledDiffuseColor.rgb, detailFade ) / 0.86;
        #endif`,
      );
  };
}

// ---------- Trees and spaceport buildings ----------

function inSpaceportFootprint(x: number, z: number): boolean {
  if (Math.hypot(x, z) < PAD_FLAT_R + 120) return true;
  // VAB yard, road corridor and tank farm.
  if (x > -1500 && x < -700 && z > -800 && z < -100) return true;
  if (x > 200 && x < 520 && z > 220 && z < 620) return true;
  // Road from the pad to the VAB (a 40 m wide corridor).
  const t = Math.max(0, Math.min(1, (x * -1100 + z * -420) / (1100 * 1100 + 420 * 420)));
  if (Math.hypot(x - -1100 * t, z - -420 * t) < 40) return true;
  // Second pad.
  if (Math.hypot(x - -400, z - -2300) < 420) return true;
  return false;
}

function buildTrees(count: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'terrain-trees';
  const canopyGeo = new THREE.ConeGeometry(1, 1, 7, 1);
  canopyGeo.translate(0, 0.5, 0);
  const bushGeo = new THREE.IcosahedronGeometry(1, 0);
  const treeMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, color: 0xffffff });
  const trees = new THREE.InstancedMesh(canopyGeo, treeMat, count);
  const bushes = new THREE.InstancedMesh(bushGeo, treeMat, count);
  trees.name = 'terrain-tree-canopy';
  bushes.name = 'terrain-bushes';
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  const dark = new THREE.Color(0x2b4a22), light = new THREE.Color(0x5e7a3a);
  let nt = 0, nb = 0, seed = 0;
  while ((nt < count || nb < count) && seed < count * 12) {
    seed++;
    const r = 820 + 9000 * Math.pow(hash2(seed, 1, 91), 1.6);
    const a = hash2(seed, 2, 92) * Math.PI * 2;
    const x = r * Math.cos(a), z = r * Math.sin(a);
    if (inSpaceportFootprint(x, z)) continue;
    const smp = sampleTerrain(x, z);
    if (smp.coast > -140 || smp.lagoon > 0.05) continue;
    // Clumped: keep a point only where forest noise is high enough.
    if (fbm(x / 500, z / 500, 3, 41) < 0.38 + 0.15 * hash2(seed, 3, 93)) continue;
    const y = terrainHeightAt(x, z);
    col.copy(dark).lerp(light, hash2(seed, 4, 94));
    if (hash2(seed, 5, 95) < 0.55 && nt < count) {
      const h = 7 + 9 * hash2(seed, 6, 96);
      const w = h * (0.28 + 0.12 * hash2(seed, 7, 97));
      p.set(x, y - 0.5, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
      s.set(w, h, w);
      trees.setMatrixAt(nt, m.compose(p, q, s));
      trees.setColorAt(nt, col);
      nt++;
    } else if (nb < count) {
      const w = 2 + 3.5 * hash2(seed, 8, 98);
      p.set(x, y + w * 0.35, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a * 3);
      s.set(w, w * 0.8, w);
      bushes.setMatrixAt(nb, m.compose(p, q, s));
      bushes.setColorAt(nb, col.multiplyScalar(0.92));
      nb++;
    }
  }
  trees.count = nt;
  bushes.count = nb;
  trees.instanceMatrix.needsUpdate = true;
  bushes.instanceMatrix.needsUpdate = true;
  if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
  if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
  trees.computeBoundingSphere();
  bushes.computeBoundingSphere();
  trees.castShadow = bushes.castShadow = true;
  trees.receiveShadow = bushes.receiveShadow = true;
  group.add(trees, bushes);
  return group;
}

function boxAt(
  w: number, h: number, d: number, x: number, z: number, mat: THREE.Material, yOffset = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, terrainHeightAt(x, z) + h / 2 + yOffset, z);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function buildSpaceport(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'spaceport';
  const wall = new THREE.MeshStandardMaterial({ color: 0xdedbd2, roughness: 0.8, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3b4250, roughness: 0.7, metalness: 0.2 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.6, metalness: 0.3 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb8432f, roughness: 0.6, metalness: 0.3 });
  const tankMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.35, metalness: 0.25 });
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x4a4a48, roughness: 0.95, metalness: 0 });

  // Vehicle assembly building with a tall door facing the pad.
  const vab = boxAt(70, 82, 52, -1100, -420, wall);
  vab.name = 'vab';
  g.add(vab);
  const door = boxAt(26, 70, 1, -1100 + 0, -420 + 26.6, dark);
  g.add(door);
  g.add(boxAt(72, 2, 54, -1100, -420, roof, 82));
  const annex = boxAt(60, 24, 40, -1180, -560, wall);
  g.add(annex);

  // Road from the VAB to the pad.
  const roadLen = Math.hypot(1100, 420);
  const road = new THREE.Mesh(new THREE.BoxGeometry(roadLen, 0.3, 14), asphalt);
  road.position.set(-550, PAD_GROUND_Y + 0.12, -210);
  // Box length runs along local +X; rotation.y = a turns +X to (cos a, 0, -sin a): point it at the VAB.
  road.rotation.y = Math.atan2(420, -1100);
  road.receiveShadow = true;
  g.add(road);

  // Propellant tank farm: spheres on short legs.
  for (const [x, z] of [[300, 300], [380, 420], [460, 320]] as const) {
    const y = terrainHeightAt(x, z);
    const tank = new THREE.Mesh(new THREE.SphereGeometry(9, 24, 16), tankMat);
    tank.position.set(x, y + 13, z);
    tank.castShadow = tank.receiveShadow = true;
    g.add(tank);
    const skirtMesh = new THREE.Mesh(new THREE.CylinderGeometry(5, 6, 6, 16), dark);
    skirtMesh.position.set(x, y + 3, z);
    g.add(skirtMesh);
  }

  // Second launch pad: apron, tower and lightning masts.
  const pad2y = terrainHeightAt(-400, -2300);
  const apron2 = new THREE.Mesh(new THREE.BoxGeometry(70, 2, 70), roof);
  apron2.position.set(-400, pad2y, -2300);
  apron2.receiveShadow = true;
  g.add(apron2);
  const tower2 = new THREE.Mesh(new THREE.BoxGeometry(10, 74, 10), red);
  tower2.position.set(-418, pad2y + 37, -2300);
  tower2.castShadow = true;
  g.add(tower2);
  for (const [dx, dz] of [[30, 30], [-30, -30], [30, -30]] as const) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.2, 90, 8), wall);
    mast.position.set(-400 + dx, pad2y + 45, -2300 + dz);
    mast.castShadow = true;
    g.add(mast);
  }

  // Low control-centre buildings to the north-west.
  for (let i = 0; i < 5; i++) {
    const x = -2900 + i * 70, z = -1500 - (i % 2) * 60;
    g.add(boxAt(50, 10 + 4 * (i % 3), 30, x, z, i % 2 ? wall : roof));
  }
  return g;
}

// ---------- Public builder ----------

export interface PadTerrain {
  group: THREE.Group;
  land: THREE.Mesh;
  water: THREE.Mesh;
  /** Re-tint the far part of the patch from the globe's day map so the rim matches the planet. */
  blendGlobe(image: CanvasImageSource & { width: number; height: number }, padToEarth: THREE.Matrix4): void;
  /** Animate the sea (time in seconds) and fade details with camera height above the pad. */
  update(timeS: number, cameraHeight: number): void;
  dispose(): void;
}

export function buildPadTerrain(opts: { trees?: number; spaceport?: boolean } = {}): PadTerrain {
  const group = new THREE.Group();
  group.name = 'pad-terrain';

  const samples: TerrainSample[] = [];
  const tmp = new THREE.Color();
  const shoreTex = buildShoreLut();
  const landGeo = polarGrid((x, z, r, pos, col, k) => {
    const s = sampleTerrain(x, z);
    samples[k] = s;
    pos[k * 3] = x;
    pos[k * 3 + 1] = groundY(shoreHeight(x, z, s.height), r);
    pos[k * 3 + 2] = z;
    landColour(x, z, s, r, tmp);
    col[k * 3] = tmp.r;
    col[k * 3 + 1] = tmp.g;
    col[k * 3 + 2] = tmp.b;
  }, (k) => {
    const s = samples[k];
    return [Math.max(-3000, Math.min(3000, s.coast)), s.lagoon, s.height];
  });
  const waterGeo = polarGrid((x, z, r, pos, col, k) => {
    const s = samples[k] ?? sampleTerrain(x, z);
    pos[k * 3] = x;
    pos[k * 3 + 1] = SEA_LEVEL_Y - 0.4 - curvatureDrop(r) - skirt(r) * 0.98;
    pos[k * 3 + 2] = z;
    waterColour(s, tmp);
    col[k * 3] = tmp.r;
    col[k * 3 + 1] = tmp.g;
    col[k * 3 + 2] = tmp.b;
  });
  const baseLand = (landGeo.getAttribute('color') as THREE.BufferAttribute).array.slice() as Float32Array;
  const baseWater = (waterGeo.getAttribute('color') as THREE.BufferAttribute).array.slice() as Float32Array;

  const detail = makeDetailTexture();
  const landMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: detail,
    roughness: 0.96,
    metalness: 0,
  });
  patchLandShader(landMat, shoreTex);
  const land = new THREE.Mesh(landGeo, landMat);
  land.name = 'terrain-land';
  land.receiveShadow = true;
  // Read-only copy of the shoreline lookup (RGBA: coastX, lagoon centre, half-width, along mask).
  land.userData.shoreLut = shoreTex.image.data;

  const waterUniforms = { uTime: { value: 0 } };
  const waterMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.12,
    metalness: 0.1,
    envMapIntensity: 1.2,
    // Wins the depth test against land that pokes a hair above the sea right at the shoreline.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // Cheap wave normals: a few travelling sine waves perturb the flat normal.
  waterMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterUniforms.uTime;
    shader.uniforms.uShoreLUT = { value: shoreTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;\nvarying float vWaterDist;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvWaterXZ = position.xz;\nvWaterDist = -mvPosition.z;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        varying vec2 vWaterXZ;
        varying float vWaterDist;
        ${SHORE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Per-pixel waterline: discard the land side, blend the edge pixel to wet sand, and add a
          // thin foam line just offshore.
          float sdW = shoreSD(vWaterXZ);
          float fwW = max(length(fwidth(vWaterXZ)), 0.05);
          if (sdW < -fwW) discard;
          float edge = smoothstep(-fwW, fwW, sdW);
          float foam = (1.0 - smoothstep(0.0, 2.5, sdW)) * 0.45;
          diffuseColor.rgb = mix(${glslVec(C.wetSand)}, diffuseColor.rgb, edge);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.88, 0.88), foam * edge);
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 p = vWaterXZ;
          float fade = 1.0 - smoothstep( 300.0, 9000.0, vWaterDist );
          vec2 d = vec2( 0.0 );
          d += vec2( 0.8, 0.6 ) * cos( dot( p, vec2( 0.8, 0.6 ) ) * 0.09 + uTime * 1.3 ) * 0.5;
          d += vec2( -0.4, 0.9 ) * cos( dot( p, vec2( -0.4, 0.9 ) ) * 0.21 + uTime * 1.9 ) * 0.3;
          d += vec2( 0.95, -0.3 ) * cos( dot( p, vec2( 0.95, -0.3 ) ) * 0.47 + uTime * 2.7 ) * 0.2;
          d += vec2( 0.2, -0.98 ) * cos( dot( p, vec2( 0.2, -0.98 ) ) * 1.1 + uTime * 3.6 ) * 0.12;
          vec3 bump = ( viewMatrix * vec4( d.x, 0.0, d.y, 0.0 ) ).xyz;
          normal = normalize( normal - bump * 0.22 * fade );
        }`,
      );
  };
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.name = 'terrain-water';
  water.receiveShadow = true;
  // Drawn after the land; where the land is above the sea the depth test hides the water.
  water.renderOrder = 1;

  group.add(land, water);

  const trees = buildTrees(opts.trees ?? 3500);
  group.add(trees);
  // Orbital spaceport (VAB, road, tank farm, second pad). Off for the model-rocket flight site.
  const spaceport = opts.spaceport === false ? new THREE.Group() : buildSpaceport();
  group.add(spaceport);

  function blendGlobe(image: CanvasImageSource & { width: number; height: number }, padToEarth: THREE.Matrix4): void {
    if (typeof document === 'undefined') return;
    const w = 1024, h = 512;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    try {
      ctx.drawImage(image, 0, 0, w, h);
    } catch {
      return;
    }
    let px: Uint8ClampedArray;
    try {
      px = ctx.getImageData(0, 0, w, h).data;
    } catch {
      return;
    }
    const v = new THREE.Vector3();
    const sample = (geo: THREE.BufferGeometry, base: Float32Array, start: number, end: number, gain: number): void => {
      const posA = geo.getAttribute('position') as THREE.BufferAttribute;
      const colA = geo.getAttribute('color') as THREE.BufferAttribute;
      const rimA = geo.getAttribute('rim') as THREE.BufferAttribute;
      const col = colA.array as Float32Array;
      // Land is shaded per pixel: there the vertex colour is the globe colour and aGlobeW its weight.
      const wAttr = geo.getAttribute('aGlobeW') as THREE.BufferAttribute | undefined;
      for (let k = 0; k < posA.count; k++) {
        const wgt = smooth(start, end, rimA.getX(k));
        if (wAttr) wAttr.setX(k, wgt);
        if (wgt <= 0) {
          col[k * 3] = base[k * 3];
          col[k * 3 + 1] = base[k * 3 + 1];
          col[k * 3 + 2] = base[k * 3 + 2];
          continue;
        }
        v.fromBufferAttribute(posA, k).applyMatrix4(padToEarth);
        const lat = Math.atan2(v.y, Math.hypot(v.x, v.z));
        const lon = Math.atan2(-v.z, v.x);
        const u = lon / (2 * Math.PI) + 0.5;
        const t = 0.5 - lat / Math.PI;
        const ix = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
        const iy = Math.min(h - 1, Math.max(0, Math.floor(t * h)));
        const o = (iy * w + ix) * 4;
        // Texture is sRGB; vertex colours are linear.
        tmp.setRGB(px[o] / 255, px[o + 1] / 255, px[o + 2] / 255, THREE.SRGBColorSpace).multiplyScalar(gain);
        const ww = wAttr ? 1 : wgt;
        col[k * 3] = base[k * 3] + (tmp.r - base[k * 3]) * ww;
        col[k * 3 + 1] = base[k * 3 + 1] + (tmp.g - base[k * 3 + 1]) * ww;
        col[k * 3 + 2] = base[k * 3 + 2] + (tmp.b - base[k * 3 + 2]) * ww;
      }
      colA.needsUpdate = true;
      if (wAttr) wAttr.needsUpdate = true;
    };
    sample(landGeo, baseLand, 0.3, 0.75, 1.1);
    sample(waterGeo, baseWater, 0.35, 0.8, 1.0);
  }

  function update(timeS: number, cameraHeight: number): void {
    waterUniforms.uTime.value = timeS % 10_000;
    trees.visible = cameraHeight < 25_000;
    spaceport.visible = cameraHeight < 60_000;
  }

  function dispose(): void {
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
        o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
    detail.dispose();
    shoreTex.dispose();
  }

  return { group, land, water, blendGlobe, update, dispose };
}
