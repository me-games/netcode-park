// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TS port of the ecctrl character controller's animation layer (React/R3F/zustand shells removed).
//
// Port notes / deliberate deviations from upstream:
// - De-branding renames: `EcctrlAnimationState` -> `CharacterAnimationState`,
//   `resolveEcctrlAnimationState` -> `resolveAnimationState`, `EcctrlAnimationStateContext`
//   -> `AnimationStateContext` (the `handle` field is dropped so the resolver stays pure).
// - The zustand animation store + `EcctrlAnimationStateController` component + the demo's
//   `AnimatedCharacterModel` playback effect are folded into one `CharacterAnimations` class;
//   drei `useAnimations`'s implicit mixer tick becomes an explicit `mixer.update(dt)`.
// - Upstream reads `e.action._clip` (private API); this port uses `e.action.getClip().name`.
// - Upstream sets the store (crossfade via re-render) and THEN calls `onChange`; this port
//   applies the transition then fires `onChange` — same observable order. The transition
//   attempt (and the stuck-lock release checks) run every update, guarded and idempotent:
//   the non-React equivalent of upstream's playback effect re-running on `canPlayNext`
//   changes (this is what fades Jump_Loop/Idle_Loop in after a one-shot finishes).
// - `crossFadeFrom`'s `warp` argument is passed explicitly as `false` (upstream omits it), and
//   the crossfade is skipped (plain `.play()`) when no previous action is cached.
// - NEW (no upstream source): `buildClipMap` alias-based fuzzy clip lookup + hole-filling
//   chaining, and the procedural bob/lean fallback (PROC_* constants) for rig-less models.
// - NEW: the IDLE-bound action starts playing in the constructor (upstream leaves the rig in
//   bind pose until the first state change).
// - RUN's default clip is `Jog_Fwd_Loop` (the value the upstream demo actually runs);
//   `Sprint_Loop` is the second exact choice and also binds via alias.
// - The state controller's `enabled` prop and the `timeScale` RefObject variant are dropped in
//   favor of `setPaused(boolean)` / `setTimeScale(number)`.

import * as THREE from "three";

// ---------------------------------------------------------------------------
// State resolver (pure port)
// ---------------------------------------------------------------------------

/** The seven animation states the resolver can produce. */
export type CharacterAnimationState =
  | "IDLE"
  | "WALK"
  | "RUN"
  | "JUMP_START"
  | "JUMP_IDLE"
  | "JUMP_FALL"
  | "JUMP_LAND";

/**
 * The plain state snapshot the animation system consumes each frame.
 * Defined HERE, never imported from the controller — `CharacterController`'s readonly getters
 * satisfy it structurally, so you can pass the controller instance straight into `update()`.
 * Any object with these five booleans works (handy for networked remote players).
 */
export interface CharacterStateSnapshot {
  /** Ground contact within the float-ray forgiveness window. */
  readonly isOnGround: boolean;
  /** Airborne and moving downward (velocity·up < 0). */
  readonly isFalling: boolean;
  /** INPUT-based, not velocity-based: true while the player is steering the character. */
  readonly isMoving: boolean;
  /** Run key held (or toggled, when the controller uses toggle-run). */
  readonly runActive: boolean;
  /** True during the short jump window (default 0.1 s), not for the whole airborne arc. */
  readonly jumpActive: boolean;
}

/** Snapshot plus the previous frame's ground flag (derived internally by CharacterAnimations). */
export interface AnimationStateContext extends CharacterStateSnapshot {
  readonly wasOnGround: boolean;
}

/** Custom state-resolver signature — must stay a pure function over the context. */
export type AnimationStateResolver = (ctx: AnimationStateContext) => CharacterAnimationState;

/**
 * Pure animation-state resolver (exact upstream logic). Check order is load-bearing:
 * JUMP_START outranks everything (fires on the ground frame where the jump window opened);
 * JUMP_LAND outranks IDLE/WALK/RUN for exactly one evaluation after touchdown.
 */
export function resolveAnimationState(ctx: AnimationStateContext): CharacterAnimationState {
  const { isOnGround, wasOnGround, isFalling, isMoving, runActive, jumpActive } = ctx;

  if (jumpActive && wasOnGround) return "JUMP_START";

  if (isOnGround) {
    if (!wasOnGround) return "JUMP_LAND";
    if (!isMoving) return "IDLE";
    return runActive ? "RUN" : "WALK";
  }

  return isFalling ? "JUMP_FALL" : "JUMP_IDLE";
}

// ---------------------------------------------------------------------------
// Clip lookup (NEW — alias-based fuzzy binding so UAL, Mixamo-named, or arbitrary rigs work)
// ---------------------------------------------------------------------------

/** Resolved clip NAME per state; null = unbound (procedural fallback may take over). */
export type ClipMap = Record<CharacterAnimationState, string | null>;

const ALL_STATES: readonly CharacterAnimationState[] = [
  "IDLE",
  "WALK",
  "RUN",
  "JUMP_START",
  "JUMP_IDLE",
  "JUMP_FALL",
  "JUMP_LAND",
];

type ClipSearchSpec = {
  /** Quaternius Universal Animation Library names, tried first (exact, then case-insensitive). */
  exact: readonly string[];
  /** Case-insensitive substring aliases, in priority order. */
  aliases: readonly string[];
};

const CLIP_SEARCH: Record<CharacterAnimationState, ClipSearchSpec> = {
  IDLE: { exact: ["Idle_Loop"], aliases: ["idle", "stand", "breath"] },
  WALK: { exact: ["Walk_Loop"], aliases: ["walk"] },
  RUN: { exact: ["Jog_Fwd_Loop", "Sprint_Loop"], aliases: ["run", "jog", "sprint"] },
  // Only the LOOP jump states (JUMP_IDLE/JUMP_FALL) end with a bare "jump" alias (lowest priority
  // — the specific compound tokens above always win when present) so a rig whose only airborne clip
  // is named "Jump" / "Jumping" still animates mid-air instead of playing the ground loop.
  // The one-shot states (JUMP_START/JUMP_LAND) deliberately OMIT the bare "jump" alias: binding them
  // to a shared loop clip (e.g. "Jump_Loop") makes them one-shot-clamp that clip, freezing the rig on
  // its last frame through the whole airborne arc — the same reason the hole-filling below leaves
  // them null. Without a specific start/land clip they stay null and the previous loop keeps playing.
  JUMP_START: {
    exact: ["Jump_Start"],
    aliases: ["jump_start", "jumpstart", "jump start", "jump_up", "takeoff"],
  },
  JUMP_IDLE: { exact: ["Jump_Loop"], aliases: ["jump_loop", "jump_idle", "air", "fall", "jump"] },
  JUMP_FALL: { exact: ["Jump_Loop"], aliases: ["jump_loop", "fall", "falling", "air", "jump"] },
  JUMP_LAND: { exact: ["Jump_Land"], aliases: ["jump_land", "land"] },
};

/**
 * Bind animation clips to states by fuzzy name lookup.
 *
 * Per state, first match wins: explicit override (exact, then case-insensitive) → UAL exact
 * names → UAL case-insensitive → each alias as a case-insensitive SUBSTRING (shortest matching
 * clip name wins, so `Walk_Loop` beats `Walk_Bwd_Loop` and Mixamo's `walking` beats
 * `walking_backwards`). Afterwards LOOP-state holes are chained (RUN↔WALK, JUMP_IDLE↔JUMP_FALL)
 * so partially-animated rigs still move; one-shot states (JUMP_START/JUMP_LAND) stay null when
 * unbound so the previous loop keeps playing (upstream behavior) instead of clamping a loop clip.
 *
 * If your rig's names don't bind, pass `overrides` — e.g. `{ RUN: "MyFastRun" }`.
 */
export function buildClipMap(
  clips: THREE.AnimationClip[],
  overrides?: Partial<Record<CharacterAnimationState, string>>
): ClipMap {
  const names = clips.map((clip) => clip.name);
  const lowerNames = names.map((name) => name.toLowerCase());

  const findExact = (name: string): string | null => (names.includes(name) ? name : null);
  const findCiExact = (name: string): string | null => {
    const index = lowerNames.indexOf(name.toLowerCase());
    return index >= 0 ? names[index] : null;
  };

  const resolveClip = (state: CharacterAnimationState): string | null => {
    const override = overrides?.[state];
    if (override !== undefined) {
      const hit = findExact(override) ?? findCiExact(override);
      if (hit !== null) return hit;
      console.warn(
        `[CharacterAnimations] clip override "${override}" for state ${state} matches no clip; falling back to fuzzy lookup.`
      );
    }
    const spec = CLIP_SEARCH[state];
    for (const exactName of spec.exact) {
      const hit = findExact(exactName);
      if (hit !== null) return hit;
    }
    for (const exactName of spec.exact) {
      const hit = findCiExact(exactName);
      if (hit !== null) return hit;
    }
    for (const alias of spec.aliases) {
      let best: string | null = null;
      for (let i = 0; i < names.length; i++) {
        if (lowerNames[i].includes(alias) && (best === null || names[i].length < best.length)) {
          best = names[i];
        }
      }
      if (best !== null) return best;
    }
    return null;
  };

  const map: ClipMap = {
    IDLE: null,
    WALK: null,
    RUN: null,
    JUMP_START: null,
    JUMP_IDLE: null,
    JUMP_FALL: null,
    JUMP_LAND: null,
  };
  for (const state of ALL_STATES) map[state] = resolveClip(state);

  // Hole-filling chaining so partial rigs still animate — LOOP states only.
  // JUMP_START/JUMP_LAND are deliberately NOT hole-filled: they get one-shot playback
  // (LoopOnce + clampWhenFinished), and aliasing a loop clip (idle, fall) onto them would
  // freeze the rig in a clamped pose after every stop/landing. Left null they reproduce
  // upstream's missing-action early return: the previous loop keeps playing.
  if (map.RUN === null) map.RUN = map.WALK;
  if (map.WALK === null) map.WALK = map.RUN;
  if (map.JUMP_FALL === null) map.JUMP_FALL = map.JUMP_IDLE;
  if (map.JUMP_IDLE === null) map.JUMP_IDLE = map.JUMP_FALL;
  return map;
}

// ---------------------------------------------------------------------------
// Playback constants (upstream demo values)
// ---------------------------------------------------------------------------

/** One-shot (JUMP_START/JUMP_LAND) actions play sped up so they finish inside the hop. */
const ONE_SHOT_TIME_SCALE = 1.6;
/** Crossfade into a one-shot action, seconds (scaled by the effective mixer timeScale). */
const ONE_SHOT_FADE_DURATION = 0.1;
/** Crossfade between looping actions, seconds (scaled by the effective mixer timeScale). */
const LOOP_FADE_DURATION = 0.2;
/** Floor for the fade timeScale factor — prevents a zero-length fade while paused. */
const FADE_TIME_SCALE_FLOOR = 0.05;

// Procedural fallback constants (NEW — no upstream source). Tuning hints:
// raise the *_BOB_FREQ values for a more frantic gait, the *_BOB_AMP values for a bouncier
// one; *_LEAN tips the model forward while moving; PROC_SMOOTHING is the blend rate
// (higher = snappier transitions between offsets).
const PROC_WALK_BOB_FREQ = 8; // rad/s
const PROC_RUN_BOB_FREQ = 12; // rad/s
const PROC_WALK_BOB_AMP = 0.03; // m
const PROC_RUN_BOB_AMP = 0.05; // m
const PROC_WALK_LEAN = 0.06; // rad, forward-positive about local X
const PROC_RUN_LEAN = 0.12; // rad
const PROC_AIR_LEAN = -0.08; // rad
const PROC_LAND_DIP = 0.06; // m
const PROC_SMOOTHING = 10; // in k = 1 - exp(-PROC_SMOOTHING * dt)

// ---------------------------------------------------------------------------
// Mixer state machine
// ---------------------------------------------------------------------------

export interface CharacterAnimationsOptions {
  /** Per-state clip-name overrides; passed through to {@link buildClipMap}. */
  clipMap?: Partial<Record<CharacterAnimationState, string>>;
  /** Custom state resolver; default {@link resolveAnimationState}. */
  resolver?: AnimationStateResolver;
  /** Fired once per state CHANGE, after the transition is applied. Receives a context copy. */
  onChange?: (state: CharacterAnimationState, ctx: AnimationStateContext) => void;
  /**
   * "auto" (default): procedural bob/lean when no usable clips bind;
   * "procedural": force the procedural fallback even when clips exist;
   * "none": do nothing when unbound (model stays static).
   */
  fallback?: "auto" | "procedural" | "none";
}

/** Options for {@link CharacterAnimations.playOneShot}. */
export interface PlayOneShotOptions {
  /** Crossfade-in seconds from the current motion. Default 0.1. */
  fadeIn?: number;
  /** Playback speed. Default 1. */
  timeScale?: number;
  /** Clamp the final pose instead of returning to the loop. Default false. */
  clamp?: boolean;
  /** Fired when the clip finishes (skipped if a newer one-shot interrupts it). */
  onDone?: () => void;
}

type MutableAnimationStateContext = {
  -readonly [Key in keyof AnimationStateContext]: AnimationStateContext[Key];
};

/**
 * Animation state machine for the character: resolves a state from the controller's snapshot,
 * crossfades `THREE.AnimationMixer` actions (one-shot jump start/land, looping everything
 * else), and falls back to a procedural bob/lean for rig-less models.
 *
 * Call `update(controller, renderDelta)` once per render frame AFTER the physics stepping
 * loop — never inside it, and always with the render-clock delta (the mixer's own timeScale
 * handles pause/slow-motion).
 */
export class CharacterAnimations {
  /** Escape hatch for playing extra clips (e.g. `Sitting_Enter` on vehicle entry). */
  readonly mixer: THREE.AnimationMixer;

  #model: THREE.Object3D;
  #clipMap: ClipMap;
  #resolver: AnimationStateResolver;
  #onChange: ((state: CharacterAnimationState, ctx: AnimationStateContext) => void) | undefined;
  #actions = new Map<string, THREE.AnimationAction>();
  // Every provided clip by name — lets playOneShot reach clips beyond the 7
  // locomotion states (the full 46-clip UAL catalog: Punch_*, Sword_*, Sitting_*…).
  #clipsByName = new Map<string, THREE.AnimationClip>();
  #oneShotAction: THREE.AnimationAction | null = null;
  #oneShotOnDone: (() => void) | undefined;
  // When true, the active one-shot holds its final pose on finish (clamp:true —
  // e.g. Death01) instead of crossfading back to locomotion.
  #oneShotHoldPose = false;

  #state: CharacterAnimationState = "IDLE";
  #prevActionName: string | null;
  #canPlayNext = true;
  #initialized = false;
  #previousIsOnGround = false;
  #ctx: MutableAnimationStateContext;

  #timeScale = 1;
  #paused = false;
  #prevMixerTimeScale = -1;

  #usingProceduralFallback: boolean;
  #basePositionY: number;
  #baseRotationX: number;
  #procPhase = 0;
  #bobOffset = 0;
  #leanOffset = 0;

  #disposed = false;
  #onFinished: (event: { action: THREE.AnimationAction }) => void;

  /**
   * @param model root Object3D of the character visual (mixer root; also the transform target
   *              for the procedural fallback).
   * @param clips animation clips (e.g. `gltf.animations` from the bundled animation library, a
   *              Mixamo export, or `[]` — an empty array triggers the procedural fallback
   *              under the default `"auto"` mode).
   */
  constructor(
    model: THREE.Object3D,
    clips: THREE.AnimationClip[],
    options: CharacterAnimationsOptions = {}
  ) {
    this.#model = model;
    this.#clipMap = buildClipMap(clips, options.clipMap);
    this.#resolver = options.resolver ?? resolveAnimationState;
    this.#onChange = options.onChange;
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of clips) this.#clipsByName.set(clip.name, clip);

    // Cache one AnimationAction per bound clip so repeated lookups are free and
    // crossFadeFrom always finds the previous action still alive.
    const boundNames = new Set<string>();
    for (const state of ALL_STATES) {
      const name = this.#clipMap[state];
      if (name !== null) boundNames.add(name);
    }
    for (const clip of clips) {
      if (boundNames.has(clip.name) && !this.#actions.has(clip.name)) {
        this.#actions.set(clip.name, this.mixer.clipAction(clip));
      }
    }

    const fallback = options.fallback ?? "auto";
    const rigUnbound = this.#clipMap.IDLE === null && this.#clipMap.WALK === null;
    this.#usingProceduralFallback =
      fallback === "procedural" || (fallback === "auto" && rigUnbound);

    // Procedural fallback is additive over the transform captured here — never cumulative.
    this.#basePositionY = model.position.y;
    this.#baseRotationX = model.rotation.x;

    this.#prevActionName = this.#clipMap.IDLE;
    if (this.#prevActionName !== null) {
      // NEW vs upstream: start the idle clip immediately (upstream stayed in bind pose
      // until the first state change).
      this.#actions.get(this.#prevActionName)?.play();
    }

    this.#ctx = {
      isOnGround: false,
      wasOnGround: false,
      isFalling: false,
      isMoving: false,
      runActive: false,
      jumpActive: false,
    };

    this.#onFinished = (event) => {
      // One-shot (punch/gesture) finished.
      if (this.#oneShotAction && event.action === this.#oneShotAction) {
        const finished = this.#oneShotAction;
        const done = this.#oneShotOnDone;
        if (this.#oneShotHoldPose) {
          // clamp:true — keep the clamped final frame and stay locked until a
          // later playOneShot() (or an explicit change) replaces it.
          this.#oneShotOnDone = undefined;
          done?.();
          return;
        }
        // Default: hand control back to locomotion by crossfading the current
        // state's loop in FROM the just-finished one-shot, which is clamped on
        // its last frame (see playOneShot). Doing this here — in the same mixer
        // tick that fires "finished", from a still-posing clamped action —
        // is what prevents the one-frame unposed T-pose flash the old deferred
        // reset().play() left between finish and the next update.
        this.#oneShotAction = null;
        this.#oneShotOnDone = undefined;
        this.#canPlayNext = true;
        this.#recoverFromOneShot(finished);
        done?.();
        return;
      }
      const clipName = event.action.getClip().name;
      if (
        !this.#canPlayNext &&
        (clipName === this.#clipMap.JUMP_START || clipName === this.#clipMap.JUMP_LAND)
      ) {
        this.#canPlayNext = true;
      }
    };
    this.mixer.addEventListener("finished", this.#onFinished);
  }

  /** Current resolved animation state (starts `"IDLE"`). */
  get state(): CharacterAnimationState {
    return this.#state;
  }

  /** The resolved state→clip-name binding (for debugging; treat as read-only). */
  get clipMap(): ClipMap {
    return this.#clipMap;
  }

  /** True when the procedural bob/lean drives the model instead of animation clips. */
  get usingProceduralFallback(): boolean {
    return this.#usingProceduralFallback;
  }

  /**
   * Call once per render frame AFTER the physics stepping loop.
   * @param snapshot anything satisfying {@link CharacterStateSnapshot} — typically the
   *                 CharacterController instance itself.
   * @param dt RAW render-clock delta in seconds (do NOT pre-multiply by timeScale).
   */
  update(snapshot: CharacterStateSnapshot, dt: number): void {
    if (this.#disposed) return;

    const ctx = this.#ctx;
    ctx.isOnGround = snapshot.isOnGround;
    // First-ever frame uses the CURRENT value so a character that spawns grounded
    // does not fire JUMP_LAND.
    ctx.wasOnGround = this.#initialized ? this.#previousIsOnGround : snapshot.isOnGround;
    ctx.isFalling = snapshot.isFalling;
    ctx.isMoving = snapshot.isMoving;
    ctx.runActive = snapshot.runActive;
    ctx.jumpActive = snapshot.jumpActive;

    const next = this.#resolver(ctx);
    const stateChanged = next !== this.#state;
    if (stateChanged) this.#state = next;
    // Attempt the transition EVERY update, not only on state change — the non-React
    // equivalent of upstream's effect re-running on canPlayNext changes: after a one-shot
    // (Jump_Start/Jump_Land) finishes and unlocks, the pending loop clip must still fade in
    // even though the state did not change again. Internal guards make this a no-op otherwise.
    this.#applyTransition();
    if (stateChanged) {
      // Context copy: the live ctx object is reused every frame.
      this.#onChange?.(next, { ...ctx });
    }

    this.#previousIsOnGround = snapshot.isOnGround;
    this.#initialized = true;

    this.#releaseStuckLocks();

    if (this.#usingProceduralFallback) this.#updateProcedural(dt);

    const effectiveTimeScale = this.#paused ? 0 : this.#timeScale;
    if (this.#prevMixerTimeScale !== effectiveTimeScale) {
      this.mixer.timeScale = effectiveTimeScale;
      this.#prevMixerTimeScale = effectiveTimeScale;
    }
    // Raw render delta — mixer.timeScale does the scaling internally.
    this.mixer.update(dt);
  }

  /**
   * Global playback speed (default 1). Fade durations stretch with it, so slow-motion
   * transitions stay smooth instead of popping.
   */
  setTimeScale(timeScale: number): void {
    this.#timeScale = timeScale;
  }

  /** Paused ⇒ effective mixer timeScale 0 (state resolution keeps running). */
  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  /**
   * Play a full-body one-shot clip (punch, wave, pick-up, cast…) over the current
   * locomotion, then hand control back to the state machine when it finishes. Any
   * NON-locomotion clip from the set passed to the constructor works — see the
   * character-controller skill's 46-clip catalog (Punch_Jab/Cross, Sword_Attack,
   * Pistol_Shoot, Interact, Hit_Chest, …). Returns false if the clip name is unknown.
   *
   * @example
   * // punch on click:
   * addEventListener('pointerdown', () => anims.playOneShot('Punch_Jab'));
   */
  playOneShot(clipName: string, options: PlayOneShotOptions = {}): boolean {
    if (this.#disposed) return false;
    const clip = this.#clipsByName.get(clipName);
    if (!clip) return false;

    const action = this.mixer.clipAction(clip);

    // Crossfade the new one-shot FROM whatever is currently posing: a still-playing
    // previous one-shot (rapid re-punch) takes priority over the cached locomotion
    // action, so re-punching blends punch→punch instead of dipping toward bind pose.
    const prevOneShot =
      this.#oneShotAction && this.#oneShotAction !== action ? this.#oneShotAction : null;
    const current =
      prevOneShot ??
      (this.#prevActionName !== null ? this.#actions.get(this.#prevActionName) : undefined);

    action.enabled = true;
    action.setLoop(THREE.LoopOnce, 1);
    // ALWAYS clamp the final frame: the pose must be held from the "finished"
    // event until #recoverFromOneShot's crossfade takes over (or forever, when
    // clamp:true). With clampWhenFinished=false the action disables itself on
    // finish and the rig snaps to bind pose for a frame — the T-pose flash.
    action.clampWhenFinished = true;
    this.#oneShotHoldPose = options.clamp ?? false;
    action.timeScale = options.timeScale ?? 1;
    action.reset();
    if (current && current !== action) {
      action.crossFadeFrom(current, options.fadeIn ?? 0.1, false);
    }
    action.play();

    this.#oneShotAction = action;
    this.#oneShotOnDone = options.onDone;
    // Freeze the locomotion transition until the one-shot's 'finished' event
    // reopens it; marking the one-shot as the "current" action makes
    // #applyTransition a no-op meanwhile.
    this.#canPlayNext = false;
    this.#prevActionName = clipName;
    return true;
  }

  /** Stop all actions, uncache clips, remove the mixer's 'finished' listener. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.mixer.removeEventListener("finished", this.#onFinished);
    this.mixer.stopAllAction();
    for (const action of this.#actions.values()) {
      this.mixer.uncacheClip(action.getClip());
    }
    this.#actions.clear();
  }

  /**
   * Return to locomotion after a one-shot finishes: crossfade the current
   * state's loop in FROM the just-finished (still-posing, clamped) one-shot.
   * Called from the "finished" handler so the blend starts in the same tick —
   * no unposed frame. Falls back to a plain reset()/play() only when the finished
   * action can't be a fade source, and to prevActionName=null when the state has
   * no bound loop (procedural fallback / previous clip keeps the rig posed).
   */
  #recoverFromOneShot(finished: THREE.AnimationAction): void {
    const name = this.#clipMap[this.#state];
    const loopAction = name !== null ? this.#actions.get(name) : undefined;
    if (!loopAction) {
      this.#prevActionName = null;
      return;
    }
    const effectiveTimeScale = this.#paused ? 0 : this.#timeScale;
    const fade = LOOP_FADE_DURATION * Math.max(effectiveTimeScale, FADE_TIME_SCALE_FLOOR);
    loopAction.enabled = true;
    loopAction.timeScale = 1;
    loopAction.reset();
    if (loopAction !== finished) loopAction.crossFadeFrom(finished, fade, false);
    loopAction.play();
    this.#prevActionName = name;
  }

  /**
   * Crossfade into the clip bound to the current state. Runs every update (guards make it a
   * no-op unless the target clip differs and the one-shot lock is open) — mirrors upstream's
   * effect re-running on both state and canPlayNext changes.
   */
  #applyTransition(): void {
    const nextName = this.#clipMap[this.#state];
    // Unbound state: keep the previous action playing (upstream's `if (!nextAction) return`);
    // on a fully rig-less model the procedural fallback drives the transform instead.
    if (nextName === null) return;
    const nextAction = this.#actions.get(nextName);
    if (!nextAction) return;

    const effectiveTimeScale = this.#paused ? 0 : this.#timeScale;
    const getFadeDuration = (duration: number): number =>
      duration * Math.max(effectiveTimeScale, FADE_TIME_SCALE_FLOOR);

    const prevActionName = this.#prevActionName;
    // Only crossfade when switching to a NEW clip (JUMP_IDLE→JUMP_FALL share Jump_Loop —
    // comparing clip names, not states, keeps the loop from restarting mid-air).
    if (nextName !== prevActionName && this.#canPlayNext) {
      const prevAction =
        prevActionName !== null ? this.#actions.get(prevActionName) : undefined;

      // One-shot detection is by CLIP NAME, not state, so a shared clip inherits
      // one-shot behavior exactly like upstream's name-keyed actions.
      if (nextName === this.#clipMap.JUMP_START || nextName === this.#clipMap.JUMP_LAND) {
        this.#canPlayNext = false;
        nextAction.timeScale = ONE_SHOT_TIME_SCALE;
        nextAction.reset();
        if (prevAction) {
          nextAction.crossFadeFrom(prevAction, getFadeDuration(ONE_SHOT_FADE_DURATION), false);
        }
        nextAction.setLoop(THREE.LoopOnce, 1).play();
        nextAction.clampWhenFinished = true;
      } else {
        this.#canPlayNext = true;
        nextAction.timeScale = 1;
        nextAction.reset();
        if (prevAction) {
          nextAction.crossFadeFrom(prevAction, getFadeDuration(LOOP_FADE_DURATION), false);
        }
        nextAction.play();
      }

      this.#prevActionName = nextName;
    }
  }

  /**
   * Release the one-shot lock if the state moved past the one-shot's natural follow-up
   * (runs every update — the non-React equivalent of upstream's effect re-runs).
   */
  #releaseStuckLocks(): void {
    const prevActionName = this.#prevActionName;
    if (prevActionName === null) return;
    if (
      !this.#canPlayNext &&
      prevActionName === this.#clipMap.JUMP_START &&
      this.#state !== "JUMP_IDLE" &&
      this.#state !== "JUMP_START"
    ) {
      this.#canPlayNext = true;
    }
    if (
      !this.#canPlayNext &&
      prevActionName === this.#clipMap.JUMP_LAND &&
      this.#state !== "IDLE" &&
      this.#state !== "JUMP_LAND"
    ) {
      this.#canPlayNext = true;
    }
  }

  /** Procedural bob/lean for rig-less models — additive over the captured base transform. */
  #updateProcedural(dt: number): void {
    const state = this.#state;

    if (state === "WALK") this.#procPhase += PROC_WALK_BOB_FREQ * dt;
    else if (state === "RUN") this.#procPhase += PROC_RUN_BOB_FREQ * dt;

    let targetBob = 0;
    if (state === "WALK") targetBob = PROC_WALK_BOB_AMP * Math.abs(Math.sin(this.#procPhase));
    else if (state === "RUN") targetBob = PROC_RUN_BOB_AMP * Math.abs(Math.sin(this.#procPhase));
    else if (state === "JUMP_LAND") targetBob = -PROC_LAND_DIP;

    let targetLean = 0;
    if (state === "WALK") targetLean = PROC_WALK_LEAN;
    else if (state === "RUN") targetLean = PROC_RUN_LEAN;
    else if (state === "JUMP_START" || state === "JUMP_IDLE" || state === "JUMP_FALL") {
      targetLean = PROC_AIR_LEAN;
    }

    // Frame-rate-independent smoothing (same idiom as the controller's gravityDirLerpSpeed).
    const k = 1 - Math.exp(-PROC_SMOOTHING * dt);
    this.#bobOffset += (targetBob - this.#bobOffset) * k;
    this.#leanOffset += (targetLean - this.#leanOffset) * k;

    this.#model.position.y = this.#basePositionY + this.#bobOffset;
    this.#model.rotation.x = this.#baseRotationX + this.#leanOffset;
  }
}
