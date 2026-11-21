// Snap-point geometry and validity rules for Build Mode.
// Pure TypeScript — no DOM, no three.js.

import type { Component } from '../types';
import {
  addExternalPart,
  addInternalPart,
  aftRadiusOf,
  foreRadiusOf,
  innerRadiusOf,
  isExternal,
  type Design,
  type ExternalComponent,
  type InternalComponent,
} from './design';
import { createTransitionBetween, type AnchorMode } from './parts';

export type SnapKind = 'top' | 'bottom' | 'between' | 'inside';

export interface TransitionSuggestion {
  foreRadius: number;
  aftRadius: number;
  /** Where to insert the transition relative to the new part. */
  position: 'before' | 'after';
}

export interface SnapPoint {
  id: string;
  kind: SnapKind;
  label: string;
  /** Station from nose tip (m). Maps to 3D y = rocketLength - stationX. */
  stationX: number;
  /** Visual ring radius (m). */
  radius: number;
  /** For external parts: stack insertion index. */
  insertIndex?: number;
  /** For internal parts: target parent stack node id. */
  parentId?: string;
  /** True when diameters match (within tolerance) or internal part fits. */
  diameterMatch: boolean;
  /** Offered automatically when external diameters do not match. */
  needsTransition?: TransitionSuggestion;
  /** Human-readable note when diameters mismatch or fit is tight. */
  warning?: string;
}

const RADIUS_TOLERANCE = 0.0006; // 0.6 mm radial (1.2 mm diameter)

function radiiMatch(r1: number, r2: number): boolean {
  return Math.abs(r1 - r2) <= RADIUS_TOLERANCE;
}

function fmtDiaMm(r: number): string {
  return `${(r * 2000).toFixed(1)} mm`;
}

/** Compute resolved fore station of every node in design.stack. */
function stackStations(design: Design): number[] {
  const out: number[] = [];
  let cursor = 0;
  for (const node of design.stack) {
    out.push(cursor);
    cursor += node.part.length;
  }
  return out;
}

/**
 * Compute all valid snap points in `design` for placing `candidate`.
 */
export function computeSnapPoints(design: Design, candidate: Component): SnapPoint[] {
  const snaps: SnapPoint[] = [];
  const stations = stackStations(design);
  const totalLen =
    design.stack.length > 0
      ? stations[design.stack.length - 1] + design.stack[design.stack.length - 1].part.length
      : 0;

  if (isExternal(candidate)) {
    if (design.stack.length === 0) {
      snaps.push({
        id: 'snap-start',
        kind: 'top',
        label: 'Start rocket',
        stationX: 0,
        radius: Math.max(aftRadiusOf(candidate), foreRadiusOf(candidate), 0.014),
        insertIndex: 0,
        diameterMatch: true,
      });
      return snaps;
    }

    const first = design.stack[0].part;
    const candFore = foreRadiusOf(candidate);
    const candAft = aftRadiusOf(candidate);

    // 1. Top of stack (only if first part is not already a nose cone)
    if (first.kind !== 'nosecone') {
      const nextFore = foreRadiusOf(first);
      const match = candidate.kind === 'transition' ? radiiMatch(candAft, nextFore) : radiiMatch(candAft, nextFore);
      snaps.push({
        id: 'snap-top',
        kind: 'top',
        label: `Top of ${first.name}`,
        stationX: 0,
        radius: Math.max(nextFore, candAft, 0.012),
        insertIndex: 0,
        diameterMatch: match,
        ...(match
          ? {}
          : {
              needsTransition: { foreRadius: candAft, aftRadius: nextFore, position: 'after' },
              warning: `${fmtDiaMm(candAft)} vs ${fmtDiaMm(nextFore)}`,
            }),
      });
    }

    // Nose cones only go at the top of the stack.
    if (candidate.kind === 'nosecone') {
      return snaps;
    }

    // 2. Between two adjacent external parts
    for (let i = 1; i < design.stack.length; i++) {
      const prev = design.stack[i - 1].part;
      const next = design.stack[i].part;
      const prevAft = aftRadiusOf(prev);
      const nextFore = foreRadiusOf(next);
      const matchFore = radiiMatch(prevAft, candFore);
      const matchAft = radiiMatch(candAft, nextFore);
      const match = matchFore && matchAft;
      const suggestion: TransitionSuggestion | undefined = !matchFore
        ? { foreRadius: prevAft, aftRadius: candFore, position: 'before' }
        : !matchAft
          ? { foreRadius: candAft, aftRadius: nextFore, position: 'after' }
          : undefined;
      snaps.push({
        id: `snap-between-${i}`,
        kind: 'between',
        label: `Between ${prev.name} & ${next.name}`,
        stationX: stations[i],
        radius: Math.max(prevAft, nextFore, 0.012),
        insertIndex: i,
        diameterMatch: match,
        ...(suggestion
          ? {
              needsTransition: suggestion,
              warning: !matchFore
                ? `${fmtDiaMm(prevAft)} → ${fmtDiaMm(candFore)}`
                : `${fmtDiaMm(candAft)} → ${fmtDiaMm(nextFore)}`,
            }
          : {}),
      });
    }

    // 3. Bottom of stack
    const last = design.stack[design.stack.length - 1].part;
    const lastAft = aftRadiusOf(last);
    const matchBottom = radiiMatch(lastAft, candFore);
    snaps.push({
      id: 'snap-bottom',
      kind: 'bottom',
      label: `Bottom of ${last.name}`,
      stationX: totalLen,
      radius: Math.max(lastAft, candFore, 0.012),
      insertIndex: design.stack.length,
      diameterMatch: matchBottom,
      ...(matchBottom
        ? {}
        : {
            needsTransition: { foreRadius: lastAft, aftRadius: candFore, position: 'before' },
            warning: `${fmtDiaMm(lastAft)} → ${fmtDiaMm(candFore)}`,
          }),
    });

    return snaps;
  }

  // Internal / attached parts: fins, motor mounts, chutes, masses, rings.
  for (let i = 0; i < design.stack.length; i++) {
    const node = design.stack[i];
    const ext = node.part;

    // Fins attach to body tubes (or transitions).
    if (candidate.kind === 'finset') {
      if (ext.kind !== 'bodytube' && ext.kind !== 'transition') continue;
      snaps.push({
        id: `snap-inside-${node.id}`,
        kind: 'inside',
        label: `Attach to ${ext.name}`,
        stationX: stations[i] + Math.max(0, ext.length - candidate.rootChord / 2),
        radius: aftRadiusOf(ext) * 1.2,
        parentId: node.id,
        diameterMatch: true,
      });
      continue;
    }

    // Motor mounts and recovery go inside body tubes; side boosters mount outside body tubes.
    if (candidate.kind === 'innertube' || candidate.kind === 'parachute') {
      if (ext.kind !== 'bodytube') continue;
      const isSidePod = candidate.kind === 'innertube' && (candidate.radialCount ?? 0) >= 2;
      const innerR = innerRadiusOf(ext);
      const fits =
        isSidePod || candidate.kind !== 'innertube'
          ? true
          : candidate.outerRadius <= innerR + RADIUS_TOLERANCE;
      const stationX =
        candidate.kind === 'innertube'
          ? stations[i] + Math.max(0, ext.length - candidate.length / 2)
          : stations[i] + Math.min(ext.length * 0.3, ext.length);
      snaps.push({
        id: `snap-inside-${node.id}`,
        kind: 'inside',
        label: isSidePod ? `Mount on ${ext.name}` : `Inside ${ext.name}`,
        stationX,
        radius: aftRadiusOf(ext) * (isSidePod ? 1.35 : 1.15),
        parentId: node.id,
        diameterMatch: fits,
        ...(fits || candidate.kind !== 'innertube'
          ? {}
          : {
              warning: `Mount ${fmtDiaMm(candidate.outerRadius)} > tube ID ${fmtDiaMm(innerR)}`,
            }),
      });
      continue;
    }

    // Mass components and rings can go inside body tubes, nose cones, or transitions.
    const innerR = innerRadiusOf(ext);
    const fits =
      candidate.kind === 'ring' && !candidate.external
        ? candidate.outerRadius <= innerR + RADIUS_TOLERANCE
        : true;
    snaps.push({
      id: `snap-inside-${node.id}`,
      kind: 'inside',
      label: candidate.kind === 'ring' && candidate.external ? `On ${ext.name}` : `Inside ${ext.name}`,
      stationX: stations[i] + ext.length * 0.5,
      radius: Math.max(aftRadiusOf(ext) * 1.12, 0.012),
      parentId: node.id,
      diameterMatch: fits,
      ...(fits ? {} : { warning: `Ring wider than ${ext.name}` }),
    });
  }

  return snaps;
}

export interface ApplySnapOptions {
  addTransition?: boolean;
  anchor?: AnchorMode;
  offset?: number;
}

/**
 * Place `candidate` into `design` at the chosen `snap` point.
 * If `addTransition` is true and `snap.needsTransition` is set, inserts a bridging transition too.
 */
export function applySnap(
  design: Design,
  candidate: Component,
  snap: SnapPoint,
  opts: ApplySnapOptions = {},
): { design: Design; id: string } | null {
  if (isExternal(candidate)) {
    const idx = snap.insertIndex ?? design.stack.length;
    let d = design;
    if (opts.addTransition && snap.needsTransition) {
      const tr = createTransitionBetween(
        snap.needsTransition.foreRadius,
        snap.needsTransition.aftRadius,
      );
      if (snap.needsTransition.position === 'before') {
        d = addExternalPart(d, tr, idx).design;
        return addExternalPart(d, candidate as ExternalComponent, idx + 1);
      } else {
        const placed = addExternalPart(d, candidate as ExternalComponent, idx);
        const withTr = addExternalPart(placed.design, tr, idx + 1);
        return { design: withTr.design, id: placed.id };
      }
    }
    return addExternalPart(d, candidate as ExternalComponent, idx);
  }

  if (!snap.parentId) return null;
  return addInternalPart(
    design,
    snap.parentId,
    candidate as InternalComponent,
    opts.anchor,
    opts.offset,
  );
}
