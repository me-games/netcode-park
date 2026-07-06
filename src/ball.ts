// The football: a shared `objects` entry. Whoever last kicks it owns and
// simulates it; everyone else sees the smoothed stream. Passing between players
// is seamless because ownership hands off on contact and the object stream is
// continuous. Goals are detected by the host only.
import * as THREE from "three";
import type { Session } from "@genex-ai/multiplayer";
import { type PlayerNet } from "./netstate.ts";
import {
  BALL_RADIUS,
  BALL_SPAWN,
  WALL_LIMIT,
  PITCH,
  PITCH_GOAL_NORTH_Z,
  PITCH_GOAL_SOUTH_Z,
} from "./layout.ts";

const G = 22;
const GROUND_FRICTION = 0.985;
const BOUNCE = 0.45;
const MAX_SPEED = 22;

interface BallState extends Record<string, unknown> {
  x: number;
  y: number;
  z: number;
}

export class NetBall {
  readonly mesh: THREE.Mesh;
  private sim = { x: BALL_SPAWN.x, y: BALL_SPAWN.y, z: BALL_SPAWN.z, vx: 0, vy: 0, vz: 0 };
  private lastPos = new THREE.Vector3().copy(BALL_SPAWN);
  private initialized = false;
  private goalCooldown = 0;
  private _v = new THREE.Vector3();
  private _axis = new THREE.Vector3();
  private _up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 24, 18),
      new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.55, metalness: 0.0 })
    );
    this.mesh.castShadow = true;
    this.mesh.position.copy(BALL_SPAWN);
    scene.add(this.mesh);
  }

  private r2(v: number) {
    return Math.round(v * 100) / 100;
  }

  /** Host seeds the ball at spawn once it exists. */
  ensureInit(room: Session<PlayerNet>) {
    if (this.initialized) return;
    if (room.isHost && room.objects.get("ball") === undefined) {
      room.objects.claim("ball");
      room.objects.set("ball", { x: BALL_SPAWN.x, y: BALL_SPAWN.y, z: BALL_SPAWN.z });
      this.initialized = true;
    }
  }

  private seedFromNetwork(room: Session<PlayerNet>) {
    const v = room.objects.get<BallState>("ball");
    if (v?.stateRaw && typeof v.stateRaw.x === "number") {
      this.sim.x = v.stateRaw.x;
      this.sim.y = v.stateRaw.y;
      this.sim.z = v.stateRaw.z;
      this.sim.vx = this.sim.vy = this.sim.vz = 0;
    }
  }

  private kickCooldown = 0;

  /** Try to kick if my feet are on the ball and I'm moving toward it. Returns true on a kick. */
  tryKick(room: Session<PlayerNet>, feet: THREE.Vector3, moving: boolean, running: boolean): boolean {
    if (this.kickCooldown > 0 || !moving) return false;
    const view = room.objects.get<BallState>("ball");
    const bx = view?.state?.x ?? this.sim.x;
    const bz = view?.state?.z ?? this.sim.z;
    const dx = bx - feet.x;
    const dz = bz - feet.z;
    const dist = Math.hypot(dx, dz);
    const reach = BALL_RADIUS + 0.6;
    if (dist > reach) return false;

    if (!view?.isMine) {
      room.objects.claim("ball");
      this.seedFromNetwork(room);
    }
    const inv = dist > 0.001 ? 1 / dist : 0;
    const speed = running ? 15 : 9;
    this.sim.vx = dx * inv * speed;
    this.sim.vz = dz * inv * speed;
    this.sim.vy = Math.max(this.sim.vy, 3.2);
    this.kickCooldown = 0.18; // avoid re-kicking every frame while touching
    return true;
  }

  /** Per-frame: simulate if owned, then position + spin the mesh. */
  update(room: Session<PlayerNet>, dt: number) {
    const view = room.objects.get<BallState>("ball");
    const clamped = Math.min(dt, 1 / 30);

    if (view?.isMine) {
      const s = this.sim;
      s.vy -= G * clamped;
      s.x += s.vx * clamped;
      s.y += s.vy * clamped;
      s.z += s.vz * clamped;

      if (s.y <= BALL_RADIUS) {
        s.y = BALL_RADIUS;
        if (s.vy < 0) s.vy = -s.vy * BOUNCE;
        s.vx *= GROUND_FRICTION;
        s.vz *= GROUND_FRICTION;
        if (Math.abs(s.vx) < 0.05) s.vx = 0;
        if (Math.abs(s.vz) < 0.05) s.vz = 0;
      }
      const lim = WALL_LIMIT - BALL_RADIUS;
      if (Math.abs(s.x) > lim) {
        s.x = Math.sign(s.x) * lim;
        s.vx = -s.vx * 0.6;
      }
      if (Math.abs(s.z) > lim) {
        s.z = Math.sign(s.z) * lim;
        s.vz = -s.vz * 0.6;
      }
      const sp = Math.hypot(s.vx, s.vy, s.vz);
      if (sp > MAX_SPEED) {
        const k = MAX_SPEED / sp;
        s.vx *= k;
        s.vy *= k;
        s.vz *= k;
      }
      this.mesh.position.set(s.x, s.y, s.z);
    } else if (view?.state && typeof view.state.x === "number") {
      this.mesh.position.set(view.state.x, view.state.y ?? BALL_RADIUS, view.state.z ?? 0);
    }

    // Rolling spin from the frame's movement (works for owner + remote).
    this._v.copy(this.mesh.position).sub(this.lastPos);
    const moved = this._v.length();
    if (moved > 1e-4) {
      this._axis.copy(this._up).cross(this._v).normalize();
      this.mesh.rotateOnWorldAxis(this._axis, moved / BALL_RADIUS);
    }
    this.lastPos.copy(this.mesh.position);

    if (this.goalCooldown > 0) this.goalCooldown -= dt;
    if (this.kickCooldown > 0) this.kickCooldown -= dt;
  }

  private lastSentJson = "";
  private lastSentAt = 0;

  /** Owner publishes on the fixed tick — but only when the ball MOVED (plus a ~2Hz
   * keepalive). A resting ball republished every tick wastes the relay message budget. */
  publish(room: Session<PlayerNet>) {
    const view = room.objects.get<BallState>("ball");
    if (!view?.isMine) return;
    const net = { x: this.r2(this.sim.x), y: this.r2(this.sim.y), z: this.r2(this.sim.z) };
    const json = JSON.stringify(net);
    const now = Date.now();
    if (json === this.lastSentJson && now - this.lastSentAt < 500) return;
    this.lastSentJson = json;
    this.lastSentAt = now;
    room.objects.set("ball", net);
  }

  /** Host-only goal test. Returns the scorer's id (ball owner) or null. */
  checkGoal(room: Session<PlayerNet>): string | null {
    if (!room.isHost || this.goalCooldown > 0) return null;
    const view = room.objects.get<BallState>("ball");
    if (!view?.owner || !view.stateRaw) return null;
    const { x, y, z } = view.stateRaw;
    if (typeof x !== "number") return null;
    const withinMouth = Math.abs(x - PITCH.center.x) <= PITCH.goalWidth / 2 && y <= PITCH.goalHeight;
    const inNorth = withinMouth && z <= PITCH_GOAL_NORTH_Z && z >= PITCH_GOAL_NORTH_Z - PITCH.goalDepth - 1.5;
    const inSouth = withinMouth && z >= PITCH_GOAL_SOUTH_Z && z <= PITCH_GOAL_SOUTH_Z + PITCH.goalDepth + 1.5;
    if (inNorth || inSouth) {
      this.goalCooldown = 3;
      return view.owner;
    }
    return null;
  }

  /** Host resets the ball to the centre spot after a goal. */
  resetToCenter(room: Session<PlayerNet>) {
    if (!room.isHost) return;
    room.objects.claim("ball");
    this.sim = { x: BALL_SPAWN.x, y: BALL_SPAWN.y, z: BALL_SPAWN.z, vx: 0, vy: 0, vz: 0 };
    room.objects.set("ball", { x: BALL_SPAWN.x, y: BALL_SPAWN.y, z: BALL_SPAWN.z });
    this.mesh.position.copy(BALL_SPAWN);
  }
}

function makeBallTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#f7f7f7";
  ctx.fillRect(0, 0, 256, 256);
  // scattered dark "pentagons" for a classic look
  ctx.fillStyle = "#1c1c1c";
  const spots: [number, number, number][] = [
    [60, 60, 26],
    [190, 70, 24],
    [128, 140, 28],
    [50, 190, 22],
    [205, 195, 22],
  ];
  for (const [x, y, r] of spots) {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
