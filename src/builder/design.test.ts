import { describe, it, expect } from 'vitest';
import {
  addExternalPart,
  addInternalPart,
  createEmptyDesign,
  duplicatePart,
  findPart,
  fromRocketModel,
  mapFlawsToParts,
  moveExternalPart,
  removePart,
  toRocketModel,
  updatePart,
} from './design';
import { findPreset } from './parts';
import type { BodyTube, FinSet, InnerTube, NoseCone, Parachute } from '../types';
import { massProps } from '../physics/massprops';
import { aeroProps } from '../physics/aero';
import { atmosphere } from '../physics/atmosphere';
import { createSim } from '../physics/sim';
import { findMotor, thrustAt } from '../ork/motors';
import { parseOrkXml } from '../ork/parser';
import { SAMPLE_ORK_XML } from '../ork/sample';

describe('builder/design', () => {
  it('stacks external parts fore-to-aft and resolves absolute stations', () => {
    let d = createEmptyDesign('Test Rocket');
    const nose = findPreset('nose-ogive-bt50')!.create() as NoseCone;
    const tube = findPreset('tube-bt50-240')!.create() as BodyTube;

    const r1 = addExternalPart(d, nose);
    d = r1.design;
    const r2 = addExternalPart(d, tube);
    d = r2.design;

    const model = toRocketModel(d);
    expect(model.name).toBe('Test Rocket');
    expect(model.components).toHaveLength(2);
    expect(model.components[0].x).toBeCloseTo(0);
    expect(model.components[1].x).toBeCloseTo(nose.length);
    expect(model.length).toBeCloseTo(nose.length + tube.length);
    expect(model.maxRadius).toBeCloseTo(tube.outerRadius);
  });

  it('attaches fins, motor mount and chute to a body tube and produces a stable flyable RocketModel', () => {
    let d = createEmptyDesign('Starter');
    const nose = findPreset('nose-ogive-bt50')!.create() as NoseCone;
    const tube = findPreset('tube-bt50-240')!.create() as BodyTube;
    const fins = findPreset('fins-trap-3-bt50')!.create() as FinSet;
    const mount = findPreset('mount-18mm-c6')!.create() as InnerTube;
    const chute = findPreset('chute-30cm')!.create() as Parachute;

    d = addExternalPart(d, nose).design;
    const tRes = addExternalPart(d, tube);
    d = tRes.design;
    d = addInternalPart(d, tRes.id, fins, 'bottom', 0)!.design;
    d = addInternalPart(d, tRes.id, mount, 'bottom', 0)!.design;
    d = addInternalPart(d, tRes.id, chute, 'top', 0.03)!.design;

    const model = toRocketModel(d);
    expect(model.components).toHaveLength(5);

    const finComp = model.components.find((c) => c.kind === 'finset') as FinSet;
    expect(finComp.x).toBeCloseTo(nose.length + tube.length - fins.rootChord);
    expect(finComp.bodyRadius).toBeCloseTo(tube.outerRadius);

    const motor = findMotor({ manufacturer: 'Estes', designation: 'C6' })!;
    const mp = massProps(model, motor, 0);
    const ap = aeroProps(model, 0.1, mp.cgX);
    const cal = (ap.cpX - mp.cgX) / (2 * model.maxRadius);
    expect(mp.mass).toBeGreaterThan(0.03);
    expect(cal).toBeGreaterThan(1.0);
  });

  it('updates part properties immutably and syncs fin bodyRadius when parent tube resizes', () => {
    let d = createEmptyDesign();
    const tRes = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube);
    d = tRes.design;
    const fRes = addInternalPart(d, tRes.id, findPreset('fins-trap-3-bt50')!.create() as FinSet)!;
    d = fRes.design;

    const d2 = updatePart(d, tRes.id, { part: { outerRadius: 0.02 } as Partial<BodyTube> });
    expect((findPart(d, tRes.id)!.part as BodyTube).outerRadius).not.toBeCloseTo(0.02);
    expect((findPart(d2, tRes.id)!.part as BodyTube).outerRadius).toBeCloseTo(0.02);

    const model = toRocketModel(d2);
    const fin = model.components.find((c) => c.kind === 'finset') as FinSet;
    expect(fin.bodyRadius).toBeCloseTo(0.02);
  });

  it('supports move, duplicate and remove', () => {
    let d = createEmptyDesign();
    const a = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone);
    d = a.design;
    const b = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube);
    d = b.design;
    const dup = duplicatePart(d, b.id)!;
    d = dup.design;
    expect(d.stack).toHaveLength(3);
    expect(dup.id).not.toBe(b.id);

    d = moveExternalPart(d, dup.id, 1);
    expect(d.stack[1].id).toBe(dup.id);

    d = removePart(d, dup.id);
    expect(d.stack).toHaveLength(2);
  });

  it('round-trips the sample .ork RocketModel through fromRocketModel -> toRocketModel', () => {
    const original = parseOrkXml(SAMPLE_ORK_XML);
    const design = fromRocketModel(original);
    const rebuilt = toRocketModel(design);

    expect(rebuilt.name).toBe(original.name);
    expect(rebuilt.length).toBeCloseTo(original.length, 5);
    expect(rebuilt.maxRadius).toBeCloseTo(original.maxRadius, 5);
    expect(rebuilt.components.length).toBe(original.components.length);

    const motor = findMotor({ manufacturer: 'Estes', designation: 'C6' })!;
    const mp1 = massProps(original, motor, 0);
    const mp2 = massProps(rebuilt, motor, 0);
    expect(mp2.mass).toBeCloseTo(mp1.mass, 5);
    expect(mp2.cgX).toBeCloseTo(mp1.cgX, 5);

    const ap1 = aeroProps(original, 0.1, mp1.cgX);
    const ap2 = aeroProps(rebuilt, 0.1, mp2.cgX);
    expect(ap2.cpX).toBeCloseTo(ap1.cpX, 5);
  });

  it('maps flight and pre-flight flaws to the responsible parts', () => {
    let d = createEmptyDesign('Flaw Test');
    const nose = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone);
    d = nose.design;
    const tube = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube);
    d = tube.design;
    const fins = addInternalPart(d, tube.id, findPreset('fins-trap-3-bt50')!.create() as FinSet)!;
    d = fins.design;
    const mount = addInternalPart(d, tube.id, findPreset('mount-18mm-c6')!.create() as InnerTube)!;
    d = mount.design;
    const chute = addInternalPart(d, tube.id, findPreset('chute-30cm')!.create() as Parachute)!;
    d = chute.design;

    const mapped = mapFlawsToParts(
      [
        { id: `fin-flutter:${fins.id}`, severity: 'critical', title: 'Fin flutter', detail: '', fix: '' },
        { id: 'hard-landing', severity: 'warning', title: 'Hard landing', detail: '', fix: '' },
        { id: 'low-twr', severity: 'warning', title: 'Low TWR', detail: '', fix: '' },
      ],
      d,
    );
    expect(mapped.get(fins.id)?.[0].title).toBe('Fin flutter');
    expect(mapped.get(chute.id)?.[0].title).toBe('Hard landing');
    expect(mapped.get(mount.id)?.[0].title).toBe('Low TWR');
  });

  it('builds a two-stage rocket with a decoupler and simulates stage separation & ignition', () => {
    let d = createEmptyDesign('Two-Stage');
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    const upperTube = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube);
    d = upperTube.design;
    d = addInternalPart(d, upperTube.id, findPreset('chute-30cm')!.create() as Parachute, 'top', 0.03)!.design;
    d = addInternalPart(d, upperTube.id, findPreset('fins-trap-3-bt50')!.create() as FinSet, 'bottom', 0)!.design;
    d = addInternalPart(d, upperTube.id, findPreset('mount-18mm-b6')!.create() as InnerTube, 'bottom', 0)!.design;

    // Decoupler + booster stage
    d = addExternalPart(d, findPreset('decoupler-bt50')!.create() as BodyTube).design;
    const boosterTube = addExternalPart(d, findPreset('tube-bt50-140')!.create() as BodyTube);
    d = boosterTube.design;
    d = addInternalPart(d, boosterTube.id, findPreset('fins-trap-3-bt50')!.create() as FinSet, 'bottom', 0)!.design;
    d = addInternalPart(d, boosterTube.id, findPreset('mount-18mm-c6')!.create() as InnerTube, 'bottom', 0)!.design;

    const model = toRocketModel(d);
    expect(model.stageCount).toBe(2);
    expect(model.stages).toHaveLength(2);

    const c6 = findMotor({ manufacturer: 'Estes', designation: 'C6' })!;
    const b6 = findMotor({ manufacturer: 'Estes', designation: 'B6' })!;
    const sim = createSim(
      model,
      c6,
      {
        railLength: 1,
        railAngle: 0,
        railAzimuth: 0,
        windSpeed: 0,
        windDirection: 0,
        gust: 0,
        launchAltitude: 0,
        stageMotors: [
          { motor: c6, ignitionDelay: 0 },
          { motor: b6, ignitionDelay: 0.1 },
        ],
      },
      { atmosphere, massProps, aeroProps, thrust: thrustAt },
    );
    sim.ignite();
    for (let i = 0; i < 60 && !sim.done; i++) sim.step(0.25);

    const types = sim.events.map((e) => e.type);
    expect(types).toContain('stage separation');
    expect(types).toContain('stage ignition');
    expect(types).toContain('apogee');
  });
});
