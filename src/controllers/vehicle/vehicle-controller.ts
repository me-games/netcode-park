// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TypeScript port of the ecctrl vehicle controller (React/R3F removed).
// This file is the car brain: chassis rigid body, drivetrain (engine torque
// curve, gear ratios, RPM-threshold auto shift with cooldown), speed-sensitive
// steering config, per-wheel demand routing, and final suspension/friction
// impulse application. The drone half of the upstream component lives in
// `drone/drone-controller.ts`; the upstream dead `carConfig.controlMode` key
// was removed.

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { World, RigidBody } from "@dimforge/rapier3d-compat";
import {
  bakeCurveLUT,
  createSlerpVec3,
  type CurveData,
  type CurveLUT,
} from "../shared/math.ts";
import { ShapeCastWheel, type DriveWheelConfig, type SteerWheelConfig, type WheelOptions } from "./wheel.ts";

const clamp = THREE.MathUtils.clamp;

/**
 * Car input. Booleans are momentary state (hold to act); `setMovement` merges
 * field-wise, so send only the keys you own. `+steer = LEFT turn` and
 * `joystickL.x` is subtracted (push right = turn right).
 */
export type VehicleInput = {
  forward?: boolean;
  backward?: boolean;
  steerLeft?: boolean;
  steerRight?: boolean;
  brake?: boolean;
  joystickL?: { x: number; y: number };
};
export type ReadonlyVehicleInput = Readonly<Omit<VehicleInput, "joystickL">> & {
  readonly joystickL?: Readonly<{ x: number; y: number }>;
};

export type TransmissionMode = "auto" | "manual";

/**
 * Drivetrain + steering config.
 *
 * Tuning hints:
 * - "car feels slow" -> raise `engineHorsepower` (peak torque = HP*7022/maxRPM).
 * - "reverse too fast" -> lower `reverseRPMScale` (0.3 = reverse tops out at 30%).
 * - "twitchy at speed" -> steeper falloff in `steerAngleCurveData` (default
 *   already gives full angle below 20% of top speed, 0.4x at top).
 * - single-entry `gearRatios` disables shifting; multiple entries enable the
 *   RPM-threshold auto shift (`shiftUpRPM`/`shiftDownRPM` with `shiftCooldown`).
 */
export type CarConfig = {
  /** Engine power (HP). Peak torque derives as HP * 7022 / engineMaxRPM. */
  engineHorsepower: number;
  /** Engine redline (RPM). */
  engineMaxRPM: number;
  /** Gear ratios, low to high gear. Empty array falls back to [10]. */
  gearRatios: number[];
  /** Multiplied into every gear ratio. */
  finalDriveRatio: number;
  /** "auto" shifts by RPM thresholds; "manual" only via setGear(). */
  transmissionMode: TransmissionMode;
  /** Auto-upshift above this engine RPM. */
  shiftUpRPM: number;
  /** Auto-downshift below this engine RPM. */
  shiftDownRPM: number;
  /** Seconds between automatic shifts. */
  shiftCooldown: number;
  /** Steering slew rate (rad/s). */
  steerRate: number;
  /** Max steer angle at standstill (rad). */
  maxSteerAngle: number;
  /** Torque multiplier while reversing. */
  reverseTorqueScale: number;
  /** Scales the reverse speed cap. */
  reverseRPMScale: number;
  /** Engine torque over normalized wheel speed (1 at idle -> 0 at redline). */
  engineTorqueCurveData: CurveData;
  /** Steer-angle falloff over forward-speed ratio (speed-sensitive steering). */
  steerAngleCurveData: CurveData;
};

/** Library defaults (upstream values; HP 6 is deliberately tiny — presets tune it). */
export const DEFAULT_CAR_CONFIG: CarConfig = {
  // Engine and drive train
  engineHorsepower: 6,
  engineMaxRPM: 6000,
  gearRatios: [10],
  finalDriveRatio: 1,
  transmissionMode: "auto",
  shiftUpRPM: 5200,
  shiftDownRPM: 2200,
  shiftCooldown: 0.35,
  // Steering
  steerRate: Math.PI * 2,
  maxSteerAngle: Math.PI / 6, // 30 degrees in radians
  // Reverse
  reverseTorqueScale: 1,
  reverseRPMScale: 0.3,
  // Curves
  engineTorqueCurveData: {
    points: [
      { x: 0, y: 1, r_out: 0 },
      { x: 1, y: 0, r_in: 0 },
    ],
    samples: 50,
  },
  steerAngleCurveData: {
    points: [
      { x: 0, y: 1, r_out: 0 },
      { x: 0.2, y: 1, r_in: 0, r_out: 0 },
      { x: 1, y: 0.4, r_in: 0 },
    ],
    samples: 50,
  },
};

export type VehicleControllerOptions = {
  /** The Rapier world (from `PhysicsWorld.create()`'s `.world`). */
  world: World;
  /** Initial body translation. */
  position?: THREE.Vector3;
  /** Initial body rotation. */
  rotation?: THREE.Quaternion;
  /** Allow the body to sleep when at rest. Default true. */
  canSleep?: boolean;
  /** Start enabled. Default true. */
  enable?: boolean;
  /** Merged over DEFAULT_CAR_CONFIG. */
  carConfig?: Partial<CarConfig>;
  /** Gravity-direction smoothing (factor 1 - exp(-k*dt)). Default 6. */
  gravityDirLerpSpeed?: number;
};

const getDriveRatio = (
  gearRatios: number[],
  gearIndex: number,
  finalDriveRatio: number
) => (gearRatios[gearIndex] ?? gearRatios[0] ?? 0) * finalDriveRatio;

const getMaxWheelAngVel = (engineMaxRPM: number, driveRatio: number) =>
  driveRatio !== 0 ? (engineMaxRPM / driveRatio) * ((2 * Math.PI) / 60) : 0;

/**
 * Drivable car controller over a dynamic Rapier body plus shapecast wheels.
 *
 * The controller creates the rigid body WITHOUT colliders — attach chassis
 * colliders to `vehicle.body` yourself (see `vehicle/presets.ts` for shapes
 * and densities), then add wheels via `addWheel()`. Parent your chassis mesh
 * under `chassisObject` and add that group to the scene; wheels auto-parent
 * under it (the scene graph is the wheels' pose source).
 *
 * Call `update()` exactly once per fixed physics step, BEFORE `world.step()`.
 * `+Z` is the vehicle's FORWARD axis.
 */
export class VehicleController {
  /** Exposed so wheels (WheelVehicleContext) can query the world. */
  readonly world: World;
  /** Dynamic body, created WITHOUT colliders — the caller attaches them. */
  readonly body: RigidBody;
  /** Scene-graph root: add to scene, parent the chassis mesh under it. */
  readonly chassisObject: THREE.Group;
  /** Master enable; `update()` early-outs when false. */
  enabled: boolean;

  // --- config ---
  private readonly carConfig: CarConfig;
  private readonly gravityDirLerpSpeed: number;
  private readonly gearRatiosList: number[];
  private readonly engineMaxTorque: number;
  private readonly engineTorqueCurve: CurveLUT;
  private readonly steerAngleCurve: CurveLUT;

  // --- drivetrain state ---
  private _gearIndex = 0;
  private _driveRatio: number;
  private _engineRPM = 0;
  private shiftCooldownTimer = 0;
  private maxWheelAngVel: number;
  private readonly driveWheelConfig: DriveWheelConfig;
  private readonly steerWheelConfig: SteerWheelConfig;

  // --- wheels ---
  private readonly wheelsMap = new Map<string, ShapeCastWheel>();

  // --- input state ---
  private readonly movementState = {
    forward: false,
    backward: false,
    steerLeft: false,
    steerRight: false,
    brake: false,
    joystickL: { x: 0, y: 0 },
  };

  // --- vehicle info scratch ---
  private readonly vehiclePos = new THREE.Vector3();
  private readonly vehicleQuat = new THREE.Quaternion();
  private readonly vehicleInvertQuat = new THREE.Quaternion();
  private readonly vehicleLinVel = new THREE.Vector3();
  private readonly vehicleAngVel = new THREE.Vector3();
  private readonly vehicleXAxis = new THREE.Vector3();
  private readonly vehicleYAxis = new THREE.Vector3();
  private readonly vehicleZAxis = new THREE.Vector3();

  // --- gravity state ---
  private readonly _upAxis = new THREE.Vector3();
  private readonly referenceGravity = new THREE.Vector3();
  private referenceGravityMag = 0;
  private readonly referenceGravityDir = new THREE.Vector3();
  private readonly _gravityDir = new THREE.Vector3();
  private readonly slerpVec3 = createSlerpVec3();

  constructor(options: VehicleControllerOptions) {
    this.world = options.world;
    this.enabled = options.enable ?? true;
    this.gravityDirLerpSpeed = options.gravityDirLerpSpeed ?? 6;

    // Merge config; empty gearRatios falls back to the library default [10].
    this.carConfig = { ...DEFAULT_CAR_CONFIG, ...options.carConfig };
    this.gearRatiosList =
      Array.isArray(this.carConfig.gearRatios) && this.carConfig.gearRatios.length > 0
        ? this.carConfig.gearRatios
        : DEFAULT_CAR_CONFIG.gearRatios;

    // Peak engine torque: HP * 7022 / maxRPM (7022 ~= 5252 lb·ft·RPM/HP in N·m).
    this.engineMaxTorque =
      this.carConfig.engineMaxRPM !== 0
        ? (this.carConfig.engineHorsepower * 7022) / this.carConfig.engineMaxRPM
        : 0;
    this._driveRatio = getDriveRatio(
      this.gearRatiosList,
      this._gearIndex,
      this.carConfig.finalDriveRatio
    );

    // Bake curve LUTs.
    this.engineTorqueCurve = bakeCurveLUT(
      this.carConfig.engineTorqueCurveData.points,
      this.carConfig.engineTorqueCurveData.samples ?? 50
    );
    this.steerAngleCurve = bakeCurveLUT(
      this.carConfig.steerAngleCurveData.points,
      this.carConfig.steerAngleCurveData.samples ?? 50
    );

    this.maxWheelAngVel = getMaxWheelAngVel(
      this.carConfig.engineMaxRPM,
      this._driveRatio
    );
    this.driveWheelConfig = {
      maxDriveTorque: 0,
      maxWheelAngVel: this.maxWheelAngVel,
      engineTorqueCurve: this.engineTorqueCurve,
      reverseTorqueScale: this.carConfig.reverseTorqueScale,
      reverseRPMScale: this.carConfig.reverseRPMScale,
      driveRatio: this._driveRatio,
    };
    this.steerWheelConfig = {
      steerAngleCurve: this.steerAngleCurve,
      steerRate: this.carConfig.steerRate,
      maxSteerAngle: this.carConfig.maxSteerAngle,
      maxWheelAngVel: this.maxWheelAngVel,
    };

    // Create the dynamic body (no colliders — caller attaches them).
    const desc = RAPIER.RigidBodyDesc.dynamic();
    if (options.position)
      desc.setTranslation(options.position.x, options.position.y, options.position.z);
    if (options.rotation) desc.setRotation(options.rotation);
    desc.setCanSleep(options.canSleep ?? true);
    this.body = this.world.createRigidBody(desc);

    // Scene-graph root, aligned with the body from the start.
    this.chassisObject = new THREE.Group();
    this.chassisObject.position.copy(this.body.translation());
    this.chassisObject.quaternion.copy(this.body.rotation());

    // Prime vehicle info so getters are sensible before the first update().
    this.vehiclePos.copy(this.body.translation());
    this.vehicleQuat.copy(this.body.rotation());
    this.vehicleXAxis.set(1, 0, 0).applyQuaternion(this.vehicleQuat);
    this.vehicleYAxis.set(0, 1, 0).applyQuaternion(this.vehicleQuat);
    this.vehicleZAxis.set(0, 0, 1).applyQuaternion(this.vehicleQuat);

    // Prime gravity state so the first slerp doesn't swing from a zero
    // vector and wheels never see gravityMag 0 on frame 1.
    const g = this.world.gravity;
    this.referenceGravity.set(g.x, g.y, g.z);
    this.referenceGravityMag = this.referenceGravity.length();
    this.referenceGravityDir.copy(this.referenceGravity).normalize();
    if (this.referenceGravityDir.lengthSq() === 0)
      this.referenceGravityDir.copy(this.vehicleYAxis).negate();
    this._gravityDir.copy(this.referenceGravityDir);
    this._upAxis.copy(this._gravityDir).negate();
  }

  // --- readonly state getters (live internal instances; copy, never mutate) ---
  get upAxis(): THREE.Vector3 {
    return this._upAxis;
  }
  get gravityDir(): THREE.Vector3 {
    return this._gravityDir;
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
  /** +Z is the vehicle's FORWARD axis. */
  get bodyZAxis(): THREE.Vector3 {
    return this.vehicleZAxis;
  }
  get input(): ReadonlyVehicleInput {
    return this.movementState;
  }
  get wheels(): ReadonlyMap<string, ShapeCastWheel> {
    return this.wheelsMap;
  }
  get gearIndex(): number {
    return this._gearIndex;
  }
  /** Current gear ratio x final drive ratio. */
  get driveRatio(): number {
    return this._driveRatio;
  }
  /** Live engine RPM readout (drive-weighted average wheel RPM x |driveRatio|). */
  get engineRPM(): number {
    return this._engineRPM;
  }

  /**
   * Field-wise input merge: only keys present in `input` are written, so
   * multiple sources (keyboard + joystick) can push independently.
   */
  setMovement(input: VehicleInput): void {
    const state = this.movementState;
    if (input.forward !== undefined) state.forward = input.forward;
    if (input.backward !== undefined) state.backward = input.backward;
    if (input.steerLeft !== undefined) state.steerLeft = input.steerLeft;
    if (input.steerRight !== undefined) state.steerRight = input.steerRight;
    if (input.brake !== undefined) state.brake = input.brake;
    if (input.joystickL) {
      state.joystickL.x = input.joystickL.x;
      state.joystickL.y = input.joystickL.y;
    }
  }

  /**
   * Manually select a gear (index into `gearRatios`, clamped). Starts the
   * shift cooldown, so it also pauses auto-shifting for `shiftCooldown` s.
   */
  setGear(index: number): void {
    const nextGearIndex = clamp(Math.floor(index), 0, this.gearRatiosList.length - 1);
    if (this._gearIndex === nextGearIndex) return;
    this._gearIndex = nextGearIndex;
    this.shiftCooldownTimer = this.carConfig.shiftCooldown;
    this.syncTransmissionConfig();
    this.syncWheelConfig();
  }

  /**
   * Create a wheel and parent its group under `chassisObject`. Register all
   * wheels before the first `update()` for a stable torque split (adding
   * later works — the split just re-balances).
   */
  addWheel(options: WheelOptions): ShapeCastWheel {
    const wheel = new ShapeCastWheel(this, options);
    if (!this.wheelsMap.has(wheel.id)) {
      this.chassisObject.add(wheel.wheelGroup);
      this.wheelsMap.set(wheel.id, wheel);
      this.syncWheelConfig();
    }
    return wheel;
  }

  /** Remove a wheel by id (detaches its groups, re-splits drive torque). */
  removeWheel(id: string): void {
    const wheel = this.wheelsMap.get(id);
    if (!wheel) return;
    this.wheelsMap.delete(id);
    wheel.wheelGroup.removeFromParent();
    this.syncWheelConfig();
  }

  /**
   * Per-fixed-step update; call exactly once per physics substep BEFORE
   * `world.step()`. The `dt` parameter is accepted for a uniform controller
   * call shape and IGNORED — all timing uses the fixed `world.timestep`.
   *
   * Order (replicates upstream's children-before-parent frame order):
   * A. sync `chassisObject` from the rigid body (wheels read world poses),
   * B. update every wheel, C. refresh vehicle/gravity info (unless sleeping),
   * D. transmission -> demands -> impulses. Demands written in D are consumed
   * by the wheels NEXT step — an intentional upstream one-frame delay.
   */
  update(_dt?: number): void {
    if (!this.enabled) return;

    // A. Scene graph <- rigid body (must precede any wheel world-pose read).
    this.chassisObject.position.copy(this.body.translation());
    this.chassisObject.quaternion.copy(this.body.rotation());
    this.chassisObject.updateMatrixWorld(true);

    // B. Wheels (children-first useFrame order upstream).
    for (const wheel of this.wheelsMap.values()) wheel.update();

    // C. Vehicle + gravity info while awake.
    if (!this.body.isSleeping()) {
      this.updateVehicleInfo();
      this.updateGravityInfo();
    }

    // D. Car control whenever there is a wheel.
    if (this.wheelsMap.size > 0) this.applyCarControl();
  }

  /** Remove the body from the world and detach the scene-graph objects. */
  dispose(): void {
    for (const wheel of this.wheelsMap.values()) wheel.dispose();
    this.wheelsMap.clear();
    this.world.removeRigidBody(this.body);
    this.chassisObject.removeFromParent();
  }

  // ------------------------------------------------------------------
  // Internals (formulas and ordering mirror upstream exactly)
  // ------------------------------------------------------------------

  private syncTransmissionConfig(): void {
    this._driveRatio = getDriveRatio(
      this.gearRatiosList,
      this._gearIndex,
      this.carConfig.finalDriveRatio
    );
    this.maxWheelAngVel = getMaxWheelAngVel(
      this.carConfig.engineMaxRPM,
      this._driveRatio
    );
    this.driveWheelConfig.driveRatio = this._driveRatio;
    this.driveWheelConfig.maxWheelAngVel = this.maxWheelAngVel;
    this.steerWheelConfig.maxWheelAngVel = this.maxWheelAngVel;
  }

  private syncWheelConfig(): void {
    let totalDriveTorqueWeight = 0;
    for (const wheel of this.wheelsMap.values()) {
      if (!wheel.driveWheel) continue;
      totalDriveTorqueWeight += Math.max(0, wheel.driveTorqueWeight);
    }
    for (const wheel of this.wheelsMap.values()) {
      if (wheel.driveWheel) {
        const driveTorqueWeight = Math.max(0, wheel.driveTorqueWeight);
        // Shallow copy for drive config (upstream spreads)...
        wheel.setDriveWheelConfig({
          ...this.driveWheelConfig,
          maxDriveTorque:
            totalDriveTorqueWeight > 0
              ? (this.engineMaxTorque * driveTorqueWeight) / totalDriveTorqueWeight
              : 0,
        });
      }
      // ...but the SHARED object for steer config (upstream passes the ref),
      // so steer wheels see later maxWheelAngVel updates without a re-push.
      if (wheel.steerWheel) wheel.setSteerWheelConfig(this.steerWheelConfig);
    }
  }

  private updateVehicleInfo(): void {
    this.vehiclePos.copy(this.body.translation());
    this.vehicleQuat.copy(this.body.rotation());
    this.vehicleInvertQuat.copy(this.vehicleQuat).invert();
    this.vehicleLinVel.copy(this.body.linvel());
    this.vehicleAngVel.copy(this.body.angvel());
    this.vehicleYAxis.set(0, 1, 0).applyQuaternion(this.vehicleQuat);
    this.vehicleXAxis.set(1, 0, 0).applyQuaternion(this.vehicleQuat);
    this.vehicleZAxis.set(0, 0, 1).applyQuaternion(this.vehicleQuat);
  }

  private updateGravityInfo(): void {
    // Constant world gravity only (upstream custom-gravity fields are out of
    // scope for v1); the slerp is retained faithfully — it converges
    // instantly under constant gravity and keeps the formula intact.
    const g = this.world.gravity;
    this.referenceGravity.set(g.x, g.y, g.z);
    this.referenceGravityMag = this.referenceGravity.length();
    this.referenceGravityDir.copy(this.referenceGravity).normalize();
    if (this.referenceGravityDir.lengthSq() === 0)
      this.referenceGravityDir.copy(this.vehicleYAxis).negate();
    this._gravityDir.copy(
      this.slerpVec3(
        this._gravityDir,
        this.referenceGravityDir,
        1 - Math.exp(-this.gravityDirLerpSpeed * this.world.timestep),
        this.vehicleZAxis
      )
    );
    this._upAxis.copy(this._gravityDir).negate();
  }

  private updateTransmission(): void {
    // Drive-weighted average wheel RPM -> engine RPM (updated even while the
    // shift cooldown runs; only the shift decision is skipped).
    let totalWheelRPM = 0;
    let totalDriveTorqueWeight = 0;
    for (const wheel of this.wheelsMap.values()) {
      if (!wheel.driveWheel) continue;
      const driveTorqueWeight = Math.max(0, wheel.driveTorqueWeight);
      totalWheelRPM +=
        ((Math.abs(wheel.wheelAngVel) * 60) / (Math.PI * 2)) * driveTorqueWeight;
      totalDriveTorqueWeight += driveTorqueWeight;
    }

    const averageWheelRPM =
      totalDriveTorqueWeight > 0 ? totalWheelRPM / totalDriveTorqueWeight : 0;
    this._engineRPM = averageWheelRPM * Math.abs(this._driveRatio);
    if (this.carConfig.transmissionMode !== "auto" || this.gearRatiosList.length <= 1)
      return;

    if (this.shiftCooldownTimer > 0) {
      this.shiftCooldownTimer = Math.max(
        0,
        this.shiftCooldownTimer - this.world.timestep
      );
      return;
    }

    if (
      this._engineRPM > this.carConfig.shiftUpRPM &&
      this._gearIndex < this.gearRatiosList.length - 1
    ) {
      this.setGear(this._gearIndex + 1);
    } else if (this._engineRPM < this.carConfig.shiftDownRPM && this._gearIndex > 0) {
      this.setGear(this._gearIndex - 1);
    }
  }

  private velocityBasedCarControl(): void {
    const input = this.movementState;
    // Convert user input to drive/brake/steer demand (+steer = LEFT turn).
    const driveIn = clamp((input.forward ? 1 : 0) - (input.backward ? 1 : 0), -1, 1);
    const steerIn = clamp(
      (input.steerLeft ? 1 : 0) - (input.steerRight ? 1 : 0) - input.joystickL.x,
      -1,
      1
    );
    const brakeIn = input.brake ? 1 : 0;

    // Wheels consume these demands NEXT step (intentional one-frame delay).
    for (const wheel of this.wheelsMap.values()) {
      if (wheel.driveWheel) wheel.setDriveDemand(driveIn);
      if (wheel.brakeWheel) wheel.setBrakeDemand(brakeIn);
      if (wheel.steerWheel) wheel.setSteerDemand(steerIn);
    }
  }

  private applyWheelImpulse(): void {
    const body = this.body;

    // Wake-up check: only wake when a wheel has contact and a moving surface
    // or non-zero wheel surface speed.
    if (body.isSleeping()) {
      let shouldWake = false;
      for (const wheel of this.wheelsMap.values()) {
        if (!wheel.rayHit) continue;
        if (wheel.isOnPlatform || Math.abs(wheel.wheelLinVel) > 1e-4) {
          shouldWake = true;
          break;
        }
      }
      if (!shouldWake) return;
      body.wakeUp();
    }

    for (const wheel of this.wheelsMap.values()) {
      // `rayHit` is the wheel's ONE-FRAME-STALE published snapshot (upstream
      // wheelInfo): on contact loss the stale friction impulses fire once
      // more; on contact gain this step's suspension impulse is skipped.
      if (!wheel.rayHit) continue;
      // Suspension at the SUPPORT point (avoids contact-patch jacking while
      // steering); friction impulses at the actual hit point. Wake flag
      // `false` for the vehicle's own impulses.
      body.applyImpulseAtPoint(wheel.floatImp, wheel.supPos, false);
      body.applyImpulseAtPoint(wheel.lngFricImp, wheel.rayHitPos, false);
      body.applyImpulseAtPoint(wheel.latFricImp, wheel.rayHitPos, false);
    }
  }

  private applyCarControl(): void {
    // Engine RPM + automatic gear changes before sending demands to wheels.
    this.updateTransmission();
    // Route drive/brake/steer demands to the wheels.
    this.velocityBasedCarControl();
    // Apply suspension + friction impulses from the shapecast wheels.
    this.applyWheelImpulse();
  }
}
