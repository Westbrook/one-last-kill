import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTY_LEVELS, getDifficultyProfile, scaleEncounter } from '../../src/game/difficulty.js';
import { DifficultyLootLedger } from '../../src/game/difficulty-loot-rules.js';
import { RunSettings } from '../../src/game/run-settings.js';
import { AMMO_SUPPLY_CACHES, AmmoSupplyLedger } from '../../src/game/ammo-supply-rules.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from '../../src/game/mission-data.js';
import { enemyCampaignPoolCapacity } from '../../src/game/enemy-navigation.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';
import { ROOF } from '../../src/world/layout.js';

test('difficulty scales finite cache capacity and checkpoint restores cannot replenish spent supplies', () => {
  const id = AMMO_SUPPLY_CACHES[0].id;
  for (const profile of DIFFICULTY_LEVELS) {
    const ledger = new AmmoSupplyLedger();
    ledger.reset(profile.ammo);
    const capacity = Math.round(120 * profile.ammo);
    assert.equal(ledger.capacity(id), capacity);
    assert.equal(ledger.units(id), capacity);
    const held = { current: 'pistol', loaded: 3, reserve: 0 };
    const collected = ledger.take(id, held, amount => { held.reserve += amount; return amount; }, { active: true });
    assert.equal(collected, Math.floor(capacity / 5));
    assert.equal(held.loaded, 3);
    const checkpoint = ledger.snapshot();
    for (let retry = 0; retry < 3; retry++) {
      held.reserve = 0;
      assert.equal(ledger.restore(checkpoint), true);
      assert.equal(ledger.take(id, held, amount => amount, { active: true }), 0);
      assert.equal(ledger.units(id), capacity % 5);
    }
    const overfilled = { version: 1, caches: checkpoint.caches.map(entry => ({
      ...entry, remainingUnits: entry.id === id ? capacity + 1 : entry.remainingUnits,
    })) };
    assert.equal(ledger.restore(overfilled), false);
    assert.deepEqual(ledger.snapshot(), checkpoint);
    ledger.reset(profile.ammo);
    assert.equal(ledger.units(id), capacity, 'Only a new run replenishes the selected difficulty budget');
  }
});

test('cache scaling rejects invalid budgets atomically and uses authored capacity on every new reset', () => {
  const ledger = new AmmoSupplyLedger();
  ledger.reset(1.6);
  ledger.reset(0.7);
  assert.equal(ledger.capacity(AMMO_SUPPLY_CACHES[0].id), 84, 'Difficulty changes between runs do not compound');
  const before = ledger.snapshot();
  for (const multiplier of [NaN, Infinity, -1, '2', Number.MAX_VALUE]) {
    assert.throws(() => ledger.reset(multiplier), RangeError);
    assert.deepEqual(ledger.snapshot(), before);
  }
});

test('every difficulty guarantees the first enemy drop for each weapon at its existing appearance', () => {
  for (const profile of DIFFICULTY_LEVELS) {
    const ledger = new DifficultyLootLedger();
    for (const [type, ammo] of Object.entries({ bat: 0, pistol: 9, shotgun: 6, smg: 30, machinegun: 50 })) {
      assert.deepEqual(ledger.drop(type, ammo, profile), {
        type, ammo: ammo ? Math.max(1, Math.round(ammo * profile.ammo)) : 0,
      });
    }
    assert.equal(ledger.drop('fists', 0, profile), null);
    assert.equal(ledger.drop('missing', 0, profile), null);
  }
});

test('harder difficulty spaces duplicate weapons predictably while checkpoint retries replay the same drops', () => {
  const totals = [];
  for (const profile of DIFFICULTY_LEVELS) {
    const ledger = new DifficultyLootLedger(), checkpoint = ledger.snapshot();
    const sequence = () => Array.from({ length: 21 }, () => ledger.drop('pistol', 9, profile));
    const first = sequence();
    assert.equal(first.filter(Boolean).length, 1 + Math.floor(20 * profile.weaponDrop));
    assert.equal(ledger.restore(checkpoint), true);
    assert.deepEqual(sequence(), first);
    totals.push(first.filter(Boolean).length);
    ledger.reset();
    assert.ok(ledger.drop('pistol', 9, profile), 'A new run renews first availability');
  }
  assert.ok(totals[2] > totals[3] && totals[3] > totals[4]);
});

test('invalid loot snapshots cannot change first-drop history', () => {
  const ledger = new DifficultyLootLedger();
  ledger.drop('shotgun', 6, getDifficultyProfile('hard'));
  const before = ledger.snapshot();
  for (const snapshot of [null, {}, { version: 2, weapons: [] },
    { version: 1, weapons: [{ type: 'shotgun', deaths: 0 }] },
    { version: 1, weapons: [{ type: 'shotgun', deaths: 1 }, { type: 'shotgun', deaths: 2 }] },
    { version: 1, weapons: [{ type: 'fists', deaths: 2 }] },
    { version: 1, weapons: [{ type: '__proto__', deaths: 2 }] },
  ]) {
    assert.equal(ledger.restore(snapshot), false);
    assert.deepEqual(ledger.snapshot(), before);
  }
});

const h = createEnemyAIHarness();
const roof = { x: 22, y: ROOF.floorY, z: -4 };

test('existing supply cases use the locked run budget and display a full indicator after a new run', () => {
  const meshes = h.supplies.list.map(entry => entry.mesh);
  try {
    for (const profile of DIFFICULTY_LEVELS) {
      RunSettings.reset();
      RunSettings.configure({ difficulty: profile.id });
      RunSettings.start();
      h.supplies.reset();
      for (const [index, entry] of h.supplies.list.entries()) {
        assert.equal(entry.capacity, Math.round(120 * profile.ammo));
        assert.equal(entry.remainingUnits, entry.capacity);
        assert.equal(entry.indicator.scale.x, entry.indicatorWidth);
        assert.equal(entry.mesh, meshes[index], 'Difficulty changes between runs reuse the visible case');
      }
    }
  } finally {
    RunSettings.reset();
  }
});

test('actual enemy damage preserves every weapon strength and body multiplier at every difficulty', () => {
  for (const profile of DIFFICULTY_LEVELS) {
    h.runSettings.profile = profile;
    for (const def of Object.values(WEAPON_DEFS)) {
      h.reset();
      const enemy = h.spawn('enforcer', roof, { zone: 'roof' });
      enemy.health = 1000;
      for (const [part, multiplier] of Object.entries({ body: 1, head: 2.5, limb: 0.7 })) {
        const result = h.damageEnemy(enemy, def.dmg, part);
        assert.ok(Math.abs(result.damage - def.dmg * multiplier * profile.playerDamage) < 1e-8);
        assert.equal(result.killed, false);
      }
      const health = enemy.health;
      for (const invalid of [0, -1, Infinity, NaN, '20']) assert.equal(h.damageEnemy(enemy, invalid, 'body'), null);
      assert.equal(enemy.health, health);
      const result = h.damageEnemy(enemy, 10000, 'body');
      assert.equal(result.damage, health, 'Stats credit actual remaining health, including a lethal scaled hit');
      assert.equal(result.killed, true);
    }
  }
});

test('actual vest drops retain hit condition and scale recovered protection within the armor cap', () => {
  for (const profile of DIFFICULTY_LEVELS) {
    h.runSettings.profile = profile;
    for (const part of ['head', 'body']) {
      h.reset();
      const enemy = h.spawn('bruiser', roof, { zone: 'roof' });
      h.damageEnemy(enemy, 10, part);
      const condition = part === 'head' ? 100 : 50;
      assert.equal(enemy.armorStrength, condition);
      h.killEnemy(enemy);
      assert.equal(h.armorDrops[0][3], Math.min(100, Math.round(condition * profile.armor)));
      assert.equal(h.drops[0][3], 'shotgun');
      assert.equal(h.drops[0][4], Math.round(6 * profile.ammo));
      assert.equal(h.killEnemy(enemy), false);
      assert.equal(h.armorDrops.length, 1);
    }
  }
});

test('production loot restores its first weapon guarantee and duplicate cadence with a checkpoint', () => {
  h.reset(); h.runSettings.profile = getDifficultyProfile('very-hard');
  const checkpoint = h.snapshotDifficultyLoot();
  const kill = () => {
    const enemy = h.spawn('gunman', roof, { zone: 'roof' });
    h.killEnemy(enemy);
  };
  kill(); kill();
  assert.equal(h.drops.length, 1);
  assert.equal(h.drops[0][4], 6);
  assert.equal(h.restoreDifficultyLoot(checkpoint), true);
  kill(); kill();
  assert.equal(h.drops.length, 2);
  h.resetDifficultyLoot(); kill();
  assert.equal(h.drops.length, 3);
});

test('shared rig pools cover every scaled campaign and defense without reserving duplicate runs', () => {
  const encounters = Object.entries(ZONE_WAVE_CONFIG).filter(([zone]) => zone !== 'bakery').map(([, config]) => config);
  for (const type of Object.keys(h.ENEMY_TYPES)) {
    const campaign = Math.max(...DIFFICULTY_LEVELS.map(profile => enemyCampaignPoolCapacity(type,
      encounters.map(config => scaleEncounter(config, profile)),
      Object.values(FINAL_ENCOUNTERS).map(config => scaleEncounter(config, profile)))));
    const defense = (type === 'enforcer' ? 1 : 6) + 2;
    assert.equal(h.EnemyPool.pools[type].length, Math.max(campaign, defense));
  }
});
