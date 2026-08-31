import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDefenseDirector } from '../../src/game/defense-director.js';
import { DEFENSE_ARENAS, DEFENSE_WAVE_COUNTS } from '../../src/game/defense-rules.js';
import { createCombatStats } from '../../src/game/combat-stats.js';

// Exercise the production director and EncounterSchedule. These dependencies
// only record successful allocations and presentation; no GPU or world clock
// is involved. Fixture deaths do not claim player combat-stat credit.
function createHarness() {
  const director = createDefenseDirector(), stats = createCombatStats();
  const enemies = [], births = [], attempts = [], refills = [], wins = [];
  const objectives = [], messages = [], returns = [];
  let foot, dead = false, grounded = true, blocked = false, config, run;
  let seedCalls = 0, suppliesCleared = 0, suppliesElapsed = 0, supplyWave = null;

  const living = () => enemies.filter(enemy => enemy.alive);
  function countEnemies(zone, key, counts) {
    assert.equal(zone, run.arena);
    assert.equal(key, 'defense-' + run.arena);
    counts.total = counts.alive = counts.rearAlive = 0;
    counts.aliveByWave.fill(0);
    counts.frontAliveByWave.fill(0);
    counts.byType = {};
    for (const enemy of living()) {
      if (enemy.zone !== zone) continue;
      counts.total++;
      counts.byType[enemy.type] = (counts.byType[enemy.type] || 0) + 1;
      if (enemy.key === key) {
        counts.aliveByWave[enemy.waveIndex]++;
        counts.frontAliveByWave[enemy.waveIndex]++;
      }
    }
    counts.alive = counts.total;
  }

  director.init({
    nextSeed() { seedCalls++; return null; },
    createCounts(settings) {
      config = settings;
      return { total: 0, alive: 0, rearAlive: 0, byType: {},
        aliveByWave: Array(settings.waveCount).fill(0),
        frontAliveByWave: Array(settings.waveCount).fill(0) };
    },
    countEnemies,
    spawn(key, zone, schedule, counts) {
      assert.equal(schedule.config, config);
      assert.equal(key, 'defense-' + run.arena);
      assert.equal(zone, run.arena);
      return schedule.spawnAvailable(counts, entry => {
        attempts.push(entry);
        if (blocked) return false;
        const enemy = { ...entry, key, zone, alive: true };
        enemies.push(enemy);
        births.push(enemy);
        const alive = living();
        assert.ok(alive.length <= config.maxAlive, 'A queued roster obeys its live cap');
        for (const [type, maximum] of Object.entries(config.typeCaps)) {
          assert.ok(alive.filter(contact => contact.type === type).length <= maximum);
        }
        return true;
      });
    },
    stats: () => stats.snapshot(),
    playerFoot: () => foot,
    isDead: () => dead,
    isGrounded: () => grounded,
    returnPlayer(point) { foot = { ...point }; returns.push({ ...point }); },
    supplies: {
      refill(value) { refills.push({ ...value, performance: { ...value.performance } }); supplyWave = value.wave; },
      clear() { suppliesCleared++; supplyWave = null; suppliesElapsed = 0; },
      update(dt) { suppliesElapsed += dt; },
      snapshot: () => ({ wave: supplyWave, elapsed: suppliesElapsed }),
    },
    objective: value => objectives.push(value),
    message: (...value) => messages.push(value),
    onWin: result => wins.push(result),
  });

  function start(options = {}) {
    run = Object.freeze({ mode: 'defense', arena: 'roof', waves: 10, difficulty: 'average', locked: true, ...options });
    foot = { ...DEFENSE_ARENAS[run.arena].checkpoint };
    director.start(run);
    return run;
  }
  function step(dt = 0.25) { director.update(dt); }
  function until(predicate, seconds = 30) {
    for (let index = 0; index < seconds * 4 && !predicate(); index++) step();
    assert.ok(predicate(), 'Bounded defense progress: ' + JSON.stringify(director.snapshot()));
  }
  function defeat(contacts = living()) { for (const enemy of contacts) enemy.alive = false; }

  return { director, stats, enemies, births, attempts, refills, wins, objectives, messages, returns,
    start, step, until, defeat, living,
    get config() { return config; },
    get run() { return run; },
    get seedCalls() { return seedCalls; },
    get suppliesCleared() { return suppliesCleared; },
    get foot() { return foot; },
    set foot(value) { foot = value; },
    set dead(value) { dead = value; },
    set grounded(value) { grounded = value; },
    set blocked(value) { blocked = value; },
  };
}

test('roof and street defense finish each selected duration only after the final contact dies', () => {
  for (const arena of ['roof', 'street']) {
    for (const waves of DEFENSE_WAVE_COUNTS) {
      const fixture = createHarness();
      fixture.start({ arena, waves, difficulty: 'very-hard' });
      assert.equal(fixture.director.isActive(), true);
      assert.equal(fixture.director.snapshot().wavesTotal, waves);
      assert.equal(fixture.refills.length, 1);

      for (let wave = 1; wave <= waves; wave++) {
        fixture.until(() => fixture.director.snapshot().wave === wave);
        // Late rosters can exceed the live cap; reserve entries must still be
        // allocated before this wave can count as defended.
        for (let group = 0; fixture.director.snapshot().pending && group < 20; group++) {
          fixture.defeat();
          fixture.step(0.7);
        }
        assert.equal(fixture.director.snapshot().pending, 0);
        assert.ok(fixture.living().length > 0);
        assert.equal(fixture.births.filter(enemy => enemy.waveIndex === wave - 1).length,
          fixture.config.waves[wave - 1].length);
        fixture.defeat(fixture.living().slice(1));
        fixture.step(60);
        assert.equal(fixture.director.snapshot().wave, wave, 'A living contact prevents the next wave');
        assert.equal(fixture.director.snapshot().wavesSurvived, wave - 1);
        assert.equal(fixture.refills.length, wave, 'Survivors cannot trigger early supplies');
        assert.equal(fixture.wins.length, 0, 'The wave count alone cannot grant victory');

        fixture.defeat();
        fixture.step();
        assert.equal(fixture.director.snapshot().wavesSurvived, wave);
        assert.equal(fixture.refills.length, Math.min(waves, wave + 1));
      }

      assert.equal(fixture.director.isActive(), false);
      assert.equal(fixture.director.isResolved(), true);
      assert.equal(fixture.wins.length, 1);
      assert.equal(fixture.births.length, fixture.config.totalContacts);
      assert.deepEqual(fixture.refills.map(refill => refill.wave), Array.from({ length: waves }, (_, index) => index + 1));
      const result = fixture.wins[0];
      assert.equal(result.arena, arena);
      assert.equal(result.difficulty, 'very-hard');
      assert.equal(result.wavesTotal, waves);
      assert.equal(result.wavesSurvived, waves);
      assert.equal(result.alive, 0);
      assert.equal(result.pending, 0);
      assert.equal(result.spawned, result.totalContacts);
      fixture.step(1000);
      assert.equal(fixture.wins.length, 1, 'Victory publishes exactly once');
      assert.equal(fixture.refills.length, waves, 'There is no supply for a nonexistent next wave');
    }
  }
});

test('blocked allocations retain the original pending contacts without extra waves or supplies', () => {
  const fixture = createHarness();
  fixture.blocked = true;
  fixture.start({ arena: 'street', difficulty: 'hard' });
  fixture.until(() => fixture.director.snapshot().wave === 1);
  const initial = [...fixture.attempts];
  assert.equal(initial.length, fixture.config.waves[0].length);
  for (let retry = 0; retry < 5; retry++) {
    fixture.step(1);
    assert.equal(fixture.director.snapshot().spawned, 0);
    assert.equal(fixture.director.snapshot().pending, initial.length);
    assert.equal(fixture.director.snapshot().wavesSurvived, 0);
    assert.equal(fixture.refills.length, 1);
    assert.ok(fixture.attempts.slice(-initial.length).every((entry, index) => entry === initial[index]));
  }
  fixture.blocked = false;
  fixture.until(() => fixture.director.snapshot().pending === 0);
  assert.equal(fixture.births.length, initial.length);
  assert.equal(fixture.director.snapshot().wave, 1);
  assert.equal(fixture.refills.length, 1);
  fixture.defeat();
  fixture.step();
  assert.deepEqual(fixture.refills.map(refill => refill.wave), [1, 2]);
});

test('pausing the gameplay step freezes wave and supply clocks, and dead players cannot advance', async () => {
  const fixture = createHarness();
  fixture.start();
  fixture.step(0.5);
  const paused = fixture.director.snapshot();
  await delay(25);
  assert.deepEqual(fixture.director.snapshot(), paused, 'Wall-clock time cannot progress a paused defense');
  for (const dt of [0, -1, NaN, Infinity]) fixture.step(dt);
  assert.deepEqual(fixture.director.snapshot(), paused);
  fixture.dead = true;
  fixture.step(1000);
  assert.deepEqual(fixture.director.snapshot(), paused);
  fixture.dead = false;
  fixture.step(0.5);
  assert.equal(fixture.director.snapshot().timer, paused.timer - 0.5);
  assert.equal(fixture.director.snapshot().supplies.elapsed, paused.supplies.elapsed + 0.5);
  assert.equal(fixture.refills.length, 1);
  assert.equal(fixture.births.length, 0);
});

test('per-wave resupply receives only the completed wave performance and damage', () => {
  const fixture = createHarness();
  // Existing statistics may be present when a retry enters the director.
  fixture.stats.recordShot(true, 'pistol', 30);
  fixture.stats.recordKill(false, 'pistol');
  fixture.start({ difficulty: 'easy' });
  assert.deepEqual(fixture.refills[0].performance, { damageTaken: 0, shots: 0, hits: 0, kills: 0 });
  fixture.until(() => fixture.director.snapshot().wave === 1);
  fixture.stats.recordShot(true, 'pistol', 30);
  fixture.stats.recordShot(false, 'pistol');
  fixture.stats.recordKill(false, 'pistol');
  fixture.director.recordDamage(14);
  fixture.director.recordDamage(7);
  fixture.director.recordDamage(-100);
  fixture.director.recordDamage(NaN);
  fixture.defeat();
  fixture.step();
  assert.deepEqual(fixture.refills[1], {
    arena: 'roof', wave: 2, difficulty: 'easy',
    performance: { damageTaken: 21, shots: 2, hits: 1, kills: 1 },
  });
  fixture.until(() => fixture.director.snapshot().wave === 2);
  fixture.stats.recordShot(true, 'pistol', 30);
  fixture.stats.recordKill(false, 'pistol');
  fixture.director.recordDamage(3);
  fixture.defeat();
  fixture.step();
  assert.deepEqual(fixture.refills[2].performance, { damageTaken: 3, shots: 1, hits: 1, kills: 1 });
});

test('reset and a fresh start discard the previous life timers, wave state and supply performance', () => {
  const fixture = createHarness();
  const run = fixture.start({ arena: 'street', waves: 20, difficulty: 'very-easy' });
  fixture.until(() => fixture.director.snapshot().wave === 1);
  fixture.director.recordDamage(44);
  fixture.stats.recordShot(true, 'pistol', 30);
  fixture.defeat();
  fixture.step();
  assert.equal(fixture.director.snapshot().wavesSurvived, 1);
  fixture.director.reset();
  assert.equal(fixture.director.isActive(), false);
  assert.equal(fixture.director.isResolved(), false);
  assert.equal(fixture.director.snapshot().wave, 0);
  assert.equal(fixture.director.snapshot().arena, null);
  assert.equal(fixture.director.snapshot().supplies.wave, null);
  assert.equal(fixture.suppliesCleared, 1);
  const cleared = fixture.director.snapshot();
  fixture.step(1000);
  assert.deepEqual(fixture.director.snapshot(), cleared);

  // The mission owns physical actor removal and restores checkpoint stats.
  fixture.enemies.length = 0;
  fixture.stats.reset();
  fixture.start(run);
  const retried = fixture.director.snapshot();
  assert.equal(retried.active, true);
  assert.equal(retried.resolved, false);
  assert.equal(retried.difficulty, 'very-easy');
  assert.equal(retried.wavesTotal, 20);
  assert.equal(retried.wave, 0);
  assert.equal(retried.wavesSurvived, 0);
  assert.equal(retried.spawned, 0);
  assert.equal(retried.pending, 0);
  assert.equal(retried.timer, fixture.config.firstWave);
  assert.equal(fixture.seedCalls, 2);
  assert.deepEqual(fixture.refills.at(-1).performance, { damageTaken: 0, shots: 0, hits: 0, kills: 0 });
  fixture.until(() => fixture.director.snapshot().wave === 1);
  assert.equal(fixture.living().length, fixture.config.waves[0].length);
});

test('arena containment returns escaped players to their last grounded safe position', () => {
  for (const arena of ['roof', 'street']) {
    const fixture = createHarness();
    fixture.start({ arena });
    const initial = { ...fixture.foot };
    fixture.foot = { ...initial, x: initial.x + 0.5 };
    fixture.director.containPlayer();
    const safe = { ...fixture.foot };
    fixture.grounded = false;
    fixture.foot = { ...safe, x: safe.x + 0.3, y: safe.y + 1 };
    fixture.director.containPlayer();
    fixture.foot = { ...safe, y: safe.y - 5 };
    fixture.director.containPlayer();
    assert.deepEqual(fixture.returns, [safe], 'A jump does not replace the grounded return point');
    assert.deepEqual(fixture.foot, safe);
    assert.equal(fixture.messages.length, 1);
    fixture.foot = { ...safe, x: 1000 };
    fixture.director.containPlayer();
    assert.equal(fixture.messages.length, 1, 'Boundary feedback is throttled');
    assert.equal(fixture.director.snapshot().wave, 0);
    fixture.step(3);
    fixture.foot = { ...safe, x: 1000 };
    fixture.director.containPlayer();
    assert.equal(fixture.messages.length, 2);
    fixture.dead = true;
    fixture.foot = { ...safe, y: safe.y - 5 };
    fixture.director.containPlayer();
    assert.equal(fixture.returns.length, 3, 'Death freezes arena movement');
  }
});
