import test from 'node:test';
import assert from 'node:assert/strict';
import { createFireHazards, FIRE_DAMAGE_PER_SECOND } from '../../src/game/fire-hazards.js';

const box = (x1, y1, z1, x2, y2, z2) => ({ min: { x: x1, y: y1, z: z1 }, max: { x: x2, y: y2, z: z2 } });
const near = (actual, expected, message = 'Values agree') => assert.ok(Math.abs(actual - expected) < 1e-7,
  `${message}: ${actual} versus ${expected}`);

function fixture(options = {}) {
  const player = { pos: { x: -0.32, y: 1.72, z: 0 }, _eyeH: 1.72, _bodyH: 1.84, radius: 0.32, health: 100, armor: 80 };
  const fire = { active: true, damageBounds: box(0, 0, -0.5, 1, 2, 0.5) };
  const fires = [fire], colliders = [], gate = { active: true }, hits = [];
  const controller = createFireHazards({ player, fires, colliders, canDamage: () => gate.active,
    applyDamage(amount, source, feedback) {
      player.health -= amount;
      hits.push({ amount, source: { ...source }, ...feedback });
    }, ...options });
  return { player, fire, fires, colliders, gate, hits, controller };
}
function run(h, seconds, hz = 120) {
  for (let tick = 0; tick < Math.round(seconds * hz); tick++) h.controller.update(1 / hz);
}

test('a capsule touching a blocking fire takes damage at its boundary and within the small contact margin', () => {
  const h = fixture();
  h.fire.collider = h.fire.damageBounds;
  h.colliders.push(h.fire.collider);
  near(h.controller.update(0.25), 5, 'Exact collision contact is hot');
  h.player.pos.x = -0.339;
  near(h.controller.update(0.25), 5, 'A collision clearance gap inside two centimetres is hot');
  h.player.pos.x = -0.341;
  assert.equal(h.controller.update(0.25), 0);
  near(h.player.health, 90);
  assert.equal(h.player.armor, 80, 'Only the injected damage path owns player state');
});

test('rounded capsule corners and end caps use distance, not a rectangular player envelope', () => {
  const h = fixture();
  h.fire.damageBounds = box(0, 0, 0, 1, 2, 1);
  h.player.pos.x = -0.24; h.player.pos.z = -0.24;
  assert.ok(h.controller.update(0.1) > 0);
  h.player.pos.x = -0.245; h.player.pos.z = -0.245;
  assert.equal(h.controller.update(0.1), 0, 'The rounded corner is outside the two-centimetre margin');
  h.player.pos.x = 0; h.player.pos.z = 0;
  h.fire.damageBounds = box(-1, 1.855, -1, 1, 2.5, 1);
  assert.ok(h.controller.update(0.1) > 0, 'The actual upper cap retains its original segment endpoint');
  h.fire.damageBounds.min.y = 1.865;
  assert.equal(h.controller.update(0.1), 0);
  h.fire.damageBounds = box(-1, -1, -1, 1, -0.03, 1);
  assert.equal(h.controller.update(0.1), 0, 'A flame below the feet cannot touch the lower cap from another floor');
});

test('current crouch dimensions preserve feet and permit passing below elevated flames', () => {
  const h = fixture();
  h.player.pos.x = 0;
  h.fire.damageBounds = box(-1, 1.3, -1, 1, 2, 1);
  h.player.bodyHeight = 1.84; h.player.eyeHeight = 1.72;
  h.player._bodyH = 1.22; h.player._eyeH = 1.1; h.player.pos.y = 1.1;
  assert.equal(h.controller.update(0.25), 0);
  h.player._bodyH = 1.84; h.player._eyeH = 1.72; h.player.pos.y = 1.72;
  near(h.controller.update(0.25), 5);
});

test('continuous contact deals the same simulation-time damage at different frame rates and never stacks fires', () => {
  for (const hz of [4, 30, 60, 120]) for (const overlap of [1, 3]) {
    const h = fixture();
    for (let index = 1; index < overlap; index++) h.fires.push({ ...h.fire });
    run(h, 2, hz);
    near(h.player.health, 60);
    near(h.controller.snapshot().contactSeconds, 2);
    near(h.controller.snapshot().damageRequested, FIRE_DAMAGE_PER_SECOND * 2);
  }
  const h = fixture();
  for (const dt of [0.03, 0.17, 0.8, 1]) h.controller.update(dt);
  near(h.player.health, 60, 'All accepted simulation time contributes without a wall-clock catch-up timer');
});

test('leaving the flames stops damage immediately without retaining fractional damage debt', () => {
  const h = fixture();
  near(h.controller.update(0.12), 2.4);
  h.player.pos.x = -4;
  for (const dt of [0.01, 0.5, 2]) assert.equal(h.controller.update(dt), 0);
  assert.equal(h.hits.length, 1); near(h.player.health, 97.6);
  assert.equal(h.controller.snapshot().touching, false);
  h.player.pos.x = -0.32;
  near(h.controller.update(0.05), 1);
  assert.equal(h.hits[1].feedback, true, 'A fresh contact has one immediate feedback cue');
  near(h.player.health, 96.6);
});

test('health remains exact while feedback is throttled and large steps never emit missed feedback bursts', () => {
  const h = fixture();
  run(h, 1);
  assert.equal(h.hits.length, 120);
  assert.equal(h.hits.filter(hit => hit.feedback).length, 4);
  assert.equal(h.controller.snapshot().feedbackCount, 4);
  near(h.player.health, 80);
  const calls = h.hits.length;
  h.controller.update(0.75);
  assert.equal(h.hits.length, calls + 1);
  assert.equal(h.hits.at(-1).feedback, true);
  near(h.player.health, 65);
});

test('pause and invalid dt freeze damage, contact state and feedback cooldowns', () => {
  const h = fixture();
  h.controller.update(0.1);
  const before = h.controller.snapshot(), health = h.player.health;
  h.gate.active = false;
  h.player.pos.x = -4;
  assert.equal(h.controller.update(90), 0);
  h.gate.active = true;
  for (const dt of [0, -1, NaN, Infinity, -Infinity, null, undefined, '1', {}, 1n]) assert.equal(h.controller.update(dt), 0);
  assert.deepEqual(h.controller.snapshot(), before);
  assert.equal(h.player.health, health); assert.equal(h.hits.length, 1);
  h.player.pos.x = -0.32;
  h.controller.update(0.1);
  assert.equal(h.hits.at(-1).feedback, false, 'Paused time cannot expire the cue cooldown');
  near(h.player.health, 96);
});

test('inactive, removed and malformed hazards cannot damage or leave a delayed burn', () => {
  const h = fixture();
  h.fire.active = false;
  h.fires.push(null, { active: true }, { active: true, damageBounds: box(1, 0, 0, 0, 1, 1) },
    { active: true, damageBounds: box(NaN, 0, 0, 1, 1, 1) });
  assert.equal(h.controller.update(0.25), 0);
  h.fire.active = true;
  near(h.controller.update(0.25), 5);
  h.fire.active = false;
  assert.equal(h.controller.update(1), 0);
  assert.equal(h.controller.snapshot().touching, false);
  h.fires.length = 0;
  assert.equal(h.controller.update(1), 0);
  assert.equal(h.hits.length, 1);
});

test('solid walls and floors shield contact margins even when a flame box protrudes across them', () => {
  const h = fixture();
  h.player.pos.x = -0.52;
  h.fire.damageBounds = box(-0.25, 0, -1, 1.5, 2, 1);
  h.colliders.push(box(-0.2, 0, -1, 0, 2.5, 1));
  assert.equal(h.controller.update(0.25), 0, 'The player touches the wall, not flame through its far side');
  h.colliders.length = 0;
  near(h.controller.update(0.25), 5);
  h.player.pos.x = 0;
  h.fire.damageBounds = box(-1, -1, -1, 1, 0.015, 1);
  h.colliders.push(box(-2, -0.2, -2, 2, 0, 2));
  assert.equal(h.controller.update(0.25), 0, 'A supporting slab blocks a flame just below the feet');
});

test('visual flame source above a wreck body permits contact while real cover stays protective', () => {
  const h = fixture();
  h.player.pos.x = -0.92;
  h.fire.damageBounds = box(-0.8, 0.84, -0.7, 0.8, 3.34, 0.7);
  h.fire.group = { position: { x: 0, y: 0.84, z: 0 } };
  h.fire.damageSource = { x: 0, y: 2.09, z: 0 };
  h.colliders.push(box(-0.6, 0, -1, 0.6, 0.915, 1));
  near(h.controller.update(0.25), 5, 'The hood origin is not used as the heat source');
  assert.deepEqual(h.hits[0].source, h.fire.damageSource);
  h.colliders.push(box(-0.6, 0, -1, -0.5, 3.5, 1));
  assert.equal(h.controller.update(0.25), 0, 'An actual full-height screen still shields the same flame');
});

test('all fire-owned blockers are ignored for heat shielding, with no overlapping damage multiplier', () => {
  const h = fixture();
  h.fire.collider = h.fire.damageBounds;
  const second = { active: true, damageBounds: box(-0.1, 0, -0.5, 1, 2, 0.5) };
  second.collider = second.damageBounds;
  h.fires.push(second); h.colliders.push(h.fire.collider, second.collider);
  near(h.controller.update(0.25), 5);
  assert.equal(h.hits.length, 1);
});

test('optional collider enablement follows live geometry changes without stale shielding', () => {
  const enabled = new Set(), h = fixture({ isColliderEnabled: collider => enabled.has(collider) });
  const screen = box(-0.2, 0, -1, -0.1, 3, 1);
  h.colliders.push(screen); enabled.add(screen);
  assert.equal(h.controller.update(0.25), 0);
  enabled.delete(screen);
  near(h.controller.update(0.25), 5);
  enabled.add(screen);
  assert.equal(h.controller.update(0.25), 0);
});

test('lethal exposure is capped at remaining health and reset clears only hazard-owned state', () => {
  const h = fixture();
  h.player.health = 3;
  near(h.controller.update(1), 3);
  assert.equal(h.player.health, 0);
  assert.equal(h.controller.update(1), 0);
  assert.equal(h.hits.length, 1);
  h.controller.reset();
  assert.deepEqual(h.controller.snapshot(), { touching: false, contactSeconds: 0, damageRequested: 0, feedbackCount: 0 });
  assert.equal(h.player.health, 0); assert.equal(h.player.armor, 80);
  h.player.health = 100;
  near(h.controller.update(0.1), 2);
  assert.equal(h.hits.at(-1).feedback, true);
});

test('damage, cue interval and contact margin are tunable without changing capsule shape', () => {
  const h = fixture({ damagePerSecond: 10, feedbackInterval: 0.5, contactSkin: 0 });
  h.player.pos.x = -0.321;
  assert.equal(h.controller.update(0.25), 0);
  h.player.pos.x = -0.32;
  run(h, 1);
  near(h.player.health, 90);
  assert.equal(h.hits.filter(hit => hit.feedback).length, 2);
  const harmless = fixture({ damagePerSecond: 0 });
  assert.equal(harmless.controller.update(1), 0); assert.equal(harmless.player.health, 100);
});
