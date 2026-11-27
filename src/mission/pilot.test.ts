import { describe, expect, it } from 'vitest';
import { flyMission } from './fly';
import { PILOT_MAX_LEAD, PILOT_TILT_RATE, startPilotedFlight, type PilotedFlight } from './pilot';
import { getMission } from './vehicles';

const def = getMission('lvm3-m4')!;

/** Angle of the nose from local vertical, degrees, from the sample's own telemetry. */
const tiltOf = (pitchDeg: number | undefined): number => 90 - (pitchDeg ?? 90);

const newest = (flight: PilotedFlight) => flight.record.samples[flight.record.samples.length - 1];

/** A flight taken through the countdown to the moment the clamps let go. */
function launched(mission = def): PilotedFlight {
  const flight = startPilotedFlight(mission);
  while (newest(flight).t <= 0) flight.advance(1 / 60);
  return flight;
}

describe('startPilotedFlight', () => {
  it('starts on the pad before ignition and counts down to release', () => {
    const flight = startPilotedFlight(def);
    const record = flight.record;
    expect(record.samples).toHaveLength(1);
    expect(record.samples[0].t).toBeCloseTo(-3, 6);
    expect(record.samples[0].thrust).toBe(0);
    expect(record.markers).toHaveLength(0);

    flight.advance(1);
    expect(newest(flight).t).toBeCloseTo(-2, 6);
    expect(newest(flight).thrust).toBe(0);

    // Lever and autopilot hand-over on the pad leave the engines at full power.
    flight.setManual(true);
    flight.setThrottle(0);
    expect(flight.state().throttle).toBe(1);
    flight.setManual(false);

    const held: number[] = [];
    while (newest(flight).t <= 0) {
      flight.advance(1 / 60);
      if (newest(flight).t < 0 && newest(flight).thrust > 0) held.push(newest(flight).thrust);
    }
    expect(held.length).toBeGreaterThan(3);
    expect(held[held.length - 1]).toBeGreaterThan(held[0]);
    expect(record.markers.find((m) => /Liftoff/.test(m.label))!.t).toBe(0);
    expect(record.markers.some((m) => /ignition/.test(m.label) && m.t < 0)).toBe(true);
  });

  it('releases at the same instant as the replay, at any frame rate', () => {
    const replay = flyMission(getMission('falcon9-starlink')!);
    for (const frame of [1 / 144, 1 / 30, 0.7]) {
      const flight = launched(getMission('falcon9-starlink')!);
      expect(flight.record.liftoffSimTime).toBeCloseTo(replay.liftoffSimTime!, 9);
      expect(flight.record.markers.find((m) => /Liftoff/.test(m.label))!.t).toBe(0);
      const again = startPilotedFlight(getMission('falcon9-starlink')!);
      for (let t = 0; t < 8; t += frame) again.advance(frame);
      expect(again.record.markers.find((m) => /Liftoff/.test(m.label))!.t).toBe(0);
      expect(again.record.earth!.angleAtLiftoff).toBeCloseTo(replay.earth!.angleAtLiftoff, 9);
      for (let i = 1; i < again.record.samples.length; i++) {
        expect(again.record.samples[i].t).toBeGreaterThan(again.record.samples[i - 1].t);
      }
    }
  });

  it('can be called off during the countdown', () => {
    const flight = startPilotedFlight(def);
    flight.advance(1);
    const record = flight.finish();
    expect(record.outcome!.summary).toBe('Flight ended before liftoff.');
    for (const m of record.markers) expect(Number.isFinite(m.t)).toBe(true);
  });

  it('grows one record as it advances', () => {
    const flight = launched();
    const record = flight.record;
    const pad = record.samples.length;

    for (let i = 0; i < 300; i++) flight.advance(1 / 60);
    expect(flight.record).toBe(record);
    const last = record.samples[record.samples.length - 1];
    expect(last.t).toBeGreaterThan(4.5);
    expect(last.altitude).toBeGreaterThan(record.samples[0].altitude);
    // Frames between kept samples replace the newest one instead of piling up.
    expect(record.samples.length - pad).toBeLessThan(30);
    for (let i = 1; i < record.samples.length; i++) {
      expect(record.samples[i].t).toBeGreaterThan(record.samples[i - 1].t);
    }
    expect(record.markers.find((m) => /Liftoff/.test(m.label))!.label).toMatch(/at T\+3 s/);
    expect(flight.state().manual).toBe(false);
  });

  it('lets the pilot tip the nose over and move the throttle', () => {
    const auto = launched();
    const hand = launched();
    for (let i = 0; i < 40; i++) { auto.advance(0.1); hand.advance(0.1); }

    hand.setManual(true);
    const before = hand.state();
    expect(before.manual).toBe(true);
    hand.setInput({ pitch: 1 });
    for (let i = 0; i < 40; i++) { auto.advance(0.1); hand.advance(0.1); }
    hand.setInput({ pitch: 0 });

    const after = hand.state();
    expect(after.tiltDeg).toBeGreaterThan(before.tiltDeg + 10);
    const a = auto.record.samples[auto.record.samples.length - 1];
    const h = hand.record.samples[hand.record.samples.length - 1];
    expect(h.phase).toBe('manual');
    // The vehicle really follows the command: it leans further than the autopilot's flight.
    expect(tiltOf(h.pitchDeg)).toBeGreaterThan(tiltOf(a.pitchDeg) + 5);

    // Only the commanded level is checked: this early the vehicle is on its solid boosters,
    // which burn at their own rate whatever the throttle says.
    hand.setThrottle(0);
    expect(hand.state().throttle).toBe(0);
    hand.setInput({ throttle: 1 });
    for (let i = 0; i < 10; i++) hand.advance(0.1);
    expect(hand.state().throttle).toBeGreaterThan(0.3);
  });

  it('keeps the command close to the nose, so letting go stops the turn', () => {
    const flight = launched();
    for (let i = 0; i < 480; i++) flight.advance(1 / 60);
    flight.setManual(true);
    flight.setInput({ pitch: 1 });
    for (let i = 0; i < 600; i++) {
      flight.advance(1 / 60);
      const s = flight.state();
      expect(s.tiltDeg - s.noseTiltDeg).toBeLessThanOrEqual(PILOT_MAX_LEAD + 0.5);
    }
    flight.setInput({ pitch: 0 });
    const released = flight.state();
    // Ten seconds of held key really turned the vehicle.
    expect(released.noseTiltDeg).toBeGreaterThan(20);
    for (let i = 0; i < 300; i++) flight.advance(1 / 60);
    const settled = flight.state();
    // The stick lets go over a tenth of a second, so the command creeps on by well under a degree.
    expect(settled.tiltDeg - released.tiltDeg).toBeLessThan(1);
    expect(settled.noseTiltDeg - released.noseTiltDeg).toBeLessThanOrEqual(PILOT_MAX_LEAD + 0.5);
    expect(Math.abs(settled.noseTiltDeg - settled.tiltDeg)).toBeLessThan(1);
  });

  it('turns the heading and can always steer back', () => {
    const flight = launched();
    for (let i = 0; i < 480; i++) flight.advance(1 / 60);
    flight.setManual(true);
    flight.setInput({ pitch: 1 });
    for (let i = 0; i < 300; i++) flight.advance(1 / 60);
    const leaned = flight.state();
    flight.setInput({ pitch: 0, yaw: 1 });
    for (let i = 0; i < 300; i++) flight.advance(1 / 60);
    const turned = flight.state();
    expect(turned.headingDeg).toBeGreaterThan(leaned.headingDeg + 5);
    flight.setInput({ pitch: -1, yaw: 0 });
    for (let i = 0; i < 120; i++) flight.advance(1 / 60);
    expect(flight.state().tiltDeg).toBeLessThan(turned.tiltDeg - 3);
  });

  it('warns before the airflow breaks the vehicle up', () => {
    const flight = launched();
    expect(flight.state().airflow).toBe('ok');
    for (let i = 0; i < 480; i++) flight.advance(1 / 60);
    flight.setManual(true);
    flight.setInput({ pitch: 1 });
    const seen = new Set<string>();
    for (let i = 0; i < 6000 && !flight.ended; i++) {
      flight.advance(1 / 60);
      seen.add(flight.state().airflow);
    }
    expect(flight.ended).toBe(true);
    expect(flight.record.markers.some((m) => /breakup/i.test(m.label))).toBe(true);
    expect(seen.has('warn')).toBe(true);
    expect(seen.has('danger')).toBe(true);
  });

  it('eases the steering in like a stick instead of jumping to full rate', () => {
    const flight = launched();
    for (let i = 0; i < 480; i++) flight.advance(1 / 60);
    flight.setManual(true);
    const start = flight.state().tiltDeg;
    flight.setInput({ pitch: 1 });
    for (let i = 0; i < 6; i++) flight.advance(1 / 60);
    // A tenth of a second at full rate would be 0.6 degrees.
    expect(flight.state().tiltDeg - start).toBeLessThan(0.5 * PILOT_TILT_RATE * 0.1);
    expect(flight.state().tiltDeg).toBeGreaterThan(start);
  });

  it('follows the airflow on prograde hold, and a steering key takes over again', () => {
    const flight = launched();
    for (let i = 0; i < 1200; i++) flight.advance(1 / 60);
    flight.setManual(true);
    flight.setHold('prograde');
    for (let i = 0; i < 1800; i++) flight.advance(1 / 60);
    const s = flight.state();
    expect(s.hold).toBe('prograde');
    expect(s.alphaDeg).toBeLessThan(2);
    expect(flight.ended).toBe(false);
    flight.setInput({ pitch: 1 });
    flight.advance(1 / 60);
    expect(flight.state().hold).toBe('attitude');
  });

  it('keeps the throttle inside what the engines can do', () => {
    const f9 = launched(getMission('falcon9-starlink')!);
    for (let i = 0; i < 600; i++) f9.advance(1 / 60);
    f9.setManual(true);
    f9.setThrottle(0);
    const low = f9.state();
    expect(low.throttleMin).toBeCloseTo(0.57);
    expect(low.throttle).toBeCloseTo(0.57);
    for (let i = 0; i < 300; i++) f9.advance(1 / 60);
    // The Merlins spool down over a couple of seconds, not at once.
    expect(f9.state().engineThrottle!).toBeLessThan(0.65);

    // LVM3's liquid core cannot be throttled at all, and on the pad only the solids burn.
    const lvm = launched();
    expect(lvm.state()).toMatchObject({ solidBurning: true, engineThrottle: null });
    for (let i = 0; i < 1200 && lvm.record.samples[lvm.record.samples.length - 1].t < 115; i++) lvm.advance(0.1);
    lvm.setManual(true);
    lvm.setThrottle(0);
    expect(lvm.state()).toMatchObject({ throttleMin: 1, throttle: 1 });
  });

  it('hands back to the autopilot and finishes with an outcome', () => {
    const flight = launched();
    for (let i = 0; i < 20; i++) flight.advance(0.1);
    flight.setManual(true);
    flight.setManual(false);
    for (let i = 0; i < 20; i++) flight.advance(0.1);
    expect(flight.record.samples[flight.record.samples.length - 1].phase).not.toBe('manual');
    const record = flight.finish();
    expect(record.outcome).toBeDefined();
    expect(record.orbit).toBeDefined();
  });
});
