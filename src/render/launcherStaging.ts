import type { LauncherMesh, LauncherSpec } from './launcherMesh';

export interface SeparationState {
  /** Seconds since separation for each stage (same index as spec.stages), or null if attached. */
  stages: (number | null)[];
  /** Seconds since fairing separation, or null if attached. */
  fairing: number | null;
}

const HIDE_AFTER_S = 8;

export function updateLauncherStaging(
  mesh: LauncherMesh,
  spec: LauncherSpec,
  state: SeparationState,
): void {
  for (let i = 0; i < mesh.stageGroups.length; i++) {
    const group = mesh.stageGroups[i];
    const stageSpec = spec.stages[i];
    const t = state.stages[i] ?? null;

    if (stageSpec?.parallel) {
      const { count, radialOffset, attachStation } = stageSpec.parallel;
      if (t === null) {
        group.visible = true;
        for (let k = 0; k < group.children.length && k < count; k++) {
          const angle = (2 * Math.PI * k) / count;
          const booster = group.children[k];
          booster.position.set(
            radialOffset * Math.cos(angle),
            attachStation,
            radialOffset * Math.sin(angle),
          );
          booster.rotation.set(0, 0, 0);
        }
      } else if (t >= HIDE_AFTER_S) {
        group.visible = false;
      } else {
        group.visible = true;
        const dt = Math.max(0, t);
        const dr = 3.5 * dt;
        const dy = dt === 0 ? 0 : -2.0 * dt - 2.5 * dt * dt;
        const tilt = Math.min(0.6, 0.25 * dt);

        for (let k = 0; k < group.children.length && k < count; k++) {
          const angle = (2 * Math.PI * k) / count;
          const ux = Math.cos(angle);
          const uz = Math.sin(angle);
          const booster = group.children[k];
          booster.position.set(
            (radialOffset + dr) * ux,
            attachStation + dy,
            (radialOffset + dr) * uz,
          );
          booster.rotation.set(uz * tilt, 0, -ux * tilt);
        }
      }
    } else {
      if (t === null) {
        group.visible = true;
        group.position.set(0, 0, 0);
        group.rotation.set(0, 0, 0);
      } else if (t >= HIDE_AFTER_S) {
        group.visible = false;
      } else {
        group.visible = true;
        const dt = Math.max(0, t);
        const dy = dt === 0 ? 0 : -1.5 * dt - 3.0 * dt * dt;
        group.position.set(0, dy, 0);
        group.rotation.set(0, 0, 0);
      }
    }
  }

  if (mesh.fairingHalves) {
    const [left, right] = mesh.fairingHalves;
    const t = state.fairing;
    if (t === null) {
      left.visible = true;
      right.visible = true;
      left.position.set(0, 0, 0);
      left.rotation.set(0, 0, 0);
      right.position.set(0, 0, 0);
      right.rotation.set(0, 0, 0);
    } else if (t >= HIDE_AFTER_S) {
      left.visible = false;
      right.visible = false;
    } else {
      left.visible = true;
      right.visible = true;
      const dt = Math.max(0, t);
      const dx = 3.0 * dt;
      const dy = dt === 0 ? 0 : -1.5 * dt - 2.0 * dt * dt;
      const rz = Math.min(0.8, 0.3 * dt);
      left.position.set(dx, dy, 0);
      left.rotation.set(0, 0, -rz);
      right.position.set(-dx, dy, 0);
      right.rotation.set(0, 0, rz);
    }
  }
}
