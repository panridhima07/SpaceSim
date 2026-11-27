import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MU_EARTH,
  RE,
  G0,
  deltaVUntil,
  predictCutoff,
  solveSteering,
  thrustAccelAt,
  timeForDeltaV,
  type BurnSegment,
  type PlanarState,
  type SteeringLaw,
} from '../src/index.ts';
import { AscentAutopilot, SITES, Simulation, flyAscent, twoStageKerolox, usablePropellant, type AscentOptions } from '../src/index.ts';
import { falcon9Block5 } from '../src/vehicle/falcon9.ts';
import { pslvXL } from '../src/vehicle/pslv.ts';

const MU = MU_EARTH;

function close(actual: number, expected: number, tol: number, msg = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} actual=${actual} expected=${expected} diff=${actual - expected} tol=${tol}`,
  );
}

function relClose(actual: number, expected: number, tol: number, msg = ''): void {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(rel <= tol, `${msg} actual=${actual} expected=${expected} relErr=${rel} tol=${tol}`);
}

/** The target circular orbit at radius r. */
function circularTarget(r: number): PlanarState {
  return { r, rdot: 0, h: Math.sqrt(MU * r) };
}

/** Miss of the predicted cutoff state against the target, in metres, m/s and m^2/s. */
function assertHitsTarget(state: PlanarState, law: SteeringLaw, segs: BurnSegment[], target: PlanarState): void {
  const p = predictCutoff(state, law, MU, segs);
  assert.ok(Math.abs(p.r - target.r) < 10, `radius miss ${p.r - target.r} m`);
  assert.ok(Math.abs(p.rdot - target.rdot) < 0.1, `radial speed miss ${p.rdot - target.rdot} m/s`);
  assert.ok(Math.abs(p.h - target.h) / target.r < 0.1, `angular momentum miss ${(p.h - target.h) / target.r} m/s`);
}

describe('burn segment bookkeeping', () => {
  const single: BurnSegment[] = [{ start: 0, duration: 40, ve: 3050, tau: 160000 / 2700 }];
  const twoWithGap: BurnSegment[] = [
    { start: 0, duration: 40, ve: 3050, tau: 160000 / 2700 },
    { start: 48, duration: 380, ve: 3413, tau: 121000 / 273.7 },
  ];
  const gapShifted: BurnSegment[] = [
    twoWithGap[0],
    { ...twoWithGap[1], start: 300 },
  ];

  test('deltaVUntil of one segment is -ve ln(1 - d/tau)', () => {
    const d = 25;
    const seg = single[0];
    const expected = -seg.ve * Math.log(1 - d / seg.tau);
    close(deltaVUntil(single, d), expected, 1e-9);
  });

  test('deltaVUntil sums both segments and ignores the gap length', () => {
    const d1 = -twoWithGap[0].ve * Math.log(1 - twoWithGap[0].duration / twoWithGap[0].tau);
    const d2 = -twoWithGap[1].ve * Math.log(1 - 100 / twoWithGap[1].tau);
    close(deltaVUntil(twoWithGap, 148), d1 + d2, 1e-9, 'two segments');
    // The second segment starts at 48 s in one case and at 300 s in the other: once the
    // time limit is past both starts, the delta-v must be the same.
    // Once both burns are over, the delta-v is the same whatever the coast length.
    const dvFull = d1 + -twoWithGap[1].ve * Math.log(1 - 380 / twoWithGap[1].tau);
    close(deltaVUntil(twoWithGap, 428), dvFull, 1e-9, 'both burns complete');
    close(deltaVUntil(gapShifted, 680), dvFull, 1e-9, 'gap insensitivity');
  });

  test('timeForDeltaV inverts deltaVUntil inside the first segment', () => {
    for (const t of [5, 20, 39]) {
      const dv = deltaVUntil(twoWithGap, t);
      close(timeForDeltaV(twoWithGap, dv), t, 1e-6, `t=${t}`);
    }
  });

  test('timeForDeltaV inverts deltaVUntil inside the second segment', () => {
    for (const t of [60, 150, 300, 420]) {
      const dv = deltaVUntil(twoWithGap, t);
      close(timeForDeltaV(twoWithGap, dv), t, 1e-6, `t=${t}`);
    }
  });

  test('thrustAccelAt is ve/(tau - s) inside a burn and zero in the gap and after the end', () => {
    const seg = twoWithGap[0];
    for (const s of [0, 10, 30]) {
      close(thrustAccelAt(twoWithGap, s), seg.ve / (seg.tau - s), 1e-9, `burn s=${s}`);
    }
    const s2 = twoWithGap[1];
    close(thrustAccelAt(twoWithGap, 100), s2.ve / (s2.tau - (100 - s2.start)), 1e-9, 'second burn');
    assert.equal(thrustAccelAt(twoWithGap, 44), 0, 'in the gap');
    assert.equal(thrustAccelAt(twoWithGap, 500), 0, 'after the end');
  });
});

describe('predictCutoff', () => {
  const burn: BurnSegment[] = [{ start: 0, duration: 380, ve: 348 * G0, tau: 121000 / 273.7 }];

  test('zero thrust time returns the input state', () => {
    const r = RE + 120e3;
    const state: PlanarState = { r, rdot: 900, h: r * 2800 };
    const p = predictCutoff(state, { k1: 0.5, k2: -0.001, T: 1e-6 }, MU, burn);
    close(p.r, state.r, 1e-3, 'r');
    // Thrust acts for 1 us: about 8e-6 m/s of change is physical here.
    close(p.rdot, state.rdot, 1e-4, 'rdot');
    // Thrust over 1 us adds about 45 m^2/s to h (a r T): compare relatively.
    relClose(p.h, state.h, 1e-8, 'h');
  });

  test('a pure coast from a circular orbit keeps radius and angular momentum', () => {
    // One segment that starts at t=100, with cutoff at t=100: only the coast is integrated.
    const coast: BurnSegment[] = [{ start: 100, duration: 100, ve: 3000, tau: 100 }];
    const r = RE + 200e3;
    const h = Math.sqrt(MU * r);
    const p = predictCutoff({ r, rdot: 0, h }, { k1: 0, k2: 0, T: 100 }, MU, coast);
    relClose(p.r, r, 1e-6, 'radius');
    close(p.rdot, 0, 1e-3, 'radial speed stays zero');
    relClose(p.h, h, 1e-6, 'angular momentum');
  });

  // Regression: predictCutoff once returned the input state when every burn started after T.
  test('a 10 s radial coast from rest drops by about 0.5 g t^2', () => {
    // Launch-like state at h = 0 and rdot = 0, 100 km up; the burn does not start until t=100.
    const r = RE + 100e3;
    const g = MU / (r * r);
    const later: BurnSegment[] = [{ start: 100, duration: 50, ve: 3000, tau: 100 }];
    const p = predictCutoff({ r, rdot: 0, h: 0 }, { k1: 0, k2: 0, T: 10 }, MU, later);
    const drop = r - p.r;
    relClose(drop, 0.5 * g * 10 * 10, 0.01, 'drop distance');
    relClose(p.rdot, -g * 10, 0.01, 'vertical speed');
  });

  test('a horizontal 5 s burn adds angular momentum of r times delta-v', () => {
    const r = RE + 200e3;
    const h0 = Math.sqrt(MU * r);
    const short: BurnSegment[] = [{ start: 0, duration: 5, ve: 3000, tau: 200 }];
    const dv = deltaVUntil(short, 5);
    const p = predictCutoff({ r, rdot: 0, h: h0 }, { k1: 0, k2: 0, T: 5 }, MU, short);
    relClose(p.h - h0, r * dv, 0.005, 'delta-h');
  });
});

describe('solveSteering: upper stage to a circular orbit', () => {
  const rT = RE + 200e3;
  const target = circularTarget(rT);
  const segs: BurnSegment[] = [{ start: 0, duration: 380, ve: 348 * G0, tau: 121000 / 273.7 }];
  const state: PlanarState = { r: RE + 120e3, rdot: 900, h: (RE + 120e3) * 2800 };
  let first: ReturnType<typeof solveSteering>;

  test('converges, is feasible and predicts a cutoff on the target', () => {
    first = solveSteering(state, target, MU, segs);
    assert.equal(first.converged, true);
    assert.equal(first.feasible, true);
    assert.ok(first.law.T > 250 && first.law.T < 380, `T=${first.law.T}`);
    assertHitsTarget(state, first.law, segs, target);
  });

  test('the initial pitch is between 0 and 45 degrees, and pitch falls with time', () => {
    const pitch0 = Math.atan(first.law.k1);
    assert.ok(pitch0 > 0 && pitch0 < Math.PI / 4, `pitch0=${(pitch0 * 180) / Math.PI} deg`);
    assert.ok(first.law.k2 < 0, `k2=${first.law.k2}`);
  });

  test('a warm start from the previous law converges in at most 2 iterations', () => {
    const again = solveSteering(state, target, MU, segs, first.law);
    assert.equal(again.converged, true);
    assert.ok(again.iterations <= 2, `iterations=${again.iterations}`);
  });

  test('an infeasible 150 s stage is flagged, and its cutoff is the end of the burn', () => {
    const short: BurnSegment[] = [{ start: 0, duration: 150, ve: 348 * G0, tau: 121000 / 273.7 }];
    const sol = solveSteering(state, target, MU, short);
    assert.equal(sol.feasible, false);
    close(sol.law.T, 150, 1e-6, 'cutoff time');
  });
});

describe('solveSteering: two burns with a coast between', () => {
  const rT = RE + 200e3;
  const target = circularTarget(rT);
  const segs: BurnSegment[] = [
    { start: 0, duration: 40, ve: 3050, tau: 160000 / 2700 },
    { start: 48, duration: 380, ve: 3413, tau: 121000 / 273.7 },
  ];
  const state: PlanarState = { r: RE + 60e3, rdot: 1000, h: (RE + 60e3) * 1700 };

  test('converges, predicts the target and cuts off after the coast', () => {
    const sol = solveSteering(state, target, MU, segs);
    assert.equal(sol.converged, true);
    assert.ok(sol.law.T > 48, `T=${sol.law.T}`);
    assertHitsTarget(state, sol.law, segs, target);
  });
});

// ---- target plane and nominal flights ---------------------------------------

/** Set up the autopilot's target plane on the pad (it runs as the vehicle is released) and return it. */
function planeOnPad(site: (typeof SITES)[keyof typeof SITES], inclinationDeg: number): { inclDeg: number; latDeg: number } {
  const opts: AscentOptions = { target: { perigeeAltitude: 200e3, apogeeAltitude: 200e3, inclinationDeg }, pitchKickDeg: 8 };
  const ap = new AscentAutopilot(opts);
  const sim = new Simulation(falcon9Block5(10000), { site, epoch: new Date('2023-02-27T23:13:00Z') }, ap);
  sim.run(60, () => ap.phase !== 'prelaunch');
  assert.equal(ap.phase, 'vertical', 'target plane is set when the vehicle is released');
  const latDeg = (Math.asin(sim.r[2] / Math.hypot(sim.r[0], sim.r[1], sim.r[2])) * 180) / Math.PI;
  return { inclDeg: (Math.acos(ap.planeNormal[2]) * 180) / Math.PI, latDeg };
}

describe('target plane', () => {
  test('Falcon 9 from Cape Canaveral: a 51.6 deg request gives a 51.6 deg plane', () => {
    const { inclDeg } = planeOnPad(SITES.capeCanaveral, 51.6);
    close(inclDeg, 51.6, 0.01, 'plane inclination (deg)');
  });

  test('a retrograde request above 180 deg minus the latitude is clamped, not thrown', () => {
    let res: { inclDeg: number; latDeg: number } | undefined;
    assert.doesNotThrow(() => {
      res = planeOnPad(SITES.capeCanaveral, 170);
    });
    close(res!.inclDeg, 180 - Math.abs(res!.latDeg), 0.01, 'clamped plane inclination (deg)');
  });
});

describe('nominal flights reach their targets without a false out-of-reach warning', () => {
  const flights: [string, () => ReturnType<typeof flyAscent>][] = [
    [
      'PSLV-XL to a 529 km sun-synchronous orbit',
      () =>
        flyAscent(
          pslvXL(1696.24),
          { site: SITES.sriharikota, epoch: new Date('2025-05-18T00:29:00Z') },
          { target: { perigeeAltitude: 529e3, apogeeAltitude: 529e3, inclinationDeg: 97.6, southward: true }, pitchKickDeg: 9 },
          3000,
        ),
    ],
    [
      'Falcon 9 to 365 x 373 km at 43 deg',
      () =>
        flyAscent(
          falcon9Block5(16000),
          { site: SITES.capeCanaveral, epoch: new Date('2023-02-27T23:13:00Z') },
          { target: { perigeeAltitude: 365e3, apogeeAltitude: 373e3, inclinationDeg: 43, southward: true }, pitchKickDeg: 8 },
          3000,
        ),
    ],
  ];
  for (const [name, fly] of flights) {
    test(name, () => {
      const res = fly();
      const bad = res.sim.events.filter((e) => e.message.includes('out of reach'));
      assert.equal(bad.length, 0, `false warning: ${bad.map((e) => e.message).join('; ')}`);
      assert.equal(res.autopilot.reachedTarget, true, 'reachedTarget');
    });
  }
});

describe('closed-loop plan for a solid stage follows its thrust curve', () => {
  test('PS3 segments end with the thrust curve and burn the usable propellant', () => {
    const veh = pslvXL(1696.24);
    const ap = new AscentAutopilot({
      target: { perigeeAltitude: 529e3, apogeeAltitude: 529e3, inclinationDeg: 97.6, southward: true },
      pitchKickDeg: 9,
    });
    const sim = new Simulation(veh, { site: SITES.sriharikota, epoch: new Date('2025-05-18T00:29:00Z') }, ap);
    const ps3 = veh.stages.findIndex((s) => s.name.startsWith('PS3'));
    assert.ok(ps3 >= 0 && veh.stages[ps3].engine.thrustCurve, 'PS3 has a thrust curve');
    // Run until PS3 has been burning for 20 s under closed-loop guidance.
    sim.run(600, () => ap.phase === 'closedLoop' && sim.rt.stages[ps3].engineOn && sim.t - sim.rt.stages[ps3].ignitionTime > 20);
    const st = sim.rt.stages[ps3];
    assert.ok(st.engineOn, 'PS3 is burning');
    const curve = veh.stages[ps3].engine.thrustCurve!;
    const elapsed = sim.t - st.ignitionTime;
    const segs = (ap as unknown as { segments(s: Simulation): BurnSegment[] }).segments(sim);
    assert.ok(segs.length >= 3, `segments ${segs.length}`);
    // The first PS3 segment starts now; the segments that follow PS3 start after its curve ends.
    const ps3Segs: BurnSegment[] = [];
    for (const s of segs) {
      const prev = ps3Segs[ps3Segs.length - 1];
      if (ps3Segs.length === 0 ? s.start < 1e-6 : Math.abs(s.start - (prev.start + prev.duration)) < 1e-6) ps3Segs.push(s);
      else break;
    }
    const end = ps3Segs[ps3Segs.length - 1];
    const curveEnd = curve[curve.length - 1][0] - elapsed;
    close(end.start + end.duration, curveEnd, 1, 'PS3 planned end vs thrust curve end');
    // Propellant of a segment is duration * mass / tau; the mass falls as earlier segments burn.
    let m = sim.diag.mass;
    let planned = 0;
    for (const s of ps3Segs) {
      const p = (s.duration * m) / s.tau;
      planned += p;
      m -= p;
    }
    relClose(planned, usablePropellant(veh, ps3, sim.prop), 0.01, 'planned PS3 propellant vs usable');
  });
});

describe('circularize node away from an apsis', () => {
  const fly = (at: 'apoapsis' | { afterInsertion: number }) =>
    flyAscent(
      twoStageKerolox(12000),
      { site: SITES.sriharikota },
      {
        target: { perigeeAltitude: 200e3, apogeeAltitude: 700e3 },
        pitchKickDeg: 6,
        maxG: 4.5,
        nodes: [{ name: 'Circ', at, deltaV: 'circularize' }],
      },
      9000,
    );

  test('a time-based node removes the radial velocity and circularises at the node radius', () => {
    const res = fly({ afterInsertion: 600 });
    const el = res.sim.elements();
    assert.ok(el.e < 0.003, `eccentricity ${el.e}`);
    const start = res.sim.events.find((e) => e.message.startsWith('Circ start'));
    const done = res.sim.events.find((e) => e.message.startsWith('Circ complete'));
    assert.ok(start && done, 'burn events');
    assert.ok(start.message.includes('fixed direction'), start.message);
    // Radius of the vehicle at the burn midpoint, by two-body propagation from just before the burn.
    const mid = (start.t + done.t) / 2;
    const probe = new Simulation(twoStageKerolox(12000), { site: SITES.sriharikota }, new AscentAutopilot({
      target: { perigeeAltitude: 200e3, apogeeAltitude: 700e3 }, pitchKickDeg: 6, maxG: 4.5,
    }));
    probe.run(mid, () => false);
    const rMid = Math.hypot(probe.r[0], probe.r[1], probe.r[2]);
    close(el.a, rMid, 5e3, 'final orbit radius vs radius at the burn');
    // The old apoapsis-radius formula would have aimed at the 700 km apoapsis instead.
    assert.ok(Math.abs(el.a - (RE + 700e3)) > 20e3, 'not the apoapsis radius');
  });

  test('an apoapsis node still gives the same orbit as before', () => {
    const el = fly('apoapsis').sim.elements();
    close(el.a, 7059887.814, 1, 'semi-major axis');
    close(el.e, 0.000103, 2e-6, 'eccentricity');
  });
});
