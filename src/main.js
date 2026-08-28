import * as THREE from 'three';
import { scene, camera, renderer, GameTime, recordRenderTime } from './core/renderer.js';
import { FixedStepClock } from './core/frame-budget.js';
import { Settings } from './core/settings.js';
import { buildSkybox, loadSurfaceTextures } from './render/materials.js';
import { createLightBudget } from './render/lighting.js';
import { renderWithViewModel, shareViewModelLighting } from './render/viewmodel.js';
import { createWorldPresentation } from './render/world-presentation.js';
import { buildEnvironment, updateEnvironment } from './render/environment.js';
import { World, WorldState, Triggers, currentZone, ZONE_OBJECTIVES, triggersUpdate, ZoneCull, addLights, buildWorld, finalizeWorldSurfaces, animateFires, animateFlickerLights, animateSmoke } from './world/world.js';
import { Player, PlayerState, playerInit, playerUpdate, resetPlayerMotion } from './game/player.js';
import { Input } from './core/input.js';

import { HUD, IntroCard, EndCard, ObjectiveBanner, FPSMeter } from './ui/hud.js';
import { Weapons, WeaponDrops } from './game/weapons.js';
import { AmmoSupplies } from './game/ammo-supplies.js';
import { Enemies, EnemyPool, enemiesUpdate } from './game/enemies.js';
import {
  initMission, WaveDirector, HealPickups, StreetChoice, Endings,
  CHECKPOINTS, saveCheckpoint, restartFromZone,
} from './game/mission.js';
import { CombatStats } from './game/combat-stats.js';
import { ThreatFeedback } from './game/threat-feedback.js';
import { initNavigation, updateNavigation } from './game/navigation.js';
import { Blood, FX } from './render/effects.js';

const clock = new FixedStepClock();
let lightBudget;
let worldPresentation;
let controlledTest = false;
let inspecting = false;
let contextLost = false;
let previousTime = 0;
let wasPlaying = false;
let hudTimer = 0;

const renderWorld = () => worldPresentation ? worldPresentation.render() : renderer.render(scene, camera);

function isPlaying() {
  return Input.active && !PlayerState.dead && !IntroCard.isOpen()
    && !Endings.isResolved() && !document.hidden && !contextLost;
}

/** All gameplay advances on one bounded clock. Paused time is discarded. */
function stepFrame(realDt) {
  const steps = clock.advance(realDt, isPlaying());
  let progressed = 0;
  for (let step = 0; step < steps && isPlaying(); step++) {
    GameTime.elapsed += clock.step;
    Weapons.tick(clock.step);
    playerUpdate(clock.step);
    enemiesUpdate(clock.step);
    WaveDirector.update(clock.step);
    triggersUpdate();
    HealPickups.update(clock.step);
    StreetChoice.update(clock.step);
    Endings.update(clock.step);
    CombatStats.update(clock.step);
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
  renderWithViewModel(renderer, scene, camera, renderWorld);
}

function frame(now) {
  const realDt = previousTime ? (now - previousTime) / 1000 : 0;
  previousTime = now;
  Input.pollGamepad();
  if (controlledTest) return;
  const playing = isPlaying();
  if (!playing) {
    clock.advance(0, false);
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
  const textures = await loadSurfaceTextures();
  const failures = textures.filter(result => result.status === 'rejected');
  if (failures.length) console.warn('Some surface maps could not load; procedural materials remain available.');
  scene.background = buildSkybox();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(scene.background);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.8;
  pmrem.dispose();

  addLights();
  buildWorld();
  buildEnvironment();
  finalizeWorldSurfaces();
  worldPresentation = createWorldPresentation(renderer, scene, camera, { getQuality: () => Settings.get('quality') });
  const initial = CHECKPOINTS.apartment;
  Player.pos.set(initial.x, initial.y + Player.eyeHeight, initial.z);
  Player.yaw = initial.yaw;
  playerInit();
  Weapons.init();
  // The opening starts empty-handed. Weapons are earned from defeated foes.
  Weapons._equip('fists', 0);
  AmmoSupplies.init({ world: World, player: Player, canInteract: isPlaying });
  initMission();
  initNavigation();
  WeaponDrops._initHaloPool();
  ZoneCull.setActiveZone('apartment');
  lightBudget = createLightBudget(scene, ZoneCull);
  shareViewModelLighting(scene);
  lightBudget.update(camera);
  EnemyPool.init();
  Weapons.update(0);
  HUD.setObjective(ZONE_OBJECTIVES.apartment);
  render();

  const startButton = document.getElementById('startbutton');
  if (startButton) { startButton.disabled = false; startButton.textContent = 'BEGIN MISSION'; }
  document.dispatchEvent(new CustomEvent('game:ready'));
  renderer.setAnimationLoop(frame);

  // QA is visible, explicit, and excluded from production builds.
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV && params.get('qa') === '1') {
    const { installQA } = await import('./testing/qa.js');
    installQA({
      scene, World, renderer, camera, Player, PlayerState, Enemies, Weapons,
      stepFrame, render,
      setTesting(active) { controlledTest = active; clock.advance(0, false); previousTime = 0; },
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
      metrics: () => ({ zone: currentZone, lighting: lightBudget.snapshot(), pixelRatio: renderer.getPixelRatio(), presentation: worldPresentation.snapshot() }),
    });
  }
}

boot().catch(error => {
  console.error('Mission initialization failed:', error);
  const status = document.getElementById('loadstatus');
  if (status) status.textContent = 'The mission could not start. Reload the page; details are in the developer console.';
  const button = document.getElementById('startbutton');
  if (button) { button.disabled = true; button.textContent = 'UNABLE TO START'; }
});
