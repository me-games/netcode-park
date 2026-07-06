// SPDX-License-Identifier: MIT
// Auto-fit a Rapier capsule to a loaded avatar's bounds (Genex AG-747). Library
// avatars vary in height and proportion; deriving the collider from the model —
// instead of a fixed preset — is what lets many avatars work with no manual
// tuning. Spread the result into CharacterControllerOptions AND apply
// `modelOffsetY` to the model, or the avatar hovers above the ground (the
// single most common wiring bug):
//
//   const { scene } = await loadVrm("./assets/avatar.vrm");
//   const fit = capsuleFromModel(scene);
//   const character = new CharacterController(world, camera, {
//     ...characterPresets["default"].options, ...fit, position,
//   });
//   character.root.add(scene);
//   scene.position.y = fit.modelOffsetY; // feet on the ground, not at capsule center
import * as THREE from "three";

export interface CapsuleFit {
  /** Cylinder half-height — total capsule height = 2*(halfHeight + radius). */
  capsuleHalfHeight: number;
  capsuleRadius: number;
  /** The model's world-space height in metres (handy for scaling jump velocity). */
  height: number;
  /**
   * Local Y for the model under `character.root`. The root tracks the capsule
   * CENTER, and the controller float-spring keeps the capsule bottom hovering
   * `floatHeight` above the ground — so the model (feet at its origin) must
   * drop by `halfHeight + radius + floatHeight` to stand on the floor.
   */
  modelOffsetY: number;
}

/**
 * Derive a snug upright capsule from the model's world bounding box.
 *
 * Pass `floatHeight` if you override the controller default (0.2) — e.g. the
 * "heavy-body-reference" preset uses 0.3 — so `modelOffsetY` stays correct.
 */
export function capsuleFromModel(model: THREE.Object3D, floatHeight = 0.2): CapsuleFit {
  model.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());

  const height = Math.max(size.y, 0.1);
  const radius = THREE.MathUtils.clamp(Math.min(size.x, size.z) * 0.5, 0.15, 0.35);
  const capsuleHalfHeight = Math.max(height / 2 - radius, 0.05);
  // box.min.y is ~0 for a feet-origin VRM; subtracting it also grounds models
  // whose origin sits elsewhere (e.g. a center-origin placeholder mesh).
  const modelOffsetY = -(capsuleHalfHeight + radius + floatHeight) - box.min.y;

  return { capsuleHalfHeight, capsuleRadius: radius, height, modelOffsetY };
}
