// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TypeScript port of the ecctrl character controller (React/R3F removed).
// The "default" and "heavy-body-reference" values are upstream tuning
// (library defaults / demo leva settings); the other presets are Genex-authored.

import type { CharacterControllerOptions } from "./character-controller.ts";

/**
 * A named tuning set for the character controller.
 *
 * IMPORTANT: the float spring (`springK`/`dampingC`) and the auto-balance
 * springs scale roughly linearly with body mass, so every preset states the
 * collider `density` it was tuned for (`assumedDensity`, always mirrored into
 * `options.density`). If you change density or capsule size, scale those
 * spring constants in the same proportion.
 */
export interface CharacterPreset {
  /** Collider density the spring constants were tuned for. */
  assumedDensity: number;
  /** Plain-language description of the feel this preset gives. */
  description: string;
  /** Partial options — unset keys fall back to the library defaults. */
  options: CharacterControllerOptions;
}

/**
 * Ready-made character tunings. Spread into the controller options:
 *
 * ```ts
 * const character = new CharacterController(world, camera, {
 *   ...characterPresets["default"].options,
 *   userData: { controller: { excludeVehicleRay: true } },
 * });
 * ```
 *
 * Quick tuning map: "slippery" -> lower `slideGripFactor`; "floaty" -> lower
 * `fallingGravityScale`; "sluggish" -> raise `accDeltaTime`; "jumps too weak"
 * -> raise `jumpVel`; "tips over" -> raise `autoBalanceSpringK`.
 */
export const characterPresets: Readonly<
  Record<
    | "default"
    | "heavy-body-reference"
    | "platformer-snappy"
    | "souls-heavy"
    | "moon-bounce"
    | "ice-slide",
    CharacterPreset
  >
> = {
  /** Upstream library defaults — a balanced third-person feel at density 1. */
  "default": {
    assumedDensity: 1,
    description:
      "Balanced third-person feel (the library defaults). Walk 2 m/s, run 5 m/s, " +
      "decisive jump, moderate grip. Tuned for collider density 1.",
    options: {
      density: 1,
    },
  },

  /**
   * UPSTREAM PARITY — the source demo's tuned settings at density 200.
   * Every value below must match the upstream demo exactly; the float and
   * balance springs are ~80x stiffer because the body is ~200x heavier.
   */
  "heavy-body-reference": {
    assumedDensity: 200,
    description:
      "The upstream demo tuning: a heavy (density 200) body with proportionally " +
      "stiff float/balance springs. The reference for how spring constants scale " +
      "with mass — copy this ratio when you raise density.",
    options: {
      density: 200,
      capsuleHalfHeight: 0.3,
      capsuleRadius: 0.3,
      maxWalkVel: 1.1,
      maxRunVel: 5.5,
      jumpVel: 6,
      jumpDuration: 0.1,
      moveImpulsePointOffset: 0,
      slopeMaxAngle: 1,
      floatHeight: 0.3,
      rayOriginOffset: -0.35,
      rayHitForgiveness: 0.3,
      rayLength: 1.3,
      rayRadius: 0.15,
      springK: 6400,
      dampingC: 860,
      autoBalanceSpringK: 50,
      autoBalanceDampingC: 3,
      autoBalanceSpringOnY: 8,
      autoBalanceDampingOnY: 0.76,
    },
  },

  /** Genex-authored: fast accel/brake, decisive jumps, hold-to-run. */
  "platformer-snappy": {
    assumedDensity: 1,
    description:
      "Snappy platformer feel: quick starts and stops, strong jump with a heavy " +
      "fall, extra air control, high grip. Run is hold-to-run (no toggle). " +
      "Tuned for collider density 1.",
    options: {
      density: 1,
      maxWalkVel: 3,
      maxRunVel: 7,
      accDeltaTime: 0.35,
      decDeltaTime: 0.35,
      jumpVel: 7,
      fallingGravityScale: 4,
      airDragFactor: 0.3,
      slideGripFactor: 0.8,
      enableToggleRun: false,
    },
  },

  /** Genex-authored: weighty, committed movement. */
  "souls-heavy": {
    assumedDensity: 1,
    description:
      "Weighty, committed movement: slow to start and stop, low deliberate jump, " +
      "gentle fall, pronounced run lean. Tuned for collider density 1.",
    options: {
      density: 1,
      maxWalkVel: 1.6,
      maxRunVel: 4,
      accDeltaTime: 0.12,
      decDeltaTime: 0.15,
      jumpVel: 4.2,
      jumpDuration: 0.15,
      fallingGravityScale: 2.2,
      moveImpulsePointOffset: 0.6,
    },
  },

  /**
   * Genex-authored: long, floaty jumps. PAIR WITH LOW WORLD GRAVITY — set the
   * physics world gravity to `(0, -1.62, 0)` (the controller never changes
   * world gravity itself).
   */
  "moon-bounce": {
    assumedDensity: 1,
    description:
      "Low-gravity moonwalk: long floaty jumps and drifty air control. Pair with " +
      "world gravity (0, -1.62, 0) — the preset does not set world gravity for " +
      "you. Tuned for collider density 1.",
    options: {
      density: 1,
      jumpVel: 4,
      fallingGravityScale: 1,
      fallingMaxVel: 10,
      airDragFactor: 0.05,
    },
  },

  /** Genex-authored: near-zero grip, everything slides. */
  "ice-slide": {
    assumedDensity: 1,
    description:
      "Ice feel: near-zero grip, slow acceleration, barely any braking, and " +
      "sideways momentum is mostly kept — turns become wide slides. Tuned for " +
      "collider density 1.",
    options: {
      density: 1,
      slideGripFactor: 0.05,
      accDeltaTime: 0.08,
      decDeltaTime: 0.03,
      rejectVelFactor: 0.2,
    },
  },
};

/** Name of a shipped character preset. */
export type CharacterPresetName = keyof typeof characterPresets;
