// Fly the cruise in a Web Worker when the platform has one, otherwise in this thread.

import { flyCruise, type CruiseRecord } from './cruise';

type WorkerReply =
  | { type: 'progress'; text: string }
  | { type: 'done'; record: CruiseRecord }
  | { type: 'error'; error: string };

let cached: Promise<CruiseRecord> | undefined;
const listeners = new Set<(text: string) => void>();

export function runCruise(onProgress?: (text: string) => void): Promise<CruiseRecord> {
  if (cached) {
    if (onProgress) listeners.add(onProgress);
    return cached;
  }
  listeners.clear();
  if (onProgress) listeners.add(onProgress);
  const fanOut = (text: string) => { for (const fn of listeners) fn(text); };
  const p = fly(fanOut);
  cached = p;
  p.catch(() => { if (cached === p) cached = undefined; });
  // Drop the UI callbacks once the run settles so they are not kept for the page's lifetime.
  p.then(() => listeners.clear(), () => listeners.clear());
  return p;
}

function fly(onProgress?: (text: string) => void): Promise<CruiseRecord> {
  if (typeof Worker === 'undefined') {
    return new Promise((resolve, reject) => {
      try {
        resolve(flyCruise({ onProgress }));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./cruiseWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      // A WebView without module workers: fly it here instead. The page waits, but it works.
      try {
        resolve(flyCruise({ onProgress }));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
    let gotMessage = false;
    const inThread = () => {
      try {
        resolve(flyCruise({ onProgress }));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const failed = (message: string) => {
      if (!gotMessage) { worker.terminate(); inThread(); } // the module worker never started (e.g. a WebView that cannot load it)
      else finish(() => reject(new Error(message)));
    };
    worker.onmessageerror = () => failed('Cruise flight failed');
    const finish = (fn: () => void) => {
      worker.terminate();
      fn();
    };
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      gotMessage = true;
      const reply = event.data;
      if (reply.type === 'progress') onProgress?.(reply.text);
      else if (reply.type === 'done') finish(() => resolve(reply.record));
      else finish(() => reject(new Error(reply.error)));
    };
    worker.onerror = (event) => {
      failed(event.message || 'Cruise flight failed');
    };
    worker.postMessage({});
  });
}
