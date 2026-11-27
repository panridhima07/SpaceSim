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

  describe('launch date and weather', () => {
    const forecast = {
      source: 'forecast' as const,
      date: '2026-11-25',
      hour: 10,
      temperatureC: 31,
      pressureHpa: 1006,
      windSpeed: 9.4,
      windFromDeg: 135,
      gustSpeed: 11.75,
      cloudCover: 40,
      lowCloudCover: 10,
      precipChance: 10,
      visibilityM: 20000,
      weatherCode: 2,
      aloft: [{ altitude: 1500, speed: 14, fromDeg: 180 }],
    };

    const pickDate = (value: string): void => {
      const date = container.querySelector<HTMLInputElement>('.sfb-weather-grid input[type="date"]') as HTMLInputElement;
      date.value = value;
      date.dispatchEvent(new Event('change'));
    };
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    it('does not ask for weather until a date is picked', () => {
      const weather = vi.fn();
      createUI(container, cb, { weather });
      expect(weather).not.toHaveBeenCalled();
      expect(container.querySelector('.sfb-weather')?.textContent).toContain('Pick a launch date');
    });

    it('loads the weather for the picked date and applies it to the launch settings', async () => {
      const weather = vi.fn().mockResolvedValue(forecast);
      const ui = createUI(container, cb, { weather });
      pickDate('2026-11-25');
      await settle();

      expect(weather).toHaveBeenCalledWith(expect.objectContaining({ id: 'sdsc' }), '2026-11-25', 10);
      const cfg = ui.getConfig();
      expect(cfg.windSpeed).toBeCloseTo(9.4);
      expect(cfg.windDirection).toBeCloseTo((135 * Math.PI) / 180);
      expect(cfg.gust).toBeCloseTo(0.25);
      expect(cfg.groundTemperature).toBeCloseTo(304.15);
      expect(cfg.groundPressure).toBeCloseTo(100600);
      expect(cfg.windLayers).toHaveLength(1);
      expect(cb.onConfig).toHaveBeenCalled();

      const out = container.querySelector('.sfb-weather') as HTMLElement;
      expect(out.querySelector('.sfb-pill')?.textContent).toBe('No-go');
      expect(out.textContent).toContain('9.4 m/s from SE');
      expect(out.textContent).toContain('Winds aloft applied');
    });

    it('drops the winds aloft when the surface wind is edited by hand', async () => {
      const ui = createUI(container, cb, { weather: vi.fn().mockResolvedValue(forecast) });
      pickDate('2026-11-25');
      await settle();
      const wind = container.querySelectorAll<HTMLInputElement>('.sfb-launch-grid input')[3];
      wind.value = '0';
      wind.dispatchEvent(new Event('input'));
      const cfg = ui.getConfig();
      expect(cfg.windSpeed).toBe(0);
      expect(cfg.windLayers).toBeUndefined();
    });

    it('keeps the launch settings and says so when the weather cannot be loaded', async () => {
      const ui = createUI(container, cb, { weather: vi.fn().mockRejectedValue(new Error('offline')) });
      pickDate('2026-11-25');
      await settle();
      expect(container.querySelector('.sfb-weather-error')).not.toBeNull();
      expect(ui.getConfig().windSpeed).toBe(2);
      expect(ui.getConfig().groundTemperature).toBeUndefined();
    });

    it('waits for coordinates on a custom site', () => {
      const weather = vi.fn().mockResolvedValue(forecast);
      createUI(container, cb, { weather });
      const site = container.querySelector<HTMLSelectElement>('.sfb-weather-grid select') as HTMLSelectElement;
      site.value = 'custom';
      site.dispatchEvent(new Event('change'));
      pickDate('2026-11-25');
      expect(weather).not.toHaveBeenCalled();
      expect(container.querySelector('.sfb-weather')?.textContent).toContain('latitude and longitude');
    });
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

  it('shows mass, weight and TWR, and warns when a burning motor cannot lift the rocket', () => {
    const ui = createUI(container, cb);
    const read = (label: string): HTMLElement =>
      Array.from(container.querySelectorAll('.sfb-cell'))
        .find((c) => c.querySelector('dt')?.textContent === label)
        ?.querySelector('dd') as HTMLElement;
    ui.setTelemetry(state({ mass: 0.25, thrust: 2 }), 1, false);
    expect(read('Thrust').textContent).toBe('2.0 N');
    expect(read('Mass').textContent).toBe('250 g');
    expect(read('Weight').textContent).toBe('2.5 N');
    expect(read('TWR').textContent).toBe('0.82');
    expect(read('TWR').classList.contains('sfb-twr-low')).toBe(true);
    ui.setTelemetry(state({ mass: 1.5, thrust: 0 }), 1, false);
    expect(read('Mass').textContent).toBe('1.50 kg');
    expect(read('TWR').classList.contains('sfb-twr-low')).toBe(false);
  });

  it('formats whole and slow-motion warp factors', () => {
    const ui = createUI(container, cb);
    const label = container.querySelector('.sfb-warp-label') as HTMLElement;
    ui.setTelemetry(state(), 0.1 + 0.1, false);
    expect(label.textContent).toBe('×0.2');
    ui.setTelemetry(state(), 0.30000000000000004, false);
    expect(label.textContent).toBe('×0.3');
    ui.setTelemetry(state(), 100000, false);
    expect(label.textContent).toBe('×100000');
  });

  it('marks the Pad camera as selected at start', () => {
    createUI(container, cb);
    const pad = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Pad');
    expect(pad?.classList.contains('is-active')).toBe(true);
    expect(cb.onCamera).not.toHaveBeenCalled();
  });

  it('shows the flaw empty states depending on whether a flight happened', () => {
    const ui = createUI(container, cb);
    expect(container.textContent).toContain('Press Launch; the flaw report appears when the flight ends.');
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

  it('keeps toasts visible while the HUD is hidden, and stacks at most three', () => {
    const ui = createUI(container, cb);
    ui.setVisible(false);
    for (const msg of ['one', 'two', 'three', 'four']) ui.toast(msg);
    const shown = Array.from(container.querySelectorAll('.sfb-toast'));
    expect(shown.map((t) => t.textContent)).toEqual(['two', 'three', 'four']);
    expect(shown[0].closest('.sfb-hidden')).toBeNull();
  });

  it('starts the CG/CP and Trail toggles on, as the app does', () => {
    createUI(container, cb);
    const toggle = (label: string): HTMLButtonElement =>
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;
    for (const label of ['CG\u00b7CP', 'Trail']) {
      expect(toggle(label).getAttribute('aria-pressed')).toBe('true');
      expect(toggle(label).classList.contains('is-active')).toBe(true);
    }
    expect(toggle('Forces').getAttribute('aria-pressed')).toBe('false');
    toggle('Trail').click();
    expect(cb.onToggle).toHaveBeenCalledWith('trail', false);
  });

  it('clamps the launch settings and writes the clamped value back on change', () => {
    const ui = createUI(container, cb);
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('.sfb-launch-grid input')).slice(0, 7);
    const enter = (values: string[]): void => {
      inputs.forEach((input, i) => {
        input.value = values[i];
        input.dispatchEvent(new Event('change'));
      });
    };

    enter(['100', '90', '400', '99', '-10', '500', '60']);
    expect(inputs.map((i) => i.value)).toEqual(['30', '45', '360', '40', '0', '100', '30']);

    enter(['0', '-5', '-1', '-2', '999', '-3', '-4']);
    expect(inputs.map((i) => i.value)).toEqual(['0.1', '0', '0', '0', '360', '0', '0']);

    // Clamped even before the field is committed.
    inputs[0].value = '1000';
    inputs[6].value = '99';
    expect(ui.getConfig().railLength).toBe(30);
    expect(ui.getConfig().ejectionDelay).toBe(30);

    enter(['1', '0', '0', '2', '270', '20', '']);
    expect(inputs[6].value).toBe('');
    expect(ui.getConfig().ejectionDelay).toBeUndefined();
  });

  it('ignores auto-repeat for the reset and pause keys', () => {
    createUI(container, cb);
    for (const key of ['r', 'p']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true }));
    }
    expect(cb.onReset).toHaveBeenCalledTimes(1);
    expect(cb.onPause).toHaveBeenCalledTimes(1);
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
      // 812.4 N on 1 kg.
      expect(values).toEqual(['1.23 km', '99.5 m/s', '82.8']);
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
