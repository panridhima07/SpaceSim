import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { G0 } from '../src/constants.ts';
import { initialPropellant, initialRuntime, tankOffsets, type EngineSpec, type StageSpec, type TankSpec, type VehicleSpec } from '../src/vehicle/types.ts';
import { deltaVBudget, massProperties, stackLayout, stageMass, usablePropellant } from '../src/vehicle/massprops.ts';
import { pslvXL } from '../src/vehicle/pslv.ts';
import { aeroForces, aeroGeometry, freeMolecularHeatFlux, interpolate, stagnationHeatFlux } from '../src/aero/aero.ts';

// ---- helpers ---------------------------------------------------------------

function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

function assertRel(actual: number, expected: number, tol: number, msg = ''): void {
  assert.ok(relErr(actual, expected) <= tol, `${msg} actual=${actual} expected=${expected} relErr=${relErr(actual, expected)}`);
}

const engine = (thrustVac: number, ispVac: number, extra: Partial<EngineSpec> = {}): EngineSpec => ({
  name: 'E',
  thrustVac,
  ispVac,
  ...extra,
});

const liquidTank = (propellantMass: number, bottom: number, length: number, flowFraction: number, extra: Partial<TankSpec> = {}): TankSpec => ({
  kind: 'liquid',
  propellantMass,
  bottom,
  length,
  flowFraction,
  ...extra,
});

// Core stage: 20 m long, radius 1.8 m, dry 4000 kg, two liquid tanks.
// LOX: 100000 kg, station 1..9, flow 0.6. RP1: 60000 kg, station 10..16, flow 0.4.
function coreStage(): StageSpec {
  return {
    name: 'Core',
    dryMass: 4000,
    length: 20,
    radius: 1.8,
    tanks: [liquidTank(100000, 1, 8, 0.6, { name: 'LOX' }), liquidTank(60000, 10, 6, 0.4, { name: 'RP1' })],
    engine: engine(1e6, 340),
    engineCount: 1,
  };
}

// Upper stage: 10 m long, radius 1.5 m, dry 1000 kg, two liquid tanks.
function upperStage(): StageSpec {
  return {
    name: 'Upper',
    dryMass: 1000,
    length: 10,
    radius: 1.5,
    tanks: [liquidTank(20000, 1, 4, 0.7, { name: 'LOX' }), liquidTank(10000, 6, 3, 0.3, { name: 'RP1' })],
    engine: engine(200000, 350),
    engineCount: 1,
  };
}

// Strap-on solid: 15 m long, radius 0.9 m, dry 2000 kg, 40000 kg of solid per booster.
function booster(count: number, radialOffset = 3.5, attachStation = 2): StageSpec {
  return {
    name: 'SRB',
    dryMass: 2000,
    length: 15,
    radius: 0.9,
    tanks: [{ name: 'grain', kind: 'solid', propellantMass: 40000, bottom: 0, length: 14, flowFraction: 1 }],
    engine: engine(500000, 270),
    engineCount: 1,
    parallel: { count, radialOffset, attachStation },
  };
}

// Two-stage vehicle, payload 500 kg, length 2 m, radius 1.2 m, no fairing, no boosters.
function twoStage(): VehicleSpec {
  return {
    name: 'Two',
    stages: [coreStage(), upperStage()],
    payload: { mass: 500, length: 2, radius: 1.2 },
  };
}

// Two-stage core plus strap-on boosters (listed after the core stages in the array).
function withBoosters(count: number): VehicleSpec {
  return {
    name: 'Boosted',
    stages: [coreStage(), upperStage(), booster(count)],
    payload: { mass: 500, length: 2, radius: 1.2 },
  };
}

// Same as withBoosters(4) plus a fairing.
function fairedVehicle(): VehicleSpec {
  return {
    ...withBoosters(4),
    fairing: { mass: 800, length: 12, radius: 1.8, noseLength: 5 },
  };
}

// One-stage vehicle with no tanks: dry 1000 kg at 0.4 L, payload 500 kg on top.
function singleStageNoProp(): VehicleSpec {
  return {
    name: 'One',
    stages: [{ name: 'S', dryMass: 1000, length: 10, radius: 1, tanks: [], engine: engine(1e5, 300), engineCount: 1 }],
    payload: { mass: 500, length: 2, radius: 0.8 },
  };
}

// ---- vehicle/types ----------------------------------------------------------

describe('initialRuntime and propellant bookkeeping', () => {
  test('all stages attached, engines off, fairing flag follows the fairing', () => {
    const rt = initialRuntime(twoStage());
    assert.equal(rt.stages.length, 2);
    assert.ok(rt.stages.every((s) => s.attached && !s.engineOn));
    assert.equal(rt.fairingAttached, false);
    assert.equal(initialRuntime(fairedVehicle()).fairingAttached, true);
  });

  test('tankOffsets for two stages of two tanks each is [0, 2]', () => {
    assert.deepEqual(tankOffsets(twoStage()), [0, 2]);
  });

  test('initialPropellant is flattened in tank order', () => {
    assert.deepEqual(initialPropellant(twoStage()), [100000, 60000, 20000, 10000]);
  });
});

// ---- stackLayout ------------------------------------------------------------

describe('stackLayout', () => {
  test('stage bases accumulate bottom-up, top is the sum of core lengths', () => {
    const v = twoStage();
    const { base, top, length } = stackLayout(v, initialRuntime(v));
    assert.equal(base[0], 0);
    assert.equal(base[1], 20);
    assert.equal(top, 30);
    assert.equal(length, 32); // payload length 2 m
  });

  test('boosters sit at core base + attachStation', () => {
    const v = withBoosters(4);
    const { base } = stackLayout(v, initialRuntime(v));
    assert.equal(base[2], 0 + 2);
  });

  test('detaching stage 0 moves the next base to 0 and shrinks top by its length', () => {
    const v = twoStage();
    const rt = initialRuntime(v);
    rt.stages[0].attached = false;
    const { base, top, length } = stackLayout(v, rt);
    assert.ok(Number.isNaN(base[0]));
    assert.equal(base[1], 0);
    assert.equal(top, 10);
    assert.equal(length, 12);
  });

  test('length uses fairing length while the fairing is attached, payload length after', () => {
    const v = fairedVehicle();
    const rt = initialRuntime(v);
    rt.fairingAttached = true;
    assert.equal(stackLayout(v, rt).length, 30 + 12);
    rt.fairingAttached = false;
    assert.equal(stackLayout(v, rt).length, 30 + 2);
  });
});

// ---- massProperties ---------------------------------------------------------

describe('massProperties', () => {
  test('total mass = dry * booster count + propellant * count + payload + fairing', () => {
    const v = fairedVehicle();
    const rt = initialRuntime(v);
    const prop = initialPropellant(v);
    const mp = massProperties(v, rt, prop);
    const expected =
      4000 + 100000 + 60000 + // core stage 0
      1000 + 20000 + 10000 + // core stage 1
      4 * (2000 + 40000) + // four strap-on boosters
      500 + // payload
      800; // fairing
    assertRel(mp.mass, expected, 1e-12);
  });

  test('CG of a single stage with dry mass and payload matches the hand calculation', () => {
    // Dry 1000 kg at 0.4 * 10 = 4 m. Payload 500 kg at top (10 m) + 1 m = 11 m.
    // CG = (1000 * 4 + 500 * 11) / 1500 = 6.3333 m.
    const v = singleStageNoProp();
    const mp = massProperties(v, initialRuntime(v), []);
    assertRel(mp.cg, 9500 / 1500, 1e-12);
    assertRel(mp.mass, 1500, 1e-12);
  });

  test('parallel-axis check: inertia about CG for dry stage (thin cylinder) plus payload (solid cylinder)', () => {
    // Stage: dry 1000 kg, length 10, radius 1 m; a zero-propellant tank adds nothing.
    // Payload: 500 kg, radius 0.8 m, length 2 m. Station: dry 4, payload 11, CG 6.3333.
    const v: VehicleSpec = {
      name: 'PA',
      stages: [
        {
          name: 'S',
          dryMass: 1000,
          length: 10,
          radius: 1,
          tanks: [liquidTank(0, 0, 5, 1)],
          engine: engine(1e5, 300),
          engineCount: 1,
        },
      ],
      payload: { mass: 500, length: 2, radius: 0.8 },
    };
    const mp = massProperties(v, initialRuntime(v), initialPropellant(v));
    const cg = (1000 * 4 + 500 * 11) / 1500;
    // Dry thin-walled cylinder: Ia = m R^2, It = m (R^2/2 + L^2/12).
    const dryIt = 1000 * (1 / 2 + 100 / 12);
    // Payload solid cylinder: It = m (r^2/4 + L^2/12), Ia = m r^2 / 2.
    const payIt = 500 * (0.64 / 4 + 4 / 12);
    const payIa = 0.5 * 500 * 0.64;
    const dryIa = 1000 * 1;
    const iyy = dryIt + 1000 * (4 - cg) ** 2 + payIt + 500 * (11 - cg) ** 2;
    const ixx = dryIa + payIa;
    assertRel(mp.inertia[1], iyy, 1e-9, 'pitch');
    assertRel(mp.inertia[2], iyy, 1e-9, 'yaw');
    assertRel(mp.inertia[0], ixx, 1e-9, 'roll');
  });

  test('draining the lower stage propellant (all of it) moves the CG up', () => {
    const v = twoStage();
    const rt = initialRuntime(v);
    const full = massProperties(v, rt, initialPropellant(v));
    const drained = massProperties(v, rt, [0, 0, 20000, 10000]);
    assert.ok(drained.cg > full.cg, `full=${full.cg} drained=${drained.cg}`);
    // Full CG = 2086500 / 195500 kg m (hand sum of station * mass).
    assertRel(full.cg, 2086500 / 195500, 1e-9);
  });

  test('a liquid tank column shortens from the top, so its CG drops as it drains', () => {
    // Only one tank, no dry mass, no payload: the CG is the tank's own CG.
    const v: VehicleSpec = {
      name: 'T',
      stages: [{ name: 'T', dryMass: 0, length: 10, radius: 1, tanks: [liquidTank(1000, 2, 6, 1)], engine: engine(1e5, 300), engineCount: 1 }],
      payload: { mass: 0, length: 1, radius: 0.5 },
    };
    const rt = initialRuntime(v);
    assertRel(massProperties(v, rt, [1000]).cg, 2 + 3, 1e-12, 'full liquid CG');
    assertRel(massProperties(v, rt, [500]).cg, 2 + 1.5, 1e-12, 'half liquid CG');
  });

  test('a solid tank keeps its CG station as it burns', () => {
    const v: VehicleSpec = {
      name: 'S',
      stages: [
        {
          name: 'S',
          dryMass: 0,
          length: 10,
          radius: 1,
          tanks: [{ kind: 'solid', propellantMass: 1000, bottom: 2, length: 6, flowFraction: 1 }],
          engine: engine(1e5, 300),
          engineCount: 1,
        },
      ],
      payload: { mass: 0, length: 1, radius: 0.5 },
    };
    const rt = initialRuntime(v);
    assertRel(massProperties(v, rt, [1000]).cg, 5, 1e-12);
    assertRel(massProperties(v, rt, [500]).cg, 5, 1e-12);
  });

  test('inertia components are all positive and pitch/yaw >> roll for a long thin stack', () => {
    const mp = massProperties(twoStage(), initialRuntime(twoStage()), initialPropellant(twoStage()));
    const [ixx, iyy, izz] = mp.inertia;
    assert.ok(ixx > 0 && iyy > 0 && izz > 0);
    assert.ok(iyy > 10 * ixx, `iyy=${iyy} ixx=${ixx}`);
    assert.ok(izz > 10 * ixx);
  });

  test('pitch inertia decreases as propellant drains', () => {
    const v = twoStage();
    const rt = initialRuntime(v);
    const full = massProperties(v, rt, initialPropellant(v));
    const half = massProperties(v, rt, initialPropellant(v).map((m) => 0.5 * m));
    assert.ok(half.inertia[1] < full.inertia[1], `full=${full.inertia[1]} half=${half.inertia[1]}`);
  });

  test('four symmetric boosters give Iyy = Izz', () => {
    const v = withBoosters(4);
    const mp = massProperties(v, initialRuntime(v), initialPropellant(v));
    assertRel(mp.inertia[1], mp.inertia[2], 1e-9);
  });

  test('two boosters on the +/-Y axis: Izz - Iyy = 2 * boosterTotalMassEach * radialOffset^2', () => {
    const v = withBoosters(2);
    const mp = massProperties(v, initialRuntime(v), initialPropellant(v));
    const boosterEach = 2000 + 40000; // dry + propellant of one booster
    const expected = 2 * boosterEach * 3.5 ** 2;
    assertRel(mp.inertia[2] - mp.inertia[1], expected, 1e-9);
  });

  test('roll inertia includes n * m * d^2 for each booster', () => {
    const v = withBoosters(4);
    const rt = initialRuntime(v);
    const withB = massProperties(v, rt, initialPropellant(v));
    const rtNo = initialRuntime(v);
    rtNo.stages[2].attached = false;
    const without = massProperties(v, rtNo, initialPropellant(v));
    // Booster terms: n * (dry ia + tank ia + m d^2), with dry ia = m R^2 and tank ia = 0.5 m r^2.
    const d2 = 3.5 ** 2;
    const dryTerm = 4 * (2000 * 0.81 + 2000 * d2);
    const tankTerm = 4 * (0.5 * 40000 * 0.81 + 40000 * d2);
    assertRel(withB.inertia[0] - without.inertia[0], dryTerm + tankTerm, 1e-9);
  });
});

// ---- usable propellant, stage mass, delta-v --------------------------------

describe('usablePropellant, stageMass, deltaVBudget', () => {
  test('usable propellant is limited by the first tank to run dry', () => {
    const v = twoStage();
    const prop = initialPropellant(v);
    // LOX: (100000 - 0.005 * 100000) / 0.6 = 165833; RP1: (60000 - 300) / 0.4 = 149250. RP1 limits.
    assertRel(usablePropellant(v, 0, prop), 149250, 1e-12);
  });

  test('usable propellant is zero when empty', () => {
    const v = twoStage();
    assert.equal(usablePropellant(v, 0, [0, 0, 0, 0]), 0);
    assert.equal(usablePropellant(withBoosters(4), 2, [100000, 60000, 20000, 0, 0, 0, 0, 0, 0]), 0);
  });

  test('usable propellant multiplies by the booster count', () => {
    const v = withBoosters(4);
    const prop = initialPropellant(v);
    // Booster tank: (40000 - 0.005 * 40000) / 1 = 39800 per booster, times 4.
    assertRel(usablePropellant(v, 2, prop), 39800 * 4, 1e-12);
  });

  test('stageMass is dry plus propellant, times booster count', () => {
    const v = withBoosters(4);
    const prop = initialPropellant(v);
    assertRel(stageMass(v, 0, prop), 4000 + 100000 + 60000, 1e-12);
    assertRel(stageMass(v, 2, prop), (2000 + 40000) * 4, 1e-12);
  });

  test('deltaVBudget gives a solid stage the length of its thrust curve as burn time', () => {
    // thrustVac of a curve motor is the curve's peak, so propellant / peak flow is too short.
    const budget = deltaVBudget(pslvXL(1700));
    const core = pslvXL(1700).stages.filter((s) => !s.parallel);
    for (let i = 0; i < core.length; i++) {
      const curve = core[i].engine.thrustCurve;
      if (!curve) continue;
      assertRel(budget[i].burnTime, curve[curve.length - 1][0] - curve[0][0], 1e-12, core[i].name);
    }
    // PS1 (S139) burns for well over 100 s, not the 73 s the peak-thrust estimate gave.
    assert.ok(budget[0].burnTime > 100, `PS1 burnTime=${budget[0].burnTime}`);
  });

  test('deltaVBudget matches Tsiolkovsky by hand for the two-stage vehicle', () => {
    const v = twoStage();
    const budget = deltaVBudget(v);
    assert.equal(budget.length, 2);
    // Lower stage listed first.
    assert.equal(budget[0].stage, 'Core');
    assert.equal(budget[1].stage, 'Upper');

    // Upper stage: payload 500 + wet (1000 + 20000 + 10000) = m0 of 31500.
    // Usable 28428.57 kg (LOX limits: (20000 - 100) / 0.7 = 28428.57, RP1 (10000-50)/0.3 = 33166).
    const usable1 = (20000 - 0.005 * 20000) / 0.7;
    const m0u = 500 + 1000 + 20000 + 10000;
    const dv1 = G0 * 350 * Math.log(m0u / (m0u - usable1));
    const mdot1 = 200000 / (G0 * 350);
    assertRel(budget[1].deltaV, dv1, 1e-9, 'upper dv');
    assertRel(budget[1].burnTime, usable1 / mdot1, 1e-9, 'upper burn');

    // Core stage: m0 = 31500 + 4000 + 100000 + 60000 = 195500, usable 149250.
    const m0c = m0u + 4000 + 100000 + 60000;
    const usable0 = 149250;
    const dv0 = G0 * 340 * Math.log(m0c / (m0c - usable0));
    const mdot0 = 1e6 / (G0 * 340);
    assertRel(budget[0].deltaV, dv0, 1e-9, 'core dv');
    assertRel(budget[0].burnTime, usable0 / mdot0, 1e-9, 'core burn');
  });
});

// ---- aero -------------------------------------------------------------------

describe('aero interpolate', () => {
  const table: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [1, 3],
    [2, 3],
  ];

  test('clamps at both ends', () => {
    assert.equal(interpolate(table, -5), 1);
    assert.equal(interpolate(table, 10), 3);
  });

  test('linear inside the table', () => {
    assertRel(interpolate(table, 0.5), 2, 1e-12);
    assertRel(interpolate(table, 0.25), 1.5, 1e-12);
    assertRel(interpolate(table, 1.5), 3, 1e-12);
  });
});

describe('aeroGeometry', () => {
  test('refArea = pi * maxRadius^2 for a plain stack', () => {
    const v = twoStage();
    const g = aeroGeometry(v, initialRuntime(v));
    assertRel(g.refArea, Math.PI * 1.8 ** 2, 1e-12);
  });

  test('refArea adds booster frontal area while attached and drops when detached', () => {
    const v = withBoosters(4);
    const rt = initialRuntime(v);
    const withB = aeroGeometry(v, rt);
    assertRel(withB.refArea, Math.PI * 1.8 ** 2 + 4 * Math.PI * 0.9 ** 2, 1e-12);
    rt.stages[2].attached = false;
    const without = aeroGeometry(v, rt);
    assertRel(without.refArea, Math.PI * 1.8 ** 2, 1e-12);
  });

  test('xNose lies within the top section of the stack (with and without fairing)', () => {
    const v = twoStage();
    const g = aeroGeometry(v, initialRuntime(v));
    assert.ok(g.xNose >= 30 && g.xNose <= g.length, `xNose=${g.xNose}`);

    const f = fairedVehicle();
    const rt = initialRuntime(f);
    const gf = aeroGeometry(f, rt);
    assert.ok(gf.xNose >= 30 && gf.xNose <= gf.length, `xNose(faired)=${gf.xNose}`);
  });
});

describe('aeroForces (continuum, rho = 1, a = 340, mfp = 1e-7)', () => {
  const v = twoStage();
  const g = aeroGeometry(v, initialRuntime(v));
  const cg = massProperties(v, initialRuntime(v), initialPropellant(v)).cg;
  const air = (vb: [number, number, number], omega: [number, number, number] = [0, 0, 0], cgStation = cg) =>
    aeroForces(vb, omega, 1.0, 340, 1e-7, g, cgStation);

  test('zero angle of attack: pure axial drag -q A Cd along X, no lateral force or moment', () => {
    const r = air([100, 0, 0]);
    const q = 0.5 * 1.0 * 100 ** 2;
    assertRel(r.force[0], -q * g.refArea * r.cd, 1e-12);
    assert.ok(Math.abs(r.force[1]) < 1e-9 && Math.abs(r.force[2]) < 1e-9);
    assert.ok(Math.abs(r.moment[1]) < 1e-9 && Math.abs(r.moment[2]) < 1e-9);
    assert.equal(r.alpha, 0);
  });

  test('drag grows with V^2 at a nearly flat subsonic Cd (normalised by the reported cd)', () => {
    const r1 = air([50, 0, 0]);
    const r2 = air([100, 0, 0]);
    assert.ok(Math.abs(r1.cd - r2.cd) / r1.cd < 0.05, 'table should be nearly flat below Mach 0.5');
    assertRel(r2.force[0] / r1.force[0], (100 / 50) ** 2 * (r2.cd / r1.cd), 1e-9);
  });

  test('small lateral velocity gives a lateral force with Fz < 0 and Fy = 0', () => {
    const r = air([100, 0, 1]);
    assert.ok(r.force[2] < 0, `Fz=${r.force[2]}`);
    assert.ok(Math.abs(r.force[1]) < 1e-9, `Fy=${r.force[1]}`);
  });

  test('alpha = atan2(w, V)', () => {
    const r = air([100, 0, 1]);
    assertRel(r.alpha, Math.atan2(1, 100), 1e-12);
  });

  test('CG far aft (cg = 0): pitching moment My is positive', () => {
    const r = air([100, 0, 1], [0, 0, 0], 0);
    assert.ok(r.moment[1] > 0, `My=${r.moment[1]}`);
    assert.ok(r.cp > 0);
  });

  test('CG ahead of everything (cg = length): pitching moment My is negative', () => {
    const r = air([100, 0, 1], [0, 0, 0], g.length);
    assert.ok(r.moment[1] < 0, `My=${r.moment[1]}`);
  });

  test('reported cp lies between xBody and xNose', () => {
    const r = air([100, 0, 1], [0, 0, 0], 0);
    const lo = Math.min(g.xBody, g.xNose);
    const hi = Math.max(g.xBody, g.xNose);
    assert.ok(r.cp >= lo - 1e-9 && r.cp <= hi + 1e-9, `cp=${r.cp} range=[${lo}, ${hi}]`);
  });

  test('pitch damping: omega = [0, 0.1, 0] gives negative My at zero angle of attack', () => {
    const r = air([100, 0, 0], [0, 0.1, 0]);
    assert.ok(r.moment[1] < 0, `My=${r.moment[1]}`);
  });

  test('yaw damping: omega = [0, 0, -0.1] gives positive Mz', () => {
    const r = air([100, 0, 0], [0, 0, -0.1]);
    assert.ok(r.moment[2] > 0, `Mz=${r.moment[2]}`);
  });

  test('flying backwards (vb = [-V, 0, 0]) gives axial force along +X', () => {
    const r = air([-100, 0, 0]);
    assert.ok(r.force[0] > 0, `Fx=${r.force[0]}`);
    const q = 0.5 * 1.0 * 100 ** 2;
    assertRel(r.force[0], q * g.refArea * r.cd, 1e-12);
  });

  test('free-molecular limit (mfp = 1e6): cd = 2.2 regardless of Mach', () => {
    const lo = aeroForces([100, 0, 0], [0, 0, 0], 1.0, 340, 1e6, g, cg);
    const hi = aeroForces([1000, 0, 0], [0, 0, 0], 1.0, 340, 1e6, g, cg);
    assert.equal(lo.cd, 2.2);
    assert.equal(hi.cd, 2.2);
  });

  test('transition regime (Kn about 0.316): cd strictly between the table value and 2.2', () => {
    const mfp = g.length * Math.pow(10, -0.5);
    const cont = aeroForces([100, 0, 0], [0, 0, 0], 1.0, 340, 1e-7, g, cg);
    const trans = aeroForces([100, 0, 0], [0, 0, 0], 1.0, 340, mfp, g, cg);
    const lo = Math.min(cont.cd, 2.2);
    const hi = Math.max(cont.cd, 2.2);
    assert.ok(trans.cd > lo && trans.cd < hi, `cont=${cont.cd} trans=${trans.cd}`);
    assertRel(trans.cd, 0.5 * cont.cd + 0.5 * 2.2, 1e-9);
  });

  test('zero density gives zero force and moment', () => {
    const r = aeroForces([100, 0, 1], [0, 0.1, 0], 0, 340, 1e-7, g, cg);
    assert.deepEqual(r.force, [0, 0, 0]);
    assert.deepEqual(r.moment, [0, 0, 0]);
  });

  test('mach = V / a and dynamicPressure = 0.5 rho V^2', () => {
    const r = air([170, 0, 0]);
    assertRel(r.mach, 170 / 340, 1e-12);
    assertRel(r.dynamicPressure, 0.5 * 170 ** 2, 1e-12);
  });
});

describe('heating', () => {
  test('stagnation heat flux scales with V^3 and with sqrt(rho / Rn)', () => {
    const base = stagnationHeatFlux(3e-4, 4000, 1);
    assertRel(stagnationHeatFlux(3e-4, 8000, 1) / base, 8, 1e-12);
    assertRel(stagnationHeatFlux(12e-4, 4000, 1) / base, 2, 1e-12);
    assertRel(stagnationHeatFlux(3e-4, 4000, 4) / base, 0.5, 1e-12);
  });

  test('classic check: rho = 3e-4, V = 7000 m/s, Rn = 1 m gives about 1.03e6 W/m^2 (2 %)', () => {
    assertRel(stagnationHeatFlux(3e-4, 7000, 1), 1.03e6, 0.02);
  });

  test('free-molecular heat flux = 0.5 rho V^3', () => {
    assertRel(freeMolecularHeatFlux(3e-4, 7000), 0.5 * 3e-4 * 7000 ** 3, 1e-12);
  });
});
