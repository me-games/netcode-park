// Builds the static park: ground, football pitch + goals, sumo circle, ramps,
// perimeter fence, trees, clouds, sky and lighting. Also registers the static
// physics colliders every client shares. Dynamic things (ball, crate, cars)
// live in their own modules.
import * as THREE from "three";
import type { PhysicsWorld } from "./controllers/shared/physics-world.ts";
import { cuboidCollider } from "./controllers/shared/colliders.ts";
import {
  GROUND_HALF,
  WALL_LIMIT,
  PITCH,
  PITCH_GOAL_NORTH_Z,
  PITCH_GOAL_SOUTH_Z,
  SUMO,
  RAMPS,
  COLORS,
} from "./layout.ts";

export interface BuiltWorld {
  /** Meshes the follow-camera should not clip through. */
  cameraObstacles: THREE.Object3D[];
  sun: THREE.DirectionalLight;
}

export function buildWorld(scene: THREE.Scene, physics: PhysicsWorld): BuiltWorld {
  const obstacles: THREE.Object3D[] = [];

  // ---- Sky + fog ----
  scene.background = makeSkyTexture();
  scene.fog = new THREE.Fog(COLORS.skyBottom, 70, 130);

  // ---- Lighting ----
  const hemi = new THREE.HemisphereLight(0xcfeaff, 0x5a7a3a, 0.9);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d6, 2.2);
  sun.position.set(38, 54, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 180;
  const s = 70;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  // ---- Ground ----
  const groundMat = new THREE.MeshStandardMaterial({
    map: makeGrassTexture(),
    roughness: 1,
  });
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2),
    groundMat
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Ground collider (a thick slab so nothing tunnels through).
  staticBox(physics, [0, -0.5, 0], [GROUND_HALF, 0.5, GROUND_HALF], { friction: 0.9 });

  // ---- Football pitch ----
  buildPitch(scene, physics, obstacles);

  // ---- Sumo circle ----
  buildSumoCircle(scene);

  // ---- Ramps ----
  for (const r of RAMPS) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(r.size[0], r.size[1], r.size[2]),
      new THREE.MeshStandardMaterial({ color: r.tilt === 0 ? COLORS.rampTop : COLORS.ramp, roughness: 0.85 })
    );
    mesh.position.set(r.pos[0], r.pos[1] + r.size[1] / 2, r.pos[2]);
    mesh.rotation.x = r.tilt;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    obstacles.push(mesh);

    const body = physics.createBody({
      type: "fixed",
      position: [mesh.position.x, mesh.position.y, mesh.position.z],
      rotation: [r.tilt, 0, 0],
    });
    cuboidCollider(physics.world, body, [r.size[0] / 2, r.size[1] / 2, r.size[2] / 2], {
      friction: 0.9,
    });
  }

  // ---- Perimeter fence (visual) + invisible walls (collider) ----
  buildBoundary(scene, physics);

  // ---- Decorative trees + clouds ----
  buildTrees(scene);
  buildClouds(scene);

  return { cameraObstacles: obstacles, sun };
}

// Convenience: a static box with matching collider (correct arg order).
function staticBox(
  physics: PhysicsWorld,
  center: [number, number, number],
  half: [number, number, number],
  opts: { friction?: number } = {}
) {
  const body = physics.createBody({ type: "fixed", position: center });
  cuboidCollider(physics.world, body, half, opts);
  return body;
}

function buildPitch(scene: THREE.Scene, physics: PhysicsWorld, obstacles: THREE.Object3D[]) {
  const { center, halfWidth, halfLength, goalWidth, goalHeight, goalDepth } = PITCH;

  // Striped turf overlay, slightly above the ground to avoid z-fighting.
  const turf = new THREE.Mesh(
    new THREE.PlaneGeometry(halfWidth * 2, halfLength * 2),
    new THREE.MeshStandardMaterial({ map: makePitchTexture(), roughness: 1 })
  );
  turf.rotation.x = -Math.PI / 2;
  turf.position.set(center.x, 0.02, center.z);
  turf.receiveShadow = true;
  scene.add(turf);

  // White boundary + centre lines.
  addLineRect(scene, center.x, center.z, halfWidth, halfLength, 0.03);
  addLine(scene, center.x - halfWidth, center.x + halfWidth, center.z, center.z, 0.03); // halfway line
  const circle = new THREE.Mesh(
    new THREE.RingGeometry(2.4, 2.6, 48),
    new THREE.MeshBasicMaterial({ color: COLORS.line, side: THREE.DoubleSide })
  );
  circle.rotation.x = -Math.PI / 2;
  circle.position.set(center.x, 0.04, center.z);
  scene.add(circle);

  // Two goals.
  buildGoal(scene, physics, obstacles, center.x, PITCH_GOAL_NORTH_Z, goalWidth, goalHeight, goalDepth, 1);
  buildGoal(scene, physics, obstacles, center.x, PITCH_GOAL_SOUTH_Z, goalWidth, goalHeight, goalDepth, -1);
}

function buildGoal(
  scene: THREE.Scene,
  physics: PhysicsWorld,
  obstacles: THREE.Object3D[],
  x: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  dir: number // +1 goal opens toward -Z, -1 toward +Z
) {
  const postMat = new THREE.MeshStandardMaterial({ color: COLORS.goalPost, roughness: 0.5, metalness: 0.1 });
  const postR = 0.12;
  const group = new THREE.Group();

  const mkPost = (px: number) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, height, 12), postMat);
    post.position.set(px, height / 2, z);
    post.castShadow = true;
    group.add(post);
    // thin collider so players can't walk through the post
    const body = physics.createBody({ type: "fixed", position: [px, height / 2, z] });
    cuboidCollider(physics.world, body, [postR, height / 2, postR]);
  };
  mkPost(x - width / 2);
  mkPost(x + width / 2);

  const bar = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, width, 12), postMat);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(x, height, z);
  bar.castShadow = true;
  group.add(bar);

  // Back frame (depth) to read as a goal — visual net posts.
  const backZ = z - dir * depth;
  const backMat = new THREE.MeshStandardMaterial({ color: COLORS.goalPost, roughness: 0.6 });
  [x - width / 2, x + width / 2].forEach((px) => {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(postR * 0.7, postR * 0.7, height, 8), backMat);
    b.position.set(px, height / 2, backZ);
    group.add(b);
  });
  // Net (semi-transparent).
  const net = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.25 })
  );
  net.position.set(x, height / 2, backZ);
  group.add(net);

  scene.add(group);
  obstacles.push(group);
}

function buildSumoCircle(scene: THREE.Scene) {
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(SUMO.radius, 64),
    new THREE.MeshStandardMaterial({ color: COLORS.sumoFill, roughness: 1 })
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.set(SUMO.center.x, 0.02, SUMO.center.z);
  fill.receiveShadow = true;
  scene.add(fill);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(SUMO.radius - 0.35, SUMO.radius, 64),
    new THREE.MeshBasicMaterial({ color: COLORS.sumoRing, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(SUMO.center.x, 0.05, SUMO.center.z);
  scene.add(ring);
}

function buildBoundary(scene: THREE.Scene, physics: PhysicsWorld) {
  const wallH = 6;
  const t = 0.5;
  // Invisible tall colliders just inside the visible fence.
  const spots: { c: [number, number, number]; h: [number, number, number] }[] = [
    { c: [0, wallH / 2, -WALL_LIMIT], h: [WALL_LIMIT, wallH / 2, t] },
    { c: [0, wallH / 2, WALL_LIMIT], h: [WALL_LIMIT, wallH / 2, t] },
    { c: [-WALL_LIMIT, wallH / 2, 0], h: [t, wallH / 2, WALL_LIMIT] },
    { c: [WALL_LIMIT, wallH / 2, 0], h: [t, wallH / 2, WALL_LIMIT] },
  ];
  for (const w of spots) staticBox(physics, w.c, w.h);

  // Low visible fence around the park.
  const fenceMat = new THREE.MeshStandardMaterial({ color: COLORS.fence, roughness: 0.9 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0xa9855f, roughness: 0.9 });
  const L = WALL_LIMIT + 1;
  const postEvery = 6;
  for (let i = -L; i <= L; i += postEvery) {
    for (const [sx, sz] of [
      [i, -L],
      [i, L],
      [-L, i],
      [L, i],
    ] as [number, number][]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.3, 0.3), fenceMat);
      post.position.set(sx, 0.65, sz);
      post.castShadow = true;
      scene.add(post);
    }
  }
  // Top rails (4 long thin boxes).
  const railGeoX = new THREE.BoxGeometry(L * 2, 0.15, 0.15);
  const railGeoZ = new THREE.BoxGeometry(0.15, 0.15, L * 2);
  const rails: [THREE.BufferGeometry, number, number, number][] = [
    [railGeoX, 0, 1.1, -L],
    [railGeoX, 0, 1.1, L],
    [railGeoZ, -L, 1.1, 0],
    [railGeoZ, L, 1.1, 0],
  ];
  for (const [geo, x, y, z] of rails) {
    const rail = new THREE.Mesh(geo, railMat);
    rail.position.set(x, y, z);
    scene.add(rail);
  }
}

function buildTrees(scene: THREE.Scene) {
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.45, 2.4, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: COLORS.treeTrunk, roughness: 1 });
  const leafGeo = new THREE.IcosahedronGeometry(2.2, 0);
  const leafMat = new THREE.MeshStandardMaterial({ color: COLORS.treeLeaf, roughness: 1, flatShading: true });

  const R = WALL_LIMIT + 4;
  const count = 26;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const jitter = ((i * 928.7) % 7) - 3.5;
    const x = Math.cos(a) * (R + jitter);
    const z = Math.sin(a) * (R + jitter);
    const scale = 0.8 + ((i * 53) % 10) / 20;
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.set(x, 1.2 * scale, z);
    trunk.scale.setScalar(scale);
    trunk.castShadow = true;
    scene.add(trunk);
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    leaf.position.set(x, (2.4 + 1.2) * scale, z);
    leaf.scale.setScalar(scale);
    leaf.castShadow = true;
    scene.add(leaf);
  }
}

function buildClouds(scene: THREE.Scene) {
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.9 });
  for (let i = 0; i < 10; i++) {
    const group = new THREE.Group();
    const puffs = 3 + (i % 3);
    for (let p = 0; p < puffs; p++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(2 + (p % 2), 0), cloudMat);
      puff.position.set(p * 2.4 - puffs, ((p * 37) % 5) / 5, ((p * 91) % 4) - 2);
      group.add(puff);
    }
    const a = (i / 10) * Math.PI * 2;
    group.position.set(Math.cos(a) * 40, 26 + (i % 4) * 3, Math.sin(a) * 40);
    group.scale.setScalar(1.4);
    scene.add(group);
  }
}

// ---- line helpers (thin white boxes laid on the pitch) ----
function addLine(scene: THREE.Scene, x1: number, x2: number, z1: number, z2: number, y: number) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(len, 0.18),
    new THREE.MeshBasicMaterial({ color: COLORS.line })
  );
  line.rotation.x = -Math.PI / 2;
  line.rotation.z = -Math.atan2(dz, dx);
  line.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
  scene.add(line);
}

function addLineRect(scene: THREE.Scene, cx: number, cz: number, hw: number, hl: number, y: number) {
  addLine(scene, cx - hw, cx + hw, cz - hl, cz - hl, y);
  addLine(scene, cx - hw, cx + hw, cz + hl, cz + hl, y);
  addLine(scene, cx - hw, cx - hw, cz - hl, cz + hl, y);
  addLine(scene, cx + hw, cx + hw, cz - hl, cz + hl, y);
}

// ---- procedural textures ----
function makeSkyTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#3a86d6");
  g.addColorStop(0.55, "#7fc0ea");
  g.addColorStop(1, "#bfe4f5");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeGrassTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#6db24a";
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) {
    const shade = 60 + Math.floor(((i * 137) % 40));
    ctx.fillStyle = `rgba(${shade - 20},${shade + 40},${shade - 10},0.5)`;
    const x = (i * 53) % 128;
    const y = (i * 97) % 128;
    ctx.fillRect(x, y, 2, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GROUND_HALF, GROUND_HALF);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePitchTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const stripes = 8;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? "#4e9d3f" : "#57a846";
    ctx.fillRect(0, (i * 256) / stripes, 256, 256 / stripes);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
