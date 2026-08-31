import * as THREE from 'three';
import './touch-controls.css';
import './installed-app.css';
import { scene, camera, renderer, GameTime, recordRenderTime } from './core/renderer.js';
import { FixedStepClock } from './core/frame-budget.js';
import { Settings, audioMixFromSettings } from './core/settings.js';
import { Audio } from './core/audio.js';
import { Ballistics } from './core/ballistics.js';
import { MATS, buildSkybox, loadSurfaceTextures, getSurfaceTextureStatus } from './render/materials.js';
import { createLightBudget } from './render/lighting.js';
import { createInteriorLighting } from './render/interior-lighting.js';
import { createInteriorReflections } from './render/interior-reflections.js';
import { createFocusedShadowBudget } from './render/shadow-budget.js';
import { createRoofTaskLighting } from './render/roof-task-lighting.js';
import { renderWithViewModel, shareViewModelLighting } from './render/viewmodel.js';
import { createWorldPresentation } from './render/world-presentation.js';
import { warmViewModels } from './render/viewmodel-prewarm.js';
import { warmCharacters } from './render/character-prewarm.js';
import { loadHeroFaceAlbedo, setHeroFaceTextureEnabled, getHeroFaceTextureStatus } from './render/hero-face-albedo.js';
import { buildEnvironment, finishEnvironmentMaterials, updateEnvironment } from './render/environment.js';
import { World, WorldState, Triggers, currentZone, ZONE_OBJECTIVES, triggersUpdate, ZoneCull, addLights, buildWorld, finalizeWorldSurfaces, animateFires, animateFlickerLights, animateSmoke } from './world/world.js';
import { Player, PlayerState, playerInit, playerUpdate, resetPlayerMotion } from './game/player.js';
import { Input } from './core/input.js';

import { HUD, IntroCard, EndCard, ObjectiveBanner, FPSMeter } from './ui/hud.js';
import { Weapons, WeaponDrops, WEAPON_DEFS } from './game/weapons.js';
import { AmmoSupplies } from './game/ammo-supplies.js';
import { ArmorPickups } from './game/armor-pickups.js';
import { Enemies, EnemyPool, enemiesUpdate } from './game/enemies.js';
import {
  initMission, WaveDirector, HealPickups, StreetChoice, Endings, FireHazards,
  CHECKPOINTS, saveCheckpoint, restartFromZone, startRun, DefenseDirector,
} from './game/mission.js';
import { CombatStats } from './game/combat-stats.js';
import { Rage } from './game/rage-rules.js';
import { RunSettings } from './game/run-settings.js';
import { HealthRegeneration } from './game/health-regeneration.js';
import { ThreatFeedback } from './game/threat-feedback.js';
import { initNavigation, updateNavigation } from './game/navigation.js';
import { Blood, FX } from './render/effects.js';

const clock = new FixedStepClock();
let lightBudget;
let interiorLighting;
let interiorReflections;
let focusedShadows;
let roofTaskLighting;
let worldPresentation;
let weaponWarmup = { status: 'pending' };
let characterWarmup = { status: 'pending' };
const graphicsStartup = {};
let surfaceDelivery;
let controlledTest = false;
let inspecting = false;
let contextLost = false;
let previousTime = 0;
let wasPlaying = false;
let hudTimer = 0;
const audioScene = {
  zone: 'apartment', threat: 0, paused: true, dead: false,
  listener: { position: camera.position, yaw: 0 },
};

function syncAudioSettings(settings = Settings.snapshot()) {
  // Preferences never grant permission to unmute or start an audio device.
  Audio.setMix(audioMixFromSettings(settings));
  Audio.setVoiceEnabled(settings.checkpointVoice);
}
syncAudioSettings();
document.addEventListener('settingschange', event => syncAudioSettings(event.detail));

const renderWorld = () => worldPresentation ? worldPresentation.render() : renderer.render(scene, camera);

function isPlaying() {
  return (RunSettings.isStarted() || controlledTest) && Input.active && !PlayerState.dead && !IntroCard.isOpen()
    && !Endings.isResolved() && !DefenseDirector.isResolved() && !document.hidden && !contextLost;
}

document.addEventListener('game:runstart', () => {
  startRun();
  clock.advance(0, false);
  previousTime = 0;
  inspecting = false;
  render();
});

function syncTouchContext() {
  Input.setTouchContext({
    canAim: !PlayerState.dead && Weapons.def().kind === 'ranged',
    canRage: !PlayerState.dead && Rage.available(Player),
  });
}

function updateAudioScene(dt) {
  audioScene.zone = currentZone;
  audioScene.listener.yaw = Player.yaw;
  audioScene.paused = !isPlaying();
  audioScene.dead = PlayerState.dead;
  // Nearby active contacts raise the pulse gently. No polling timer, scene
  // traversal, or hidden-tab time can advance the score outside simulation.
  let pressure = 0;
  for (const enemy of Enemies.list) {
    if (!enemy.alive) continue;
    const distance = Math.hypot(enemy.pos.x - Player.pos.x, enemy.pos.y - Player.pos.y, enemy.pos.z - Player.pos.z);
    if (distance < 28) pressure += (1 - distance / 28) * (enemy.state === 'attack' ? 0.42 : 0.22);
  }
  audioScene.threat = Math.min(1, pressure);
  Audio.tick(dt, audioScene);
}

/** All gameplay advances on one bounded clock. Paused time is discarded. */
function stepFrame(realDt) {
  const steps = clock.advance(realDt, isPlaying());
  let progressed = 0;
  for (let step = 0; step < steps && isPlaying(); step++) {
    GameTime.elapsed += clock.step;
    // Expire rage before this step's attacks: a late kill cannot secure it.
    const healthBeforeRage = Player.health;
    Rage.update(clock.step, Player);
    if (Player.health !== healthBeforeRage) HUD.setHealth(Player.health);
    Weapons.tick(clock.step);
    syncTouchContext();
    playerUpdate(clock.step);
    DefenseDirector.containPlayer();
    FireHazards.update(clock.step);
    if (PlayerState.dead) {
      // Lethal contact cannot collect a supply or commit a checkpoint/ending.
      HUD.update(clock.step);
      progressed += clock.step;
      continue;
    }
    enemiesUpdate(clock.step);
    if (PlayerState.dead) continue;
    if (RunSettings.snapshot().mode === 'defense') DefenseDirector.update(clock.step);
    else {
      WaveDirector.update(clock.step);
      triggersUpdate();
    }
    HealPickups.update(clock.step);
    ArmorPickups.update(clock.step);
    if (RunSettings.snapshot().mode !== 'defense') {
      StreetChoice.update(clock.step);
      Endings.update(clock.step);
    }
    if (HealthRegeneration.update(clock.step, Player, RunSettings.profile)) HUD.setHealth(Player.health);
    CombatStats.update(clock.step);
    const rageOutcome = Rage.takeOutcome();
    if (rageOutcome === 'secured') HUD.message('RAGE SECURED · BONUS HEALTH KEPT', 2.5);
    else if (rageOutcome === 'expired') HUD.message('RAGE ENDED · HEALTH RESTORED TO STARTING VALUE', 2.5);
    HUD.update(clock.step);
    progressed += clock.step;
  }
  if (progressed > 0) {
    animateFires(GameTime.elapsed, progressed);
    animateFlickerLights(GameTime.elapsed);
    animateSmoke(progressed);
    updateEnvironment(progressed, GameTime.elapsed);
    Blood.update(progressed);
    FX.update(progressed);
    Weapons.update(progressed);
    HUD.setRage({ ...Rage.snapshot(Player), gamepad: Input.gamepadConnected });
    if (isPlaying()) ThreatFeedback.update(progressed, Enemies.list);
    else ThreatFeedback.clear();
    ObjectiveBanner.update(GameTime.elapsed);
    updateNavigation(progressed);
    hudTimer -= progressed;
    if (hudTimer <= 0) {
      HUD.setCombat?.(CombatStats.snapshot());
      HUD.setCompass?.(Player.yaw);
      hudTimer = 0.10;
    }
  }
  syncTouchContext();
  updateAudioScene(progressed);
  return progressed;
}

function render() {
  if (contextLost) return;
  // One-way fire gates are created during progression, after initial lighting.
  for (const fire of WorldState.fires) lightBudget?.register(fire.light);
  lightBudget?.update(camera);
  if (inspecting) {
    Weapons.update(0);
    HUD.setCompass?.(Player.yaw);
    updateNavigation(0);
  }
  focusedShadows?.update(camera, renderer.shadowMap.enabled);
  renderWithViewModel(renderer, scene, camera, renderWorld);
}

function frame(now) {
  const realDt = previousTime ? (now - previousTime) / 1000 : 0;
  previousTime = now;
  Input.pollGamepad();
  syncTouchContext();
  if (controlledTest) return;
  const playing = isPlaying();
  if (!playing) {
    clock.advance(0, false);
    if (wasPlaying) updateAudioScene(0);
    if (wasPlaying || inspecting) render();
    wasPlaying = false;
    return;
  }
  // The first resumed frame starts a fresh clock; no hidden-tab catch-up.
  const dt = wasPlaying ? realDt : 0;
  wasPlaying = true;
  stepFrame(dt);
  FPSMeter.tick(now / 1000, realDt);
  recordRenderTime(realDt);
  render();
}

document.addEventListener('game:contextlost', () => {
  contextLost = true;
  Input.pause();
  HUD.message('GRAPHICS CONTEXT LOST — RELOAD TO RESTORE THE MISSION', 60);
  const status = document.getElementById('loadstatus');
  if (status) status.textContent = 'Graphics interrupted. Reload this page to recover.';
});

async function boot() {
  const bootStarted = performance.now();
  const [textures] = await Promise.all([loadSurfaceTextures(), loadHeroFaceAlbedo()]);
  surfaceDelivery = getSurfaceTextureStatus();
  setHeroFaceTextureEnabled(true);
  graphicsStartup.surfaceMapsMs = performance.now() - bootStarted;
  const failures = textures.filter(result => result.status === 'rejected');
  if (failures.length) console.warn('Some surface maps could not load; procedural materials remain available.');
  scene.background = buildSkybox();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(scene.background);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.8;
  pmrem.dispose();

  const worldStarted = performance.now();
  const worldLight = addLights();
  buildWorld();
  buildEnvironment();
  roofTaskLighting = createRoofTaskLighting(World, { roofMeshes: ZoneCull.byZone.roof, metalMaterial: MATS.roofMetal });
  finalizeWorldSurfaces();
  // Custom roof finishes must follow structural face ownership: the clipping
  // pass deliberately rejects arbitrary shader hooks on unfinished geometry.
  finishEnvironmentMaterials();
  graphicsStartup.worldBuildMs = performance.now() - worldStarted;
  try {
    interiorLighting = await createInteriorLighting(World, { zoneMeshes: ZoneCull.byZone });
  } catch (error) {
    console.warn('Static interior lighting was unavailable; live lighting remains enabled.', error);
  }
  worldPresentation = createWorldPresentation(renderer, scene, camera, { getQuality: () => Settings.get('quality') });
  const initial = CHECKPOINTS.apartment;
  Player.pos.set(initial.x, initial.y + Player.eyeHeight, initial.z);
  Player.yaw = initial.yaw;
  playerInit();
  Weapons.init();
  // The opening starts empty-handed. Weapons are earned from defeated foes.
  Weapons._equip('fists', 0);
  AmmoSupplies.init({ world: World, player: Player, canInteract: isPlaying });
  ArmorPickups.init({
    world: World, player: Player, canCollect: isPlaying,
    onCollect(pickup) {
      HUD.setArmor(Player.armor);
      HUD.message('VEST EQUIPPED · ' + Math.round(Player.armor) + '% ARMOR', 1.6);
      Audio.pickupChime({ kind: 'armor', environment: pickup.zone ?? currentZone });
    },
  });
  // Build once from final world triangles, before NPC rigs and pickup halos.
  // Generous movement barriers must never fill visible gaps between railings.
  Ballistics.rebuild(World);
  initMission();
  initNavigation();
  WeaponDrops._initHaloPool();
  ZoneCull.setActiveZone('apartment');
  lightBudget = createLightBudget(scene, ZoneCull);
  shareViewModelLighting(scene);
  lightBudget.update(camera);
  try {
    interiorReflections = await createInteriorReflections(renderer, scene, World, {
      zoneMeshes: ZoneCull.byZone, interiorLighting, lightBudget,
    });
  } catch (error) {
    console.warn('Interior reflection capture was unavailable; the sky environment remains enabled.', error);
  }
  EnemyPool.init();
  focusedShadows = createFocusedShadowBudget(worldLight.directional, worldLight.bounds, {
    casterRoot: scene, receiverFloor: -2.2,
  });
  Weapons.update(0);
  const characterStart = performance.now();
  try {
    const characters = [];
    World.traverse(object => { if (object.userData.rig?.visualMeshes) characters.push(object); });
    characterWarmup = await warmCharacters(renderer, scene, camera, characters);
    characterWarmup.elapsedMs = performance.now() - characterStart;
  } catch (error) {
    characterWarmup = { status: 'fallback', elapsedMs: performance.now() - characterStart };
    console.warn('Character graphics warmup was unavailable; normal first-use rendering remains enabled.', error);
  }
  // Prepare cached geometry, textures and shaders before the first pickup.
  // The loading menu still covers the canvas and no simulation is running.
  const warmupStart = performance.now();
  try {
    const models = Object.values(WEAPON_DEFS).map(definition => Weapons._vm(definition.vm));
    weaponWarmup = await warmViewModels(renderer, scene, camera, models, { basePosition: Weapons.basePos });
    weaponWarmup.elapsedMs = performance.now() - warmupStart;
  } catch (error) {
    weaponWarmup = { status: 'fallback', elapsedMs: performance.now() - warmupStart };
    console.warn('Weapon graphics warmup was unavailable; normal first-use rendering remains enabled.', error);
  }
  HUD.setObjective(ZONE_OBJECTIVES.apartment);
  render();
  graphicsStartup.readyMs = performance.now() - bootStarted;

  const startButton = document.getElementById('startbutton');
  if (startButton) { startButton.disabled = false; startButton.textContent = 'BEGIN MISSION'; }
  document.dispatchEvent(new CustomEvent('game:ready'));
  renderer.setAnimationLoop(frame);

  // QA is visible, explicit, and excluded from production builds.
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV && params.get('qa') === '1') {
    const [{ installQA }, { createGpuFrameTimer }, { installDifficultyQA }] = await Promise.all([
      import('./testing/qa.js'), import('./core/gpu-frame-timer.js'), import('./testing/difficulty-qa.js'),
    ]);
    const gpuTimer = createGpuFrameTimer(renderer.getContext(), { sampleWindow: 2048 });
    const qaApi = {
      scene, World, renderer, camera, Player, PlayerState, Enemies, Weapons,
      stepFrame, gpuTimer,
      render() {
        gpuTimer.begin();
        try { render(); }
        finally { gpuTimer.end(); }
      },
      setTesting(active) { controlledTest = active; clock.advance(0, false); previousTime = 0; },
      setInteriorLightingEnabled(enabled) { interiorLighting?.setEnabled(enabled); },
      setInteriorReflectionsEnabled(enabled) { interiorReflections?.setEnabled(enabled); },
      setHeroFaceTextureEnabled,
      setFocusedShadowsEnabled(enabled) { focusedShadows?.setEnabled(enabled); },
      setRoofTaskLightingEnabled(enabled) {
        for (const mesh of roofTaskLighting?.setEnabled(enabled) ?? []) Ballistics.updateObject(mesh);
      },
      setInspection(active) {
        inspecting = active;
        if (active) {
          Input.pause({ showOverlay: false });
          document.getElementById('overlay').classList.add('hidden');
          IntroCard.dismiss({ engage: false });
          HUD.showDeath(false);
          EndCard.hide();
        }
        render();
      },
      resetToApartment() {
        Input.pause({ showOverlay: false });
        DefenseDirector.reset();
        RunSettings.reset();
        HealthRegeneration.reset();
        Triggers.reset();
        Endings.reset(); StreetChoice.reset(); WaveDirector.reset();
        AmmoSupplies.reset();
        Weapons.restore({ current: 'fists', loaded: 0, reserve: 0 });
        saveCheckpoint('apartment');
        const restored = restartFromZone();
        CombatStats.reset();
        resetPlayerMotion();
        Weapons.update(0);
        inspecting = true;
        document.getElementById('overlay').classList.add('hidden');
        render();
        return restored;
      },
      metrics: () => ({ zone: currentZone, lighting: lightBudget.snapshot(), pixelRatio: renderer.getPixelRatio(),
        presentation: worldPresentation.snapshot(), weaponWarmup, characterWarmup,
        interiorLighting: interiorLighting?.snapshot(), focusedShadows: focusedShadows?.snapshot(),
        interiorReflections: interiorReflections?.snapshot(),
        roofTaskLighting: roofTaskLighting?.snapshot(),
        heroFace: getHeroFaceTextureStatus(),
        surfaceDelivery,
        startup: graphicsStartup }),
    };
    installQA(qaApi);
    installDifficultyQA(qaApi);
  }
}

boot().catch(error => {
  console.error('Mission initialization failed:', error);
  const status = document.getElementById('loadstatus');
  if (status) status.textContent = 'The mission could not start. Reload the page; details are in the developer console.';
  const button = document.getElementById('startbutton');
  if (button) { button.disabled = true; button.textContent = 'UNABLE TO START'; }
});
