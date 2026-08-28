import test from 'node:test';
import assert from 'node:assert/strict';
import {
  damageForHit, advanceAttackWindup, updateAwareness, canMeleeHit,
  isSegmentOccluded, oldestCorpseIndex, invalidateEnemy,
} from '../../src/game/combat-rules.js';

test('damage applies one body-part multiplier to base weapon damage', () => {
  assert.equal(damageForHit(20, 'body'), 20);
  assert.equal(damageForHit(20, 'head'), 50);
  assert.equal(damageForHit(20, 'limb'), 14);
  assert.equal(damageForHit(20, 'unknown'), 20);
  assert.equal(damageForHit(20, 'toString'), 20);
  assert.equal(damageForHit(28, 'head'), 70);
});

test('invalid damage cannot heal enemies or corrupt health', () => {
  for (const amount of [-10, 0, NaN, Infinity, -Infinity, undefined, '20']) {
    assert.equal(damageForHit(amount, 'head'), 0);
  }
});

test('a melee windup completes once using only simulation time', () => {
  const attack = { windupRemaining: 0.275 };
  assert.equal(advanceAttackWindup(attack, 0.1), false);
  assert.equal(advanceAttackWindup(attack, 0), false);
  assert.ok(Math.abs(attack.windupRemaining - 0.175) < 1e-9);
  assert.equal(advanceAttackWindup(attack, 0.1), false);
  assert.equal(advanceAttackWindup(attack, 0.075), true);
  assert.equal(attack.windupRemaining, -1);
  assert.equal(advanceAttackWindup(attack, 10), false);
});

test('interrupting an attack cancels damage, including a just-due windup', () => {
  for (const remaining of [0.2, 0]) {
    const attack = { windupRemaining: remaining };
    assert.equal(advanceAttackWindup(attack, 0.3, true), false);
    assert.equal(advanceAttackWindup(attack, 1), false);
  }
});

test('windup completion is stable at 60 Hz and 120 Hz', () => {
  for (const rate of [60, 120]) {
    const attack = { windupRemaining: 0.5 };
    let completed = 0;
    for (let i = 0; i < rate; i++) {
      if (advanceAttackWindup(attack, 1 / rate)) completed++;
    }
    assert.equal(completed, 1);
  }
});

function memory() {
  return {
    lastSeenPosition: { x: 0, y: 0, z: 0 },
    lastSeenPlayer: false,
    timeSinceSeen: Infinity,
    stateTime: 100,
  };
}

test('unaware enemies do not acquire hidden targets', () => {
  const enemy = memory();
  assert.equal(updateAwareness(enemy, { x: 4, y: 2, z: 8 }, false, 1), 'idle');
  assert.deepEqual(enemy.lastSeenPosition, { x: 0, y: 0, z: 0 });
});

test('investigation uses the last observed position, not a moving hidden target', () => {
  const enemy = memory();
  const target = { x: 4, y: 2, z: 8 };
  assert.equal(updateAwareness(enemy, target, true, 0.1), 'visible');
  target.x = 30;
  assert.equal(updateAwareness(enemy, target, false, 3.9), 'investigate');
  assert.deepEqual(enemy.lastSeenPosition, { x: 4, y: 2, z: 8 });
  assert.equal(updateAwareness(enemy, target, false, 0.1), 'idle');
  assert.equal(enemy.lastSeenPlayer, false);
});

test('reacquisition refreshes memory regardless of enemy age', () => {
  const enemy = memory();
  const target = { x: 2, y: 1, z: 3 };
  updateAwareness(enemy, target, true, 0.1);
  updateAwareness(enemy, target, false, 3.8);
  assert.equal(updateAwareness(enemy, target, true, 0.1), 'visible');
  assert.equal(enemy.timeSinceSeen, 0);
  assert.equal(updateAwareness(enemy, target, false, 1), 'investigate');
});

test('melee needs reach, a facing target, similar floor height, and clear geometry', () => {
  const valid = { distance: 1.2, heightDifference: 0, facingDot: 1, clear: true, range: 1.7 };
  assert.equal(canMeleeHit(valid), true);
  assert.equal(canMeleeHit({ ...valid, distance: 2.1 }), false);
  assert.equal(canMeleeHit({ ...valid, heightDifference: 2.6 }), false);
  assert.equal(canMeleeHit({ ...valid, heightDifference: -2.6 }), false);
  assert.equal(canMeleeHit({ ...valid, facingDot: -1 }), false);
  assert.equal(canMeleeHit({ ...valid, clear: false }), false);
  assert.equal(canMeleeHit({ ...valid, distance: NaN }), false);
});

const box = (x1, y1, z1, x2, y2, z2) => ({
  min: { x: x1, y: y1, z: z1 }, max: { x: x2, y: y2, z: z2 },
});

test('line of sight blocks intervening walls but ignores geometry beyond the target', () => {
  const start = { x: 0, y: 1.5, z: 0 }, end = { x: 10, y: 1.5, z: 0 };
  assert.equal(isSegmentOccluded(start, end, []), false);
  assert.equal(isSegmentOccluded(start, end, [box(4, 0, -1, 5, 3, 1)]), true);
  assert.equal(isSegmentOccluded(start, end, [box(11, 0, -1, 12, 3, 1)]), false);
  assert.equal(isSegmentOccluded(start, end, [box(-2, 0, -1, -1, 3, 1)]), false);
  assert.equal(isSegmentOccluded(start, end, [box(4, 0, 1, 5, 3, 2)]), false);
});

test('line of sight handles parallel rays, floor separation, and starts inside solids', () => {
  assert.equal(isSegmentOccluded(
    { x: 1, y: 1, z: 1 }, { x: 1, y: 5, z: 1 }, [box(0, 2, 0, 2, 2.2, 2)],
  ), true);
  assert.equal(isSegmentOccluded(
    { x: 1, y: 1, z: 1 }, { x: 8, y: 1, z: 1 }, [box(0, 0, 0, 2, 2, 2)],
  ), true);
  assert.equal(isSegmentOccluded(
    { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, [box(-1, -1, -1, 1, 1, 1)],
  ), false);
});

test('corpse recycling chooses the oldest matching dead rig and never a live one', () => {
  const enemies = [
    { type: 'gunman', alive: true, corpseTimer: 100 },
    { type: 'thug', alive: false, corpseTimer: 12 },
    { type: 'gunman', alive: false, corpseTimer: 5 },
    { type: 'gunman', alive: false, corpseTimer: 8 },
    { type: 'gunman', alive: false, removed: true, corpseTimer: 200 },
  ];
  assert.equal(oldestCorpseIndex(enemies), 1);
  assert.equal(oldestCorpseIndex(enemies, 'gunman'), 3);
  assert.equal(oldestCorpseIndex(enemies, 'enforcer'), -1);
  assert.equal(oldestCorpseIndex([]), -1);
});

test('releasing an enemy cancels all attacks on retained references', () => {
  const enemy = { alive: true, removed: false, state: 'attack', windupRemaining: 0.1, burstLeft: 6, swingTimer: 0.5, aimCommitted: true };
  invalidateEnemy(enemy);
  assert.equal(enemy.alive, false);
  assert.equal(enemy.removed, true);
  assert.equal(enemy.state, 'removed');
  assert.equal(enemy.burstLeft, 0);
  assert.equal(enemy.swingTimer, 0);
  assert.equal(enemy.aimCommitted, false);
  assert.equal(advanceAttackWindup(enemy, 1), false);
});
