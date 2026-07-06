// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TS port of the ecctrl character controller's keyboard layer (replaces drei
// KeyboardControls + the demo wrapper's key polling; React/zustand shells removed).
//
// Port notes / deliberate deviations from upstream:
// - NEW: window `blur` + `visibilitychange`(hidden) clear ALL keys — prevents stuck keys
//   after alt-tab (drei does not do this; upstream slept bodies on tab-hide instead).
// - NEW: `preventDefault` on handled keys defaults to true (stops Space scrolling the page).
// - `onInteract` is rising-edge + `event.repeat`-guarded, replacing the zustand
//   change-only subscription semantics upstream got for free.

/** Movement intent for the character. Field names match the controller's `MovementInput`, so
 *  `character.setMovement({ ...kb.getCharacterMovement(), joystick: { x, y } })` works verbatim. */
export interface CharacterMovementIntent {
  forward: boolean;
  backward: boolean;
  leftward: boolean;
  rightward: boolean;
  run: boolean;
  jump: boolean;
}

/** Movement intent for the car. Field names match the vehicle controller's `VehicleInput`. */
export interface CarMovementIntent {
  forward: boolean;
  backward: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  brake: boolean;
}

/** Movement intent for the drone. Field names match the drone controller's `DroneInput`.
 *  Deliberately asymmetric: WASD = throttle/yaw, arrows = pitch/roll (they are NOT aliases). */
export interface DroneMovementIntent {
  throttleUp: boolean;
  throttleDown: boolean;
  yawLeft: boolean;
  yawRight: boolean;
  pitchForward: boolean;
  pitchBackward: boolean;
  rollLeft: boolean;
  rollRight: boolean;
}

export interface KeyboardInputOptions {
  /** Event target; default `window` (a non-focusable element would never receive key events). */
  target?: Window | HTMLElement;
  /** Call `preventDefault()` on handled keys (stops Space scrolling the page). Default true. */
  preventDefault?: boolean;
}

type NamedKey =
  | "w"
  | "s"
  | "a"
  | "d"
  | "space"
  | "shift"
  | "f"
  | "up"
  | "down"
  | "left"
  | "right";

// Bindings ported from the upstream keyboard map: letters/arrows/space match by
// KeyboardEvent.code; Shift matches by event.key so ShiftLeft AND ShiftRight both work.
const CODE_BINDINGS: Readonly<Partial<Record<string, NamedKey>>> = {
  KeyW: "w",
  KeyS: "s",
  KeyA: "a",
  KeyD: "d",
  Space: "space",
  KeyF: "f",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};
const KEY_BINDINGS: Readonly<Partial<Record<string, NamedKey>>> = {
  Shift: "shift",
};

const ALL_NAMED_KEYS: readonly NamedKey[] = [
  "w",
  "s",
  "a",
  "d",
  "space",
  "shift",
  "f",
  "up",
  "down",
  "left",
  "right",
];

/**
 * Event-driven keyboard state: WASD/arrows/Space/Shift/F → movement intents.
 * Nothing to call per frame — read `getCharacterMovement()` (or the car/drone variants) once
 * per render frame and pass the result into the controller's `setMovement()`. Always send the
 * complete intent object: the controller merges defined fields, so a stale partial would leave
 * old `true`s behind.
 */
export class KeyboardInput {
  #keys: Record<NamedKey, boolean> = {
    w: false,
    s: false,
    a: false,
    d: false,
    space: false,
    shift: false,
    f: false,
    up: false,
    down: false,
    left: false,
    right: false,
  };

  #target: Window | HTMLElement;
  #preventDefault: boolean;
  #interactCallbacks = new Set<() => void>();
  #disposed = false;

  #onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    const named = CODE_BINDINGS[e.code] ?? KEY_BINDINGS[e.key];
    if (named === undefined) return;
    if (this.#preventDefault) e.preventDefault();
    const wasDown = this.#keys[named];
    this.#keys[named] = true;
    // Rising edge only, guarded against OS key auto-repeat.
    if (named === "f" && !e.repeat && !wasDown) {
      for (const callback of this.#interactCallbacks) callback();
    }
  };

  #onKeyUp = (event: Event): void => {
    const e = event as KeyboardEvent;
    const named = CODE_BINDINGS[e.code] ?? KEY_BINDINGS[e.key];
    if (named === undefined) return;
    this.#keys[named] = false;
  };

  #onBlur = (): void => {
    this.#clearAll();
  };

  #onVisibilityChange = (): void => {
    if (document.hidden) this.#clearAll();
  };

  constructor(options: KeyboardInputOptions = {}) {
    this.#target = options.target ?? window;
    this.#preventDefault = options.preventDefault ?? true;
    this.#target.addEventListener("keydown", this.#onKeyDown);
    this.#target.addEventListener("keyup", this.#onKeyUp);
    // NEW vs upstream: clear all keys when focus/visibility is lost (no stuck keys after alt-tab).
    window.addEventListener("blur", this.#onBlur);
    document.addEventListener("visibilitychange", this.#onVisibilityChange);
  }

  // ---- Raw named-key state (upstream keyboard-map names) ----

  get w(): boolean {
    return this.#keys.w;
  }
  get s(): boolean {
    return this.#keys.s;
  }
  get a(): boolean {
    return this.#keys.a;
  }
  get d(): boolean {
    return this.#keys.d;
  }
  get space(): boolean {
    return this.#keys.space;
  }
  get shift(): boolean {
    return this.#keys.shift;
  }
  get f(): boolean {
    return this.#keys.f;
  }
  get up(): boolean {
    return this.#keys.up;
  }
  get down(): boolean {
    return this.#keys.down;
  }
  get left(): boolean {
    return this.#keys.left;
  }
  get right(): boolean {
    return this.#keys.right;
  }

  /** True while any bound key is held (useful for waking a sleeping body). */
  get anyPressed(): boolean {
    for (const named of ALL_NAMED_KEYS) {
      if (this.#keys[named]) return true;
    }
    return false;
  }

  // ---- Derived intents (exact upstream wrapper mappings, touch terms merged by the caller) ----

  /** WASD or arrows to move, Shift to run, Space to jump. Merge touch input caller-side:
   *  `{ ...kb.getCharacterMovement(), run: kb.shift || btnRun.pressed, joystick: {...} }`. */
  getCharacterMovement(): CharacterMovementIntent {
    const k = this.#keys;
    return {
      forward: k.w || k.up,
      backward: k.s || k.down,
      leftward: k.a || k.left,
      rightward: k.d || k.right,
      run: k.shift,
      jump: k.space,
    };
  }

  /** WASD or arrows to drive/steer, Space to brake. */
  getCarMovement(): CarMovementIntent {
    const k = this.#keys;
    return {
      forward: k.w || k.up,
      backward: k.s || k.down,
      steerLeft: k.a || k.left,
      steerRight: k.d || k.right,
      brake: k.space,
    };
  }

  /** W/S throttle, A/D yaw, arrows pitch/roll. WASD and arrows are NOT aliases here — do not
   *  "unify" them; the asymmetry is the upstream control scheme. */
  getDroneMovement(): DroneMovementIntent {
    const k = this.#keys;
    return {
      throttleUp: k.w,
      throttleDown: k.s,
      yawLeft: k.a,
      yawRight: k.d,
      pitchForward: k.up,
      pitchBackward: k.down,
      rollLeft: k.left,
      rollRight: k.right,
    };
  }

  /**
   * Rising-edge interact hook (F key), auto-repeat-guarded — wire it to the enter/exit
   * manager: `kb.onInteract(() => mgr.requestInteract())`. Returns an unsubscribe function.
   */
  onInteract(callback: () => void): () => void {
    this.#interactCallbacks.add(callback);
    return () => {
      this.#interactCallbacks.delete(callback);
    };
  }

  /** Remove all listeners and clear state. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#target.removeEventListener("keydown", this.#onKeyDown);
    this.#target.removeEventListener("keyup", this.#onKeyUp);
    window.removeEventListener("blur", this.#onBlur);
    document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    this.#interactCallbacks.clear();
    this.#clearAll();
  }

  #clearAll(): void {
    for (const named of ALL_NAMED_KEYS) this.#keys[named] = false;
  }
}
