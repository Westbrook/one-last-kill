import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { lerp, clamp } from '../../src/core/math.js';
import { capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { createBallisticHit } from '../../src/core/ballistics.js';

// Actual player/camera code, with explicit quiet services. These joined floor
// fixtures isolate camera behavior; stair-layout tests cover the built world.
function fixture(reducedMotion) {
  const floorY = 14;
  const box = (x1, x2, y1, y2) => new THREE.Box3(
    new THREE.Vector3(x1, y1, -2), new THREE.Vector3(x2, y2, 2),
  );
  const colliders = [box(-5, 0, floorY - 0.24, floorY), box(0, 0.3, floorY - 0.24, floorY),
    box(0.3, 5, floorY - 0.24, floorY), box(0, 0.3, floorY + 1.95, floorY + 2.4)];
  const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 300);
  const Input = { active: true, keys: new Set(), isAiming: () => false,
    consumeFrame: () => ({ dx: 0, dy: 0 }) };
  const source = readFileSync(new URL('../../src/game/player.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '');
  assert.doesNotMatch(source, /^import\s/m);
  const api = runInNewContext(`${source}\n;({ Player, playerInit, playerUpdate, resetPlayerMotion });`, {
    THREE, lerp, clamp, camera, Colliders: { list: colliders }, capsuleHasClearance, moveCapsule, Input,
    Ballistics: { raycast: () => null }, createBallisticHit, currentZone: 'roof',
    Settings: { get: key => key === 'reducedMotion' ? reducedMotion : 1 },
    Audio: { footstep() {}, movement() {} }, HUD: { setHealth() {}, setArmor() {} }, Weapons: { handleInput() {} },
  }, { filename: 'player.js' });
  return { ...api, camera, Input, floorY };
}

test('actual player camera crosses flush floor joints in both directions without height oscillation', () => {
  for (const reducedMotion of [false, true]) for (const sign of [-1, 1]) for (const dt of [1 / 120, 1 / 60, 1 / 30]) {
    const { Player, playerInit, playerUpdate, camera, Input, floorY } = fixture(reducedMotion);
    Player.pos.set(-sign * 1.5, floorY + Player.eyeHeight + 0.01, 0);
    Player.yaw = -sign * Math.PI / 2;
    playerInit();
    for (let tick = 0; tick < 60; tick++) playerUpdate(dt);
    Input.keys.add('KeyW');
    let frames = 0, minEye = Infinity, maxEye = -Infinity;
    while (sign * Player.pos.x < 1.6 && frames++ < 360) {
      playerUpdate(dt);
      assert.equal(Player.onGround, true, `Lost support at x=${Player.pos.x}, foot=${Player.pos.y - Player._eyeH}, vy=${Player.vel.y}, direction=${sign}, dt=${dt}`);
      assert.ok(Math.abs(Player.pos.y - Player._eyeH - floorY) < 0.001, 'The foot anchor stays on the joined plane');
      assert.ok(Math.abs(Player._stepOffset) < 0.001, 'Flush joints cannot repeatedly trigger step smoothing');
      assert.ok(camera.position.toArray().every(Number.isFinite));
      assert.ok(camera.rotation.toArray().slice(0, 3).every(Number.isFinite));
      minEye = Math.min(minEye, camera.position.y); maxEye = Math.max(maxEye, camera.position.y);
      assert.ok(Math.abs(camera.position.y - Player.pos.y) <= 0.0061,
        'Only the authored small walking bob may move the eye relative to the body');
    }
    assert.ok(sign * Player.pos.x >= 1.6, 'The real controller must traverse all three slabs');
    assert.ok(maxEye - minEye <= (reducedMotion ? 0.00001 : 0.0121));
  }
});

test('camera step smoothing settles monotonically after the last riser instead of bouncing', () => {
  for (const dt of [1 / 120, 1 / 60, 1 / 30]) {
    const { Player, playerInit, playerUpdate, camera, floorY } = fixture(true);
    Player.pos.set(0.8, floorY + Player.eyeHeight, 0);
    playerInit();
    for (let tick = 0; tick < 60; tick++) playerUpdate(dt);
    // This disclosed state models the eased camera immediately after a riser.
    // The supporting floor and all subsequent movement use real collision.
    Player._stepOffset = 0.18;
    let previousOffset = Player._stepOffset, previousEye = Player.pos.y - previousOffset;
    for (let tick = 0; tick < Math.ceil(1 / dt); tick++) {
      playerUpdate(dt);
      assert.ok(Player._stepOffset <= previousOffset && Player._stepOffset >= 0);
      assert.ok(camera.position.y >= previousEye - 1e-9);
      assert.ok(camera.position.y - previousEye < 0.083, 'No correction exceeds the bounded exponential recovery');
      assert.ok(Math.abs(Player.pos.y - Player._eyeH - floorY) < 0.001);
      previousOffset = Player._stepOffset; previousEye = camera.position.y;
    }
    assert.ok(Player._stepOffset < 1e-7);
    assert.ok(Math.abs(camera.position.y - Player.pos.y) < 1e-7);
  }
});

test('standing still on a floor joint leaves the camera and stance stable', () => {
  const { Player, playerInit, playerUpdate, camera, floorY } = fixture(false);
  for (const x of [0, 0.3]) {
    Player.pos.set(x, floorY + Player.eyeHeight, 0);
    playerInit();
    for (let tick = 0; tick < 120; tick++) playerUpdate(1 / 120);
    const position = camera.position.clone();
    for (let tick = 0; tick < 360; tick++) {
      playerUpdate(1 / 120);
      assert.ok(camera.position.distanceTo(position) < 1e-9);
      assert.equal(Player._eyeH, Player.eyeHeight);
      assert.equal(Player.isCrouching, false);
      assert.equal(Player.onGround, true);
    }
  }
});
