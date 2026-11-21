// Time series OpenRocket stored inside a .ork file: the <databranch> rows of one
// <simulation>'s <flightdata>. Columns are named by the databranch `types` attribute.

import { DOMParser as XmldomParser } from '@xmldom/xmldom';

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

function listAll(root: { getElementsByTagName(name: string): ArrayLike<XEl> }, name: string): XEl[] {
  const list = root.getElementsByTagName(name);
  const out: XEl[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

/**
 * Column name -> values for the first <databranch> of the simulation at `simIndex`.
 * `simIndex` counts only <simulation> elements that carry <flightdata> (the same list
 * `extractSimulations` returns). Returns {} when the index or the databranch is missing.
 * NaN is returned for OpenRocket's "NaN" cells.
 */
export function extractSeries(xml: string, simIndex: number): Record<string, number[]> {
  const doc = parseXml(xml);
  const sims = listAll(doc, 'simulation').filter((s) =>
    elementChildren(s).some((c) => c.nodeName === 'flightdata'),
  );
  const sim = sims[simIndex];
  if (!sim) return {};
  const flight = elementChildren(sim).find((c) => c.nodeName === 'flightdata');
  if (!flight) return {};
  const branch = elementChildren(flight).find((c) => c.nodeName === 'databranch');
  if (!branch) return {};

  const types = (branch.getAttribute('types') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: Record<string, number[]> = {};
  for (const name of types) out[name] = [];

  for (const row of elementChildren(branch)) {
    if (row.nodeName !== 'datapoint') continue;
    const cells = (row.textContent ?? '').trim().split(',');
    types.forEach((name, i) => {
      const raw = cells[i];
      const v = raw === undefined ? NaN : Number(raw.trim());
      out[name].push(raw === undefined || raw.trim() === '' ? NaN : v);
    });
  }
  return out;
}
