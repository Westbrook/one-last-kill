import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from '../../src/game/mission-data.js';
import { EncounterSchedule, EncounterRouteProgress } from '../../src/game/encounter-rules.js';
import { selectEncounterSpawn } from '../../src/game/encounter-spawns.js';
import { describeOffscreenThreat } from '../../src/game/offscreen-threats.js';
import { hasPairBearingSeparation, isBehindPlayer } from '../../src/game/rear-encounter-rules.js';
import { isSegmentOccluded } from '../../src/game/combat-rules.js';
import { enemyPoolCapacity } from '../../src/game/enemy-navigation.js';
import { Architecture } from '../../src/world/architecture.js';
import { capsuleHasClearance } from '../../src/core/collision.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

const ai = createEnemyAIHarness();
const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 220);
const messages = [];
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
  THREE, camera, Architecture, Player: ai.player, PlayerState: ai.playerState,
  Enemies: ai.Enemies, isBlocked: ai.isBlocked, primeEnemyInvestigation: ai.primeEnemyInvestigation,
  surfaceTopAt: ai.surfaceTopAt, selectEncounterSpawn, isSegmentOccluded, readThreatView,
  EncounterSchedule, EncounterRouteProgress, ZONE_WAVE_CONFIG,
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

function assertRear(enemy, type) {
  assert.ok(enemy, 'a rear arrival was acquired from the real pool');
  assert.equal(enemy.type, type);
  assert.equal(enemy.arrivalSide, 'rear');
  assert.equal(enemy.arrivalRole, 'rear');
  assert.equal(enemy.encounterEntry, 1);
  assert.ok(enemy.spawnGrace >= 1);
  assert.equal(enemy.lastSeenPlayer, true);
  assert.equal(enemy.lastSeenPosition.equals(ai.player.pos), true, 'the initial search target is copied from the arrival moment');
  assert.equal(isBehindPlayer(foot(), ai.player.yaw, enemy.pos), true);
  assert.equal(describeOffscreenThreat(readThreatView(), enemy).visible, false);
  assert.equal(capsuleHasClearance(enemy.pos, 0.48, 2.02, ai.colliders), true);
  assert.ok(Math.abs(ai.surfaceTopAt(enemy.pos.x, enemy.pos.y, enemy.pos.z) - enemy.pos.y) <= 0.04);
}

test('the actual balcony director commits staggered front/rear entries with a weaker rear loadout', () => {
  for (const [inventory, expected] of [
    [{ current: 'fists', loaded: 0, reserve: 0 }, 'brawler'],
    [{ current: 'bat', loaded: 0, reserve: 0 }, 'brawler'],
    [{ current: 'pistol', loaded: 0, reserve: 0 }, 'brawler'],
    [{ current: 'pistol', loaded: 0, reserve: 12 }, 'thug'],
  ]) {
    reset('balcony', { x: 6, y: 4.02, z: 0.95 }, Math.PI / 2, inventory);
    mission.WaveDirector.update(0.66);
    const rear = ai.Enemies.list.find(enemy => enemy.arrivalRole === 'rear');
    assertRear(rear, expected);
    assert.equal(rear.authoredType, 'thug');
    assert.equal(rear.encounterKey, 'balcony');
    assert.equal(rear.encounterWave, 0);
    const front = ai.Enemies.list.find(enemy => enemy.encounterEntry === 0);
    assert.ok(front);
    assert.equal(hasPairBearingSeparation(foot(), front.pos, rear.pos), true);
    assert.equal(mission.WaveDirector.schedule.spawned, 2);
    assert.equal(mission.WaveDirector.schedule.pending.length, 0);
    assert.equal(messages.length, 1, 'the group announces once even when its second slot adapts');
    assert.equal(mission.WaveDirector.schedule.total, 6);
  }
});

test('an unavailable rear rig leaves the exact authored slot pending until acquisition succeeds', () => {
  reset('balcony', { x: 6, y: 4.02, z: 0.95 }, Math.PI / 2);
  const acquire = ai.EnemyPool.acquire;
  let attempted = 0;
  ai.EnemyPool.acquire = function(type) {
    // Both entries adapt to brawlers here; allow only the forward acquisition.
    if (type === 'brawler' && ++attempted > 1) return null;
    return acquire.call(this, type);
  };
  try {
    mission.WaveDirector.update(0.66);
    const pending = mission.WaveDirector.schedule.pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].entryIndex, 1);
    assert.equal(pending[0].type, 'thug', 'an uncommitted downgrade must not rewrite the authored pending type');
    assert.equal(mission.WaveDirector.schedule.spawned, 1);
    assert.equal(mission.WaveDirector.schedule.groups[0].pending, 1);
    assert.equal(ai.Enemies.list.length, 1);
  } finally { ai.EnemyPool.acquire = acquire; }
  mission.WaveDirector.update(0.66);
  assertRear(ai.Enemies.list.find(enemy => enemy.encounterEntry === 1), 'brawler');
  assert.equal(mission.WaveDirector.schedule.spawned, 2);
  assert.equal(mission.WaveDirector.schedule.pending.length, 0);
});

test('director-created rear brawlers and bat carriers round the balcony corner and attack', () => {
  for (const inventory of [
    { current: 'bat', loaded: 0, reserve: 0 },
    { current: 'pistol', loaded: 8, reserve: 0 },
  ]) {
    reset('balcony', { x: 6, y: 4.02, z: 0.95 }, Math.PI / 2, inventory);
    mission.WaveDirector.update(0.66);
    const rear = ai.Enemies.list.find(enemy => enemy.encounterEntry === 1);
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
  reset('balcony', point, Math.PI / 2);
  mission.WaveDirector.update(0.66);
  const old = ai.Enemies.list.find(enemy => enemy.encounterEntry === 1);
  assertRear(old, 'brawler');
  const originalPosition = old.pos.clone();
  mission.WaveDirector.update(0.66);
  reset('balcony', point, Math.PI / 2);
  assert.equal(old.alive, false);
  assert.equal(old.removed, true);
  assert.equal(mission.WaveDirector.schedule.spawned, 0);
  assert.equal(mission.WaveDirector.schedule.pending.length, 0);
  assert.equal(mission.WaveDirector.schedule.timer, ZONE_WAVE_CONFIG.balcony.firstWave);
  assert.equal(mission.WaveDirector.routeProgress.distance, 0);
  assert.ok([...mission.spawnCursors.values()].every(value => value === 0));
  mission.WaveDirector.update(0.66);
  const next = ai.Enemies.list.find(enemy => enemy.encounterEntry === 1);
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
