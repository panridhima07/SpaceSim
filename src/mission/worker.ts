// Web Worker that flies a mission off the main thread and posts the record back.
// It only touches the mission modules, never three.js or the app/render code.

import { flyMission, type FlyOptions } from './fly';
import type { FlightRecord } from './record';
import { getMission } from './vehicles';

interface Request extends FlyOptions { id: string }

type Reply =
  | { ok: true; record: FlightRecord }
  | { ok: false; error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, ...opts } = event.data;
  const mission = getMission(id);
  if (!mission) {
    scope.postMessage({ ok: false, error: `Unknown mission: ${id}` });
    return;
  }
  try {
    scope.postMessage({ ok: true, record: flyMission(mission, opts) });
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
