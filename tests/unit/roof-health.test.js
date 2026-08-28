import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HEALTH_SUPPLIES, ROOF_HEALTH_ROUTES } from '../../src/game/health-supply-data.js';
import { ROOF, BALCONY, OPENINGS } from '../../src/world/layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { Colliders, capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { createAmmoSupplies } from '../../src/game/ammo-supplies.js';
import { resolveSurfaceOwnership } from '../../src/world/surface-ownership.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';
import { createHealthPickupHarness } from './helpers/health-pickup-harness.js';

const fixture = buildWorldSurfaceFixture();
// Supplies are real solid floor cases and must participate in route clearance.
const ammo = createAmmoSupplies();
ammo.init({ world: fixture.World, player: { pos: new THREE.Vector3(), _eyeH: 1.72 }, canInteract: () => false });
resolveSurfaceOwnership(fixture.records.values());
fixture.ballistics.rebuild(fixture.World);
const supplies = new Map(HEALTH_SUPPLIES.map(value => [value.id, value]));
const roofSupplies = HEALTH_SUPPLIES.filter(value => value.zone === 'roof');
const vector = value => Array.isArray(value) ? new THREE.Vector3(...value) : new THREE.Vector3(value.x, value.y, value.z);
const near = (actual, expected, label, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);

function floorAt(x, z) {
  const hit = fixture.ballistics.raycast(new THREE.Vector3(x, ROOF.floorY + 0.1, z), new THREE.Vector3(0, -1, 0), 0.3);
  return hit ? { y: hit.point.y, normalY: hit.normal.y, object: hit.object } : null;
}

function collisionFloorAt(x, z) {
  let top = -Infinity;
  for (const box of Colliders.list) {
    if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z && box.max.y <= ROOF.floorY + 0.03) {
      top = Math.max(top, box.max.y);
    }
  }
  return top;
}

function roofPickupHarness() {
  const harness = createHealthPickupHarness();
  for (const supply of roofSupplies) {
    harness.HealPickups.spawn(supply.x, supply.y, supply.z, supply.amount, supply.zone, supply.id);
  }
  harness.HealPickups.setZone('roof');
  return harness;
}

function walk(route, { radius = 0.48, height = 2.02, harness = null, reverse = false } = {}) {
  const points = reverse ? [...route.waypoints].reverse() : route.waypoints;
  const body = { position: vector(points[0]), velocity: new THREE.Vector3(), radius, height, onGround: true };
  let travel = 0, frames = 0, lowest = Infinity, highest = -Infinity;
  const delta = 1 / 120, before = new THREE.Vector3();
  for (let index = 1; index < points.length; index++) {
    const target = vector(points[index]);
    const budget = Math.ceil(body.position.distanceTo(target) / 4.2 / delta) + 120;
    for (let frame = 0; frame < budget; frame++) {
      const dx = target.x - body.position.x, dz = target.z - body.position.z, distance = Math.hypot(dx, dz);
      if (distance < 0.025 && Math.abs(body.position.y - target.y) < 0.025) break;
      const speed = Math.min(4.2, distance / delta);
      body.velocity.set(dx / (distance || 1) * speed, body.velocity.y - 22 * delta, dz / (distance || 1) * speed);
      before.copy(body.position); moveCapsule(body, delta, Colliders.list, true);
      travel += before.distanceTo(body.position); frames++;
      lowest = Math.min(lowest, body.position.y); highest = Math.max(highest, body.position.y);
      assert.equal(body.onGround, true, `${route.id}: continuous floor at ${body.position.toArray()}`);
      near(body.velocity.y, 0, `${route.id}: no jump or artificial vertical boost`);
      if (harness) {
        harness.Player.pos.copy(body.position); harness.Player.pos.y += harness.Player._eyeH;
        harness.GameTime.elapsed += delta;
        harness.HealPickups.update(delta);
      }
    }
    assert.ok(body.position.distanceTo(target) < 0.04, `${route.id} stopped before ${target.toArray()} at ${body.position.toArray()}`);
  }
  near(lowest, ROOF.floorY, 'lowest route foot'); near(highest, ROOF.floorY, 'highest route foot');
  return { body, travel, frames };
}

test('named fixed supplies preserve the original thirteen records and give each rooftop route a finite 60 HP', () => {
  const original = [
    ['apartment', -10, 4, -4, 25], ['neighbor', 3, 4, -7, 25],
    ['balcony', 11.5, 4, -3.5, 25], ['balcony', -18, 4, BALCONY.laneZ, 25],
    ['stairwell', -16.55, 6.4, -0.85, 30], ['roof', 13, 14, -5, 30], ['roof', -10, 14, -5, 30],
    ['scaffolding', 15.5, 7, 4.2, 25], ['scaffolding', 18, 1.5, 5.2, 25],
    ['street', 0, 0.05, 14, 35], ['street', 29, 0.05, 16, 35],
    ['bakery', -22.5, 0.08, 33.1, 35], ['bakery', -22.6, 0.08, 39.4, 35],
  ];
  assert.deepEqual(HEALTH_SUPPLIES.slice(0, original.length).map(({ zone, x, y, z, amount }) => [zone, x, y, z, amount]), original);
  assert.equal(HEALTH_SUPPLIES.length, 15); assert.equal(supplies.size, HEALTH_SUPPLIES.length);
  assert.ok(Object.isFrozen(HEALTH_SUPPLIES)); assert.ok(Object.isFrozen(ROOF_HEALTH_ROUTES));
  for (const supply of HEALTH_SUPPLIES) {
    assert.ok(Object.isFrozen(supply)); assert.ok(supply.id && supply.zone);
    assert.ok([supply.x, supply.y, supply.z, supply.amount].every(Number.isFinite));
    assert.ok(Number.isInteger(supply.amount) && supply.amount > 0 && supply.amount <= 35);
  }
  const declared = new Set();
  for (const route of Object.values(ROOF_HEALTH_ROUTES)) {
    assert.ok(Object.isFrozen(route) && Object.isFrozen(route.waypoints) && Object.isFrozen(route.supplyIds));
    assert.equal(route.supplyIds.length, 2);
    assert.equal(route.supplyIds.reduce((total, id) => total + supplies.get(id).amount, 0), 60);
    for (const id of route.supplyIds) {
      assert.equal(supplies.get(id).zone, 'roof'); assert.equal(supplies.get(id).route, route.id);
      assert.equal(declared.has(id), false); declared.add(id);
    }
    for (const point of route.waypoints) assert.ok(Object.isFrozen(point));
  }
  assert.deepEqual([...declared].sort(), roofSupplies.map(value => value.id).sort());
});

test('new north supplies occupy the supported west link and the lane beyond the mechanical house', () => {
  const west = supplies.get('roof-north-west'), east = supplies.get('roof-north-east');
  near(west.x, (ROOF.x1 + ROOF.lightwell.x1) / 2, 'west-link centre');
  assert.ok(west.z > ROOF.lightwell.z1 && west.z < ROOF.lightwell.z2);
  assert.ok(east.x > ROOF.serviceHouse.x2 + 0.48 && east.z < ROOF.serviceHouse.z1 - 0.48);
  const westDeck = fixture.records.get('roof-annex-west-link-deck').bounds;
  const northDeck = fixture.records.get('roof-annex-north-deck').bounds;
  assert.ok(westDeck.containsPoint(vector(west).add(new THREE.Vector3(0, -0.01, 0))));
  assert.ok(northDeck.containsPoint(vector(east).add(new THREE.Vector3(0, -0.01, 0))));
  assert.ok(ROOF_HEALTH_ROUTES.north.label.includes('lightwell') && ROOF_HEALTH_ROUTES.north.label.includes('mechanical house'));
  assert.ok(ROOF_HEALTH_ROUTES.front.label.includes('water tank'));
});

test('every rooftop pack and eight nearby standing approaches have real floor, full body clearance and an open pickup line', () => {
  for (const supply of roofSupplies) {
    for (const dx of [-0.2, 0, 0.2]) for (const dz of [-0.2, 0, 0.2]) {
      const floor = floorAt(supply.x + dx, supply.z + dz);
      assert.ok(floor, `${supply.id}: support under the complete rotating pack footprint`);
      near(floor.y, ROOF.floorY, supply.id); near(floor.normalY, 1, `${supply.id}: upward support`);
    }
    for (let sample = 0; sample < 8; sample++) {
      const angle = sample * Math.PI / 4;
      const foot = vector(supply).add(new THREE.Vector3(Math.cos(angle) * 0.55, 0.03, Math.sin(angle) * 0.55));
      assert.ok(capsuleHasClearance(foot, 0.48, 2.02, Colliders.list), `${supply.id}: approach ${sample}`);
      near(collisionFloorAt(foot.x, foot.z), ROOF.floorY, `${supply.id}: exact standing support`);
      const finish = floorAt(foot.x, foot.z);
      // The outer approach enters the authored 1.5cm gravel finish. The
      // supporting deck/collider remains at 14m; the finish is not a step.
      assert.ok(finish && finish.y >= ROOF.floorY - 1e-5 && finish.y <= ROOF.floorY + 0.01501,
        `${supply.id}: visible deck or gravel finish over the same support`);
      near(finish.normalY, 1, `${supply.id}: upward walking finish`);
      const playerCenter = foot.clone(); playerCenter.y += 0.5;
      for (const bob of [-0.04, 0.04]) {
        const pack = vector(supply); pack.y += 0.18 + bob;
        assert.ok(playerCenter.distanceTo(pack) < 0.9, `${supply.id}: actual automatic pickup distance`);
        assert.equal(fixture.ballistics.segmentOccluded(playerCenter, pack, 'bullet'), false,
          `${supply.id}: collection never requires reaching through geometry`);
      }
    }
  }
});

test('the actual rotating and bobbing health models stay above support and outside solid world geometry', () => {
  const { HealPickups, GameTime, Player } = roofPickupHarness(); Player.health = 100;
  for (let pose = 0; pose < 32; pose++) {
    GameTime.elapsed = pose * 0.31;
    for (const pickup of HealPickups.list) pickup.mesh.rotation.y = pose * Math.PI / 8;
    HealPickups.update(1 / 120);
    for (const pickup of HealPickups.list) {
      const bounds = new THREE.Box3().setFromObject(pickup.mesh);
      assert.ok(bounds.min.y >= ROOF.floorY + 0.099 && bounds.max.y <= ROOF.floorY + 0.273,
        `${pickup.id}: authored hover and red cross remain above the deck`);
      assert.ok(!Colliders.list.some(box => box.intersectsBox(bounds)), `${pickup.id}: visible model is not buried in a wall or prop`);
      assert.equal(pickup.active, true, 'visual updates cannot spend a pack at full health');
    }
  }
});

test('straight out of the stair door means east, and turning left means the supported north crossing', () => {
  const forwardView = ROOF_HEALTH_ROUTES.front.views[0], leftView = ROOF_HEALTH_ROUTES.north.views[0];
  const camera = new THREE.PerspectiveCamera(), direction = new THREE.Vector3();
  camera.rotation.set(0, forwardView.yaw, 0, 'YXZ'); camera.getWorldDirection(direction);
  near(direction.x, 1, 'east from stair door'); near(direction.z, 0, 'east tangent');
  camera.rotation.set(0, leftView.yaw, 0, 'YXZ'); camera.getWorldDirection(direction);
  near(direction.x, 0, 'north tangent'); near(direction.z, -1, 'left/north');
  assert.deepEqual(leftView.from, STAIRS.roofExit);
  assert.equal(supplies.get(leftView.supplyIds[0]).route, 'north');
});

test('each route exposes its fixed supplies from its physical approaches across supported FOVs and camera heights', () => {
  for (const route of Object.values(ROOF_HEALTH_ROUTES)) for (const view of route.views) {
    for (const eyeHeight of [1.10, 1.72]) for (const fov of [70, 82, 100]) for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      const camera = new THREE.PerspectiveCamera(fov, aspect, 0.05, 500);
      camera.position.fromArray(view.from); camera.position.y += eyeHeight;
      camera.rotation.set(0, view.yaw, 0, 'YXZ'); camera.updateMatrixWorld(true);
      for (const id of view.supplyIds) {
        const supply = supplies.get(id);
        // The complete pack fits in a 0.3m horizontal envelope at every yaw.
        for (const dx of [-0.15, 0.15]) for (const dy of [0.10, 0.273]) for (const dz of [-0.15, 0.15]) {
          const target = vector(supply).add(new THREE.Vector3(dx, dy, dz));
          const projected = target.clone().project(camera);
          assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && projected.z > -1 && projected.z < 1,
            `${view.id} / ${id}: entire pack in ${fov}deg ${aspect.toFixed(2)} view`);
          assert.equal(fixture.ballistics.segmentOccluded(camera.position, target), false,
            `${view.id} / ${id}: no parapet, lightwell, mechanical house or furniture hides the supply`);
        }
      }
    }
  }
});

for (const route of Object.values(ROOF_HEALTH_ROUTES)) {
  test(`a full capsule walks the complete ${route.id} crossing in both directions without a jump, gap or blocked corner`, () => {
    for (const reverse of [false, true]) {
      const result = walk(route, { reverse });
      assert.ok(result.travel > (route.id === 'north' ? 60 : 38), `${route.id}: complete crossing, not only a local shortcut`);
      if (!reverse) {
        assert.ok(result.body.position.x > OPENINGS.roofScaffold.min[0] + result.body.radius
          && result.body.position.x < OPENINGS.roofScaffold.max[0] - result.body.radius);
      }
    }
  });

  test(`walking the ${route.id} crossing collects exactly its two real health packs and preserves the other route`, () => {
    const harness = roofPickupHarness(); harness.Player.health = 40;
    const initialObjects = harness.HealPickups.list.map(pickup => [pickup.mesh, pickup.halo]);
    const children = harness.World.children.length;
    walk(route, { radius: 0.32, height: 1.84, harness });
    assert.equal(harness.Player.health, 100); assert.equal(harness.calls.chimes, 2);
    assert.deepEqual(Array.from(harness.HealPickups.list).filter(pickup => !pickup.active).map(pickup => pickup.id).sort(), [...route.supplyIds].sort());
    harness.HealPickups.restoreZone('roof');
    assert.ok(harness.HealPickups.list.every(pickup => pickup.active && pickup.mesh.visible && pickup.halo.visible));
    assert.deepEqual(harness.HealPickups.list.map(pickup => [pickup.mesh, pickup.halo]), initialObjects);
    assert.equal(harness.World.children.length, children, 'checkpoint restoration reuses supplies and lights');
    // A full-health retry of the same physical route leaves every pack intact.
    walk(route, { radius: 0.32, height: 1.84, harness });
    assert.equal(harness.Player.health, 100); assert.equal(harness.calls.chimes, 2);
    assert.ok(harness.HealPickups.list.every(pickup => pickup.active));
  });
}
