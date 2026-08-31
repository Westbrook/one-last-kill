import test from 'node:test';
import assert from 'node:assert/strict';
import { Group } from 'three';
import { ROOF } from '../../src/world/layout.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { createArmorPickups } from '../../src/game/armor-pickups.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

// Exercise production spawn, damage and death against authored floor geometry.
const h = createEnemyAIHarness();
const roof = { x: 22, y: ROOF.floorY, z: -4 };

function spawnBruiser() {
  h.reset();
  return h.spawn('bruiser', roof, { zone: 'roof' });
}

test('headshots preserve a shotgun enemy vest at full strength until pickup', () => {
  const enemy = spawnBruiser();
  assert.equal(enemy.def.weaponType, 'shotgun');
  assert.equal(enemy.armorStrength, 100);
  assert.equal(h.damageEnemy(enemy, 20, 'head').killed, false);
  assert.equal(enemy.armorStrength, 100);
  assert.equal(h.armorDrops.length, 0, 'a living enemy still owns its vest');
  assert.equal(h.damageEnemy(enemy, 30, 'head').killed, true);
  assert.equal(h.armorDrops.length, 1);
  assert.equal(h.armorDrops[0][3], 100);
});

test('body damage leaves half-strength armor without repeatedly halving it', () => {
  for (const hitPart of ['body', undefined, 'unknown']) {
    const enemy = spawnBruiser();
    assert.equal(h.damageEnemy(enemy, 10, hitPart).killed, false);
    assert.equal(enemy.armorStrength, 50);
    assert.equal(h.armorDrops.length, 0);
    assert.equal(h.damageEnemy(enemy, 10, hitPart).killed, false);
    assert.equal(enemy.armorStrength, 50);
    assert.equal(h.damageEnemy(enemy, 100, hitPart).killed, true);
    assert.equal(h.armorDrops.length, 1);
    assert.equal(h.armorDrops[0][3], 50);
  }
});

test('a fatal headshot cannot repair armor damaged by an earlier body shot', () => {
  const enemy = spawnBruiser();
  h.damageEnemy(enemy, 10, 'body');
  assert.equal(h.damageEnemy(enemy, 50, 'head').killed, true);
  assert.equal(h.armorDrops[0][3], 50);
});

test('limb damage does not damage the vest', () => {
  const enemy = spawnBruiser();
  assert.equal(h.damageEnemy(enemy, 20, 'limb').killed, false);
  assert.equal(enemy.armorStrength, 100);
  h.damageEnemy(enemy, 50, 'head');
  assert.equal(h.armorDrops[0][3], 100);
});

test('invalid damage cannot damage the vest or cause a drop', () => {
  const enemy = spawnBruiser();
  for (const amount of [0, -10, NaN, Infinity, -Infinity, undefined, '20']) {
    assert.equal(h.damageEnemy(enemy, amount, 'body'), null);
    assert.equal(enemy.health, enemy.def.maxHealth);
    assert.equal(enemy.armorStrength, 100);
    assert.equal(h.armorDrops.length, 0);
  }
  h.damageEnemy(enemy, 50, 'head');
  assert.equal(h.armorDrops[0][3], 100);
});

test('an armored corpse drops exactly one vest and ignores later damage', () => {
  const enemy = spawnBruiser();
  assert.equal(h.killEnemy(enemy), true);
  assert.equal(h.killEnemy(enemy), false);
  assert.equal(h.damageEnemy(enemy, 200, 'body'), null);
  assert.equal(h.armorDrops.length, 1);
  assert.equal(h.armorDrops[0][3], 100);
  assert.equal(h.drops.length, 1, 'the existing shotgun drop remains available');
});

test('armor drops use the resolved supporting floor and retain their encounter zone', () => {
  for (const fixture of [
    { ...roof, zone: 'roof' },
    { x: 18, y: DISTRICT.street.road.floorY, z: 18, zone: 'street' },
    { x: -19.45, y: 6.4, z: -0.85, zone: 'stairwell' },
  ]) {
    h.reset();
    const enemy = h.spawn('bruiser', fixture, { zone: fixture.zone });
    if (fixture.zone === 'roof') enemy.floorY = 0;
    assert.equal(h.damageEnemy(enemy, 50, 'head').killed, true);
    assert.equal(h.armorDrops.length, 1);
    const [x, floorY, z, strength, zone] = h.armorDrops[0];
    assert.equal(x, fixture.x);
    assert.ok(Math.abs(floorY - fixture.y) < 1e-6, 'spawn clearance and stale floors must not offset the vest');
    assert.equal(z, fixture.z);
    assert.equal(strength, 100);
    assert.equal(zone, fixture.zone);
  }
});

test('a surviving street bruiser killed inside the bakery leaves a collectible vest', () => {
  const point = { x: -18.75, y: DISTRICT.bakery.floorY, z: 29.5 };
  h.reset(point);
  h.player.armor = 0;
  const pickups = createArmorPickups();
  pickups.init({ world: new Group(), player: h.player, colliders: h.colliders });
  pickups.setZone('street');
  // Stage a pursuer that has crossed the entrance but retains its encounter
  // ownership. The actual lethal hit and pickup manager handle its reward.
  const survivor = h.spawn('bruiser', point, { zone: 'street' });
  pickups.setZone('bakery');
  assert.equal(h.damageEnemy(survivor, 50, 'head').killed, true);
  assert.equal(h.armorDrops.length, 1);
  const drop = pickups.spawn(...h.armorDrops[0]);
  assert.equal(drop.zone, 'street');
  assert.equal(drop.mesh.visible, true);
  pickups.update(1 / 120);
  assert.equal(h.player.armor, 100);
  assert.equal(drop.active, false);
});

test('an unsupported armor drop retains the last known floor', () => {
  h.reset();
  const enemy = h.spawn('bruiser', { x: -10, y: ROOF.floorY, z: -12.5 }, { zone: 'roof' });
  assert.equal(h.surfaceTopAt(enemy.pos.x, enemy.pos.y + 0.20, enemy.pos.z, 2.5), -Infinity);
  enemy.floorY = ROOF.floorY;
  assert.equal(h.killEnemy(enemy), true);
  assert.equal(h.armorDrops[0][1], ROOF.floorY);
  assert.equal(h.armorDrops[0][4], 'roof');
});

test('enemies without shotgun armor do not generate vest pickups', () => {
  for (const type of ['thug', 'brawler', 'gunman', 'hitman', 'enforcer']) {
    h.reset();
    const enemy = h.spawn(type, roof, { zone: 'roof' });
    assert.equal(enemy.armorStrength, 0);
    assert.equal(h.damageEnemy(enemy, 200, 'body').killed, true);
    assert.equal(h.armorDrops.length, 0, type);
  }
});

test('a reused enemy pool slot starts with a fresh full-strength vest', () => {
  const first = spawnBruiser();
  const slot = first.poolSlot;
  h.damageEnemy(first, 200, 'body');
  assert.equal(h.armorDrops[0][3], 50);
  h.Enemies.remove(first);
  const second = h.spawn('bruiser', roof, { zone: 'roof' });
  assert.equal(second.poolSlot, slot);
  assert.equal(second.armorStrength, 100);
  assert.equal(h.damageEnemy(first, 200, 'body'), null, 'released references cannot affect new armor');
  assert.equal(h.killEnemy(first), false);
  assert.equal(h.damageEnemy(second, 50, 'head').killed, true);
  assert.equal(h.armorDrops.length, 2);
  assert.equal(h.armorDrops[1][3], 100);
});
