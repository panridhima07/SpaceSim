// Builds three.js geometry for a RocketModel.
//
// Local frame: rocket axis along +Y, nose pointing +Y, origin at the nose tip.
// A component whose fore end is at station x occupies local y in [-(x+length), -x].
// Units are metres, not rescaled.

import * as THREE from 'three';
import type { Component, FinSet, InnerTube, Ring, RocketModel } from '../types';
import { buildFin, buildNoseCone, buildTransition } from './parts/aero';
import { buildBodyTube, buildBoosterPod, buildLaunchLug, buildMotor, buildRailButton } from './parts/airframe';
import { buildInnerTube, buildMass, buildPackedChute, buildRing } from './parts/internals';
import { gradeRocket, isPod, sideBodyModel, type PartGrade } from './parts/grade';
import { airframeOutline, surfaceRadiusAt } from './parts/profile';
import { PART_COLORS, partMaterial, type PartContext, type PartTier } from './parts/types';

export { noseProfile } from './parts/profile';
export type { PartTier } from './parts/types';

export interface RocketMeshOptions {
  cutaway?: boolean;
  /**
   * Which design each part is drawn with. 'auto' (default) grades every part from the
   * design data; a tier name forces all parts; a map sets parts by component id and
   * grades the rest.
   */
  tiers?: 'auto' | PartTier | Record<string, PartTier>;
}

/** Thickness drawn for a fin whose file gives none, metres. */
const MIN_FIN_THICKNESS = 2e-4;

/** Name every mesh after its component so picking and highlighting find it. */
function tag(obj: THREE.Object3D, c: Component): THREE.Object3D {
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.name = c.id;
      o.userData.component = c;
    }
  });
  return obj;
}

/**
 * A flat slab in a fin's plane: `outline` is [axial aft of the root leading edge,
 * radial from the fin's mounting radius] in metres. Used for the parts of a fin that
 * lie below its root line.
 */
function finPlaneSlab(c: FinSet, outline: [number, number][], ctx: PartContext): THREE.Mesh | null {
  const t = Math.max(c.thickness, 1e-4);
  if (outline.length < 3 || outline.some(([a, r]) => !Number.isFinite(a) || !Number.isFinite(r))) return null;
  const shape = new THREE.Shape(outline.map(([a, r]) => new THREE.Vector2(a, r)));
  const geom = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, steps: 1 });
  geom.translate(0, 0, -t / 2);
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 1),
  );
  basis.setPosition(c.bodyRadius, -c.x, 0);
  geom.applyMatrix4(basis);
  return new THREE.Mesh(geom, partMaterial(c.color ?? PART_COLORS.fin, ctx));
}

/**
 * Build the 3D group for a rocket. Origin at the nose tip, +Y toward the nose.
 * Every part is drawn at its own dimensions with the design its grade selects.
 * Without `cutaway`, only parts visible from outside are built. With `cutaway`,
 * internal parts are added and the outer skin turns see-through.
 * The grades used are left on `group.userData.grades`.
 */
export function buildRocketMesh(rocket: RocketModel, opts: RocketMeshOptions = {}): THREE.Group {
  const cutaway = !!opts.cutaway;
  const group = new THREE.Group();
  group.name = rocket.name || 'rocket';

  const grades: PartGrade[] = gradeRocket(rocket);
  const choice = opts.tiers ?? 'auto';
  const tierOf = (i: number, c: Component): PartTier => {
    if (choice === 'auto') return grades[i].tier;
    if (typeof choice === 'string') return choice;
    return choice[c.id] ?? grades[i].tier;
  };
  // Entries past the main stack belong to side bodies, in the same order they are drawn below.
  const sideParts = (rocket.sideBodies ?? []).flatMap((sb) => sb.components);
  grades.forEach((g, i) => { g.tier = tierOf(i, rocket.components[i] ?? sideParts[i - rocket.components.length]); });
  group.userData.grades = grades;

  const ctx: PartContext = {
    cutaway,
    maxRadius: Number.isFinite(rocket.maxRadius) ? rocket.maxRadius : 0,
    rocketLength: Number.isFinite(rocket.length) ? rocket.length : 0,
  };
  const outline = airframeOutline(rocket);
  const airframeAft = outline.reduce((m, o) => Math.max(m, o.x + o.length), 0);

  /** Run a part design; a design that throws costs one part, not the whole rocket. */
  const draw = <C extends Component>(build: (c: C, tier: PartTier, ctx: PartContext) => THREE.Object3D, c: C, tier: PartTier): THREE.Object3D => {
    try {
      return tag(build(c, tier, ctx), c);
    } catch {
      rocket.warnings.includes(`"${c.name}" could not be drawn.`) || rocket.warnings.push(`"${c.name}" could not be drawn.`);
      return new THREE.Group();
    }
  };

  rocket.components.forEach((c, index) => {
    const tier = grades[index].tier;
    switch (c.kind) {
      case 'nosecone':
        group.add(draw(buildNoseCone, c, tier));
        break;
      case 'bodytube':
        group.add(draw(buildBodyTube, c, tier));
        break;
      case 'transition':
        group.add(draw(buildTransition, c, tier));
        break;
      case 'finset': {
        const count = Math.min(64, Math.max(1, Math.round(c.count) || 1));
        const one = new THREE.Group();
        // A fin with no thickness in the file is still a visible sheet.
        const fin0: FinSet = c.thickness > 0 ? c : { ...c, thickness: MIN_FIN_THICKNESS };
        one.add(tag(draw(buildFin, fin0, tier), c));

        // Where the body narrows under the root, carry the fin down to the surface.
        if (c.rootChord > 0 && c.bodyRadius > 0) {
          const n = 12;
          const drops: [number, number][] = [];
          let worst = 0;
          for (let k = 0; k <= n; k++) {
            const a = (c.rootChord * k) / n;
            const r = surfaceRadiusAt(outline, c.x + a);
            const drop = Number.isNaN(r) ? 0 : Math.min(0, r - c.bodyRadius);
            worst = Math.min(worst, drop);
            drops.push([a, drop]);
          }
          if (worst < -1e-5) {
            const skirt = finPlaneSlab(c, [[0, 0], [c.rootChord, 0], ...drops.reverse().map(([a, d]) => [a, d - 2e-4] as [number, number])], ctx);
            if (skirt) one.add(tag(skirt, c));
          }
        }
        // Through-the-wall tab, seen in cutaway.
        if (cutaway && c.tabHeight && c.tabLength && c.tabHeight > 0 && c.tabLength > 0) {
          const a0 = c.tabOffset ?? 0;
          const tab = finPlaneSlab(c, [[a0, 0], [a0 + c.tabLength, 0], [a0 + c.tabLength, -c.tabHeight], [a0, -c.tabHeight]], ctx);
          if (tab) one.add(tag(tab, c));
        }

        const start = Number.isFinite(c.angleOffset) ? (c.angleOffset as number) : 0;
        for (let i = 0; i < count; i++) {
          const fin = i === 0 ? one : one.clone();
          fin.rotation.y = start + (2 * Math.PI * i) / count;
          group.add(fin);
        }
        break;
      }
      case 'innertube': {
        const c2 = c as InnerTube;
        if (isPod(c2)) {
          // Side-mounted booster pods are external and always visible.
          const count = Math.min(64, Math.round(c2.radialCount as number));
          const pod = draw(buildBoosterPod, c2, tier);
          for (let i = 0; i < count; i++) {
            const ang = (2 * Math.PI * i) / count;
            const p = i === 0 ? pod : pod.clone();
            p.position.set(Math.cos(ang) * (c2.radialOffset as number), 0, Math.sin(ang) * (c2.radialOffset as number));
            group.add(p);
          }
          break;
        }
        // A tube that sticks out of the back of the airframe shows from outside.
        const protrudes = c2.x + c2.length > airframeAft + 1e-6;
        const parts: THREE.Object3D[] = [];
        if (cutaway || protrudes) parts.push(draw(buildInnerTube, c2, tier));
        if (c2.isMotorMount && c2.motor) parts.push(draw(buildMotor, c2, tier));
        if (parts.length === 0) break;
        const spots = c2.cluster && c2.cluster.length > 0 ? c2.cluster : [[0, 0] as [number, number]];
        spots.forEach(([px, pz], i) => {
          for (const part of parts) {
            const p = i === 0 ? part : part.clone();
            p.position.set(px, 0, pz);
            group.add(p);
          }
        });
        break;
      }
      case 'ring': {
        const c2 = c as Ring;
        if (!c2.external) {
          if (cutaway) group.add(draw(buildRing, c2, tier));
          break;
        }
        // Lugs and rail buttons sit on the body surface, at their own angle.
        const isButton = c2.ringType === 'railbutton';
        const station = isButton ? c2.x + c2.outerRadius : c2.x + c2.length / 2;
        const surface = surfaceRadiusAt(outline, station);
        // The surface as it is now wins over the radius recorded at import, so a fitting
        // follows its tube when the tube is resized in the builder.
        const mountRadius = Number.isNaN(surface) ? (c2.mountRadius ?? ctx.maxRadius) : surface;
        const placed: Ring = { ...c2, mountRadius };
        const one = draw(isButton ? buildRailButton : buildLaunchLug, placed, tier);
        tag(one, c2);
        const copies = Math.min(32, Math.max(1, Math.round(c2.instanceCount ?? 1) || 1));
        const sep = Number.isFinite(c2.instanceSeparation) ? (c2.instanceSeparation as number) : 0;
        const holder = new THREE.Group();
        for (let i = 0; i < copies; i++) {
          const inst = i === 0 ? one : one.clone();
          inst.position.y = -i * sep;
          holder.add(inst);
        }
        holder.rotation.y = Number.isFinite(c2.angle) ? (c2.angle as number) : 0;
        group.add(holder);
        break;
      }
      case 'mass':
        if (cutaway) group.add(draw(buildMass, c, tier));
        break;
      case 'parachute':
        if (cutaway) group.add(draw(buildPackedChute, c, tier));
        break;
    }
  });

  // Boosters, pods and tube fins: each is its own small stack, repeated around the axis.
  (rocket.sideBodies ?? []).forEach((sb, i) => {
    const sub = sideBodyModel(rocket, i);
    const tiers: Record<string, PartTier> = {};
    for (const g of grades) tiers[g.id] = g.tier;
    const body = buildRocketMesh(sub, { cutaway, tiers });
    const count = Math.min(64, Math.max(1, Math.round(sb.count) || 1));
    const offset = Number.isFinite(sb.radialOffset) ? sb.radialOffset : 0;
    for (let k = 0; k < count; k++) {
      // Same sense as fin and fitting angles: turning about +Y from the +X axis.
      const ang = (Number.isFinite(sb.angle) ? sb.angle : 0) + (2 * Math.PI * k) / count;
      const inst = k === 0 ? body : body.clone();
      inst.position.set(offset * Math.cos(ang), 0, -offset * Math.sin(ang));
      inst.userData.sideBody = sb.id;
      group.add(inst);
    }
  });
  return group;
}

/**
 * Two torus rings marking CG (blue) and CP (red). Add `group` as a child of the
 * rocket group; `update` sets their local y to -cgX and -cpX.
 */
export function buildCgCpMarkers(maxRadius: number): {
  group: THREE.Group;
  update(cgX: number, cpX: number): void;
} {
  const group = new THREE.Group();
  group.name = 'cgcp-markers';
  const ringRadius = 1.15 * maxRadius;
  const tube = Math.max(0.0015, 0.04 * maxRadius);

  const make = (name: string, color: number): THREE.Mesh => {
    const g = new THREE.TorusGeometry(ringRadius, tube, 12, 64);
    g.rotateX(Math.PI / 2); // lie in the XZ plane, ring axis along Y
    const m = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 }),
    );
    m.name = name;
    group.add(m);
    return m;
  };

  const cg = make('cg', 0x2f7de2);
  const cp = make('cp', 0xe23b3b);

  return {
    group,
    update(cgX: number, cpX: number) {
      cg.position.y = -cgX;
      cp.position.y = -cpX;
    },
  };
}

/** Dispose geometries and materials recursively. */
export function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
}
