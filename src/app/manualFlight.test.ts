// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { atmosphere } from '../physics/atmosphere';
import { massProps } from '../physics/massprops';
import { aeroProps } from '../physics/aero';
import { thrustAt } from '../ork/motors';
import { FIXTURE_MOTOR, FIXTURE_ROCKET } from '../physics/fixture';
import { createSim } from '../physics/sim';
import { G0, type Sim, type SimConfig } from '../types';
import { createManualFlight, MANUAL_WARPS, steerRate, TURN_RATE, type ManualFlight } from './manualFlight';

const CONFIG: SimConfig = {
  railLength: 1, railAngle: 0, railAzimuth: 0, windSpeed: 0, windDirection: 0, gust: 0, launchAltitude: 0,
};
const key = (type: 'keydown' | 'keyup', k: string): void => {
  window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
};

describe('steerRate', () => {
  const front = new THREE.Quaternion(); // camera looking along -Z
  const up = new THREE.Vector3(0, 1, 0);
  /** Where the nose tip moves under an angular velocity. */
  const motion = (w: readonly number[]): THREE.Vector3 => new THREE.Vector3(...(w as [number, number, number])).cross(up);

  it('turns the nose clockwise on screen for the right arrow', () => {
    const m = motion(steerRate(1, 0, up, front));
    expect(m.x).toBeGreaterThan(0.5);
    expect(Math.abs(m.z)).toBeLessThan(1e-9);
  });
  it('leans the nose away from the camera for the upper tilt button', () => {
    const m = motion(steerRate(0, 1, up, front));
    expect(m.z).toBeLessThan(-0.5);
  });
  it.each([-1, 1])('moves the nose the way the buttons point when seen end on (nose z = %i)', (z) => {
    const nose = new THREE.Vector3(0, 0, z);
    const tip = (rotate: number, tilt: number): THREE.Vector3 =>
      new THREE.Vector3(...steerRate(rotate, tilt, nose, front)).cross(nose);
    expect(tip(1, 0).x).toBeGreaterThan(0.5);
    expect(tip(0, 1).y).toBeGreaterThan(0.5);
  });
  it.each([new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)])(
    'turns no faster with a turn and a tilt arrow together (nose %o)',
    (nose) => {
      expect(Math.hypot(...steerRate(1, 0, nose, front))).toBeCloseTo(TURN_RATE);
      expect(Math.hypot(...steerRate(1, 1, nose, front))).toBeCloseTo(TURN_RATE);
      expect(Math.hypot(...steerRate(-1, -1, nose, front))).toBeCloseTo(TURN_RATE);
      // Shift scales both arrows well inside the limit, so nothing is clamped.
      expect(Math.hypot(...steerRate(0.3, 0.3, nose, front))).toBeCloseTo(0.3 * Math.SQRT2 * TURN_RATE);
    },
  );
});

describe('manual flight controller', () => {
  let sim: Sim;
  let launched = false;
  let manual: ManualFlight;
  const host = {
    sim: () => sim,
    launched: () => launched,
    stageCount: () => 1,
    noseAxis: () => new THREE.Vector3(0, 1, 0),
    cameraQuaternion: () => new THREE.Quaternion(),
    launch: vi.fn(() => { sim.ignite(); launched = true; return true; }),
    reset: vi.fn(() => { sim = createSim(FIXTURE_ROCKET, FIXTURE_MOTOR, CONFIG, { atmosphere, massProps, aeroProps, thrust: thrustAt }); launched = false; }),
    cycleCamera: vi.fn(),
    onExit: vi.fn(),
  };
  /** Run the app loop for `seconds` of real time. */
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds / 0.05; i++) {
      const dt = manual.tick(0.05);
      if (launched && !sim.done) sim.step(dt, manual.controls());
      manual.update();
    }
  };

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.clearAllMocks();
    host.reset();
    manual = createManualFlight(document.getElementById('app')!, host);
    manual.start();
  });

  // A hidden deck takes no keys, so earlier tests' decks stay out of the way.
  afterEach(() => manual.exit());

  it('starts on the pad with the engine off', () => {
    expect(manual.active).toBe(true);
    expect(manual.controls().throttle).toBe(0);
    run(0.5);
    expect(sim.state.phase).toBe('pad');
  });

  it('launches from the stage button and flies at quarter speed by default', () => {
    key('keydown', ' ');
    expect(host.launch).toHaveBeenCalledTimes(1);
    expect(manual.controls().throttle).toBe(1);
    expect(manual.tick(0.1)).toBeCloseTo(0.025);
  });

  it('cuts the engine, and fires the parachute from the stage button', () => {
    key('keydown', ' ');
    run(1.2);
    key('keydown', 'x');
    expect(manual.controls().throttle).toBe(0);
    key('keydown', ' ');
    expect(sim.state.chuteDeployed).toBe(true);
  });

  describe('chute prompt', () => {
    const mode = (): string => document.querySelector('.fdk-mode')!.textContent!;
    // Fly (engine cut after burnout so it coasts) until the sim logs apogee, or give up after 600 s of sim time.
    const flyPastApogee = (): void => {
      for (let i = 0; i < 12000 && !sim.events.some((e) => e.type === 'apogee') && !sim.done; i++) {
        sim.step(0.05, manual.controls());
        manual.update();
      }
    };

    it('says Manual before apogee', () => {
      key('keydown', ' ');
      run(1);
      expect(mode()).toBe('Manual');
    });

    it('prompts for the chute after apogee without opening it', () => {
      key('keydown', ' ');
      flyPastApogee();
      expect(sim.events.some((e) => e.type === 'apogee')).toBe(true);
      expect(sim.state.chuteDeployed).toBe(false);
      expect(mode()).toBe('Falling · open the chute');
    });

    it('drops the prompt once Space opens the chute', () => {
      key('keydown', ' ');
      flyPastApogee();
      key('keydown', ' ');
      expect(sim.state.chuteDeployed).toBe(true);
      expect(mode()).not.toBe('Falling · open the chute');
    });
  });

  it('offers steering only once the rocket is off the rail', () => {
    const arrow = (): boolean => document.querySelector<HTMLButtonElement>('.fdk-rotate button')!.disabled;
    expect(arrow()).toBe(true);
    key('keydown', ' ');
    run(2);
    expect(arrow()).toBe(false);
  });

  it('holds attitude by default and lets go when SAS is off', () => {
    key('keydown', ' ');
    run(2);
    expect(manual.controls().rate).toEqual([0, 0, 0]);
    key('keydown', 'f');
    expect(manual.controls().rate).toBeUndefined();
    key('keydown', 'd');
    expect(Math.hypot(...manual.controls().rate!)).toBeGreaterThan(0.5);
    key('keyup', 'd');
    expect(manual.controls().rate).toBeUndefined();
  });

  it('exits cleanly', () => {
    manual.exit();
    expect(manual.active).toBe(false);
    expect(host.onExit).toHaveBeenCalled();
    key('keydown', ' ');
    expect(host.launch).not.toHaveBeenCalled();
  });

  it('keeps the lever within 0..1', () => {
    key('keydown', ' ');
    const lever = document.querySelector('.fdk-lever')!;
    document.querySelector<HTMLElement>('.fdk-track')!.getBoundingClientRect = () =>
      ({ top: 100, bottom: 300, height: 200 }) as DOMRect;
    const at = (type: string, clientY: number): void => {
      lever.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientY, bubbles: true, cancelable: true }));
    };
    at('pointerdown', 150);
    expect(manual.controls().throttle).toBeCloseTo(0.75);
    at('pointermove', 900);
    expect(manual.controls().throttle).toBe(0);
    at('pointermove', -900);
    expect(manual.controls().throttle).toBe(1);
    at('pointerup', -900);
  });

  it('moves the throttle with Q and E as time passes, within 0..1', () => {
    key('keydown', ' ');
    const hold = (k: string, seconds: number): void => {
      key('keydown', k);
      for (let i = 0; i < seconds / 0.1; i++) manual.tick(0.1);
      key('keyup', k);
    };
    hold('q', 1);
    expect(manual.controls().throttle).toBeCloseTo(0.5);
    hold('q', 3);
    expect(manual.controls().throttle).toBe(0);
    hold('e', 3);
    expect(manual.controls().throttle).toBe(1);
  });

  it('shows thrust, weight and TWR with units', () => {
    const readouts = (): Record<string, string> => Object.fromEntries(
      [...document.querySelectorAll('.fdk-readout')].map((n) => [
        n.querySelector('.fdk-readout-label')!.textContent,
        n.querySelector('.fdk-readout-value')!.textContent,
      ]),
    );
    expect(readouts()).toMatchObject({ Thrust: '0.0 N', TWR: '0.00', Alt: '0 m', Speed: '0 m/s' });
    key('keydown', ' ');
    run(0.4);
    const { thrust, mass } = sim.state;
    expect(thrust).toBeGreaterThan(0);
    expect(readouts().Thrust).toBe(`${thrust.toFixed(1)} N`);
    expect(readouts().Weight).toBe(`${(mass * G0).toFixed(1)} N`);
    expect(readouts().TWR).toBe((thrust / (mass * G0)).toFixed(2));
  });

  it('lets go of held arrows when the window loses focus', () => {
    key('keydown', ' ');
    run(2);
    key('keydown', 'd');
    key('keydown', 'w');
    expect(Math.hypot(...manual.controls().rate!)).toBeGreaterThan(0.5);
    window.dispatchEvent(new Event('blur'));
    expect(manual.controls().rate).toEqual([0, 0, 0]);
  });

  it('stops the warp steps at both ends', () => {
    const shown = (): string => document.querySelector('.fdk-warp-text')!.textContent!;
    for (let i = 0; i < MANUAL_WARPS.length + 2; i++) manual.warpBy(-1);
    expect(shown()).toBe('×0.25');
    expect(manual.tick(0.1)).toBeCloseTo(0.025);
    for (let i = 0; i < MANUAL_WARPS.length + 2; i++) manual.warpBy(1);
    expect(shown()).toBe('×5');
    expect(manual.tick(0.1)).toBeCloseTo(0.5);
    document.querySelector<HTMLButtonElement>('.fdk-warp-down')!.click();
    expect(shown()).toBe('×2');
  });

  it('gives no simulated time while paused, from the method or the button', () => {
    const pause = document.querySelector<HTMLButtonElement>('.fdk-pause')!;
    manual.togglePause();
    expect(pause.getAttribute('aria-label')).toBe('Resume');
    expect(manual.tick(0.1)).toBe(0);
    pause.click();
    expect(pause.getAttribute('aria-label')).toBe('Pause');
    expect(manual.tick(0.1)).toBeCloseTo(0.025);
  });

  it('takes no keys, pauses or warps while inactive', () => {
    manual.exit();
    for (const k of [' ', 'x', 'd', 'f', 'v', 'e']) {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(host.launch).not.toHaveBeenCalled();
    expect(host.cycleCamera).not.toHaveBeenCalled();
    manual.togglePause();
    manual.warpBy(1);
    expect(manual.tick(0.1)).toBeCloseTo(0.025);
  });
});
