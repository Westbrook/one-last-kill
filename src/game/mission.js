import * as THREE from 'three';
import { camera, GameTime } from '../core/renderer.js';
import { Audio } from '../core/audio.js';
import { Input, engageLock } from '../core/input.js';
import { Colliders, capsuleHasClearance } from '../core/collision.js';
import { Player, PlayerState, resetPlayerMotion } from './player.js';
import { HUD, ObjectiveBanner, EndCard } from '../ui/hud.js';
import { World, currentZone, zoneChanged, onZoneChange, ZoneCull } from '../world/world.js';
import { Enemies, isBlocked, primeEnemyInvestigation } from './enemies.js';
import { Weapons, WeaponDrops } from './weapons.js';
import { AmmoSupplies } from './ammo-supplies.js';
import { ArmorPickups } from './armor-pickups.js';
import { applyArmorDamage, clampArmor } from './armor-rules.js';
import { Rage } from './rage-rules.js';
import {
  CHECKPOINTS, ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS,
  createCheckpoint,
} from './mission-data.js';
import { EncounterSchedule, EncounterRouteProgress } from './encounter-rules.js';
import { selectEncounterSpawn, selectEncounterFrontPair } from './encounter-spawns.js';
import { EncounterSeeds } from './encounter-session.js';
import { HEALTH_SUPPLIES } from './health-supply-data.js';
import { isSegmentOccluded } from './combat-rules.js';
import { readThreatView, ThreatFeedback } from './threat-feedback.js';
import { DISTRICT } from '../world/district-layout.js';
import { Architecture } from '../world/architecture.js';
import { createHealthPickupModel } from '../render/health-pickup-model.js';

let checkpoint = null;
let initialized = false;
let restoringCheckpoint = false;
const spawnCursors = new Map();
const routePlayerFoot = { x: 0, y: 0, z: 0 };

function applyPlayerDamage(amount, source = null, attacker = null) {
  if (PlayerState.dead || !Number.isFinite(amount) || amount <= 0) return;
  const healthDamage = applyArmorDamage(Player, amount);
  HUD.setArmor(Player.armor);
  HUD.setHealth(Player.health);
  if (healthDamage > 0) HUD.bloodFlash(Math.min(1, 0.35 + healthDamage / 25));
  if (source) {
    const angle = Math.atan2(source.x - Player.pos.x, -(source.z - Player.pos.z)) + Player.yaw;
    HUD.damageDirection?.(angle);
    ThreatFeedback.hit(attacker || { pos: { x: source.x, y: source.y, z: source.z }, height: 1.8, radius: 0.35 });
  }
  if (Player.health <= 0) playerDie();
}

function playerDie() {
  if (PlayerState.dead) return;
  PlayerState.dead = true;
  Player.health = 0;
  Player.armor = 0;
  HUD.setArmor(0);
  Rage.reset();
  HUD.setRage?.({});
  Weapons.cancelAttack?.();
  HUD.setHealth(0);
  ThreatFeedback.clear();
  WaveDirector.stop();
  StreetChoice.dismiss();
  HUD.showDeath(true);
  Input.pause({ showOverlay: false });
  Audio.clearRadio();
  HUD.message('DOWN — RESTART FROM CHECKPOINT', 4);
}

function saveCheckpoint(zone, branch = null) {
  checkpoint = Object.freeze({
    ...createCheckpoint(zone, Weapons.snapshot(), branch),
    // Inventory and cache state form one checkpoint transaction. Restoring
    // ammunition without this ledger would refill already-collected supplies.
    ammoSupplies: AmmoSupplies.snapshot(),
    armor: clampArmor(Player.armor),
  });
  const anchor = checkpoint.anchor;
  // Retain this public field for the existing player/debugging interface.
  PlayerState.lastZoneSpawn.pos.set(anchor.x, anchor.y + Player.eyeHeight, anchor.z);
  PlayerState.lastZoneSpawn.yaw = anchor.yaw;
}

function getCheckpointStatus(zone) {
  const anchor = CHECKPOINTS[zone];
  if (!anchor) return { zone, valid: false, reason: 'unknown zone' };
  const floor = surfaceTopAt(anchor.x, anchor.y, anchor.z, 0.25, 0.15);
  if (!Number.isFinite(floor) || Math.abs(floor - anchor.y) > 0.16) {
    return { zone, valid: false, reason: 'no authored floor' };
  }
  const foot = { x: anchor.x, y: floor + 0.02, z: anchor.z };
  const blocked = isBlocked(foot, 0, 0, Player.radius, Player.bodyHeight);
  return { zone, valid: !blocked, reason: blocked ? 'insufficient clearance' : null, foot };
}

function restartFromZone() {
  if (!checkpoint) saveCheckpoint('apartment');
  const saved = checkpoint;
  const status = getCheckpointStatus(saved.zone);
  if (!status.valid) {
    HUD.message('CHECKPOINT BLOCKED — RELOAD THE MISSION', 4);
    return false;
  }

  // Reset the branch BEFORE restarting its encounter. A final lock or pending
  // choice from the old life must not survive into the restored simulation.
  WaveDirector.reset();
  Endings.reset();
  StreetChoice.reset();
  Enemies.clearAll();
  WeaponDrops.clearAll();
  ArmorPickups.clearAll();
  Input.reset();
  EndCard.hide();
  ThreatFeedback.clear();
  Audio.reset();
  Rage.reset();
  HUD.setRage?.({});

  PlayerState.dead = false;
  Player.health = 100;
  Player.armor = clampArmor(saved.armor);
  Player.pos.set(status.foot.x, status.foot.y + Player.eyeHeight, status.foot.z);
  Player.yaw = saved.anchor.yaw;
  Player.pitch = 0;
  resetPlayerMotion();
  Weapons.restore(saved.weapon);
  AmmoSupplies.restore(saved.ammoSupplies);
  HUD.setHealth(100);
  HUD.setArmor(Player.armor);
  HUD.showDeath(false);
  HealPickups.restoreZone(saved.zone);
  ArmorPickups.setZone(saved.zone);
  AmmoSupplies.setZone(saved.zone);

  // zoneChanged owns the live zone binding, lighting and objective banner.
  // Its mission subscriber is suppressed while replaying this same checkpoint.
  restoringCheckpoint = true;
  try {
    ZoneCull.setHidden(saved.zone, false);
    zoneChanged(saved.zone);
  } finally {
    restoringCheckpoint = false;
  }
  if (saved.branch === 'car') StreetChoice.commitCar();
  else if (saved.branch === 'bakery') StreetChoice.commitBakery();
  else {
    WaveDirector.start(saved.zone);
    if (saved.zone === 'street') StreetChoice.arm(6);
  }
  HUD.message('CHECKPOINT RESTORED', 1.6);
  return true;
}

// Highest supporting collider top under the supplied foot position. This is
// also used by enemy movement, so keep the scan allocation-free.
function surfaceTopAt(x, y, z, downSpan = 1.6, upTol = 0.10) {
  let best = -Infinity;
  const colliders = Colliders.list;
  for (let i = 0; i < colliders.length; i++) {
    const box = colliders[i];
    if (x < box.min.x - 0.05 || x > box.max.x + 0.05) continue;
    if (z < box.min.z - 0.05 || z > box.max.z + 0.05) continue;
    const top = box.max.y;
    if (top <= y + upTol && top >= y - downSpan && top > best) best = top;
  }
  return best;
}

function hasGroundBelow(x, y, z, downSpan = 1.6) {
  return Number.isFinite(surfaceTopAt(x, y, z, downSpan));
}

function playerFootPosition() {
  routePlayerFoot.x = Player.pos.x;
  routePlayerFoot.y = Player.pos.y - Player._eyeH;
  routePlayerFoot.z = Player.pos.z;
  return routePlayerFoot;
}

const spawnSightTarget = new THREE.Vector3();
const spawnOccluders = [null];
const solidSpawnKinds = new Set(['wall', 'building', 'partition', 'lintel', 'floor', 'deck', 'slab', 'roof', 'ceiling']);
function spawnConcealed(source) {
  const { pos, radius, height } = source;
  for (const record of Architecture.elements.values()) {
    const mesh = record.mesh, material = mesh?.material;
    // Collision-only screens and transparent glazing must not conceal a spawn.
    if (!solidSpawnKinds.has(record.kind) || !mesh?.isMesh || mesh.geometry.type !== 'BoxGeometry'
      || !material?.visible || Array.isArray(material) || material.transparent || material.opacity !== 1
      || material.alphaTest || material.alphaMap || material.alphaHash || material.colorWrite === false) continue;
    let parent = mesh;
    while (parent && parent.visible) parent = parent.parent;
    if (parent) continue;
    // Require one solid box to cover the envelope. Independent corner rays
    // hitting different slats could otherwise miss visible gaps between them.
    spawnOccluders[0] = record.bounds;
    let covered = true;
    for (let corner = 0; corner < 9; corner++) {
      spawnSightTarget.set(pos.x + (corner === 8 ? 0 : corner & 1 ? radius : -radius),
        pos.y + (corner === 8 ? height / 2 : corner & 2 ? height : 0),
        pos.z + (corner === 8 ? 0 : corner & 4 ? radius : -radius));
      if (!isSegmentOccluded(camera.position, spawnSightTarget, spawnOccluders)) { covered = false; break; }
    }
    if (covered) return true;
  }
  return false;
}

function encounterPlacement(key, config, waveIndex, routeProgress, variation = null) {
  const foot = playerFootPosition();
  const cursorKey = key + ':' + waveIndex;
  const cursor = spawnCursors.get(cursorKey) || 0;
  spawnCursors.set(cursorKey, cursor + 1);
  return {
    config, waveIndex, routeProgress, variation,
    playerFoot: foot, yaw: Player.yaw, view: readThreatView(), weapon: Weapons.snapshot(),
    enemies: Enemies.list, encounterKey: key, startIndex: cursor,
    floorAt: point => surfaceTopAt(point.x, point.y, point.z, 0.28, 0.16),
    // Arrival space uses the full conservative envelope. The AI steering
    // probe deliberately shrinks its radius to slide beside walls.
    blocked: point => !capsuleHasClearance(point, 0.48, 2.02, Colliders.list),
    occluded: spawnConcealed,
  };
}

function pickFromConfig(key, config, waveIndex = 0, routeProgress = 0, entry = {}, variation = null) {
  return selectEncounterSpawn({
    ...encounterPlacement(key, config, waveIndex, routeProgress, variation),
    entryIndex: entry.entryIndex, waitedSeconds: entry.waitedSeconds, type: entry.type,
  });
}

function pickSafeSpawn(zone) {
  const config = ZONE_WAVE_CONFIG[zone];
  if (!config) return null;
  const active = WaveDirector.zone === zone;
  const waveIndex = active ? (WaveDirector.wavePending ? WaveDirector.waveIndex - 1 : WaveDirector.waveIndex) : 0;
  return pickFromConfig(zone, config, waveIndex, active ? WaveDirector.routeProgress?.distance ?? 0 : 0,
    {}, active ? WaveDirector.schedule?.variation : null)?.point ?? null;
}

function countAliveInZone(zone) {
  let count = 0;
  for (const enemy of Enemies.list) if (enemy.alive && enemy.zone === zone) count++;
  return count;
}

function createEncounterCounts(config) {
  return { total: 0, alive: 0, rearAlive: 0, aliveByWave: Array(config.waveCount).fill(0),
    frontAliveByWave: Array(config.waveCount).fill(0), byType: {} };
}

function collectEncounterCounts(zone, key, counts) {
  counts.total = 0;
  counts.rearAlive = 0;
  counts.aliveByWave.fill(0);
  counts.frontAliveByWave.fill(0);
  for (const type in counts.byType) counts.byType[type] = 0;
  for (const enemy of Enemies.list) {
    if (!enemy.alive || enemy.zone !== zone) continue;
    counts.total++;
    if (enemy.arrivalRole === 'rear') counts.rearAlive++;
    counts.byType[enemy.type] = (counts.byType[enemy.type] || 0) + 1;
    if (enemy.encounterKey === key && Number.isInteger(enemy.encounterWave)) {
      counts.aliveByWave[enemy.encounterWave] = (counts.aliveByWave[enemy.encounterWave] || 0) + 1;
      if (enemy.arrivalRole !== 'rear') counts.frontAliveByWave[enemy.encounterWave] = (counts.frontAliveByWave[enemy.encounterWave] || 0) + 1;
    }
  }
  counts.alive = counts.total;
  return counts;
}

function spawnScheduled(key, zone, schedule, counts, progress = 0) {
  collectEncounterCounts(zone, key, counts);
  function commitArrival(enemy, entry, spawn) {
    enemy.zone = zone;
    enemy.encounterKey = key;
    enemy.encounterWave = entry.waveIndex;
    enemy.encounterEntry = entry.entryIndex;
    enemy.authoredType = entry.type;
    enemy.arrivalSide = spawn.rear ? 'rear' : 'front';
    enemy.arrivalRole = spawn.role;
    if (spawn.graceSeconds > 0) {
      primeEnemyInvestigation(enemy, Player.pos, playerFootPosition().y);
      enemy.spawnGrace = Math.max(enemy.spawnGrace, spawn.graceSeconds);
    }
    entry.type = spawn.type;
  }
  function announce(entry, firstForWave) {
    if (firstForWave) {
      const label = schedule.config.stages?.[entry.waveIndex]?.label;
      const incoming = schedule.reinforcementsActive ? 'REINFORCEMENTS' : (zone === 'balcony' ? 'CLOSE CONTACTS' : 'CONTACTS');
      HUD.message(incoming + ' · ' + (label || (entry.waveIndex + 1) + ' / ' + schedule.config.waveCount), 1.8);
    }
  }
  function hasCapacity(spawns) {
    const types = {};
    let total = 0;
    for (const enemy of Enemies.list) {
      if (!enemy.alive || enemy.zone !== zone) continue;
      total++;
      types[enemy.type] = (types[enemy.type] || 0) + 1;
    }
    if (total + spawns.length > schedule.config.maxAlive) return false;
    for (const spawn of spawns) {
      types[spawn.type] = (types[spawn.type] || 0) + 1;
      if (types[spawn.type] > (schedule.config.typeCaps?.[spawn.type] ?? Infinity)) return false;
    }
    return true;
  }
  return schedule.spawnAvailable(counts, (entry, firstForWave) => {
    const spawn = pickFromConfig(key, schedule.config, entry.waveIndex, progress, entry, schedule.variation);
    // Only commit a rear downgrade after placement and final-type pool checks.
    if (!spawn || !hasCapacity([spawn])) return false;
    const { point } = spawn;
    const enemy = Enemies.spawn(spawn.type, point.x, point.z, point.y);
    if (!enemy) return false;
    commitArrival(enemy, entry, spawn);
    announce(entry, firstForWave);
    return true;
  }, (entries, firstForWave) => {
    const spawns = selectEncounterFrontPair({
      ...encounterPlacement(key, schedule.config, entries[0].waveIndex, progress, schedule.variation), entries,
    });
    if (!spawns || !hasCapacity(spawns)) return false;
    const acquired = [];
    for (const spawn of spawns) {
      const { point } = spawn;
      const enemy = Enemies.spawn(spawn.type, point.x, point.z, point.y);
      if (!enemy) {
        // The second rig can fail independently. Roll back the first without
        // consuming either authored slot, granting kills, or dropping loot.
        for (const first of acquired) Enemies.remove(first);
        return false;
      }
      acquired.push(enemy);
    }
    acquired.forEach((enemy, index) => commitArrival(enemy, entries[index], spawns[index]));
    announce(entries[0], firstForWave);
    return true;
  });
}

// Compatibility hooks spawn only the supplied group; the finale scheduler owns
// the remaining groups and never treats these direct helpers as a victory.
function spawnPending(zone, types, config, key = zone) {
  let spawned = 0;
  while (types.length && countAliveInZone(zone) < config.maxAlive) {
    const spawn = pickFromConfig(key, config, 0, 0, { type: types[0] });
    if (!spawn) break;
    const { point } = spawn;
    const enemy = Enemies.spawn(types[0], point.x, point.z, point.y);
    if (!enemy) break;
    enemy.zone = zone;
    enemy.encounterKey = key;
    enemy.encounterWave = 0;
    types.shift();
    spawned++;
  }
  return spawned;
}

function recoverAfterContacts() {
  const gained = Math.max(0, Math.min(25, 100 - Player.health));
  Player.health += gained;
  HUD.setHealth(Player.health);
  return gained > 0 ? ' · +' + gained + ' HP' : '';
}

function encounterStatus(zone, schedule) {
  const aliveTypes = [];
  for (const enemy of Enemies.list) if (enemy.alive && enemy.zone === zone) aliveTypes.push(enemy.type);
  const pendingTypes = schedule?.pendingTypes ?? [];
  const unstartedTypes = schedule?.unstartedTypes ?? [];
  const remainingTypes = [...aliveTypes, ...pendingTypes, ...unstartedTypes];
  return {
    total: schedule?.total ?? 0,
    remaining: remainingTypes.length,
    alive: aliveTypes.length,
    spawned: schedule?.spawned ?? 0,
    pending: pendingTypes.length,
    pendingTypes, unstartedTypes, remainingTypes,
    waveIndex: schedule?.waveIndex ?? 0,
    clearedWaves: schedule?.clearedWaves ?? 0,
    reinforcementsActive: schedule?.reinforcementsActive ?? false,
    seed: schedule?.seed ?? null,
    variationEnabled: schedule?.variation?.enabled ?? false,
    timerDuration: schedule?.timerDuration ?? 0,
    recoveryDelay: schedule?.recoveryDelay ?? 0,
    skipped: schedule?.skipped ?? 0,
  };
}

const WaveDirector = {
  zone: null,
  active: false,
  finalLocked: false,
  cleared: false,
  routeProgress: null,
  schedule: null,
  counts: null,
  spawnTimer: 0,
  get waveIndex() { return this.schedule?.waveIndex ?? 0; },
  get timer() { return this.schedule?.timer ?? 0; },
  get wavePending() { return this.schedule?.wavePending ?? false; },
  get pendingTypes() { return this.schedule?.pendingTypes ?? []; },

  start(zone) {
    if (this.finalLocked) return;
    const config = ZONE_WAVE_CONFIG[zone];
    if (!config) { this.stop(); return; }
    this.zone = zone;
    this.active = true;
    this.cleared = false;
    this.schedule = new EncounterSchedule(config, { seed: EncounterSeeds.next() });
    this.counts = createEncounterCounts(config);
    this.spawnTimer = 0;
    this.routeProgress = config.route ? new EncounterRouteProgress(config.route) : null;
    for (let index = 0; index < config.waveCount; index++) spawnCursors.set(zone + ':' + index, 0);
  },
  stop() {
    this.active = false;
    this.zone = null;
    this.schedule = null;
    this.counts = null;
    this.routeProgress = null;
    this.cleared = false;
  },
  reset() {
    this.stop();
    this.finalLocked = false;
    this.spawnTimer = 0;
    spawnCursors.clear();
  },
  lockFinal() { this.finalLocked = true; this.stop(); },

  update(dt) {
    if (!this.active || !this.zone || PlayerState.dead) return;
    const foot = playerFootPosition();
    const progress = this.routeProgress?.update(foot) ?? 0;
    const counts = collectEncounterCounts(this.zone, this.zone, this.counts);
    counts.footY = foot.y;
    counts.grounded = Player.onGround;
    counts.routeProgress = progress;
    const events = this.schedule.update(dt, counts);
    if (this.schedule.config.retireLive !== false) {
      for (const index of events.retiredWaves) {
        for (let i = Enemies.list.length - 1; i >= 0; i--) {
          const enemy = Enemies.list[i];
          if (enemy.encounterKey === this.zone && enemy.encounterWave === index) Enemies.remove(enemy);
        }
      }
    }
    if (events.queuedWave !== null) {
      this.spawnTimer = 0;
      spawnCursors.set(this.zone + ':' + events.queuedWave, 0);
    }
    this.spawnTimer -= dt;
    if (this.schedule.pending.length && this.spawnTimer <= 0) {
      spawnScheduled(this.zone, this.zone, this.schedule, this.counts, progress);
      this.spawnTimer = 0.65;
    }
    const recovery = events.clearedWaves.length ? recoverAfterContacts() : '';
    if (this.schedule.cleared) {
      this.active = false;
      this.cleared = true;
      const label = this.schedule.skipped ? 'ROUTE SECURED' : 'AREA CLEAR';
      HUD.message(label + recovery + ' — ' + this.schedule.config.exitHint, 3.5);
      HUD.setObjective(this.schedule.config.exitHint);
    } else if (events.clearedWaves.length) {
      const message = this.schedule.reinforcementsActive ? 'SQUAD DOWN' : 'CONTACTS DOWN';
      HUD.message(message + recovery + (this.schedule.reinforcementsActive ? ' · MORE ARE COMING' : ' · CATCH YOUR BREATH'), 2.5);
    } else if (events.retiredWaves.length) {
      const message = this.zone === 'stairwell'
        ? 'LANDING LEFT BEHIND · KEEP CLIMBING'
        : 'UPPER PLATFORM BYPASSED · KEEP DESCENDING';
      HUD.message(message, 2.2);
    }
  },
};

function handleZoneChange(zone) {
  if (restoringCheckpoint || !CHECKPOINTS[zone]) return;
  // Once a branch starts, entering the other arena cannot erase its enemies,
  // reset its timer, or replace the checkpoint with the wrong ending.
  if (Endings.isCommitted()) { Endings.refreshObjective(); return; }
  // The initial apartment trigger can fire after initMission has already
  // saved its loadout. Do not capture an already-fired shot as starting ammo.
  if (checkpoint?.zone === zone && WaveDirector.zone === zone) return;
  for (let i = Enemies.list.length - 1; i >= 0; i--) {
    const enemy = Enemies.list[i];
    if (enemy.zone && enemy.zone !== zone) Enemies.remove(enemy);
  }
  saveCheckpoint(zone);
  HealPickups.setZone(zone);
  ArmorPickups.setZone(zone);
  AmmoSupplies.setZone(zone);
  WaveDirector.start(zone);
  StreetChoice.reset();
  if (zone === 'street') StreetChoice.arm(6);
  if (zone === 'bakery') StreetChoice.commitBakery();
}

function spawnGnucciBodyguards(types = [...FINAL_ENCOUNTERS.car.waves[0]]) {
  return spawnPending('street', types, FINAL_ENCOUNTERS.car, 'final-car');
}

function spawnBakeryRaiders(types = [...FINAL_ENCOUNTERS.bakery.waves[0]]) {
  return spawnPending('bakery', types, FINAL_ENCOUNTERS.bakery, 'final-bakery');
}

// Meshes remain allocated after collection so a checkpoint can restore its
// supplies without leaking geometries or PointLights on repeated deaths.
const HealPickups = (() => {
  const list = [];
  let activeZone = 'apartment';
  const haloIntensity = 0.35;
  function syncVisibility(pickup) {
    const visible = pickup.active && (!pickup.zone || pickup.zone === activeZone);
    pickup.mesh.visible = visible;
    pickup.halo.visible = visible;
    // Practical lights are pooled by intensity, not their source visibility.
    pickup.halo.intensity = visible ? haloIntensity : 0;
  }
  return {
    list,
    spawn(x, y, z, amount = 25, zone = null, id = null) {
      const mesh = createHealthPickupModel();
      if (id) {
        mesh.name = 'health:' + id;
        mesh.userData.healthSupplyId = id;
      }
      mesh.position.set(x, y + 0.18, z);
      const halo = new THREE.PointLight(0xffa0a0, haloIntensity, 1.8, 1.8);
      halo.userData.zone = zone;
      halo.position.copy(mesh.position);
      halo.position.y += 0.05;
      const pickup = { id, mesh, halo, amount, zone, active: true, baseY: mesh.position.y, phase: Math.random() * Math.PI * 2 };
      list.push(pickup);
      syncVisibility(pickup);
      World.add(mesh, halo);
      return pickup;
    },
    setZone(zone) {
      activeZone = zone;
      for (const pickup of list) syncVisibility(pickup);
    },
    restoreZone(zone) {
      for (const pickup of list) if (pickup.zone === zone) pickup.active = true;
      this.setZone(zone);
    },
    update(dt) {
      for (const pickup of list) {
        if (!pickup.active || !pickup.mesh.visible) continue;
        pickup.mesh.position.y = pickup.baseY + Math.sin(GameTime.elapsed * 2.6 + pickup.phase) * 0.04;
        pickup.mesh.rotation.y += dt * 1.2;
        // Recheck after each collection so two nearby packs cannot consume a
        // second pack after the first has already filled the player's health.
        if (PlayerState.dead || Player.health >= 100) continue;
        const dx = pickup.mesh.position.x - Player.pos.x;
        const dy = pickup.mesh.position.y - (Player.pos.y - Player._eyeH + 0.5);
        const dz = pickup.mesh.position.z - Player.pos.z;
        if (dx * dx + dy * dy + dz * dz >= 0.9 * 0.9) continue;
        const gained = Math.min(pickup.amount, 100 - Player.health);
        Player.health += gained;
        HUD.setHealth(Player.health);
        HUD.message('+' + gained + ' HP', 1.2);
        Audio.pickupChime({ kind: 'health', environment: pickup.zone ?? activeZone });
        pickup.active = false;
        syncVisibility(pickup);
      }
    },
  };
})();

const StreetChoice = (() => {
  const element = document.getElementById('choice');
  let presented = false;
  let committed = false;
  let promptDelay = null;
  return {
    arm(delay = 6) {
      if (this.isCommitted()) return;
      promptDelay = Math.max(0, delay);
    },
    present() {
      if (presented || this.isCommitted() || PlayerState.dead || currentZone !== 'street') return;
      presented = true;
      element.classList.add('show');
      HUD.message('CHOOSE — APPROACH THE CAR, OR THE BAKERY', 4);
    },
    dismiss() { element.classList.remove('show'); },
    reset() {
      presented = false;
      committed = false;
      promptDelay = null;
      this.dismiss();
    },
    isPresented() { return presented; },
    isCommitted() { return committed || Endings.isCommitted(); },
    getDelay() { return promptDelay; },
    commitCar() {
      if (this.isCommitted()) return;
      committed = true;
      promptDelay = null;
      this.dismiss();
      Endings.beginCar();
    },
    commitBakery() {
      if (this.isCommitted()) return;
      committed = true;
      promptDelay = null;
      this.dismiss();
      Endings.beginBakery();
    },
    update(dt = 0) {
      if (this.isCommitted() || PlayerState.dead) return;
      if (currentZone !== 'street' && currentZone !== 'bakery') return;
      // A player walking across the balcony above the car has not made a
      // street choice. Commit volumes require the actual street floor.
      if (Math.abs(Player.pos.y - Player._eyeH) > 1.2) return;
      if (promptDelay !== null && currentZone === 'street') {
        promptDelay -= dt;
        if (promptDelay <= 0) { promptDelay = null; this.present(); }
      }
      const carDistance = Math.hypot(Player.pos.x - DISTRICT.car.x, Player.pos.z - DISTRICT.car.z);
      const bakeryX = (DISTRICT.bakery.door.x1 + DISTRICT.bakery.door.x2) / 2;
      const bakeryDistance = Math.hypot(Player.pos.x - bakeryX, Player.pos.z - DISTRICT.bakery.door.z);
      if (carDistance < 4.5) this.commitCar();
      else if (bakeryDistance < 5.5) this.commitBakery();
    },
  };
})();

const Endings = (() => {
  let mode = null;
  let bakeryDeadline = 0;
  let resolved = false;
  let schedule = null;
  let counts = null;
  let spawnTimer = 0;
  let objectiveTimer = 0;

  function begin(branch) {
    if (mode) return;
    mode = branch;
    const config = FINAL_ENCOUNTERS[branch];
    bakeryDeadline = config.deadlineSeconds;
    schedule = new EncounterSchedule(config, { seed: EncounterSeeds.next() });
    counts = createEncounterCounts(config);
    spawnTimer = 0;
    objectiveTimer = 0;
    resolved = false;
    WaveDirector.lockFinal();
    Enemies.clearAll();
    const zone = branch === 'car' ? 'street' : 'bakery';
    const key = 'final-' + branch;
    saveCheckpoint(zone, branch);
    HealPickups.setZone(zone);
    ArmorPickups.setZone(zone);
    AmmoSupplies.setZone(zone);
    StreetChoice.dismiss();
    for (let index = 0; index < config.waveCount; index++) spawnCursors.set(key + ':' + index, 0);
    counts.footY = Player.pos.y - Player._eyeH;
    schedule.update(0, counts);
    spawnScheduled(key, zone, schedule, counts);
    if (branch === 'car') {
      ObjectiveBanner.show('vengeance', 'BREAK THE BODYGUARD TEAMS — REACH THE CAR');
    } else {
      ObjectiveBanner.show('protector', 'CLEAR THE SHOP AND BACK ROOM — SAVE THE FAMILY');
    }
    Endings.refreshObjective();
  }

  return {
    isCommitted() { return mode !== null; },
    isResolved() { return resolved; },
    getMode() { return mode; },
    getPendingCount() { return schedule?.pending.length ?? 0; },
    getStatus() {
      const zone = mode === 'car' ? 'street' : mode === 'bakery' ? 'bakery' : null;
      return {
        mode, resolved, deadline: bakeryDeadline,
        deadlineSeconds: schedule?.config.deadlineSeconds ?? 0,
        ...encounterStatus(zone, schedule),
      };
    },
    reset() {
      mode = null;
      bakeryDeadline = 0;
      resolved = false;
      schedule = null;
      counts = null;
      spawnTimer = 0;
      objectiveTimer = 0;
    },
    beginCar() { begin('car'); },
    beginBakery() { begin('bakery'); },
    refreshObjective() {
      if (!mode || resolved) return;
      const remaining = this.getStatus().remaining;
      if (mode === 'car') {
        HUD.setObjective(remaining ? 'VENGEANCE — ' + remaining + ' GUARDS · REACH THE CAR' : 'CAR CLEAR — REACH THE DRIVER’S DOOR');
      } else {
        HUD.setObjective('PROTECTOR — ' + remaining + ' RAIDERS · ' + Math.max(0, Math.ceil(bakeryDeadline)) + 's');
      }
    },
    update(dt) {
      if (!mode || resolved || PlayerState.dead) return;
      const zone = mode === 'car' ? 'street' : 'bakery';
      const key = 'final-' + mode;
      collectEncounterCounts(zone, key, counts);
      counts.footY = Player.pos.y - Player._eyeH;
      const events = schedule.update(dt, counts);
      if (events.queuedWave !== null) {
        spawnTimer = 0;
        spawnCursors.set(key + ':' + events.queuedWave, 0);
      }
      spawnTimer -= dt;
      if (schedule.pending.length && spawnTimer <= 0) {
        spawnScheduled(key, zone, schedule, counts);
        spawnTimer = 0.65;
      }
      if (events.clearedWaves.length) {
        const recovery = recoverAfterContacts();
        if (!schedule.cleared) HUD.message('TEAM DOWN' + recovery + ' · REGROUP', 2.5);
      }
      objectiveTimer -= dt;
      if (mode === 'bakery') {
        bakeryDeadline = Math.max(0, bakeryDeadline - dt);
        if (bakeryDeadline < 1e-6) bakeryDeadline = 0;
      }
      if (objectiveTimer <= 0) { this.refreshObjective(); objectiveTimer = 0.25; }
      if (mode === 'car') {
        const nearCar = Math.hypot(Player.pos.x - DISTRICT.car.x, Player.pos.z - DISTRICT.car.z)
          < FINAL_ENCOUNTERS.car.arrivalRadius;
        const onStreet = Math.abs(Player.pos.y - Player._eyeH - DISTRICT.car.y) < 1.2;
        if (schedule.cleared && nearCar && onStreet) {
          resolved = true;
          EndCard.show('— VENGEANCE —', 'THE LAST RIDE',
            'Gnucci tries the door. It is already open.<br>You climb in beside him. He stops talking.<br>The car never makes it past the corner of Carmine and Mulberry.<br><br>This ends here. Tonight. The way you promised.');
        }
      } else if (schedule.cleared) {
        resolved = true;
        EndCard.show('— PROTECTOR —', 'A PAPER ROSE',
          'The shopkeeper lowers her broken broom. Inside the back room, Charli is shaking.<br>She hands you a folded paper rose, the corner singed by smoke.<br>You go back out into the street. Gnucci is gone. Tomorrow you will hunt him.<br><br>Tonight, you stayed.');
      } else if (bakeryDeadline <= 0) {
        resolved = true;
        EndCard.show('— TOO LATE —', 'A QUIET HOUSE',
          'You reach the back room. The lights are out. Someone left a paper rose on the floor.<br>You did not get here in time.<br><br>Try again. Move faster. Save them.');
      }
    },
  };
})();

function initMission() {
  if (initialized) return;
  initialized = true;
  onZoneChange(handleZoneChange);
  AmmoSupplies.setZone('apartment');
  // Explicit initialization avoids cross-module access before World and the
  // weapon view model exist. It also makes repeated startup calls harmless.
  for (const { id, zone, x, y, z, amount } of HEALTH_SUPPLIES) HealPickups.spawn(x, y, z, amount, zone, id);
  saveCheckpoint('apartment');
  WaveDirector.start('apartment');
  document.getElementById('restartbutton')?.addEventListener('click', () => {
    if (PlayerState.dead && restartFromZone()) engageLock();
  });
  addEventListener('keydown', event => {
    if (PlayerState.dead && event.code === 'Enter') {
      event.preventDefault();
      if (restartFromZone()) engageLock();
    }
  });

}

function getMissionState() {
  const waveStatus = encounterStatus(WaveDirector.zone, WaveDirector.schedule);
  const stageIndex = WaveDirector.wavePending ? WaveDirector.waveIndex - 1 : WaveDirector.waveIndex;
  return {
    initialized,
    zone: currentZone,
    checkpoint: checkpoint ? {
      zone: checkpoint.zone,
      branch: checkpoint.branch,
      anchor: { ...checkpoint.anchor },
      weapon: { ...checkpoint.weapon },
      ammoSupplies: checkpoint.ammoSupplies,
      armor: checkpoint.armor,
    } : null,
    wave: {
      ...waveStatus,
      zone: WaveDirector.zone,
      index: WaveDirector.waveIndex,
      total: ZONE_WAVE_CONFIG[WaveDirector.zone]?.waveCount ?? 0,
      totalContacts: waveStatus.total,
      active: WaveDirector.active,
      cleared: WaveDirector.cleared,
      timer: WaveDirector.timer,
      routeProgress: WaveDirector.routeProgress?.distance ?? 0,
      stageIndex,
      stage: ZONE_WAVE_CONFIG[WaveDirector.zone]?.stages?.[stageIndex]?.id ?? null,
      finalLocked: WaveDirector.finalLocked,
    },
    ending: Endings.getStatus(),
    choice: { presented: StreetChoice.isPresented(), committed: StreetChoice.isCommitted(), delay: StreetChoice.getDelay() },
    ammoSupplies: AmmoSupplies.snapshot(),
  };
}

export {
  initMission, getMissionState, getCheckpointStatus, saveCheckpoint, CHECKPOINTS,
  applyPlayerDamage, playerDie, restartFromZone,
  ZONE_WAVE_CONFIG, WaveDirector, surfaceTopAt, hasGroundBelow,
  pickSafeSpawn, countAliveInZone, spawnGnucciBodyguards, spawnBakeryRaiders,
  HealPickups, StreetChoice, Endings,
};
