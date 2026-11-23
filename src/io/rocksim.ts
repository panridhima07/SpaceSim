// RockSim (.rkt) XML parser.
// Converts <RockSimDocument> XML into the canonical RocketModel (SI units: m, kg, kg/m^3, rad).

import { DOMParser as XmldomParser } from '@xmldom/xmldom';
import {
  MAX_CHILDREN,
  MAX_FIN_POINTS,
  MAX_STACK_PARTS,
  MAX_TOTAL_PARTS,
  MAX_NEST_DEPTH,
  clampCount,
  clampLength,
  clampMass,
  clampOffset,
  clampRadius,
  assertSafeXmlText,
} from './limits';
import type {
  BodyTube,
  Component,
  FinSet,
  InnerTube,
  MassComponent,
  NoseCone,
  NoseShape,
  Parachute,
  Ring,
  RocketModel,
  StageBoundary,
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

type ParserCtor = new (opts?: unknown) => { parseFromString(xml: string, mimeType: string): XDoc };

const ELEMENT_NODE = 1;
const DEG = Math.PI / 180;

const ROCKSIM_SHAPES: Record<number, NoseShape> = {
  0: 'conical',
  1: 'ogive',
  2: 'parabolic',
  3: 'ellipsoid',
  4: 'power',
  5: 'haack',
};

const EXTERNAL_TAGS = new Set(['nosecone', 'bodytube', 'transition']);

function makeParser(): { parseFromString(xml: string, mimeType: string): XDoc } {
  const Native = (globalThis as unknown as { DOMParser?: ParserCtor }).DOMParser;
  if (Native) return new Native();
  const Ctor = XmldomParser as unknown as ParserCtor;
  return new Ctor({ onError: () => {} });
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
  const lower = name.toLowerCase();
  return kids(el).find((k) => tagOf(k) === lower);
}

function textOf(n: XNode | undefined): string | undefined {
  if (!n) return undefined;
  const t = (n.textContent ?? '').trim();
  return t === '' ? undefined : t;
}

function str(el: XNode, name: string): string | undefined {
  return textOf(child(el, name));
}

function num(el: XNode, name: string): number | undefined {
  const t = str(el, name);
  if (t === undefined) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

function boolFlag(el: XNode, name: string): boolean {
  const t = (str(el, name) ?? '').toLowerCase();
  return t === '1' || t === 'true';
}

function nameOf(el: XNode, fallback: string): string {
  return str(el, 'Name') || fallback;
}

function findFirstTag(doc: XDoc, name: string): XNode | undefined {
  const lower = name.toLowerCase();
  const queue: XNode[] = doc.documentElement ? [doc.documentElement] : [];
  for (let i = 0; i < queue.length && i < 20000; i++) {
    if (tagOf(queue[i]) === lower) return queue[i];
    queue.push(...kids(queue[i]));
  }
  return undefined;
}

// ---------- Unit & property helpers ----------

/** Convert RockSim mm to m, clamped >= 0. */
function mmToM(mm: number | undefined, fallback = 0): number {
  if (mm === undefined || !Number.isFinite(mm)) return fallback;
  return clampLength(mm / 1000);
}

/** Convert RockSim mass in g to kg. */
function gToKg(g: number | undefined): number | undefined {
  if (g === undefined || !Number.isFinite(g) || g <= 0) return undefined;
  return clampMass(g / 1000);
}

/** RockSim density is in g/cm^3 (DensityType 0 = bulk); convert to kg/m^3. */
function densityOf(el: XNode, fallback = 680): number {
  const densityType = num(el, 'DensityType');
  if (densityType !== undefined && densityType !== 0) return fallback;
  const d = num(el, 'Density');
  if (d !== undefined && d > 0) return d * 1000;
  return fallback;
}

function overridesOf(el: XNode, x: number): { massOverride?: number; cgOverride?: number } {
  const out: { massOverride?: number; cgOverride?: number } = {};
  if (boolFlag(el, 'UseKnownMass')) {
    const m = gToKg(num(el, 'KnownMass'));
    if (m !== undefined) out.massOverride = m;
  }
  const cgMm = num(el, 'KnownCG');
  if (cgMm !== undefined && boolFlag(el, 'UseKnownCG')) {
    out.cgOverride = clampOffset(x + mmToM(cgMm, 0));
  }
  return out;
}

function colorOf(el: XNode): number | undefined {
  const raw = str(el, 'DisplayFlags') ? undefined : str(el, 'Color');
  const rgb = raw ?? str(el, 'Color');
  if (!rgb) return undefined;
  // RockSim stores RGB(r,g,b) or integer RGB
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(rgb);
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.min(255, Math.max(0, v)));
    return (r << 16) | (g << 8) | b;
  }
  const n = Number(rgb);
  if (Number.isInteger(n) && n >= 0 && n <= 0xffffff) return n;
  return undefined;
}

function placeChild(el: XNode, parentX: number, parentLen: number, childLen: number, defaultMode = 0): number {
  const mode = Math.round(num(el, 'LocationMode') ?? defaultMode);
  const xb = clampOffset((num(el, 'Xb') ?? 0) / 1000);
  switch (mode) {
    case 1: // middle
      return parentX + (parentLen - childLen) / 2 + xb;
    case 2: // back / bottom
      return parentX + parentLen - childLen + xb;
    case 0: // front / top
    default:
      return parentX + xb;
  }
}

// ---------- Component builders ----------

function makeNoseCone(el: XNode, x: number): NoseCone {
  const length = mmToM(num(el, 'Len'), 0.1);
  const baseRadius = clampRadius(mmToM(num(el, 'BaseDia'), 50) / 2);
  const construction = num(el, 'ConstructionType');
  const wallMm = num(el, 'WallThickness');
  const thickness = construction === 0 ? 0 : mmToM(wallMm, 2);
  const shapeCode = Math.round(num(el, 'ShapeCode') ?? 1);
  const shape: NoseShape = ROCKSIM_SHAPES[shapeCode] ?? 'ogive';
  const shapeParam = num(el, 'ShapeParameter') ?? (shape === 'power' || shape === 'parabolic' || shape === 'haack' ? 0.5 : 0);
  const color = colorOf(el);
  return {
    id: '',
    name: nameOf(el, 'Nose Cone'),
    kind: 'nosecone',
    x,
    length,
    density: densityOf(el, 1050),
    ...overridesOf(el, x),
    ...(color !== undefined ? { color } : {}),
    shape,
    shapeParam,
    baseRadius,
    thickness: Math.min(thickness, baseRadius),
  };
}

function makeBodyTube(el: XNode, x: number): BodyTube {
  const length = mmToM(num(el, 'Len'), 0.2);
  const outerRadius = clampRadius(mmToM(num(el, 'OD'), 50) / 2);
  const innerRadius = clampRadius(mmToM(num(el, 'ID'), 48) / 2);
  const thickness = innerRadius > 0 && innerRadius < outerRadius
    ? outerRadius - innerRadius
    : Math.min(outerRadius * 0.1, 0.0015);
  const color = colorOf(el);
  return {
    id: '',
    name: nameOf(el, 'Body Tube'),
    kind: 'bodytube',
    x,
    length,
    density: densityOf(el, 680),
    ...overridesOf(el, x),
    ...(color !== undefined ? { color } : {}),
    outerRadius,
    thickness,
  };
}

function makeTransition(el: XNode, x: number): Transition {
  const length = mmToM(num(el, 'Len'), 0.05);
  const foreRadius = clampRadius(mmToM(num(el, 'FrontDia'), 50) / 2);
  const aftRadius = clampRadius(mmToM(num(el, 'RearDia'), 50) / 2);
  const construction = num(el, 'ConstructionType');
  const thickness = Math.min(Math.max(foreRadius, aftRadius), construction === 0 ? 0 : mmToM(num(el, 'WallThickness'), 2));
  const shapeCode = Math.round(num(el, 'ShapeCode') ?? 0);
  const shape = shapeCode === 0 ? undefined : ROCKSIM_SHAPES[shapeCode];
  const color = colorOf(el);
  return {
    id: '',
    name: nameOf(el, 'Transition'),
    kind: 'transition',
    x,
    length,
    density: densityOf(el, 1050),
    ...overridesOf(el, x),
    ...(color !== undefined ? { color } : {}),
    foreRadius,
    aftRadius,
    thickness,
    ...(shape ? { shape, shapeParam: num(el, 'ShapeParameter') ?? 0.5 } : {}),
  };
}

function parseFinPoints(el: XNode): [number, number][] | undefined {
  const pl = child(el, 'PointList');
  if (!pl) return undefined;
  const pointEls = kids(pl).filter((k) => tagOf(k) === 'point').slice(0, MAX_FIN_POINTS);
  if (pointEls.length >= 3) {
    const pts: [number, number][] = [];
    for (const p of pointEls) {
      const px = num(p, 'X');
      const py = num(p, 'Y');
      if (px !== undefined && py !== undefined) {
        pts.push([clampOffset(px / 1000), clampOffset(py / 1000)]);
      }
      if (pts.length >= MAX_FIN_POINTS) break;
    }
    if (pts.length >= 3) return pts;
  }
  const raw = textOf(pl);
  if (!raw) return undefined;
  const pts: [number, number][] = [];
  for (const token of raw.split('|')) {
    const parts = token.split(',').map((s) => Number(s.trim()));
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      pts.push([clampOffset(parts[0] / 1000), clampOffset(parts[1] / 1000)]);
    }
    if (pts.length >= MAX_FIN_POINTS) break;
  }
  return pts.length >= 3 ? pts : undefined;
}

function makeFinSet(el: XNode, parentX: number, parentLen: number, bodyRadius: number): FinSet {
  const count = clampCount(num(el, 'FinCount'), 3);
  const points = parseFinPoints(el);
  const isCustom = tagOf(el) === 'customfinset' || (Math.round(num(el, 'ShapeCode') ?? 0) === 2 && !!points);

  let rootChord = mmToM(num(el, 'RootChord'), 0);
  let span = mmToM(num(el, 'SemiSpan'), 0);
  if (points && points.length >= 3) {
    const xs = points.map(([px]) => px);
    const ys = points.map(([, py]) => py);
    if (rootChord <= 0) rootChord = Math.max(0.01, Math.max(...xs) - Math.min(...xs));
    if (span <= 0) span = Math.max(0.01, Math.max(...ys));
  }
  if (rootChord <= 0) rootChord = 0.05;
  if (span <= 0) span = 0.04;

  const tipChord = mmToM(num(el, 'TipChord'), rootChord * 0.5);
  const sweepLength = clampOffset((num(el, 'SweepDistance') ?? 0) / 1000);
  const thickness = clampRadius(mmToM(num(el, 'Thickness'), 2));
  const cant = (num(el, 'CantAngle') ?? 0) * DEG;
  const shapeCode = Math.round(num(el, 'ShapeCode') ?? 0);
  const finShape: FinSet['finShape'] = isCustom && points
    ? 'freeform'
    : shapeCode === 1
      ? 'elliptical'
      : 'trapezoid';
  const x = placeChild(el, parentX, parentLen, rootChord, 0);
  const color = colorOf(el);

  return {
    id: '',
    name: nameOf(el, 'Fin Set'),
    kind: 'finset',
    x,
    length: rootChord,
    density: densityOf(el, 160),
    ...overridesOf(el, x),
    ...(color !== undefined ? { color } : {}),
    count,
    rootChord,
    tipChord,
    span,
    sweepLength,
    thickness,
    cant,
    bodyRadius,
    finShape,
    ...(finShape === 'freeform' && points ? { points } : {}),
  };
}

function makeInnerTube(el: XNode, parentX: number, parentLen: number): InnerTube {
  const length = mmToM(num(el, 'Len'), 0.07);
  const outerRadius = clampRadius(mmToM(num(el, 'OD'), 20) / 2);
  const innerRadius = clampRadius(mmToM(num(el, 'ID'), 18) / 2);
  const thickness = innerRadius > 0 && innerRadius < outerRadius
    ? outerRadius - innerRadius
    : Math.min(outerRadius * 0.1, 0.001);
  const isMotorMount = boolFlag(el, 'IsMotorMount');
  const overhang = mmToM(num(el, 'MotorOverhang'), 0);
  const x = placeChild(el, parentX, parentLen, length, 2);

  return {
    id: '',
    name: nameOf(el, isMotorMount ? 'Motor Mount' : 'Inner Tube'),
    kind: 'innertube',
    x,
    length,
    density: densityOf(el, 680),
    ...overridesOf(el, x),
    outerRadius,
    thickness,
    isMotorMount,
    overhang,
  };
}

function makeRing(el: XNode, tag: string, parentX: number, parentLen: number, bodyRadius: number): Ring {
  const length = mmToM(num(el, 'Len'), 0.005);
  const outerRadius = clampRadius(mmToM(num(el, 'OD'), bodyRadius * 2000) / 2);
  const innerRadius = Math.min(outerRadius, mmToM(num(el, 'ID'), 0) / 2);
  const x = placeChild(el, parentX, parentLen, length, 0);

  let ringType: Ring['ringType'] = 'centeringring';
  let external = false;
  if (tag === 'launchlug') {
    ringType = 'launchlug';
    external = true;
  } else if (tag === 'railbutton') {
    ringType = 'railbutton';
    external = true;
  } else if (tag === 'bulkhead') {
    ringType = 'bulkhead';
  } else if (tag === 'tubecoupler') {
    ringType = 'tubecoupler';
  } else if (tag === 'engineblock') {
    ringType = 'engineblock';
  } else {
    const usage = Math.round(num(el, 'UsageCode') ?? 0);
    if (usage === 1) ringType = 'bulkhead';
    else if (usage === 2) ringType = 'tubecoupler';
    else if (usage === 3) ringType = 'engineblock';
  }

  return {
    id: '',
    name: nameOf(el, external ? 'Launch Lug' : 'Centering Ring'),
    kind: 'ring',
    x,
    length,
    density: densityOf(el, 630),
    ...overridesOf(el, x),
    outerRadius,
    innerRadius,
    ringType,
    ...(external ? { external: true, mountRadius: bodyRadius } : {}),
  };
}

function makeParachute(el: XNode, isStreamer: boolean, parentX: number, parentLen: number): Parachute {
  const length = mmToM(num(el, 'Len') ?? num(el, 'PackedLength'), 0.05);
  const x = placeChild(el, parentX, parentLen, length, 0);
  let diameter = mmToM(num(el, 'Dia'), 0.3);
  if (isStreamer) {
    const w = mmToM(num(el, 'Width'), 0.025);
    const l = mmToM(num(el, 'Len'), 0.3);
    diameter = Math.max(0.05, Math.sqrt((4 / Math.PI) * w * l));
  }
  const cd = num(el, 'Cd') ?? (isStreamer ? 0.6 : 0.8);
  const deployCode = Math.round(num(el, 'DeployEvent') ?? 0);
  const deployEvent: Parachute['deployEvent'] =
    deployCode === 1 ? 'ejection' : deployCode === 2 ? 'altitude' : 'apogee';
  const deployAltitude = Math.max(0, num(el, 'DeployAltitude') ?? 150);
  const deployDelay = Math.max(0, num(el, 'DeployDelay') ?? 0);
  const mass = gToKg(num(el, 'KnownMass')) ?? 0.015;

  return {
    id: '',
    name: nameOf(el, isStreamer ? 'Streamer' : 'Parachute'),
    kind: 'parachute',
    x,
    length,
    density: 0,
    diameter,
    cd,
    deployEvent,
    deployAltitude,
    deployDelay,
    mass,
  };
}

function makeMassObject(el: XNode, parentX: number, parentLen: number): MassComponent {
  const length = mmToM(num(el, 'Len'), 0.02);
  const x = placeChild(el, parentX, parentLen, length, 0);
  const mass = gToKg(num(el, 'KnownMass')) ?? 0.01;
  return {
    id: '',
    name: nameOf(el, 'Mass Object'),
    kind: 'mass',
    x,
    length,
    density: 0,
    mass,
  };
}

function collectAttachedParts(
  parentEl: XNode,
  parentX: number,
  parentLen: number,
  bodyRadius: number,
  out: Component[],
  warnings: string[],
  depth = 0,
): void {
  const attached = child(parentEl, 'AttachedParts');
  if (!attached) return;
  if (depth >= MAX_NEST_DEPTH) {
    warnings.push(`Parts nested more than ${MAX_NEST_DEPTH} levels deep were skipped.`);
    return;
  }
  let attachedEls = kids(attached);
  if (attachedEls.length > MAX_CHILDREN) {
    warnings.push(`A part has ${attachedEls.length} attached parts; only the first ${MAX_CHILDREN} were read.`);
    attachedEls = attachedEls.slice(0, MAX_CHILDREN);
  }

  for (const el of attachedEls) {
    if (out.length >= MAX_TOTAL_PARTS) {
      warnings.push(`Stopped reading at ${MAX_TOTAL_PARTS} parts.`);
      break;
    }
    const tag = tagOf(el);
    if (tag === 'finset' || tag === 'customfinset') {
      out.push(makeFinSet(el, parentX, parentLen, bodyRadius));
    } else if (tag === 'bodytube') {
      const inner = makeInnerTube(el, parentX, parentLen);
      out.push(inner);
      collectAttachedParts(el, inner.x, inner.length, inner.outerRadius, out, warnings, depth + 1);
    } else if (
      tag === 'ring' ||
      tag === 'centeringring' ||
      tag === 'bulkhead' ||
      tag === 'tubecoupler' ||
      tag === 'engineblock' ||
      tag === 'launchlug' ||
      tag === 'railbutton'
    ) {
      out.push(makeRing(el, tag, parentX, parentLen, bodyRadius));
    } else if (tag === 'parachute') {
      out.push(makeParachute(el, false, parentX, parentLen));
    } else if (tag === 'streamer') {
      const chute = makeParachute(el, true, parentX, parentLen);
      out.push(chute);
      warnings.push(`Streamer "${chute.name}" was imported as an equivalent parachute.`);
    } else if (tag === 'massobject') {
      out.push(makeMassObject(el, parentX, parentLen));
    } else {
      warnings.push(`Unsupported RockSim part <${el.nodeName}> ("${nameOf(el, tag)}") was skipped.`);
    }
  }
}

// ---------- Public API ----------

/**
 * Parse RockSim (.rkt) XML text into a RocketModel (SI units).
 * Throws if the document is not a valid RockSim design.
 */
export function parseRockSimXml(xml: string): RocketModel {
  assertSafeXmlText(xml);
  const warnings: string[] = [];
  const text = xml.replace(/^[\uFEFF\s]+/, '');
  if (!text) throw new Error('The file is empty.');

  let doc: XDoc;
  try {
    doc = makeParser().parseFromString(text, 'text/xml');
  } catch (err) {
    throw new Error(`Could not read RockSim XML: ${(err as Error).message}`);
  }
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Could not read RockSim XML: the file is damaged or incomplete.');
  }

  const rootDoc = findFirstTag(doc, 'RockSimDocument');
  if (!rootDoc) {
    throw new Error('No <RockSimDocument> element found. This is not a RockSim (.rkt) file.');
  }

  const designEl = findFirstTag(doc, 'RocketDesign') ?? rootDoc;
  const name = str(designEl, 'Name') || 'RockSim Rocket';

  // RockSim orders stages top-to-bottom as Stage3Parts (sustainer), Stage2Parts, Stage1Parts (booster).
  const stageTags = ['Stage3Parts', 'Stage2Parts', 'Stage1Parts'];
  const stageContainers = stageTags
    .map((t) => child(designEl, t))
    .filter((el): el is XNode => el !== undefined && kids(el).length > 0);

  if (stageContainers.length === 0) {
    throw new Error('No rocket stages or parts found in this RockSim file.');
  }

  const components: Component[] = [];
  const stages: StageBoundary[] = [];
  let cursor = 0;
  let externalCount = 0;

  for (let sIdx = 0; sIdx < stageContainers.length; sIdx++) {
    const stageEl = stageContainers[sIdx];
    const stageStart = components.length;
    for (const el of kids(stageEl)) {
      const tag = tagOf(el);
      if (EXTERNAL_TAGS.has(tag) && externalCount >= MAX_STACK_PARTS) {
        if (externalCount === MAX_STACK_PARTS) {
          warnings.push(`Only the first ${MAX_STACK_PARTS} body parts were read; the rest were skipped.`);
          externalCount++;
        }
        continue;
      }
      if (!EXTERNAL_TAGS.has(tag)) {
        warnings.push(`Unsupported top-level RockSim element <${tag}> ("${nameOf(el, tag)}") was skipped.`);
        continue;
      }

      const x = cursor;
      let comp: NoseCone | BodyTube | Transition;
      let bodyRadius: number;
      if (tag === 'nosecone') {
        comp = makeNoseCone(el, x);
        bodyRadius = comp.baseRadius;
      } else if (tag === 'bodytube') {
        comp = makeBodyTube(el, x);
        bodyRadius = comp.outerRadius;
      } else {
        comp = makeTransition(el, x);
        bodyRadius = Math.max(comp.foreRadius, comp.aftRadius);
      }

      cursor += comp.length;
      externalCount++;
      components.push(comp);
      collectAttachedParts(el, comp.x, comp.length, bodyRadius, components, warnings);
    }
    const stageCount = components.length - stageStart;
    if (stageCount > 0) {
      stages.push({
        name: sIdx === 0 ? 'Sustainer' : `Stage ${sIdx + 1}`,
        startComponent: stageStart,
        componentCount: stageCount,
      });
    }
  }

  if (components.length === 0) {
    throw new Error('This RockSim file has no valid nose cone, body tube, or transition.');
  }

  components.forEach((c, i) => {
    c.id = `c${i}`;
  });

  let length = 0;
  let maxRadius = 0;
  for (const c of components) {
    if (c.kind === 'nosecone' || c.kind === 'bodytube' || c.kind === 'transition' || c.kind === 'finset') {
      length = Math.max(length, c.x + c.length);
    }
    if (c.kind === 'nosecone') maxRadius = Math.max(maxRadius, c.baseRadius);
    else if (c.kind === 'bodytube') maxRadius = Math.max(maxRadius, c.outerRadius);
    else if (c.kind === 'transition') maxRadius = Math.max(maxRadius, c.foreRadius, c.aftRadius);
  }

  return {
    name,
    components,
    length,
    maxRadius,
    stageCount: Math.max(1, stages.length),
    ...(stages.length > 1 ? { stages } : {}),
    warnings,
  };
}
