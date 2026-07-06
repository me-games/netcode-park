// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TS port of the ecctrl drone controller (named preset tables:
// heavy-lifter is the upstream demo drone verbatim; camera-drone and
// racing-drone are product tuning derived from the library defaults).

import type { DroneConfig } from "./drone-controller.ts";

/**
 * One propeller slot of a preset: where to place the mount (in chassis
 * space) and how to configure it. Thrust axis is the mount's local +Y.
 */
export interface DronePropellerPreset {
  /** Mount position in chassis space. */
  position: { x: number; y: number; z: number };
  /** Max thrust in newtons at full throttle. */
  maxThrust: number;
  /** Reaction torque = maxThrust * torqueRatio. */
  torqueRatio: number;
  /**
   * Counter-rotation flag. Diagonal pairs share the same value so reaction
   * torques cancel at hover (quad-X layout).
   */
  invertTorque: boolean;
}

/**
 * Collider recipe for the chassis body: one central cuboid plus one flat
 * cylinder under each propeller (arm tips). Feed these to the collider
 * helpers in shared/colliders.ts when building the rigid body.
 */
export interface DroneBodyPreset {
  cuboidHalfExtents: { x: number; y: number; z: number };
  armCylinders: {
    halfHeight: number;
    radius: number;
    positions: { x: number; y: number; z: number }[];
  };
  /** Collider density (kg/m^3). Rapier derives the actual mass from this. */
  density: number;
  /**
   * Documentation value only — Rapier computes the real mass from the
   * colliders. The PD POSITION gains and maxThrust in `config` assume a mass
   * near this number.
   */
  approxMassKg: number;
}

/** A complete, ready-to-fly drone recipe. */
export interface DronePreset {
  name: string;
  /** Merged over DEFAULT_DRONE_CONFIG by the controller. */
  config: Partial<DroneConfig>;
  /** Always 4 propellers in a quad-X layout. */
  propellers: DronePropellerPreset[];
  body: DroneBodyPreset;
  /**
   * weight / (4 * maxThrust), documentation value. Attitude authority is
   * best when this is near 0.5 (total thrust ~ 2x weight).
   */
  approxHoverThrottle: number;
  /** Plain-language provenance and tuning hints. */
  notes: string;
}

// All presets are quad-X: propellers at (+-ox, oy, +-oz) with invertTorque
// true on the (+x,+z) and (-x,-z) diagonal pair (counter-rotation, so the
// reaction torques cancel at hover).

/**
 * Slow, heavily damped aerial-camera platform (~2 kg at density 335).
 * Gentle 20-degree tilt limit, strong air drag, extra tilt damping. The
 * POSITION-mode gains stay at the library defaults, which fit a ~2 kg drone.
 */
export const cameraDrone: DronePreset = {
  name: "camera-drone",
  config: {
    controlMode: "VELOCITY",
    maxYawRate: 1.2,
    maxHorizSpeed: 10,
    maxVertSpeed: 4,
    maxTiltAngle: Math.PI / 9, // 20 degrees
    airDragFactor: 0.4,
    TILT_D: 4,
  },
  propellers: [
    { position: { x: 0.25, y: 0.02, z: 0.25 }, maxThrust: 10, torqueRatio: 0.6, invertTorque: true },
    { position: { x: -0.25, y: 0.02, z: 0.25 }, maxThrust: 10, torqueRatio: 0.6, invertTorque: false },
    { position: { x: 0.25, y: 0.02, z: -0.25 }, maxThrust: 10, torqueRatio: 0.6, invertTorque: false },
    { position: { x: -0.25, y: 0.02, z: -0.25 }, maxThrust: 10, torqueRatio: 0.6, invertTorque: true },
  ],
  body: {
    cuboidHalfExtents: { x: 0.12, y: 0.04, z: 0.12 },
    armCylinders: {
      halfHeight: 0.01,
      radius: 0.12,
      positions: [
        { x: 0.25, y: 0.02, z: 0.25 },
        { x: -0.25, y: 0.02, z: 0.25 },
        { x: 0.25, y: 0.02, z: -0.25 },
        { x: -0.25, y: 0.02, z: -0.25 },
      ],
    },
    density: 335,
    approxMassKg: 2,
  },
  approxHoverThrottle: 0.49,
  notes:
    "Steady filming platform, assumes a ~2 kg body (density 335). Hover sits " +
    "near 0.49 throttle, so attitude authority is close to its best. Feels " +
    "floaty on purpose: high air drag and extra tilt damping smooth out " +
    "stick input. If you change the mass, scale maxThrust to keep hover near " +
    "0.5 and scale VERT_POS_/HORIZ_POS_ gains linearly with mass.",
};

/**
 * Agile FPV-style racer (~5 kg at density 240). Full 45-degree tilt, fast
 * yaw, low drag, snappier tilt response.
 */
export const racingDrone: DronePreset = {
  name: "racing-drone",
  config: {
    controlMode: "VELOCITY",
    maxYawRate: 3.5,
    maxVertSpeed: 12,
    airDragFactor: 0.15,
    TILT_P: 18,
    TILT_D: 2.5,
  },
  propellers: [
    { position: { x: 0.3, y: 0.02, z: 0.3 }, maxThrust: 25, torqueRatio: 0.6, invertTorque: true },
    { position: { x: -0.3, y: 0.02, z: 0.3 }, maxThrust: 25, torqueRatio: 0.6, invertTorque: false },
    { position: { x: 0.3, y: 0.02, z: -0.3 }, maxThrust: 25, torqueRatio: 0.6, invertTorque: false },
    { position: { x: -0.3, y: 0.02, z: -0.3 }, maxThrust: 25, torqueRatio: 0.6, invertTorque: true },
  ],
  body: {
    cuboidHalfExtents: { x: 0.15, y: 0.05, z: 0.2 },
    armCylinders: {
      halfHeight: 0.01,
      radius: 0.15,
      positions: [
        { x: 0.3, y: 0.02, z: 0.3 },
        { x: -0.3, y: 0.02, z: 0.3 },
        { x: 0.3, y: 0.02, z: -0.3 },
        { x: -0.3, y: 0.02, z: -0.3 },
      ],
    },
    density: 240,
    approxMassKg: 5,
  },
  approxHoverThrottle: 0.49,
  notes:
    "Fast and twitchy, assumes a ~5 kg body (density 240). Full 45-degree " +
    "tilt at 30 m/s (library default) with quick yaw. Raise TILT_P for even " +
    "sharper flips, raise TILT_D if it wobbles after a maneuver. POSITION " +
    "gains stay at library defaults, sized for a light drone; scale them " +
    "with mass if you make it heavier.",
};

/**
 * The upstream demo drone, verbatim (~298 kg at density 200): big cargo
 * platform with POSITION gains pre-scaled x100 for its mass.
 */
export const heavyLifter: DronePreset = {
  name: "heavy-lifter",
  config: {
    controlMode: "VELOCITY",
    maxYawRate: 2,
    maxHorizSpeed: 20,
    maxVertSpeed: 8,
    maxTiltAngle: Math.PI / 4,
    airDragFactor: 0.2,
    TILT_P: 15,
    TILT_D: 3,
    // Yaw gains stay at library defaults (6 / 4) — matches the demo.
    VERT_POS_P: 900,
    VERT_POS_D: 700,
    HORIZ_POS_P: 500,
    HORIZ_POS_D: 550,
    HORIZ_VEL_P: 1,
    VERT_VEL_P: 2,
  },
  propellers: [
    { position: { x: 1, y: -0.15, z: 1 }, maxThrust: 5000, torqueRatio: 0.6, invertTorque: true },
    { position: { x: -1, y: -0.15, z: 1 }, maxThrust: 5000, torqueRatio: 0.6, invertTorque: false },
    { position: { x: 1, y: -0.15, z: -1 }, maxThrust: 5000, torqueRatio: 0.6, invertTorque: false },
    { position: { x: -1, y: -0.15, z: -1 }, maxThrust: 5000, torqueRatio: 0.6, invertTorque: true },
  ],
  body: {
    cuboidHalfExtents: { x: 0.4, y: 0.2, z: 1.5 },
    armCylinders: {
      halfHeight: 0.05,
      radius: 0.65,
      positions: [
        { x: 1, y: -0.15, z: 1 },
        { x: 1, y: -0.15, z: -1 },
        { x: -1, y: -0.15, z: 1 },
        { x: -1, y: -0.15, z: -1 },
      ],
    },
    density: 200,
    approxMassKg: 298,
  },
  approxHoverThrottle: 0.146,
  notes:
    "The original demo drone, kept number-for-number: a ~298 kg lifter " +
    "(density 200, cuboid ~192 kg plus four ~26.5 kg arm discs). Hover sits " +
    "low at ~0.146 throttle, so it has huge climb reserve but less attitude " +
    "budget. Its VERT_POS_/HORIZ_POS_ hold gains are pre-scaled about x100 " +
    "over the library defaults because those gains are absolute forces that " +
    "grow with mass. Good for cargo craft and boss vehicles. Note the " +
    "airDragFactor 0.2 is nearly cosmetic at this mass.",
};

/**
 * All shipped drone presets by kebab-case name. Spread a preset's `config`
 * into DroneControllerOptions and build body/propellers from its recipes.
 */
export const dronePresets: Readonly<
  Record<"camera-drone" | "racing-drone" | "heavy-lifter", DronePreset>
> = {
  "camera-drone": cameraDrone,
  "racing-drone": racingDrone,
  "heavy-lifter": heavyLifter,
};
