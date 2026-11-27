// Keeps the rockets saved in this browser and the ones saved to the account in step.
// The browser copy stays the working copy, so saving and loading work offline; the
// account copy is what follows the person to another device.

import type { Design } from '../builder/design';
import { listSavedDesigns, saveDesign } from '../builder/storage';
import type { Cloud } from './session';

/** Browser design id -> account row id. */
const MAP_KEY = 'sfb.cloud.designIds.v1';

function readMap(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(MAP_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  try {
    globalThis.localStorage?.setItem(MAP_KEY, JSON.stringify(map));
  } catch {
    // Without the map a later save makes a second account copy; nothing is lost.
  }
}

/** Account row ids whose delete did not reach the account yet. Retried on the next pull. */
const PENDING_KEY = 'sfb.cloud.pendingDeletes.v1';

function readPending(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function writePending(ids: string[]): void {
  try {
    globalThis.localStorage?.setItem(PENDING_KEY, JSON.stringify(ids));
  } catch {
    // Lost only if browser storage is unavailable; the row then reappears on a later pull.
  }
}

/** Copy a just-saved design to the account. Quietly does nothing for guests or offline. */
export async function pushDesign(cloud: Cloud, design: Design, thumbnail?: string, sourceFileSha256?: string): Promise<void> {
  if (!cloud.store.enabled) return;
  const map = readMap();
  const send = (id?: string) =>
    cloud.store.saveDesign({
      ...(id ? { id } : {}),
      name: design.name || 'Untitled Rocket',
      design,
      ...(thumbnail ? { thumbnail } : {}),
      ...(sourceFileSha256 ? { sourceFileSha256 } : {}),
    });
  // A row removed on another device comes back as null on update: save it afresh.
  const id = (await send(map[design.id])) ?? (map[design.id] ? await send() : null);
  if (id && map[design.id] !== id) {
    map[design.id] = id;
    writeMap(map);
  }
}

/** Remove the account copy of a design deleted in this browser. */
export async function removeDesign(cloud: Cloud, localId: string): Promise<void> {
  const map = readMap();
  const cloudId = map[localId];
  if (!cloudId) return;
  delete map[localId];
  writeMap(map);
  if (cloud.store.enabled && (await cloud.store.deleteDesign(cloudId))) return;
  // Not removed from the account (failed, or signed out): remember it so a later pull does not bring it back.
  writePending([...readPending().filter((id) => id !== cloudId), cloudId]);
}

/** Bring account designs this browser does not have into the local list. Returns how many arrived. */
export async function pullDesigns(cloud: Cloud): Promise<number> {
  if (!cloud.store.enabled) return 0;
  // Retry deletes that failed earlier; a row whose delete still fails stays pending. None of
  // them is re-added by this pull, even if the retry reported success but the list still has it.
  const wasPending = readPending();
  const pending: string[] = [];
  for (const id of wasPending) {
    if (!(await cloud.store.deleteDesign(id))) pending.push(id);
  }
  writePending(pending);
  const blocked = new Set(wasPending);
  const remote = await cloud.store.listDesigns();
  if (remote.length === 0) return 0;
  const have = new Set(listSavedDesigns().map((d) => d.id));
  const map = readMap();
  let added = 0;
  // Oldest first, so the newest ends up at the top of the local list.
  for (const cd of [...remote].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (blocked.has(cd.id)) continue;
    map[cd.design.id] = cd.id;
    if (have.has(cd.design.id)) continue;
    try {
      saveDesign(cd.design, cd.thumbnail);
      have.add(cd.design.id);
      added++;
    } catch {
      break; // Browser storage is full; the rest stay in the account.
    }
  }
  writeMap(map);
  return added;
}
