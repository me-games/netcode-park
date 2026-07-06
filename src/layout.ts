// Shared world layout + palette. Every module reads positions/sizes from here
// so the scene, the colliders, and the game logic can never drift apart.
import * as THREE from "three";

export const GROUND_HALF = 62; // half-size of the flat park (x/z from -62..62)
export const WALL_LIMIT = 58; // invisible boundary that keeps players/ball in

// --- Football pitch (runs along Z; goals at each end) ---
export const PITCH = {
  center: new THREE.Vector3(0, 0, -16),
  halfWidth: 13, // along X
  halfLength: 18, // along Z
  goalWidth: 8, // opening along X
  goalHeight: 3,
  goalDepth: 2.2,
};
export const PITCH_GOAL_SOUTH_Z = PITCH.center.z + PITCH.halfLength; // z = +2
export const PITCH_GOAL_NORTH_Z = PITCH.center.z - PITCH.halfLength; // z = -34

export const BALL_RADIUS = 0.45;
export const BALL_SPAWN = new THREE.Vector3(0, BALL_RADIUS, PITCH.center.z);

// --- Sumo circle + contested crate ---
export const SUMO = {
  center: new THREE.Vector3(30, 0, 12),
  radius: 5.6,
};
export const CRATE_SIZE = 1.7; // full edge length of the cube
export const CRATE_SPAWN = new THREE.Vector3(
  SUMO.center.x,
  CRATE_SIZE / 2,
  SUMO.center.z
);
// The crate counts as "out" once its centre passes this far from the middle.
export const SUMO_OUT_RADIUS = SUMO.radius + CRATE_SIZE * 0.35;

// --- Vehicle parking spots ---
export const CAR_SPAWN = { position: new THREE.Vector3(-13, 0.55, 16), yaw: Math.PI };
export const CAR2_SPAWN = { position: new THREE.Vector3(-17, 0.55, 11), yaw: Math.PI / 2 };
export const DRONE_SPAWN = { position: new THREE.Vector3(13, 1.4, 16), yaw: 0 };

// --- Ramp playground (west side) ---
export const RAMPS: { pos: [number, number, number]; size: [number, number, number]; tilt: number }[] = [
  { pos: [-32, 0, 0], size: [8, 0.6, 9], tilt: -0.32 },
  { pos: [-32, 0, -14], size: [8, 0.6, 9], tilt: 0.32 },
  { pos: [-40, 1.15, -7], size: [8, 0.6, 6], tilt: 0 }, // top platform between the two ramps
];

export const PLAYER_SPAWN = new THREE.Vector3(0, 1.4, 16);

// Distinct, friendly avatar colors handed out to players by join order.
export const PLAYER_COLORS = [
  0x4fc3f7, 0xff8a65, 0xba68c8, 0x81c784, 0xffd54f, 0xf06292, 0x4db6ac, 0x9575cd,
];

export const COLORS = {
  grassA: 0x6db24a,
  grassB: 0x64a844,
  pitchA: 0x4e9d3f,
  pitchB: 0x57a846,
  line: 0xf3f7f0,
  ramp: 0xc98a5a,
  rampTop: 0xb5793a,
  sumoRing: 0xffb300,
  sumoFill: 0xe6c260,
  crate: 0xb5793a,
  goalPost: 0xf5f5f5,
  fence: 0x8d6e63,
  treeTrunk: 0x8d6e63,
  treeLeaf: 0x69a84f,
  skyTop: 0x3a86d6,
  skyBottom: 0xbfe4f5,
};
