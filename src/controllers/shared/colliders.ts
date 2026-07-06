// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TS port of the ecctrl controller (collider glue: re-implements the
// mesh -> collider auto-generation and the explicit collider helpers that the
// upstream React components received from their React physics wrapper,
// @react-three/rapier v2.2.0). One deliberate substitution: `mergeVertices`
// comes from `three/addons/utils/BufferGeometryUtils.js` (ships inside the
// `three` package) instead of the upstream wrapper's `three-stdlib` — same
// function, no extra dependency.
// All helpers assume `PhysicsWorld.create()` (i.e. RAPIER.init) has already
// resolved — constructing a ColliderDesc before WASM init throws.

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Auto-collider shape for {@link collidersFromObject}.
 * - `"cuboid"`: bounding box per mesh — cheapest, fine for crates/walls.
 * - `"ball"`: bounding sphere per mesh.
 * - `"hull"`: convex hull per mesh — good default for `genex model` props
 *   (tight fit, still convex/fast).
 * - `"trimesh"`: exact triangle mesh — for static level geometry only; never
 *   put a trimesh on a fast dynamic body (tunneling).
 */
export type AutoColliderShape = "cuboid" | "ball" | "hull" | "trimesh";

/** Options applied to every created collider. */
export interface ColliderOptions {
  /**
   * Friction coefficient. NEGATIVE values are legal and load-bearing: the
   * character capsule ships with friction -0.5 because its traction is
   * synthetic (the controller applies its own grip impulses). Do not clamp.
   */
  friction?: number;
  /** Bounciness, 0 (dead) to 1 (superball). */
  restitution?: number;
  /** Mass density (kg/m^3). Mutually exclusive with `mass`. */
  density?: number;
  /**
   * Explicit mass in kg. Mutually exclusive with `density`. Use `mass: 0` on
   * sensor colliders so they add no mass to the vehicle.
   */
  mass?: number;
  /** Sensor colliders detect overlaps but produce no contact forces. */
  sensor?: boolean;
  /** Rapier collision-groups bitmask. */
  collisionGroups?: number;
  /** Rapier solver-groups bitmask. */
  solverGroups?: number;
  /** Extra contact skin thickness (helps jitter at the cost of visual gap). */
  contactSkin?: number;
  /** `RAPIER.ActiveCollisionTypes` bitmask. */
  activeCollisionTypes?: number;
  frictionCombineRule?: RAPIER.CoefficientCombineRule;
  restitutionCombineRule?: RAPIER.CoefficientCombineRule;
  /** Translation of the collider relative to its parent body. */
  position?: [number, number, number];
  /** Rotation (euler XYZ, radians) relative to its parent body. */
  rotation?: [number, number, number];
}

// Exact upstream error string (we support density/mass; massProperties is not ported).
const massPropertiesConflictError =
  "Please pick ONLY ONE of the `density`, `mass` and `massProperties` options.";

/**
 * Auto-generate one collider per visible mesh under `object3d` — the vanilla
 * equivalent of the upstream `<RigidBody colliders="...">` prop. Works on GLB
 * scenes, including `genex model` output.
 *
 * `object3d` must be the SAME object registered to `body` (their frames must
 * coincide); call this right after creating the body, before the first step.
 * Pass `includeInvisible: true` to also process hidden meshes.
 */
export function collidersFromObject(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  object3d: THREE.Object3D,
  shape: AutoColliderShape = "cuboid",
  options: ColliderOptions & { includeInvisible?: boolean } = {}
): RAPIER.Collider[] {
  const colliders: RAPIER.Collider[] = [];
  object3d.updateWorldMatrix(true, false);
  const invertedRootMatrix = object3d.matrixWorld.clone().invert();
  const rootWorldScale = object3d.getWorldScale(new THREE.Vector3());

  const colliderFromChild = (child: THREE.Object3D) => {
    if (!("isMesh" in child)) return;
    const mesh = child as THREE.Mesh;

    const worldScale = mesh.getWorldScale(new THREE.Vector3());
    mesh.updateWorldMatrix(true, false);
    const relPosition = new THREE.Vector3();
    const relRotation = new THREE.Quaternion();
    const relScale = new THREE.Vector3();
    new THREE.Matrix4()
      .copy(mesh.matrixWorld)
      .premultiply(invertedRootMatrix)
      .decompose(relPosition, relRotation, relScale);

    // Collider ARGS (half-extents/radius/vertices) are scaled by
    // childWorldScale * rootWorldScale — exactly upstream, where the
    // collider's object3D carries `scale = childWorldScale` (the child's
    // ABSOLUTE world scale, root scale included) and sits under the
    // registered root, so its getWorldScale() = rootScale * childWorldScale.
    // Upstream quirk faithfully replicated, not fixed: the root scale is
    // double-counted in the collider size, so with a root scaled 2x the
    // colliders come out 2x larger than the rendered meshes.
    const argsScale = worldScale.clone().multiply(rootWorldScale);
    const { desc, offset } = descFromGeometry(mesh, shape, argsScale);
    // Placement wrt the body: (relative pose plus the geometry's own offset
    // scaled by the mesh's world scale), the whole sum then scaled by the
    // ROOT object's world scale — exactly upstream, where the auto-collider
    // props store `relPosition + offset * childWorldScale` and the collider
    // setup then multiplies the position by the registered root's world
    // scale. Upstream quirk faithfully replicated, not fixed: the offset
    // term ends up scaled twice (childWorldScale already contains the root
    // scale), same policy as the ball `radius * scale.x` quirk below.
    desc.setTranslation(
      (relPosition.x + offset.x * worldScale.x) * rootWorldScale.x,
      (relPosition.y + offset.y * worldScale.y) * rootWorldScale.y,
      (relPosition.z + offset.z * worldScale.z) * rootWorldScale.z
    );
    desc.setRotation({
      x: relRotation.x,
      y: relRotation.y,
      z: relRotation.z,
      w: relRotation.w,
    });

    const collider = world.createCollider(desc, body);
    applyColliderOptions(collider, options);
    colliders.push(collider);
  };

  if (options.includeInvisible) object3d.traverse(colliderFromChild);
  else object3d.traverseVisible(colliderFromChild);

  return colliders;
}

/**
 * Attach a box collider. `halfExtents` are HALF sizes — a `[1, 0.4, 2.4]`
 * collider is 2 x 0.8 x 4.8 units. Do not halve twice.
 */
export function cuboidCollider(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  halfExtents: [number, number, number],
  options: ColliderOptions = {}
): RAPIER.Collider {
  return createFromDesc(
    world,
    body,
    RAPIER.ColliderDesc.cuboid(halfExtents[0], halfExtents[1], halfExtents[2]),
    options
  );
}

/** Attach a sphere collider. */
export function ballCollider(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  radius: number,
  options: ColliderOptions = {}
): RAPIER.Collider {
  return createFromDesc(world, body, RAPIER.ColliderDesc.ball(radius), options);
}

/**
 * Attach a capsule collider. Rapier arg order is `(halfHeight, radius)` — the
 * REVERSE of `THREE.CapsuleGeometry(radius, length)` — and `halfHeight`
 * covers the CYLINDRICAL section only: total height is
 * `2 * halfHeight + 2 * radius` (so `[0.3, 0.3]` is 1.2 units tall).
 */
export function capsuleCollider(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  halfHeight: number,
  radius: number,
  options: ColliderOptions = {}
): RAPIER.Collider {
  return createFromDesc(
    world,
    body,
    RAPIER.ColliderDesc.capsule(halfHeight, radius),
    options
  );
}

/**
 * Attach a cylinder collider (arg order `(halfHeight, radius)`, same caveat
 * as {@link capsuleCollider}). The vehicle enter/exit sensors use this shape.
 */
export function cylinderCollider(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  halfHeight: number,
  radius: number,
  options: ColliderOptions = {}
): RAPIER.Collider {
  return createFromDesc(
    world,
    body,
    RAPIER.ColliderDesc.cylinder(halfHeight, radius),
    options
  );
}

/**
 * Attach an exact triangle-mesh collider built from `mesh` (transform
 * relative to the body's registered object is baked in, world scale applied
 * to the vertices). Static level geometry only — trimeshes are hollow and
 * expensive to collide against for fast dynamic bodies.
 */
export function trimeshColliderFromMesh(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  mesh: THREE.Mesh,
  options: ColliderOptions = {}
): RAPIER.Collider {
  return meshColliderFromMesh(world, body, mesh, "trimesh", options);
}

/**
 * Attach a convex-hull collider built from `mesh` — the best default for
 * dynamic props from `genex model` GLBs (tight fit, fast, solid).
 */
export function convexHullColliderFromMesh(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  mesh: THREE.Mesh,
  options: ColliderOptions = {}
): RAPIER.Collider {
  return meshColliderFromMesh(world, body, mesh, "hull", options);
}

/**
 * Apply mutable options to an existing collider (upstream option order).
 * Call again manually if you tune values at runtime. `density` and `mass`
 * are mutually exclusive — picking both throws, exactly like upstream.
 */
export function applyColliderOptions(
  collider: RAPIER.Collider,
  options: ColliderOptions
): void {
  if (options.sensor !== undefined) collider.setSensor(options.sensor);
  if (options.collisionGroups !== undefined)
    collider.setCollisionGroups(options.collisionGroups);
  if (options.solverGroups !== undefined)
    collider.setSolverGroups(options.solverGroups);
  if (options.friction !== undefined) collider.setFriction(options.friction);
  if (options.frictionCombineRule !== undefined)
    collider.setFrictionCombineRule(options.frictionCombineRule);
  if (options.restitution !== undefined)
    collider.setRestitution(options.restitution);
  if (options.restitutionCombineRule !== undefined)
    collider.setRestitutionCombineRule(options.restitutionCombineRule);
  if (options.activeCollisionTypes !== undefined)
    collider.setActiveCollisionTypes(options.activeCollisionTypes);
  if (options.contactSkin !== undefined)
    collider.setContactSkin(options.contactSkin);

  // Mass LAST, and exclusively.
  if (options.density !== undefined) {
    if (options.mass !== undefined) {
      throw new Error(massPropertiesConflictError);
    }
    collider.setDensity(options.density);
    return;
  }
  if (options.mass !== undefined) {
    collider.setMass(options.mass);
  }
}

// ---- internals ----

/**
 * Shared body of trimesh/hull mesh helpers: bakes the mesh's current world
 * transform relative to the body's current pose (so the collider lands where
 * the mesh renders), scales vertices by the mesh's world scale, then defers
 * to {@link createFromDesc} (explicit `options.position`/`rotation` override
 * the baked pose).
 */
function meshColliderFromMesh(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  mesh: THREE.Mesh,
  shape: "trimesh" | "hull",
  options: ColliderOptions
): RAPIER.Collider {
  mesh.updateWorldMatrix(true, false);
  const worldScale = mesh.getWorldScale(new THREE.Vector3());

  const t = body.translation();
  const r = body.rotation();
  const invertedBodyMatrix = new THREE.Matrix4()
    .compose(
      new THREE.Vector3(t.x, t.y, t.z),
      new THREE.Quaternion(r.x, r.y, r.z, r.w),
      new THREE.Vector3(1, 1, 1)
    )
    .invert();
  const relPosition = new THREE.Vector3();
  const relRotation = new THREE.Quaternion();
  const relScale = new THREE.Vector3();
  new THREE.Matrix4()
    .copy(mesh.matrixWorld)
    .premultiply(invertedBodyMatrix)
    .decompose(relPosition, relRotation, relScale);

  const { desc } = descFromGeometry(mesh, shape, worldScale);
  desc.setTranslation(relPosition.x, relPosition.y, relPosition.z);
  desc.setRotation({
    x: relRotation.x,
    y: relRotation.y,
    z: relRotation.z,
    w: relRotation.w,
  });
  return createFromDesc(world, body, desc, options);
}

function createFromDesc(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  desc: RAPIER.ColliderDesc,
  options: ColliderOptions
): RAPIER.Collider {
  if (options.position) {
    desc.setTranslation(
      options.position[0],
      options.position[1],
      options.position[2]
    );
  }
  if (options.rotation) {
    const quat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        options.rotation[0],
        options.rotation[1],
        options.rotation[2],
        "XYZ"
      )
    );
    desc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
  }
  const collider = world.createCollider(desc, body);
  applyColliderOptions(collider, options);
  return collider;
}

/**
 * Build a ColliderDesc from a mesh's geometry for the given auto shape,
 * mirroring the upstream args + scaling exactly (`scale` is whatever scale
 * the caller wants baked into the args — the auto-collider path passes
 * childWorldScale * rootWorldScale to replicate upstream's double-counted
 * root scale; the explicit mesh helpers pass the mesh's world scale):
 * - cuboid: bounding-box half extents, scaled per-axis; offset = box center.
 * - ball: bounding-sphere radius scaled by `scale.x` ONLY (upstream quirk —
 *   non-uniformly scaled spheres are wrong upstream too; replicated, not
 *   fixed); offset = sphere center.
 * - trimesh/hull: vertices scaled component-wise by `scale`; no offset.
 */
function descFromGeometry(
  mesh: THREE.Mesh,
  shape: AutoColliderShape,
  scale: THREE.Vector3
): { desc: RAPIER.ColliderDesc; offset: THREE.Vector3 } {
  const geometry = mesh.geometry;
  switch (shape) {
    case "cuboid": {
      geometry.computeBoundingBox();
      const boundingBox = geometry.boundingBox;
      if (!boundingBox)
        throw new Error(
          `Could not compute a bounding box for mesh "${mesh.name}"`
        );
      const size = boundingBox.getSize(new THREE.Vector3());
      return {
        desc: RAPIER.ColliderDesc.cuboid(
          (size.x / 2) * scale.x,
          (size.y / 2) * scale.y,
          (size.z / 2) * scale.z
        ),
        offset: boundingBox.getCenter(new THREE.Vector3()),
      };
    }
    case "ball": {
      geometry.computeBoundingSphere();
      const boundingSphere = geometry.boundingSphere;
      if (!boundingSphere)
        throw new Error(
          `Could not compute a bounding sphere for mesh "${mesh.name}"`
        );
      return {
        desc: RAPIER.ColliderDesc.ball(boundingSphere.radius * scale.x),
        offset: boundingSphere.center.clone(),
      };
    }
    case "trimesh": {
      // Non-indexed geometry is WELDED via mergeVertices (upstream behavior)
      // rather than given a fabricated sequential index — welding removes
      // duplicate vertices and matters for internal-edge behavior.
      const clonedGeometry = geometry.index
        ? geometry.clone()
        : mergeVertices(geometry);
      const index = clonedGeometry.index;
      if (!index)
        throw new Error(
          `Could not build a triangle index for mesh "${mesh.name}"`
        );
      const desc = RAPIER.ColliderDesc.trimesh(
        scaledPositions(clonedGeometry, scale),
        new Uint32Array(index.array)
      );
      return { desc, offset: new THREE.Vector3() };
    }
    case "hull": {
      const clonedGeometry = geometry.clone();
      const desc = RAPIER.ColliderDesc.convexHull(
        scaledPositions(clonedGeometry, scale)
      );
      if (!desc)
        throw new Error(
          `Failed to build a convex hull for mesh "${mesh.name}" ` +
            "(degenerate or coplanar geometry?)"
        );
      return { desc, offset: new THREE.Vector3() };
    }
  }
}

/**
 * Copy the position attribute into a fresh Float32Array, scaled
 * component-wise by the mesh's world scale. Reads via getX/getY/getZ so
 * interleaved buffer attributes cannot silently corrupt the vertex data
 * (raw `.array` access on an interleaved attribute returns the whole
 * interleaved buffer).
 */
function scaledPositions(
  geometry: THREE.BufferGeometry,
  scale: THREE.Vector3
): Float32Array {
  const attribute = geometry.attributes.position;
  if (!attribute)
    throw new Error("Geometry has no position attribute to build a collider from");
  const out = new Float32Array(attribute.count * 3);
  for (let i = 0; i < attribute.count; i++) {
    out[i * 3] = attribute.getX(i) * scale.x;
    out[i * 3 + 1] = attribute.getY(i) * scale.y;
    out[i * 3 + 2] = attribute.getZ(i) * scale.z;
  }
  return out;
}
