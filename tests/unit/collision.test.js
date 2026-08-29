import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Ray, Vector3 } from 'three';
import { STAIRS } from '../../src/world/stair-layout.js';
import {
  Colliders, resolveSphereAABB, resolveCapsuleAABB,
  capsuleHasClearance, findStepUp, moveCapsule,
} from '../../src/core/collision.js';

const box = (x1, y1, z1, x2, y2, z2) => new Box3(new Vector3(x1, y1, z1), new Vector3(x2, y2, z2));
const floor = () => box(-20, -0.2, -20, 20, 0, 20);
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
function body(x = 0, y = 0, z = 0) {
  return { position: new Vector3(x, y, z), velocity: new Vector3(), radius: 0.32, height: 1.84, onGround: true };
}

test('sphere contact returns an outward normal and penetration depth', () => {
  const hit = resolveSphereAABB(new Vector3(-0.2, 0.5, 0.5), 0.32, box(0, 0, 0, 1, 1, 1));
  assert.deepEqual(hit.normal.toArray(), [-1, 0, 0]);
  near(hit.depth, 0.12);
});

test('tangent and separated spheres do not create a collision', () => {
  const obstacle = box(0, 0, 0, 1, 1, 1);
  assert.equal(resolveSphereAABB(new Vector3(-0.32, 0.5, 0.5), 0.32, obstacle), null);
  assert.equal(resolveSphereAABB(new Vector3(-2, 0.5, 0.5), 0.32, obstacle), null);
  assert.equal(resolveSphereAABB(new Vector3(0.5, 0.5, 0.5), 0, obstacle), null);
});

test('sphere inside a box is moved through its nearest face', () => {
  const hit = resolveSphereAABB(new Vector3(0.1, 0.5, 0.5), 0.32, box(0, 0, 0, 1, 1, 1));
  assert.deepEqual(hit.normal.toArray(), [-1, 0, 0]);
  near(hit.depth, 0.42);
});

test('callers can retain collision results without sharing the pooled output', () => {
  const output = { normal: new Vector3(), depth: 0 };
  const obstacle = box(0, 0, 0, 1, 1, 1);
  const retained = resolveSphereAABB(new Vector3(-0.2, 0.5, 0.5), 0.32, obstacle, output);
  resolveSphereAABB(new Vector3(1.2, 0.5, 0.5), 0.32, obstacle);
  assert.equal(retained, output);
  assert.deepEqual(retained.normal.toArray(), [-1, 0, 0]);
});

test('vertical capsule catches a thin obstacle between its end spheres', () => {
  const bottom = new Vector3(0, 0.32, 0);
  const top = new Vector3(0, 1.52, 0);
  const rail = box(0.2, 0.82, -1, 1, 1.02, 1);
  assert.equal(resolveSphereAABB(bottom, 0.32, rail), null);
  assert.equal(resolveSphereAABB(top, 0.32, rail), null);
  const hit = resolveCapsuleAABB(bottom, top, 0.32, rail);
  assert.deepEqual(hit.normal.toArray(), [-1, 0, 0]);
  near(hit.depth, 0.12);
  assert.deepEqual(bottom.toArray(), [0, 0.32, 0]);
  assert.deepEqual(top.toArray(), [0, 1.52, 0]);
});

test('capsule separation clears its whole height when intersecting a slab', () => {
  const hit = resolveCapsuleAABB(new Vector3(0, 0.32, 0), new Vector3(0, 1.52, 0), 0.32, box(-4, 0.9, -4, 4, 1, 4));
  assert.deepEqual(hit.normal.toArray(), [0, -1, 0]);
  near(hit.depth, 0.94);
});

test('capsule head and feet resolve ceilings and floors', () => {
  let hit = resolveCapsuleAABB(new Vector3(0, 0.30, 0), new Vector3(0, 1.50, 0), 0.32, floor());
  assert.deepEqual(hit.normal.toArray(), [0, 1, 0]);
  near(hit.depth, 0.02);
  hit = resolveCapsuleAABB(new Vector3(0, 0.32, 0), new Vector3(0, 1.52, 0), 0.32, box(-4, 1.8, -4, 4, 2.1, 4));
  assert.deepEqual(hit.normal.toArray(), [0, -1, 0]);
  near(hit.depth, 0.04);
});

test('standing clearance rejects a low beam while preserving crouch clearance', () => {
  const feet = new Vector3(0, 0, 0);
  const geometry = [floor(), box(-2, 1.3, -2, 2, 1.5, 2)];
  assert.equal(capsuleHasClearance(feet, 0.32, 1.22, geometry), true);
  assert.equal(capsuleHasClearance(feet, 0.32, 1.84, geometry), false);
  assert.deepEqual(feet.toArray(), [0, 0, 0]);
});

test('auto-step accepts a 0.30 m riser but rejects taller single faces', () => {
  const feet = new Vector3(-0.1, 0, 0);
  near(findStepUp(feet, 0.32, 1.84, [floor(), box(0, 0, -1, 1, 0.30, 1)]), 0.30);
  assert.equal(findStepUp(feet, 0.32, 1.84, [floor(), box(0, 0, -1, 1, 0.301, 1)]), null);
});

test('auto-step clears a chain of low treads under an overlapping landing', () => {
  const feet = new Vector3(-0.1, 0, 0);
  const geometry = [floor(), box(0, 0, -1, 1, 0.24, 1), box(0.05, 0.38, -1, 1, 0.48, 1)];
  near(findStepUp(feet, 0.32, 1.84, geometry), 0.48);
});

test('auto-step rejects low ceilings and obstacles at torso height', () => {
  const feet = new Vector3(-0.1, 0, 0);
  const tread = box(0, 0, -1, 1, 0.24, 1);
  assert.equal(findStepUp(feet, 0.32, 1.84, [floor(), tread, box(-2, 1.95, -2, 2, 2.2, 2)]), null);
  assert.equal(findStepUp(feet, 0.32, 1.84, [floor(), tread, box(0, 0.92, -1, 1, 1.04, 1)]), null);
});

test('movement resolves corner contacts using fresh capsule endpoints', () => {
  const player = body(-0.1, -0.01, -0.1);
  player.velocity.set(3, -1, 3);
  const geometry = [floor(), box(0, 0, -4, 4, 3, 4), box(-4, 0, 0, 4, 3, 4)];
  moveCapsule(player, 1 / 120, geometry);
  near(player.position.x, -0.32);
  near(player.position.z, -0.32);
  near(player.position.y, 0);
  assert.equal(capsuleHasClearance(player.position, player.radius, player.height, geometry), true);
  assert.equal(player.onGround, true);
});

test('flush slab edges never turn horizontal motion into an upward bounce', () => {
  for (const axis of ['x', 'z']) for (const sign of [-1, 1]) for (const reverse of [false, true]) {
    const geometry = [box(-5, 13.8, -5, 0, 14, 5), box(0, 13.8, -5, 0.3, 14, 5), box(0.3, 13.8, -5, 5, 14, 5)];
    if (axis === 'z') for (const slab of geometry) {
      [slab.min.x, slab.min.z] = [slab.min.z, slab.min.x];
      [slab.max.x, slab.max.z] = [slab.max.z, slab.max.x];
    }
    if (reverse) geometry.reverse();
    const player = body(0, 14, 0);
    player.position[axis] = -sign * 1.5;
    const dt = 1 / 120;
    for (let tick = 0; tick < 90; tick++) {
      player.velocity[axis] = sign * 4.2;
      player.velocity.y -= 22 * dt;
      moveCapsule(player, dt, geometry, true);
      near(player.position.y, 14);
      near(player.velocity.y, 0);
      near(player.velocity[axis], sign * 4.2);
      near(player.stepped, 0);
      assert.equal(player.onGround, true, `${axis}, direction ${sign}, reversed ${reverse}`);
    }
    assert.ok(sign * player.position[axis] > 1.5);
  }
});

test('floor-first contact preserves jumping and cannot bridge an unsupported gap', () => {
  const jumping = body();
  jumping.velocity.y = 4;
  moveCapsule(jumping, 1 / 30, [floor()], true);
  near(jumping.position.y, 4 / 30);
  near(jumping.velocity.y, 4);
  assert.equal(jumping.onGround, false);

  const gap = [box(-5, -0.2, -2, 0, 0, 2), box(1, -0.2, -2, 5, 0, 2)];
  const falling = body(0.5, 0, 0);
  for (let tick = 0; tick < 30; tick++) {
    falling.velocity.y -= 22 / 120;
    moveCapsule(falling, 1 / 120, gap, true);
    assert.equal(falling.onGround, false);
    near(falling.stepped, 0);
  }
  assert.ok(falling.position.y < -0.6);
});

test('floor-first contact does not climb a tall face or snap to an uncrossed floor', () => {
  const player = body(-0.6, 0, 0), geometry = [floor(), box(0, 0, -2, 1, 0.8, 2)];
  for (let tick = 0; tick < 60; tick++) {
    player.velocity.set(4.2, -22 / 120, 0);
    moveCapsule(player, 1 / 120, geometry, true);
    near(player.position.y, 0);
    near(player.stepped, 0);
    assert.ok(player.position.x <= -player.radius + 1e-6);
  }
  const falling = body(0, 0.6, 0);
  falling.onGround = false; falling.velocity.y = -1;
  moveCapsule(falling, 1 / 30, [box(-2, 0, -2, 2, 0.3, 2)]);
  near(falling.position.y, 0.6 - 1 / 30);
  near(falling.velocity.y, -1);
  assert.equal(falling.onGround, false);
});

test('a successful step retains toe support before the body centre reaches the tread', () => {
  for (const rise of [2.4 / 14, 2.6 / 14, 0.3]) for (const dt of [1 / 30, 1 / 120, 1 / 240]) {
    const geometry = [floor(), box(0, 0, -1, 1, rise, 1)];
    const player = body(-0.27, 0, 0);
    player.velocity.set(0.4, -22 * dt, 0);
    moveCapsule(player, dt, geometry, true);
    assert.ok(player.stepped >= rise);
    assert.ok(player.position.x < 0, 'The toe reaches the step before the centre does');
    assert.equal(player.onGround, true);
    const x = player.position.x;
    for (let tick = 0; tick < Math.ceil(1 / dt); tick++) {
      player.velocity.set(0, player.velocity.y - 22 * dt, 0);
      moveCapsule(player, dt, geometry, false);
      near(player.position.x, x);
      near(player.position.y, rise);
      near(player.velocity.y, 0);
      near(player.stepped, 0);
      assert.equal(player.onGround, true, 'Releasing movement must not fall back off a completed step');
      assert.ok(capsuleHasClearance(player.position, player.radius, player.height, geometry));
    }
  }
});

test('slow and fast ascent keep ground contact without converting walking into upward velocity', () => {
  const rise = 2.6 / 14, depth = 0.3, count = 14;
  for (const sign of [-1, 1]) for (const speed of [0.35, 0.84, 4.2, 7]) for (const dt of [1 / 30, 1 / 120, 1 / 240]) {
    const geometry = [floor()];
    for (let index = 0; index < count; index++) {
      const a = sign * index * depth, b = sign * (index + 1) * depth;
      geometry.push(box(Math.min(a, b), 0, -1, Math.max(a, b), (index + 1) * rise, 1));
    }
    const target = count * depth - 0.15;
    const player = body(-sign * 0.7, 0, 0);
    const ticks = Math.ceil(((target + 0.7) / speed + 1) / dt);
    for (let tick = 0; tick < ticks && sign * player.position.x < target; tick++) {
      const before = player.position.clone();
      const blend = 1 - Math.exp(-(player.onGround ? 20 : 4) * dt);
      player.velocity.x += (sign * speed - player.velocity.x) * blend;
      player.velocity.y -= 22 * dt;
      moveCapsule(player, dt, geometry, true);
      assert.equal(player.onGround, true, `Lost support at ${player.position.toArray()}, speed=${speed}, dt=${dt}`);
      assert.ok(sign * (player.position.x - before.x) >= -1e-9, 'A tread must not push the player backward');
      assert.ok(player.position.y >= before.y - 0.00101, 'Only the 1 mm collision skin may settle downward');
      near(player.velocity.y, 0);
      assert.ok(capsuleHasClearance(player.position, player.radius, player.height, geometry, 1e-7));
    }
    assert.ok(sign * player.position.x >= target, `Complete the ascent at speed=${speed}, dt=${dt}`);
    near(player.position.y, count * rise, 0.00101);
  }
});

test('ground support uses a circle, not a padded rectangle or a tangent point', () => {
  const platform = box(0, 0, 0, 1, 0.2, 1);
  for (const [x, z] of [[-0.24, -0.24], [-0.32, 0.5], [0.5, 1.32]]) {
    const player = body(x, 0.2, z);
    player.velocity.y = -22 / 120;
    moveCapsule(player, 1 / 120, [platform], true);
    assert.equal(player.onGround, false, `No supported footprint at ${x}, ${z}`);
    assert.ok(player.position.y < 0.2);
    near(player.stepped, 0);
  }
});

test('an airborne body beside a ledge cannot acquire the grounded footprint snap', () => {
  const geometry = [box(0, 0, 0, 1, 0.2, 1)];
  const falling = body(-0.28, 0.201, 0.5);
  falling.onGround = false; falling.velocity.y = -1;
  moveCapsule(falling, 1 / 120, geometry, true);
  near(falling.position.y, 0.201 - 1 / 120);
  near(falling.velocity.y, -1);
  near(falling.stepped, 0);
  assert.equal(falling.onGround, false);

  const jumping = body(-0.28, 0.2, 0.5);
  jumping.velocity.y = 5.6;
  moveCapsule(jumping, 1 / 120, geometry, true);
  near(jumping.position.y, 0.2 + 5.6 / 120);
  near(jumping.velocity.y, 5.6);
  assert.equal(jumping.onGround, false);
});

test('retained toe support releases as soon as the footprint leaves the ledge', () => {
  const geometry = [box(0, 0, -1, 1, 0.2, 1)];
  const player = body(-0.3, 0.2, 0);
  player.velocity.set(-4.2, -22 / 120, 0);
  moveCapsule(player, 1 / 120, geometry, true);
  assert.ok(player.position.x < -player.radius);
  assert.ok(player.position.y < 0.2);
  assert.ok(player.velocity.y < 0);
  assert.equal(player.onGround, false);
  near(player.stepped, 0);
});

test('fast movement cannot tunnel through a thin torso obstacle', () => {
  const player = body(-0.6, 0, 0);
  player.velocity.set(100, -1, 0);
  moveCapsule(player, 1 / 30, [floor(), box(0, 0.82, -2, 0.02, 1.02, 2)]);
  near(player.position.x, -0.32);
  near(player.velocity.x, 0);
});

test('extreme downward travel is bounded and stops at a thin floor', () => {
  const player = body(0, 0.7, 0);
  player.onGround = false;
  player.velocity.y = -1000;
  moveCapsule(player, 10, [box(-5, -0.02, -5, 5, 0, 5)]);
  near(player.position.y, 0);
  near(player.velocity.y, 0);
  assert.equal(player.onGround, true);
});

test('invalid elapsed time cannot corrupt a body', () => {
  const player = body(1, 2, 3);
  player.velocity.set(5, 5, 5);
  for (const dt of [0, -1, NaN, Infinity]) moveCapsule(player, dt, []);
  assert.deepEqual(player.position.toArray(), [1, 2, 3]);
  assert.deepEqual(player.velocity.toArray(), [5, 5, 5]);
});

test('airborne motion never invokes automatic stair climbing', () => {
  const player = body(-0.4, 0.01, 0);
  player.onGround = false;
  player.velocity.set(2, 3, 0);
  moveCapsule(player, 1 / 30, [floor(), box(0, 0, -1, 1, 0.24, 1)], true);
  near(player.stepped, 0);
});

test('all four authored switchback flights remain walkable with a continuous capsule', () => {
  // Solver-only coverage follows the shared authored surfaces. The dedicated
  // stair-layout suite additionally builds the real shell, guards and fittings.
  const geometry = [];
  for (const landing of STAIRS.landings) {
    geometry.push(box(landing.x1, landing.y - landing.thickness, landing.z1,
      landing.x2, landing.y, landing.z2));
  }
  for (const flight of STAIRS.flights) {
    for (const tread of flight.treads) {
      geometry.push(box(tread.x1, tread.bottomY, tread.z1, tread.x2, tread.topY, tread.z2));
    }
  }

  const player = body(...STAIRS.route[0]);
  const dt = 1 / 120;
  for (const [targetX, targetY, targetZ] of STAIRS.route.slice(1)) {
    for (let tick = 0; tick < 1000; tick++) {
      const dx = targetX - player.position.x;
      const dz = targetZ - player.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.03) break;
      const speed = Math.min(4.2, distance / dt);
      player.velocity.x = dx / distance * speed;
      player.velocity.z = dz / distance * speed;
      player.velocity.y -= 22 * dt;
      moveCapsule(player, dt, geometry, true);
    }
    near(player.position.x, targetX, 0.03);
    near(player.position.z, targetZ, 0.03);
    near(player.position.y, targetY, 0.03);
    assert.equal(player.onGround, true);
    assert.equal(capsuleHasClearance(player.position, player.radius, player.height, geometry), true);
  }
});

test('static collider registration clones supplied bounds', () => {
  Colliders.clear();
  const min = new Vector3(0, 0, 0);
  const max = new Vector3(1, 1, 1);
  const registered = Colliders.addBox(min, max);
  min.set(-5, -5, -5);
  max.set(5, 5, 5);
  assert.deepEqual(registered.min.toArray(), [0, 0, 0]);
  assert.deepEqual(registered.max.toArray(), [1, 1, 1]);
  Colliders.clear();
  assert.equal(Colliders.list.length, 0);
});

test('enabling cached gate colliders is idempotent and preserves their bounds', () => {
  Colliders.clear();
  const queryList = Colliders.list;
  const floorCollider = Colliders.addBoxBySize(0, -0.1, 0, 20, 0.2, 20);
  const gate = Colliders.addBoxBySize(-3, 4.95, -6, 1.8, 1.9, 1.8);
  const originalBounds = { min: gate.min.toArray(), max: gate.max.toArray() };
  for (let campaign = 0; campaign < 25; campaign++) {
    assert.equal(Colliders.setEnabled(gate, false), true);
    assert.equal(Colliders.setEnabled(gate, false), true);
    assert.equal(Colliders.isEnabled(gate), false);
    assert.deepEqual(Colliders.list, [floorCollider]);
    assert.equal(Colliders.setEnabled(gate, true), true);
    assert.equal(Colliders.setEnabled(gate, true), true);
    assert.equal(Colliders.isEnabled(gate), true);
    assert.equal(Colliders.list.length, 2);
    assert.equal(Colliders.list[1], gate);
  }
  assert.equal(Colliders.list, queryList, 'query consumers retain the same array');
  assert.deepEqual({ min: gate.min.toArray(), max: gate.max.toArray() }, originalBounds);
  Colliders.clear();
});

test('disabled gates stop blocking both player clearance and projectile rays', () => {
  Colliders.clear();
  const gate = Colliders.addBoxBySize(0, 0.95, 0, 1.8, 1.9, 1.8);
  const feet = new Vector3(0, 0, 0);
  const ray = new Ray(new Vector3(-4, 1, 0), new Vector3(1, 0, 0));
  const hit = new Vector3();
  const rayBlocked = () => Colliders.list.some(collider => ray.intersectBox(collider, hit) !== null);
  assert.equal(capsuleHasClearance(feet, 0.32, 1.84, Colliders.list), false);
  assert.equal(rayBlocked(), true);
  Colliders.setEnabled(gate, false);
  assert.equal(capsuleHasClearance(feet, 0.32, 1.84, Colliders.list), true);
  assert.equal(rayBlocked(), false);
  Colliders.setEnabled(gate, true);
  assert.equal(capsuleHasClearance(feet, 0.32, 1.84, Colliders.list), false);
  assert.equal(rayBlocked(), true);
  Colliders.clear();
});

test('separate gate colliders toggle independently without disturbing static geometry', () => {
  Colliders.clear();
  const staticFloor = Colliders.addBoxBySize(0, -0.1, 0, 20, 0.2, 20);
  const fire = Colliders.addBoxBySize(-3, 4.95, -6, 1.8, 1.9, 1.8);
  const debris = Colliders.addBoxBySize(-3, 4.15, -6, 0.6, 0.3, 2.6);
  Colliders.setEnabled(fire, false);
  assert.deepEqual(Colliders.list, [staticFloor, debris]);
  Colliders.setEnabled(debris, false);
  assert.deepEqual(Colliders.list, [staticFloor]);
  Colliders.setEnabled(fire, true);
  Colliders.setEnabled(debris, true);
  assert.deepEqual(Colliders.list, [staticFloor, fire, debris]);
  Colliders.clear();
});

test('clearing the registry prevents stale or unknown boxes from being re-enabled', () => {
  Colliders.clear();
  const disabled = Colliders.addBoxBySize(0, 1, 0, 2, 2, 2);
  const enabled = Colliders.addBoxBySize(3, 1, 0, 2, 2, 2);
  Colliders.setEnabled(disabled, false);
  Colliders.clear();
  assert.equal(Colliders.setEnabled(disabled, true), false);
  assert.equal(Colliders.setEnabled(enabled, true), false);
  assert.equal(Colliders.setEnabled(box(0, 0, 0, 1, 1, 1), true), false);
  assert.equal(Colliders.setEnabled(null, false), false);
  assert.equal(Colliders.isEnabled(disabled), false);
  assert.equal(Colliders.list.length, 0);
});

test('mesh-derived colliders support the same reusable enable lifecycle', () => {
  Colliders.clear();
  const geometry = new BoxGeometry(2, 2, 2);
  const material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.position.set(3, 4, 5);
  const collider = Colliders.addFromMesh(mesh, 0.1);
  Colliders.setEnabled(collider, false);
  assert.equal(Colliders.list.length, 0);
  assert.equal(Colliders.setEnabled(collider, true), true);
  assert.equal(Colliders.list[0], collider);
  assert.deepEqual(collider.min.toArray(), [1.9, 2.9, 3.9]);
  assert.deepEqual(collider.max.toArray(), [4.1, 5.1, 6.1]);
  Colliders.clear();
  geometry.dispose();
  material.dispose();
});
