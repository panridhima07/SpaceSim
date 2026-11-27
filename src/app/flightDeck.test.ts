// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DECK_FINE_SCALE, createFlightDeck } from './flightDeck';
import type { DeckInput, DeckOptions, DeckState, FlightDeck } from './flightDeck';

const ZERO: DeckInput = { rotate: 0, tilt: 0, throttle: 0 };

const baseState: DeckState = {
  throttle: 0.5, throttleText: '50%', engineOn: false, activeToggles: [],
  modeText: 'Manual', manual: true, readouts: [],
};

const decks: FlightDeck[] = [];

function setup(over: Partial<DeckOptions> = {}) {
  const spies = {
    onInput: vi.fn(), onThrottle: vi.fn(), onToggle: vi.fn(), onExit: vi.fn(), onEngine: vi.fn(),
    onStage: vi.fn(), onMode: vi.fn(), onWarp: vi.fn(), onPause: vi.fn(), onReset: vi.fn(),
  };
  const deck = createFlightDeck({
    root: document.body,
    tiltLabels: ['Tilt away', 'Tilt toward'],
    rotateLabels: ['Turn left', 'Turn right'],
    toggles: [{ id: 'sas', label: 'SAS', key: 'g' }],
    ...spies,
    ...over,
  });
  decks.push(deck);
  deck.setVisible(true);
  deck.update(baseState);
  const q = <T extends HTMLElement = HTMLButtonElement>(sel: string): T => document.querySelector<T>(sel)!;
  const input = (): DeckInput => spies.onInput.mock.lastCall?.[0] ?? ZERO;
  return { deck, spies, q, input };
}

const key = (type: 'keydown' | 'keyup', k: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent => {
  const e = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

const pointer = (node: Element, type: string, pointerId = 1, init: PointerEventInit = {}): void => {
  node.dispatchEvent(new PointerEvent(type, { pointerId, bubbles: true, cancelable: true, isPrimary: true, ...init }));
};

beforeEach(() => { document.body.innerHTML = ''; });
// The deck listens on window for good; a hidden one takes no keys.
afterEach(() => { for (const d of decks.splice(0)) d.setVisible(false); });

describe('flight deck keys', () => {
  it.each([
    ['a', { rotate: -1 }], ['ArrowLeft', { rotate: -1 }],
    ['d', { rotate: 1 }], ['ArrowRight', { rotate: 1 }],
    ['w', { tilt: 1 }], ['ArrowUp', { tilt: 1 }],
    ['s', { tilt: -1 }], ['ArrowDown', { tilt: -1 }],
    ['e', { throttle: 1 }], ['q', { throttle: -1 }],
  ])('holds %s', (k, expected) => {
    const { input } = setup();
    expect(key('keydown', k).defaultPrevented).toBe(true);
    expect(input()).toEqual({ ...ZERO, ...expected });
    key('keyup', k);
    expect(input()).toEqual(ZERO);
  });

  it('taps Z, X, Space, T and the toggle keys', () => {
    const { spies } = setup();
    key('keydown', 'z');
    expect(spies.onThrottle).toHaveBeenLastCalledWith(1);
    key('keydown', 'x');
    expect(spies.onThrottle).toHaveBeenLastCalledWith(0);
    key('keydown', ' ');
    expect(spies.onStage).toHaveBeenCalledTimes(1);
    key('keydown', 't');
    expect(spies.onMode).toHaveBeenCalledTimes(1);
    key('keydown', 'G', { shiftKey: true });
    expect(spies.onToggle).toHaveBeenLastCalledWith('sas');
    expect(spies.onInput).not.toHaveBeenCalled();
  });

  it('scales held input while Shift is down', () => {
    const { input } = setup();
    key('keydown', 'W', { shiftKey: true });
    expect(input().tilt).toBeCloseTo(DECK_FINE_SCALE);
    key('keyup', 'Shift');
    expect(input().tilt).toBe(1);
    key('keydown', 'Shift', { shiftKey: true });
    expect(input().tilt).toBeCloseTo(DECK_FINE_SCALE);
  });

  it('consumes its keys so page shortcuts do not fire, and leaves the others', () => {
    const { spies } = setup();
    const page = vi.fn();
    window.addEventListener('keydown', page, true);
    window.addEventListener('keydown', page);
    key('keydown', 'w', {}, document.body);
    key('keydown', ' ', {}, document.body);
    expect(page).not.toHaveBeenCalled();
    expect(key('keydown', 'k', {}, document.body).defaultPrevented).toBe(false);
    expect(page).toHaveBeenCalledTimes(2);
    expect(spies.onStage).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', page, true);
    window.removeEventListener('keydown', page);
  });

  it('consumes auto-repeat without acting again', () => {
    const { spies } = setup();
    key('keydown', ' ');
    const again = key('keydown', ' ', { repeat: true });
    expect(again.defaultPrevented).toBe(true);
    expect(spies.onStage).toHaveBeenCalledTimes(1);
    key('keydown', 'w');
    key('keydown', 'w', { repeat: true });
    expect(spies.onInput).toHaveBeenCalledTimes(1);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])('leaves %o combinations to the browser', (mod) => {
    const { spies } = setup();
    expect(key('keydown', 'w', mod).defaultPrevented).toBe(false);
    expect(key('keydown', 'z', mod).defaultPrevented).toBe(false);
    expect(spies.onInput).not.toHaveBeenCalled();
    expect(spies.onThrottle).not.toHaveBeenCalled();
  });

  it('lets go of held keys when a modifier is released', () => {
    const { input } = setup();
    key('keydown', 'w');
    key('keyup', 'Control');
    expect(input()).toEqual(ZERO);
  });

  it('leaves keys without a callback to the page', () => {
    setup({ onStage: undefined, onMode: undefined });
    expect(key('keydown', ' ').defaultPrevented).toBe(false);
    expect(key('keydown', 't').defaultPrevented).toBe(false);
    expect(document.querySelector('.fdk-stage')).toBeNull();
    expect(document.querySelector('.fdk-mode')!.tagName).toBe('SPAN');
  });

  it('ignores typing in fields but not range inputs, and always releases', () => {
    const { input, spies } = setup();
    const text = document.createElement('input');
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const range = document.createElement('input');
    range.type = 'range';
    document.body.append(text, area, editable, range);
    for (const field of [text, area, editable]) {
      expect(key('keydown', 'a', {}, field).defaultPrevented).toBe(false);
    }
    expect(spies.onInput).not.toHaveBeenCalled();
    key('keydown', 'a', {}, range);
    expect(input().rotate).toBe(-1);
    key('keyup', 'a', {}, text);
    expect(input()).toEqual(ZERO);
  });

  describe('by physical position', () => {
    it('tilts, not throttles, on the AZERTY key where W sits', () => {
      const { input, spies } = setup();
      expect(key('keydown', 'z', { code: 'KeyW' }).defaultPrevented).toBe(true);
      expect(input()).toEqual({ ...ZERO, tilt: 1 });
      expect(spies.onThrottle).not.toHaveBeenCalled();
      key('keyup', 'z', { code: 'KeyW' });
      expect(input()).toEqual(ZERO);
    });

    it('reads WASD, the taps and toggles on a non-Latin layout', () => {
      const { input, spies } = setup();
      key('keydown', 'ф', { code: 'KeyA' });
      expect(input().rotate).toBe(-1);
      key('keyup', 'ф', { code: 'KeyA' });
      expect(input()).toEqual(ZERO);
      key('keydown', 'я', { code: 'KeyZ' });
      expect(spies.onThrottle).toHaveBeenLastCalledWith(1);
      key('keydown', 'п', { code: 'KeyG' });
      expect(spies.onToggle).toHaveBeenLastCalledWith('sas');
    });

    it('reads Space and the arrows from the code', () => {
      const { input, spies } = setup();
      key('keydown', ' ', { code: 'Space' });
      expect(spies.onStage).toHaveBeenCalledTimes(1);
      expect(key('keyup', ' ', { code: 'Space' }).defaultPrevented).toBe(true);
      key('keydown', 'ArrowLeft', { code: 'ArrowLeft' });
      expect(input().rotate).toBe(-1);
      key('keyup', 'ArrowLeft', { code: 'ArrowLeft' });
      expect(input()).toEqual(ZERO);
    });

    it('goes by what the key types for other codes, such as a keypad arrow', () => {
      const { input } = setup();
      key('keydown', 'ArrowUp', { code: 'Numpad8' });
      expect(input().tilt).toBe(1);
      key('keyup', 'ArrowUp', { code: 'Numpad8' });
      expect(input()).toEqual(ZERO);
    });

    it('releases a key that types something else by the time it comes up', () => {
      const { input } = setup();
      key('keydown', 'w', { code: 'KeyW' });
      key('keyup', 'ц', { code: 'KeyW' });
      expect(input()).toEqual(ZERO);
    });

    it.each([
      ['Shift', 'ShiftLeft'], ['Control', 'ControlLeft'], ['Meta', 'MetaLeft'], ['Alt', 'AltRight'],
    ])('handles %s events that carry a code', (name, code) => {
      const { input } = setup();
      key('keydown', 'w', { code: 'KeyW', shiftKey: name === 'Shift' });
      key('keyup', name, { code });
      expect(input()).toEqual(name === 'Shift' ? { ...ZERO, tilt: 1 } : ZERO);
    });
  });

  it('takes no keys while hidden or inactive', () => {
    let active = false;
    const { deck, spies } = setup({ isActive: () => active });
    expect(key('keydown', 'w').defaultPrevented).toBe(false);
    active = true;
    deck.setVisible(false);
    expect(key('keydown', 'w').defaultPrevented).toBe(false);
    expect(spies.onInput).not.toHaveBeenCalled();
  });
});

describe('flight deck release', () => {
  it.each([
    ['release()', (d: FlightDeck) => d.release()],
    ['hiding the deck', (d: FlightDeck) => d.setVisible(false)],
    ['window blur', () => window.dispatchEvent(new Event('blur'))],
    ['a hidden document', () => {
      const spy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      spy.mockRestore();
    }],
  ])('drops keys and pointers on %s', (_name, act) => {
    const { deck, spies, q, input } = setup();
    key('keydown', 'e');
    pointer(q('.fdk-cw'), 'pointerdown');
    expect(input()).toEqual({ rotate: 1, tilt: 0, throttle: 1 });
    act(deck);
    expect(input()).toEqual(ZERO);
    expect(q('.fdk-cw').classList.contains('is-held')).toBe(false);
    const calls = spies.onInput.mock.calls.length;
    deck.release();
    expect(spies.onInput).toHaveBeenCalledTimes(calls);
  });
});

describe('flight deck pointers', () => {
  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('holds a button until %s', (end) => {
    const { q, input } = setup();
    pointer(q('.fdk-tilt-down'), 'pointerdown');
    expect(input().tilt).toBe(-1);
    pointer(q('.fdk-tilt-down'), end);
    expect(input()).toEqual(ZERO);
  });

  it('follows several pointers at once and reports only changes', () => {
    const { q, input, spies } = setup();
    pointer(q('.fdk-ccw'), 'pointerdown', 1);
    pointer(q('.fdk-tilt-up'), 'pointerdown', 2);
    expect(input()).toEqual({ rotate: -1, tilt: 1, throttle: 0 });
    key('keydown', 'a');
    expect(spies.onInput).toHaveBeenCalledTimes(2);
    pointer(q('.fdk-ccw'), 'pointerup', 1);
    expect(input().rotate).toBe(-1);
    key('keyup', 'a');
    expect(input()).toEqual({ rotate: 0, tilt: 1, throttle: 0 });
  });

  it('acts on a second finger tapping a button while an arrow is held', () => {
    const { q, spies, input } = setup();
    pointer(q('.fdk-cw'), 'pointerdown', 1);
    pointer(q('.fdk-stage'), 'pointerup', 2, { isPrimary: false });
    expect(spies.onStage).toHaveBeenCalledTimes(1);
    expect(input().rotate).toBe(1);
  });

  it('sets the throttle by tapping and dragging the lever', () => {
    const { q, spies } = setup();
    q<HTMLElement>('.fdk-track').getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200 }) as DOMRect;
    const lever = q<HTMLElement>('.fdk-lever');
    pointer(lever, 'pointerdown', 3, { clientY: 150 });
    expect(spies.onThrottle).toHaveBeenLastCalledWith(0.75);
    pointer(lever, 'pointermove', 3, { clientY: 400 });
    expect(spies.onThrottle).toHaveBeenLastCalledWith(0);
    pointer(lever, 'pointermove', 3, { clientY: 0 });
    expect(spies.onThrottle).toHaveBeenLastCalledWith(1);
    pointer(lever, 'pointerup', 3);
    pointer(lever, 'pointermove', 3, { clientY: 200 });
    expect(spies.onThrottle).toHaveBeenCalledTimes(3);
  });

  it('runs the tap buttons and drops focus afterwards', () => {
    const { q, spies } = setup();
    for (const sel of ['.fdk-max', '.fdk-min', '.fdk-engine', '.fdk-stage', '.fdk-toggle', '.fdk-mode',
      '.fdk-warp-down', '.fdk-warp-up', '.fdk-pause', '.fdk-reset', '.fdk-close']) {
      q(sel).focus();
      q(sel).click();
      expect(document.activeElement).not.toBe(q(sel));
    }
    expect(spies.onThrottle.mock.calls).toEqual([[1], [0]]);
    expect(spies.onWarp.mock.calls).toEqual([[-1], [1]]);
    expect(spies.onToggle).toHaveBeenCalledWith('sas');
    for (const f of [spies.onEngine, spies.onStage, spies.onMode, spies.onPause, spies.onReset, spies.onExit]) {
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('labels every button and blocks the long-press menu', () => {
    const { q } = setup();
    for (const b of document.querySelectorAll('.fdk button')) expect(b.getAttribute('aria-label')).toBeTruthy();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    q('.fdk-cw').dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });
});

describe('flight deck disabled controls', () => {
  const off: DeckState = {
    ...baseState, throttleDisabled: true, engineDisabled: true, stageDisabled: true, steerDisabled: true,
  };

  it('ignores keys and pointers', () => {
    const { deck, q, spies } = setup();
    deck.update(off);
    for (const k of ['a', 'd', 'w', 's', 'e', 'q', 'z', 'x', ' ']) key('keydown', k);
    for (const sel of ['.fdk-ccw', '.fdk-cw', '.fdk-tilt-up', '.fdk-tilt-down']) {
      expect(q(sel).disabled).toBe(true);
      pointer(q(sel), 'pointerdown');
    }
    q<HTMLElement>('.fdk-track').getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200 }) as DOMRect;
    pointer(q<HTMLElement>('.fdk-lever'), 'pointerdown', 4, { clientY: 150 });
    for (const sel of ['.fdk-max', '.fdk-min', '.fdk-engine', '.fdk-stage']) q(sel).click();
    for (const f of [spies.onInput, spies.onThrottle, spies.onEngine, spies.onStage]) expect(f).not.toHaveBeenCalled();
    expect(q('.fdk-lever').getAttribute('aria-disabled')).toBe('true');
  });

  it('lets go of a control that is disabled while held', () => {
    const { deck, q, input } = setup();
    key('keydown', 'e');
    pointer(q('.fdk-cw'), 'pointerdown');
    deck.update({ ...baseState, steerDisabled: true });
    expect(input()).toEqual({ rotate: 0, tilt: 0, throttle: 1 });
    deck.update(off);
    expect(input()).toEqual(ZERO);
  });
});

describe('flight deck state', () => {
  it('starts hidden', () => {
    decks.push(createFlightDeck({
      root: document.body, tiltLabels: ['u', 'd'], rotateLabels: ['l', 'r'], toggles: [],
      onInput: vi.fn(), onThrottle: vi.fn(), onToggle: vi.fn(), onExit: vi.fn(),
    }));
    expect(document.querySelector('.fdk')!.classList.contains('fdk-hidden')).toBe(true);
    for (const sel of ['.fdk-engine', '.fdk-stage', '.fdk-pause', '.fdk-reset', '.fdk-warp-up']) {
      expect(document.querySelector(sel)).toBeNull();
    }
  });

  it('shows what it is given', () => {
    const { deck, q } = setup();
    deck.update({
      throttle: 0.72, throttleText: '72%', engineOn: true, engineText: 'Burning', stageLabel: 'Chute',
      activeToggles: ['sas'], modeText: 'Autopilot', manual: false, warpText: 'x5', paused: true,
      readouts: [{ label: 'Alt', value: '120 m' }, { label: 'AoA', value: '9', tone: 'danger' }],
    });
    const lever = q('.fdk-lever');
    expect(lever.getAttribute('aria-valuenow')).toBe('72');
    expect(lever.getAttribute('aria-valuetext')).toBe('72%');
    expect(q('.fdk-fill').style.height).toBe('72%');
    expect(q('.fdk-handle').style.bottom).toBe('72%');
    expect(q('.fdk-throttle-text').textContent).toBe('72%');
    expect(q('.fdk-engine').classList.contains('is-on')).toBe(true);
    expect(q('.fdk-engine').textContent).toBe('Burning');
    expect(q('.fdk-stage').textContent).toBe('Chute');
    expect(q('.fdk-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(q('.fdk-mode').textContent).toBe('Autopilot');
    expect(q('.fdk-mode').classList.contains('is-manual')).toBe(false);
    expect(q('.fdk-warp-text').textContent).toBe('x5');
    expect(q('.fdk-pause').getAttribute('aria-label')).toBe('Resume');
    const values = [...document.querySelectorAll('.fdk-readout-value')].map((n) => n.textContent);
    expect(values).toEqual(['120 m', '9']);
    expect(document.querySelectorAll('.fdk-readout.is-danger')).toHaveLength(1);

    deck.update(baseState);
    expect(q('.fdk-engine').textContent).toBe('Off');
    expect(q('.fdk-stage').textContent).toBe('Stage');
    expect(q('.fdk-warp-text').hidden).toBe(true);
    expect(document.querySelectorAll('.fdk-readout')).toHaveLength(0);
    deck.update({ ...baseState, readouts: [{ label: 'Alt', value: '120 m' }] });
    expect(q('.fdk-readout-value').textContent).toBe('120 m');
  });

  it('leaves the DOM alone when nothing changed', async () => {
    const { deck } = setup();
    const state: DeckState = { ...baseState, warpText: 'x1', readouts: [{ label: 'Alt', value: '1 m', tone: 'warn' }] };
    deck.update(state);
    const seen = vi.fn();
    const observer = new MutationObserver(seen);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    deck.update({ ...state, activeToggles: [], readouts: [{ ...state.readouts[0] }] });
    await Promise.resolve();
    expect(seen).not.toHaveBeenCalled();
    observer.disconnect();
  });
});
