// Lunar landing tests, adapted from the ASTRA Spaceflight prototype's terrain, navigation and
// lander suites. They fly the real lander physics against the app's own Moon ephemeris.
import { beforeAll, describe, expect, it } from 'vitest';
import { julianDate } from '../world/ephemeris';
import * as P from './core';
import { LANDER_ENGINE as E, LANDER_SPECS } from './core';
import { LD, LanderSim, qFromY, qrot } from './lander';
import { createMoonEphemeris } from './moonEphemeris';
import { MODES, RouteFollower, planAll, planRoute, type Route } from './nav';
import { HazardMap, R_MOON, Terrain, fmtLatLon, llToMF, mfToLL, pickTargets, regionAt, siteBasis } from './terrain';

const DEG = Math.PI / 180;
const MU = P.MU_M;
const ve = E.isp * P.G0;
const eph = createMoonEphemeris(julianDate(new Date('2023-08-23T00:00:00Z'))); // Chandrayaan-3 landing day
const spec = LANDER_SPECS.lander;

/** Circular lunar orbit state in the ephemeris frame. */
function lunarOrbit({ t0 = 3.2 * 86400, alt = 100e3, rh = P.unit([0.55, 0.35, 0.76]) } = {}) {
  const rm = eph.moonAt(t0), vm = eph.moonVelAt(t0);
  const nrm = P.unit(P.cross(rh, [0, 0, 1])), vh = P.unit(P.cross(nrm, rh)), R = R_MOON + alt;
  return { t: t0, r: P.add(rm, P.scale(rh, R)), v: P.add(vm, P.scale(vh, Math.sqrt(MU / R))), a: vh };
}
function run(L: LanderSim, until: (l: LanderSim) => boolean, step = 0.5, max = 200000): void {
  let n = 0;
  while (!until(L) && n++ < max) L.advance(L.phase === 'COAST' && L.mode === 'AUTO' ? Math.min(L.maxWarp() * 0.1, 20) : step);
}
const done = (l: LanderSim) => l.phase === 'LANDED' || l.phase === 'CRASHED';

describe('lunar terrain', () => {
  const terrain = new Terrain({ seed: 4242, mare: true });
  const map = new HazardMap(terrain);

  it('is deterministic for a seed and differs between seeds', () => {
    const again = new Terrain({ seed: 4242, mare: true });
    const other = new Terrain({ seed: 4243, mare: true });
    expect(again.height(123.4, -56.7)).toBe(terrain.height(123.4, -56.7));
    expect(again.rocks.length).toBe(terrain.rocks.length);
    expect(other.height(123.4, -56.7)).not.toBe(terrain.height(123.4, -56.7));
  });

  it('makes highlands rougher and more cratered than mare', () => {
    const highland = new Terrain({ seed: 4242, mare: false });
    expect(highland.craters.length).toBeGreaterThan(terrain.craters.length * 2);
    expect(highland.rocks.length).toBeGreaterThan(terrain.rocks.length);
  });

  it('adds boulders on top of the bare surface', () => {
    const [x, y, r] = terrain.rocks[0];
    expect(terrain.ground(x, y) - terrain.height(x, y)).toBeCloseTo(0.8 * r, 6);
  });

  it('returns a unit surface normal that points up', () => {
    const n = terrain.normal(50, 80);
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 9);
    expect(n[2]).toBeGreaterThan(0.5);
  });

  it('names regions and formats coordinates', () => {
    expect(regionAt(8.5, 31.4)).toEqual({ name: 'Mare Tranquillitatis', mare: true });
    expect(regionAt(-69.4, 32.3).name).toBe('South polar region'); // Chandrayaan-3 site
    expect(fmtLatLon(-69.37, 32.35)).toBe('69.37°S 32.35°E');
  });

  it('round-trips latitude and longitude through the Moon-fixed frame', () => {
    const ll = mfToLL(llToMF(-0.3, 1.1));
    expect(ll.lat).toBeCloseTo(-0.3, 12);
    expect(ll.lon).toBeCloseTo(1.1, 12);
    const { U, E: east, N } = siteBasis(-0.3, 1.1);
    expect(P.dot(U, east)).toBeCloseTo(0, 12);
    expect(P.norm(P.sub(P.cross(east, N), U))).toBeLessThan(1e-12);
  });

  it('builds a hazard map consistent with the terrain', () => {
    expect(map.n).toBe(480);
    const k = map.idx(101, -77);
    expect(map.h[k]).toBeCloseTo(terrain.height(map.cx(map.ix(101)), map.cy(map.iy(-77))), 3);
    expect(map.idx(1e6, 0)).toBe(-1);
    let blocked = 0, safe = 0;
    for (let i = 0; i < map.block.length; i++) {
      blocked += map.block[i];
      if (map.hzFoot[i] === 0) safe++;
      expect(map.hzFoot[i]).toBeGreaterThanOrEqual(map.hz[i]);
    }
    expect(blocked).toBeGreaterThan(0);
    expect(safe).toBeGreaterThan(0);
  });

  it('finds a safe landing spot whose whole footprint is clear', () => {
    const spot = map.safeSpot(0, 0)!;
    expect(spot).not.toBeNull();
    expect(map.hzFoot[map.idx(spot[0], spot[1])]).toBe(0);
  });

  it('picks three reachable science targets', () => {
    const targets = pickTargets(map, terrain);
    expect(targets.map((t) => t.id)).toEqual(['ALPHA', 'BRAVO', 'CHARLIE']);
    for (const t of targets) expect(map.block[map.idx(t.x, t.y)]).toBe(0);
  });

  describe('rover route planner', () => {
    const start = map.nearest(0, 0, (k) => !map.block[k])!;
    const goal = pickTargets(map, terrain)[0];
    const routes = planAll(map, start, [goal.x, goal.y]);
    const ok = routes.filter((r): r is Extract<Route, { ok: true }> => r.ok);

    it('finds a route in every mode', () => {
      expect(routes.map((r) => r.mode)).toEqual(MODES);
      expect(ok.length).toBe(3);
    });

    it('never crosses an impassable cell and ends at the goal', () => {
      for (const r of ok) {
        const follower = new RouteFollower(r.pts);
        for (let s = 0; s <= follower.total; s += 1) {
          const p = follower.at(s);
          expect(map.block[map.idx(p.x, p.y)]).toBe(0);
        }
        const end = r.pts[r.pts.length - 1];
        expect(Math.hypot(end[0] - goal.x, end[1] - goal.y)).toBeLessThan(45);
        expect(r.length).toBeCloseTo(follower.total, 0);
      }
    });

    it('trades distance for safety across the modes', () => {
      const [shortest, , safest] = ok;
      const straight = Math.hypot(goal.x - start[0], goal.y - start[1]);
      expect(shortest.length).toBeGreaterThanOrEqual(straight - 4);
      expect(shortest.length).toBeLessThanOrEqual(safest.length + 1e-6);
      expect(safest.risk).toBeLessThanOrEqual(shortest.risk + 1e-6);
      expect(shortest.energyWh).toBeGreaterThan(0);
      expect(shortest.time).toBeGreaterThan(shortest.length / 3.0 - 1e-6); // never faster than nominal speed
    });

    it('reports a goal outside the map', () => {
      const r = planRoute(map, start, [5000, 0]);
      expect(r.ok).toBe(false);
    });
  });
});

describe('lunar lander', () => {
  let L: LanderSim;
  const phases: string[] = [];
  let tPDI = 0;
  let dvDeorbit = 0;
  let periAfterBurn = 0;

  beforeAll(() => {
    L = new LanderSim(eph, lunarOrbit(), spec);
    run(L, (l) => l.phase === 'COAST');
    dvDeorbit = L.dvUsed;
    periAfterBurn = L.periAlt();
    tPDI = L.plan!.tPDI;
    const seen = new Set<string>();
    run(L, (l) => {
      if (!seen.has(l.phase)) { seen.add(l.phase); phases.push(l.phase); }
      return done(l);
    }, 0.05);
  }, 120_000);

  it('starts with the rocket-equation delta-v and refuses manual control before the deorbit burn', () => {
    const fresh = new LanderSim(eph, lunarOrbit(), spec);
    expect(fresh.mass).toBeCloseTo(spec.payloadMass, 9);
    expect(fresh.dvLeft()).toBeCloseTo(ve * Math.log(fresh.mass / fresh.dry), 6);
    expect(fresh.dvLeft()).toBeGreaterThan(2000);
    expect(fresh.setMode('MANUAL')).toBe(false);
  });

  it('deorbits into a 15 km perilune with a near-ideal burn', () => {
    const rA = R_MOON + 100e3, rP = R_MOON + 15e3;
    const ideal = Math.sqrt(MU / rA) - Math.sqrt(MU * (2 / rA - 2 / (rA + rP)));
    expect(Math.abs(periAfterBurn - 15e3)).toBeLessThan(400);
    expect(Math.abs(dvDeorbit - ideal)).toBeLessThan(4);
  });

  it('picks a landing site with terrain, a hazard map and science targets', () => {
    expect(L.site!.name.length).toBeGreaterThan(0);
    expect(L.site!.appr[0] ** 2 + L.site!.appr[1] ** 2).toBeCloseTo(1, 9);
    expect(L.targets!.length).toBe(3);
  });

  it('lands softly on autopilot through every descent phase', () => {
    expect(L.phase, L.reason ?? '').toBe('LANDED');
    expect(phases.join('>')).toBe('COAST>BRAKE>APPROACH>TERMINAL>LANDED');
    const g = L.landing!;
    expect(g.vv).toBeLessThan(1.0);
    expect(g.vh).toBeLessThan(0.5);
    expect(g.tilt!).toBeLessThan(12);
    expect(g.miss!).toBeLessThan(6);
    expect(g.score!).toBeGreaterThanOrEqual(75);
    expect(L.t - tPDI).toBeGreaterThan(520);
    expect(L.t - tPDI).toBeLessThan(900);
  });

  it('uses propellant consistently with the delta-v flown', () => {
    expect(L.prop).toBeGreaterThan(0);
    expect(L.prop).toBeLessThan(L.prop0);
    expect(Math.abs(L.dvUsed - ve * Math.log((L.dry + L.prop0) / L.mass)) / L.dvUsed).toBeLessThan(0.05);
  });

  it('calls out the descent milestones in order', () => {
    const txt = L.events.map((e) => e.text).join(' | ');
    const order = ['POWERED DESCENT INITIATED', 'HIGH GATE', 'LOW GATE', 'TOUCHDOWN'].map((k) => txt.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('stays fixed to the rotating Moon after touchdown', () => {
    const m1 = L.toMF(L.r);
    L.advance(900);
    const m2 = L.toMF(L.r);
    expect(Math.hypot(m2[0] - m1[0], m2[1] - m1[1], m2[2] - m1[2])).toBeLessThan(1e-6);
    expect(P.norm(L.vrel())).toBeLessThan(1e-3);
    expect(Math.abs(P.norm(L.r) - R_MOON)).toBeLessThan(600);
  });

  describe('from a descent orbit', () => {
    let base: LanderSim;
    beforeAll(() => {
      base = new LanderSim(eph, lunarOrbit({ t0: 4 * 86400 }), spec);
      run(base, (l) => l.phase === 'COAST');
    }, 60_000);

    /** Lander hovering h metres above the site in MANUAL terminal descent. */
    function injected(h: number): LanderSim {
      const a = base.clone();
      a.silent = false;
      const r = a.inertialAt(0, 0, a.terrain!.ground(0, 0) + LD.CGH + h);
      a.r = r; a.v = P.cross(a.W, r); a.q = qFromY(P.unit(r), a.basis().E); a.w = [0, 0, 0];
      a.phase = 'TERMINAL'; a.mode = 'MANUAL'; a.engine = true; a.thr = 0.3; a.cmdThr = 0.3; a.level = 0.3;
      a.tgt = [0, 0]; a.hda = true; a.dCmd = null; a.plan!.tPDI = a.t - 1;
      return a;
    }
    const cut = (a: LanderSim) => { a.hold = null; a.level = 0; a.cmdThr = 0; a.engine = false; a.thr = 0; };

    it('conserves energy and angular momentum while coasting', () => {
      const c = base.clone();
      const e0 = 0.5 * P.norm(c.v) ** 2 - MU / P.norm(c.r), h0 = P.norm(P.cross(c.r, c.v));
      c.advance(1500);
      const e1 = 0.5 * P.norm(c.v) ** 2 - MU / P.norm(c.r), h1 = P.norm(P.cross(c.r, c.v));
      expect(Math.abs(e1 - e0) / Math.abs(e0)).toBeLessThan(1e-8);
      expect(Math.abs(h1 - h0) / h0).toBeLessThan(1e-8);
    });

    it('restores a saved lander that then follows the original exactly', () => {
      const a = base.clone();
      const b = LanderSim.restore(eph, a.save(), a);
      a.advance(2000); b.advance(2000);
      expect(P.norm(P.sub(a.r, b.r))).toBeLessThan(1e-6);
      expect(b.phase).toBe(a.phase);
    });

    it('lands under a scripted manual pilot', () => {
      const a = injected(450);
      a.setHold('UP');
      let n = 0;
      while (!done(a) && n++ < 20000) {
        const tl = a.telemetry();
        const vzc = -Math.min(5, Math.max(0.5, 0.5 + 0.034 * (tl.agl ?? 0)));
        const g = MU / P.norm(a.r) ** 2;
        a.setThrottle(P.clamp(((g + 1.2 * (vzc - tl.vv)) * a.mass) / E.tMax, 0.2, 1));
        a.advance(0.05);
      }
      expect(a.phase).toBe('LANDED');
      expect(a.landing!.vv).toBeLessThan(1.5);
      expect(a.mode).toBe('MANUAL');
    });

    it('limits manual pitch rate and holds retrograde on request', () => {
      const a = injected(20000);
      cut(a);
      a.setInput({ pitch: 1 });
      for (let i = 0; i < 60; i++) a.advance(0.05);
      expect(Math.abs(P.norm(a.w) - LD.W_MAN)).toBeLessThan(0.01);

      const b = injected(3000);
      cut(b);
      b.v = P.add(b.v, P.scale(b.basis().E, 40));
      b.setHold('RETRO');
      for (let i = 0; i < 600; i++) b.advance(0.05);
      const err = Math.acos(P.clamp(P.dot(qrot(b.q, [0, 1, 0]), P.scale(P.unit(b.vrel()), -1)), -1, 1)) / DEG;
      expect(err).toBeLessThan(3);
    });

    it('burns propellant at F / (Isp g0) and flames out when empty', () => {
      const a = injected(20000);
      a.setHold('UP'); a.setThrottle(1);
      const p0 = a.prop;
      for (let i = 0; i < 200; i++) a.advance(0.05);
      const expected = (E.tMax / ve) * 10;
      expect(Math.abs(p0 - a.prop - expected) / expected).toBeLessThan(0.02);

      const z = injected(20000);
      z.setHold('UP'); z.prop = 0.5; z.mass = z.dry + 0.5; z.setThrottle(1);
      for (let i = 0; i < 100; i++) z.advance(0.05);
      expect(z.prop).toBe(0);
      expect(z.engine).toBe(false);
      expect(z.events.some((e) => /DEPLETED/.test(e.text))).toBe(true);
    });

    it('detects a free-fall crash at the speed gravity predicts', () => {
      const a = injected(300);
      cut(a);
      let n = 0;
      while (!done(a) && n++ < 4000) a.advance(0.05);
      expect(a.phase).toBe('CRASHED');
      expect(a.reason).toMatch(/vertical speed/);
      const expected = Math.sqrt(2 * (MU / R_MOON ** 2) * 300);
      expect(Math.abs(a.landing!.vv - expected) / expected).toBeLessThan(0.08);
    });

    it('destroys a lander that touches down drifting sideways', () => {
      const a = injected(60);
      a.setHold('UP');
      a.v = P.add(a.v, P.scale(a.basis().E, 6));
      let n = 0;
      while (!done(a) && n++ < 4000) {
        const tl = a.telemetry();
        a.setThrottle(P.clamp(((MU / P.norm(a.r) ** 2 + 1.2 * (-1 - tl.vv)) * a.mass) / E.tMax, 0.2, 1));
        a.advance(0.05);
      }
      expect(a.phase).toBe('CRASHED');
      expect(a.reason).toMatch(/horizontal/);
    });
  });

  it('crashes, rather than landing, when under-fuelled', () => {
    const a = new LanderSim(eph, lunarOrbit({ t0: 6 * 86400 }), { payloadMass: spec.payloadMass - spec.landerProp + 1300, landerProp: 1300 });
    run(a, (l) => l.phase === 'COAST');
    run(a, done, 0.05);
    expect(a.phase).toBe('CRASHED');
  }, 120_000);
});
