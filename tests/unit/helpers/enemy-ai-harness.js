import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import * as Navigation from '../../../src/game/enemy-navigation.js';
import * as Combat from '../../../src/game/combat-rules.js';
import * as ArmorRules from '../../../src/game/armor-rules.js';
import * as StairPursuit from '../../../src/game/stair-pursuit.js';
import { DIFFICULTY_LEVELS, getDifficultyProfile, scaleEncounter } from '../../../src/game/difficulty.js';
import { DifficultyLootLedger } from '../../../src/game/difficulty-loot-rules.js';
import { lerp, smoothstep } from '../../../src/core/math.js';
import { BUILDING, BALCONY, ROOF } from '../../../src/world/layout.js';
import { DISTRICT } from '../../../src/world/district-layout.js';
import { ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from '../../../src/game/mission-data.js';
import { Colliders, resolveCapsuleAABB } from '../../../src/core/collision.js';
import { createBallisticHit } from '../../../src/core/ballistics.js';
import { resolveSurfaceOwnership } from '../../../src/world/surface-ownership.js';
import { createAmmoSupplies } from '../../../src/game/ammo-supplies.js';
import { buildWorldSurfaceFixture } from './world-surface-fixture.js';

/**
 * Real enemy perception, steering, attacks and capsule movement against all
 * authored geometry. Only rig presentation, GPU compilation and effect/audio
 * sinks are replaced; no browser, renderer or audio device is constructed.
 * A focused integration test can supply the real DOM-free humanoid functions.
 */
export function createEnemyAIHarness({ audio = null, humanoids = null, difficulty = 'average' } = {}) {
  const fixture = buildWorldSurfaceFixture();
  const clock = { elapsed: 0 };
  const player = { pos: new THREE.Vector3(), _eyeH: 1.72, _bodyH: 1.84, radius: 0.32, health: 1000 };
  const playerState = { dead: false }, damage = [], drops = [], armorDrops = [];
  const supplies = createAmmoSupplies();
  supplies.init({ world: fixture.World, player, canInteract: () => false });
  resolveSurfaceOwnership(fixture.records.values());
  fixture.ballistics.rebuild(fixture.World);
  const missionSource = readFileSync(new URL('../../../src/game/mission.js', import.meta.url), 'utf8');
  const floorSource = missionSource.match(/function surfaceTopAt\([^]*?\n\}/)?.[0];
  assert.ok(floorSource, 'keep the actual floor sampler in this harness');
  const surfaceTopAt = runInNewContext(`${floorSource}\n;surfaceTopAt;`, { Colliders });
  const source = readFileSync(new URL('../../../src/game/enemies.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\s*$/gm, match => match.replace(/[^\n]/g, ''))
    .replace(/^export\s*\{[^}]+\};?\s*$/gm, match => match.replace(/[^\n]/g, ''));
  assert.doesNotMatch(source, /^import\s/m);
  const silentEffects = new Proxy({}, { get: () => () => {} });
  const deterministicMath = Object.create(Math); deterministicMath.random = () => 0.5;
  const runSettings = { profile: getDifficultyProfile(difficulty) };
  const api = runInNewContext(`${source}\n;({ ENEMY_TYPES, EnemyPool, EnemyNavigation, Enemies, enemiesUpdate, enemyTick, enemyAttackPlayer, hasLineOfSight, isBlocked, primeEnemyInvestigation, raycastEnemies, damageEnemy, killEnemy, resetDifficultyLoot, snapshotDifficultyLoot, restoreDifficultyLoot });`, {
    THREE, lerp, smoothstep, ...Navigation, ...Combat, ...ArmorRules, ...StairPursuit,
    RunSettings: runSettings, DifficultyLootLedger, DIFFICULTY_LEVELS, scaleEncounter,
    GameTime: clock, Player: player, PlayerState: playerState,
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: { compile() {} },
    World: fixture.World, Colliders, resolveCapsuleAABB, Ballistics: fixture.ballistics, createBallisticHit, BUILDING, BALCONY, ROOF, DISTRICT,
    ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS, Math: deterministicMath, surfaceTopAt,
    makeHumanoid: () => new THREE.Group(), attachHeldWeapon: () => null, resetHumanoidPose() {}, updateHumanoidPose() {},
    beginHumanoidCollapse() {}, updateHumanoidCollapse: () => true,
    ...humanoids,
    WeaponDrops: { _mat: () => null, spawn(...args) { drops.push(args); } }, Audio: audio ?? silentEffects, Blood: silentEffects, FX: silentEffects,
    ArmorPickups: { spawn(...args) { armorDrops.push(args); } },
    applyPlayerDamage(amount, origin, attacker) { damage.push({ time: clock.elapsed, amount, origin: origin.clone(), attacker }); return true; },
  }, { filename: 'src/game/enemies.js' });
  api.EnemyPool.init();

  function placePlayer(point) {
    player.pos.set(point.x, point.y + player._eyeH, point.z);
  }
  function reset(goal) {
    api.Enemies.clearAll(); clock.elapsed = 0; damage.length = 0; drops.length = 0; armorDrops.length = 0;
    api.resetDifficultyLoot();
    player.health = 1000; playerState.dead = false;
    if (goal) placePlayer(goal);
  }
  function spawn(type, point, { zone = 'stairwell', prime = false } = {}) {
    const enemy = api.Enemies.spawn(type, point.x, point.z, point.y + 0.03);
    assert.ok(enemy, `available ${type} pool slot`);
    enemy.zone = zone;
    if (prime) assert.equal(api.primeEnemyInvestigation(enemy, player.pos, player.pos.y - player._eyeH), true);
    return enemy;
  }
  function step(dt = 1 / 120) {
    clock.elapsed += dt;
    api.enemiesUpdate(dt);
  }
  return { ...api, fixture, ballistics: fixture.ballistics, colliders: Colliders.list, clock, player, playerState, runSettings, damage, drops, armorDrops, supplies, surfaceTopAt, placePlayer, reset, spawn, step };
}
