import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFENSE_ARENAS, DEFENSE_UNLOCKS, DEFENSE_WAVE_COUNTS,
  createDefenseEncounter, defenseSupplyBudget, defenseSupplyCandidates,
  defenseUnlockedWeapons, isInsideDefenseArena,
} from '../../src/game/defense-rules.js';
import { DIFFICULTY_LEVELS, ENEMY_WEAPONS } from '../../src/game/difficulty.js';
import { EncounterSchedule } from '../../src/game/encounter-rules.js';
import { ZONE_WAVE_CONFIG } from '../../src/game/mission-data.js';
import { ROOF } from '../../src/world/layout.js';
import { DISTRICT } from '../../src/world/district-layout.js';

function defenseDriver(config, seed = null) {
  const schedule = new EncounterSchedule(config, { seed });
  const alive = [], arrivals = [];
  function tick(dt) {
    const aliveByWave = [], byType = {};
    for (const enemy of alive) {
      aliveByWave[enemy.waveIndex] = (aliveByWave[enemy.waveIndex] || 0) + 1;
      byType[enemy.type] = (byType[enemy.type] || 0) + 1;
    }
    const events = schedule.update(dt, { alive: alive.length, aliveByWave, footY: DEFENSE_ARENAS[config.arena].floorY });
    if (events.queuedWave !== null) assert.equal(alive.length, 0, 'A new defense wave cannot overlap a survivor');
    schedule.spawnAvailable({ total: alive.length, byType }, entry => {
      alive.push({ ...entry });
      arrivals.push({ ...entry });
      return true;
    });
    assert.ok(alive.length <= config.maxAlive && alive.length <= 6);
    assert.ok(alive.filter(enemy => enemy.type === 'enforcer').length <= 1);
    return events;
  }
  return { schedule, alive, arrivals, tick };
}

test('every defense duration preserves the campaign first weapon appearances at every difficulty', () => {
  assert.deepEqual(DEFENSE_UNLOCKS.map(({ wave, weapon }) => [wave, weapon]), [
    [1, 'fists'], [1, 'bat'], [3, 'pistol'], [9, 'smg'], [12, 'shotgun'], [12, 'machinegun'],
  ]);
  for (const arena of Object.keys(DEFENSE_ARENAS)) {
    for (const waves of DEFENSE_WAVE_COUNTS) {
      for (const difficulty of DIFFICULTY_LEVELS) {
        const config = createDefenseEncounter({ arena, waves, difficulty });
        const first = new Map();
        for (const [index, group] of config.waves.entries()) {
          for (const enemy of group) if (!first.has(ENEMY_WEAPONS[enemy])) first.set(ENEMY_WEAPONS[enemy], index + 1);
        }
        for (const unlock of DEFENSE_UNLOCKS) {
          assert.equal(first.get(unlock.weapon), unlock.wave <= waves ? unlock.wave : undefined,
            `${arena}/${waves}/${difficulty.id}: ${unlock.weapon}`);
        }
        assert.ok(config.waves[0].every(enemy => ['brawler', 'thug'].includes(enemy)));
        assert.equal(config.spawns, ZONE_WAVE_CONFIG[arena].spawns);
        assert.equal(config.route, null);
        assert.equal(config.stages, null);
        assert.equal(config.rearPressure, null);
        assert.equal(config.reinforcements, null);
        assert.equal(config.waveCount, waves);
        assert.equal(config.totalContacts, config.waves.flat().length);
        assert.deepEqual(config.composition(waves), []);
        assert.ok(Object.isFrozen(config) && Object.isFrozen(config.waves) && config.waves.every(Object.isFrozen));
      }
    }
  }
  assert.deepEqual(defenseUnlockedWeapons(10), ['fists', 'bat', 'pistol', 'smg']);
});

test('pressure grows through a run and difficulty scales counts, loadouts and recovery', () => {
  const configs = DIFFICULTY_LEVELS.map(difficulty => createDefenseEncounter({ arena: 'roof', waves: 100, difficulty }));
  const rank = { brawler: 0, thug: 1, gunman: 2, hitman: 3, bruiser: 4, enforcer: 5 };
  const strength = config => config.waves.flat().reduce((sum, type) => sum + rank[type], 0);
  for (const config of configs) {
    assert.ok(config.waves.at(-1).length > config.waves[0].length);
    assert.ok(config.waves.every(group => group.length > 0 && group.length <= 12));
  }
  for (let index = 1; index < configs.length; index++) {
    assert.ok(configs[index].totalContacts > configs[index - 1].totalContacts);
    assert.ok(strength(configs[index]) > strength(configs[index - 1]));
    assert.ok(configs[index].waveInterval < configs[index - 1].waveInterval);
    for (let wave = 0; wave < 100; wave++) {
      const previous = configs[index - 1].waves[wave], current = configs[index].waves[wave];
      assert.ok(current.length >= previous.length);
      for (let slot = 0; slot < previous.length; slot++) assert.ok(rank[current[slot]] >= rank[previous[slot]],
        `A higher difficulty cannot downgrade wave ${wave + 1}, slot ${slot}`);
    }
  }
});

test('all selected durations finish exactly once under live and heavy-weapon caps', () => {
  for (const arena of Object.keys(DEFENSE_ARENAS)) {
    for (const waves of DEFENSE_WAVE_COUNTS) {
      for (const difficulty of DIFFICULTY_LEVELS) {
        const config = createDefenseEncounter({ arena, waves, difficulty });
        const game = defenseDriver(config, 7129);
        let remaining = config.totalContacts * 3 + waves * 3;
        while (!game.schedule.cleared && remaining-- > 0) {
          game.tick(100);
          game.alive.shift();
        }
        assert.equal(game.schedule.cleared, true, `${arena}/${waves}/${difficulty.id}`);
        assert.equal(game.schedule.clearedWaves, waves);
        assert.equal(game.schedule.spawned, config.totalContacts);
        assert.equal(game.schedule.skipped, 0);
        assert.equal(game.schedule.pending.length, 0);
        assert.equal(new Set(game.arrivals.map(entry => `${entry.waveIndex}:${entry.entryIndex}`)).size, config.totalContacts);
        assert.equal(game.tick(100).completed, false, 'Completion is a single event');
      }
    }
  }
});

test('a survivor and every pending contact must clear before the full next-wave breather starts', () => {
  const config = createDefenseEncounter({ arena: 'street', waves: 20, difficulty: 'very-hard' });
  const game = defenseDriver(config);
  game.tick(config.firstWave);
  game.alive.splice(1);
  game.tick(100);
  assert.equal(game.schedule.waveIndex, 1);
  game.alive.length = 0;
  const events = game.tick(0);
  assert.deepEqual(events.clearedWaves, [0]);
  assert.equal(game.schedule.timer, config.waveInterval);
  game.tick(config.waveInterval - 0.001);
  assert.equal(game.schedule.waveIndex, 1);
  game.tick(0.001);
  assert.equal(game.schedule.waveIndex, 2);
  game.schedule.reset();
  assert.equal(game.schedule.waveIndex, 0);
  assert.equal(game.schedule.clearedWaves, 0);
  assert.equal(game.schedule.timer, config.firstWave);
  assert.deepEqual(game.schedule.unstartedTypes, config.waves.flat());
});

test('resupply is bounded, deterministic and cannot introduce a locked weapon', () => {
  for (const difficulty of DIFFICULTY_LEVELS) {
    for (let wave = 1; wave <= 100; wave++) {
      const request = {
        difficulty, wave, health: 0, armor: 0, weapon: { current: 'fists', loaded: 0, reserve: 0 },
        performance: { damageTaken: 200, hits: 8, shots: 10, kills: 12 },
      };
      const budget = defenseSupplyBudget(request);
      assert.deepEqual(budget, defenseSupplyBudget(request));
      assert.ok(budget.health >= 0 && budget.health <= 60);
      assert.ok(budget.armor >= 0 && budget.armor <= 100);
      assert.ok(budget.ammoUnits >= 0 && budget.ammoUnits <= 240);
      assert.ok(budget.weapons.length <= 2);
      for (const weapon of budget.weapons) {
        assert.ok(defenseUnlockedWeapons(wave).includes(weapon.type));
        assert.ok(Number.isSafeInteger(weapon.ammo) && weapon.ammo >= 0);
      }
      const newlyUnlocked = DEFENSE_UNLOCKS.filter(unlock => unlock.wave === wave && unlock.weapon !== 'fists');
      for (const unlock of newlyUnlocked) assert.ok(budget.weapons.some(weapon => weapon.type === unlock.weapon));
      if (wave < 3) assert.equal(budget.ammoUnits, 0);
      assert.ok(Object.isFrozen(budget) && Object.isFrozen(budget.weapons));
    }
  }
});

test('supply amounts respond to difficulty, injuries, current ammunition and successful defense', () => {
  const request = {
    difficulty: 'average', wave: 20, health: 20, armor: 0,
    weapon: { current: 'smg', loaded: 0, reserve: 0 },
    performance: { damageTaken: 0, shots: 10, hits: 5, kills: 3 },
  };
  const normal = defenseSupplyBudget(request);
  const injured = defenseSupplyBudget({ ...request, performance: { ...request.performance, damageTaken: 80 } });
  assert.ok(injured.health > normal.health);
  assert.ok(injured.armor > normal.armor);
  const full = defenseSupplyBudget({ ...request, health: 100, armor: 100, weapon: { current: 'smg', loaded: 30, reserve: 90 } });
  assert.equal(full.health, 0);
  assert.equal(full.armor, 0);
  assert.ok(full.ammoUnits < normal.ammoUnits);
  const successful = defenseSupplyBudget({ ...request, performance: { damageTaken: 0, shots: 10, hits: 10, kills: 6 } });
  assert.ok(successful.ammoUnits > normal.ammoUnits);
  const easy = defenseSupplyBudget({ ...request, difficulty: 'very-easy' });
  const hard = defenseSupplyBudget({ ...request, difficulty: 'very-hard' });
  for (const kind of ['health', 'armor', 'ammoUnits']) {
    assert.ok(easy[kind] > normal[kind]);
    assert.ok(normal[kind] > hard[kind]);
  }
  for (const health of [99.25, 99.5, 99.75]) {
    const damaged = defenseSupplyBudget({ ...request, health, armor: 99.75 });
    assert.ok(damaged.health <= 100 - health, 'A supply cannot promise more healing than the missing health');
  }
});

test('arena boundaries contain all spawn pockets and reject campaign exits, holes and falls', () => {
  for (const arena of Object.keys(DEFENSE_ARENAS)) {
    const location = DEFENSE_ARENAS[arena];
    assert.equal(isInsideDefenseArena(arena, location.checkpoint), true);
    assert.equal(isInsideDefenseArena(arena, { ...location.checkpoint, y: location.floorY + 1.4 }), true);
    assert.equal(isInsideDefenseArena(arena, { ...location.checkpoint, y: location.floorY - 1 }), false);
    assert.equal(isInsideDefenseArena(arena, { x: NaN, y: location.floorY, z: 0 }), false);
    for (const spawn of ZONE_WAVE_CONFIG[arena].spawns) assert.equal(isInsideDefenseArena(arena, spawn), true);
  }
  assert.equal(isInsideDefenseArena('roof', { x: -15.4, y: 14, z: -8.5 }), false);
  assert.equal(isInsideDefenseArena('roof', { x: 22, y: 14, z: 0.1 }), false);
  assert.equal(isInsideDefenseArena('roof', { x: -10, y: 14, z: -12 }), false);
  assert.equal(isInsideDefenseArena('street', DISTRICT.bakery.checkpoint), false);
  assert.equal(isInsideDefenseArena('street', { x: 15, y: 10, z: 4 }), false);
});

test('per-wave supply candidates stay near the player and clear roof holes and service-house walls', () => {
  for (const arena of Object.keys(DEFENSE_ARENAS)) {
    const location = DEFENSE_ARENAS[arena];
    const playerFoot = location.checkpoint;
    const request = { arena, playerFoot, wave: 12 };
    const candidates = defenseSupplyCandidates(request);
    assert.ok(candidates.length >= 3 && candidates.length <= 36);
    assert.deepEqual(candidates, defenseSupplyCandidates(request));
    assert.notDeepEqual(candidates, defenseSupplyCandidates({ ...request, wave: 13 }));
    for (const point of candidates) {
      const distance = Math.hypot(point.x - playerFoot.x, point.z - playerFoot.z);
      assert.ok(distance >= 2 - 1e-8 && distance <= 4.5 + 1e-8);
      assert.equal(point.y, location.floorY);
      assert.equal(isInsideDefenseArena(arena, point, { margin: 0.6 }), true);
    }
  }
  const candidates = defenseSupplyCandidates({ arena: 'roof', wave: 2, playerFoot: { x: -5, y: 14, z: -14 } });
  for (const point of candidates) {
    assert.ok(point.x < ROOF.serviceHouse.x1 - 0.6 || point.x > ROOF.serviceHouse.x2 + 0.6
      || point.z < ROOF.serviceHouse.z1 - 0.6 || point.z > ROOF.serviceHouse.z2 + 0.6);
  }
  assert.deepEqual(defenseSupplyCandidates({ arena: 'roof', wave: 1, playerFoot: null }), []);
});

test('defense rules reject incomplete settings and invalid durations or wave addresses', () => {
  const settings = { arena: 'roof', waves: 10, difficulty: 'average' };
  for (const arena of ['bakery', '', null]) assert.throws(() => createDefenseEncounter({ ...settings, arena }), RangeError);
  for (const waves of [0, 1, 30, 101, 10.5, '10']) assert.throws(() => createDefenseEncounter({ ...settings, waves }), RangeError);
  for (const difficulty of [undefined, null, 'extreme']) assert.throws(() => createDefenseEncounter({ ...settings, difficulty }), RangeError);
  for (const wave of [0, 101, NaN, 1.5]) {
    assert.throws(() => defenseUnlockedWeapons(wave), RangeError);
    assert.throws(() => defenseSupplyBudget({ difficulty: 'average', wave }), RangeError);
  }
});
