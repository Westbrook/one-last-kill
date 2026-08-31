import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { Colliders, capsuleHasClearance, moveCapsule } from '../../../src/core/collision.js';
import { createBallisticHit } from '../../../src/core/ballistics.js';
import { createInputState } from '../../../src/core/input-state.js';
import { lerp, clamp } from '../../../src/core/math.js';
import { createAmmoSupplies } from '../../../src/game/ammo-supplies.js';
import { resolveSurfaceOwnership } from '../../../src/world/surface-ownership.js';
import { buildWorldSurfaceFixture } from './world-surface-fixture.js';

/** Real eight-zone builders and ammo-box colliders, with no renderer/device. */
export function buildPlayerMovementWorld() {
  const fixture = buildWorldSurfaceFixture();
  resolveSurfaceOwnership(fixture.records.values());
  const supplies = createAmmoSupplies();
  supplies.init({ world: fixture.World, player: { pos: new THREE.Vector3(), _eyeH: 1.72 }, canInteract: () => false });
  const owners = new Map([...fixture.records.values()].filter(record => record.collider)
    .map(record => [record.collider, record.id]));
  for (const record of fixture.records.values()) {
    for (const [index, collider] of (record.mesh.userData.colliders ?? []).entries()) {
      owners.set(collider, `${record.id}:part-${index + 1}`);
    }
  }
  for (const entry of supplies.list) owners.set(entry.collider, entry.id);
  return { ...fixture, supplies, colliders: Colliders.list, owners };
}

const DIRECTIONS = Object.freeze({
  forward: { forward: 1, right: 0, keys: ['KeyW'] },
  strafe: { forward: 0, right: 1, keys: ['KeyD'] },
  diagonal: { forward: 1, right: 1, keys: ['KeyW', 'KeyD'] },
  backward: { forward: -1, right: 0, keys: ['KeyS'] },
});

/**
 * The actual Player controller consumes keyboard/analog/mouse/aim inputs.
 * Only the initial feet placement is assigned; steering never writes player
 * position, velocity, onGround, stance height, or the collision solver.
 */
export function createPlayerMovementHarness(world, { dt = 1 / 120, reducedMotion = false } = {}) {
  const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 300);
  // Exercise the real dead zone, key state and mouse delta consumption without
  // DOM listeners, pointer capture or a connected physical controller.
  const Input = createInputState();
  Input.activate();
  const audio = [], trace = [];
  let elapsed = 0, profile = {};
  const source = readFileSync(new URL('../../../src/game/player.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '');
  assert.doesNotMatch(source, /^import\s/m, 'Update the explicit player bindings for changed imports');
  const api = runInNewContext(source + '\n;({Player,PlayerState,playerInit,playerUpdate,resetPlayerMotion});', {
    THREE, lerp, clamp, camera, Colliders: { list: world.colliders }, capsuleHasClearance, moveCapsule, Input,
    Settings: { get: key => key === 'reducedMotion' ? reducedMotion : 1 },
    Ballistics: { raycast: () => null }, createBallisticHit, currentZone: 'stairwell',
    Audio: {
      footstep(options) { audio.push({ kind: 'footstep', ...options }); },
      movement(options) { audio.push({ kind: 'movement', ...options }); },
    },
    HUD: { setHealth() {}, setArmor() {} }, Weapons: { handleInput() {} },
  }, { filename: 'src/game/player.js:movement-input-fixture' });
  const { Player } = api;
  function feet() { return new THREE.Vector3(Player.pos.x, Player.pos.y - Player._eyeH, Player.pos.z); }
  function sample() {
    const position = feet();
    const value = { time: elapsed, position: position.toArray(), velocity: Player.vel.toArray(),
      onGround: Player.onGround, bodyHeight: Player._bodyH, eyeHeight: Player._eyeH,
      crouch: Player.isCrouching, aiming: Player.aiming, sprinting: Player.isSprinting,
      stepOffset: Player._stepOffset, eyeY: camera.position.y };
    trace.push(value);
    assert.ok(value.position.every(Number.isFinite) && value.velocity.every(Number.isFinite), 'Player state stays finite');
    assert.ok(camera.position.toArray().every(Number.isFinite), 'Camera stays finite');
    assert.equal(Input.keys.has('Space'), false, 'This fixture never presses jump');
    assert.equal(Player._jumpBuffer, 0, 'Movement must not acquire a synthetic jump buffer');
    assert.equal(capsuleHasClearance(position, Player.radius, Player._bodyH, world.colliders, 0.003), true,
      'The real controller must leave its capsule clear of the built geometry: ' + JSON.stringify(value));
    return value;
  }
  function tick(count = 1, observe = () => {}) {
    for (let index = 0; index < count; index++) {
      elapsed += dt;
      api.playerUpdate(dt);
      observe(sample());
    }
  }
  function setMovement(next = profile, moving = true) {
    profile = { ...next };
    const direction = DIRECTIONS[profile.scheme ?? 'forward'];
    assert.ok(direction, 'Known input scheme');
    for (const key of Input.keys) Input.keyUp(key);
    Input.mouseButton(2, Boolean(profile.aim));
    Input.setGamepad(null);
    if (profile.crouch) Input.keyDown('KeyC');
    if (profile.sprint) Input.keyDown('ShiftLeft');
    if (!moving) return;
    const magnitude = profile.magnitude ?? 1;
    if (magnitude === 1) for (const key of direction.keys) Input.keyDown(key);
    else {
      const length = Math.hypot(direction.forward, direction.right);
      // Invert the production 0.18 dead zone, then let setGamepad normalize it.
      // Even a requested 0.02 magnitude is a legitimate accepted stick input.
      const rawMagnitude = 0.18 + (1 - 0.18) * magnitude;
      Input.setGamepad({ connected: true, buttons: [], axes: [
        direction.right / length * rawMagnitude, -direction.forward / length * rawMagnitude, 0, 0,
      ] });
    }
  }
  function lookAlong(dx, dz) {
    const direction = DIRECTIONS[profile.scheme ?? 'forward'];
    const yaw = Math.atan2(-dx, -dz) + Math.atan2(direction.right, direction.forward);
    const difference = Math.atan2(Math.sin(Player.yaw - yaw), Math.cos(Player.yaw - yaw));
    Input.mouseMove(difference / (0.0025 * (Input.isAiming() ? 0.72 : 1)), 0);
  }
  function spawn(point, { yaw = 0, initialProfile = {} } = {}) {
    Input.activate();
    Player.pos.set(point[0], point[1] + Player.eyeHeight + 0.02, point[2]);
    Player.yaw = yaw; Player.pitch = 0; Player.health = 100; api.PlayerState.dead = false;
    api.playerInit();
    setMovement(initialProfile, false);
    tick(Math.ceil(0.5 / dt));
    assert.equal(Player.onGround, true, 'Initial disclosed feet fixture settles onto the authored floor');
    trace.length = 0; audio.length = 0; elapsed = 0;
  }
  function expectedSpeed() {
    const direction = DIRECTIONS[profile.scheme ?? 'forward'];
    const sprint = profile.sprint && direction.forward > 0 && !profile.crouch && !profile.aim;
    return (sprint ? Player.speedSprint : Player.speedWalk) * (profile.magnitude ?? 1)
      * (profile.crouch ? 0.5 : 1) * (profile.aim ? 0.65 : 1);
  }
  function diagnostic(target, label) {
    const position = feet(), area = new THREE.Box3(
      position.clone().add(new THREE.Vector3(-0.7, -0.35, -0.7)),
      position.clone().add(new THREE.Vector3(0.7, Player._bodyH + 0.2, 0.7)),
    );
    return {
      label, target, profile, dt, elapsed, feet: position.toArray(), velocity: Player.vel.toArray(),
      grounded: Player.onGround, stance: Player._bodyH,
      nearby: world.colliders.filter(box => box.intersectsBox(area)).slice(0, 12).map(box => ({
        id: world.owners.get(box) ?? 'unregistered collider', min: box.min.toArray(), max: box.max.toArray(),
      })),
      lastFrames: trace.slice(-6),
    };
  }
  function driveTo(target, nextProfile = profile, { label = 'Route target', maxSeconds, radius = 0.18 } = {}) {
    setMovement(nextProfile);
    const initialDistance = Math.hypot(target[0] - Player.pos.x, target[2] - Player.pos.z);
    const limit = Math.ceil((maxSeconds ?? initialDistance / expectedSpeed() * 2.5 + 2) / dt);
    for (let frame = 0; frame < limit; frame++) {
      const position = feet(), dx = target[0] - position.x, dz = target[2] - position.z;
      if (Math.hypot(dx, dz) <= radius && Math.abs(position.y - target[1]) <= 0.065 && Player.onGround) return;
      lookAlong(dx, dz); tick();
    }
    assert.fail('Continuous player input did not reach its target: ' + JSON.stringify(diagnostic(target, label)));
  }
  function stop(seconds = 0.35) { setMovement(profile, false); tick(Math.ceil(seconds / dt)); }
  return { ...api, camera, Input, audio, trace, world, dt,
    feet, tick, spawn, setMovement, lookAlong, driveTo, stop, diagnostic,
    elapsed: () => elapsed };
}
