// Plain-language names for the parts palette. The catalogue (parts.ts) keeps its hobby
// codes ("Ogive Nose (BT-50)") because exported rockets use them; this file only decides
// what a beginner reads on a part card. Pure TypeScript — no DOM.

import type { PartCategory, PartPreset } from './parts';

/** Short category names for the palette rail. */
export const FRIENDLY_CATEGORY: Record<PartCategory, string> = {
  nose: 'Noses',
  tube: 'Body',
  transition: 'Adapters',
  fins: 'Fins',
  motor: 'Engines',
  recovery: 'Chutes',
  payload: 'Cargo',
  rings: 'Rings',
};

/** One-line explanation of what each category is for. */
export const CATEGORY_HELP: Record<PartCategory, string> = {
  nose: 'Nose cones — the pointed tip at the top',
  tube: 'Body tubes — the main body of the rocket',
  transition: 'Adapters — join a wide part to a narrow one, or split stages',
  fins: 'Fins — keep the rocket flying straight',
  motor: 'Engines — push the rocket up',
  recovery: 'Parachutes — bring the rocket down safely',
  payload: 'Cargo and weights — cameras, computers, balance weights',
  rings: 'Rings and small fittings — hold inner parts in place',
};

export interface FriendlyPart {
  /** Simple name shown on the card. */
  name: string;
  /** Second line: size in everyday units. */
  detail: string;
  /** Size badge (XS … XXL) from the part's width, or '' when width does not matter. */
  size: string;
  /** Everything the search box matches against, lower-case. */
  search: string;
}

const RENAMES: readonly [RegExp, string][] = [
  [/Von Kármán Nose/i, 'Sleek nose'],
  [/Ogive Nose/i, 'Pointed nose'],
  [/Conical Nose/i, 'Cone nose'],
  [/Ellipsoid Nose/i, 'Round nose'],
  [/Payload Tube/i, 'Short body tube'],
  [/Body Tube/i, 'Body tube'],
  [/Airframe/i, 'Strong body tube'],
  [/Boat-Tail/i, 'Tail cone'],
  [/Transition/i, 'Adapter'],
  [/Stage Decoupler/i, 'Stage separator'],
  [/Trapezoid Fins/i, 'Classic fins'],
  [/Elliptical Fins/i, 'Round fins'],
  [/Swept Delta/i, 'Swept-back fins'],
  [/High-Power Fins/i, 'Heavy-duty fins'],
  [/Side Boosters/i, 'Side boosters'],
  [/Nose Weight/i, 'Balance weight'],
  [/Flight Computer/i, 'Flight computer'],
  [/Camera Payload/i, 'Camera'],
  [/Centering Ring/i, 'Engine holder ring'],
  [/Bulkhead/i, 'Divider disc'],
  [/Launch Lug/i, 'Launch rail guide'],
];

/** Width (mm) → T-shirt size, so "does it fit?" can be answered at a glance. */
export function sizeBadge(diameterMm: number | undefined): string {
  if (diameterMm === undefined || !Number.isFinite(diameterMm)) return '';
  if (diameterMm < 21) return 'XS';
  if (diameterMm < 29) return 'S';
  if (diameterMm < 38) return 'M';
  if (diameterMm < 50) return 'L';
  if (diameterMm < 62) return 'XL';
  return 'XXL';
}

const ENGINE_POWER: Record<string, string> = {
  A: 'Tiny',
  B: 'Small',
  C: 'Small',
  D: 'Medium',
  E: 'Medium',
  F: 'Big',
  G: 'Big',
  I: 'Huge',
  J: 'Huge',
};

function cleanCodes(text: string): string {
  return text
    .replace(/\(BT-\d+\)/gi, '')
    .replace(/BT-\d+(→\d+)?/gi, '')
    .replace(/\(\d+ mm\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function friendlyPart(preset: PartPreset): FriendlyPart {
  let name = preset.label;
  let detail = preset.subtitle;
  const size = sizeBadge(preset.diameterMm);

  const engine = /^(\d+) mm Mount · ([A-Z])(\d+)/.exec(preset.label);
  if (engine) {
    const letter = engine[2];
    name = `${ENGINE_POWER[letter] ?? 'Rocket'} engine ${letter}${engine[3]}`;
    detail = `${engine[1]} mm wide · power ${preset.subtitle.split(' · ')[1] ?? ''}`;
  } else {
    for (const [re, simple] of RENAMES) {
      if (re.test(name)) {
        name = name.replace(re, simple);
        break;
      }
    }
    name = cleanCodes(name);
    if (preset.category === 'transition' || preset.category === 'rings') {
      // Keep only the "from → to" widths; the hobby tube codes are dropped.
      name = name.replace(/\s*\d+→\d+$/, '').replace(/\s*\d+(\.\d+)? mm$/, '');
    }
    name = name.replace(/\s*57 mm$/, '');
    detail = cleanCodes(detail)
      .replace(/(\d+(?:\.\d+)?) mm · (\d+(?:\.\d+)?) cm/, '$1 mm wide · $2 cm long')
      .replace(/^([\d.]+ → [\d.]+ mm)$/, '$1 wide')
      .replace(/^([\d.]+ mm) · Separates stage/, 'Splits the rocket in two · $1')
      .replace(/(\d+) mm span/, 'sticks out $1 mm')
      .replace(/Ejection/, 'Opens after engine burns out')
      .replace(/Apogee/, 'Opens at the top')
      .replace(/ · Cd [\d.]+/, '')
      .replace(/radial pods/, 'extra engines on the sides')
      .replace(/^→ /, 'to ')
      .replace(/Trim ballast/, 'Fixes balance')
      .replace(/Ballast \/ payload/, 'Fixes balance')
      .replace(/Altimeter \/ avionics/, 'Tracks the flight')
      .replace(/Heavy payload/, 'Films the flight')
      .replace(/solid disc/, 'wide')
      .replace(/^External · /, 'Outside · ');
    if (preset.category === 'rings' && /→/.test(preset.label)) {
      const m = /(\d+)→(\d+)/.exec(preset.label);
      if (m) detail = `Fits ${m[2]} mm engine in ${m[1]} mm tube`;
    }
  }

  const search = [name, detail, preset.label, preset.subtitle, FRIENDLY_CATEGORY[preset.category], size]
    .join(' ')
    .toLowerCase();
  return { name, detail, size, search };
}

/**
 * Plain version of a placed part's name ("Payload Tube (BT-50)" -> "Short body tube",
 * "18 mm Mount (C6-5)" -> "Engine holder (C6-5)"). Names the user typed, or that came
 * from an imported file, pass through unless they contain one of the hobby terms.
 */
export function friendlyName(name: string): string {
  let out = name.replace(/^(\d+) mm Mount/i, 'Engine holder');
  for (const [re, simple] of RENAMES) {
    if (re.test(out)) {
      out = out.replace(re, simple);
      break;
    }
  }
  return cleanCodes(out) || name;
}

/** Does `preset` match what was typed in the search box? Every word must appear. */
export function matchesSearch(part: FriendlyPart, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => part.search.includes(w));
}

// Static 24×24 outline icons, one per category. No dynamic text, so innerHTML is safe.
export const CATEGORY_ICON: Record<PartCategory | 'all', string> = {
  all: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  nose: '<path d="M12 3c3.2 4 5 9 5 14v3H7v-3c0-5 1.800-10 5-14z"/>',
  tube: '<path d="M8 3h8v18H8z"/><path d="M8 8h8M8 16h8"/>',
  transition: '<path d="M9.500 3h5l3.500 18H6z"/>',
  fins: '<path d="M10 3h4v18h-4z"/><path d="M10 13l-6 8h6M14 13l6 8h-6"/>',
  motor: '<path d="M8.500 3h7v10h-7z"/><path d="M8.500 13l-2.500 5h12l-2.500-5"/><path d="M12 18v3M9 18l-1 3M15 18l1 3"/>',
  recovery: '<path d="M3 11a9 8 0 0 1 18 0z"/><path d="M3 11l9 10 9-10M12 11v10"/>',
  payload: '<path d="M5 8h14v12H5z"/><path d="M9 8V5h6v3"/><circle cx="12" cy="14" r="2.500"/>',
  rings: '<circle cx="12" cy="12" r="8.500"/><circle cx="12" cy="12" r="4"/>',
};

export function iconSvg(key: PartCategory | 'all', size = 20): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.600" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${CATEGORY_ICON[key]}</svg>`
  );
}
