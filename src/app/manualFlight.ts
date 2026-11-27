// Hand flying for the main flight screen: turns the control deck into simulator commands.
// The physics always runs on the device here, whatever the platform: a flight someone is steering
// cannot wait on a server.

import * as THREE from 'three';
import { G0, type Controls, type Sim, type Vec3 } from '../types';
import { createFlightDeck, type DeckInput } from './flightDeck';

export const MANUAL_WARPS = [0.25, 0.5, 1, 2, 5];
/** Model-rocket motors burn for a second or two, so hand flying starts at half speed. */
const DEFAULT_WARP = 0.5;
/** rad/s the nose turns while an arrow is held. */
export const TURN_RATE = (45 * Math.PI) / 180;
/** Longest real frame taken as flight time, s: a stalled tab must not skip the burn. */
const MAX_FRAME = 0.1;
/** Lever travel per second while a throttle key is held. */
const THROTTLE_RATE = 0.5;

export interface ManualHost {
  sim(): Sim | null;
  launched(): boolean;
  /** Number of motor stages the rocket flies with; 1 for a single-stage rocket. */
  stageCount(): number;
  /** Where the nose points, scene space (same directions as the physics world). */
  noseAxis(): THREE.Vector3;
  cameraQuaternion(): THREE.Quaternion;
  /** Light the motor. False when there is nothing to launch. */
  launch(): boolean;
  /** Put a fresh rocket on the pad. */
  reset(): void;
  cycleCamera(): void;
  onExit(): void;
}

export interface ManualFlight {
  readonly active: boolean;
  start(): void;
  exit(): void;
  /** What the deck's pause button does. Ignored while inactive. */
  togglePause(): void;
  /** What the deck's warp buttons do: one step slower or faster. Ignored while inactive. */
  warpBy(delta: 1 | -1): void;
  /** Simulated seconds this frame is worth. */
  tick(realDt: number): number;
  controls(): Controls;
  /** Refresh the deck; call once a frame. */
  update(): void;
}

/**
 * World-frame turn rate for the held arrows. `rotate` +1 swings the nose clockwise as seen on
 * screen, `tilt` +1 leans it away from the camera.
 */
export function steerRate(
  rotate: number,
  tilt: number,
  nose: THREE.Vector3,
  camera: THREE.Quaternion,
): Vec3 {
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera);
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera);
  const facing = back.dot(nose);
  let turnAxis = back;
  let turn = -rotate;
  let lean = -tilt;
  if (Math.abs(facing) > 0.8) {
    // Looking along the rocket, turning about the view axis would only roll it: the arrows then
    // move the nose left/right and up/down on screen, whichever end is toward the camera.
    turnAxis = up;
    if (facing > 0) turn = rotate;
    else lean = tilt;
  }
  // The two arrows together turn no faster than one: clamp before scaling to the rate.
  const w = turnAxis.multiplyScalar(turn).addScaledVector(right, lean).clampLength(0, 1).multiplyScalar(TURN_RATE);
  return [w.x, w.y, w.z];
}

export function createManualFlight(root: HTMLElement, host: ManualHost): ManualFlight {
  let active = false;
  let throttle = 1;
  let engineOn = false;
  let hold = true;
  let paused = false;
  let warp = DEFAULT_WARP;
  let input: DeckInput = { rotate: 0, tilt: 0, throttle: 0 };

  function toPad(): void {
    throttle = 1;
    engineOn = false;
    paused = false;
    deck.release();
  }

  const finished = (): boolean => host.sim()?.done === true;
  const burnedOut = (): boolean => host.sim()?.events.some((e) => e.type === 'burnout') === true;
  const stagesLeft = (): number =>
    host.stageCount() - 1 - (host.sim()?.events.filter((e) => e.type === 'stage separation').length ?? 0);

  function lightUp(): void {
    if (!host.launched() && !host.launch()) return;
    engineOn = true;
  }

  function togglePause(): void {
    if (!active) return;
    paused = !paused;
    update();
  }

  function warpBy(delta: 1 | -1): void {
    if (!active) return;
    const i = MANUAL_WARPS.indexOf(warp) + delta;
    warp = MANUAL_WARPS[Math.min(MANUAL_WARPS.length - 1, Math.max(0, i))];
    update();
  }

  const deck = createFlightDeck({
    root,
    tiltLabels: ['Away', 'Toward'],
    rotateLabels: ['Left', 'Right'],
    toggles: [
      { id: 'sas', label: 'SAS', title: 'Hold attitude while no arrow is held (F)', key: 'f' },
      { id: 'camera', label: 'Camera', title: 'Next camera (V)', key: 'v' },
    ],
    onInput: (next) => { input = next; },
    onThrottle: (level) => { throttle = Math.min(1, Math.max(0, level)); },
    onToggle: (id) => {
      if (id === 'camera') host.cycleCamera();
      else hold = !hold;
      update();
    },
    onEngine: () => {
      if (finished()) return;
      if (engineOn) engineOn = false;
      else lightUp();
      update();
    },
    onStage: () => {
      const sim = host.sim();
      if (!sim || sim.done) return;
      if (!host.launched()) lightUp();
      else if (!sim.separateStage()) sim.deployChutes();
      update();
    },
    onWarp: warpBy,
    onPause: togglePause,
    onReset: () => { host.reset(); toPad(); update(); },
    onExit: () => exit(),
  });

  function update(): void {
    if (!active) return;
    const sim = host.sim();
    if (!sim) return;
    const s = sim.state;
    const out = burnedOut() && stagesLeft() <= 0;
    const launched = host.launched();
    const weight = s.mass * G0;
    const twr = weight > 0 ? s.thrust / weight : 0;
    deck.update({
      throttle,
      throttleText: out ? 'burned out' : `${Math.round(throttle * 100)}%`,
      throttleDisabled: out || s.chuteDeployed,
      engineOn: engineOn && !out && !s.chuteDeployed,
      engineDisabled: sim.done || out || s.chuteDeployed,
      stageLabel: !launched ? 'Launch' : stagesLeft() > 0 ? 'Stage' : 'Chute',
      stageDisabled: sim.done || (launched && stagesLeft() <= 0 && s.chuteDeployed),
      steerDisabled: sim.done || s.chuteDeployed,
      activeToggles: hold ? ['sas'] : [],
      modeText: sim.done ? (s.phase === 'crashed' ? 'Crashed' : 'Landed') : 'Manual',
      manual: true,
      warpText: `×${warp}`,
      paused,
      readouts: [
        { label: 'Thrust', value: `${s.thrust.toFixed(1)} N` },
        { label: 'Weight', value: `${weight.toFixed(1)} N` },
        { label: 'TWR', value: twr.toFixed(2), tone: s.thrust > 0 && twr < 1 ? 'warn' : undefined },
        { label: 'Alt', value: `${Math.round(s.altitude)} m` },
        { label: 'Speed', value: `${Math.round(s.speed)} m/s` },
      ],
    });
  }

  function exit(): void {
    if (!active) return;
    active = false;
    deck.setVisible(false);
    host.onExit();
  }

  return {
    get active() { return active; },
    start(): void {
      host.reset();
      active = true;
      hold = true;
      warp = DEFAULT_WARP;
      toPad();
      deck.setVisible(true);
      update();
    },
    exit,
    togglePause,
    warpBy,
    tick(realDt: number): number {
      if (!(realDt > 0)) return 0;
      const frame = Math.min(realDt, MAX_FRAME);
      // E and Q move the lever in real time, whatever the warp.
      throttle = Math.min(1, Math.max(0, throttle + input.throttle * THROTTLE_RATE * frame));
      return paused ? 0 : frame * warp;
    },
    controls(): Controls {
      const turning = input.rotate !== 0 || input.tilt !== 0;
      return {
        gimbalPitch: 0,
        gimbalYaw: 0,
        throttle: engineOn ? throttle : 0,
        rate: turning
          ? steerRate(input.rotate, input.tilt, host.noseAxis(), host.cameraQuaternion())
          : hold ? [0, 0, 0] : undefined,
      };
    },
    update,
  };
}
