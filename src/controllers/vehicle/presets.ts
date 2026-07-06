// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TypeScript port of the ecctrl vehicle controller (React/R3F removed).
// Pure data: named vehicle presets. `arcade-kart` and `muscle-drift` are
// verbatim from the upstream MIT demo's two tuned vehicles; `offroad-bouncy`
// and `race-grip` are Genex-authored starting points derived from them.

import type { CarConfig } from "./vehicle-controller.ts";
import type { WheelOptions } from "./wheel.ts";

/**
 * One chassis collider (cuboid) to attach to `vehicle.body`, e.g. via
 * `cuboidCollider(world, vehicle.body, [x, y, z], { position, density })`.
 */
export type ChassisColliderSpec = {
  /** Cuboid HALF extents (m). */
  halfExtents: { x: number; y: number; z: number };
  /** Collider offset from the body origin (m). */
  offset: { x: number; y: number; z: number };
  /** Collider density (kg/m^3). Chassis mass = volume x density. */
  density: number;
};

/** One wheel mount: local position (+Z = front) plus per-wheel role flags. */
export type WheelSlotSpec = {
  position: { x: number; y: number; z: number };
  steerWheel?: boolean;
  driveWheel?: boolean;
  brakeWheel?: boolean;
  driveTorqueWeight?: number;
  maxBrakeTorque?: number;
};

/**
 * A complete car recipe: chassis colliders, drivetrain config, shared wheel
 * options, and the four wheel slots (order FL, FR, RL, RR; +Z = forward,
 * +X = left).
 *
 * IMPORTANT: suspension `springK`/`dampingC` in `wheelShared` scale with
 * chassis MASS — every preset states its `assumedChassisDensity` for the
 * listed collider volumes. If your chassis is materially heavier/lighter,
 * rescale springK proportionally and keep dampingC below
 * `2*sqrt(springK * massPerWheel)`.
 *
 * Wiring sketch:
 * ```ts
 * const car = new VehicleController({ world, carConfig: preset.carConfig });
 * for (const c of preset.chassisColliders)
 *   cuboidCollider(world, car.body, [c.halfExtents.x, c.halfExtents.y, c.halfExtents.z],
 *     { position: [c.offset.x, c.offset.y, c.offset.z], density: c.density });
 * for (const slot of preset.wheelSlots)
 *   car.addWheel({ ...preset.wheelShared, ...slot,
 *     position: new THREE.Vector3(slot.position.x, slot.position.y, slot.position.z) });
 * ```
 */
export type VehiclePreset = {
  name: string;
  /** Density the spring constants were tuned against (see note above). */
  assumedChassisDensity: number;
  carConfig: Partial<CarConfig>;
  /** Applied to every wheel (slots override per-wheel fields). */
  wheelShared: Omit<Partial<WheelOptions>, "position">;
  /** FL, FR, RL, RR. */
  wheelSlots: WheelSlotSpec[];
  chassisColliders: ChassisColliderSpec[];
};

/**
 * Upstream demo "Vehicle 1", verbatim: an all-wheel-drive, front-steer kart
 * with stiff suspension and forgiving grip. The safe default.
 */
export const arcadeKart: VehiclePreset = {
  name: "arcade-kart",
  assumedChassisDensity: 200,
  carConfig: {
    engineHorsepower: 600,
    engineMaxRPM: 6000,
    gearRatios: [10],
    finalDriveRatio: 1,
    transmissionMode: "auto",
    shiftUpRPM: 5200,
    shiftDownRPM: 2200,
    shiftCooldown: 0.35,
    steerRate: Math.PI * 2,
    maxSteerAngle: Math.PI / 6,
    reverseTorqueScale: 1,
    reverseRPMScale: 0.5,
  },
  wheelShared: {
    springK: 38000,
    dampingC: 4000,
    rayShapeR: 0.5,
    rayShapeH: 0.15,
    rayLength: 0.5,
    maxBrakeTorque: 3000,
    tireGripFactor: 1.3,
    wheelModelDensity: 100,
    wheelModelRadius: 0.5,
  },
  wheelSlots: [
    { position: { x: 0.9, y: 0, z: 1.8 }, steerWheel: true, driveWheel: true, brakeWheel: true },
    { position: { x: -0.9, y: 0, z: 1.8 }, steerWheel: true, driveWheel: true, brakeWheel: true },
    { position: { x: 0.9, y: 0, z: -1.8 }, driveWheel: true, brakeWheel: true },
    { position: { x: -0.9, y: 0, z: -1.8 }, driveWheel: true, brakeWheel: true },
  ],
  chassisColliders: [
    {
      halfExtents: { x: 1, y: 0.4, z: 2.4 },
      offset: { x: 0, y: 0.1, z: 0 },
      density: 200,
    },
  ],
};

/**
 * Upstream demo "Vehicle 2", verbatim: softer suspension, rear-biased drive
 * torque (rear `driveTorqueWeight` 2) — power-oversteers into drifts under
 * throttle.
 */
export const muscleDrift: VehiclePreset = {
  name: "muscle-drift",
  assumedChassisDensity: 200,
  carConfig: {
    engineHorsepower: 600,
    engineMaxRPM: 6000,
    gearRatios: [10],
    finalDriveRatio: 1,
    transmissionMode: "auto",
    shiftUpRPM: 5200,
    shiftDownRPM: 2200,
    shiftCooldown: 0.35,
    steerRate: Math.PI * 2,
    maxSteerAngle: Math.PI / 6,
    reverseTorqueScale: 1,
    reverseRPMScale: 0.5,
  },
  wheelShared: {
    springK: 25000,
    dampingC: 3200,
    rayShapeR: 0.5,
    rayShapeH: 0.15,
    rayLength: 0.5,
    tireGripFactor: 1.3,
    wheelModelDensity: 100,
    wheelModelRadius: 0.5,
  },
  wheelSlots: [
    { position: { x: 0.85, y: 0, z: 1.5 }, steerWheel: true, driveWheel: true, brakeWheel: true, maxBrakeTorque: 2600 },
    { position: { x: -0.85, y: 0, z: 1.5 }, steerWheel: true, driveWheel: true, brakeWheel: true, maxBrakeTorque: 2600 },
    { position: { x: 0.85, y: 0, z: -1.5 }, driveWheel: true, brakeWheel: true, driveTorqueWeight: 2, maxBrakeTorque: 1800 },
    { position: { x: -0.85, y: 0, z: -1.5 }, driveWheel: true, brakeWheel: true, driveTorqueWeight: 2, maxBrakeTorque: 1800 },
  ],
  chassisColliders: [
    {
      halfExtents: { x: 0.8, y: 0.17, z: 1 },
      offset: { x: 0, y: 0.5, z: -0.6 },
      density: 100,
    },
    {
      halfExtents: { x: 1, y: 0.3, z: 2.4 },
      offset: { x: 0, y: 0, z: 0 },
      density: 200,
    },
  ],
};

/**
 * Genex-authored starting point (no upstream source — TUNE IN TESTBED):
 * softer, longer-travel suspension for a springy ride over bumps, bigger
 * wheels, lower grip, wider steering. Derived from `arcade-kart`.
 */
export const offroadBouncy: VehiclePreset = {
  name: "offroad-bouncy",
  assumedChassisDensity: 200,
  carConfig: {
    engineHorsepower: 450,
    engineMaxRPM: 6000,
    gearRatios: [10],
    finalDriveRatio: 1,
    transmissionMode: "auto",
    shiftUpRPM: 5200,
    shiftDownRPM: 2200,
    shiftCooldown: 0.35,
    steerRate: Math.PI * 2,
    maxSteerAngle: Math.PI / 5,
    reverseTorqueScale: 1,
    reverseRPMScale: 0.5,
  },
  wheelShared: {
    springK: 16000,
    dampingC: 1600,
    rayShapeR: 0.6,
    rayShapeH: 0.15,
    rayLength: 0.8,
    maxBrakeTorque: 3000,
    tireGripFactor: 1.0,
    lowVelThreshold: 0.5,
    rollingResistanceCoef: 0.012,
    wheelModelDensity: 100,
    wheelModelRadius: 0.6,
  },
  wheelSlots: [
    { position: { x: 0.9, y: 0, z: 1.8 }, steerWheel: true, driveWheel: true, brakeWheel: true },
    { position: { x: -0.9, y: 0, z: 1.8 }, steerWheel: true, driveWheel: true, brakeWheel: true },
    { position: { x: 0.9, y: 0, z: -1.8 }, driveWheel: true, brakeWheel: true },
    { position: { x: -0.9, y: 0, z: -1.8 }, driveWheel: true, brakeWheel: true },
  ],
  chassisColliders: [
    {
      halfExtents: { x: 1, y: 0.4, z: 2.4 },
      offset: { x: 0, y: 0.1, z: 0 },
      density: 200,
    },
  ],
};

/**
 * Genex-authored starting point (no upstream source — tuned in the testbed):
 * stiff rear-wheel-drive racer with high grip and a 4-speed gearbox so the
 * RPM-threshold auto shift actually exercises. Chassis from `muscle-drift`.
 *
 * Gearing note: the tire model's rolling resistance grows with wheel speed,
 * so each gear has a drag-limited equilibrium RPM (measured in the testbed:
 * ~5500 / ~4900 / ~4100 for gears 1-3). `shiftUpRPM` must sit BELOW the
 * next-lower gear's equilibrium or the shift point is never reached; 4300
 * gives two clean upshifts on flat ground and post-shift RPM ~2800-3000
 * (safely above `shiftDownRPM` — no hunting).
 */
export const raceGrip: VehiclePreset = {
  name: "race-grip",
  assumedChassisDensity: 200,
  carConfig: {
    engineHorsepower: 800,
    engineMaxRPM: 6000,
    gearRatios: [20, 13, 9, 6.5],
    finalDriveRatio: 1,
    transmissionMode: "auto",
    shiftUpRPM: 4300,
    shiftDownRPM: 2400,
    shiftCooldown: 0.35,
    steerRate: Math.PI * 2,
    maxSteerAngle: Math.PI / 7,
    reverseTorqueScale: 1,
    reverseRPMScale: 0.3,
  },
  wheelShared: {
    springK: 42000,
    dampingC: 5200,
    rayShapeR: 0.5,
    rayShapeH: 0.15,
    rayLength: 0.5,
    // Grip vs rollover (measured in the testbed): the lat slip curve keeps
    // ~90% grip even in a full slide, so peak lateral acceleration is
    // ~(groundFriction + tireGripFactor)/2 * latFrictionEllipseScale in g.
    // Keep that at or below the static rollover threshold
    // (halfTrack / comHeight, ~1.0 g for this chassis) or a handbrake slide
    // trips the car over instead of drifting.
    tireGripFactor: 1.5,
    lngFrictionEllipseScale: 1.15,
    latFrictionEllipseScale: 0.8,
    // Low-resistance racing tires (library default 0.007): raises the
    // drag-limited top speed per gear so the auto shift has headroom.
    rollingResistanceCoef: 0.004,
    wheelModelDensity: 100,
    wheelModelRadius: 0.5,
  },
  wheelSlots: [
    { position: { x: 0.85, y: 0, z: 1.5 }, steerWheel: true, brakeWheel: true, maxBrakeTorque: 2600 },
    { position: { x: -0.85, y: 0, z: 1.5 }, steerWheel: true, brakeWheel: true, maxBrakeTorque: 2600 },
    { position: { x: 0.85, y: 0, z: -1.5 }, driveWheel: true, brakeWheel: true, driveTorqueWeight: 1.5, maxBrakeTorque: 1800 },
    { position: { x: -0.85, y: 0, z: -1.5 }, driveWheel: true, brakeWheel: true, driveTorqueWeight: 1.5, maxBrakeTorque: 1800 },
  ],
  chassisColliders: [
    // Light cabin + low-slung main mass: keeps the CoM near axle height so
    // hard cornering leans instead of tripping over.
    {
      halfExtents: { x: 0.8, y: 0.17, z: 1 },
      offset: { x: 0, y: 0.5, z: -0.6 },
      density: 60,
    },
    {
      halfExtents: { x: 1, y: 0.3, z: 2.4 },
      offset: { x: 0, y: -0.15, z: 0 },
      density: 200,
    },
  ],
};

/** All presets by kebab-case name. */
export const vehiclePresets: Readonly<
  Record<"arcade-kart" | "muscle-drift" | "offroad-bouncy" | "race-grip", VehiclePreset>
> = {
  "arcade-kart": arcadeKart,
  "muscle-drift": muscleDrift,
  "offroad-bouncy": offroadBouncy,
  "race-grip": raceGrip,
};
