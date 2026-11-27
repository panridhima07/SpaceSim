// The hand-flying controls shared by the three flight screens (main flight, mission, Moon
// landing), laid out like Spaceflight Simulator: throttle lever and engine switch bottom left,
// hold-to-turn arrows bottom right, stage and hold buttons above them, time controls on top.
// The deck only shows state and reports input; each screen decides what the input does.

import './flightDeck.css';

/** Held directions, each -1..1. Scaled by DECK_FINE_SCALE while Shift is held. */
export interface DeckInput {
  /** +1 is the clockwise arrow (D, right), -1 the counter-clockwise one (A, left). */
  rotate: number;
  /** +1 is the upper tilt button (W, up), -1 the lower one (S, down). */
  tilt: number;
  /** +1 is E (open the throttle), -1 is Q (close it). */
  throttle: number;
}

export interface DeckToggle {
  id: string;
  label: string;
  title?: string;
  /** Keyboard key, lower case. */
  key?: string;
}

export interface DeckOptions {
  /** The deck is appended here. */
  root: HTMLElement;
  /** Captions of the tilt buttons, upper (+1) then lower (-1). */
  tiltLabels: [string, string];
  /** Captions of the rotate buttons, left (-1) then right (+1). */
  rotateLabels: [string, string];
  toggles: DeckToggle[];
  onInput(input: DeckInput): void;
  /** The lever was dragged or tapped, or MAX/MIN/Z/X pressed: 0..1. */
  onThrottle(level: number): void;
  onToggle(id: string): void;
  /** The close button. */
  onExit(): void;
  /** Absent: the engine switch is not shown. */
  onEngine?(): void;
  /** Absent: the stage button is not shown and Space is left to the page. */
  onStage?(): void;
  /** Absent: the mode chip is plain text and T is left to the page. */
  onMode?(): void;
  /** Absent: the warp buttons are not shown. */
  onWarp?(delta: 1 | -1): void;
  onPause?(): void;
  onReset?(): void;
  /** Keys are only taken while this returns true. Default: always while visible. */
  isActive?(): boolean;
}

export interface DeckReadout {
  label: string;
  value: string;
  tone?: 'warn' | 'danger';
}

export interface DeckState {
  /** Lever position, 0..1. */
  throttle: number;
  /** Shown above the lever, e.g. "72%" or "solid motors". */
  throttleText: string;
  throttleDisabled?: boolean;
  engineOn: boolean;
  /** Caption of the engine switch. Default "On" / "Off". */
  engineText?: string;
  engineDisabled?: boolean;
  stageLabel?: string;
  stageDisabled?: boolean;
  /** Greys out the rotate and tilt buttons. */
  steerDisabled?: boolean;
  /** Ids of the toggles that are on. */
  activeToggles: string[];
  modeText: string;
  /** Highlights the mode chip. */
  manual: boolean;
  warpText?: string;
  paused?: boolean;
  readouts: DeckReadout[];
}

export interface FlightDeck {
  /** Hidden on creation. Hiding releases every held input. */
  setVisible(on: boolean): void;
  /** Cheap to call every frame: the DOM is only touched where something changed. */
  update(state: DeckState): void;
  /** Let go of everything held and report zero input. */
  release(): void;
}

export const DECK_FINE_SCALE = 0.3;

/** The controls that act for as long as they are held. */
type Hold = 'ccw' | 'cw' | 'tiltUp' | 'tiltDown' | 'throttleUp' | 'throttleDown';

const HOLD_KEYS: Record<string, Hold> = {
  a: 'ccw', arrowleft: 'ccw',
  d: 'cw', arrowright: 'cw',
  w: 'tiltUp', arrowup: 'tiltUp',
  s: 'tiltDown', arrowdown: 'tiltDown',
  e: 'throttleUp',
  q: 'throttleDown',
};

const STEER_HOLDS: Hold[] = ['ccw', 'cw', 'tiltUp', 'tiltDown'];
const THROTTLE_HOLDS: Hold[] = ['throttleUp', 'throttleDown'];

const svg = (body: string): string =>
  `<svg class="fdk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const ICONS = {
  ccw: svg('<path d="M18.06 16.5A7 7 0 1 0 5 13"/><path d="M2 11.6h6L5 16z" fill="currentColor" stroke-width="1.4"/>'),
  cw: svg('<path d="M5.94 16.5A7 7 0 1 1 19 13"/><path d="M16 11.6h6L19 16z" fill="currentColor" stroke-width="1.4"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  engine: svg('<path d="M12 4v7"/><path d="M7.5 6.8a7.5 7.5 0 1 0 9 0"/>'),
  pause: svg('<path d="M9 6v12M15 6v12"/>'),
  play: svg('<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke-width="1.6"/>'),
  reset: svg('<path d="M6 8h8.5a5 5 0 0 1 0 10H8"/><path d="M9.5 4.5L6 8l3.5 3.5"/>'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(cls: string, label: string): HTMLButtonElement {
  const b = el('button', `fdk-btn ${cls}`);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  return b;
}

/**
 * The name a key goes by here. Letters, Space and the arrows are read from where the key sits
 * (`code`), so WASD keeps its shape on AZERTY and still works on non-Latin layouts. Everything
 * else, and events without a code, go by what the key types.
 */
function keyName(e: KeyboardEvent): string {
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (code === 'Space') return ' ';
  if (code.startsWith('Arrow')) return code.toLowerCase();
  return e.key.toLowerCase();
}

/** True when the key press belongs to a field the user is typing in. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target.tagName === 'INPUT') return (target as HTMLInputElement).type !== 'range';
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

function capture(node: Element, pointerId: number): void {
  try {
    node.setPointerCapture?.(pointerId);
  } catch {
    // The pointer is already gone. The window listeners still see it lift.
  }
}

export function createFlightDeck(options: DeckOptions): FlightDeck {
  let visible = false;
  let fine = false;
  let spaceTaken = false;
  let steerDisabled = false;
  let throttleDisabled = false;
  let engineDisabled = false;
  let stageDisabled = false;
  /** The pointer dragging the lever, if any, and the last level it reported. */
  let drag: { id: number; level: number } | null = null;
  let sent: DeckInput = { rotate: 0, tilt: 0, throttle: 0 };
  const heldKeys = new Map<string, Hold>();
  const heldPointers = new Map<number, Hold>();
  const holdButtons = new Map<Hold, HTMLButtonElement>();

  // ---------- Input ----------
  const isHeld = (hold: Hold): boolean => {
    for (const h of heldKeys.values()) if (h === hold) return true;
    for (const h of heldPointers.values()) if (h === hold) return true;
    return false;
  };

  /** Report the combined input, if it differs from what was last reported. */
  const emit = (): void => {
    const scale = fine ? DECK_FINE_SCALE : 1;
    const axis = (plus: Hold, minus: Hold): number => (Number(isHeld(plus)) - Number(isHeld(minus))) * scale;
    const next: DeckInput = {
      rotate: axis('cw', 'ccw'),
      tilt: axis('tiltUp', 'tiltDown'),
      throttle: axis('throttleUp', 'throttleDown'),
    };
    for (const [hold, node] of holdButtons) node.classList.toggle('is-held', isHeld(hold));
    if (next.rotate === sent.rotate && next.tilt === sent.tilt && next.throttle === sent.throttle) return;
    sent = next;
    options.onInput({ ...next });
  };

  const holdDisabled = (hold: Hold): boolean => (THROTTLE_HOLDS.includes(hold) ? throttleDisabled : steerDisabled);

  const drop = (holds: Hold[]): void => {
    for (const [key, h] of heldKeys) if (holds.includes(h)) heldKeys.delete(key);
    for (const [id, h] of heldPointers) if (holds.includes(h)) heldPointers.delete(id);
  };

  const endDrag = (): void => {
    drag = null;
    lever.classList.remove('is-held');
  };

  const liftPointer = (id: number): void => {
    if (drag?.id === id) endDrag();
    if (heldPointers.delete(id)) emit();
  };

  const release = (): void => {
    heldKeys.clear();
    heldPointers.clear();
    fine = false;
    endDrag();
    emit();
  };

  // ---------- Elements ----------
  const deck = el('div', 'fdk fdk-hidden');
  deck.setAttribute('role', 'group');
  deck.setAttribute('aria-label', 'Flight controls');
  deck.addEventListener('contextmenu', (e) => e.preventDefault());

  /** A button that acts once per press. */
  const tap = (node: HTMLButtonElement, action: () => void): HTMLButtonElement => {
    let firedAt = -Infinity;
    // Browsers send no click for a second finger, so staging while an arrow is held needs this.
    node.addEventListener('pointerup', (e) => {
      if (e.isPrimary !== false || node.disabled) return;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) return;
      firedAt = e.timeStamp;
      action();
    });
    node.addEventListener('click', (e) => {
      node.blur();
      // Should a browser send the click after all, it must not act twice.
      if (e.timeStamp - firedAt < 700) return;
      action();
    });
    return node;
  };

  const holdButton = (hold: Hold, cls: string, caption: string, icon: string): HTMLButtonElement => {
    const node = button(`fdk-hold ${cls}`, caption);
    node.innerHTML = icon;
    node.append(el('span', 'fdk-caption', caption));
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.button > 0 || !visible || holdDisabled(hold)) return;
      capture(node, e.pointerId);
      fine = e.shiftKey;
      heldPointers.set(e.pointerId, hold);
      emit();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      node.addEventListener(type, (e) => liftPointer(e.pointerId));
    }
    holdButtons.set(hold, node);
    return node;
  };

  // Top bar: mode, readouts, time controls.
  const top = el('div', 'fdk-top');
  let mode: HTMLElement;
  if (options.onMode) {
    mode = tap(button('fdk-mode', 'Change flight mode'), () => options.onMode?.());
    mode.title = 'Change flight mode (T)';
    mode.setAttribute('aria-keyshortcuts', 'T');
  } else {
    mode = el('span', 'fdk-mode');
  }
  const readouts = el('div', 'fdk-readouts');
  const time = el('div', 'fdk-time');
  const timeButton = (cls: string, label: string, content: string, action: () => void): HTMLButtonElement => {
    const node = tap(button(cls, label), action);
    node.innerHTML = content;
    node.title = label;
    time.append(node);
    return node;
  };
  const warpText = el('span', 'fdk-warp-text');
  warpText.hidden = true;
  if (options.onWarp) timeButton('fdk-warp-down', 'Slow down time', '−', () => options.onWarp?.(-1));
  time.append(warpText);
  if (options.onWarp) timeButton('fdk-warp-up', 'Speed up time', '+', () => options.onWarp?.(1));
  const pause = options.onPause ? timeButton('fdk-pause', 'Pause', ICONS.pause, () => options.onPause?.()) : null;
  if (options.onReset) timeButton('fdk-reset', 'Reset flight', ICONS.reset, () => options.onReset?.());
  timeButton('fdk-close', 'Close flight controls', ICONS.close, () => {
    release();
    options.onExit();
  });
  top.append(mode, readouts, time);

  // Bottom left: throttle and engine.
  const left = el('div', 'fdk-left');
  const throttleText = el('div', 'fdk-throttle-text');
  const setThrottle = (level: number): void => {
    if (!throttleDisabled) options.onThrottle(level);
  };
  const max = tap(button('fdk-max', 'Maximum throttle'), () => setThrottle(1));
  max.textContent = 'MAX';
  max.title = 'Maximum throttle (Z)';
  const min = tap(button('fdk-min', 'Minimum throttle'), () => setThrottle(0));
  min.textContent = 'MIN';
  min.title = 'Minimum throttle (X)';

  const lever = el('div', 'fdk-lever');
  lever.setAttribute('role', 'slider');
  lever.setAttribute('aria-label', 'Throttle');
  lever.setAttribute('aria-orientation', 'vertical');
  lever.setAttribute('aria-valuemin', '0');
  lever.setAttribute('aria-valuemax', '100');
  lever.setAttribute('aria-valuenow', '0');
  lever.setAttribute('aria-disabled', 'false');
  lever.setAttribute('aria-keyshortcuts', 'E Q Z X');
  const track = el('div', 'fdk-track');
  const fill = el('div', 'fdk-fill');
  const handle = el('div', 'fdk-handle');
  track.append(fill, handle);
  lever.append(track);

  const dragTo = (clientY: number): void => {
    const r = track.getBoundingClientRect();
    if (!drag || r.height <= 0) return;
    const level = Math.min(1, Math.max(0, (r.bottom - clientY) / r.height));
    if (level === drag.level) return;
    drag.level = level;
    options.onThrottle(level);
  };
  lever.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (e.button > 0 || !visible || throttleDisabled || drag) return;
    capture(lever, e.pointerId);
    drag = { id: e.pointerId, level: -1 };
    lever.classList.add('is-held');
    dragTo(e.clientY);
  });
  lever.addEventListener('pointermove', (e) => {
    if (drag?.id === e.pointerId) dragTo(e.clientY);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    lever.addEventListener(type, (e) => liftPointer(e.pointerId));
  }
  left.append(throttleText, max, lever, min);

  let engine: HTMLButtonElement | null = null;
  const engineCaption = el('span', 'fdk-caption');
  if (options.onEngine) {
    engine = tap(button('fdk-engine', 'Engine'), () => {
      if (!engineDisabled) options.onEngine?.();
    });
    engine.innerHTML = ICONS.engine;
    engine.append(engineCaption);
    engine.setAttribute('aria-pressed', 'false');
    left.append(engine);
  }

  // Bottom right: stage and toggles, tilt pair, rotate arrows.
  const right = el('div', 'fdk-right');
  const actions = el('div', 'fdk-actions');
  let stage: HTMLButtonElement | null = null;
  if (options.onStage) {
    stage = tap(button('fdk-stage', 'Stage'), () => {
      if (!stageDisabled) options.onStage?.();
    });
    stage.textContent = 'Stage';
    stage.title = 'Space';
    stage.setAttribute('aria-keyshortcuts', 'Space');
    actions.append(stage);
  }
  const toggleBox = el('div', 'fdk-toggles');
  const toggles = options.toggles.map((t) => {
    const node = tap(button('fdk-toggle', t.label), () => options.onToggle(t.id));
    node.textContent = t.label;
    node.dataset.id = t.id;
    node.setAttribute('aria-pressed', 'false');
    if (t.key) node.setAttribute('aria-keyshortcuts', t.key.toUpperCase());
    const hint = t.title ?? (t.key ? `${t.label} (${t.key.toUpperCase()})` : '');
    if (hint) node.title = hint;
    toggleBox.append(node);
    return { id: t.id, node };
  });
  actions.append(toggleBox);

  const tilt = el('div', 'fdk-tilt');
  tilt.append(
    holdButton('tiltUp', 'fdk-tilt-up', options.tiltLabels[0], ICONS.up),
    holdButton('tiltDown', 'fdk-tilt-down', options.tiltLabels[1], ICONS.down),
  );
  const rotate = el('div', 'fdk-rotate');
  rotate.append(
    holdButton('ccw', 'fdk-ccw', options.rotateLabels[0], ICONS.ccw),
    holdButton('cw', 'fdk-cw', options.rotateLabels[1], ICONS.cw),
  );
  right.append(actions, tilt, rotate);

  const body = el('div', 'fdk-body');
  body.append(left, right);
  deck.append(top, body);
  options.root.append(deck);

  // ---------- Keyboard and focus ----------
  /** What a key does here, or null when the deck leaves it to the page. */
  const keyAction = (key: string): (() => void) | null => {
    if (Object.hasOwn(HOLD_KEYS, key)) {
      const hold = HOLD_KEYS[key];
      return () => {
        if (holdDisabled(hold)) return;
        heldKeys.set(key, hold);
        emit();
      };
    }
    if (key === 'z') return () => setThrottle(1);
    if (key === 'x') return () => setThrottle(0);
    if (key === ' ' && options.onStage) {
      return () => {
        if (!stageDisabled) options.onStage?.();
      };
    }
    if (key === 't' && options.onMode) return () => options.onMode?.();
    const toggle = options.toggles.find((t) => t.key === key);
    return toggle ? () => options.onToggle(toggle.id) : null;
  };

  window.addEventListener('keydown', (e) => {
    if (!visible || (options.isActive && !options.isActive())) return;
    // Ctrl combinations belong to the browser: Ctrl+W would close the tab mid-flight.
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (fine !== e.shiftKey) {
      fine = e.shiftKey;
      emit();
    }
    const key = keyName(e);
    const action = keyAction(key);
    if (!action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (key === ' ') spaceTaken = true;
    if (!e.repeat) action();
  }, true);

  window.addEventListener('keyup', (e) => {
    const key = keyName(e);
    // Releasing Ctrl or the Windows key can swallow the keyup of whatever was held with it.
    if (key === 'control' || key === 'meta' || key === 'alt') heldKeys.clear();
    else heldKeys.delete(key);
    fine = e.shiftKey;
    // Some browsers press the focused button when Space comes up.
    if (key === ' ' && spaceTaken) {
      spaceTaken = false;
      e.preventDefault();
    }
    emit();
  }, true);

  window.addEventListener('pointerup', (e) => liftPointer(e.pointerId));
  window.addEventListener('pointercancel', (e) => liftPointer(e.pointerId));
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) release();
  });

  // ---------- State ----------
  const shown = new Map<string, string | number | boolean>();
  /** True the first time a value is seen, and whenever it differs from the last one. */
  const changed = (name: string, value: string | number | boolean): boolean => {
    if (shown.get(name) === value) return false;
    shown.set(name, value);
    return true;
  };

  const readoutNodes: { box: HTMLElement; label: HTMLElement; value: HTMLElement }[] = [];
  const updateReadouts = (list: DeckReadout[]): void => {
    while (readoutNodes.length > list.length) {
      const i = readoutNodes.length - 1;
      readoutNodes.pop()!.box.remove();
      for (const part of ['label', 'value', 'tone']) shown.delete(`readout${i}.${part}`);
    }
    list.forEach((r, i) => {
      let node = readoutNodes[i];
      if (!node) {
        node = { box: el('span', 'fdk-readout'), label: el('span', 'fdk-readout-label'), value: el('b', 'fdk-readout-value') };
        node.box.append(node.label, node.value);
        readouts.append(node.box);
        readoutNodes.push(node);
      }
      if (changed(`readout${i}.label`, r.label)) node.label.textContent = r.label;
      if (changed(`readout${i}.value`, r.value)) node.value.textContent = r.value;
      if (changed(`readout${i}.tone`, r.tone ?? '')) {
        node.box.classList.toggle('is-warn', r.tone === 'warn');
        node.box.classList.toggle('is-danger', r.tone === 'danger');
      }
    });
  };

  return {
    setVisible(on: boolean): void {
      if (on === visible) return;
      visible = on;
      if (!on) release();
      deck.classList.toggle('fdk-hidden', !on);
    },

    update(state: DeckState): void {
      let dropped = false;

      const level = Math.round(Math.min(1, Math.max(0, state.throttle || 0)) * 1000) / 10;
      if (changed('throttle', level)) {
        fill.style.height = `${level}%`;
        handle.style.bottom = `${level}%`;
        lever.setAttribute('aria-valuenow', String(Math.round(level)));
      }
      if (changed('throttleText', state.throttleText)) {
        throttleText.textContent = state.throttleText;
        lever.setAttribute('aria-valuetext', state.throttleText);
      }
      if (changed('throttleDisabled', !!state.throttleDisabled)) {
        throttleDisabled = !!state.throttleDisabled;
        lever.setAttribute('aria-disabled', String(throttleDisabled));
        max.disabled = min.disabled = throttleDisabled;
        if (throttleDisabled) {
          drop(THROTTLE_HOLDS);
          endDrag();
          dropped = true;
        }
      }

      if (engine) {
        if (changed('engineOn', state.engineOn)) {
          engine.classList.toggle('is-on', state.engineOn);
          engine.setAttribute('aria-pressed', String(state.engineOn));
        }
        const text = state.engineText ?? (state.engineOn ? 'On' : 'Off');
        if (changed('engineText', text)) {
          engineCaption.textContent = text;
          engine.setAttribute('aria-label', `Engine ${text}`);
        }
        if (changed('engineDisabled', !!state.engineDisabled)) {
          engineDisabled = engine.disabled = !!state.engineDisabled;
        }
      }

      if (stage) {
        const label = state.stageLabel ?? 'Stage';
        if (changed('stageLabel', label)) {
          stage.textContent = label;
          stage.setAttribute('aria-label', label);
        }
        if (changed('stageDisabled', !!state.stageDisabled)) {
          stageDisabled = stage.disabled = !!state.stageDisabled;
        }
      }

      if (changed('steerDisabled', !!state.steerDisabled)) {
        steerDisabled = !!state.steerDisabled;
        for (const hold of STEER_HOLDS) holdButtons.get(hold)!.disabled = steerDisabled;
        if (steerDisabled) {
          drop(STEER_HOLDS);
          dropped = true;
        }
      }

      for (const t of toggles) {
        const on = state.activeToggles.includes(t.id);
        if (changed(`toggle.${t.id}`, on)) t.node.setAttribute('aria-pressed', String(on));
      }

      if (changed('modeText', state.modeText)) {
        mode.textContent = state.modeText;
        if (options.onMode) mode.setAttribute('aria-label', `${state.modeText}: change flight mode`);
      }
      if (changed('manual', state.manual)) mode.classList.toggle('is-manual', state.manual);

      if (changed('warpText', state.warpText ?? '')) {
        warpText.textContent = state.warpText ?? '';
        warpText.hidden = !state.warpText;
      }
      if (pause && changed('paused', !!state.paused)) {
        const label = state.paused ? 'Resume' : 'Pause';
        pause.innerHTML = state.paused ? ICONS.play : ICONS.pause;
        pause.setAttribute('aria-label', label);
        pause.setAttribute('aria-pressed', String(!!state.paused));
        pause.title = label;
      }

      updateReadouts(state.readouts);
      if (dropped) emit();
    },

    release,
  };
}
