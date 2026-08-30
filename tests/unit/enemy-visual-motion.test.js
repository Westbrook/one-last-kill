import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOF } from '../../src/world/layout.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

let renderedPose = null, renderedDelta = null, poseCalls = 0;
const h = createEnemyAIHarness({ humanoids: {
  updateHumanoidPose(root, pose, dt) {
    renderedPose = pose; renderedDelta = dt; poseCalls++;
  },
} });
const near = (actual, expected, tolerance = 1e-9) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`,
);

function actor(yaw = 0) {
  h.reset({ x: 22, y: ROOF.floorY, z: -4 });
  const enemy = h.spawn('thug', { x: 20, y: ROOF.floorY, z: -4 }, { zone: 'roof' });
  enemy.staggerTime = 1; enemy.yaw = yaw;
  renderedPose = null; renderedDelta = null; poseCalls = 0;
  return enemy;
}

function withMovement(moveBody, run) {
  const original = h.EnemyNavigation.moveBody;
  h.EnemyNavigation.moveBody = moveBody;
  try { run(); } finally { h.EnemyNavigation.moveBody = original; }
}

test('a blocked or purely vertical movement cannot animate a horizontal stride from residual velocity', () => {
  for (const rise of [0, 0.25, -0.3]) {
    const enemy = actor(0.7), pose = enemy.poseInput;
    withMovement(body => {
      body.position.y += rise;
      // A movement solver can retain desired velocity after applying a
      // bounded movement/clearance policy. Presentation must use its result.
      body.velocity.set(2, -1, 3);
      return body;
    }, () => h.enemyTick(enemy, 1 / 60));
    assert.equal(renderedPose, pose, 'The existing per-enemy pose object is reused');
    near(renderedPose.speed, 0); near(renderedPose.forward, 1); near(renderedPose.strafe, 0);
    assert.deepEqual(enemy.vel.toArray(), [2, -1, 3], 'Visual measurement does not rewrite physics velocity');
    assert.ok(enemy.mesh.position.equals(enemy.pos));
  }
});

test('completed displacement drives forward, reverse and lateral poses independently of final velocity', () => {
  const speed = 3;
  for (const yaw of [-2.1, 0, 0.7]) {
    for (const direction of [[0, 1], [0, -1], [1, 0], [-0.6, 0.8]]) {
      for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
        const enemy = actor(yaw);
        const [strafe, forward] = direction;
        const worldX = Math.cos(yaw) * strafe + Math.sin(yaw) * forward;
        const worldZ = -Math.sin(yaw) * strafe + Math.cos(yaw) * forward;
        withMovement(body => {
          body.position.x += worldX * speed * dt;
          body.position.z += worldZ * speed * dt;
          body.velocity.set(0, -2, 0);
          return body;
        }, () => h.enemyTick(enemy, dt));
        near(renderedPose.speed, speed);
        near(renderedPose.forward, forward); near(renderedPose.strafe, strafe);
        near(Math.hypot(renderedPose.forward, renderedPose.strafe), 1);
        assert.equal(renderedDelta, dt);
        assert.deepEqual(enemy.vel.toArray(), [0, -2, 0]);
      }
    }
  }
});

test('real capsule movement remains unchanged while its completed travel feeds the pose', () => {
  for (const dt of [1 / 60, 0.25]) {
    const enemy = actor();
    enemy.staggerTime = 0;
    h.EnemyNavigation.setGeometry(h.colliders, 1);
    const original = h.EnemyNavigation.moveBody;
    let solverPosition = null, solverVelocity = null, traveled = 0;
    withMovement(function (body, delta) {
      const x = body.position.x, z = body.position.z;
      const result = original.call(this, body, delta);
      traveled = Math.hypot(body.position.x - x, body.position.z - z);
      solverPosition = body.position.clone(); solverVelocity = body.velocity.clone();
      return result;
    }, () => h.enemyTick(enemy, dt));
    assert.ok(traveled > 0, 'The fixture must exercise actual horizontal capsule movement');
    near(renderedPose.speed * renderedDelta, traveled);
    if (dt > 0.1) assert.ok(renderedPose.speed < Math.hypot(solverVelocity.x, solverVelocity.z),
      'A bounded physics step must not animate the full requested velocity');
    assert.ok(enemy.pos.equals(solverPosition), 'Pose measurement cannot move the capsule');
    assert.ok(enemy.vel.equals(solverVelocity), 'Pose measurement cannot alter collision response');
    assert.ok(enemy.mesh.position.equals(solverPosition));
  }
});

test('paused and invalid public simulation updates neither move actors nor change their pose input', () => {
  const enemy = actor(), position = enemy.pos.clone(), velocity = enemy.vel.clone();
  const pose = { ...enemy.poseInput };
  for (const dt of [0, -1, NaN, Infinity]) h.enemiesUpdate(dt);
  assert.equal(poseCalls, 0);
  assert.deepEqual({ ...enemy.poseInput }, pose);
  assert.ok(enemy.pos.equals(position)); assert.ok(enemy.vel.equals(velocity));
});
