// Unified rocket & motor file importer.
// Detects format by content sniffing first (magic bytes, XML root, JSON, RASP)
// and falls back to filename extension only when needed.

import type { Motor, RocketModel } from '../types';
import { fromRocketModel, toRocketModel, type Design } from '../builder/design';
import { decodeOrkText, parseOrkXml } from '../ork/parser';
import { readOrkZip } from '../ork/orkExtras';
import { parseEng } from '../ork/motors';
import { embeddedMotors, parseRse } from '../ork/rse';
import { parseRockSimXml } from './rocksim';
import { assertFileSize, sanitizeDesignObject } from './limits';

export type ImportFormat = 'ork' | 'rocksim' | 'sfb-json' | 'eng' | 'rse';

export interface ImportResult {
  kind: 'design' | 'motors';
  format: ImportFormat;
  name: string;
  design?: Design;
  model?: RocketModel;
  motors: Motor[];
  warnings: string[];
}

export const IMPORT_EXTENSIONS: string[] = ['.ork', '.rkt', '.json', '.eng', '.rse', '.xml'];

export const IMPORT_ACCEPT: string = [
  ...IMPORT_EXTENSIONS,
  'application/octet-stream',
  'application/zip',
  'application/json',
  'text/xml',
  'application/xml',
  'text/plain',
].join(',');

const UNKNOWN_FORMAT_MSG = "This file type isn't supported. Try .ork, .rkt, .json, .eng or .rse.";

function baseName(filename: string): string {
  const leaf = filename.split(/[/\\]/).pop() ?? filename;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(0, dot) : leaf || 'Imported Rocket';
}

function extOf(filename: string): string {
  const leaf = filename.split(/[/\\]/).pop() ?? filename;
  const dot = leaf.lastIndexOf('.');
  return dot >= 0 ? leaf.slice(dot).toLowerCase() : '';
}

function decodeText(bytes: Uint8Array): string {
  let raw: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    raw = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    raw = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  } else if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) {
    // No BOM, but ASCII-range text encoded as UTF-16LE (NUL in the high byte of the first char).
    raw = new TextDecoder('utf-16le').decode(bytes);
  } else if (bytes.length >= 2 && bytes[0] === 0 && bytes[1] !== 0) {
    raw = new TextDecoder('utf-16be').decode(bytes);
  } else {
    const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    raw = new TextDecoder('utf-8').decode(bytes.subarray(start));
  }
  return raw.replace(/^\uFEFF/, '');
}

function looksBinary(text: string): boolean {
  const sample = text.slice(0, 512);
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0 || code === 0xfffd) return true;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) control++;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

// ---------- JSON sanitization ----------
// The per-part sanitizers live in ./limits so share links and saved designs use them too.

function parseAndSanitizeJson(text: string, filename: string): { design: Design; model: RocketModel; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This JSON file is damaged or not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON file does not contain a rocket design.');
  }

  const warnings: string[] = [];
  let candidateObj: unknown = parsed;

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new Error('JSON array contains no rocket designs.');
    if (parsed.length > 1) {
      warnings.push(`File contained ${parsed.length} saved designs; imported the first one.`);
    }
    const first = parsed[0] as Record<string, unknown>;
    candidateObj = first && typeof first === 'object' && 'design' in first && first.design ? first.design : first;
  } else {
    const obj = parsed as Record<string, unknown>;
    if (obj.format === 'sfb-design' && obj.design && typeof obj.design === 'object') {
      candidateObj = obj.design;
    } else if ('design' in obj && obj.design && typeof obj.design === 'object' && !Array.isArray(obj.stack)) {
      candidateObj = obj.design;
    }
  }

  if (!candidateObj || typeof candidateObj !== 'object') {
    throw new Error('JSON file does not contain a valid rocket design.');
  }

  const rawDesign = candidateObj as Record<string, unknown>;
  if (!Array.isArray(rawDesign.stack)) {
    throw new Error('JSON file is missing a valid rocket stack.');
  }

  const design = sanitizeDesignObject(rawDesign, baseName(filename), warnings);

  const model = toRocketModel(design);
  if (model.components.length === 0) {
    throw new Error('This design has no rocket parts and cannot be loaded.');
  }

  return { design, model, warnings };
}

// ---------- Format handlers ----------

function finalizeModelResult(
  format: 'ork' | 'rocksim',
  model: RocketModel,
  filename: string,
  motors: Motor[],
): ImportResult {
  if (model.components.length === 0) {
    throw new Error('This design has no rocket parts (nose cone, body tube, or transition) and cannot be loaded.');
  }
  const design = fromRocketModel(model);
  if (design.stack.length === 0) {
    throw new Error('This design has no external rocket body parts and cannot be loaded.');
  }
  const name = model.name && model.name !== 'Rocket' ? model.name : baseName(filename);
  return {
    kind: 'design',
    format,
    name,
    design,
    model,
    motors,
    warnings: [...model.warnings],
  };
}

// ---------- Public API ----------

/**
 * Import any supported rocket design or motor file (.ork, .rkt, .json, .eng, .rse).
 * Detects format from content first, falling back to extension only when needed.
 */
export async function importRocketFile(
  data: ArrayBuffer | Uint8Array,
  filename: string,
): Promise<ImportResult> {
  if (data.byteLength > 0) assertFileSize(data.byteLength);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength === 0) {
    throw new Error('The file is empty.');
  }

  // 1. Zip magic (PK\x03\x04 or PK) -> .ork archive
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const { xml, files } = await readOrkZip(bytes);
    const model = parseOrkXml(xml);
    const motors = embeddedMotors(files);
    return finalizeModelResult('ork', model, filename, motors);
  }

  // 2. Gzip magic (1f 8b) -> gzipped .ork
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const xml = await decodeOrkText(bytes);
    const model = parseOrkXml(xml);
    return finalizeModelResult('ork', model, filename, []);
  }

  // 3. Text-based formats (XML, JSON, RASP .eng)
  const text = decodeText(bytes);
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('The file is empty.');
  }
  if (looksBinary(trimmed)) {
    throw new Error(UNKNOWN_FORMAT_MSG);
  }

  const lowerHead = trimmed.slice(0, 2048).toLowerCase();
  const ext = extOf(filename);

  // 3a. XML sniffing
  if (lowerHead.includes('<openrocket')) {
    const model = parseOrkXml(text);
    return finalizeModelResult('ork', model, filename, []);
  }
  if (lowerHead.includes('<rocksimdocument')) {
    const model = parseRockSimXml(text);
    return finalizeModelResult('rocksim', model, filename, []);
  }
  if (lowerHead.includes('<engine-database')) {
    const motors = parseRse(text);
    if (motors.length === 0) {
      throw new Error('No valid motors were found in this .rse file.');
    }
    return {
      kind: 'motors',
      format: 'rse',
      name: filename || 'motors.rse',
      motors,
      warnings: [],
    };
  }

  // 3b. JSON sniffing
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const { design, model, warnings } = parseAndSanitizeJson(trimmed, filename);
    return {
      kind: 'design',
      format: 'sfb-json',
      name: design.name,
      design,
      model,
      motors: [],
      warnings,
    };
  }

  // 3c. RASP .eng sniffing
  const engMotors = parseEng(text);
  if (engMotors.length > 0) {
    return {
      kind: 'motors',
      format: 'eng',
      name: filename || 'motors.eng',
      motors: engMotors,
      warnings: [],
    };
  }

  // 3d. Extension fallbacks for edge-case XML/text files
  if (ext === '.ork' || (ext === '.xml' && lowerHead.includes('<rocket'))) {
    const model = parseOrkXml(text);
    return finalizeModelResult('ork', model, filename, []);
  }
  if (ext === '.rkt') {
    const model = parseRockSimXml(text);
    return finalizeModelResult('rocksim', model, filename, []);
  }
  if (ext === '.rse') {
    const motors = parseRse(text);
    if (motors.length === 0) throw new Error('No valid motors were found in this .rse file.');
    return { kind: 'motors', format: 'rse', name: filename || 'motors.rse', motors, warnings: [] };
  }
  if (ext === '.eng') {
    throw new Error('No motors found in this .eng file.');
  }

  throw new Error(UNKNOWN_FORMAT_MSG);
}
