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
  NoseShape,
  Parachute,
  Ring,
  RocketModel,
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
}

interface ParserLike {
  parseFromString(xml: string, mimeType: string): unknown;
}

const ELEMENT_NODE = 1;
const DEG = Math.PI / 180;

const NOSE_SHAPES: readonly NoseShape[] = ['conical', 'ogive', 'ellipsoid', 'power', 'parabolic', 'haack'];
const EXTERNAL_TAGS = new Set(['nosecone', 'bodytube', 'transition']);
const FIN_TAGS = new Set(['trapezoidfinset', 'ellipticalfinset', 'freeformfinset']);
const RING_TAGS = new Set(['centeringring', 'bulkhead', 'tubecoupler', 'engineblock', 'launchlug', 'railbutton']);
const INTERNAL_TAGS = new Set([
  ...FIN_TAGS, ...RING_TAGS,
  'innertube', 'parachute', 'streamer', 'masscomponent', 'shockcord',
]);

// ---------- Public API ----------

/** Parse OpenRocket XML text into a RocketModel. Throws only if the text is not an OpenRocket design. */
export function parseOrkXml(xml: string): RocketModel {
  const warnings: string[] = [];

  let doc: XDoc;
  try {
    doc = makeParser().parseFromString(xml, 'text/xml') as XDoc;
  } catch (err) {
    throw new Error(`Could not read OpenRocket XML: ${(err as Error).message}`);
  }
  const rocketList = doc.getElementsByTagName('rocket');
  if (rocketList.length === 0) {
    throw new Error('No <rocket> element found. This is not an OpenRocket design file.');
  }
  const rocketEl = rocketList[0];

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
    warnings.push(`Rocket has ${stageCount} stages. Staging is not simulated; all stages are stacked into one rocket.`);
  }

  // Pass A: collect external components (fore to aft) with their raw radii.
  const raws: ExternalRaw[] = [];
  for (const container of stageContainers) {
    const subs = child(container, 'subcomponents');
    if (!subs) continue;
    for (const el of kids(subs)) {
      const tag = tagOf(el);
      if (tag === 'nosecone') {
        raws.push({ el, tag, fore: undefined, aft: radiusOf(el, 'aftradius') });
      } else if (tag === 'bodytube') {
        const r = radiusOf(el, 'radius');
        raws.push({ el, tag, fore: r, aft: r });
      } else if (tag === 'transition') {
        raws.push({ el, tag, fore: radiusOf(el, 'foreradius'), aft: radiusOf(el, 'aftradius') });
      } else if (INTERNAL_TAGS.has(tag)) {
        warnings.push(`<${tag}> ("${nameOf(el)}") is not attached to a body tube and was ignored.`);
      } else {
        warnings.push(`Unsupported component type <${tag}> ("${nameOf(el)}") was ignored; it is not simulated.`);
      }
    }
  }

  // Pass B: resolve "auto" radii from adjacent components until nothing changes.
  for (let iter = 0; iter < raws.length + 2; iter++) {
    let changed = false;
    raws.forEach((r, i) => {
      const prev = raws[i - 1];
      const next = raws[i + 1];
      if (r.tag === 'bodytube') {
        if (r.fore === undefined) {
          const v = prev?.aft ?? next?.fore;
          if (v !== undefined) { r.fore = v; r.aft = v; changed = true; }
        }
      } else {
        if (r.fore === undefined && prev?.aft !== undefined) { r.fore = prev.aft; changed = true; }
        if (r.aft === undefined && next?.fore !== undefined) { r.aft = next.fore; changed = true; }
      }
    });
    if (!changed) break;
  }
  for (const r of raws) {
    const unresolved = r.tag === 'nosecone'
      ? r.aft === undefined
      : r.tag === 'bodytube'
        ? r.fore === undefined
        : r.fore === undefined || r.aft === undefined;
    if (unresolved) warnings.push(`Could not resolve an automatic radius for "${nameOf(r.el)}"; using 0.`);
    r.fore ??= 0;
    r.aft ??= 0;
  }

  // Pass C: stack externals fore to aft and recurse into their children.
  const components: Component[] = [];
  let cursor = 0;
  for (const r of raws) {
    const length = num(r.el, 'length') ?? 0;
    const x = cursor;
    cursor += length;
    let comp: Component;
    if (r.tag === 'nosecone') {
      comp = makeNose(r.el, x, length, r.aft ?? 0, warnings);
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
  }
  components.forEach((c, i) => { c.id = `c${i}`; });

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

  return { name, components, length, maxRadius, stageCount, warnings };
}

/** Parse a .ork file (plain XML, or a zip archive containing rocket.ork). */
export async function parseOrkFile(data: ArrayBuffer | Uint8Array): Promise<RocketModel> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file('rocket.ork') ?? Object.values(zip.files).find((f) => !f.dir);
    if (!entry) throw new Error('The .ork archive contains no files.');
    return parseOrkXml(await entry.async('string'));
  }
  return parseOrkXml(new TextDecoder('utf-8').decode(bytes));
}

// ---------- Internal types and helpers ----------

interface ExternalRaw {
  el: XNode;
  tag: string;
  fore: number | undefined;
  aft: number | undefined;
}

/** Geometry of a parent component, used to place its children. */
interface Frame {
  x: number;
  length: number;
  outer: number;
  inner: number;
}

interface BaseFields {
  id: string;
  name: string;
  x: number;
  length: number;
  density: number;
  massOverride?: number;
  cgOverride?: number;
}

function makeParser(): ParserLike {
  const Native = (globalThis as unknown as { DOMParser?: new () => ParserLike }).DOMParser;
  return Native ? new Native() : (new XmldomParser() as unknown as ParserLike);
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
  return (el.localName || el.nodeName || '').toLowerCase();
}

function child(el: XNode, name: string): XNode | undefined {
  return kids(el).find((k) => tagOf(k) === name);
}

function textOf(n: XNode | undefined): string | undefined {
  return n ? (n.textContent ?? '').trim() : undefined;
}

function numOf(n: XNode | undefined): number | undefined {
  const t = textOf(n);
  if (!t) return undefined;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : undefined;
}

function num(el: XNode, name: string): number | undefined {
  return numOf(child(el, name));
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
  const v = m ? parseFloat(m[1]) : parseFloat(t);
  return Number.isFinite(v) ? v : undefined;
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

function base(el: XNode, x: number, length: number, density: number): BaseFields {
  return { id: '', name: nameOf(el), x, length, density, ...overrides(el, x) };
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
  return {
    ...base(el, x, length, bulkDensity(el)),
    kind: 'nosecone',
    shape,
    shapeParam: num(el, 'shapeparameter') ?? 1,
    baseRadius: aft,
    thickness: num(el, 'thickness') ?? 0,
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
  return {
    ...base(el, x, length, bulkDensity(el)),
    kind: 'transition',
    foreRadius: fore,
    aftRadius: aft,
    thickness: num(el, 'thickness') ?? 0,
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
    out.push({ id: '', name, x, length: len, density: parent.density, kind: 'ring', outerRadius: r, innerRadius: inner });
    if (capped && inner > 0 && t > 0) {
      // End cap: a solid disc of the shoulder thickness at its outer end.
      const capX = which === 'aft' ? x + len - t : x;
      out.push({ id: '', name: `${name} cap`, x: capX, length: t, density: parent.density, kind: 'ring', outerRadius: r, innerRadius: 0 });
    }
  }
  return out;
}

function makeFins(el: XNode, tag: string, parent: Frame, warnings: string[]): FinSet {
  const count = Math.max(1, Math.round(num(el, 'fincount') ?? 3));
  const thickness = num(el, 'thickness') ?? 0;
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
    if (points.length === 0) warnings.push(`Freeform fin set "${nameOf(el)}" has no usable points.`);
    rootChord = points.reduce((m, p) => Math.max(m, p[0]), 0);
    span = points.reduce((m, p) => Math.max(m, p[1]), 0);
  } else if (tag === 'ellipticalfinset') {
    finShape = 'elliptical';
    rootChord = num(el, 'rootchord') ?? 0;
    span = num(el, 'height') ?? 0;
  } else {
    rootChord = num(el, 'rootchord') ?? 0;
    tipChord = num(el, 'tipchord') ?? 0;
    span = num(el, 'height') ?? 0;
    sweepLength = num(el, 'sweeplength') ?? 0;
  }

  const length = rootChord;
  const x = placeAt(el, parent, length, 'bottom');
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
    bodyRadius: parent.outer,
    finShape,
    ...(crossSection ? { crossSection } : {}),
    ...(points ? { points } : {}),
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

function makeInnerTube(el: XNode, x: number, length: number, parent: Frame): InnerTube {
  const mount = child(el, 'motormount');
  const motor = mount ? readMotor(mount) : undefined;
  return {
    ...base(el, x, length, bulkDensity(el)),
    kind: 'innertube',
    outerRadius: radiusOf(el, 'outerradius') ?? parent.inner,
    thickness: num(el, 'thickness') ?? 0,
    isMotorMount: mount !== undefined,
    overhang: mount ? (num(mount, 'overhang') ?? 0) : 0,
    ...(motor ? { motor } : {}),
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
  const length = num(el, 'length') ?? 0;
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
  return { ...base(el, x, length, bulkDensity(el)), kind: 'ring', outerRadius: outer, innerRadius: inner };
}

/** Rail button: a short external tube with outer/inner diameter and height. */
function makeRailButton(el: XNode, parent: Frame): Ring {
  const length = num(el, 'height') ?? 0;
  const outer = (num(el, 'outerdiameter') ?? 0) / 2;
  const inner = Math.min(outer, (num(el, 'innerdiameter') ?? 0) / 2);
  const x = placeAt(el, parent, length, 'top');
  return { ...base(el, x, length, bulkDensity(el)), kind: 'ring', outerRadius: outer, innerRadius: inner, external: true };
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
      const length = num(el, 'length') ?? 0;
      return makeInnerTube(el, placeAt(el, parent, length, 'top'), length, parent);
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
      warnings.push(`Unsupported component type <${tag}> ("${nameOf(el)}") was ignored; it is not simulated.`);
      return undefined;
  }
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
    const comp = buildInternal(el, tag, frame, warnings, tubes);
    if (!comp) continue;
    out.push(comp);
    buildChildren(el, frameOf(comp), out, warnings);
  }
}
