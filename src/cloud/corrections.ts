// Remembered import corrections: diff what our importer produced against what the user
// fixed, and keep the fix per file (keyed by SHA-256) on this device.
// Pure TypeScript — no DOM. Storage is injectable (StorageLike) for tests.

import type { ChildNode, Design, StackNode } from '../builder/design';
import type { StorageLike } from '../builder/storage';
import { sanitizeDesignObject } from '../io/limits';
import type { Component, RocketModel, SideBody } from '../types';
import type { CorrectionChange, ImportCorrection } from './types';

const NUM_TOL = 1e-9;
const MAX_NOTE = 2000;
const MAX_FILENAME = 200;

/** Lower-case hex SHA-256 of the file bytes (Web Crypto: works in browsers and Node 20+). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// Diff

function deepEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (a === b) return true;
    return Math.abs(a - b) <= NUM_TOL;
  }
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Names of component fields whose values differ. `id` and `x` are ignored. */
function diffFields(a: Component, b: Component): string[] {
  const ao = a as unknown as Record<string, unknown>;
  const bo = b as unknown as Record<string, unknown>;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const k of [...Object.keys(bo), ...Object.keys(ao)]) {
    if (k === 'id' || k === 'x' || seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  return keys.filter((k) => !deepEqual(ao[k], bo[k]));
}

/** Indices (into `seq`) of one longest strictly increasing subsequence. */
function lisIndices(seq: number[]): Set<number> {
  const n = seq.length;
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j] < seq[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
    if (best === -1 || len[i] > len[best]) best = i;
  }
  const out = new Set<number>();
  for (let i = best; i !== -1 && i >= 0; i = prev[i]) out.add(i);
  return out;
}

function sideBodyEntry(kind: CorrectionChange['kind'], sb: SideBody): CorrectionChange {
  return { kind, partName: sb.name, partKind: 'sidebody' };
}

/**
 * What changed between the design our importer produced and the one the user corrected.
 * Parts are matched by id first (ids are stable within one import), so a renamed or
 * resized part is 'changed', not removed+added. Empty when nothing differs.
 *
 * A stack node counts as 'moved' when it is out of order relative to the other parts the
 * two designs share (removing or inserting a part does not flag everything after it).
 */
export function diffDesigns(imported: Design, corrected: Design): CorrectionChange[] {
  const impStack = new Map<string, { node: StackNode; index: number }>();
  imported.stack.forEach((node, index) => {
    if (!impStack.has(node.id)) impStack.set(node.id, { node, index });
  });
  const impChild = new Map<string, { child: ChildNode; parentId: string }>();
  for (const node of imported.stack) {
    for (const child of node.children) {
      if (!impChild.has(child.id)) impChild.set(child.id, { child, parentId: node.id });
    }
  }

  // Which corrected stack nodes are out of order among the shared ones.
  const shared = corrected.stack.filter((n) => impStack.has(n.id));
  const movedStack = new Set<string>();
  if (shared.length > 1) {
    const seq = shared.map((n) => impStack.get(n.id)!.index);
    const keep = lisIndices(seq);
    shared.forEach((n, i) => {
      if (!keep.has(i)) movedStack.add(n.id);
    });
  }

  const out: CorrectionChange[] = [];
  const matchedStack = new Set<string>();
  const matchedChild = new Set<string>();

  const emit = (
    base: { partName: string; partKind: string },
    moved: boolean,
    fields: string[],
  ): void => {
    if (fields.length > 0) {
      out.push({ kind: 'changed', ...base, fields: moved ? [...fields, 'position'] : fields });
    } else if (moved) {
      out.push({ kind: 'moved', ...base });
    }
  };

  for (const node of corrected.stack) {
    const base = { partName: node.part.name, partKind: node.part.kind };
    const before = impStack.get(node.id);
    if (!before) {
      out.push({ kind: 'added', ...base });
    } else {
      matchedStack.add(node.id);
      const fields = diffFields(before.node.part, node.part);
      if (!deepEqual(before.node.stage, node.stage)) fields.push('stage');
      emit(base, movedStack.has(node.id), fields);
    }

    for (const child of node.children) {
      const cbase = { partName: child.part.name, partKind: child.part.kind };
      const was = impChild.get(child.id);
      if (!was) {
        out.push({ kind: 'added', ...cbase });
        continue;
      }
      matchedChild.add(child.id);
      const moved =
        was.parentId !== node.id ||
        was.child.anchor !== child.anchor ||
        !deepEqual(was.child.offset, child.offset);
      emit(cbase, moved, diffFields(was.child.part, child.part));
    }
  }

  // Side bodies (boosters, pods, tube fins) carried over from the file.
  const impSide = new Map((imported.sideBodies ?? []).map((sb) => [sb.id, sb] as const));
  const corSide = corrected.sideBodies ?? [];
  const matchedSide = new Set<string>();
  for (const sb of corSide) {
    const was = impSide.get(sb.id);
    if (!was) out.push(sideBodyEntry('added', sb));
    else {
      matchedSide.add(sb.id);
      if (!deepEqual(was, sb)) out.push(sideBodyEntry('changed', sb));
    }
  }

  // Removed parts last, in imported order.
  for (const node of imported.stack) {
    if (!matchedStack.has(node.id)) {
      out.push({ kind: 'removed', partName: node.part.name, partKind: node.part.kind });
    }
    for (const child of node.children) {
      if (!matchedChild.has(child.id)) {
        out.push({ kind: 'removed', partName: child.part.name, partKind: child.part.kind });
      }
    }
  }
  for (const sb of imported.sideBodies ?? []) {
    if (!matchedSide.has(sb.id)) out.push(sideBodyEntry('removed', sb));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plain-English description

const KIND_LABEL: Record<string, string> = {
  nosecone: 'Nose cone',
  bodytube: 'Body tube',
  transition: 'Transition',
  finset: 'Fins',
  innertube: 'Inner tube',
  parachute: 'Parachute',
  mass: 'Mass',
  ring: 'Ring',
  sidebody: 'Side body',
};

const FIELD_LABEL: Record<string, string> = {
  name: 'name',
  length: 'length',
  density: 'density',
  massOverride: 'mass override',
  cgOverride: 'CG override',
  color: 'colour',
  finish: 'finish',
  shape: 'shape',
  shapeParam: 'shape parameter',
  baseRadius: 'base radius',
  outerRadius: 'outer radius',
  innerRadius: 'inner radius',
  foreRadius: 'fore radius',
  aftRadius: 'aft radius',
  thickness: 'thickness',
  isDecoupler: 'decoupler',
  count: 'count',
  rootChord: 'root chord',
  tipChord: 'tip chord',
  span: 'span',
  sweepLength: 'sweep',
  cant: 'cant',
  bodyRadius: 'body radius',
  finShape: 'fin shape',
  crossSection: 'cross-section',
  points: 'outline',
  angleOffset: 'angle',
  filletRadius: 'fillet',
  isMotorMount: 'motor mount',
  motor: 'motor',
  overhang: 'overhang',
  diameter: 'diameter',
  cd: 'drag coefficient',
  deployEvent: 'deploy event',
  deployAltitude: 'deploy altitude',
  deployDelay: 'deploy delay',
  mass: 'mass',
  stage: 'stage',
};

function fieldLabel(f: string): string {
  return FIELD_LABEL[f] ?? f;
}

function describeOne(c: CorrectionChange): string {
  const label = `${KIND_LABEL[c.partKind] ?? c.partKind} "${c.partName}"`;
  switch (c.kind) {
    case 'added':
      return `${label}: added`;
    case 'removed':
      return `${label}: removed`;
    case 'moved':
      return `${label}: moved`;
    case 'changed': {
      const fields = c.fields ?? [];
      const moved = fields.includes('position');
      const rest = fields.filter((f) => f !== 'position').map(fieldLabel);
      const bits: string[] = [];
      if (moved) bits.push('moved');
      if (rest.length > 0) bits.push(`${rest.join(', ')} changed`);
      return `${label}: ${bits.length > 0 ? bits.join(', ') : 'changed'}`;
    }
  }
}

/** One plain-English line per change; max `limit` lines (default 8) then "…and N more". */
export function describeChanges(changes: CorrectionChange[], limit = 8): string[] {
  const max = Math.max(0, Math.floor(limit));
  const lines = changes.slice(0, max).map(describeOne);
  if (changes.length > max) lines.push(`…and ${changes.length - max} more`);
  return lines;
}

// ---------------------------------------------------------------------------
// Record

function clampText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** Build the record to store. `parsedModel` is what the importer made of the file before any edit. */
export function makeCorrection(a: {
  fileSha256: string;
  filename: string;
  parsedModel: RocketModel;
  imported: Design;
  corrected: Design;
  note?: string;
  now?: number;
}): ImportCorrection {
  return {
    fileSha256: a.fileSha256,
    filename: clampText(a.filename, MAX_FILENAME),
    parsedModel: a.parsedModel,
    correctedDesign: a.corrected,
    note: clampText(a.note, MAX_NOTE),
    changes: diffDesigns(a.imported, a.corrected),
    updatedAt: a.now ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Device-local copy

export const CORRECTIONS_KEY = 'sfb.import.corrections.v1';
export const MAX_LOCAL_CORRECTIONS = 20;

const SHA_RE = /^[0-9a-f]{64}$/;
const CHANGE_KINDS = new Set(['added', 'removed', 'changed', 'moved']);

function resolveStorage(store?: StorageLike): StorageLike | null {
  if (store) return store;
  try {
    return typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function sanitizeChanges(raw: unknown): CorrectionChange[] {
  if (!Array.isArray(raw)) return [];
  const out: CorrectionChange[] = [];
  for (const item of raw.slice(0, 500)) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.kind !== 'string' || !CHANGE_KINDS.has(c.kind)) continue;
    const entry: CorrectionChange = {
      kind: c.kind as CorrectionChange['kind'],
      partName: clampText(c.partName, 120),
      partKind: clampText(c.partKind, 40),
    };
    if (Array.isArray(c.fields)) {
      entry.fields = c.fields.filter((f): f is string => typeof f === 'string').slice(0, 50).map((f) => f.slice(0, 60));
    }
    out.push(entry);
  }
  return out;
}

/** Sanitize one stored entry; null when it is not usable. */
function sanitizeEntry(item: unknown): ImportCorrection | null {
  if (!item || typeof item !== 'object') return null;
  const e = item as Record<string, unknown>;
  if (typeof e.fileSha256 !== 'string') return null;
  const sha = e.fileSha256.toLowerCase();
  if (!SHA_RE.test(sha)) return null;
  const model = e.parsedModel as Record<string, unknown> | null | undefined;
  if (!model || typeof model !== 'object' || !Array.isArray(model.components)) return null;
  if (!e.correctedDesign || typeof e.correctedDesign !== 'object') return null;
  try {
    const correctedDesign = sanitizeDesignObject(e.correctedDesign as Record<string, unknown>, 'Imported Rocket', []);
    return {
      fileSha256: sha,
      filename: clampText(e.filename, MAX_FILENAME),
      parsedModel: model as unknown as RocketModel,
      correctedDesign,
      note: clampText(e.note, MAX_NOTE),
      changes: sanitizeChanges(e.changes),
      updatedAt: typeof e.updatedAt === 'number' && Number.isFinite(e.updatedAt) ? e.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Raw stored entries (unsanitized), or [] on any problem. */
function readRaw(s: StorageLike): unknown[] {
  try {
    const text = s.getItem(CORRECTIONS_KEY);
    if (!text) return [];
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function updatedAtOf(item: unknown): number {
  const t = item && typeof item === 'object' ? (item as Record<string, unknown>).updatedAt : 0;
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}

function shaOf(item: unknown): string {
  const v = item && typeof item === 'object' ? (item as Record<string, unknown>).fileSha256 : '';
  return typeof v === 'string' ? v.toLowerCase() : '';
}

export function loadLocalCorrection(fileSha256: string, store?: StorageLike): ImportCorrection | null {
  try {
    const s = resolveStorage(store);
    if (!s || typeof fileSha256 !== 'string') return null;
    const sha = fileSha256.toLowerCase();
    if (!SHA_RE.test(sha)) return null;
    let best: unknown = null;
    for (const item of readRaw(s)) {
      if (shaOf(item) === sha && (best === null || updatedAtOf(item) > updatedAtOf(best))) best = item;
    }
    return best === null ? null : sanitizeEntry(best);
  } catch {
    return null;
  }
}

function writeEntries(s: StorageLike, entries: unknown[]): boolean {
  try {
    s.setItem(CORRECTIONS_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function saveLocalCorrection(c: ImportCorrection, store?: StorageLike): void {
  try {
    const s = resolveStorage(store);
    if (!s || typeof c?.fileSha256 !== 'string') return;
    const sha = c.fileSha256.toLowerCase();
    if (!SHA_RE.test(sha)) return;
    const others = readRaw(s).filter((item) => item && typeof item === 'object' && shaOf(item) !== sha);
    const next = [{ ...c, fileSha256: sha }, ...others]
      .sort((a, b) => updatedAtOf(b) - updatedAtOf(a))
      .slice(0, MAX_LOCAL_CORRECTIONS);
    if (writeEntries(s, next)) return;
    // Quota: drop the oldest half (always keeping the newest) and retry once.
    const keep = Math.max(1, Math.floor(next.length / 2));
    writeEntries(s, next.slice(0, keep));
  } catch {
    // Never throw: a correction that can't be remembered must not break an import.
  }
}

export function deleteLocalCorrection(fileSha256: string, store?: StorageLike): void {
  try {
    const s = resolveStorage(store);
    if (!s || typeof fileSha256 !== 'string') return;
    const sha = fileSha256.toLowerCase();
    const all = readRaw(s);
    const next = all.filter((item) => shaOf(item) !== sha);
    if (next.length === all.length) return;
    writeEntries(s, next);
  } catch {
    // ignore
  }
}

/** The newer of a local and a cloud correction for the same file (either may be null). */
export function pickCorrection(
  local: ImportCorrection | null,
  cloud: ImportCorrection | null,
): ImportCorrection | null {
  if (!local) return cloud ?? null;
  if (!cloud) return local;
  return cloud.updatedAt > local.updatedAt ? cloud : local;
}
