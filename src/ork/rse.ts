// RockSim .rse engine files, as embedded by OpenRocket inside .ork archives under
// thrustcurves/. Each file is an <engine-database> holding one or more <engine>
// elements. Units in the file: dia/len in mm, weights in grams, t in s, f in N.
// Output is SI (see src/types.ts).

import type { Motor } from '../types';
import { parseEng, usableMotor, type MotorCurve } from './motors';
import { DOMParser as XmldomParser } from '@xmldom/xmldom';
import { assertSafeXmlText } from '../io/limits';

interface XEl {
  nodeType: number;
  nodeName: string;
  childNodes: ArrayLike<XEl>;
  textContent: string | null;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<XEl>;
}

interface XDoc {
  getElementsByTagName(name: string): ArrayLike<XEl>;
}

type ParserCtor = new () => { parseFromString(text: string, mime: string): XDoc };

const ELEMENT_NODE = 1;

function parseXml(xml: string): XDoc {
  const Native = (globalThis as unknown as { DOMParser?: ParserCtor }).DOMParser;
  if (Native) return new Native().parseFromString(xml, 'text/xml');
  // Malformed input is reported through onError; keep it quiet and let the caller see [].
  const Ctor = XmldomParser as unknown as new (opts: unknown) => {
    parseFromString(text: string, mime: string): XDoc;
  };
  return new Ctor({ onError: () => {} }).parseFromString(xml, 'text/xml');
}

function listAll(root: { getElementsByTagName(name: string): ArrayLike<XEl> }, name: string): XEl[] {
  const list = root.getElementsByTagName(name);
  const out: XEl[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

function elementChildren(el: XEl): XEl[] {
  const out: XEl[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === ELEMENT_NODE) out.push(c);
  }
  return out;
}

/** Finite number from an attribute, or NaN. */
function attrNum(el: XEl, name: string): number {
  const raw = el.getAttribute(name);
  if (raw === null || raw.trim() === '') return NaN;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : NaN;
}

function trapezoid(curve: MotorCurve): number {
  let sum = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const [t0, f0] = curve[i];
    const [t1, f1] = curve[i + 1];
    sum += ((f0 + f1) / 2) * (t1 - t0);
  }
  return sum;
}

function engineToMotor(engine: XEl): Motor | null {
  const dataEl = elementChildren(engine).find((c) => c.nodeName === 'data');
  if (!dataEl) return null;

  const points: MotorCurve = [];
  for (const row of elementChildren(dataEl)) {
    if (row.nodeName !== 'eng-data') continue;
    const t = attrNum(row, 't');
    const f = attrNum(row, 'f');
    if (Number.isFinite(t) && Number.isFinite(f)) points.push([t, f]);
  }
  if (points.length === 0) return null;

  const curve: MotorCurve = points.map(([t, f]) => [t, f] as [number, number]);
  if (curve[0][0] > 0) curve.unshift([0, 0]);
  if (curve[curve.length - 1][1] !== 0) {
    curve.push([curve[curve.length - 1][0], 0]);
  }

  const diameter = attrNum(engine, 'dia') / 1000;
  const length = attrNum(engine, 'len') / 1000;
  const totalMass = attrNum(engine, 'initWt') / 1000;
  const propellantMass = attrNum(engine, 'propWt') / 1000;
  if (![diameter, length, totalMass, propellantMass].every(Number.isFinite)) return null;

  const motor: Motor = {
    manufacturer: engine.getAttribute('mfg')?.trim() ?? '',
    designation: engine.getAttribute('code')?.trim() ?? '',
    diameter,
    length,
    totalMass,
    propellantMass,
    curve,
    burnTime: curve[curve.length - 1][0],
    totalImpulse: trapezoid(curve),
    approximate: false,
  };
  return usableMotor(motor) ? motor : null;
}

/**
 * Every <engine> in an RSE document as a Motor. Returns [] for malformed or
 * unrecognised input. Throws only for oversized text or a DOCTYPE / ENTITY declaration.
 */
export function parseRse(xml: string): Motor[] {
  assertSafeXmlText(xml); // the one case that throws: oversized input or a DOCTYPE / ENTITY declaration
  try {
    const doc = parseXml(xml);
    const motors: Motor[] = [];
    for (const engine of listAll(doc, 'engine')) {
      try {
        const motor = engineToMotor(engine);
        if (motor) motors.push(motor);
      } catch {
        // Skip a single broken engine; keep the rest.
      }
    }
    return motors;
  } catch {
    return [];
  }
}

/**
 * Motors from an archive's embedded files: `.rse` entries via parseRse and `.eng`
 * entries via parseEng. Keys are archive paths (as readOrkZip returns them).
 */
export function embeddedMotors(files: Record<string, string>): Motor[] {
  const motors: Motor[] = [];
  for (const [name, text] of Object.entries(files)) {
    const lower = name.toLowerCase();
    try {
      if (lower.endsWith('.rse')) motors.push(...parseRse(text));
      else if (lower.endsWith('.eng')) motors.push(...parseEng(text));
    } catch {
      // Unreadable entry: skip it.
    }
  }
  return motors;
}
