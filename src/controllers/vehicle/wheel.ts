// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TypeScript port of the ecctrl vehicle controller (React/R3F removed).
// This file is the shapecast wheel: suspension spring/damper, slip-curve tire
// model with friction ellipse and tire relaxation, speed-sensitive steering,
// wheel spin integration, moving-platform following, and the wheel-model
// visual sync. Upstream typo'd names are corrected in our public API:
// `rayHitFriciton` -> `rayHitFriction`, `wheelModelReversRotation` ->
// `wheelModelReverseRotation`, `wheelModelUpdate` -> `updateModel`; the
// rigid-body userData key `ecctrl` is renamed to `controller` (de-branding).

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type {
  World,
  RigidBody,
  Collider,
  ColliderShapeCastHit,
  RayColliderIntersection,
  Ray,
  Cylinder,
} from "@dimforge/rapier3d-compat";
import {
  remap,
  bakeCurveLUT,
  evaluateCurveLUT,
  type CurveData,
  type CurveLUT,
} from "../shared/math.ts";

const clamp = THREE.MathUtils.clamp;

/**
 * Drivetrain config pushed into drive wheels by the vehicle controller.
 * Users normally never build this by hand — `VehicleController` derives it
 * from `CarConfig` and re-pushes it on every gear change.
 */
export type DriveWheelConfig = {
  /** Peak engine torque share for THIS wheel (N·m), split by drive weights. */
  maxDriveTorque: number;
  /** Wheel angular velocity at engine redline in top of current gear (rad/s). */
  maxWheelAngVel: number;
  /** Baked engine torque curve, sampled by |wheelAngVel| / maxWheelAngVel. */
  engineTorqueCurve: CurveLUT;
  /** Torque multiplier while reversing (1 = same punch as forward). */
  reverseTorqueScale: number;
  /** Scales the reverse speed cap (0.3 = reverse tops out at 30%). */
  reverseRPMScale: number;
  /** Current gear ratio x final drive ratio. */
  driveRatio: number;
};

/**
 * Steering config shared (by reference) across all steer wheels — the vehicle
 * controller updates `maxWheelAngVel` in place on gear changes.
 */
export type SteerWheelConfig = {
  /** Baked steer-angle falloff curve over forward-speed ratio (speed-sensitive steering). */
  steerAngleCurve: CurveLUT;
  /** How fast the wheel slews toward its target angle (rad/s). */
  steerRate: number;
  /** Max steer angle at standstill (rad). */
  maxSteerAngle: number;
  /** Theoretical top wheel spin (rad/s); normalizes the speed ratio. */
  maxWheelAngVel: number;
};

/**
 * Per-wheel options. Everything except `position` has an upstream default.
 *
 * Tuning hints:
 * - "car bottoms out / sits too low" -> raise `springK` (scale with chassis mass!).
 * - "car pogo-bounces" -> raise `dampingC` (keep it below `2*sqrt(springK * massPerWheel)`).
 * - "too slidey / too grippy" -> `tireGripFactor` (averaged with ground friction).
 * - "drifts too easily sideways" -> raise `latFrictionEllipseScale`.
 * - "wheels dig into curbs" -> longer `rayLength` (more suspension travel).
 */
export type WheelOptions = {
  /** Stable id used as the key in the vehicle's wheel map. Default: random UUID. */
  id?: string;
  /** Optional display name (not used by physics). */
  name?: string;
  /** Master enable; a disabled wheel skips its whole update. Default true. */
  enable?: boolean;
  /** REQUIRED. Wheel mount point in chassis-local space (axle position, +Z forward). */
  position: THREE.Vector3;

  /** "shapeCast" (cylinder sweep, default; handles curbs/side contact) or "rayCast" (cheaper). */
  groundDetection?: "shapeCast" | "rayCast";
  /** Wheel radius (m). Default 0.5. */
  rayShapeR?: number;
  /** Cylinder HALF-height = half the tire width (m). Default 0.15. */
  rayShapeH?: number;
  /** Suspension travel below the axle (m). Default 0.5. */
  rayLength?: number;
  /** Suspension spring constant. Default 180 (assumes a very light chassis — presets scale it). */
  springK?: number;
  /** Suspension damping. Default 16. Upstream note: max at 2*sqrt(K*mass). */
  dampingC?: number;

  /** Flip drive torque sign (for mirrored wheel setups). Default false. */
  driveInvert?: boolean;
  /** Does the engine power this wheel? Default false. */
  driveWheel?: boolean;
  /** Torque split weight among drive wheels. Default 1. Bigger = more of the engine. */
  driveTorqueWeight?: number;
  /** Flip steer direction. Default false. */
  steerInvert?: boolean;
  /** Does this wheel steer? Default false. */
  steerWheel?: boolean;
  /** Does this wheel brake? Default false. */
  brakeWheel?: boolean;
  /** Max brake torque (N·m). Default 40. */
  maxBrakeTorque?: number;

  /** Rolling drag while free-rolling. Default 0.007. */
  rollingResistanceCoef?: number;

  /** Below this contact speed (m/s) the tire blends toward full static grip. Default 0.4. */
  lowVelThreshold?: number;
  /** Tire grip, averaged with ground friction: (surface + grip) * 0.5. Default 1.5. */
  tireGripFactor?: number;
  /** Scales the longitudinal (accel/brake) half of the friction ellipse. Default 1. */
  lngFrictionEllipseScale?: number;
  /** Scales the lateral (cornering) half of the friction ellipse. Default 1. */
  latFrictionEllipseScale?: number;
  /** Longitudinal tire relaxation rate (smaller = snappier response). Default 0.05. */
  relaxLngRate?: number;
  /** Lateral tire relaxation rate. Default 0.1. */
  relaxLatRate?: number;
  /** Relaxation floor so low-speed tires stay responsive. Default 0.3. */
  minLngRelaxCoeff?: number;
  /** Relaxation floor, lateral. Default 0.3. */
  minLatRelaxCoeff?: number;
  /** Longitudinal slip curve. Default (0,0)->(0.25,1)->(1,0.7). */
  lngSlipRatioCurveData?: CurveData;
  /** Lateral slip curve. Default (0,0)->(0.15,1)->(1,0.9). */
  latSlipRatioCurveData?: CurveData;

  /** Inherit velocity from dynamic/kinematic bodies stood on. Default true. */
  followPlatform?: boolean;
  /** Platform-influence falloff over (platform mass / vehicle mass). */
  massRatioFallOffCurveData?: CurveData;
  /** Push wheel load back onto dynamic bodies stood on. Default true. */
  applyCounterMass?: boolean;
  /** Push tire friction back onto dynamic bodies stood on. Default true. */
  applyCounterFriction?: boolean;

  /** Drive the visual groups (suspension bounce + wheel spin). Default true. (upstream `wheelModelUpdate`) */
  updateModel?: boolean;
  /** VISUAL mass proxy density — fattens effective inertia; creates no collider. Default 1.5. */
  wheelModelDensity?: number;
  /** Visual wheel radius for the model rest offset. Default 0.5. */
  wheelModelRadius?: number;
  /** Suspension visual smoothing rate (1 - exp(-rate*dt)). Default 10. */
  wheelModelLerpPosRate?: number;
  /** Spin the wheel mesh the other way. Default false. (upstream `wheelModelReversRotation`) */
  wheelModelReverseRotation?: boolean;
};

/**
 * What the wheel needs from its vehicle. `VehicleController` satisfies this
 * structurally (it exposes `world`, `body`, `chassisObject`, `gravityMag`).
 */
export type WheelVehicleContext = {
  readonly world: World;
  readonly body: RigidBody;
  readonly chassisObject: THREE.Object3D;
  readonly gravityMag: number;
};

/**
 * Local (type-only) view of the shared rigid-body userData contract owned by
 * `shared/physics-world.ts` (`ControllerUserData`). Runtime key is
 * `controller` (upstream used `ecctrl`). Wheel shapecasts skip bodies with
 * `excludeRay` or `excludeVehicleRay` — the on-foot character body should set
 * `{ controller: { excludeVehicleRay: true } }`.
 */
type WheelUserData = {
  controller?: {
    excludeRay?: boolean;
    excludeCharacterRay?: boolean;
    excludeVehicleRay?: boolean;
  };
};

const DEFAULT_LNG_SLIP_CURVE: CurveData = {
  points: [
    { x: 0, y: 0, r_out: 1.45 },
    { x: 0.25, y: 1, r_in: 0, r_out: 0 },
    { x: 1, y: 0.7, r_in: 0 },
  ],
};
const DEFAULT_LAT_SLIP_CURVE: CurveData = {
  points: [
    { x: 0, y: 0, r_out: 1.45 },
    { x: 0.15, y: 1, r_in: 0, r_out: 0 },
    { x: 1, y: 0.9, r_in: 0 },
  ],
};
const DEFAULT_MASS_RATIO_FALL_OFF_CURVE: CurveData = {
  points: [
    { x: 0, y: 0.5, r_out: 0 },
    { x: 0.5, y: 1, r_out: 0 },
    { x: 1, y: 1, r_in: 0 },
  ],
};

/**
 * One shapecast wheel. Constructed via `VehicleController.addWheel()`.
 *
 * Scene-graph pose derivation (the load-bearing design): the wheel's world
 * pose comes from `wheelGroup.getWorldPosition/getWorldQuaternion`, whose
 * parent chain is the vehicle's `chassisObject` — which the controller syncs
 * from the rigid body at the top of ITS `update()`, BEFORE any wheel updates.
 * Steering mutates `wheelGroup`'s local rotation via `rotateY`; the
 * accumulated group rotation is the authoritative steer pose (the
 * `steerAngle` number is bookkeeping for increments and reporting).
 *
 * Add your wheel mesh as a child of `modelObject` (it spins around local X;
 * `suspensionGroup` above it bounces on local Y with the suspension).
 */
export class ShapeCastWheel {
  readonly id: string;
  readonly name: string;
  /** Master enable; `update()` early-outs when false. */
  enabled: boolean;

  /** Steering parent, child of the chassis at the wheel mount point. */
  readonly wheelGroup = new THREE.Group();
  /** Suspension bounce group (local Y), child of `wheelGroup`. */
  readonly suspensionGroup = new THREE.Group();
  /** Add your wheel mesh here; spins around local X. Child of `suspensionGroup`. */
  readonly modelObject = new THREE.Group();

  /** Flags the vehicle brain reads for demand routing / torque split. */
  readonly driveWheel: boolean;
  readonly steerWheel: boolean;
  readonly brakeWheel: boolean;
  readonly driveTorqueWeight: number;

  // --- vehicle context ---
  private readonly vehicle: WheelVehicleContext;

  // --- options ---
  private readonly groundDetection: "shapeCast" | "rayCast";
  private readonly rayShapeR: number;
  private readonly rayShapeH: number;
  private readonly rayLength: number;
  private readonly springK: number;
  private readonly dampingC: number;
  private readonly driveInvert: boolean;
  private readonly steerInvert: boolean;
  private readonly maxBrakeTorque: number;
  private readonly rollingResistanceCoef: number;
  private readonly lowVelThreshold: number;
  private readonly tireGripFactor: number;
  private readonly lngFrictionEllipseScale: number;
  private readonly latFrictionEllipseScale: number;
  private readonly relaxLngRate: number;
  private readonly relaxLatRate: number;
  private readonly minLngRelaxCoeff: number;
  private readonly minLatRelaxCoeff: number;
  private readonly followPlatform: boolean;
  private readonly applyCounterMass: boolean;
  private readonly applyCounterFriction: boolean;
  private readonly updateModel: boolean;
  private readonly wheelModelRadius: number;
  private readonly wheelModelLerpPosRate: number;
  private readonly wheelModelReverseRotation: boolean;

  // --- derived wheel constants (wheelInertia = 0.5 * m * r^2) ---
  private readonly wheelMass: number;
  private readonly wheelInertia: number;

  // --- baked curves ---
  private readonly lngSlipRatioCurve: CurveLUT;
  private readonly latSlipRatioCurve: CurveLUT;
  private readonly massRatioFallOffCurve: CurveLUT;

  // --- shapecast primitives (constructed once; Ray wraps LIVE refs to
  //     rayOrigin/rayDirection — mutate the vectors, never re-create the Ray) ---
  private readonly rayShape: Cylinder;
  private readonly rayCastRay: Ray;
  private readonly rotZ90 = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    Math.PI / 2
  );

  // --- vehicle info scratch (refreshed every update for the freshest pose) ---
  private readonly vehiclePos = new THREE.Vector3();
  private readonly vehicleQuat = new THREE.Quaternion();
  private readonly vehicleLinVel = new THREE.Vector3();
  private readonly vehicleAngVel = new THREE.Vector3();
  private readonly vehicleXAxis = new THREE.Vector3();
  private readonly vehicleYAxis = new THREE.Vector3();
  private readonly vehicleZAxis = new THREE.Vector3();

  // --- wheel physical state ---
  private effectiveInertia = 0;
  private _wheelAngVel = 0;
  private readonly supportPoint = new THREE.Vector3();

  // --- friction state ---
  private frictionCoef = 0;
  private readonly _lngAxis = new THREE.Vector3();
  private readonly _latAxis = new THREE.Vector3();
  private readonly lngFrictionImp = new THREE.Vector3();
  private readonly latFrictionImp = new THREE.Vector3();
  private _lngSlipRatio = 0;
  private _latSlipRatio = 0;
  private _slipStrength = 0;
  private smoothedLngImpulse = 0;
  private smoothedLatImpulse = 0;
  private desiredLngImpulse = 0;
  private desiredLatImpulse = 0;

  // --- steering state ---
  private _steerAngle = 0;
  private steerTarget = 0;
  private steerIncrement = 0;
  private steerDemand = 0;
  private steerWheelConfig: SteerWheelConfig | null = null;

  // --- drive state ---
  private _driveTorque = 0;
  private driveDemand = 0;
  private driveWheelConfig: DriveWheelConfig | null = null;

  // --- brake state ---
  private _brakeTorque = 0;
  private brakeDemand = 0;

  // --- shapecast scratch/state ---
  private readonly distFromRayOriginToVehicle = new THREE.Vector3();
  private readonly angvelToLinvel = new THREE.Vector3();
  private readonly floatingImpulse = new THREE.Vector3();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayRotation = new THREE.Quaternion();
  private readonly rayDirection = new THREE.Vector3();
  private readonly rayOriginVelocity = new THREE.Vector3();
  private readonly rayUpAxis = new THREE.Vector3();
  private readonly rayFWDAxis = new THREE.Vector3();
  private readonly rayLeftAxis = new THREE.Vector3();
  private _shapeRayHit: ColliderShapeCastHit | null = null;
  private _rayHit: RayColliderIntersection | null = null;
  private _suspensionToi = 0;
  private _rayHitBody: RigidBody | null = null;
  private readonly rayShapeCenter = new THREE.Vector3();
  private readonly stableRayHitPoint = new THREE.Vector3();
  private readonly targetRayHitPoint = new THREE.Vector3();
  private readonly rayHitPointOffset = new THREE.Vector3();
  private readonly rayHitPointPosition = new THREE.Vector3();
  private readonly rayHitPointVelocity = new THREE.Vector3();
  private readonly rayHitPointVelOnPlane = new THREE.Vector3();
  private readonly rayHitPointNormal = new THREE.Vector3();
  private _rayHitFriction = 0;

  // --- moving platform state ---
  private massRatio = 1;
  private _isOnMovingObject = false;
  private wheelSupportForceMag = 0;
  private readonly wheelSupportImpulse = new THREE.Vector3();
  private readonly wheelFrictionImpulse = new THREE.Vector3();
  private readonly movingObjectPosition = new THREE.Vector3();
  private readonly movingObjectVelocity = new THREE.Vector3();
  private readonly movingObjectVelocityOnPlane = new THREE.Vector3();
  private readonly movingObjectLinearVelocity = new THREE.Vector3();
  private readonly movingObjectAngularVelocity = new THREE.Vector3();
  private readonly distanceFromOriginToObjectPoint = new THREE.Vector3();
  private readonly movingObjectAngvelToLinvel = new THREE.Vector3();

  // --- world pose scratch ---
  private readonly worldPos = new THREE.Vector3();
  private readonly worldQuat = new THREE.Quaternion();

  // --- published state (one-frame-stale, mirrors upstream wheelInfo) ---
  // Upstream copies every VALUE-typed field into `wheelInfo` at the TOP of the
  // wheel's frame (updateVehicleInfo), BEFORE floatVehicle/solveWheelRotation
  // overwrite the live fields — so the vehicle brain (and user code) always
  // reads LAST step's values. Vector fields are shared by reference upstream
  // (mutated in place), so their getters stay live. Do NOT "fix" this by
  // reading the live fields: impulse gating on contact transitions and
  // RPM-threshold shift timing depend on the stale snapshot.
  private publishedRayHit: ColliderShapeCastHit | RayColliderIntersection | null =
    null;
  private publishedRayHitBody: RigidBody | null = null;
  private publishedRayHitFriction = 0;
  private publishedIsOnPlatform = false;
  private publishedLngSlipRatio = 0;
  private publishedLatSlipRatio = 0;
  private publishedSlipStrength = 0;
  private publishedEffInertia = 0;
  private publishedSteerAngle = 0;
  private publishedDriveTorque = 0;
  private publishedBrakeTorque = 0;
  private publishedWheelAngVel = 0;
  private publishedWheelLinVel = 0;

  /** Ground-query filter: skip excluded bodies (userData key `controller`). */
  private readonly rayFilter = (collider: Collider): boolean => {
    const userData = collider.parent()?.userData as WheelUserData | undefined;
    return !(
      userData?.controller?.excludeRay || userData?.controller?.excludeVehicleRay
    );
  };

  constructor(vehicle: WheelVehicleContext, options: WheelOptions) {
    this.vehicle = vehicle;

    this.id = options.id ?? THREE.MathUtils.generateUUID();
    this.name = options.name ?? "";
    this.enabled = options.enable ?? true;

    this.groundDetection = options.groundDetection ?? "shapeCast";
    this.rayShapeR = options.rayShapeR ?? 0.5;
    this.rayShapeH = options.rayShapeH ?? 0.15;
    this.rayLength = options.rayLength ?? 0.5;
    this.springK = options.springK ?? 180;
    this.dampingC = options.dampingC ?? 16; // max at 2*sqrt(K*mass)

    this.driveInvert = options.driveInvert ?? false;
    this.driveWheel = options.driveWheel ?? false;
    this.driveTorqueWeight = options.driveTorqueWeight ?? 1;
    this.steerInvert = options.steerInvert ?? false;
    this.steerWheel = options.steerWheel ?? false;
    this.brakeWheel = options.brakeWheel ?? false;
    this.maxBrakeTorque = options.maxBrakeTorque ?? 40;

    this.rollingResistanceCoef = options.rollingResistanceCoef ?? 0.007;

    this.lowVelThreshold = options.lowVelThreshold ?? 0.4;
    this.tireGripFactor = options.tireGripFactor ?? 1.5;
    this.lngFrictionEllipseScale = options.lngFrictionEllipseScale ?? 1;
    this.latFrictionEllipseScale = options.latFrictionEllipseScale ?? 1;
    this.relaxLngRate = options.relaxLngRate ?? 0.05;
    this.relaxLatRate = options.relaxLatRate ?? 0.1;
    this.minLngRelaxCoeff = options.minLngRelaxCoeff ?? 0.3;
    this.minLatRelaxCoeff = options.minLatRelaxCoeff ?? 0.3;

    this.followPlatform = options.followPlatform ?? true;
    this.applyCounterMass = options.applyCounterMass ?? true;
    this.applyCounterFriction = options.applyCounterFriction ?? true;

    this.updateModel = options.updateModel ?? true;
    this.wheelModelRadius = options.wheelModelRadius ?? 0.5;
    this.wheelModelLerpPosRate = options.wheelModelLerpPosRate ?? 10;
    this.wheelModelReverseRotation = options.wheelModelReverseRotation ?? false;

    // Derived wheel constants (visual density proxy -> inertia; no collider).
    const wheelModelDensity = options.wheelModelDensity ?? 1.5;
    const wheelVolume =
      Math.PI * this.rayShapeR * this.rayShapeR * (this.rayShapeH * 2);
    this.wheelMass = wheelModelDensity * wheelVolume;
    this.wheelInertia = 0.5 * this.wheelMass * this.rayShapeR * this.rayShapeR;

    // Bake curve LUTs.
    const lngData = options.lngSlipRatioCurveData ?? DEFAULT_LNG_SLIP_CURVE;
    this.lngSlipRatioCurve = bakeCurveLUT(lngData.points, lngData.samples ?? 50);
    const latData = options.latSlipRatioCurveData ?? DEFAULT_LAT_SLIP_CURVE;
    this.latSlipRatioCurve = bakeCurveLUT(latData.points, latData.samples ?? 50);
    const massData =
      options.massRatioFallOffCurveData ?? DEFAULT_MASS_RATIO_FALL_OFF_CURVE;
    this.massRatioFallOffCurve = bakeCurveLUT(
      massData.points,
      massData.samples ?? 50
    );

    // Cylinder ctor order is (halfHeight, radius) — swapping the args gives a
    // pancake wheel that "works" until side contacts.
    this.rayShape = new RAPIER.Cylinder(this.rayShapeH, this.rayShapeR);
    // The Ray holds LIVE references to rayOrigin/rayDirection.
    this.rayCastRay = new RAPIER.Ray(this.rayOrigin, this.rayDirection);

    // Build the visual hierarchy; the caller (VehicleController.addWheel)
    // parents `wheelGroup` under the chassis object.
    this.wheelGroup.position.copy(options.position);
    this.wheelGroup.add(this.suspensionGroup);
    this.suspensionGroup.add(this.modelObject);
  }

  /**
   * Full per-step wheel pipeline. Called by `VehicleController.update()`
   * (children-first order) once per fixed physics step, BEFORE `world.step()`.
   */
  update(): void {
    if (!this.enabled) return;
    const body = this.vehicle.body;
    const gravityMag = this.vehicle.gravityMag;

    // 1. Refresh vehicle pose/velocity info + publish LAST step's wheel state
    //    (the snapshot the vehicle brain reads — upstream wheelInfo).
    this.updateVehicleInfo(body);

    // 2. Update shapecast pose/dir/axes/velocity (applies LAST frame's steer increment).
    this.updateShapeCastDir();

    // 3. Convert demands into drive torque / steer target / brake torque.
    this.handleUserInput();

    // 4. Slew the steer angle (increment applied to the group NEXT frame).
    this.steeringWheel();

    // 5. Cast, find contact, compute the suspension (floating) impulse.
    this.floatVehicle(body);

    // 6. Detect moving platforms and their contact-point velocity.
    this.isOnMovingObjectDetect(body);

    // 7. Push wheel load back onto the stood-on dynamic body (previous frame's force).
    this.applyMassOnStandCollider();

    // 8. Push tire friction back onto the stood-on dynamic body (previous frame's impulses).
    this.applyFrictionOnStandCollider();

    // 9. Relative contact velocity (platform-adjusted).
    this.computeRelativeVelocity();

    // 10. Contact friction coefficient (surface + tire grip average).
    this.computeContactFriction();

    // 11. Slip-curve tire model -> lng/lat friction impulses.
    this.computeWheelFrictionImpulse(gravityMag);

    // 12. Integrate wheel spin (drive/brake/rolling-resistance/friction reaction).
    this.solveWheelRotation();

    // 13. Sync the visual groups (suspension bounce + spin).
    this.updateWheelModel();
  }

  /** Remove the wheel's groups from the scene graph. */
  dispose(): void {
    this.wheelGroup.removeFromParent();
  }

  // --- demand/config setters (called by the vehicle brain) ---
  setDriveDemand(v: number): void {
    this.driveDemand = v;
  }
  setBrakeDemand(v: number): void {
    this.brakeDemand = v;
  }
  setSteerDemand(v: number): void {
    this.steerDemand = v;
  }
  setDriveWheelConfig(cfg: DriveWheelConfig): void {
    this.driveWheelConfig = cfg;
  }
  setSteerWheelConfig(cfg: SteerWheelConfig): void {
    this.steerWheelConfig = cfg;
  }

  // --- readonly state ---
  // Value-typed getters return the ONE-FRAME-STALE published snapshot taken at
  // the top of update() (upstream wheelInfo semantics); vector getters return
  // live internal instances shared by reference (copy, never mutate).
  get rayHit(): ColliderShapeCastHit | RayColliderIntersection | null {
    return this.publishedRayHit;
  }
  get rayHitBody(): RigidBody | null {
    return this.publishedRayHitBody;
  }
  /** Friction application point (center-section projected + side blended). */
  get rayHitPos(): THREE.Vector3 {
    return this.rayHitPointPosition;
  }
  get rayHitNormal(): THREE.Vector3 {
    return this.rayHitPointNormal;
  }
  /** Ground collider friction at the contact. (upstream `rayHitFriciton`) */
  get rayHitFriction(): number {
    return this.publishedRayHitFriction;
  }
  get rayOriginVel(): THREE.Vector3 {
    return this.rayOriginVelocity;
  }
  /** Relative (platform-adjusted) contact velocity. */
  get rayHitPointVel(): THREE.Vector3 {
    return this.rayHitPointVelocity;
  }
  get isOnPlatform(): boolean {
    return this.publishedIsOnPlatform;
  }
  /** Suspension impulse — applied by the vehicle at `supPos`. */
  get floatImp(): THREE.Vector3 {
    return this.floatingImpulse;
  }
  get lngFricImp(): THREE.Vector3 {
    return this.lngFrictionImp;
  }
  get latFricImp(): THREE.Vector3 {
    return this.latFrictionImp;
  }
  get lngAxis(): THREE.Vector3 {
    return this._lngAxis;
  }
  get latAxis(): THREE.Vector3 {
    return this._latAxis;
  }
  get lngSlipRatio(): number {
    return this.publishedLngSlipRatio;
  }
  get latSlipRatio(): number {
    return this.publishedLatSlipRatio;
  }
  /** max(lngSlipRatio, latSlipRatio) — handy for skid VFX/SFX triggers. */
  get slipStrength(): number {
    return this.publishedSlipStrength;
  }
  /** effectiveInertia = 0.5*m_wheel*r^2 + (load/g)*r^2. */
  get effInertia(): number {
    return this.publishedEffInertia;
  }
  /** Suspension application point (shape center + side-contact offset). */
  get supPos(): THREE.Vector3 {
    return this.supportPoint;
  }
  get steerAngle(): number {
    return this.publishedSteerAngle;
  }
  get driveTorque(): number {
    return this.publishedDriveTorque;
  }
  get brakeTorque(): number {
    return this.publishedBrakeTorque;
  }
  /** Wheel spin (rad/s). */
  get wheelAngVel(): number {
    return this.publishedWheelAngVel;
  }
  /** Wheel surface speed = wheelAngVel * rayShapeR (m/s). */
  get wheelLinVel(): number {
    return this.publishedWheelLinVel;
  }
  /** Current suspension hit distance (0 when airborne). Port-only extension
   *  (no upstream wheelInfo field), so it reads LIVE, not the snapshot. */
  get suspensionToi(): number {
    return this._suspensionToi;
  }

  // ------------------------------------------------------------------
  // Pipeline internals (order and formulas mirror upstream exactly)
  // ------------------------------------------------------------------

  private updateVehicleInfo(body: RigidBody): void {
    this.vehiclePos.copy(body.translation());
    this.vehicleQuat.copy(body.rotation());

    this.vehicleYAxis.set(0, 1, 0).applyQuaternion(this.vehicleQuat);
    this.vehicleXAxis.set(1, 0, 0).applyQuaternion(this.vehicleQuat);
    this.vehicleZAxis.set(0, 0, 1).applyQuaternion(this.vehicleQuat);

    this.vehicleLinVel.copy(body.linvel());
    this.vehicleAngVel.copy(body.angvel());

    // Publish LAST step's value-typed wheel state (see the published-state
    // field block for why this snapshot must happen HERE, before floatVehicle
    // and solveWheelRotation mutate the live fields).
    this.publishedRayHit =
      this.groundDetection === "rayCast" ? this._rayHit : this._shapeRayHit;
    this.publishedRayHitBody = this._rayHitBody;
    this.publishedRayHitFriction = this._rayHitFriction;
    this.publishedIsOnPlatform = this._isOnMovingObject;
    this.publishedLngSlipRatio = this._lngSlipRatio;
    this.publishedLatSlipRatio = this._latSlipRatio;
    this.publishedSlipStrength = this._slipStrength;
    this.publishedEffInertia = this.effectiveInertia;
    this.publishedSteerAngle = this._steerAngle;
    this.publishedDriveTorque = this._driveTorque;
    this.publishedBrakeTorque = this._brakeTorque;
    this.publishedWheelAngVel = this._wheelAngVel;
    this.publishedWheelLinVel = this._wheelAngVel * this.rayShapeR;
  }

  private updateShapeCastDir(): void {
    // Steer and gather world pos/quat. NOTE: applies LAST frame's increment —
    // the group's accumulated local rotation is the authoritative steer pose.
    // Requires the chassis matrixWorld already synced from the rigid body
    // (VehicleController.update() step A).
    if (this.steerWheel) this.wheelGroup.rotateY(this.steerIncrement);
    this.wheelGroup.getWorldPosition(this.worldPos);
    this.wheelGroup.getWorldQuaternion(this.worldQuat);

    // Update shape cast current info: pos/dir/axes.
    this.rayOrigin.copy(this.worldPos);
    this.rayDirection.set(0, -1, 0).applyQuaternion(this.worldQuat);
    this.rayUpAxis.copy(this.rayDirection).negate();
    this.rayFWDAxis.set(0, 0, 1).applyQuaternion(this.worldQuat);
    this.rayLeftAxis.crossVectors(this.rayUpAxis, this.rayFWDAxis).normalize();

    // Ray origin velocity = linvel + angvel x r.
    this.distFromRayOriginToVehicle.copy(this.rayOrigin).sub(this.vehiclePos);
    this.angvelToLinvel.crossVectors(
      this.vehicleAngVel,
      this.distFromRayOriginToVehicle
    );
    this.rayOriginVelocity.copy(this.vehicleLinVel).add(this.angvelToLinvel);
  }

  private handleUserInput(): void {
    const currDriveConfig = this.driveWheelConfig;
    const currSteerConfig = this.steerWheelConfig;

    // Drive torque from demand, torque split, gear ratio, reverse scaling and
    // the engine torque curve over |wheelAngVel|/maxAngVel. NOTE: intentionally
    // NOT zeroed when the guard fails (faithful to upstream).
    if (this.driveWheel && currDriveConfig && currDriveConfig.maxDriveTorque !== 0) {
      const maxAngVel =
        currDriveConfig.maxWheelAngVel *
        (this.driveDemand < 0 ? currDriveConfig.reverseRPMScale : 1);
      const angvelRatio =
        maxAngVel > 0 ? Math.abs(this._wheelAngVel) / maxAngVel : 1;
      this._driveTorque =
        this.driveDemand *
        currDriveConfig.maxDriveTorque *
        currDriveConfig.driveRatio *
        (this.driveDemand < 0 ? currDriveConfig.reverseTorqueScale : 1) *
        evaluateCurveLUT(angvelRatio, currDriveConfig.engineTorqueCurve) *
        (this.driveInvert ? -1 : 1);
    }

    // Speed-sensitive steering: normalized by the CHASSIS forward speed over
    // the car's theoretical top speed (maxWheelAngVel * r), not the wheel spin.
    if (this.steerWheel && currSteerConfig) {
      const steerMaxWheelAngVel = currSteerConfig.maxWheelAngVel;
      const speedRatio =
        steerMaxWheelAngVel > 0
          ? clamp(
              this.vehicleLinVel.dot(this.vehicleZAxis) /
                (steerMaxWheelAngVel * this.rayShapeR),
              0,
              1
            )
          : 0;
      this.steerTarget =
        this.steerDemand *
        currSteerConfig.maxSteerAngle *
        evaluateCurveLUT(speedRatio, currSteerConfig.steerAngleCurve) *
        (this.steerInvert ? -1 : 1);
    }

    // Brake: simply max torque scaled by demand.
    if (this.brakeWheel) {
      this._brakeTorque = this.brakeDemand * this.maxBrakeTorque;
    }
  }

  private steeringWheel(): void {
    const angleDiff = this.steerTarget - this._steerAngle;
    const maxIncrement =
      (this.steerWheelConfig?.steerRate ?? 0) * this.vehicle.world.timestep;
    this.steerIncrement =
      Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), maxIncrement);

    // Group rotation happens NEXT frame in updateShapeCastDir().
    this._steerAngle += this.steerIncrement;
  }

  private floatVehicle(body: RigidBody): void {
    const world = this.vehicle.world;

    // Cast the wheel detection shape/ray.
    if (this.groundDetection === "rayCast") {
      this._rayHit = world.castRayAndGetNormal(
        this.rayCastRay,
        this.rayLength + this.rayShapeR,
        false,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        body,
        this.rayFilter
      );
    } else {
      this._shapeRayHit = world.castShape(
        this.rayOrigin,
        // rotZ90 applied in LOCAL space aligns the cylinder's Y principal
        // axis with the wheel's local X axle (multiply, NOT premultiply).
        this.rayRotation.copy(this.worldQuat).multiply(this.rotZ90),
        this.rayDirection,
        this.rayShape,
        0, // targetDistance
        this.rayLength, // maxToi
        false, // stopAtPenetration
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        body,
        this.rayFilter
      );
    }

    // Retrieve ray hit collider and distance (rayCast hit uses camelCase
    // `timeOfImpact`, shapecast hit uses snake_case `time_of_impact`).
    const hitCollider =
      this.groundDetection === "rayCast"
        ? this._rayHit?.collider
        : this._shapeRayHit?.collider;
    const hitDistance =
      this.groundDetection === "rayCast"
        ? this._rayHit?.timeOfImpact
        : this._shapeRayHit?.time_of_impact;

    if (hitCollider && hitDistance != null) {
      // The ray starts at the axle, the shapecast at the rim — hence the -rayShapeR.
      this._suspensionToi =
        this.groundDetection === "rayCast"
          ? Math.max(0, hitDistance - this.rayShapeR)
          : hitDistance;
      this._rayHitBody = hitCollider.parent();
      // Raw ray hit point.
      if (this.groundDetection === "rayCast") {
        this.targetRayHitPoint
          .copy(this.rayOrigin)
          .addScaledVector(this.rayDirection, hitDistance);
      } else {
        this.targetRayHitPoint.copy(this._shapeRayHit!.witness1);
      }
      // Hit normal.
      this.rayHitPointNormal
        .copy(
          this.groundDetection === "rayCast"
            ? this._rayHit!.normal
            : this._shapeRayHit!.normal1
        )
        .normalize();
      // Shape center at suspension hit distance.
      this.rayShapeCenter
        .copy(this.rayOrigin)
        .addScaledVector(this.rayDirection, this._suspensionToi);
      // Stable center-section hit point + side-contact blending (shapecast only).
      let supportOffset = 0;
      if (this.groundDetection === "rayCast") {
        this.stableRayHitPoint.copy(this.targetRayHitPoint);
      } else {
        // Project the raw witness back to the wheel center section.
        const rawOffset = clamp(
          this.rayHitPointOffset
            .copy(this.targetRayHitPoint)
            .sub(this.rayShapeCenter)
            .dot(this.rayLeftAxis),
          -this.rayShapeH,
          this.rayShapeH
        );
        this.stableRayHitPoint
          .copy(this.targetRayHitPoint)
          .addScaledVector(this.rayLeftAxis, -rawOffset);

        // Blend side support only when the normal shows side contact.
        const normalSide = this.rayHitPointNormal.dot(this.rayLeftAxis);
        const normalFwd = this.rayHitPointNormal.dot(this.rayFWDAxis);
        const sideWeight = clamp(
          Math.abs(normalSide) /
            Math.sqrt(Math.max(1 - normalFwd * normalFwd, 1e-6)),
          0,
          1
        );
        supportOffset = -Math.abs(rawOffset) * Math.sign(normalSide) * sideWeight;
      }
      // Final friction point and support point (two DIFFERENT points — mixing
      // them up reintroduces contact-patch jacking while steering).
      this.rayHitPointPosition
        .copy(this.stableRayHitPoint)
        .addScaledVector(this.rayLeftAxis, supportOffset);
      this.supportPoint
        .copy(this.rayShapeCenter)
        .addScaledVector(this.rayLeftAxis, supportOffset);
      // Ground friction at contact.
      if (this._rayHitFriction !== hitCollider.friction())
        this._rayHitFriction = hitCollider.friction() ?? 0;
      // Spring + damping. NOTE: damping projects LAST frame's relative contact
      // velocity onto rayUpAxis while the impulse points along the hit normal —
      // the mixed frames are intentional (part of the ride feel).
      const springForce =
        this.springK * Math.max(0, this.rayLength - this._suspensionToi);
      const dampingForce =
        this.dampingC * this.rayHitPointVelocity.dot(this.rayUpAxis);
      this.floatingImpulse
        .copy(this.rayHitPointNormal)
        .multiplyScalar(springForce - dampingForce)
        .multiplyScalar(world.timestep);
    } else {
      // Reset contact state when no hit. Smoothed friction impulses are NOT
      // reset — and because the vehicle gates on the PUBLISHED (one-frame-
      // stale) rayHit, the stale lng/lat impulses ARE applied once more on
      // the contact-loss step (faithful upstream behavior).
      this._rayHitBody = null;
      this._suspensionToi = 0;
      this._rayHitFriction = 0;
      this.floatingImpulse.set(0, 0, 0);
    }
  }

  private isOnMovingObjectDetect(body: RigidBody): void {
    const hitBody = this._rayHitBody;
    // Dynamic (0) and position-kinematic (2) bodies count as platforms.
    if (
      this.followPlatform &&
      hitBody &&
      (hitBody.bodyType() === RAPIER.RigidBodyType.Dynamic ||
        hitBody.bodyType() === RAPIER.RigidBodyType.KinematicPositionBased)
    ) {
      this._isOnMovingObject = true;

      // Mass-ratio falloff (dynamic only; kinematic platforms pin ratio at 1).
      if (hitBody.bodyType() === RAPIER.RigidBodyType.Dynamic) {
        const ratio = clamp(hitBody.mass() / Math.max(body.mass(), 1e-6), 0, 1);
        this.massRatio = evaluateCurveLUT(ratio, this.massRatioFallOffCurve);
      } else {
        this.massRatio = 1;
      }

      // Standing-point velocity = linvel + angvel x r, scaled by mass ratio.
      this.movingObjectPosition.copy(hitBody.translation());
      this.distanceFromOriginToObjectPoint
        .copy(this.rayOrigin)
        .sub(this.movingObjectPosition);
      this.movingObjectLinearVelocity.copy(hitBody.linvel());
      this.movingObjectAngularVelocity.copy(hitBody.angvel());
      this.movingObjectAngvelToLinvel.crossVectors(
        this.movingObjectAngularVelocity,
        this.distanceFromOriginToObjectPoint
      );
      this.movingObjectVelocity
        .copy(this.movingObjectLinearVelocity)
        .add(this.movingObjectAngvelToLinvel)
        .multiplyScalar(this.massRatio);
      this.movingObjectVelocityOnPlane
        .copy(this.movingObjectVelocity)
        .projectOnPlane(this.rayHitPointNormal);
    } else {
      this._isOnMovingObject = false;
      this.movingObjectVelocity.set(0, 0, 0);
      this.movingObjectVelocityOnPlane.set(0, 0, 0);
      this.massRatio = 1;
    }
  }

  private applyMassOnStandCollider(): void {
    const hitBody = this._rayHitBody;
    // Counter impulses go only to dynamic bodies; wake flag `true` when
    // poking OTHER bodies. Uses PREVIOUS frame's wheelSupportForceMag.
    if (
      !hitBody ||
      hitBody.bodyType() !== RAPIER.RigidBodyType.Dynamic ||
      !this.applyCounterMass
    )
      return;
    this.wheelSupportImpulse
      .copy(this.rayHitPointNormal)
      .multiplyScalar(
        -1 * this.wheelSupportForceMag * this.vehicle.world.timestep * this.massRatio
      );
    if (this.wheelSupportForceMag > 0)
      hitBody.applyImpulseAtPoint(
        this.wheelSupportImpulse,
        this.rayHitPointPosition,
        true
      );
  }

  // Upstream method name is typo'd `applyFricitonOnStandCollider`.
  private applyFrictionOnStandCollider(): void {
    const hitBody = this._rayHitBody;
    if (
      !hitBody ||
      hitBody.bodyType() !== RAPIER.RigidBodyType.Dynamic ||
      !this.applyCounterFriction
    )
      return;
    // PREVIOUS frame's friction impulses.
    this.wheelFrictionImpulse
      .addVectors(this.lngFrictionImp, this.latFrictionImp)
      .multiplyScalar(-1 * this.massRatio);
    if (this.wheelFrictionImpulse.lengthSq() > 1e-4)
      hitBody.applyImpulseAtPoint(
        this.wheelFrictionImpulse,
        this.rayHitPointPosition,
        true
      );
  }

  private computeRelativeVelocity(): void {
    this.rayHitPointVelocity.copy(this.rayOriginVelocity);
    this.rayHitPointVelOnPlane
      .copy(this.rayHitPointVelocity)
      .projectOnPlane(this.rayHitPointNormal);
    if (this._isOnMovingObject && this.followPlatform) {
      this.rayHitPointVelocity.sub(this.movingObjectVelocity);
      this.rayHitPointVelOnPlane.sub(this.movingObjectVelocityOnPlane);
    }
  }

  private computeContactFriction(): void {
    if (this._rayHitBody)
      this.frictionCoef = Math.max(
        (this._rayHitFriction + this.tireGripFactor) * 0.5,
        0
      );
    else this.frictionCoef = 0;
  }

  private computeWheelFrictionImpulse(gravityMag: number): void {
    const timestep = this.vehicle.world.timestep;

    // Airborne: keep rolling resistance / effective inertia sane, zero slip.
    // (Friction impulses keep stale values — the stale-rayHit gate in the
    // vehicle applies them exactly once more on the contact-loss step, as
    // upstream does.)
    if (!this._rayHitBody) {
      this.wheelSupportForceMag = this.wheelMass * gravityMag;
      this.effectiveInertia =
        this.wheelInertia +
        (this.wheelSupportForceMag / gravityMag) * this.rayShapeR * this.rayShapeR;
      this._lngSlipRatio = 0;
      this._latSlipRatio = 0;
      this._slipStrength = 0;
      return;
    }

    // Wheel support force from the floating impulse.
    const floatingImpMag = Math.max(
      this.floatingImpulse.dot(this.rayHitPointNormal),
      0
    );
    this.wheelSupportForceMag = floatingImpMag / timestep;

    // effectiveInertia = 0.5*m*r^2 + (load/g)*r^2.
    this.effectiveInertia =
      this.wheelInertia +
      (this.wheelSupportForceMag / gravityMag) * this.rayShapeR * this.rayShapeR;

    // Longitudinal and lateral axes on the contact plane.
    this._lngAxis
      .copy(this.rayFWDAxis)
      .projectOnPlane(this.rayHitPointNormal)
      .normalize();
    this._latAxis
      .copy(this.rayLeftAxis)
      .projectOnPlane(this.rayHitPointNormal)
      .normalize();
    // Contact point velocities.
    const lngContactVel = this.rayHitPointVelocity.dot(this._lngAxis);
    const latContactVel = this.rayHitPointVelocity.dot(this._latAxis);
    const lngContactVelAbs = Math.abs(lngContactVel);
    const latContactVelAbs = Math.abs(latContactVel);
    // Wheel surface speed and slip.
    const wheelLinVel = this._wheelAngVel * this.rayShapeR;
    const slipDiff = wheelLinVel - lngContactVel;
    const slipDiffAbs = Math.abs(slipDiff);

    // Slip ratios and slip-curve values.
    this._lngSlipRatio = slipDiffAbs / Math.max(lngContactVelAbs, 1e-4);
    this._latSlipRatio =
      latContactVelAbs === 0 && lngContactVelAbs === 0
        ? 0
        : clamp(Math.atan2(latContactVelAbs, lngContactVelAbs) / (Math.PI / 2), 0, 1);
    this._slipStrength = Math.max(this._lngSlipRatio, this._latSlipRatio);
    const lngSlipValue = evaluateCurveLUT(this._lngSlipRatio, this.lngSlipRatioCurve);
    const latSlipValue = evaluateCurveLUT(this._latSlipRatio, this.latSlipRatioCurve);

    // Static friction blend at low speed.
    const lngStaticWeight = clamp(
      1.0 - Math.max(slipDiffAbs, lngContactVelAbs) / this.lowVelThreshold,
      0,
      1
    );
    const finalLngSlipValue = remap(lngStaticWeight, 0, 1, lngSlipValue, 1);
    const latStaticWeight = clamp(
      1.0 - Math.max(latContactVelAbs, lngContactVelAbs) / this.lowVelThreshold,
      0,
      1
    );
    const finalLatSlipValue = remap(latStaticWeight, 0, 1, latSlipValue, 1);

    // Friction ellipse: max allowed impulse per axis.
    const maxLngImp =
      this.wheelSupportForceMag *
      finalLngSlipValue *
      this.frictionCoef *
      timestep *
      this.lngFrictionEllipseScale;
    const maxLatImp =
      this.wheelSupportForceMag *
      finalLatSlipValue *
      this.frictionCoef *
      timestep *
      this.latFrictionEllipseScale;

    // Desired impulses from slip and load.
    this.desiredLngImpulse =
      (slipDiff * this.effectiveInertia) / (this.rayShapeR * this.rayShapeR);
    this.desiredLatImpulse = latContactVel * (this.wheelSupportForceMag / gravityMag);

    // Clamp within the ellipse. (Degenerate 0/0 -> NaN -> no clamp; Infinity ->
    // zeroed impulses. JS semantics make this safe — do NOT add guards.)
    const ellipseUsage = Math.sqrt(
      (this.desiredLngImpulse / maxLngImp) * (this.desiredLngImpulse / maxLngImp) +
        (this.desiredLatImpulse / maxLatImp) * (this.desiredLatImpulse / maxLatImp)
    );
    if (ellipseUsage > 1.0) {
      this.desiredLngImpulse /= ellipseUsage;
      this.desiredLatImpulse /= ellipseUsage;
    }

    // Tire relaxation: keep low-speed tires responsive while still allowing
    // speed-based relaxation.
    const lngCoeff = clamp(
      Math.max(
        this.minLngRelaxCoeff,
        (lngContactVelAbs / Math.max(this.relaxLngRate, 1e-6)) * timestep
      ),
      0,
      1
    );
    const latCoeff = clamp(
      Math.max(
        this.minLatRelaxCoeff,
        (latContactVelAbs / Math.max(this.relaxLatRate, 1e-6)) * timestep
      ),
      0,
      1
    );
    this.smoothedLngImpulse +=
      (this.desiredLngImpulse - this.smoothedLngImpulse) * lngCoeff;
    this.smoothedLatImpulse +=
      (this.desiredLatImpulse - this.smoothedLatImpulse) * latCoeff;

    // Final impulses. The lateral one OPPOSES lateral contact velocity via the
    // explicit minus; the longitudinal has no minus because slipDiff already
    // encodes direction.
    this.lngFrictionImp.copy(this._lngAxis).multiplyScalar(this.smoothedLngImpulse);
    this.latFrictionImp.copy(this._latAxis).multiplyScalar(-this.smoothedLatImpulse);
  }

  private solveWheelRotation(): void {
    const timestep = this.vehicle.world.timestep;

    // Define wheel state (no engine spin in air).
    const isDriving =
      this.driveWheel && Math.abs(this._driveTorque) > 0 && this._rayHitBody;
    const isBraking =
      this.brakeWheel && Math.abs(this._brakeTorque) > 0 && this._rayHitBody;
    const isFreeRolling = !isDriving && !isBraking;

    // Friction reaction torque — IMPULSE-based, NO timestep factor: the
    // impulse divided by effectiveInertia/r (with the extra r) is a Δ(rad/s).
    if (this._rayHitBody)
      this._wheelAngVel -=
        (this.lngFrictionImp.dot(this._lngAxis) * this.rayShapeR) /
        this.effectiveInertia;

    // Rolling resistance: on ground when free-rolling, or in air while spinning.
    if (
      (this._rayHitBody && isFreeRolling) ||
      (!this._rayHitBody && this._wheelAngVel !== 0)
    ) {
      const rollingResistTorque =
        -this.rollingResistanceCoef * this.wheelSupportForceMag * this._wheelAngVel;
      this._wheelAngVel +=
        (rollingResistTorque / this.effectiveInertia) * timestep;
    }

    // Engine torque.
    if (isDriving && !isBraking)
      this._wheelAngVel += (this._driveTorque / this.effectiveInertia) * timestep;

    // Brake torque — clamped so braking can never reverse the spin in one step.
    if (isBraking) {
      const appliedBrakeTorque = this._brakeTorque * -Math.sign(this._wheelAngVel);
      this._wheelAngVel +=
        Math.min(
          Math.abs(this._wheelAngVel),
          Math.abs(appliedBrakeTorque / this.effectiveInertia) * timestep
        ) * -Math.sign(this._wheelAngVel);
    }
  }

  private updateWheelModel(): void {
    if (!this.updateModel) return;
    const timestep = this.vehicle.world.timestep;
    // Suspension bounce.
    const hasContact =
      this.groundDetection === "rayCast" ? this._rayHit : this._shapeRayHit;
    const offsetY = hasContact
      ? -(this.rayLength + this.rayShapeR) +
        this.wheelModelRadius +
        (this.rayLength - this._suspensionToi)
      : -(this.rayLength + this.rayShapeR) + this.wheelModelRadius;
    this.suspensionGroup.position.y = THREE.MathUtils.lerp(
      this.suspensionGroup.position.y,
      offsetY,
      1 - Math.exp(-this.wheelModelLerpPosRate * timestep)
    );
    // Wheel spin.
    this.modelObject.rotation.x +=
      this._wheelAngVel * timestep * (this.wheelModelReverseRotation ? -1 : 1);
  }
}
