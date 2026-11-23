// Builds three.js geometry for a staged orbital launch vehicle (LauncherSpec).
//
// Local frame: vehicle axis along +Y, nose pointing +Y, origin at the base of
// the first core stage. Units are metres.
//
// Look: smooth-shaded PBR surfaces with a procedural livery per stage (panel seams, ring frames,
// roll-pattern blocks and a dark band), bell-shaped engine nozzles with a metallic finish,
// ogive booster noses with attach struts, and interstage rings. Everything stays inside the
// stage outlines the physics uses, so separation and plume placement are unchanged.

import * as THREE from 'three';

export interface LauncherStage {
  name: string;
  length: number;        // m
  radius: number;        // m
  engineCount: number;
  /** Present on strap-on boosters: `count` copies around the first core stage. */
  parallel?: { count: number; radialOffset: number; attachStation: number; phase?: number };
}

export interface LauncherSpec {
  name: string;
  /** Core stages from the bottom up, plus strap-on boosters (those with `parallel`), in any order. */
  stages: LauncherStage[];
  payload: { length: number; radius?: number };
  fairing?: { length: number; radius: number; noseLength?: number };
}

export interface LauncherMesh {
  /** Everything. Add this to the scene. */
  group: THREE.Group;
  /** One group per entry of spec.stages, same index. A booster stage's
      group has one direct child per booster. */
  stageGroups: THREE.Group[];
  /** [left half, right half], or null when the spec has no fairing. */
  fairingHalves: [THREE.Group, THREE.Group] | null;
  payload: THREE.Group;
  /** Height from y = 0 to the tip of the nose, m. */
  totalLength: number;
}

export interface LauncherState {
  /** Same length and index as spec.stages. false = separated, hide it. */
  stagesAttached: boolean[];
  fairingAttached: boolean;
}

const COLORS = {
  coreA: 0xf4f3ee,
  coreB: 0xe9e6dc,
  booster: 0xd9dcdf,
  nozzle: 0x3a3f47,
  nozzleHot: 0x8a5a3a,
  fairing: 0xfbfbf8,
  payload: 0xd4a438,
  band: 0x22262d,
  base: 0x2a2d33,
  ring: 0xbfc3c8,
  strut: 0x8d939b,
} as const;

const RADIAL_SEGMENTS = 48;
const NOSE_POINTS = 32;

interface MaterialSet {
  stage: (index: number, length: number, radius: number, kind: 'core' | 'booster' | 'upper') => THREE.MeshStandardMaterial;
  nozzle: THREE.MeshStandardMaterial;
  base: THREE.MeshStandardMaterial;
  ring: THREE.MeshStandardMaterial;
  strut: THREE.MeshStandardMaterial;
  fairing: THREE.MeshStandardMaterial;
  payload: THREE.MeshStandardMaterial;
  booster: THREE.MeshStandardMaterial;
}

function canvasAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return !!c.getContext && c.getContext('2d') !== null;
  } catch {
    return false;
  }
}

/**
 * Livery texture for one stage: u wraps around the body, v runs bottom (0) to top (1).
 * Draws panel seams every ~2 m, darker frame rings, black roll-pattern blocks near the top
 * of the first stage and a thin dark band at the top of every stage.
 */
function liveryTexture(
  length: number,
  radius: number,
  base: number,
  opts: { rollBlocks: boolean; band: boolean; foam: boolean },
): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const w = 512;
  const h = Math.min(2048, Math.max(256, Math.round((length / (2 * Math.PI * radius)) * w)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const c = new THREE.Color(base);
  ctx.fillStyle = `#${c.getHexString()}`;
  ctx.fillRect(0, 0, w, h);
  const pxPerM = h / length;

  // Subtle large-scale tonal variation, then fine grain.
  for (let i = 0; i < 40; i++) {
    const y = (i / 40) * h;
    ctx.fillStyle = `rgba(0,0,0,${0.012 + 0.018 * Math.abs(Math.sin(i * 12.9898) % 1)})`;
    ctx.fillRect(0, y, w, h / 40 + 1);
  }
  if (opts.foam) {
    // Cryogenic insulation: warm off-white with faint diagonal spray texture.
    ctx.fillStyle = 'rgba(210,190,150,0.18)';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 1500; i++) {
      const x = (Math.sin(i * 91.7) * 0.5 + 0.5) * w;
      const y = (Math.sin(i * 47.3 + 1.1) * 0.5 + 0.5) * h;
      ctx.fillStyle = `rgba(120,100,70,${0.04 + 0.04 * ((i * 7) % 3)})`;
      ctx.fillRect(x, y, 6, 2);
    }
  }

  // Vertical panel seams.
  const seams = Math.max(8, Math.round((2 * Math.PI * radius) / 1.6));
  ctx.fillStyle = 'rgba(40,45,55,0.18)';
  for (let i = 0; i < seams; i++) ctx.fillRect((i / seams) * w, 0, 1.2, h);

  // Horizontal ring frames every ~2 m, slightly heavier every ~6 m.
  for (let m = 0, k = 0; m < length; m += 2, k++) {
    const y = h - m * pxPerM;
    ctx.fillStyle = k % 3 === 0 ? 'rgba(30,35,45,0.32)' : 'rgba(40,45,55,0.16)';
    ctx.fillRect(0, y, w, k % 3 === 0 ? 2.5 : 1.3);
  }

  if (opts.rollBlocks) {
    // Roll-pattern: four black blocks just under the top, alternating quadrants.
    const bh = Math.min(3.2, length * 0.12) * pxPerM;
    const y0 = h - (length - 1.5) * pxPerM;
    ctx.fillStyle = '#1b1e23';
    for (let q = 0; q < 4; q += 2) ctx.fillRect((q / 4) * w, y0, w / 4, bh);
    ctx.fillRect((1 / 4) * w, y0 + bh, w / 4, bh);
    ctx.fillRect((3 / 4) * w, y0 + bh, w / 4, bh);
  }
  if (opts.band) {
    ctx.fillStyle = `#${new THREE.Color(COLORS.band).getHexString()}`;
    ctx.fillRect(0, h - (length - 0.25) * pxPerM, w, 0.35 * pxPerM);
    ctx.fillRect(0, h - 0.6 * pxPerM, w, 0.25 * pxPerM);
  }
  // Lengthwise cable raceway on one side.
  ctx.fillStyle = 'rgba(90,95,105,0.55)';
  ctx.fillRect(w * 0.125 - 4, 0, 8, h);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(w * 0.125 - 4, 0, 2, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function makeMaterial(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.42,
    metalness: 0.08,
    ...opts,
  });
}

function createMaterials(): MaterialSet {
  const booster = makeMaterial(COLORS.booster, { roughness: 0.5 });
  return {
    stage(index, length, radius, kind) {
      const color = kind === 'booster' ? COLORS.booster : index % 2 === 0 ? COLORS.coreA : COLORS.coreB;
      const map = liveryTexture(length, radius, color, {
        rollBlocks: index === 0 && kind === 'core',
        band: kind !== 'booster',
        foam: kind === 'upper',
      });
      return makeMaterial(map ? 0xffffff : color, {
        map,
        roughness: kind === 'upper' ? 0.62 : 0.4,
        metalness: kind === 'booster' ? 0.12 : 0.06,
      });
    },
    nozzle: makeMaterial(COLORS.nozzle, { roughness: 0.32, metalness: 0.85, side: THREE.DoubleSide }),
    base: makeMaterial(COLORS.base, { roughness: 0.85, metalness: 0.2 }),
    ring: makeMaterial(COLORS.ring, { roughness: 0.3, metalness: 0.6 }),
    strut: makeMaterial(COLORS.strut, { roughness: 0.4, metalness: 0.7 }),
    fairing: makeMaterial(COLORS.fairing, { roughness: 0.35, metalness: 0.04, side: THREE.DoubleSide }),
    payload: makeMaterial(COLORS.payload, { roughness: 0.3, metalness: 0.6 }),
    booster,
  };
}

/** Bell-nozzle profile for LatheGeometry: throat at the top (y = height), exit at y = 0. */
function bellProfile(exitRadius: number, height: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const throat = exitRadius * 0.34;
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const s = i / n; // 0 = exit, 1 = throat
    // Parabolic bell: fast flare near the throat, nearly straight near the exit.
    const r = throat + (exitRadius - throat) * Math.pow(1 - s, 0.62);
    pts.push(new THREE.Vector2(r, s * height * 0.86));
  }
  // Short converging section / combustion chamber above the throat.
  pts.push(new THREE.Vector2(throat * 1.25, height * 0.93));
  pts.push(new THREE.Vector2(throat * 1.35, height));
  return pts;
}

function addNozzles(
  parent: THREE.Group,
  baseY: number,
  stageRadius: number,
  engineCount: number,
  mats: MaterialSet,
): void {
  if (engineCount <= 0) return;

  const nozzleHeight = 0.6 * stageRadius;
  const nozzleRadius = engineCount === 1 ? 0.32 * stageRadius : 0.24 * stageRadius;
  const ringRadius = 0.5 * stageRadius;

  const bellGeom = new THREE.LatheGeometry(bellProfile(nozzleRadius, nozzleHeight), 28);
  // Exit lip: a thin torus that catches the light.
  const lipGeom = new THREE.TorusGeometry(nozzleRadius, nozzleRadius * 0.035, 6, 28);
  lipGeom.rotateX(Math.PI / 2);
  for (let i = 0; i < engineCount; i++) {
    const engine = new THREE.Group();
    const bell = new THREE.Mesh(bellGeom, mats.nozzle);
    bell.castShadow = true;
    const lip = new THREE.Mesh(lipGeom, mats.ring);
    engine.add(bell, lip);
    const y = baseY - nozzleHeight;
    if (engineCount === 1) {
      engine.position.set(0, y, 0);
    } else {
      const angle = (2 * Math.PI * i) / engineCount;
      engine.position.set(ringRadius * Math.cos(angle), y, ringRadius * Math.sin(angle));
    }
    parent.add(engine);
  }
}

/** Closed cylinder with livery on the side, a dark heat shield underneath and a plain top cap. */
function stageBody(
  radius: number,
  length: number,
  side: THREE.Material,
  base: THREE.Material,
  top: THREE.Material,
): THREE.Mesh {
  const geom = new THREE.CylinderGeometry(radius, radius, length, RADIAL_SEGMENTS, 1);
  const mesh = new THREE.Mesh(geom, [side, top, base]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildBoosterStage(
  stage: LauncherStage,
  mats: MaterialSet,
  coreRadius: number,
  boosterIndex: number,
): THREE.Group {
  const stageGroup = new THREE.Group();
  stageGroup.name = stage.name;

  const parallel = stage.parallel;
  if (!parallel) return stageGroup;

  const coneHeight = Math.min(stage.length, 2.4 * stage.radius);
  const cylHeight = Math.max(0, stage.length - coneHeight);
  const sideMat = mats.stage(boosterIndex, Math.max(cylHeight, 1), stage.radius, 'booster');

  // One cylinder + nose shared by every booster of the stage.
  const cylGeom =
    cylHeight > 0
      ? new THREE.CylinderGeometry(stage.radius, stage.radius, cylHeight, RADIAL_SEGMENTS)
      : null;
  const noseGeom = coneHeight > 0 ? new THREE.LatheGeometry(buildOgiveProfile(stage.radius, coneHeight), RADIAL_SEGMENTS) : null;
  const skirtGeom = new THREE.CylinderGeometry(stage.radius * 1.04, stage.radius * 1.12, Math.min(1.2, cylHeight * 0.08), RADIAL_SEGMENTS, 1, true);

  for (let k = 0; k < parallel.count; k++) {
    const angle = (parallel.phase ?? 0) + (2 * Math.PI * k) / parallel.count;
    const x = parallel.radialOffset * Math.cos(angle);
    const z = parallel.radialOffset * Math.sin(angle);

    const booster = new THREE.Group();
    booster.name = `${stage.name}-${k}`;
    booster.position.set(x, parallel.attachStation, z);

    if (cylGeom) {
      const cylMesh = new THREE.Mesh(cylGeom, [sideMat, mats.base, mats.base]);
      cylMesh.position.y = cylHeight / 2;
      cylMesh.castShadow = cylMesh.receiveShadow = true;
      booster.add(cylMesh);
      const skirt = new THREE.Mesh(skirtGeom, mats.ring);
      skirt.position.y = Math.min(1.2, cylHeight * 0.08) / 2;
      booster.add(skirt);
    }

    if (noseGeom) {
      const nose = new THREE.Mesh(noseGeom, mats.booster);
      nose.position.y = cylHeight;
      nose.castShadow = true;
      booster.add(nose);
    }

    // Attach struts toward the core, at the forward and aft attach points.
    const gap = parallel.radialOffset - stage.radius - coreRadius;
    if (gap > 0.05) {
      const strutGeom = new THREE.CylinderGeometry(0.09 * stage.radius, 0.09 * stage.radius, gap + 0.3, 8);
      strutGeom.rotateZ(Math.PI / 2);
      for (const yy of [0.12 * stage.length, Math.max(0.2 * stage.length, cylHeight - 0.6)]) {
        const strut = new THREE.Mesh(strutGeom, mats.strut);
        // Booster-local: point back at the core axis.
        const dir = new THREE.Vector3(-Math.cos(angle), 0, -Math.sin(angle));
        strut.position.copy(dir).multiplyScalar(stage.radius + gap / 2);
        strut.position.y = yy;
        strut.rotation.y = -angle;
        booster.add(strut);
      }
    }

    addNozzles(booster, 0, stage.radius, stage.engineCount, mats);
    stageGroup.add(booster);
  }

  return stageGroup;
}

function buildOgiveProfile(radius: number, length: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const rho = (radius * radius + length * length) / (2 * radius);
  for (let i = 0; i < NOSE_POINTS; i++) {
    // s = length at base (y = 0), s = 0 at tip (y = length)
    const y = (length * i) / (NOSE_POINTS - 1);
    const s = length - y;
    const r = Math.sqrt(Math.max(0, rho * rho - (length - s) * (length - s))) + radius - rho;
    pts.push(new THREE.Vector2(Math.max(0, r), y));
  }
  // Blunt the tip slightly so it does not shade as a needle.
  const tip = pts[pts.length - 1];
  tip.x = 0;
  return pts;
}

function buildFairingHalf(
  name: string,
  baseY: number,
  radius: number,
  cylLength: number,
  noseLength: number,
  phiStart: number,
  material: THREE.MeshStandardMaterial,
  seamMat: THREE.MeshStandardMaterial,
): THREE.Group {
  const half = new THREE.Group();
  half.name = name;

  if (cylLength > 0) {
    const cylGeom = new THREE.CylinderGeometry(
      radius,
      radius,
      cylLength,
      RADIAL_SEGMENTS / 2,
      1,
      false,
      phiStart,
      Math.PI,
    );
    const cylMesh = new THREE.Mesh(cylGeom, material);
    cylMesh.position.y = baseY + cylLength / 2;
    cylMesh.castShadow = true;
    half.add(cylMesh);
    // Separation rail along the split line, and a ring at the base.
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, cylLength * 0.98, 0.12), seamMat);
    rail.position.set(Math.sin(phiStart) * radius, baseY + cylLength / 2, Math.cos(phiStart) * radius);
    half.add(rail);
  }

  if (noseLength > 0) {
    const profile = buildOgiveProfile(radius, noseLength);
    const noseGeom = new THREE.LatheGeometry(profile, RADIAL_SEGMENTS / 2, phiStart, Math.PI);
    const noseMesh = new THREE.Mesh(noseGeom, material);
    noseMesh.position.y = baseY + cylLength;
    noseMesh.castShadow = true;
    half.add(noseMesh);
  }

  return half;
}

export function buildLauncherMesh(spec: LauncherSpec): LauncherMesh {
  const group = new THREE.Group();
  group.name = spec.name;

  const mats = createMaterials();
  const stageGroups: THREE.Group[] = [];

  const firstCore = spec.stages.find((s) => !s.parallel);
  const coreRadius = firstCore?.radius ?? 1;
  const coreCount = spec.stages.filter((s) => !s.parallel).length;

  let coreTopY = 0;
  let coreIndex = 0;
  let boosterIndex = 0;
  let lastCoreRadius = 1;

  for (const stage of spec.stages) {
    if (stage.parallel) {
      const boosterGroup = buildBoosterStage(stage, mats, coreRadius, boosterIndex++);
      stageGroups.push(boosterGroup);
      group.add(boosterGroup);
    } else {
      const stageGroup = new THREE.Group();
      stageGroup.name = stage.name;

      const isUpper = coreIndex > 0 && coreIndex === coreCount - 1;
      const side = mats.stage(coreIndex, stage.length, stage.radius, isUpper ? 'upper' : 'core');
      const body = stageBody(stage.radius, stage.length, side, mats.base, mats.ring);
      body.position.y = coreTopY + stage.length / 2;
      stageGroup.add(body);

      // Interstage / frame ring just below the top of the stage (kept inside the stage length).
      const ringH = Math.min(0.5, stage.length * 0.04);
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(stage.radius * 1.015, stage.radius * 1.015, ringH, RADIAL_SEGMENTS, 1, true),
        mats.ring,
      );
      ring.position.y = coreTopY + stage.length - ringH / 2 - 0.03;
      stageGroup.add(ring);
      // Narrower upper stage: a conical adapter on top of this stage's body.
      const next = spec.stages.slice(spec.stages.indexOf(stage) + 1).find((s) => !s.parallel);
      if (next && next.radius < stage.radius - 0.05) {
        const h = Math.min(stage.length * 0.15, (stage.radius - next.radius) * 1.6);
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(next.radius, stage.radius, h, RADIAL_SEGMENTS, 1, true), side);
        cone.position.y = coreTopY + stage.length - h / 2;
        stageGroup.add(cone);
      }

      addNozzles(stageGroup, coreTopY, stage.radius, stage.engineCount, mats);

      coreTopY += stage.length;
      lastCoreRadius = stage.radius;
      coreIndex++;

      stageGroups.push(stageGroup);
      group.add(stageGroup);
    }
  }

  // Payload
  const payload = new THREE.Group();
  payload.name = 'payload';
  const payloadRadius = spec.payload.radius ?? 0.8 * lastCoreRadius;
  const payloadGeom = new THREE.CylinderGeometry(
    payloadRadius,
    payloadRadius,
    spec.payload.length,
    RADIAL_SEGMENTS,
  );
  const payloadMesh = new THREE.Mesh(payloadGeom, mats.payload);
  payloadMesh.position.y = coreTopY + spec.payload.length / 2;
  payload.add(payloadMesh);
  group.add(payload);

  // Fairing
  let fairingHalves: [THREE.Group, THREE.Group] | null = null;
  let totalLength = coreTopY + spec.payload.length;

  if (spec.fairing) {
    const noseLength = spec.fairing.noseLength ?? 0.4 * spec.fairing.length;
    const cylLength = Math.max(0, spec.fairing.length - noseLength);
    const left = buildFairingHalf('fairing-left', coreTopY, spec.fairing.radius, cylLength, noseLength, 0, mats.fairing, mats.ring);
    const right = buildFairingHalf('fairing-right', coreTopY, spec.fairing.radius, cylLength, noseLength, Math.PI, mats.fairing, mats.ring);
    group.add(left, right);
    fairingHalves = [left, right];
    totalLength = coreTopY + spec.fairing.length;
  }

  return {
    group,
    stageGroups,
    fairingHalves,
    payload,
    totalLength,
  };
}

/** Shows or hides parts to match the flight state.
    Missing array entries count as attached. */
export function setLauncherState(mesh: LauncherMesh, state: LauncherState): void {
  for (let i = 0; i < mesh.stageGroups.length; i++) {
    mesh.stageGroups[i].visible = state.stagesAttached[i] ?? true;
  }
  if (mesh.fairingHalves) {
    mesh.fairingHalves[0].visible = state.fairingAttached;
    mesh.fairingHalves[1].visible = state.fairingAttached;
  }
}

/** Disposes every geometry, material and texture under the group.
    Safe to call twice. */
export function disposeLauncher(mesh: LauncherMesh): void {
  const materials = new Set<THREE.Material>();
  mesh.group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.dispose();
    if (Array.isArray(obj.material)) {
      for (const m of obj.material) materials.add(m);
    } else if (obj.material) {
      materials.add(obj.material);
    }
  });
  for (const m of materials) {
    const map = (m as THREE.MeshStandardMaterial).map;
    if (map) map.dispose();
    m.dispose();
  }
}
