// Car + drone, networked. Only the DRIVER simulates a vehicle's physics and
// publishes its pose on `objects`; everyone else (and the host, for an idle
// vehicle) renders a smooth follower whose Rapier body is force-positioned to
// the network pose so the local character can still bump it. The host owns and
// republishes idle vehicles, and persists their resting pose.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Session } from "@genex-ai/multiplayer";
import type { PhysicsWorld } from "./controllers/shared/physics-world.ts";
import { cuboidCollider, cylinderCollider } from "./controllers/shared/colliders.ts";
import { VehicleController } from "./controllers/vehicle/vehicle-controller.ts";
import { vehiclePresets } from "./controllers/vehicle/presets.ts";
import { DroneController, type PropellerOptions } from "./controllers/drone/drone-controller.ts";
import { dronePresets } from "./controllers/drone/presets.ts";
import type { VehicleUnitLike } from "./controllers/interact/enter-exit.ts";
import { CAR_SPAWN, DRONE_SPAWN } from "./layout.ts";
import { type PlayerNet } from "./netstate.ts";

export interface Pose {
  x: number;
  y: number;
  z: number;
  q: number[];
}
interface VehState extends Record<string, unknown> {
  x: number;
  y: number;
  z: number;
  q: number[];
}

const ZERO = { x: 0, y: 0, z: 0 };
const r2 = (v: number) => Math.round(v * 100) / 100;

function yawQuat(yaw: number): number[] {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).toArray();
}

/** One networked vehicle: owns the authority/follower switch + publishing. */
export class VehicleNet {
  driving = false;
  private registered = false;
  private hostAdopted = false; // has this host adopted the live resting pose yet?
  private lastIdleJson = ""; // last idle keepalive payload (change detection)
  private lastIdleAt = 0; // when the last idle keepalive was sent (ms epoch)
  restingPose: Pose;
  private _t = new THREE.Vector3();
  private _q = new THREE.Quaternion();

  constructor(
    readonly id: string,
    readonly unit: VehicleUnitLike,
    readonly body: RAPIER.RigidBody,
    readonly chassisObject: THREE.Object3D,
    spawn: { position: THREE.Vector3; yaw: number },
    private physics: PhysicsWorld
  ) {
    this.restingPose = { x: spawn.position.x, y: spawn.position.y, z: spawn.position.z, q: yawQuat(spawn.yaw) };
    this.placeBody(this.restingPose);
    this.renderPose(this.restingPose);
  }

  private placeBody(p: Pose) {
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, false);
    this.body.setRotation({ x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] }, false);
    this.body.setLinvel(ZERO, false);
    this.body.setAngvel(ZERO, false);
  }

  private renderPose(p: Pose) {
    this.chassisObject.position.set(p.x, p.y, p.z);
    this.chassisObject.quaternion.set(p.q[0], p.q[1], p.q[2], p.q[3]);
  }

  private bodyPose(): Pose {
    const t = this.body.translation();
    const r = this.body.rotation();
    return { x: t.x, y: t.y, z: t.z, q: [r.x, r.y, r.z, r.w] };
  }

  /** Local player takes the wheel: my physics becomes authoritative. */
  beginDrive(room: Session<PlayerNet>) {
    // Seed my body from the latest network pose so there's no jump.
    const v = room.objects.get<VehState>(this.id);
    const src = v?.stateRaw && typeof v.stateRaw.x === "number" ? poseFrom(v.stateRaw) : this.restingPose;
    this.placeBody(src);
    this.body.setEnabled(true);
    room.objects.claim(this.id);
    this.physics.registerBody(this.body, this.chassisObject);
    this.registered = true;
    this.driving = true;
  }

  /** Local player steps out: publish the final pose, hand back to the relay. */
  endDrive(room: Session<PlayerNet>) {
    this.driving = false;
    const p = this.bodyPose();
    room.objects.set(this.id, { x: r2(p.x), y: r2(p.y), z: r2(p.z), q: p.q.map(r2) });
    this.restingPose = p;
    if (this.registered) {
      this.physics.unregisterBody(this.body);
      this.registered = false;
    }
    room.objects.release(this.id);
  }

  /** Did I lose the seat to someone who claimed at the same instant? */
  lostSeat(room: Session<PlayerNet>): boolean {
    const v = room.objects.get<VehState>(this.id);
    return this.driving && !!v && v.owner !== undefined && v.owner !== room.id;
  }

  /** Force followers' body + visual to the network pose (call BEFORE step). */
  followerSync(room: Session<PlayerNet>) {
    if (this.driving) return;
    const v = room.objects.get<VehState>(this.id);

    // Authority follows OWNERSHIP, not host status. The host is the idle authority
    // only for a vehicle nobody owns (or one it owns itself); the moment another
    // player claims/drives it, the host follows the network stream like everyone
    // else. (The old `if (isHost)` pinned driven cars to restingPose — every other
    // player's driving looked permanently frozen on the host's screen.)
    const mineOrUnowned = !v || v.owner === undefined || v.isMine;
    if (room.isHost && mineOrUnowned) {
      // Claim an unowned vehicle so idle ones stay published + persisted.
      if (v && v.owner === undefined) room.objects.claim(this.id);
      // The FIRST time I own it as host (fresh room or host migration), adopt
      // the live pose off the wire so I don't teleport it back to spawn.
      if (!this.hostAdopted && v && v.isMine && v.stateRaw && typeof v.stateRaw.x === "number") {
        this.restingPose = poseFrom(v.stateRaw);
        this.hostAdopted = true;
      }
      // I'm the idle authority: hold the vehicle at its resting pose.
      this.placeBody(this.restingPose);
      this.renderPose(this.restingPose);
      return;
    }

    this.hostAdopted = false;
    // Someone else owns it (a remote driver or the host): follow the stream.
    if (v?.state && typeof v.state.x === "number") this.renderPose(poseFrom(v.state));
    if (v?.stateRaw && typeof v.stateRaw.x === "number") this.placeBody(poseFrom(v.stateRaw));
  }

  /**
   * On the fixed tick: publish what I'm authoritative for. `hostSeedAllowed`
   * gates CREATING an idle vehicle object — held false until persistence has
   * loaded, so a fresh world seeds from the saved pose, not spawn.
   */
  publish(room: Session<PlayerNet>, hostSeedAllowed: boolean) {
    if (this.driving) {
      const p = this.bodyPose();
      room.objects.set(this.id, poseNet(p));
      this.restingPose = p;
    } else if (room.isHost) {
      const v = room.objects.get<VehState>(this.id);
      if (v === undefined) {
        if (!hostSeedAllowed) return;
        room.objects.claim(this.id);
        this.hostAdopted = true; // I created it at restingPose — nothing to adopt
        room.objects.set(this.id, poseNet(this.restingPose));
      } else if (v.isMine) {
        // Idle authority: keepalive at ~1Hz / on change — never every tick. Each
        // publish is a relay message, and a host re-setting several PARKED vehicles
        // at full tick rate blows the per-connection message budget (which is what
        // starved the driven car's stream and froze it for everyone).
        const net = poseNet(this.restingPose);
        const json = JSON.stringify(net);
        const now = Date.now();
        if (json !== this.lastIdleJson || now - this.lastIdleAt >= 1000) {
          this.lastIdleJson = json;
          this.lastIdleAt = now;
          room.objects.set(this.id, net);
        }
      }
    }
  }

  /** Emergency local cleanup (e.g. on disconnect) — no network calls. */
  bailOut() {
    this.driving = false;
    if (this.registered) {
      this.physics.unregisterBody(this.body);
      this.registered = false;
    }
    this.holdResting();
  }

  holdResting() {
    if (!this.driving) {
      this.placeBody(this.restingPose);
      this.renderPose(this.restingPose);
    }
  }

  applyPersistedPose(p: Pose) {
    this.restingPose = p;
    this.hostAdopted = true; // this pose is authoritative — don't re-adopt from spawn
    if (!this.driving) {
      this.placeBody(p);
      this.renderPose(p);
    }
  }
}

function poseFrom(s: { x: number; y: number; z: number; q?: number[] }): Pose {
  return { x: s.x, y: s.y, z: s.z, q: Array.isArray(s.q) && s.q.length === 4 ? s.q : [0, 0, 0, 1] };
}
function poseNet(p: Pose): VehState {
  return { x: r2(p.x), y: r2(p.y), z: r2(p.z), q: p.q.map(r2) };
}

// ---------------------------------------------------------------------------
// Builders — construct the local controllers + visuals.
// ---------------------------------------------------------------------------

export function buildCar(
  physics: PhysicsWorld,
  scene: THREE.Scene,
  opts: { spawn?: { position: THREE.Vector3; yaw: number }; color?: number } = {}
) {
  const preset = vehiclePresets["arcade-kart"];
  const spawn = opts.spawn ?? CAR_SPAWN;
  const car = new VehicleController({
    world: physics.world,
    position: spawn.position.clone(),
    carConfig: preset.carConfig,
  });
  for (const c of preset.chassisColliders) {
    cuboidCollider(physics.world, car.body, [c.halfExtents.x, c.halfExtents.y, c.halfExtents.z], {
      position: [c.offset.x, c.offset.y, c.offset.z],
      density: c.density,
    });
  }

  // Visual chassis: a chunky little kart.
  const bodyMat = new THREE.MeshStandardMaterial({ color: opts.color ?? 0xe14b3b, roughness: 0.5, metalness: 0.2 });
  const cabinMat = new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.3, metalness: 0.3 });
  const lower = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.7, 4.4), bodyMat);
  lower.position.y = 0.15;
  lower.castShadow = true;
  car.chassisObject.add(lower);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 1.9), cabinMat);
  cabin.position.set(0, 0.75, -0.2);
  cabin.castShadow = true;
  car.chassisObject.add(cabin);

  const wheelGeom = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 18);
  wheelGeom.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
  for (const slot of preset.wheelSlots) {
    const wheel = car.addWheel({
      ...preset.wheelShared,
      ...slot,
      position: new THREE.Vector3(slot.position.x, slot.position.y, slot.position.z),
    });
    wheel.modelObject.add(new THREE.Mesh(wheelGeom, wheelMat));
  }
  scene.add(car.chassisObject);
  return car;
}

export function buildDrone(physics: PhysicsWorld, scene: THREE.Scene) {
  const preset = dronePresets["camera-drone"];
  const chassis = new THREE.Group();

  const core = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.18, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x2c6fb5, roughness: 0.4, metalness: 0.3 })
  );
  core.castShadow = true;
  chassis.add(core);
  const armMat = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.6 });

  const propellers: PropellerOptions[] = [];
  for (const p of preset.propellers) {
    const mount = new THREE.Object3D();
    mount.position.set(p.position.x * 3, p.position.y, p.position.z * 3); // spread arms out for a ~1.5m frame
    chassis.add(mount);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6), armMat);
    arm.rotation.z = Math.PI / 2;
    arm.lookAt(0, 0, 0);
    mount.add(arm);
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.03, 0.09),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 })
    );
    blade.position.y = 0.12;
    mount.add(blade);
    propellers.push({
      object: mount,
      spinModel: blade,
      maxThrust: p.maxThrust,
      torqueRatio: p.torqueRatio,
      invertTorque: p.invertTorque,
    });
  }
  scene.add(chassis);

  const body = physics.createBody({ type: "dynamic", position: [DRONE_SPAWN.position.x, DRONE_SPAWN.position.y, DRONE_SPAWN.position.z] });
  const b = preset.body;
  cuboidCollider(physics.world, body, [b.cuboidHalfExtents.x, b.cuboidHalfExtents.y, b.cuboidHalfExtents.z], {
    density: b.density,
  });
  for (const pos of b.armCylinders.positions) {
    cylinderCollider(physics.world, body, b.armCylinders.halfHeight, b.armCylinders.radius, {
      position: [pos.x, pos.y, pos.z],
      density: b.density,
    });
  }
  const drone = new DroneController({ world: physics.world, body, chassis, propellers, config: preset.config });
  drone.setControlMode("POSITION");
  drone.setTarget(DRONE_SPAWN.position.clone(), new THREE.Vector3(0, 0, 1));
  return { drone, chassis, body };
}
