import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionTurn } from '../../src/core/motion-turn.js';

const pixels = degrees => -degrees * Math.PI / 180 / 0.0025;
const degrees = dx => -dx * 0.0025 * 180 / Math.PI;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

test('hybrid retains direct horizontal aim and independent vertical sensitivity', () => {
  const turn = createMotionTurn();
  const delta = turn.update(pixels(5), pixels(-4), 'hybrid', 1.5);
  close(degrees(delta.dx), 5);
  close(degrees(delta.dy), -6);
  close(turn.tick(1 / 60), 0);
});

test('held edge turns repeatedly without new samples and retains rotation at neutral', () => {
  for (const sign of [-1, 1]) {
    const turn = createMotionTurn();
    let yaw = degrees(turn.update(pixels(27 * sign), 0, 'edge').dx);
    close(yaw, 15 * sign);
    for (let frame = 0; frame < 360; frame++) yaw += degrees(turn.tick(1 / 60));
    yaw += degrees(turn.update(pixels(-27 * sign), 0, 'edge').dx);
    close(yaw, 720 * sign);
    close(turn.tick(1 / 60), 0);
  }
});

test('edge turns depend on elapsed active time instead of frame rate or sensor count', () => {
  for (const frequency of [30, 60, 120]) {
    const turn = createMotionTurn();
    turn.update(pixels(21), 0, 'edge');
    let yaw = 0;
    for (let frame = 0; frame < frequency * 3; frame++) {
      if (frame % 5 === 0) turn.update(0, 0, 'edge');
      yaw += degrees(turn.tick(1 / frequency));
    }
    close(yaw, 180);
  }
});

test('small aiming motions and return through center never acquire a continuous turn', () => {
  const turn = createMotionTurn();
  for (const movement of [5, 7, -4, -8, -12, 12]) {
    close(degrees(turn.update(pixels(movement), 0, 'edge').dx), movement);
    close(turn.tick(0.1), 0);
  }
});

test('reset or hybrid switch discards deflection without emitting a counter-turn', () => {
  const turn = createMotionTurn();
  turn.update(pixels(27), 0, 'edge');
  turn.reset();
  close(turn.tick(0.1), 0);
  close(degrees(turn.update(pixels(-3), 0, 'edge').dx), -3);
  turn.update(pixels(-27), 0, 'edge');
  close(degrees(turn.update(pixels(2), 0, 'hybrid').dx), 2);
  close(turn.tick(0.1), 0);
});

test('invalid elapsed times cannot create motion and long gaps are bounded', () => {
  const turn = createMotionTurn();
  turn.update(pixels(27), 0, 'edge');
  for (const dt of [NaN, Infinity, -1, 0, undefined]) close(turn.tick(dt), 0);
  close(degrees(turn.tick(100)), 12);
});
