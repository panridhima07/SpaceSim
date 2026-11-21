// @ts-nocheck
// Ported from the ASTRA Spaceflight prototype. The numeric code below is unchanged from the
// tested original, so its bodies are not type-checked; the declared class fields and the
// tests in this folder are the contract. Type the internals before changing the maths.
// Procedural lunar terrain around a landing site. Pure module (no DOM / three.js): used by the renderer, the lander
// contact model, the hazard analysis and the rover path planner, so all of them see exactly the same ground.
//
// Local frame: x = east, y = north (metres, tangent plane at the site), height h(x, y) above the reference sphere.
// The terrain is deterministic for a given (seed, mare) pair: same landing site → same craters and boulders.
import { mulberry32, R_MOON } from './core';

export { R_MOON };
const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------------
// Named lunar regions (approximate centres) → site names, mare vs highland character
// ------------------------------------------------------------------------------------------------
const REGIONS = [
  ['Mare Tranquillitatis', 8.5, 31.4, 11, 1], ['Mare Serenitatis', 28.0, 17.5, 10, 1], ['Mare Imbrium', 32.8, -15.6, 16, 1], ['Mare Crisium', 17.0, 59.1, 6, 1],
  ['Mare Fecunditatis', -7.8, 51.3, 9, 1], ['Mare Nectaris', -15.2, 35.5, 5, 1], ['Mare Nubium', -21.3, -16.6, 9, 1], ['Mare Humorum', -24.4, -38.6, 6, 1],
  ['Mare Vaporum', 13.3, 3.6, 4, 1], ['Mare Frigoris', 56.0, 1.4, 8, 1], ['Oceanus Procellarum', 18.4, -57.4, 20, 1], ['Mare Cognitum', -10.0, -23.1, 4, 1],
  ['Sinus Medii', 1.6, 0.0, 3, 1], ['Sinus Aestuum', 12.6, -8.3, 3, 1], ['Mare Smythii', 1.3, 87.5, 4, 1], ['Mare Moscoviense', 27.3, 147.9, 5, 1],
  ['Tycho crater region', -43.3, -11.4, 4.5, 0], ['Copernicus crater region', 9.6, -20.1, 4, 0], ['Montes Apenninus', 18.9, -3.7, 4, 0], ['Aristarchus plateau', 23.7, -47.4, 3.5, 0],
  ['Kepler crater region', 8.1, -38.0, 2.5, 0], ['Plato crater region', 51.6, -9.4, 3.5, 0], ['Clavius crater region', -58.8, -14.4, 5, 0], ['Mare Orientale basin', -19.4, -92.8, 6, 0],
  ['South Pole–Aitken basin', -53.0, -170.0, 22, 0], ['Descartes highlands', -11.7, 15.5, 5, 0], ['Taurus–Littrow valley', 20.2, 30.8, 3, 0],
];
const gc = (la1, lo1, la2, lo2) => Math.acos(Math.max(-1, Math.min(1, Math.sin(la1 * DEG) * Math.sin(la2 * DEG) + Math.cos(la1 * DEG) * Math.cos(la2 * DEG) * Math.cos((lo1 - lo2) * DEG)))) / DEG;
export function regionAt(lat: number, lon: number): LunarRegion {
  let best = null, bd = 1e9;
  for (const [name, la, lo, r, mare] of REGIONS) { const d = gc(lat, lon, la, lo); if (d < r && d / r < bd) { bd = d / r; best = { name, mare: !!mare }; } }
  if (best) return best;
  if (lat > 62) return { name: 'North polar highlands', mare: false };
  if (lat < -62) return { name: 'South polar region', mare: false };
  const wl = ((lon + 540) % 360) - 180;
  if (Math.abs(wl) > 90) return { name: 'Far-side highlands', mare: false };
  return { name: 'Near-side highlands', mare: false };
}
export const fmtLatLon = (lat, lon) => { const wl = ((lon + 540) % 360) - 180; return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(wl).toFixed(2)}°${wl >= 0 ? 'E' : 'W'}`; };

// ------------------------------------------------------------------------------------------------
// Lat/lon ↔ Moon-fixed frame (x → lon 0, y → north, z → −(lon 90°E): same as the rendered globe) and the local tangent basis
// ------------------------------------------------------------------------------------------------
export const llToMF = (lat, lon) => [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
export const mfToLL = (p) => { const n = Math.hypot(p[0], p[1], p[2]); return { lat: Math.asin(p[1] / n), lon: Math.atan2(-p[2], p[0]) }; };
export function siteBasis(lat, lon) {
  const U = llToMF(lat, lon), E = [-Math.sin(lon), 0, -Math.cos(lon)], N = [-Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
  return { U, E, N };
}

// ------------------------------------------------------------------------------------------------
// Terrain
// ------------------------------------------------------------------------------------------------
const hash2 = (ix, iy, s) => { let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(s, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const sstep = (t) => t * t * (3 - 2 * t);

export interface LunarRegion { name: string; mare: boolean }
export interface ScienceTarget { id: string; x: number; y: number; kind: string }
/** [x, y, radius, depth/diameter, fresh] in site metres. */
export type Crater = [number, number, number, number, boolean];
/** [x, y, radius] in site metres. */
export type Boulder = [number, number, number];

export class Terrain {
  seed: number; mare: boolean; half: number; nearHalf: number; rough: number;
  craters: Crater[]; rocks: Boulder[];
  cell: number; grid: Map<number, number[]>; rcell: number; rgrid: Map<number, number[]>;
  constructor({ seed = 1, mare = true, half = 24000, nearHalf = 1600 } = {}) {
    this.seed = seed | 0; this.mare = mare; this.half = half; this.nearHalf = nearHalf;
    this.rough = mare ? 0.55 : 1.0;
    const rnd = mulberry32(this.seed ^ 0x5bd1e995), P = mare ? 1 : 3.0;
    // ---- craters: [x, y, R, depth/diameter, fresh]
    const cr = [];
    const area = (2 * half / 1000) ** 2, nBig = Math.round(0.19 * P * area);
    const pareto = (dmin, dmax) => { const u = Math.max(1e-6, rnd()); return Math.min(dmax, dmin / Math.sqrt(u)); };
    const ratio = (fresh) => (fresh ? 0.12 + rnd() * 0.07 : 0.035 + rnd() * 0.055);              // depth / diameter: degraded ≈ 0.04-0.09, fresh ≈ 0.12-0.19
    for (let i = 0; i < nBig; i++) { const fr = rnd() < 0.10; cr.push([(rnd() * 2 - 1) * half, (rnd() * 2 - 1) * half, pareto(250, 3500) / 2, ratio(fr), fr]); }
    const nNear = Math.round(120 * P * ((2 * nearHalf / 1000) ** 2) * (1 - (9 / 250) ** 2));
    for (let i = 0; i < nNear; i++) { const D = pareto(9, 250), fr = rnd() < (D < 40 ? 0.2 : 0.12); cr.push([(rnd() * 2 - 1) * nearHalf, (rnd() * 2 - 1) * nearHalf, D / 2, ratio(fr), fr]); }
    this.craters = cr;
    this.cell = 256; this.grid = new Map();
    cr.forEach((c, i) => {
      const R = c[2] * 3, x0 = Math.floor((c[0] - R) / this.cell), x1 = Math.floor((c[0] + R) / this.cell), y0 = Math.floor((c[1] - R) / this.cell), y1 = Math.floor((c[1] + R) / this.cell);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) { const k = gx * 65536 + gy; let a = this.grid.get(k); if (!a) this.grid.set(k, (a = [])); a.push(i); }
    });
    // ---- boulders: [x, y, r] ; clustered on fresh crater rims plus a sparse background
    const rocks = [], rp = () => Math.min(2.6, 0.28 / Math.sqrt(Math.max(1e-4, rnd())) * 0.9);
    for (const c of cr) {
      if (!c[4] || c[2] * 2 > 400 || Math.abs(c[0]) > nearHalf || Math.abs(c[1]) > nearHalf) continue;
      const n = Math.round(Math.min(40, c[2] * 0.7 * (mare ? 1 : 1.6)));
      for (let k = 0; k < n; k++) { const a = rnd() * 6.2832, u = 0.95 + rnd() * rnd() * 1.4; rocks.push([c[0] + Math.cos(a) * c[2] * u, c[1] + Math.sin(a) * c[2] * u, rp()]); }
    }
    const nBg = Math.round(260 * (mare ? 1 : 2.2) * ((2 * nearHalf / 1000) ** 2));
    for (let i = 0; i < nBg; i++) rocks.push([(rnd() * 2 - 1) * nearHalf, (rnd() * 2 - 1) * nearHalf, rp() * 0.85]);
    this.rocks = rocks; this.rgrid = new Map(); this.rcell = 32;
    rocks.forEach((r, i) => { const k = Math.floor(r[0] / this.rcell) * 65536 + Math.floor(r[1] / this.rcell); let a = this.rgrid.get(k); if (!a) this.rgrid.set(k, (a = [])); a.push(i); });
  }

  // fractal undulation (value noise, 10 octaves from 6.4 km down to 12.5 m), tapered to 0 at the field edge so the patch joins the globe
  base(x, y) {
    let s = 0, a = 55 * this.rough, f = 1 / 6400, sd = this.seed;
    for (let o = 0; o < 10; o++, a *= 0.5, f *= 2, sd += 7919) {
      const px = x * f, py = y * f, ix = Math.floor(px), iy = Math.floor(py), fx = sstep(px - ix), fy = sstep(py - iy);
      const v = (hash2(ix, iy, sd) * (1 - fx) + hash2(ix + 1, iy, sd) * fx) * (1 - fy) + (hash2(ix, iy + 1, sd) * (1 - fx) + hash2(ix + 1, iy + 1, sd) * fx) * fy;
      s += (v - 0.5) * 2 * a;
    }
    const r = Math.max(Math.abs(x), Math.abs(y)) / this.half, k = 1 - sstep(Math.min(1, Math.max(0, (r - 0.55) / 0.4)));
    return s * k;
  }
  craterH(x, y) {
    const lst = this.grid.get(Math.floor(x / this.cell) * 65536 + Math.floor(y / this.cell)); if (!lst) return 0;
    let h = 0;
    for (const i of lst) {
      const c = this.craters[i], dx = x - c[0], dy = y - c[1], R = c[2], d2 = dx * dx + dy * dy; if (d2 > 9 * R * R) continue;
      const u = Math.sqrt(d2) / R, D = c[3] * 2 * R, rim = D * (c[4] ? 0.26 : 0.17), e = (u - 1) / 0.2;
      if (u < 1) h += -D * (1 - u * u) + rim * Math.exp(-e * e);
      else h += rim * Math.exp(-e * e) + rim * 0.22 / (u * u * u);
    }
    const r = Math.max(Math.abs(x), Math.abs(y)) / this.half; return h * (1 - sstep(Math.min(1, Math.max(0, (r - 0.8) / 0.18))));
  }
  height(x, y) { return this.base(x, y) + this.craterH(x, y); }
  rockH(x, y) {                                         // boulders: half-buried domes
    const lst = this.rgrid.get(Math.floor(x / this.rcell) * 65536 + Math.floor(y / this.rcell)); if (!lst) return 0;
    let h = 0;
    for (const i of lst) { const r = this.rocks[i], dx = x - r[0], dy = y - r[1], d2 = dx * dx + dy * dy, R2 = r[2] * r[2]; if (d2 < R2) h = Math.max(h, 0.8 * Math.sqrt(R2 - d2) * 1.0); }
    return h;
  }
  ground(x, y) { return this.height(x, y) + this.rockH(x, y); }                      // what a foot or wheel actually touches
  slopeDeg(x, y, b = 2) { const gx = (this.height(x + b, y) - this.height(x - b, y)) / (2 * b), gy = (this.height(x, y + b) - this.height(x, y - b)) / (2 * b); return Math.atan(Math.hypot(gx, gy)) / DEG; }
  normal(x, y, b = 1.5) { const gx = (this.height(x + b, y) - this.height(x - b, y)) / (2 * b), gy = (this.height(x, y + b) - this.height(x, y - b)) / (2 * b); const n = Math.hypot(gx, gy, 1); return [-gx / n, -gy / n, 1 / n]; }   // (east, north, up)
}

// ------------------------------------------------------------------------------------------------
// Hazard / traversability grid centred on the site (cell = 2 m): elevation, slope, boulders, roughness, clearance
// ------------------------------------------------------------------------------------------------
export const LIM = { landSlope: 8, landRock: 0.35, roverSlope: 24, roverRock: 0.40 };
export class HazardMap {
  t: Terrain; half: number; cell: number; n: number;
  h: Float32Array; rock: Float32Array; slope: Float32Array; lslope: Float32Array; rough: Float32Array;
  /** 1 where the rover cannot drive. */
  block: Uint8Array;
  /** Metres to the nearest impassable cell (capped at 60). */
  clear: Float32Array;
  /** Landing hazard class per cell: 0 safe, 1 caution, 2 hazard. hzFoot widens it to the lander footprint. */
  hz: Uint8Array; hzFoot: Uint8Array;
  constructor(terrain, { half = 480, cell = 2 } = {}) {
    this.t = terrain; this.half = half; this.cell = cell; const n = (this.n = Math.round((2 * half) / cell)), N = n * n;
    this.h = new Float32Array(N); this.rock = new Float32Array(N); this.slope = new Float32Array(N); this.lslope = new Float32Array(N); this.rough = new Float32Array(N);
    this.block = new Uint8Array(N); this.clear = new Float32Array(N); this.hz = new Uint8Array(N);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) this.h[j * n + i] = terrain.height(this.cx(i), this.cy(j));
    for (const r of terrain.rocks) {
      if (Math.abs(r[0]) > half || Math.abs(r[1]) > half) continue;
      const i0 = Math.floor((r[0] - r[2] + half) / cell), i1 = Math.floor((r[0] + r[2] + half) / cell), j0 = Math.floor((r[1] - r[2] + half) / cell), j1 = Math.floor((r[1] + r[2] + half) / cell);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (i >= 0 && j >= 0 && i < n && j < n) { const k = j * n + i; this.rock[k] = Math.max(this.rock[k], 0.8 * r[2]); }
    }
    const H = this.h, at = (i, j) => H[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, gx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell), gy = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      this.slope[k] = Math.atan(Math.hypot(gx, gy)) / DEG;
      const b = 2, lx = (at(i + b, j) - at(i - b, j)) / (2 * b * cell), ly = (at(i, j + b) - at(i, j - b)) / (2 * b * cell);       // lander-scale (±4 m) gradient
      this.lslope[k] = Math.atan(Math.hypot(lx, ly)) / DEG;
      let mx = 0; const pl = H[k]; for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) mx = Math.max(mx, Math.abs(at(i + di, j + dj) - (pl + lx * di * cell + ly * dj * cell)));
      this.rough[k] = mx;
      this.block[k] = this.slope[k] > LIM.roverSlope || this.rock[k] >= LIM.roverRock ? 1 : 0;
      // landing hazard class: 0 safe · 1 caution · 2 hazard
      const rk = this.rock[k] >= LIM.landRock, sl = this.lslope[k];
      this.hz[k] = sl > 12 || this.rock[k] >= 0.6 || mx > 1.2 ? 2 : sl > LIM.landSlope || rk || mx > 0.55 ? 1 : 0;
    }
    // widen the hazard class to the lander footprint (±5 m): a cell is only safe when its neighbourhood is
    const hz2 = this.hz.slice(), w = Math.round(5 / cell);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let m = 0; for (let dj = -w; dj <= w; dj++) for (let di = -w; di <= w; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < n && jj < n) { const v = this.hz[jj * n + ii]; if (v > m) m = v; } } hz2[j * n + i] = m; }
    this.hzFoot = hz2;
    // clearance transform (chamfer 3-4) → metres to the nearest impassable cell
    const INF = 1e9, d = new Float32Array(N); for (let k = 0; k < N; k++) d[k] = this.block[k] ? 0 : INF;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * n + i; let v = d[k]; if (i > 0) v = Math.min(v, d[k - 1] + 3); if (j > 0) { v = Math.min(v, d[k - n] + 3); if (i > 0) v = Math.min(v, d[k - n - 1] + 4); if (i < n - 1) v = Math.min(v, d[k - n + 1] + 4); } d[k] = v; }
    for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) { const k = j * n + i; let v = d[k]; if (i < n - 1) v = Math.min(v, d[k + 1] + 3); if (j < n - 1) { v = Math.min(v, d[k + n] + 3); if (i < n - 1) v = Math.min(v, d[k + n + 1] + 4); if (i > 0) v = Math.min(v, d[k + n - 1] + 4); } d[k] = v; }
    for (let k = 0; k < N; k++) this.clear[k] = Math.min(60, (d[k] / 3) * cell);
  }
  cx(i) { return -this.half + (i + 0.5) * this.cell; }
  cy(j) { return -this.half + (j + 0.5) * this.cell; }
  ix(x) { return Math.floor((x + this.half) / this.cell); }
  iy(y) { return Math.floor((y + this.half) / this.cell); }
  inside(x, y) { return x > -this.half && x < this.half && y > -this.half && y < this.half; }
  idx(x, y) { const i = this.ix(x), j = this.iy(y); return i < 0 || j < 0 || i >= this.n || j >= this.n ? -1 : j * this.n + i; }
  // bilinear elevation (cell-centre samples)
  elev(x, y) {
    const n = this.n, fx = (x + this.half) / this.cell - 0.5, fy = (y + this.half) / this.cell - 0.5;
    const i = Math.max(0, Math.min(n - 2, Math.floor(fx))), j = Math.max(0, Math.min(n - 2, Math.floor(fy))), u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fy - j));
    const H = this.h; return (H[j * n + i] * (1 - u) + H[j * n + i + 1] * u) * (1 - v) + (H[(j + 1) * n + i] * (1 - u) + H[(j + 1) * n + i + 1] * u) * v;
  }
  // nearest cell satisfying `ok(k)` to (x, y), searching rings outward; returns [x, y] or null
  nearest(x: number, y: number, ok: (k: number) => boolean, maxR = 200): [number, number] | null {
    const i0 = this.ix(x), j0 = this.iy(y), n = this.n, R = Math.round(maxR / this.cell);
    for (let r = 0; r <= R; r++) {
      let best = null, bd = 1e18;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= n || j >= n) continue;
        if (ok(j * n + i)) { const dd = di * di + dj * dj; if (dd < bd) { bd = dd; best = [this.cx(i), this.cy(j)]; } }
      }
      if (best) return best;
    }
    return null;
  }
  // safest landing point near (x, y): cell whose whole footprint is class 0, preferring the nominal point
  safeSpot(x: number, y: number, maxR = 160): [number, number] | null { return this.nearest(x, y, (k) => this.hzFoot[k] === 0 && this.rough[k] < 0.5, maxR); }
}

// ------------------------------------------------------------------------------------------------
// Science targets: reachable, gentle spots 220-420 m from the lander, one per sector
// ------------------------------------------------------------------------------------------------
export function pickTargets(map: HazardMap, terrain: Terrain, rnd: () => number = mulberry32(terrain.seed ^ 77)): ScienceTarget[] {
  const names = ['ALPHA', 'BRAVO', 'CHARLIE'], out = [];
  for (let s = 0; s < 3; s++) {
    let found = null;
    for (let tries = 0; tries < 60 && !found; tries++) {
      const a = ((s + rnd() * 0.5 + 0.1) / 3) * Math.PI * 2 + 0.4, d = 220 + rnd() * 200, x = Math.cos(a) * d, y = Math.sin(a) * d;
      if (!map.inside(x, y)) continue; const k = map.idx(x, y);
      if (k >= 0 && !map.block[k] && map.slope[k] < 9 && map.clear[k] > 4) found = [x, y];
    }
    if (!found) found = map.nearest(Math.cos(s * 2.1) * 300, Math.sin(s * 2.1) * 300, (k) => !map.block[k] && map.clear[k] > 3, 120) || [200 * (s + 1) * 0.6, 120];
    // describe what is there
    let cr = null, bd = 1e9; for (const c of terrain.craters) { const d = Math.hypot(found[0] - c[0], found[1] - c[1]); if (c[2] > 12 && d < c[2] * 1.4 && d < bd) { bd = d; cr = c; } }
    let nr = 0; for (const r of terrain.rocks) if (Math.hypot(found[0] - r[0], found[1] - r[1]) < 40) nr++;
    const kind = cr ? (cr[4] ? 'Fresh crater rim · ejecta sample' : 'Degraded crater rim · regolith sample') : nr > 14 ? 'Boulder field · rock sample' : 'Smooth regolith · core sample';
    out.push({ id: names[s], x: found[0], y: found[1], kind });
  }
  return out;
}
