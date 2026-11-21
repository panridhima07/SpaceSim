import { describe, it, expect } from 'vitest';
import {
  PART_PRESETS,
  PART_CATEGORIES,
  findPreset,
  presetsByCategory,
  MATERIALS,
  createTransitionBetween,
} from './parts';
import type { InnerTube } from '../types';
import { findMotor } from '../ork/motors';

describe('builder/parts', () => {
  it('has unique presetIds and valid positive dimensions', () => {
    const ids = new Set<string>();
    for (const preset of PART_PRESETS) {
      expect(ids.has(preset.presetId)).toBe(false);
      ids.add(preset.presetId);
      const comp = preset.create();
      expect(comp.name.length).toBeGreaterThan(0);
      expect(comp.length).toBeGreaterThan(0);
      expect(comp.x).toBe(0);
    }
  });

  it('creates fresh instances on each create() call', () => {
    const preset = findPreset('tube-bt50-240')!;
    const a = preset.create();
    const b = preset.create();
    expect(a).not.toBe(b);
    a.length = 0.5;
    expect(b.length).not.toBe(0.5);
  });

  it('covers all 8 part categories with multiple presets', () => {
    for (const cat of PART_CATEGORIES) {
      expect(presetsByCategory(cat).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('includes 18, 24, 29, 38 and 54 mm motor classes that all resolve in motors.ts', () => {
    const mounts = presetsByCategory('motor');
    const diameters = new Set(mounts.map((p) => p.diameterMm));
    for (const d of [18, 24, 29, 38, 54]) {
      expect(diameters.has(d)).toBe(true);
    }
    for (const preset of mounts) {
      const tube = preset.create() as InnerTube;
      expect(tube.isMotorMount).toBe(true);
      expect(tube.motor).toBeDefined();
      const resolved = findMotor(tube.motor!);
      expect(resolved).not.toBeNull();
      // Motor must fit inside its own mount inner diameter.
      const innerDia = 2 * (tube.outerRadius - tube.thickness);
      expect(innerDia).toBeGreaterThanOrEqual(tube.motor!.diameter);
    }
  });

  it('builds a transition bridging any two radii', () => {
    const tr = createTransitionBetween(0.0124, 0.0208);
    expect(tr.kind).toBe('transition');
    expect(tr.foreRadius).toBeCloseTo(0.0124);
    expect(tr.aftRadius).toBeCloseTo(0.0208);
    expect(tr.length).toBeGreaterThanOrEqual(0.03);
  });

  it('has positive material densities', () => {
    expect(MATERIALS.length).toBeGreaterThanOrEqual(5);
    for (const m of MATERIALS) {
      expect(m.density).toBeGreaterThan(0);
    }
  });
});
