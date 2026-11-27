import { beforeAll, describe, expect, it } from 'vitest';
import { parseOrkXml } from '../ork/parser';
import { SAMPLE_ORK_XML } from '../ork/sample';
import { findMotor } from '../ork/motors';
import { replaySim } from './replaySim';
import { flightRequest, parseFlightJob, runFlightJob, unpackLog, type FlightJobResult } from './simJob';

const config = {
  railLength: 1.2, railAngle: 0.05, railAzimuth: 0, windSpeed: 3, windDirection: 4.7, gust: 0.1, launchAltitude: 0,
};

let result: FlightJobResult;

beforeAll(() => {
  const request = flightRequest(parseOrkXml(SAMPLE_ORK_XML), findMotor({ designation: 'C6' })!, config);
  result = runFlightJob(parseFlightJob(request), { budgetMs: Infinity });
}, 120_000);

describe('replaySim', () => {
  it('starts on the pad and waits for ignition', () => {
    const sim = replaySim(result);
    expect(sim.state.phase).toBe('pad');
    expect(sim.log).toHaveLength(1);
    expect(sim.events).toEqual([]);
    sim.step(1);
    expect(sim.state.t).toBe(0);
    sim.ignite();
    expect(sim.events.map((e) => e.type)).toEqual(['ignition']);
    sim.ignite();
    expect(sim.events).toHaveLength(1);
  });

  it('reveals events and log samples as the clock passes them, keeping one state object', () => {
    const sim = replaySim(result);
    const state = sim.state;
    const log = sim.log;
    sim.ignite();
    for (let i = 0; i < 200; i++) {
      sim.step(1 / 60);
      expect(sim.state.t).toBeCloseTo((i + 1) / 60, 9);
      expect(sim.events.every((e) => e.t <= sim.state.t + 1e-5)).toBe(true);
      expect(log[log.length - 1].t).toBeLessThanOrEqual(sim.state.t + 1e-5);
    }
    expect(sim.state).toBe(state);
    expect(sim.log).toBe(log);
    expect(sim.events.map((e) => e.type)).toContain('railExit');
    expect(sim.done).toBe(false);
  });

  it('interpolates between samples with a unit quaternion', () => {
    const samples = unpackLog(result.log);
    const i = samples.findIndex((s, k) => k > 0 && s.phase === 'descent' && samples[k + 1].t - s.t > 0.05);
    const a = samples[i];
    const b = samples[i + 1];
    const sim = replaySim(result);
    sim.ignite();
    sim.step((a.t + b.t) / 2);
    expect(sim.state.altitude).toBeCloseTo((a.altitude + b.altitude) / 2, 6);
    expect(sim.state.pos[1]).toBeCloseTo((a.pos[1] + b.pos[1]) / 2, 6);
    expect(Math.hypot(...sim.state.quat)).toBeCloseTo(1, 12);
    expect(sim.state.phase).toBe(a.phase);
  });

  it('normalises and takes the short way round when the quaternion sign flips', () => {
    const base = result.log.rows[0];
    const row = (t: number, quat: number[]): number[] => {
      const r = base.slice();
      r[0] = t;
      r.splice(7, 4, ...quat);
      return r;
    };
    const sim = replaySim({ ...result, events: [], log: { rows: [row(0, [0, 0, 0, 1]), row(1, [0, 0, 0, -1])] } });
    sim.ignite();
    sim.step(0.5);
    expect(sim.state.quat).toEqual([0, 0, 0, 1]);
  });

  it('is done at the end with every event and sample, and stays there', () => {
    const sim = replaySim(result);
    sim.ignite();
    sim.step(1e6);
    expect(sim.done).toBe(true);
    expect(sim.events).toEqual(result.events);
    expect(sim.log).toEqual(unpackLog(result.log));
    expect(sim.state).toEqual({ ...sim.log[sim.log.length - 1], t: sim.state.t });
    expect(sim.state.phase).toBe('landed');
    const t = sim.state.t;
    sim.step(5);
    expect(sim.state.t).toBe(t);
  });

  it('ends the same whatever the frame length', () => {
    const sim = replaySim(result);
    sim.ignite();
    let frames = 0;
    while (!sim.done && frames++ < 100_000) sim.step(0.37);
    expect(sim.done).toBe(true);
    expect(sim.events).toEqual(result.events);
    expect(sim.log).toHaveLength(result.log.rows.length);
  });

  it('cannot be flown by hand', () => {
    const sim = replaySim(result);
    sim.ignite();
    expect(sim.deployChutes()).toBe(false);
    expect(sim.separateStage()).toBe(false);
  });
});
