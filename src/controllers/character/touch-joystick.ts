// SPDX-FileCopyrightText: 2023-2026 Erdong Chen
// SPDX-License-Identifier: MIT
// Vanilla-TS port of the ecctrl controller's touch input (Joystick + VirtualButton DOM/CSS
// widgets; React/zustand shells removed — per-instance state + callbacks instead of stores).
//
// Port notes / deliberate deviations from upstream:
// - NEW: `setPointerCapture` on pointerdown keeps drags alive outside the 200px wrapper
//   (upstream relied on `pointerleave` alone; that reset path is kept for parity when
//   capture is unavailable).
// - `VirtualButton.dispose()` resets only ITS OWN state (upstream unmount reset ALL buttons).
// - Upstream's hard-coded duplicate DOM ids (joystick/base/knob/button/cap) are dropped;
//   instances are the identity now.
// - The zustand store keys (`id` props) are gone — create one instance per stick/button.

// ---------------------------------------------------------------------------
// Shared style plumbing
// ---------------------------------------------------------------------------

function applyStyle(
  element: HTMLElement,
  base: Partial<CSSStyleDeclaration>,
  override?: Partial<CSSStyleDeclaration>
): void {
  Object.assign(element.style, base);
  if (override) Object.assign(element.style, override);
}

/** Legacy vendor prefixes upstream shipped via React CSSProperties (Moz/ms). */
function applyLegacyUserSelectNone(element: HTMLElement): void {
  element.style.setProperty("-moz-user-select", "none");
  element.style.setProperty("-ms-user-select", "none");
}

// ---------------------------------------------------------------------------
// TouchJoystick
// ---------------------------------------------------------------------------

// Default styles for the joystick wrapper (the 200px interactive hit area).
// NOTE: upstream ships NO position (left/bottom commented out) — position via wrapperStyle.
const DEFAULT_JOYSTICK_WRAPPER_STYLE: Partial<CSSStyleDeclaration> = {
  userSelect: "none",
  webkitUserSelect: "none",
  touchAction: "none",
  overscrollBehavior: "none",
  position: "fixed",
  zIndex: "10",
  height: "200px",
  width: "200px",
  borderRadius: "50%",
};

// Default styles for the joystick base (the 100px reference circle — center math uses THIS).
const DEFAULT_JOYSTICK_BASE_STYLE: Partial<CSSStyleDeclaration> = {
  width: "100px",
  height: "100px",
  background: "rgba(0, 0, 0, 0.1)",
  border: "2px solid white",
  borderRadius: "50%",
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  touchAction: "none",
};

// Default styles for the joystick knob. The cubic-bezier transition IS the spring-back:
// the state snaps to 0 instantly on release while the knob overshoots home in CSS.
const DEFAULT_JOYSTICK_KNOB_STYLE: Partial<CSSStyleDeclaration> = {
  width: "70px",
  height: "70px",
  background: "rgba(255, 255, 255, 0.8)",
  borderRadius: "50%",
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  transition: "transform 0.2s cubic-bezier(0.25, 1.5, 0.5, 1)",
  willChange: "transform",
  pointerEvents: "none",
};

export interface TouchJoystickOptions {
  /** DOM parent; default `document.body`. */
  parent?: HTMLElement;
  /** Max knob travel in px; default 50. Larger = more finger travel for full deflection. */
  maxRadius?: number;
  /**
   * Style overrides merged over the defaults. Positioning (`left`/`bottom`/`right`) MUST come
   * through here — no default position ships; e.g. `{ left: "0", bottom: "0" }` for a
   * bottom-left movement stick.
   */
  wrapperStyle?: Partial<CSSStyleDeclaration>;
  baseStyle?: Partial<CSSStyleDeclaration>;
  knobStyle?: Partial<CSSStyleDeclaration>;
  /** Optional change hook: fires on every move/reset with the new state. */
  onChange?: (x: number, y: number, active: boolean) => void;
}

/**
 * DOM+CSS touch joystick. Read `x`/`y` each render frame and pass them into the character
 * controller: `setMovement({ ...kb.getCharacterMovement(), joystick: { x: joy.x, y: joy.y } })`.
 * A nonzero joystick overrides the digital keys inside the controller — pass both through and
 * let it pick. Note the controller normalizes direction, so deflection magnitude is not speed.
 */
export class TouchJoystick {
  #maxRadius: number;
  #wrapper: HTMLDivElement;
  #base: HTMLDivElement;
  #knob: HTMLDivElement;
  #x = 0;
  #y = 0;
  #active = false;
  /** Pointer-drag latch — distinct from the public `active` (deflection ≠ 0) flag. */
  #pointerActive = false;
  #onChange: ((x: number, y: number, active: boolean) => void) | undefined;
  #disposed = false;

  #onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  #onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.#move(event.clientX, event.clientY);
    this.#pointerActive = true;
    // NEW vs upstream: capture keeps the drag working outside the 200px wrapper.
    if (typeof this.#wrapper.setPointerCapture === "function") {
      try {
        this.#wrapper.setPointerCapture(event.pointerId);
      } catch {
        // pointer already gone — the pointerleave reset path still covers us
      }
    }
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (this.#pointerActive) this.#move(event.clientX, event.clientY);
  };

  #onPointerEnd = (): void => {
    this.#reset();
  };

  constructor(options: TouchJoystickOptions = {}) {
    this.#maxRadius = options.maxRadius ?? 50;
    this.#onChange = options.onChange;

    this.#wrapper = document.createElement("div");
    applyStyle(this.#wrapper, DEFAULT_JOYSTICK_WRAPPER_STYLE, options.wrapperStyle);
    applyLegacyUserSelectNone(this.#wrapper);

    this.#base = document.createElement("div");
    applyStyle(this.#base, DEFAULT_JOYSTICK_BASE_STYLE, options.baseStyle);
    this.#wrapper.appendChild(this.#base);

    this.#knob = document.createElement("div");
    applyStyle(this.#knob, DEFAULT_JOYSTICK_KNOB_STYLE, options.knobStyle);
    this.#base.appendChild(this.#knob);

    this.#wrapper.addEventListener("contextmenu", this.#onContextMenu);
    this.#wrapper.addEventListener("pointerdown", this.#onPointerDown);
    this.#wrapper.addEventListener("pointermove", this.#onPointerMove);
    this.#wrapper.addEventListener("pointerup", this.#onPointerEnd);
    this.#wrapper.addEventListener("pointerleave", this.#onPointerEnd);

    (options.parent ?? document.body).appendChild(this.#wrapper);
  }

  /** Normalized horizontal deflection in [-1, 1] (right-positive). */
  get x(): number {
    return this.#x;
  }

  /** Normalized vertical deflection in [-1, 1], UP-positive (screen dy is negated once here). */
  get y(): number {
    return this.#y;
  }

  /** True iff (x, y) !== (0, 0). */
  get active(): boolean {
    return this.#active;
  }

  /** The wrapper element (for ad-hoc styling / conditional display). */
  get element(): HTMLDivElement {
    return this.#wrapper;
  }

  /** Show/hide helper — e.g. show only when `navigator.maxTouchPoints > 0`. */
  setVisible(visible: boolean): void {
    this.#wrapper.style.display = visible ? "" : "none";
  }

  /** Reset state + remove DOM + listeners. Safe to call mid-drag. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#reset();
    this.#wrapper.removeEventListener("contextmenu", this.#onContextMenu);
    this.#wrapper.removeEventListener("pointerdown", this.#onPointerDown);
    this.#wrapper.removeEventListener("pointermove", this.#onPointerMove);
    this.#wrapper.removeEventListener("pointerup", this.#onPointerEnd);
    this.#wrapper.removeEventListener("pointerleave", this.#onPointerEnd);
    this.#wrapper.remove();
  }

  #move(clientX: number, clientY: number): void {
    // Center math uses the BASE rect (100px reference circle), not the 200px wrapper.
    const rect = this.#base.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    let dx = clientX - centerX;
    let dy = clientY - centerY;
    const distance = Math.hypot(dx, dy);
    // If the distance exceeds the maximum radius, scale down the movement.
    if (distance > this.#maxRadius) {
      dx *= this.#maxRadius / distance;
      dy *= this.#maxRadius / distance;
    }

    // The -50% self-centering and the pixel offset ride in ONE translate — replacing this
    // with left/top would break the CSS spring-back.
    this.#knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    this.#x = dx / this.#maxRadius;
    this.#y = -dy / this.#maxRadius; // screen-down-positive dy → game-forward-positive y
    this.#active = !(this.#x === 0 && this.#y === 0);
    this.#onChange?.(this.#x, this.#y, this.#active);
  }

  #reset(): void {
    this.#pointerActive = false;
    // State snaps to 0 immediately; the knob eases back via the CSS transition.
    this.#knob.style.transform = "translate(-50%, -50%)";
    this.#x = 0;
    this.#y = 0;
    this.#active = false;
    this.#onChange?.(0, 0, false);
  }
}

// ---------------------------------------------------------------------------
// VirtualButton
// ---------------------------------------------------------------------------

// Default style for the virtual button wrapper (the 60px hit area).
const DEFAULT_BUTTON_WRAPPER_STYLE: Partial<CSSStyleDeclaration> = {
  userSelect: "none",
  webkitUserSelect: "none",
  touchAction: "none",
  overscrollBehavior: "none",
  position: "fixed",
  zIndex: "10",
  height: "60px",
  width: "60px",
  background: "rgba(0, 0, 0, 0.1)",
  borderRadius: "50%",
};

// Default style for the virtual button cap (the 45px visible disc with the label).
const DEFAULT_BUTTON_CAP_STYLE: Partial<CSSStyleDeclaration> = {
  width: "45px",
  height: "45px",
  background: "rgba(255, 255, 255, 0.8)",
  borderRadius: "50%",
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  transition: "transform 0.2s cubic-bezier(0.25, 1.5, 0.5, 1)",
  willChange: "transform",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  fontSize: "12px",
  fontWeight: "bold",
  fontFamily: "Arial, sans-serif",
  color: "LightGray",
  userSelect: "none",
  pointerEvents: "none",
};

export interface VirtualButtonOptions {
  /** Text rendered on the cap, e.g. "Jump" (plain text — set via textContent). */
  label?: string;
  /** DOM parent; default `document.body`. */
  parent?: HTMLElement;
  /** Style overrides; position the button via `wrapperStyle` (e.g. `{ right: "40px", bottom: "90px" }`). */
  wrapperStyle?: Partial<CSSStyleDeclaration>;
  capStyle?: Partial<CSSStyleDeclaration>;
  /** Rising-edge press hook (e.g. an on-screen Enter/Exit button → `mgr.requestInteract()`). */
  onPress?: () => void;
  onRelease?: () => void;
}

/**
 * DOM+CSS virtual button for touch controls. Read `pressed` each frame (e.g.
 * `jump: kb.space || btnJump.pressed`) or use the `onPress`/`onRelease` edge callbacks.
 */
export class VirtualButton {
  #wrapper: HTMLDivElement;
  #cap: HTMLDivElement;
  #pressed = false;
  #onPress: (() => void) | undefined;
  #onRelease: (() => void) | undefined;
  #disposed = false;

  #onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  #onPointerDown = (event: PointerEvent): void => {
    this.#press(event);
  };

  #onPointerEnd = (): void => {
    this.#release();
  };

  constructor(options: VirtualButtonOptions = {}) {
    this.#onPress = options.onPress;
    this.#onRelease = options.onRelease;

    this.#wrapper = document.createElement("div");
    applyStyle(this.#wrapper, DEFAULT_BUTTON_WRAPPER_STYLE, options.wrapperStyle);
    applyLegacyUserSelectNone(this.#wrapper);

    this.#cap = document.createElement("div");
    applyStyle(this.#cap, DEFAULT_BUTTON_CAP_STYLE, options.capStyle);
    this.#cap.textContent = options.label ?? "";
    this.#wrapper.appendChild(this.#cap);

    this.#wrapper.addEventListener("contextmenu", this.#onContextMenu);
    this.#wrapper.addEventListener("pointerdown", this.#onPointerDown);
    this.#wrapper.addEventListener("pointerup", this.#onPointerEnd);
    this.#wrapper.addEventListener("pointerleave", this.#onPointerEnd);

    (options.parent ?? document.body).appendChild(this.#wrapper);
  }

  /** True while the button is held. */
  get pressed(): boolean {
    return this.#pressed;
  }

  /** The wrapper element (for ad-hoc styling / conditional display). */
  get element(): HTMLDivElement {
    return this.#wrapper;
  }

  /** Show/hide helper. */
  setVisible(visible: boolean): void {
    this.#wrapper.style.display = visible ? "" : "none";
  }

  /** Release (if held) + remove DOM + listeners. Resets only this button's own state. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release();
    this.#wrapper.removeEventListener("contextmenu", this.#onContextMenu);
    this.#wrapper.removeEventListener("pointerdown", this.#onPointerDown);
    this.#wrapper.removeEventListener("pointerup", this.#onPointerEnd);
    this.#wrapper.removeEventListener("pointerleave", this.#onPointerEnd);
    this.#wrapper.remove();
  }

  #press(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const wasPressed = this.#pressed;
    this.#pressed = true;
    this.#cap.style.transform = "translate(-50%, -50%) scale(1.3)";
    this.#cap.style.opacity = "0.5";
    // Rising edge (pointerdown cannot re-fire while down, but guard anyway).
    if (!wasPressed) this.#onPress?.();
  }

  #release(): void {
    if (!this.#pressed) return;
    this.#pressed = false;
    this.#cap.style.transform = "translate(-50%, -50%) scale(1)";
    this.#cap.style.opacity = "1";
    this.#onRelease?.();
  }
}
