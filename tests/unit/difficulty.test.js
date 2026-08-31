import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTY_LEVELS, getDifficultyProfile, scaleEncounter } from '../../src/game/difficulty.js';
import { ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from '../../src/game/mission-data.js';
import { EncounterSchedule } from '../../src/game/encounter-rules.js';
import { encounterSpawnRole } from '../../src/game/rear-encounter-rules.js';

const encounters = [...Object.entries(ZONE_WAVE_CONFIG),
  ...Object.entries(FINAL_ENCOUNTERS).map(([name, config]) => [`final-${name}`, config])];
const level = { brawler: 0, thug: 1, gunman: 2, hitman: 3, bruiser: 4, enforcer: 5 };

test('difficulty pressure increases across the scale and only easier levels regenerate health', () => {
  for (const key of ['enemyCount', 'enemyDamage', 'weaponPressure']) {
    assert.ok(DIFFICULTY_LEVELS.every((profile, index, all) => !index || all[index - 1][key] < profile[key]), key);
  }
  for (const key of ['waveInterval', 'playerDamage', 'ammo', 'health', 'armor']) {
    assert.ok(DIFFICULTY_LEVELS.every((profile, index, all) => !index || all[index - 1][key] > profile[key]), key);
  }
  const [veryEasy, easy, ...rest] = DIFFICULTY_LEVELS;
  assert.ok(veryEasy.regen > easy.regen && easy.regen > 0);
  assert.ok(veryEasy.regenDelay < easy.regenDelay);
  assert.ok(rest.every(profile => profile.regen === 0));
  const average = getDifficultyProfile('average');
  for (const key of ['enemyCount', 'waveInterval', 'playerDamage', 'enemyDamage', 'weaponDrop', 'ammo', 'health', 'armor']) {
    assert.equal(average[key], 1, key);
  }
  assert.ok(DIFFICULTY_LEVELS.every(profile => Object.isFrozen(profile)));
  assert.throws(() => getDifficultyProfile('unknown'), RangeError);
  assert.throws(() => getDifficultyProfile(undefined), RangeError);
});

test('Average preserves every campaign and finale roster, timer and geometry exactly', () => {
  for (const [, config] of encounters) assert.equal(scaleEncounter(config, 'average'), config);
});

test('all scaled encounters keep stages, safe anchors, live caps and original weapon arrival waves', () => {
  for (const [name, original] of encounters) for (const profile of DIFFICULTY_LEVELS) {
    const config = scaleEncounter(original, profile), context = `${name}/${profile.id}`;
    assert.equal(config.waveCount, original.waveCount, context);
    for (const key of ['spawns', 'rearSpawns', 'stages', 'route', 'typeCaps', 'rearEntryIndices', 'maxAlive', 'minRecovery', 'deadlineSeconds']) {
      assert.equal(config[key], original[key], `${context}/${key}`);
    }
    assert.equal(config.totalContacts, config.waves.flat().length, context);
    const allTypes = new Set(original.waves.flat());
    for (const type of allTypes) {
      assert.equal(config.waves.findIndex(wave => wave.includes(type)), original.waves.findIndex(wave => wave.includes(type)), `${context}/${type}`);
    }
    for (const [index, wave] of config.waves.entries()) {
      assert.ok(wave.length >= 1 && wave.length <= Math.ceil(original.waves[index].length * 1.4), context);
      const unlocked = new Set(original.waves.slice(0, index + 1).flat());
      const ceiling = Math.max(...original.waves[index].map(type => level[type]));
      for (const type of wave) {
        assert.ok(unlocked.has(type), `${context}/${index} introduced ${type} early`);
        assert.ok(level[type] <= ceiling, `${context}/${index} exceeded its weapon ceiling`);
      }
      for (const type of Object.keys(original.typeCaps ?? {})) {
        assert.equal(wave.filter(value => value === type).length, original.waves[index].filter(value => value === type).length, `${context}/${type} budget`);
      }
      assert.ok(Object.isFrozen(wave));
    }
    assert.deepEqual(config.composition(-1), []);
    assert.deepEqual(config.composition(config.waveCount), []);
    assert.ok(Object.isFrozen(config));
    assert.equal(scaleEncounter(original, profile.id), config, 'retry uses the same immutable balance plan');
  }
});

test('balcony pairs, rear entry ownership and the two roof sentries survive every difficulty', () => {
  for (const profile of DIFFICULTY_LEVELS) {
    assert.deepEqual(scaleEncounter(ZONE_WAVE_CONFIG.roof, profile).waves[0], ['gunman', 'thug']);
    for (const name of ['balcony', 'stairwell']) {
      const original = ZONE_WAVE_CONFIG[name], scaled = scaleEncounter(original, profile);
      assert.equal(scaled.frontPairSize, original.frontPairSize);
      assert.equal(scaled.maxRearAlive, original.maxRearAlive);
      for (const [index, wave] of scaled.waves.entries()) {
        assert.equal(wave.length, original.waves[index].length);
        const roles = wave.map((_, entry) => encounterSpawnRole(entry, wave.length, scaled.rearEntryIndices));
        const originalRoles = original.waves[index].map((_, entry) => encounterSpawnRole(entry, wave.length, original.rearEntryIndices));
        assert.deepEqual(roles, originalRoles);
        for (const [entry, role] of roles.entries()) {
          if (role === 'rear' && level[original.waves[index][entry]] <= 1) assert.ok(level[wave[entry]] <= 1);
        }
      }
    }
  }
});

test('difficulty changes the full campaign enemy budget and recovery pacing monotonically', () => {
  const budgets = DIFFICULTY_LEVELS.map(profile => Object.values(ZONE_WAVE_CONFIG)
    .reduce((sum, config) => sum + scaleEncounter(config, profile).totalContacts, 0));
  assert.ok(budgets.every((budget, index) => !index || budget > budgets[index - 1]), String(budgets));
  for (const [, original] of encounters) {
    const intervals = DIFFICULTY_LEVELS.map(profile => scaleEncounter(original, profile).waveInterval);
    assert.ok(intervals.every((interval, index) => Number.isFinite(interval) && interval > 0
      && (!index || interval < intervals[index - 1])));
  }
});

function finishEncounter(config, seed, label) {
  const schedule = new EncounterSchedule(config, { seed });
  let alive = [];
  function counts() {
    const aliveByWave = Array(config.waveCount).fill(0), frontAliveByWave = Array(config.waveCount).fill(0), byType = {};
    let rearAlive = 0;
    for (const entry of alive) {
      aliveByWave[entry.waveIndex]++;
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      const role = config.rearPressure
        ? encounterSpawnRole(entry.entryIndex, config.waves[entry.waveIndex].length, config.rearEntryIndices) : 'front';
      if (role === 'rear') rearAlive++;
      else frontAliveByWave[entry.waveIndex]++;
    }
    return { alive: alive.length, total: alive.length, aliveByWave, frontAliveByWave, byType, rearAlive };
  }
  for (let tick = 0; tick < 2000 && !schedule.cleared; tick++) {
    // Stay at each authored landing until its entire roster has been defeated.
    const active = schedule.groups.find(group => !group.cleared && !group.retired);
    const index = active?.index ?? Math.min(schedule.waveIndex, config.waveCount - 1);
    const stage = config.stages?.[index];
    const footY = stage?.minFootY ?? config.spawns[0].y;
    schedule.update(0.25, { ...counts(), footY, routeProgress: stage?.minProgress ?? 0 });
    const admit = tick % 11 !== 0; // A failed allocation must remain retryable.
    schedule.spawnAvailable(counts(), entry => {
      if (!admit) return false;
      alive.push(entry);
      return true;
    }, pair => {
      if (!admit) return false;
      alive.push(...pair);
      return true;
    });
    const current = counts();
    assert.ok(current.total <= config.maxAlive, `${label} exceeded live budget`);
    assert.ok(current.rearAlive <= (config.maxRearAlive ?? Infinity), `${label} exceeded rear budget`);
    for (const [type, cap] of Object.entries(config.typeCaps ?? {})) assert.ok((current.byType[type] ?? 0) <= cap, label);
    if (tick % 3 === 2) alive = [];
  }
  assert.equal(schedule.cleared, true, `${label} must finish`);
  assert.equal(schedule.spawned, config.totalContacts, `${label} must spawn the finite roster`);
  assert.equal(schedule.clearedWaves, config.waveCount, label);
  assert.equal(schedule.skipped, 0, `${label} must not require skipped waves to finish`);
  assert.deepEqual(schedule.pendingTypes, []);
}

test('every difficulty finishes every campaign/finale schedule within caps, including seeded arrival times', () => {
  for (const [name, original] of encounters) for (const profile of DIFFICULTY_LEVELS) for (const seed of [null, 825991]) {
    finishEncounter(scaleEncounter(original, profile), seed, `${name}/${profile.id}/${seed}`);
  }
});
