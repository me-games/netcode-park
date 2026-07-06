// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TS port of the ecctrl controller's vehicle enter/exit example
// pattern (EcctrlWrapper): proximity sensors, key prompt, control + camera
// handoff between the on-foot character and registered vehicles, and exit
// placement beside the vehicle. Upstream keeps this logic as React demo glue
// (zustand store + useCallbacks + JSX sensor colliders); this port folds it
// into one reusable manager class. Deliberate renames from upstream:
// collider-name match "character-capsule-collider" -> collider HANDLE
// equality; store value "ecctrl" -> CHARACTER_ID = "character"; the store's
// typo'd `ContorlType` union is replaced by plain string ids.

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

/** Well-known id for the on-foot character unit. */
export const CHARACTER_ID = "character";

/**
 * What the follow camera needs from whichever unit is in control. Mirrors
 * the subset of the upstream imperative handles read by the demo wrapper.
 * All getters return live, internally-reused THREE objects — treat them as
 * read-only and `.copy()` if you need to keep a value across frames.
 */
export interface FollowTargetLike {
  /** Body world position. */
  readonly currPos: THREE.Vector3;
  /** Body-frame up axis (world space). */
  readonly bodyYAxis: THREE.Vector3;
  /** Gravity-aligned up axis (world space). */
  readonly upAxis: THREE.Vector3;
}

/**
 * The character controller as seen by this module. Implemented by
 * `character/character-controller.ts`; enter-exit only knows this interface.
 */
export interface CharacterUnitLike extends FollowTargetLike {
  /**
   * The capsule collider — used to recognize the character in sensor events.
   * Upstream matched by collider NAME ("character-capsule-collider"); the
   * port matches by collider handle instead (raw Rapier colliders are
   * nameless).
   */
  readonly collider: RAPIER.Collider;
  /**
   * Hide + disable physics. Port equivalent of the upstream React unmount of
   * the character component while driving. Must disable the rigid body AND
   * collider, hide the visual group, and zero input.
   */
  park(): void;
  /**
   * Teleport to (position, rotation) — the Euler uses order "YXZ" — zero
   * linear/angular velocity, re-enable body and collider, show visuals.
   * Port equivalent of remounting the character at a respawn transform.
   */
  unpark(position: THREE.Vector3, rotation: THREE.Euler): void;
}

/**
 * A drivable/flyable unit. Satisfied structurally by both
 * `vehicle/vehicle-controller.ts` and `drone/drone-controller.ts`.
 */
export interface VehicleUnitLike extends FollowTargetLike {
  /** Chassis rigid body — the proximity sensor collider attaches to it. */
  readonly body: RAPIER.RigidBody;
  /** World-space body X axis (live vector). */
  readonly bodyXAxis: THREE.Vector3;
  /** World-space body Z axis (live vector). */
  readonly bodyZAxis: THREE.Vector3;
}

/**
 * Which live vehicle axis the character is placed along on exit.
 * Cars step out sideways ("bodyX"); a drone drops the pilot off along its
 * up axis ("up"). Evaluated at the moment of exit, never cached.
 */
export type ExitAxis = "bodyX" | "bodyZ" | "up";

/**
 * Proximity sensor shape, created by the manager and attached to
 * `vehicle.body`. Offsets are body-local. Bigger radius = the "Press F"
 * prompt appears from farther away.
 */
export type VehicleSensorShape =
  | {
      kind: "cylinder";
      halfHeight: number;
      radius: number;
      offset?: { x: number; y: number; z: number };
    }
  | { kind: "ball"; radius: number; offset?: { x: number; y: number; z: number } };

/** One vehicle the character can enter. */
export interface VehicleRegistration {
  /** Unique id, e.g. "car", "drone". Must not equal CHARACTER_ID. */
  id: string;
  /** Prompt text shown to the player, e.g. "Car", "Drone". */
  label: string;
  vehicle: VehicleUnitLike;
  /**
   * Default: cylinder halfHeight 0.4, radius 1.5, offset (0, 0.1, 0) — the
   * upstream car sensor. Use `{ kind: "ball", radius: 1 }` for a drone.
   * Tuning hint: the upstream demo's second car uses cylinder 0.3/1.5 with
   * no offset; radius is the knob that matters for prompt range.
   */
  sensor?: VehicleSensorShape;
  /**
   * Direction the character is placed on exit, from LIVE vehicle axes at
   * exit time. Cars: "bodyX" (default); drone: "up".
   */
  exitAxis?: ExitAxis;
  /**
   * Distance along `exitAxis` from the vehicle center. Default 1.5 (equals
   * the default sensor radius, so immediate re-entry stays possible —
   * intended, matches upstream). Raise it if the character spawns inside
   * wide chassis geometry.
   */
  exitLength?: number;
  /**
   * Per-frame input routing while this vehicle is active. The game builds
   * the concrete input object (keyboard/joystick modules) inside this
   * callback, e.g. `() => car.setMovement(kb.getCarMovement())`.
   */
  applyInput?: (dt: number) => void;
  /**
   * Handoff hooks. The drone registers `onOccupantEnter` to switch to
   * VELOCITY control mode, and `onOccupantExit` to capture a hold target
   * (`setTarget(currPos, bodyZAxis)`) then switch to POSITION mode.
   * `onOccupantExit` fires BEFORE the character is unparked. Also the seam
   * where game code plays Sitting_Enter / Driving_Loop / Sitting_Exit clips
   * (new design — upstream unmounts the character instead of animating it).
   */
  onOccupantEnter?: () => void;
  onOccupantExit?: () => void;
}

/** Current key-prompt target (which vehicle "Press F" would enter). */
export interface PromptTarget {
  id: string;
  label: string;
}

export interface EnterExitOptions {
  world: RAPIER.World;
  character: CharacterUnitLike;
  /**
   * Per-frame input routing while on foot, e.g.
   * `() => character.setMovement(kb.getCharacterMovement())`.
   */
  applyCharacterInput?: (dt: number) => void;
  /**
   * Fires whenever the key-prompt target changes (including -> null).
   * Drive your DOM prompt element from here.
   */
  onPromptChange?: (target: PromptTarget | null) => void;
  /** Fires after control switches. fromId/toId are CHARACTER_ID or vehicle ids. */
  onHandoff?: (fromId: string, toId: string) => void;
}

// --- Named constant table (upstream demo values) -------------------------
// Default proximity sensor: the upstream car sensor (cylinder, mass 0 so it
// never shifts the chassis center of mass).
const DEFAULT_SENSOR: VehicleSensorShape = {
  kind: "cylinder",
  halfHeight: 0.4,
  radius: 1.5,
  offset: { x: 0, y: 0.1, z: 0 },
};
// Distance the character is placed from the vehicle center on exit.
const DEFAULT_EXIT_LENGTH = 1.5;
// Default exit direction (cars step out along body X).
const DEFAULT_EXIT_AXIS: ExitAxis = "bodyX";
// Camera aim point sits this far above the body center, along bodyYAxis.
const CAMERA_TARGET_LIFT = 0.5;

interface VehicleRecord {
  reg: VehicleRegistration;
  sensorCollider: RAPIER.Collider;
  /** Character is inside this vehicle's proximity sensor. */
  inRange: boolean;
}

/**
 * Manages the character <-> vehicle enter/exit flow:
 *
 * - Creates one sensor collider per registered vehicle and tracks whether
 *   the character capsule is inside it.
 * - Surfaces a key prompt (`onPromptChange`) for the nearest eligible
 *   vehicle (registration order = prompt priority, first match wins).
 * - On `requestInteract()`: parks the character and hands control to the
 *   vehicle, or places the character beside the vehicle and hands control
 *   back.
 * - Exposes `cameraTarget` / `cameraUp` / `activeVehicle` for the follow
 *   camera, and routes device input to whichever unit is in control.
 *
 * Loop contract (per fixed physics substep): call `update(dt)` FIRST, then
 * the character/vehicle controllers' own `update()`, then `world.step()`.
 * After stepping, feed drained collision events into
 * `handleIntersectionEvent` — proximity therefore lags input by at most one
 * frame, exactly as upstream.
 */
export class EnterExitManager {
  private world: RAPIER.World;
  private character: CharacterUnitLike;
  private applyCharacterInput?: (dt: number) => void;
  private onPromptChange?: (target: PromptTarget | null) => void;
  private onHandoff?: (fromId: string, toId: string) => void;

  /** Registration order = prompt priority. */
  private records: VehicleRecord[] = [];
  private activeId: string = CHARACTER_ID;
  private prompt: PromptTarget | null = null;
  /** One-shot interact latch, consumed at the start of the next update(). */
  private interactRequested = false;

  // Camera feed (reused instances — consumers copy, never mutate).
  // Upstream initializes both to (0,0,0); the port starts cameraUp at
  // (0,1,0) so the up vector is never degenerate before the first update
  // (deliberate, documented deviation).
  private cameraTargetV = new THREE.Vector3();
  private cameraUpV = new THREE.Vector3(0, 1, 0);

  // Preallocated exit-transform scratch (upstream: five refs).
  private exitPos = new THREE.Vector3();
  private exitRot = new THREE.Euler();
  private exitZAxis = new THREE.Vector3();
  private exitXAxis = new THREE.Vector3();
  private exitMatrix = new THREE.Matrix4();

  constructor(opts: EnterExitOptions) {
    this.world = opts.world;
    this.character = opts.character;
    this.applyCharacterInput = opts.applyCharacterInput;
    this.onPromptChange = opts.onPromptChange;
    this.onHandoff = opts.onHandoff;
  }

  /**
   * Creates the sensor collider on `reg.vehicle.body` and starts tracking.
   * Call after the vehicle's rigid body exists. Registration ORDER = prompt
   * priority (first registered wins when sensors overlap).
   */
  registerVehicle(reg: VehicleRegistration): void {
    if (reg.id === CHARACTER_ID) {
      throw new Error(`EnterExitManager: vehicle id "${CHARACTER_ID}" is reserved`);
    }
    if (this.records.some((r) => r.reg.id === reg.id)) {
      throw new Error(`EnterExitManager: duplicate vehicle id "${reg.id}"`);
    }

    const shape = reg.sensor ?? DEFAULT_SENSOR;
    const desc =
      shape.kind === "cylinder"
        ? RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius)
        : RAPIER.ColliderDesc.ball(shape.radius);
    desc.setSensor(true);
    // mass 0: the sensor must never shift the chassis mass properties —
    // that would break car/drone tuning parity.
    desc.setMass(0);
    if (shape.offset) desc.setTranslation(shape.offset.x, shape.offset.y, shape.offset.z);
    // Raw Rapier needs the explicit opt-in (@react-three/rapier set this
    // implicitly when intersection handlers existed). Without it, sensor
    // events silently never fire.
    desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    const sensorCollider = this.world.createCollider(desc, reg.vehicle.body);
    this.records.push({ reg, sensorCollider, inRange: false });
  }

  /** Removes the sensor collider and forgets the vehicle. */
  unregisterVehicle(id: string): void {
    const index = this.records.findIndex((r) => r.reg.id === id);
    if (index < 0) return;
    const [record] = this.records.splice(index, 1);
    this.world.removeCollider(record.sensorCollider, false);
    this.refreshPrompt();
  }

  /**
   * Edge-triggered interact request (F key rising edge / virtual button
   * press). Latched and consumed at the START of the next `update(dt)`;
   * multiple calls within one frame collapse into one request. Wire this to
   * a key TRANSITION, not level — polling a held key here would enter and
   * exit every frame.
   */
  requestInteract(): void {
    this.interactRequested = true;
  }

  /**
   * Feed Rapier collision events here, e.g. from the shared physics-world
   * drain: `eventQueue.drainCollisionEvents((h1, h2, started) =>
   * mgr.handleIntersectionEvent(h1, h2, started))`. Runs AFTER
   * `world.step()`; effects are consumed by the NEXT frame's `update()`.
   */
  handleIntersectionEvent(handle1: number, handle2: number, started: boolean): void {
    const charHandle = this.character.collider.handle;
    for (const record of this.records) {
      const sensorHandle = record.sensorCollider.handle;
      if (
        (handle1 === sensorHandle && handle2 === charHandle) ||
        (handle2 === sensorHandle && handle1 === charHandle)
      ) {
        record.inRange = started;
        this.refreshPrompt();
      }
      // Any event not matching a (sensor, character-capsule) pair is
      // ignored — this replaces the upstream collider-name check.
    }
  }

  /**
   * Per-frame logic. MUST run each physics frame BEFORE the active
   * controller's `update(dt)`, which itself runs before `world.step()`.
   * Consumes a pending interact request, refreshes the camera target/up,
   * and routes input to the active unit. This module does no integration —
   * `dt` is only forwarded to the `applyInput` callbacks.
   */
  update(dt: number): void {
    // 1. Consume interact request.
    if (this.interactRequested) {
      this.interactRequested = false;
      this.performInteract();
    }

    // 2. Camera target/up.
    if (this.activeId === CHARACTER_ID) {
      // Guard: skip the copy while the character position is still all-zero
      // (pre-physics); keep previous values, matching upstream.
      if (this.character.currPos.lengthSq() > 0) {
        this.cameraTargetV
          .copy(this.character.currPos)
          .addScaledVector(this.character.bodyYAxis, CAMERA_TARGET_LIFT);
        this.cameraUpV.copy(this.character.upAxis);
      }
    } else {
      const record = this.activeRecord();
      if (record) {
        const v = record.reg.vehicle;
        this.cameraTargetV.copy(v.currPos).addScaledVector(v.bodyYAxis, CAMERA_TARGET_LIFT);
        this.cameraUpV.copy(v.upAxis);
      } else {
        // Defensive branch (unreachable in practice): no active unit.
        this.cameraTargetV.set(0, 0, 0);
        this.cameraUpV.set(0, 1, 0);
      }
    }

    // 3. Route input to whichever unit is in control.
    if (this.activeId === CHARACTER_ID) {
      this.applyCharacterInput?.(dt);
    } else {
      this.activeRecord()?.reg.applyInput?.(dt);
    }
  }

  /** Which unit has control: CHARACTER_ID or a registered vehicle id. */
  get activeControllerId(): string {
    return this.activeId;
  }

  /** The unit in control (character or vehicle) as a camera target. */
  get activeUnit(): FollowTargetLike {
    const record = this.activeRecord();
    return record ? record.reg.vehicle : this.character;
  }

  /**
   * The active vehicle, or null when on foot — lets camera glue do the
   * vehicle-heading alignment via `activeVehicle.bodyZAxis`.
   */
  get activeVehicle(): VehicleUnitLike | null {
    return this.activeRecord()?.reg.vehicle ?? null;
  }

  /**
   * `activeUnit.currPos + activeUnit.bodyYAxis * 0.5`, recomputed in
   * `update()`. Reused internal vector — copy, do not mutate.
   */
  get cameraTarget(): THREE.Vector3 {
    return this.cameraTargetV;
  }

  /**
   * Copy of `activeUnit.upAxis`. The follow camera lerps `camera.up`
   * toward this each frame (that lerp lives in follow-camera, not here).
   * Reused internal vector — copy, do not mutate.
   */
  get cameraUp(): THREE.Vector3 {
    return this.cameraUpV;
  }

  /** Current prompt target, or null when nothing is in range. */
  get promptTarget(): PromptTarget | null {
    return this.prompt;
  }

  /** Removes all sensor colliders; the manager becomes inert. */
  dispose(): void {
    for (const record of this.records) {
      this.world.removeCollider(record.sensorCollider, false);
    }
    this.records = [];
    this.setPrompt(null);
  }

  // --- private -----------------------------------------------------------

  private activeRecord(): VehicleRecord | null {
    if (this.activeId === CHARACTER_ID) return null;
    return this.records.find((r) => r.reg.id === this.activeId) ?? null;
  }

  /** Fires onPromptChange only when the target actually changes. */
  private setPrompt(next: PromptTarget | null): void {
    const prev = this.prompt;
    const changed =
      (prev === null) !== (next === null) ||
      (prev !== null && next !== null && prev.id !== next.id);
    this.prompt = next;
    if (changed) this.onPromptChange?.(next);
  }

  /** Port of the upstream `updateVehicleAccessTarget` callback. */
  private refreshPrompt(): void {
    if (this.activeId !== CHARACTER_ID) {
      this.setPrompt(null);
      return;
    }
    const first = this.records.find((r) => r.inRange);
    this.setPrompt(first ? { id: first.reg.id, label: first.reg.label } : null);
  }

  /** Port of the upstream `handleVehicleAccess` callback. */
  private performInteract(): void {
    // ENTERING a vehicle.
    if (this.activeId === CHARACTER_ID) {
      const record = this.records.find((r) => r.inRange);
      if (!record) return;
      record.inRange = false;
      this.character.park();
      // Port adaptation: upstream unmounted the character, which REMOVED
      // the capsule collider and made Rapier emit intersection-exit events
      // for every sensor. A disable-based park does not guarantee those
      // `stopped` events across Rapier versions, so clear every in-range
      // flag locally. Do NOT remove this even if events appear to fire.
      for (const r of this.records) r.inRange = false;
      this.activeId = record.reg.id;
      this.setPrompt(null);
      record.reg.onOccupantEnter?.();
      this.onHandoff?.(CHARACTER_ID, record.reg.id);
      return;
    }

    // EXITING the active vehicle.
    const record = this.activeRecord();
    if (!record) return;
    const vehicle = record.reg.vehicle;
    const exitAxis = record.reg.exitAxis ?? DEFAULT_EXIT_AXIS;
    // Live axes, read at the moment of exit — never cached at registration.
    const exitDir =
      exitAxis === "bodyX"
        ? vehicle.bodyXAxis
        : exitAxis === "up"
          ? vehicle.upAxis
          : vehicle.bodyZAxis;
    this.computeExitTransform(vehicle, exitDir, record.reg.exitLength ?? DEFAULT_EXIT_LENGTH);
    // onOccupantExit BEFORE unparking: the drone must capture its hold
    // target (currPos/bodyZAxis) before anything else moves.
    record.reg.onOccupantExit?.();
    this.character.unpark(this.exitPos, this.exitRot);
    this.activeId = CHARACTER_ID;
    this.setPrompt(null);
    this.onHandoff?.(record.reg.id, CHARACTER_ID);
  }

  /**
   * Port of the upstream `computeExitTransform` — exact math and order.
   * Writes `this.exitPos` / `this.exitRot`.
   *
   * Faithful non-guard: if the vehicle is flipped so bodyZAxis is parallel
   * to upAxis, projectOnPlane yields a near-zero vector and normalize()
   * produces NaN — upstream does not guard this either (realistic trigger:
   * exiting a nose-down drone along its up axis).
   */
  private computeExitTransform(
    vehicle: VehicleUnitLike,
    exitDirection: THREE.Vector3,
    exitLength: number,
  ): void {
    this.exitPos.copy(vehicle.currPos).addScaledVector(exitDirection, exitLength);
    const up = vehicle.upAxis;
    this.exitZAxis.copy(vehicle.bodyZAxis).projectOnPlane(up).normalize();
    // Cross order matters: X = up x Z. Swapping mirrors the spawn basis.
    this.exitXAxis.crossVectors(up, this.exitZAxis);
    // makeBasis takes COLUMN vectors X, Y, Z.
    this.exitMatrix.makeBasis(this.exitXAxis, up, this.exitZAxis);
    // Euler order "YXZ" — the character's unpark() interprets it the same way.
    this.exitRot.setFromRotationMatrix(this.exitMatrix, "YXZ");
  }
}
