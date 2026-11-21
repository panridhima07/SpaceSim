import { describe, it, expect } from 'vitest';
import { addExternalPart, createEmptyDesign } from './design';
import { findPreset } from './parts';
import { applySnap, computeSnapPoints } from './snap';
import type { BodyTube, NoseCone } from '../types';

describe('builder/snap', () => {
  it('offers a single start snap on an empty design for external parts', () => {
    const d = createEmptyDesign();
    const nose = findPreset('nose-ogive-bt50')!.create();
    const snaps = computeSnapPoints(d, nose);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].kind).toBe('top');
    expect(snaps[0].diameterMatch).toBe(true);
  });

  it('offers top, between, and bottom snaps with diameter match detection', () => {
    let d = createEmptyDesign();
    const nose = findPreset('nose-ogive-bt50')!.create() as NoseCone;
    const tube50 = findPreset('tube-bt50-240')!.create() as BodyTube;
    d = addExternalPart(d, nose).design;
    d = addExternalPart(d, tube50).design;

    // Matching BT-50 tube can go between or at bottom, not above nosecone
    const snapsMatch = computeSnapPoints(d, findPreset('tube-bt50-140')!.create());
    expect(snapsMatch.map((s) => s.kind)).toEqual(['between', 'bottom']);
    expect(snapsMatch.every((s) => s.diameterMatch)).toBe(true);

    // Mismatched BT-60 tube flags diameterMatch=false and suggests a transition
    const snapsWide = computeSnapPoints(d, findPreset('tube-bt60-380')!.create());
    const bottom = snapsWide.find((s) => s.kind === 'bottom')!;
    expect(bottom.diameterMatch).toBe(false);
    expect(bottom.needsTransition).toBeDefined();
    expect(bottom.needsTransition!.foreRadius).toBeCloseTo(tube50.outerRadius);
  });

  it('inserts an automatic bridging transition when applySnap is called with addTransition', () => {
    let d = createEmptyDesign();
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    d = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube).design;

    const wideTube = findPreset('tube-bt60-380')!.create();
    const snaps = computeSnapPoints(d, wideTube);
    const bottom = snaps.find((s) => s.kind === 'bottom')!;
    const res = applySnap(d, wideTube, bottom, { addTransition: true })!;

    expect(res.design.stack).toHaveLength(4);
    expect(res.design.stack[2].part.kind).toBe('transition');
    expect(res.design.stack[3].part.kind).toBe('bodytube');
    expect(res.id).toBe(res.design.stack[3].id);
  });

  it('computes inside snaps for internal parts and checks motor mount clearance', () => {
    let d = createEmptyDesign();
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    d = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube).design;

    // 18 mm mount fits inside BT-50 (23.8 mm ID)
    const m18 = findPreset('mount-18mm-c6')!.create();
    const s18 = computeSnapPoints(d, m18);
    expect(s18).toHaveLength(1);
    expect(s18[0].kind).toBe('inside');
    expect(s18[0].diameterMatch).toBe(true);

    // 38 mm mount does NOT fit inside BT-50
    const m38 = findPreset('mount-38mm-i284')!.create();
    const s38 = computeSnapPoints(d, m38);
    expect(s38).toHaveLength(1);
    expect(s38[0].diameterMatch).toBe(false);
    expect(s38[0].warning).toBeDefined();
  });
});
