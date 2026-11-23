import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPORT_ACCEPT, IMPORT_EXTENSIONS, importRocketFile } from './importer';
import { toRocketModel } from '../builder/design';
import { exportDesignJson } from '../builder/storage';

const FIXTURES_DIR = join(process.cwd(), 'fixtures', 'external');
const orkFixtures = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.ork'));

const SAMPLE_ENG = `; Sample Estes C6
C6 18 70 0-3-5 0.0125 0.024 Estes
0.0 0.0
0.2 14.0
0.5 4.5
1.86 0.0
`;

const SAMPLE_RSE = `<?xml version="1.0" encoding="UTF-8"?>
<engine-database>
  <engine-list>
    <engine mfg="Estes" code="C6" dia="18" len="70" initWt="24" propWt="12.5">
      <data>
        <eng-data t="0" f="0"/>
        <eng-data t="0.2" f="14"/>
        <eng-data t="1.86" f="0"/>
      </data>
    </engine>
  </engine-list>
</engine-database>`;

const SAMPLE_RKT = `<?xml version="1.0" encoding="UTF-8"?>
<RockSimDocument>
  <RocketDesign>
    <Name>Test RKT</Name>
    <Stage3Parts>
      <NoseCone>
        <Name>Nose</Name>
        <Len>80</Len>
        <BaseDia>24</BaseDia>
        <ShapeCode>1</ShapeCode>
      </NoseCone>
      <BodyTube>
        <Name>Body</Name>
        <Len>200</Len>
        <OD>24</OD>
        <ID>22</ID>
      </BodyTube>
    </Stage3Parts>
  </RocketDesign>
</RockSimDocument>`;

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('importRocketFile', () => {
  it('exports IMPORT_EXTENSIONS and IMPORT_ACCEPT with extensions and Android-safe MIME types', () => {
    expect(IMPORT_EXTENSIONS).toEqual(expect.arrayContaining(['.ork', '.rkt', '.json', '.eng', '.rse', '.xml']));
    expect(IMPORT_ACCEPT).toContain('.ork');
    expect(IMPORT_ACCEPT).toContain('.rkt');
    expect(IMPORT_ACCEPT).toContain('application/octet-stream');
    expect(IMPORT_ACCEPT).toContain('application/zip');
    expect(IMPORT_ACCEPT).toContain('application/json');
    expect(IMPORT_ACCEPT).toContain('text/xml');
  });

  it('imports every fixture in fixtures/external/*.ork and produces a valid Design and RocketModel', async () => {
    expect(orkFixtures.length).toBeGreaterThan(0);
    for (const file of orkFixtures) {
      const bytes = readFileSync(join(FIXTURES_DIR, file));
      const res = await importRocketFile(bytes, file);

      expect(res.kind).toBe('design');
      expect(res.format).toBe('ork');
      expect(res.model).toBeDefined();
      expect(res.model!.components.length).toBeGreaterThan(0);
      expect(res.design).toBeDefined();
      expect(res.design!.stack.length).toBeGreaterThan(0);

      const rebuilt = toRocketModel(res.design!);
      expect(rebuilt.components.length).toBeGreaterThan(0);
    }
  });

  it('detects .ork by content sniffing even when renamed to .bin', async () => {
    const bytes = readFileSync(join(FIXTURES_DIR, orkFixtures[0]));
    const res = await importRocketFile(bytes, 'mystery.bin');
    expect(res.kind).toBe('design');
    expect(res.format).toBe('ork');
    expect(res.model!.components.length).toBeGreaterThan(0);
  });

  it('round-trips sfb-design JSON via exportDesignJson and handles SavedDesign arrays', async () => {
    const orkBytes = readFileSync(join(FIXTURES_DIR, orkFixtures[0]));
    const orkRes = await importRocketFile(orkBytes, orkFixtures[0]);
    const jsonText = exportDesignJson(orkRes.design!);

    // With UTF-8 BOM prepended
    const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encodeUtf8(jsonText)]);
    const res = await importRocketFile(bomBytes, 'rocket.json');
    expect(res.kind).toBe('design');
    expect(res.format).toBe('sfb-json');
    expect(res.design!.stack.length).toBe(orkRes.design!.stack.length);
    expect(res.model!.components.length).toBeGreaterThan(0);

    // Array of SavedDesign -> takes first and warns
    const savedArray = JSON.stringify([
      { id: 's1', name: 'First', savedAt: 1, design: orkRes.design! },
      { id: 's2', name: 'Second', savedAt: 2, design: orkRes.design! },
    ]);
    const arrRes = await importRocketFile(encodeUtf8(savedArray), 'backup.json');
    expect(arrRes.kind).toBe('design');
    expect(arrRes.warnings.some((w) => /saved designs/i.test(w))).toBe(true);
  });

  it('repairs malformed JSON with warnings and ensures unique IDs and valid toRocketModel', async () => {
    const malformed = JSON.stringify({
      name: 'Edited Rocket',
      nextId: 1,
      stack: [
        {
          id: 'p1',
          part: { kind: 'nosecone', name: 'Nose', length: 0.1, baseRadius: 0.02, shape: 'alien-shape', thickness: -5 },
          children: [],
        },
        {
          id: 'p1', // duplicate ID
          part: { kind: 'bodytube', name: 'Body', length: 0.3, outerRadius: 0.02, thickness: 0.001 },
          children: [
            {
              id: 'p1', // duplicate ID
              anchor: 'invalid-anchor',
              offset: 'bad-offset',
              part: { kind: 'finset', name: 'Fins', count: 3, rootChord: 0.05, tipChord: 0.02, span: 0.04 },
            },
            {
              id: 'bad-chute',
              anchor: 'top',
              offset: 0.05,
              part: { kind: 'parachute', name: 'Broken Chute', diameter: -1 },
            },
          ],
        },
        {
          id: 'bad-tube',
          part: { kind: 'bodytube', name: 'Zero Tube', length: 0, outerRadius: 0.02 },
          children: [],
        },
      ],
    });

    const res = await importRocketFile(encodeUtf8(malformed), 'broken.json');
    expect(res.kind).toBe('design');
    expect(res.format).toBe('sfb-json');
    expect(res.warnings.length).toBeGreaterThanOrEqual(4);
    expect(res.design!.stack.length).toBe(2);

    const ids = new Set<string>();
    for (const node of res.design!.stack) {
      expect(ids.has(node.id)).toBe(false);
      ids.add(node.id);
      for (const ch of node.children) {
        expect(ids.has(ch.id)).toBe(false);
        ids.add(ch.id);
      }
    }
    expect(res.design!.nextId).toBeGreaterThan(1);
    expect(() => toRocketModel(res.design!)).not.toThrow();
  });

  it('imports RockSim .rkt files and .rse / .eng motor files', async () => {
    const rktRes = await importRocketFile(encodeUtf8(SAMPLE_RKT), 'test.rkt');
    expect(rktRes.kind).toBe('design');
    expect(rktRes.format).toBe('rocksim');
    expect(rktRes.design!.stack.length).toBe(2);
    expect(toRocketModel(rktRes.design!).components.length).toBe(2);

    const engRes = await importRocketFile(encodeUtf8(SAMPLE_ENG), 'estes.txt');
    expect(engRes.kind).toBe('motors');
    expect(engRes.format).toBe('eng');
    expect(engRes.motors.length).toBe(1);
    expect(engRes.motors[0].designation).toBe('C6');

    const rseRes = await importRocketFile(encodeUtf8(SAMPLE_RSE), 'estes.xml');
    expect(rseRes.kind).toBe('motors');
    expect(rseRes.format).toBe('rse');
    expect(rseRes.motors.length).toBe(1);
  });

  it('throws friendly errors for empty, garbage, damaged archive, and zero-component files', async () => {
    await expect(importRocketFile(new Uint8Array(0), 'empty.ork')).rejects.toThrow(/empty/i);

    const garbage = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x00, 0x07, 0x13, 0x89]);
    await expect(importRocketFile(garbage, 'random.dat')).rejects.toThrow(/isn't supported/i);

    const badZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]);
    await expect(importRocketFile(badZip, 'broken.ork')).rejects.toThrow(/damaged/i);

    const emptyOrk = encodeUtf8('<openrocket><rocket><name>Empty</name><subcomponents/></rocket></openrocket>');
    await expect(importRocketFile(emptyOrk, 'empty.ork')).rejects.toThrow(/no rocket parts/i);

    const emptyJson = encodeUtf8('{"stack": []}');
    await expect(importRocketFile(emptyJson, 'empty.json')).rejects.toThrow(/no valid rocket components/i);
  });
});
