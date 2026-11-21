// @ts-nocheck
// Ported from the ASTRA Spaceflight prototype. The numeric code below is unchanged from the
// tested original, so its bodies are not type-checked; the declared class fields and the
// tests in this folder are the contract. Type the internals before changing the maths.
// Rover navigation: A* over the hazard grid with three cost models (shortest / balanced / safest), any-angle string pulling,
// and honest route metrics (length, slope, energy, time, risk) computed by walking the final polyline over the same terrain.
// Pure module — used by the game and by the tests.
import { LIM, type HazardMap } from './terrain';

export type RouteMode = 'SHORTEST' | 'BALANCED' | 'SAFEST';
export type Point = [number, number];
export interface RouteStats {
  /** m */ length: number; /** deg */ maxSlope: number; /** deg */ meanSlope: number;
  energyWh: number; /** s */ time: number; /** 0..100 */ risk: number; /** m */ climb: number; /** m */ minClear: number;
  waypoints: number;
}
export type Route =
  | ({ ok: true; mode: RouteMode; pts: Point[]; expanded: number; adjusted: boolean } & RouteStats)
  | { ok: false; mode: RouteMode; reason: string; expanded?: number };
export const MODES: RouteMode[] = ['SHORTEST', 'BALANCED', 'SAFEST'];
export const ROVER = { mass: 520, wheelR: 0.42, vNom: 3.0, vMin: 0.6, crr: 0.12, eff: 0.7, pBase: 160, battery: 400, g: 1.62 };   // kg, m, m/s, –, –, W, Wh, m/s²
const SQ2 = Math.SQRT2, DEG = Math.PI / 180;

// cost multiplier (≥ 1) for entering a cell; Infinity when the rover cannot go there
export function cellCost(map: HazardMap, k: number, mode: RouteMode): number {
  if (map.block[k]) return Infinity;
  if (mode === 'SHORTEST') return 1;
  const s = map.slope[k], cl = map.clear[k], rg = map.rough[k];
  if (mode === 'BALANCED') return 1 + 0.05 * s + 0.9 * (s / 14) ** 2 + 0.8 * rg + 1.2 * Math.exp(-cl / 3);
  return 1 + 0.14 * s + 3.2 * (s / 11) ** 2 + 2.2 * rg + 9 * Math.exp(-cl / 7);                                       // SAFEST: keep away from slopes and hazards
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) { const K = this.k, V = this.v; let i = K.length; K.push(key); V.push(val); while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; } K[i] = key; V[i] = val; }
  pop() {
    const K = this.k, V = this.v, top = V[0], lk = K.pop(), lv = V.pop(); const n = K.length;
    if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && K[c + 1] < K[c]) c++; if (K[c] >= lk) break; K[i] = K[c]; V[i] = V[c]; i = c; } K[i] = lk; V[i] = lv; }
    return top;
  }
}

// straight-line cost over the grid between two points (Bresenham-style sampling), Infinity if blocked
function lineCost(map, mode, x0, y0, x1, y1) {
  const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L / (map.cell * 0.5))); let c = 0;
  for (let s = 0; s <= n; s++) { const u = s / n, k = map.idx(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u); if (k < 0) return Infinity; const m = cellCost(map, k, mode); if (!Number.isFinite(m)) return Infinity; c += m; }
  return (c / (n + 1)) * L;
}

export function planRoute(map: HazardMap, start: Point, goal: Point, mode: RouteMode = 'BALANCED'): Route {
  const n = map.n, N = n * n, cell = map.cell;
  const free = (k) => !map.block[k];
  const sIdx = map.idx(start[0], start[1]), gIdx = map.idx(goal[0], goal[1]);
  if (sIdx < 0 || gIdx < 0) return { ok: false, mode, reason: 'outside mapped area' };
  const sFix = free(sIdx) ? start : map.nearest(start[0], start[1], free, 30), gFix = free(gIdx) ? goal : map.nearest(goal[0], goal[1], free, 40);
  if (!sFix || !gFix) return { ok: false, mode, reason: 'no free cell near the endpoint' };
  const s = map.idx(sFix[0], sFix[1]), g = map.idx(gFix[0], gFix[1]), gi = g % n, gj = (g / n) | 0;
  const gS = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const heap = new Heap(); gS[s] = 0; heap.push(0, s);
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQ2], [1, -1, SQ2], [-1, 1, SQ2], [-1, -1, SQ2]];
  let expanded = 0;
  while (heap.size) {
    const k = heap.pop(); if (closed[k]) continue; closed[k] = 1; expanded++;
    if (k === g) break;
    const i = k % n, j = (k / n) | 0;
    for (const [di, dj, w] of NB) {
      const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const q = jj * n + ii; if (closed[q]) continue; const m = cellCost(map, q, mode); if (!Number.isFinite(m)) continue;
      if (di && dj && (map.block[j * n + ii] || map.block[jj * n + i])) continue;                         // no cutting corners through obstacles
      const mm = 0.5 * (m + cellCost(map, k, mode)), ng = gS[k] + w * cell * mm;
      if (ng < gS[q]) { gS[q] = ng; from[q] = k; const dx = Math.abs(ii - gi), dy = Math.abs(jj - gj); heap.push(ng + cell * (Math.max(dx, dy) + (SQ2 - 1) * Math.min(dx, dy)), q); }
    }
  }
  if (!closed[g]) return { ok: false, mode, reason: 'no traversable route', expanded };
  let cells = []; for (let k = g; k !== -1; k = from[k]) cells.push(k); cells.reverse();
  let pts = cells.map((k) => [map.cx(k % n), map.cy((k / n) | 0)]);
  pts[0] = [sFix[0], sFix[1]]; pts[pts.length - 1] = [gFix[0], gFix[1]];
  // any-angle string pulling: take a straight shortcut only when it is no more expensive (under THIS mode's cost) than the grid path it replaces
  const seg = (a, b) => { let c = 0; for (let q = a; q < b; q++) c += Math.hypot(pts[q + 1][0] - pts[q][0], pts[q + 1][1] - pts[q][1]) * 0.5 * (cellCost(map, map.idx(pts[q][0], pts[q][1]), mode) + cellCost(map, map.idx(pts[q + 1][0], pts[q + 1][1]), mode)); return c; };
  const out = [pts[0]]; let a = 0;
  while (a < pts.length - 1) {
    let best = a + 1;
    for (let b = pts.length - 1; b > a + 1; b--) { const lc = lineCost(map, mode, pts[a][0], pts[a][1], pts[b][0], pts[b][1]); if (lc <= seg(a, b) * 1.0001) { best = b; break; } }
    out.push(pts[best]); a = best;
  }
  return { ok: true, mode, pts: out, expanded, adjusted: sFix !== start || gFix !== goal, ...routeStats(map, out) };
}

// walk the polyline every metre and accumulate length, slope, energy, time and risk
export function routeStats(map: HazardMap, pts: Point[]): RouteStats {
  let len = 0, maxS = 0, sumS = 0, cnt = 0, E = 0, T = 0, risk = 0, climb = 0, minClear = 60;
  const R = ROVER, mg = R.mass * R.g;
  for (let q = 0; q + 1 < pts.length; q++) {
    const [x0, y0] = pts[q], [x1, y1] = pts[q + 1], L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L)); let prevH = map.elev(x0, y0);
    for (let s = 1; s <= n; s++) {
      const u = s / n, x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u, k = map.idx(x, y), d = L / n; if (k < 0) continue;
      const sl = map.slope[k], h = map.elev(x, y), dh = h - prevH; prevH = h;
      const v = Math.max(R.vMin, R.vNom * (1 - (sl / 32) ** 2)), th = Math.atan2(dh, d);
      const F = mg * (Math.max(0, Math.sin(th)) + R.crr * Math.cos(th)); E += (F * d) / R.eff; T += d / v; len += d; sumS += sl; cnt++; maxS = Math.max(maxS, sl);
      if (dh > 0) climb += dh; minClear = Math.min(minClear, map.clear[k]);
      risk += (Math.min(1, sl / 24) * 0.6 + (map.clear[k] < 5 ? (1 - map.clear[k] / 5) * 0.4 : 0)) * d;
    }
  }
  E += R.pBase * T;
  return { length: len, maxSlope: maxS, meanSlope: cnt ? sumS / cnt : 0, energyWh: E / 3600, time: T, risk: len ? (risk / len) * 100 : 0, climb, minClear, waypoints: pts.length };
}

export function planAll(map: HazardMap, start: Point, goal: Point): Route[] { return MODES.map((m) => planRoute(map, start, goal, m)); }

// position + heading + speed along a polyline (driving simulation): s = distance travelled (m)
export class RouteFollower {
  pts: Point[]; cum: number[]; total: number;
  constructor(pts) {
    this.pts = pts; this.cum = [0]; for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.total = this.cum[this.cum.length - 1];
  }
  at(s) {
    s = Math.max(0, Math.min(this.total, s)); let i = 1; while (i < this.cum.length - 1 && this.cum[i] < s) i++;
    const a = this.pts[i - 1], b = this.pts[i], L = this.cum[i] - this.cum[i - 1] || 1, u = (s - this.cum[i - 1]) / L;
    return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, heading: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
}
