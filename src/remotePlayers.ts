// Manages the visual avatars of every OTHER player: async-loads each one,
// drives its animation from the synced flags, positions it from the smoothed
// network state, hides it while that player is in a vehicle, and floats a name
// tag + emote bubbles. No physics here — remotes are pure visuals.
import * as THREE from "three";
import type { Session } from "@genex-ai/multiplayer";
import {
  createPlayerAvatar,
  makeNameTag,
  makeFootRing,
  makeEmoteBubble,
  IDLE_FLAGS,
  type PlayerAvatar,
  type AnimFlags,
} from "./avatar.ts";
import { colorForId, type PlayerNet } from "./netstate.ts";

interface RemoteEntry {
  group: THREE.Group; // holds avatar model, name tag, foot ring
  avatar: PlayerAvatar | null; // null while the VRM loads
  nameTag: THREE.Sprite;
  bubble: THREE.Sprite | null;
  bubbleUntil: number;
  color: number;
  removed: boolean;
}

export class RemotePlayers {
  private entries = new Map<string, RemoteEntry>();
  private _q = new THREE.Quaternion();

  constructor(private scene: THREE.Scene) {}

  has(id: string) {
    return this.entries.has(id);
  }

  ensure(id: string, name: string) {
    if (this.entries.has(id)) return;
    const color = colorForId(id);
    const group = new THREE.Group();
    const nameTag = makeNameTag(name || "Player", color);
    nameTag.position.y = 2.15;
    group.add(nameTag);
    group.add(makeFootRing(color));
    this.scene.add(group);

    const entry: RemoteEntry = {
      group,
      avatar: null,
      nameTag,
      bubble: null,
      bubbleUntil: 0,
      color,
      removed: false,
    };
    this.entries.set(id, entry);

    createPlayerAvatar()
      .then((avatar) => {
        if (entry.removed) {
          avatar.dispose();
          return;
        }
        entry.avatar = avatar;
        group.add(avatar.model);
      })
      .catch((e) => console.error("[remote avatar]", e));
  }

  rename(id: string, name: string) {
    const e = this.entries.get(id);
    if (!e) return;
    const tag = makeNameTag(name || "Player", e.color);
    tag.position.copy(e.nameTag.position);
    e.group.remove(e.nameTag);
    (e.nameTag.material as THREE.SpriteMaterial).map?.dispose();
    (e.nameTag.material as THREE.SpriteMaterial).dispose();
    e.nameTag = tag;
    e.group.add(tag);
  }

  remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    e.removed = true;
    e.avatar?.dispose();
    this.scene.remove(e.group);
    this.entries.delete(id);
  }

  emote(id: string, emoji: string, now: number) {
    const e = this.entries.get(id);
    if (!e) return;
    if (!e.bubble) {
      e.bubble = makeEmoteBubble(emoji);
      e.bubble.position.y = 2.9;
      e.group.add(e.bubble);
    }
    e.bubbleUntil = now + 2500;
    e.bubble.visible = true;
  }

  /** Called every render frame. `me` is the local session id (skipped). */
  update(room: Session<PlayerNet>, dt: number, now: number) {
    // Reap avatars for players who left (defensive — 'leave' also calls remove).
    for (const id of this.entries.keys()) {
      if (!room.players.has(id)) this.remove(id);
    }

    for (const [id, p] of room.players) {
      if (id === room.id) continue;
      this.ensure(id, p.name);
      const e = this.entries.get(id)!;
      const s = p.state;
      const raw = p.stateRaw;
      const mode = raw?.mode ?? 0;
      const ring = e.group.children.find((c) => (c as THREE.Mesh).geometry instanceof THREE.RingGeometry);

      if (mode !== 0) {
        // Seat them on the vehicle they occupy (so a driven car is never empty).
        // Prefer the explicit vehicle id (distinguishes car vs car2); fall back to the
        // mode mapping for peers on an older bundle that doesn't publish `veh`.
        const vid = typeof raw?.veh === "string" && raw.veh ? raw.veh : mode === 1 ? "car" : "drone";
        const v = room.objects.get<{ x: number; y: number; z: number; q: number[] }>(vid);
        if (v?.state && typeof v.state.x === "number") {
          const seatY = mode === 1 ? 0.55 : 0.15;
          e.group.position.set(v.state.x, v.state.y + seatY, v.state.z);
          if (Array.isArray(v.state.q) && v.state.q.length === 4) {
            this._q.fromArray(v.state.q);
            e.group.quaternion.copy(this._q);
          }
        }
        if (e.avatar) e.avatar.model.visible = true;
        e.nameTag.visible = true;
        if (ring) ring.visible = false;
        e.avatar?.update(IDLE_FLAGS, dt);
      } else {
        if (e.avatar) e.avatar.model.visible = true;
        e.nameTag.visible = true;
        if (ring) ring.visible = true;
        if (s && typeof s.x === "number") {
          e.group.position.set(s.x, s.y ?? 0, s.z ?? 0);
          if (Array.isArray(s.q) && s.q.length === 4) {
            this._q.fromArray(s.q as number[]);
            e.group.quaternion.copy(this._q);
          }
        }
        const flags: AnimFlags = raw
          ? { isOnGround: !!raw.g, isFalling: !!raw.f, isMoving: !!raw.m, runActive: !!raw.r, jumpActive: !!raw.j }
          : IDLE_FLAGS;
        e.avatar?.update(flags, dt);
      }

      if (e.bubble && e.bubble.visible && now > e.bubbleUntil) e.bubble.visible = false;
    }
  }

  dispose() {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }
}
