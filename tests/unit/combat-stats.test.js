import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCombatStats } from '../../src/game/combat-stats.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { weaponHarness } from './helpers/weapon-harness.js';

const row = (stats, type) => stats.snapshot().weapons.find(weapon => weapon.type === type);

test('per-weapon accuracy includes missed swings while aggregate shots remain firearm rounds', () => {
  const stats = createCombatStats();
  stats.recordMelee(true, 'bat', 55);
  stats.recordMelee(false, 'bat');
  stats.recordKill(false, 'bat');
  stats.recordShot(true, 'pistol', 24);
  const snapshot = stats.snapshot();
  assert.equal(snapshot.attacks, 3);
  assert.equal(snapshot.attackHits, 2);
  assert.equal(snapshot.shots, 1);
  assert.equal(snapshot.hits, 1);
  assert.equal(snapshot.accuracy, 100);
  assert.equal(snapshot.damageDealt, 79);
  assert.equal(snapshot.favoriteWeapon, 'bat');
  assert.equal(snapshot.favoriteWeaponName, 'BAT');
  assert.deepEqual(row(stats, 'bat'), {
    type: 'bat', name: 'BAT', kind: 'melee', attacks: 2, shots: 0, hits: 1,
    kills: 1, headshots: 0, accuracy: 50, damageDealt: 55,
  });
  assert.equal(snapshot.weapons.length, Object.keys(WEAPON_DEFS).length);
});

test('favorite weapon uses attacks, then kills, with a stable tie order and no unused favorite', () => {
  const stats = createCombatStats();
  assert.equal(stats.snapshot().favoriteWeapon, null);
  stats.recordShot(false, 'pistol');
  stats.recordMelee(true, 'bat', 55);
  assert.equal(stats.snapshot().favoriteWeapon, 'bat');
  stats.recordKill(true, 'pistol');
  assert.equal(stats.snapshot().favoriteWeapon, 'pistol');
  assert.equal(row(stats, 'pistol').headshots, 1);
  stats.recordMelee(false, 'bat');
  assert.equal(stats.snapshot().favoriteWeapon, 'bat');
});

test('checkpoint restoration rolls back credited results without reviving a kill streak or rage wager', () => {
  let rageResets = 0, rageKills = 0;
  const stats = createCombatStats({ rage: { reset() { rageResets++; }, recordKill() { rageKills++; } } });
  stats.recordShot(true, 'pistol', 24);
  stats.recordKill(true, 'pistol');
  const checkpoint = stats.snapshot();
  stats.recordMelee(true, 'fists', 10);
  stats.recordKill(false, 'fists');
  stats.restore(checkpoint);
  assert.equal(rageKills, 2, 'restoring recorded kills never earns new rage credit');
  assert.equal(rageResets, 1);
  assert.deepEqual(stats.snapshot(), { ...checkpoint, streak: 0 });
  assert.equal(stats.streakRemaining, 0);
  checkpoint.weapons.find(weapon => weapon.type === 'pistol').kills = 900;
  assert.equal(row(stats, 'pistol').kills, 1, 'restored rows do not alias the saved snapshot');
  stats.reset();
  const reset = stats.snapshot();
  assert.equal(reset.kills, 0);
  assert.equal(reset.bestStreak, 0);
  assert.equal(reset.attacks, 0);
  assert.equal(reset.damageDealt, 0);
  assert.equal(reset.favoriteWeapon, null);
  for (const weapon of reset.weapons) {
    for (const field of ['attacks', 'shots', 'hits', 'kills', 'headshots', 'accuracy', 'damageDealt']) {
      assert.equal(weapon[field], 0);
    }
  }
});

test('longest kill streak survives expiration and rolls back with checkpoint results', () => {
  const stats = createCombatStats();
  stats.recordKill(false, 'bat');
  stats.recordKill(false, 'bat');
  stats.update(5);
  assert.equal(stats.snapshot().streak, 0);
  assert.equal(stats.snapshot().bestStreak, 2);
  const checkpoint = stats.snapshot();
  for (let kill = 0; kill < 4; kill++) stats.recordKill(false, 'bat');
  assert.equal(stats.snapshot().bestStreak, 4);
  stats.restore(checkpoint);
  assert.equal(stats.snapshot().bestStreak, 2, 'a failed life cannot inflate the completed run record');
  assert.equal(stats.snapshot().streak, 0);
  stats.restore({ kills: 2, bestStreak: 20 });
  assert.equal(stats.snapshot().bestStreak, 2, 'a best streak cannot exceed credited kills');
  stats.restore({ kills: 2, streak: 1 });
  assert.equal(stats.snapshot().bestStreak, 1, 'older snapshots retain their known current streak as the minimum best');
  stats.reset();
  assert.equal(stats.snapshot().bestStreak, 0);
});

test('legacy and malformed snapshots cannot create invalid counters or accuracy above 100 percent', () => {
  const stats = createCombatStats();
  stats.restore({ kills: 1, shots: 2, hits: 8, headshots: 4, damageDealt: Infinity,
    weapons: [{ type: 'shotgun', attacks: 1, hits: 8, kills: 2, headshots: 3, damageDealt: -30 },
      { type: 'fists', attacks: -1, shots: 3, hits: NaN }, { type: '__proto__', attacks: 900 }, null] });
  assert.equal(stats.snapshot().accuracy, 100);
  assert.equal(stats.snapshot().damageDealt, 0);
  assert.equal(stats.snapshot().headshots, 1);
  assert.equal(row(stats, 'shotgun').accuracy, 100);
  assert.equal(row(stats, 'shotgun').headshots, 2);
  assert.equal(row(stats, 'fists').shots, 0);
  assert.equal(row(stats, 'fists').accuracy, 0);
  stats.restore(null);
  assert.equal(stats.snapshot().favoriteWeapon, null);
});

test('real shotgun firing records multiple pellet kills as one hit and only actual damage', () => {
  const { Weapons, CombatStats, ray } = weaponHarness();
  const targets = [{ alive: true, health: 12 }, { alive: true, health: 7 }];
  ray.query = () => {
    const enemy = targets.find(target => target.alive);
    return enemy ? { enemy, part: 'body', point: new THREE.Vector3(0, 0, -1), dist: 1 } : null;
  };
  Weapons.init();
  Weapons.restore({ current: 'shotgun', loaded: 6, reserve: 0 });
  Weapons._fireRanged();
  assert.equal(row(CombatStats, 'shotgun').kills, 2);
  assert.equal(row(CombatStats, 'shotgun').damageDealt, 19, 'overkill and later pellets cannot inflate damage');
  assert.equal(row(CombatStats, 'shotgun').attacks, 1);
  assert.equal(row(CombatStats, 'shotgun').hits, 1);
  assert.equal(row(CombatStats, 'shotgun').accuracy, 100);
  Weapons._fireRanged();
  assert.equal(row(CombatStats, 'shotgun').accuracy, 50);
  assert.equal(CombatStats.snapshot().accuracy, 50);
  assert.equal(CombatStats.snapshot().kills, 2);
});

test('real firearm-preserving melee credits fists and a canceled windup records no completed attack', () => {
  const { Weapons, CombatStats, enemy, ray } = weaponHarness();
  Weapons.init();
  Weapons.restore({ current: 'pistol', loaded: 3, reserve: 11 });
  enemy.health = 20;
  Weapons.handleInput({ vPressed: true }, 1 / 120);
  Weapons.tick(WEAPON_DEFS.fists.attackDuration * WEAPON_DEFS.fists.contactPhase);
  assert.equal(row(CombatStats, 'fists').kills, 1);
  assert.equal(row(CombatStats, 'fists').damageDealt, 20);
  assert.equal(row(CombatStats, 'pistol').attacks, 0);
  assert.equal(row(CombatStats, 'pistol').kills, 0);
  assert.equal(CombatStats.snapshot().shots, 0);
  assert.deepEqual({ ...Weapons.snapshot() }, { current: 'pistol', loaded: 3, reserve: 11 });

  Weapons.tick(1);
  Weapons.handleInput({ vPressed: true }, 1 / 120);
  Weapons.cancelAttack();
  Weapons.tick(1);
  assert.equal(row(CombatStats, 'fists').attacks, 1);

  ray.query = () => null;
  Weapons.handleInput({ vPressed: true }, 1 / 120);
  Weapons.tick(0.14);
  assert.equal(row(CombatStats, 'fists').attacks, 2);
  assert.equal(row(CombatStats, 'fists').accuracy, 50);
});
