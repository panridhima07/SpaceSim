import { describe, it, expect } from 'vitest';
import {
  addExternalPart,
  addInternalPart,
  createEmptyDesign,
  duplicatePart,
  findPart,
  fromRocketModel,
  moveExternalPart,
  removePart,
  toRocketModel,
  updatePart,
} from './design';
import { findPreset } from './parts';
import type { BodyTube, FinSet, InnerTube, NoseCone, Parachute } from '../types';
import { massProps } from '../physics/massprops';
import { aeroProps } from '../physics/aero';
import { findMotor } from '../ork/motors';
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
});
