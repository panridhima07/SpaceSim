import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEG,
  FLATTENING,
  G0,
  MU_EARTH,
  OMEGA_EARTH,
  RE,
  SITES,
  Simulation,
  debrisImpacts,
  engineOutput,
  flyAscent,
  jetStreamWind,
  lvm3,
  tunePitchKick,
  twoStageKerolox,
  type AscentOptions,
  type FlightEvent,
  type FlightResult,
  type Telemetry,
} from '../src/index.ts';

const SITE = SITES.sriharikota;
const CFG = { site: SITE };
const MAIN_OPTS: AscentOptions = { target: { perigeeAltitude: 200e3 }, pitchKickDeg: 6, maxG: 4.5 };

function close(actual: number, expected: number, tol: number, msg = ''): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} actual=${actual} expected=${expected} diff=${actual - expected} tol=${tol}`);
}

function relClose(actual: number, expected: number, tol: number, msg = ''): void {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(rel <= tol, `${msg} actual=${actual} expected=${expected} relErr=${rel} tol=${tol}`);
}

/** Index of the first event matching pred, or -1. */
function findEvent(events: FlightEvent[], pred: (e: FlightEvent) => boolean): number {
  return events.findIndex(pred);
}

// One ascent to 200 km shared by several checks (about a second to fly).
const main: FlightResult = flyAscent(twoStageKerolox(12000), CFG, MAIN_OPTS);

describe('pad hold', () => {
  const sim = new Simulation(twoStageKerolox(), CFG);

  test('a new vehicle starts held on the pad at the site', () => {
    assert.equal(sim.held, true);
    close(sim.diag.altitude, SITE.altitude ?? 0, 1, 'altitude');
    relClose(sim.diag.speedInertial, OMEGA_EARTH * Math.hypot(sim.r[0], sim.r[1]), 1e-3, 'inertial speed');
    relClose(sim.diag.speedInertial, 452, 0.01, 'inertial speed near 452 m/s');
    close((sim.diag.pitch * 180) / Math.PI, 90, 0.01, 'pitch (nose up)');
  });

  test('the hold-down keeps it on the pad for 10 s, with no change of mass', () => {
    const alt0 = sim.diag.altitude;
    const lat0 = sim.diag.lat;
    const lon0 = sim.diag.lon;
    const mass0 = sim.diag.mass;
    sim.step(10);
    assert.equal(sim.held, true);
    close(sim.diag.altitude, alt0, 1, 'altitude');
    close(sim.diag.lat, SITE.latDeg * DEG, 1e-6, 'latitude vs site');
    close(sim.diag.lon, SITE.lonDeg * DEG, 1e-6, 'longitude vs site');
    close(sim.diag.lat, lat0, 1e-6, 'latitude unchanged');
    close(sim.diag.lon, lon0, 1e-6, 'longitude unchanged');
    assert.equal(sim.diag.mass, mass0);
  });
});

describe('engine start on the pad', () => {
  test('ignition on the pad gives sea-level thrust and burns propellant, and the vehicle stays held', () => {
    const sim = new Simulation(twoStageKerolox(), CFG);
    const mass0 = sim.diag.mass;
    sim.ignite(0);
    sim.step(5);
    const seaLevelThrust = 9 * 914e3 * (282 / 311);
    relClose(sim.diag.thrust, seaLevelThrust, 0.02, 'thrust on the pad');
    const expectedFlow = (9 * 914e3) / (G0 * 311);
    relClose(mass0 - sim.diag.mass, expectedFlow * 5, 0.15, 'propellant burned in 5 s');
    assert.equal(sim.held, true);

    const alt0 = sim.diag.altitude;
    sim.release();
    sim.step(5);
    assert.ok(sim.diag.altitude > alt0, `altitude ${sim.diag.altitude} did not increase from ${alt0}`);
    assert.ok(Number.isFinite(sim.liftoffTime));
    assert.ok(sim.events.some((e) => e.type === 'liftoff'), 'no liftoff event');
  });
});

describe('full autopilot ascent to 200 km', () => {
  test('reaches the target orbit', () => {
    assert.equal(main.reachedTarget, true);
  });

  test('perigee and apogee are within 3 km of 200 km', () => {
    close(main.perigeeAltitude, 200e3, 3e3, 'perigee');
    close(main.apogeeAltitude, 200e3, 3e3, 'apogee');
  });

  test('inclination matches the geocentric latitude of the site', () => {
    const geocentric = Math.atan(Math.pow(1 - FLATTENING, 2) * Math.tan(SITE.latDeg * DEG)) / DEG;
    close(main.inclinationDeg, geocentric, 0.1, 'inclination');
    close(geocentric, 13.63, 0.01, 'geocentric latitude');
  });

  test('events occur in the expected order', () => {
    const ev = main.sim.events;
    const steps: [string, (e: FlightEvent) => boolean][] = [
      ['ignition', (e) => e.type === 'ignition'],
      ['liftoff', (e) => e.type === 'liftoff'],
      ['Pitch-over', (e) => e.message === 'Pitch-over'],
      ['Gravity turn', (e) => e.message === 'Gravity turn'],
      ['Closed-loop guidance', (e) => e.message === 'Closed-loop guidance'],
      ['Stage 1 burnout', (e) => e.type === 'burnout' && e.message.includes('Stage 1')],
      ['Stage 1 separation', (e) => e.type === 'separation' && e.message.includes('Stage 1')],
      ['Stage 2 ignition', (e) => e.type === 'ignition' && e.message.includes('Stage 2')],
      ['fairing jettison', (e) => e.type === 'fairing'],
      ['cutoff', (e) => e.type === 'cutoff'],
      ['orbit insertion', (e) => e.type === 'orbit'],
    ];
    let last = -1;
    for (const [name, pred] of steps) {
      const i = findEvent(ev, (e) => pred(e));
      assert.ok(i >= 0, `missing event: ${name}`);
      assert.ok(i > last, `event out of order: ${name} at index ${i}, previous at ${last}`);
      last = i;
    }
  });

  test('max Q, its altitude and its time are in the expected band', () => {
    const { sim } = main;
    const qkPa = sim.maxQ.value / 1000;
    assert.ok(qkPa >= 25 && qkPa <= 45, `max Q ${qkPa} kPa`);
    assert.ok(sim.maxQ.altitude >= 8e3 && sim.maxQ.altitude <= 16e3, `max Q altitude ${sim.maxQ.altitude}`);
    const tQ = sim.maxQ.t - sim.liftoffTime;
    assert.ok(tQ >= 50 && tQ <= 90, `max Q at T+${tQ}`);
  });

  test('max g does not exceed the limit by more than 3 %', () => {
    assert.ok(main.sim.maxG.value <= 4.5 * 1.03, `max g ${main.sim.maxG.value}`);
  });

  test('total delta-v spent is between 8800 and 9700 m/s', () => {
    const dv = main.sim.dvExpended;
    assert.ok(dv >= 8800 && dv <= 9700, `dv ${dv}`);
  });

  test('propellant margin is positive', () => {
    assert.ok(main.propellantMargin > 0, `margin ${main.propellantMargin}`);
  });

  test('telemetry is non-empty, time ordered, non-negative altitude after liftoff, and mass non-increasing', () => {
    const { sim } = main;
    const log = sim.log;
    assert.ok(log.length > 0);
    for (let i = 1; i < log.length; i++) {
      assert.ok(log[i].t >= log[i - 1].t, `log not time ordered at ${i}`);
      assert.ok(log[i].mass <= log[i - 1].mass + 1e-9, `mass increased at ${i}: ${log[i - 1].mass} -> ${log[i].mass}`);
    }
    for (const e of log) {
      if (e.t >= sim.liftoffTime) assert.ok(e.altitude >= 0, `negative altitude ${e.altitude} at t=${e.t}`);
    }
  });

  test('final mass is payload plus stage 2 dry mass plus its remaining propellant', () => {
    const { sim } = main;
    const payload = twoStageKerolox(12000).payload.mass;
    const stage2 = twoStageKerolox(12000).stages[1];
    const remaining = sim.prop.slice(2).reduce((a, b) => a + b, 0);
    close(sim.diag.mass, payload + stage2.dryMass + remaining, 1, 'final mass');
  });

  test('stage 1 and the fairing are left behind as debris', () => {
    const names = main.sim.debris.map((d) => d.name);
    assert.ok(names.includes('Stage 1'), `debris: ${names}`);
    assert.ok(names.includes('Fairing'), `debris: ${names}`);
  });
});

describe('angle of attack in dense air', () => {
  test('|alpha| stays under 3 deg wherever q exceeds 10 kPa', () => {
    const dense = main.sim.log.filter((e: Telemetry) => e.q > 10e3);
    assert.ok(dense.length > 0, 'no dense-air samples');
    for (const e of dense) assert.ok(Math.abs(e.alphaDeg) < 3, `alpha ${e.alphaDeg} deg at t=${e.t}`);
  });
});

describe('the insertion orbit is real', () => {
  test('one unpowered orbit stays between 150 and 260 km and conserves energy to 1e-4', () => {
    const f = flyAscent(twoStageKerolox(12000), CFG, MAIN_OPTS);
    const ins = f.autopilot.insertionTime;
    const energy = (sim: Simulation): number => {
      const rr = Math.hypot(sim.r[0], sim.r[1], sim.r[2]);
      return (sim.v[0] ** 2 + sim.v[1] ** 2 + sim.v[2] ** 2) / 2 - MU_EARTH / rr;
    };
    const e0 = energy(f.sim);
    const logLen = f.sim.log.length;
    f.sim.step(5400);
    const after = f.sim.log.slice(logLen).filter((e) => e.t >= ins);
    assert.ok(after.length > 0, 'no telemetry after insertion');
    for (const e of after) {
      assert.ok(e.altitude > 150e3 && e.altitude < 260e3, `altitude ${e.altitude} at t=${e.t}`);
    }
    const e1 = energy(f.sim);
    relClose(e1, e0, 1e-4, 'specific orbital energy');
  });
});

describe('mission with a circularisation burn', () => {
  const mission = flyAscent(
    twoStageKerolox(12000),
    CFG,
    {
      target: { perigeeAltitude: 200e3, apogeeAltitude: 600e3 },
      pitchKickDeg: 6,
      maxG: 4.5,
      nodes: [{ name: 'Circularisation', at: 'apoapsis', deltaV: 'circularize' }],
    },
    9000,
  );

  test('insertion event reports a 200.0 x 600.0 km orbit', () => {
    const ins = mission.sim.events.find((e) => e.type === 'orbit');
    assert.ok(ins, 'no orbit insertion event');
    assert.ok(ins.message.includes('200.0 x 600.0'), ins.message);
  });

  test('final orbit is circular and near 600 km at both apsides', () => {
    const el = mission.sim.elements();
    assert.ok(el.e < 0.002, `eccentricity ${el.e}`);
    assert.ok(mission.perigeeAltitude >= 560e3 && mission.perigeeAltitude <= 610e3, `perigee ${mission.perigeeAltitude}`);
    assert.ok(mission.apogeeAltitude >= 560e3 && mission.apogeeAltitude <= 610e3, `apogee ${mission.apogeeAltitude}`);
  });

  test('stage 2 used two ignitions', () => {
    assert.equal(mission.sim.rt.stages[1].ignitionsUsed, 2);
  });

  test('circularisation delta-v is within 15 % of the vis-viva value', () => {
    const rA = RE + 600e3;
    const a = RE + 400e3;
    const expected = Math.sqrt(MU_EARTH / rA) - Math.sqrt(MU_EARTH * (2 / rA - 1 / a));
    const start = mission.sim.events.find((e) => e.type === 'burn' && e.message.includes('Circularisation start'));
    assert.ok(start, 'no circularisation burn start event');
    const m = /start: ([\d.]+) m\/s/.exec(start.message);
    assert.ok(m, start.message);
    relClose(Number(m[1]), expected, 0.15, `burn dv (expected ${expected.toFixed(1)} m/s)`);
  });
});

describe('LVM3 to a Chandrayaan-3 transfer orbit', () => {
  const lv = flyAscent(lvm3(), CFG, { target: { perigeeAltitude: 170e3, apogeeAltitude: 36500e3 }, pitchKickDeg: 8 }, 3000);
  const L = lv.sim.liftoffTime;

  test('reaches the transfer orbit within tolerance', () => {
    assert.equal(lv.reachedTarget, true);
    close(lv.perigeeAltitude, 170e3, 3e3, 'perigee');
    close(lv.apogeeAltitude, 36500e3, 300e3, 'apogee');
  });

  test('L110 core ignites at T+108 s', () => {
    const e = lv.sim.events.find((x) => x.type === 'ignition' && x.message.includes('L110 core'));
    assert.ok(e, 'no L110 core ignition');
    close(e.t - L, 108, 0.5, 'L110 core ignition time');
  });

  test('boosters separate between T+120 and T+135 s', () => {
    const e = lv.sim.events.find((x) => x.type === 'separation' && x.message.includes('S200'));
    assert.ok(e, 'no booster separation');
    const tb = e.t - L;
    assert.ok(tb >= 120 && tb <= 135, `booster separation at T+${tb}`);
  });

  test('final cutoff is between T+900 and T+1000 s', () => {
    const cutoffs = lv.sim.events.filter((x) => x.type === 'cutoff');
    assert.ok(cutoffs.length > 0, 'no cutoff event');
    const tc = cutoffs[cutoffs.length - 1].t - L;
    assert.ok(tc >= 900 && tc <= 1000, `final cutoff at T+${tc}`);
  });

  test('liftoff mass is between 630 and 645 t', () => {
    const m = lv.sim.log[0].mass;
    assert.ok(m >= 630e3 && m <= 645e3, `liftoff mass ${m} kg`);
  });
});

describe('overloaded rockets', () => {
  test('an overloaded launcher does not reach the target and does not throw', () => {
    const res = flyAscent(twoStageKerolox(60000), CFG, MAIN_OPTS);
    assert.equal(res.reachedTarget, false);
  });

  test('a launcher whose thrust is below its weight aborts on the pad', () => {
    const res = flyAscent(twoStageKerolox(400000), CFG, MAIN_OPTS);
    assert.ok(res.sim.events.some((e) => e.type === 'abort'), 'no abort event');
    assert.equal(res.sim.held, true);
  });
});

describe('manual flight without an autopilot', () => {
  test('vertical climb then a throttle-down, with the thrust in the expected window', () => {
    const sim = new Simulation(twoStageKerolox(), CFG);
    sim.stage();
    sim.step(4);
    sim.release();
    sim.cmd.attitude = sim.diag.up;
    sim.cmd.throttle = 1;
    sim.step(20);
    assert.ok(sim.diag.altitude > 500, `altitude ${sim.diag.altitude}`);
    assert.ok((sim.diag.pitch * 180) / Math.PI > 89, `pitch ${(sim.diag.pitch * 180) / Math.PI}`);
    assert.ok(sim.diag.verticalSpeed > 50, `vertical speed ${sim.diag.verticalSpeed}`);

    const before = sim.diag.thrust;
    sim.cmd.throttle = 0.6;
    sim.step(5);
    const ratio = sim.diag.thrust / before;
    assert.ok(ratio >= 0.5 && ratio <= 0.66, `thrust ratio ${ratio}`);
    // Compare with the engine model at 60 % throttle and the current back-pressure.
    const e = twoStageKerolox().stages[0].engine;
    const expected = 9 * engineOutput(e, 0.6, sim.diag.pressure).thrust;
    relClose(sim.diag.thrust, expected, 0.03, 'thrust at 60 % throttle');
  });
});

describe('determinism', () => {
  test('two identical flights end in bit-identical positions', () => {
    const a = flyAscent(twoStageKerolox(12000), CFG, MAIN_OPTS);
    const b = flyAscent(twoStageKerolox(12000), CFG, MAIN_OPTS);
    assert.deepStrictEqual(a.sim.r, b.sim.r);
  });
});

describe('wind', () => {
  test('a 60 m/s jet stream does not stop the flight reaching orbit, and alpha stays small low down', () => {
    const wind = jetStreamWind({ jetSpeed: 60, towardDeg: 180 });
    const res = flyAscent(twoStageKerolox(12000), { site: SITE, wind }, MAIN_OPTS);
    assert.equal(res.reachedTarget, true);
    // Two transients are expected and excluded. The vertical rise (to the gravity-turn event)
    // is commanded vertical while the surface wind sets the air-relative direction: alpha is
    // about 10 deg at q near 1 kPa and 90 deg at liftoff. Gravity-turn onset also lags the air
    // flow for about a second (5.7 deg at T+19 s). Once the turn is established (3 s after
    // the event) the nose follows the air-relative velocity, so the bound is checked from there.
    const gt = res.sim.events.find((e) => e.message === 'Gravity turn');
    assert.ok(gt, 'no gravity turn event');
    const low = res.sim.log.filter((e) => e.altitude < 20e3 && e.t >= gt.t + 3);
    assert.ok(low.length > 0, 'no low-altitude samples');
    const maxAlpha = Math.max(...low.map((e) => Math.abs(e.alphaDeg)));
    assert.ok(maxAlpha < 5, `max alpha below 20 km ${maxAlpha} deg`);
  });
});

describe('pitch-kick tuning and debris', () => {
  const kick3 = flyAscent(twoStageKerolox(12000), CFG, { ...MAIN_OPTS, pitchKickDeg: 3, nodes: [] });

  test('tunePitchKick returns a kick in [3, 9] that beats a 3 deg kick on propellant', () => {
    const tuned = tunePitchKick(twoStageKerolox(12000), CFG, { ...MAIN_OPTS, nodes: [] }, [3, 9], 4);
    assert.ok(tuned.pitchKickDeg >= 3 && tuned.pitchKickDeg <= 9, `kick ${tuned.pitchKickDeg}`);
    assert.equal(tuned.result.reachedTarget, true);
    assert.ok(
      tuned.result.propellantMargin >= kick3.propellantMargin,
      `margin ${tuned.result.propellantMargin} < ${kick3.propellantMargin} at 3 deg`,
    );
  });

  test('stage 1 of the 3 deg flight comes down east of the pad, near the site latitude', () => {
    const hits = debrisImpacts(kick3.sim);
    const s1 = hits.find((h) => h.name === 'Stage 1');
    assert.ok(s1, 'no Stage 1 impact');
    assert.ok(s1.lonDeg > 80.23 && s1.lonDeg < 95, `Stage 1 lon ${s1.lonDeg}`);
    assert.ok(Math.abs(s1.latDeg - 13.7) < 2, `Stage 1 lat ${s1.latDeg}`);
  });
});

describe('oblateness-compensated targeting', () => {
  // Same 200 x 600 km target flown twice. Osculating targeting meets 600 km on paper at cutoff
  // but J2 pulls the real apogee lower; the compensated cutoff reaches the requested altitude.
  const peak = (compensate: boolean): { reached: boolean; top: number; quoted: number } => {
    const res = flyAscent(twoStageKerolox(12000), CFG, {
      target: { perigeeAltitude: 200e3, apogeeAltitude: 600e3, compensateOblateness: compensate },
      pitchKickDeg: 6,
      maxG: 4.5,
    });
    const quoted = res.apogeeAltitude;
    const start = res.sim.log.length;
    res.sim.step(4000); // past the first apogee, unpowered
    let top = -Infinity;
    for (const row of res.sim.log.slice(start)) top = Math.max(top, row.altitude + 0); // geodetic altitude
    // Compare like with like: radius above the equatorial radius, as the target is defined.
    return { reached: res.reachedTarget, top, quoted };
  };
  const plain = peak(false);
  const fixed = peak(true);

  test('osculating targeting quotes 600 km at cutoff', () => {
    assert.ok(plain.reached);
    close(plain.quoted, 600e3, 1e3, 'osculating apogee at cutoff');
  });
  test('compensated cutoff aims higher on paper and flies higher in fact', () => {
    assert.ok(fixed.reached);
    assert.ok(fixed.quoted > plain.quoted + 10e3, `quoted ${fixed.quoted} vs ${plain.quoted}`);
    assert.ok(fixed.top > plain.top + 10e3, `flown ${fixed.top} vs ${plain.top}`);
  });
  test('the compensated flight tops out within 3 km of the 600 km target radius', () => {
    const res = flyAscent(twoStageKerolox(12000), CFG, {
      target: { perigeeAltitude: 200e3, apogeeAltitude: 600e3, compensateOblateness: true },
      pitchKickDeg: 6,
      maxG: 4.5,
    });
    let rMax = 0;
    const sim = res.sim;
    for (let i = 0; i < 400; i++) {
      sim.step(10);
      rMax = Math.max(rMax, Math.hypot(sim.r[0], sim.r[1], sim.r[2]));
    }
    close(rMax - RE, 600e3, 3e3, 'apogee radius above the equatorial radius');
  });
});
