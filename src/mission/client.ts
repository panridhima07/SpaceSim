// Run a mission in a Web Worker when the platform has one, otherwise in this thread.

import { flyMission, type FlyOptions } from './fly';
import type { FlightRecord } from './record';
import { getMission } from './vehicles';

interface WorkerReply {
  ok: boolean;
  record?: FlightRecord;
  error?: string;
}

export function runMission(id: string, opts: FlyOptions = {}): Promise<FlightRecord> {
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
    const finish = (fn: () => void) => {
      worker.terminate();
      fn();
    };
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
