import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { HEALTH_SUPPLIES } from '../../../src/game/health-supply-data.js';
import { ZONE_WAVE_CONFIG } from '../../../src/game/mission-data.js';
import { createHealthPickupModel } from '../../../src/render/health-pickup-model.js';
import { createFireHazards } from '../../../src/game/fire-hazards.js';

const missionSource = readFileSync(new URL('../../../src/game/mission.js', import.meta.url), 'utf8');

function actualBlock(startMarker, endMarker) {
  const start = missionSource.indexOf(startMarker);
  const end = missionSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Keep the actual health harness boundaries current: ${startMarker}`);
  return missionSource.slice(start, end);
}

const pickupSource = actualBlock('const HealPickups = (() => {', '\nconst StreetChoice =');
const initializationSource = actualBlock('function initMission()', '\nfunction getMissionState()');
assert.match(pickupSource, /\}\)\(\);\s*$/);
assert.match(initializationSource, /HealPickups\.spawn\(/);

/**
 * Production health geometry, collection and initialization code. Surrounding
 * mission services and presentation are explicit recording sinks: this creates
 * no browser, renderer, audio context, event listeners or live input handlers.
 */
export function createHealthPickupHarness() {
  const World = new THREE.Group();
  const Player = { pos: new THREE.Vector3(0, 5.72, 0), _eyeH: 1.72, health: 100 };
  const PlayerState = { dead: false }, GameTime = { elapsed: 0 };
  const calls = {
    health: [], messages: [], chimes: 0, zoneListeners: [], ammoZones: [],
    checkpoints: [], waves: [], domEvents: [], windowEvents: [],
    restartRequests: 0, pointerLockRequests: 0,
  };
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => 0.5;
  const button = {
    addEventListener(type, callback) { calls.domEvents.push({ id: 'restartbutton', type, callback }); },
  };
  const api = runInNewContext(`let initialized = false;\n${pickupSource}\n${initializationSource}\n`
    + ';({ HealPickups, initMission });', {
    THREE, World, Player, PlayerState, GameTime, Math: deterministicMath, HEALTH_SUPPLIES, ZONE_WAVE_CONFIG, createHealthPickupModel,
    FireHazards: null, createFireHazards, WorldState: { fires: [] }, Colliders: { list: [] },
    HUD: {
      setHealth(value) { calls.health.push(value); },
      message(...values) { calls.messages.push(values); },
    },
    Audio: { pickupChime() { calls.chimes++; } },
    onZoneChange(callback) { calls.zoneListeners.push(callback); },
    handleZoneChange() {},
    AmmoSupplies: { setZone(zone) { calls.ammoZones.push(zone); } },
    saveCheckpoint(zone) { calls.checkpoints.push(zone); },
    WaveDirector: { start(zone) { calls.waves.push(zone); } },
    document: { getElementById: id => id === 'restartbutton' ? button : null },
    addEventListener(type, callback) { calls.windowEvents.push({ type, callback }); },
    restartFromZone() { calls.restartRequests++; return true; },
    engageLock() { calls.pointerLockRequests++; },
  }, { filename: 'src/game/mission.js:health-pickups' });
  return { ...api, World, Player, PlayerState, GameTime, calls };
}
