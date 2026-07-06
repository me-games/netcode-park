import "./style.css";
import * as THREE from "three";

// --- Genex identity + crash reporting: the very first thing that runs ---
import { initGameSentry, sentryCanvasSnapshot } from "@genex-ai/embed-sdk/sentry";
import { initEmbed, waitForPlayer, getColyseusAuth } from "@genex-ai/embed-sdk";
import { GENEX } from "./genex.config.ts";
import { connect, type Session } from "@genex-ai/multiplayer";

import { PhysicsWorld } from "./controllers/shared/physics-world.ts";
import { CharacterController } from "./controllers/character/character-controller.ts";
import { characterPresets } from "./controllers/character/presets.ts";
import { FollowCamera } from "./controllers/character/follow-camera.ts";
import { KeyboardInput } from "./controllers/character/keyboard-input.ts";
import { EnterExitManager, CHARACTER_ID, type PromptTarget } from "./controllers/interact/enter-exit.ts";
import { buildCar, buildDrone, VehicleNet } from "./vehicles.ts";
import { Persistence } from "./persistence.ts";

import { buildWorld } from "./world.ts";
import { createLocalAvatar, makeEmoteBubble } from "./avatar.ts";
import { RemotePlayers } from "./remotePlayers.ts";
import { Hud } from "./hud.ts";
import { NetBall } from "./ball.ts";
import { NetCrate } from "./crate.ts";
import { awardPoint, scoreRows } from "./scores.ts";
import { unlockAudio, sfxKick, sfxWhistle, sfxCheer } from "./sfx.ts";
import { PLAYER_SPAWN, CAR_SPAWN, CAR2_SPAWN, DRONE_SPAWN } from "./layout.ts";
import { colorForId, type PlayerNet } from "./netstate.ts";

initGameSentry({ slug: GENEX.slug });
initEmbed({ slug: GENEX.slug, apiUrl: GENEX.apiUrl, dashboardOrigins: GENEX.dashboardOrigins });

const WAVE = "👋";

async function main() {
  // ---------- Renderer / scene / camera ----------
  const app = document.querySelector<HTMLDivElement>("#app")!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  app.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 320);
  camera.position.set(0, 6, 16);

  const clock = new THREE.Clock();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- Physics + world ----------
  const physics = await PhysicsWorld.create();
  const world = buildWorld(scene, physics);

  // ---------- Local player ----------
  const { model, vrm, anims, fit } = await createLocalAvatar();
  const character = new CharacterController(physics.world, camera, {
    ...characterPresets["default"].options,
    ...fit,
    position: { x: PLAYER_SPAWN.x, y: PLAYER_SPAWN.y, z: PLAYER_SPAWN.z },
    userData: { controller: { excludeVehicleRay: true } },
  });
  scene.add(character.root);
  character.root.add(model);
  model.position.y = fit.modelOffsetY;
  physics.registerBody(character.body, character.root);

  const FEET_DROP = fit.capsuleHalfHeight + fit.capsuleRadius + 0.2;

  // Emote bubble that floats over my own avatar.
  const myBubble = makeEmoteBubble(WAVE);
  myBubble.position.y = 2.9 + fit.modelOffsetY; // above the head, relative to capsule centre
  myBubble.visible = false;
  character.root.add(myBubble);
  let myBubbleUntil = 0;

  const kb = new KeyboardInput();
  const followCam = new FollowCamera(camera, {
    domElement: renderer.domElement,
    colliderMeshes: world.cameraObstacles as THREE.Mesh[],
  });

  // ---------- Vehicles ----------
  const car = buildCar(physics, scene);
  const car2 = buildCar(physics, scene, { spawn: CAR2_SPAWN, color: 0x2c6fb5 }); // the blue kart
  const { drone, chassis: droneChassis, body: droneBody } = buildDrone(physics, scene);
  const carNet = new VehicleNet("car", car, car.body, car.chassisObject, CAR_SPAWN, physics);
  const car2Net = new VehicleNet("car2", car2, car2.body, car2.chassisObject, CAR2_SPAWN, physics);
  const droneNet = new VehicleNet("drone", drone, droneBody, droneChassis, DRONE_SPAWN, physics);
  const vehNets: Record<string, VehicleNet> = { car: carNet, car2: car2Net, drone: droneNet };
  const allNets = [carNet, car2Net, droneNet];
  let myMode = 0; // 0 foot · 1 car-type · 2 drone
  let myVeh = ""; // vehicle object id I'm in ("car" | "car2" | "drone"), "" on foot
  let currentPrompt: PromptTarget | null = null;

  // ---------- Persistence (car/drone parked positions) ----------
  const persistence = new Persistence();
  let worldLoaded = false;
  let worldLoading = false;
  async function ensureWorldLoaded() {
    if (worldLoaded || worldLoading || !room || !room.isHost) return;
    worldLoading = true;
    const data = await persistence.load();
    // Only seed from the save when the world is fresh (no live vehicle yet);
    // on host migration the live pose already on the wire wins.
    if (data?.car && room && room.objects.get("car") === undefined) carNet.applyPersistedPose(data.car);
    if (data?.car2 && room && room.objects.get("car2") === undefined) car2Net.applyPersistedPose(data.car2);
    if (data?.drone && room && room.objects.get("drone") === undefined) droneNet.applyPersistedPose(data.drone);
    worldLoaded = true;
    worldLoading = false;
  }
  let lastSaved = "";
  function maybeSaveWorld() {
    if (!room || !room.isHost || !worldLoaded) return;
    const snapshot = { car: carNet.restingPose, car2: car2Net.restingPose, drone: droneNet.restingPose };
    const json = JSON.stringify(snapshot);
    if (json !== lastSaved) {
      lastSaved = json;
      persistence.save(snapshot);
    }
  }

  const mgr = new EnterExitManager({
    world: physics.world,
    character,
    applyCharacterInput: () => character.setMovement(kb.getCharacterMovement()),
    onPromptChange: (target) => (currentPrompt = target),
    onHandoff: (fromId, toId) => handleHandoff(fromId, toId),
  });
  mgr.registerVehicle({
    id: "car",
    label: "Car",
    vehicle: car,
    exitAxis: "bodyX",
    exitLength: 2.4,
    sensor: { kind: "cylinder", halfHeight: 0.6, radius: 3, offset: { x: 0, y: 0.1, z: 0 } },
    applyInput: () => car.setMovement(kb.getCarMovement()),
  });
  mgr.registerVehicle({
    id: "car2",
    label: "Blue Car",
    vehicle: car2,
    exitAxis: "bodyX",
    exitLength: 2.4,
    sensor: { kind: "cylinder", halfHeight: 0.6, radius: 3, offset: { x: 0, y: 0.1, z: 0 } },
    applyInput: () => car2.setMovement(kb.getCarMovement()),
  });
  mgr.registerVehicle({
    id: "drone",
    label: "Drone",
    vehicle: drone,
    exitAxis: "up",
    exitLength: 1.8,
    sensor: { kind: "ball", radius: 3 },
    applyInput: () => drone.setMovement(kb.getDroneMovement()),
    onOccupantEnter: () => drone.setControlMode("VELOCITY"),
    onOccupantExit: () => {
      drone.setTarget(drone.currPos, drone.bodyZAxis);
      drone.setControlMode("POSITION");
    },
  });
  physics.onCollisionEvent((h1, h2, started) => mgr.handleIntersectionEvent(h1, h2, started));

  function handleHandoff(fromId: string, toId: string) {
    if (!room) return;
    if (toId !== CHARACTER_ID) {
      myMode = toId === "drone" ? 2 : 1;
      myVeh = toId;
      vehNets[toId].beginDrive(room);
    } else {
      const v = vehNets[fromId];
      v.endDrive(room);
      myMode = 0;
      myVeh = "";
      if (fromId === "drone") {
        drone.setMovement({
          throttleUp: false,
          throttleDown: false,
          yawLeft: false,
          yawRight: false,
          pitchForward: false,
          pitchBackward: false,
          rollLeft: false,
          rollRight: false,
        });
      } else {
        const exited = fromId === "car2" ? car2 : car;
        exited.setMovement({ forward: false, backward: false, steerLeft: false, steerRight: false, brake: false });
      }
    }
  }

  function vehicleTakenByOther(vid: string): boolean {
    if (!room) return false;
    const wantMode = vid === "drone" ? 2 : 1;
    for (const [id, p] of room.players) {
      if (id === room.id) continue;
      const raw = p.stateRaw;
      // Prefer the explicit vehicle id (0.2+ bundles); fall back to mode for old peers.
      const inIt = typeof raw?.veh === "string" && raw.veh ? raw.veh === vid : (raw?.mode ?? 0) === wantMode;
      if (inIt) return true;
    }
    return false;
  }

  // Controller brains run inside the fixed physics substep, AFTER the manager
  // routes input to whichever unit is active.
  physics.onBeforeStep(() => {
    const dt = physics.timeStep;
    mgr.update(dt);
    if (!character.isParked) character.update(dt);
    if (carNet.driving) car.update(dt);
    if (car2Net.driving) car2.update(dt);
    if (droneNet.driving) drone.update(dt);
  });

  // ---------- Dynamic props ----------
  const ball = new NetBall(scene);
  const crate = new NetCrate(scene, physics);

  // ---------- HUD ----------
  const hud = new Hud();
  hud.setConnection("connecting");
  hud.setHint(
    `<b>WASD</b> move · <b>Shift</b> run · <b>Space</b> jump · <b>Q</b> wave 👋 · <b>E</b> enter car/drone · kick the ball · shove the crate · drag to look`
  );

  // ---------- Multiplayer ----------
  const remotes = new RemotePlayers(scene);
  let room: Session<PlayerNet> | null = null;
  let myName = "You";

  function refreshPresence() {
    if (!room) return;
    const rows = [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.id === room!.id ? myName : p.name || "Player",
      color: colorForId(p.id),
      isHost: room!.host === p.id,
      isMe: p.id === room!.id,
    }));
    // Put me first, then hosts, then others.
    rows.sort((a, b) => Number(b.isMe) - Number(a.isMe) || Number(b.isHost) - Number(a.isHost));
    hud.setPresence(rows);
  }

  async function joinRoom() {
    const { user } = await waitForPlayer();
    myName = user.name || "You";
    hud.setConnection("connecting");

    const r = await connect<PlayerNet>({
      url: GENEX.colyseusUrl,
      room: GENEX.slug,
      name: myName,
      auth: getColyseusAuth()!,
    });
    room = r;
    hud.setConnection("online");
    hud.resetRejoinButton();
    refreshPresence();

    r.on("join", () => refreshPresence());
    r.on("change", () => refreshPresence());
    r.on("leave", (id) => {
      remotes.remove(id);
      refreshPresence();
    });
    r.on("host", () => refreshPresence());

    r.on("reconnecting", (info) => {
      hud.setConnection("reconnecting");
      hud.setReconnectAttempt(info.attempt);
    });
    r.on("reconnected", () => {
      hud.setConnection("online");
      hud.toast("Reconnected");
    });
    r.on("disconnect", () => {
      room = null;
      remotes.dispose();
      for (const net of allNets) net.bailOut();
      myMode = 0;
      myVeh = "";
      hud.setConnection("lost");
    });

    r.on("emote", (payload) => {
      const p = payload as { from?: string; emoji?: string };
      if (p?.from) remotes.emote(p.from, p.emoji || WAVE, performance.now());
    });

    // Goal + sumo announcements (host broadcasts; everyone celebrates).
    r.on("goal", (payload) => {
      const p = payload as { name?: string };
      hud.toast(`⚽ Goal! ${p?.name || "Someone"} scores!`);
      sfxWhistle();
      sfxCheer();
    });
    r.on("sumo", (payload) => {
      const p = payload as { name?: string };
      hud.toast(`💥 ${p?.name || "Someone"} shoved the crate out!`);
      sfxCheer();
    });

    // The crate's host-authoritative input channel.
    crate.bindInputs(r);

    // The relay warns before a deploy — flush pending saves right now.
    r.on("server:restart", () => {
      persistence.flush();
      hud.toast("Server updating — saving & holding tight…");
    });
  }

  hud.onRejoin(() => {
    joinRoom().catch((e) => {
      console.error("[rejoin]", e);
      hud.resetRejoinButton();
    });
  });

  // First connection (don't let a failure kill the render loop).
  joinRoom().catch((e) => {
    console.error("[connect]", e);
    hud.setConnection("lost");
  });

  // ---------- Emote input (Q) ----------
  window.addEventListener("pointerdown", unlockAudio, { once: false });
  window.addEventListener("keydown", (e) => {
    unlockAudio();
    if (e.repeat) return;
    if (e.code === "KeyQ") {
      myBubble.visible = true;
      myBubbleUntil = performance.now() + 2500;
      room?.send("emote", { from: room.id, emoji: WAVE });
    }
    if (e.code === "KeyE") {
      if (mgr.activeControllerId !== CHARACTER_ID) {
        mgr.requestInteract(); // step out — always allowed
      } else if (currentPrompt) {
        if (vehicleTakenByOther(currentPrompt.id)) hud.toast(`That ${currentPrompt.label.toLowerCase()} is in use`);
        else mgr.requestInteract();
      }
    }
  });

  // ---------- Publish my state on a fixed ~15 Hz tick ----------
  const r2 = (v: number) => Math.round(v * 100) / 100;
  let lastScoresJson = "";
  setInterval(() => {
    if (!room) return;
    const p = character.currPos;
    const q = character.currQuat;
    room.me.set({
      x: r2(p.x),
      y: r2(p.y - FEET_DROP),
      z: r2(p.z),
      q: [r2(q.x), r2(q.y), r2(q.z), r2(q.w)],
      mode: myMode,
      veh: myVeh,
      g: character.isOnGround,
      f: character.isFalling,
      m: character.isMoving,
      r: character.runActive,
      j: character.jumpActive,
    });

    // Shared props: publish what I own, deliver my crate push.
    ball.ensureInit(room);
    ball.publish(room);
    crate.publishPush(room);
    crate.publish(room);
    void ensureWorldLoaded();
    for (const net of allNets) net.publish(room, worldLoaded);
    maybeSaveWorld();

    // Scoreboard (re-render only when it actually changes).
    const rows = scoreRows(room);
    const json = JSON.stringify(rows);
    if (json !== lastScoresJson) {
      lastScoresJson = json;
      hud.setScores(rows);
    }
  }, 66);

  // ---------- Render loop ----------
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    const now = performance.now();

    // Shared props BEFORE the physics step (the crate proxy must be positioned
    // so the character collides with it this step).
    if (room) {
      const feet = character.currPos;
      const onFoot = !character.isParked;

      if (ball.tryKick(room, feet, character.isMoving && onFoot, character.runActive)) sfxKick();
      ball.update(room, dt);
      const ballScorer = ball.checkGoal(room);
      if (ballScorer) {
        const nm = ballScorer === room.id ? myName : room.players.get(ballScorer)?.name || "Someone";
        awardPoint(room, ballScorer, nm);
        ball.resetToCenter(room);
        room.send("goal", { name: nm });
        hud.toast(`⚽ Goal! ${ballScorer === room.id ? "You" : nm} scored!`);
        sfxWhistle();
        sfxCheer();
      }

      crate.sensePush(feet, character.isMoving, onFoot);
      const crateScorer = crate.update(room, dt);
      if (crateScorer) {
        const nm = crateScorer === room.id ? myName : room.players.get(crateScorer)?.name || "Someone";
        awardPoint(room, crateScorer, nm);
        room.send("sumo", { name: nm });
        hud.toast(`💥 ${crateScorer === room.id ? "You" : nm} shoved the crate out!`);
        sfxCheer();
      }

      // Vehicles I don't drive follow the network; bail if I lost my seat.
      for (const net of allNets) net.followerSync(room);
      if (allNets.some((net) => net.lostSeat(room!))) mgr.requestInteract();
    } else {
      for (const net of allNets) net.holdResting();
    }

    physics.step(dt);

    // Follow camera tracks whatever unit is active (character or vehicle).
    const camT = mgr.cameraTarget;
    followCam.moveTo(camT.x, camT.y, camT.z, true);
    followCam.setUp(mgr.cameraUp);
    if (mgr.activeControllerId === CHARACTER_ID) {
      if (physics.stepsLastFrame > 0 && character.isOnPlatform) {
        followCam.applyPlatformTurn(character.turnOnYQuat);
      }
    } else if (mgr.activeVehicle) {
      followCam.alignHeading(mgr.activeVehicle.bodyZAxis, dt);
    }
    followCam.update(dt);

    // Local animation.
    anims.update(character, dt);
    vrm.update(dt);
    if (myBubble.visible && now > myBubbleUntil) myBubble.visible = false;

    // Prompt ("Press E …") — refresh only when the text changes.
    updatePrompt();

    // Remote players.
    if (room) remotes.update(room, dt, now);

    renderer.render(scene, camera);
    sentryCanvasSnapshot(renderer.domElement);
  });

  let lastPromptHtml = "";
  function updatePrompt() {
    let html: string;
    if (mgr.activeControllerId !== CHARACTER_ID) {
      html = `<kbd>E</kbd> Step out`;
    } else if (currentPrompt) {
      html = vehicleTakenByOther(currentPrompt.id)
        ? `${currentPrompt.label} is in use`
        : `<kbd>E</kbd> Enter ${currentPrompt.label}`;
    } else {
      html = "";
    }
    if (html !== lastPromptHtml) {
      lastPromptHtml = html;
      hud.setPrompt(html || null);
    }
  }
}

main().catch((err) => {
  console.error("[fatal boot]", err);
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-family:system-ui;padding:24px;text-align:center";
  el.textContent = "Something went wrong starting the game. Please refresh.";
  document.body.appendChild(el);
});
