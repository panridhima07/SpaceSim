// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUI } from './ui';
import type { UICallbacks } from './uiTypes';
import type { Flaw, FlightEvent, SimState } from '../types';

describe('createUI', () => {
  let container: HTMLElement;
  let cb: UICallbacks;

  const makeCallbacks = (): UICallbacks => ({
    onFile: vi.fn(),
    onLoadSample: vi.fn(),
    onLaunch: vi.fn(),
    onReset: vi.fn(),
    onWarp: vi.fn(),
    onPause: vi.fn(),
    onCamera: vi.fn(),
    onConfig: vi.fn(),
    onMotor: vi.fn(),
    onToggle: vi.fn(),
    onFlawClick: vi.fn(),
    onScrub: vi.fn(),
    onStressTest: vi.fn(),
  });

  const state = (over: Partial<SimState> = {}): SimState => ({
    t: 1.5,
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    quat: [0, 0, 0, 1],
    omega: [0, 0, 0],
    phase: 'boost',
    mass: 1,
    altitude: 1234,
    speed: 99.5,
    mach: 0.3,
    alpha: 0.05,
    dynamicPressure: 2500,
    thrust: 812.4,
    drag: 0,
    accelG: 4.2,
    cgX: 0,
    cpX: 0,
    stabilityCal: 2.1,
    chuteDeployed: false,
    ...over,
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.append(container);
    cb = makeCallbacks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders into the container and keeps the root non-blocking', () => {
    createUI(container, cb);
    const root = container.querySelector('.sfb-root') as HTMLElement;
    expect(root).not.toBeNull();
    // The stylesheet is not applied in jsdom; pointer-events: none comes from .sfb-root in style.css.
    expect(root.classList.contains('sfb-root')).toBe(true);
  });

  it('getConfig converts degrees and percent, and leaves ejection delay undefined when blank', () => {
    const ui = createUI(container, cb);
    const cfg = ui.getConfig();
    expect(cfg.railLength).toBeCloseTo(1.0);
    expect(cfg.railAngle).toBe(0);
    expect(cfg.windSpeed).toBe(2);
    expect(cfg.windDirection).toBeCloseTo((270 * Math.PI) / 180);
    expect(cfg.gust).toBeCloseTo(0.2);
    expect(cfg.launchAltitude).toBe(0);
    expect(cfg.ejectionDelay).toBeUndefined();
  });

  it('emits onConfig when a launch input changes', () => {
    createUI(container, cb);
    const rail = container.querySelectorAll<HTMLInputElement>('.sfb-launch-grid input')[0];
    rail.value = '2.5';
    rail.dispatchEvent(new Event('input'));
    expect(cb.onConfig).toHaveBeenCalledTimes(1);
    expect((cb.onConfig as ReturnType<typeof vi.fn>).mock.calls[0][0].railLength).toBeCloseTo(2.5);
  });

  it('hides the rocket body and shows the hint when setRocket(null)', () => {
    const ui = createUI(container, cb);
    ui.setRocket(null);
    const hint = container.querySelector('.sfb-hint') as HTMLElement;
    expect(hint.textContent).toContain('Drop an OpenRocket');
    expect(hint.classList.contains('sfb-hidden')).toBe(false);
  });

  it('writes telemetry text and flight events', () => {
    const ui = createUI(container, cb);
    ui.setTelemetry(state(), 10, false);
    expect(container.textContent).toContain('BOOST');
    expect(container.textContent).toContain('1.23 km');
    const events: FlightEvent[] = [
      { t: 1.86, type: 'burnout', altitude: 52, speed: 31, message: 'Burnout' },
    ];
    ui.setEvents(events);
    expect(container.textContent).toContain('T+1.86');
    expect(container.textContent).toContain('Burnout');
  });

  it('shows the flaw empty states depending on whether a flight happened', () => {
    const ui = createUI(container, cb);
    expect(container.textContent).toContain('Fly the rocket to analyse it');
    ui.setEvents([{ t: 0, type: 'ignition', altitude: 0, speed: 0, message: 'Ignition' }]);
    ui.setFlaws([]);
    expect(container.textContent).toContain('Analysing when the flight ends');
    ui.setEvents([{ t: 9, type: 'landing', altitude: 0, speed: 4, message: 'Landed' }]);
    ui.setFlaws([]);
    expect(container.textContent).toContain('No flaws found');
  });

  it('renders a jump link only for flaws with a time', () => {
    const ui = createUI(container, cb);
    const flaws: Flaw[] = [
      { id: 'a', severity: 'critical', title: 'Unstable', detail: 'd', fix: 'f', t: 3.2 },
      { id: 'b', severity: 'info', title: 'Heavy', detail: 'd', fix: 'f' },
    ];
    ui.setFlaws(flaws);
    const links = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.startsWith('Jump'),
    );
    expect(links).toHaveLength(1);
    links[0].click();
    expect(cb.onFlawClick).toHaveBeenCalledWith(flaws[0]);
  });

  it('shows the replay scrubber only for a positive duration', () => {
    const ui = createUI(container, cb);
    const replay = container.querySelector('.sfb-replay') as HTMLElement;
    ui.setReplay(0, 0);
    expect(replay.classList.contains('sfb-hidden')).toBe(true);
    ui.setReplay(20, 5);
    expect(replay.classList.contains('sfb-hidden')).toBe(false);
  });

  it('fires onLaunch for Space outside form fields and ignores it inside an input', () => {
    createUI(container, cb);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(cb.onLaunch).toHaveBeenCalledTimes(1);

    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(cb.onLaunch).toHaveBeenCalledTimes(1);
  });

  it('maps keys 1-4 to cameras and , . to warp', () => {
    createUI(container, cb);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));
    expect(cb.onCamera).toHaveBeenCalledWith('onboard');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.' }));
    expect(cb.onWarp).toHaveBeenCalledWith(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',' }));
    expect(cb.onWarp).toHaveBeenCalledWith(-1);
  });

  it('toast appears and is removed after 3 seconds', () => {
    vi.useFakeTimers();
    const ui = createUI(container, cb);
    ui.toast('Saved');
    expect(container.querySelector('.sfb-toast')?.textContent).toBe('Saved');
    vi.advanceTimersByTime(3000);
    expect(container.querySelector('.sfb-toast')).toBeNull();
  });

  describe('phone HUD (forceMobile)', () => {
    const mobile = { forceMobile: true };
    const sheetOf = (): HTMLElement => container.querySelector('.sfb-sheet') as HTMLElement;
    const menuOf = (): HTMLButtonElement => container.querySelector('.sfb-hud-menu') as HTMLButtonElement;
    const sheetOpen = (): boolean => sheetOf().classList.contains('is-open');
    const landing: FlightEvent = { t: 9, type: 'landing', altitude: 0, speed: 4, message: 'Landed' };
    const flaw: Flaw = { id: 'a', severity: 'critical', title: 'Unstable', detail: 'd', fix: 'f', t: 3.2 };

    it('builds the phone structure with the sheet closed', () => {
      createUI(container, cb, mobile);
      expect(container.querySelector('.sfb-root')?.classList.contains('sfb-mobile')).toBe(true);
      expect(sheetOf()).not.toBeNull();
      expect(sheetOpen()).toBe(false);
    });

    it('opens the sheet from the menu button and closes it from the close button', () => {
      createUI(container, cb, mobile);
      menuOf().click();
      expect(sheetOpen()).toBe(true);
      (sheetOf().querySelector('.sfb-sheet-close') as HTMLButtonElement).click();
      expect(sheetOpen()).toBe(false);
    });

    it('moves the rocket, launch, flaws, log and camera panels into the sheet', () => {
      createUI(container, cb, mobile);
      const sheet = sheetOf();
      expect(sheet.querySelector('.sfb-tabpage-rocket .sfb-motor')).not.toBeNull();
      expect(sheet.querySelector('.sfb-tabpage-launch .sfb-launch-grid')).not.toBeNull();
      expect(sheet.querySelector('.sfb-tabpage-flaws .sfb-flaws')).not.toBeNull();
      expect(sheet.querySelector('.sfb-tabpage-log .sfb-events')).not.toBeNull();
      expect(sheet.querySelector('.sfb-tabpage-view .sfb-dock-group')).not.toBeNull();
      // The desktop columns are emptied on phones.
      expect((container.querySelector('.sfb-left') as HTMLElement).children.length).toBe(0);
      expect((container.querySelector('.sfb-right') as HTMLElement).children.length).toBe(0);
    });

    it('keeps the launch inputs working inside the sheet', () => {
      createUI(container, cb, mobile);
      const rail = sheetOf().querySelector<HTMLInputElement>('.sfb-launch-grid input') as HTMLInputElement;
      rail.value = '3';
      rail.dispatchEvent(new Event('input'));
      expect((cb.onConfig as ReturnType<typeof vi.fn>).mock.calls[0][0].railLength).toBeCloseTo(3);
    });

    it('setTelemetry updates the compact top-strip readouts', () => {
      const ui = createUI(container, cb, mobile);
      ui.setTelemetry(state(), 10, false);
      const values = Array.from(container.querySelectorAll('.sfb-hud-chip .sfb-hud-v')).map((e) => e.textContent);
      expect(values).toEqual(['1.23 km', '99.5 m/s', '4.2 g']);
      expect(container.querySelector('.sfb-hud-top')?.textContent).toContain('T+1.5');
    });

    it('opens the Flaws tab with a badge when flaws arrive after a landing', () => {
      const ui = createUI(container, cb, mobile);
      ui.setEvents([landing]);
      expect(sheetOpen()).toBe(false);
      ui.setFlaws([flaw]);
      expect(sheetOpen()).toBe(true);
      expect(sheetOf().querySelector('.sfb-tabpage-flaws')?.classList.contains('is-active')).toBe(true);
      const badge = container.querySelector('.sfb-badge') as HTMLElement;
      expect(badge.classList.contains('sfb-hidden')).toBe(false);
      expect(badge.textContent).toBe('1');
      expect(badge.classList.contains('is-critical')).toBe(true);
    });

    it('closes the sheet when a flaw jump is tapped', () => {
      const ui = createUI(container, cb, mobile);
      ui.setEvents([landing]);
      ui.setFlaws([flaw]);
      expect(sheetOpen()).toBe(true);
      const jump = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.startsWith('Jump'),
      ) as HTMLButtonElement;
      jump.click();
      expect(cb.onFlawClick).toHaveBeenCalledWith(flaw);
      expect(sheetOpen()).toBe(false);
    });

    it('bottom bar keeps Launch wired to its callback', () => {
      createUI(container, cb, mobile);
      (container.querySelector('.sfb-dock .sfb-btn-launch') as HTMLButtonElement).click();
      expect(cb.onLaunch).toHaveBeenCalledTimes(1);
    });

    it('getConfig still returns the launch defaults', () => {
      const ui = createUI(container, cb, mobile);
      const cfg = ui.getConfig();
      expect(cfg.railLength).toBeCloseTo(1.0);
      expect(cfg.railAngle).toBe(0);
      expect(cfg.windSpeed).toBe(2);
      expect(cfg.windDirection).toBeCloseTo((270 * Math.PI) / 180);
      expect(cfg.gust).toBeCloseTo(0.2);
      expect(cfg.ejectionDelay).toBeUndefined();
    });
  });
});
