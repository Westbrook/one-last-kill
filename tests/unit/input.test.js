import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputState, normalizeStick } from '../../src/core/input-state.js';

function controller({ pressed = [], axes = [0, 0, 0, 0] } = {}) {
  return { connected: true, axes, buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: pressed.includes(index), value: pressed.includes(index) ? 1 : 0 })) };
}

test('menus reject held movement, attacks, and look deltas', () => {
  const input = createInputState();
  input.keyDown('KeyW');
  input.keyDown('KeyJ');
  input.keyDown('KeyT');
  input.mouseButton(0, true);
  input.mouseMove(100, 50);
  input.setGamepad(controller({ pressed: [7, 12], axes: [1, 1, 1, 1] }));
  const frame = input.consumeFrame();
  assert.equal(input.keys.size, 0);
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.tPressed, false);
  assert.equal(frame.dx, 0);
  assert.equal(frame.moveX, 0);
});

test('edge actions are consumed exactly once and ignore repeats', () => {
  const input = createInputState();
  input.activate();
  for (const code of ['KeyE', 'KeyR', 'KeyV', 'KeyG', 'KeyT', 'Space', 'KeyJ']) input.keyDown(code);
  const first = input.consumeFrame();
  for (const action of ['ePressed', 'rPressed', 'vPressed', 'gPressed', 'tPressed', 'jumpPressed', 'leftPressed']) assert.equal(first[action], true);
  for (const code of ['KeyE', 'KeyR', 'KeyV', 'KeyG', 'KeyT', 'Space', 'KeyJ']) {
    input.keyDown(code, true);
    input.keyDown(code, false);
  }
  const next = input.consumeFrame();
  for (const action of ['ePressed', 'rPressed', 'vPressed', 'gPressed', 'tPressed', 'jumpPressed', 'leftPressed']) assert.equal(next[action], false);
  assert.equal(next.leftDown, true);
  input.keyUp('KeyJ');
  input.keyDown('KeyJ');
  input.keyUp('KeyT');
  input.keyDown('KeyT');
  const pressedAgain = input.consumeFrame();
  assert.equal(pressedAgain.leftPressed, true);
  assert.equal(pressedAgain.tPressed, true);
});

test('pause clears keys, mouse buttons, aim toggle, edges, and deltas', () => {
  const input = createInputState();
  input.activate();
  input.locked = true;
  input.keyDown('KeyW');
  input.keyDown('KeyE');
  input.keyDown('KeyT');
  input.keyDown('KeyQ');
  input.mouseButton(0, true);
  input.mouseButton(2, true);
  input.mouseMove(200, -80);
  input.setGamepad(controller({ pressed: [0, 6, 7, 10, 12], axes: [0.8, -1, 1, 1] }));
  input.pause();
  assert.equal(input.active, false);
  assert.equal(input.locked, false);
  assert.equal(input.keys.size, 0);
  assert.equal(input.isAiming(), false);
  input.activate();
  const frame = input.consumeFrame();
  for (const key of ['leftDown', 'leftPressed', 'rightDown', 'ePressed', 'tPressed', 'jumpDown', 'jumpPressed', 'sprintDown']) assert.equal(frame[key], false);
  for (const key of ['dx', 'dy', 'moveX', 'moveY']) assert.equal(frame[key], 0);
});

test('reset clears captured controls without deactivating an engaged session', () => {
  const input = createInputState();
  input.activate();
  input.locked = true;
  input.keyDown('KeyW');
  input.reset();
  assert.equal(input.active, true);
  assert.equal(input.locked, true);
  assert.equal(input.keys.size, 0);
});

test('keyboard fallback supports frame-rate-independent looking and firing', () => {
  const input = createInputState();
  input.activate();
  assert.equal(input.locked, false);
  input.keyDown('ArrowRight');
  input.keyDown('ArrowUp');
  input.keyDown('KeyJ');
  const first = input.consumeFrame(1 / 60);
  assert.ok(first.dx > 0);
  assert.ok(first.dy < 0);
  assert.equal(first.leftDown, true);
  assert.equal(first.leftPressed, true);
  const halfFrame = input.consumeFrame(1 / 120);
  assert.equal(halfFrame.dx * 2, first.dx);
  assert.equal(halfFrame.leftPressed, false);
});

test('mouse deltas are consumed once and invalid deltas cannot poison the camera', () => {
  const input = createInputState();
  input.activate();
  input.mouseMove(10, -3);
  input.mouseMove(Number.NaN, Number.POSITIVE_INFINITY);
  assert.equal(input.consumeFrame().dx, 10);
  assert.equal(input.consumeFrame().dy, 0);
});

test('mouse, keyboard, and gamepad fire release independently', () => {
  const input = createInputState();
  input.activate();
  input.keyDown('KeyJ');
  input.mouseButton(0, true);
  input.setGamepad(controller({ pressed: [7] }));
  input.mouseButton(0, false);
  input.keyUp('KeyJ');
  assert.equal(input.leftDown, true);
  input.setGamepad(controller());
  assert.equal(input.leftDown, false);
});

test('aim works as mouse hold, Q toggle, and controller trigger', () => {
  const input = createInputState();
  input.activate();
  input.mouseButton(2, true);
  assert.equal(input.isAiming(), true);
  input.mouseButton(2, false);
  assert.equal(input.isAiming(), false);
  input.keyDown('KeyQ');
  input.keyDown('KeyQ', true);
  assert.equal(input.isAiming(), true);
  input.keyUp('KeyQ');
  input.keyDown('KeyQ');
  assert.equal(input.isAiming(), false);
  input.setGamepad(controller({ pressed: [6] }));
  assert.equal(input.consumeFrame().rightDown, true);
  input.setGamepad(controller());
  assert.equal(input.isAiming(), false);
});

test('stick dead zone rejects drift and clamps diagonal movement', () => {
  assert.deepEqual(normalizeStick(0.1, 0.1), { x: 0, y: 0 });
  assert.deepEqual(normalizeStick(Number.NaN, undefined), { x: 0, y: 0 });
  const diagonal = normalizeStick(1, -1);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-10);
  assert.ok(diagonal.x > 0);
  assert.ok(diagonal.y < 0);
});

test('standard gamepad actions have edges, forward movement, and aim', () => {
  const input = createInputState();
  input.activate();
  const pad = controller({ pressed: [0, 1, 2, 3, 5, 6, 7, 10, 12, 13], axes: [0, -1, 0.6, -0.5] });
  input.setGamepad(pad);
  const frame = input.consumeFrame();
  for (const key of ['leftDown', 'leftPressed', 'jumpDown', 'jumpPressed', 'rPressed', 'ePressed', 'vPressed', 'gPressed', 'tPressed', 'crouchDown', 'sprintDown', 'rightDown']) assert.equal(frame[key], true, key);
  assert.equal(frame.moveY, 1);
  assert.ok(frame.dx > 0);
  assert.ok(frame.dy < 0);
  input.setGamepad(pad);
  const held = input.consumeFrame();
  assert.equal(held.leftDown, true);
  assert.equal(held.leftPressed, false);
  assert.equal(held.rPressed, false);
  assert.equal(held.tPressed, false);
  assert.equal(held.jumpPressed, false);
});

test('controller disconnect clears only controller controls', () => {
  const input = createInputState();
  input.activate();
  input.keyDown('KeyW');
  input.setGamepad(controller({ pressed: [6, 7], axes: [1, -1, 1, 1] }));
  input.consumeFrame();
  input.setGamepad(null);
  const frame = input.consumeFrame();
  assert.equal(input.gamepadConnected, false);
  assert.equal(input.keys.has('KeyW'), true);
  assert.equal(frame.leftDown, false);
  assert.equal(frame.rightDown, false);
  assert.equal(frame.moveX, 0);
  assert.equal(frame.dx, 0);
});

test('controller confirm can be accepted without creating a jump or shot edge', () => {
  const input = createInputState();
  input.activate();
  const pad = controller({ pressed: [0, 7, 12] });
  input.setGamepad(pad, { suppressEdges: true });
  const initial = input.consumeFrame();
  assert.equal(initial.jumpPressed, false);
  assert.equal(initial.leftPressed, false);
  assert.equal(initial.tPressed, false);
  assert.equal(initial.leftDown, false);
  assert.equal(initial.jumpDown, false);
  input.setGamepad(pad);
  const held = input.consumeFrame();
  assert.equal(held.jumpPressed, false);
  assert.equal(held.tPressed, false);
  input.setGamepad(controller());
  input.setGamepad(pad);
  const pressedAgain = input.consumeFrame();
  assert.equal(pressedAgain.jumpPressed, true);
  assert.equal(pressedAgain.tPressed, true);
});

test('a controller button held through focus loss stays released until a fresh press', () => {
  const input = createInputState();
  const pad = controller({ pressed: [6, 7, 12] });
  input.activate();
  input.setGamepad(pad);
  const initial = input.consumeFrame();
  assert.equal(initial.leftDown, true);
  assert.equal(initial.tPressed, true);
  input.pause();
  input.activate();
  input.setGamepad(pad);
  const resumed = input.consumeFrame();
  assert.equal(resumed.leftDown, false);
  assert.equal(resumed.tPressed, false);
  assert.equal(input.isAiming(), false);
  input.setGamepad(controller());
  input.setGamepad(pad);
  const pressedAgain = input.consumeFrame();
  assert.equal(pressedAgain.leftPressed, true);
  assert.equal(pressedAgain.tPressed, true);
});
