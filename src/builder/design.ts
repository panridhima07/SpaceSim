// Editable rocket design tree and pure operations.
// Pure TypeScript — no DOM, no three.js. Converts to/from src/types.ts RocketModel.

import type {
  BodyTube,
  Component,
  FinSet,
  Flaw,
  InnerTube,
  MassComponent,
  NoseCone,
  Parachute,
  Ring,
  RocketModel,
  StageBoundary,
  Transition,
} from '../types';
import type { AnchorMode } from './parts';

export type ExternalComponent = NoseCone | BodyTube | Transition;
export type InternalComponent = FinSet | InnerTube | Parachute | MassComponent | Ring;

export interface ChildNode {
  id: string;
  part: InternalComponent;
  anchor: AnchorMode;
  /** Axial offset in metres relative to the anchor (same convention as OpenRocket). */
  offset: number;
}

export interface StackNode {
  id: string;
  part: ExternalComponent;
  children: ChildNode[];
}

export interface Design {
  id: string;
  name: string;
  /** External components in fore-to-aft order. */
  stack: StackNode[];
  /** Monotonic counter for deterministic part IDs. */
  nextId: number;
  /** Boosters, pods and tube fins carried over from an imported file, unchanged. */
  sideBodies?: SideBody[];
}

export function isExternal(c: Component): c is ExternalComponent {
  return c.kind === 'nosecone' || c.kind === 'bodytube' || c.kind === 'transition';
}

export function isInternal(c: Component): c is InternalComponent {
  return !isExternal(c);
}

/** Deep-clone a component so mutations never leak across design states. */
function cloneComponent<T extends Component>(c: T): T {
  const copy = { ...c } as T;
  if (copy.kind === 'finset' && copy.points) {
    copy.points = copy.points.map(([a, r]) => [a, r] as [number, number]);
  }
  if (copy.kind === 'innertube' && copy.motor) {
    copy.motor = { ...copy.motor };
  }
  return copy;
}

function allocId(nextId: number): { id: string; nextId: number } {
  return { id: `p${nextId}`, nextId: nextId + 1 };
}

export function createEmptyDesign(name = 'New Rocket'): Design {
  return {
    id: `d_${Date.now().toString(36)}`,
    name,
    stack: [],
    nextId: 1,
  };
}

/** Outer radius at the fore end of an external component. */
export function foreRadiusOf(c: ExternalComponent): number {
  switch (c.kind) {
    case 'nosecone': return 0;
    case 'bodytube': return c.outerRadius;
    case 'transition': return c.foreRadius;
  }
}

/** Outer radius at the aft end of an external component. */
export function aftRadiusOf(c: ExternalComponent): number {
  switch (c.kind) {
    case 'nosecone': return c.baseRadius;
    case 'bodytube': return c.outerRadius;
    case 'transition': return c.aftRadius;
  }
}

/** Inner radius of an external component (for fitting internal parts). */
export function innerRadiusOf(c: ExternalComponent): number {
  switch (c.kind) {
    case 'nosecone': return Math.max(0, c.baseRadius - c.thickness);
    case 'bodytube': return Math.max(0, c.outerRadius - c.thickness);
    case 'transition': return Math.max(0, Math.max(c.foreRadius, c.aftRadius) - c.thickness);
  }
}

/**
 * Add an external part (nose cone, body tube, transition) to the stack.
 * If `index` is omitted, nose cones go to the front (0) if there isn't one already,
 * otherwise parts append to the aft end.
 */
export function addExternalPart(
  design: Design,
  part: ExternalComponent,
  index?: number,
): { design: Design; id: string } {
  const alloc = allocId(design.nextId);
  const cloned = cloneComponent(part);
  cloned.id = alloc.id;
  const node: StackNode = { id: alloc.id, part: cloned, children: [] };

  let insertAt: number;
  if (index !== undefined) {
    insertAt = Math.max(0, Math.min(design.stack.length, index));
  } else if (part.kind === 'nosecone' && (design.stack.length === 0 || design.stack[0].part.kind !== 'nosecone')) {
    insertAt = 0;
  } else {
    insertAt = design.stack.length;
  }

  const stack = [...design.stack];
  stack.splice(insertAt, 0, node);
  return {
    design: { ...design, stack, nextId: alloc.nextId },
    id: alloc.id,
  };
}

/**
 * Add an internal/attached part (fin set, motor mount, parachute, mass, ring)
 * to an external parent node.
 */
export function addInternalPart(
  design: Design,
  parentId: string,
  part: InternalComponent,
  anchor?: AnchorMode,
  offset?: number,
): { design: Design; id: string } | null {
  const parentIdx = design.stack.findIndex((s) => s.id === parentId);
  if (parentIdx === -1) return null;

  const alloc = allocId(design.nextId);
  const cloned = cloneComponent(part);
  cloned.id = alloc.id;

  const resolvedAnchor: AnchorMode =
    anchor ?? (cloned.kind === 'finset' || cloned.kind === 'innertube' ? 'bottom' : 'top');
  const resolvedOffset = offset ?? 0;

  const child: ChildNode = {
    id: alloc.id,
    part: cloned,
    anchor: resolvedAnchor,
    offset: resolvedOffset,
  };

  const stack = design.stack.map((node, i) =>
    i === parentIdx ? { ...node, children: [...node.children, child] } : node,
  );
  return {
    design: { ...design, stack, nextId: alloc.nextId },
    id: alloc.id,
  };
}

/** Remove any part (external stack node or internal child) by ID. */
export function removePart(design: Design, partId: string): Design {
  if (design.stack.some((s) => s.id === partId)) {
    return { ...design, stack: design.stack.filter((s) => s.id !== partId) };
  }
  return {
    ...design,
    stack: design.stack.map((s) =>
      s.children.some((c) => c.id === partId)
        ? { ...s, children: s.children.filter((c) => c.id !== partId) }
        : s,
    ),
  };
}

/** Move an external stack node to a new index. */
export function moveExternalPart(design: Design, partId: string, toIndex: number): Design {
  const fromIndex = design.stack.findIndex((s) => s.id === partId);
  if (fromIndex === -1) return design;
  const clamped = Math.max(0, Math.min(design.stack.length - 1, toIndex));
  if (fromIndex === clamped) return design;
  const stack = [...design.stack];
  const [moved] = stack.splice(fromIndex, 1);
  stack.splice(clamped, 0, moved);
  return { ...design, stack };
}

/** Duplicate an external node (including its children) or an internal child node. */
export function duplicatePart(design: Design, partId: string): { design: Design; id: string } | null {
  const stackIdx = design.stack.findIndex((s) => s.id === partId);
  if (stackIdx !== -1) {
    const src = design.stack[stackIdx];
    let nextId = design.nextId;
    const newParentAlloc = allocId(nextId);
    nextId = newParentAlloc.nextId;
    const parentPart = cloneComponent(src.part);
    parentPart.id = newParentAlloc.id;

    const children: ChildNode[] = src.children.map((ch) => {
      const ca = allocId(nextId);
      nextId = ca.nextId;
      const cp = cloneComponent(ch.part);
      cp.id = ca.id;
      return { ...ch, id: ca.id, part: cp };
    });

    const copyNode: StackNode = { id: newParentAlloc.id, part: parentPart, children };
    const stack = [...design.stack];
    stack.splice(stackIdx + 1, 0, copyNode);
    return { design: { ...design, stack, nextId }, id: newParentAlloc.id };
  }

  for (let i = 0; i < design.stack.length; i++) {
    const node = design.stack[i];
    const cIdx = node.children.findIndex((c) => c.id === partId);
    if (cIdx !== -1) {
      const src = node.children[cIdx];
      const alloc = allocId(design.nextId);
      const cp = cloneComponent(src.part);
      cp.id = alloc.id;
      const copyChild: ChildNode = { ...src, id: alloc.id, part: cp };
      const children = [...node.children];
      children.splice(cIdx + 1, 0, copyChild);
      const stack = design.stack.map((s, idx) => (idx === i ? { ...s, children } : s));
      return { design: { ...design, stack, nextId: alloc.nextId }, id: alloc.id };
    }
  }
  return null;
}

export interface PartPatch {
  part?: Partial<Component>;
  anchor?: AnchorMode;
  offset?: number;
}

/** Update properties on any external or internal part by ID. */
export function updatePart(design: Design, partId: string, patch: PartPatch): Design {
  let changed = false;
  const stack = design.stack.map((node) => {
    if (node.id === partId) {
      changed = true;
      const updated = { ...node.part, ...patch.part, id: node.id } as ExternalComponent;
      return { ...node, part: updated };
    }
    const cIdx = node.children.findIndex((c) => c.id === partId);
    if (cIdx !== -1) {
      changed = true;
      const children = node.children.map((ch, i) => {
        if (i !== cIdx) return ch;
        const updatedPart = { ...ch.part, ...patch.part, id: ch.id } as InternalComponent;
        if (updatedPart.kind === 'finset') {
          updatedPart.length = updatedPart.rootChord;
        }
        return {
          ...ch,
          part: updatedPart,
          anchor: patch.anchor ?? ch.anchor,
          offset: patch.offset ?? ch.offset,
        };
      });
      return { ...node, children };
    }
    return node;
  });
  return changed ? { ...design, stack } : design;
}

export interface FoundPart {
  part: Component;
  parentId: string | null;
  anchor?: AnchorMode;
  offset?: number;
  stackIndex: number;
}

export function findPart(design: Design, partId: string): FoundPart | null {
  for (let i = 0; i < design.stack.length; i++) {
    const node = design.stack[i];
    if (node.id === partId) {
      return { part: node.part, parentId: null, stackIndex: i };
    }
    for (const ch of node.children) {
      if (ch.id === partId) {
        return {
          part: ch.part,
          parentId: node.id,
          anchor: ch.anchor,
          offset: ch.offset,
          stackIndex: i,
        };
      }
    }
  }
  return null;
}

/** Resolve child fore station from its parent's resolved [x, x+length] and anchor/offset. */
function resolveChildX(parentX: number, parentLen: number, childLen: number, anchor: AnchorMode, offset: number): number {
  switch (anchor) {
    case 'bottom':
      return parentX + parentLen - childLen + offset;
    case 'middle':
      return parentX + (parentLen - childLen) / 2 + offset;
    case 'top':
    default:
      return parentX + offset;
  }
}

/** Convert an editable Design into the canonical RocketModel consumed by physics, mesh and flaws. */
export function toRocketModel(design: Design): RocketModel {
  const components: Component[] = [];
  const stageStarts: number[] = [0];
  let cursor = 0;
  let maxRadius = 0;
  let length = 0;

  for (const node of design.stack) {
    if (node.part.kind === 'bodytube' && node.part.isDecoupler && components.length > 0) {
      stageStarts.push(components.length);
    }

    const ext = cloneComponent(node.part);
    ext.id = node.id;
    ext.x = cursor;
    cursor += ext.length;

    components.push(ext);
    length = Math.max(length, ext.x + ext.length);
    switch (ext.kind) {
      case 'nosecone':
        maxRadius = Math.max(maxRadius, ext.baseRadius);
        break;
      case 'bodytube':
        maxRadius = Math.max(maxRadius, ext.outerRadius);
        break;
      case 'transition':
        maxRadius = Math.max(maxRadius, ext.foreRadius, ext.aftRadius);
        break;
    }

    const parentOuter = aftRadiusOf(ext);

    for (const ch of node.children) {
      const child = cloneComponent(ch.part);
      child.id = ch.id;
      if (child.kind === 'finset') {
        child.length = child.rootChord;
        child.bodyRadius = parentOuter;
      } else if (child.kind === 'innertube' && child.radialCount && child.radialCount >= 2) {
        child.radialOffset = parentOuter + child.outerRadius;
      }
      child.x = resolveChildX(ext.x, ext.length, child.length, ch.anchor, ch.offset);
      components.push(child);
      if (child.kind === 'finset') {
        length = Math.max(length, child.x + child.length);
      }
    }
  }

  let stages: StageBoundary[] | undefined;
  if (stageStarts.length > 1) {
    stages = stageStarts.map((startComponent, idx) => {
      const end = idx + 1 < stageStarts.length ? stageStarts[idx + 1] : components.length;
      const slice = components.slice(startComponent, end);
      const mount = slice.find((c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount);
      return {
        name: idx === 0 ? 'Sustainer' : `Booster ${idx}`,
        startComponent,
        componentCount: end - startComponent,
        ...(mount?.motor?.designation ? { motorDesignation: mount.motor.designation } : {}),
      };
    });
  }

  return {
    name: design.name || 'Untitled Rocket',
    components,
    length,
    maxRadius,
    stageCount: stages ? stages.length : 1,
    ...(stages ? { stages } : {}),
    warnings: [],
  };
}

/**
 * Convert any RocketModel (such as an imported .ork file) into an editable Design.
 * External parts become stack nodes in fore-to-aft order; internal parts attach to
 * the enclosing (or nearest) external part with exact offsets preserved.
 */
export function fromRocketModel(rocket: RocketModel): Design {
  const externals = rocket.components
    .filter(isExternal)
    .map((c) => cloneComponent(c))
    .sort((a, b) => a.x - b.x);
  const internals = rocket.components.filter(isInternal).map((c) => cloneComponent(c));

  let nextId = 1;
  const stack: StackNode[] = externals.map((ext) => {
    const alloc = allocId(nextId);
    nextId = alloc.nextId;
    ext.id = alloc.id;
    return { id: alloc.id, part: ext, children: [] };
  });

  // Compute resolved stations of the stack so offsets match the original rocket stations.
  const stations: { x: number; length: number }[] = [];
  let cursor = 0;
  for (const node of stack) {
    stations.push({ x: cursor, length: node.part.length });
    cursor += node.part.length;
  }

  for (const internal of internals) {
    if (stack.length === 0) break;
    const mid = internal.x + internal.length / 2;
    // Prefer a bodytube enclosing the midpoint, then any external enclosing the midpoint, then nearest.
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < stack.length; i++) {
      const st = stations[i];
      const inside = mid >= st.x - 1e-6 && mid <= st.x + st.length + 1e-6;
      const dist = inside
        ? 0
        : Math.min(Math.abs(mid - st.x), Math.abs(mid - (st.x + st.length)));
      const kindPenalty = stack[i].part.kind === 'bodytube' ? 0 : 0.001;
      const score = dist + kindPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) bestIdx = 0;

    const parent = stations[bestIdx];
    const anchor: AnchorMode =
      internal.kind === 'finset' || internal.kind === 'innertube' ? 'bottom' : 'top';
    const offset =
      anchor === 'bottom'
        ? internal.x - (parent.x + parent.length - internal.length)
        : internal.x - parent.x;

    const alloc = allocId(nextId);
    nextId = alloc.nextId;
    internal.id = alloc.id;
    stack[bestIdx].children.push({
      id: alloc.id,
      part: internal,
      anchor,
      offset,
    });
  }

  return {
    id: `d_${Date.now().toString(36)}`,
    name: rocket.name || 'Imported Rocket',
    stack,
    nextId,
  };
}

/**
 * Associate pre-flight or post-flight flaws with the part IDs in `design` that caused them,
 * so the builder can display flaw indicators right beside the relevant parts.
 */
export function mapFlawsToParts(flaws: Flaw[], design: Design): Map<string, Flaw[]> {
  const byPart = new Map<string, Flaw[]>();
  const add = (id: string, flaw: Flaw): void => {
    const list = byPart.get(id);
    if (list) list.push(flaw);
    else byPart.set(id, [flaw]);
  };

  const allParts: Component[] = [];
  for (const node of design.stack) {
    allParts.push(node.part);
    for (const ch of node.children) allParts.push(ch.part);
  }
  const finIds = allParts.filter((c) => c.kind === 'finset').map((c) => c.id);
  const chuteIds = allParts.filter((c) => c.kind === 'parachute').map((c) => c.id);
  const mountIds = allParts
    .filter((c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount)
    .map((c) => c.id);
  const noseIds = allParts.filter((c) => c.kind === 'nosecone').map((c) => c.id);

  for (const flaw of flaws) {
    if (flaw.id.startsWith('fin-flutter:')) {
      const targetId = flaw.id.slice('fin-flutter:'.length);
      if (allParts.some((c) => c.id === targetId)) {
        add(targetId, flaw);
        continue;
      }
    }
    if (
      flaw.id === 'unstable' ||
      flaw.id === 'overstable' ||
      flaw.id === 'static-stability' ||
      flaw.id === 'high-aoa'
    ) {
      const targets = finIds.length > 0 ? finIds : noseIds;
      for (const id of targets) add(id, flaw);
      continue;
    }
    if (flaw.id === 'no-deploy' || flaw.id === 'hard-landing' || flaw.id === 'deploy-speed') {
      for (const id of chuteIds) add(id, flaw);
      continue;
    }
    if (
      flaw.id === 'low-twr' ||
      flaw.id === 'static-twr' ||
      flaw.id === 'no-motor' ||
      flaw.id === 'static-no-motor' ||
      flaw.id === 'static-motor-fit' ||
      flaw.id === 'static-motor-length' ||
      flaw.id === 'rail-exit-slow'
    ) {
      for (const id of mountIds) add(id, flaw);
      continue;
    }
  }
  return byPart;
}
