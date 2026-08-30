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

test('touch controls are ignored before activation and cleared through pause or reset', () => {
  const input = createInputState();
  const pressTouchControls = () => {
    input.setTouchMove(1, 1);
    input.touchLook(120, -80);
    for (const action of ['fire', 'aim', 'jump', 'crouch', 'sprint', 'use', 'reload', 'melee', 'drop', 'rage']) input.touchButton(action, true);
  };
  const assertReleased = () => {
    const frame = input.consumeFrame();
    for (const key of ['leftDown', 'leftPressed', 'aimDown', 'jumpDown', 'jumpPressed', 'crouchDown', 'sprintDown', 'ePressed', 'rPressed', 'vPressed', 'gPressed', 'tPressed']) assert.equal(frame[key], false, key);
    for (const key of ['dx', 'dy', 'moveX', 'moveY']) assert.equal(frame[key], 0, key);
  };
  pressTouchControls();
  assertReleased();
  input.activate();
  assertReleased();
  pressTouchControls();
  input.pause();
  pressTouchControls();
  input.activate();
  assertReleased();
  pressTouchControls();
  input.reset();
  assert.equal(input.active, true);
  assertReleased();
  pressTouchControls();
  input.activate();
  assertReleased();
});

test('touch action edges fire once per press, including taps released between frames', () => {
  const input = createInputState();
  input.activate();
  const actions = {
    fire: 'leftPressed', jump: 'jumpPressed', use: 'ePressed', reload: 'rPressed',
    melee: 'vPressed', drop: 'gPressed', rage: 'tPressed',
  };
  for (const action of Object.keys(actions)) input.touchButton(action, true);
  const first = input.consumeFrame();
  for (const edge of Object.values(actions)) assert.equal(first[edge], true, edge);
  assert.equal(first.leftDown, true);
  assert.equal(first.jumpDown, true);
  for (const action of Object.keys(actions)) input.touchButton(action, true);
  const held = input.consumeFrame();
  for (const edge of Object.values(actions)) assert.equal(held[edge], false, edge);
  assert.equal(held.leftDown, true);
  assert.equal(held.jumpDown, true);
  for (const action of Object.keys(actions)) {
    input.touchButton(action, false);
    input.touchButton(action, true);
    input.touchButton(action, false);
  }
  const tapped = input.consumeFrame();
  for (const edge of Object.values(actions)) assert.equal(tapped[edge], true, edge);
  assert.equal(tapped.leftDown, false);
  assert.equal(tapped.jumpDown, false);
  const next = input.consumeFrame();
  for (const edge of Object.values(actions)) assert.equal(next[edge], false, edge);
  assert.equal(input.touchButton('unknown', true), false);
});

test('touch fire and aim release independently of mouse, keyboard, and controller', () => {
  const sources = [
    (input, down) => {
      input[down ? 'keyDown' : 'keyUp']('KeyJ');
      input.keyDown('KeyQ');
      input.keyUp('KeyQ');
    },
    (input, down) => { input.mouseButton(0, down); input.mouseButton(2, down); },
    (input, down) => input.setGamepad(controller({ pressed: down ? [6, 7] : [] })),
  ];
  for (const setPhysicalButtons of sources) {
    const input = createInputState();
    input.activate();
    setPhysicalButtons(input, true);
    input.touchButton('fire', true);
    input.touchButton('aim', true);
    setPhysicalButtons(input, false);
    assert.equal(input.leftDown, true);
    assert.equal(input.isAiming(), true);
    input.touchButton('fire', false);
    input.touchButton('aim', false);
    assert.equal(input.leftDown, false);
    assert.equal(input.isAiming(), false);

    setPhysicalButtons(input, true);
    input.touchButton('fire', true);
    input.touchButton('aim', true);
    input.touchButton('fire', false);
    input.touchButton('aim', false);
    assert.equal(input.leftDown, true);
    assert.equal(input.isAiming(), true);
    setPhysicalButtons(input, false);
    assert.equal(input.leftDown, false);
    assert.equal(input.isAiming(), false);
  }
});

test('touch jump, sprint, and crouch remain held across frames and release independently', () => {
  const input = createInputState();
  input.activate();
  const actions = [
    ['jump', 'Space', 'jumpDown'],
    ['sprint', 'ShiftLeft', 'sprintDown'],
    ['crouch', 'KeyC', 'crouchDown'],
  ];
  for (const [action, code] of actions) {
    input.touchButton(action, true);
    input.keyDown(code);
    input.keyUp(code);
  }
  for (let frameIndex = 0; frameIndex < 2; frameIndex++) {
    const frame = input.consumeFrame();
    for (const [, , held] of actions) assert.equal(frame[held], true, held);
  }
  for (const [action, code] of actions) {
    input.keyDown(code);
    input.touchButton(action, false);
  }
  const keyboardHeld = input.consumeFrame();
  for (const [, code, held] of actions) {
    assert.equal(keyboardHeld[held], true, held);
    input.keyUp(code);
  }
  const released = input.consumeFrame();
  for (const [, , held] of actions) assert.equal(released[held], false, held);
});

test('touch movement has a radial deadzone, forward Y, and bounded combined movement', () => {
  const input = createInputState();
  input.activate();
  input.setTouchMove(0.08, 0.08);
  let frame = input.consumeFrame();
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 0);
  input.setTouchMove(Number.NaN, Number.POSITIVE_INFINITY);
  frame = input.consumeFrame();
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 0);
  input.setTouchMove(0, 0.56);
  frame = input.consumeFrame();
  assert.ok(Math.abs(frame.moveY - 0.5) < 1e-10);
  assert.equal(input.consumeFrame().moveY, frame.moveY);
  input.setTouchMove(2, 2);
  frame = input.consumeFrame();
  assert.ok(Math.abs(Math.hypot(frame.moveX, frame.moveY) - 1) < 1e-10);
  assert.ok(frame.moveX > 0 && frame.moveY > 0);
  input.setTouchMove(1, 0);
  input.setGamepad(controller({ axes: [0, -1, 0, 0] }));
  frame = input.consumeFrame();
  assert.ok(Math.abs(Math.hypot(frame.moveX, frame.moveY) - 1) < 1e-10);
  assert.ok(frame.moveX > 0 && frame.moveY > 0);
  input.setTouchMove(0, -1);
  frame = input.consumeFrame();
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 0);
  input.setGamepad(null);
  assert.equal(input.consumeFrame().moveY, -1);
});

test('touch look combines with mouse deltas once and rejects non-finite values', () => {
  const input = createInputState();
  input.activate();
  input.mouseMove(8, -6);
  input.touchLook(10, -3);
  input.touchLook(-2, 4);
  input.touchLook(Number.NaN, Number.NEGATIVE_INFINITY);
  const frame = input.consumeFrame();
  assert.equal(frame.dx, 16);
  assert.equal(frame.dy, -5);
  const next = input.consumeFrame();
  assert.equal(next.dx, 0);
  assert.equal(next.dy, 0);
});

test('resetTouch clears only touch controls and preserves other devices pending edges', () => {
  const input = createInputState();
  input.activate();
  input.keyDown('KeyW');
  input.keyDown('KeyE');
  input.keyDown('Space');
  input.mouseButton(0, true);
  input.mouseMove(9, -4);
  input.setGamepad(controller({ pressed: [2, 6, 10], axes: [0, -1, 0, 0] }));
  input.setTouchMove(1, 0);
  input.touchLook(100, 100);
  for (const action of ['fire', 'jump', 'aim', 'crouch', 'sprint', 'use', 'reload', 'melee', 'drop', 'rage']) input.touchButton(action, true);
  input.resetTouch();
  assert.equal(input.active, true);
  assert.equal(input.keys.has('KeyW'), true);
  const frame = input.consumeFrame();
  assert.equal(frame.dx, 9);
  assert.equal(frame.dy, -4);
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 1);
  for (const key of ['leftDown', 'leftPressed', 'aimDown', 'jumpDown', 'jumpPressed', 'sprintDown', 'ePressed', 'rPressed']) assert.equal(frame[key], true, key);
  for (const key of ['crouchDown', 'vPressed', 'gPressed', 'tPressed']) assert.equal(frame[key], false, key);
  input.keyUp('Space');
  input.mouseButton(0, false);
  input.setGamepad(null);
  const released = input.consumeFrame();
  for (const key of ['leftDown', 'aimDown', 'jumpDown', 'sprintDown']) assert.equal(released[key], false, key);
});
