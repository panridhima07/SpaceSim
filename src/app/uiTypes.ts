// Contract between the DOM UI (ui.ts) and the app glue (main.ts).
import type { Flaw, FlightEvent, SimConfig, SimState, StressReport } from '../types';

export type CameraMode = 'pad' | 'chase' | 'onboard' | 'map';
export type ToggleName = 'cutaway' | 'forces' | 'markers' | 'trail';

export interface UICallbacks {
  /** A .ork or .eng file was dropped or chosen. */
  onFile(file: File): void;
  onLoadSample(): void;
  onLaunch(): void;
  onReset(): void;
  onWarp(delta: 1 | -1): void;
  onPause(): void;
  onCamera(mode: CameraMode): void;
  /** Launch settings changed (rail, wind...). */
  onConfig(config: SimConfig): void;
  onMotor(designation: string): void;
  onToggle(name: ToggleName, on: boolean): void;
  onFlawClick(flaw: Flaw): void;
  /** Replay scrubber moved to sim time t. */
  onScrub(t: number): void;
  /** Run the headless stress test on the current design. */
  onStressTest(): void;
  /** Switch to rocket build mode. */
  onBuild?(): void;
}

/** One component's build-quality grade, as listed in the UI. */
export interface PartInfo {
  name: string;
  /** Kind of part, e.g. "Fin set". */
  label: string;
  tier: 'best' | 'ok' | 'bad';
  /** Trusted inline SVG for this kind at this tier. */
  icon: string;
  /** Why it got this grade. */
  reasons: string[];
}

export interface RocketInfo {
  name: string;
  length: number;
  diameter: number;
  mass: number;
  stabilityCal: number;
  motor: string | null;
  warnings: string[];
  /** Grade of every part visible on the outside, fore to aft. */
  parts?: PartInfo[];
}

export interface UI {
  setRocket(info: RocketInfo | null): void;
  setMotors(list: { designation: string; label: string }[], selected: string | null): void;
  setTelemetry(s: SimState, warp: number, paused: boolean): void;
  setEvents(events: FlightEvent[]): void;
  setFlaws(flaws: Flaw[]): void;
  /** Show the replay scrubber (duration 0 hides it). */
  setReplay(duration: number, t: number): void;
  /** Show stress-test results (null clears; 'running' shows a busy state). */
  setStress(report: StressReport | null | 'running'): void;
  toast(msg: string): void;
  getConfig(): SimConfig;
  setVisible(visible: boolean): void;
  setBuildLabel?(label: string): void;
}
