import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { CHECKPOINTS, ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from '../../src/game/mission-data.js';
import { EncounterSchedule, EncounterRouteProgress } from '../../src/game/encounter-rules.js';
import { createEncounterSeedSource } from '../../src/game/encounter-session.js';
import { selectEncounterSpawn, selectEncounterFrontPair } from '../../src/game/encounter-spawns.js';
import { describeOffscreenThreat } from '../../src/game/offscreen-threats.js';
import { hasPairBearingSeparation, isBehindPlayer } from '../../src/game/rear-encounter-rules.js';
import { isSegmentOccluded } from '../../src/game/combat-rules.js';
import { enemyPoolCapacity } from '../../src/game/enemy-navigation.js';
import { Architecture } from '../../src/world/architecture.js';
import { Colliders, capsuleHasClearance } from '../../src/core/collision.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

const ai = createEnemyAIHarness();
const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 220);
const messages = [];
// Exact authored placements remain an explicit fixture. Normal gameplay draws
// fresh attempt seeds; separate runtime integration tests exercise that mode.
const EncounterSeeds = createEncounterSeedSource();
EncounterSeeds.setOverride(null);
let weapon = { current: 'fists', loaded: 0, reserve: 0 };
const source = readFileSync(new URL('../../src/game/mission.js', import.meta.url), 'utf8');
const start = source.indexOf('function playerFootPosition()');
const end = source.indexOf('\nfunction handleZoneChange(', start);
assert.ok(start >= 0 && end > start, 'exercise the actual mission spawning and WaveDirector implementation');
const readThreatView = () => ({ position: camera.position, yaw: camera.rotation.y, pitch: camera.rotation.x,
  fov: camera.fov, aspect: camera.aspect, zoom: camera.zoom });
const mission = runInNewContext(`
const spawnCursors = new Map();
const routePlayerFoot = { x: 0, y: 0, z: 0 };
${source.slice(start, end)}
;({ WaveDirector, spawnScheduled, createEncounterCounts, spawnCursors, pickSafeSpawn, spawnConcealed });`, {
  THREE, camera, Architecture, Colliders, capsuleHasClearance, Player: ai.player, PlayerState: ai.playerState,
  Enemies: ai.Enemies, isBlocked: ai.isBlocked, primeEnemyInvestigation: ai.primeEnemyInvestigation,
  surfaceTopAt: ai.surfaceTopAt, selectEncounterSpawn, selectEncounterFrontPair, isSegmentOccluded, readThreatView,
  EncounterSchedule, EncounterRouteProgress, EncounterSeeds, ZONE_WAVE_CONFIG,
  Weapons: { snapshot: () => ({ ...weapon }) },
  HUD: { message: (...values) => messages.push(values), setHealth() {}, setObjective() {} },
}, { filename: 'src/game/mission.js' });

function place(point, yaw) {
  ai.placePlayer(point);
  ai.player.yaw = yaw;
  ai.player.onGround = true;
  camera.position.copy(ai.player.pos);
  camera.rotation.set(0, yaw, 0, 'YXZ');
}

function reset(zone, point, yaw, inventory = { current: 'fists', loaded: 0, reserve: 0 }) {
  ai.reset(point);
  weapon = { ...inventory };
  messages.length = 0;
  place(point, yaw);
  mission.WaveDirector.reset();
  mission.WaveDirector.start(zone);
}

function foot() {
  return { x: ai.player.pos.x, y: ai.player.pos.y - ai.player._eyeH, z: ai.player.pos.z };
}

function assertRear(enemy, type, entryIndex = enemy?.zone === 'balcony' ? 2 : 1) {
  assert.ok(enemy, 'a rear arrival was acquired from the real pool');
  assert.equal(enemy.type, type);
  assert.equal(enemy.arrivalSide, 'rear');
  assert.equal(enemy.arrivalRole, 'rear');
  assert.equal(enemy.encounterEntry, entryIndex);
  assert.ok(enemy.spawnGrace >= 1);
  assert.equal(enemy.lastSeenPlayer, true);
  assert.equal(enemy.lastSeenPosition.equals(ai.player.pos), true, 'the initial search target is copied from the arrival moment');
  assert.equal(isBehindPlayer(foot(), ai.player.yaw, enemy.pos), true);
  assert.equal(describeOffscreenThreat(readThreatView(), enemy).visible, false);
  assert.equal(capsuleHasClearance(enemy.pos, 0.48, 2.02, ai.colliders), true);
  assert.ok(Math.abs(ai.surfaceTopAt(enemy.pos.x, enemy.pos.y, enemy.pos.z) - enemy.pos.y) <= 0.04);
}

const living = () => Array.from(ai.Enemies.list).filter(enemy => enemy.alive);

// These deliberate fixture deaths use the production damage/death path. They
// do not simulate player shots, player kill credit, or a successful playthrough.
function defeatContacts(predicate = () => true) {
  for (const enemy of living().filter(predicate)) {
    assert.equal(ai.damageEnemy(enemy, 9999, 'body', enemy.pos.clone()).killed, true);
  }
}

function assertForwardPair(waveIndex) {
  const pair = living().filter(enemy => enemy.encounterWave === waveIndex && enemy.arrivalRole === 'front');
  assert.equal(pair.length, 2);
  assert.deepEqual(pair.map(enemy => enemy.encounterEntry).sort(), [0, 1]);
  for (const enemy of pair) {
    assert.equal(enemy.arrivalSide, 'front');
    assert.equal(enemy.encounterKey, 'balcony');
    assert.equal(enemy.poolSlot.owner, enemy);
    assert.equal(isBehindPlayer(foot(), ai.player.yaw, enemy.pos, { minDistance: 0, minRearDot: 0 }), false);
    assert.ok(Math.hypot(enemy.pos.x - foot().x, enemy.pos.z - foot().z) >= 5);
    assert.equal(capsuleHasClearance(enemy.pos, 0.48, 2.02, ai.colliders), true);
  }
  assert.equal(hasPairBearingSeparation(foot(), pair[0].pos, pair[1].pos), true);
  return pair;
}

function prepareSecondBalconyGroup(inventory, point = { x: 4, y: 4.02, z: 0.95 }) {
  reset('balcony', CHECKPOINTS.balcony, CHECKPOINTS.balcony.yaw, inventory);
  mission.WaveDirector.update(ZONE_WAVE_CONFIG.balcony.firstWave);
  assertForwardPair(0);
  defeatContacts();
  place(point, Math.PI / 2);
  mission.WaveDirector.update(0);
  messages.length = 0;
}

test('the actual opening director commits two visible forward actors together, with no rear substitution', () => {
  reset('balcony', CHECKPOINTS.balcony, CHECKPOINTS.balcony.yaw);
  for (let tick = 0; tick < 11; tick++) mission.WaveDirector.update(1 / 120);
  assert.equal(living().length, 0);
  mission.WaveDirector.update(1 / 120);
  const pair = assertForwardPair(0);
  assert.deepEqual(pair.map(enemy => enemy.type), ['brawler', 'thug']);
  assert.deepEqual(pair.map(enemy => enemy.pos.x), [10, 12]);
  for (const enemy of pair) {
    assert.equal(describeOffscreenThreat(readThreatView(), enemy).visible, true);
    assert.equal(mission.spawnConcealed(enemy), false);
    assert.equal(isSegmentOccluded(camera.position, { x: enemy.pos.x, y: enemy.pos.y + 1.7, z: enemy.pos.z }, ai.colliders), false);
  }
  assert.equal(mission.WaveDirector.schedule.spawned, 2);
  assert.equal(mission.WaveDirector.schedule.pending.length, 0);
  assert.equal(mission.WaveDirector.schedule.total, 8);
  assert.equal(messages.length, 1);
  const second = pair[1];
  defeatContacts(enemy => enemy === pair[0]);
  mission.WaveDirector.update(5);
  assert.equal(living().length, 1);
  assert.equal(living()[0], second, 'A quick first kill cannot erase the second actor');
  assert.equal(mission.WaveDirector.waveIndex, 1);
  assert.equal(mission.WaveDirector.schedule.groups[0].frontCleared, false);
});

test('failure to acquire the second forward rig rolls back the first without consuming either slot', () => {
  reset('balcony', CHECKPOINTS.balcony, CHECKPOINTS.balcony.yaw);
  const acquire = ai.EnemyPool.acquire, spawn = ai.Enemies.spawn, created = [], slots = [];
  ai.EnemyPool.acquire = function(type) { return type === 'thug' ? null : acquire.call(this, type); };
  ai.Enemies.spawn = function(...args) {
    const enemy = spawn.apply(this, args);
    if (enemy) { created.push(enemy); slots.push(enemy.poolSlot); }
    return enemy;
  };
  try {
    mission.WaveDirector.update(ZONE_WAVE_CONFIG.balcony.firstWave);
    assert.equal(created.length, 1);
    assert.equal(created[0].removed, true);
    assert.equal(created[0].alive, false);
    assert.equal(created[0].hasDroppedWeapon, false, 'Rollback is not a rewarded death or a free weapon drop');
    assert.equal(created[0].poolSlot, null);
    assert.equal(slots[0].owner, null);
    assert.equal(slots[0].inUse, false);
    assert.equal(slots[0].rig.visible, false);
    assert.equal(living().length, 0);
    assert.equal(mission.WaveDirector.schedule.spawned, 0);
    assert.equal(mission.WaveDirector.schedule.groups[0].pending, 2);
    assert.equal(mission.WaveDirector.schedule.groups[0].frontSpawned, 0);
    assert.deepEqual(mission.WaveDirector.schedule.pending.map(entry => entry.entryIndex), [0, 1]);
    assert.equal(messages.length, 0, 'A rolled-back proposal cannot announce a completed arrival');
  } finally {
    ai.EnemyPool.acquire = acquire;
    ai.Enemies.spawn = spawn;
  }
  mission.WaveDirector.update(0.66);
  assertForwardPair(0);
  assert.equal(mission.WaveDirector.schedule.spawned, 2);
  assert.equal(mission.WaveDirector.schedule.pending.length, 0);
  assert.equal(messages.length, 1);
});

test('later balcony groups add a weaker rear actor without taking either forward slot', () => {
  for (const [inventory, expected] of [
    [{ current: 'fists', loaded: 0, reserve: 0 }, 'brawler'],
    [{ current: 'bat', loaded: 0, reserve: 0 }, 'brawler'],
    [{ current: 'pistol', loaded: 0, reserve: 0 }, 'brawler'],
    [{ current: 'pistol', loaded: 0, reserve: 12 }, 'thug'],
  ]) {
    prepareSecondBalconyGroup(inventory);
    mission.WaveDirector.update(ZONE_WAVE_CONFIG.balcony.waveInterval);
    const rear = living().find(enemy => enemy.arrivalRole === 'rear');
    assertRear(rear, expected);
    assert.equal(rear.authoredType, 'thug');
    assert.equal(rear.encounterKey, 'balcony');
    assert.equal(rear.encounterWave, 1);
    const pair = assertForwardPair(1);
    for (const front of pair) assert.equal(hasPairBearingSeparation(foot(), front.pos, rear.pos), true);
    assert.equal(living().length, 3);
    assert.equal(mission.WaveDirector.schedule.spawned, 5);
    assert.equal(mission.WaveDirector.schedule.pending.length, 0);
    assert.equal(messages.length, 1, 'The group announces once even when its third slot adapts');
    assert.equal(mission.WaveDirector.schedule.total, 8);
  }
});

test('an unavailable rear rig leaves the exact authored slot pending until acquisition succeeds', () => {
  prepareSecondBalconyGroup();
  const acquire = ai.EnemyPool.acquire;
  let attempted = 0;
  ai.EnemyPool.acquire = function(type) {
    // The forward brawler is allowed; the rear bat would adapt to a second.
    if (type === 'brawler' && ++attempted > 1) return null;
    return acquire.call(this, type);
  };
  try {
    mission.WaveDirector.update(ZONE_WAVE_CONFIG.balcony.waveInterval);
    const pending = mission.WaveDirector.schedule.pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].entryIndex, 2);
    assert.equal(pending[0].type, 'thug', 'an uncommitted downgrade must not rewrite the authored pending type');
    assert.equal(mission.WaveDirector.schedule.spawned, 4);
    assert.equal(mission.WaveDirector.schedule.groups[1].pending, 1);
    assertForwardPair(1);
    assert.equal(living().length, 2);
  } finally { ai.EnemyPool.acquire = acquire; }
  mission.WaveDirector.update(0.66);
  assertRear(living().find(enemy => enemy.encounterEntry === 2), 'brawler');
  assert.equal(mission.WaveDirector.schedule.spawned, 5);
  assert.equal(mission.WaveDirector.schedule.pending.length, 0);
});

test('director-created rear brawlers and bat carriers round the balcony corner and attack', () => {
  for (const inventory of [
    { current: 'bat', loaded: 0, reserve: 0 },
    { current: 'pistol', loaded: 8, reserve: 0 },
  ]) {
    prepareSecondBalconyGroup(inventory, { x: 6, y: 4.02, z: 0.95 });
    mission.WaveDirector.update(ZONE_WAVE_CONFIG.balcony.waveInterval);
    const rear = living().find(enemy => enemy.encounterEntry === 2);
    assertRear(rear, inventory.current === 'bat' ? 'brawler' : 'thug');
    assert.ok(rear.pos.z < 0, 'the arrival starts on the terrace side of the building corner');
    for (let tick = 0; tick < 15 * 120 && !ai.damage.some(hit => hit.attacker === rear); tick++) {
      ai.step();
      assert.equal(capsuleHasClearance(rear.pos, rear.radius, rear.height, ai.colliders, 1e-5), true);
    }
    const hit = ai.damage.find(value => value.attacker === rear);
    assert.ok(hit, `${rear.type} can reach the player around the balcony corner`);
    assert.ok(hit.time >= 1, 'the grace period must elapse before real melee contact');
    assert.ok(Math.abs(rear.pos.y - 4) < 0.12);
  }
});

test('an actual living rear actor leaves both next-stage forward slots available without early healing', () => {
  const config = ZONE_WAVE_CONFIG.balcony;
  prepareSecondBalconyGroup();
  mission.WaveDirector.update(config.waveInterval);
  const rear = living().find(enemy => enemy.arrivalRole === 'rear');
  assertRear(rear, 'brawler');
  ai.player.health = 40;
  defeatContacts(enemy => enemy.encounterWave === 1 && enemy.arrivalRole === 'front');
  place({ x: -6, y: 4.02, z: 0.95 }, Math.PI / 2);
  mission.WaveDirector.update(0);
  assert.equal(mission.WaveDirector.schedule.groups[1].frontCleared, true);
  assert.equal(mission.WaveDirector.schedule.groups[1].cleared, false);
  assert.equal(ai.player.health, 40, 'Forward clearance alone cannot grant the full group recovery');
  mission.WaveDirector.update(config.minRecovery);
  assertForwardPair(2);
  assert.equal(living().length, 3);
  assert.ok(living().includes(rear));
  assert.equal(rear.removed, false);
  assert.equal(mission.WaveDirector.schedule.spawned, 7);
  assert.deepEqual(mission.WaveDirector.schedule.pending.map(entry => [entry.waveIndex, entry.entryIndex]), [[2, 2]]);
  assert.equal(ai.player.health, 40);

  defeatContacts(enemy => enemy === rear);
  mission.WaveDirector.update(0.66);
  assertForwardPair(2);
  assert.equal(living().length, 3);
  assertRear(living().find(enemy => enemy.encounterWave === 2 && enemy.arrivalRole === 'rear'), 'brawler');
  assert.equal(mission.WaveDirector.schedule.spawned, 8);
  assert.equal(mission.WaveDirector.schedule.pending.length, 0);
  assert.equal(ai.player.health, 65, 'The old full group earns recovery only when its rear contact also dies');
  defeatContacts();
  mission.WaveDirector.update(0);
  assert.equal(mission.WaveDirector.cleared, true);
  assert.equal(mission.WaveDirector.schedule.skipped, 0);
  assert.equal(ai.player.health, 90);
});

test('the actual balcony director commits exactly six forward entries and two additional rear entries', () => {
  const config = ZONE_WAVE_CONFIG.balcony, records = [];
  const positions = [CHECKPOINTS.balcony, { x: 4, y: 4.02, z: 0.95 }, { x: -6, y: 4.02, z: 0.95 }];
  reset('balcony', positions[0], Math.PI);
  mission.WaveDirector.update(config.firstWave);
  for (let waveIndex = 0; waveIndex < config.waveCount; waveIndex++) {
    if (waveIndex) {
      place(positions[waveIndex], Math.PI / 2);
      mission.WaveDirector.update(config.minRecovery);
    }
    assertForwardPair(waveIndex);
    const group = living();
    assert.equal(group.length, waveIndex === 0 ? 2 : 3);
    for (const enemy of group) records.push({ waveIndex: enemy.encounterWave, entryIndex: enemy.encounterEntry,
      role: enemy.arrivalRole, authoredType: enemy.authoredType });
    defeatContacts();
    mission.WaveDirector.update(0);
  }
  assert.equal(records.length, 8);
  assert.equal(records.filter(entry => entry.role === 'front').length, 6);
  assert.equal(records.filter(entry => entry.role === 'rear').length, 2);
  assert.equal(new Set(records.map(entry => `${entry.waveIndex}:${entry.entryIndex}`)).size, 8);
  for (const [waveIndex, wave] of config.waves.entries()) {
    assert.deepEqual(records.filter(entry => entry.waveIndex === waveIndex).map(entry => entry.authoredType), wave);
  }
  assert.equal(mission.WaveDirector.schedule.spawned, 8);
  assert.equal(mission.WaveDirector.schedule.clearedWaves, 3);
  assert.equal(mission.WaveDirector.schedule.skipped, 0);
  assert.equal(mission.WaveDirector.cleared, true);
  for (let tick = 0; tick < 10; tick++) mission.WaveDirector.update(10);
  assert.equal(mission.WaveDirector.schedule.spawned, 8);
  assert.equal(living().length, 0);
});

test('actual ranged damage also preserves the attacking actor for warning feedback', () => {
  reset('balcony', { x: 0, y: 4.02, z: 0.95 }, Math.PI / 2);
  const gunman = ai.spawn('gunman', { x: -6, y: 4, z: 0.95 }, { zone: 'balcony' });
  for (let tick = 0; tick < 3 * 120 && !ai.damage.length; tick++) ai.step();
  assert.ok(ai.damage.length > 0, 'a real aim and firing cycle reaches the player');
  assert.equal(ai.damage[0].attacker, gunman);
});

test('turning away before a forward stair arrival also downgrades its actual rear loadout', () => {
  for (const [inventory, expected] of [
    [{ current: 'bat', loaded: 0, reserve: 0 }, 'brawler'],
    [{ current: 'pistol', loaded: 8, reserve: 0 }, 'thug'],
  ]) {
    reset('stairwell', { x: -19.4, y: 4.02, z: -8.8 }, 0, inventory);
    mission.WaveDirector.update(1.21);
    const frontSlot = ai.Enemies.list.find(enemy => enemy.encounterEntry === 0);
    assert.ok(frontSlot);
    assert.equal(frontSlot.authoredType, 'gunman');
    assert.equal(frontSlot.arrivalRole, 'front');
    assert.equal(frontSlot.arrivalSide, 'rear');
    assert.equal(frontSlot.type, expected, 'looking away cannot let an intended forward gunman arrive armed behind the player');
    assert.ok(frontSlot.spawnGrace >= 1);
    assert.equal(frontSlot.lastSeenPosition.equals(ai.player.pos), true);
    assert.equal(describeOffscreenThreat(readThreatView(), frontSlot).visible, false);
    assert.equal(mission.WaveDirector.schedule.spawned, 1);
    assert.equal(mission.WaveDirector.schedule.pending[0].entryIndex, 1);
  }
});

test('a failed forward stair placement does not block a safe lower-landing rear contact', () => {
  reset('stairwell', { x: -19.4, y: 6.42, z: -0.85 }, Math.PI,
    { current: 'pistol', loaded: 8, reserve: 0 });
  mission.WaveDirector.update(1.21);
  assert.equal(ai.Enemies.list.length, 1, 'front landing candidates are too close to the player');
  const rear = ai.Enemies.list[0];
  assertRear(rear, 'brawler');
  assert.equal(rear.pos.y, 4.03);
  assert.equal(rear.encounterKey, 'stairwell');
  assert.equal(rear.encounterWave, 0);
  assert.equal(mission.WaveDirector.schedule.pending[0].entryIndex, 0);
  assert.equal(mission.WaveDirector.schedule.pending[0].type, 'gunman');
  assert.ok(rear.stairPursuit.active, 'the actual stair investigation route is seeded');

  for (let tick = 0; tick < 7 * 120 && !ai.damage.length; tick++) ai.step();
  assert.ok(ai.damage.length > 0, 'this director-created contact climbs and lands a real melee attack');
  assert.equal(ai.damage[0].attacker, rear, 'actual melee damage keeps the actor identity for warning feedback');
  assert.ok(ai.damage[0].time >= 1);
  assert.ok(Math.abs(rear.pos.y - 6.4) < 0.12);
});

test('climbing past a landing retains its living rear pursuer and the two-contact cap', () => {
  reset('stairwell', { x: -19.4, y: 6.42, z: -0.85 }, Math.PI);
  mission.WaveDirector.update(1.21);
  const rear = ai.Enemies.list[0];
  assertRear(rear, 'brawler');
  place({ x: -16.6, y: 6.8, z: -3.5 }, 0);
  mission.WaveDirector.update(0.66);
  assert.equal(rear.alive, true);
  assert.equal(rear.removed, false);
  assert.ok(ai.Enemies.list.includes(rear));
  assert.equal(mission.WaveDirector.schedule.skipped, 1, 'only the unspawned old forward entry retires');
  assert.equal(mission.WaveDirector.schedule.groups[0].retired, true);
  for (let i = 0; i < 15; i++) mission.WaveDirector.update(0.66);
  assert.ok(ai.Enemies.list.filter(enemy => enemy.alive).length <= 2);
  assert.ok(ai.Enemies.list.includes(rear));
});

test('every lower landing can supply its stage through actual spawning and pool ownership', () => {
  const targets = [
    { x: -19.4, y: 6.42, z: -0.85 }, { x: -16.6, y: 9.02, z: -9 },
    { x: -19.4, y: 11.62, z: -0.85 }, { x: -16.6, y: 14.02, z: -9 },
  ];
  for (const [index, target] of targets.entries()) {
    reset('stairwell', target, index % 2 === 0 ? Math.PI : 0,
      { current: 'shotgun', loaded: 4, reserve: 0 });
    // The real director retires unvisited earlier bands without kill credit.
    mission.WaveDirector.update(1.21);
    const rear = ai.Enemies.list.find(enemy => enemy.encounterWave === index && enemy.encounterEntry === 1);
    assertRear(rear, index === 0 ? 'brawler' : 'thug');
    assert.equal(rear.pos.y, ZONE_WAVE_CONFIG.stairwell.rearSpawns[index].y + 0.03);
    assert.equal(rear.authoredType, ZONE_WAVE_CONFIG.stairwell.waves[index][1]);
    assert.equal(rear.poolSlot.owner, rear);
    assert.equal(mission.WaveDirector.schedule.skipped, index * 2);
    assert.equal(mission.WaveDirector.schedule.total, 8);
  }
});

test('a director reset restores rear roles, timers and cursors without retaining the old enemy', () => {
  const point = { x: 6, y: 4.02, z: 0.95 };
  prepareSecondBalconyGroup(undefined, point);
  mission.WaveDirector.update(ZONE_WAVE_CONFIG.balcony.waveInterval);
  const old = living().find(enemy => enemy.encounterEntry === 2);
  assertRear(old, 'brawler');
  const originalPosition = old.pos.clone();
  mission.WaveDirector.update(0.66);
  reset('balcony', CHECKPOINTS.balcony, CHECKPOINTS.balcony.yaw);
  assert.equal(old.alive, false);
  assert.equal(old.removed, true);
  assert.equal(mission.WaveDirector.schedule.spawned, 0);
  assert.equal(mission.WaveDirector.schedule.pending.length, 0);
  assert.equal(mission.WaveDirector.schedule.timer, ZONE_WAVE_CONFIG.balcony.firstWave);
  assert.equal(mission.WaveDirector.routeProgress.distance, 0);
  assert.ok([...mission.spawnCursors.values()].every(value => value === 0));
  mission.WaveDirector.update(ZONE_WAVE_CONFIG.balcony.firstWave);
  assertForwardPair(0);
  defeatContacts();
  place(point, Math.PI / 2);
  mission.WaveDirector.update(0);
  mission.WaveDirector.update(ZONE_WAVE_CONFIG.balcony.waveInterval);
  const next = living().find(enemy => enemy.encounterEntry === 2);
  assertRear(next, 'brawler');
  assert.notEqual(next, old);
  assert.equal(next.pos.equals(originalPosition), true);
});

test('the existing shared rig pools cover the strongest possible concentration of rear melee arrivals', () => {
  const configs = [...Object.values(ZONE_WAVE_CONFIG), ...Object.values(FINAL_ENCOUNTERS)];
  for (const type of ['brawler', 'thug']) {
    for (const config of Object.values(ZONE_WAVE_CONFIG).filter(value => value.rearPressure)) {
      const capacity = enemyPoolCapacity(type, configs);
      assert.ok(capacity >= config.maxAlive + 2, `${type}: two dead rigs cannot exhaust rear arrival capacity`);
      assert.equal(ai.EnemyPool.pools[type].length, capacity);
    }
  }
});
