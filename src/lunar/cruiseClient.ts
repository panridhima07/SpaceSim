// Fly the cruise in a Web Worker when the platform has one, otherwise in this thread.

import { flyCruise, type CruiseRecord } from './cruise';

type WorkerReply =
  | { type: 'progress'; text: string }
  | { type: 'done'; record: CruiseRecord }
  | { type: 'error'; error: string };

let cached: Promise<CruiseRecord> | undefined;

export function runCruise(onProgress?: (text: string) => void): Promise<CruiseRecord> {
  if (cached) return cached;
  const p = fly(onProgress);
  cached = p;
  p.catch(() => { if (cached === p) cached = undefined; });
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
    worker.onmessageerror = () => finish(() => reject(new Error('Cruise flight failed')));
    const finish = (fn: () => void) => {
      worker.terminate();
      fn();
    };
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'progress') onProgress?.(reply.text);
      else if (reply.type === 'done') finish(() => resolve(reply.record));
      else finish(() => reject(new Error(reply.error)));
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || 'Cruise flight failed')));
    };
    worker.postMessage({});
  });
}
