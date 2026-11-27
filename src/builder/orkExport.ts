// OpenRocket (.ork) XML & zip exporter — inverse of src/ork/parser.ts.
// Pure TypeScript — no DOM, no three.js.

import type {
  BodyTube,
  Component,
  FinSet,
  InnerTube,
  MassComponent,
  NoseCone,
  Parachute,
  Ring,
  RocketModel,
  SideBody,
  Transition,
} from '../types';
import { fromRocketModel, isExternal, isInternal, type ChildNode, type Design, type StackNode } from './design';

const RAD2DEG = 180 / Math.PI;
const DEFAULT_CONFIG_ID = 'sfb-default-config';

function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
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

function appearanceXml(c: { color?: number; finish?: string }): string {
  const parts: string[] = [];
  if (c.finish) {
    parts.push(`<finish>${esc(c.finish)}</finish>`);
  }
  if (c.color !== undefined && Number.isFinite(c.color)) {
    const rgb = c.color & 0xffffff;
    const r = (rgb >> 16) & 0xff;
    const g = (rgb >> 8) & 0xff;
    const b = rgb & 0xff;
    parts.push(`<appearance><paint red="${r}" green="${g}" blue="${b}" alpha="255"/></appearance>`);
  }
  return parts.join('');
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

function fittingXml(r: Ring): string {
  const parts: string[] = [];
  if (r.angle) {
    parts.push(`<angleoffset>${fmt(r.angle * RAD2DEG)}</angleoffset>`);
  }
  if (r.instanceCount !== undefined && r.instanceCount > 1) {
    parts.push(`<instancecount>${Math.round(r.instanceCount)}</instancecount>`);
    parts.push(`<instanceseparation>${fmt(r.instanceSeparation ?? 0)}</instanceseparation>`);
  }
  return parts.join('');
}

function clusterXml(it: InnerTube): string {
  if (!it.cluster || it.cluster.length < 2) return '';
  const n = it.cluster.length;
  const hasCenter = it.cluster.some(([x, z]) => Math.hypot(x, z) < 1e-6);
  const config = n === 2 ? 'double' : hasCenter ? `${n}-star` : `${n}-ring`;
  // Estimate centre-to-centre pitch from first non-zero offset.
  let dist = 0;
  for (const [x, z] of it.cluster) {
    const d = Math.hypot(x, z);
    if (d > 1e-6) {
      dist = d;
      break;
    }
  }
  let pitch = dist * 2;
  if (!hasCenter && n >= 3) {
    pitch = dist * 2 * Math.sin(Math.PI / n);
  }
  const scale = it.outerRadius > 0 ? pitch / (2 * it.outerRadius) : 1;
  return (
    `<clusterconfiguration>${config}</clusterconfiguration>` +
    `<clusterscale>${fmt(scale)}</clusterscale>` +
    `<clusterrotation>0</clusterrotation>`
  );
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
      const tabXml =
        f.tabHeight && f.tabLength && f.tabHeight > 0 && f.tabLength > 0
          ? `<tabheight>${fmt(f.tabHeight)}</tabheight>` +
            `<tablength>${fmt(f.tabLength)}</tablength>` +
            `<tabposition relativeto="front">${fmt(f.tabOffset ?? 0)}</tabposition>`
          : '';
      const common =
        `<name>${esc(f.name)}</name>` +
        pos +
        `<fincount>${Math.max(1, Math.round(f.count))}</fincount>` +
        `<thickness>${fmt(f.thickness)}</thickness>` +
        `<cant>${fmt(f.cant * RAD2DEG)}</cant>` +
        (f.angleOffset ? `<angleoffset>${fmt(f.angleOffset * RAD2DEG)}</angleoffset>` : '') +
        (f.filletRadius && f.filletRadius > 0 ? `<filletradius>${fmt(f.filletRadius)}</filletradius>` : '') +
        (f.crossSection ? `<crosssection>${f.crossSection}</crosssection>` : '') +
        tabXml +
        materialTag(f.density) +
        appearanceXml(f) +
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
            `<motor configid="${DEFAULT_CONFIG_ID}">` +
            `<type>single</type>` +
            `<manufacturer>${esc(it.motor.manufacturer)}</manufacturer>` +
            `<designation>${esc(it.motor.designation)}</designation>` +
            `<diameter>${fmt(it.motor.diameter)}</diameter>` +
            `<length>${fmt(it.motor.length)}</length>` +
            `<delay>${delayStr}</delay>` +
            `</motor>`;
        }
        mountXml =
          `<motormount>` +
          `<ignitionevent>automatic</ignitionevent>` +
          `<ignitiondelay>0</ignitiondelay>` +
          `<overhang>${fmt(it.overhang)}</overhang>` +
          `${motorXml}` +
          `</motormount>`;
      }
      return (
        `<innertube>` +
        `<name>${esc(it.name)}</name>` +
        pos +
        `<outerradius>${fmt(it.outerRadius)}</outerradius>` +
        `<thickness>${fmt(it.thickness)}</thickness>` +
        `<length>${fmt(it.length)}</length>` +
        clusterXml(it) +
        materialTag(it.density) +
        appearanceXml(it) +
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
        appearanceXml(p) +
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
        appearanceXml(m) +
        overridesXml(m) +
        `</masscomponent>`
      );
    }

    case 'ring': {
      const r = c as Ring;
      if (r.ringType === 'railbutton') {
        return (
          `<railbutton>` +
          `<name>${esc(r.name)}</name>` +
          pos +
          `<outerdiameter>${fmt(r.outerRadius * 2)}</outerdiameter>` +
          `<innerdiameter>${fmt(r.innerRadius * 2)}</innerdiameter>` +
          `<height>${fmt(r.length)}</height>` +
          fittingXml(r) +
          materialTag(r.density) +
          appearanceXml(r) +
          overridesXml(r) +
          `</railbutton>`
        );
      }
      if (r.external) {
        const thick = Math.max(0, r.outerRadius - r.innerRadius);
        return (
          `<launchlug>` +
          `<name>${esc(r.name)}</name>` +
          pos +
          `<radius>${fmt(r.outerRadius)}</radius>` +
          `<thickness>${fmt(thick)}</thickness>` +
          `<length>${fmt(r.length)}</length>` +
          fittingXml(r) +
          materialTag(r.density) +
          appearanceXml(r) +
          overridesXml(r) +
          `</launchlug>`
        );
      }
      if (r.ringType === 'tubecoupler' || r.ringType === 'engineblock') {
        return (
          `<${r.ringType}>` +
          `<name>${esc(r.name)}</name>` +
          pos +
          `<outerradius>${fmt(r.outerRadius)}</outerradius>` +
          `<innerradius>${fmt(r.innerRadius)}</innerradius>` +
          `<length>${fmt(r.length)}</length>` +
          materialTag(r.density) +
          appearanceXml(r) +
          overridesXml(r) +
          `</${r.ringType}>`
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
          appearanceXml(r) +
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
        appearanceXml(r) +
        overridesXml(r) +
        `</centeringring>`
      );
    }
  }
}

function sideBodyXml(sb: SideBody): string {
  if (sb.type === 'tubefin') {
    const tube = sb.components[0] as BodyTube | undefined;
    if (!tube) return '';
    return (
      `<tubefinset>` +
      `<name>${esc(sb.name)}</name>` +
      `<position type="absolute">${fmt(tube.x)}</position>` +
      `<fincount>${Math.max(1, Math.round(sb.count))}</fincount>` +
      `<length>${fmt(tube.length)}</length>` +
      `<radius>${fmt(tube.outerRadius)}</radius>` +
      `<thickness>${fmt(tube.thickness)}</thickness>` +
      `<angleoffset>${fmt(sb.angle * RAD2DEG)}</angleoffset>` +
      materialTag(tube.density) +
      appearanceXml(tube) +
      overridesXml(tube) +
      `</tubefinset>`
    );
  }

  const tag = sb.type === 'pod' ? 'podset' : 'parallelstage';
  const extNodes = sideComponentsToStack(sb.components);
  const firstX = extNodes[0]?.part.x ?? 0;
  return (
    `<${tag}>` +
    `<name>${esc(sb.name)}</name>` +
    `<position type="absolute">${fmt(firstX)}</position>` +
    `<instancecount>${Math.max(1, Math.round(sb.count))}</instancecount>` +
    `<radiusoffset method="free">${fmt(sb.radialOffset)}</radiusoffset>` +
    `<angleoffset>${fmt(sb.angle * RAD2DEG)}</angleoffset>` +
    `<subcomponents>${extNodes.map((n) => stackNodeXml(n)).join('')}</subcomponents>` +
    `</${tag}>`
  );
}

function sideComponentsToStack(components: Component[]): StackNode[] {
  const exts = components.filter(isExternal).sort((a, b) => a.x - b.x);
  const ints = components.filter(isInternal);
  const nodes: StackNode[] = exts.map((p, i) => ({ id: `sb_${i}`, part: p, children: [] }));
  for (const internal of ints) {
    if (nodes.length === 0) break;
    const mid = internal.x + internal.length / 2;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i].part;
      const inside = mid >= p.x - 1e-6 && mid <= p.x + p.length + 1e-6;
      const dist = inside ? 0 : Math.min(Math.abs(mid - p.x), Math.abs(mid - (p.x + p.length)));
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const parent = nodes[bestIdx].part;
    nodes[bestIdx].children.push({
      id: internal.id,
      part: internal,
      anchor: 'top',
      offset: internal.x - parent.x,
    });
  }
  return nodes;
}

function stackNodeXml(node: StackNode, extraXml = ''): string {
  const c = node.part;
  const inner = node.children.map(childXml).join('') + extraXml;
  const subs = inner.length > 0 ? `<subcomponents>${inner}</subcomponents>` : '';

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
        (n.flipped ? `<isflipped>true</isflipped>` : '') +
        materialTag(n.density) +
        appearanceXml(n) +
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
        appearanceXml(b) +
        overridesXml(b) +
        subs +
        `</bodytube>`
      );
    }
    case 'transition': {
      const t = c as Transition;
      const shape = t.shape && t.shape !== 'conical' ? t.shape : 'conical';
      const curveXml =
        shape !== 'conical'
          ? `<shapeparameter>${fmt(t.shapeParam ?? 1)}</shapeparameter>` +
            (t.clipped ? `<shapeclipped>true</shapeclipped>` : '')
          : '';
      return (
        `<transition>` +
        `<name>${esc(t.name)}</name>` +
        `<shape>${shape}</shape>` +
        curveXml +
        `<length>${fmt(t.length)}</length>` +
        `<foreradius>${fmt(t.foreRadius)}</foreradius>` +
        `<aftradius>${fmt(t.aftRadius)}</aftradius>` +
        `<thickness>${fmt(t.thickness)}</thickness>` +
        materialTag(t.density) +
        appearanceXml(t) +
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

interface StageExport {
  name: string;
  nodes: StackNode[];
  massOverride?: number;
  overrideSubcomponentsMass?: boolean;
}

function buildStagesFromRocket(rocket: RocketModel): { stages: StageExport[]; sideBodies?: SideBody[] } {
  if (!rocket.stages || rocket.stages.length <= 1) {
    const d = fromRocketModel(rocket);
    const s = rocket.stages?.[0];
    return {
      stages: [
        {
          name: s?.name || 'Sustainer',
          nodes: d.stack,
          massOverride: s?.massOverride,
          overrideSubcomponentsMass: s?.overrideSubcomponentsMass,
        },
      ],
      sideBodies: rocket.sideBodies,
    };
  }

  // Slice components by stage boundaries so multi-stage RocketModels preserve exact stages.
  const stages: StageExport[] = rocket.stages.map((st, idx) => {
    const slice = rocket.components.slice(st.startComponent, st.startComponent + st.componentCount);
    // Shift stations so the stage's first external component starts at x = 0, matching fromRocketModel's assumption.
    const firstExt = slice.find(isExternal);
    const baseX = firstExt ? firstExt.x : 0;
    const shifted = baseX !== 0 ? slice.map((c) => ({ ...c, x: c.x - baseX })) : slice;
    const subRocket: RocketModel = {
      name: rocket.name,
      components: shifted,
      length: rocket.length,
      maxRadius: rocket.maxRadius,
      stageCount: 1,
      warnings: [],
    };
    const subDesign = fromRocketModel(subRocket);
    return {
      name: st.name || (idx === 0 ? 'Sustainer' : `Booster ${idx}`),
      nodes: subDesign.stack,
      massOverride: st.massOverride,
      overrideSubcomponentsMass: st.overrideSubcomponentsMass,
    };
  });
  return { stages, sideBodies: rocket.sideBodies };
}

function buildStagesFromDesign(design: Design): { stages: StageExport[]; sideBodies?: SideBody[] } {
  const buckets: StackNode[][] = [[]];
  for (const node of design.stack) {
    if ((node.stage || (node.part.kind === 'bodytube' && node.part.isDecoupler)) && buckets[buckets.length - 1].length > 0) {
      buckets.push([]);
    }
    buckets[buckets.length - 1].push(node);
  }
  return {
    stages: buckets.map((nodes, idx) => {
      const info = nodes[0]?.stage;
      return {
        name: info?.name || (idx === 0 ? 'Sustainer' : `Booster ${idx}`),
        nodes,
        massOverride: info?.massOverride,
        overrideSubcomponentsMass: info?.overrideSubcomponentsMass,
      };
    }),
    sideBodies: design.sideBodies,
  };
}

/** Export a Design or RocketModel to OpenRocket XML text. */
export function exportOrkXml(input: Design | RocketModel): string {
  const rocketName = input.name || 'Rocket';
  const { stages, sideBodies } = isDesign(input)
    ? buildStagesFromDesign(input)
    : buildStagesFromRocket(input);

  // Attach any sideBodies to the first bodytube (or first stack node) so parser.ts reads them back.
  let sideTargetAssigned = false;
  const sideXml = (sideBodies ?? []).map(sideBodyXml).join('');
  let hasMotor = false;

  const stagesXml = stages
    .map((stage) => {
      const nodesXml = stage.nodes
        .map((node) => {
          if (node.children.some((ch) => ch.part.kind === 'innertube' && (ch.part as InnerTube).isMotorMount && (ch.part as InnerTube).motor)) {
            hasMotor = true;
          }
          let extra = '';
          if (sideXml && !sideTargetAssigned && (node.part.kind === 'bodytube' || stage.nodes.indexOf(node) === stage.nodes.length - 1)) {
            extra = sideXml;
            sideTargetAssigned = true;
          }
          return stackNodeXml(node, extra);
        })
        .join('');
      const stageMassXml =
        stage.massOverride !== undefined && stage.massOverride > 0
          ? `<overridemass>${fmt(stage.massOverride)}</overridemass>` +
            `<overridesubcomponentsmass>${stage.overrideSubcomponentsMass ? 'true' : 'false'}</overridesubcomponentsmass>`
          : '';
      return (
        `      <stage>\n` +
        `        <name>${esc(stage.name)}</name>\n` +
        (stageMassXml ? `        ${stageMassXml}\n` : '') +
        `        <subcomponents>${nodesXml}</subcomponents>\n` +
        `      </stage>`
      );
    })
    .join('\n');

  const motorConfigXml = hasMotor
    ? `    <motorconfiguration configid="${DEFAULT_CONFIG_ID}" default="true">\n` +
      stages.map((_, idx) => `      <stage number="${idx}" active="true"/>\n`).join('') +
      `    </motorconfiguration>\n`
    : '';

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<openrocket version="1.9" creator="Space Flight Builder">\n` +
    `  <rocket>\n` +
    `    <name>${esc(rocketName)}</name>\n` +
    motorConfigXml +
    `    <subcomponents>\n` +
    `${stagesXml}\n` +
    `    </subcomponents>\n` +
    `  </rocket>\n` +
    `</openrocket>\n`
  );
}

/** Export a Design or RocketModel as a standard zipped .ork file (Uint8Array). */
export async function exportOrkZip(input: Design | RocketModel): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('rocket.ork', exportOrkXml(input));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
