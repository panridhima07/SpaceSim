// Force vector arrows for the flight view.
// Vectors are in whatever frame the group is placed in.

import * as THREE from 'three';

export interface ForceVectors {
  thrust: THREE.Vector3;
  drag: THREE.Vector3;
  normal: THREE.Vector3;
  weight: THREE.Vector3;
  /** Arrow length per newton, metres. */
  scale: number;
}

export interface ForceAnchors {
  cg: THREE.Vector3;
  cp: THREE.Vector3;
  nozzle: THREE.Vector3;
}

const MIN_FORCE = 1e-6;

const COLORS = {
  thrust: 0xff8a1f,
  drag: 0x9aa3ad,
  normal: 0xd23fd2,
  weight: 0x3fbf5a,
};

function makeArrow(color: number): THREE.ArrowHelper {
  const a = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, color);
  a.visible = false;
  return a;
}

function applyArrow(
  arrow: THREE.ArrowHelper,
  force: THREE.Vector3,
  scale: number,
  origin: THREE.Vector3,
): void {
  const mag = force.length();
  if (!(mag >= MIN_FORCE)) {
    arrow.visible = false;
    return;
  }
  const len = mag * scale;
  const headLength = Math.min(0.2 * len, 0.08);
  arrow.visible = true;
  arrow.position.copy(origin);
  arrow.setDirection(force.clone().normalize());
  arrow.setLength(len, headLength, headLength * 0.5);
}

export function buildForceArrows(): {
  group: THREE.Group;
  update(v: ForceVectors, anchors: ForceAnchors): void;
} {
  const group = new THREE.Group();
  group.name = 'force-arrows';

  const thrust = makeArrow(COLORS.thrust);
  const drag = makeArrow(COLORS.drag);
  const normal = makeArrow(COLORS.normal);
  const weight = makeArrow(COLORS.weight);
  group.add(thrust, drag, normal, weight);

  return {
    group,
    update(v, anchors) {
      applyArrow(thrust, v.thrust, v.scale, anchors.nozzle);
      applyArrow(drag, v.drag, v.scale, anchors.cp);
      applyArrow(normal, v.normal, v.scale, anchors.cp);
      applyArrow(weight, v.weight, v.scale, anchors.cg);
    },
  };
}
