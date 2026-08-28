import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStairPursuit, stairPursuitWaypoint, stairPursuitMemorySeconds, resetStairPursuit, primeEnemyInvestigation } from '../../src/game/stair-pursuit.js';
import { capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

const point = (x, y, z) => ({ x, y, z });
const harness = createEnemyAIHarness();
const rearBases = [point(-19.45, 4, -9), point(-16.55, 6.4, -0.85), point(-19.45, 9, -9), point(-16.55, 11.6, -0.85)];
const turnedGoals = [point(-16.6, 6.4, -0.85), point(-19.4, 9, -9), point(-16.6, 11.6, -0.85), point(-19.4, 14, -9)];

function pursue(type, start, goal, { prime = true, seconds = 12, zone = 'stairwell' } = {}) {
  harness.reset(goal);
  const enemy = harness.spawn(type, start, { prime, zone });
  const previous = enemy.pos.clone();
  let travelled = 0, lowest = enemy.pos.y;
  for (let tick = 0; tick < seconds * 120 && !harness.damage.length; tick++) {
    harness.step();
    const moved = previous.distanceTo(enemy.pos);
    assert.ok(moved < 0.6, `NPC cannot teleport along a stair route: ${moved}`);
    assert.ok(enemy.pos.toArray().every(Number.isFinite));
    assert.ok(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, harness.colliders, 1e-5), 'actual capsule cannot pass through a guard or slab');
    travelled += Math.hypot(previous.x - enemy.pos.x, previous.z - enemy.pos.z);
    lowest = Math.min(lowest, enemy.pos.y);
    previous.copy(enemy.pos);
  }
  return { enemy, hits: harness.damage.length, seconds: harness.clock.elapsed, travelled, lowest };
}

test('the authored route completes the far landing turn before crossing stair lanes', () => {
  const state = createStairPursuit();
  stairPursuitWaypoint(state, rearBases[1], turnedGoals[1]);
  const turn = state.path.findIndex(value => Math.abs(value.x + 16.6) < 1e-6 && Math.abs(value.y - 9) < 1e-6 && Math.abs(value.z + 9.2) < 1e-6);
  assert.ok(turn >= 0);
  assert.ok(state.path.slice(turn + 1).some(value => Math.abs(value.x + 19.4) < 1e-6), 'lane crossing follows the safe end platform');
  assert.ok(state.path.some(value => value.y > 6.4), 'the route retains real elevations');
  const pool = [...state.pointPool];
  resetStairPursuit(state);
  stairPursuitWaypoint(state, rearBases[1], turnedGoals[1]);
  assert.equal(state.pointPool[0], pool[0], 'replanning reuses waypoint storage');
});

test('priming snapshots an initial observation, invalidates sight cache and grants bounded attack grace', () => {
  const eye = new THREE.Vector3(-19.4, 10.72, -9);
  const enemy = { alive: true, zone: 'stairwell', pos: new THREE.Vector3(-19.45, 4.03, -9), losCached: true, swingTimer: 0.4, burstLeft: 3, windupRemaining: 0.2 };
  assert.equal(primeEnemyInvestigation(enemy, eye, 9), true);
  eye.set(0, 0, 0);
  assert.deepEqual(enemy.lastSeenPosition, point(-19.4, 10.72, -9));
  assert.equal(enemy.lastSeenFootY, 9);
  assert.equal(enemy.timeSinceSeen, 0);
  assert.equal(enemy.losCached, false);
  assert.equal(enemy.spawnGrace, 1);
  assert.equal(enemy.windupRemaining, -1);
  assert.equal(enemy.swingTimer, 0);
  assert.equal(enemy.burstLeft, 0);
  const duration = stairPursuitMemorySeconds(enemy.stairPursuit, point(-19.4, 9, -9), 3.6);
  assert.ok(duration >= 4 && duration <= 12);
  assert.equal(primeEnemyInvestigation({ alive: false }, eye, 4), false);
  assert.equal(primeEnemyInvestigation(enemy, point(NaN, 4, 0), 4), false);
});

for (const type of ['brawler', 'thug']) {
  test(`${type} climbs all four actual flights and catches a target beyond each guard turn`, () => {
    for (let index = 0; index < rearBases.length; index++) {
      const result = pursue(type, rearBases[index], turnedGoals[index]);
      assert.ok(result.hits > 0, `flight ${index + 1}: ${result.enemy.pos.toArray()}, state ${result.enemy.state}`);
      assert.ok(Math.abs(result.enemy.pos.y - turnedGoals[index].y) < 0.12, 'contact occurs on the upper landing');
      assert.ok(result.lowest >= rearBases[index].y - 0.05, 'pursuit cannot fall down an adjacent flight');
      assert.ok(result.seconds < 7, 'rear pressure reaches the landing promptly');
    }
  });

  test(`${type} reaches the climbing lane instead of walking underneath the target`, () => {
    for (let index = 0; index < rearBases.length; index++) {
      const base = rearBases[index];
      const wrongLane = point(base.x < -18 ? -16.55 : -19.45, base.y, base.z);
      const goal = point(base.x < -18 ? -19.4 : -16.6, turnedGoals[index].y, turnedGoals[index].z);
      const result = pursue(type, wrongLane, goal);
      assert.ok(result.hits > 0, `flight ${index + 1}: ${result.enemy.pos.toArray()}`);
      assert.ok(result.lowest >= base.y - 0.05, 'the lower end platform remains the connecting path');
    }
  });

  test(`${type} follows a remembered target across two flights with the same horizontal coordinates`, () => {
    const result = pursue(type, rearBases[0], point(-19.4, 9, -9));
    assert.ok(result.hits > 0);
    assert.ok(result.travelled > 18, 'the NPC takes the stairs instead of attacking through a storey');
    assert.ok(Math.abs(result.enemy.pos.y - 9) < 0.12);
  });

  test(`${type} follows the final landing through the actual roof doorway`, () => {
    const result = pursue(type, rearBases[3], point(-13.5, 14, -8.4));
    assert.ok(result.hits > 0);
    assert.ok(Math.abs(result.enemy.pos.y - 14) < 0.12);
  });
}

test('only a primed arrival receives attack grace; normal enemies keep their established timing', () => {
  const goal = point(0, 4, 0.95), start = point(1, 4, 0.95);
  harness.reset(goal);
  const ordinary = harness.spawn('brawler', start, { zone: 'balcony' });
  ordinary.yaw = -Math.PI / 2;
  assert.equal(ordinary.spawnGrace, 0);
  assert.equal(harness.enemyAttackPlayer(ordinary), true);
  harness.reset(goal);
  const arriving = harness.spawn('brawler', start, { zone: 'balcony', prime: true });
  arriving.yaw = -Math.PI / 2;
  assert.equal(harness.enemyAttackPlayer(arriving), false);
  for (let tick = 0; tick < 114; tick++) harness.step();
  assert.equal(harness.damage.length, 0);
  assert.equal(arriving.windupRemaining, -1);
  assert.equal(arriving.swingTimer, 0);
  for (let tick = 0; tick < 60; tick++) harness.step();
  assert.ok(harness.damage.length > 0);
  assert.ok(harness.damage[0].time >= 1);
  assert.equal(arriving.stairPursuit.active, false, 'balcony steering does not enter the stair route');
});

test('an unseen moving player does not refresh a stair observation beyond twelve seconds', () => {
  const observation = point(-13.5, 14, -8.4);
  harness.reset(observation);
  const enemy = harness.spawn('thug', rearBases[0], { prime: true });
  const rememberedEye = enemy.lastSeenPosition.clone();
  harness.placePlayer(point(-30, 0.08, 35));
  let firstIdle = null;
  for (let tick = 0; tick < 18 * 120; tick++) {
    harness.step();
    assert.equal(enemy.lastSeenPosition.equals(rememberedEye), true, 'occluded player movement is never observed');
    if (enemy.state === 'idle' && harness.clock.elapsed > 0.05 && firstIdle === null) firstIdle = harness.clock.elapsed;
  }
  assert.ok(firstIdle >= 11.8 && firstIdle <= 12.05, `bounded investigation: ${firstIdle}`);
  assert.equal(enemy.lastSeenPlayer, false);
  assert.equal(enemy.state, 'idle');
  assert.equal(enemy.stairPursuit.active, false);
  assert.equal(harness.damage.length, 0);
});

test('a moving player can be pursued through all four flights using only actual sight observations', () => {
  for (const type of ['brawler', 'thug']) {
    const start = point(-19.4, 6.4, -0.65);
    harness.reset(start);
    const enemy = harness.spawn(type, rearBases[0], { prime: true });
    const playerBody = { position: new THREE.Vector3(start.x, start.y + 0.02, start.z), velocity: new THREE.Vector3(), radius: 0.32, height: 1.84, onGround: true };
    const targets = [...STAIRS.route.slice(5), STAIRS.roofExit];
    let targetIndex = 0;
    const reachedLandings = new Set();
    for (let tick = 0; tick < 40 * 120; tick++) {
      const target = targets[targetIndex];
      if (target) {
        const dx = target[0] - playerBody.position.x, dz = target[2] - playerBody.position.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.035 && Math.abs(playerBody.position.y - target[1]) < 0.08) targetIndex++;
        const speed = Math.min(1.6, length * 120);
        playerBody.velocity.x = length > 0.001 ? dx / length * speed : 0;
        playerBody.velocity.z = length > 0.001 ? dz / length * speed : 0;
      } else { playerBody.velocity.x = 0; playerBody.velocity.z = 0; }
      playerBody.velocity.y -= 22 / 120;
      moveCapsule(playerBody, 1 / 120, harness.colliders, targetIndex < targets.length);
      harness.placePlayer(playerBody.position);
      harness.step();
      for (const landing of STAIRS.landings.slice(1)) {
        if (Math.abs(enemy.pos.y - landing.y) < 0.08) reachedLandings.add(landing.id);
      }
      if (targetIndex === targets.length && Math.abs(enemy.pos.y - 14) < 0.12
        && Math.hypot(enemy.pos.x - playerBody.position.x, enemy.pos.z - playerBody.position.z) < enemy.def.attackRange + 0.1) break;
    }
    assert.equal(targetIndex, targets.length, 'the physical player finishes the authored ascent');
    assert.equal(reachedLandings.size, 4, `${type} follows every flight and turn`);
    assert.ok(Math.abs(enemy.pos.y - 14) < 0.12, `${type} reaches the roof level, not a lower projected floor`);
    assert.ok(harness.damage.length > 0, 'actual melee checks connect during pursuit');
  }
});
