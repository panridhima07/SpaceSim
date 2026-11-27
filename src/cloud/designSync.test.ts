// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addExternalPart, createEmptyDesign, type Design } from '../builder/design';
import { listSavedDesigns, STORAGE_KEY as LOCAL_DESIGNS_KEY } from '../builder/storage';
import { pullDesigns, removeDesign } from './designSync';
import type { Cloud } from './session';
import type { CloudDesign } from './types';

/** Node 26 exposes a broken global localStorage that shadows jsdom's, so install an in-memory one. */
function installMemoryStorage(): void {
  const m = new Map<string, string>();
  const storage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  };
  for (const target of [globalThis, typeof window !== 'undefined' ? window : undefined]) {
    if (target) Object.defineProperty(target, 'localStorage', { value: storage, configurable: true, writable: true });
  }
}

const MAP_KEY = 'sfb.cloud.designIds.v1';
const PENDING_KEY = 'sfb.cloud.pendingDeletes.v1';

function fakeCloud(overrides: { deleteDesign?: ReturnType<typeof vi.fn>; listDesigns?: ReturnType<typeof vi.fn> } = {}) {
  const store = {
    enabled: true,
    deleteDesign: overrides.deleteDesign ?? vi.fn(async () => true),
    listDesigns: overrides.listDesigns ?? vi.fn(async () => []),
    saveDesign: vi.fn(async () => null),
  };
  return { cloud: { store } as unknown as Cloud, store };
}

function remoteRow(localId: string, cloudId: string): CloudDesign {
  // A bare empty design fails sanitizeDesignObject (listSavedDesigns drops it), so add one part like store.test does.
  const design: Design = JSON.parse(
    JSON.stringify(
      addExternalPart(createEmptyDesign('Remote rocket'), {
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
  design.id = localId;
  return { id: cloudId, name: 'Remote rocket', design, updatedAt: 1000 };
}

function readPending(): unknown {
  const raw = localStorage.getItem(PENDING_KEY);
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
  installMemoryStorage();
  localStorage.clear();
});

describe('removeDesign and pullDesigns with failing deletes', () => {
  it('keeps a row pending when delete fails in both removeDesign and the pull retry, and does not re-add it', async () => {
    localStorage.setItem(MAP_KEY, JSON.stringify({ 'local-1': 'cloud-1' }));
    const deleteDesign = vi.fn(async () => false);
    const listDesigns = vi.fn(async () => [remoteRow('local-1', 'cloud-1')]);
    const { cloud } = fakeCloud({ deleteDesign, listDesigns });

    await removeDesign(cloud, 'local-1');
    expect(deleteDesign).toHaveBeenCalledWith('cloud-1');
    expect(readPending()).toEqual(['cloud-1']);

    const added = await pullDesigns(cloud);
    expect(added).toBe(0);
    expect(deleteDesign).toHaveBeenLastCalledWith('cloud-1');
    expect(readPending()).toEqual(['cloud-1']);
    expect(listSavedDesigns().map((d) => d.id)).toEqual([]);
  });

  it('clears the pending entry when the pull retry succeeds and still does not re-add the row in that pull', async () => {
    localStorage.setItem(MAP_KEY, JSON.stringify({ 'local-1': 'cloud-1' }));
    const deleteDesign = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const listDesigns = vi.fn(async () => [remoteRow('local-1', 'cloud-1')]);
    const { cloud } = fakeCloud({ deleteDesign, listDesigns });

    await removeDesign(cloud, 'local-1');
    expect(readPending()).toEqual(['cloud-1']);

    const added = await pullDesigns(cloud);
    // A delete can report success without removing the row (an RLS no-op returns no error), so a
    // row that was pending at the start of the pull is skipped even when the list still returns it.
    expect(readPending()).toEqual([]);
    expect(added).toBe(0);
    expect(listSavedDesigns()).toEqual([]);
  });

  it('does not record a pending delete when deleteDesign succeeds in removeDesign', async () => {
    localStorage.setItem(MAP_KEY, JSON.stringify({ 'local-1': 'cloud-1', 'local-2': 'cloud-2' }));
    const deleteDesign = vi.fn(async () => true);
    const { cloud } = fakeCloud({ deleteDesign });

    await removeDesign(cloud, 'local-1');
    expect(deleteDesign).toHaveBeenCalledWith('cloud-1');
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    // The local-to-cloud mapping entry for the removed design is dropped; the other one stays.
    expect(JSON.parse(localStorage.getItem(MAP_KEY)!)).toEqual({ 'local-2': 'cloud-2' });
    expect(localStorage.getItem(LOCAL_DESIGNS_KEY)).toBeNull();
  });
});
