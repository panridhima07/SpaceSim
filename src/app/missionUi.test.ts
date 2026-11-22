// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlightRecord } from '../mission/record';
import { snapshotAt } from '../mission/snapshot';
import { getMission } from '../mission/vehicles';
import { createMissionUI, type MissionUiCallbacks } from './missionUi';

function makeCallbacks(): MissionUiCallbacks {
  return {
    onExit: vi.fn(),
    onFly: vi.fn(),
    onPlayPause: vi.fn(),
    onWarp: vi.fn(),
    onScrub: vi.fn(),
    onCamera: vi.fn(),
  };
}

function makeRecord(): FlightRecord {
  return {
    source: 'mission',
    vehicleName: 'LVM3-M4 / Chandrayaan-3',
    samples: [
      {
        t: 0,
        pos: [6378137, 0, 0],
        quat: [0, 0, 0, 1],
        vel: [0, 0, 0],
        altitude: 0,
        speed: 0,
        mach: 0,
        q: 0,
        accelG: 1,
        mass: 640_000,
        thrust: 9_000_000,
        stage: 0,
        propellant: [110_000, 410_000, 28_000],
        health: { maxQ: 0.5, skin: 1.2 },
      },
      {
        t: 100,
        pos: [6478137, 0, 0],
        quat: [0, 0, 0, 1],
        vel: [0, 2000, 0],
        altitude: 100_000,
        speed: 2000,
        mach: 6,
        q: 0,
        accelG: 3,
        mass: 200_000,
        thrust: 1_600_000,
        stage: 0,
        propellant: [50_000, 0, 28_000],
        health: { maxQ: 0.5, skin: 1.2 },
      },
    ],
    markers: [
      { t: 10, kind: 'event', label: 'Liftoff' },
      { t: 50, kind: 'event', label: 'S200 separation', reference: 127.0 },
      { t: 75, kind: 'flaw', label: 'High skin temp', severity: 'critical' },
    ],
    outcome: {
      outcome: 'nominal',
      summary: 'Reached target transfer orbit.',
      perigeeAltitude: 170_000,
      apogeeAltitude: 36_500_000,
      apogeeShortfall: 0,
      impact: null,
    },
  };
}

describe('createMissionUI', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders timeline rows equal to event markers and shows reference times', () => {
    const cbs = makeCallbacks();
    const ui = createMissionUI(document.body, cbs);
    const rec = makeRecord();
    ui.setRecord(rec, getMission('lvm3-m4')!);

    const rows = document.querySelectorAll('.msn-event-row');
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain('127.0');
  });

  it('assigns critical class for health 1.2 and good class for health 0.5', () => {
    const cbs = makeCallbacks();
    const ui = createMissionUI(document.body, cbs);
    const rec = makeRecord();
    ui.setRecord(rec, getMission('lvm3-m4')!);
    ui.update(snapshotAt(rec, 0), true, 1);

    const healthRows = Array.from(document.querySelectorAll('.msn-health-list .msn-bar-row'));
    const maxQRow = healthRows.find((r) => r.textContent?.includes('Dynamic pressure'));
    const skinRow = healthRows.find((r) => r.textContent?.includes('Skin temperature'));
    expect(maxQRow?.classList.contains('msn-health-good')).toBe(true);
    expect(skinRow?.classList.contains('msn-health-critical')).toBe(true);
  });

  it('hides outcome banner before the end and shows it at the end', () => {
    const cbs = makeCallbacks();
    const ui = createMissionUI(document.body, cbs);
    const rec = makeRecord();
    ui.setRecord(rec, getMission('lvm3-m4')!);

    ui.update(snapshotAt(rec, 50), true, 1);
    const banner = document.querySelector('.msn-outcome')!;
    expect(banner.classList.contains('sfb-hidden')).toBe(true);

    ui.update(snapshotAt(rec, 100), false, 1);
    expect(banner.classList.contains('sfb-hidden')).toBe(false);
    expect(banner.textContent).toContain('NOMINAL');
    expect(banner.textContent).toContain('170.0 x 36500.0 km');
  });

  it('calls onScrub with the marker time when clicking a timeline row', () => {
    const cbs = makeCallbacks();
    const ui = createMissionUI(document.body, cbs);
    const rec = makeRecord();
    ui.setRecord(rec, getMission('lvm3-m4')!);

    const rows = document.querySelectorAll<HTMLButtonElement>('.msn-event-row');
    rows[1].click();
    expect(cbs.onScrub).toHaveBeenCalledWith(50);
  });
});
