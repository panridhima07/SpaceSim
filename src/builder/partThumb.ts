// Small 2D pictures of catalogue parts for the palette cards. Each part is drawn from its
// real dimensions: a side view with the nose end up, or an end-on view for rings. Pure
// TypeScript, no DOM. Every coordinate is clamped to the 48-unit box. Round bodies are
// shaded with plain overlapping paths (base fill, white highlight strip, black shadow
// strip): no defs, gradients or ids, so many thumbs can share one page.

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
  motor: '#d9803a',
  nozzle: '#e6dfcf',
  pod: '#c3c9d1',
  chute: '#f0622a',
  mass: '#9aa3ad',
  metal: '#7c8591',
  pcb: '#3fae5a',
  part: '#f5c542',
  ring: '#c9c5b8',
  wood: '#cfa972',
} as const;

const WHITE = '#fff';
const BLACK = '#000';
const JOINT = ' stroke-width="0.8" stroke-opacity="0.7"';

type Pt = [number, number];
/** Half-width and height pairs, fore to aft, of a body of revolution seen from the side. */
type Prof = Array<[number, number]>;

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

/** A flat shading or highlight layer: no outline, drawn over a base fill. */
function overlay(d: string, color: string, opacity: string): string {
  return `<path d="${d}" fill="${color}" fill-opacity="${opacity}" stroke="none"/>`;
}

/** The part of a round body between two fractions (-1 = left edge, 1 = right edge) of its half-width. */
function band(prof: Prof, k0: number, k1: number, cx = MID): string {
  const a = prof.map(([h, y]): Pt => [cx + k0 * h, y]);
  const b = prof.map(([h, y]): Pt => [cx + k1 * h, y]).reverse();
  return pathD([...a, ...b]);
}

/** A round body shaded to read as a cylinder: base fill, left highlight strip, right shadow strip. */
function cylinder(prof: Prof, accent: string, base = '0.5', cx = MID): string {
  return (
    fillShape(band(prof, -1, 1, cx), accent, base) +
    overlay(band(prof, -0.7, -0.35, cx), WHITE, '0.3') +
    overlay(band(prof, 0.6, 1, cx), BLACK, '0.25')
  );
}

/** Half-width of a profile at height y. */
function hwAt(prof: Prof, y: number): number {
  for (let i = 1; i < prof.length; i++) {
    const [h0, y0] = prof[i - 1];
    const [h1, y1] = prof[i];
    if (y <= y1 || i === prof.length - 1) {
      const t = y1 > y0 ? clamp((y - y0) / (y1 - y0), 0, 1) : 1;
      return h0 + (h1 - h0) * t;
    }
  }
  return prof.length ? prof[0][0] : 0;
}

/** Thin joint lines across a round body at the given heights. */
function joints(prof: Prof, ys: number[]): string {
  const d = ys
    .map((y) => {
      const h = hwAt(prof, y);
      return `M${num(MID - h)} ${num(y)}H${num(MID + h)}`;
    })
    .join('');
  return strokeOnly(d, JOINT);
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
  return cylinder([[f.w / 2, f.top], [f.w / 2, f.bottom]], accent);
}

function noseSvg(c: NoseCone): string {
  const L = pos(c.length, 0.1);
  const R = pos(c.baseRadius, 0.01);
  const f = frame(L, 2 * R);
  const prof: Prof = noseConeProfile({ ...c, length: L, baseRadius: R }, 14).map(
    ([s, r]): [number, number] => [nonneg(r) * f.sx, yAt(f, s)],
  );
  // Shoulder joint near the base.
  const joint = f.h > 10 ? joints(prof, [f.bottom - clamp(f.h * 0.14, 1.5, 4)]) : '';
  return cylinder(prof, ACCENT.nose) + joint;
}

function tubeSvg(c: BodyTube): string {
  const f = frame(pos(c.length, 0.1), 2 * pos(c.outerRadius, 0.01));
  const hw = f.w / 2;
  const prof: Prof = [[hw, f.top], [hw, f.bottom]];
  if (!c.isDecoupler) {
    const j = clamp(f.h * 0.1, 1.8, 3);
    return cylinder(prof, ACCENT.tube) + (f.h > 10 ? joints(prof, [f.top + j, f.bottom - j]) : '');
  }
  const mid = (f.top + f.bottom) / 2;
  const off = Math.min(3, f.h * 0.25);
  const seam = strokeOnly(
    `M${num(MID - hw)} ${num(mid)}H${num(MID + hw)}`,
    ' stroke-width="1" stroke-dasharray="2 1.5"',
  );
  const bolts =
    `<path d="${circlePath(MID, mid - off, 0.9)}${circlePath(MID, mid + off, 0.9)}" ` +
    `fill="currentColor" stroke="none"/>`;
  return cylinder(prof, ACCENT.decoupler, '0.55') + seam + bolts;
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
  const prof: Prof = [[rf * f.sx, f.top], [ra * f.sx, f.bottom]];
  const j = clamp(f.h * 0.1, 1.8, 3);
  return cylinder(prof, ACCENT.transition) + (f.h > 10 ? joints(prof, [f.top + j, f.bottom - j]) : '');
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
  let lead: string; // lighter strip along the leading edge
  if (c.finShape === 'elliptical') {
    const hh = (rootBottom - f.top) / 2;
    const mid = f.top + hh;
    const a = f.w * KAPPA;
    const arc =
      `M${num(xr)} ${num(f.top)}` +
      `C${num(xr + a)} ${num(f.top)} ${num(xt)} ${num(mid - hh * KAPPA)} ${num(xt)} ${num(mid)}`;
    fin =
      arc +
      `C${num(xt)} ${num(mid + hh * KAPPA)} ${num(xr + a)} ${num(rootBottom)} ${num(xr)} ${num(rootBottom)}Z`;
    lead = `${arc}L${num(xr)} ${num(f.top + hh * 0.45)}Z`;
  } else {
    const ys = yAt(f, sweep);
    const ye = yAt(f, sweep + tip);
    fin = pathD([[xr, f.top], [xt, ys], [xt, ye], [xr, rootBottom]]);
    lead = pathD([
      [xr, f.top],
      [xt, ys],
      [xt, Math.min(ys + 2.2, ye)],
      [xr, Math.min(f.top + 3, rootBottom)],
    ]);
  }

  const strip = pathD([
    [x0, MARGIN],
    [xr, MARGIN],
    [xr, VIEW - MARGIN],
    [x0, VIEW - MARGIN],
  ]);
  let out =
    fillShape(strip, ACCENT.fins, '0.2') +
    fillShape(fin, ACCENT.fins, '0.55') +
    overlay(lead, WHITE, '0.3') +
    strokeOnly(`M${num(xr)} ${num(f.top)}V${num(rootBottom)}`, ' stroke-width="1.2"');
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
  const hw = f.w / 2;
  const caseSvg = cylinder([[hw, f.top], [hw, caseBottom]], ACCENT.motor, '0.55');
  const nozzle = fillShape(
    pathD([
      [MID - f.w * 0.4, caseBottom],
      [MID + f.w * 0.4, caseBottom],
      [MID + f.w * 0.2, f.bottom],
      [MID - f.w * 0.2, f.bottom],
    ]),
    ACCENT.nozzle,
    '0.6',
  );
  // Dark throat notch at the bottom of the nozzle.
  const t = f.w * 0.12;
  const yt = f.bottom - nozzleH * 0.6;
  const throat = overlay(pathD([[MID - t, yt], [MID + t, yt], [MID + t, f.bottom], [MID - t, f.bottom]]), BLACK, '0.55');
  // Only a single capital letter from the designation is ever printed.
  const first = String(m.designation ?? '').charAt(0);
  const letter = /^[A-Z]$/.test(first) ? first : '';
  let label = '';
  if (letter) {
    const fs = round1(clamp(f.w * 0.7, 4, 8));
    const cy = (f.top + caseBottom) / 2;
    const hb = Math.min(fs * 0.65, (caseBottom - f.top) / 2);
    label =
      overlay(pathD([[MID - hw, cy - hb], [MID + hw, cy - hb], [MID + hw, cy + hb], [MID - hw, cy + hb]]), BLACK, '0.35') +
      `<text x="${num(MID)}" y="${num(cy + 2.5)}" font-family="sans-serif" ` +
      `font-size="${fs}" font-weight="700" text-anchor="middle" ` +
      `fill="currentColor" stroke="none">${letter}</text>`;
  }
  return caseSvg + label + nozzle + throat;
}

function podsSvg(c: InnerTube): string {
  const outer = pos(c.outerRadius, 0.0094);
  const off = pos(c.radialOffset, outer);
  const f = frame(pos(c.length, 0.1), 2 * (off + outer));
  const pr = Math.max(1, outer * f.sx);
  const dx = off * f.sx;
  const tipH = Math.min(f.h * 0.25, pr * 2);
  const bot = f.bottom - Math.min(2.5, f.h * 0.1);
  const yt = f.top + tipH;
  let body = '';
  let tips = '';
  let hl = '';
  let sh = '';
  let stubs = '';
  for (const pc of [MID - dx, MID + dx]) {
    body += pathD([[pc - pr, yt], [pc, f.top], [pc + pr, yt], [pc + pr, bot], [pc - pr, bot]]);
    tips += pathD([[pc - pr, yt], [pc, f.top], [pc + pr, yt]]);
    hl += pathD([[pc - 0.7 * pr, yt], [pc - 0.35 * pr, yt], [pc - 0.35 * pr, bot], [pc - 0.7 * pr, bot]]);
    sh += pathD([[pc + 0.6 * pr, yt], [pc + pr, yt], [pc + pr, bot], [pc + 0.6 * pr, bot]]);
    stubs += pathD([[pc - 0.55 * pr, bot], [pc + 0.55 * pr, bot], [pc + 0.4 * pr, f.bottom], [pc - 0.4 * pr, f.bottom]]);
  }
  return (
    fillShape(body, ACCENT.pod, '0.5') +
    overlay(tips, ACCENT.nose, '0.85') +
    overlay(hl, WHITE, '0.3') +
    overlay(sh, BLACK, '0.25') +
    fillShape(stubs, ACCENT.nozzle, '0.7')
  );
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
  // Folds of two segments each, alternately lit and shaded.
  let light = '';
  let dark = '';
  for (let i = 0; i < n; i += 2) {
    const fold = pathD([left[i], left[i + 1], left[i + 2], right[i + 2], right[i + 1], right[i]]);
    if (i % 4 === 0) light += fold;
    else dark += fold;
  }
  return (
    fillShape(pathD([...left, ...[...right].reverse()]), ACCENT.chute, '0.5') +
    overlay(light, WHITE, '0.3') +
    overlay(dark, BLACK, '0.25')
  );
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
  // Four gores between five meridians, alternately lit and shaded.
  const ks = [-1, -0.5, 0, 0.5, 1];
  const ctl = (k: number): string => `${num(MID + hw * k * 0.85)} ${num(top + domeH * 0.1)}`;
  let light = '';
  let dark = '';
  let lines = '';
  for (let i = 0; i < 4; i++) {
    const gore =
      `M${num(MID + hw * ks[i])} ${num(base)}Q${ctl(ks[i])} ${num(MID)} ${num(top)}` +
      `Q${ctl(ks[i + 1])} ${num(MID + hw * ks[i + 1])} ${num(base)}Z`;
    if (i % 2 === 0) light += gore;
    else dark += gore;
  }
  for (const k of ks) lines += `M${num(MID + hw * k)} ${num(base)}L${num(MID)} ${num(apex)}`;
  return (
    fillShape(canopy, ACCENT.chute, '0.5') +
    overlay(light, WHITE, '0.25') +
    overlay(dark, BLACK, '0.2') +
    strokeOnly(lines, ' stroke-width="0.7"') +
    `<path d="${circlePath(MID, apex, 1.2)}" fill="currentColor" stroke="none"/>`
  );
}

function massSvg(c: MassComponent): string {
  const name = String(c.name ?? '');
  if (/camera/i.test(name)) {
    const body = pathD([[8, 15], [40, 15], [40, 35], [8, 35]]) + pathD([[17, 11], [27, 11], [27, 15], [17, 15]]);
    return (
      fillShape(body, ACCENT.mass, '0.45') +
      fillShape(circlePath(MID, 25, 7), ACCENT.mass, '0.7') +
      overlay(circlePath(MID, 25, 4.2), '#0a1020', '0.9') +
      overlay(circlePath(MID - 1.6, 23.4, 1.1), WHITE, '0.8') +
      overlay(pathD([[31, 12.5], [36, 12.5], [36, 15], [31, 15]]), ACCENT.nose, '0.9')
    );
  }
  if (/computer/i.test(name)) {
    const board = fillShape(pathD([[14, 14], [34, 14], [34, 34], [14, 34]]), ACCENT.pcb, '0.6');
    const chip = overlay(pathD([[20, 20], [28, 20], [28, 28], [20, 28]]), BLACK, '0.75');
    const part = overlay(pathD([[16, 16], [19, 16], [19, 19], [16, 19]]), ACCENT.part, '0.95');
    const pins = [19, 24, 29]
      .map((p) => `M${num(p)} 14V10M${num(p)} 34V38M14 ${num(p)}H10M34 ${num(p)}H38`)
      .join('');
    return board + chip + part + strokeOnly(pins, ' stroke-width="1"');
  }
  // Balance weight: a darker metal trapezoid with a handle loop.
  const weight = cylinder([[6, 20], [12, 40]], ACCENT.metal, '0.8');
  const handle = strokeOnly(
    `M${num(MID - 4)} 20V15C${num(MID - 4)} 10 ${num(MID + 4)} 10 ${num(MID + 4)} 15V20`,
  );
  return weight + handle;
}

function lugSvg(c: Ring): string {
  const f = frame(pos(c.length, 0.03), pos(2 * c.outerRadius, 0.004));
  const gap = 4;
  const lineX = MID - (f.w + gap) / 2;
  const hw = f.w / 2;
  const cx = lineX + gap + hw;
  const tube = cylinder([[hw, f.top], [hw, f.bottom]], ACCENT.ring, '0.5', cx);
  // Dark open ends.
  const ry = 1.2;
  const cap = (y: number): string =>
    `M${num(cx - hw)} ${num(y)}A${num(hw)} ${ry} 0 0 1 ${num(cx + hw)} ${num(y)}` +
    `A${num(hw)} ${ry} 0 0 1 ${num(cx - hw)} ${num(y)}Z`;
  const ends = overlay(cap(f.top) + cap(f.bottom), BLACK, '0.55');
  const bodyLine = strokeOnly(`M${num(lineX)} ${num(MARGIN)}V${num(VIEW - MARGIN)}`, ' stroke-width="1.2"');
  return tube + ends + bodyLine;
}

function ringSvg(c: Ring): string {
  if (c.external) return lugSvg(c);
  // End-on view: the outer circle is drawn at a fixed size, the inner one in true proportion.
  const Ro = pos(c.outerRadius, 0.01);
  const Ri = clamp(nonneg(c.innerRadius), 0, Ro);
  const R = 20;
  const r = (Ri / Ro) * R;
  // Darker rim line just inside the outer edge.
  const rimR = R - Math.min(2.2, Math.max(0, R - r) / 3);
  const rim = strokeOnly(circlePath(MID, MID, rimR), ' stroke="#000" stroke-opacity="0.45" stroke-width="1"');
  if (r < 0.5) {
    // Solid bulkhead with a small eyebolt ring in the centre.
    return (
      fillShape(circlePath(MID, MID, R), ACCENT.wood, '0.6') +
      rim +
      strokeOnly(circlePath(MID, MID, 2.6), ' stroke-width="1.2"')
    );
  }
  return (
    `<path d="${circlePath(MID, MID, R)}${circlePath(MID, MID, r)}" fill="${ACCENT.wood}" ` +
    `fill-opacity="0.6" fill-rule="evenodd"/>` +
    rim
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
