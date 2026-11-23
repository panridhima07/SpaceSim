// Small 2D pictures of catalogue parts for the palette cards. Each part is drawn from its
// real dimensions: a side view with the nose end up, or an end-on view for rings. Pure
// TypeScript, no DOM. Every coordinate is clamped to the 48-unit box.

import { noseConeProfile } from '../render/parts/profile';
import type {
  BodyTube,
  Component,
  FinSet,
  InnerTube,
  MassComponent,
  MotorRef,
  NoseCone,
  Parachute,
  Ring,
  Transition,
} from '../types';
import type { PartPreset } from './parts';

const VIEW = 48;
const MARGIN = 4;
const AVAIL = VIEW - 2 * MARGIN;
const MIN_DIM = 6;
const MID = VIEW / 2;
/** Cubic Bezier handle length for a quarter ellipse. */
const KAPPA = 0.5523;
const FILL_OPACITY = '0.22';

const ACCENT = {
  nose: '#e2552f',
  decoupler: '#d9a426',
  tube: '#9aa3ad',
  transition: '#8a9099',
  fins: '#4da3ff',
  motor: '#f0622a',
  chute: '#f0622a',
  mass: '#9aa3ad',
  ring: '#c9c5b8',
} as const;

type Pt = [number, number];

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** A coordinate rounded to 1 decimal and kept inside the box. Non-finite values become 0. */
function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return String(round1(clamp(v, 0, VIEW)));
}

/** A strictly positive dimension, or the fallback. */
function pos(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** A non-negative dimension, or 0. */
function nonneg(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function pathD(pts: Pt[], closed = true): string {
  const body = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${num(x)} ${num(y)}`).join('');
  return closed ? `${body}Z` : body;
}

/** A full circle built from two arcs, so it can sit in one path with a hole. */
function circlePath(cx: number, cy: number, r: number): string {
  const R = num(r);
  return (
    `M${num(cx - r)} ${num(cy)}A${R} ${R} 0 1 0 ${num(cx + r)} ${num(cy)}` +
    `A${R} ${R} 0 1 0 ${num(cx - r)} ${num(cy)}Z`
  );
}

function fillShape(d: string, accent: string, opacity = FILL_OPACITY): string {
  return `<path d="${d}" fill="${accent}" fill-opacity="${opacity}"/>`;
}

function strokeOnly(d: string, extra = ''): string {
  return `<path d="${d}" fill="none"${extra}/>`;
}

interface Frame {
  top: number;
  bottom: number;
  /** Drawn height and width, inside the 40-unit area. */
  h: number;
  w: number;
  /** Drawn units per metre across and along the part. */
  sx: number;
  sy: number;
}

/**
 * Fit a part of axial length L and overall width W into the box, keeping its proportion.
 * Anything thinner than MIN_DIM is widened to MIN_DIM; anything longer than the box is
 * drawn at the box height.
 */
function frame(L: number, W: number): Frame {
  const fit = Math.min(AVAIL / L, AVAIL / W);
  const h = clamp(L * fit, MIN_DIM, AVAIL);
  const w = clamp(W * fit, MIN_DIM, AVAIL);
  const top = (VIEW - h) / 2;
  return { top, bottom: top + h, h, w, sx: w / W, sy: h / L };
}

/** Height on the drawing of a point s metres aft of the fore end, kept inside the frame. */
function yAt(f: Frame, s: number): number {
  return clamp(f.top + s * f.sy, f.top, f.bottom);
}

function rectSvg(L: number, W: number, accent: string): string {
  const f = frame(L, W);
  const x0 = MID - f.w / 2;
  const x1 = MID + f.w / 2;
  return fillShape(pathD([[x0, f.top], [x1, f.top], [x1, f.bottom], [x0, f.bottom]]), accent);
}

function noseSvg(c: NoseCone): string {
  const L = pos(c.length, 0.1);
  const R = pos(c.baseRadius, 0.01);
  const f = frame(L, 2 * R);
  const prof = noseConeProfile({ ...c, length: L, baseRadius: R }, 24);
  const right = prof.map(([s, r]): Pt => [MID + nonneg(r) * f.sx, yAt(f, s)]);
  const left = right.map(([x, y]): Pt => [2 * MID - x, y]).reverse();
  return fillShape(pathD([...right, ...left]), ACCENT.nose);
}

function tubeSvg(c: BodyTube): string {
  const body = rectSvg(pos(c.length, 0.1), 2 * pos(c.outerRadius, 0.01), ACCENT.tube);
  if (!c.isDecoupler) return body;
  const f = frame(pos(c.length, 0.1), 2 * pos(c.outerRadius, 0.01));
  const mid = (f.top + f.bottom) / 2;
  const x0 = MID - f.w / 2;
  const x1 = MID + f.w / 2;
  const seam = strokeOnly(
    `M${num(x0)} ${num(mid)}H${num(x1)}`,
    ' stroke-width="1" stroke-dasharray="2 1.5"',
  );
  return rectSvg(pos(c.length, 0.1), 2 * pos(c.outerRadius, 0.01), ACCENT.decoupler) + seam;
}

function transitionSvg(c: Transition): string {
  const L = pos(c.length, 0.03);
  let rf = nonneg(c.foreRadius);
  let ra = nonneg(c.aftRadius);
  if (rf + ra <= 0) {
    rf = 0.01;
    ra = 0.01;
  }
  const f = frame(L, 2 * Math.max(rf, ra));
  const h1 = rf * f.sx;
  const h2 = ra * f.sx;
  return fillShape(
    pathD([[MID - h1, f.top], [MID + h1, f.top], [MID + h2, f.bottom], [MID - h2, f.bottom]]),
    ACCENT.transition,
  );
}

function finsSvg(c: FinSet): string {
  // One fin beside a strip of body tube: drawing the whole fin can at card size
  // squashes every fin into the same flat blob.
  const root = pos(c.rootChord, pos(c.length, 0.05));
  const span = pos(c.span, 0.03);
  const tip = nonneg(c.tipChord);
  const sweep = nonneg(c.sweepLength);
  const f = frame(Math.max(root, sweep + tip), span);
  const STRIP = 6;
  const x0 = MID - (f.w + STRIP) / 2;
  const xr = x0 + STRIP; // where the fin leaves the body
  const xt = xr + f.w; // fin tip
  const rootBottom = yAt(f, root);

  let fin: string;
  if (c.finShape === 'elliptical') {
    const hh = (rootBottom - f.top) / 2;
    const mid = f.top + hh;
    const a = f.w * KAPPA;
    fin =
      `M${num(xr)} ${num(f.top)}` +
      `C${num(xr + a)} ${num(f.top)} ${num(xt)} ${num(mid - hh * KAPPA)} ${num(xt)} ${num(mid)}` +
      `C${num(xt)} ${num(mid + hh * KAPPA)} ${num(xr + a)} ${num(rootBottom)} ${num(xr)} ${num(rootBottom)}Z`;
  } else {
    fin = pathD([
      [xr, f.top],
      [xt, yAt(f, sweep)],
      [xt, yAt(f, sweep + tip)],
      [xr, rootBottom],
    ]);
  }

  const strip = pathD([
    [x0, MARGIN],
    [xr, MARGIN],
    [xr, VIEW - MARGIN],
    [x0, VIEW - MARGIN],
  ]);
  let out = fillShape(strip, ACCENT.fins, '0.1') + fillShape(fin, ACCENT.fins);
  if (c.count === 4) {
    // The fin facing the viewer, seen edge-on.
    out += strokeOnly(`M${num(x0 + STRIP / 2)} ${num(f.top)}V${num(rootBottom)}`, ' stroke-width="0.8"');
  }
  return out;
}

function motorSvg(m: MotorRef, c: InnerTube): string {
  const f = frame(pos(m.length, pos(c.length, 0.07)), pos(m.diameter, 2 * pos(c.outerRadius, 0.01)));
  const nozzleH = Math.min(4, f.h * 0.15);
  const caseBottom = f.bottom - nozzleH;
  const x0 = MID - f.w / 2;
  const x1 = MID + f.w / 2;
  const caseD = pathD([[x0, f.top], [x1, f.top], [x1, caseBottom], [x0, caseBottom]]);
  const nozzleD = pathD([
    [MID - f.w * 0.4, caseBottom],
    [MID + f.w * 0.4, caseBottom],
    [MID + f.w * 0.2, f.bottom],
    [MID - f.w * 0.2, f.bottom],
  ]);
  // Only a single capital letter from the designation is ever printed.
  const first = String(m.designation ?? '').charAt(0);
  const letter = /^[A-Z]$/.test(first) ? first : '';
  const label = letter
    ? `<text x="${num(MID)}" y="${num((f.top + caseBottom) / 2 + 2.5)}" font-family="sans-serif" ` +
      `font-size="${round1(clamp(f.w * 0.7, 4, 8))}" font-weight="700" text-anchor="middle" ` +
      `fill="currentColor" stroke="none">${letter}</text>`
    : '';
  return fillShape(caseD + nozzleD, ACCENT.motor) + label;
}

function podsSvg(c: InnerTube): string {
  const outer = pos(c.outerRadius, 0.0094);
  const off = pos(c.radialOffset, outer);
  const f = frame(pos(c.length, 0.1), 2 * (off + outer));
  const pr = Math.max(1, outer * f.sx);
  const dx = off * f.sx;
  const tipH = Math.min(f.h * 0.25, pr * 2);
  let d = '';
  for (const pc of [MID - dx, MID + dx]) {
    d += pathD([
      [pc - pr, f.top + tipH],
      [pc, f.top],
      [pc + pr, f.top + tipH],
      [pc + pr, f.bottom],
      [pc - pr, f.bottom],
    ]);
  }
  return fillShape(d, ACCENT.motor);
}

function streamerSvg(): string {
  const n = 12;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const y = 5 + 38 * u;
    const x = MID + 3.5 * Math.sin(u * Math.PI * 3);
    const hw = 1.5 + 1.5 * u; // the ribbon flares toward its tail
    left.push([x - hw, y]);
    right.push([x + hw, y]);
  }
  return fillShape(pathD([...left, ...[...right].reverse()]), ACCENT.chute);
}

function chuteSvg(c: Parachute): string {
  if (/streamer/i.test(String(c.name ?? ''))) return streamerSvg();
  const d = pos(c.diameter, 0.3);
  // 0.18 m is the smallest canopy in the catalogue, 0.9 m the largest.
  const t = clamp((d - 0.18) / (0.9 - 0.18), 0, 1);
  const cw = 14 + 24 * t;
  const hw = cw / 2;
  const top = 5;
  const domeH = cw * 0.55;
  const base = top + domeH;
  const apex = 43;
  const canopy =
    `M${num(MID - hw)} ${num(base)}` +
    `C${num(MID - hw)} ${num(top + domeH * 0.25)} ${num(MID - hw * 0.45)} ${num(top)} ${num(MID)} ${num(top)}` +
    `C${num(MID + hw * 0.45)} ${num(top)} ${num(MID + hw)} ${num(top + domeH * 0.25)} ${num(MID + hw)} ${num(base)}Z`;
  let lines = '';
  for (const k of [-1, -0.5, 0, 0.5, 1]) {
    lines += `M${num(MID + hw * k)} ${num(base)}L${num(MID)} ${num(apex)}`;
  }
  return fillShape(canopy, ACCENT.chute) + strokeOnly(lines, ' stroke-width="0.7"');
}

function massSvg(c: MassComponent): string {
  const name = String(c.name ?? '');
  if (/camera/i.test(name)) {
    const body = pathD([[8, 15], [40, 15], [40, 35], [8, 35]]) + pathD([[17, 11], [27, 11], [27, 15], [17, 15]]);
    return (
      fillShape(body, ACCENT.mass) +
      strokeOnly(circlePath(MID, 25, 6)) +
      strokeOnly(circlePath(MID, 25, 2.5))
    );
  }
  if (/computer/i.test(name)) {
    const chip = fillShape(pathD([[14, 14], [34, 14], [34, 34], [14, 34]]), ACCENT.mass);
    const die = strokeOnly(pathD([[19, 19], [29, 19], [29, 29], [19, 29]]));
    const pins = [19, 24, 29]
      .map((p) => `M${num(p)} 14V10M${num(p)} 34V38M14 ${num(p)}H10M34 ${num(p)}H38`)
      .join('');
    return chip + die + strokeOnly(pins);
  }
  // Balance weight: a trapezoid with a handle loop.
  const weight = fillShape(pathD([[MID - 6, 20], [MID + 6, 20], [MID + 12, 40], [MID - 12, 40]]), ACCENT.mass);
  const handle = strokeOnly(
    `M${num(MID - 4)} 20V15C${num(MID - 4)} 10 ${num(MID + 4)} 10 ${num(MID + 4)} 15V20`,
  );
  return weight + handle;
}

function lugSvg(c: Ring): string {
  const f = frame(pos(c.length, 0.03), pos(2 * c.outerRadius, 0.004));
  const gap = 4;
  const lineX = MID - (f.w + gap) / 2;
  const tubeX = lineX + gap;
  const tube = fillShape(
    pathD([[tubeX, f.top], [tubeX + f.w, f.top], [tubeX + f.w, f.bottom], [tubeX, f.bottom]]),
    ACCENT.ring,
  );
  const bodyLine = strokeOnly(`M${num(lineX)} ${num(MARGIN)}V${num(VIEW - MARGIN)}`, ' stroke-width="1.2"');
  return tube + bodyLine;
}

function ringSvg(c: Ring): string {
  if (c.external) return lugSvg(c);
  // End-on view: the outer circle is drawn at a fixed size, the inner one in true proportion.
  const Ro = pos(c.outerRadius, 0.01);
  const Ri = clamp(nonneg(c.innerRadius), 0, Ro);
  const R = 20;
  const r = (Ri / Ro) * R;
  if (r < 0.5) {
    const cross = strokeOnly(
      `M${num(MID - 5)} ${num(MID)}H${num(MID + 5)}M${num(MID)} ${num(MID - 5)}V${num(MID + 5)}`,
      ' stroke-width="1"',
    );
    return fillShape(circlePath(MID, MID, R), ACCENT.ring, '0.5') + cross;
  }
  return (
    `<path d="${circlePath(MID, MID, R)}${circlePath(MID, MID, r)}" fill="${ACCENT.ring}" ` +
    `fill-opacity="${FILL_OPACITY}" fill-rule="evenodd"/>`
  );
}

function draw(c: Component): string {
  switch (c.kind) {
    case 'nosecone':
      return noseSvg(c);
    case 'bodytube':
      return tubeSvg(c);
    case 'transition':
      return transitionSvg(c);
    case 'finset':
      return finsSvg(c);
    case 'innertube':
      if (c.motor) return motorSvg(c.motor, c);
      if ((c.radialCount ?? 0) >= 2) return podsSvg(c);
      return rectSvg(pos(c.length, 0.1), 2 * pos(c.outerRadius, 0.01), ACCENT.tube);
    case 'parachute':
      return chuteSvg(c);
    case 'mass':
      return massSvg(c);
    case 'ring':
      return ringSvg(c);
    default:
      return strokeOnly('M8 8H40V40H8Z', ' stroke-dasharray="2 2"');
  }
}

/**
 * A complete `<svg viewBox="0 0 48 48" ...>` string picturing this catalogue part.
 * Side view with the nose end up (rings are drawn end-on). Stroke is currentColor.
 */
export function partThumbSvg(preset: PartPreset, size = 40): string {
  const px = Number.isFinite(size) && size > 0 ? round1(size) : 40;
  let body: string;
  try {
    body = draw(preset.create());
  } catch {
    body = strokeOnly('M8 8H40V40H8Z', ' stroke-dasharray="2 2"');
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${px}" height="${px}" ` +
    `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" ` +
    `stroke-linecap="round" aria-hidden="true">${body}</svg>`
  );
}
