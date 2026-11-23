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

describe('builder/design: stages of an imported rocket', () => {
  const load = async (file: string) => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { parseOrkFile } = await import('../ork/parser');
    return parseOrkFile(new Uint8Array(readFileSync(join(process.cwd(), 'fixtures', 'external', file))));
  };

  it.each(['Three_stage_low_power_rocket.ork', 'Two_stage_high_power_rocket.ork'])(
    'keeps every stage of %s through the editable design',
    async (file) => {
      const model = await load(file);
      const design = fromRocketModel(model);
      const back = toRocketModel(design);
      expect(back.stageCount).toBe(model.stageCount);
      expect(back.stages!.map((s) => s.name)).toEqual(model.stages!.map((s) => s.name));
      expect(back.stages!.map((s) => s.componentCount)).toEqual(model.stages!.map((s) => s.componentCount));
      expect(back.components.length).toBe(model.components.length);
      expect(back.length).toBeCloseTo(model.length, 6);
      // Every part stays in the stage it came from.
      const stageOf = (m: typeof model, name: string, kind: string): number =>
        m.stages!.findIndex((s) =>
          m.components.slice(s.startComponent, s.startComponent + s.componentCount).some((c) => c.name === name && c.kind === kind),
        );
      for (const c of model.components) {
        expect(stageOf(back, c.name, c.kind)).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it('keeps stages while tinkering: resize, remove the first part of a stage, save as JSON', async () => {
    const model = await load('Three_stage_low_power_rocket.ork');
    let design = fromRocketModel(model);
    const starts = design.stack.filter((n) => n.stage);
    expect(starts.length).toBe(3);

    // Resizing a tube keeps the stage count and lengthens the rocket.
    const tube = design.stack.find((n) => n.part.kind === 'bodytube')!;
    design = updatePart(design, tube.id, { part: { length: tube.part.length + 0.05 } });
    const longer = toRocketModel(design);
    expect(longer.stageCount).toBe(3);
    expect(longer.length).toBeCloseTo(model.length + 0.05, 6);

    // Removing the first part of the last stage hands the boundary to the next part.
    const last = starts[2];
    const idx = design.stack.findIndex((n) => n.id === last.id);
    if (idx < design.stack.length - 1) {
      const after = removePart(design, last.id);
      expect(toRocketModel(after).stageCount).toBe(3);
      expect(after.stack[idx].stage?.name).toBe(last.stage!.name);
    }

    // A saved design file carries the stages.
    const { importRocketFile } = await import('../io/importer');
    const bytes = new TextEncoder().encode(JSON.stringify(design));
    const reloaded = await importRocketFile(bytes, 'three.json');
    expect(reloaded.model!.stageCount).toBe(3);
  });

  it('exports the stages back to OpenRocket', async () => {
    const model = await load('Two_stage_high_power_rocket.ork');
    const { exportOrkXml } = await import('./orkExport');
    const again = parseOrkXml(exportOrkXml(fromRocketModel(model)));
    expect(again.stageCount).toBe(2);
    expect(again.stages!.map((s) => s.name)).toEqual(model.stages!.map((s) => s.name));
  });
});

describe('builder/design: side bodies of an imported rocket', () => {
  const load = async (name: string) => {
    const { MOCK_CASES } = await import('../validate/mockOrk');
    return parseOrkXml(MOCK_CASES.find((c) => c.name === name)!.xml);
  };
  const aftOf = (sb: { components: { x: number; length: number }[] }) =>
    Math.max(...sb.components.map((c) => c.x + c.length));

  it.each(['strap-on-boosters', 'pods', 'boosters-with-fins-and-gap', 'pods-free-radius', 'tube-fins-auto'])(
    'leaves %s exactly where the file put them',
    async (name) => {
      const model = await load(name);
      expect(model.sideBodies!.length).toBeGreaterThan(0);
      const back = toRocketModel(fromRocketModel(model));
      back.sideBodies!.forEach((sb, i) => {
        const orig = model.sideBodies![i];
        expect(sb.radialOffset).toBeCloseTo(orig.radialOffset, 9);
        sb.components.forEach((c, k) => expect(c.x).toBeCloseTo(orig.components[k].x, 9));
      });
    },
  );

  it('carries boosters along when the tube they hang on is lengthened, widened or pushed down', async () => {
    const model = await load('strap-on-boosters');
    const design = fromRocketModel(model);
    const sb0 = design.sideBodies![0];
    const parent = design.stack.find((n) => n.id === sb0.mount!.parentId)!;
    const before = toRocketModel(design);
    const parentAftBefore = before.components.find((c) => c.id === parent.id)!;
    const gapToAft = aftOf(before.sideBodies![0]) - (parentAftBefore.x + parentAftBefore.length);

    // Longer tube: the boosters keep their place relative to its aft end.
    const longer = toRocketModel(updatePart(design, parent.id, { part: { length: parent.part.length + 0.1 } }));
    const pl = longer.components.find((c) => c.id === parent.id)!;
    expect(aftOf(longer.sideBodies![0]) - (pl.x + pl.length)).toBeCloseTo(gapToAft, 9);
    expect(aftOf(longer.sideBodies![0])).toBeCloseTo(aftOf(before.sideBodies![0]) + 0.1, 9);

    // Wider tube: the boosters move out by the same amount, so they still touch the skin.
    const r = (parent.part as BodyTube).outerRadius;
    const wider = toRocketModel(updatePart(design, parent.id, { part: { outerRadius: r + 0.01 } }));
    expect(wider.sideBodies![0].radialOffset).toBeCloseTo(before.sideBodies![0].radialOffset + 0.01, 9);

    // A part added above pushes the tube, and the boosters with it, down the rocket.
    const tube = findPreset('tube-bt50-140')!.create() as BodyTube;
    const idx = design.stack.findIndex((n) => n.id === parent.id);
    const pushed = toRocketModel(addExternalPart(design, tube, idx).design);
    expect(aftOf(pushed.sideBodies![0])).toBeCloseTo(aftOf(before.sideBodies![0]) + tube.length, 9);

    // The saved design keeps the tie.
    const { importRocketFile } = await import('../io/importer');
    const reloaded = await importRocketFile(new TextEncoder().encode(JSON.stringify(design)), 'b.json');
    expect(reloaded.design!.sideBodies![0].mount?.parentId).toBe(parent.id);

    // With its tube removed a side body stays put rather than vanishing or jumping.
    const orphan = toRocketModel(removePart(design, parent.id));
    expect(orphan.sideBodies!.length).toBe(before.sideBodies!.length);
  });
});
