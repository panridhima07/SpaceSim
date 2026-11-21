// Gallery of every part design: one row per kind, one column per tier.
// Each cell is a still rendered once from a shared WebGL renderer.

import * as THREE from 'three';
import type { Component, RocketModel } from '../types';
import { buildRocketMesh, disposeGroup } from '../render/rocketMesh';
import { PART_ICONS, PART_LABELS, partKey, type PartKindKey } from '../render/parts/grade';
import { PART_TIERS, type PartTier } from '../render/parts/types';

const R = 0.025;
const base = { id: 'p', name: 'part', density: 0 };

/** A one-part rocket per kind, sized like a mid-power model. */
const SAMPLES: { key: PartKindKey; part: Component; cutaway?: boolean; with?: Component[] }[] = [
  { key: 'nosecone', part: { ...base, kind: 'nosecone', x: 0, length: 0.12, shape: 'ogive', shapeParam: 1, baseRadius: R, thickness: 0.002 } },
  { key: 'bodytube', part: { ...base, kind: 'bodytube', x: 0, length: 0.14, outerRadius: R, thickness: 0.002 } },
  { key: 'decoupler', part: { ...base, kind: 'bodytube', x: 0, length: 0.05, outerRadius: R, thickness: 0.002, isDecoupler: true } },
  { key: 'transition', part: { ...base, kind: 'transition', x: 0, length: 0.08, foreRadius: 0.015, aftRadius: R, thickness: 0.002 } },
  {
    key: 'finset',
    part: { ...base, kind: 'finset', x: 0.04, length: 0.08, count: 3, rootChord: 0.08, tipChord: 0.04, span: 0.06, sweepLength: 0.035, thickness: 0.004, cant: 0, bodyRadius: R, finShape: 'trapezoid', crossSection: 'airfoil', filletRadius: 0.004 },
    with: [{ ...base, id: 'b', kind: 'bodytube', x: 0, length: 0.13, outerRadius: R, thickness: 0.002 }],
  },
  {
    key: 'launchlug',
    part: { ...base, kind: 'ring', x: 0.02, length: 0.04, outerRadius: 0.005, innerRadius: 0.004, external: true, ringType: 'launchlug', mountRadius: R },
    with: [{ ...base, id: 'b', kind: 'bodytube', x: 0, length: 0.08, outerRadius: R, thickness: 0.002 }],
  },
  {
    key: 'railbutton',
    part: { ...base, kind: 'ring', x: 0.03, length: 0.012, outerRadius: 0.008, innerRadius: 0.005, external: true, ringType: 'railbutton', mountRadius: R },
    with: [{ ...base, id: 'b', kind: 'bodytube', x: 0, length: 0.08, outerRadius: R, thickness: 0.002 }],
  },
  { key: 'motor', part: { ...base, kind: 'innertube', x: 0, length: 0.07, outerRadius: 0.0125, thickness: 0.0005, isMotorMount: true, overhang: 0.005, motor: { manufacturer: 'Estes', designation: 'D12', diameter: 0.024, length: 0.07, delay: 5 } } },
  { key: 'boosterpod', part: { ...base, kind: 'innertube', x: 0.05, length: 0.12, outerRadius: 0.012, thickness: 0.001, isMotorMount: false, overhang: 0, radialCount: 2, radialOffset: 0.03 } },
  { key: 'innertube', cutaway: true, part: { ...base, kind: 'innertube', x: 0, length: 0.09, outerRadius: 0.0125, thickness: 0.001, isMotorMount: false, overhang: 0 } },
  { key: 'centeringring', cutaway: true, part: { ...base, kind: 'ring', x: 0, length: 0.004, outerRadius: R, innerRadius: 0.0125, ringType: 'centeringring' } },
  { key: 'bulkhead', cutaway: true, part: { ...base, kind: 'ring', x: 0, length: 0.005, outerRadius: R, innerRadius: 0, ringType: 'bulkhead' } },
  { key: 'tubecoupler', cutaway: true, part: { ...base, kind: 'ring', x: 0, length: 0.05, outerRadius: 0.024, innerRadius: 0.0225, ringType: 'tubecoupler' } },
  { key: 'mass', cutaway: true, part: { ...base, kind: 'mass', x: 0, length: 0.03, mass: 0.05 } },
  { key: 'parachute', cutaway: true, part: { ...base, kind: 'parachute', x: 0, length: 0.06, diameter: 0.4, cd: 0.8, deployEvent: 'apogee', deployAltitude: 0, deployDelay: 0, mass: 0.02 } },
];

const W = 440;
const H = 300;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H, false);
renderer.setClearColor(0x0d1522, 1);

function still(sample: (typeof SAMPLES)[number], tier: PartTier): string {
  const parts = [...(sample.with ?? []), sample.part];
  const rocket: RocketModel = {
    name: sample.key, components: parts, length: 0.15, maxRadius: R, stageCount: 1, warnings: [],
  };
  // Supporting parts stay plain so the part under review stands out.
  const tiers: Record<string, PartTier> = { [sample.part.id]: tier };
  for (const w of sample.with ?? []) tiers[w.id] = 'ok';
  const group = buildRocketMesh(rocket, { tiers });
  if (sample.cutaway) {
    disposeGroup(group);
    group.clear();
    group.add(...buildRocketMesh(rocket, { cutaway: true, tiers }).children);
  }

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(2, 3, 4);
  scene.add(sun, group);

  const box = new THREE.Box3().setFromObject(group);
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 0.1;
  const cam = new THREE.PerspectiveCamera(30, W / H, size / 100, size * 20);
  // Motors and rings read best from below and behind; everything else from the side.
  const fromAft = sample.key === 'motor' || sample.key === 'bulkhead' || sample.key === 'centeringring';
  const dir = fromAft ? new THREE.Vector3(0.9, sample.key === 'motor' ? -1.1 : 1.1, 1.2) : new THREE.Vector3(1.6, 0.45, 1.2);
  cam.position.copy(centre).addScaledVector(dir.normalize(), size * 2.0);
  cam.up.set(0, 1, 0);
  cam.lookAt(centre);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');
  disposeGroup(group);
  return url;
}

const grid = document.getElementById('grid') as HTMLTableElement;
const head = grid.insertRow();
head.innerHTML = '<th>Part</th><th class="best">Best</th><th class="ok">OK</th><th class="bad">Bad</th>';

for (const sample of SAMPLES) {
  const row = grid.insertRow();
  const kind = row.insertCell();
  kind.className = 'kind';
  kind.textContent = PART_LABELS[sample.key];
  if (partKey(sample.part) !== sample.key) kind.textContent += ' (key mismatch)';
  for (const tier of PART_TIERS) {
    const cell = row.insertCell();
    const wrap = document.createElement('div');
    wrap.className = 'cell';
    const img = document.createElement('img');
    img.alt = `${PART_LABELS[sample.key]}, ${tier} design`;
    img.src = still(sample, tier);
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = PART_ICONS[sample.key][tier]; // static SVG from the part modules
    const small = icon.cloneNode(true) as HTMLElement;
    small.classList.add('small');
    wrap.append(img, icon, small);
    cell.append(wrap);
  }
}
