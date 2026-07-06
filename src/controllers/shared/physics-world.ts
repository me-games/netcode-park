// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TS port of the ecctrl controller (physics world glue: this file
// re-implements, as one plain class, the behavior the upstream React
// components received from their React physics wrapper (@react-three/rapier
// v2.2.0) plus ecctrl's own TimeControl — Rapier WASM init, fixed-timestep
// accumulator loop, rigid-body <-> Object3D registry with interpolated pose
// sync, collision/intersection event dispatch, and the debug-line renderer).
// Note: upstream's rigid-body userData key `ecctrl` is renamed to
// `controller` in this port (deliberate de-branding rename).

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

/**
 * Shape of `RigidBody.userData` the controllers understand. Runtime key is
 * `controller` (upstream used `ecctrl`; renamed as part of de-branding).
 *
 * - `excludeRay`: body is ignored by ALL ground queries (character rays AND
 *   wheel shapecasts). Set it on bodies that should never count as ground.
 * - `excludeCharacterRay`: ignored by the character's ground query only.
 * - `excludeVehicleRay`: ignored by wheel shapecasts only. The character body
 *   itself should be created with `{ controller: { excludeVehicleRay: true } }`
 *   so car wheels do not treat the on-foot character as drivable ground.
 */
export interface ControllerUserData {
  controller?: {
    excludeRay?: boolean;
    excludeCharacterRay?: boolean;
    excludeVehicleRay?: boolean;
  };
}

/**
 * World creation options. Defaults mirror the upstream physics wrapper's
 * defaults exactly; you rarely need to touch anything except `gravity`.
 */
export interface PhysicsWorldOptions {
  /** World gravity in m/s^2. Default `[0, -9.81, 0]`. */
  gravity?: [number, number, number];
  /**
   * Fixed simulation step in seconds. Default `1/60`. Controllers read this
   * via `world.timestep` — it is the ONLY dt physics code may use.
   */
  timeStep?: number;
  /**
   * Per-frame wall-clock clamp in seconds (spiral-of-death guard). Default
   * `1/30`, i.e. at most 2 substeps per frame at the default step. Raise it
   * if you want physics to catch up after long frame hitches.
   */
  maxDelta?: number;
  /** Interpolate rendered poses between fixed steps. Default `true`. */
  interpolate?: boolean;
  /** Solver iterations. More = stiffer stacks, more CPU. Default 4. */
  numSolverIterations?: number;
  /** Internal PGS iterations. Default 1. */
  numInternalPgsIterations?: number;
  /** Allowed penetration (length units). Default 0.001. */
  allowedLinearError?: number;
  /** Contact prediction distance (length units). Default 0.002. */
  predictionDistance?: number;
  /** Minimum island size for parallelism. Default 128. */
  minIslandSize?: number;
  /** Max CCD substeps. Default 1. */
  maxCcdSubsteps?: number;
  /** Contact softness frequency (Hz). Default 30. */
  contactNaturalFrequency?: number;
  /** World length unit (units per meter). Default 1. */
  lengthUnit?: number;
}

/** Options for {@link PhysicsWorld.createBody}. */
export interface RigidBodyOptions {
  /** Body type. Default `"dynamic"`. */
  type?: "dynamic" | "fixed" | "kinematicPosition" | "kinematicVelocity";
  /** Initial translation. */
  position?: [number, number, number];
  /** Initial rotation: a quaternion, or `[x, y, z]` euler angles (XYZ, rad). */
  rotation?: THREE.Quaternion | [number, number, number];
  /** Allow the body to sleep when at rest. Default `true`. */
  canSleep?: boolean;
  /** Enable continuous collision detection (fast small bodies). */
  ccd?: boolean;
  /** Per-body gravity multiplier (0 disables gravity for this body). */
  gravityScale?: number;
  /** Linear velocity damping. */
  linearDamping?: number;
  /** Angular velocity damping. */
  angularDamping?: number;
  /** Lock all rotations. */
  lockRotations?: boolean;
  /** Enable rotation per axis `[x, y, z]`. */
  enabledRotations?: [boolean, boolean, boolean];
  /** Arbitrary user data; see {@link ControllerUserData} for the keys the controllers read. */
  userData?: unknown;
}

/** One side of a collision/intersection event. */
export interface CollisionTarget {
  collider: RAPIER.Collider;
  rigidBody: RAPIER.RigidBody | null;
  /** The registered Object3D of the collider's body, if any. */
  object3d: THREE.Object3D | null;
}

/** Payload delivered to per-collider event handlers. */
export interface CollisionPayload {
  target: CollisionTarget;
  other: CollisionTarget;
}

/**
 * Per-collider event handlers. Enter events are disambiguated: solid contacts
 * fire `onCollisionEnter`, sensor overlaps fire `onIntersectionEnter`. Exit
 * events fire BOTH `onCollisionExit` and `onIntersectionExit` — faithful
 * upstream behavior, kept on purpose.
 */
export interface ColliderEventHandlers {
  onCollisionEnter?: (payload: CollisionPayload) => void;
  onCollisionExit?: (payload: CollisionPayload) => void;
  /** Sensor overlap began. */
  onIntersectionEnter?: (payload: CollisionPayload) => void;
  /** Sensor overlap ended. */
  onIntersectionExit?: (payload: CollisionPayload) => void;
}

interface BodyState {
  object: THREE.Object3D;
  invertedWorldMatrix: THREE.Matrix4;
  scale: THREE.Vector3;
}

interface PreviousPose {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
}

// Module-level shared init promise: RAPIER.init() loads the embedded WASM
// once, no matter how many worlds are created.
let rapierInitPromise: Promise<void> | null = null;

// Scratch objects for the per-frame mesh sync (never escape this module).
const _matrix4 = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _bodyPos = new THREE.Vector3();
const _bodyRot = new THREE.Quaternion();
const _identityMatrix = new THREE.Matrix4();

/**
 * Owns the Rapier world, the fixed-timestep accumulator loop, the
 * body <-> Object3D registry, and collision-event dispatch.
 *
 * Canonical loop shape (once per rAF frame):
 * ```ts
 * const physics = await PhysicsWorld.create();
 * physics.onBeforeStep(() => controller.update(physics.timeStep));
 * renderer.setAnimationLoop(() => {
 *   physics.step(clock.getDelta());   // fixed substeps + mesh sync + events
 *   // ...camera + render (render-delta code lives OUT here, never inside)
 * });
 * ```
 * Before-step callbacks fire once per fixed SUBSTEP (before `world.step()`),
 * so controller impulses are consumed by the step immediately following —
 * with `frameRateCorrection = 60 * world.timestep` this preserves the
 * upstream impulse scaling exactly.
 */
export class PhysicsWorld {
  /** The raw Rapier world. Controllers receive this, not the wrapper. */
  readonly world: RAPIER.World;
  /** The fixed step in seconds; `world.timestep` is kept equal to it. */
  readonly timeStep: number;
  /** Pause gate — checked before any time accumulates, so no time banks up. */
  paused = false;
  /** Time dilation. 1 = realtime; 0.5 = half-speed slow-mo. */
  timeScale = 1;
  /** Per-frame wall-clock clamp in seconds (see {@link PhysicsWorldOptions.maxDelta}). */
  maxDelta: number;
  /** Interpolate rendered poses between fixed steps. */
  interpolate: boolean;

  private eventQueue: RAPIER.EventQueue;
  private bodyStates = new Map<number, BodyState>();
  private colliderEvents = new Map<number, ColliderEventHandlers>();
  private beforeStepCallbacks = new Set<(world: RAPIER.World) => void>();
  private afterStepCallbacks = new Set<(world: RAPIER.World) => void>();
  private collisionEventTaps = new Set<
    (handle1: number, handle2: number, started: boolean) => void
  >();
  private accumulator = 0;
  private previousState = new Map<number, PreviousPose>();
  private stepsExecuted = 0;
  private debugLines: THREE.LineSegments | null = null;
  private debugScene: THREE.Scene | null = null;

  private constructor(options: PhysicsWorldOptions) {
    const gravity = options.gravity ?? [0, -9.81, 0];
    this.timeStep = options.timeStep ?? 1 / 60;
    this.maxDelta = options.maxDelta ?? 1 / 30;
    this.interpolate = options.interpolate ?? true;

    this.world = new RAPIER.World(
      new RAPIER.Vector3(gravity[0], gravity[1], gravity[2])
    );
    // Integration parameters — upstream physics-wrapper defaults.
    this.world.integrationParameters.numSolverIterations =
      options.numSolverIterations ?? 4;
    this.world.integrationParameters.numInternalPgsIterations =
      options.numInternalPgsIterations ?? 1;
    this.world.integrationParameters.normalizedAllowedLinearError =
      options.allowedLinearError ?? 0.001;
    this.world.integrationParameters.minIslandSize =
      options.minIslandSize ?? 128;
    this.world.integrationParameters.maxCcdSubsteps =
      options.maxCcdSubsteps ?? 1;
    this.world.integrationParameters.normalizedPredictionDistance =
      options.predictionDistance ?? 0.002;
    this.world.lengthUnit = options.lengthUnit ?? 1;
    this.world.integrationParameters.contact_natural_frequency =
      options.contactNaturalFrequency ?? 30;

    this.world.timestep = this.timeStep;
    this.eventQueue = new RAPIER.EventQueue(false);
  }

  /**
   * Create a physics world. Awaits `RAPIER.init()` (embedded WASM — no
   * bundler config needed); multiple calls share a single init. Nothing may
   * construct any `RAPIER.*` object before this promise resolves.
   */
  static async create(options: PhysicsWorldOptions = {}): Promise<PhysicsWorld> {
    if (!rapierInitPromise) rapierInitPromise = RAPIER.init();
    await rapierInitPromise;
    return new PhysicsWorld(options);
  }

  // ---- body registry (replaces the JSX <RigidBody> mount/unmount) ----

  /**
   * Create a rigid body from plain options. If `object3d` is given it is
   * registered for interpolated render sync (see {@link registerBody}).
   */
  createBody(
    options: RigidBodyOptions = {},
    object3d?: THREE.Object3D
  ): RAPIER.RigidBody {
    const desc = new RAPIER.RigidBodyDesc(
      rigidBodyTypeFromString(options.type ?? "dynamic")
    );
    desc.canSleep = options.canSleep ?? true;
    if (options.position) {
      desc.setTranslation(
        options.position[0],
        options.position[1],
        options.position[2]
      );
    }
    if (options.rotation) {
      const quat = Array.isArray(options.rotation)
        ? new THREE.Quaternion().setFromEuler(
            new THREE.Euler(
              options.rotation[0],
              options.rotation[1],
              options.rotation[2],
              "XYZ"
            )
          )
        : options.rotation;
      desc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
    }

    const body = this.world.createRigidBody(desc);
    // Mutable options, applied in the upstream option-map order.
    if (options.gravityScale !== undefined)
      body.setGravityScale(options.gravityScale, true);
    if (options.linearDamping !== undefined)
      body.setLinearDamping(options.linearDamping);
    if (options.angularDamping !== undefined)
      body.setAngularDamping(options.angularDamping);
    if (options.enabledRotations) {
      body.setEnabledRotations(
        options.enabledRotations[0],
        options.enabledRotations[1],
        options.enabledRotations[2],
        true
      );
    }
    if (options.lockRotations !== undefined)
      body.lockRotations(options.lockRotations, true);
    if (options.ccd !== undefined) body.enableCcd(options.ccd);
    if (options.userData !== undefined) body.userData = options.userData;

    if (object3d) this.registerBody(body, object3d);
    return body;
  }

  /**
   * Register an Object3D to follow `body` (interpolated, once per frame).
   *
   * The parent's inverse world matrix and the object's world scale are
   * captured NOW and never refreshed — register scene-root-level groups
   * (character root, chassis group) and add them to the scene FIRST; if the
   * registered object's parent later moves or scales, the sync silently
   * desyncs.
   */
  registerBody(body: RAPIER.RigidBody, object3d: THREE.Object3D): void {
    object3d.updateWorldMatrix(true, false);
    const invertedWorldMatrix = object3d.parent
      ? object3d.parent.matrixWorld.clone().invert()
      : _identityMatrix.clone();
    this.bodyStates.set(body.handle, {
      object: object3d,
      invertedWorldMatrix,
      scale: object3d.getWorldScale(new THREE.Vector3()).clone(),
    });
  }

  /** Stop syncing the body's Object3D (does not remove the body). */
  unregisterBody(body: RAPIER.RigidBody): void {
    this.bodyStates.delete(body.handle);
  }

  /**
   * Unregister the body's Object3D, drop event handlers for all of its
   * colliders, and remove the body (and its colliders) from the world.
   */
  removeBody(body: RAPIER.RigidBody): void {
    for (let i = 0; i < body.numColliders(); i++) {
      this.colliderEvents.delete(body.collider(i).handle);
    }
    this.unregisterBody(body);
    this.world.removeRigidBody(body);
  }

  /** The registered Object3D for `body`, or null. */
  getObject3d(body: RAPIER.RigidBody): THREE.Object3D | null {
    return this.bodyStates.get(body.handle)?.object ?? null;
  }

  // ---- step hooks ----

  /**
   * Register a callback fired once per fixed SUBSTEP, immediately before
   * `world.step()`. Controllers' `update()` calls live here. Returns an
   * unsubscribe function.
   */
  onBeforeStep(cb: (world: RAPIER.World) => void): () => void {
    this.beforeStepCallbacks.add(cb);
    return () => {
      this.beforeStepCallbacks.delete(cb);
    };
  }

  /** Like {@link onBeforeStep} but fired right after `world.step()`. */
  onAfterStep(cb: (world: RAPIER.World) => void): () => void {
    this.afterStepCallbacks.add(cb);
    return () => {
      this.afterStepCallbacks.delete(cb);
    };
  }

  // ---- collision/intersection events ----

  /**
   * Attach enter/exit handlers to a collider. Also enables
   * `ActiveEvents.COLLISION_EVENTS` on it — without that flag Rapier never
   * reports the pair, so sensors would stay silent.
   */
  setColliderEvents(
    collider: RAPIER.Collider,
    handlers: ColliderEventHandlers
  ): void {
    collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.colliderEvents.set(collider.handle, handlers);
  }

  /** Remove the handlers registered via {@link setColliderEvents}. */
  clearColliderEvents(collider: RAPIER.Collider): void {
    this.colliderEvents.delete(collider.handle);
  }

  /**
   * Raw tap fired once per drained collision event (both solid and sensor),
   * during the per-frame drain, BEFORE per-collider handler dispatch.
   * Feed this to `EnterExitManager.handleIntersectionEvent`. Returns an
   * unsubscribe function.
   */
  onCollisionEvent(
    cb: (handle1: number, handle2: number, started: boolean) => void
  ): () => void {
    this.collisionEventTaps.add(cb);
    return () => {
      this.collisionEventTaps.delete(cb);
    };
  }

  // ---- main loop ----

  /**
   * Advance the simulation. Call once per rAF with the render clock delta in
   * SECONDS. Runs zero or more fixed substeps (before-step callbacks +
   * `world.step()` + after-step callbacks each), then syncs registered
   * Object3Ds (interpolated), drains collision events, and updates the debug
   * lines.
   */
  step(delta: number): void {
    this.stepsExecuted = 0;
    // Pause gates BEFORE accumulation so unpausing never replays banked time.
    if (this.paused) return;

    const maxStep = Math.max(0, this.maxDelta);
    const dt = THREE.MathUtils.clamp(delta, 0, maxStep);
    if (this.timeScale <= 0 || dt <= 0) return;
    // Hard safety clamp from the upstream wrapper, kept in addition to
    // maxDelta (different layers; users may raise maxDelta).
    const clampedDelta = THREE.MathUtils.clamp(dt * this.timeScale, 0, 0.5);

    this.accumulator += clampedDelta;
    while (this.accumulator >= this.timeStep) {
      if (this.interpolate) {
        // Snapshot previous poses — needed for accurate interpolation when
        // the world steps more than once per frame. Values are COPIED out of
        // the WASM-returned objects.
        this.previousState.clear();
        this.world.forEachRigidBody((body) => {
          const t = body.translation();
          const r = body.rotation();
          this.previousState.set(body.handle, {
            position: new THREE.Vector3(t.x, t.y, t.z),
            rotation: new THREE.Quaternion(r.x, r.y, r.z, r.w),
          });
        });
      }
      this.beforeStepCallbacks.forEach((callback) => {
        callback(this.world);
      });
      // Re-assert the fixed step every substep so user code that fiddled with
      // world.timestep cannot break frameRateCorrection (= 60 * timestep).
      this.world.timestep = this.timeStep;
      this.world.step(this.eventQueue);
      this.afterStepCallbacks.forEach((callback) => {
        callback(this.world);
      });
      this.accumulator -= this.timeStep;
      this.stepsExecuted++;
    }

    const interpolationAlpha = !this.interpolate
      ? 1
      : this.accumulator / this.timeStep;

    // Mesh sync: rewind to the previous-tick pose, then lerp toward the
    // current tick by alpha (the upstream interpolation scheme, exactly).
    this.bodyStates.forEach((state, handle) => {
      const body = this.world.getRigidBody(handle);
      if (!body || body.isSleeping()) return;

      const t = body.translation();
      const r = body.rotation();
      const prev = this.previousState.get(handle);
      if (prev) {
        _matrix4
          .compose(prev.position, prev.rotation, state.scale)
          .premultiply(state.invertedWorldMatrix)
          .decompose(_position, _rotation, _scale);
        state.object.position.copy(_position);
        state.object.quaternion.copy(_rotation);
      }

      _bodyPos.set(t.x, t.y, t.z);
      _bodyRot.set(r.x, r.y, r.z, r.w);
      _matrix4
        .compose(_bodyPos, _bodyRot, state.scale)
        .premultiply(state.invertedWorldMatrix)
        .decompose(_position, _rotation, _scale);
      state.object.position.lerp(_position, interpolationAlpha);
      state.object.quaternion.slerp(_rotation, interpolationAlpha);
    });

    // Drain collision events ONCE per frame, after the substep loop (the
    // queue accumulates across substeps; per-substep draining would change
    // enter/exit pairing).
    this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      this.collisionEventTaps.forEach((tap) => {
        tap(handle1, handle2, started);
      });

      const collider1 = this.world.getCollider(handle1);
      const collider2 = this.world.getCollider(handle2);
      if (!collider1 || !collider2) return;
      const handlers1 = this.colliderEvents.get(handle1);
      const handlers2 = this.colliderEvents.get(handle2);
      if (!handlers1 && !handlers2) return;

      const target1 = this.collisionTargetFor(collider1);
      const target2 = this.collisionTargetFor(collider2);
      const payload1: CollisionPayload = { target: target1, other: target2 };
      const payload2: CollisionPayload = { target: target2, other: target1 };

      if (started) {
        // Enter fires INSIDE the contactPair callback: pure sensor overlaps
        // (no contact manifold) do NOT fire onCollisionEnter.
        this.world.contactPair(collider1, collider2, () => {
          handlers1?.onCollisionEnter?.(payload1);
          handlers2?.onCollisionEnter?.(payload2);
        });
        if (this.world.intersectionPair(collider1, collider2)) {
          handlers1?.onIntersectionEnter?.(payload1);
          handlers2?.onIntersectionEnter?.(payload2);
        }
      } else {
        // An ending event fires BOTH handler families unconditionally —
        // faithful upstream behavior, do not "fix".
        handlers1?.onCollisionExit?.(payload1);
        handlers2?.onCollisionExit?.(payload2);
        handlers1?.onIntersectionExit?.(payload1);
        handlers2?.onIntersectionExit?.(payload2);
      }
    });

    this.renderDebug();
  }

  /**
   * Number of fixed substeps executed by the most recent `step()` call.
   * Wiring uses this to gate once-per-step camera work (e.g. platform turn).
   */
  get stepsLastFrame(): number {
    return this.stepsExecuted;
  }

  // ---- debug ----

  /**
   * Add a wireframe rendering of every collider to `scene`. Costs CPU/GPU —
   * keep it off in shipped games; great while tuning colliders.
   */
  enableDebug(scene: THREE.Scene): void {
    if (this.debugLines) return;
    const lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true })
    );
    lines.frustumCulled = false;
    scene.add(lines);
    this.debugLines = lines;
    this.debugScene = scene;
  }

  /** Remove and dispose the debug lines. */
  disableDebug(): void {
    if (!this.debugLines) return;
    this.debugScene?.remove(this.debugLines);
    this.debugLines.geometry.dispose();
    const material = this.debugLines.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
    this.debugLines = null;
    this.debugScene = null;
  }

  get debugEnabled(): boolean {
    return this.debugLines !== null;
  }

  /** Free the Rapier world + event queue and clear every registry. */
  dispose(): void {
    this.disableDebug();
    this.bodyStates.clear();
    this.colliderEvents.clear();
    this.beforeStepCallbacks.clear();
    this.afterStepCallbacks.clear();
    this.collisionEventTaps.clear();
    this.previousState.clear();
    this.eventQueue.free();
    this.world.free();
  }

  // ---- internals ----

  private collisionTargetFor(collider: RAPIER.Collider): CollisionTarget {
    const rigidBody = collider.parent();
    return {
      collider,
      rigidBody,
      object3d: rigidBody
        ? (this.bodyStates.get(rigidBody.handle)?.object ?? null)
        : null,
    };
  }

  private renderDebug(): void {
    if (!this.debugLines) return;
    // debugRender() allocates fresh buffers every call — dispose the previous
    // geometry each frame or leak GPU memory.
    const buffers = this.world.debugRender();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(buffers.vertices, 3)
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(buffers.colors, 4));
    this.debugLines.geometry.dispose();
    this.debugLines.geometry = geometry;
  }
}

function rigidBodyTypeFromString(
  type: NonNullable<RigidBodyOptions["type"]>
): RAPIER.RigidBodyType {
  switch (type) {
    case "dynamic":
      return RAPIER.RigidBodyType.Dynamic;
    case "fixed":
      return RAPIER.RigidBodyType.Fixed;
    case "kinematicPosition":
      return RAPIER.RigidBodyType.KinematicPositionBased;
    case "kinematicVelocity":
      return RAPIER.RigidBodyType.KinematicVelocityBased;
  }
}
