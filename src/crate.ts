// The sumo crate — the contested-physics case. TWO players can push it at once,
// so claim-on-touch would flicker. Instead ONE authority (the host) integrates
// it: every client senses its own push and sends it to the host via the input
// channel; the host sums all pushes, moves the crate, and publishes the result
// on `objects` (smoothed for everyone). A kinematic proxy body on every client
// lets the local character physically bump the crate with zero ownership fights.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Session } from "@genex-ai/multiplayer";
import type { PhysicsWorld } from "./controllers/shared/physics-world.ts";
import { cuboidCollider } from "./controllers/shared/colliders.ts";
import { type PlayerNet } from "./netstate.ts";
import { CRATE_SIZE, CRATE_SPAWN, SUMO, SUMO_OUT_RADIUS } from "./layout.ts";

const HALF = CRATE_SIZE / 2;
const PUSH_ACCEL = 30;
const DAMP = 6.5;
const MAX_SPEED = 3.6;
const REACH = HALF + 0.7;

interface CrateState extends Record<string, unknown> {
  x: number;
  z: number;
}
interface PushMsg {
  obj: string;
  dir: [number, number];
  from: string;
}

export class NetCrate {
  readonly mesh: THREE.Mesh;
  private body: RAPIER.RigidBody;
  private sim = { x: CRATE_SPAWN.x, z: CRATE_SPAWN.z, vx: 0, vz: 0 };
  private pending: PushMsg[] = [];
  private myPush: [number, number] | null = null;
  private lastPusher = "";
  private wasHost = false;
  private _tmp = { x: 0, y: HALF, z: 0 };

  constructor(scene: THREE.Scene, private physics: PhysicsWorld) {
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE),
      new THREE.MeshStandardMaterial({ map: makeCrateTexture(), roughness: 0.9 })
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.position.set(CRATE_SPAWN.x, HALF, CRATE_SPAWN.z);
    scene.add(this.mesh);

    // Kinematic collision proxy — the character can push against this locally.
    this.body = physics.createBody({
      type: "kinematicPosition",
      position: [CRATE_SPAWN.x, HALF, CRATE_SPAWN.z],
    });
    cuboidCollider(physics.world, this.body, [HALF, HALF, HALF], { friction: 0.6 });
  }

  /** Register once: collect push inputs the relay routes to us while we're host. */
  bindInputs(room: Session<PlayerNet>) {
    room.inputs.on((_from, payload) => {
      const p = payload as Partial<PushMsg>;
      if (p?.obj === "crate" && Array.isArray(p.dir) && p.from) {
        this.pending.push({ obj: "crate", dir: p.dir as [number, number], from: p.from });
      }
    });
  }

  /** Each frame: figure out whether I'm pushing the crate right now. */
  sensePush(feet: THREE.Vector3, moving: boolean, onFoot: boolean) {
    this.myPush = null;
    if (!moving || !onFoot) return;
    const cx = this.mesh.position.x;
    const cz = this.mesh.position.z;
    const dx = cx - feet.x;
    const dz = cz - feet.z;
    const dist = Math.hypot(dx, dz);
    if (dist > REACH || dist < 1e-3) return;
    this.myPush = [dx / dist, dz / dist];
  }

  /** On the fixed tick: deliver my push (to the host, or locally if I am host). */
  publishPush(room: Session<PlayerNet>) {
    if (!this.myPush) return;
    if (room.isHost) {
      this.pending.push({ obj: "crate", dir: this.myPush, from: room.id });
    } else {
      room.inputs.send({ obj: "crate", dir: this.myPush, from: room.id });
    }
  }

  /**
   * Per-frame update. On the host: integrate + move the proxy. On non-hosts:
   * follow the smoothed network state. Returns the scorer id if the crate was
   * pushed out this frame (host only), else null.
   */
  update(room: Session<PlayerNet>, dt: number): string | null {
    const isHost = room.isHost;

    // Handle host election: seed the sim from the last published truth.
    if (isHost && !this.wasHost) {
      const v = room.objects.get<CrateState>("crate");
      if (v?.stateRaw && typeof v.stateRaw.x === "number") {
        this.sim.x = v.stateRaw.x;
        this.sim.z = v.stateRaw.z;
      }
      this.sim.vx = this.sim.vz = 0;
      room.objects.claim("crate");
    }
    this.wasHost = isHost;

    let scorer: string | null = null;

    if (isHost) {
      if (room.objects.get("crate") === undefined) room.objects.claim("crate");
      const clamped = Math.min(dt, 1 / 30);
      let fx = 0;
      let fz = 0;
      for (const p of this.pending.splice(0)) {
        fx += p.dir[0];
        fz += p.dir[1];
        this.lastPusher = p.from;
      }
      const s = this.sim;
      s.vx += fx * PUSH_ACCEL * clamped;
      s.vz += fz * PUSH_ACCEL * clamped;
      const d = Math.max(0, 1 - DAMP * clamped);
      s.vx *= d;
      s.vz *= d;
      const sp = Math.hypot(s.vx, s.vz);
      if (sp > MAX_SPEED) {
        s.vx *= MAX_SPEED / sp;
        s.vz *= MAX_SPEED / sp;
      }
      s.x += s.vx * clamped;
      s.z += s.vz * clamped;

      // Out of the ring?
      const outDist = Math.hypot(s.x - SUMO.center.x, s.z - SUMO.center.z);
      if (outDist > SUMO_OUT_RADIUS && this.lastPusher) {
        scorer = this.lastPusher;
        this.resetToCenter(room);
      }
      this.mesh.position.set(this.sim.x, HALF, this.sim.z);
    } else {
      this.pending.length = 0;
      const v = room.objects.get<CrateState>("crate");
      if (v?.state && typeof v.state.x === "number") {
        this.mesh.position.set(v.state.x, HALF, v.state.z ?? SUMO.center.z);
      }
    }

    // Drive the kinematic proxy so the local character collides with it.
    this._tmp.x = this.mesh.position.x;
    this._tmp.z = this.mesh.position.z;
    this.body.setNextKinematicTranslation(this._tmp);

    return scorer;
  }

  private lastSentJson = "";
  private lastSentAt = 0;

  /** Host publishes crate position on the fixed tick — but only when it MOVED (plus a
   * ~2Hz keepalive). A resting crate republished every tick wastes the message budget. */
  publish(room: Session<PlayerNet>) {
    if (!room.isHost) return;
    const net = {
      x: Math.round(this.sim.x * 100) / 100,
      z: Math.round(this.sim.z * 100) / 100,
    };
    const json = JSON.stringify(net);
    const now = Date.now();
    if (json === this.lastSentJson && now - this.lastSentAt < 500) return;
    this.lastSentJson = json;
    this.lastSentAt = now;
    room.objects.set("crate", net);
  }

  resetToCenter(room: Session<PlayerNet>) {
    this.sim = { x: CRATE_SPAWN.x, z: CRATE_SPAWN.z, vx: 0, vz: 0 };
    this.lastPusher = "";
    if (room.isHost) {
      room.objects.claim("crate");
      room.objects.set("crate", { x: CRATE_SPAWN.x, z: CRATE_SPAWN.z });
    }
    this.mesh.position.set(CRATE_SPAWN.x, HALF, CRATE_SPAWN.z);
  }
}

function makeCrateTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#b5793a";
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = "#7d5327";
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, 120, 120);
  ctx.lineWidth = 5;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (i * 128) / 4);
    ctx.lineTo(128, (i * 128) / 4);
    ctx.stroke();
  }
  // corner brackets
  ctx.strokeStyle = "#5f3f1e";
  ctx.strokeRect(4, 4, 120, 120);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
