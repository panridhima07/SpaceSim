// OpenRocket (.ork) XML & zip exporter — inverse of src/ork/parser.ts.
// Pure TypeScript — no DOM, no three.js.

import JSZip from 'jszip';
import type {
  BodyTube,
  FinSet,
  InnerTube,
  MassComponent,
  NoseCone,
  Parachute,
  Ring,
  RocketModel,
  Transition,
} from '../types';
import { fromRocketModel, type ChildNode, type Design, type StackNode } from './design';

const RAD2DEG = 180 / Math.PI;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  return Number.isFinite(n) ? Number(n.toPrecision(7)).toString() : '0';
}

function materialTag(density: number): string {
  return `<material type="bulk" density="${fmt(density)}">Custom</material>`;
}

function overridesXml(c: { massOverride?: number; cgOverride?: number; x?: number }): string {
  const parts: string[] = [];
  if (c.massOverride !== undefined && c.massOverride > 0) {
    parts.push(`<overridemass>${fmt(c.massOverride)}</overridemass>`);
  }
  if (c.cgOverride !== undefined) {
    parts.push(`<overridecg>${fmt(c.cgOverride - (c.x ?? 0))}</overridecg>`);
  }
  return parts.join('');
}

function childXml(ch: ChildNode): string {
  const c = ch.part;
  const pos = `<position type="${ch.anchor}">${fmt(ch.offset)}</position>`;

  switch (c.kind) {
    case 'finset': {
      const f = c as FinSet;
      const tag =
        f.finShape === 'elliptical'
          ? 'ellipticalfinset'
          : f.finShape === 'freeform'
            ? 'freeformfinset'
            : 'trapezoidfinset';
      const common =
        `<name>${esc(f.name)}</name>` +
        pos +
        `<fincount>${Math.max(1, Math.round(f.count))}</fincount>` +
        `<thickness>${fmt(f.thickness)}</thickness>` +
        `<cant>${fmt(f.cant * RAD2DEG)}</cant>` +
        (f.crossSection ? `<crosssection>${f.crossSection}</crosssection>` : '') +
        materialTag(f.density) +
        overridesXml(f);

      if (tag === 'freeformfinset') {
        const pts = (f.points ?? [])
          .map(([x, y]) => `<point x="${fmt(x)}" y="${fmt(y)}"/>`)
          .join('');
        return `<freeformfinset>${common}<finpoints>${pts}</finpoints></freeformfinset>`;
      }
      if (tag === 'ellipticalfinset') {
        return (
          `<ellipticalfinset>${common}` +
          `<rootchord>${fmt(f.rootChord)}</rootchord>` +
          `<height>${fmt(f.span)}</height>` +
          `</ellipticalfinset>`
        );
      }
      return (
        `<trapezoidfinset>${common}` +
        `<rootchord>${fmt(f.rootChord)}</rootchord>` +
        `<tipchord>${fmt(f.tipChord)}</tipchord>` +
        `<height>${fmt(f.span)}</height>` +
        `<sweeplength>${fmt(f.sweepLength)}</sweeplength>` +
        `</trapezoidfinset>`
      );
    }

    case 'innertube': {
      const it = c as InnerTube;
      let mountXml = '';
      if (it.isMotorMount) {
        let motorXml = '';
        if (it.motor) {
          const delayStr = Number.isFinite(it.motor.delay) ? fmt(it.motor.delay) : 'None';
          motorXml =
            `<motor>` +
            `<manufacturer>${esc(it.motor.manufacturer)}</manufacturer>` +
            `<designation>${esc(it.motor.designation)}</designation>` +
            `<diameter>${fmt(it.motor.diameter)}</diameter>` +
            `<length>${fmt(it.motor.length)}</length>` +
            `<delay>${delayStr}</delay>` +
            `</motor>`;
        }
        mountXml = `<motormount><overhang>${fmt(it.overhang)}</overhang>${motorXml}</motormount>`;
      }
      return (
        `<innertube>` +
        `<name>${esc(it.name)}</name>` +
        pos +
        `<outerradius>${fmt(it.outerRadius)}</outerradius>` +
        `<thickness>${fmt(it.thickness)}</thickness>` +
        `<length>${fmt(it.length)}</length>` +
        materialTag(it.density) +
        overridesXml(it) +
        mountXml +
        `</innertube>`
      );
    }

    case 'parachute': {
      const p = c as Parachute;
      const area = Math.PI * (p.diameter / 2) ** 2;
      const surfDensity = area > 0 ? p.mass / area : 0;
      return (
        `<parachute>` +
        `<name>${esc(p.name)}</name>` +
        pos +
        `<packedlength>${fmt(p.length)}</packedlength>` +
        `<diameter>${fmt(p.diameter)}</diameter>` +
        `<cd>${fmt(p.cd)}</cd>` +
        `<deployevent>${p.deployEvent}</deployevent>` +
        `<deployaltitude>${fmt(p.deployAltitude)}</deployaltitude>` +
        `<deploydelay>${fmt(p.deployDelay)}</deploydelay>` +
        `<material type="surface" density="${fmt(surfDensity)}">Ripstop nylon</material>` +
        overridesXml(p) +
        `</parachute>`
      );
    }

    case 'mass': {
      const m = c as MassComponent;
      return (
        `<masscomponent>` +
        `<name>${esc(m.name)}</name>` +
        pos +
        `<packedlength>${fmt(m.length)}</packedlength>` +
        `<mass>${fmt(m.mass)}</mass>` +
        overridesXml(m) +
        `</masscomponent>`
      );
    }

    case 'ring': {
      const r = c as Ring;
      if (r.external) {
        const thick = Math.max(0, r.outerRadius - r.innerRadius);
        return (
          `<launchlug>` +
          `<name>${esc(r.name)}</name>` +
          pos +
          `<radius>${fmt(r.outerRadius)}</radius>` +
          `<thickness>${fmt(thick)}</thickness>` +
          `<length>${fmt(r.length)}</length>` +
          materialTag(r.density) +
          overridesXml(r) +
          `</launchlug>`
        );
      }
      if (r.innerRadius <= 0) {
        return (
          `<bulkhead>` +
          `<name>${esc(r.name)}</name>` +
          pos +
          `<outerradius>${fmt(r.outerRadius)}</outerradius>` +
          `<length>${fmt(r.length)}</length>` +
          materialTag(r.density) +
          overridesXml(r) +
          `</bulkhead>`
        );
      }
      return (
        `<centeringring>` +
        `<name>${esc(r.name)}</name>` +
        pos +
        `<outerradius>${fmt(r.outerRadius)}</outerradius>` +
        `<innerradius>${fmt(r.innerRadius)}</innerradius>` +
        `<length>${fmt(r.length)}</length>` +
        materialTag(r.density) +
        overridesXml(r) +
        `</centeringring>`
      );
    }
  }
}

function stackNodeXml(node: StackNode): string {
  const c = node.part;
  const subs =
    node.children.length > 0
      ? `<subcomponents>${node.children.map(childXml).join('')}</subcomponents>`
      : '';

  switch (c.kind) {
    case 'nosecone': {
      const n = c as NoseCone;
      return (
        `<nosecone>` +
        `<name>${esc(n.name)}</name>` +
        `<shape>${n.shape}</shape>` +
        `<shapeparameter>${fmt(n.shapeParam)}</shapeparameter>` +
        `<length>${fmt(n.length)}</length>` +
        `<aftradius>${fmt(n.baseRadius)}</aftradius>` +
        `<thickness>${fmt(n.thickness)}</thickness>` +
        materialTag(n.density) +
        overridesXml(n) +
        subs +
        `</nosecone>`
      );
    }
    case 'bodytube': {
      const b = c as BodyTube;
      return (
        `<bodytube>` +
        `<name>${esc(b.name)}</name>` +
        `<length>${fmt(b.length)}</length>` +
        `<radius>${fmt(b.outerRadius)}</radius>` +
        `<thickness>${fmt(b.thickness)}</thickness>` +
        materialTag(b.density) +
        overridesXml(b) +
        subs +
        `</bodytube>`
      );
    }
    case 'transition': {
      const t = c as Transition;
      return (
        `<transition>` +
        `<name>${esc(t.name)}</name>` +
        `<shape>conical</shape>` +
        `<length>${fmt(t.length)}</length>` +
        `<foreradius>${fmt(t.foreRadius)}</foreradius>` +
        `<aftradius>${fmt(t.aftRadius)}</aftradius>` +
        `<thickness>${fmt(t.thickness)}</thickness>` +
        materialTag(t.density) +
        overridesXml(t) +
        subs +
        `</transition>`
      );
    }
  }
}

function isDesign(input: Design | RocketModel): input is Design {
  return 'stack' in input;
}

/** Export a Design or RocketModel to OpenRocket XML text. */
export function exportOrkXml(input: Design | RocketModel): string {
  const design = isDesign(input) ? input : fromRocketModel(input);
  const stages: StackNode[][] = [[]];
  for (const node of design.stack) {
    if (node.part.kind === 'bodytube' && node.part.isDecoupler && stages[stages.length - 1].length > 0) {
      stages.push([]);
    }
    stages[stages.length - 1].push(node);
  }
  const stagesXml = stages
    .map((nodes, idx) => {
      const name = idx === 0 ? 'Sustainer' : `Booster ${idx}`;
      return (
        `      <stage>\n` +
        `        <name>${name}</name>\n` +
        `        <subcomponents>${nodes.map(stackNodeXml).join('')}</subcomponents>\n` +
        `      </stage>`
      );
    })
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<openrocket version="1.9" creator="Space Flight Builder">\n` +
    `  <rocket>\n` +
    `    <name>${esc(design.name || 'Rocket')}</name>\n` +
    `    <subcomponents>\n` +
    `${stagesXml}\n` +
    `    </subcomponents>\n` +
    `  </rocket>\n` +
    `</openrocket>\n`
  );
}

/** Export a Design or RocketModel as a standard zipped .ork file (Uint8Array). */
export async function exportOrkZip(input: Design | RocketModel): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('rocket.ork', exportOrkXml(input));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
