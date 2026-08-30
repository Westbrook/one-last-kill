import test from 'node:test';
import assert from 'node:assert/strict';
import { createRageState, RAGE_CONFIG, Rage } from '../../src/game/rage-rules.js';
import { createCombatStats, CombatStats } from '../../src/game/combat-stats.js';

function fixture(health = 20, options) {
  const player = { health }, rage = createRageState(options);
  const stats = createCombatStats({ rage });
  const kills = (count = 4) => { for (let i = 0; i < count; i++) stats.recordKill(); };
  return { player, rage, stats, kills };
}

test('rage requires strictly below 30% health and more than three credited kills', () => {
  for (const health of [0, 1, 29.999, 30, 31, 100]) {
    const { player, rage, stats } = fixture(health);
    for (let kills = 0; kills <= 4; kills++) {
      const eligible = health > 0 && health < 30 && kills >= 4;
      assert.equal(rage.available(player), eligible, `health=${health}, kills=${kills}`);
      if (kills < 4) stats.recordKill(kills === 0);
    }
    assert.equal(rage.enter(player), health > 0 && health < 30);
    assert.equal(player.health, health > 0 && health < 30 ? health * 2 : health);
    assert.equal(stats.snapshot().kills, 4);
    assert.equal(stats.snapshot().headshots, 1, 'a headshot counts as one kill');
  }
});

test('shots, hits and expired streaks do not replace the rolling kill count', () => {
  const { player, rage, stats, kills } = fixture();
  for (let i = 0; i < 20; i++) stats.recordShot(true);
  kills(3);
  assert.equal(rage.available(player), false);
  stats.recordKill();
  stats.update(6); rage.update(6, player);
  assert.equal(stats.streak, 0);
  assert.equal(rage.available(player), true, 'the five-second streak is independent of rage eligibility');
});

test('only kills strictly within the last minute qualify and older kills age out independently', () => {
  const { player, rage, stats, kills } = fixture();
  kills(1);
  rage.update(30, player); kills(3);
  rage.update(29.999, player);
  assert.equal(rage.available(player), true);
  rage.update(0.001, player);
  assert.equal(rage.snapshot(player).recentKills, 3);
  assert.equal(rage.available(player), false, 'a kill exactly sixty seconds old has expired');
  stats.recordKill();
  assert.equal(rage.available(player), true);
  rage.update(30, player);
  assert.equal(rage.snapshot(player).recentKills, 1);
  assert.equal(rage.available(player), false);
});

test('the kill lookback is configurable without changing another instance or the defaults', () => {
  const short = fixture(20, { killWindowSeconds: 5 });
  const standard = fixture();
  short.kills(); standard.kills();
  short.rage.update(5, short.player); standard.rage.update(5, standard.player);
  assert.equal(short.rage.available(short.player), false);
  assert.equal(standard.rage.available(standard.player), true);
  assert.equal(RAGE_CONFIG.killWindowSeconds, 60);
  assert.equal(standard.rage.config.killWindowSeconds, 60);
  for (const killWindowSeconds of [0, -1, NaN, Infinity, '60']) {
    assert.throws(() => createRageState({ killWindowSeconds }), RangeError);
  }
});

test('rage doubles current health, respects a supplied maximum and cannot stack while active', () => {
  const { player, rage, kills } = fixture(10);
  kills();
  assert.equal(rage.enter(player), true);
  assert.equal(player.health, 20);
  assert.equal(rage.enter(player), false, 'the doubled health is still below 30%, but active rage cannot stack');
  assert.equal(player.health, 20);
  rage.update(4, player);
  assert.equal(rage.snapshot(player).remaining, 6, 'a rejected activation did not restart the deadline');
  const scaled = fixture(50); scaled.kills();
  assert.equal(scaled.rage.enter(scaled.player), false);
  assert.equal(scaled.rage.enter(scaled.player, 200), true);
  assert.equal(scaled.player.health, 100);
});

test('a kill before ten seconds secures remaining health without healing again or later reverting', () => {
  const { player, rage, stats, kills } = fixture();
  kills(); rage.enter(player);
  rage.update(9.999, player);
  player.health -= 13;
  stats.recordKill();
  assert.equal(player.health, 27);
  assert.equal(rage.snapshot(player).active, false);
  assert.equal(rage.takeOutcome(), 'secured');
  assert.equal(rage.takeOutcome(), null, 'the outcome is delivered once');
  rage.update(120, player);
  assert.equal(player.health, 27);
});

test('a kill at or after the deadline cannot secure an expired health boost', () => {
  for (const duration of [10, 10.001, 15]) {
    const { player, rage, stats, kills } = fixture();
    kills(); rage.enter(player);
    rage.update(duration, player);
    stats.recordKill();
    assert.equal(player.health, 20);
    assert.equal(rage.snapshot(player).active, false);
    assert.equal(rage.takeOutcome(), 'expired');
  }
});

test('failure returns exactly the activation health after either damage or healing while alive', () => {
  for (const laterHealth of [1, 12, 35, 80, 100]) {
    const { player, rage, kills } = fixture(24);
    kills(); rage.enter(player);
    player.health = laterHealth;
    rage.update(9.5, player);
    assert.equal(player.health, laterHealth);
    rage.update(0.5, player);
    assert.equal(player.health, 24);
    assert.equal(rage.takeOutcome(), 'expired');
    rage.update(1, player);
    assert.equal(rage.takeOutcome(), null);
  }
});

test('simulation steps expire rage exactly at the ten-second boundary at common update rates', () => {
  for (const rate of [30, 60, 120]) {
    const { player, rage, kills } = fixture();
    kills(); rage.enter(player);
    for (let i = 0; i < rate * 10 - 1; i++) rage.update(1 / rate, player);
    assert.equal(player.health, 40, `${rate} Hz: still active before the deadline`);
    assert.equal(rage.snapshot(player).active, true);
    rage.update(1 / rate, player);
    assert.equal(player.health, 20, `${rate} Hz: expired on the deadline`);
    assert.equal(rage.takeOutcome(), 'expired');
  }
});

test('nonpositive or invalid time cannot consume eligibility or an active boost', () => {
  const { player, rage, kills } = fixture();
  kills(); rage.enter(player);
  const before = rage.snapshot(player);
  for (const dt of [0, -1, NaN, Infinity]) rage.update(dt, player);
  assert.deepEqual(rage.snapshot(player), before);
  assert.equal(player.health, 40);
});

test('death discards the wager and recent kills without restoring health', () => {
  for (const deadHealth of [0, -1]) {
    const { player, rage, kills } = fixture();
    kills(); rage.enter(player);
    player.health = deadHealth;
    rage.update(10, player);
    assert.equal(player.health, deadHealth);
    assert.deepEqual(rage.snapshot(player), { available: false, active: false, remaining: 0, recentKills: 0 });
    assert.equal(rage.takeOutcome(), null);
    player.health = 20;
    assert.equal(rage.enter(player), false, 'respawning cannot reuse the previous life’s kills');
  }
});

test('completed wagers do not consume kills or invent an extra activation cooldown', () => {
  for (const secured of [false, true]) {
    const { player, rage, stats, kills } = fixture(10);
    kills(); rage.enter(player);
    if (secured) stats.recordKill();
    else rage.update(10, player);
    assert.equal(rage.available(player), true);
    assert.equal(rage.enter(player), true);
    assert.equal(player.health, secured ? 40 : 20);
  }
});

test('CombatStats reset clears rage eligibility and the pending outcome', () => {
  const { player, rage, stats, kills } = fixture();
  kills(); rage.enter(player); stats.recordKill();
  stats.reset();
  assert.equal(rage.takeOutcome(), null);
  assert.equal(rage.snapshot(player).recentKills, 0);
  player.health = 20;
  assert.equal(rage.enter(player), false);
  assert.equal(stats.snapshot().kills, 0);
});

test('the exported CombatStats singleton forwards kills and resets to the exported Rage singleton', () => {
  const player = { health: 20 };
  CombatStats.reset();
  try {
    for (let i = 0; i < 4; i++) CombatStats.recordKill();
    assert.equal(Rage.enter(player), true);
    CombatStats.reset();
    assert.equal(Rage.snapshot(player).active, false);
    assert.equal(Rage.snapshot(player).recentKills, 0);
  } finally { CombatStats.reset(); }
});
