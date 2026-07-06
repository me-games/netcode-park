// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TypeScript port of the ecctrl character controller (React/R3F removed).
// Renames vs upstream: option `rayOriginOffest` -> `rayOriginOffset` (typo fix);
// rigid-body userData key `ecctrl` -> `controller` (de-branding rename).

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  bakeCurveLUT,
  evaluateCurveLUT,
  createSlerpVec3,
  type CurveData,
  type CurveLUT,
} from "../shared/math.ts";
import type { ControllerUserData } from "../shared/physics-world.ts";

export type { ControllerUserData };

const clamp = THREE.MathUtils.clamp;

/** Default platform mass-ratio falloff curve: flat 0 until half the character's
 *  mass, then rising to full inheritance at equal-or-heavier platforms. */
const DEFAULT_CURVE_DATA: CurveData = {
  points: [
    { x: 0, y: 0, r_out: 0 },
    { x: 0.5, y: 0, r_in: 0, r_out: 0 },
    { x: 1, y: 1, r_in: 0 },
  ],
};

/**
 * Movement intents pushed into the controller via {@link CharacterController.setMovement}.
 * Booleans are digital WASD-style input; `joystick` is an analog stick in
 * [-1, 1] on each axis (overrides the booleans while non-zero).
 */
export type MovementInput = {
  forward?: boolean;
  backward?: boolean;
  leftward?: boolean;
  rightward?: boolean;
  joystick?: { x: number; y: number };
  run?: boolean;
  jump?: boolean;
};

/** Read-only view of the merged movement state (returned by the `input` getter). */
export type ReadonlyMovementInput = Readonly<Omit<MovementInput, "joystick">> & {
  readonly joystick?: Readonly<{ x: number; y: number }>;
};

/**
 * Ground-detection strategy: `"shapeCast"` (default) sweeps a small ball down
 * (forgiving on ledges/stairs), `"rayCast"` casts a single ray (cheaper,
 * stricter). Switch at runtime with {@link CharacterController.setGroundDetection}.
 */
export type GroundDetectionMode = "shapeCast" | "rayCast";

/** Fully-populated internal movement state (all fields always present). */
type ResolvedMovementInput = {
  forward: boolean;
  backward: boolean;
  leftward: boolean;
  rightward: boolean;
  joystick: { x: number; y: number };
  run: boolean;
  jump: boolean;
};

/**
 * Options for {@link CharacterController}. Every value has a tuned default —
 * start from a preset in `./presets.ts` and only override what feels wrong.
 *
 * IMPORTANT: the float/auto-balance spring constants scale roughly linearly
 * with body mass, so they are tuned for a specific `density`. If you change
 * `density` (or capsule size), re-tune `springK`/`dampingC` and the four
 * `autoBalance*` values in the same proportion.
 */
export interface CharacterControllerOptions {
  /** Spawn position of the rigid body. Default `{ x: 0, y: 1, z: 0 }`. */
  position?: { x: number; y: number; z: number };
  /** Spawn rotation of the rigid body. Default identity. */
  rotation?: THREE.Quaternion;
  /**
   * Capsule collider friction. Default `-0.5` — NEGATIVE on purpose: traction
   * is synthesized by the move-impulse model, and negative friction (averaged
   * with the ground's) keeps the capsule itself from grabbing walls/ground.
   * Do not "fix" this to a positive value.
   */
  friction?: number;
  /** Collider density (mass = density x capsule volume). Default `1`. Presets state the density they were tuned for. */
  density?: number;
  /** Allow the body to sleep when at rest. Default `true`. */
  canSleep?: boolean;
  /** Initial gravity scale while airborne and not falling. Default `1`. */
  gravityScale?: number;
  /**
   * Stored on `body.userData` — the ray-filter contract other controllers
   * read. Recommended: `{ controller: { excludeVehicleRay: true } }` so car
   * wheels never treat the on-foot character as drivable ground.
   */
  userData?: ControllerUserData;
  /** Build debug indicators (needs the `debugScene` constructor arg). Default `false`. */
  debug?: boolean;
  /** Initial value of the `enabled` switch. Default `true`. */
  enable?: boolean;

  // ── character capsule ──
  /** Capsule cylinder half-height (total height = 2*(halfHeight+radius)). Default `0.3`. */
  capsuleHalfHeight?: number;
  /** Capsule radius. Default `0.3`. */
  capsuleRadius?: number;

  // ── forward direction ──
  /** `true` = always face the camera/custom forward (strafe mode). Default `false`. */
  lockForward?: boolean;
  /** `true` = use the vector given via `setForwardDir` instead of the camera's forward. Default `false`. */
  useCustomForward?: boolean;
  /** `true` = project movement on the character's own up axis instead of the gravity up axis. Default `false`. */
  useCharacterUpAxis?: boolean;

  // ── gravity-direction smoothing ──
  /** How fast the smoothed gravity direction chases world gravity (`1 - exp(-k*dt)`). Higher = snappier. Default `6`. */
  gravityDirLerpSpeed?: number;

  // ── base control ──
  /** Target walk speed in m/s. Default `2`. */
  maxWalkVel?: number;
  /** Target run speed in m/s. Default `5`. */
  maxRunVel?: number;
  /** Acceleration responsiveness in (0,1]: higher = reaches target speed faster. Default `0.2`. */
  accDeltaTime?: number;
  /** Braking responsiveness in (0,1]: higher = stops faster when input is released. Default `0.2`. */
  decDeltaTime?: number;
  /** How strongly off-axis (sideways) velocity is cancelled while grounded. 0 = keep drifting, 1 = full cancel. Default `1`. */
  rejectVelFactor?: number;
  /** Height above the body center where the move impulse is applied — creates the run lean. 0 = no lean. Default `0.5`. */
  moveImpulsePointOffset?: number;
  /** Jump takeoff speed in m/s (applied via setLinvel, i.e. velocity replace). Default `5`. */
  jumpVel?: number;
  /** Seconds the jump keeps re-asserting takeoff velocity (also suppresses the downward float spring). Default `0.1`. */
  jumpDuration?: number;
  /** Blends the ground normal into the jump direction (0 = straight up, 1 = off the slope). Default `0`. */
  slopeJumpFactor?: number;
  /** Air control strength (replaces ground grip while airborne). Lower = floatier air control. Default `0.1`. */
  airDragFactor?: number;
  /** Added to the ground's friction before the 0..1 grip blend. Lower = slippery ice feel. Default `0.5`. */
  slideGripFactor?: number;
  /** Gravity multiplier while falling — higher = heavier, snappier falls. Default `3`. */
  fallingGravityScale?: number;
  /** Terminal fall speed in m/s (gravity cuts to 0 past it). Default `20`. */
  fallingMaxVel?: number;
  /** `true` = the run key toggles run on/off; `false` = hold to run. Default `true`. */
  enableToggleRun?: boolean;

  // ── floating ray ──
  /** Ground-detection strategy. Default `"shapeCast"`. */
  groundDetection?: GroundDetectionMode;
  /** Max walkable slope in radians; steeper ground makes the character slide. Default `Math.PI / 2.5` (72 deg). */
  slopeMaxAngle?: number;
  /** How high the capsule floats above the ground. Default `0.2`. */
  floatHeight?: number;
  /**
   * Ground-query origin offset along the character's own up axis (usually
   * negative: start under the hips). Default `-capsuleHalfHeight`.
   * RENAMED from upstream's typo'd `rayOriginOffest`.
   */
  rayOriginOffset?: number;
  /** Extra grounded tolerance beyond the float distance — raise it if stairs/ledges flicker the grounded state. Default `0.28`. */
  rayHitForgiveness?: number;
  /** Max ground-query distance. Default `capsuleRadius + 1`. */
  rayLength?: number;
  /** Radius of the shapecast ball. Default `capsuleRadius / 2`. */
  rayRadius?: number;
  /** Float spring stiffness. Scales with mass — tuned per density (see presets). Default `80`. */
  springK?: number;
  /** Float spring damping. Too low = pogo bounce, too high = sticky landings. Default `6`. */
  dampingC?: number;

  // ── auto balance ──
  /** Keep the capsule upright with spring torques. Default `true`. */
  autoBalance?: boolean;
  /** Upright spring stiffness. Scales with mass. Default `0.5`. */
  autoBalanceSpringK?: number;
  /** Upright spring damping. Default `0.03`. */
  autoBalanceDampingC?: number;
  /** Turning (yaw) spring stiffness — higher = faster facing changes. Default `0.08`. */
  autoBalanceSpringOnY?: number;
  /** Turning (yaw) spring damping. Default `0.006`. */
  autoBalanceDampingOnY?: number;

  // ── moving platform ──
  /** Inherit velocity/rotation from the platform under the character. Default `true`. */
  followPlatform?: boolean;
  /**
   * Falloff of platform-rotation inheritance by platform/character mass ratio
   * (light dynamic props don't drag the character around). Default: 0 below
   * 0.5x character mass, ramping to 1 at equal mass.
   */
  massRatioFallOffCurveData?: CurveData;
  /** Push the character's weight down into dynamic ground each step. Default `true`. */
  applyCounterMass?: boolean;
  /** Kick dynamic ground downward when jumping off it. Default `true`. */
  applyCounterJumpImp?: boolean;
  /** Scale of the counter-jump kick. Default `1`. */
  counterJumpImpFactor?: number;
  /** Push dynamic ground backward when running on it. Default `true`. */
  applyCounterMoveImp?: boolean;
  /** Scale of the counter-move push. Default `1`. */
  counterMoveImpFactor?: number;
}

/** Bundle of debug indicator objects (parity-non-critical helper). */
type DebugAssets = {
  group: THREE.Group;
  forwardIndicator: THREE.Group;
  moveIndicator: THREE.Group;
  rayStart: THREE.Mesh;
  rayEnd: THREE.Mesh;
  rayTrigger: THREE.Mesh;
  rayStable: THREE.Mesh;
  standingPoint: THREE.Mesh;
  velocityArrow: THREE.ArrowHelper;
  disposables: Array<{ dispose(): void }>;
};

/**
 * Dynamic floating-capsule character controller.
 *
 * The character is a real dynamic rigid body kept floating above the ground by
 * a spring (downward shapecast), moved by impulses, turned by yaw torques and
 * kept upright by balance torques. It pushes and is pushed by other dynamic
 * bodies, rides moving/rotating platforms, climbs walkable slopes and slides
 * on steep ones.
 *
 * Loop contract: call `update()` once per FIXED physics substep BEFORE
 * `world.step()`; all internal time terms use `world.timestep`. Sync the
 * visual root after stepping (register `(body, root)` with the PhysicsWorld
 * registry, or call `syncRoot()` yourself).
 */
export class CharacterController {
  /** Master enable switch — `false` skips the whole per-step brain. */
  enabled: boolean;

  /** Visual anchor: parent your character model under this group. */
  readonly root: THREE.Group;

  private readonly world: RAPIER.World;
  private readonly camera: THREE.Camera;
  private readonly _body: RAPIER.RigidBody;
  private readonly _collider: RAPIER.Collider;

  // ── resolved options ──
  private readonly debugEnabled: boolean;
  private readonly capsuleRadius: number;
  private readonly useCustomForward: boolean;
  private readonly gravityDirLerpSpeed: number;
  private readonly maxWalkVel: number;
  private readonly maxRunVel: number;
  private readonly accDeltaTime: number;
  private readonly decDeltaTime: number;
  private readonly rejectVelFactor: number;
  private readonly moveImpulsePointOffset: number;
  private readonly jumpVel: number;
  private readonly jumpDuration: number;
  private readonly slopeJumpFactor: number;
  private readonly airDragFactor: number;
  private readonly slideGripFactor: number;
  private readonly fallingGravityScale: number;
  private readonly fallingMaxVel: number;
  private readonly enableToggleRun: boolean;
  private groundDetectionMode: GroundDetectionMode;
  private readonly slopeMaxAngle: number;
  private readonly floatHeight: number;
  private readonly rayOriginOffset: number;
  private readonly rayHitForgiveness: number;
  private readonly rayLength: number;
  private readonly rayRadius: number;
  private readonly springK: number;
  private readonly dampingC: number;
  private readonly autoBalance: boolean;
  private readonly autoBalanceSpringK: number;
  private readonly autoBalanceDampingC: number;
  private readonly autoBalanceSpringOnY: number;
  private readonly autoBalanceDampingOnY: number;
  private readonly followPlatform: boolean;
  private readonly applyCounterMass: boolean;
  private readonly applyCounterJumpImp: boolean;
  private readonly counterJumpImpFactor: number;
  private readonly applyCounterMoveImp: boolean;
  private readonly counterMoveImpFactor: number;
  private readonly initialGravityScale: number;
  private readonly massRatioFallOffCurve: CurveLUT;

  // ── input state ──
  private readonly movementState: ResolvedMovementInput = {
    forward: false,
    backward: false,
    leftward: false,
    rightward: false,
    joystick: { x: 0, y: 0 },
    run: false,
    jump: false,
  };
  private jumpElapsedTime = 0;
  private _jumpActive = false;
  private canJumpAgain = true;
  private _runActive = false;
  private canRunAgain = false;

  // ── fixed axes ──
  private readonly fixedZero = new THREE.Vector3(0, 0, 0);
  private readonly fixedOrigin = new THREE.Vector3(0, 0, 0);
  private readonly fixedZAxis = new THREE.Vector3(0, 0, 1);

  // ── body axes ──
  private readonly characterYAxis = new THREE.Vector3(0, 1, 0);
  private readonly characterXAxis = new THREE.Vector3(1, 0, 0);
  private readonly characterZAxis = new THREE.Vector3(0, 0, 1);

  // ── gravity ──
  private isZeroGravity = false;
  private readonly upAxisVec = new THREE.Vector3();
  /** Alias of a LIVE vector: `characterYAxis` when `useCharacterUpAxis`, else `upAxisVec`. */
  private readonly referenceUpAxis: THREE.Vector3;
  private readonly referenceGravity = new THREE.Vector3();
  private referenceGravityMag = 0;
  private readonly referenceGravityDir = new THREE.Vector3();
  private readonly gravityDirVec = new THREE.Vector3();
  private readonly slerpVec3 = createSlerpVec3();

  // ── kinematic state ──
  private readonly _relativeVel = new THREE.Vector3();
  private readonly _relativeVelOnPlane = new THREE.Vector3();
  private readonly _relativeVelOnUp = new THREE.Vector3();
  private readonly currentPos = new THREE.Vector3();
  private readonly currentVel = new THREE.Vector3();
  private readonly currentVelOnPlane = new THREE.Vector3();
  private readonly currentVelOnUp = new THREE.Vector3();
  private readonly currentAngVel = new THREE.Vector3();
  private readonly currentAngVelOnPlane = new THREE.Vector3();
  private readonly currentAngVelOnUp = new THREE.Vector3();
  private readonly currentQuat = new THREE.Quaternion();

  // ── balance / turning ──
  private readonly balanceCrossAxis = new THREE.Vector3();
  private readonly turnCrossAxis = new THREE.Vector3();
  private readonly turnOnYAxis = new THREE.Vector3();
  private readonly _turnOnYQuat = new THREE.Quaternion();

  // ── movement ──
  private isLockForward: boolean;
  private readonly forwardDirection = new THREE.Vector3();
  private readonly camRightDirection = new THREE.Vector3();
  private readonly rightwardDirection = new THREE.Vector3();
  private readonly _inputDir = new THREE.Vector3();
  private readonly lastInputDir = new THREE.Vector3();
  private readonly baseImpulse = new THREE.Vector3();
  private readonly _moveImpulse = new THREE.Vector3();
  private readonly moveImpulsePoint = new THREE.Vector3();
  private readonly moveImpulseToGround = new THREE.Vector3();
  private readonly _movingDirection = new THREE.Vector3();
  private readonly movingDirCrossAxis = new THREE.Vector3();
  private readonly wantToMoveVel = new THREE.Vector3();
  private readonly rejectVel = new THREE.Vector3();

  // ── jump ──
  private _isOnGround = false;
  private readonly jumpDirection = new THREE.Vector3();
  private readonly jumpVelocityVec = new THREE.Vector3();
  private readonly jumpImpulseToGround = new THREE.Vector3();

  // ── fall / friction ──
  private _isFalling = false;
  private readonly _dragFrictionImpulse = new THREE.Vector3();

  // ── floating ray ──
  private readonly springDistVec = new THREE.Vector3();
  private readonly dampingVelVec = new THREE.Vector3();
  private readonly floatingForce = new THREE.Vector3();
  private readonly _floatingImpulse = new THREE.Vector3();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly groundHitOrigin = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private readonly rayShape: RAPIER.Ball;
  private readonly ray: RAPIER.Ray;
  private shapeRayHit: RAPIER.ColliderShapeCastHit | null = null;
  private rayHit: RAPIER.RayColliderIntersection | null = null;
  private castRayHit: RAPIER.RayColliderIntersection | null = null;
  private castShapeHit: RAPIER.ColliderShapeCastHit | null = null;
  private groundHitDistance = 0;
  private groundFloatingDistance = 0;
  private rayHitBody: RAPIER.RigidBody | null = null;

  // ── slope ──
  private slopeAngleInFront = 0;
  private _actualSlopeAngle = 0;
  private readonly actualSlopeNormalVec = new THREE.Vector3();

  // ── standing platform ──
  private massRatio = 1;
  private isOnMovingObject = false;
  private slideFrictionCoef = 0;
  private standingPointFriction = 0;
  private readonly standingPoint = new THREE.Vector3();
  private readonly characterMassImpulse = new THREE.Vector3();
  private readonly movingObjectPosition = new THREE.Vector3();
  private readonly movingObjectVelocity = new THREE.Vector3();
  private readonly movingObjectVelocityOnPlane = new THREE.Vector3();
  private readonly movingObjectVelocityOnUp = new THREE.Vector3();
  private readonly movingObjectLinearVelocity = new THREE.Vector3();
  private readonly movingObjectAngularVelocity = new THREE.Vector3();
  private movingObjectAngularVelocityValue = 0;
  private readonly movingObjectAngularVelocityAxis = new THREE.Vector3();
  private readonly distanceFromCharacterToObjectPoint = new THREE.Vector3();
  private readonly movingObjectAngvelToLinvel = new THREE.Vector3();

  // ── park state (enter/exit vehicle support) ──
  private parked = false;
  private readonly unparkEuler = new THREE.Euler();
  private readonly unparkQuat = new THREE.Quaternion();

  // ── debug ──
  private debugAssets: DebugAssets | null = null;

  /**
   * Creates the dynamic rigid body + capsule collider immediately (the Rapier
   * world must be initialized before constructing).
   *
   * Also creates `root` (positioned at the body): parent your character model
   * under it — the upstream demo placed its model with a -0.6 Y offset.
   *
   * @param world  Raw Rapier world (the controller does NOT self-register any
   *               step callbacks — your game loop calls `update()`).
   * @param camera Camera used to derive the movement forward direction.
   * @param options Tuning options; see {@link CharacterControllerOptions}.
   * @param debugScene If `options.debug` is set, debug indicator meshes are
   *               added to this scene.
   */
  constructor(
    world: RAPIER.World,
    camera: THREE.Camera,
    options: CharacterControllerOptions = {},
    debugScene?: THREE.Scene
  ) {
    this.world = world;
    this.camera = camera;

    // ── resolve options (defaults mirror upstream Ecctrl.tsx l.26-88) ──
    this.debugEnabled = options.debug ?? false;
    this.enabled = options.enable ?? true;
    const capsuleHalfHeight = options.capsuleHalfHeight ?? 0.3;
    this.capsuleRadius = options.capsuleRadius ?? 0.3;
    this.isLockForward = options.lockForward ?? false;
    this.useCustomForward = options.useCustomForward ?? false;
    const useCharacterUpAxis = options.useCharacterUpAxis ?? false;
    this.gravityDirLerpSpeed = options.gravityDirLerpSpeed ?? 6;
    this.maxWalkVel = options.maxWalkVel ?? 2;
    this.maxRunVel = options.maxRunVel ?? 5;
    this.accDeltaTime = options.accDeltaTime ?? 0.2;
    this.decDeltaTime = options.decDeltaTime ?? 0.2;
    this.rejectVelFactor = options.rejectVelFactor ?? 1;
    this.moveImpulsePointOffset = options.moveImpulsePointOffset ?? 0.5;
    this.jumpVel = options.jumpVel ?? 5;
    this.jumpDuration = options.jumpDuration ?? 0.1;
    this.slopeJumpFactor = options.slopeJumpFactor ?? 0;
    this.airDragFactor = options.airDragFactor ?? 0.1;
    this.slideGripFactor = options.slideGripFactor ?? 0.5;
    this.fallingGravityScale = options.fallingGravityScale ?? 3;
    this.fallingMaxVel = options.fallingMaxVel ?? 20;
    this.enableToggleRun = options.enableToggleRun ?? true;
    this.groundDetectionMode = options.groundDetection ?? "shapeCast";
    this.slopeMaxAngle = options.slopeMaxAngle ?? Math.PI / 2.5;
    this.floatHeight = options.floatHeight ?? 0.2;
    this.rayOriginOffset = options.rayOriginOffset ?? -capsuleHalfHeight;
    this.rayHitForgiveness = options.rayHitForgiveness ?? 0.28;
    this.rayLength = options.rayLength ?? this.capsuleRadius + 1;
    this.rayRadius = options.rayRadius ?? this.capsuleRadius / 2;
    this.springK = options.springK ?? 80;
    this.dampingC = options.dampingC ?? 6;
    this.autoBalance = options.autoBalance ?? true;
    this.autoBalanceSpringK = options.autoBalanceSpringK ?? 0.5;
    this.autoBalanceDampingC = options.autoBalanceDampingC ?? 0.03;
    this.autoBalanceSpringOnY = options.autoBalanceSpringOnY ?? 0.08;
    this.autoBalanceDampingOnY = options.autoBalanceDampingOnY ?? 0.006;
    this.followPlatform = options.followPlatform ?? true;
    this.applyCounterMass = options.applyCounterMass ?? true;
    this.applyCounterJumpImp = options.applyCounterJumpImp ?? true;
    this.counterJumpImpFactor = options.counterJumpImpFactor ?? 1;
    this.applyCounterMoveImp = options.applyCounterMoveImp ?? true;
    this.counterMoveImpFactor = options.counterMoveImpFactor ?? 1;
    this.initialGravityScale = options.gravityScale ?? 1;

    const curveData = options.massRatioFallOffCurveData ?? DEFAULT_CURVE_DATA;
    this.massRatioFallOffCurve = bakeCurveLUT(curveData.points, curveData.samples ?? 50);

    // `referenceUpAxis` ALIASES a live vector (never copied) — upstream l.190.
    this.referenceUpAxis = useCharacterUpAxis ? this.characterYAxis : this.upAxisVec;

    // ── rigid body + capsule collider (JSX <RigidBody>/<CapsuleCollider> replacement) ──
    const position = options.position ?? { x: 0, y: 1, z: 0 };
    const rotation = options.rotation ?? new THREE.Quaternion();
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation(rotation)
      .setCanSleep(options.canSleep ?? true)
      .setGravityScale(this.initialGravityScale);
    this._body = world.createRigidBody(bodyDesc);
    this._body.userData = options.userData ?? {};

    // Capsule args order matches the JSX args: (halfHeight, radius).
    const colliderDesc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight, this.capsuleRadius)
      .setFriction(options.friction ?? -0.5)
      .setDensity(options.density ?? 1);
    this._collider = world.createCollider(colliderDesc, this._body);

    // Ground-query scratch shapes (reused every step).
    this.rayShape = new RAPIER.Ball(this.rayRadius);
    this.ray = new RAPIER.Ray(this.rayOrigin, this.rayDirection);

    // Visual root (the JSX children slot).
    this.root = new THREE.Group();
    this.root.position.copy(position);
    this.root.quaternion.copy(rotation);

    if (this.debugEnabled && debugScene) this.buildDebugAssets(debugScene);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Imperative handle (mirror of upstream EcctrlHandle)
  // All vector/quaternion getters return LIVE internal instances: read-only,
  // `.clone()`/`.copy()` if you keep them.
  // ────────────────────────────────────────────────────────────────────────

  /** The character's dynamic rigid body. */
  get body(): RAPIER.RigidBody {
    return this._body;
  }
  /** The capsule collider. */
  get collider(): RAPIER.Collider {
    return this._collider;
  }
  /** Smoothed up axis (opposite of the smoothed gravity direction). Live vector. */
  get upAxis(): THREE.Vector3 {
    return this.upAxisVec;
  }
  /** Smoothed gravity direction (unit). Live vector. */
  get gravityDir(): THREE.Vector3 {
    return this.gravityDirVec;
  }
  /** Magnitude of world gravity. */
  get gravityMag(): number {
    return this.referenceGravityMag;
  }
  /** Body position (this step). Live vector. */
  get currPos(): THREE.Vector3 {
    return this.currentPos;
  }
  /** Body rotation (this step). Live quaternion. */
  get currQuat(): THREE.Quaternion {
    return this.currentQuat;
  }
  /** Body linear velocity. Live vector. */
  get currLinVel(): THREE.Vector3 {
    return this.currentVel;
  }
  /** Body angular velocity. Live vector. */
  get currAngVel(): THREE.Vector3 {
    return this.currentAngVel;
  }
  /** Current merged movement input. */
  get input(): ReadonlyMovementInput {
    return this.movementState;
  }
  /** World-space input direction (unit, camera-relative). Live vector. */
  get inputDir(): THREE.Vector3 {
    return this._inputDir;
  }
  /** Actual moving direction (input dir rotated up walkable slopes). Live vector. */
  get movingDirection(): THREE.Vector3 {
    return this._movingDirection;
  }
  /** Velocity relative to the ground/platform under the character. Live vector. */
  get relativeVel(): THREE.Vector3 {
    return this._relativeVel;
  }
  /** Relative velocity projected on the ground plane. Live vector. */
  get relativeVelOnPlane(): THREE.Vector3 {
    return this._relativeVelOnPlane;
  }
  /** Relative velocity projected on the up axis. Live vector. */
  get relativeVelOnUp(): THREE.Vector3 {
    return this._relativeVelOnUp;
  }
  /** Last applied move impulse. NOTE: already scaled by frameRateCorrection. Live vector. */
  get moveImpulse(): THREE.Vector3 {
    return this._moveImpulse;
  }
  /** Last applied float-spring impulse (NOT frameRateCorrection-scaled). Live vector. */
  get floatingImpulse(): THREE.Vector3 {
    return this._floatingImpulse;
  }
  /** Last applied idle drag impulse. NOTE: already scaled by frameRateCorrection. Live vector. */
  get dragFrictionImpulse(): THREE.Vector3 {
    return this._dragFrictionImpulse;
  }
  /** Body local +X axis in world space. Live vector. */
  get bodyXAxis(): THREE.Vector3 {
    return this.characterXAxis;
  }
  /** Body local +Y axis in world space. Live vector. */
  get bodyYAxis(): THREE.Vector3 {
    return this.characterYAxis;
  }
  /** Body local +Z axis (facing) in world space. Live vector. */
  get bodyZAxis(): THREE.Vector3 {
    return this.characterZAxis;
  }
  /**
   * The RIGID BODY the character stands on (or `null`). Upstream misnomer
   * kept on purpose — it returns the body, not a collider.
   */
  get standCollider(): RAPIER.RigidBody | null {
    return this.rayHitBody;
  }
  /** World-space standing point on the ground. Live vector. */
  get standPoint(): THREE.Vector3 {
    return this.standingPoint;
  }
  /** Ground normal at the standing point. Live vector. */
  get standNormal(): THREE.Vector3 {
    return this.actualSlopeNormalVec;
  }
  /** `true` while the float query holds the character up. */
  get isOnGround(): boolean {
    return this._isOnGround;
  }
  /** `true` while airborne and moving downward. */
  get isFalling(): boolean {
    return this._isFalling;
  }
  /** `true` while standing on a dynamic or kinematic (position-based) body. */
  get isOnPlatform(): boolean {
    return this.isOnMovingObject;
  }
  /** Signed slope angle in front of the moving direction (radians). */
  get slopeAngle(): number {
    return this.slopeAngleInFront;
  }
  /** Absolute slope angle of the ground under the character (radians). */
  get actualSlopeAngle(): number {
    return this._actualSlopeAngle;
  }
  /** Friction of the collider under the character. */
  get standFriction(): number {
    return this.standingPointFriction;
  }
  /** Blended grip coefficient in [0, 1] (refreshed only while idling on ground). */
  get slideFriction(): number {
    return this.slideFrictionCoef;
  }
  /** `true` while there is movement input. */
  get isMoving(): boolean {
    return this._inputDir.lengthSq() > 1e-6;
  }
  /** Ground-plane speed relative to the platform (m/s). */
  get moveSpeed(): number {
    return this._relativeVelOnPlane.length();
  }
  /** Signed vertical speed along the up axis (m/s). */
  get verticalSpeed(): number {
    return this._relativeVelOnUp.dot(this.referenceUpAxis);
  }
  /** `true` while the run toggle/hold is active. */
  get runActive(): boolean {
    return this._runActive;
  }
  /** `true` during the `jumpDuration` takeoff window. */
  get jumpActive(): boolean {
    return this._jumpActive;
  }
  /** `true` while the character always faces the forward direction (strafe mode). */
  get lockForward(): boolean {
    return this.isLockForward;
  }
  /** Per-step rotation of the platform under the character (identity when off-platform). Live quaternion. */
  get turnOnYQuat(): THREE.Quaternion {
    return this._turnOnYQuat;
  }
  /** `true` while parked (hidden + physics disabled, e.g. inside a vehicle). */
  get isParked(): boolean {
    return this.parked;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Public methods
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Merge movement intents into the input state. Only fields you pass are
   * changed, so different input sources (keyboard, joystick, buttons) can each
   * push their own subset.
   */
  setMovement(movement: MovementInput): void {
    if (movement.forward !== undefined) this.movementState.forward = movement.forward;
    if (movement.backward !== undefined) this.movementState.backward = movement.backward;
    if (movement.leftward !== undefined) this.movementState.leftward = movement.leftward;
    if (movement.rightward !== undefined) this.movementState.rightward = movement.rightward;
    if (movement.joystick) {
      this.movementState.joystick.x = movement.joystick.x;
      this.movementState.joystick.y = movement.joystick.y;
    }
    if (movement.run !== undefined) this.movementState.run = movement.run;
    if (movement.jump !== undefined) this.movementState.jump = movement.jump;
  }

  /** Toggle strafe mode (always face the camera/custom forward direction). */
  setLockForward(lock: boolean): void {
    this.isLockForward = lock;
  }

  /** Set the custom forward direction (only used with `useCustomForward: true`). */
  setForwardDir(dir: THREE.Vector3): void {
    this.forwardDirection.copy(dir);
  }

  /** Switch ground-detection strategy at runtime (clears the stale hit of the other mode). */
  setGroundDetection(mode: GroundDetectionMode): void {
    this.groundDetectionMode = mode;
    if (mode === "rayCast") this.shapeRayHit = null;
    else this.rayHit = null;
  }

  /**
   * Park the character (used when entering a vehicle): disables the body and
   * collider, hides the root, zeroes velocities and clears movement input.
   * `update()` early-outs while parked.
   */
  park(): void {
    if (this.parked) return;
    this.parked = true;
    this._body.setLinvel(this.fixedZero, false);
    this._body.setAngvel(this.fixedZero, false);
    this._body.setEnabled(false);
    this._collider.setEnabled(false);
    this.root.visible = false;
    this.movementState.forward = false;
    this.movementState.backward = false;
    this.movementState.leftward = false;
    this.movementState.rightward = false;
    this.movementState.joystick.x = 0;
    this.movementState.joystick.y = 0;
    this.movementState.run = false;
    this.movementState.jump = false;
  }

  /**
   * Un-park the character at a new pose (used when exiting a vehicle).
   * The Euler is interpreted with rotation order "YXZ". Re-enables the body
   * and collider, zeroes velocities and wakes the body. The facing memory
   * (`lastInputDir`) resets to the new forward so the character doesn't snap
   * back to its pre-park heading.
   */
  unpark(position: THREE.Vector3, rotation: THREE.Euler): void {
    this.unparkEuler.set(rotation.x, rotation.y, rotation.z, "YXZ");
    this.unparkQuat.setFromEuler(this.unparkEuler);
    this._body.setTranslation(position, false);
    this._body.setRotation(this.unparkQuat, false);
    this._body.setLinvel(this.fixedZero, false);
    this._body.setAngvel(this.fixedZero, false);
    this._body.setEnabled(true);
    this._collider.setEnabled(true);
    this.root.visible = true;
    this.root.position.copy(position);
    this.root.quaternion.copy(this.unparkQuat);
    // Reset facing memory to the new character forward (+Z).
    this.lastInputDir.set(0, 0, 1).applyQuaternion(this.unparkQuat);
    this.parked = false;
    this._body.wakeUp();
  }

  /**
   * Per-physics-step brain. Call once per fixed substep BEFORE `world.step()`.
   * The optional `dt` exists only for a uniform controller call shape and is
   * IGNORED — all time terms use the fixed `world.timestep`.
   */
  update(dt?: number): void {
    void dt; // uniform signature; internal dt is world.timestep (fixed)

    // Skip the whole controller loop when disabled or parked
    if (!this.enabled || this.parked) return;
    const characterBody = this._body;
    let isSleeping = characterBody.isSleeping();

    // Correct frame rate difference
    const frameRateCorrection = 60 * this.world.timestep;

    /**
     * Getting all the user input states
     * (run/jump edge state machines run every step, BEFORE the sleep early-out)
     */
    const forward = this.movementState.forward;
    const backward = this.movementState.backward;
    const leftward = this.movementState.leftward;
    const rightward = this.movementState.rightward;
    const run = this.getRunState(this.movementState.run || false);
    const jump = this.getJumpState(this.movementState.jump || false);
    const joystick = this.movementState.joystick;
    const hasControlInput =
      forward ||
      backward ||
      leftward ||
      rightward ||
      jump ||
      Math.abs(joystick.x) > 1e-4 ||
      Math.abs(joystick.y) > 1e-4;

    // Wake on moving platforms or player input so the controller can refresh
    // contact state before applying impulses.
    if (isSleeping && (this.isOnMovingObject || hasControlInput)) {
      characterBody.wakeUp();
      isSleeping = false;
    }

    // If character is sleeping, skip the update to save performance.
    if (isSleeping) return;

    // Update character collider pos/vel/quat/axis
    this.updateCharacterInfo();

    // Update gravity value & direction
    this.updateGravityInfo();

    // Update input direction after gravity/up-axis refresh so slope and
    // movement use current-frame input.
    this.updateForwardDirection();
    this.setInputDirection({ forward, backward, rightward, leftward, joystick });
    const hasMoveInput = this._inputDir.lengthSq() > 0;

    // Update character auto balance
    // (NOTE: consumes LAST step's isZeroGravity — refreshed below; upstream parity)
    if (this.autoBalance && !this.isZeroGravity) this.autoBalanceCharacter(frameRateCorrection);

    // Update ground contact info
    this.floatCharacter();

    // Detect if character is on a moving object
    this.isOnMovingObjectDetect();

    // Compute relative velocity
    this.computeRelativeVelocity();

    // Float character up
    this.applyFloatingForce();

    // Apply character mass to standing object
    this.applyMassOnStandCollider();

    // Detect slope angle below character
    this.slopeDetect();

    // Detect if character is under zero gravity condition
    this.zeroGravityDetect();

    // Detect if character is falling
    this.fallDetect();

    // Apply drag force if character is not moving
    if (!hasMoveInput) this.applyFriction(frameRateCorrection);

    // Apply dynamic gravity scale: grounded / jump-up / fall / exceed-fall-max-vel
    this.applyDynamicGravity();

    // Apply jump impulse to character
    if (jump && this._isOnGround) this.applyJumpImpulse();

    /**
     * Move character model to correct direction and speed
     * (camera-based movement vs character-based movement)
     */
    if (this.isLockForward) {
      // Camera based movement always turns character to camera forward direction
      if (!this.isZeroGravity) this.turnCharacter(this.forwardDirection, frameRateCorrection);
      if (hasMoveInput) this.moveCharacter(run, frameRateCorrection);
      // Keep last input direction same as forward direction
      this.lastInputDir.copy(this.forwardDirection);
    } else {
      // Character based movement
      if (hasMoveInput) {
        if (!this.isZeroGravity) this.turnCharacter(this._inputDir, frameRateCorrection);
        this.moveCharacter(run, frameRateCorrection);
        this.lastInputDir.copy(this._inputDir);
      } else {
        // If no last input, keep character facing forward direction
        if (this.lastInputDir.lengthSq() === 0) this.lastInputDir.copy(this.characterZAxis);
        // Keep character at last input direction, spinning with the platform when idle
        // (applyQuaternion mutates lastInputDir in place — intentional accumulation)
        if (!this.isZeroGravity)
          this.turnCharacter(
            this.isOnMovingObject && this.followPlatform
              ? this.lastInputDir.applyQuaternion(this._turnOnYQuat)
              : this.lastInputDir,
            frameRateCorrection
          );
        // Keep moving direction same as last input direction
        this._movingDirection.copy(this.lastInputDir);
      }
    }

    // Update debug indicators
    if (this.debugEnabled) this.updateDebugger();
  }

  /**
   * Copies the body pose onto `root`. Call AFTER `world.step()` — not needed
   * when `(body, root)` is registered with the PhysicsWorld sync registry.
   */
  syncRoot(): void {
    this.root.position.copy(this._body.translation());
    this.root.quaternion.copy(this._body.rotation());
  }

  /** Removes the body (and its collider) from the world and tears down visuals. */
  dispose(): void {
    this.world.removeRigidBody(this._body);
    this.root.removeFromParent();
    if (this.debugAssets) {
      this.debugAssets.group.removeFromParent();
      for (const item of this.debugAssets.disposables) item.dispose();
      this.debugAssets.velocityArrow.dispose();
      this.debugAssets = null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private per-step helpers (bodies are verbatim ports of the upstream
  // useCallback helpers; comments cite Ecctrl.tsx line numbers)
  // ────────────────────────────────────────────────────────────────────────

  /** Update character collider pos/vel/quat/axis (upstream l.397-412). */
  private updateCharacterInfo(): void {
    const body = this._body;
    this.currentPos.copy(body.translation());
    this.currentQuat.copy(body.rotation());

    this.characterYAxis.set(0, 1, 0).applyQuaternion(this.currentQuat);
    this.characterXAxis.set(1, 0, 0).applyQuaternion(this.currentQuat);
    this.characterZAxis.set(0, 0, 1).applyQuaternion(this.currentQuat);

    // Linear projections use referenceUpAxis; angular use the body's own Y axis.
    this.currentVel.copy(body.linvel());
    this.currentVelOnPlane.copy(this.currentVel).projectOnPlane(this.referenceUpAxis);
    this.currentVelOnUp.copy(this.currentVel).projectOnVector(this.referenceUpAxis);

    this.currentAngVel.copy(body.angvel());
    this.currentAngVelOnPlane.copy(this.currentAngVel).projectOnPlane(this.characterYAxis);
    this.currentAngVelOnUp.copy(this.currentAngVel).projectOnVector(this.characterYAxis);
  }

  /**
   * Update gravity/upAxis direction and value (upstream l.499-513; the custom
   * gravity-field branch is dropped per the v1 port scope — world gravity may
   * still be nonstandard or changed at runtime).
   */
  private updateGravityInfo(): void {
    this.referenceGravity.copy(this.world.gravity);

    this.referenceGravityMag = this.referenceGravity.length();
    this.referenceGravityDir.copy(this.referenceGravity).normalize();
    // Prevent NaN when gravity is zero: fall back to opposite of character up axis.
    if (this.referenceGravityDir.lengthSq() === 0)
      this.referenceGravityDir.copy(this.characterYAxis).negate();
    // slerpVec3 returns its own scratch vector — copy immediately.
    this.gravityDirVec.copy(
      this.slerpVec3(
        this.gravityDirVec,
        this.referenceGravityDir,
        1 - Math.exp(-this.gravityDirLerpSpeed * this.world.timestep),
        this.characterXAxis
      )
    );
    this.upAxisVec.copy(this.gravityDirVec).negate();
  }

  /** Camera-projected forward/rightward directions (upstream l.417-427). */
  private updateForwardDirection(): void {
    if (!this.useCustomForward) {
      this.camera.getWorldDirection(this.forwardDirection);
      this.camRightDirection.crossVectors(this.forwardDirection, this.camera.up).normalize();
      this.forwardDirection.crossVectors(this.referenceUpAxis, this.camRightDirection);
      this.rightwardDirection.crossVectors(this.forwardDirection, this.referenceUpAxis).normalize();
    } else {
      this.forwardDirection.projectOnPlane(this.referenceUpAxis).normalize();
      this.rightwardDirection.crossVectors(this.forwardDirection, this.referenceUpAxis).normalize();
    }
  }

  /** Build the world-space input direction from intents (upstream l.432-449). */
  private setInputDirection(dir: MovementInput): void {
    this._inputDir.set(0, 0, 0);
    // Handle joystick analog input (if available)
    if (dir.joystick && (dir.joystick.x !== 0 || dir.joystick.y !== 0)) {
      this._inputDir
        .addScaledVector(this.forwardDirection, dir.joystick.y)
        .addScaledVector(this.rightwardDirection, dir.joystick.x);
    } else {
      if (dir.forward) this._inputDir.add(this.forwardDirection);
      if (dir.backward) this._inputDir.sub(this.forwardDirection);
      if (dir.leftward) this._inputDir.sub(this.rightwardDirection);
      if (dir.rightward) this._inputDir.add(this.rightwardDirection);
    }
    this._inputDir.normalize();
  }

  /** Upright balance spring torque (upstream l.518-522). */
  private autoBalanceCharacter(fpsCorr: number): void {
    this.balanceCrossAxis.crossVectors(this.characterYAxis, this.upAxisVec);
    const torque = this.balanceCrossAxis
      .multiplyScalar(this.autoBalanceSpringK)
      .sub(this.currentAngVelOnPlane.multiplyScalar(this.autoBalanceDampingC));
    this._body.applyTorqueImpulse(torque.multiplyScalar(fpsCorr), false);
  }

  /** Yaw turn spring torque toward `direction` (upstream l.527-534). */
  private turnCharacter(direction: THREE.Vector3, fpsCorr: number): void {
    this.turnCrossAxis.crossVectors(this.characterZAxis, direction);
    let dot = clamp(this.characterZAxis.dot(direction), -1, 1);
    if (Math.abs(dot) < 1e-10) dot = 0; // prevent dot = -0 flipping atan2
    const angle = Math.atan2(this.turnCrossAxis.dot(this.characterYAxis), dot);
    const torque = this.turnOnYAxis
      .copy(this.characterYAxis)
      .multiplyScalar(angle * this.autoBalanceSpringOnY)
      .sub(this.currentAngVelOnUp.multiplyScalar(this.autoBalanceDampingOnY));
    this._body.applyTorqueImpulse(torque.multiplyScalar(fpsCorr), false);
  }

  /**
   * Ground-query collider filter (upstream l.539-542; userData key renamed
   * `ecctrl` -> `controller`).
   */
  private readonly rayFilter = (collider: RAPIER.Collider): boolean => {
    const userData = collider.parent()?.userData as ControllerUserData | undefined;
    return !(userData?.controller?.excludeRay || userData?.controller?.excludeCharacterRay);
  };

  /**
   * Steep-hit fallback: scan the center ray for the nearest walkable hit
   * (upstream l.544-580).
   */
  private findWalkableCenterRayHit(maxDistance: number): boolean {
    this.castRayHit = null;
    this.ray.origin = this.rayOrigin;
    this.ray.dir = this.rayDirection;

    // Scan center ray for walkable hit
    this.world.intersectionsWithRay(
      this.ray,
      maxDistance,
      false,
      (hit) => {
        const slopeAngle = this.actualSlopeNormalVec.copy(hit.normal).angleTo(this.referenceUpAxis);
        if (
          slopeAngle < this.slopeMaxAngle &&
          (!this.castRayHit || hit.timeOfImpact < this.castRayHit.timeOfImpact)
        ) {
          this.castRayHit = hit;
        }
        return true;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      this._body,
      this.rayFilter
    );

    const selectedRayHit = this.castRayHit as RAPIER.RayColliderIntersection | null;
    if (!selectedRayHit) return false;

    this.rayHit = selectedRayHit;
    this.rayHitBody = selectedRayHit.collider.parent();
    this.actualSlopeNormalVec.copy(selectedRayHit.normal);
    this._actualSlopeAngle = this.actualSlopeNormalVec.angleTo(this.referenceUpAxis);
    this.groundHitDistance = selectedRayHit.timeOfImpact;
    // rayCast-style float distance even when called from shapeCast mode (upstream parity).
    this.groundFloatingDistance = this.rayRadius * 2 + this.floatHeight;
    this.groundHitOrigin.copy(this.rayOrigin);
    this.standingPointFriction = selectedRayHit.collider.friction() ?? 0;
    return true;
  }

  /** Ground detection + grounded-state update (upstream l.582-675). */
  private floatCharacter(): void {
    // Ray origin uses the body's OWN Y axis; direction is gravity-down.
    this.rayOrigin.copy(this.currentPos).addScaledVector(this.characterYAxis, this.rayOriginOffset);
    this.rayDirection.copy(this.referenceUpAxis).negate();
    // Reset previous hit state
    this.rayHit = null;
    this.shapeRayHit = null;
    this.rayHitBody = null;

    // RayCast ground detection
    if (this.groundDetectionMode === "rayCast") {
      this.ray.origin = this.rayOrigin;
      this.ray.dir = this.rayDirection;
      this.castRayHit = this.world.castRayAndGetNormal(
        this.ray,
        this.rayLength,
        false,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        this._body,
        this.rayFilter
      );

      if (this.castRayHit) {
        this.actualSlopeNormalVec.copy(this.castRayHit.normal);
        this._actualSlopeAngle = this.actualSlopeNormalVec.angleTo(this.referenceUpAxis);
        // Use first walkable ray hit
        if (this._actualSlopeAngle < this.slopeMaxAngle) {
          this.rayHit = this.castRayHit;
          this.rayHitBody = this.castRayHit.collider.parent();
          this.groundHitOrigin.copy(this.rayOrigin);
          this.groundHitDistance = this.castRayHit.timeOfImpact;
          this.groundFloatingDistance = this.rayRadius * 2 + this.floatHeight;
          this.standingPointFriction = this.castRayHit.collider.friction() ?? 0;
        }
        // Ignore steep hit and scan center ray below
        else this.findWalkableCenterRayHit(this.rayLength);
      }
    }
    // ShapeCast ground detection
    else if (this.groundDetectionMode === "shapeCast") {
      this.castShapeHit = this.world.castShape(
        this.rayOrigin,
        this._body.rotation(),
        this.rayDirection,
        this.rayShape,
        0,
        this.rayLength,
        false,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        this._body,
        this.rayFilter
      );

      if (this.castShapeHit) {
        this.actualSlopeNormalVec.copy(this.castShapeHit.normal1);
        this._actualSlopeAngle = this.actualSlopeNormalVec.angleTo(this.referenceUpAxis);
        // Use first walkable shape hit
        if (this._actualSlopeAngle < this.slopeMaxAngle) {
          this.shapeRayHit = this.castShapeHit;
          this.groundHitOrigin.copy(this.rayOrigin);
          this.rayHitBody = this.castShapeHit.collider.parent();
          // NOTE: shapecast hits expose snake_case `time_of_impact` (rapier3d-compat).
          this.groundHitDistance = this.castShapeHit.time_of_impact;
          this.groundFloatingDistance = this.rayRadius + this.floatHeight;
          this.standingPointFriction = this.castShapeHit.collider.friction() ?? 0;
        } else {
          // Ignore steep hit and scan center ray below
          this.findWalkableCenterRayHit(this.rayLength + this.rayRadius);
        }
      }
    }

    // Update ground contact state
    if (this.rayHitBody) {
      this._isOnGround =
        this.groundHitDistance < this.groundFloatingDistance + this.rayHitForgiveness;

      if (this._isOnGround) {
        // Retrieve actual standing point
        if (this.rayHit)
          this.standingPoint
            .copy(this.groundHitOrigin)
            .addScaledVector(this.rayDirection, this.groundHitDistance);
        else if (this.shapeRayHit) this.standingPoint.copy(this.shapeRayHit.witness1);
      } else {
        this.standingPointFriction = 0;
      }
    } else {
      this.rayHitBody = null;
      this._isOnGround = false;
      this._actualSlopeAngle = 0;
      this.slopeAngleInFront = 0;
      this.standingPointFriction = 0;
    }
  }

  /** Float spring: I = F * dt (NOT frameRateCorrection-scaled) (upstream l.677-691). */
  private applyFloatingForce(): void {
    const hasGroundHit = this.rayHit || this.shapeRayHit;
    if (!hasGroundHit || !this._isOnGround) {
      this._floatingImpulse.set(0, 0, 0);
      return;
    }

    this.springDistVec
      .copy(this.referenceUpAxis)
      .multiplyScalar(this.groundFloatingDistance - this.groundHitDistance);
    this.dampingVelVec.copy(this._relativeVel).projectOnVector(this.referenceUpAxis);
    this.floatingForce.subVectors(
      this.springDistVec.multiplyScalar(this.springK),
      this.dampingVelVec.multiplyScalar(this.dampingC)
    );
    // Convert force to impulse: I = F * dt (already multiplied by timestep, no fpsCorr)
    this._floatingImpulse.copy(this.floatingForce).multiplyScalar(this.world.timestep);
    // During jump startup, keep support force but skip downward adhesion that
    // can cancel slow-motion jumps.
    if (this._jumpActive && this._floatingImpulse.dot(this.referenceUpAxis) < 0)
      this._floatingImpulse.set(0, 0, 0);
    if (!this._body.isSleeping()) this._body.applyImpulse(this._floatingImpulse, false);
  }

  /** Push the character's weight down into dynamic ground (upstream l.696-705). */
  private applyMassOnStandCollider(): void {
    if (
      !this.rayHitBody ||
      this.rayHitBody.bodyType() !== RAPIER.RigidBodyType.Dynamic ||
      !this._isOnGround
    )
      return;
    // Apply opposite force to standing object
    const impulseMag = Math.max(-this._floatingImpulse.dot(this.upAxisVec), 0);
    const weightMag = this._body.mass() * this.referenceGravityMag * this.world.timestep; // I = F * dt = m * g * dt
    // Gravity is not applied when on ground, so impulseMag is 0 at stable
    // condition — apply a constant weightMag instead.
    this.characterMassImpulse
      .copy(this.gravityDirVec)
      .multiplyScalar(Math.max(impulseMag, weightMag) * this.massRatio);
    if (this.applyCounterMass)
      this.rayHitBody.applyImpulseAtPoint(this.characterMassImpulse, this.standingPoint, true);
  }

  /** Idle drag friction (only called when there is no move input) (upstream l.710-717). */
  private applyFriction(fpsCorr: number): void {
    if (!this.rayHitBody || !this._isOnGround) return;
    // Calculate friction coefficient — the ONLY place slideFrictionCoef refreshes.
    this.slideFrictionCoef = clamp((this.standingPointFriction + this.slideGripFactor) * 0.5, 0, 1);
    // Apply friction impulse, I = m * dv * frictionCoef
    this._dragFrictionImpulse
      .copy(this._relativeVelOnPlane)
      .negate()
      .multiplyScalar(this._body.mass() * this.slideFrictionCoef * clamp(this.decDeltaTime, 0, 1));
    this._body.applyImpulse(this._dragFrictionImpulse.multiplyScalar(fpsCorr), false);
  }

  /** Slope angles under/in front of the character (upstream l.722-737). */
  private slopeDetect(): void {
    const hasGroundHit = this.rayHit || this.shapeRayHit;
    if (hasGroundHit) {
      // Actual slope angle from upAxis
      this._actualSlopeAngle = this.actualSlopeNormalVec.angleTo(this.referenceUpAxis);
      if (this._isOnGround) {
        // Slope angle in front of character moving direction (no clamp on the dot — upstream parity)
        this.slopeAngleInFront = -Math.asin(this.actualSlopeNormalVec.dot(this._inputDir));
      } else {
        this.slopeAngleInFront = 0;
      }
    } else {
      this._actualSlopeAngle = 0;
      this.slopeAngleInFront = 0;
    }
  }

  /** Falling detect (upstream l.742-744). */
  private fallDetect(): void {
    this._isFalling = this.currentVelOnUp.dot(this.upAxisVec) < 0 && !this._isOnGround;
  }

  /** Zero gravity detect (upstream l.749-751). */
  private zeroGravityDetect(): void {
    this.isZeroGravity = this.referenceGravityMag === 0;
  }

  /**
   * Moving/rotating platform detection + inherited velocity (upstream
   * l.756-794). Matches dynamic (0) and kinematic-position (2) bodies only —
   * velocity-based kinematic bodies are NOT matched (upstream parity).
   */
  private isOnMovingObjectDetect(): void {
    if (
      this.followPlatform &&
      this.rayHitBody &&
      this._isOnGround &&
      (this.rayHitBody.bodyType() === RAPIER.RigidBodyType.Dynamic ||
        this.rayHitBody.bodyType() === RAPIER.RigidBodyType.KinematicPositionBased)
    ) {
      this.isOnMovingObject = true;

      // Find the proper rigid body mass ratio
      if (this.rayHitBody.bodyType() === RAPIER.RigidBodyType.Dynamic) {
        const ratio = clamp(this.rayHitBody.mass() / Math.max(this._body.mass(), 1e-6), 0, 1);
        this.massRatio = evaluateCurveLUT(ratio, this.massRatioFallOffCurve);
      } else {
        this.massRatio = 1;
      }

      // Distance from character to the platform's center of mass
      this.movingObjectPosition.copy(this.rayHitBody.worldCom());
      this.distanceFromCharacterToObjectPoint.copy(this.currentPos).sub(this.movingObjectPosition);
      // Moving object linear velocity
      this.movingObjectLinearVelocity.copy(this.rayHitBody.linvel());
      // Moving object angular velocity
      this.movingObjectAngularVelocity.copy(this.rayHitBody.angvel());
      // Combine linear velocity and angular velocity into movingObjectVelocity
      // (only the rotational part is scaled by the mass-ratio falloff)
      this.movingObjectAngvelToLinvel.crossVectors(
        this.movingObjectAngularVelocity,
        this.distanceFromCharacterToObjectPoint
      );
      this.movingObjectVelocity
        .copy(this.movingObjectLinearVelocity)
        .addScaledVector(this.movingObjectAngvelToLinvel, this.massRatio);
      this.movingObjectVelocityOnPlane
        .copy(this.movingObjectVelocity)
        .projectOnPlane(this.referenceUpAxis);
      this.movingObjectVelocityOnUp
        .copy(this.movingObjectVelocity)
        .projectOnVector(this.referenceUpAxis);

      // Compute moving object angular velocity turn quaternion
      this.movingObjectAngularVelocityValue = this.movingObjectAngularVelocity.length();
      this.movingObjectAngularVelocityAxis.copy(this.movingObjectAngularVelocity).normalize();
      this._turnOnYQuat.setFromAxisAngle(
        this.movingObjectAngularVelocityAxis,
        this.movingObjectAngularVelocityValue * this.world.timestep
      );
    } else {
      this.isOnMovingObject = false;
      this.movingObjectVelocity.set(0, 0, 0);
      this.movingObjectVelocityOnPlane.set(0, 0, 0);
      this.movingObjectVelocityOnUp.set(0, 0, 0);
      this._turnOnYQuat.identity();
      this.massRatio = 1;
    }
  }

  /** Velocity relative to the platform under the character (upstream l.799-808). */
  private computeRelativeVelocity(): void {
    this._relativeVel.copy(this.currentVel);
    this._relativeVelOnPlane.copy(this.currentVelOnPlane);
    this._relativeVelOnUp.copy(this.currentVelOnUp);
    if (this.isOnMovingObject && this.followPlatform) {
      this._relativeVel.sub(this.movingObjectVelocity);
      this._relativeVelOnPlane.sub(this.movingObjectVelocityOnPlane);
      this._relativeVelOnUp.sub(this.movingObjectVelocityOnUp);
    }
  }

  /**
   * Jump: velocity REPLACE via setLinvel, re-fired every step while
   * `jumpActive && isOnGround` (upstream l.813-823 — do not add a fired-once latch).
   */
  private applyJumpImpulse(): void {
    this.jumpDirection
      .copy(this.referenceUpAxis)
      .addScaledVector(this.actualSlopeNormalVec, this.slopeJumpFactor)
      .normalize();
    this.jumpVelocityVec
      .copy(this._relativeVelOnPlane)
      .add(this.movingObjectVelocity)
      .addScaledVector(this.jumpDirection, this.jumpVel);
    this._body.setLinvel(this.jumpVelocityVec, true);
    // Apply opposite impulse to dynamic ground (not fpsCorr-scaled)
    if (
      this.applyCounterJumpImp &&
      this.rayHitBody &&
      this.rayHitBody.bodyType() === RAPIER.RigidBodyType.Dynamic
    ) {
      this.jumpImpulseToGround
        .copy(this.jumpDirection)
        .multiplyScalar(-this._body.mass() * this.jumpVel * this.massRatio * this.counterJumpImpFactor);
      this.rayHitBody.applyImpulseAtPoint(this.jumpImpulseToGround, this.standingPoint, true);
    }
  }

  /**
   * Gravity scale control: zero on ground, `fallingGravityScale` while falling,
   * zero past terminal velocity, initial scale otherwise (upstream l.829-848).
   */
  private applyDynamicGravity(): void {
    const body = this._body;
    // Falling condition
    if (this._isFalling) {
      // Past fallingMaxVel: cut gravity to 0 (terminal velocity), else apply fallingGravityScale
      if (this.currentVelOnUp.lengthSq() > this.fallingMaxVel * this.fallingMaxVel) {
        if (body.gravityScale() !== 0) body.setGravityScale(0, false);
      } else {
        if (body.gravityScale() !== this.fallingGravityScale)
          body.setGravityScale(this.fallingGravityScale, false);
      }
    }
    // Jump up and ground condition
    else {
      if (this._isOnGround) {
        if (body.gravityScale() !== 0) body.setGravityScale(0, false);
      } else {
        if (body.gravityScale() !== this.initialGravityScale)
          body.setGravityScale(this.initialGravityScale, false);
      }
    }
  }

  /** Jump edge/timer state machine (upstream l.853-871). */
  private getJumpState(jumpPressed: boolean): boolean {
    if (this._jumpActive) {
      this.jumpElapsedTime += this.world.timestep;
      // Once jump duration is exceeded, set jump to inactive
      if (this.jumpElapsedTime >= this.jumpDuration) this._jumpActive = false;
    } else {
      // If jump key is pressed and can jump again, activate the jump and block
      // continuous jumping until the key is released.
      if (jumpPressed && this.canJumpAgain) {
        this._jumpActive = true;
        this.jumpElapsedTime = 0;
        this.canJumpAgain = false;
      }
      // Once jump key is released, allow jumping again
      if (!jumpPressed) this.canJumpAgain = true;
    }
    return this._jumpActive;
  }

  /** Run toggle/hold state machine (upstream l.876-886). */
  private getRunState(runPressed: boolean): boolean {
    if (this.enableToggleRun) {
      // Only toggle run state on the key's rising edge
      if (runPressed && !this.canRunAgain) this._runActive = !this._runActive;
      this.canRunAgain = runPressed;
    } else {
      this._runActive = runPressed;
    }
    return this._runActive;
  }

  /** Move impulse (slope climb + rejectVel + above-CoM lean) (upstream l.454-494). */
  private moveCharacter(run: boolean, fpsCorr: number): void {
    // Moving direction: rotate inputDir up/down the slope in front
    this.movingDirCrossAxis.crossVectors(this._inputDir, this.referenceUpAxis);
    this._movingDirection
      .copy(this._inputDir)
      .applyAxisAngle(this.movingDirCrossAxis, this.slopeAngleInFront);

    // Rejection velocity: cancel off-axis drift (zeroed while airborne)
    this.wantToMoveVel.copy(this._relativeVelOnPlane).projectOnVector(this._inputDir);
    this.rejectVel
      .copy(this._relativeVelOnPlane)
      .sub(this.wantToMoveVel)
      .multiplyScalar(this._isOnGround ? this.rejectVelFactor : 0);

    // Required moving impulse: I = m * dv
    // (slideFrictionCoef may be stale here — it refreshes only in applyFriction; upstream parity)
    const multiplier =
      this._body.mass() *
      clamp(this.accDeltaTime, 0, 1) *
      (this._isOnGround ? this.slideFrictionCoef : this.airDragFactor) *
      (this._actualSlopeAngle > this.slopeMaxAngle ? this.airDragFactor : 1);
    this.baseImpulse
      .copy(this._movingDirection)
      .multiplyScalar(run ? this.maxRunVel : this.maxWalkVel)
      .sub(this._relativeVelOnPlane);
    this._moveImpulse.copy(this.baseImpulse).sub(this.rejectVel).multiplyScalar(multiplier);

    // Apply the impulse above the center of mass -> run lean
    this.moveImpulsePoint
      .copy(this.currentPos)
      .addScaledVector(this.characterYAxis, this.moveImpulsePointOffset);
    this._body.applyImpulseAtPoint(
      this._moveImpulse.multiplyScalar(fpsCorr),
      this.moveImpulsePoint,
      true
    );

    // Apply opposite moving impulse to the standing point (dynamic ground only)
    if (
      this.applyCounterMoveImp &&
      this.rayHitBody &&
      this._isOnGround &&
      this.rayHitBody.bodyType() === RAPIER.RigidBodyType.Dynamic
    ) {
      this.moveImpulseToGround
        .copy(this.baseImpulse)
        .multiplyScalar(multiplier * this.massRatio * this.counterMoveImpFactor)
        .negate();
      this.rayHitBody.applyImpulseAtPoint(
        this.moveImpulseToGround.multiplyScalar(fpsCorr),
        this.standingPoint,
        true
      );
    } else {
      this.moveImpulseToGround.set(0, 0, 0);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Debug indicators (parity-non-critical helper; simplified from upstream
  // l.299-360 / 891-931 / 1112-1159)
  // ────────────────────────────────────────────────────────────────────────

  private buildDebugAssets(scene: THREE.Scene): void {
    const r = this.capsuleRadius;
    const rayCastGeo = new THREE.CircleGeometry(
      this.groundDetectionMode === "rayCast" ? this.rayRadius / 2 : this.rayRadius,
      12
    );
    const rayCastMat = new THREE.MeshBasicMaterial({
      color: 0x9370db,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
    });
    const standingMat = new THREE.MeshBasicMaterial({
      color: 0x800080,
      transparent: true,
      opacity: 0.5,
    });
    const standingGeo = new THREE.OctahedronGeometry(this.rayRadius / 2, 3);
    const forwardRingGeo = new THREE.RingGeometry(r * 2, r * 2.1, 32);
    const forwardPointerGeo = new THREE.PlaneGeometry(r / 2, r / 2);
    const forwardIndicatorMat = new THREE.MeshBasicMaterial({
      color: 0x007fff,
      side: THREE.DoubleSide,
    });
    const movePointerGeo = new THREE.OctahedronGeometry(r / 3, 0);
    const moveRingGeo = new THREE.RingGeometry(r * 1.5, r * 2, 32);
    const moveIndicatorMat = new THREE.MeshBasicMaterial({
      color: 0x4169e1,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
    });

    const group = new THREE.Group();

    const forwardIndicator = new THREE.Group();
    const forwardRing = new THREE.Mesh(forwardRingGeo, forwardIndicatorMat);
    forwardRing.rotation.set(-Math.PI / 2, 0, 0);
    const forwardPointer = new THREE.Mesh(forwardPointerGeo, forwardIndicatorMat);
    forwardPointer.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
    forwardPointer.position.set(0, 0, -r * 2);
    forwardIndicator.add(forwardRing, forwardPointer);

    const rayStart = new THREE.Mesh(rayCastGeo, rayCastMat);
    const rayEnd = new THREE.Mesh(rayCastGeo, rayCastMat);
    const rayTrigger = new THREE.Mesh(rayCastGeo, standingMat);
    const rayStable = new THREE.Mesh(rayCastGeo, standingMat);
    const standingPoint = new THREE.Mesh(standingGeo, rayCastMat);

    const moveIndicator = new THREE.Group();
    const movePointer = new THREE.Mesh(movePointerGeo, moveIndicatorMat);
    movePointer.scale.set(0.5, 0.5, 2);
    movePointer.position.set(0, 0, -r * 2);
    const moveRing = new THREE.Mesh(moveRingGeo, moveIndicatorMat);
    moveRing.rotation.set(-Math.PI / 2, 0, 0);
    moveIndicator.add(movePointer, moveRing);

    const velocityArrow = new THREE.ArrowHelper(undefined, undefined, undefined, 0xff0000);

    group.add(forwardIndicator, rayStart, rayEnd, rayTrigger, rayStable, standingPoint, moveIndicator, velocityArrow);
    scene.add(group);

    this.debugAssets = {
      group,
      forwardIndicator,
      moveIndicator,
      rayStart,
      rayEnd,
      rayTrigger,
      rayStable,
      standingPoint,
      velocityArrow,
      disposables: [
        rayCastGeo,
        rayCastMat,
        standingGeo,
        standingMat,
        forwardRingGeo,
        forwardPointerGeo,
        forwardIndicatorMat,
        movePointerGeo,
        moveRingGeo,
        moveIndicatorMat,
      ],
    };
  }

  private readonly forwardIndicatorMatrix = new THREE.Matrix4();
  private readonly moveIndicatorMatrix = new THREE.Matrix4();
  private readonly currVelDir = new THREE.Vector3();

  /** Debug indicator poses (upstream l.891-931). */
  private updateDebugger(): void {
    const d = this.debugAssets;
    if (!d) return;

    // Look-forward direction indicator
    d.forwardIndicator.position.copy(this.rayOrigin);
    this.forwardIndicatorMatrix.lookAt(this.fixedOrigin, this.forwardDirection, this.referenceUpAxis);
    d.forwardIndicator.quaternion.setFromRotationMatrix(this.forwardIndicatorMatrix);

    // Floating shape cast indicator
    const debugStableDistance =
      this.groundDetectionMode === "rayCast"
        ? this.rayRadius * 2 + this.floatHeight
        : this.rayRadius + this.groundFloatingDistance;
    d.rayStart.position.copy(this.rayOrigin);
    d.rayStart.quaternion.setFromUnitVectors(this.fixedZAxis, this.referenceUpAxis);
    d.rayEnd.position.copy(this.rayOrigin).addScaledVector(this.referenceUpAxis, -this.rayLength);
    d.rayEnd.quaternion.setFromUnitVectors(this.fixedZAxis, this.referenceUpAxis);
    d.rayTrigger.position
      .copy(this.rayOrigin)
      .addScaledVector(this.referenceUpAxis, -debugStableDistance - this.rayHitForgiveness);
    d.rayTrigger.quaternion.setFromUnitVectors(this.fixedZAxis, this.referenceUpAxis);
    d.rayStable.position
      .copy(this.rayOrigin)
      .addScaledVector(this.referenceUpAxis, -debugStableDistance);
    d.rayStable.quaternion.setFromUnitVectors(this.fixedZAxis, this.referenceUpAxis);
    d.standingPoint.position.copy(this.standingPoint);

    // Want-to-move direction indicator
    d.moveIndicator.position.copy(this.rayOrigin);
    this.moveIndicatorMatrix.lookAt(this.fixedOrigin, this._movingDirection, this.referenceUpAxis);
    d.moveIndicator.quaternion.setFromRotationMatrix(this.moveIndicatorMatrix);

    // Current moving velocity arrow
    d.velocityArrow.position.copy(this.currentPos);
    d.velocityArrow.setDirection(this.currVelDir.copy(this._relativeVel).normalize());
    d.velocityArrow.setLength(
      this._relativeVel.length() / (this._runActive ? this.maxRunVel : this.maxWalkVel)
    );
  }
}
