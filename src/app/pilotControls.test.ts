// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PilotInput, PilotState, PilotedFlight } from '../mission/pilot';
import { FINE_SCALE, createPilotControls, throttleText, type PilotControls } from './pilotControls';

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

/** jsdom has no PointerEvent; the deck only needs the id, the button and where it is. */
const pointer = (node: Element, type: string, clientY = 0): void => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  node.dispatchEvent(e);
};

let root: HTMLElement;
let controls: PilotControls;
let f: ReturnType<typeof fakeFlight>;
let onStart: () => void;
let onEnd: () => void;

const find = <T extends HTMLElement = HTMLButtonElement>(selector: string): T => root.querySelector<T>(selector)!;
const labelled = (label: string): HTMLButtonElement => find(`button[aria-label="${label}"]`);
const readout = (label: string): HTMLElement =>
  [...root.querySelectorAll<HTMLElement>('.fdk-readout')].find((n) => n.querySelector('.fdk-readout-label')!.textContent === label)!;

beforeEach(() => {
  document.body.innerHTML = '<div class="msn-root"><div class="msn-header-right"><button class="sfb-btn-primary">Fly</button></div></div>';
  root = document.querySelector<HTMLElement>('.msn-root')!;
  onStart = vi.fn();
  onEnd = vi.fn();
  controls = createPilotControls(root, { onStart, onEnd });
  f = fakeFlight();
  controls.setFlight(f.flight);
  controls.update();
});

// A deck left showing would go on taking the next test's keys.
afterEach(() => controls.setFlight(null));

describe('mission flight deck', () => {
  it('shows with a flight and goes away with it, along with the header button caption', () => {
    const start = find('.msn-pilot-start');
    expect(find('.fdk').classList.contains('fdk-hidden')).toBe(false);
    expect(root.classList.contains('msn-piloting')).toBe(true);
    expect(start.textContent).toBe('Restart flight');
    expect(start.nextElementSibling?.textContent).toBe('Fly');
    start.click();
    expect(onStart).toHaveBeenCalledOnce();

    controls.setFlight(null);
    expect(find('.fdk').classList.contains('fdk-hidden')).toBe(true);
    expect(root.classList.contains('msn-piloting')).toBe(false);
    expect(start.textContent).toBe('Fly it yourself');
    expect(key('keydown', 'w').defaultPrevented).toBe(false);
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

  it('takes control from an on-screen button held down', () => {
    for (const [label, axis, value] of [['Nose down', 'pitch', 1], ['Nose up', 'pitch', -1], ['Left', 'yaw', -1], ['Right', 'yaw', 1]] as const) {
      f.st.manual = false;
      pointer(labelled(label), 'pointerdown');
      expect(f.st.manual).toBe(true);
      expect(f.input[axis]).toBe(value);
      pointer(labelled(label), 'pointerup');
      expect(f.input[axis]).toBe(0);
    }
  });

  it('opens and closes the throttle with E and Q, taking control', () => {
    key('keydown', 'e');
    expect(f.st.manual).toBe(true);
    expect(f.input.throttle).toBe(1);
    key('keyup', 'e');
    key('keydown', 'q');
    expect(f.input.throttle).toBe(-1);
  });

  it('does not take control back when a key held through T is let go', () => {
    key('keydown', 'w');
    key('keydown', 'd');
    key('keydown', 't');
    expect(f.st.manual).toBe(false);
    key('keyup', 'w');
    key('keyup', 'd');
    expect(f.st.manual).toBe(false);
    expect(f.input).toMatchObject({ pitch: 0, yaw: 0 });
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

  it('ignores keys while the mission view is hidden', () => {
    root.classList.add('sfb-hidden');
    expect(key('keydown', 'w').defaultPrevented).toBe(false);
    expect(f.st.manual).toBe(false);
  });

  it('drops every held key when the window loses focus', () => {
    key('keydown', 'w');
    key('keydown', 'e');
    window.dispatchEvent(new Event('blur'));
    expect(f.input).toMatchObject({ pitch: 0, yaw: 0, throttle: 0 });
  });

  it('starts a new flight with nothing held', () => {
    key('keydown', 'w');
    const next = fakeFlight();
    controls.setFlight(next.flight);
    expect(f.input.pitch).toBe(0);
    expect(next.st.manual).toBe(false);
    expect(next.input.pitch).toBe(0);
  });

  it('G takes control and follows the airflow, and G again holds the attitude', () => {
    key('keydown', 'g');
    expect(f.st.manual).toBe(true);
    expect(f.st.hold).toBe('prograde');
    controls.update();
    expect(labelled('Airflow').getAttribute('aria-pressed')).toBe('true');
    expect(find('.fdk-mode').textContent).toBe('Manual · airflow');
    key('keyup', 'g');
    labelled('Airflow').click();
    expect(f.st.hold).toBe('attitude');
    controls.update();
    expect(labelled('Airflow').getAttribute('aria-pressed')).toBe('false');
  });

  it('sets the throttle outright with Z, X, the lever and its end buttons', () => {
    key('keydown', 'x');
    expect(f.spies.setThrottle).toHaveBeenLastCalledWith(0);
    expect(f.st.manual).toBe(true);
    key('keydown', 'z');
    expect(f.spies.setThrottle).toHaveBeenLastCalledWith(1);

    f.st.manual = false;
    labelled('Minimum throttle').click();
    expect(f.spies.setThrottle).toHaveBeenLastCalledWith(0);
    expect(f.st.manual).toBe(true);
    labelled('Maximum throttle').click();
    expect(f.spies.setThrottle).toHaveBeenLastCalledWith(1);

    f.st.manual = false;
    find('.fdk-track').getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 }) as DOMRect;
    pointer(find('.fdk-lever'), 'pointerdown', 25);
    expect(f.spies.setThrottle).toHaveBeenLastCalledWith(0.75);
    expect(f.st.manual).toBe(true);
  });

  it('switches the autopilot with T and with the mode chip', () => {
    const chip = find('button.fdk-mode');
    expect(chip.textContent).toBe('Autopilot');
    key('keydown', 't');
    expect(f.st.manual).toBe(true);
    controls.update();
    expect(chip.textContent).toBe('Manual');
    chip.click();
    expect(f.st.manual).toBe(false);
  });

  it('reports the engines on a switch that cannot be pressed, and has no stage button', () => {
    const engine = find('.fdk-engine');
    expect(engine.disabled).toBe(true);
    expect(engine.textContent).toBe('Auto');
    expect(engine.getAttribute('aria-pressed')).toBe('true');
    f.st.solidBurning = false;
    controls.update();
    expect(engine.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('.fdk-stage')).toBeNull();
    expect(key('keydown', ' ').defaultPrevented).toBe(false);
  });

  it('shows where the nose is, where it is heading and how far off the airflow', () => {
    const value = (label: string): string => readout(label).querySelector('b')!.textContent!;
    expect(value('Nose from vertical')).toBe('0°');
    expect(value('Heading')).toBe('auto');
    expect(value('Off airflow')).toBe('—');

    Object.assign(f.st, { manual: true, noseTiltDeg: 5, tiltDeg: 12, headingDeg: 95, q: 20000, alphaDeg: 14, airflow: 'warn' });
    controls.update();
    expect(value('Nose from vertical')).toBe('5° → 12°');
    expect(value('Heading')).toBe('95°');
    expect(value('Off airflow')).toBe('14°');
    expect(readout('Off airflow').classList.contains('is-warn')).toBe(true);

    f.st.airflow = 'danger';
    controls.update();
    expect(readout('Off airflow').classList.contains('is-danger')).toBe(true);
    expect(readout('Off airflow').classList.contains('is-warn')).toBe(false);
  });

  it('ends the flight from the close button', () => {
    labelled('Close flight controls').click();
    expect(onEnd).toHaveBeenCalledOnce();
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
