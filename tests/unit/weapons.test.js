import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { reloadMagazine, sanitizeWeaponSnapshot, canPickupWeapon, weaponPickupPrompt } from '../../src/game/weapon-rules.js';
import { createCombatStats } from '../../src/game/combat-stats.js';

test('reload conserves ammunition and never exceeds the magazine', () => {
  for (const def of Object.values(WEAPON_DEFS).filter(d => d.kind === 'ranged')) {
    for (let loaded = 0; loaded <= def.mag; loaded++) {
      for (const spare of [0, 1, 6, 99]) {
        const next = reloadMagazine(loaded, spare, def.mag);
        assert.equal(next.loaded + next.reserve, loaded + spare);
        assert.ok(next.loaded <= def.mag && next.reserve >= 0);
      }
    }
  }
});

test('checkpoint preserves exact loaded and reserve rounds', () => {
  assert.deepEqual(sanitizeWeaponSnapshot({ current: 'pistol', loaded: 3, reserve: 15 }),
    { current: 'pistol', loaded: 3, reserve: 15 });
  assert.deepEqual(sanitizeWeaponSnapshot({ current: 'unknown', loaded: 900, reserve: -1 }),
    { current: 'fists', loaded: 0, reserve: 0 });
  assert.deepEqual(sanitizeWeaponSnapshot({ current: 'shotgun', loaded: Infinity, reserve: NaN }),
    { current: 'shotgun', loaded: 0, reserve: 0 });
});

test('combat accuracy counts shots, not shotgun pellets, and streaks expire', () => {
  const stats = createCombatStats();
  stats.recordShot(true); stats.recordShot(false); stats.recordKill(true);
  assert.equal(stats.snapshot().accuracy, 50);
  assert.equal(stats.snapshot().headshots, 1);
  stats.update(5.1);
  assert.equal(stats.streak, 0);
  assert.equal(stats.kills, 1);
  stats.reset();
  assert.equal(stats.snapshot().accuracy, 0);
});

test('melee pickups never advertise ammunition or consume identical equipment', () => {
  const bat = { weaponType: 'bat', ammo: 0 };
  assert.equal(weaponPickupPrompt('fists', bat), '[E] PICK UP BAT');
  assert.equal(canPickupWeapon('bat', bat), false);
  assert.equal(weaponPickupPrompt('bat', bat), null);
  assert.equal(canPickupWeapon('pistol', { weaponType: 'fists', ammo: 0 }), false);
});

test('useful ranged pickups retain their exact ammunition prompt', () => {
  const pistol = { weaponType: 'pistol', ammo: 9 };
  assert.equal(weaponPickupPrompt('pistol', pistol), '[E] +9 PISTOL AMMO');
  assert.equal(weaponPickupPrompt('bat', pistol), '[E] PICK UP PISTOL (9)');
  assert.equal(canPickupWeapon('pistol', { ...pistol, ammo: 0 }), false);
  assert.equal(canPickupWeapon('bat', { ...pistol, ammo: 0 }), true);
});

test('invalid pickup records do not produce an interaction', () => {
  for (const drop of [null, undefined, {}, { weaponType: 'missing' }, { weaponType: 'constructor' }, { weaponType: '__proto__' }]) {
    assert.equal(canPickupWeapon('bat', drop), false);
    assert.equal(weaponPickupPrompt('bat', drop), null);
  }
  for (const ammo of [-3, NaN, Infinity]) {
    assert.equal(canPickupWeapon('pistol', { weaponType: 'pistol', ammo }), false);
  }
});
