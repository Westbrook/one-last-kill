import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

// Record only event names. This fixture never imports a live audio device.
const events = [];
const h = createEnemyAIHarness({ audio: new Proxy({}, { get: (_target, method) => () => events.push(method) }) });

test('a real NPC shotgun cluster keeps four damage contacts but emits one discharge cue', () => {
  h.reset({ x: 0, y: 4.02, z: 0.95 }); events.length = 0;
  const actor = h.spawn('bruiser', { x: -6, y: 4, z: 0.95 }, { zone: 'balcony' });
  for (let left = actor.def.burst; left > 0; left--) {
    actor.burstLeft = left;
    assert.equal(h.enemyAttackPlayer(actor), true, 'Each original pellet still reaches the player');
  }
  assert.equal(h.damage.length, actor.def.burst);
  assert.equal(events.filter(name => name === 'shotgunShot').length, 1);
  actor.burstLeft = actor.def.burst;
  h.enemyAttackPlayer(actor);
  assert.equal(events.filter(name => name === 'shotgunShot').length, 2, 'A new cluster gets a new blast');
});

test('automatic NPC weapons retain one discharge cue per actual round in their burst', () => {
  for (const [type, sound] of [['hitman', 'smgShot'], ['enforcer', 'machinegunShot']]) {
    h.reset({ x: 0, y: 4.02, z: 0.95 }); events.length = 0;
    const actor = h.spawn(type, { x: -6, y: 4, z: 0.95 }, { zone: 'balcony' });
    for (let left = actor.def.burst; left > 0; left--) {
      actor.burstLeft = left;
      assert.equal(h.enemyAttackPlayer(actor), true);
    }
    assert.equal(h.damage.length, actor.def.burst);
    assert.equal(events.filter(name => name === sound).length, actor.def.burst);
  }
});
