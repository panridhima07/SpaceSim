// Decides which of the three designs (best / ok / bad) each component is drawn with.
// The grade comes only from what the design file says about the part: its shape,
// proportions, finish and fit. Nothing here changes a dimension.

import type { Component, FinSet, InnerTube, RocketModel } from '../../types';
import type { PartIconSet, PartTier } from './types';
import { AERO_ICONS } from './aero';
import { AIRFRAME_ICONS } from './airframe';
import { INTERNAL_ICONS } from './internals';

export type PartKindKey =
  | 'nosecone' | 'bodytube' | 'decoupler' | 'transition' | 'finset'
  | 'launchlug' | 'railbutton' | 'motor' | 'boosterpod'
  | 'innertube' | 'centeringring' | 'bulkhead' | 'tubecoupler' | 'mass' | 'parachute';

export const PART_ICONS: Record<PartKindKey, PartIconSet> = {
  ...AERO_ICONS,
  ...AIRFRAME_ICONS,
  ...INTERNAL_ICONS,
};

export const PART_LABELS: Record<PartKindKey, string> = {
  nosecone: 'Nose cone',
  bodytube: 'Body tube',
  decoupler: 'Decoupler',
  transition: 'Transition',
  finset: 'Fin set',
  launchlug: 'Launch lug',
  railbutton: 'Rail button',
  motor: 'Motor mount',
  boosterpod: 'Booster pod',
  innertube: 'Inner tube',
  centeringring: 'Centering ring',
  bulkhead: 'Bulkhead',
  tubecoupler: 'Tube coupler',
  mass: 'Mass',
  parachute: 'Recovery',
};

export interface GradeReason {
  /** 'good' and 'poor' shift the grade a step; one 'defect' makes the part bad. */
  effect: 'good' | 'poor' | 'defect';
  text: string;
}

export interface PartGrade {
  id: string;
  name: string;
  key: PartKindKey;
  tier: PartTier;
  reasons: GradeReason[];
  /** True when the part shows on the outside of the rocket. */
  external: boolean;
}

/** Which icon and label a component uses. */
export function partKey(c: Component): PartKindKey {
  switch (c.kind) {
    case 'nosecone': return 'nosecone';
    case 'bodytube': return c.isDecoupler ? 'decoupler' : 'bodytube';
    case 'transition': return 'transition';
    case 'finset': return 'finset';
    case 'innertube':
      if (isPod(c)) return 'boosterpod';
      return c.isMotorMount ? 'motor' : 'innertube';
    case 'ring':
      if (c.ringType === 'launchlug' || (c.external && c.ringType !== 'railbutton')) return 'launchlug';
      if (c.ringType === 'railbutton') return 'railbutton';
      if (c.ringType === 'tubecoupler' || c.ringType === 'shoulder') return 'tubecoupler';
      if (c.ringType === 'bulkhead' || !(c.innerRadius > 0)) return 'bulkhead';
      return 'centeringring';
    case 'mass': return 'mass';
    case 'parachute': return 'parachute';
  }
}

export function isPod(c: InnerTube): boolean {
  return !!c.radialCount && c.radialCount >= 2 && !!c.radialOffset && c.radialOffset > 0;
}

function isExternal(c: Component): boolean {
  switch (c.kind) {
    case 'nosecone': case 'bodytube': case 'transition': case 'finset': return true;
    case 'ring': return !!c.external;
    case 'innertube': return isPod(c) || c.isMotorMount;
    default: return false;
  }
}

const pct = (v: number): string => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const mm = (v: number): string => `${(v * 1000).toFixed(1)} mm`;

function finishReasons(c: Component, out: GradeReason[]): void {
  const f = (c.finish ?? '').toLowerCase();
  if (!f) return;
  if (f.includes('polish') || f === 'smooth' || f.includes('optimum') || f.includes('mirror')) {
    out.push({ effect: 'good', text: `${f} surface finish` });
  } else if (f.includes('rough') || f.includes('unfinished')) {
    out.push({ effect: 'poor', text: `${f} surface finish adds skin drag` });
  }
}

function gradeFins(c: FinSet, out: GradeReason[]): void {
  if (!(c.span > 0) || !(c.rootChord > 0)) {
    out.push({ effect: 'defect', text: 'fin has no span or no root chord' });
    return;
  }
  if (c.count < 3) out.push({ effect: 'defect', text: `${c.count} fin${c.count === 1 ? '' : 's'} cannot hold the rocket straight in every direction` });
  const cs = c.crossSection ?? 'rounded';
  if (cs === 'airfoil') out.push({ effect: 'good', text: 'airfoil section' });
  else if (cs === 'square') out.push({ effect: 'poor', text: 'square edges add drag' });
  const tc = c.thickness / c.rootChord;
  if (!(c.thickness > 0)) out.push({ effect: 'defect', text: 'fin has zero thickness' });
  else if (tc < 0.01) out.push({ effect: 'poor', text: `very thin (${pct(tc)} of chord), likely to flutter` });
  else if (tc > 0.15) out.push({ effect: 'poor', text: `very thick (${pct(tc)} of chord)` });
  if (c.filletRadius && c.filletRadius > 0) out.push({ effect: 'good', text: `root fillets (${mm(c.filletRadius)})` });
  if (c.tabHeight && c.tabHeight > 0) out.push({ effect: 'good', text: 'through-the-wall tabs' });
  if (c.bodyRadius > 0 && c.span > 6 * c.bodyRadius) {
    out.push({ effect: 'poor', text: `span is ${(c.span / (2 * c.bodyRadius)).toFixed(1)} body diameters, long and fragile` });
  }
  if (Math.abs(c.sweepLength) > 0 && c.sweepLength + c.tipChord > c.rootChord * 1.6) {
    out.push({ effect: 'poor', text: 'tips trail far behind the root and land first' });
  }
}

/** Grade one component. `rocket` supplies its neighbours. */
export function gradeComponent(c: Component, rocket: RocketModel): PartGrade {
  const reasons: GradeReason[] = [];
  const add = (effect: GradeReason['effect'], text: string): void => { reasons.push({ effect, text }); };

  switch (c.kind) {
    case 'nosecone': {
      if (!(c.length > 0) || !(c.baseRadius > 0)) { add('defect', 'no length or no base radius'); break; }
      const fineness = c.length / (2 * c.baseRadius);
      if (c.flipped) {
        if (fineness >= 1) add('good', 'tail cone cuts base drag');
      } else {
        if (c.shape === 'haack' || c.shape === 'ogive' || c.shape === 'parabolic') add('good', `${c.shape} profile`);
        else if (c.shape === 'conical') add('poor', 'plain conical profile');
        if (fineness < 1) add('defect', `blunt: only ${fineness.toFixed(1)} diameters long`);
        else if (fineness < 2) add('poor', `short: ${fineness.toFixed(1)} diameters long`);
        else if (fineness >= 3 && fineness <= 7) add('good', `${fineness.toFixed(1)}:1 fineness`);
        else if (fineness > 10) add('poor', `needle-like: ${fineness.toFixed(0)} diameters long`);
      }
      finishReasons(c, reasons);
      break;
    }
    case 'bodytube': {
      if (!(c.length > 0) || !(c.outerRadius > 0)) { add('defect', 'no length or no radius'); break; }
      const wall = c.thickness / c.outerRadius;
      if (!(c.thickness > 0)) add('poor', 'no wall thickness given');
      else if (wall < 0.008) add('poor', `paper-thin wall (${pct(wall)} of radius)`);
      else if (wall >= 0.02 && wall <= 0.12) add('good', `sound wall (${mm(c.thickness)})`);
      else if (wall > 0.3) add('poor', `very heavy wall (${pct(wall)} of radius)`);
      const ext = rocket.components.filter((k) => k.kind === 'nosecone' || k.kind === 'bodytube' || k.kind === 'transition');
      const i = ext.indexOf(c);
      const prev = ext[i - 1];
      if (prev) {
        const aft = prev.kind === 'nosecone' ? (prev.flipped ? 0 : prev.baseRadius) : prev.kind === 'bodytube' ? prev.outerRadius : prev.aftRadius;
        const step = Math.abs(aft - c.outerRadius);
        if (step > 0.02 * c.outerRadius) add('defect', `${mm(step)} step in radius where it meets "${prev.name}"`);
      }
      finishReasons(c, reasons);
      break;
    }
    case 'transition': {
      if (!(c.length > 0)) { add('defect', 'no length'); break; }
      const angle = Math.atan2(Math.abs(c.aftRadius - c.foreRadius), c.length) * (180 / Math.PI);
      if (angle > 35) add('defect', `abrupt ${angle.toFixed(0)}° step`);
      else if (angle > 18) add('poor', `steep ${angle.toFixed(0)}° taper`);
      else if (angle > 0 && angle <= 10) add('good', `gentle ${angle.toFixed(0)}° taper`);
      if (c.shape && c.shape !== 'conical') add('good', `${c.shape} curve`);
      finishReasons(c, reasons);
      break;
    }
    case 'finset':
      gradeFins(c, reasons);
      finishReasons(c, reasons);
      break;
    case 'innertube': {
      if (isPod(c)) { finishReasons(c, reasons); break; }
      if (!c.isMotorMount) break;
      const bore = Math.max(0, c.outerRadius - c.thickness) * 2;
      if (!c.motor) { add('poor', 'no motor selected'); break; }
      if (c.motor.diameter > 0 && bore > 0) {
        const gap = bore - c.motor.diameter;
        if (gap < -0.0005) add('defect', `motor (${mm(c.motor.diameter)}) is wider than the mount bore (${mm(bore)})`);
        else if (gap <= 0.0015) add('good', 'motor fits the mount closely');
        else if (gap > 0.004) add('poor', `motor rattles: ${mm(gap)} of play`);
      }
      if (c.motor.length > 0 && c.overhang > 0.5 * c.motor.length) add('poor', 'more than half the motor hangs out');
      if (c.motor.length > 0 && c.motor.length - c.overhang > c.length + 0.002) {
        add('poor', `motor is ${mm(c.motor.length - c.overhang - c.length)} longer than its mount`);
      } else if (c.motor.length > 0) add('good', 'mount supports the full motor');
      break;
    }
    case 'ring': {
      if (c.ringType === 'railbutton') { add('good', 'rail buttons guide better than lugs'); add('good', 'low drag'); break; }
      if (c.external) {
        if (!(c.length > 0)) { add('defect', 'no length'); break; }
        if (c.outerRadius > 0 && c.length < 4 * c.outerRadius) add('poor', 'short lug binds on the rod');
        break;
      }
      if (!(c.outerRadius > 0)) { add('defect', 'no radius'); break; }
      if (c.innerRadius >= c.outerRadius) add('defect', 'hole is as wide as the ring');
      if (c.ringType === 'centeringring' && c.length > 0 && c.length < 0.0008) add('poor', `only ${mm(c.length)} thick`);
      break;
    }
    case 'parachute': {
      if (!(c.diameter > 0)) add('defect', 'no canopy size');
      else if (c.cd >= 1.2) add('good', `high-drag canopy (Cd ${c.cd.toFixed(1)})`);
      else if (c.cd < 0.5) add('poor', `low-drag canopy (Cd ${c.cd.toFixed(1)})`);
      if (c.deployEvent === 'altitude') add('good', 'altitude-triggered deployment');
      break;
    }
    case 'mass':
      if (!(c.mass > 0)) add('poor', 'weighs nothing');
      break;
  }

  const defects = reasons.filter((r) => r.effect === 'defect').length;
  const net = reasons.filter((r) => r.effect === 'good').length - reasons.filter((r) => r.effect === 'poor').length;
  const tier: PartTier = defects > 0 || net <= -1 ? 'bad' : net >= 2 ? 'best' : 'ok';
  return { id: c.id, name: c.name, key: partKey(c), tier, reasons, external: isExternal(c) };
}

/** A side body's own parts as a small rocket, so they can be graded and drawn like any other. */
export function sideBodyModel(rocket: RocketModel, index: number): RocketModel {
  const sb = (rocket.sideBodies ?? [])[index];
  let maxRadius = 0;
  for (const c of sb.components) {
    if (c.kind === 'bodytube') maxRadius = Math.max(maxRadius, c.outerRadius);
    else if (c.kind === 'nosecone') maxRadius = Math.max(maxRadius, c.baseRadius);
    else if (c.kind === 'transition') maxRadius = Math.max(maxRadius, c.foreRadius, c.aftRadius);
  }
  return { name: sb.name, components: sb.components, length: rocket.length, maxRadius, stageCount: 1, warnings: rocket.warnings };
}

/**
 * Grade every component: the main stack in model order, then each side body's parts.
 * The first `rocket.components.length` entries line up with `rocket.components`.
 */
export function gradeRocket(rocket: RocketModel): PartGrade[] {
  const out = rocket.components.map((c) => gradeComponent(c, rocket));
  (rocket.sideBodies ?? []).forEach((sb, i) => {
    const sub = sideBodyModel(rocket, i);
    for (const c of sb.components) {
      const g = gradeComponent(c, sub);
      out.push({ ...g, name: `${sb.name}: ${c.name}${sb.count > 1 ? ` ×${sb.count}` : ''}` });
    }
  });
  return out;
}
