import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import {
  REAR_SPAWN_GRACE_SECONDS, REAR_FALLBACK_AFTER_SECONDS,
  rearEnemyType, isBehindPlayer, encounterSpawnRole, rearSpawnPolicy,
  hasPairBearingSeparation, hasSameWaveSeparation,
} from '../../src/game/rear-encounter-rules.js';

const origin = Object.freeze({ x: 0, y: 4, z: 0 });
const point = (x, z, y = 4) => ({ x, y, z });
const polar = (angle, distance = 10) => point(Math.sin(angle) * distance, -Math.cos(angle) * distance);
const enemy = (position, overrides = {}) => ({
  alive: true, removed: false, encounterKey: 'balcony', encounterWave: 1, pos: position, ...overrides,
});

test('melee, unarmed and unknown players only receive the weakest fist contact behind them', () => {
  for (const weapon of ['fists', 'bat', 'knife', 'missing', '', null, undefined, {}, '__proto__']) {
    for (const preferred of ['thug', 'brawler', 'gunman', 'enforcer', 'missing']) {
      assert.equal(rearEnemyType(weapon, preferred), 'brawler');
    }
  }
});

test('known firearms allow a rear bat while preserving a deliberately weaker fist preference', () => {
  for (const [weapon, definition] of Object.entries(WEAPON_DEFS)) {
    if (definition.kind !== 'ranged') continue;
    assert.equal(rearEnemyType(weapon), 'thug', weapon);
    assert.equal(rearEnemyType(weapon, 'brawler'), 'brawler', weapon);
    for (const preferred of ['gunman', 'hitman', 'bruiser', 'enforcer', 'unknown']) {
      assert.equal(rearEnemyType(weapon, preferred), 'thug', `${weapon} cannot authorize ${preferred} as a rear gunner`);
    }
  }
});

test('rear selection never returns a ranged or heavy archetype for any authored weapon', () => {
  for (const weapon of Object.keys(WEAPON_DEFS)) {
    for (const preferred of ['brawler', 'thug', 'gunman', 'hitman', 'bruiser', 'enforcer']) {
      assert.ok(['brawler', 'thug'].includes(rearEnemyType(weapon, preferred)));
    }
  }
});

test('rear geometry follows the game yaw convention in all four directions', () => {
  for (const [yaw, behind, front] of [
    [0, point(0, 6), point(0, -6)],
    [Math.PI / 2, point(6, 0), point(-6, 0)],
    [Math.PI, point(0, -6), point(0, 6)],
    [-Math.PI / 2, point(-6, 0), point(6, 0)],
  ]) {
    assert.equal(isBehindPlayer(origin, yaw, behind), true);
    assert.equal(isBehindPlayer(origin, yaw, front), false);
    assert.equal(isBehindPlayer(origin, yaw + 8 * Math.PI, behind), true);
  }
});

test('the default rear cone rejects side-on and forward positions but admits a 105 degree bearing', () => {
  for (const degrees of [0, 45, 90, 100, -100]) {
    assert.equal(isBehindPlayer(origin, 0, polar(degrees * Math.PI / 180)), false, `${degrees} degrees`);
  }
  for (const degrees of [105, 135, 180, -105, -135]) {
    assert.equal(isBehindPlayer(origin, 0, polar(degrees * Math.PI / 180)), true, `${degrees} degrees`);
  }
});

test('five metres is an inclusive horizontal minimum and height never grants a closer rear spawn', () => {
  assert.equal(isBehindPlayer(origin, 0, point(0, 4.99)), false);
  assert.equal(isBehindPlayer(origin, 0, point(0, 5)), true);
  assert.equal(isBehindPlayer(origin, 0, point(0, 4.99, 100)), false);
  assert.equal(isBehindPlayer(origin, 0, point(0, 5, 100)), true, 'Floor and height safety are separate mandatory caller checks');
  assert.equal(isBehindPlayer(origin, 0, point(0, 5), { minDistance: 6 }), false);
  assert.equal(isBehindPlayer(origin, 0, polar(Math.PI * 0.6), { minRearDot: 0.5 }), false);
});

test('rear geometry works away from the origin without mutating authored points', () => {
  const player = Object.freeze(point(-12, 0.95));
  const candidate = Object.freeze(point(-5, 0.95));
  assert.equal(isBehindPlayer(player, Math.PI / 2, candidate), true);
  assert.deepEqual(player, point(-12, 0.95));
  assert.deepEqual(candidate, point(-5, 0.95));
});

test('invalid positions and thresholds fail closed instead of producing a rear fallback', () => {
  for (const candidate of [null, {}, point(NaN, 8), point(0, Infinity), origin]) {
    assert.equal(isBehindPlayer(origin, 0, candidate), false);
  }
  for (const yaw of [NaN, Infinity, undefined]) assert.equal(isBehindPlayer(origin, yaw, point(0, 6)), false);
  for (const options of [{ minDistance: -1 }, { minDistance: Infinity }, { minRearDot: NaN }, { minRearDot: -0.1 }, { minRearDot: 1.1 }]) {
    assert.equal(isBehindPlayer(origin, 0, point(0, 6), options), false);
  }
  assert.equal(isBehindPlayer(point(-1e308, 0), 0, point(1e308, 10)), false);
});

test('exactly one authored index owns the rear role in each two-person wave', () => {
  assert.deepEqual([0, 1].map(index => encounterSpawnRole(index, 2)), ['front', 'rear']);
  for (const size of [0, 1, 3, 4, 5]) {
    assert.ok(Array.from({ length: size }, (_, index) => encounterSpawnRole(index, size)).every(role => role === 'front'));
  }
  for (const index of [-1, 2, 3, NaN, 0.5, '1']) assert.equal(encounterSpawnRole(index, 2), 'front');
});

test('blocked retries and earlier successful spawns never reassign the designated rear role', () => {
  const pending = [{ authoredIndex: 0 }, { authoredIndex: 1 }];
  for (let retry = 0; retry < 10; retry++) assert.equal(encounterSpawnRole(pending[1].authoredIndex, 2), 'rear');
  pending.shift();
  assert.equal(encounterSpawnRole(pending[0].authoredIndex, 2), 'rear', 'Use the retained authored index, not its new array index');
  const retry = [{ authoredIndex: 0 }, { authoredIndex: 1 }];
  assert.deepEqual(retry.map(entry => encounterSpawnRole(entry.authoredIndex, 2)), ['front', 'rear']);
});

test('rear attempts allow a safe forward fallback after a finite simulation-time wait', () => {
  assert.equal(REAR_FALLBACK_AFTER_SECONDS, 1.5);
  assert.deepEqual(rearSpawnPolicy(0), { tryRear: true, allowForwardFallback: false, spawnGraceSeconds: 1 });
  assert.equal(rearSpawnPolicy(REAR_FALLBACK_AFTER_SECONDS - 0.001).allowForwardFallback, false);
  assert.equal(rearSpawnPolicy(REAR_FALLBACK_AFTER_SECONDS).allowForwardFallback, true);
  assert.equal(rearSpawnPolicy(120).tryRear, true, 'A safe rear placement stays preferable even after fallback is allowed');
  assert.equal(rearSpawnPolicy(120).allowForwardFallback, true);
  assert.equal(rearSpawnPolicy(1.5, { fallbackAfter: 2 }).allowForwardFallback, false);
  assert.equal(rearSpawnPolicy(2, { fallbackAfter: 2 }).allowForwardFallback, true);
});

test('pause and a failed attempt do not advance or restart a pure fallback deadline', () => {
  const waited = 1.25;
  for (let retry = 0; retry < 30; retry++) assert.equal(rearSpawnPolicy(waited).allowForwardFallback, false);
  assert.equal(rearSpawnPolicy(waited + 0.25).allowForwardFallback, true);
  assert.equal(rearSpawnPolicy(0).allowForwardFallback, false, 'Checkpoint retry passes a fresh eligible-time counter');
});

test('spawn attack grace is always at least one second and policy results cannot be mutated', () => {
  assert.equal(REAR_SPAWN_GRACE_SECONDS, 1);
  for (const spawnGrace of [-10, 0, 0.5, NaN, Infinity]) assert.equal(rearSpawnPolicy(0, { spawnGrace }).spawnGraceSeconds, 1);
  assert.equal(rearSpawnPolicy(0, { spawnGrace: 2.5 }).spawnGraceSeconds, 2.5);
  const policy = rearSpawnPolicy(0);
  assert.throws(() => { policy.allowForwardFallback = true; }, TypeError);
  assert.equal(rearSpawnPolicy(0).allowForwardFallback, false);
});

test('invalid wait state never authorizes either an unsafe rear attempt or a forward fallback', () => {
  for (const waited of [NaN, Infinity, -1, undefined]) {
    assert.equal(rearSpawnPolicy(waited).tryRear, false);
    assert.equal(rearSpawnPolicy(waited).allowForwardFallback, false);
  }
  for (const fallbackAfter of [NaN, Infinity, -1]) assert.equal(rearSpawnPolicy(10, { fallbackAfter }).allowForwardFallback, false);
});

test('pair separation rejects collinear and nearly collinear contacts at different depths', () => {
  for (const other of [point(0, -12), point(0.1, -12), point(-0.1, -12)]) {
    assert.equal(hasPairBearingSeparation(origin, point(0, -8), other), false);
    assert.equal(hasPairBearingSeparation(origin, other, point(0, -8)), false);
  }
});

test('staggered contacts need both lateral clearance and a visible angular separation', () => {
  assert.equal(hasPairBearingSeparation(origin, point(-0.35, -8), point(0.35, -10)), true);
  assert.equal(hasPairBearingSeparation(origin, point(0, -100), point(0.5, -100)), false,
    'Half a metre of lateral spacing at a hundred metres still aligns the head bearings');
  assert.equal(hasPairBearingSeparation(origin, point(0, -1), point(0.1, -1)), false,
    'A large close-range angle cannot replace the physical lateral requirement');
  assert.equal(hasPairBearingSeparation(origin, point(0, -10), point(0.5, -10)), true);
});

test('separation is symmetric, translation invariant and independent from world-facing yaw', () => {
  const candidate = point(-0.4, -10), other = point(0.4, -12);
  assert.equal(hasPairBearingSeparation(origin, candidate, other), true);
  assert.equal(hasPairBearingSeparation(origin, other, candidate), true);
  const player = point(-16, 0.95);
  const translate = p => point(p.x + player.x, p.z + player.z);
  assert.equal(hasPairBearingSeparation(player, translate(candidate), translate(other)), true);
  const rotate = p => point(-p.z, p.x);
  assert.equal(hasPairBearingSeparation(origin, rotate(candidate), rotate(other)), true);
});

test('a conservative near-depth test prevents asymmetric collinear acceptance', () => {
  const near = point(0, -5), far = point(0.5, -20);
  assert.equal(hasPairBearingSeparation(origin, near, far, { minAngle: 0 }), false);
  assert.equal(hasPairBearingSeparation(origin, far, near, { minAngle: 0 }), false);
});

test('opposite front and rear contacts can share a horizontal axis without stacking in one view', () => {
  assert.equal(hasPairBearingSeparation(origin, point(0, -8), point(0, 7)), true);
  assert.equal(hasPairBearingSeparation(origin, point(0, -8), point(0, 7), { allowOpposite: false }), false);
  assert.equal(hasPairBearingSeparation(origin, point(0, -8), point(0, -8)), false);
});

test('pair geometry rejects invalid or zero-length bearings and invalid thresholds', () => {
  for (const bad of [null, {}, origin, point(NaN, -8), point(0, Infinity)]) {
    assert.equal(hasPairBearingSeparation(origin, bad, point(1, -10)), false);
    assert.equal(hasPairBearingSeparation(origin, point(1, -10), bad), false);
  }
  for (const options of [{ minPerp: -1 }, { minPerp: NaN }, { minAngle: -1 }, { minAngle: Infinity }, { minAngle: Math.PI + 0.01 }]) {
    assert.equal(hasPairBearingSeparation(origin, point(-1, -8), point(1, -10), options), false);
  }
});

test('only living contacts in the same authored wave reserve the pair bearing', () => {
  const candidate = point(0, -8), aligned = point(0, -12);
  assert.equal(hasSameWaveSeparation(origin, candidate, [enemy(aligned)], 1), false);
  for (const contact of [
    enemy(aligned, { alive: false }), enemy(aligned, { removed: true }), enemy(aligned, { encounterWave: 0 }),
  ]) assert.equal(hasSameWaveSeparation(origin, candidate, [contact], 1), true);
  assert.equal(hasSameWaveSeparation(origin, candidate, [], 1), true);
});

test('encounter ownership prevents a different zone or final group from blocking the pair rule', () => {
  const aligned = enemy(point(0, -12), { encounterKey: 'final-car' });
  assert.equal(hasSameWaveSeparation(origin, point(0, -8), [aligned], 1, { encounterKey: 'balcony' }), true);
  assert.equal(hasSameWaveSeparation(origin, point(0, -8), [aligned], 1, { encounterKey: 'final-car' }), false);
});

test('all same-wave contacts must pass separation without mutating their ownership or positions', () => {
  const contacts = Object.freeze([
    Object.freeze(enemy(Object.freeze(point(1, -8)))),
    Object.freeze(enemy(Object.freeze(point(0, -12)))),
  ]);
  assert.equal(hasSameWaveSeparation(origin, point(0, -8), contacts, 1), false);
  assert.deepEqual(contacts.map(contact => contact.pos), [point(1, -8), point(0, -12)]);
  assert.equal(hasSameWaveSeparation(origin, point(0, -8), contacts, NaN), false);
  assert.equal(hasSameWaveSeparation(origin, point(0, -8), null, 1), false);
  assert.equal(hasSameWaveSeparation(point(NaN, 0), point(0, -8), [], 1), false);
});
