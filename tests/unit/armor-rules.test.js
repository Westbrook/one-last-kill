import test from 'node:test';
import assert from 'node:assert/strict';
import { applyArmorDamage, armorStrengthAfterHit } from '../../src/game/armor-rules.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('armor wears 25 percent slower and absorbs damage before health, including the breaking hit', () => {
  for (const [armor, damage, remainingArmor, remainingHealth] of [
    [0, 20, 0, 80], [100, 20, 85, 100], [50, 20, 35, 100],
    [15, 20, 0, 100], [15, 40, 0, 80], [0.75, 2, 0, 99],
    [100, 200, 0, 100 / 3], [50, 300, 0, 0],
  ]) {
    const player = { health: 100, armor };
    applyArmorDamage(player, damage);
    near(player.armor, remainingArmor);
    near(player.health, remainingHealth);
  }
});

test('repeated small hits conserve the same protection as one large hit', () => {
  const repeated = { health: 100, armor: 50 }, single = { ...repeated };
  for (let hit = 0; hit < 800; hit++) applyArmorDamage(repeated, 0.1);
  applyArmorDamage(single, 80);
  near(repeated.armor, single.armor);
  near(repeated.health, single.health);
});

test('invalid damage cannot heal or consume protection, and unarmored players retain ordinary damage', () => {
  for (const amount of [0, -1, NaN, Infinity, -Infinity, undefined, '20']) {
    const player = { health: 62, armor: 35 };
    assert.equal(applyArmorDamage(player, amount), 0);
    assert.deepEqual(player, { health: 62, armor: 35 });
  }
  const player = { health: 62 };
  assert.equal(applyArmorDamage(player, 12), 12);
  assert.deepEqual(player, { health: 50, armor: 0 });
});

test('body damage caps vest strength at half and later headshots cannot restore it', () => {
  assert.equal(armorStrengthAfterHit(100, 'head'), 100);
  assert.equal(armorStrengthAfterHit(100, 'body'), 50);
  assert.equal(armorStrengthAfterHit(50, 'head'), 50);
  assert.equal(armorStrengthAfterHit(50, 'body'), 50);
  assert.equal(armorStrengthAfterHit(0, 'body'), 0);
});
