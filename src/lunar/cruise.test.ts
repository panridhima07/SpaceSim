import { beforeAll, describe, expect, it } from 'vitest';
import { G0, R_MOON, cross, dot, norm, unit } from './core';
import { CH3, CRUISE_RECORD_VERSION, cruiseStateAt, deserializeCruise, flyCruise, serializeCruise, type CruiseRecord } from './cruise';
import { LanderSim } from './lander';
import { createMoonEphemeris } from './moonEphemeris';
import { mfToLL } from './terrain';

const DEG = Math.PI / 180;
const hoursFrom = (rec: CruiseRecord, t: number, iso: string): number =>
  ((rec.epochJD + t / 86400 - 2440587.5) * 86400000 - Date.parse(iso)) / 3600000;

describe('Chandrayaan-3 cruise', () => {
  let rec: CruiseRecord;
  const ev = (id: string) => rec.events.find((e) => e.id === id)!;
  beforeAll(() => { rec = flyCruise(); }, 120000);

  it('flies every step of the mission in order', () => {
    expect(rec.events.map((e) => e.id)).toEqual(
      ['liftoff', 'inject', 'ebn1', 'ebn2', 'ebn3', 'ebn4', 'ebn5', 'tli', 'tcm', 'loi', 'lbn2', 'lbn3', 'lbn4', 'lbn5', 'sep', 'db1', 'db2', 'pdi'],
    );
    for (let i = 1; i < rec.n; i++) expect(rec.t[i]).toBeGreaterThanOrEqual(rec.t[i - 1]);
  });

  it('starts on the pad and carries the launch into the same record', () => {
    // First sample: on the ground at Sriharikota, the whole launch vehicle, before release.
    expect(Math.hypot(rec.r[0], rec.r[1], rec.r[2]) - 6371e3).toBeLessThan(25e3);
    expect(Math.asin(rec.r[2] / Math.hypot(rec.r[0], rec.r[1], rec.r[2])) / DEG).toBeCloseTo(13.7, 0);
    expect(rec.mass[0]).toBeGreaterThan(600e3);
    expect(rec.t[0]).toBeLessThanOrEqual(ev('liftoff').t);
    expect(ev('liftoff').t).toBeLessThan(rec.injectT);
    expect(ev('inject').t).toBe(rec.injectT);
    // The launch is sampled finely and joins the cruise without a jump in position.
    let i = 0;
    while (rec.t[i] < rec.injectT) i++;
    expect(i).toBeGreaterThan(500);
    expect(rec.t[i]).toBe(rec.injectT);
    expect(rec.mass[i]).toBe(CH3.stackMass);
    const gap = Math.hypot(rec.r[3 * i] - rec.r[3 * i - 3], rec.r[3 * i + 1] - rec.r[3 * i - 2], rec.r[3 * i + 2] - rec.r[3 * i - 1]);
    expect(gap).toBeLessThan(1.5 * Math.hypot(rec.v[3 * i], rec.v[3 * i + 1], rec.v[3 * i + 2]) * (rec.t[i] - rec.t[i - 1]) + 1);
    // Climbing all the way: the launcher is in orbit by the time it lets go.
    expect(cruiseStateAt(rec, rec.injectT - 5).burning || cruiseStateAt(rec, rec.injectT - 60).burning).toBe(true);
    expect(ev('inject').orbit!.peri).toBeGreaterThan(120e3);
  });

  it('reaches the published orbits after each Earth-bound burn', () => {
    expect(ev('ebn1').orbit!.apo / 1000).toBeCloseTo(41762, -2);
    expect(ev('ebn3').orbit!.apo / 1000).toBeCloseTo(51400, -2);
    expect(ev('ebn4').orbit!.apo / 1000).toBeCloseTo(71351, -2);
    expect(ev('ebn5').orbit!.apo / 1000).toBeCloseTo(127609, -2);
  });

  it('injects and arrives within a day of the real flight', () => {
    expect(Math.abs(hoursFrom(rec, ev('tli').t, '2023-07-31T18:45:00Z'))).toBeLessThan(24);
    expect(Math.abs(hoursFrom(rec, ev('loi').t, '2023-08-05T13:45:00Z'))).toBeLessThan(24);
    expect(ev('tcm').dv!).toBeLessThan(30); // the course correction is a nudge, not a second injection
  });

  it('is captured by the Moon into a polar orbit', () => {
    const loi = ev('loi').orbit!;
    expect(loi.body).toBe('moon');
    expect(loi.peri).toBeGreaterThan(100e3);
    expect(Number.isFinite(loi.apo)).toBe(true);
    // Handoff state is Moon-centred with +Z along the Moon's spin axis.
    const h = unit(cross(rec.handoff.r, rec.handoff.v));
    expect(Math.abs(Math.acos(h[2]) / DEG - 90)).toBeLessThan(1.5);
  });

  it('spends propellant by the rocket equation and keeps some in reserve', () => {
    const burns = rec.events.filter((e) => e.dv && ['ebn1', 'ebn2', 'ebn3', 'ebn4', 'ebn5', 'tli', 'tcm', 'loi', 'lbn2', 'lbn3', 'lbn4', 'lbn5'].includes(e.id));
    const total = burns.reduce((a, e) => a + e.dv!, 0);
    const expected = CH3.stackMass * Math.exp(-total / (CH3.pmEngine.isp * G0));
    expect(Math.abs(ev('lbn5').mass - expected)).toBeLessThan(0.5);
    expect(rec.pmPropLeft).toBeGreaterThan(0);
    expect(rec.pmPropLeft).toBeLessThan(CH3.pmProp * 0.2);
  });

  it('ends in a descent orbit whose low point is short of the site', () => {
    expect(rec.handoff.perilune).toBeGreaterThan(15e3);
    expect(rec.handoff.perilune).toBeLessThan(32e3);
    expect(Math.abs(rec.handoff.crossTrack)).toBeLessThan(10e3);
  });

  it('interpolates the recorded path through its samples', () => {
    const i = Math.floor(rec.n / 2), s = cruiseStateAt(rec, rec.t[i]);
    expect(Math.hypot(s.r[0] - rec.r[3 * i], s.r[1] - rec.r[3 * i + 1], s.r[2] - rec.r[3 * i + 2])).toBeLessThan(1);
    // Between samples the interpolated speed matches the neighbours.
    const mid = cruiseStateAt(rec, 0.5 * (rec.t[i] + rec.t[i + 1]));
    const v0 = Math.hypot(rec.v[3 * i], rec.v[3 * i + 1], rec.v[3 * i + 2]);
    expect(Math.abs(norm(mid.v) - v0) / v0).toBeLessThan(0.05);
  });

  it('stores and reads back the record exactly', () => {
    const back = deserializeCruise(serializeCruise(rec))!;
    const arrays = ['t', 'r', 'v', 'mass', 'burning'] as const;
    const scalars = (x: CruiseRecord) => ({ ...x, t: 0, r: 0, v: 0, mass: 0, burning: 0 });
    expect(scalars(back)).toEqual(scalars(rec));
    for (const k of arrays) {
      expect(back[k].constructor).toBe(rec[k].constructor);
      expect(back[k].length).toBe(rec[k].length);
      expect((rec[k] as ArrayLike<number> & { every(f: (x: number, i: number) => boolean): boolean }).every((x, i) => Object.is(x, back[k][i]))).toBe(true);
    }
    // An open orbit's apoapsis is Infinity, which plain JSON would turn into null.
    const open = { ...rec, events: rec.events.map((e, i) => (i === 0 ? { ...e, orbit: { body: 'earth' as const, peri: 1, apo: Infinity } } : e)) };
    expect(deserializeCruise(serializeCruise(open))!.events[0].orbit!.apo).toBe(Infinity);
    const wrong = serializeCruise(rec);
    new DataView(wrong).setUint32(4, CRUISE_RECORD_VERSION ^ 1, true);
    expect(deserializeCruise(wrong)).toBeNull();
    expect(deserializeCruise(new ArrayBuffer(4))).toBeNull();
  });

  it('lets Vikram land softly at Shiv Shakti point from that orbit', () => {
    const eph = createMoonEphemeris(rec.epochJD);
    const h = rec.handoff, rm = eph.moonAt(h.t), vm = eph.moonVelAt(h.t);
    const L = new LanderSim(eph, { t: h.t, r: h.r.map((x, i) => x + rm[i]), v: h.v.map((x, i) => x + vm[i]), a: h.v.map((x) => -x) }, h.spec);
    expect(L.beginDescentTo(CH3.site.latDeg * DEG, CH3.site.lonDeg * DEG, CH3.site.name)).toBe(true);
    const twr0 = h.spec.engine!.tMax / (L.mass * 1.62);
    expect(twr0).toBeGreaterThan(1); // four 800 N engines do hold Vikram up, but not by much
    expect(twr0).toBeLessThan(1.3);
    for (let n = 0; n < 4000 && L.phase !== 'LANDED' && L.phase !== 'CRASHED'; n++) L.advance(1);
    expect(L.phase).toBe('LANDED');
    const g = L.landing!;
    expect(g.vv).toBeLessThan(2); // Vikram's design limit
    expect(g.vh).toBeLessThan(0.5);
    expect(g.propLeft!).toBeGreaterThan(0);
    const ll = mfToLL(L.toMF(L.r));
    expect(Math.abs(ll.lat / DEG - CH3.site.latDeg)).toBeLessThan(0.02);
    expect(Math.abs(ll.lon / DEG - CH3.site.lonDeg)).toBeLessThan(0.05);
    expect(norm(L.r) - R_MOON).toBeLessThan(3000);
    expect(dot(L.vrel(), L.vrel())).toBeLessThan(1e-6); // at rest on the turning Moon
  }, 120000);
});
