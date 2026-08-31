import test from 'node:test';
import assert from 'node:assert/strict';
import { capsuleHasClearance, Colliders } from '../../src/core/collision.js';
import { createDefenseEncounter } from '../../src/game/defense-rules.js';
import { createEncounterVariation } from '../../src/game/encounter-variation.js';
import { selectEncounterSpawn } from '../../src/game/encounter-spawns.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { ROOF } from '../../src/world/layout.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

// Production spawn selection, enemy AI and capsule movement against the real
// world geometry. Only character rendering, audio and player damage are sinks.
const h = createEnemyAIHarness();

function streetOpening() {
  h.reset(DISTRICT.street.checkpoint);
  const config = createDefenseEncounter({ arena: 'street', waves: 10, difficulty: 'average' });
  const spawn = selectEncounterSpawn({
    config, waveIndex: 0, entryIndex: 0, type: config.waves[0][0],
    playerFoot: DISTRICT.street.checkpoint, yaw: DISTRICT.street.checkpoint.yaw,
    weapon: { current: 'fists' }, variation: createEncounterVariation(config, 5),
    floorAt: point => h.surfaceTopAt(point.x, point.y, point.z),
    blocked: point => !capsuleHasClearance(point, 0.48, 2.02, Colliders.list),
  });
  assert.ok(spawn, 'the seeded opening must use an accepted production arrival');
  assert.ok(Math.hypot(spawn.point.x - h.player.pos.x, spawn.point.z - h.player.pos.z) > 30);
  return h.spawn(spawn.type, spawn.point, { zone: 'street', prime: true });
}

test('a distant seeded street-defense arrival keeps advancing until it reaches and attacks the defender', () => {
  const enemy = streetOpening();
  enemy.encounterKey = 'defense-street';
  for (let step = 0; step < 30 * 120 && !h.damage.length; step++) h.step();
  assert.ok(h.damage.length > 0, 'the first wave must not idle forever outside normal alert range');
  assert.equal(h.damage[0].attacker, enemy);
  assert.equal(enemy.state, 'attack');
  assert.equal(h.hasLineOfSight(enemy), true, 'attack still requires actual sight of the stationary defender');
  assert.ok(Math.hypot(enemy.pos.x - h.player.pos.x, enemy.pos.z - h.player.pos.z) < 1.5);
});

test('campaign arrivals still forget a distant observation and do not learn an unseen player movement', () => {
  const enemy = streetOpening();
  enemy.encounterKey = 'street';
  const observation = enemy.lastSeenPosition.clone();
  for (let step = 0; step < 20 * 120; step++) h.step();
  assert.equal(enemy.state, 'idle');
  assert.equal(enemy.lastSeenPlayer, false);
  assert.equal(h.damage.length, 0);
  const stopped = enemy.pos.clone();
  h.placePlayer({ x: 32, y: 0.05, z: 12.2 });
  for (let step = 0; step < 120; step++) h.step();
  assert.ok(enemy.lastSeenPosition.equals(observation));
  assert.ok(enemy.pos.equals(stopped), 'campaign investigation has its original bounded memory');
});

test('defense movement updates its arena objective when the defender moves beyond alert range', () => {
  h.reset(DISTRICT.street.checkpoint);
  const enemy = h.spawn('brawler', DISTRICT.street.spawnPockets[0], { zone: 'street', prime: true });
  enemy.encounterKey = 'defense-street';
  h.placePlayer({ x: 32, y: 0.05, z: 18 });
  h.step(); h.step();
  assert.ok(Math.hypot(enemy.pos.x - h.player.pos.x, enemy.pos.z - h.player.pos.z) > enemy.def.alertRange);
  assert.equal(enemy.state, 'investigate');
  assert.ok(enemy.lastSeenPosition.equals(h.player.pos));
  assert.ok(Math.abs(enemy.lastSeenFootY - 0.05) < 1e-9);
  assert.equal(enemy.aimCommitted, false);
  assert.equal(h.damage.length, 0);
});

test('a defense gunman investigates around the real rooftop house without firing through it', () => {
  const house = ROOF.serviceHouse, z = (house.z1 + house.z2) / 2;
  h.reset({ x: house.x2 + 1.2, y: ROOF.floorY, z });
  const enemy = h.spawn('gunman', { x: house.x1 - 1.2, y: ROOF.floorY, z }, { zone: 'roof', prime: true });
  enemy.encounterKey = 'defense-roof';
  assert.equal(h.hasLineOfSight(enemy), false);
  const origin = enemy.pos.clone();
  for (let step = 0; step < 300; step++) h.step();
  assert.ok(enemy.pos.distanceTo(origin) > 1, 'the objective requests a real route around solid cover');
  assert.equal(enemy.state, 'investigate');
  assert.equal(h.hasLineOfSight(enemy), false);
  assert.equal(enemy.aimCommitted, false);
  assert.equal(h.damage.length, 0);
  assert.equal(h.enemyAttackPlayer(enemy), false, 'even a direct attack attempt respects ballistic cover');
  assert.equal(h.damage.length, 0);
});
