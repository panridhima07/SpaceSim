// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlightRecord } from '../mission/record';
import { snapshotAt } from '../mission/snapshot';
import { MISSIONS, getMission, type MissionDef } from '../mission/vehicles';
import { createMissionUI, type MissionUiCallbacks } from './missionUi';

function makeCallbacks(): MissionUiCallbacks {
  return {
    onExit: vi.fn(),
    onMission: vi.fn(),
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

  it('lists every mission in the picker and fires onMission when one is chosen', () => {
    const cbs = makeCallbacks();
    createMissionUI(document.body, cbs);

    const picker = document.querySelector<HTMLSelectElement>('select[aria-label="Mission"]')!;
    expect(picker.classList.contains('msn-select')).toBe(true);
    const names = Array.from(picker.options).map((o) => o.textContent);
    expect(names).toEqual(MISSIONS.map((m) => m.name));

    const last = MISSIONS[MISSIONS.length - 1];
    picker.value = last.id;
    picker.dispatchEvent(new Event('change'));
    expect(cbs.onMission).toHaveBeenCalledWith(last.id);
  });

  it('follows setRecord: picker value, title and case list match the mission', () => {
    const cbs = makeCallbacks();
    const ui = createMissionUI(document.body, cbs);
    const picker = document.querySelector<HTMLSelectElement>('select[aria-label="Mission"]')!;
    const caseSelect = document.querySelector<HTMLSelectElement>('select[aria-label="Flight case"]')!;

    for (const def of MISSIONS) {
      ui.setRecord(makeRecord(), def);
      expect(picker.value).toBe(def.id);
      expect(document.querySelector('.msn-vehicle-name')!.textContent).toBe(def.name);
      expect(caseSelect.value).toBe('nominal');
    }

    const copy: MissionDef = { ...base(), id: 'lvm3-m4', name: 'Copied test flight' };
    ui.setRecord(makeRecord(), copy);
    expect(document.querySelector('.msn-vehicle-name')!.textContent).toBe('Copied test flight');
    const failOptions = Array.from(caseSelect.options).filter((o) => o.value === 'vikas-out');
    expect(failOptions).toHaveLength(1);
  });

  it('shows the Moon button only for Chandrayaan-3', () => {
    const cbs = makeCallbacks();
    const ui = createMissionUI(document.body, cbs);
    const moon = document.querySelector<HTMLButtonElement>('.msn-moon-btn')!;

    ui.setRecord(makeRecord(), { ...base(), id: 'lvm3-m4' });
    expect(moon.classList.contains('sfb-hidden')).toBe(false);

    ui.setRecord(makeRecord(), { ...base(), id: 'pslv-c61', name: 'Other flight' });
    expect(moon.classList.contains('sfb-hidden')).toBe(true);
  });

  it('keeps fault cards across ticks with the same faults and rebuilds them when the set changes', () => {
    const cbs = makeCallbacks();
    const ui = createMissionUI(document.body, cbs);
    const rec = makeRecord();
    const fault = (id: string, t0: number, t1: number): NonNullable<FlightRecord['faults']>[number] => ({
      id,
      system: 'thermal',
      severity: 'critical',
      t: t0,
      tFirst: t0,
      tLast: t1,
      value: 1.2,
      limit: 1,
      unit: '',
      title: `Fault ${id}`,
      detail: `Detail ${id}`,
      fix: `Fix ${id}`,
    });
    rec.faults = [fault('a', 0, 100), fault('b', 60, 100)];
    ui.setRecord(rec, getMission('lvm3-m4')!);

    const snap = snapshotAt(rec, 20);
    ui.update(snap, true, 1);
    const first = Array.from(document.querySelectorAll('.msn-fault-card'));
    expect(first).toHaveLength(1);
    expect(first[0].textContent).toContain('Fault a');

    ui.update(snap, true, 1);
    const second = Array.from(document.querySelectorAll('.msn-fault-card'));
    expect(second).toHaveLength(1);
    expect(second[0]).toBe(first[0]);

    ui.update(snapshotAt(rec, 70), true, 1);
    const third = Array.from(document.querySelectorAll('.msn-fault-card'));
    expect(third).toHaveLength(2);
    expect(third[0]).not.toBe(first[0]);
    expect(third[1].textContent).toContain('Fault b');

    // A new record must not be hidden by values cached from the previous one.
    ui.setRecord(rec, getMission('lvm3-m4')!);
    expect(document.querySelectorAll('.msn-fault-card')).toHaveLength(0);
    ui.update(snapshotAt(rec, 70), true, 1);
    expect(document.querySelectorAll('.msn-fault-card')).toHaveLength(2);
    expect(document.querySelector('.msn-stat-val')!.textContent).toBe('T+70.0 s');
  });

  it('works for a mission with no failureCases and no faults', () => {
    const cbs = makeCallbacks();
    const ui = createMissionUI(document.body, cbs);
    const def: MissionDef = { ...base(), id: 'test-no-cases', name: 'No cases', failureCases: undefined, faults: undefined };
    const rec = makeRecord();

    expect(() => ui.setRecord(rec, def)).not.toThrow();
    expect(() => ui.update(snapshotAt(rec, 0), true, 1)).not.toThrow();

    const caseSelect = document.querySelector<HTMLSelectElement>('select[aria-label="Flight case"]')!;
    const values = Array.from(caseSelect.options).map((o) => o.value);
    expect(values).toContain('nominal');
    expect(values).not.toContain('blocked-vent'); // scenarios need a fault model
    expect(values).not.toContain('vikas-out');
    expect(document.querySelector('.msn-vehicle-name')!.textContent).toBe('No cases');
  });
});

/** A mission definition built from lvm3-m4, so the tests do not depend on other mission ids. */
function base(): MissionDef {
  return { ...getMission('lvm3-m4')!, failureCases: getMission('lvm3-m4')!.failureCases?.slice() };
}
