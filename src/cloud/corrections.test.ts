import { describe, it, expect } from 'vitest';
import {
  CORRECTIONS_KEY,
  MAX_LOCAL_CORRECTIONS,
  deleteLocalCorrection,
  describeChanges,
  diffDesigns,
  loadLocalCorrection,
  makeCorrection,
  pickCorrection,
  saveLocalCorrection,
  sha256Hex,
} from './corrections';
import {
  addExternalPart,
  addInternalPart,
  fromRocketModel,
  moveExternalPart,
  removePart,
  updatePart,
  type Design,
} from '../builder/design';
import type { StorageLike } from '../builder/storage';
import { parseOrkXml } from '../ork/parser';
import { SAMPLE_ORK_XML } from '../ork/sample';
import type { BodyTube, FinSet, Parachute, SideBody } from '../types';
import type { CorrectionChange, ImportCorrection } from './types';

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const model = parseOrkXml(SAMPLE_ORK_XML);
const base = (): Design => fromRocketModel(model);

function idOf(d: Design, kind: string): string {
  for (const n of d.stack) {
    if (n.part.kind === kind) return n.id;
    for (const c of n.children) if (c.part.kind === kind) return c.id;
  }
  throw new Error(`no ${kind} in sample`);
}

const sha = (n: number): string => n.toString(16).padStart(64, '0');

function correctionFor(n: number, updatedAt: number, d: Design = base()): ImportCorrection {
  return makeCorrection({
    fileSha256: sha(n),
    filename: `rocket-${n}.ork`,
    parsedModel: model,
    imported: base(),
    corrected: updatePart(d, idOf(d, 'bodytube'), { part: { name: 'Renamed' } }),
    now: updatedAt,
  });
}

describe('sha256Hex', () => {
  it('matches known digests', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('diffDesigns', () => {
  it('reports nothing for identical designs', () => {
    expect(diffDesigns(base(), base())).toEqual([]);
    const d = base();
    expect(diffDesigns(d, JSON.parse(JSON.stringify(d)))).toEqual([]);
  });

  it('reports a resized tube as one changed entry with the field', () => {
    const d = base();
    const id = idOf(d, 'bodytube');
    const tube = d.stack.find((n) => n.id === id)!.part as BodyTube;
    const out = diffDesigns(d, updatePart(d, id, { part: { outerRadius: tube.outerRadius * 2 } }));
    expect(out).toEqual([
      { kind: 'changed', partName: tube.name, partKind: 'bodytube', fields: ['outerRadius'] },
    ]);
  });

  it('ignores tiny numeric noise and station x', () => {
    const d = base();
    const id = idOf(d, 'bodytube');
    const tube = d.stack.find((n) => n.id === id)!.part as BodyTube;
    const noisy = updatePart(d, id, { part: { length: tube.length + 1e-12, x: 99 } });
    expect(diffDesigns(d, noisy)).toEqual([]);
  });

  it('reports a moved child as moved', () => {
    const d = base();
    const id = idOf(d, 'finset');
    const out = diffDesigns(d, updatePart(d, id, { offset: 0.05 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'moved', partKind: 'finset' });
    expect(out[0].fields).toBeUndefined();
    expect(diffDesigns(d, updatePart(d, id, { anchor: 'top' }))[0].kind).toBe('moved');
  });

  it('reports a child moved to another parent as moved', () => {
    const d = base();
    const finId = idOf(d, 'finset');
    const from = d.stack.findIndex((n) => n.children.some((c) => c.id === finId));
    const to = from === 0 ? 1 : 0;
    const child = d.stack[from].children.find((c) => c.id === finId)!;
    const stack = d.stack.map((n, i) =>
      i === from
        ? { ...n, children: n.children.filter((c) => c.id !== finId) }
        : i === to
          ? { ...n, children: [...n.children, child] }
          : n,
    );
    const out = diffDesigns(d, { ...d, stack });
    expect(out).toEqual([{ kind: 'moved', partName: child.part.name, partKind: 'finset' }]);
  });

  it('merges resize + move into a single changed entry including position', () => {
    const d = base();
    const id = idOf(d, 'finset');
    const fin = d.stack.flatMap((n) => n.children).find((c) => c.id === id)!.part as FinSet;
    const out = diffDesigns(d, updatePart(d, id, { part: { span: fin.span * 1.5 }, offset: 0.02 }));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('changed');
    expect(out[0].fields).toContain('span');
    expect(out[0].fields).toContain('position');
  });

  it('reports removed and added parts (removed last)', () => {
    const d = base();
    const chuteId = idOf(d, 'parachute');
    const without = removePart(d, chuteId);
    expect(diffDesigns(d, without)).toEqual([
      expect.objectContaining({ kind: 'removed', partKind: 'parachute' }),
    ]);
    expect(diffDesigns(without, d)).toEqual([
      expect.objectContaining({ kind: 'added', partKind: 'parachute' }),
    ]);

    const chute = d.stack.flatMap((n) => n.children).find((c) => c.id === chuteId)!.part as Parachute;
    const tubeId = idOf(d, 'bodytube');
    const tube = d.stack.find((n) => n.id === tubeId)!.part as BodyTube;
    const edit = addInternalPart(removePart(d, chuteId), tubeId, { ...chute, name: 'Streamer' } as Parachute)!.design;
    const out = diffDesigns(d, updatePart(edit, tubeId, { part: { name: tube.name + '!' } }));
    expect(out.map((c) => c.kind)).toEqual(['changed', 'added', 'removed']);
  });

  it('reports removal of a stack part without flagging the parts after it as moved', () => {
    let d = base();
    const tube = d.stack.find((n) => n.part.kind === 'bodytube')!.part as BodyTube;
    d = addExternalPart(d, { ...tube, name: 'Extra A' }).design;
    d = addExternalPart(d, { ...tube, name: 'Extra B' }).design;
    const firstTubeId = idOf(d, 'bodytube');
    const out = diffDesigns(d, removePart(d, firstTubeId));
    expect(out.map((c) => c.kind)).toContain('removed');
    expect(out.filter((c) => c.kind === 'moved')).toEqual([]);
  });

  it('reports a reordered stack node as moved', () => {
    let d = base();
    const tube = d.stack.find((n) => n.part.kind === 'bodytube')!.part as BodyTube;
    const a = addExternalPart(d, { ...tube, name: 'Extra A' });
    const b = addExternalPart(a.design, { ...tube, name: 'Extra B' });
    d = b.design;
    const last = d.stack.length - 1;
    const out = diffDesigns(d, moveExternalPart(d, d.stack[1].id, last));
    expect(out).toEqual([
      expect.objectContaining({ kind: 'moved', partName: d.stack[1].part.name }),
    ]);
  });

  it('treats a rename as changed, not removed + added', () => {
    const d = base();
    const id = idOf(d, 'finset');
    const out = diffDesigns(d, updatePart(d, id, { part: { name: 'My fins' } }));
    expect(out).toEqual([{ kind: 'changed', partName: 'My fins', partKind: 'finset', fields: ['name'] }]);
  });

  it('reports a stage marker difference', () => {
    const d = base();
    const marked: Design = {
      ...d,
      stack: d.stack.map((n, i) => (i === 1 ? { ...n, stage: { name: 'Booster' } } : n)),
    };
    const out = diffDesigns(d, marked);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'changed', fields: ['stage'] });
    expect(diffDesigns(marked, d)[0].fields).toEqual(['stage']);
  });

  it('reports side body differences', () => {
    const d = base();
    const tube = d.stack.find((n) => n.part.kind === 'bodytube')!.part as BodyTube;
    const sb: SideBody = {
      id: 'sb1',
      name: 'Strap-on',
      type: 'booster',
      count: 2,
      radialOffset: 0.05,
      angle: 0,
      components: [{ ...tube, id: 'sbp1', x: 0 }],
    };
    const withSb: Design = { ...d, sideBodies: [sb] };
    expect(diffDesigns(d, withSb)).toEqual([{ kind: 'added', partName: 'Strap-on', partKind: 'sidebody' }]);
    expect(diffDesigns(withSb, d)).toEqual([{ kind: 'removed', partName: 'Strap-on', partKind: 'sidebody' }]);
    expect(diffDesigns(withSb, { ...d, sideBodies: [{ ...sb, count: 3 }] })).toEqual([
      { kind: 'changed', partName: 'Strap-on', partKind: 'sidebody' },
    ]);
    expect(diffDesigns(withSb, { ...d, sideBodies: [{ ...sb }] })).toEqual([]);
  });

  it('puts removed parts last and keeps corrected stack order', () => {
    const d = base();
    const inner = idOf(d, 'innertube');
    const nose = d.stack.find((n) => n.part.kind === 'nosecone')!;
    const edited = updatePart(removePart(d, inner), nose.id, { part: { name: 'Pointy' } });
    const out = diffDesigns(d, edited);
    expect(out.map((c) => c.kind)).toEqual(['changed', 'removed']);
  });
});

describe('describeChanges', () => {
  it('writes plain-English lines', () => {
    const changes: CorrectionChange[] = [
      { kind: 'changed', partName: 'Trapezoid fins', partKind: 'finset', fields: ['position', 'span'] },
      { kind: 'added', partName: 'Chute', partKind: 'parachute' },
      { kind: 'removed', partName: 'Ring', partKind: 'ring' },
      { kind: 'moved', partName: 'Mount', partKind: 'innertube' },
    ];
    expect(describeChanges(changes)).toEqual([
      'Fins "Trapezoid fins": moved, span changed',
      'Parachute "Chute": added',
      'Ring "Ring": removed',
      'Inner tube "Mount": moved',
    ]);
  });

  it('truncates after the limit with a count of the rest', () => {
    const changes: CorrectionChange[] = Array.from({ length: 11 }, (_, i) => ({
      kind: 'removed' as const,
      partName: `P${i}`,
      partKind: 'mass',
    }));
    const lines = describeChanges(changes);
    expect(lines).toHaveLength(9);
    expect(lines[8]).toBe('…and 3 more');
    expect(describeChanges(changes, 2)).toEqual(['Mass "P0": removed', 'Mass "P1": removed', '…and 9 more']);
    expect(describeChanges(changes.slice(0, 8))).toHaveLength(8);
  });
});

describe('makeCorrection', () => {
  it('builds a record with the diff and clamped text', () => {
    const d = base();
    const c = makeCorrection({
      fileSha256: sha(1),
      filename: 'x'.repeat(500),
      parsedModel: model,
      imported: d,
      corrected: updatePart(d, idOf(d, 'finset'), { part: { span: 0.2 } }),
      note: 'n'.repeat(5000),
      now: 123,
    });
    expect(c.filename).toHaveLength(200);
    expect(c.note).toHaveLength(2000);
    expect(c.updatedAt).toBe(123);
    expect(c.changes).toHaveLength(1);
    expect(c.parsedModel).toBe(model);
  });
});

describe('local corrections', () => {
  it('round-trips a correction', () => {
    const store = memoryStorage();
    const c = correctionFor(1, 1000);
    saveLocalCorrection(c, store);
    const back = loadLocalCorrection(sha(1), store)!;
    expect(back).not.toBeNull();
    expect(back.filename).toBe('rocket-1.ork');
    expect(back.updatedAt).toBe(1000);
    expect(back.changes).toEqual(c.changes);
    expect(back.correctedDesign.stack.map((n) => n.id)).toEqual(c.correctedDesign.stack.map((n) => n.id));
    expect(diffDesigns(c.correctedDesign, back.correctedDesign)).toEqual([]);
    expect(loadLocalCorrection(sha(2), store)).toBeNull();
    expect(loadLocalCorrection('nope', store)).toBeNull();
  });

  it('replaces an existing entry for the same file and deletes', () => {
    const store = memoryStorage();
    saveLocalCorrection(correctionFor(1, 1000), store);
    saveLocalCorrection(correctionFor(1, 2000), store);
    expect(JSON.parse(store.getItem(CORRECTIONS_KEY)!)).toHaveLength(1);
    expect(loadLocalCorrection(sha(1), store)!.updatedAt).toBe(2000);
    deleteLocalCorrection(sha(1), store);
    expect(loadLocalCorrection(sha(1), store)).toBeNull();
  });

  it('fails quiet on corrupt storage', () => {
    const store = memoryStorage();
    store.setItem(CORRECTIONS_KEY, '{not json');
    expect(loadLocalCorrection(sha(1), store)).toBeNull();
    expect(() => saveLocalCorrection(correctionFor(1, 1), store)).not.toThrow();
    expect(loadLocalCorrection(sha(1), store)).not.toBeNull();

    store.setItem(CORRECTIONS_KEY, JSON.stringify([{ fileSha256: sha(3), correctedDesign: { stack: 'x' } }]));
    expect(loadLocalCorrection(sha(3), store)).toBeNull();
    store.setItem(
      CORRECTIONS_KEY,
      JSON.stringify([{ ...correctionFor(4, 1), parsedModel: { name: 'no components' } }]),
    );
    expect(loadLocalCorrection(sha(4), store)).toBeNull();
    store.setItem(CORRECTIONS_KEY, JSON.stringify([{ ...correctionFor(5, 1), fileSha256: 'abc' }]));
    expect(loadLocalCorrection('abc', store)).toBeNull();
    deleteLocalCorrection(sha(9), store);
  });

  it('clamps note and filename on load', () => {
    const store = memoryStorage();
    const c = { ...correctionFor(1, 1), note: 'n'.repeat(9000), filename: 'f'.repeat(900) };
    store.setItem(CORRECTIONS_KEY, JSON.stringify([c]));
    const back = loadLocalCorrection(sha(1), store)!;
    expect(back.note).toHaveLength(2000);
    expect(back.filename).toHaveLength(200);
  });

  it('keeps only the newest 20 entries', () => {
    const store = memoryStorage();
    for (let i = 1; i <= 25; i++) saveLocalCorrection(correctionFor(i, i * 10), store);
    expect(JSON.parse(store.getItem(CORRECTIONS_KEY)!)).toHaveLength(MAX_LOCAL_CORRECTIONS);
    for (let i = 1; i <= 5; i++) expect(loadLocalCorrection(sha(i), store)).toBeNull();
    for (let i = 6; i <= 25; i++) expect(loadLocalCorrection(sha(i), store)).not.toBeNull();
  });

  it('does not throw on quota errors and retries with fewer entries', () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {},
    };
    expect(() => saveLocalCorrection(correctionFor(1, 1), throwing)).not.toThrow();
    expect(() => deleteLocalCorrection(sha(1), throwing)).not.toThrow();
    expect(loadLocalCorrection(sha(1), throwing)).toBeNull();

    const map = new Map<string, string>();
    const one = JSON.stringify(correctionFor(1, 1)).length;
    const small: StorageLike = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        if (v.length > one * 3.5) throw new DOMException('full', 'QuotaExceededError');
        map.set(k, v);
      },
      removeItem: (k) => void map.delete(k),
    };
    for (let i = 1; i <= 3; i++) saveLocalCorrection(correctionFor(i, i), small);
    expect(() => saveLocalCorrection(correctionFor(4, 4), small)).not.toThrow();
    expect(loadLocalCorrection(sha(4), small)).not.toBeNull();
  });

  it('never throws without any localStorage', () => {
    expect(loadLocalCorrection(sha(1))).toBeNull();
    expect(() => saveLocalCorrection(correctionFor(1, 1))).not.toThrow();
  });
});

describe('pickCorrection', () => {
  it('picks the newer one and handles nulls', () => {
    const older = correctionFor(1, 100);
    const newer = correctionFor(1, 200);
    expect(pickCorrection(older, newer)).toBe(newer);
    expect(pickCorrection(newer, older)).toBe(newer);
    expect(pickCorrection(older, null)).toBe(older);
    expect(pickCorrection(null, newer)).toBe(newer);
    expect(pickCorrection(null, null)).toBeNull();
  });
});
