// A thin, typed wrapper over Supabase for per-user cloud data. Nothing here throws on
// network or database failures: the app must keep working offline and before the tables
// exist, so a failure is warned about once per kind and turned into an empty result.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Design } from '../builder/design';
import { sanitizeDesignObject } from '../io/limits';
import type { RocketModel } from '../types';
import type { CloudDesign, ConsentState, CorrectionChange, ImportCorrection } from './types';

export const IMPORTER_VERSION = '1';
export const ROCKET_FILES_BUCKET = 'rocket-files';

const MAX_NAME = 120;
const MAX_NOTE = 2000;
const MAX_FILENAME = 200;

export interface CloudStore {
  /** False for guests or when Supabase is not configured: every call then resolves to a harmless empty result. */
  readonly enabled: boolean;
  getConsent(): Promise<ConsentState | null>;
  setConsent(c: ConsentState): Promise<void>;
  listDesigns(): Promise<CloudDesign[]>;
  saveDesign(d: { id?: string; name: string; design: Design; thumbnail?: string; sourceFileSha256?: string }): Promise<string | null>;
  deleteDesign(id: string): Promise<void>;
  /** Uploads the bytes once per unique file (skip if the row exists). Only call when research consent is true. */
  uploadRocketFile(f: { sha256: string; filename: string; format: string; bytes: Uint8Array }): Promise<void>;
  getCorrection(fileSha256: string): Promise<ImportCorrection | null>;
  saveCorrection(c: ImportCorrection, shareForTraining: boolean): Promise<void>;
  deleteCorrection(fileSha256: string): Promise<void>;
  logSimRun(r: {
    designId?: string;
    kind: 'flight' | 'stress';
    config: unknown;
    summary: unknown;
    durationMs: number;
    ranOn: 'server' | 'browser';
  }): Promise<void>;
}

const clamp = (s: unknown, max: number): string => (typeof s === 'string' ? s.slice(0, max) : '');

function toMs(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function safeDesign(raw: unknown, fallbackName: string): Design | null {
  const obj = asObject(raw);
  if (!obj) return null;
  try {
    return sanitizeDesignObject(obj, fallbackName, []);
  } catch {
    return null;
  }
}

export function createCloudStore(client: SupabaseClient | null, userId: string | null): CloudStore {
  const warned = new Set<string>();
  const warn = (kind: string, err: unknown): void => {
    if (warned.has(kind)) return;
    warned.add(kind);
    console.warn(`[cloud] ${kind} failed; continuing without the cloud copy.`, err);
  };

  const active = client && userId ? { c: client, uid: userId } : null;

  /** Runs a call, turning thrown errors and `{ error }` results into a warning and `fallback`. */
  async function guard<T>(kind: string, fallback: T, fn: (c: SupabaseClient, uid: string) => PromiseLike<T>): Promise<T> {
    if (!active) return fallback;
    try {
      return await fn(active.c, active.uid);
    } catch (err) {
      warn(kind, err);
      return fallback;
    }
  }

  function check(error: unknown): void {
    if (error) throw error;
  }

  function mapDesign(row: Record<string, unknown>): CloudDesign | null {
    const name = clamp(row.name, MAX_NAME) || 'Untitled';
    const design = safeDesign(row.design, name);
    if (!design || typeof row.id !== 'string') return null;
    const out: CloudDesign = { id: row.id, name, design, updatedAt: toMs(row.updated_at) };
    if (typeof row.thumbnail === 'string') out.thumbnail = row.thumbnail;
    if (typeof row.source_file_sha256 === 'string') out.sourceFileSha256 = row.source_file_sha256;
    return out;
  }

  function mapCorrection(row: Record<string, unknown>): ImportCorrection | null {
    const filename = clamp(row.filename, MAX_FILENAME);
    const corrected = safeDesign(row.corrected_design, filename || 'Imported rocket');
    const parsed = asObject(row.parsed_model);
    if (!corrected || !parsed || typeof row.file_sha256 !== 'string') return null;
    return {
      fileSha256: row.file_sha256,
      filename,
      parsedModel: parsed as unknown as RocketModel,
      correctedDesign: corrected,
      note: clamp(row.note, MAX_NOTE),
      changes: Array.isArray(row.changes) ? (row.changes as CorrectionChange[]) : [],
      updatedAt: toMs(row.updated_at),
    };
  }

  return {
    enabled: active !== null,

    getConsent: () =>
      guard<ConsentState | null>('read consent', null, async (c, uid) => {
        const { data, error } = await c
          .from('profiles')
          .select('research_consent, consent_version, consented_at')
          .eq('user_id', uid)
          .maybeSingle();
        check(error);
        if (!data) return null;
        return {
          research: data.research_consent === true,
          version: Number(data.consent_version) || 0,
          decidedAt: toMs(data.consented_at),
        };
      }),

    setConsent: (s) =>
      guard<void>('save consent', undefined, async (c, uid) => {
        const { error } = await c.from('profiles').upsert(
          {
            user_id: uid,
            research_consent: s.research,
            consent_version: s.version,
            consented_at: new Date(s.decidedAt).toISOString(),
          },
          { onConflict: 'user_id' },
        );
        check(error);
      }),

    listDesigns: () =>
      guard<CloudDesign[]>('list designs', [], async (c, uid) => {
        const { data, error } = await c
          .from('designs')
          .select('id, name, design, thumbnail, source_file_sha256, updated_at')
          .eq('user_id', uid)
          .order('updated_at', { ascending: false });
        check(error);
        const out: CloudDesign[] = [];
        for (const row of (data ?? []) as Record<string, unknown>[]) {
          const d = mapDesign(row);
          if (d) out.push(d);
        }
        return out;
      }),

    saveDesign: (d) =>
      guard<string | null>('save design', null, async (c, uid) => {
        const fields = {
          name: clamp(d.name, MAX_NAME) || 'Untitled',
          design: d.design,
          thumbnail: d.thumbnail ?? null,
          source_file_sha256: d.sourceFileSha256 ?? null,
        };
        if (d.id) {
          const { data, error } = await c
            .from('designs')
            .update(fields)
            .eq('id', d.id)
            .eq('user_id', uid)
            .select('id')
            .maybeSingle();
          check(error);
          return data ? String(data.id) : null;
        }
        const { data, error } = await c
          .from('designs')
          .insert({ ...fields, user_id: uid })
          .select('id')
          .single();
        check(error);
        return data ? String(data.id) : null;
      }),

    deleteDesign: (id) =>
      guard<void>('delete design', undefined, async (c, uid) => {
        const { error } = await c.from('designs').delete().eq('id', id).eq('user_id', uid);
        check(error);
      }),

    uploadRocketFile: (f) =>
      guard<void>('upload rocket file', undefined, async (c, uid) => {
        const existing = await c
          .from('rocket_files')
          .select('sha256')
          .eq('user_id', uid)
          .eq('sha256', f.sha256)
          .maybeSingle();
        check(existing.error);
        if (existing.data) return;
        const path = `${uid}/${f.sha256}`;
        const up = await c.storage
          .from(ROCKET_FILES_BUCKET)
          .upload(path, f.bytes, { contentType: 'application/octet-stream', upsert: true });
        check(up.error);
        const { error } = await c.from('rocket_files').insert({
          user_id: uid,
          sha256: f.sha256,
          filename: clamp(f.filename, MAX_FILENAME),
          size_bytes: f.bytes.byteLength,
          format: f.format,
          storage_path: path,
        });
        check(error);
      }),

    getCorrection: (sha) =>
      guard<ImportCorrection | null>('read correction', null, async (c, uid) => {
        const { data, error } = await c
          .from('import_corrections')
          .select('file_sha256, filename, parsed_model, corrected_design, changes, note, updated_at')
          .eq('user_id', uid)
          .eq('file_sha256', sha)
          .maybeSingle();
        check(error);
        return data ? mapCorrection(data as Record<string, unknown>) : null;
      }),

    saveCorrection: (corr, share) =>
      guard<void>('save correction', undefined, async (c, uid) => {
        const { error } = await c.from('import_corrections').upsert(
          {
            user_id: uid,
            file_sha256: corr.fileSha256,
            filename: clamp(corr.filename, MAX_FILENAME),
            parsed_model: corr.parsedModel,
            corrected_design: corr.correctedDesign,
            changes: corr.changes,
            note: clamp(corr.note, MAX_NOTE),
            share_for_training: share,
            importer_version: IMPORTER_VERSION,
          },
          { onConflict: 'user_id,file_sha256' },
        );
        check(error);
      }),

    deleteCorrection: (sha) =>
      guard<void>('delete correction', undefined, async (c, uid) => {
        const { error } = await c.from('import_corrections').delete().eq('user_id', uid).eq('file_sha256', sha);
        check(error);
      }),

    logSimRun: (r) =>
      guard<void>('log simulation run', undefined, async (c, uid) => {
        const { error } = await c.from('sim_runs').insert({
          user_id: uid,
          design_id: r.designId ?? null,
          kind: r.kind,
          config: r.config ?? null,
          summary: r.summary ?? null,
          duration_ms: Math.max(0, Math.round(r.durationMs)),
          ran_on: r.ranOn,
        });
        check(error);
      }),
  };
}
