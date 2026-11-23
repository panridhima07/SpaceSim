// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PilotInput, PilotState, PilotedFlight } from '../mission/pilot';
import { FINE_SCALE, createPilotControls, throttleText } from './pilotControls';

function fakeFlight() {
  const input: PilotInput = { pitch: 0, yaw: 0, throttle: 0 };
  const st: PilotState = {
    manual: false, hold: 'attitude', tiltDeg: 0, headingDeg: 90, throttle: 1,
    engineThrottle: null, throttleMin: null, solidBurning: true, noseTiltDeg: 0, alphaDeg: 0, q: 0, airflow: 'ok', ended: false,
  };
  const flight = {
    record: {} as PilotedFlight['record'],
    ended: false,
    markerVersion: 0,
    state: () => st,
    setManual: vi.fn((on: boolean) => { st.manual = on; if (on) st.hold = 'attitude'; }),
    setHold: vi.fn((hold: PilotState['hold']) => { st.hold = hold; }),
    setInput: (next: Partial<PilotInput>) => { Object.assign(input, next); },
    setThrottle: vi.fn((level: number) => { st.throttle = level; }),
    advance: vi.fn(),
    finish: vi.fn(),
  };
  return { flight: flight as unknown as PilotedFlight, input, st, spies: flight };
}

const key = (type: 'keydown' | 'keyup', k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
};

describe('pilot keyboard controls', () => {
  let root: HTMLElement;
  let f: ReturnType<typeof fakeFlight>;

  beforeEach(() => {
    document.body.innerHTML = '<div class="msn-root"><div class="msn-header-right"></div></div>';
    root = document.querySelector<HTMLElement>('.msn-root')!;
    const controls = createPilotControls(root, { onStart: vi.fn(), onEnd: vi.fn() });
    f = fakeFlight();
    controls.setFlight(f.flight);
  });

  it('steers while a key is held and stops when it is let go', () => {
    key('keydown', 'w');
    expect(f.st.manual).toBe(true);
    expect(f.input.pitch).toBe(1);
    key('keydown', 'd');
    expect(f.input).toMatchObject({ pitch: 1, yaw: 1 });
    key('keyup', 'w');
    expect(f.input).toMatchObject({ pitch: 0, yaw: 1 });
    key('keyup', 'd');
    expect(f.input).toMatchObject({ pitch: 0, yaw: 0, throttle: 0 });
  });

  it('leaves Ctrl combinations to the browser', () => {
    const e = key('keydown', 'w', { ctrlKey: true });
    expect(f.st.manual).toBe(false);
    expect(f.input.pitch).toBe(0);
    expect(e.defaultPrevented).toBe(false);
    key('keydown', 'Control');
    expect(f.input.throttle).toBe(0);
  });

  it('steers gently with Shift held', () => {
    key('keydown', 'Shift', { shiftKey: true });
    expect(f.st.manual).toBe(false);
    key('keydown', 'W', { shiftKey: true });
    expect(f.input.pitch).toBeCloseTo(FINE_SCALE);
    key('keyup', 'Shift');
    expect(f.input.pitch).toBe(1);
    key('keyup', 'w');
    expect(f.input.pitch).toBe(0);
  });

  it('keeps arrow keys from scrolling and ignores typing in fields', () => {
    expect(key('keydown', 'ArrowUp').defaultPrevented).toBe(true);
    expect(f.input.pitch).toBe(1);
    key('keyup', 'ArrowUp');

    const field = document.createElement('input');
    root.append(field);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(f.input.yaw).toBe(0);
  });

  it('drops every held key when the window loses focus', () => {
    key('keydown', 'w');
    key('keydown', 'e');
    window.dispatchEvent(new Event('blur'));
    expect(f.input).toMatchObject({ pitch: 0, yaw: 0, throttle: 0 });
  });

  it('G takes control and follows the airflow until a steering key is pressed', () => {
    key('keydown', 'g');
    expect(f.st.manual).toBe(true);
    expect(f.st.hold).toBe('prograde');
    key('keyup', 'g');
    key('keydown', 'g');
    expect(f.st.hold).toBe('attitude');
  });

  it('sets the throttle outright with Z and X, and T hands control back', () => {
    key('keydown', 'x');
    expect(f.spies.setThrottle).toHaveBeenLastCalledWith(0);
    key('keydown', 'z');
    expect(f.spies.setThrottle).toHaveBeenLastCalledWith(1);
    expect(f.st.manual).toBe(true);
    key('keydown', 't');
    expect(f.st.manual).toBe(false);
  });
});

describe('throttleText', () => {
  const base: PilotState = {
    manual: true, hold: 'attitude', tiltDeg: 0, headingDeg: 90, throttle: 1,
    engineThrottle: null, throttleMin: null, solidBurning: false,
    noseTiltDeg: 0, alphaDeg: 0, q: 0, airflow: 'ok', ended: false,
  };
  it('says what the engines can really do', () => {
    expect(throttleText({ ...base, solidBurning: true })).toBe('solid motors');
    expect(throttleText(base)).toBe('engines off');
    expect(throttleText({ ...base, engineThrottle: 1, throttleMin: 1 })).toBe('100% · fixed');
    expect(throttleText({ ...base, engineThrottle: 0.9, throttleMin: 0.57, throttle: 0.6 })).toBe('90% → 60%');
    expect(throttleText({ ...base, engineThrottle: 0.6, throttleMin: 0.57, throttle: 0.6 })).toBe('60%');
  });
});
