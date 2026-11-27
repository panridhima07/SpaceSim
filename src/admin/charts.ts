// Inline-SVG line charts and HTML bar lists for the admin dashboard. No library.
// Text is always set with textContent / setAttribute, never innerHTML.

export interface Series {
  label: string;
  color: string;
  values: number[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 640;
const H = 220;
const PAD = { left: 44, right: 12, top: 12, bottom: 26 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
/** Dots are drawn only when the chart has this many points or fewer. */
const DOT_LIMIT = 31;
/** Chart text in viewBox units; 16 keeps labels near 9 px on a 360 px phone (the viewBox is 640 wide). */
const LABEL_SIZE = 16;

function svgNode<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function svgText(content: string, attrs: Record<string, string | number>): SVGTextElement {
  const node = svgNode('text', attrs);
  node.textContent = content;
  return node;
}

/** Smallest of 1, 2, 5 or 10 times a power of ten that is at least n (never below 1). */
function niceMax(n: number): number {
  if (!(n > 1)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= n) return step * magnitude;
  }
  return 10 * magnitude;
}

function formatTick(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function lineChart(title: string, labels: string[], series: Series[]): SVGSVGElement {
  const svg = svgNode('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%',
    role: 'img',
    'aria-label': title,
    class: 'admin-chart',
  });

  const count = labels.length;
  const peak = Math.max(0, ...series.flatMap((s) => s.values));
  // Counts never get a half-step tick (0.5 on a 0-1 axis): the axis runs at least to 2.
  const top = Math.max(2, niceMax(peak));
  const yOf = (v: number): number => PAD.top + PLOT_H - (v / top) * PLOT_H;
  const xOf = (i: number): number =>
    count <= 1 ? PAD.left + PLOT_W / 2 : PAD.left + (i * PLOT_W) / (count - 1);

  for (const v of [0, top / 2, top]) {
    const y = yOf(v);
    svg.append(
      svgNode('line', {
        x1: PAD.left,
        x2: W - PAD.right,
        y1: y,
        y2: y,
        stroke: 'currentColor',
        'stroke-opacity': 0.14,
      }),
      svgText(formatTick(v), { x: PAD.left - 8, y: y + 4, 'text-anchor': 'end', 'font-size': LABEL_SIZE }),
    );
  }

  if (peak === 0) {
    svg.append(
      svgText('No activity in this period', {
        x: PAD.left + PLOT_W / 2,
        y: PAD.top + PLOT_H / 2 + 6,
        'text-anchor': 'middle',
        'font-size': LABEL_SIZE,
      }),
    );
  }

  for (const s of series) {
    const n = Math.min(count, s.values.length);
    if (n > 0) {
      const points = Array.from({ length: n }, (_, i) => `${xOf(i)},${yOf(s.values[i])}`).join(' ');
      svg.append(
        svgNode('polyline', {
          points,
          fill: 'none',
          stroke: s.color,
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        }),
      );
    }
    for (let i = 0; i < n; i++) {
      const cx = xOf(i);
      const cy = yOf(s.values[i]);
      if (count <= DOT_LIMIT) {
        svg.append(svgNode('circle', { cx, cy, r: 2.5, fill: s.color }));
      }
      // Invisible larger target that carries the hover title for every point.
      const hit = svgNode('circle', { cx, cy, r: 6, fill: 'transparent' });
      const tip = svgNode('title', {});
      tip.textContent = `${labels[i]} · ${s.label}: ${s.values[i]}`;
      hit.append(tip);
      svg.append(hit);
    }
  }

  if (count > 0) {
    const marks = Array.from(new Set(count >= 3 ? [0, Math.floor((count - 1) / 2), count - 1] : [0, count - 1]));
    for (const i of marks) {
      const anchor = count === 1 ? 'middle' : i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle';
      svg.append(
        svgText(labels[i].slice(5), {
          x: xOf(i),
          y: H - 6,
          'text-anchor': anchor,
          'font-size': LABEL_SIZE,
        }),
      );
    }
  }

  return svg;
}

export function barList(items: { label: string; value: number; color?: string }[]): HTMLElement {
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'admin-empty';
    empty.textContent = 'No data yet';
    return empty;
  }

  const max = Math.max(0, ...items.map((item) => item.value));
  const list = document.createElement('div');
  list.className = 'admin-bars';

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'admin-bar-row';

    const label = document.createElement('span');
    label.className = 'admin-bar-label';
    label.textContent = item.label;

    const track = document.createElement('div');
    track.className = 'admin-bar-track';
    const fill = document.createElement('div');
    fill.className = 'admin-bar-fill';
    fill.style.width = `${max > 0 ? (item.value / max) * 100 : 0}%`;
    if (item.color) fill.style.background = item.color;
    track.append(fill);

    const value = document.createElement('span');
    value.className = 'admin-bar-value';
    value.textContent = item.value.toLocaleString('en-US');

    row.append(label, track, value);
    list.append(row);
  }

  return list;
}
