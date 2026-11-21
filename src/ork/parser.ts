import JSZip from 'jszip';
import { DOMParser as XmldomParser } from '@xmldom/xmldom';
import type {
  BodyTube,
  Component,
  FinSet,
  InnerTube,
  MassComponent,
  MotorRef,
  NoseCone,
  StageBoundary,
  NoseShape,
  Parachute,
  Ring,
  RocketModel,
  SideBody,
  Transition,
} from '../types';

// ---------- Minimal DOM typing (shared by browser DOM and @xmldom/xmldom) ----------

interface XNode {
  nodeType: number;
  nodeName: string;
  localName?: string | null;
  childNodes: ArrayLike<XNode>;
  textContent: string | null;
  getAttribute(name: string): string | null;
}

interface XDoc {
  getElementsByTagName(name: string): ArrayLike<XNode>;
  documentElement?: XNode | null;
}

interface ParserLike {
  parseFromString(xml: string, mimeType: string): unknown;
}

const ELEMENT_NODE = 1;
const DEG = Math.PI / 180;
/** Radius OpenRocket gives a part whose automatic radius has no neighbour to copy. */
const DEFAULT_RADIUS = 0.025;

const NOSE_SHAPES: readonly NoseShape[] = ['conical', 'ogive', 'ellipsoid', 'power', 'parabolic', 'haack'];
const EXTERNAL_TAGS = new Set(['nosecone', 'bodytube', 'transition']);
const FIN_TAGS = new Set(['trapezoidfinset', 'ellipticalfinset', 'freeformfinset']);
const RING_TAGS = new Set(['centeringring', 'bulkhead', 'tubecoupler', 'engineblock', 'launchlug', 'railbutton']);
const INTERNAL_TAGS = new Set([
  ...FIN_TAGS, ...RING_TAGS,
  'innertube', 'parachute', 'streamer', 'masscomponent', 'shockcord',
]);

/** Bodies mounted beside the main stack. */
const SIDE_BODY_TAGS = new Set(['parallelstage', 'podset', 'tubefinset', 'booster']);
/** Where side bodies found during a parse are collected. */
let sideSink: SideBody[] | null = null;

// ---------- Public API ----------

/** Parse OpenRocket XML text into a RocketModel. Throws only if the text is not an OpenRocket design. */
export function parseOrkXml(xml: string): RocketModel {
  const warnings: string[] = [];
  const sideBodies: SideBody[] = [];
  sideSink = sideBodies;

  // A byte-order mark or blank lines before the XML declaration stop strict parsers.
  const text = xml.replace(/^[\uFEFF\s]+/, '');
  if (!text) throw new Error('The file is empty.');

  let doc: XDoc;
  try {
    doc = makeParser().parseFromString(text, 'text/xml') as XDoc;
  } catch (err) {
    throw new Error(`Could not read OpenRocket XML: ${(err as Error).message}`);
  }
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Could not read OpenRocket XML: the file is damaged or incomplete.');
  }
  const rocketEl = findRocket(doc);
  if (!rocketEl) {
    throw new Error('No <rocket> element found. This is not an OpenRocket design file.');
  }

  const name = textOf(child(rocketEl, 'name')) || 'Rocket';

  // Stages: <rocket><subcomponents><stage>...; if there are no stage elements, the rocket's own subcomponents are the stage.
  const topSubs = child(rocketEl, 'subcomponents');
  const stageEls = topSubs ? kids(topSubs).filter((k) => tagOf(k) === 'stage') : [];
  if (topSubs && stageEls.length > 0) {
    for (const k of kids(topSubs)) {
      const t = tagOf(k);
      if (t !== 'stage') warnings.push(`Unsupported element <${t}> directly under the rocket was ignored.`);
    }
  }
  const stageContainers: XNode[] = stageEls.length > 0 ? stageEls : [rocketEl];
  const stageCount = Math.max(1, stageEls.length);
  if (stageCount > 1) {
    warnings.push(
      `Rocket has ${stageCount} stages. Stages separate only when stage motors are supplied; otherwise all stages fly as one stacked rocket.`,
    );
  }

  // Pass A: collect external components (fore to aft) with their raw radii.
  const raws: (ExternalRaw & { stageIndex: number })[] = [];
  for (let sIdx = 0; sIdx < stageContainers.length; sIdx++) {
    const container = stageContainers[sIdx];
    const subs = child(container, 'subcomponents');
    if (!subs) continue;
    for (const el of kids(subs)) {
      const tag = tagOf(el);
      if (tag === 'nosecone') {
        // A flipped nose (tail cone) has its wide end forward and its tip aft.
        const wide = radiusOf(el, 'aftradius');
        raws.push(flag(el, 'isflipped')
          ? { el, tag, fore: wide, aft: 0, flipped: true, stageIndex: sIdx }
          : { el, tag, fore: 0, aft: wide, stageIndex: sIdx });
      } else if (tag === 'bodytube') {
        const r = radiusOf(el, 'radius');
        raws.push({ el, tag, fore: r, aft: r, stageIndex: sIdx });
      } else if (tag === 'transition') {
        raws.push({ el, tag, fore: radiusOf(el, 'foreradius'), aft: radiusOf(el, 'aftradius'), stageIndex: sIdx });
      } else if (INTERNAL_TAGS.has(tag)) {
        warnings.push(`<${tag}> ("${nameOf(el)}") is not attached to a body tube and was ignored.`);
      } else {
        warnings.push(`Unsupported component type <${tag}> ("${nameOf(el)}") was ignored; it is not simulated.`);
      }
    }
  }

  resolveRadii(raws, warnings);

  // Pass C: stack externals fore to aft and recurse into their children.
  const components: Component[] = [];
  const stageStarts = new Array<number>(stageContainers.length).fill(-1);
  const stageCounts = new Array<number>(stageContainers.length).fill(0);
  let cursor = 0;
  for (const r of raws) {
    const beforeCount = components.length;
    if (stageStarts[r.stageIndex] === -1) stageStarts[r.stageIndex] = beforeCount;
    const rawLength = num(r.el, 'length') ?? 0;
    if (rawLength < 0) warnings.push(`"${nameOf(r.el)}" has a negative length (${rawLength} m); using 0.`);
    const length = Math.max(0, rawLength);
    const x = cursor;
    cursor += length;
    let comp: Component;
    if (r.tag === 'nosecone') {
      comp = makeNose(r.el, x, length, (r.flipped ? r.fore : r.aft) ?? 0, warnings);
    } else if (r.tag === 'bodytube') {
      comp = makeBodyTube(r.el, x, length, r.fore ?? 0);
    } else {
      comp = makeTransition(r.el, x, length, r.fore ?? 0, r.aft ?? 0);
    }
    components.push(comp);
    if (comp.kind === 'nosecone' || comp.kind === 'transition') {
      components.push(...shoulderRings(r.el, comp));
    }
    buildChildren(r.el, frameOf(comp), components, warnings);
    stageCounts[r.stageIndex] += components.length - beforeCount;
  }
  components.forEach((c, i) => { c.id = `c${i}`; });

  const stages: StageBoundary[] = stageContainers.map((container, sIdx) => {
    const mOver = num(container, 'overridemass');
    const subOver = textOf(child(container, 'overridesubcomponentsmass')) === 'true';
    return {
      name: nameOf(container) || `Stage ${sIdx + 1}`,
      startComponent: stageStarts[sIdx] === -1 ? components.length : stageStarts[sIdx],
      componentCount: stageCounts[sIdx],
      ...(mOver !== undefined ? { massOverride: mOver, overrideSubcomponentsMass: subOver } : {}),
    };
  });

  if (components.length === 0) warnings.push('No nose cone, body tube or transition was found.');

  let length = 0;
  let maxRadius = 0;
  for (const c of components) {
    if (c.kind === 'nosecone' || c.kind === 'bodytube' || c.kind === 'transition' || c.kind === 'finset') {
      length = Math.max(length, c.x + c.length);
    }
    switch (c.kind) {
      case 'nosecone': maxRadius = Math.max(maxRadius, c.baseRadius); break;
      case 'bodytube': maxRadius = Math.max(maxRadius, c.outerRadius); break;
      case 'transition': maxRadius = Math.max(maxRadius, c.foreRadius, c.aftRadius); break;
      default: break;
    }
  }

  sideSink = null;
  sideBodies.forEach((sb, k) => {
    sb.id = `s${k}`;
    sb.components.forEach((c, i) => { c.id = `s${k}_${i}`; });
  });
  if (sideBodies.length > 0) {
    warnings.push(`${sideBodies.map((sb) => `"${sb.name}"`).join(', ')}: drawn in 3D, but the flight model does not yet count the mass or drag of boosters, pods and tube fins.`);
  }

  return { name, components, length, maxRadius, stageCount, stages, warnings, ...(sideBodies.length > 0 ? { sideBodies } : {}) };
}

/**
 * Text of a design file that is not a zip: plain XML, gzip-compressed XML (OpenRocket
 * before 1.1.9 saved these), in UTF-8 or UTF-16.
 */
export async function decodeOrkText(bytes: Uint8Array): Promise<string> {
  let raw = bytes;
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    const Stream = (globalThis as unknown as { DecompressionStream?: new (f: string) => unknown }).DecompressionStream;
    if (!Stream) throw new Error('This is a gzip-compressed .ork file, which this device cannot unpack.');
    try {
      const piped = new Blob([raw as unknown as BlobPart]).stream().pipeThrough(new Stream('gzip') as never);
      raw = new Uint8Array(await new Response(piped as unknown as BodyInit).arrayBuffer());
    } catch {
      throw new Error('The gzip-compressed .ork file is damaged.');
    }
  }
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return new TextDecoder('utf-16le').decode(raw);
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return new TextDecoder('utf-16be').decode(raw);
  return new TextDecoder('utf-8').decode(raw);
}

/** Parse a .ork file (plain or gzip XML, or a zip archive containing rocket.ork). */
export async function parseOrkFile(data: ArrayBuffer | Uint8Array): Promise<RocketModel> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new Error('The .ork archive is damaged and cannot be opened.');
    }
    const files = Object.values(zip.files).filter((f) => !f.dir);
    const entry = zip.file('rocket.ork') ?? files.find((f) => /\.ork$/i.test(f.name)) ?? files[0];
    if (!entry) throw new Error('The .ork archive contains no files.');
    return parseOrkXml(await decodeOrkText(await entry.async('uint8array')));
  }
  return parseOrkXml(await decodeOrkText(bytes));
}

// ---------- Internal types and helpers ----------

interface ExternalRaw {
  el: XNode;
  tag: string;
  fore: number | undefined;
  aft: number | undefined;
  flipped?: boolean;
}

/** Geometry of a parent component, used to place its children. */
interface Frame {
  x: number;
  length: number;
  outer: number;
  inner: number;
  /** Outer radius at a station, for parents whose radius changes along their length. */
  surfaceAt?: (x: number) => number;
}

interface BaseFields {
  id: string;
  name: string;
  x: number;
  length: number;
  density: number;
  massOverride?: number;
  cgOverride?: number;
  color?: number;
  finish?: string;
}

/** Resolve "auto" radii from adjacent components until nothing changes. */
function resolveRadii(raws: ExternalRaw[], warnings: string[]): void {
  for (let iter = 0; iter < raws.length + 2; iter++) {
    let changed = false;
    raws.forEach((r, i) => {
      const prev = raws[i - 1];
      const next = raws[i + 1];
      if (r.tag === 'bodytube') {
        if (r.fore === undefined) {
          const prevAft = prev?.tag === 'nosecone' && prev.flipped ? undefined : prev?.aft;
          const nextFore = next?.tag === 'nosecone' && !next.flipped ? undefined : next?.fore;
          const v = prevAft ?? nextFore;
          if (v !== undefined) { r.fore = v; r.aft = v; changed = true; }
        }
      } else {
        // A nose tip (radius 0) is not something a neighbour should copy.
        const prevAft = prev?.tag === 'nosecone' && prev.flipped ? undefined : prev?.aft;
        const nextFore = next?.tag === 'nosecone' && !next.flipped ? undefined : next?.fore;
        if (r.fore === undefined && prevAft !== undefined) { r.fore = prevAft; changed = true; }
        if (r.aft === undefined && nextFore !== undefined) { r.aft = nextFore; changed = true; }
      }
    });
    if (!changed) break;
  }
  for (const r of raws) {
    const unresolved = r.tag === 'nosecone'
      ? r.aft === undefined || r.fore === undefined
      : r.tag === 'bodytube'
        ? r.fore === undefined
        : r.fore === undefined || r.aft === undefined;
    if (unresolved) {
      warnings.push(`Could not resolve an automatic radius for "${nameOf(r.el)}"; using OpenRocket's default of ${DEFAULT_RADIUS * 1000} mm.`);
    }
    // A nose tip has no fore radius; everything else falls back to the default.
    r.fore ??= DEFAULT_RADIUS;
    r.aft ??= DEFAULT_RADIUS;
  }
}

function makeParser(): ParserLike {
  const Native = (globalThis as unknown as { DOMParser?: new () => ParserLike }).DOMParser;
  return Native ? new Native() : (new XmldomParser() as unknown as ParserLike);
}

/** The first <rocket> element, whatever its namespace prefix or letter case. */
function findRocket(doc: XDoc): XNode | undefined {
  const direct = doc.getElementsByTagName('rocket');
  if (direct.length > 0) return direct[0];
  const queue: XNode[] = doc.documentElement ? [doc.documentElement] : [];
  for (let i = 0; i < queue.length && i < 20000; i++) {
    if (tagOf(queue[i]) === 'rocket') return queue[i];
    queue.push(...kids(queue[i]));
  }
  return undefined;
}

function kids(el: XNode): XNode[] {
  const out: XNode[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === ELEMENT_NODE) out.push(n);
  }
  return out;
}

function tagOf(el: XNode): string {
  const raw = el.localName || el.nodeName || '';
  return raw.slice(raw.indexOf(':') + 1).toLowerCase();
}

function child(el: XNode, name: string): XNode | undefined {
  return kids(el).find((k) => tagOf(k) === name);
}

function textOf(n: XNode | undefined): string | undefined {
  return n ? (n.textContent ?? '').trim() : undefined;
}

/** Number from file text. Accepts a decimal comma ("0,3") from hand-edited files. */
function parseNum(t: string | null | undefined): number {
  if (!t) return NaN;
  const s = t.trim();
  return parseFloat(/^[-+]?\d*,\d+(e[-+]?\d+)?$/i.test(s) ? s.replace(',', '.') : s);
}

function numOf(n: XNode | undefined): number | undefined {
  const t = textOf(n);
  if (!t) return undefined;
  const v = parseNum(t);
  return Number.isFinite(v) ? v : undefined;
}

/** A size that cannot be negative; negative values in the file become 0. */
function size(el: XNode, name: string): number | undefined {
  const v = num(el, name);
  return v === undefined ? undefined : Math.max(0, v);
}

function num(el: XNode, name: string): number | undefined {
  return numOf(child(el, name));
}

function flag(el: XNode, name: string): boolean {
  return (textOf(child(el, name)) ?? '').toLowerCase() === 'true';
}

function str(el: XNode, name: string): string | undefined {
  return textOf(child(el, name));
}

function nameOf(el: XNode): string {
  return str(el, 'name') || tagOf(el);
}

/** Radius-like value. "auto" with no number gives undefined (resolved from neighbours); "auto 0.0125" gives 0.0125. */
function radiusOf(el: XNode, name: string): number | undefined {
  const t = str(el, name);
  if (t === undefined) return undefined;
  const m = /^auto\s+(.+)$/i.exec(t);
  const v = m ? parseNum(m[1]) : parseNum(t);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

function materialOf(el: XNode): { density: number; surface: boolean } {
  const m = child(el, 'material');
  const d = parseFloat(m?.getAttribute('density') ?? '');
  return {
    density: Number.isFinite(d) ? d : 0,
    surface: (m?.getAttribute('type') ?? '').toLowerCase() === 'surface',
  };
}

/** Bulk density in kg/m^3; surface-density materials (parachute cloth) give 0 here. */
function bulkDensity(el: XNode): number {
  const m = materialOf(el);
  return m.surface ? 0 : m.density;
}

function overrides(el: XNode, x: number): { massOverride?: number; cgOverride?: number } {
  const o: { massOverride?: number; cgOverride?: number } = {};
  const m = num(el, 'overridemass');
  if (m !== undefined && m > 0) o.massOverride = m;
  const cg = num(el, 'overridecg');
  if (cg !== undefined) o.cgOverride = x + cg;
  return o;
}

/** Paint colour from <appearance><paint red green blue>, as 24-bit RGB. */
function paintOf(el: XNode): number | undefined {
  const a = child(el, 'appearance');
  const p = a ? child(a, 'paint') : undefined;
  if (!p) return undefined;
  const ch = ['red', 'green', 'blue'].map((k) => parseInt(p.getAttribute(k) ?? '', 10));
  if (ch.some((v) => !Number.isFinite(v))) return undefined;
  const [r, g, b] = ch.map((v) => Math.min(255, Math.max(0, v)));
  return (r << 16) | (g << 8) | b;
}

function base(el: XNode, x: number, length: number, density: number): BaseFields {
  const color = paintOf(el);
  const finish = str(el, 'finish')?.toLowerCase();
  return {
    id: '', name: nameOf(el), x, length, density, ...overrides(el, x),
    ...(color !== undefined ? { color } : {}),
    ...(finish ? { finish } : {}),
  };
}

/**
 * Absolute fore station of an internal component.
 * top: parent.x + v; bottom: parent aft end - child length + v; middle: centred + v; absolute: v from nose tip.
 */
function placeAt(el: XNode, parent: Frame, childLength: number, defaultMethod: string): number {
  const p = child(el, 'position') ?? child(el, 'axialoffset');
  const method = (p?.getAttribute('type') || p?.getAttribute('method') || defaultMethod).toLowerCase();
  const value = numOf(p) ?? 0;
  switch (method) {
    case 'bottom': return parent.x + parent.length - childLength + value;
    case 'middle': return parent.x + (parent.length - childLength) / 2 + value;
    case 'absolute': return value;
    default: return parent.x + value;
  }
}

function frameOf(c: Component): Frame {
  let outer = 0;
  let inner = 0;
  switch (c.kind) {
    case 'nosecone':
      outer = c.baseRadius;
      inner = c.baseRadius;
      break;
    case 'bodytube':
    case 'innertube':
      outer = c.outerRadius;
      inner = Math.max(0, outer - c.thickness);
      break;
    case 'transition':
      outer = c.aftRadius;
      inner = Math.max(0, outer - c.thickness);
      if (Math.abs(c.foreRadius - c.aftRadius) > 1e-6 && c.length > 0) {
        const { x: x0, length: len, foreRadius: rf, aftRadius: ra } = c;
        const surfaceAt = (x: number): number => rf + (ra - rf) * Math.min(1, Math.max(0, (x - x0) / len));
        return { x: c.x, length: c.length, outer, inner, surfaceAt };
      }
      break;
    case 'ring':
      outer = c.outerRadius;
      inner = c.innerRadius;
      break;
    case 'finset':
      outer = c.bodyRadius;
      inner = c.bodyRadius;
      break;
    default:
      break;
  }
  return { x: c.x, length: c.length, outer, inner };
}

// ---------- Component builders ----------

function makeNose(el: XNode, x: number, length: number, aft: number, warnings: string[]): NoseCone {
  const shapeRaw = (str(el, 'shape') || 'ogive').toLowerCase();
  let shape: NoseShape = 'ogive';
  if ((NOSE_SHAPES as readonly string[]).includes(shapeRaw)) {
    shape = shapeRaw as NoseShape;
  } else {
    warnings.push(`Nose cone "${nameOf(el)}" has unknown shape "${shapeRaw}"; using ogive.`);
  }
  const flipped = flag(el, 'isflipped');
  if (flipped) {
    warnings.push(`"${nameOf(el)}" is a tail cone (flipped nose). It is drawn as built, but its lift and drag are estimated as a nose cone.`);
  }
  return {
    ...base(el, x, length, bulkDensity(el)),
    kind: 'nosecone',
    shape,
    shapeParam: num(el, 'shapeparameter') ?? 1,
    baseRadius: aft,
    thickness: size(el, 'thickness') ?? 0,
    ...(flipped ? { flipped: true } : {}),
  };
}

function makeBodyTube(el: XNode, x: number, length: number, radius: number): BodyTube {
  return {
    ...base(el, x, length, bulkDensity(el)),
    kind: 'bodytube',
    outerRadius: radius,
    thickness: num(el, 'thickness') ?? 0,
  };
}

function makeTransition(el: XNode, x: number, length: number, fore: number, aft: number): Transition {
  const shapeRaw = (str(el, 'shape') || 'conical').toLowerCase();
  const curved = shapeRaw !== 'conical' && (NOSE_SHAPES as readonly string[]).includes(shapeRaw);
  return {
    ...base(el, x, length, bulkDensity(el)),
    kind: 'transition',
    foreRadius: fore,
    aftRadius: aft,
    thickness: size(el, 'thickness') ?? 0,
    ...(curved
      ? { shape: shapeRaw as NoseShape, shapeParam: num(el, 'shapeparameter') ?? 1, clipped: flag(el, 'shapeclipped') }
      : {}),
  };
}

/** Nose and transition shoulders as internal rings: aft shoulders extend aft, fore shoulders extend forward. */
function shoulderRings(el: XNode, parent: NoseCone | Transition): Ring[] {
  const out: Ring[] = [];
  for (const which of ['fore', 'aft'] as const) {
    const p = `${which}shoulder`;
    const r = num(el, `${p}radius`);
    const len = num(el, `${p}length`) ?? 0;
    if (r === undefined || !(r > 0) || !(len > 0)) continue;
    const t = num(el, `${p}thickness`) ?? 0;
    const inner = t > 0 && t < r ? r - t : 0;
    const capped = (str(el, `${p}capped`) ?? '').toLowerCase() === 'true';
    const x = which === 'aft' ? parent.x + parent.length : parent.x - len;
    const name = `${parent.name} ${which} shoulder`;
    out.push({ id: '', name, x, length: len, density: parent.density, kind: 'ring', outerRadius: r, innerRadius: inner, ringType: 'shoulder' });
    if (capped && inner > 0 && t > 0) {
      // End cap: a solid disc of the shoulder thickness at its outer end.
      const capX = which === 'aft' ? x + len - t : x;
      out.push({ id: '', name: `${name} cap`, x: capX, length: t, density: parent.density, kind: 'ring', outerRadius: r, innerRadius: 0, ringType: 'shoulder' });
    }
  }
  return out;
}

function makeFins(el: XNode, tag: string, parent: Frame, warnings: string[]): FinSet {
  const count = Math.max(1, Math.round(num(el, 'fincount') ?? 3));
  const thickness = size(el, 'thickness') ?? 0;
  const cant = (num(el, 'cant') ?? 0) * DEG;

  let finShape: FinSet['finShape'] = 'trapezoid';
  let rootChord = 0;
  let tipChord = 0;
  let span = 0;
  let sweepLength = 0;
  let points: [number, number][] | undefined;

  if (tag === 'freeformfinset') {
    finShape = 'freeform';
    points = [];
    const fp = child(el, 'finpoints');
    if (fp) {
      for (const p of kids(fp)) {
        if (tagOf(p) !== 'point') continue;
        const px = parseFloat(p.getAttribute('x') ?? '');
        const py = parseFloat(p.getAttribute('y') ?? '');
        if (Number.isFinite(px) && Number.isFinite(py)) points.push([px, py]);
      }
    }
    // Shoelace area: a self-crossing or collapsed outline encloses nothing.
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      area += x1 * y2 - x2 * y1;
    }
    if (points.length === 0) warnings.push(`Freeform fin set "${nameOf(el)}" has no usable points.`);
    else if (points.length < 3 || Math.abs(area) < 1e-10) {
      warnings.push(`Freeform fin set "${nameOf(el)}" has an outline that encloses no area (too few points, or it crosses itself); it is not drawn.`);
    }
    rootChord = points.reduce((m, p) => Math.max(m, p[0]), 0);
    span = points.reduce((m, p) => Math.max(m, p[1]), 0);
  } else if (tag === 'ellipticalfinset') {
    finShape = 'elliptical';
    rootChord = size(el, 'rootchord') ?? 0;
    span = size(el, 'height') ?? 0;
  } else {
    rootChord = size(el, 'rootchord') ?? 0;
    tipChord = size(el, 'tipchord') ?? 0;
    span = size(el, 'height') ?? 0;
    // OpenRocket stores either a sweep length or a sweep angle.
    const sweepAngle = num(el, 'sweepangle');
    sweepLength = num(el, 'sweeplength') ?? (sweepAngle !== undefined ? span * Math.tan(sweepAngle * DEG) : 0);
  }

  const length = rootChord;
  const x = placeAt(el, parent, length, 'bottom');
  // Angle of the first fin: <angleoffset> in new files, <rotation> in old ones (degrees).
  const angleOffset = (num(el, 'angleoffset') ?? num(el, 'rotation') ?? 0) * DEG;
  const fillet = size(el, 'filletradius') ?? 0;
  const tabHeight = size(el, 'tabheight') ?? 0;
  const tabLength = Math.min(size(el, 'tablength') ?? 0, rootChord);
  // Tab position is relative to the front, centre or end of the root chord.
  const tabEl = child(el, 'tabposition');
  const tabRel = (tabEl?.getAttribute('relativeto') ?? 'front').toLowerCase();
  const tabVal = numOf(tabEl) ?? 0;
  const tabOffset = tabRel === 'end' ? rootChord - tabLength + tabVal
    : tabRel === 'center' ? (rootChord - tabLength) / 2 + tabVal
    : tabVal;
  const csRaw = (str(el, 'crosssection') ?? '').toLowerCase();
  const crossSection = csRaw === 'square' || csRaw === 'rounded' || csRaw === 'airfoil' ? csRaw : undefined;
  return {
    ...base(el, x, length, bulkDensity(el)),
    kind: 'finset',
    count,
    rootChord,
    tipChord,
    span,
    sweepLength,
    thickness,
    cant,
    // On a tapered parent the fin mounts at the radius under its leading edge, as in OpenRocket.
    bodyRadius: parent.surfaceAt ? parent.surfaceAt(x) : parent.outer,
    finShape,
    ...(crossSection ? { crossSection } : {}),
    ...(points ? { points } : {}),
    ...(angleOffset ? { angleOffset } : {}),
    ...(fillet > 0 ? { filletRadius: fillet } : {}),
    ...(tabHeight > 0 && tabLength > 0 ? { tabHeight, tabLength, tabOffset } : {}),
  };
}

function readMotor(mountEl: XNode): MotorRef | undefined {
  const m = child(mountEl, 'motor');
  if (!m) return undefined;
  return {
    manufacturer: str(m, 'manufacturer') ?? '',
    designation: str(m, 'designation') ?? '',
    diameter: num(m, 'diameter') ?? 0,
    length: num(m, 'length') ?? 0,
    // Missing, "None" or unparsable delay becomes NaN (plugged / no ejection charge).
    delay: parseFloat(str(m, 'delay') ?? ''),
  };
}

/**
 * Centres of the tubes in an OpenRocket cluster, [x, z] metres from the rocket axis.
 * `pitch` is the centre-to-centre spacing. Returns undefined for a single tube.
 */
export function clusterOffsets(config: string, pitch: number, rotation: number): [number, number][] | undefined {
  const name = config.toLowerCase();
  const m = /^([0-9]+)-(row|ring|star|cross|grid)$/.exec(name);
  const n = name === 'double' ? 2 : m ? parseInt(m[1], 10) : 1;
  const layout = name === 'double' ? 'row' : m ? m[2] : 'single';
  if (!(n >= 2) || n > 64 || !(pitch > 0)) return undefined;
  const pts: [number, number][] = [];
  const ring = (k: number, r: number): void => {
    for (let i = 0; i < k; i++) pts.push([r * Math.cos((2 * Math.PI * i) / k), r * Math.sin((2 * Math.PI * i) / k)]);
  };
  // Radius that puts k tubes one pitch apart on a circle.
  const ringRadius = (k: number): number => (k < 2 ? 0 : 0.5 / Math.sin(Math.PI / k));
  if (layout === 'row') {
    for (let i = 0; i < n; i++) pts.push([i - (n - 1) / 2, 0]);
  } else if (layout === 'grid') {
    const side = Math.round(Math.sqrt(n));
    for (let i = 0; i < side; i++) for (let j = 0; j < side; j++) pts.push([i - (side - 1) / 2, j - (side - 1) / 2]);
  } else if (layout === 'ring') {
    ring(n, ringRadius(n));
  } else {
    // star / cross: one in the middle, the rest around it.
    pts.push([0, 0]);
    ring(n - 1, Math.max(1, ringRadius(n - 1)));
  }
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return pts.map(([x, z]) => [pitch * (x * c - z * s), pitch * (x * s + z * c)]);
}

function makeInnerTube(el: XNode, x: number, length: number, parent: Frame, warnings: string[]): InnerTube {
  const mount = child(el, 'motormount');
  const motor = mount ? readMotor(mount) : undefined;
  const outerRadius = radiusOf(el, 'outerradius') ?? parent.inner;
  const cluster = clusterOffsets(
    str(el, 'clusterconfiguration') ?? 'single',
    2 * outerRadius * (num(el, 'clusterscale') ?? 1),
    (num(el, 'clusterrotation') ?? 0) * DEG,
  );
  if (cluster) {
    warnings.push(`"${nameOf(el)}" is a cluster of ${cluster.length} tubes. All are drawn, but mass and thrust count one tube and one motor.`);
  }
  return {
    ...base(el, x, length, bulkDensity(el)),
    kind: 'innertube',
    outerRadius,
    thickness: size(el, 'thickness') ?? 0,
    isMotorMount: mount !== undefined,
    overhang: mount ? (num(mount, 'overhang') ?? 0) : 0,
    ...(motor ? { motor } : {}),
    ...(cluster ? { cluster } : {}),
  };
}

function makeChute(el: XNode, tag: string, parent: Frame): Parachute {
  const isStreamer = tag === 'streamer';
  const mat = materialOf(el);
  const length = num(el, 'packedlength') ?? 0;

  let diameter: number;
  let area: number;
  if (isStreamer) {
    area = (num(el, 'striplength') ?? 0) * (num(el, 'stripwidth') ?? 0);
    diameter = Math.sqrt((4 * area) / Math.PI); // equal-area circular canopy
  } else {
    diameter = num(el, 'diameter') ?? 0;
    area = Math.PI * (diameter / 2) ** 2;
  }

  const cdText = str(el, 'cd');
  const cdVal = cdText !== undefined && !/auto/i.test(cdText) ? parseFloat(cdText) : NaN;
  const cd = Number.isFinite(cdVal) ? cdVal : isStreamer ? 0.6 : 0.8;

  const ev = (str(el, 'deployevent') ?? 'ejection').toLowerCase();
  const deployEvent: Parachute['deployEvent'] =
    ev === 'apogee' ? 'apogee' : ev === 'altitude' ? 'altitude' : 'ejection';

  const x = placeAt(el, parent, length, 'top');
  return {
    ...base(el, x, length, mat.surface ? 0 : mat.density),
    kind: 'parachute',
    diameter,
    cd,
    deployEvent,
    deployAltitude: num(el, 'deployaltitude') ?? 0,
    deployDelay: num(el, 'deploydelay') ?? 0,
    // Canopy (surface density × area) plus shroud lines (count × length × linear density).
    mass: (mat.surface ? mat.density * area : 0) + (num(el, 'linecount') ?? 0) * (num(el, 'linelength') ?? 0) * densityOfChild(el, 'linematerial'),
  };
}

/** Density attribute of a named child element (e.g. <linematerial density="...">). */
function densityOfChild(el: XNode, name: string): number {
  const d = parseFloat(child(el, name)?.getAttribute('density') ?? '');
  return Number.isFinite(d) ? d : 0;
}

function makeMass(el: XNode, parent: Frame): MassComponent {
  const length = num(el, 'packedlength') ?? 0;
  const x = placeAt(el, parent, length, 'top');
  return { ...base(el, x, length, 0), kind: 'mass', mass: num(el, 'mass') ?? 0 };
}

/** An inner tube sibling of a ring, in the body frame: its span and outer radius. */
interface SiblingTube {
  x0: number;
  x1: number;
  outer: number;
}

function makeRing(el: XNode, tag: string, parent: Frame, tubes: SiblingTube[]): Ring {
  const length = size(el, 'length') ?? 0;
  const x = placeAt(el, parent, length, 'top');
  const outer = radiusOf(el, 'outerradius') ?? radiusOf(el, 'radius') ?? parent.inner;
  let inner = radiusOf(el, 'innerradius');
  if (inner === undefined) {
    if (tag === 'centeringring') {
      // OpenRocket: an automatic centering-ring hole is the largest outer radius of the inner
      // tubes it overlaps (it fits around them), capped at the ring's own outer radius.
      inner = 0;
      for (const t of tubes) if (t.x0 < x + length && t.x1 > x) inner = Math.max(inner, t.outer);
      inner = Math.min(inner, outer);
    } else {
      const thickness = num(el, 'thickness');
      inner = thickness !== undefined && thickness < outer ? outer - thickness : 0;
    }
  }
  const ringType = tag as NonNullable<Ring['ringType']>;
  return {
    ...base(el, x, length, bulkDensity(el)), kind: 'ring', outerRadius: outer, innerRadius: Math.min(inner, outer), ringType,
    ...(tag === 'launchlug' ? fitting(el, parent, x + length / 2) : {}),
  };
}

/** Where an external fitting sits on the body: surface radius, angle, and repeat count. */
function fitting(el: XNode, parent: Frame, station: number): Pick<Ring, 'mountRadius' | 'angle' | 'instanceCount' | 'instanceSeparation'> {
  const count = Math.max(1, Math.round(num(el, 'instancecount') ?? 1));
  // Degrees: <radialdirection> in old files, <angleoffset> in new ones.
  const angle = (num(el, 'angleoffset') ?? num(el, 'radialdirection') ?? 0) * DEG;
  return {
    mountRadius: parent.surfaceAt ? parent.surfaceAt(station) : parent.outer,
    ...(angle ? { angle } : {}),
    ...(count > 1 ? { instanceCount: count, instanceSeparation: num(el, 'instanceseparation') ?? 0 } : {}),
  };
}

/** Rail button: a short external tube with outer/inner diameter and height. */
function makeRailButton(el: XNode, parent: Frame): Ring {
  const length = size(el, 'height') ?? 0;
  const outer = (size(el, 'outerdiameter') ?? 0) / 2;
  const inner = Math.min(outer, (size(el, 'innerdiameter') ?? 0) / 2);
  const x = placeAt(el, parent, length, 'top');
  return {
    ...base(el, x, length, bulkDensity(el)), kind: 'ring', outerRadius: outer, innerRadius: inner, external: true,
    ringType: 'railbutton', ...fitting(el, parent, x + outer),
  };
}

function buildInternal(el: XNode, tag: string, parent: Frame, warnings: string[], tubes: SiblingTube[]): Component | undefined {
  if (FIN_TAGS.has(tag)) return makeFins(el, tag, parent, warnings);
  if (tag === 'railbutton') return makeRailButton(el, parent);
  if (RING_TAGS.has(tag)) {
    const ring = makeRing(el, tag, parent, tubes);
    // A launch lug sits outside the body and adds drag.
    return tag === 'launchlug' ? { ...ring, external: true } : ring;
  }
  switch (tag) {
    case 'innertube': {
      const length = size(el, 'length') ?? 0;
      return makeInnerTube(el, placeAt(el, parent, length, 'top'), length, parent, warnings);
    }
    case 'parachute':
    case 'streamer':
      return makeChute(el, tag, parent);
    case 'masscomponent':
      return makeMass(el, parent);
    case 'shockcord': {
      // A shock cord is modelled as a point mass: linear density (kg/m) times cord length.
      const cord = num(el, 'cordlength') ?? 0;
      const linear = materialOf(el).density;
      if (cord > 0 && linear > 0) {
        const x = placeAt(el, parent, 0, 'top');
        return { ...base(el, x, 0, 0), kind: 'mass', mass: linear * cord };
      }
      warnings.push(`Shock cord "${nameOf(el)}" skipped: it needs a cordlength and a linear density.`);
      return undefined;
    }
    default:
      warnings.push(SIDE_BODY_TAGS.has(tag)
        ? `<${tag}> ("${nameOf(el)}") is not supported yet: it and everything attached to it are missing from the 3D model and the simulation.`
        : `Unsupported component type <${tag}> ("${nameOf(el)}") was ignored; it is not simulated.`);
      return undefined;
  }
}

/**
 * A parallel stage or pod set: its own nose / tube / transition stack, placed beside
 * the parent and repeated around the rocket axis.
 */
function makeSideStack(el: XNode, tag: string, parent: Frame, warnings: string[]): SideBody | undefined {
  const subs = child(el, 'subcomponents');
  const raws: ExternalRaw[] = [];
  const nested: XNode[] = [];
  for (const k of subs ? kids(subs) : []) {
    const t = tagOf(k);
    if (t === 'nosecone') {
      const wide = radiusOf(k, 'aftradius');
      raws.push(flag(k, 'isflipped') ? { el: k, tag: t, fore: wide, aft: 0, flipped: true } : { el: k, tag: t, fore: 0, aft: wide });
    } else if (t === 'bodytube') {
      const r = radiusOf(k, 'radius');
      raws.push({ el: k, tag: t, fore: r, aft: r });
    } else if (t === 'transition') {
      raws.push({ el: k, tag: t, fore: radiusOf(k, 'foreradius'), aft: radiusOf(k, 'aftradius') });
    } else if (SIDE_BODY_TAGS.has(t)) {
      nested.push(k);
    } else {
      warnings.push(`<${t}> ("${nameOf(k)}") directly inside "${nameOf(el)}" was ignored.`);
    }
  }
  if (raws.length === 0) {
    warnings.push(`"${nameOf(el)}" has no body parts and is not drawn.`);
    return undefined;
  }
  resolveRadii(raws, warnings);

  const total = raws.reduce((sum, r) => sum + Math.max(0, num(r.el, 'length') ?? 0), 0);
  const x0 = placeAt(el, parent, total, 'bottom');
  const components: Component[] = [];
  let cursor = x0;
  let bodyRadius = 0;
  for (const r of raws) {
    const length = Math.max(0, num(r.el, 'length') ?? 0);
    const x = cursor;
    cursor += length;
    const comp: Component = r.tag === 'nosecone'
      ? makeNose(r.el, x, length, (r.flipped ? r.fore : r.aft) ?? 0, [])
      : r.tag === 'bodytube'
        ? makeBodyTube(r.el, x, length, r.fore ?? 0)
        : makeTransition(r.el, x, length, r.fore ?? 0, r.aft ?? 0);
    bodyRadius = Math.max(bodyRadius, r.fore ?? 0, r.aft ?? 0);
    components.push(comp);
    // Bodies hanging off a side body are collected like any other; their own parts go with this one.
    buildChildren(r.el, frameOf(comp), components, warnings);
  }
  for (const k of nested) warnings.push(`"${nameOf(k)}" is attached to the side body "${nameOf(el)}" itself and was ignored.`);

  return {
    id: '', name: nameOf(el), type: tag === 'podset' ? 'pod' : 'booster',
    ...sidePlacement(el, parent, bodyRadius, x0),
    components,
  };
}

/** Tube fins: open tubes lying against the body, evenly spaced around it. */
function makeTubeFins(el: XNode, parent: Frame, warnings: string[]): SideBody | undefined {
  const length = size(el, 'length') ?? 0;
  const radius = radiusOf(el, 'radius') ?? radiusOf(el, 'outerradius');
  const count = Math.max(1, Math.round(num(el, 'fincount') ?? 6));
  const x = placeAt(el, parent, length, 'bottom');
  const mount = parent.surfaceAt ? parent.surfaceAt(x) : parent.outer;
  // Automatic radius: the size at which `count` tubes just touch each other around the body.
  const s = Math.sin(Math.PI / count);
  const r = radius ?? (count >= 3 && s < 1 ? (mount * s) / (1 - s) : mount);
  if (!(length > 0) || !(r > 0)) {
    warnings.push(`Tube fin set "${nameOf(el)}" has no length or radius and is not drawn.`);
    return undefined;
  }
  const tubeFin = makeBodyTube(el, x, length, r);
  return {
    id: '', name: nameOf(el), type: 'tubefin', count,
    radialOffset: mount + r,
    angle: (num(el, 'angleoffset') ?? num(el, 'rotation') ?? 0) * DEG,
    components: [tubeFin],
  };
}

/** Count, angle and axis distance of a parallel stage or pod set. */
function sidePlacement(el: XNode, parent: Frame, bodyRadius: number, station: number): Pick<SideBody, 'count' | 'radialOffset' | 'angle'> {
  const count = Math.min(64, Math.max(1, Math.round(num(el, 'instancecount') ?? 2)));
  const ro = child(el, 'radiusoffset') ?? child(el, 'radialoffset');
  const method = (ro?.getAttribute('method') ?? 'surface').toLowerCase();
  const value = numOf(ro) ?? 0;
  const mount = parent.surfaceAt ? parent.surfaceAt(station) : parent.outer;
  // OpenRocket: "surface" rests the body on the parent, "relative" adds a gap,
  // "free" measures from the rocket axis, "coaxial" puts it on the axis.
  const radialOffset = method === 'free' ? Math.max(0, value)
    : method === 'coaxial' ? 0
    : method === 'relative' ? mount + bodyRadius + value
    : mount + bodyRadius;
  return { count, radialOffset, angle: (num(el, 'angleoffset') ?? 0) * DEG };
}

/** Recursively build the internal children of a component, appending them after their parent. */
function buildChildren(container: XNode, frame: Frame, out: Component[], warnings: string[]): void {
  const subs = child(container, 'subcomponents');
  if (!subs) return;
  const tubes: SiblingTube[] = kids(subs)
    .filter((e) => tagOf(e) === 'innertube')
    .map((e) => {
      const len = num(e, 'length') ?? 0;
      const x0 = placeAt(e, frame, len, 'top');
      return { x0, x1: x0 + len, outer: radiusOf(e, 'outerradius') ?? frame.inner };
    });
  for (const el of kids(subs)) {
    const tag = tagOf(el);
    if (EXTERNAL_TAGS.has(tag) || tag === 'stage') {
      warnings.push(`<${tag}> ("${nameOf(el)}") nested inside another component was ignored.`);
      continue;
    }
    if (SIDE_BODY_TAGS.has(tag) && sideSink) {
      const sb = tag === 'tubefinset' ? makeTubeFins(el, frame, warnings) : makeSideStack(el, tag, frame, warnings);
      if (sb) sideSink.push(sb);
      continue;
    }
    const comp = buildInternal(el, tag, frame, warnings, tubes);
    if (!comp) continue;
    out.push(comp);
    buildChildren(el, frameOf(comp), out, warnings);
  }
}
