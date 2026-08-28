import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDoorAssemblies } from '../../src/world/door-assemblies.js';
import { capsuleHasClearance } from '../../src/core/collision.js';

const EPS = 1e-6;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < EPS,
  `${label}: ${actual} != ${expected}`);
const bounds = mesh => new THREE.Box3().setFromObject(mesh);
const tangentAxis = door => door.axis === 'x' ? 'z' : 'x';
const descriptor = (overrides = {}) => Object.freeze({
  id: 'apartment-door', axis: 'z', x: 3, z: -7, floorY: 4, width: 1.14, height: 2.1,
  wallThickness: 0.2, frameWidth: 0.06, slabThickness: 0.07, handleSide: 1, closed: true,
  ...overrides,
});

// Real geometry and collision queries, with no renderer, DOM, lights or audio.
function fixture(door) {
  const world = new THREE.Group(), colliders = [], records = new Map(), decorations = [];
  const materials = Object.fromEntries(['wood', 'metal', 'tar', 'agedStone']
    .map(name => [name, new THREE.MeshStandardMaterial({ name })]));
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  function addBox(x, y, z, sx, sy, sz, material, options = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    mesh.position.set(x, y, z); world.add(mesh);
    const collider = options.collide === false ? null : new THREE.Box3(
      new THREE.Vector3(x - sx / 2, y - sy / 2, z - sz / 2),
      new THREE.Vector3(x + sx / 2, y + sy / 2, z + sz / 2));
    mesh.userData.collider = collider;
    if (collider) colliders.push(collider);
    if (options.architecture) {
      const specification = options.architecture;
      assert.ok(!records.has(specification.id), 'architectural ids are unique');
      records.set(specification.id, { ...specification, mesh, collider, bounds: bounds(mesh) });
    }
    return mesh;
  }
  function pushDecor(geometry, material, x, y, z, sx, sy, sz) {
    assert.equal(geometry, boxGeometry, 'decor uses the injected cached geometry');
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); world.add(mesh);
    mesh.userData.collider = null; decorations.push(mesh);
  }
  const floor = addBox(door.x, door.floorY - 0.1, door.z, 8, 0.2, 8, materials.agedStone, {
    architecture: { id: 'room-floor', kind: 'floor', supports: [], supportKind: 'ground' },
  });
  const builders = createDoorAssemblies({ addBox, pushDecor, boxGeometry, materials });
  return { ...builders, world, floor, colliders, records, decorations, materials };
}

for (const axis of ['x', 'z']) {
  test(`${axis} door frame preserves the clear opening and connected floor supports`, () => {
    const door = descriptor({ axis }), f = fixture(door);
    const { jambs, header, threshold, slab } = f.closedDoor(door, { floorId: 'room-floor' });
    const tangent = tangentAxis(door), centre = door[tangent];
    near(bounds(jambs[0]).max[tangent], centre - door.width / 2, 'left clear edge');
    near(bounds(jambs[1]).min[tangent], centre + door.width / 2, 'right clear edge');
    near(bounds(header).min.y, door.floorY + door.height, 'clear head height');
    near(bounds(header).min[tangent], centre - door.width / 2 - door.frameWidth, 'header left bearing');
    near(bounds(header).max[tangent], centre + door.width / 2 + door.frameWidth, 'header right bearing');
    for (const jamb of jambs) {
      near(bounds(jamb).min.y, bounds(f.floor).max.y, 'jamb touches floor');
      near(bounds(jamb).max.y, bounds(header).min.y, 'header touches jamb');
      near(bounds(jamb).max[axis] - bounds(jamb).min[axis], door.wallThickness, 'full wall depth');
      assert.deepEqual(f.records.get(jamb.name).supports, ['room-floor']);
      assert.equal(f.records.get(jamb.name).supportKind, 'bearing');
    }
    near(bounds(threshold).min.y, bounds(f.floor).max.y, 'threshold touches floor');
    near(bounds(threshold).max.y, bounds(slab).min.y, 'slab rests on threshold');
    assert.deepEqual(f.records.get(header.name).supports, jambs.map(jamb => jamb.name));
    assert.deepEqual(f.records.get(threshold.name).supports, ['room-floor']);
    assert.deepEqual(f.records.get(slab.name).supports, [threshold.name]);
  });

  test(`${axis} closed door has one correctly sized collidable leaf and named noncolliding details`, () => {
    const door = descriptor({ axis }), f = fixture(door);
    const result = f.closedDoor(door, { floorId: 'room-floor' });
    const slabBounds = bounds(result.slab), tangent = tangentAxis(door);
    near(slabBounds.max[tangent] - slabBounds.min[tangent], door.width - 0.02, 'leaf width');
    near(slabBounds.min.y, door.floorY + 0.025, 'leaf bottom');
    near(slabBounds.max.y, door.floorY + door.height - 0.02, 'leaf top');
    near(slabBounds.min[axis], door[axis] - door.slabThickness / 2, 'inside leaf face');
    near(slabBounds.max[axis], door[axis] + door.slabThickness / 2, 'outside leaf face');
    const parts = f.world.children.filter(mesh => mesh.userData.doorId === door.id);
    const solids = parts.filter(mesh => mesh.userData.collider);
    assert.equal(solids.length, 5, 'two jambs, header, threshold and one leaf');
    assert.equal(parts.filter(mesh => mesh.userData.doorPart === 'slab').length, 1);
    for (const part of parts) {
      assert.ok(part.name.startsWith(`${door.id}-`));
      assert.ok(part.userData.doorPart);
      if (part.userData.doorSide) assert.equal(part.userData.collider, null);
    }
    assert.equal(result.handles.interior.name, `${door.id}-interior-handle`);
    assert.equal(result.handles.exterior.name, `${door.id}-exterior-handle`);
    assert.equal(capsuleHasClearance(new THREE.Vector3(door.x, door.floorY + 0.03, door.z),
      0.32, 1.84, f.colliders), false, 'closed leaf blocks the opening');
  });

  for (const handleSide of [-1, 1]) {
    test(`${axis} door handle side ${handleSide} aligns both faces without mirroring the tangent`, () => {
      const door = descriptor({ axis, handleSide }), f = fixture(door);
      const { handles } = f.closedDoor(door, { floorId: 'room-floor' });
      const tangent = tangentAxis(door), leafWidth = door.width - 0.02;
      const handleT = handleSide * (leafWidth / 2 - Math.min(0.12, leafWidth * 0.15));
      const handleWidth = Math.min(0.14, leafWidth * 0.18);
      const expectedT = door[tangent] + handleT - handleSide * handleWidth * 0.35;
      for (const handle of Object.values(handles)) near(handle.position[tangent], expectedT, 'handle tangent');
      for (const suffix of ['handle', 'handle-mount', 'lockplate', 'keyway', 'kickplate',
        'panel-0', 'panel-1', 'hinge-0', 'hinge-1', 'hinge-2']) {
        const interior = f.world.getObjectByName(`${door.id}-interior-${suffix}`);
        const exterior = f.world.getObjectByName(`${door.id}-exterior-${suffix}`);
        near(interior.position[tangent], exterior.position[tangent], `${suffix} tangent alignment`);
        near(interior.position.y, exterior.position.y, `${suffix} height alignment`);
        near(interior.position[axis] + exterior.position[axis], door[axis] * 2, `${suffix} paired normal`);
        assert.ok(interior.position[axis] < door[axis] && exterior.position[axis] > door[axis]);
        for (const mesh of [interior, exterior]) {
          const b = bounds(mesh);
          const normalExtent = Math.max(Math.abs(b.min[axis] - door[axis]), Math.abs(b.max[axis] - door[axis]));
          assert.ok(normalExtent <= 0.1 + EPS, 'hardware stays out of the adjacent lane');
          assert.ok(normalExtent - door.slabThickness / 2 <= 0.06 + EPS, 'leaf hardware projects at most 6cm');
        }
      }
      for (const side of ['interior', 'exterior']) {
        const handle = f.world.getObjectByName(`${door.id}-${side}-handle`);
        const mount = f.world.getObjectByName(`${door.id}-${side}-handle-mount`);
        const plate = f.world.getObjectByName(`${door.id}-${side}-lockplate`);
        assert.ok(bounds(handle).expandByScalar(EPS).intersectsBox(bounds(mount)), 'lever contacts spindle');
        assert.ok(bounds(mount).expandByScalar(EPS).intersectsBox(bounds(plate)), 'spindle contacts plate');
      }
    });
  }

  test(`${axis} open frame has a flush threshold and leaves every lane through the opening clear`, () => {
    const door = descriptor({ axis, closed: false }), f = fixture(door);
    const { jambs, header, threshold } = f.openFrame(door, { floorId: 'room-floor' });
    assert.equal(threshold.userData.collider, null);
    near(bounds(threshold).max.y, door.floorY, 'flush threshold top');
    assert.equal(f.records.get(threshold.name).supportKind, 'anchored');
    const parts = f.world.children.filter(mesh => mesh.userData.doorId === door.id);
    assert.deepEqual(parts.map(mesh => mesh.userData.doorPart).sort(), ['header', 'jamb', 'jamb', 'threshold']);
    assert.equal(parts.filter(mesh => mesh.userData.collider).length, 3);
    const tangent = tangentAxis(door), radius = 0.32;
    const passage = new THREE.Box3(new THREE.Vector3(door.x - 0.14, door.floorY + EPS * 4, door.z - 0.14),
      new THREE.Vector3(door.x + 0.14, door.floorY + door.height - EPS * 4, door.z + 0.14));
    passage.min[tangent] = door[tangent] - door.width / 2 + EPS * 4;
    passage.max[tangent] = door[tangent] + door.width / 2 - EPS * 4;
    for (const mesh of [jambs[0], jambs[1], header]) assert.ok(!bounds(mesh).intersectsBox(passage));
    for (const normal of [-0.16, 0, 0.16]) {
      for (const offset of [-1, 0, 1]) {
        const feet = new THREE.Vector3(door.x, door.floorY + 0.0001, door.z);
        feet[axis] += normal;
        feet[tangent] += offset * (door.width / 2 - radius - 0.015);
        assert.ok(capsuleHasClearance(feet, radius, 1.84, f.colliders), 'full-height capsule fits');
      }
    }
  });

  test(`${axis} paired face trims share tangent positions and cannot intrude into the opening`, () => {
    const door = descriptor({ axis }), f = fixture(door);
    f.openFrame(door, { floorId: 'room-floor' });
    assert.equal(f.decorations.length, 6);
    const tangent = tangentAxis(door);
    for (let i = 0; i < 3; i++) {
      const interior = f.decorations[i], exterior = f.decorations[i + 3];
      near(interior.position[tangent], exterior.position[tangent], 'trim tangent');
      near(interior.position.y, exterior.position.y, 'trim height');
      near(interior.position[axis] + exterior.position[axis], door[axis] * 2, 'trim paired normal');
      for (const mesh of [interior, exterior]) {
        const b = bounds(mesh);
        assert.ok(b.min[axis] >= door[axis] - 0.14 - EPS && b.max[axis] <= door[axis] + 0.14 + EPS);
        if (i === 0) near(b.max[tangent], door[tangent] - door.width / 2, 'left trim clear edge');
        if (i === 1) near(b.min[tangent], door[tangent] + door.width / 2, 'right trim clear edge');
        if (i === 2) near(b.min.y, door.floorY + door.height, 'header trim clear edge');
      }
    }
  });
}

test('charred relief touches only the interior panels while the exterior stays weathered wood', () => {
  for (const axis of ['x', 'z']) {
    const door = descriptor({ axis, charred: true }), f = fixture(door);
    const { slab } = f.closedDoor(door, { floorId: 'room-floor' });
    assert.equal(slab.material, f.materials.wood);
    const scorch = f.decorations.filter(mesh => mesh.material === f.materials.tar);
    assert.equal(scorch.length, 2);
    for (const [i, mesh] of scorch.entries()) {
      const panel = f.world.getObjectByName(`${door.id}-interior-panel-${i}`);
      assert.ok(bounds(mesh).max[axis] < door[axis] - door.slabThickness / 2);
      assert.ok(bounds(mesh).expandByScalar(EPS).intersectsBox(bounds(panel)), 'scorch contacts panel');
      assert.equal(f.world.getObjectByName(`${door.id}-exterior-panel-${i}`).material, f.materials.wood);
    }
  }
});

test('custom dimensions keep frame clearance and hardware limits without mutating descriptors', () => {
  const door = descriptor({ width: 1.4, height: 2.4, wallThickness: 0.24, frameWidth: 0.08, slabThickness: 0.18 });
  const before = { ...door }, f = fixture(door);
  const { slab } = f.closedDoor(door, { floorId: 'room-floor' });
  assert.deepEqual(door, before);
  near(bounds(slab).max.z - bounds(slab).min.z, 0.18, 'custom leaf thickness');
  near(bounds(slab).max.x - bounds(slab).min.x, 1.38, 'custom clear width');
  for (const mesh of f.world.children.filter(item => item.userData.doorSide)) {
    assert.ok(bounds(mesh).min.z >= door.z - 0.1 - EPS && bounds(mesh).max.z <= door.z + 0.1 + EPS);
  }
  const openDoor = descriptor({ closed: false }), openBefore = { ...openDoor }, open = fixture(openDoor);
  open.openFrame(openDoor, { floorId: 'room-floor' });
  assert.deepEqual(openDoor, openBefore);
});

test('optional dimensions use defaults and missing floor ids do not invent a floor dependency', () => {
  const door = Object.freeze({ id: 'simple-door', axis: 'x', x: 0, z: 0, floorY: 0, width: 1, height: 2 });
  const f = fixture(door), { jambs, header, slab } = f.closedDoor(door);
  near(bounds(slab).max.x - bounds(slab).min.x, 0.07, 'default leaf thickness');
  near(bounds(jambs[0]).max.x - bounds(jambs[0]).min.x, 0.2, 'default wall thickness');
  for (const jamb of jambs) {
    assert.deepEqual(f.records.get(jamb.name).supports, []);
    assert.equal(f.records.get(jamb.name).supportKind, 'ground');
  }
  assert.deepEqual(f.records.get(header.name).supports, jambs.map(mesh => mesh.name));
});

test('invalid descriptors fail before adding any geometry', () => {
  for (const overrides of [
    { axis: 'y' }, { axis: 'X' }, { id: '' }, { x: NaN }, { z: Infinity }, { floorY: NaN },
    { width: 0.02 }, { height: 0.045 }, { frameWidth: 0 }, { wallThickness: 0.28 },
    { slabThickness: 0.2 }, { slabThickness: 0.19, wallThickness: 0.18 }, { handleSide: 0 },
  ]) {
    const valid = descriptor(), f = fixture(valid), invalid = descriptor(overrides);
    assert.throws(() => f.closedDoor(invalid, { floorId: 'room-floor' }));
    assert.throws(() => f.openFrame(invalid, { floorId: 'room-floor' }));
    assert.equal(f.world.children.length, 1, 'only the injected test floor exists');
    assert.equal(f.records.size, 1);
  }
});
