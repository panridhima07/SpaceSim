// Handing the lander back to the autopilot after flying it by hand, the way the Moon page does:
// any touch of a control switches to MANUAL, and the Autopilot button switches back at an arbitrary
// moment. The autopilot has to land from the state it is given, not from the one it planned for.
import { beforeAll, describe, expect, it } from 'vitest';
import { CH3, flyCruise } from './cruise';
import { LanderSim } from './lander';
import { createMoonEphemeris } from './moonEphemeris';

const DEG = Math.PI / 180;
const done = (l: LanderSim) => l.phase === 'LANDED' || l.phase === 'CRASHED';

describe('autopilot after hand flying', () => {
  let base: LanderSim;
  let untouched: LanderSim;

  beforeAll(() => {
    // The start the page uses: Vikram in the descent orbit the cruise ends in.
    const rec = flyCruise(), eph = createMoonEphemeris(rec.epochJD);
    const h = rec.handoff, rm = eph.moonAt(h.t), vm = eph.moonVelAt(h.t);
    base = new LanderSim(eph, { t: h.t, r: h.r.map((x, i) => x + rm[i]), v: h.v.map((x, i) => x + vm[i]), a: h.v.map((x) => -x) }, h.spec);
    expect(base.beginDescentTo(CH3.site.latDeg * DEG, CH3.site.lonDeg * DEG, CH3.site.name)).toBe(true);
    untouched = fly(() => false, 0, () => {});
  }, 120_000);

  /** Frame-sized steps, warped through the coast as the page does. */
  function run(L: LanderSim, until: (l: LanderSim) => boolean): void {
    for (let n = 0; n < 2e6 && !done(L) && !until(L); n++) L.advance(L.phase === 'COAST' ? Math.max(L.maxWarp(), 1) / 30 : 0.1);
  }
  /** Autopilot until `when`, then `secs` of hand flying set up by `pilot`, then the Autopilot button. */
  function fly(when: (l: LanderSim, tPDI: number) => boolean, secs: number, pilot: (l: LanderSim) => void): LanderSim {
    const L = base.clone(), tPDI = base.plan!.tPDI;
    L.silent = false;
    run(L, (l) => when(l, tPDI));
    if (done(L)) return L; // only the untouched flight gets here
    expect(L.setMode('MANUAL')).toBe(true);
    pilot(L);
    const t0 = L.t;
    while (!done(L) && L.t - t0 < secs) L.advance(0.05);
    L.setInput({ pitch: 0, roll: 0, thr: 0 });
    if (!done(L)) expect(L.setMode('AUTO')).toBe(true);
    run(L, () => false);
    return L;
  }
  const soft = (L: LanderSim) => {
    expect(L.phase, L.reason ?? '').toBe('LANDED');
    expect(L.landing!.hard).toBe(false);
    expect(L.landing!.vv).toBeLessThan(1.5);
    expect(L.landing!.vh).toBeLessThan(0.5);
  };
  /** Metres from the planned site. */
  const off = (L: LanderSim) => Math.hypot(L.landing!.x!, L.landing!.y!);

  it('lands as the untouched flight does after a tap on the controls during the coast', () => {
    const L = fly((l, t) => l.t >= t - 120, 3, (l) => l.setInput({ pitch: 1 }));
    soft(untouched);
    soft(L);
    expect(L.engaged!.choice).toBe('COAST');
    expect(L.landing!.miss!).toBeLessThan(6);
    expect(Math.abs(L.prop - untouched.prop)).toBeLessThan(3);
  });

  it('goes round for another pass when the ignition point went by under manual control', () => {
    const L = fly((l, t) => l.t >= t - 10, 30, () => {}); // 20 s late: the planned braking burn no longer fits
    soft(L);
    expect(L.engaged!.choice).toBe('COAST');
    expect(L.engaged!.tried.map((f) => f.choice)).toContain('RESUME'); // which was flown ahead and found to crash
    expect(L.landing!.miss!).toBeLessThan(6);
    expect(off(L)).toBeLessThan(500);
    expect(L.t - base.plan!.tPDI).toBeGreaterThan(3600);
  });

  it('relights a cut engine in the braking burn and lands on safe ground beyond the site', () => {
    const L = fly((l, t) => l.t >= t + 200, 20, (l) => l.cutEngine());
    soft(L);
    expect(L.engaged!.choice).toBe('DIVERT');
    expect(L.divert).toBe(true);
    expect(off(L)).toBeGreaterThan(5e3); // the site is out of reach, and it does not crash chasing it
    expect(L.landing!.slope!).toBeLessThan(8);
    expect(L.prop).toBeGreaterThan(0);
  });

  it('comes back down softly after being flown up and away in the approach', () => {
    const L = fly((l) => l.phase === 'APPROACH' && l.t - l.tPhase >= 40, 30, (l) => { l.setHold('UP'); l.setThrottle(1); });
    soft(L);
    expect(L.landing!.slope!).toBeLessThan(8);
    expect(off(L)).toBeLessThan(5e3);
  });

  it('recovers from a tilt in the terminal descent', () => {
    const L = fly((l) => l.phase === 'TERMINAL' && l.t - l.tPhase >= 15, 10, (l) => l.setInput({ pitch: 1 }));
    soft(L);
    expect(L.landing!.tilt!).toBeLessThan(12);
    expect(off(L)).toBeLessThan(500);
  });

  it('reports the crash when it is handed back too low and too fast to stop', () => {
    const L = fly((l) => l.phase === 'APPROACH' && l.t - l.tPhase >= 40, 19, (l) => l.cutEngine());
    expect(L.mode).toBe('AUTO');
    expect(L.engaged!.grade).toBe(0);
    expect(L.phase).toBe('CRASHED');
    expect(L.landing!.destroyed).toBe(true);
    expect(L.reason).toMatch(/vertical speed/);
  });
});
