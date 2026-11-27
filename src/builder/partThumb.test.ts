import { describe, it, expect } from 'vitest';
import { PART_PRESETS } from './parts';
import type { PartPreset } from './parts';
import { partThumbSvg } from './partThumb';
import type { Component, NoseCone } from '../types';

/** Every number inside every path `d` attribute of an svg string. */
function pathNumbers(svg: string): number[] {
  const out: number[] = [];
  const dRe = / d="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = dRe.exec(svg)) !== null) {
    const nRe = /-?\d+(?:\.\d+)?/g;
    let n: RegExpExecArray | null;
    while ((n = nRe.exec(m[1])) !== null) out.push(Number(n[0]));
  }
  return out;
}

function presetOf(id: string): PartPreset {
  const p = PART_PRESETS.find((q) => q.presetId === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p;
}

function withComponent(base: PartPreset, c: Component): PartPreset {
  return { ...base, presetId: `test-${c.kind}`, create: () => c };
}

const BASE = { id: '', name: 'x', x: 0, length: 0, density: 0 };

describe('partThumbSvg', () => {
  it('draws every catalogue part as a complete 48-unit svg with no bad numbers', () => {
    for (const p of PART_PRESETS) {
      const svg = partThumbSvg(p);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).toContain('viewBox="0 0 48 48"');
      expect(svg).not.toMatch(/NaN|Infinity|undefined/);
    }
  });

  it('keeps every path coordinate inside the 0..48 box', () => {
    for (const p of PART_PRESETS) {
      for (const n of pathNumbers(partThumbSvg(p))) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(48);
      }
    }
  });

  it('gives the nose presets distinct pictures, and conical differs from ogive', () => {
    const noses = PART_PRESETS.filter((p) => p.category === 'nose');
    expect(noses.length).toBe(7);
    const distinct = new Set(noses.map((p) => partThumbSvg(p)));
    expect(distinct.size).toBeGreaterThan(1);

    const same: Omit<NoseCone, 'shape'> = {
      ...BASE,
      kind: 'nosecone',
      length: 0.1,
      density: 0,
      shapeParam: 1,
      baseRadius: 0.0125,
      thickness: 0,
    };
    const conical = partThumbSvg(withComponent(presetOf('nose-conical-bt50'), { ...same, shape: 'conical' } as NoseCone));
    const ogive = partThumbSvg(withComponent(presetOf('nose-conical-bt50'), { ...same, shape: 'ogive' } as NoseCone));
    expect(conical).not.toBe(ogive);
  });

  it('tells a streamer apart from a parachute', () => {
    expect(partThumbSvg(presetOf('streamer-5x50'))).not.toBe(partThumbSvg(presetOf('chute-30cm')));
  });

  it('tells a camera, a computer and a ballast weight apart', () => {
    const camera = partThumbSvg(presetOf('mass-payload-80g'));
    const computer = partThumbSvg(presetOf('mass-altimeter-35g'));
    const ballast = partThumbSvg(presetOf('mass-10g'));
    expect(camera).not.toBe(computer);
    expect(camera).not.toBe(ballast);
    expect(computer).not.toBe(ballast);
  });

  it('prints the motor letter on every engine thumb', () => {
    const motors = PART_PRESETS.filter((p) => p.category === 'motor');
    let checked = 0;
    for (const p of motors) {
      const c = p.create();
      if (c.kind === 'innertube' && c.motor) {
        const letter = c.motor.designation.charAt(0);
        expect(partThumbSvg(p)).toContain(`>${letter}</text>`);
        checked++;
      }
    }
    expect(checked).toBe(9);
  });

  it('respects a custom size', () => {
    expect(partThumbSvg(PART_PRESETS[0], 24)).toContain('width="24" height="24"');
    expect(partThumbSvg(PART_PRESETS[0])).toContain('width="40" height="40"');
  });

  it('does not throw and stays finite when every dimension is zero or missing', () => {
    const zeros: Component[] = [
      { ...BASE, kind: 'nosecone', shape: 'ogive', shapeParam: 0, baseRadius: 0, thickness: 0 },
      { ...BASE, kind: 'bodytube', outerRadius: 0, thickness: 0 },
      { ...BASE, kind: 'transition', foreRadius: 0, aftRadius: 0, thickness: 0 },
      {
        ...BASE,
        kind: 'finset',
        count: 4,
        rootChord: 0,
        tipChord: 0,
        span: 0,
        sweepLength: 0,
        thickness: 0,
        cant: 0,
        bodyRadius: 0,
        finShape: 'trapezoid',
      },
      {
        ...BASE,
        kind: 'innertube',
        outerRadius: 0,
        thickness: 0,
        isMotorMount: true,
        overhang: 0,
        motor: { manufacturer: '', designation: '', diameter: 0, length: 0, delay: 0 },
      },
      { ...BASE, kind: 'innertube', outerRadius: 0, thickness: 0, isMotorMount: false, overhang: 0, radialCount: 2, radialOffset: 0 },
      { ...BASE, kind: 'innertube', outerRadius: 0, thickness: 0, isMotorMount: false, overhang: 0 },
      { ...BASE, kind: 'parachute', diameter: 0, cd: 0, deployEvent: 'apogee', deployAltitude: 0, deployDelay: 0, mass: 0 },
      { ...BASE, kind: 'parachute', name: 'Streamer', diameter: 0, cd: 0, deployEvent: 'ejection', deployAltitude: 0, deployDelay: 0, mass: 0 },
      { ...BASE, kind: 'mass', mass: 0 },
      { ...BASE, kind: 'ring', outerRadius: 0, innerRadius: 0 },
      { ...BASE, kind: 'ring', outerRadius: 0, innerRadius: 0, external: true },
    ];
    for (const c of zeros) {
      const svg = partThumbSvg(withComponent(PART_PRESETS[0], c));
      expect(svg).toMatch(/^<svg/);
      expect(svg).not.toMatch(/NaN|Infinity|undefined/);
      for (const n of pathNumbers(svg)) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(48);
      }
    }
  });
});

describe('partThumbSvg shading', () => {
  it('uses no defs, ids, styles, scripts or external references', () => {
    for (const p of PART_PRESETS) {
      expect(partThumbSvg(p)).not.toMatch(/<defs|<style|<script|<use|<image|\sid=|url\(|href=|Gradient|filter/i);
    }
  });

  it('keeps every thumb under 9 drawn elements and 1500 characters', () => {
    for (const p of PART_PRESETS) {
      const svg = partThumbSvg(p);
      const elements = (svg.match(/<(path|text|circle|rect|line|ellipse|polygon)\b/g) ?? []).length;
      expect(elements).toBeLessThanOrEqual(8);
      expect(svg.length).toBeLessThanOrEqual(1500);
    }
  });

  it('shades round bodies with a highlight and a shadow overlay', () => {
    for (const id of ['tube-bt50-140', 'trans-bt20-bt50', 'nose-conical-bt50']) {
      const svg = partThumbSvg(presetOf(id));
      expect(svg).toContain('fill="#fff"');
      expect(svg).toContain('fill="#000"');
    }
  });

  it('gives a tube joint lines and a decoupler a dashed seam with bolts', () => {
    expect(partThumbSvg(presetOf('tube-bt50-140'))).toContain('stroke-opacity="0.7"');
    const dec = partThumbSvg(presetOf('decoupler-bt50'));
    expect(dec).toContain('stroke-dasharray');
    expect(dec).toContain('fill="currentColor" stroke="none"');
  });

  it('draws a bulkhead differently from a centering ring', () => {
    expect(partThumbSvg(presetOf('ring-bulkhead-bt50'))).not.toBe(partThumbSvg(presetOf('ring-centering-bt50-18')));
  });
});
