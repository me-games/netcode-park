// A reusable character avatar: the shared VRM model + the retargeted animation
// library + a CharacterAnimations state machine. Used for the local player
// (parented under the controller root) and for every remote player (visual
// only — no physics). Remotes are told apart by a floating name tag and a
// team-colored ground ring.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadVrm } from "./controllers/character/vrm/vrm-loader.ts";
import { retargetClips } from "./controllers/character/vrm/vrm-retarget.ts";
import { capsuleFromModel } from "./controllers/character/vrm/capsule-fit.ts";
import { CharacterAnimations } from "./controllers/character/character-animations.ts";

/** The five booleans that drive the animation state machine. */
export interface AnimFlags {
  isOnGround: boolean;
  isFalling: boolean;
  isMoving: boolean;
  runActive: boolean;
  jumpActive: boolean;
}

export const IDLE_FLAGS: AnimFlags = {
  isOnGround: true,
  isFalling: false,
  isMoving: false,
  runActive: false,
  jumpActive: false,
};

let libPromise: Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> | null = null;
function loadAnimLibrary() {
  if (!libPromise) {
    libPromise = new GLTFLoader().loadAsync("./assets/animation-library.glb").then((g) => ({
      scene: g.scene,
      animations: g.animations,
    }));
  }
  return libPromise;
}

export interface PlayerAvatar {
  /** The model group — feet at the group's local origin. */
  model: THREE.Object3D;
  vrm: Awaited<ReturnType<typeof loadVrm>>["vrm"];
  anims: CharacterAnimations;
  /** Advance the mixer + VRM (call once per render frame). */
  update(flags: AnimFlags, dt: number): void;
  playOneShot(clip: string): void;
  dispose(): void;
}

/** Load a fresh avatar instance (its own VRM + retargeted clips + mixer). */
export async function createPlayerAvatar(url = "./assets/avatar.vrm"): Promise<PlayerAvatar> {
  const [{ scene: model, vrm }, lib] = await Promise.all([loadVrm(url), loadAnimLibrary()]);

  // Drop the model so its feet sit on the group origin.
  const box = new THREE.Box3().setFromObject(model);
  model.position.y -= box.min.y;

  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });

  const anims = new CharacterAnimations(model, retargetClips(vrm, lib.scene, lib.animations));

  return {
    model,
    vrm,
    anims,
    update(flags, dt) {
      anims.update(flags, dt);
      vrm.update(dt);
    },
    playOneShot(clip) {
      anims.playOneShot(clip);
    },
    dispose() {
      anims.dispose();
    },
  };
}

export interface LocalAvatar {
  model: THREE.Object3D;
  vrm: Awaited<ReturnType<typeof loadVrm>>["vrm"];
  anims: CharacterAnimations;
  fit: ReturnType<typeof capsuleFromModel>;
}

/**
 * Load the avatar for the LOCAL player, along with the capsule fit the physics
 * controller needs. The model is NOT pre-offset (the controller places it under
 * its root using `fit.modelOffsetY`).
 */
export async function createLocalAvatar(url = "./assets/avatar.vrm"): Promise<LocalAvatar> {
  const [{ scene: model, vrm }, lib] = await Promise.all([loadVrm(url), loadAnimLibrary()]);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  const anims = new CharacterAnimations(model, retargetClips(vrm, lib.scene, lib.animations));
  return { model, vrm, anims, fit: capsuleFromModel(model) };
}

/** A floating name label that always faces the camera. */
export function makeNameTag(name: string, colorHex: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 72;
  const ctx = canvas.getContext("2d")!;
  drawTag(ctx, name, colorHex);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(2.6, 0.73, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function drawTag(ctx: CanvasRenderingContext2D, name: string, colorHex: number) {
  ctx.clearRect(0, 0, 256, 72);
  const col = "#" + colorHex.toString(16).padStart(6, "0");
  ctx.fillStyle = "rgba(12,16,24,0.72)";
  roundRect(ctx, 6, 10, 244, 46, 12);
  ctx.fill();
  ctx.fillStyle = col;
  roundRect(ctx, 6, 10, 8, 46, 4);
  ctx.fill();
  ctx.font = "bold 30px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  const label = name.length > 14 ? name.slice(0, 13) + "…" : name;
  ctx.fillText(label, 132, 34);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A flat team-color ring drawn under a remote player's feet. */
export function makeFootRing(colorHex: number): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.58, 32),
    new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.85, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  return ring;
}

/** An emoji bubble that pops above a player when they emote. */
export function makeEmoteBubble(emoji: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  roundRect(ctx, 14, 14, 100, 100, 26);
  ctx.fill();
  ctx.font = "68px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, 64, 66);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(1.1, 1.1, 1);
  sprite.renderOrder = 1000;
  return sprite;
}
