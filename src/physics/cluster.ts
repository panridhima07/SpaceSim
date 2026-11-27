// Which motors a rocket fires together: clusters, pods, strap-on boosters and stages.

import type { Component, InnerTube, RocketModel } from '../types';

export interface MountedMotors {
  /** The tube holding them; null when the rocket has no motor mount (one motor at the aft end). */
  mount: InnerTube | null;
  count: number;
}

/** How many identical tubes this one stands for: a cluster, a ring of pods, or both. */
export function tubeCopies(tube: InnerTube): number {
  const cluster = tube.cluster && tube.cluster.length > 1 ? tube.cluster.length : 1;
  const ring = tube.radialCount && tube.radialCount >= 2 ? Math.round(tube.radialCount) : 1;
  return cluster * ring;
}

const isMount = (c: Component): c is InnerTube => c.kind === 'innertube' && c.isMotorMount;

/**
 * The motors that light together, and where they sit. In a staged rocket only the bottom stage
 * still attached fires (spent stages are removed from `components`). Further mounts, in the stage
 * or in strap-on boosters, count when they name the same motor as the first one: the simulator
 * flies one thrust curve at a time.
 */
export function firingMotors(rocket: RocketModel): MountedMotors[] {
  const stages = rocket.stages;
  let start = 0;
  if (stages && stages.length > 1) {
    for (const s of stages) {
      if (s.startComponent < rocket.components.length) start = Math.max(start, s.startComponent);
    }
  }
  const own = rocket.components.slice(start);
  const mounts = own.filter(isMount);
  const primary = mounts[0];
  if (!primary) return [{ mount: null, count: 1 }];
  const out: MountedMotors[] = [{ mount: primary, count: tubeCopies(primary) }];
  const name = primary.motor?.designation;
  if (!name) return out;
  for (const m of mounts.slice(1)) {
    if (m.motor?.designation === name) out.push({ mount: m, count: tubeCopies(m) });
  }
  const fore = start > 0 ? Math.min(...own.map((c) => c.x)) : -Infinity;
  for (const side of rocket.sideBodies ?? []) {
    for (const m of side.components.filter(isMount)) {
      if (m.motor?.designation === name && m.x >= fore) {
        out.push({ mount: m, count: tubeCopies(m) * Math.max(1, Math.round(side.count) || 1) });
      }
    }
  }
  return out;
}

export function motorCount(rocket: RocketModel): number {
  return firingMotors(rocket).reduce((n, m) => n + m.count, 0);
}
