// Web Worker that flies the Chandrayaan-3 cruise off the main thread and posts the record back.
// It only touches the cruise and lander-core modules, never three.js or the render code.

import { flyCruise, type CruiseRecord } from './cruise';

type Reply =
  | { type: 'progress'; text: string }
  | { type: 'done'; record: CruiseRecord }
  | { type: 'error'; error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: Reply): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = () => {
  try {
    const record = flyCruise({ onProgress: (text) => scope.postMessage({ type: 'progress', text }) });
    scope.postMessage({ type: 'done', record });
  } catch (err) {
    scope.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
