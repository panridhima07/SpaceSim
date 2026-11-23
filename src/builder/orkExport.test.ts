import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createEmptyDesign, addExternalPart, addInternalPart, fromRocketModel } from './design';
import { exportOrkXml, exportOrkZip } from './orkExport';
import { parseOrkFile, parseOrkXml } from '../ork/parser';
import { massProps } from '../physics/massprops';
import type { RocketModel } from '../types';

const FIXTURES_DIR = join(process.cwd(), 'fixtures', 'external');
const ORK_FILES = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.ork')).sort();

function countByKind(components: { kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of components) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }
  return counts;
}

describe('orkExport round-trip', () => {
  it.each(ORK_FILES)('round-trips %s directly via exportOrkZip -> parseOrkFile', async (file) => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, file)));
    const original = await parseOrkFile(bytes);
    const exported = await exportOrkZip(original);

    const zip = await JSZip.loadAsync(exported);
    expect(zip.file('rocket.ork')).not.toBeNull();
    const xml = await zip.file('rocket.ork')!.async('string');
    expect(xml).toMatch(/<openrocket\s+version="1\.9"\s+creator="[^"]+"/);

    const reparsed = await parseOrkFile(exported);
    expect(reparsed.name).toBe(original.name);
    expect(reparsed.stageCount).toBe(original.stageCount);
    expect(reparsed.components.length).toBe(original.components.length);
    expect(countByKind(reparsed.components)).toEqual(countByKind(original.components));
    expect(reparsed.length).toBeCloseTo(original.length, 4);

    const origMass = massProps(original, null, 0).mass;
    const reMass = massProps(reparsed, null, 0).mass;
    expect(reMass).toBeCloseTo(origMass, 3);
  });

  it.each(ORK_FILES)('round-trips %s via fromRocketModel -> exportOrkZip -> parseOrkFile', async (file) => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, file)));
    const original = await parseOrkFile(bytes);
    const design = fromRocketModel(original);
    const exported = await exportOrkZip(design);
    const reparsed = await parseOrkFile(exported);

    expect(reparsed.name).toBe(original.name);
    expect(reparsed.components.length).toBe(original.components.length);
    expect(countByKind(reparsed.components)).toEqual(countByKind(original.components));
    expect(reparsed.length).toBeCloseTo(original.length, 4);

    // Note: Design does not store stage-level overrideSubcomponentsMass, so compare against
    // the un-overridden component mass when stage overrideSubcomponentsMass is active.
    const hasStageOverride = original.stages?.some((s) => s.overrideSubcomponentsMass);
    const baseline: RocketModel = hasStageOverride
      ? { ...original, stages: original.stages?.map((s) => ({ ...s, overrideSubcomponentsMass: false })) }
      : original;
    const origMass = massProps(baseline, null, 0).mass;
    const reMass = massProps(reparsed, null, 0).mass;
    expect(reMass).toBeCloseTo(origMass, 3);
  });

  it('preserves component fidelity: colors, finishes, flipped nose, curved transition, fin options, rings, motors, multi-stage', () => {
    let d = createEmptyDesign('Fidelity Test');
    const nose = addExternalPart(d, {
      id: '',
      name: 'Nose',
      kind: 'nosecone',
      x: 0,
      length: 0.2,
      density: 1000,
      shape: 'haack',
      shapeParam: 0.33,
      baseRadius: 0.03,
      thickness: 0.002,
      flipped: true,
      color: 0xff3366,
      finish: 'polished',
      massOverride: 0.05,
      cgOverride: 0.11,
    });
    d = nose.design;

    const trans = addExternalPart(d, {
      id: '',
      name: 'Boattail',
      kind: 'transition',
      x: 0,
      length: 0.1,
      density: 1000,
      foreRadius: 0.03,
      aftRadius: 0.025,
      thickness: 0.002,
      shape: 'ogive',
      shapeParam: 0.8,
      clipped: true,
    });
    d = trans.design;

    const body = addExternalPart(d, {
      id: '',
      name: 'Main Tube',
      kind: 'bodytube',
      x: 0,
      length: 0.4,
      density: 680,
      outerRadius: 0.025,
      thickness: 0.001,
      color: 0x112233,
    });
    d = body.design;

    d = addInternalPart(d, body.id, {
      id: '',
      name: 'Trap Fins',
      kind: 'finset',
      x: 0,
      length: 0.08,
      density: 400,
      count: 4,
      rootChord: 0.08,
      tipChord: 0.04,
      span: 0.05,
      sweepLength: 0.03,
      thickness: 0.003,
      cant: 0.02,
      bodyRadius: 0.025,
      finShape: 'trapezoid',
      crossSection: 'airfoil',
      angleOffset: 0.5,
      filletRadius: 0.004,
      tabHeight: 0.01,
      tabLength: 0.04,
      tabOffset: 0.02,
    }, 'bottom', 0)!.design;

    d = addInternalPart(d, body.id, {
      id: '',
      name: 'Freeform Fins',
      kind: 'finset',
      x: 0,
      length: 0.06,
      density: 400,
      count: 3,
      rootChord: 0.06,
      tipChord: 0,
      span: 0.04,
      sweepLength: 0,
      thickness: 0.002,
      cant: 0,
      bodyRadius: 0.025,
      finShape: 'freeform',
      points: [[0, 0], [0.02, 0.04], [0.06, 0.03], [0.06, 0]],
    }, 'top', 0.1)!.design;

    d = addInternalPart(d, body.id, {
      id: '',
      name: 'Rail Buttons',
      kind: 'ring',
      x: 0,
      length: 0.01,
      density: 1200,
      outerRadius: 0.005,
      innerRadius: 0.002,
      external: true,
      ringType: 'railbutton',
      angle: 0.4,
      instanceCount: 2,
      instanceSeparation: 0.25,
    }, 'top', 0.05)!.design;

    d = addInternalPart(d, body.id, {
      id: '',
      name: 'Coupler',
      kind: 'ring',
      x: 0,
      length: 0.05,
      density: 680,
      outerRadius: 0.024,
      innerRadius: 0.022,
      ringType: 'tubecoupler',
    }, 'top', 0.0)!.design;

    d = addInternalPart(d, body.id, {
      id: '',
      name: 'Chute',
      kind: 'parachute',
      x: 0,
      length: 0.06,
      density: 0,
      diameter: 0.45,
      cd: 0.85,
      deployEvent: 'altitude',
      deployAltitude: 150,
      deployDelay: 1.5,
      mass: 0.03,
    }, 'top', 0.08)!.design;

    d = addInternalPart(d, body.id, {
      id: '',
      name: 'Motor Mount',
      kind: 'innertube',
      x: 0,
      length: 0.1,
      density: 680,
      outerRadius: 0.015,
      thickness: 0.001,
      isMotorMount: true,
      overhang: 0.005,
      motor: {
        manufacturer: 'AeroTech',
        designation: 'G64W',
        diameter: 0.029,
        length: 0.124,
        delay: 7,
      },
    }, 'bottom', 0.005)!.design;

    const booster = addExternalPart(d, {
      id: '',
      name: 'Booster Tube',
      kind: 'bodytube',
      x: 0,
      length: 0.2,
      density: 680,
      outerRadius: 0.025,
      thickness: 0.001,
      isDecoupler: true,
    });
    d = booster.design;

    const xml = exportOrkXml(d);
    expect(xml).toContain('<motorconfiguration');
    const parsed = parseOrkXml(xml);
    expect(parsed.stageCount).toBe(2);

    const pNose = parsed.components.find((c) => c.name === 'Nose')!;
    expect(pNose.kind === 'nosecone' && pNose.flipped).toBe(true);
    expect(pNose.color).toBe(0xff3366);
    expect(pNose.finish).toBe('polished');
    expect(pNose.massOverride).toBeCloseTo(0.05, 5);
    expect(pNose.cgOverride).toBeCloseTo(0.11, 5);

    const pTrans = parsed.components.find((c) => c.name === 'Boattail')!;
    expect(pTrans.kind === 'transition' && pTrans.shape).toBe('ogive');
    expect(pTrans.kind === 'transition' && pTrans.clipped).toBe(true);

    const pFins = parsed.components.find((c) => c.name === 'Trap Fins')!;
    expect(pFins.kind === 'finset' && pFins.crossSection).toBe('airfoil');
    expect(pFins.kind === 'finset' && pFins.angleOffset).toBeCloseTo(0.5, 4);
    expect(pFins.kind === 'finset' && pFins.filletRadius).toBeCloseTo(0.004, 5);
    expect(pFins.kind === 'finset' && pFins.tabHeight).toBeCloseTo(0.01, 5);

    const pRail = parsed.components.find((c) => c.name === 'Rail Buttons')!;
    expect(pRail.kind === 'ring' && pRail.ringType).toBe('railbutton');
    expect(pRail.kind === 'ring' && pRail.instanceCount).toBe(2);

    const pCoupler = parsed.components.find((c) => c.name === 'Coupler')!;
    expect(pCoupler.kind === 'ring' && pCoupler.ringType).toBe('tubecoupler');

    const pChute = parsed.components.find((c) => c.name === 'Chute')!;
    expect(pChute.kind === 'parachute' && pChute.deployEvent).toBe('altitude');
    expect(pChute.kind === 'parachute' && pChute.deployAltitude).toBeCloseTo(150, 4);
    expect(pChute.kind === 'parachute' && pChute.mass).toBeCloseTo(0.03, 4);

    const pMount = parsed.components.find((c) => c.name === 'Motor Mount')!;
    expect(pMount.kind === 'innertube' && pMount.motor?.designation).toBe('G64W');
    expect(pMount.kind === 'innertube' && pMount.overhang).toBeCloseTo(0.005, 5);
  });
});
