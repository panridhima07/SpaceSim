// Mock OpenRocket designs for import testing. Each case is a small hand-written .ork
// document plus what a correct import must produce, worked out by hand from the XML.

export interface MockCase {
  name: string;
  /** What the case is probing. */
  probes: string;
  xml: string;
  expect?: {
    /** Nose tip to aft end, metres. */
    length?: number;
    maxRadius?: number;
    stageCount?: number;
    /** Exact count of components of a kind. */
    kinds?: Partial<Record<string, number>>;
    /** Parsing must throw. */
    throws?: boolean;
    /** A warning containing this text must be raised. */
    warns?: string;
  };
}

type Fields = Record<string, string | number | boolean | undefined>;

function fields(f: Fields): string {
  return Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
}

function el(tag: string, f: Fields, extra = '', subs = ''): string {
  return `<${tag}><name>${f.name ?? tag}</name>${fields({ ...f, name: undefined })}${extra}` +
    (subs ? `<subcomponents>${subs}</subcomponents>` : '') + `</${tag}>`;
}

const CARD = '<material type="bulk" density="680.0">Cardboard</material>';
const BALSA = '<material type="bulk" density="170.0">Balsa</material>';

export function nose(f: Fields = {}, subs = '', extra = ''): string {
  return el('nosecone', { length: 0.1, thickness: 0.002, shape: 'ogive', shapeparameter: 1, aftradius: 0.025, ...f }, CARD + extra, subs);
}
export function tube(f: Fields = {}, subs = '', extra = ''): string {
  return el('bodytube', { length: 0.3, thickness: 0.002, radius: 0.025, ...f }, CARD + extra, subs);
}
export function transition(f: Fields = {}, subs = ''): string {
  return el('transition', { length: 0.05, thickness: 0.002, shape: 'conical', foreradius: 0.025, aftradius: 0.015, ...f }, CARD, subs);
}
export function fins(f: Fields = {}, extra = ''): string {
  return el('trapezoidfinset', {
    fincount: 3, thickness: 0.003, rootchord: 0.08, tipchord: 0.04, sweeplength: 0.03, height: 0.05, cant: 0, ...f,
  }, BALSA + (extra || '<position type="bottom">0.0</position>'));
}
export function freeform(points: [number, number][], f: Fields = {}): string {
  const pts = points.map(([x, y]) => `<point x="${x}" y="${y}"/>`).join('');
  return el('freeformfinset', { fincount: 3, thickness: 0.003, ...f }, `${BALSA}<position type="bottom">0.0</position><finpoints>${pts}</finpoints>`);
}
export function mount(f: Fields = {}, motor = true, overhang = 0): string {
  const m = motor
    ? `<motormount><overhang>${overhang}</overhang><motor configid="a"><manufacturer>Estes</manufacturer><designation>C6</designation><diameter>0.018</diameter><length>0.07</length><delay>5.0</delay></motor></motormount>`
    : '';
  return el('innertube', { length: 0.07, outerradius: 0.0095, thickness: 0.0005, ...f }, `${CARD}<position type="bottom">0.0</position>${m}`);
}
export function stage(name: string, subs: string): string {
  return `<stage><name>${name}</name><subcomponents>${subs}</subcomponents></stage>`;
}
export function ork(subs: string, name = 'Mock'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><openrocket version="1.9" creator="OpenRocket 23.09"><rocket><name>${name}</name><subcomponents>${subs}</subcomponents></rocket><simulations/></openrocket>`;
}
const simple = (subs: string, name?: string): string => ork(stage('Sustainer', subs), name);

const lug = (f: Fields = {}, extra = ''): string =>
  el('launchlug', { length: 0.03, thickness: 0.0005, radius: 0.003, ...f }, `${CARD}<position type="middle">0.0</position>${extra}`);
const button = (f: Fields = {}, extra = ''): string =>
  el('railbutton', { outerdiameter: 0.0097, innerdiameter: 0.008, height: 0.0097, ...f }, `${CARD}<position type="top">0.05</position>${extra}`);

export const MOCK_CASES: MockCase[] = [
  // ---------- Baseline ----------
  {
    name: 'baseline',
    probes: 'nose + tube + 3 fins + motor mount',
    xml: simple(nose() + tube({}, fins() + mount())),
    expect: { length: 0.4, maxRadius: 0.025, stageCount: 1, kinds: { nosecone: 1, bodytube: 1, finset: 1, innertube: 1 } },
  },

  // ---------- Outline shapes ----------
  ...(['conical', 'ogive', 'ellipsoid', 'power', 'parabolic', 'haack'] as const).map((shape): MockCase => ({
    name: `nose-${shape}`,
    probes: `nose shape ${shape} at shape parameter 0.5`,
    xml: simple(nose({ shape, shapeparameter: 0.5 }) + tube()),
    expect: { length: 0.4, maxRadius: 0.025 },
  })),
  {
    name: 'nose-secant-ogive',
    probes: 'ogive with shape parameter 0.3 is a secant ogive, much closer to a cone than a tangent ogive',
    xml: simple(nose({ shapeparameter: 0.3 }) + tube()),
    expect: { length: 0.4 },
  },
  {
    name: 'nose-unknown-shape',
    probes: 'unknown nose shape name',
    xml: simple(nose({ shape: 'vonkarman' }) + tube()),
    expect: { length: 0.4, warns: 'unknown shape' },
  },
  {
    name: 'tail-cone',
    probes: 'flipped nose cone used as a tail cone at the aft end',
    xml: simple(nose() + tube() + nose({ name: 'Tail cone', isflipped: true, length: 0.06 })),
    expect: { length: 0.46, maxRadius: 0.025, kinds: { nosecone: 2 } },
  },
  {
    name: 'transition-ogive-clipped',
    probes: 'curved, clipped transition between two diameters',
    xml: simple(nose({ aftradius: 0.015 }) + tube({ radius: 0.015, length: 0.1 }) +
      transition({ shape: 'ogive', shapeclipped: true, foreradius: 0.015, aftradius: 0.03, length: 0.08 }) + tube({ radius: 0.03 })),
    expect: { length: 0.58, maxRadius: 0.03, kinds: { transition: 1 } },
  },
  {
    name: 'boat-tail',
    probes: 'transition that narrows at the aft end, with fins on the tube ahead',
    xml: simple(nose() + tube({}, fins()) + transition({ foreradius: 0.025, aftradius: 0.012 })),
    expect: { length: 0.45, maxRadius: 0.025 },
  },

  // ---------- Automatic radii ----------
  {
    name: 'auto-radii-chain',
    probes: 'every radius "auto" except one tube',
    xml: simple(nose({ aftradius: 'auto' }) + tube({ radius: 'auto' }) + transition({ foreradius: 'auto', aftradius: 'auto' }) + tube({ radius: 0.04 })),
    expect: { length: 0.75, maxRadius: 0.04 },
  },
  {
    name: 'auto-radii-unresolvable',
    probes: 'no explicit radius anywhere',
    xml: simple(nose({ aftradius: 'auto' }) + tube({ radius: 'auto' })),
    expect: { warns: 'Could not resolve' },
  },
  {
    name: 'auto-with-number',
    probes: '"auto 0.0125" form written by OpenRocket',
    xml: simple(nose({ aftradius: 'auto 0.0125' }) + tube({ radius: 'auto 0.0125' })),
    expect: { maxRadius: 0.0125 },
  },

  // ---------- Fins ----------
  {
    name: 'fins-on-transition',
    probes: 'fin set attached to a conical transition, where the body radius changes along the root',
    xml: simple(nose() + tube() + transition({ foreradius: 0.025, aftradius: 0.04, length: 0.1 }, fins())),
    expect: { length: 0.5, kinds: { finset: 1 } },
  },
  {
    name: 'fins-position-methods',
    probes: 'top / middle / bottom / absolute fin positions on one tube',
    xml: simple(nose() + tube({},
      fins({ name: 'top' }, '<position type="top">0.01</position>') +
      fins({ name: 'middle' }, '<position type="middle">0.0</position>') +
      fins({ name: 'bottom' }, '<position type="bottom">-0.01</position>') +
      fins({ name: 'absolute' }, '<position type="absolute">0.15</position>'))),
    expect: { kinds: { finset: 4 } },
  },
  {
    name: 'fins-axialoffset-only',
    probes: 'newer files that carry only <axialoffset method="bottom">',
    xml: simple(nose() + tube({}, fins({}, '<axialoffset method="bottom">0.0</axialoffset>'))),
    expect: { length: 0.4 },
  },
  {
    name: 'fins-swept-past-aft',
    probes: 'fins swept so the tips trail behind the body',
    xml: simple(nose() + tube({}, fins({ sweeplength: 0.12, tipchord: 0.05 }))),
    expect: { length: 0.4 },
  },
  {
    name: 'fins-forward-swept',
    probes: 'negative sweep (tips ahead of the root)',
    xml: simple(nose() + tube({}, fins({ sweeplength: -0.03 }))),
    expect: { length: 0.4 },
  },
  {
    name: 'fins-rotated',
    probes: 'fin set rotated 45° about the axis',
    xml: simple(nose() + tube({}, fins({ fincount: 4 }, '<position type="bottom">0.0</position><rotation>45.0</rotation><angleoffset method="relative">45.0</angleoffset>'))),
  },
  {
    name: 'fins-canted',
    probes: '10° cant',
    xml: simple(nose() + tube({}, fins({ cant: 10 }))),
  },
  {
    name: 'fins-one-and-many',
    probes: 'single fin and an eight-fin set',
    xml: simple(nose() + tube({}, fins({ name: 'one', fincount: 1 }) + fins({ name: 'eight', fincount: 8 }, '<position type="top">0.0</position>'))),
  },
  {
    name: 'fins-zero',
    probes: 'zero thickness, zero span, zero count',
    xml: simple(nose() + tube({}, fins({ name: 'flat', thickness: 0 }) + fins({ name: 'nospan', height: 0 }) + fins({ name: 'none', fincount: 0 }))),
  },
  {
    name: 'fins-elliptical',
    probes: 'elliptical fin set',
    xml: simple(nose() + tube({}, el('ellipticalfinset', { fincount: 3, thickness: 0.003, rootchord: 0.08, height: 0.05 }, `${BALSA}<position type="bottom">0.0</position>`))),
    expect: { kinds: { finset: 1 } },
  },
  {
    name: 'fins-freeform',
    probes: 'freeform outline',
    xml: simple(nose() + tube({}, freeform([[0, 0], [0.03, 0.05], [0.07, 0.05], [0.09, 0.02], [0.08, 0]]))),
    expect: { length: 0.4 },
  },
  {
    name: 'fins-freeform-overhang',
    probes: 'freeform outline that extends aft of its root and dips below the root line',
    xml: simple(nose() + tube({}, freeform([[0, 0], [0.02, 0.06], [0.14, 0.06], [0.12, -0.005], [0.08, 0]]))),
  },
  {
    name: 'fins-freeform-degenerate',
    probes: 'freeform with no points, two points, and a self-crossing outline',
    xml: simple(nose() + tube({},
      freeform([], { name: 'empty' }) + freeform([[0, 0], [0.05, 0]], { name: 'two' }) +
      freeform([[0, 0], [0.08, 0.05], [0, 0.05], [0.08, 0]], { name: 'bowtie' }))),
  },
  {
    name: 'fins-tabs-fillets',
    probes: 'through-the-wall tabs and root fillets',
    xml: simple(nose() + tube({}, fins({ tabheight: 0.01, tablength: 0.05, filletradius: 0.004 }, '<position type="bottom">0.0</position><tabposition relativeto="front">0.01</tabposition>'))),
  },
  {
    name: 'tube-fins',
    probes: 'tube fin set (ring fins)',
    xml: simple(nose() + tube({}, el('tubefinset', { fincount: 6, length: 0.06, radius: 0.0125, thickness: 0.0005 }, `${CARD}<position type="bottom">0.0</position>`))),
    expect: { warns: 'flown as fixed parts' },
  },

  // ---------- External fittings ----------
  {
    name: 'launch-lug',
    probes: 'launch lug at 90° with two instances',
    xml: simple(nose() + tube({}, lug({ instancecount: 2, instanceseparation: 0.1 }, '<radialdirection>90.0</radialdirection>'))),
    expect: { kinds: { ring: 1 } },
  },
  {
    name: 'rail-buttons',
    probes: 'pair of rail buttons',
    xml: simple(nose() + tube({}, button({ instancecount: 2, instanceseparation: 0.15 }, '<angleoffset method="relative">180.0</angleoffset>'))),
    expect: { kinds: { ring: 1 } },
  },

  // ---------- Motors ----------
  {
    name: 'motor-overhang',
    probes: 'motor sticking 15 mm out of the mount',
    xml: simple(nose() + tube({}, fins() + mount({}, true, 0.015))),
    expect: { length: 0.4 },
  },
  {
    name: 'mount-past-body',
    probes: 'motor mount tube that protrudes 20 mm aft of the body tube',
    xml: simple(nose() + tube({}, el('innertube', { length: 0.1, outerradius: 0.0095, thickness: 0.0005 }, `${CARD}<position type="bottom">0.02</position><motormount><overhang>0</overhang></motormount>`))),
    expect: { length: 0.4 },
  },
  {
    name: 'motor-cluster',
    probes: 'three-motor cluster in one mount',
    xml: simple(nose({ aftradius: 0.04 }) + tube({ radius: 0.04 }, el('innertube', { length: 0.07, outerradius: 0.0095, thickness: 0.0005, clusterconfiguration: '3-ring', clusterscale: 1, clusterrotation: 0 }, `${CARD}<position type="bottom">0.0</position><motormount><overhang>0</overhang><motor configid="a"><manufacturer>Estes</manufacturer><designation>C6</designation><diameter>0.018</diameter><length>0.07</length><delay>5</delay></motor></motormount>`))),
  },

  // ---------- Staging and side bodies ----------
  {
    name: 'three-stages',
    probes: 'three stacked stages',
    xml: ork(stage('Third', nose() + tube({ length: 0.2 }, fins())) + stage('Second', tube({ length: 0.1 }, fins())) + stage('Booster', tube({ length: 0.1 }, fins()))),
    expect: { length: 0.5, stageCount: 3, kinds: { finset: 3 } },
  },
  {
    name: 'empty-stage',
    probes: 'a stage with nothing in it between two real ones',
    xml: ork(stage('Top', nose() + tube()) + stage('Empty', '') + stage('Booster', tube({ length: 0.1 }))),
    expect: { length: 0.5, stageCount: 3 },
  },
  {
    name: 'no-stage-wrapper',
    probes: 'components directly under <rocket> (very old files)',
    xml: ork(nose() + tube()),
    expect: { length: 0.4 },
  },
  {
    name: 'strap-on-boosters',
    probes: 'parallel boosters (OpenRocket 22+ <parallelstage>)',
    xml: simple(nose() + tube({}, `<parallelstage><name>Boosters</name><instancecount>2</instancecount><radiusoffset method="surface">0.0</radiusoffset><angleoffset method="relative">0.0</angleoffset><axialoffset method="bottom">0.0</axialoffset><subcomponents>${nose({ aftradius: 0.012, length: 0.04 })}${tube({ radius: 0.012, length: 0.15 })}</subcomponents></parallelstage>`)),
    expect: { warns: 'flown as fixed parts' },
  },
  {
    name: 'pods',
    probes: 'pod set with a body inside',
    xml: simple(nose() + tube({}, `<podset><name>Pods</name><instancecount>3</instancecount><radiusoffset method="surface">0.0</radiusoffset><axialoffset method="bottom">0.0</axialoffset><subcomponents>${nose({ aftradius: 0.008, length: 0.03 })}${tube({ radius: 0.008, length: 0.08 })}</subcomponents></podset>`)),
    expect: { warns: 'flown as fixed parts' },
  },
  {
    name: 'boosters-with-fins-and-gap',
    probes: 'four boosters with their own fins and motor mounts, held 5 mm off the body, hanging 30 mm below it',
    xml: simple(nose() + tube({}, `<parallelstage><name>Strap-ons</name><instancecount>4</instancecount><radiusoffset method="relative">0.005</radiusoffset><angleoffset method="relative">45.0</angleoffset><axialoffset method="bottom">0.03</axialoffset><subcomponents>${nose({ aftradius: 'auto', length: 0.04 })}${tube({ radius: 0.012, length: 0.15 }, fins({ rootchord: 0.04, tipchord: 0.02, height: 0.02, sweeplength: 0.01 }) + mount({ outerradius: 0.0095 }))}</subcomponents></parallelstage>`)),
    expect: { length: 0.4, warns: 'flown as fixed parts' },
  },
  {
    name: 'pods-free-radius',
    probes: 'pods placed at a fixed distance from the axis, and an empty pod set',
    xml: simple(nose() + tube({}, `<podset><name>Wing pods</name><instancecount>2</instancecount><radiusoffset method="free">0.08</radiusoffset><axialoffset method="top">0.05</axialoffset><subcomponents>${tube({ radius: 0.01, length: 0.1 })}</subcomponents></podset><podset><name>Empty pods</name><instancecount>2</instancecount></podset>`)),
    expect: { warns: 'no body parts' },
  },
  {
    name: 'tube-fins-auto',
    probes: 'tube fins with an automatic radius: six tubes that just touch around the body',
    xml: simple(nose() + tube({}, el('tubefinset', { fincount: 6, length: 0.06, radius: 'auto', thickness: 0.0005 }, `${CARD}<position type="bottom">0.0</position>`))),
  },

  // ---------- Appearance ----------
  {
    name: 'painted',
    probes: 'paint colours from <appearance>',
    xml: simple(nose({}, '', '<appearance><paint red="10" green="200" blue="30" alpha="255"/><shine>0.5</shine></appearance>') +
      tube({}, '', '<appearance><paint red="0" green="0" blue="255" alpha="255"/><shine>0.3</shine></appearance><finish>polished</finish>')),
  },

  // ---------- Number formats and damaged data ----------
  {
    name: 'scientific-notation',
    probes: 'values in scientific notation',
    xml: simple(nose({ length: '1.0E-1', aftradius: '2.5E-2' }) + tube({ length: '3.0E-1', radius: '2.5e-2' })),
    expect: { length: 0.4, maxRadius: 0.025 },
  },
  {
    name: 'decimal-comma',
    probes: 'decimal commas from a hand-edited or badly localised file',
    xml: simple(nose({ length: '0,1' }) + tube({ length: '0,3', radius: '0,025' })),
    expect: { length: 0.4, maxRadius: 0.025 },
  },
  {
    name: 'negative-and-nan',
    probes: 'negative length, NaN radius, empty tags',
    xml: simple(nose({ length: -0.1 }) + tube({ radius: 'NaN' }) + tube({ length: '' }) + tube({ length: 0.2 })),
  },
  {
    name: 'zero-length-parts',
    probes: 'zero-length nose and tube',
    xml: simple(nose({ length: 0 }) + tube({ length: 0 }) + tube()),
    expect: { length: 0.3 },
  },
  {
    name: 'huge-and-tiny',
    probes: 'a 60 m tall rocket with 0.1 mm fins',
    xml: simple(nose({ length: 8, aftradius: 2 }) + tube({ length: 52, radius: 2 }, fins({ thickness: 0.0001, rootchord: 4, tipchord: 2, height: 3, sweeplength: 1 }))),
    expect: { length: 60, maxRadius: 2 },
  },
  {
    name: 'missing-fields',
    probes: 'components with almost every field missing',
    xml: simple('<nosecone/><bodytube><length>0.3</length><radius>0.02</radius><subcomponents><trapezoidfinset/><innertube/><parachute/><masscomponent/><centeringring/><launchlug/><railbutton/></subcomponents></bodytube>'),
  },
  {
    name: 'nested-externals',
    probes: 'a body tube nested inside a body tube',
    xml: simple(nose() + tube({}, tube({ name: 'inner body', radius: 0.01 }))),
    expect: { warns: 'nested' },
  },
  {
    name: 'internals-outside-body',
    probes: 'inner parts positioned beyond the ends of their tube',
    xml: simple(nose() + tube({}, el('centeringring', { length: 0.002, outerradius: 'auto', innerradius: 0.0095 }, `${CARD}<position type="top">-0.2</position>`) +
      el('parachute', { diameter: 0.3, packedlength: 0.05, packedradius: 0.02 }, '<position type="bottom">0.5</position>'))),
  },
  {
    name: 'ring-wider-than-tube',
    probes: 'centering ring with an outer radius larger than the body, and a hole larger than the ring',
    xml: simple(nose() + tube({}, el('centeringring', { length: 0.002, outerradius: 0.05, innerradius: 0.08 }, `${CARD}<position type="top">0.1</position>`))),
  },
  {
    name: 'many-parts',
    probes: '400 rings and 60 fin sets in one tube',
    xml: simple(nose() + tube({ length: 2 },
      Array.from({ length: 400 }, (_, i) => el('centeringring', { length: 0.002, outerradius: 'auto', innerradius: 0.0095 }, `${CARD}<position type="top">${(i * 0.004).toFixed(3)}</position>`)).join('') +
      Array.from({ length: 60 }, (_, i) => fins({ fincount: 4 }, `<position type="top">${(i * 0.03).toFixed(3)}</position>`)).join(''))),
    expect: { length: 2.1, kinds: { ring: 400, finset: 60 } },
  },

  // ---------- Not a rocket ----------
  { name: 'empty-file', probes: 'empty text', xml: '', expect: { throws: true } },
  { name: 'not-xml', probes: 'plain text', xml: 'this is not a rocket', expect: { throws: true } },
  { name: 'other-xml', probes: 'valid XML that is not an OpenRocket file', xml: '<?xml version="1.0"?><svg><rect/></svg>', expect: { throws: true } },
  {
    name: 'truncated',
    probes: 'file cut off mid-document',
    xml: simple(nose() + tube({}, fins())).slice(0, 420),
    expect: { throws: true },
  },
  {
    name: 'rocket-without-parts',
    probes: 'a <rocket> with no components at all',
    xml: '<openrocket><rocket><name>Bare</name></rocket></openrocket>',
    expect: { length: 0, warns: 'No nose cone' },
  },
  {
    name: 'bom-and-whitespace',
    probes: 'byte-order mark and leading blank lines',
    xml: '﻿\n\n' + simple(nose() + tube()),
    expect: { length: 0.4 },
  },
  {
    name: 'namespaced',
    probes: 'elements carrying a namespace prefix and upper-case tags',
    xml: '<or:openrocket xmlns:or="urn:x"><or:rocket><or:name>NS</or:name><or:subcomponents><or:stage><or:subcomponents>' +
      '<or:NoseCone><or:length>0.1</or:length><or:aftradius>0.025</or:aftradius></or:NoseCone>' +
      '<or:BodyTube><or:length>0.3</or:length><or:radius>0.025</or:radius></or:BodyTube>' +
      '</or:subcomponents></or:stage></or:subcomponents></or:rocket></or:openrocket>',
    expect: { length: 0.4 },
  },
];
