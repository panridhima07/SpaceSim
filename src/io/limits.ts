// Shared size limits, clamp helpers and the design sanitizer used wherever an untrusted
// rocket design enters the app (JSON files, share links, saved designs, .ork, .rkt).
// Pure TypeScript with type-only imports, so storage.ts and importer.ts can both use it
// without an import cycle.

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
  SideBody,
  Transition,
} from '../types';
import type {
  ChildNode,
  Design,
  ExternalComponent,
  InternalComponent,
  StackNode,
} from '../builder/design';
import type { AnchorMode } from '../builder/parts';

// ---------- Limits ----------

/** Parts in the main stack. */
export const MAX_STACK_PARTS = 200;
/** Child parts under one stack part. */
export const MAX_CHILDREN = 1000;
/** All parts (stack plus children) in one design. */
export const MAX_TOTAL_PARTS = 5000;
/** Fin count, radial count, instance count, tube-fin count, cluster size. */
export const MAX_COUNT = 64;
/** Lengths, chords, spans, offsets, metres. */
export const MAX_LENGTH_M = 100;
/** Radii, metres. */
export const MAX_RADIUS_M = 10;
/** Masses, kg. */
export const MAX_MASS_KG = 1e6;
/** Freeform fin outline points. */
export const MAX_FIN_POINTS = 256;
/** Side bodies (boosters, pods, tube fins) in one design. */
export const MAX_SIDE_BODIES = 16;
/** Nesting depth of components when parsing XML. */
export const MAX_NEST_DEPTH = 16;

/** Largest input file accepted, bytes. Also the largest XML text, characters. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_XML_CHARS = 20 * 1024 * 1024;
/** Largest total of bytes inflated from one archive or gzip stream. */
export const MAX_INFLATED_BYTES = 40 * 1024 * 1024;
/** Zip entries considered, and thrustcurves/ entries read. */
export const MAX_ZIP_ENTRIES = 200;
export const MAX_THRUST_ENTRIES = 100;

/** Share link: longest base64 payload, and largest decompressed JSON, bytes. */
export const MAX_SHARE_ENCODED_CHARS = 400_000;
export const MAX_SHARE_INFLATED_BYTES = 2_000_000;

export class SizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SizeLimitError';
  }
}

// ---------- Clamp helpers ----------

export function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Clamp v to [min, max]; a non-finite v (NaN or ±Infinity) gives the fallback, which is `min`. */
export function clampRange(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}
export function clampLength(v: number): number {
  return clampRange(v, 0, MAX_LENGTH_M);
}
export function clampRadius(v: number): number {
  return clampRange(v, 0, MAX_RADIUS_M);
}
export function clampMass(v: number): number {
  return clampRange(v, 0, MAX_MASS_KG);
}
/** Signed offset (station, position), clamped to +-MAX_LENGTH_M. */
export function clampOffset(v: number): number {
  return clampRange(v, -MAX_LENGTH_M, MAX_LENGTH_M);
}
/** Integer count in [1, MAX_COUNT]; non-finite gives the fallback (itself clamped). */
export function clampCount(v: unknown, fallback = 1): number {
  const n = isFiniteNum(v) ? Math.round(v) : fallback;
  return clampRange(n, 1, MAX_COUNT);
}

// ---------- Text guards ----------

const XML_FORBIDDEN = /<!\s*(?:DOCTYPE|ENTITY)/i;

/** Reject oversized XML and any document that declares a DOCTYPE or ENTITY (entity-expansion attacks). */
export function assertSafeXmlText(text: string): void {
  if (text.length > MAX_XML_CHARS) {
    throw new Error('This file is too large to import (the limit is 20 MB).');
  }
  if (XML_FORBIDDEN.test(text)) {
    throw new Error('This file contains an XML DOCTYPE or ENTITY declaration, which is not allowed.');
  }
}

export function assertFileSize(byteLength: number): void {
  if (byteLength > MAX_FILE_BYTES) {
    throw new Error('This file is too large to import (the limit is 20 MB).');
  }
}

// ---------- Capped decompression ----------

/** Read a byte stream, throwing SizeLimitError once more than `max` bytes have arrived. */
export async function readStreamCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new SizeLimitError('Decompressed data is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Inflate with a DecompressionStream, capped at `max` output bytes.
 * Returns undefined when the platform has no DecompressionStream; throws SizeLimitError over the cap
 * (any other failure, for example corrupt data, is thrown as-is).
 */
export async function inflateCapped(
  bytes: Uint8Array,
  format: 'gzip' | 'deflate-raw',
  max: number,
): Promise<Uint8Array | undefined> {
  const DS = (globalThis as unknown as {
    DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array>;
  }).DecompressionStream;
  if (!DS) return undefined;
  const piped = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DS(format));
  return readStreamCapped(piped as unknown as ReadableStream<Uint8Array>, max);
}

// ---------- Zip budget ----------

/** The subset of a JSZip entry used here. */
export interface ZipEntryLike {
  name: string;
  async(type: 'uint8array'): Promise<Uint8Array>;
  async(type: 'string'): Promise<string>;
}

/** Running total of bytes inflated from one archive. */
export interface ZipBudget {
  used: number;
}

/**
 * Inflate one zip entry under the archive budget. The declared size is checked before inflating
 * (JSZip also rejects an entry whose real size differs from its declared one), and the real size after.
 */
export async function readZipEntry(
  entry: ZipEntryLike,
  budget: ZipBudget,
  as: 'uint8array' | 'string',
  perEntryMax = MAX_FILE_BYTES,
): Promise<Uint8Array | string> {
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof declared === 'number' && (declared > perEntryMax || budget.used + declared > MAX_INFLATED_BYTES)) {
    throw new Error('The .ork archive expands to more than the allowed size and was rejected.');
  }
  const data = as === 'string' ? await entry.async('string') : await entry.async('uint8array');
  const size = as === 'string' ? (data as string).length : (data as Uint8Array).length;
  budget.used += size;
  if (size > perEntryMax || budget.used > MAX_INFLATED_BYTES) {
    throw new Error('The .ork archive expands to more than the allowed size and was rejected.');
  }
  return data;
}

// ---------- Design sanitizer ----------

export const VALID_NOSE_SHAPES = new Set<NoseShape>(['conical', 'ogive', 'ellipsoid', 'power', 'parabolic', 'haack']);
const VALID_ANCHORS = new Set<AnchorMode>(['top', 'middle', 'bottom']);
const VALID_FIN_SHAPES = new Set<FinSet['finShape']>(['trapezoid', 'elliptical', 'freeform']);
const VALID_DEPLOY_EVENTS = new Set<Parachute['deployEvent']>(['apogee', 'ejection', 'altitude']);
const VALID_RING_TYPES = new Set<NonNullable<Ring['ringType']>>([
  'centeringring', 'bulkhead', 'tubecoupler', 'engineblock', 'launchlug', 'railbutton', 'shoulder',
]);
const EXTERNAL_KINDS = new Set(['nosecone', 'bodytube', 'transition']);

const MAX_NAME = 120;
const MAX_ID = 64;

function finiteNum(v: unknown): number | undefined {
  return isFiniteNum(v) ? v : undefined;
}
function posNum(v: unknown): number | undefined {
  return isFiniteNum(v) && v > 0 ? v : undefined;
}
function nonNegNum(v: unknown, fallback: number): number {
  return isFiniteNum(v) && v >= 0 ? v : fallback;
}
function strOr(v: unknown, fallback: string, max = MAX_NAME): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : fallback;
}
/** Optional finite number, clamped. */
function optClamped(v: unknown, lo: number, hi: number): number | undefined {
  const n = finiteNum(v);
  return n === undefined ? undefined : clampRange(n, lo, hi);
}

function sanitizeMotor(raw: unknown): MotorRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  return {
    manufacturer: typeof m.manufacturer === 'string' ? m.manufacturer.slice(0, MAX_NAME) : '',
    designation: typeof m.designation === 'string' ? m.designation.slice(0, MAX_NAME) : '',
    diameter: clampRadius(nonNegNum(m.diameter, 0)),
    length: clampLength(nonNegNum(m.length, 0)),
    // NaN or Infinity (plugged / no ejection) survive JSON only as null, which also means "none".
    delay: isFiniteNum(m.delay) ? clampRange(m.delay, 0, 1e4) : NaN,
  };
}

export function sanitizeExternal(raw: unknown, warnings: string[]): ExternalComponent | null {
  if (!raw || typeof raw !== 'object') {
    warnings.push('Dropped an invalid external part entry.');
    return null;
  }
  const p = raw as Record<string, unknown>;
  const kind = p.kind;
  const massOverride = posNum(p.massOverride);
  const cgOverride = finiteNum(p.cgOverride);
  const base = {
    id: strOr(p.id, '', MAX_ID),
    name: strOr(p.name, typeof kind === 'string' ? kind.slice(0, MAX_NAME) : 'Part'),
    x: clampOffset(finiteNum(p.x) ?? 0),
    length: 0,
    density: clampRange(nonNegNum(p.density, 680), 0, 30000),
    ...(massOverride !== undefined ? { massOverride: clampMass(massOverride) } : {}),
    ...(cgOverride !== undefined ? { cgOverride: clampOffset(cgOverride) } : {}),
    ...(isFiniteNum(p.color) ? { color: clampRange(Math.round(p.color), 0, 0xffffff) } : {}),
    ...(typeof p.finish === 'string' ? { finish: p.finish.slice(0, 32) } : {}),
  };

  if (kind === 'nosecone') {
    const length = posNum(p.length);
    const baseRadius = posNum(p.baseRadius);
    if (length === undefined || baseRadius === undefined) {
      warnings.push(`Dropped nose cone "${base.name}" with missing or non-positive dimensions.`);
      return null;
    }
    const radius = clampRadius(baseRadius);
    const shape: NoseShape = VALID_NOSE_SHAPES.has(p.shape as NoseShape) ? (p.shape as NoseShape) : 'ogive';
    if (p.shape !== undefined && p.shape !== shape) {
      warnings.push(`Repaired unknown nose shape on "${base.name}" to "${shape}".`);
    }
    const nose: NoseCone = {
      ...base,
      kind: 'nosecone',
      length: clampLength(length),
      shape,
      shapeParam: clampRange(finiteNum(p.shapeParam) ?? 0, -100, 100),
      baseRadius: radius,
      thickness: Math.min(radius, nonNegNum(p.thickness, 0.002)),
      ...(typeof p.flipped === 'boolean' ? { flipped: p.flipped } : {}),
    };
    return nose;
  }

  if (kind === 'bodytube') {
    const length = posNum(p.length);
    const outerRadius = posNum(p.outerRadius);
    if (length === undefined || outerRadius === undefined) {
      warnings.push(`Dropped body tube "${base.name}" with missing or non-positive dimensions.`);
      return null;
    }
    const radius = clampRadius(outerRadius);
    const tube: BodyTube = {
      ...base,
      kind: 'bodytube',
      length: clampLength(length),
      outerRadius: radius,
      thickness: Math.min(radius * 0.99, nonNegNum(p.thickness, Math.min(0.0015, radius * 0.1))),
      ...(typeof p.isDecoupler === 'boolean' ? { isDecoupler: p.isDecoupler } : {}),
    };
    return tube;
  }

  if (kind === 'transition') {
    const length = posNum(p.length);
    const foreRadius = finiteNum(p.foreRadius);
    const aftRadius = finiteNum(p.aftRadius);
    if (
      length === undefined ||
      foreRadius === undefined || foreRadius < 0 ||
      aftRadius === undefined || aftRadius < 0 ||
      (foreRadius === 0 && aftRadius === 0)
    ) {
      warnings.push(`Dropped transition "${base.name}" with invalid dimensions.`);
      return null;
    }
    const fore = clampRadius(foreRadius);
    const aft = clampRadius(aftRadius);
    const shape = VALID_NOSE_SHAPES.has(p.shape as NoseShape) ? (p.shape as NoseShape) : undefined;
    const trans: Transition = {
      ...base,
      kind: 'transition',
      length: clampLength(length),
      foreRadius: fore,
      aftRadius: aft,
      thickness: Math.min(Math.max(fore, aft), nonNegNum(p.thickness, 0.0015)),
      ...(shape ? { shape, shapeParam: clampRange(finiteNum(p.shapeParam) ?? 0.5, -100, 100) } : {}),
      ...(typeof p.clipped === 'boolean' ? { clipped: p.clipped } : {}),
    };
    return trans;
  }

  warnings.push(`Dropped unsupported external component kind "${String(kind)}".`);
  return null;
}

export function sanitizeInternal(raw: unknown, parentOuter: number, warnings: string[]): InternalComponent | null {
  if (!raw || typeof raw !== 'object') {
    warnings.push('Dropped an invalid child component.');
    return null;
  }
  const p = raw as Record<string, unknown>;
  const kind = p.kind;
  const massOverride = posNum(p.massOverride);
  const cgOverride = finiteNum(p.cgOverride);
  const base = {
    id: strOr(p.id, '', MAX_ID),
    name: strOr(p.name, typeof kind === 'string' ? kind.slice(0, MAX_NAME) : 'Part'),
    x: clampOffset(finiteNum(p.x) ?? 0),
    length: 0,
    density: clampRange(nonNegNum(p.density, 680), 0, 30000),
    ...(massOverride !== undefined ? { massOverride: clampMass(massOverride) } : {}),
    ...(cgOverride !== undefined ? { cgOverride: clampOffset(cgOverride) } : {}),
    ...(isFiniteNum(p.color) ? { color: clampRange(Math.round(p.color), 0, 0xffffff) } : {}),
    ...(typeof p.finish === 'string' ? { finish: p.finish.slice(0, 32) } : {}),
  };

  if (kind === 'finset') {
    const rootChord = posNum(p.rootChord);
    const span = posNum(p.span);
    if (rootChord === undefined || span === undefined) {
      warnings.push(`Dropped fin set "${base.name}" with missing or non-positive chord/span.`);
      return null;
    }
    const chord = clampLength(rootChord);
    const finShape: FinSet['finShape'] = VALID_FIN_SHAPES.has(p.finShape as FinSet['finShape'])
      ? (p.finShape as FinSet['finShape'])
      : 'trapezoid';
    const points = Array.isArray(p.points)
      ? (p.points as unknown[])
          .slice(0, MAX_FIN_POINTS)
          .filter((pt): pt is [number, number] => Array.isArray(pt) && pt.length >= 2 && isFiniteNum(pt[0]) && isFiniteNum(pt[1]))
          .map(([a, r]) => [clampOffset(a), clampOffset(r)] as [number, number])
      : undefined;
    const filletRadius = optClamped(p.filletRadius, 0, MAX_RADIUS_M);
    const tabHeight = optClamped(p.tabHeight, 0, MAX_LENGTH_M);
    const tabLength = optClamped(p.tabLength, 0, MAX_LENGTH_M);
    const tabOffset = optClamped(p.tabOffset, -MAX_LENGTH_M, MAX_LENGTH_M);
    const fin: FinSet = {
      ...base,
      kind: 'finset',
      length: chord,
      count: clampCount(p.count, 3),
      rootChord: chord,
      tipChord: clampLength(nonNegNum(p.tipChord, chord * 0.5)),
      span: clampLength(span),
      sweepLength: clampOffset(finiteNum(p.sweepLength) ?? 0),
      thickness: clampRadius(posNum(p.thickness) ?? 0.002),
      cant: clampRange(finiteNum(p.cant) ?? 0, -Math.PI, Math.PI),
      bodyRadius: clampRadius(nonNegNum(p.bodyRadius, parentOuter)),
      finShape: finShape === 'freeform' && (!points || points.length < 3) ? 'trapezoid' : finShape,
      ...(points && points.length >= 3 ? { points } : {}),
      ...(p.crossSection === 'square' || p.crossSection === 'rounded' || p.crossSection === 'airfoil'
        ? { crossSection: p.crossSection }
        : {}),
      ...(finiteNum(p.angleOffset) !== undefined ? { angleOffset: clampRange(finiteNum(p.angleOffset)!, -100, 100) } : {}),
      ...(filletRadius !== undefined && filletRadius > 0 ? { filletRadius } : {}),
      ...(tabHeight !== undefined && tabLength !== undefined && tabHeight > 0 && tabLength > 0
        ? { tabHeight, tabLength, tabOffset: tabOffset ?? 0 }
        : {}),
    };
    return fin;
  }

  if (kind === 'innertube') {
    const length = posNum(p.length);
    const outerRadius = posNum(p.outerRadius);
    if (length === undefined || outerRadius === undefined) {
      warnings.push(`Dropped inner tube "${base.name}" with missing or non-positive dimensions.`);
      return null;
    }
    const radius = clampRadius(outerRadius);
    const motor = sanitizeMotor(p.motor);
    const cluster = Array.isArray(p.cluster)
      ? (p.cluster as unknown[])
          .slice(0, MAX_COUNT)
          .filter((pt): pt is [number, number] => Array.isArray(pt) && pt.length >= 2 && isFiniteNum(pt[0]) && isFiniteNum(pt[1]))
          .map(([a, b]) => [clampRange(a, -MAX_RADIUS_M, MAX_RADIUS_M), clampRange(b, -MAX_RADIUS_M, MAX_RADIUS_M)] as [number, number])
      : undefined;
    const inner: InnerTube = {
      ...base,
      kind: 'innertube',
      length: clampLength(length),
      outerRadius: radius,
      thickness: Math.min(radius * 0.99, nonNegNum(p.thickness, 0.001)),
      isMotorMount: Boolean(p.isMotorMount),
      overhang: clampOffset(finiteNum(p.overhang) ?? 0),
      ...(motor ? { motor } : {}),
      ...(posNum(p.radialCount) !== undefined ? { radialCount: clampCount(p.radialCount) } : {}),
      ...(finiteNum(p.radialOffset) !== undefined ? { radialOffset: clampRange(finiteNum(p.radialOffset)!, -MAX_RADIUS_M, MAX_RADIUS_M) } : {}),
      ...(cluster && cluster.length >= 2 ? { cluster } : {}),
    };
    return inner;
  }

  if (kind === 'parachute') {
    const diameter = posNum(p.diameter);
    if (diameter === undefined) {
      warnings.push(`Dropped parachute "${base.name}" with missing or non-positive diameter.`);
      return null;
    }
    const deployEvent = VALID_DEPLOY_EVENTS.has(p.deployEvent as Parachute['deployEvent'])
      ? (p.deployEvent as Parachute['deployEvent'])
      : 'apogee';
    const chute: Parachute = {
      ...base,
      kind: 'parachute',
      length: clampLength(posNum(p.length) ?? 0.05),
      diameter: clampLength(diameter),
      cd: clampRange(posNum(p.cd) ?? 0.8, 0, 10),
      deployEvent,
      deployAltitude: clampRange(nonNegNum(p.deployAltitude, 150), 0, 1e5),
      deployDelay: clampRange(nonNegNum(p.deployDelay, 0), 0, 1e4),
      mass: clampMass(nonNegNum(p.mass, 0.015)),
    };
    return chute;
  }

  if (kind === 'mass') {
    const mass = finiteNum(p.mass);
    if (mass === undefined || mass < 0) {
      warnings.push(`Dropped mass component "${base.name}" with invalid mass.`);
      return null;
    }
    const mc: MassComponent = {
      ...base,
      kind: 'mass',
      length: clampLength(posNum(p.length) ?? 0.02),
      mass: clampMass(mass),
    };
    return mc;
  }

  if (kind === 'ring') {
    const outerRadius = posNum(p.outerRadius);
    const length = posNum(p.length);
    if (outerRadius === undefined || length === undefined) {
      warnings.push(`Dropped ring "${base.name}" with missing or non-positive dimensions.`);
      return null;
    }
    const radius = clampRadius(outerRadius);
    const instanceCount = posNum(p.instanceCount) !== undefined ? clampCount(p.instanceCount) : undefined;
    const ring: Ring = {
      ...base,
      kind: 'ring',
      length: clampLength(length),
      outerRadius: radius,
      innerRadius: Math.min(radius, clampRadius(nonNegNum(p.innerRadius, 0))),
      ...(typeof p.external === 'boolean' ? { external: p.external } : {}),
      ...(VALID_RING_TYPES.has(p.ringType as NonNullable<Ring['ringType']>) ? { ringType: p.ringType as Ring['ringType'] } : {}),
      ...(finiteNum(p.mountRadius) !== undefined ? { mountRadius: clampRadius(Math.max(0, finiteNum(p.mountRadius)!)) } : {}),
      ...(finiteNum(p.angle) !== undefined ? { angle: clampRange(finiteNum(p.angle)!, -100, 100) } : {}),
      ...(instanceCount !== undefined && instanceCount > 1
        ? { instanceCount, instanceSeparation: clampOffset(finiteNum(p.instanceSeparation) ?? 0) }
        : {}),
    };
    return ring;
  }

  warnings.push(`Dropped unsupported child component kind "${String(kind)}".`);
  return null;
}

/** The part a side body hangs on; dropped unless every field is usable. */
function sanitizeMount(raw: unknown): { mount?: NonNullable<SideBody['mount']> } {
  if (!raw || typeof raw !== 'object') return {};
  const m = raw as Record<string, unknown>;
  const aftOffset = finiteNum(m.aftOffset);
  const gap = finiteNum(m.gap);
  if (typeof m.parentId !== 'string' || m.parentId === '' || aftOffset === undefined || gap === undefined) return {};
  return {
    mount: {
      parentId: m.parentId.slice(0, MAX_ID),
      aftOffset: clampRange(aftOffset, -1000, 1000),
      gap: clampRange(gap, -MAX_RADIUS_M, MAX_RADIUS_M),
    },
  };
}

function sanitizeSideBodies(raw: unknown, warnings: string[]): SideBody[] {
  if (!Array.isArray(raw)) return [];
  const out: SideBody[] = [];
  for (const rawSb of raw.slice(0, MAX_SIDE_BODIES)) {
    if (!rawSb || typeof rawSb !== 'object') continue;
    const sb = rawSb as Record<string, unknown>;
    if (!Array.isArray(sb.components)) continue;
    const components: Component[] = [];
    for (const rawC of sb.components.slice(0, MAX_STACK_PARTS)) {
      const kind = rawC && typeof rawC === 'object' ? (rawC as Record<string, unknown>).kind : undefined;
      const comp = typeof kind === 'string' && EXTERNAL_KINDS.has(kind)
        ? sanitizeExternal(rawC, warnings)
        : sanitizeInternal(rawC, 0.025, warnings);
      if (comp) components.push(comp);
    }
    if (components.length === 0) continue;
    const type: SideBody['type'] = sb.type === 'pod' || sb.type === 'tubefin' ? sb.type : 'booster';
    out.push({
      id: strOr(sb.id, '', MAX_ID),
      name: strOr(sb.name, 'Side body'),
      type,
      count: clampCount(sb.count, 2),
      radialOffset: clampRange(finiteNum(sb.radialOffset) ?? 0, 0, MAX_RADIUS_M),
      angle: clampRange(finiteNum(sb.angle) ?? 0, -100, 100),
      components,
      ...sanitizeMount(sb.mount),
    });
  }
  return out;
}

/**
 * Sanitize a raw design object (already JSON-parsed, already unwrapped from any envelope).
 * Throws when `stack` is not an array or nothing valid remains. Invalid nodes and children are
 * dropped with a warning; numbers are made finite and clamped to the limits above.
 */
export function sanitizeDesignObject(
  rawDesign: Record<string, unknown>,
  fallbackName: string,
  warnings: string[],
): Design {
  if (!Array.isArray(rawDesign.stack)) {
    throw new Error('JSON file is missing a valid rocket stack.');
  }
  if (rawDesign.stack.length > MAX_STACK_PARTS) {
    warnings.push(`Kept the first ${MAX_STACK_PARTS} of ${rawDesign.stack.length} parts.`);
  }

  const usedIds = new Set<string>();
  let maxNumericId = 0;
  const reserveId = (rawId: unknown): string => {
    if (typeof rawId === 'string' && rawId.trim() !== '' && rawId.trim().length <= MAX_ID && !usedIds.has(rawId.trim())) {
      const id = rawId.trim();
      usedIds.add(id);
      const m = /^p(\d+)$/.exec(id);
      if (m) maxNumericId = Math.max(maxNumericId, Math.min(Number(m[1]), 1e9));
      return id;
    }
    let next = maxNumericId + 1;
    while (usedIds.has(`p${next}`)) next++;
    maxNumericId = next;
    const id = `p${next}`;
    usedIds.add(id);
    return id;
  };

  const stack: StackNode[] = [];
  let totalParts = 0;
  for (const rawNode of rawDesign.stack.slice(0, MAX_STACK_PARTS)) {
    if (!rawNode || typeof rawNode !== 'object') {
      warnings.push('Dropped an invalid stack entry.');
      continue;
    }
    const nodeObj = rawNode as Record<string, unknown>;
    const ext = sanitizeExternal(nodeObj.part, warnings);
    if (!ext) continue;

    const nodeId = reserveId(nodeObj.id ?? ext.id);
    ext.id = nodeId;

    const parentOuter = ext.kind === 'nosecone'
      ? ext.baseRadius
      : ext.kind === 'bodytube'
        ? ext.outerRadius
        : Math.max(ext.foreRadius, ext.aftRadius);

    const rawChildren = Array.isArray(nodeObj.children) ? nodeObj.children : [];
    if (rawChildren.length > MAX_CHILDREN) {
      warnings.push(`Kept the first ${MAX_CHILDREN} of ${rawChildren.length} child parts on "${ext.name}".`);
    }
    const children: ChildNode[] = [];
    for (const rawCh of rawChildren.slice(0, MAX_CHILDREN)) {
      if (totalParts >= MAX_TOTAL_PARTS) {
        warnings.push(`Stopped at ${MAX_TOTAL_PARTS} total parts.`);
        break;
      }
      if (!rawCh || typeof rawCh !== 'object') {
        warnings.push('Dropped an invalid child entry.');
        continue;
      }
      const chObj = rawCh as Record<string, unknown>;
      const part = sanitizeInternal(chObj.part, parentOuter, warnings);
      if (!part) continue;

      const chId = reserveId(chObj.id ?? part.id);
      part.id = chId;

      const defaultAnchor: AnchorMode = part.kind === 'finset' || part.kind === 'innertube' ? 'bottom' : 'top';
      let anchor: AnchorMode = defaultAnchor;
      if (VALID_ANCHORS.has(chObj.anchor as AnchorMode)) {
        anchor = chObj.anchor as AnchorMode;
      } else if (chObj.anchor !== undefined) {
        warnings.push(`Repaired invalid anchor on "${part.name}" to "${defaultAnchor}".`);
      }

      let offset = 0;
      if (isFiniteNum(chObj.offset)) {
        offset = clampOffset(chObj.offset);
      } else if (chObj.offset !== undefined) {
        warnings.push(`Repaired invalid offset on "${part.name}" to 0.`);
      }

      children.push({ id: chId, part, anchor, offset });
      totalParts++;
    }

    const rawStage = nodeObj.stage as Record<string, unknown> | undefined;
    const stage =
      rawStage && typeof rawStage === 'object' && typeof rawStage.name === 'string'
        ? {
            name: rawStage.name.slice(0, 80),
            ...(isFiniteNum(rawStage.massOverride) && rawStage.massOverride >= 0
              ? { massOverride: clampMass(rawStage.massOverride) }
              : {}),
            ...(typeof rawStage.overrideSubcomponentsMass === 'boolean'
              ? { overrideSubcomponentsMass: rawStage.overrideSubcomponentsMass }
              : {}),
          }
        : undefined;

    totalParts++;
    stack.push({ id: nodeId, part: ext, children, ...(stage ? { stage } : {}) });
  }

  if (stack.length === 0) {
    throw new Error('No valid rocket components remained in this JSON file.');
  }

  const nextId = Math.max(
    maxNumericId + 1,
    isFiniteNum(rawDesign.nextId) ? Math.min(Math.ceil(rawDesign.nextId), 1e9) : 1,
  );

  const sideBodies = sanitizeSideBodies(rawDesign.sideBodies, warnings);
  const importWarnings = Array.isArray(rawDesign.importWarnings)
    ? rawDesign.importWarnings
        .filter((w): w is string => typeof w === 'string')
        .slice(0, 50)
        .map((w) => w.slice(0, 300))
    : [];

  return {
    id: strOr(rawDesign.id, `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, MAX_ID),
    name: strOr(rawDesign.name, fallbackName),
    stack,
    nextId,
    ...(sideBodies.length > 0 ? { sideBodies } : {}),
    ...(importWarnings.length > 0 ? { importWarnings } : {}),
  };
}
