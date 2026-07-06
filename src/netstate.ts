import { PLAYER_COLORS } from "./layout.ts";

// What each player publishes about themselves (~15 Hz). Kept flat + tiny.
export interface PlayerNet extends Record<string, unknown> {
  x: number;
  y: number; // FEET height
  z: number;
  q: number[]; // facing quaternion [x,y,z,w]
  mode: number; // 0 = on foot, 1 = driving a car, 2 = flying the drone
  veh: string; // vehicle object id when mode !== 0 ("car" | "car2" | "drone"), "" on foot
  // animation flags (discrete — remotes read these from stateRaw)
  g: boolean; // on ground
  f: boolean; // falling
  m: boolean; // moving
  r: boolean; // running
  j: boolean; // jump active
}

/** Deterministic per-player color so every client agrees on who's which. */
export function colorForId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PLAYER_COLORS[h % PLAYER_COLORS.length];
}
