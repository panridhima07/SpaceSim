// Extra .ork access: the simulations OpenRocket stored inside a design file, the
// default motor configuration, and the raw entries of the zip archive (rocket.ork
// plus the embedded thrustcurves/ motor files).

import JSZip from 'jszip';
import { DOMParser as XmldomParser } from '@xmldom/xmldom';
import { decodeOrkText } from './parser';

export interface OrkSimulation {
  name: string;
  configId: string;
  motor?: { manufacturer: string; designation: string; delay: number };
  /** Launch rod length, m. */
  rodLength: number;
  /** Launch rod angle from vertical, rad. */
  rodAngle: number;
  /** Average wind speed, m/s. */
  windSpeed: number;
  maxAltitude: number;
  maxVelocity: number;
  maxAcceleration: number;
  maxMach: number;
  timeToApogee: number;
  flightTime: number;
  groundHitVelocity: number;
  launchRodVelocity: number;
  deploymentVelocity: number;
  optimumDelay: number;
}

// ---------- Minimal DOM typing (browser DOM and @xmldom/xmldom share this subset) ----------

interface XEl {
  nodeType: number;
  nodeName: string;
  childNodes: ArrayLike<XEl>;
  textContent: string | null;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<XEl>;
}

interface XDoc {
  documentElement: XEl;
  getElementsByTagName(name: string): ArrayLike<XEl>;
}

type ParserCtor = new () => { parseFromString(text: string, mime: string): XDoc };

const ELEMENT_NODE = 1;

function parseXml(xml: string): XDoc {
  const Native = (globalThis as unknown as { DOMParser?: ParserCtor }).DOMParser;
  const Ctor: ParserCtor = Native ?? (XmldomParser as unknown as ParserCtor);
  return new Ctor().parseFromString(xml, 'text/xml');
}

function elementChildren(el: XEl): XEl[] {
  const out: XEl[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === ELEMENT_NODE) out.push(c);
  }
  return out;
}

function child(el: XEl, name: string): XEl | undefined {
  return elementChildren(el).find((c) => c.nodeName === name);
}

function childText(el: XEl, name: string): string | undefined {
  const c = child(el, name);
  return c?.textContent?.trim();
}

/** Numeric value of a string, or the fallback when absent or not a number ("none" gives the fallback). */
function num(v: string | null | undefined, fallback = NaN): number {
  if (v === null || v === undefined || v.trim() === '') return fallback;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : fallback;
}

function listAll(doc: XDoc, name: string): XEl[] {
  const list = doc.getElementsByTagName(name);
  const out: XEl[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

// ---------- Public API ----------

/**
 * Every <simulation> in the document that carries <flightdata>. The motor is the
 * <motor configid="..."> whose configid equals the simulation's <conditions><configid>.
 * Angles are returned as stored in the file (radians, SI).
 */
export function extractSimulations(xml: string): OrkSimulation[] {
  const doc = parseXml(xml);
  const motors = listAll(doc, 'motor');
  const out: OrkSimulation[] = [];

  for (const sim of listAll(doc, 'simulation')) {
    const flight = child(sim, 'flightdata');
    if (!flight) continue;
    const cond = child(sim, 'conditions');

    const configId = (cond && childText(cond, 'configid')) || '';
    const motorEl = configId
      ? motors.find((m) => m.getAttribute('configid') === configId)
      : undefined;

    const entry: OrkSimulation = {
      name: child(sim, 'name')?.textContent?.trim() || '',
      configId,
      rodLength: num(cond && childText(cond, 'launchrodlength'), 0),
      rodAngle: num(cond && childText(cond, 'launchrodangle'), 0),
      windSpeed: num(cond && childText(cond, 'windaverage'), 0),
      maxAltitude: num(flight.getAttribute('maxaltitude')),
      maxVelocity: num(flight.getAttribute('maxvelocity')),
      maxAcceleration: num(flight.getAttribute('maxacceleration')),
      maxMach: num(flight.getAttribute('maxmach')),
      timeToApogee: num(flight.getAttribute('timetoapogee')),
      flightTime: num(flight.getAttribute('flighttime')),
      groundHitVelocity: num(flight.getAttribute('groundhitvelocity')),
      launchRodVelocity: num(flight.getAttribute('launchrodvelocity')),
      deploymentVelocity: num(flight.getAttribute('deploymentvelocity')),
      optimumDelay: num(flight.getAttribute('optimumdelay')),
    };

    if (motorEl) {
      entry.motor = {
        manufacturer: childText(motorEl, 'manufacturer') ?? '',
        designation: childText(motorEl, 'designation') ?? '',
        delay: num(childText(motorEl, 'delay')),
      };
    }
    out.push(entry);
  }
  return out;
}

/** configid of the motorconfiguration flagged default="true", or null. */
export function defaultConfigId(xml: string): string | null {
  const doc = parseXml(xml);
  for (const mc of listAll(doc, 'motorconfiguration')) {
    if (mc.getAttribute('default') === 'true') {
      return mc.getAttribute('configid');
    }
  }
  return null;
}

/**
 * Read an .ork file. `xml` is the rocket.ork entry (or the raw text if the input is
 * not a zip). `files` maps every archive entry under thrustcurves/ to its text.
 */
export async function readOrkZip(
  data: Uint8Array | ArrayBuffer,
): Promise<{ xml: string; files: Record<string, string> }> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const isZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    return { xml: await decodeOrkText(bytes), files: {} };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('The .ork archive is damaged and cannot be opened.');
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const rocket = zip.file('rocket.ork') ?? entries.find((f) => /\.ork$/i.test(f.name));
  if (!rocket) throw new Error('The archive has no rocket.ork inside. Is this an OpenRocket file?');
  const xml = await decodeOrkText(await rocket.async('uint8array'));

  const files: Record<string, string> = {};
  for (const f of entries) {
    if (f.name.startsWith('thrustcurves/')) {
      files[f.name] = await f.async('string');
    }
  }
  return { xml, files };
}
