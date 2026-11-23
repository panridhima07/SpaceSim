import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseOrkXml, parseOrkFile } from './parser';
import { SAMPLE_ORK_XML } from './sample';
import type { BodyTube, FinSet, InnerTube, NoseCone, Parachute, Ring } from '../types';

describe('parseOrkXml on the sample rocket', () => {
  const rocket = parseOrkXml(SAMPLE_ORK_XML);

  it('reads name, stage count and has no warnings', () => {
    expect(rocket.name).toBe('Astra Sample');
    expect(rocket.stageCount).toBe(1);
    expect(rocket.warnings).toEqual([]);
  });

  it('produces the expected component kinds in order', () => {
    expect(rocket.components.map((c) => c.kind)).toEqual([
      'nosecone', 'bodytube', 'finset', 'innertube', 'parachute', 'mass',
    ]);
  });

  it('resolves absolute stations', () => {
    const byKind = (k: string) => rocket.components.find((c) => c.kind === k)!;
    expect(byKind('nosecone').x).toBeCloseTo(0, 9);
    expect(byKind('bodytube').x).toBeCloseTo(0.07, 9);
    expect(byKind('finset').x).toBeCloseTo(0.32, 9); // 0.37 - 0.05 root chord
    expect(byKind('innertube').x).toBeCloseTo(0.30, 9); // bottom of tube minus 0.07 length
    expect(byKind('parachute').x).toBeCloseTo(0.17, 9);
    expect(byKind('mass').x).toBeCloseTo(0.27, 9);
  });

  it('resolves the auto nose aft radius from the body tube', () => {
    const nose = rocket.components[0] as NoseCone;
    const tube = rocket.components[1] as BodyTube;
    expect(nose.baseRadius).toBeCloseTo(0.0125, 9);
    expect(tube.outerRadius).toBeCloseTo(0.0125, 9);
    expect(tube.thickness).toBeCloseTo(0.0005, 9);
    expect(nose.shape).toBe('ogive');
    expect(rocket.maxRadius).toBeCloseTo(0.0125, 9);
  });

  it('reads fins from the trapezoid geometry', () => {
    const fin = rocket.components[2] as FinSet;
    expect(fin.finShape).toBe('trapezoid');
    expect(fin.count).toBe(3);
    expect(fin.rootChord).toBeCloseTo(0.05, 9);
    expect(fin.length).toBeCloseTo(0.05, 9);
    expect(fin.tipChord).toBeCloseTo(0.025, 9);
    expect(fin.span).toBeCloseTo(0.04, 9);
    expect(fin.sweepLength).toBeCloseTo(0.025, 9);
    expect(fin.thickness).toBeCloseTo(0.003, 9);
    expect(fin.bodyRadius).toBeCloseTo(0.0125, 9);
  });

  it('reads the motor mount and the C6 motor', () => {
    const mount = rocket.components[3] as InnerTube;
    expect(mount.isMotorMount).toBe(true);
    expect(mount.overhang).toBeCloseTo(0.005, 9);
    expect(mount.outerRadius).toBeCloseTo(0.0096, 9);
    expect(mount.motor).toBeDefined();
    expect(mount.motor!.manufacturer).toBe('Estes');
    expect(mount.motor!.designation).toBe('C6');
    expect(mount.motor!.diameter).toBeCloseTo(0.018, 9);
    expect(mount.motor!.delay).toBe(5);
  });

  it('has a motor mount that fits the C6 motor without a motor-fit flaw', () => {
    const mount = rocket.components[3] as InnerTube;
    const innerDiameter = 2 * (mount.outerRadius - mount.thickness);
    expect(mount.motor!.diameter).toBeLessThanOrEqual(innerDiameter);
  });

  it('reads the parachute: diameter, default cd, and surface-density mass', () => {
    const chute = rocket.components[4] as Parachute;
    expect(chute.kind).toBe('parachute');
    expect(chute.diameter).toBeCloseTo(0.3, 9);
    expect(chute.cd).toBeCloseTo(0.8, 9);
    expect(chute.deployEvent).toBe('ejection');
    expect(chute.mass).toBeCloseTo(0.067 * Math.PI * 0.15 * 0.15, 9);
  });

  it('gives the mass component its mass', () => {
    const m = rocket.components[5];
    expect(m.kind).toBe('mass');
    if (m.kind === 'mass') expect(m.mass).toBeCloseTo(0.005, 9);
  });

  it('gives every component a unique id', () => {
    const ids = rocket.components.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('c0');
  });

  it('has overall length of about 0.37 m', () => {
    expect(rocket.length).toBeCloseTo(0.37, 6);
  });
});

describe('parseOrkFile', () => {
  it('reads a zipped .ork archive containing rocket.ork', async () => {
    const zip = new JSZip();
    zip.file('rocket.ork', SAMPLE_ORK_XML);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const rocket = await parseOrkFile(bytes);
    expect(rocket.name).toBe('Astra Sample');
    expect(rocket.components.length).toBe(6);
    expect(rocket.length).toBeCloseTo(0.37, 6);
  });

  it('reads plain XML bytes', async () => {
    const bytes = new TextEncoder().encode(SAMPLE_ORK_XML);
    const rocket = await parseOrkFile(bytes);
    expect(rocket.name).toBe('Astra Sample');
    expect(rocket.components.length).toBe(6);
  });
});

describe('unsupported content', () => {
  it('warns about an unknown component instead of throwing', () => {
    const xml = SAMPLE_ORK_XML.replace(
      '<trapezoidfinset>',
      '<fancygadget><name>Gadget</name></fancygadget><trapezoidfinset>',
    );
    const rocket = parseOrkXml(xml);
    expect(rocket.warnings.some((w) => w.includes('fancygadget'))).toBe(true);
    expect(rocket.components.length).toBe(6);
  });

  it('rejects text that is not an OpenRocket design', () => {
    expect(() => parseOrkXml('<html><body/></html>')).toThrow();
  });
});

/** Minimal design: one nose cone, one body tube, with the given extra body-tube children. */
function miniOrk(noseExtra: string, bodyChildren: string): string {
  return `<?xml version="1.0"?>
<openrocket><rocket><name>Mini</name><subcomponents><stage><subcomponents>
<nosecone><name>Nose</name><material type="bulk" density="1000">P</material><length>0.1</length><thickness>0.002</thickness>
  <shape>conical</shape><aftradius>0.0125</aftradius>${noseExtra}</nosecone>
<bodytube><name>Body</name><material type="bulk" density="680">C</material><length>0.3</length><thickness>0.001</thickness><radius>0.0125</radius>
  <subcomponents>${bodyChildren}</subcomponents></bodytube>
</subcomponents></stage></subcomponents></rocket></openrocket>`;
}

describe('nose shoulder rings', () => {
  it('adds an internal shoulder ring and a capped end ring with the nose density', () => {
    const rocket = parseOrkXml(
      miniOrk('<aftshoulderradius>0.0115</aftshoulderradius><aftshoulderlength>0.02</aftshoulderlength><aftshoulderthickness>0.002</aftshoulderthickness><aftshouldercapped>true</aftshouldercapped>', ''),
    );
    const rings = rocket.components.filter((c) => c.kind === 'ring');
    expect(rings.length).toBe(2);
    const [shoulder, cap] = rings as Ring[];
    expect(shoulder.name).toBe('Nose aft shoulder');
    expect(shoulder.x).toBeCloseTo(0.1, 9);
    expect(shoulder.length).toBeCloseTo(0.02, 9);
    expect(shoulder.outerRadius).toBeCloseTo(0.0115, 9);
    expect(shoulder.innerRadius).toBeCloseTo(0.0095, 9);
    expect(shoulder.density).toBe(1000);
    expect(shoulder.external).toBeUndefined();
    expect(cap.innerRadius).toBe(0);
    expect(cap.length).toBeCloseTo(0.002, 9);
    expect(cap.x).toBeCloseTo(0.118, 9);
  });

  it('adds no shoulder rings when the nose has no shoulder', () => {
    const rocket = parseOrkXml(miniOrk('', ''));
    expect(rocket.components.some((c) => c.kind === 'ring')).toBe(false);
  });
});

describe('external rings', () => {
  it('marks a launch lug external and keeps its tube geometry', () => {
    const rocket = parseOrkXml(
      miniOrk('', '<launchlug><name>Lug</name><axialoffset method="middle">0</axialoffset><material type="bulk" density="680">C</material><radius>0.0035</radius><length>0.035</length><thickness>0.001</thickness></launchlug>'),
    );
    const lug = rocket.components.find((c) => c.kind === 'ring') as Ring;
    expect(lug.external).toBe(true);
    expect(lug.outerRadius).toBeCloseTo(0.0035, 9);
    expect(lug.innerRadius).toBeCloseTo(0.0025, 9);
    expect(lug.length).toBeCloseTo(0.035, 9);
  });

  it('reads a rail button as an external ring from its diameters and height', () => {
    const rocket = parseOrkXml(
      miniOrk('', '<railbutton><name>Rail button</name><outerdiameter>0.01</outerdiameter><innerdiameter>0.004</innerdiameter><height>0.02</height></railbutton>'),
    );
    const btn = rocket.components.find((c) => c.kind === 'ring') as Ring;
    expect(btn.external).toBe(true);
    expect(btn.outerRadius).toBeCloseTo(0.005, 9);
    expect(btn.innerRadius).toBeCloseTo(0.002, 9);
    expect(btn.length).toBeCloseTo(0.02, 9);
  });
});

describe('centering ring automatic inner radius', () => {
  it('takes the outer radius of the overlapping inner tube, not a solid disc', () => {
    const rocket = parseOrkXml(
      miniOrk('', `
        <centeringring><name>CR</name><material type="bulk" density="680">C</material><length>0.002</length>
          <axialoffset method="bottom">0</axialoffset><outerradius>auto</outerradius><innerradius>auto</innerradius></centeringring>
        <innertube><name>Tube</name><material type="bulk" density="680">C</material><length>0.075</length>
          <axialoffset method="bottom">0.005</axialoffset><outerradius>0.0095</outerradius><thickness>0.0005</thickness></innertube>`),
    );
    const cr = rocket.components.find((c) => c.kind === 'ring') as Ring;
    expect(cr.outerRadius).toBeCloseTo(0.0125 - 0.001, 9);
    expect(cr.innerRadius).toBeCloseTo(0.0095, 9);
  });
});

describe('parachute mass', () => {
  it('adds the shroud line mass to the canopy mass', () => {
    const rocket = parseOrkXml(
      miniOrk('', `<parachute><name>Chute</name><axialoffset method="top">0.01</axialoffset><packedlength>0.04</packedlength>
        <cd>auto</cd><material type="surface" density="0.1">Nylon</material><deployevent>ejection</deployevent>
        <diameter>0.3</diameter><linecount>6</linecount><linelength>0.3</linelength>
        <linematerial type="line" density="0.002">Cord</linematerial></parachute>`),
    );
    const chute = rocket.components.find((c) => c.kind === 'parachute') as Parachute;
    const canopy = 0.1 * Math.PI * 0.15 * 0.15;
    expect(chute.mass).toBeCloseTo(canopy + 6 * 0.3 * 0.002, 9);
  });
});

describe('fin cross-section', () => {
  const finXml = (cs: string) => miniOrk('', `<trapezoidfinset><name>Fins</name><fincount>3</fincount>
    <material type="bulk" density="680">C</material><thickness>0.002</thickness>${cs}
    <rootchord>0.05</rootchord><tipchord>0.05</tipchord><height>0.03</height><sweeplength>0.02</sweeplength></trapezoidfinset>`);

  it('reads square, rounded and airfoil edges', () => {
    for (const cs of ['square', 'rounded', 'airfoil']) {
      const fin = parseOrkXml(finXml(`<crosssection>${cs}</crosssection>`)).components.find((c) => c.kind === 'finset') as FinSet;
      expect(fin.crossSection).toBe(cs);
    }
  });

  it('leaves crossSection undefined when the file has none or an unknown value', () => {
    const none = parseOrkXml(finXml('')).components.find((c) => c.kind === 'finset') as FinSet;
    expect(none.crossSection).toBeUndefined();
    const odd = parseOrkXml(finXml('<crosssection>wavy</crosssection>')).components.find((c) => c.kind === 'finset') as FinSet;
    expect(odd.crossSection).toBeUndefined();
  });
});


const NODE_FS = 'node:fs';
const NODE_URL = 'node:url';
const fsMod = (await import(/* @vite-ignore */ NODE_FS)) as unknown as {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
};
const { fileURLToPath } = (await import(/* @vite-ignore */ NODE_URL)) as unknown as {
  fileURLToPath(u: URL): string;
};

const TWO_STAGE = fileURLToPath(
  new URL('../../fixtures/external/Two_stage_high_power_rocket.ork', import.meta.url),
);
const THREE_STAGE = fileURLToPath(
  new URL('../../fixtures/external/Three_stage_low_power_rocket.ork', import.meta.url),
);

describe.skipIf(!fsMod.existsSync(TWO_STAGE) || !fsMod.existsSync(THREE_STAGE))(
  'multi-stage .ork parsing',
  () => {
    it('keeps stage boundaries for two-stage and three-stage rockets', async () => {
      const twoBytes = fsMod.readFileSync(TWO_STAGE);
      const twoModel = await parseOrkFile(twoBytes);
      expect(twoModel.stageCount).toBe(2);
      expect(twoModel.stages).toHaveLength(2);
      expect(twoModel.warnings.some((w) => w.includes('2 stages'))).toBe(true);
      expect(twoModel.stages![0].startComponent).toBe(0);
      expect(twoModel.stages![0].componentCount).toBeGreaterThan(0);
      expect(twoModel.stages![1].startComponent).toBe(twoModel.stages![0].componentCount);
      expect(twoModel.stages![1].componentCount).toBeGreaterThan(0);

      const threeBytes = fsMod.readFileSync(THREE_STAGE);
      const threeModel = await parseOrkFile(threeBytes);
      expect(threeModel.stageCount).toBe(3);
      expect(threeModel.stages).toHaveLength(3);
      const totalFromStages = threeModel.stages!.reduce((s, st) => s + st.componentCount, 0);
      expect(totalFromStages).toBe(threeModel.components.length);
    });
  },
);

describe('parseOrkXml limits', () => {
  const wrap = (inner: string): string =>
    `<openrocket><rocket><name>T</name><subcomponents><stage><subcomponents>${inner}</subcomponents></stage></subcomponents></rocket></openrocket>`;
  const tube = (extra: string): string =>
    `<bodytube><name>b</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness><subcomponents>${extra}</subcomponents></bodytube>`;

  it('clamps fin, instance counts to 64 and lengths and radii to their limits', () => {
    const fins = '<trapezoidfinset><name>f</name><fincount>1000000000</fincount><rootchord>0.07</rootchord><tipchord>0.03</tipchord><height>0.05</height><sweeplength>0.02</sweeplength><thickness>0.003</thickness></trapezoidfinset>';
    const lug = '<launchlug><name>l</name><radius>0.003</radius><length>0.02</length><instancecount>99999</instancecount></launchlug>';
    const rocket = parseOrkXml(wrap(`<bodytube><name>huge</name><length>1e9</length><radius>1e6</radius><thickness>1e6</thickness><subcomponents>${fins}${lug}</subcomponents></bodytube>`));
    const body = rocket.components.find((c) => c.kind === 'bodytube') as BodyTube;
    expect(body.length).toBe(100);
    expect(body.outerRadius).toBe(10);
    expect(body.thickness).toBeLessThanOrEqual(body.outerRadius);
    expect((rocket.components.find((c) => c.kind === 'finset') as FinSet).count).toBe(64);
    expect((rocket.components.find((c) => c.kind === 'ring') as Ring).instanceCount).toBe(64);
  });

  it('keeps normal fin counts and reads at most 1000 children per part', () => {
    const fin = '<trapezoidfinset><name>f</name><fincount>4</fincount><rootchord>0.07</rootchord><height>0.05</height></trapezoidfinset>';
    expect((parseOrkXml(wrap(tube(fin))).components.find((c) => c.kind === 'finset') as FinSet).count).toBe(4);
    const many = '<masscomponent><name>m</name><mass>0.001</mass><packedlength>0.01</packedlength></masscomponent>'.repeat(1500);
    const r = parseOrkXml(wrap(tube(many)));
    expect(r.components.filter((c) => c.kind === 'mass')).toHaveLength(1000);
  });

  it('rejects DOCTYPE and ENTITY declarations', () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "aaaa">]>${wrap('')}`;
    expect(() => parseOrkXml(evil)).toThrow(/DOCTYPE or ENTITY/);
    expect(() => parseOrkXml(`<!doctype x>${wrap('')}`)).toThrow(/DOCTYPE or ENTITY/);
  });

  it('rejects oversize files and text', async () => {
    await expect(parseOrkFile(new Uint8Array(20 * 1024 * 1024 + 1))).rejects.toThrow(/too large/);
    expect(() => parseOrkXml(`<a>${' '.repeat(20 * 1024 * 1024)}</a>`)).toThrow(/too large/);
  });
});
