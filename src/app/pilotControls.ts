// Flying a mission by hand, on the shared flight deck: throttle lever bottom left, hold-to-steer
// arrows bottom right, the autopilot chip and the readouts along the top. The deck is shown
// while a piloted flight is running; the mission's transport bar keeps the time controls.

import type { PilotState, PilotedFlight } from '../mission/pilot';
import { DECK_FINE_SCALE, createFlightDeck, type DeckInput, type DeckState } from './flightDeck';

export interface PilotControls {
  /** The flight being flown, or null when none is. Shows or hides the deck. */
  setFlight(flight: PilotedFlight | null): void;
  /** Refresh the readouts. Call once a frame while a flight is running. */
  update(): void;
}

export interface PilotControlCallbacks {
  onStart(): void;
  onEnd(): void;
}

/** The throttle as the engines have it: solid motors and fixed-thrust engines say so. */
export function throttleText(s: PilotState): string {
  if (s.engineThrottle === null || s.throttleMin === null) return s.solidBurning ? 'solid motors' : 'engines off';
  const actual = Math.round(s.engineThrottle * 100);
  if (s.throttleMin >= 0.999) return `${actual}% · fixed`;
  const cmd = Math.round(s.throttle * 100);
  return s.manual && Math.abs(cmd - actual) >= 2 ? `${actual}% → ${cmd}%` : `${actual}%`;
}
/** Steering and throttle rates are cut to this while Shift is held, for small corrections. */
export const FINE_SCALE = DECK_FINE_SCALE;

const NO_INPUT: DeckInput = { rotate: 0, tilt: 0, throttle: 0 };

/** A control newly pushed in a direction. Letting go, or Shift changing the rate, is not one. */
const pushed = (now: number, before: number): boolean => now !== 0 && Math.sign(now) !== Math.sign(before);

function deckState(s: PilotState, onPad: boolean): DeckState {
  const prograde = s.manual && s.hold === 'prograde';
  // The nose as it is; the arrow shows where it is still heading while it catches the command up.
  const nose = s.noseTiltDeg.toFixed(0), want = s.tiltDeg.toFixed(0);
  const burning = s.engineThrottle !== null || s.solidBurning;
  return {
    // By hand the lever shows the pilot's command; under the autopilot it follows the engines.
    throttle: s.manual ? s.throttle : (s.engineThrottle ?? (s.solidBurning ? 1 : 0)),
    throttleText: throttleText(s),
    // Staging is automatic, so the engine switch only reports whether anything is burning.
    engineOn: burning,
    engineText: 'Auto',
    engineDisabled: true,
    activeToggles: prograde ? ['airflow'] : [],
    modeText: onPad ? 'On pad' : !s.manual ? 'Autopilot' : prograde ? 'Manual · airflow' : 'Manual',
    // Clamped to the pad, steering does nothing until release.
    steerDisabled: onPad,
    manual: s.manual,
    readouts: [
      { label: 'Nose from vertical', value: s.manual && want !== nose ? `${nose}° → ${want}°` : `${nose}°` },
      { label: 'Heading', value: s.manual ? `${s.headingDeg.toFixed(0)}°` : 'auto' },
      {
        label: 'Off airflow',
        // In thin air the angle to the airflow stops mattering.
        value: s.q > 500 ? `${s.alphaDeg.toFixed(0)}°` : '—',
        tone: s.airflow === 'ok' ? undefined : s.airflow,
      },
    ],
  };
}

export function createPilotControls(missionRoot: HTMLElement, cb: PilotControlCallbacks): PilotControls {
  let flight: PilotedFlight | null = null;
  let last = NO_INPUT;

  // ---------- Start button, in the mission header next to Fly ----------
  const startBtn = document.createElement('button');
  startBtn.className = 'sfb-btn msn-pilot-start';
  startBtn.textContent = 'Fly it yourself';
  startBtn.type = 'button';
  startBtn.title = 'Launch now and steer it by hand';
  startBtn.addEventListener('click', () => { startBtn.blur(); cb.onStart(); });
  const headerRight = missionRoot.querySelector('.msn-header-right');
  const flyBtn = headerRight?.querySelector('.sfb-btn-primary');
  if (headerRight && flyBtn) headerRight.insertBefore(startBtn, flyBtn);
  else headerRight?.append(startBtn);

  // ---------- Flight deck ----------
  const takeManual = (): void => { flight?.setManual(true); };

  const deck = createFlightDeck({
    root: missionRoot,
    // Tilt +1 (W) tips the nose toward the horizon.
    tiltLabels: ['Nose down', 'Nose up'],
    rotateLabels: ['Left', 'Right'],
    toggles: [{
      id: 'airflow',
      label: 'Airflow',
      key: 'g',
      title: 'G: keep the nose on the oncoming air, like a real gravity turn',
    }],
    onInput(input) {
      const takeOver = pushed(input.rotate, last.rotate) || pushed(input.tilt, last.tilt) || pushed(input.throttle, last.throttle);
      last = { ...input };
      if (takeOver) takeManual();
      flight?.setInput({ pitch: input.tilt, yaw: input.rotate, throttle: input.throttle });
    },
    onThrottle(level) {
      takeManual();
      flight?.setThrottle(level);
    },
    onToggle(id) {
      if (id !== 'airflow' || !flight) return;
      const s = flight.state();
      if (!s.manual) flight.setManual(true);
      flight.setHold(s.manual && s.hold === 'prograde' ? 'attitude' : 'prograde');
    },
    // The switch is shown disabled: the autopilot lights and stages the engines.
    onEngine() {},
    onMode() { flight?.setManual(!flight.state().manual); },
    onExit: () => cb.onEnd(),
    isActive: () => flight !== null && !missionRoot.classList.contains('sfb-hidden'),
  });

  return {
    setFlight(next: PilotedFlight | null): void {
      // Let go on the outgoing flight; the next one starts with nothing held.
      deck.release();
      last = NO_INPUT;
      flight = next;
      deck.setVisible(next !== null);
      missionRoot.classList.toggle('msn-piloting', next !== null);
      startBtn.textContent = next ? 'Restart flight' : 'Fly it yourself';
    },
    update(): void {
      if (!flight) return;
      const newest = flight.record.samples?.[flight.record.samples.length - 1];
      deck.update(deckState(flight.state(), newest !== undefined && newest.t < 0));
    },
  };
}
