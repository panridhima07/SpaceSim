// Controls for flying a mission by hand: keys on a keyboard, press-and-hold buttons on a phone.
// The panel sits above the transport bar while a piloted flight is running.

import type { PilotState, PilotedFlight } from '../mission/pilot';

export interface PilotControls {
  /** The flight being flown, or null when none is. Shows or hides the panel. */
  setFlight(flight: PilotedFlight | null): void;
  /** Refresh the readouts. Call once a frame while a flight is running. */
  update(): void;
}

export interface PilotControlCallbacks {
  onStart(): void;
  onEnd(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Keys that steer. Pressing any of them takes over from the autopilot. */
const STEER_KEYS = new Set(['w', 's', 'a', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'e', 'q', 'z', 'x']);

/** The throttle as the engines have it: solid motors and fixed-thrust engines say so. */
export function throttleText(s: PilotState): string {
  if (s.engineThrottle === null || s.throttleMin === null) return s.solidBurning ? 'solid motors' : 'engines off';
  const actual = Math.round(s.engineThrottle * 100);
  if (s.throttleMin >= 0.999) return `${actual}% · fixed`;
  const cmd = Math.round(s.throttle * 100);
  return s.manual && Math.abs(cmd - actual) >= 2 ? `${actual}% → ${cmd}%` : `${actual}%`;
}
/** Steering and throttle rates are cut to this while Shift is held, for small corrections. */
export const FINE_SCALE = 0.3;

export function createPilotControls(missionRoot: HTMLElement, cb: PilotControlCallbacks): PilotControls {
  let flight: PilotedFlight | null = null;
  const held = new Set<string>();
  const touchHeld = new Set<string>();
  let fine = false;

  // ---------- Start button, in the mission header next to Fly ----------
  const startBtn = el('button', 'sfb-btn msn-pilot-start', 'Fly it yourself');
  startBtn.type = 'button';
  startBtn.title = 'Launch now and steer it by hand';
  startBtn.addEventListener('click', () => { startBtn.blur(); cb.onStart(); });
  const headerRight = missionRoot.querySelector('.msn-header-right');
  const flyBtn = headerRight?.querySelector('.sfb-btn-primary');
  if (headerRight && flyBtn) headerRight.insertBefore(startBtn, flyBtn);
  else headerRight?.append(startBtn);

  // ---------- Panel ----------
  const panel = el('section', 'sfb-panel msn-pilot sfb-hidden');
  panel.setAttribute('aria-label', 'Manual flight controls');

  const status = el('div', 'msn-pilot-status');
  const modeChip = el('span', 'msn-pilot-mode', 'Autopilot');
  const stat = (label: string): HTMLElement => {
    const box = el('span', 'msn-pilot-stat');
    const val = el('b', undefined, '—');
    box.append(el('span', 'msn-stat-label', label), val);
    status.append(box);
    return val;
  };
  status.append(modeChip);
  const thrVal = stat('Throttle');
  const tiltVal = stat('Nose from vertical');
  const hdgVal = stat('Heading');
  const airVal = stat('Off airflow');

  const row = el('div', 'msn-pilot-row');

  const tap = (label: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = el('button', 'sfb-btn', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', () => { fn(); b.blur(); });
    row.append(b);
    return b;
  };

  const takeManual = (): void => { flight?.setManual(true); };
  const toggleProgradeHold = (): void => {
    if (!flight) return;
    const s = flight.state();
    if (!s.manual) flight.setManual(true);
    flight.setHold(s.manual && s.hold === 'prograde' ? 'attitude' : 'prograde');
  };

  const applyInput = (): void => {
    if (!flight) return;
    const k = (...keys: string[]): number => (keys.some((x) => held.has(x) || touchHeld.has(x)) ? 1 : 0);
    const scale = fine ? FINE_SCALE : 1;
    flight.setInput({
      pitch: (k('w', 'arrowup') - k('s', 'arrowdown')) * scale,
      yaw: (k('d', 'arrowright') - k('a', 'arrowleft')) * scale,
      throttle: (k('e') - k('q')) * scale,
    });
  };

  /** Press and hold, the same as holding the key. */
  const hold = (label: string, key: string, title: string): void => {
    const b = el('button', 'sfb-btn msn-pilot-hold', label);
    b.type = 'button';
    b.title = title;
    b.style.touchAction = 'none';
    const set = (on: boolean): void => {
      if (on) { takeManual(); touchHeld.add(key); } else touchHeld.delete(key);
      b.classList.toggle('is-active', on);
      applyInput();
    };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); set(true); });
    b.addEventListener('pointerup', () => set(false));
    b.addEventListener('pointercancel', () => set(false));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    row.append(b);
  };

  const modeBtn = tap('Take control', 'T', () => { if (flight) flight.setManual(!flight.state().manual); });
  hold('Nose down', 'w', 'W: tip toward the horizon');
  hold('Nose up', 's', 'S: back toward vertical');
  hold('Turn left', 'a', 'A');
  hold('Turn right', 'd', 'D');
  hold('Throttle −', 'q', 'Q');
  hold('Throttle +', 'e', 'E');
  const progradeBtn = tap('Follow airflow', 'G: keep the nose on the oncoming air, like a real gravity turn', toggleProgradeHold);
  tap('Full', 'Z: full throttle', () => { takeManual(); flight?.setThrottle(1); });
  tap('Min', "X: the engines' lowest setting", () => { takeManual(); flight?.setThrottle(0); });
  tap('End flight', 'Stop here and review the flight', () => cb.onEnd());

  const hint = el('div', 'msn-pilot-hint',
    'W/S nose down/up · A/D turn · hold Shift for fine control · G follow the airflow · E/Q throttle · Z full · X lowest · T autopilot on/off. The rocket turns a few degrees a second, so lead your inputs. Real launches tip a few degrees east just after clearing the tower, then follow the airflow. Staging is automatic; solid motors and some liquid engines cannot be throttled. Keep "Off airflow" small while the air is thick: it turns red before the vehicle breaks up.');

  panel.append(status, row, hint);
  missionRoot.append(panel);

  // ---------- Keyboard ----------
  const active = (): boolean => flight !== null && !missionRoot.classList.contains('sfb-hidden');
  const typing = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range';
  };

  window.addEventListener('keydown', (e) => {
    // Ctrl combinations belong to the browser: Ctrl+W would close the tab mid-flight.
    if (!active() || !flight || typing(e) || e.metaKey || e.altKey || e.ctrlKey) return;
    const key = e.key.toLowerCase();
    if (fine !== e.shiftKey) { fine = e.shiftKey; applyInput(); }
    if (key === 't') {
      if (!e.repeat) flight.setManual(!flight.state().manual);
      return;
    }
    if (key === 'g') {
      if (!e.repeat) toggleProgradeHold();
      return;
    }
    if (!STEER_KEYS.has(key)) return;
    // Arrow keys would otherwise nudge the focused scrubber or scroll a panel.
    if (key.startsWith('arrow')) e.preventDefault();
    if (e.repeat) return;
    takeManual();
    if (key === 'z') flight.setThrottle(1);
    else if (key === 'x') flight.setThrottle(0);
    else held.add(key);
    applyInput();
  });
  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    // Releasing Ctrl or the Windows key can swallow the keyup of whatever was held with it.
    if (key === 'control' || key === 'meta' || key === 'alt') held.clear();
    held.delete(key);
    fine = e.shiftKey;
    applyInput();
  });
  const release = (): void => { held.clear(); touchHeld.clear(); fine = false; applyInput(); };
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  let lastText = '';
  return {
    setFlight(next: PilotedFlight | null): void {
      flight = next;
      held.clear();
      touchHeld.clear();
      fine = false;
      lastText = '';
      panel.classList.toggle('sfb-hidden', next === null);
      missionRoot.classList.toggle('msn-piloting', next !== null);
      startBtn.textContent = next ? 'Restart flight' : 'Fly it yourself';
    },
    update(): void {
      if (!flight) return;
      const s = flight.state();
      const text = `${s.manual}|${s.hold}|${throttleText(s)}|${s.tiltDeg.toFixed(0)}|${s.headingDeg.toFixed(0)}|${s.noseTiltDeg.toFixed(0)}|${s.alphaDeg.toFixed(0)}|${s.airflow}|${s.q > 500}`;
      if (text === lastText) return;
      lastText = text;
      const prograde = s.manual && s.hold === 'prograde';
      modeChip.textContent = !s.manual ? 'Autopilot' : prograde ? 'Manual · airflow' : 'Manual';
      progradeBtn.classList.toggle('is-active', prograde);
      progradeBtn.setAttribute('aria-pressed', String(prograde));
      modeChip.classList.toggle('is-manual', s.manual);
      modeBtn.textContent = s.manual ? 'Autopilot' : 'Take control';
      thrVal.textContent = throttleText(s);
      // The nose as it is; the arrow shows where it is still heading while it catches the command up.
      const nose = s.noseTiltDeg.toFixed(0), want = s.tiltDeg.toFixed(0);
      tiltVal.textContent = s.manual && want !== nose ? `${nose}° → ${want}°` : `${nose}°`;
      // In thin air the angle to the airflow stops mattering.
      airVal.textContent = s.q > 500 ? `${s.alphaDeg.toFixed(0)}°` : '—';
      airVal.classList.toggle('is-warn', s.airflow === 'warn');
      airVal.classList.toggle('is-danger', s.airflow === 'danger');
      hdgVal.textContent = s.manual ? `${s.headingDeg.toFixed(0)}°` : 'auto';
    },
  };
}
