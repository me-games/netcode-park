// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TS port of the ecctrl drone controller (PD attitude/position flight
// brain + thrust-propeller mixer; React/R3F lifecycle replaced by a plain class
// with an explicit per-physics-step update()).

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { createSlerpVec3 } from "../shared/math.ts";

/**
 * How the drone is flown.
 *
 * - `"VELOCITY"` — stick-flying: inputs command velocities (throttle/yaw/
 *   pitch/roll). Use while a player is on board.
 * - `"POSITION"` — autopilot: the drone holds `targetPos` and faces
 *   `targetFwd` (set both via `setTarget`). Use for parked/idle drones.
 */
export type DroneControlMode = "VELOCITY" | "POSITION";

/** Analog stick values, each axis in [-1, 1]. */
export interface DroneJoystickInput {
  x: number;
  y: number;
}

/**
 * Drone movement input (all optional — `setMovement` merges only the keys you
 * pass). Left stick = throttle (y) / yaw (x); right stick = pitch (y) /
 * roll (x). Boolean keys map to full-deflection stick input.
 */
export interface DroneInput {
  throttleUp?: boolean;
  throttleDown?: boolean;
  yawLeft?: boolean;
  yawRight?: boolean;
  pitchForward?: boolean;
  pitchBackward?: boolean;
  rollLeft?: boolean;
  rollRight?: boolean;
  /** Left stick: y = climb/descend, x = yaw. */
  joystickL?: DroneJoystickInput;
  /** Right stick: y = pitch (forward is body +Z), x = roll. */
  joystickR?: DroneJoystickInput;
}

/**
 * Drone flight configuration (PD gains keep their upstream SCREAMING_SNAKE
 * names on purpose — they are the parity-checked crown jewels).
 *
 * Tuning hints:
 * - Feels sluggish to tilt -> raise `TILT_P`; wobbles/overshoots -> raise
 *   `TILT_D`.
 * - `VERT_POS_*` / `HORIZ_POS_*` are POSITION-mode gains in absolute force
 *   units — they must scale with the drone's mass (a 10x heavier drone wants
 *   ~10x larger values).
 * - `HORIZ_VEL_P` / `VERT_VEL_P` are VELOCITY-mode gains in acceleration
 *   units — mass-independent, usually fine as-is.
 * - `airDragFactor` is an absolute force per (m/s): meaningful on a 2 kg
 *   drone, cosmetic on a 300 kg one.
 */
export interface DroneConfig {
  controlMode: DroneControlMode;
  /** Max yaw rate in rad/s. */
  maxYawRate: number;
  /** Max horizontal speed in m/s (VELOCITY-mode stick target). */
  maxHorizSpeed: number;
  /** Max vertical speed in m/s (VELOCITY-mode stick target). */
  maxVertSpeed: number;
  /** Max tilt from level, in radians. Used as tan(maxTiltAngle) internally. */
  maxTiltAngle: number;
  /** Linear air-drag impulse coefficient (absolute, not mass-relative). */
  airDragFactor: number;
  TILT_P: number;
  TILT_D: number;
  YAW_POS_P: number;
  YAW_VEL_P: number;
  VERT_POS_P: number;
  VERT_POS_D: number;
  HORIZ_POS_P: number;
  HORIZ_POS_D: number;
  HORIZ_VEL_P: number;
  VERT_VEL_P: number;
}

/** Library defaults (upstream values, verbatim). */
export const DEFAULT_DRONE_CONFIG: DroneConfig = {
  controlMode: "VELOCITY",
  maxYawRate: 2,
  maxHorizSpeed: 30,
  maxVertSpeed: 8,
  maxTiltAngle: Math.PI / 4, // 45 degree in radian
  airDragFactor: 0.2,
  // PD controller setups
  TILT_P: 15,
  TILT_D: 3,
  YAW_POS_P: 6,
  YAW_VEL_P: 4,
  // Position based config
  VERT_POS_P: 9,
  VERT_POS_D: 7,
  HORIZ_POS_P: 5,
  HORIZ_POS_D: 5.5,
  // Velocity based config
  HORIZ_VEL_P: 1,
  VERT_VEL_P: 2,
};

/**
 * Per-propeller construction options.
 *
 * `object` is the mount node — it MUST be a descendant of the drone chassis
 * object, and its local +Y is the thrust axis. (Port note: replaces the
 * upstream JSX `<ThrustPropeller position=...>` group; `spinModel` replaces
 * the upstream `children` + `showPropellerModel` pair — passing a spinModel
 * enables the spin visual.)
 *
 * Tuning hints: size `maxThrust` so that total thrust is about twice the
 * drone's weight (hover throttle near 0.5 gives the best attitude authority).
 * Diagonal propeller pairs must share the same `invertTorque` value or the
 * reaction torques will not cancel and the drone yaws constantly.
 */
export interface PropellerOptions {
  /** Mount node (descendant of the chassis). Local +Y = thrust axis. */
  object: THREE.Object3D;
  name?: string;
  /** Stable id; auto-generated when omitted. */
  id?: string;
  enable?: boolean;
  /** Max thrust in newtons at full throttle. Default 500. */
  maxThrust?: number;
  /** Reaction torque = maxThrust * torqueRatio. Default 0.6. */
  torqueRatio?: number;
  /** Flip the thrust axis to local -Y. */
  invertThrust?: boolean;
  /** Flip the reaction-torque direction (counter-rotating propeller). */
  invertTorque?: boolean;
  /** Optional visual spun around its local Y by the throttle. */
  spinModel?: THREE.Object3D;
  propellerModelUpdate?: boolean;
  /** Max visual spin in rad per 60 Hz frame. Default 50. */
  propellerModelMaxSpin?: number;
  propellerModelLerpSpinRate?: number;
  /**
   * Attach debug indicators (thrust/torque arrows + axis markers) under the
   * mount. Default false (upstream demo default was true — deliberate flip).
   */
  debug?: boolean;
  debuggerScale?: number;
  debuggerArrowScale?: number;
}

/**
 * Live per-propeller state. All vectors are reused internal instances updated
 * every physics step — read-only for consumers (copy, never mutate).
 */
export interface PropellerState {
  readonly id: string;
  name: string;
  enable: boolean;
  maxThrust: number;
  torqueRatio: number;
  invertThrust: boolean;
  invertTorque: boolean;
  /** Local potential values in vehicle space (updated every step). */
  thrustPos: THREE.Vector3;
  thrustDir: THREE.Vector3;
  thrustPot: THREE.Vector3;
  torqueDir: THREE.Vector3;
  torquePot: THREE.Vector3;
  /** Actual mixer output in world space (updated when impulses apply). */
  worldThrustPos: THREE.Vector3;
  worldThrustDir: THREE.Vector3;
  worldTorqueDir: THREE.Vector3;
  thrustImpulse: THREE.Vector3;
  torqueImpulse: THREE.Vector3;
  /** Mixer output this step, 0..1. */
  finalThrottle: number;
  /** Last throttle fed back via setThrottle (spin visual + sleep check). */
  throttle: number;
  /** Set the throttle directly (clamped to 0..1). */
  setThrottle(value: number): void;
  /** Max potential impulse components (signed). */
  lx: number;
  ly: number;
  lz: number;
  ax: number;
  ay: number;
  az: number;
}

export interface DroneControllerOptions {
  world: RAPIER.World;
  /**
   * Caller-created DYNAMIC rigid body. Attach colliders yourself (e.g. via
   * shared/colliders.ts). The controller never creates or frees the body.
   */
  body: RAPIER.RigidBody;
  /**
   * Visual root synced to the body. Register it with the physics-world
   * body<->Object3D registry; propeller mounts must be its descendants.
   */
  chassis: THREE.Object3D;
  /** Convenience: forwarded to addPropeller(). */
  propellers?: PropellerOptions[];
  /** Merged over DEFAULT_DRONE_CONFIG. */
  config?: Partial<DroneConfig>;
  enabled?: boolean;
  /** Gravity-direction smoothing rate (1 - exp(-k*dt)). Default 6. */
  gravityDirLerpSpeed?: number;
}

// Internal per-propeller bookkeeping (state + visuals + debug assets).
type PropellerEntry = {
  state: PropellerState;
  mount: THREE.Object3D;
  spinModel: THREE.Object3D | null;
  propellerModelUpdate: boolean;
  propellerModelMaxSpin: number;
  propellerModelLerpSpinRate: number;
  debuggerArrowScale: number;
  throttle: number;
  spinVel: number;
  debugGroup: THREE.Group | null;
  thrustArrow: THREE.ArrowHelper | null;
  torqueArrow: THREE.ArrowHelper | null;
  debugDisposables: Array<{ dispose(): void }>;
};

// Debug indicator colors (upstream constants).
const EC_RED = "#FA8787";
const EC_GREEN = "#96FA87";
const EC_BLUE = "#87CEFA";
const EC_AZURE = "#F0FFFF";
const EC_MED_PURPLE = "#9370DB";

const { clamp, lerp, generateUUID } = THREE.MathUtils;

/**
 * PD-controlled quadcopter (or any multi-rotor) flight controller.
 *
 * Physics model: each propeller contributes a thrust potential along its
 * mount's local +Y plus a reaction torque; the brain computes a hover
 * throttle (weight / total world-up thrust potential) and mixes per-propeller
 * attitude corrections on top, clamped so attitude control never costs
 * altitude (`maxSafeMix = min(1 - hover, hover)`).
 *
 * Loop contract: call `update()` exactly once per fixed physics step, BEFORE
 * `world.step()`. All internal math uses `world.timestep` — the `dt` argument
 * is accepted only for a uniform controller call shape and ignored.
 */
export class DroneController {
  private readonly worldRef: RAPIER.World;
  private readonly bodyRef: RAPIER.RigidBody;
  private readonly chassisRef: THREE.Object3D;
  private config: DroneConfig;
  private maxTiltTan: number;
  private isEnabled: boolean;
  private readonly gravityDirLerpSpeed: number;

  // Vehicle snapshot (stale while the body sleeps — on purpose).
  private readonly vehiclePos = new THREE.Vector3();
  private readonly vehicleQuat = new THREE.Quaternion();
  private readonly vehicleInvertQuat = new THREE.Quaternion();
  private readonly vehicleLinVel = new THREE.Vector3();
  private readonly vehicleAngVel = new THREE.Vector3();
  private readonly vehicleXAxis = new THREE.Vector3();
  private readonly vehicleYAxis = new THREE.Vector3();
  private readonly vehicleZAxis = new THREE.Vector3();

  // Gravity plumbing (world gravity only; custom gravity fields are out of scope).
  private readonly upAxisVec = new THREE.Vector3();
  private readonly referenceGravity = new THREE.Vector3();
  private referenceGravityMag = 0;
  private readonly referenceGravityDir = new THREE.Vector3();
  private readonly gravityDirVec = new THREE.Vector3();
  private readonly slerpVec3 = createSlerpVec3();

  // Drone brain scratch (pre-allocated once; zero per-frame allocation).
  private hoverThrottleValue = 0;
  private readonly targetUp = new THREE.Vector3();
  private readonly tiltError = new THREE.Vector3();
  private readonly tiltAngVel = new THREE.Vector3();
  private readonly torqueWorld = new THREE.Vector3();
  private readonly torqueBody = new THREE.Vector3();
  private readonly airDragImpulse = new THREE.Vector3();
  private readonly worldThrustDir = new THREE.Vector3();
  private readonly worldThrustPos = new THREE.Vector3();
  private readonly worldTorqueDir = new THREE.Vector3();
  // Position based scratch
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetHeading = new THREE.Vector3();
  private readonly targetFwdVec = new THREE.Vector3();
  private readonly currentFwd = new THREE.Vector3();
  private readonly posError = new THREE.Vector3();
  private readonly horizPosError = new THREE.Vector3();
  private readonly horizLinVel = new THREE.Vector3();
  private readonly horizForce = new THREE.Vector3();
  // Velocity based scratch
  private readonly worldXAxis = new THREE.Vector3();
  private readonly worldZAxis = new THREE.Vector3();
  private readonly horizAccCmd = new THREE.Vector3();
  private readonly targetLinVel = new THREE.Vector3();
  private readonly linVelError = new THREE.Vector3();
  // Propeller scratch
  private readonly propWorldPos = new THREE.Vector3();
  private readonly propWorldQuat = new THREE.Quaternion();
  private readonly propLocalPos = new THREE.Vector3();
  private readonly propLocalQuat = new THREE.Quaternion();
  private readonly propThrustDir = new THREE.Vector3();
  private readonly propThrustForce = new THREE.Vector3();
  private readonly propLeverageTorque = new THREE.Vector3();
  private readonly propReactionTorqueDir = new THREE.Vector3();
  private readonly propReactionTorque = new THREE.Vector3();
  private readonly propTorqueInfluence = new THREE.Vector3();

  // Propeller overall potential (signed linear sums, absolute angular sums).
  private readonly propellerPotential = {
    sumLX: 0,
    sumLY: 0,
    sumLZ: 0,
    sumAX: 0,
    sumAY: 0,
    sumAZ: 0,
  };

  // Input state (all merged in place by setMovement).
  private readonly movementState: Required<
    Omit<DroneInput, "joystickL" | "joystickR">
  > & { joystickL: DroneJoystickInput; joystickR: DroneJoystickInput } = {
    throttleUp: false,
    throttleDown: false,
    yawLeft: false,
    yawRight: false,
    pitchForward: false,
    pitchBackward: false,
    rollLeft: false,
    rollRight: false,
    joystickL: { x: 0, y: 0 },
    joystickR: { x: 0, y: 0 },
  };

  private readonly propellers = new Map<string, PropellerEntry>();
  private readonly propellerStates = new Map<string, PropellerState>();

  constructor(options: DroneControllerOptions) {
    this.worldRef = options.world;
    this.bodyRef = options.body;
    this.chassisRef = options.chassis;
    this.config = { ...DEFAULT_DRONE_CONFIG, ...options.config };
    this.maxTiltTan = Math.tan(this.config.maxTiltAngle);
    this.isEnabled = options.enabled ?? true;
    this.gravityDirLerpSpeed = options.gravityDirLerpSpeed ?? 6;
    if (options.propellers) {
      for (const propellerOptions of options.propellers) {
        this.addPropeller(propellerOptions);
      }
    }
  }

  // ---- per-frame ----

  /**
   * Advance the drone one physics step. Call exactly once per fixed step,
   * before `world.step()`. `dt` is ignored — `world.timestep` is the only dt.
   */
  update(_dt?: number): void {
    // Skip the whole vehicle loop when disabled
    if (!this.isEnabled) return;

    // Update snapshot + gravity only while the body is awake (stale-on-sleep
    // is upstream behavior — the sleep gate below still needs the old values).
    if (!this.bodyRef.isSleeping()) {
      this.updateVehicleInfo();
      this.updateGravityInfo();
    }

    // Write the exact body pose onto the chassis object and refresh world
    // matrices, so the propeller mounts' getWorldPosition/Quaternion reflect
    // the CURRENT body pose (pre-step; the post-step registry sync agrees).
    this.chassisRef.position.copy(this.vehiclePos);
    this.chassisRef.quaternion.copy(this.vehicleQuat);
    this.chassisRef.updateWorldMatrix(true, true);

    // Per-propeller potentials/visuals must be fresh BEFORE the brain runs
    // (upstream got this ordering from R3F child-effects-first registration).
    const frameRateCorrection = 60 * this.worldRef.timestep;
    for (const entry of this.propellers.values()) {
      if (!entry.state.enable) continue;
      this.updatePropellerInfo(entry);
      if (entry.propellerModelUpdate && entry.spinModel) {
        this.updatePropellerModel(entry, frameRateCorrection);
      }
      this.updateDebugger(entry);
    }

    // Apply drone control logics whenever there is a propeller registered
    // (runs even while asleep — the mixer owns the wake check).
    if (this.propellers.size > 0) this.applyDroneControl();
  }

  // ---- imperative handle ----

  /**
   * Merge movement input. Only keys that are defined are copied; joystick
   * values are copied field-wise (the caller's object is never stored).
   */
  setMovement(movement: DroneInput): void {
    const state = this.movementState;
    if (movement.throttleUp !== undefined) state.throttleUp = movement.throttleUp;
    if (movement.throttleDown !== undefined) state.throttleDown = movement.throttleDown;
    if (movement.yawLeft !== undefined) state.yawLeft = movement.yawLeft;
    if (movement.yawRight !== undefined) state.yawRight = movement.yawRight;
    if (movement.pitchForward !== undefined) state.pitchForward = movement.pitchForward;
    if (movement.pitchBackward !== undefined) state.pitchBackward = movement.pitchBackward;
    if (movement.rollLeft !== undefined) state.rollLeft = movement.rollLeft;
    if (movement.rollRight !== undefined) state.rollRight = movement.rollRight;
    if (movement.joystickL) {
      state.joystickL.x = movement.joystickL.x;
      state.joystickL.y = movement.joystickL.y;
    }
    if (movement.joystickR) {
      state.joystickR.x = movement.joystickR.x;
      state.joystickR.y = movement.joystickR.y;
    }
  }

  /**
   * Set the POSITION-mode hold target: `pos` = hover position, `dir` = facing
   * direction. Typical parking recipe: `setTarget(drone.currPos,
   * drone.bodyZAxis)` then `setControlMode("POSITION")`.
   */
  setTarget(pos?: THREE.Vector3, dir?: THREE.Vector3): void {
    if (pos) this.targetPosition.copy(pos);
    if (dir) this.targetHeading.copy(dir);
  }

  /**
   * Register a propeller. Returns its live state object. If a propeller with
   * the same id already exists, that existing state is returned unchanged.
   */
  addPropeller(options: PropellerOptions): PropellerState {
    const id = String(options.id ?? generateUUID());
    const existing = this.propellers.get(id);
    if (existing) return existing.state;

    const entry: PropellerEntry = {
      mount: options.object,
      spinModel: options.spinModel ?? null,
      propellerModelUpdate: options.propellerModelUpdate ?? true,
      propellerModelMaxSpin: options.propellerModelMaxSpin ?? 50,
      propellerModelLerpSpinRate: options.propellerModelLerpSpinRate ?? 10,
      debuggerArrowScale: options.debuggerArrowScale ?? 35,
      throttle: 0,
      spinVel: 0,
      debugGroup: null,
      thrustArrow: null,
      torqueArrow: null,
      debugDisposables: [],
      state: undefined as unknown as PropellerState,
    };
    const state: PropellerState = {
      id,
      name: options.name ?? "",
      enable: options.enable ?? true,
      maxThrust: options.maxThrust ?? 500,
      torqueRatio: options.torqueRatio ?? 0.6,
      invertThrust: options.invertThrust ?? false,
      invertTorque: options.invertTorque ?? false,
      thrustPos: new THREE.Vector3(),
      thrustDir: new THREE.Vector3(),
      thrustPot: new THREE.Vector3(),
      torqueDir: new THREE.Vector3(),
      torquePot: new THREE.Vector3(),
      worldThrustPos: new THREE.Vector3(),
      worldThrustDir: new THREE.Vector3(),
      worldTorqueDir: new THREE.Vector3(),
      thrustImpulse: new THREE.Vector3(),
      torqueImpulse: new THREE.Vector3(),
      finalThrottle: 0,
      throttle: 0,
      setThrottle: (value: number) => {
        entry.throttle = clamp(value, 0, 1);
      },
      lx: 0,
      ly: 0,
      lz: 0,
      ax: 0,
      ay: 0,
      az: 0,
    };
    entry.state = state;

    if (options.debug ?? false) this.buildDebugIndicators(entry, options);

    this.propellers.set(id, entry);
    this.propellerStates.set(id, state);
    return state;
  }

  /** Unregister a propeller (and dispose its debug helpers). */
  removePropeller(id: string): boolean {
    const entry = this.propellers.get(id);
    if (!entry) return false;
    this.disposePropellerDebug(entry);
    this.propellerStates.delete(id);
    return this.propellers.delete(id);
  }

  /** Switch between stick flying ("VELOCITY") and autopilot ("POSITION"). */
  setControlMode(mode: DroneControlMode): void {
    this.config.controlMode = mode;
  }

  /** Pause/resume the whole controller (no impulses while disabled). */
  setEnabled(value: boolean): void {
    this.isEnabled = value;
  }

  /**
   * Merge config changes at runtime (recomputes the cached tilt limit when
   * `maxTiltAngle` changes).
   */
  updateConfig(partial: Partial<DroneConfig>): void {
    this.config = { ...this.config, ...partial };
    this.maxTiltTan = Math.tan(this.config.maxTiltAngle);
  }

  /** Clear all propellers and debug assets. The rigid body is untouched. */
  dispose(): void {
    for (const entry of this.propellers.values()) {
      this.disposePropellerDebug(entry);
    }
    this.propellers.clear();
    this.propellerStates.clear();
  }

  // ---- readonly state getters (live internal instances; copy, never mutate) ----

  get body(): RAPIER.RigidBody {
    return this.bodyRef;
  }
  get upAxis(): THREE.Vector3 {
    return this.upAxisVec;
  }
  get gravityDir(): THREE.Vector3 {
    return this.gravityDirVec;
  }
  get gravityMag(): number {
    return this.referenceGravityMag;
  }
  get currPos(): THREE.Vector3 {
    return this.vehiclePos;
  }
  get currQuat(): THREE.Quaternion {
    return this.vehicleQuat;
  }
  get currLinVel(): THREE.Vector3 {
    return this.vehicleLinVel;
  }
  get currAngVel(): THREE.Vector3 {
    return this.vehicleAngVel;
  }
  get bodyXAxis(): THREE.Vector3 {
    return this.vehicleXAxis;
  }
  get bodyYAxis(): THREE.Vector3 {
    return this.vehicleYAxis;
  }
  get bodyZAxis(): THREE.Vector3 {
    return this.vehicleZAxis;
  }
  get targetPos(): THREE.Vector3 {
    return this.targetPosition;
  }
  get targetFwd(): THREE.Vector3 {
    return this.targetHeading;
  }
  get input(): Readonly<DroneInput> {
    return this.movementState;
  }
  get propellersInfo(): ReadonlyMap<string, PropellerState> {
    return this.propellerStates;
  }
  get controlMode(): DroneControlMode {
    return this.config.controlMode;
  }
  /** Last computed hover throttle (0..1-ish; > 1 means underpowered). */
  get hoverThrottle(): number {
    return this.hoverThrottleValue;
  }
  get enabled(): boolean {
    return this.isEnabled;
  }

  // ---- internals ----

  /** Update vehicle collider pos/vel/quat/axis from the rigid body. */
  private updateVehicleInfo(): void {
    const translation = this.bodyRef.translation();
    const rotation = this.bodyRef.rotation();
    const linvel = this.bodyRef.linvel();
    const angvel = this.bodyRef.angvel();
    this.vehiclePos.set(translation.x, translation.y, translation.z);
    this.vehicleQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.vehicleInvertQuat.copy(this.vehicleQuat).invert();
    this.vehicleLinVel.set(linvel.x, linvel.y, linvel.z);
    this.vehicleAngVel.set(angvel.x, angvel.y, angvel.z);
    this.vehicleYAxis.set(0, 1, 0).applyQuaternion(this.vehicleQuat);
    this.vehicleXAxis.set(1, 0, 0).applyQuaternion(this.vehicleQuat);
    this.vehicleZAxis.set(0, 0, 1).applyQuaternion(this.vehicleQuat);
  }

  /** Update gravity/upAxis direction and value (world gravity only). */
  private updateGravityInfo(): void {
    const gravity = this.worldRef.gravity;
    this.referenceGravity.set(gravity.x, gravity.y, gravity.z);
    this.referenceGravityMag = this.referenceGravity.length();
    this.referenceGravityDir.copy(this.referenceGravity).normalize();
    if (this.referenceGravityDir.lengthSq() === 0) {
      this.referenceGravityDir.copy(this.vehicleYAxis).negate();
    }
    // slerpVec3 returns a shared scratch vector — copy immediately.
    this.gravityDirVec.copy(
      this.slerpVec3(
        this.gravityDirVec,
        this.referenceGravityDir,
        1 - Math.exp(-this.gravityDirLerpSpeed * this.worldRef.timestep),
        this.vehicleZAxis
      )
    );
    this.upAxisVec.copy(this.gravityDirVec).negate();
  }

  /**
   * Recompute one propeller's thrust/torque potentials in vehicle space.
   * Runs every step even for static mounts — supports animated mounts
   * (tilt-rotors), matching upstream.
   */
  private updatePropellerInfo(entry: PropellerEntry): void {
    const state = entry.state;
    // Note: upstream also copied body.angvel() here but never used it — skipped.
    entry.mount.getWorldPosition(this.propWorldPos);
    entry.mount.getWorldQuaternion(this.propWorldQuat);

    this.propLocalPos
      .subVectors(this.propWorldPos, this.vehiclePos)
      .applyQuaternion(this.vehicleInvertQuat);
    this.propLocalQuat.multiplyQuaternions(this.vehicleInvertQuat, this.propWorldQuat);

    this.propThrustDir
      .set(0, state.invertThrust ? -1 : 1, 0)
      .applyQuaternion(this.propLocalQuat);
    this.propThrustForce.copy(this.propThrustDir).multiplyScalar(state.maxThrust);

    this.propLeverageTorque.crossVectors(this.propLocalPos, this.propThrustForce);
    this.propReactionTorqueDir
      .set(0, state.invertTorque ? -1 : 1, 0)
      .applyQuaternion(this.propLocalQuat);
    this.propReactionTorque
      .copy(this.propReactionTorqueDir)
      .multiplyScalar(state.maxThrust * state.torqueRatio);
    this.propTorqueInfluence.copy(this.propLeverageTorque).add(this.propReactionTorque);

    state.lx = this.propThrustForce.x;
    state.ly = this.propThrustForce.y;
    state.lz = this.propThrustForce.z;
    state.ax = this.propTorqueInfluence.x;
    state.ay = this.propTorqueInfluence.y;
    state.az = this.propTorqueInfluence.z;

    state.thrustPos.copy(this.propLocalPos);
    state.thrustDir.copy(this.propThrustDir);
    state.thrustPot.copy(this.propThrustForce);
    state.torqueDir.copy(this.propReactionTorqueDir);
    state.torquePot.copy(this.propTorqueInfluence);
    state.throttle = entry.throttle;
  }

  /** Spin the visual propeller model by the smoothed throttle. */
  private updatePropellerModel(entry: PropellerEntry, frameRateCorrection: number): void {
    if (!entry.spinModel) return;
    const targetVel =
      entry.throttle * entry.propellerModelMaxSpin * (entry.state.invertTorque ? -1 : 1);
    entry.spinVel = lerp(
      entry.spinVel,
      targetVel,
      1 - Math.exp(-entry.propellerModelLerpSpinRate * this.worldRef.timestep)
    );
    entry.spinModel.rotateY(entry.spinVel * frameRateCorrection);
  }

  /** Update debug arrow lengths from the current throttle. */
  private updateDebugger(entry: PropellerEntry): void {
    if (entry.thrustArrow) {
      entry.thrustArrow.setLength(entry.throttle * entry.debuggerArrowScale);
    }
    if (entry.torqueArrow) {
      entry.torqueArrow.setLength(
        entry.throttle * entry.debuggerArrowScale * entry.state.torqueRatio
      );
    }
  }

  /** Sum all propellers' potentials (linear: signed; angular: absolute). */
  private computePropellerPotential(): void {
    let sumLX = 0,
      sumLY = 0,
      sumLZ = 0;
    let sumAX = 0,
      sumAY = 0,
      sumAZ = 0;
    // Upstream iterates the whole map, including disabled propellers — keep.
    for (const entry of this.propellers.values()) {
      sumLX += entry.state.lx;
      sumLY += entry.state.ly;
      sumLZ += entry.state.lz;
      sumAX += Math.abs(entry.state.ax);
      sumAY += Math.abs(entry.state.ay);
      sumAZ += Math.abs(entry.state.az);
    }
    this.propellerPotential.sumLX = sumLX;
    this.propellerPotential.sumLY = sumLY;
    this.propellerPotential.sumLZ = sumLZ;
    this.propellerPotential.sumAX = sumAX;
    this.propellerPotential.sumAY = sumAY;
    this.propellerPotential.sumAZ = sumAZ;
  }

  /** POSITION mode: PD-hold targetPos/targetFwd. */
  private positionBasedDroneControl(weight: number, sumWorldLY: number): void {
    const config = this.config;
    // Compute the vertical and horizontal position difference
    this.posError.subVectors(this.targetPosition, this.vehiclePos);
    const vertPosErrorMag = this.posError.dot(this.upAxisVec);
    this.horizPosError.copy(this.posError).projectOnPlane(this.upAxisVec);

    // Compute the current vertical and horizontal linear velocity
    const vertLinVelMag = this.vehicleLinVel.dot(this.upAxisVec);
    this.horizLinVel.copy(this.vehicleLinVel).projectOnPlane(this.upAxisVec);

    // Compute the necessary vertical hovering throttle, also clamp speed at maxVertSpeed
    const vertControl = clamp(
      vertPosErrorMag * config.VERT_POS_P,
      -config.VERT_POS_D * config.maxVertSpeed,
      config.VERT_POS_D * config.maxVertSpeed
    );
    const vertForceMag = weight + vertControl - vertLinVelMag * config.VERT_POS_D;
    this.hoverThrottleValue = Math.max(0, vertForceMag / (sumWorldLY || 1));

    // Compute the tilted target up to move horizontally, also clamp speed at
    // maxHorizSpeed. NOTE: horizForce gets TWO sequential in-place clampLength
    // calls (upstream behavior — keep both, in this order).
    this.horizForce
      .set(0, 0, 0)
      .addScaledVector(this.horizPosError, config.HORIZ_POS_P)
      .addScaledVector(this.horizLinVel, -config.HORIZ_POS_D)
      .clampLength(0, config.HORIZ_POS_D * config.maxHorizSpeed);
    this.targetUp
      .copy(this.upAxisVec)
      .multiplyScalar(weight)
      .add(this.horizForce.clampLength(0, weight * this.maxTiltTan))
      .normalize();
    this.tiltError.crossVectors(this.vehicleYAxis, this.targetUp);
    this.tiltAngVel.copy(this.vehicleAngVel).projectOnPlane(this.upAxisVec);

    // Find yaw direction difference: yawError.
    // Evaluation order matters: angleTo BEFORE cross mutates currentFwd.
    this.targetFwdVec.copy(this.targetHeading).projectOnPlane(this.upAxisVec).normalize();
    this.currentFwd.copy(this.vehicleZAxis).projectOnPlane(this.upAxisVec).normalize();
    const yawError =
      this.targetFwdVec.angleTo(this.currentFwd) *
      Math.sign(this.currentFwd.cross(this.targetFwdVec).dot(this.upAxisVec));
    // Find yaw speed difference: yawRateError, also clamp speed at maxYawRate
    const currentYawRate = this.vehicleAngVel.dot(this.upAxisVec);
    const targetYawRate = clamp(
      yawError * config.YAW_POS_P,
      -config.maxYawRate,
      config.maxYawRate
    );
    const yawRateError = targetYawRate - currentYawRate;

    // Combine tilt and yaw to form the torque needed to control the drone
    this.torqueWorld
      .set(0, 0, 0)
      .addScaledVector(this.tiltError, config.TILT_P)
      .addScaledVector(this.tiltAngVel, -config.TILT_D)
      .addScaledVector(this.upAxisVec, yawRateError * config.YAW_VEL_P);
    // Convert required torque to drone local frame
    this.torqueBody.copy(this.torqueWorld).applyQuaternion(this.vehicleInvertQuat);
  }

  /** VELOCITY mode: sticks command velocities, PD converts to tilt/throttle. */
  private velocityBasedDroneControl(weight: number, sumWorldLY: number): void {
    const config = this.config;
    const input = this.movementState;
    // Convert user input (-1 to 1)
    const throttleIn = clamp(
      (input.throttleUp ? 1 : 0) - (input.throttleDown ? 1 : 0) + input.joystickL.y,
      -1,
      1
    );
    const yawIn = clamp(
      (input.yawLeft ? 1 : 0) - (input.yawRight ? 1 : 0) - input.joystickL.x,
      -1,
      1
    );
    const pitchIn = clamp(
      (input.pitchForward ? 1 : 0) - (input.pitchBackward ? 1 : 0) + input.joystickR.y,
      -1,
      1
    );
    const rollIn = clamp(
      (input.rollRight ? 1 : 0) - (input.rollLeft ? 1 : 0) + input.joystickR.x,
      -1,
      1
    );

    // Find drone roll and pitch axis
    this.worldXAxis.copy(this.vehicleXAxis).projectOnPlane(this.upAxisVec).normalize();
    this.worldZAxis.copy(this.vehicleZAxis).projectOnPlane(this.upAxisVec).normalize();

    // Compute the target linear velocity and delta-v based on user input
    this.targetLinVel
      .set(0, 0, 0)
      .addScaledVector(this.worldXAxis, -rollIn * config.maxHorizSpeed)
      .addScaledVector(this.worldZAxis, pitchIn * config.maxHorizSpeed)
      .addScaledVector(this.upAxisVec, throttleIn * config.maxVertSpeed);
    this.linVelError.subVectors(this.targetLinVel, this.vehicleLinVel);

    // Use PD controls to find the needed acceleration direction
    const vertAccCmd = clamp(
      this.linVelError.dot(this.upAxisVec) * config.VERT_VEL_P,
      -this.referenceGravityMag,
      this.referenceGravityMag
    );
    this.horizAccCmd
      .copy(this.linVelError)
      .projectOnPlane(this.upAxisVec)
      .multiplyScalar(config.HORIZ_VEL_P)
      .clampLength(0, this.referenceGravityMag * this.maxTiltTan);

    // Compute the necessary vertical hovering throttle
    const verticalForceMag = weight + vertAccCmd * this.bodyRef.mass();
    this.hoverThrottleValue = Math.max(0, verticalForceMag / (sumWorldLY || 1));

    // Tilt the drone up axis towards the acceleration direction
    this.targetUp
      .copy(this.upAxisVec)
      .multiplyScalar(this.referenceGravityMag)
      .add(this.horizAccCmd)
      .normalize();
    this.tiltError.crossVectors(this.vehicleYAxis, this.targetUp);
    this.tiltAngVel.copy(this.vehicleAngVel).projectOnPlane(this.upAxisVec);

    // Find yaw speed difference: yawRateError
    const currentYawRate = this.vehicleAngVel.dot(this.upAxisVec);
    const targetYawRate = yawIn * config.maxYawRate;
    const yawRateError = targetYawRate - currentYawRate;

    // Combine tilt and yaw to form the torque needed to control the drone
    this.torqueWorld
      .set(0, 0, 0)
      .addScaledVector(this.tiltError, config.TILT_P)
      .addScaledVector(this.tiltAngVel, -config.TILT_D)
      .addScaledVector(this.upAxisVec, yawRateError * config.YAW_VEL_P);
    // Convert required torque to drone local frame
    this.torqueBody.copy(this.torqueWorld).applyQuaternion(this.vehicleInvertQuat);
  }

  /** Mixer: hover throttle + clamped per-axis attitude mix, clamped to 0..1. */
  private computePropellerFinalThrottle(state: PropellerState, maxSafeMix: number): number {
    const potential = this.propellerPotential;
    const mix =
      (this.torqueBody.x * state.ax) / (potential.sumAX || 1) + // Pitch
      (this.torqueBody.z * state.az) / (potential.sumAZ || 1) + // Roll
      (this.torqueBody.y * state.ay) / (potential.sumAY || 1); // Yaw

    return clamp(this.hoverThrottleValue + clamp(mix, -maxSafeMix, maxSafeMix), 0, 1);
  }

  /** Apply the per-propeller thrust and torque impulses. */
  private applyMixerImpulse(): void {
    const body = this.bodyRef;
    // Compute the max mix, so the drone won't lift/lower while yaw/roll/pitch.
    // Deliberately NOT floored at 0 — a negative maxSafeMix (hover > 1) pins
    // the mix via clamp(mix, -m, m) exactly like upstream.
    const maxSafeMix = Math.min(1.0 - this.hoverThrottleValue, this.hoverThrottleValue);

    // Wake up check: only wake up when the finalThrottle has changed
    if (body.isSleeping()) {
      let shouldWake = false;
      for (const entry of this.propellers.values()) {
        const finalThrottle = this.computePropellerFinalThrottle(entry.state, maxSafeMix);
        if (Math.abs(finalThrottle - entry.state.throttle) > 1e-4) {
          shouldWake = true;
          break;
        }
      }

      if (!shouldWake) return;
      body.wakeUp();
    }

    for (const entry of this.propellers.values()) {
      const state = entry.state;
      const finalThrottle = this.computePropellerFinalThrottle(state, maxSafeMix);

      // Pass the finalThrottle back for visualization + next sleep check
      state.finalThrottle = finalThrottle;
      state.setThrottle(finalThrottle);

      // Store the actual world-space output so users can drive effects
      // without recomputing the mixer.
      this.worldThrustDir.copy(state.thrustDir).applyQuaternion(this.vehicleQuat).normalize();
      this.worldThrustPos
        .copy(state.thrustPos)
        .applyQuaternion(this.vehicleQuat)
        .add(this.vehiclePos);
      this.worldTorqueDir.copy(state.torqueDir).applyQuaternion(this.vehicleQuat).normalize();
      state.worldThrustDir.copy(this.worldThrustDir);
      state.worldThrustPos.copy(this.worldThrustPos);
      state.worldTorqueDir.copy(this.worldTorqueDir);
      state.thrustImpulse
        .copy(this.worldThrustDir)
        .multiplyScalar(state.maxThrust * finalThrottle * this.worldRef.timestep);
      state.torqueImpulse
        .copy(this.worldTorqueDir)
        .multiplyScalar(
          state.maxThrust * finalThrottle * this.worldRef.timestep * state.torqueRatio
        );

      // Apply physics
      body.applyImpulseAtPoint(state.thrustImpulse, state.worldThrustPos, false);
      body.applyTorqueImpulse(state.torqueImpulse, false);
    }
  }

  /** Apply air drag impulse (unconditionally, even after a sleeping mixer). */
  private applyAirDrag(): void {
    this.airDragImpulse
      .copy(this.vehicleLinVel)
      .multiplyScalar(-this.config.airDragFactor * this.worldRef.timestep);
    this.bodyRef.applyImpulse(this.airDragImpulse, false);
  }

  /** Main drone control application function (upstream sub-order, fixed). */
  private applyDroneControl(): void {
    // Compute propellers overall potential
    this.computePropellerPotential();

    // Overall potential for hovering the drone vertically:
    // hover throttle = weight / sum(world-Y thrust potential)
    const potential = this.propellerPotential;
    const sumWorldLY =
      potential.sumLX * this.vehicleXAxis.dot(this.upAxisVec) +
      potential.sumLY * this.vehicleYAxis.dot(this.upAxisVec) +
      potential.sumLZ * this.vehicleZAxis.dot(this.upAxisVec);
    const weight = this.bodyRef.mass() * this.referenceGravityMag;

    // Apply control logics based on selected control mode
    switch (this.config.controlMode) {
      case "POSITION":
        this.positionBasedDroneControl(weight, sumWorldLY);
        break;
      case "VELOCITY":
        this.velocityBasedDroneControl(weight, sumWorldLY);
        break;
    }

    // Apply propellers final mixer and impulse
    this.applyMixerImpulse();

    // Apply air drag impulse
    this.applyAirDrag();
  }

  // ---- debug indicators ----

  /** Build the upstream debug indicator set under the propeller mount. */
  private buildDebugIndicators(entry: PropellerEntry, options: PropellerOptions): void {
    const scale = options.debuggerScale ?? 1;
    const state = entry.state;
    const group = new THREE.Group();

    const thrustRingGeo = new THREE.RingGeometry(scale * 0.5, scale * 0.55, 12, 1, 0, -Math.PI);
    const thrustRingMat = new THREE.MeshBasicMaterial({
      color: EC_AZURE,
      side: THREE.DoubleSide,
    });
    const thrustPointerGeo = new THREE.ConeGeometry(scale * 0.06, scale * 0.5, 8, 1, true);
    const thrustIndicatorMat = new THREE.MeshBasicMaterial({
      color: EC_MED_PURPLE,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.3,
    });
    const axisPointGeo = new THREE.OctahedronGeometry(scale * 0.05, 3);
    const xAxisPointMat = new THREE.MeshBasicMaterial({ color: EC_GREEN });
    const yAxisPointMat = new THREE.MeshBasicMaterial({ color: EC_BLUE });
    const zAxisPointMat = new THREE.MeshBasicMaterial({ color: EC_RED });
    entry.debugDisposables.push(
      thrustRingGeo,
      thrustRingMat,
      thrustPointerGeo,
      thrustIndicatorMat,
      axisPointGeo,
      xAxisPointMat,
      yAxisPointMat,
      zAxisPointMat
    );

    // Thrust direction indicator
    const thrustPointer = new THREE.Mesh(thrustPointerGeo, thrustIndicatorMat);
    thrustPointer.rotation.x = state.invertThrust ? Math.PI : 0;
    thrustPointer.position.set(0, scale * 0.25 * (state.invertThrust ? -1 : 1), 0);
    group.add(thrustPointer);

    // Torque direction indicator
    const torquePointer = new THREE.Mesh(thrustPointerGeo, thrustRingMat);
    torquePointer.rotation.x = Math.PI / 2;
    torquePointer.position.set(scale * 0.53 * (state.invertTorque ? 1 : -1), 0, scale * 0.25);
    group.add(torquePointer);
    const torqueRing = new THREE.Mesh(thrustRingGeo, thrustRingMat);
    torqueRing.rotation.x = Math.PI / 2;
    group.add(torqueRing);

    // Axis pointers indicator
    const xAxisPoint = new THREE.Mesh(axisPointGeo, xAxisPointMat);
    xAxisPoint.position.set(scale, 0, 0);
    const yAxisPoint = new THREE.Mesh(axisPointGeo, yAxisPointMat);
    yAxisPoint.position.set(0, scale, 0);
    const zAxisPoint = new THREE.Mesh(axisPointGeo, zAxisPointMat);
    zAxisPoint.position.set(0, 0, scale);
    group.add(xAxisPoint, yAxisPoint, zAxisPoint);

    // Current thrust/torque arrow debuggers (lengths updated per step)
    entry.thrustArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, state.invertThrust ? -1 : 1, 0),
      undefined,
      0,
      EC_BLUE
    );
    entry.torqueArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, state.invertTorque ? -1 : 1, 0),
      undefined,
      0,
      EC_RED
    );
    group.add(entry.thrustArrow, entry.torqueArrow);

    entry.mount.add(group);
    entry.debugGroup = group;
  }

  /** Remove and dispose one propeller's debug assets. */
  private disposePropellerDebug(entry: PropellerEntry): void {
    if (entry.debugGroup) {
      entry.debugGroup.removeFromParent();
      entry.debugGroup = null;
    }
    if (entry.thrustArrow) {
      entry.thrustArrow.dispose();
      entry.thrustArrow = null;
    }
    if (entry.torqueArrow) {
      entry.torqueArrow.dispose();
      entry.torqueArrow = null;
    }
    for (const disposable of entry.debugDisposables) disposable.dispose();
    entry.debugDisposables.length = 0;
  }
}
