import { describe, it, expect } from 'vitest';
import { addExternalPart, addInternalPart, createEmptyDesign, toRocketModel } from './design';
import { findPreset } from './parts';
import { exportOrkXml, exportOrkZip } from './orkExport';
import { parseOrkFile, parseOrkXml } from '../ork/parser';
import { massProps } from '../physics/massprops';
import { aeroProps } from '../physics/aero';
import { findMotor } from '../ork/motors';
import type { BodyTube, FinSet, InnerTube, MassComponent, NoseCone, Parachute, Ring, Transition } from '../types';

describe('builder/orkExport', () => {
  it('round-trips a built rocket through exportOrkXml -> parseOrkXml with matching geometry, mass and aero', () => {
    let d = createEmptyDesign('RoundTrip Alpha');
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    const t1 = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube);
    d = t1.design;
    d = addExternalPart(d, findPreset('trans-bt50-bt60')!.create() as Transition).design;
    const t2 = addExternalPart(d, findPreset('tube-bt60-380')!.create() as BodyTube);
    d = t2.design;

    d = addInternalPart(d, t1.id, findPreset('chute-30cm')!.create() as Parachute, 'top', 0.03)!.design;
    d = addInternalPart(d, t1.id, findPreset('mass-15g')!.create() as MassComponent, 'top', 0.01)!.design;
    d = addInternalPart(d, t2.id, findPreset('fins-delta-3-ply')!.create() as FinSet, 'bottom', 0)!.design;
    d = addInternalPart(d, t2.id, findPreset('mount-29mm-f40')!.create() as InnerTube, 'bottom', 0)!.design;
    d = addInternalPart(d, t2.id, findPreset('ring-centering-bt60-29')!.create() as Ring, 'bottom', -0.02)!.design;
    d = addInternalPart(d, t2.id, findPreset('ring-lug-3mm')!.create() as Ring, 'middle', 0)!.design;

    const built = toRocketModel(d);
    const xml = exportOrkXml(d);
    const parsed = parseOrkXml(xml);

    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.name).toBe('RoundTrip Alpha');
    expect(parsed.components.length).toBe(built.components.length);
    expect(parsed.length).toBeCloseTo(built.length, 5);
    expect(parsed.maxRadius).toBeCloseTo(built.maxRadius, 5);

    const motor = findMotor({ manufacturer: 'Aerotech', designation: 'F40' })!;
    const mpBuilt = massProps(built, motor, 0);
    const mpParsed = massProps(parsed, motor, 0);
    expect(mpParsed.mass).toBeCloseTo(mpBuilt.mass, 4);
    expect(mpParsed.cgX).toBeCloseTo(mpBuilt.cgX, 4);

    const apBuilt = aeroProps(built, 0.2, mpBuilt.cgX);
    const apParsed = aeroProps(parsed, 0.2, mpParsed.cgX);
    expect(apParsed.cpX).toBeCloseTo(apBuilt.cpX, 4);
    expect(apParsed.cnAlpha).toBeCloseTo(apBuilt.cnAlpha, 3);
  });

  it('round-trips a zipped .ork file through exportOrkZip -> parseOrkFile', async () => {
    let d = createEmptyDesign('Zipped Rocket');
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    const t = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube);
    d = t.design;
    d = addInternalPart(d, t.id, findPreset('fins-trap-3-bt50')!.create() as FinSet, 'bottom', 0)!.design;

    const bytes = await exportOrkZip(d);
    // PK zip magic header
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const parsed = await parseOrkFile(bytes);
    expect(parsed.name).toBe('Zipped Rocket');
    expect(parsed.components).toHaveLength(3);
  });

  it('exports multi-stage rockets with decouplers as separate OpenRocket <stage> elements', () => {
    let d = createEmptyDesign('Two Stage Export');
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    d = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube).design;
    d = addExternalPart(d, findPreset('decoupler-bt50')!.create() as BodyTube).design;
    d = addExternalPart(d, findPreset('tube-bt50-140')!.create() as BodyTube).design;

    const xml = exportOrkXml(d);
    const parsed = parseOrkXml(xml);
    expect(parsed.stageCount).toBe(2);
  });
});
