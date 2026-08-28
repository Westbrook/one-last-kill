import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createAmmoSupplies } from '../../src/game/ammo-supplies.js';
import { AMMO_SUPPLY_CACHES } from '../../src/game/ammo-supply-rules.js';
import { Colliders, capsuleHasClearance } from '../../src/core/collision.js';
import { Architecture, boxBounds } from '../../src/world/architecture.js';
import { BALCONY, OPENINGS } from '../../src/world/layout.js';
import { isSegmentOccluded } from '../../src/game/combat-rules.js';

const config = AMMO_SUPPLY_CACHES[0];

function fixture() {
  Architecture.clear(); Colliders.clear();
  const world = new THREE.Group();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.2), new THREE.MeshStandardMaterial());
  wall.position.set(-16, 5, 0); world.add(wall);
  const wallCollider = Colliders.addBoxBySize(-16, 5, 0, 2, 2, 0.2);
  Architecture.register(wall, wallCollider, boxBounds(-16, 5, 0, 2, 2, 0.2), {
    id: 'stair-south-door-east', kind: 'wall', supportKind: 'ground',
  });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 1.8), new THREE.MeshStandardMaterial());
  floor.position.set(-16, 3.9, 0.9); world.add(floor);
  const floorCollider = Colliders.addBoxBySize(-16, 3.9, 0.9, 8, 0.2, 1.8);
  Architecture.register(floor, floorCollider, boxBounds(-16, 3.9, 0.9, 8, 0.2, 1.8), {
    id: config.support, kind: 'deck', supportKind: 'ground',
  });
  const player = { pos: new THREE.Vector3(config.position.x, BALCONY.floorY + 1.72, BALCONY.laneZ), _eyeH: 1.72 };
  const session = { active: true, dead: false };
  const supplies = createAmmoSupplies([config]);
  const initialization = { world, player, canInteract: () => session.active && !session.dead };
  supplies.init(initialization);
  supplies.setZone('balcony');
  const entry = supplies.list[0];
  const held = { current: 'pistol', loaded: 3, reserve: 0 };
  const accept = (amount, cap) => {
    const accepted = Math.max(0, Math.min(amount, cap - held.reserve));
    held.reserve += accepted;
    return accepted;
  };
  return { world, wall, wallCollider, floorCollider, player, session, supplies, entry, held, accept, initialization };
}

test('a nearby visible floor box offers reserve ammunition and consumes only accepted stock', () => {
  const { supplies, entry, held, accept } = fixture();
  assert.equal(supplies.findNearest(held), entry);
  assert.equal(supplies.prompt(entry, held), '[E] +24 PISTOL AMMO · AMMO BOX');
  assert.equal(supplies.pickup(entry, held, accept), 24);
  assert.deepEqual(held, { current: 'pistol', loaded: 3, reserve: 24 });
  assert.equal(entry.active, false);
  assert.equal(entry.remainingUnits, 0);
  assert.equal(entry.mesh.visible, true, 'A used ammo case stays physically in the world');
  assert.equal(supplies.findNearest(held), null);
  assert.equal(supplies.pickup(entry, held, accept), 0);
});

test('solid wall occlusion blocks both query and direct collection from inside the stairwell', () => {
  const { supplies, entry, held, accept, player } = fixture();
  supplies.setZone('stairwell');
  player.pos.z = -0.7;
  assert.equal(entry.mesh.visible, true);
  assert.equal(supplies.findNearest(held), null);
  assert.equal(supplies.pickup(entry, held, accept), 0);
  assert.equal(entry.remainingUnits, 120);
  assert.equal(held.reserve, 0);
});

test('range, floor and active-zone checks prevent remote or upstairs collection', () => {
  const { supplies, entry, held, accept, player } = fixture();
  player.pos.x -= 4;
  assert.equal(supplies.findNearest(held), null);
  assert.equal(supplies.pickup(entry, held, accept), 0);
  player.pos.x = config.position.x;
  player.pos.y += 2.4;
  assert.equal(supplies.findNearest(held, 10), null);
  assert.equal(supplies.pickup(entry, held, accept), 0);
  player.pos.y -= 2.4;
  supplies.setZone('roof');
  assert.equal(supplies.findNearest(held), null);
  assert.equal(supplies.pickup(entry, held, accept), 0);
  assert.equal(entry.remainingUnits, 120);
});

test('all zone changes preserve the visible floor box and its collider while gating only interaction', () => {
  const { supplies, entry, held, accept } = fixture();
  const model = entry.mesh, collider = entry.collider;
  const occupiedFeet = new THREE.Vector3(config.position.x, BALCONY.floorY + 0.02, 0.58);
  const shotStart = new THREE.Vector3(config.position.x, config.floorY + 0.18, 0.8);
  const shotEnd = new THREE.Vector3(config.position.x, config.floorY + 0.18, 0.2);
  for (const zone of ['apartment', 'neighbor', 'balcony', 'stairwell', 'roof', 'scaffolding', 'street', 'bakery']) {
    supplies.setZone(zone);
    assert.equal(entry.mesh, model);
    assert.equal(entry.collider, collider);
    assert.equal(entry.mesh.visible, true, `${zone} cannot hide a solid floor case`);
    assert.ok(Colliders.list.includes(collider));
    assert.equal(capsuleHasClearance(occupiedFeet, 0.32, 1.84, Colliders.list), false);
    assert.equal(isSegmentOccluded(shotStart, shotEnd, Colliders.list), true);
    if (entry.visibleZones.includes(zone)) {
      assert.equal(supplies.findNearest(held), entry);
    } else {
      assert.equal(supplies.findNearest(held), null);
      assert.equal(supplies.pickup(entry, held, accept), 0);
    }
  }
  assert.equal(entry.remainingUnits, 120);
  supplies.setZone('balcony');
  assert.equal(supplies.pickup(entry, held, accept), 24);
  supplies.setZone('roof');
  assert.equal(entry.mesh.visible, true, 'An empty case remains visible outside its pickup zone');
  assert.ok(Colliders.list.includes(entry.collider));
  supplies.reset();
  assert.equal(entry.mesh.visible, true, 'Campaign reset also retains the physical fixture');
});

test('paused and dead sessions cannot collect through a retained cache reference', () => {
  const { supplies, entry, held, accept, session } = fixture();
  for (const state of [{ active: false, dead: false }, { active: true, dead: true }]) {
    Object.assign(session, state);
    assert.equal(supplies.findNearest(held), null);
    assert.equal(supplies.pickup(entry, held, accept), 0);
    assert.equal(entry.remainingUnits, 120);
    assert.equal(held.reserve, 0);
  }
});

test('melee weapons and full reserves preserve the floor box and never grant an unearned weapon', () => {
  const { supplies, entry, held, accept } = fixture();
  for (const current of ['fists', 'bat', 'knife']) {
    held.current = current;
    assert.equal(supplies.findNearest(held), null);
    assert.equal(supplies.pickup(entry, held, accept), 0);
    assert.equal(held.current, current);
  }
  held.current = 'pistol'; held.reserve = 48;
  assert.equal(supplies.findNearest(held), null);
  assert.equal(supplies.pickup(entry, held, accept), 0);
  assert.equal(entry.remainingUnits, 120);
});

test('partial collection and checkpoint restore update a cached indicator without replacing resources', () => {
  const { world, supplies, entry, held, accept, initialization } = fixture();
  const mesh = entry.mesh, collider = entry.collider, initial = supplies.snapshot();
  const geometries = new Set(), materials = new Set();
  world.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) materials.add(object.material);
    assert.equal(Boolean(object.isLight), false, 'A supply box adds no practical lights');
  });
  const colliders = Colliders.list.length;
  held.reserve = 47;
  assert.equal(supplies.pickup(entry, held, accept), 1);
  assert.equal(entry.remainingUnits, 115);
  const partial = supplies.snapshot();
  for (let retry = 0; retry < 3; retry++) {
    supplies.reset();
    supplies.init(initialization);
    assert.equal(supplies.restore(partial), true);
    supplies.setZone('balcony');
    assert.equal(entry.remainingUnits, 115);
    assert.equal(entry.mesh, mesh);
    assert.equal(entry.collider, collider);
    assert.equal(supplies.list.length, 1);
    assert.equal(Colliders.list.length, colliders);
    world.traverse(object => {
      if (object.geometry) assert.ok(geometries.has(object.geometry));
      if (object.material) assert.ok(materials.has(object.material));
    });
  }
  assert.equal(supplies.restore(initial), true);
  assert.equal(entry.remainingUnits, 120);
});

test('case feet, collider and model rest on the floor while preserving gallery and doorway clearance', () => {
  const { entry, floorCollider } = fixture();
  const record = Architecture.elements.get('ammo-cache-' + config.id);
  const measured = new THREE.Box3().setFromObject(entry.mesh);
  assert.ok(measured.min.distanceTo(record.bounds.min) < 1e-6);
  assert.ok(measured.max.distanceTo(record.bounds.max) < 1e-6);
  assert.ok(record.bounds.min.distanceTo(entry.collider.min) < 1e-6);
  assert.ok(record.bounds.max.distanceTo(entry.collider.max) < 1e-6);
  assert.ok(Math.abs(record.bounds.min.y - floorCollider.max.y) < 1e-6, 'Case feet rest directly on the deck');
  assert.deepEqual(record.supports, [config.support]);
  assert.equal(record.supportKind, 'bearing');
  assert.ok(Math.abs(measured.max.y - config.floorY - config.height) < 1e-6);
  assert.ok(measured.min.x > OPENINGS.balconyStair.max[0], 'The case does not obstruct the open stair doorway');
  assert.ok(measured.max.z < BALCONY.laneZ - 0.48, 'The whole model clears the enemy centerline capsule');
  assert.ok(entry.interactionPosition.y > measured.max.y, 'The interaction point lies above the complete case, including its handle');
  for (const x of [config.position.x - 0.8, config.position.x, config.position.x + 0.8]) {
    const feet = new THREE.Vector3(x, BALCONY.floorY + 0.03, BALCONY.laneZ);
    assert.ok(capsuleHasClearance(feet, 0.32, 1.84, Colliders.list));
    assert.ok(capsuleHasClearance(feet, 0.48, 2.02, Colliders.list));
  }
});

test('unknown entries, invalid saves and failed acceptance cannot consume visible supply', () => {
  const { supplies, entry, held, accept } = fixture();
  assert.equal(supplies.pickup({ ...entry }, held, accept), 0);
  assert.equal(supplies.prompt({ ...entry }, held), null);
  assert.equal(supplies.pickup(entry, held, () => 0), 0);
  assert.equal(supplies.restore({ version: 1, caches: [] }), false);
  assert.equal(entry.remainingUnits, 120);
  assert.equal(entry.active, true);
});

test('an unobstructed floor case is collectible from every side without occluding its own lid target', () => {
  Architecture.clear(); Colliders.clear();
  const world = new THREE.Group();
  Colliders.addBoxBySize(0, 3.9, 0, 6, 0.2, 6);
  const isolated = { ...AMMO_SUPPLY_CACHES[1], position: { x: 0, y: 4, z: 0 }, floorY: 4 };
  const player = { pos: new THREE.Vector3(), _eyeH: 1.72 };
  const supplies = createAmmoSupplies([isolated]);
  supplies.init({ world, player, canInteract: () => true });
  supplies.setZone('roof');
  const entry = supplies.list[0], full = supplies.snapshot();
  const held = { current: 'pistol', loaded: 3, reserve: 0 };
  for (const [x, z] of [[0.95, 0], [-0.95, 0], [0, 0.95], [0, -0.95]]) {
    supplies.restore(full); held.reserve = 0;
    player.pos.set(x, 4 + player._eyeH, z);
    assert.equal(supplies.findNearest(held), entry, `Side ${x},${z} must see the target above the case`);
    assert.equal(supplies.pickup(entry, held, amount => { held.reserve += amount; return amount; }), 24);
    assert.equal(held.loaded, 3);
    assert.equal(entry.remainingUnits, 0);
  }
});
