// Run a mission in a Web Worker when the platform has one, otherwise in this thread.

import { flyMission, type FlyOptions } from './fly';
import type { FlightRecord } from './record';
import { getMission } from './vehicles';

interface WorkerReply {
  ok: boolean;
  record?: FlightRecord;
  error?: string;
}

function abortError(): Error {
  const err = new Error('Mission run aborted');
  err.name = 'AbortError';
  return err;
}

/** True for the rejection runMission gives when its signal aborts. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** `signal` is never sent to the worker; aborting terminates it and rejects with an AbortError. */
export function runMission(id: string, opts: FlyOptions = {}, signal?: AbortSignal): Promise<FlightRecord> {
  if (signal?.aborted) return Promise.reject(abortError());

  if (typeof Worker === 'undefined') {
    return new Promise((resolve, reject) => {
      const mission = getMission(id);
      if (!mission) {
        reject(new Error(`Unknown mission: ${id}`));
        return;
      }
      try {
        resolve(flyMission(mission, opts));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const onAbort = () => finish(() => reject(abortError()));
    const finish = (fn: () => void) => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      fn();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.ok && reply.record) {
        finish(() => resolve(reply.record!));
      } else {
        finish(() => reject(new Error(reply.error ?? `Mission ${id} failed`)));
      }
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || `Mission ${id} failed`)));
    };
    worker.postMessage({ id, ...opts });
  });
}
