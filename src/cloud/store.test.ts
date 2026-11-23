import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addExternalPart, createEmptyDesign } from '../builder/design';
import type { RocketModel } from '../types';
import { createCloudStore, IMPORTER_VERSION } from './store';
import type { ImportCorrection } from './types';

interface Call {
  table: string;
  op: string;
  args: unknown[];
  filters: [string, unknown][];
}

/** A hand-written fake: records every call, answers by "table.op" from `results`. */
function fakeClient(results: Record<string, { data?: unknown; error?: unknown } | (() => never)> = {}) {
  const calls: Call[] = [];
  const uploads: { bucket: string; path: string; opts: unknown }[] = [];
  let uploadError: unknown = null;

  const from = (table: string) => {
    const call: Call = { table, op: '', args: [], filters: [] };
    const settle = () => {
      const r = results[`${table}.${call.op}`] ?? { data: null, error: null };
      if (typeof r === 'function') r();
      return Promise.resolve({ data: null, error: null, ...(r as object) });
    };
    const b: Record<string, unknown> = {};
    const start = (op: string) => (...args: unknown[]) => {
      if (!call.op) {
        call.op = op;
        call.args = args;
        calls.push(call);
      }
      return b;
    };
    for (const op of ['select', 'insert', 'update', 'upsert', 'delete']) b[op] = start(op);
    b.eq = (k: string, v: unknown) => {
      call.filters.push([k, v]);
      return b;
    };
    b.order = () => b;
    b.maybeSingle = settle;
    b.single = settle;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
    return b;
  };

  const client = {
    from,
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _bytes: unknown, opts: unknown) => {
          uploads.push({ bucket, path, opts });
          return { data: null, error: uploadError };
        },
      }),
    },
  } as unknown as SupabaseClient;

  return { client, calls, uploads, failUpload: (e: unknown) => (uploadError = e) };
}

const UID = 'user-1';
const goodDesign = () =>
  JSON.parse(
    JSON.stringify(
      addExternalPart(createEmptyDesign('Test'), {
        id: 'x',
        kind: 'nosecone',
        name: 'Nose',
        x: 0,
        length: 0.1,
        density: 1000,
        shape: 'ogive',
        shapeParam: 1,
        baseRadius: 0.02,
        thickness: 0.002,
      }).design,
    ),
  );

describe('disabled store', () => {
  it('returns empties and makes no calls without a client or user', async () => {
    const { client, calls } = fakeClient();
    for (const store of [createCloudStore(null, UID), createCloudStore(client, null)]) {
      expect(store.enabled).toBe(false);
      expect(await store.getConsent()).toBeNull();
      expect(await store.listDesigns()).toEqual([]);
      expect(await store.saveDesign({ name: 'x', design: goodDesign() })).toBeNull();
      expect(await store.getCorrection('abc')).toBeNull();
      await store.setConsent({ research: true, version: 1, decidedAt: 1 });
      await store.deleteDesign('a');
      await store.uploadRocketFile({ sha256: 'a', filename: 'a.ork', format: 'ork', bytes: new Uint8Array(1) });
      await store.logSimRun({ kind: 'flight', config: {}, summary: {}, durationMs: 1, ranOn: 'browser' });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('column mapping', () => {
  it('maps consent rows to ConsentState and back', async () => {
    const at = '2026-01-02T03:04:05.000Z';
    const f = fakeClient({
      'profiles.select': { data: { research_consent: true, consent_version: 1, consented_at: at } },
    });
    const store = createCloudStore(f.client, UID);
    expect(await store.getConsent()).toEqual({ research: true, version: 1, decidedAt: Date.parse(at) });
    await store.setConsent({ research: false, version: 1, decidedAt: Date.parse(at) });
    const up = f.calls.find((c) => c.op === 'upsert')!;
    expect(up.args[0]).toEqual({
      user_id: UID,
      research_consent: false,
      consent_version: 1,
      consented_at: at,
    });
  });

  it('maps design rows to CloudDesign with epoch ms', async () => {
    const at = '2026-02-03T00:00:00.000Z';
    const f = fakeClient({
      'designs.select': {
        data: [{ id: 'd1', name: 'Mine', design: goodDesign(), thumbnail: 'data:x', source_file_sha256: 'abc', updated_at: at }],
      },
    });
    const list = await createCloudStore(f.client, UID).listDesigns();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'd1', name: 'Mine', thumbnail: 'data:x', sourceFileSha256: 'abc', updatedAt: Date.parse(at) });
    expect(f.calls[0].filters).toContainEqual(['user_id', UID]);
  });

  it('saveDesign inserts without an id and updates with one, writing snake_case and clamping the name', async () => {
    const f = fakeClient({ 'designs.insert': { data: { id: 'new' } }, 'designs.update': { data: { id: 'old' } } });
    const store = createCloudStore(f.client, UID);
    const id = await store.saveDesign({ name: 'n'.repeat(500), design: goodDesign(), sourceFileSha256: 'sha' });
    expect(id).toBe('new');
    const ins = f.calls.find((c) => c.op === 'insert')!;
    const row = ins.args[0] as Record<string, unknown>;
    expect(row.user_id).toBe(UID);
    expect((row.name as string).length).toBe(120);
    expect(row.source_file_sha256).toBe('sha');

    expect(await store.saveDesign({ id: 'old', name: 'x', design: goodDesign() })).toBe('old');
    const upd = f.calls.find((c) => c.op === 'update')!;
    expect(upd.filters).toContainEqual(['id', 'old']);
    expect(upd.filters).toContainEqual(['user_id', UID]);
  });

  it('maps correction rows back and clamps the note', async () => {
    const at = '2026-03-04T00:00:00.000Z';
    const f = fakeClient({
      'import_corrections.select': {
        data: {
          file_sha256: 'sha',
          filename: 'a.ork',
          parsed_model: { parts: [] },
          corrected_design: goodDesign(),
          changes: [{ kind: 'added', partName: 'Fin', partKind: 'finset' }],
          note: 'z'.repeat(5000),
          updated_at: at,
        },
      },
    });
    const c = await createCloudStore(f.client, UID).getCorrection('sha');
    expect(c).not.toBeNull();
    expect(c!.fileSha256).toBe('sha');
    expect(c!.note.length).toBe(2000);
    expect(c!.updatedAt).toBe(Date.parse(at));
    expect(c!.changes).toHaveLength(1);
  });
});

describe('untrusted rows', () => {
  it('drops a corrupt design row and keeps the good ones', async () => {
    const f = fakeClient({
      'designs.select': {
        data: [
          { id: 'bad', name: 'Bad', design: { stack: 'nope' }, updated_at: '2026-01-01T00:00:00Z' },
          { id: 'null', name: 'Null', design: null, updated_at: '2026-01-01T00:00:00Z' },
          { id: 'good', name: 'Good', design: goodDesign(), updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    });
    const list = await createCloudStore(f.client, UID).listDesigns();
    expect(list.map((d) => d.id)).toEqual(['good']);
  });

  it('returns null for a correction whose design is corrupt', async () => {
    const f = fakeClient({
      'import_corrections.select': {
        data: { file_sha256: 's', filename: 'f', parsed_model: {}, corrected_design: { stack: 1 }, changes: [], note: '' },
      },
    });
    expect(await createCloudStore(f.client, UID).getCorrection('s')).toBeNull();
  });
});

describe('failures never throw', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('turns database errors and thrown errors into empty results, warning once per kind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeClient({
      'designs.select': { error: { message: 'relation does not exist' } },
      'designs.insert': () => {
        throw new Error('network down');
      },
      'profiles.select': { error: { message: 'boom' } },
      'import_corrections.upsert': { error: { message: 'boom' } },
    });
    const store = createCloudStore(f.client, UID);
    expect(await store.listDesigns()).toEqual([]);
    expect(await store.listDesigns()).toEqual([]);
    expect(await store.saveDesign({ name: 'x', design: goodDesign() })).toBeNull();
    expect(await store.getConsent()).toBeNull();
    await expect(store.saveCorrection(correction(), true)).resolves.toBeUndefined();
    await expect(store.deleteCorrection('x')).resolves.toBeUndefined();
    // list designs twice -> one warning; plus insert, consent, correction = 4 total
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe('uploadRocketFile', () => {
  const file = { sha256: 'deadbeef', filename: 'rocket.ork', format: 'ork', bytes: new Uint8Array([1, 2, 3]) };

  it('skips when the row already exists', async () => {
    const f = fakeClient({ 'rocket_files.select': { data: { sha256: 'deadbeef' } } });
    await createCloudStore(f.client, UID).uploadRocketFile(file);
    expect(f.uploads).toHaveLength(0);
    expect(f.calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('uploads to rocket-files at userId/sha256 and records the row', async () => {
    const f = fakeClient({ 'rocket_files.select': { data: null } });
    await createCloudStore(f.client, UID).uploadRocketFile(file);
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0].bucket).toBe('rocket-files');
    expect(f.uploads[0].path).toBe(`${UID}/deadbeef`);
    const row = f.calls.find((c) => c.op === 'insert')!.args[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      user_id: UID,
      sha256: 'deadbeef',
      filename: 'rocket.ork',
      size_bytes: 3,
      format: 'ork',
      storage_path: `${UID}/deadbeef`,
    });
  });

  it('does not record the row when the upload fails, and does not throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeClient({ 'rocket_files.select': { data: null } });
    f.failUpload({ message: 'bucket missing' });
    await expect(createCloudStore(f.client, UID).uploadRocketFile(file)).resolves.toBeUndefined();
    expect(f.calls.some((c) => c.op === 'insert')).toBe(false);
  });
});

function correction(): ImportCorrection {
  return {
    fileSha256: 'sha',
    filename: 'a.ork',
    parsedModel: { parts: [] } as unknown as RocketModel,
    correctedDesign: goodDesign(),
    note: 'fins wrong',
    changes: [{ kind: 'changed', partName: 'Fin', partKind: 'finset', fields: ['span'] }],
    updatedAt: 1,
  };
}

describe('saveCorrection', () => {
  it('upserts on (user_id, file_sha256) with the share flag and importer version', async () => {
    const f = fakeClient();
    const store = createCloudStore(f.client, UID);
    await store.saveCorrection(correction(), true);
    const up = f.calls.find((c) => c.table === 'import_corrections' && c.op === 'upsert')!;
    expect(up.args[1]).toEqual({ onConflict: 'user_id,file_sha256' });
    expect(up.args[0]).toMatchObject({
      user_id: UID,
      file_sha256: 'sha',
      share_for_training: true,
      importer_version: IMPORTER_VERSION,
      note: 'fins wrong',
    });
    await store.saveCorrection(correction(), false);
    const second = f.calls.filter((c) => c.op === 'upsert')[1];
    expect((second.args[0] as Record<string, unknown>).share_for_training).toBe(false);
  });
});
