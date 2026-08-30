import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameBudget, FixedStepClock } from '../../src/core/frame-budget.js';

test('paused time cannot become catch-up damage on resume', () => {
  const clock = new FixedStepClock();
  assert.equal(clock.advance(0.01, true), 1);
  assert.equal(clock.advance(100, false), 0);
  assert.equal(clock.advance(1 / 60, true), 2);
});
test('stalls have bounded work and invalid deltas are ignored', () => {
  const clock = new FixedStepClock();
  assert.equal(clock.advance(30, true), 8);
  assert.equal(clock.advance(NaN, true), 0);
  assert.equal(clock.advance(-1, true), 0);
});
test('adaptive scale respects bounds and waits for sustained pressure', () => {
  const budget = new FrameBudget();
  for (let i = 0; i < 90; i++) budget.sample(1 / 30);
  assert.equal(budget.scale, 1.2);
  for (let i = 0; i < 2000; i++) budget.sample(1 / 30);
  assert.equal(budget.scale, 0.7);
  for (let i = 0; i < 10000; i++) budget.sample(1 / 120);
  assert.equal(budget.scale, 1.4);
});

test('adaptive steps land exactly on the contact-shading boundary', () => {
  const budget = new FrameBudget();
  for (let i = 0; i < 360; i++) budget.sample(1 / 30);
  assert.equal(budget.scale, 1, 'two downward steps must not prematurely disable contact shading');
  for (let i = 0; i < 720; i++) budget.sample(1 / 120);
  assert.equal(budget.scale, 1.1, 'recovery uses the same stable hundredth increments');
});
