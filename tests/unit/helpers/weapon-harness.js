import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { WEAPON_DEFS } from '../../../src/game/weapon-data.js';
import * as weaponRules from '../../../src/game/weapon-rules.js';
import * as meleeRules from '../../../src/game/melee-rules.js';
import { isSegmentOccluded } from '../../../src/game/combat-rules.js';
import { lerp, clamp } from '../../../src/core/math.js';
import { prepareViewModel, getViewModelMuzzle } from '../../../src/render/viewmodel.js';
import { createFirstPersonHands, poseFirstPersonHands, FIRST_PERSON_PUNCH_SECONDS } from '../../../src/render/first-person-hands.js';
import { createBatAsset, BAT_DIMENSIONS } from '../../../src/render/bat-asset.js';
import { createFirstPersonBat, poseFirstPersonBat } from '../../../src/render/first-person-bat.js';
import { placeWeaponDrop } from '../../../src/game/drop-placement.js';
import { createBallisticWorld, createBallisticHit } from '../../../src/core/ballistics.js';

/** Actual controller/model code with explicit CPU-only services, never a browser or audio device. */
export function weaponHarness({ supplies, colliders = { list: [] }, ballistics = createBallisticWorld({ colliders }), damageEnemy: damageTarget,
  audio = {}, zone = 'apartment' } = {}) {
  const source = readFileSync(new URL('../../../src/game/weapons.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '');
  assert.doesNotMatch(source, /^import\s/m, 'Update the explicit fixture for multiline imports');
  const calls = { sounds: 0, pickups: 0, audioEvents: [], damage: [], ranges: [], hits: [], kills: 0, messages: [], shots: [], impacts: [], tracers: [] };
  const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 100), scene = new THREE.Scene();
  const Player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), speedSprint: 6.5, _eyeH: 1.7, aiming: false, pitch: 0, yaw: 0 };
  const PlayerState = { dead: false }, World = new THREE.Group(), GameTime = { elapsed: 0 };
  const enemy = { alive: true, health: 500 };
  const ray = { query: () => ({ enemy, part: 'body', point: new THREE.Vector3(0, 0, -1), dist: 1 }) };
  const noOp = () => {};
  const audioEvent = name => (options = {}) => calls.audioEvents.push({ name, options: {
    ...options, ...(options.pos ? { pos: { x: options.pos.x, y: options.pos.y, z: options.pos.z } } : {}),
  } });
  const settings = { fov: 82, reducedMotion: false };
  const ammo = supplies ?? { findNearest: () => null, prompt: () => null, pickup: () => 0 };
  const deterministicMath = Object.create(Math); deterministicMath.random = () => 0.5;
  const api = runInNewContext(`${source}\n;({ Weapons, WeaponDrops, makeWeaponViewModel });`, {
    THREE, RoundedBoxGeometry, WEAPON_DEFS, ...weaponRules, ...meleeRules, lerp, clamp,
    createFirstPersonHands, poseFirstPersonHands, FIRST_PERSON_PUNCH_SECONDS, prepareViewModel, getViewModelMuzzle,
    createBatAsset, BAT_DIMENSIONS, createFirstPersonBat, poseFirstPersonBat, placeWeaponDrop, isSegmentOccluded, AmmoSupplies: ammo,
    scene, camera, GameTime, World, currentZone: zone, Colliders: colliders, Ballistics: ballistics, createBallisticHit, Player, PlayerState, Math: deterministicMath,
    HUD: {
      setWeapon: noOp, setReloading: noOp, setPickupPrompt: noOp,
      hit(value) { calls.hits.push(value); }, message(value) { calls.messages.push(value); },
    },
    Audio: {
      meleeHit(options) { calls.sounds++; audioEvent('meleeHit')(options); },
      pickupChime(options) { calls.pickups++; audioEvent('pickupChime')(options); },
      ...Object.fromEntries(['pistolShot', 'shotgunShot', 'smgShot', 'machinegunShot', 'reloadClack', 'dryClick',
        'meleeSwing', 'weaponMechanical', 'impact'].map(name => [name, audioEvent(name)])),
      ...audio,
    },
    FX: {
      muzzleFlash() {}, tracer(start, end) { calls.tracers.push({ start: start.clone(), end: end.clone() }); },
      impact(x, y, z, count, hit) { calls.impacts.push({ point: new THREE.Vector3(x, y, z), count, surfaceKind: hit?.surfaceKind, normal: hit?.normal.clone(), object: hit?.object }); },
    },
    CombatStats: { recordKill() { calls.kills++; }, recordShot(hit) { calls.shots.push(hit); } },
    Settings: { get: key => settings[key] ?? false },
    document: { getElementById: () => ({ classList: { toggle: noOp } }) },
    raycastEnemies(origin, direction, range, worldDistance) {
      calls.ranges.push(range);
      return ray.query(origin, direction, range, worldDistance);
    },
    damageEnemy(target, damage, part, point) {
      calls.damage.push(damage);
      if (damageTarget) return damageTarget(target, damage, part, point);
      target.health = Math.max(0, target.health - damage);
      target.alive = target.health > 0;
    },
  }, { filename: 'weapons.js' });
  return { ...api, camera, calls, Player, PlayerState, World, GameTime, enemy, ray, settings, colliders, ballistics };
}
