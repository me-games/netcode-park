// SPDX-License-Identifier: MIT
// VRM loading for the character controller (Genex AG-747). Wraps three's
// GLTFLoader with @pixiv/three-vrm's VRMLoaderPlugin, normalizes VRM 0.x
// orientation, and runs the standard perf cleanup — so the rest of the
// controller treats every avatar (VRM 0.x or 1.0) identically.
//
// Needs `npm i @pixiv/three-vrm` (peer of three, which the scaffold already has).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { VRM } from "@pixiv/three-vrm";

export interface LoadedVrm {
  /** The renderable root — add THIS to your character root / the scene. */
  scene: THREE.Group;
  /** The VRM instance — call `vrm.update(dt)` once per frame (spring bones). */
  vrm: VRM;
}

/**
 * Load a `.vrm` and return its scene + VRM instance, ready to animate.
 *
 * `VRMUtils.rotateVRM0` bakes the VRM 0.x 180° flip into BOTH the model and its
 * humanoid rig, so the avatar faces -Z (three's forward, same as every other
 * model) and the UAL retargeter (vrm-retarget.ts) needs no per-version handling.
 */
export async function loadVrm(url: string): Promise<LoadedVrm> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM;

  VRMUtils.rotateVRM0(vrm);
  VRMUtils.removeUnnecessaryVertices(vrm.scene);
  VRMUtils.combineSkeletons(vrm.scene);

  // Skinned avatars can pop out at glancing camera angles otherwise.
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });

  return { scene: vrm.scene, vrm };
}
