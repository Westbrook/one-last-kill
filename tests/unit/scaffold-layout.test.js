import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Architecture, boxBounds, signYaw } from '../../src/world/architecture.js';
import { SCAFFOLD_LEVELS, SCAFFOLD_TRIGGER_MIN_Z, BALCONY } from '../../src/world/layout.js';
import { Colliders, capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';

// Run the actual authored builder and structural helpers with real geometry,
// collision and registry services. Only rendering/material/canvas services are
// injected; this suite never creates a browser, renderer or audio context.
function loadFunctions(path, bindings, names) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export \{[^}]+\};\s*$/gm, '')
    .replace(/^export (?=function )/gm, '');
  assert.doesNotMatch(source, /^import\s/m, 'Update the explicit harness for multiline imports');
  return runInNewContext(`${source}\n;({ ${names.join(', ')} });`, bindings, { filename: path });
}

function fixture() {
  Architecture.clear(); Colliders.clear();
  const World = new THREE.Group(), material = new THREE.MeshStandardMaterial();
  const MATS = new Proxy({}, { get: () => material });
  const unitBox = new THREE.BoxGeometry(1, 1, 1), triggers = [];
  function addBox(x, y, z, sx, sy, sz, mat, options = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    mesh.position.set(x, y, z); World.add(mesh);
    const collider = options.collide === false ? null : Colliders.addBoxBySize(x, y, z, sx, sy, sz);
    mesh.userData.collider = collider;
    if (options.architecture) Architecture.register(mesh, collider, boxBounds(x, y, z, sx, sy, sz), options.architecture);
    return mesh;
  }
  const bindings = {
    THREE, mergeGeometries, MATS, World, Architecture, boxBounds, Colliders,
    SCAFFOLD_LEVELS, SCAFFOLD_TRIGGER_MIN_Z, _BG: { unitBox }, addBox,
    makeCanvas() { throw new Error('Scaffold rail frames should not require a canvas'); },
    addDecor: (x, y, z, sx, sy, sz, mat) => addBox(x, y, z, sx, sy, sz, mat, { collide: false }),
    pushDecor(geometry, mat, x, y, z, sx, sy, sz, yaw = 0) {
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.rotation.y = yaw; World.add(mesh);
    },
    addSign(x, y, z, width, height, normal) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
      mesh.position.set(x, y, z); mesh.rotation.y = signYaw(normal); World.add(mesh); return mesh;
    },
    Triggers: { add(name, min, max) { triggers.push({ name, box: new THREE.Box3(min, max) }); } },
  };
  Object.assign(bindings, loadFunctions('../../src/world/structures.js', bindings, ['addBeam', 'addProtectiveScreen']));

  // The supported apron and both real masonry faces are supplied by the
  // surrounding zone builders. Include their actual extents in this fixture.
  addBox(3, 0.07, 4, 66, 0.14, 8, material, { architecture: { id: 'near-apron', kind: 'ground' } });
  addBox(-1, 10.7, 0, 28, 6.6, 0.2, material, { architecture: { id: 'main-upper-south', kind: 'wall' } });
  addBox(19, 6.9, 0, 12, 13.8, 0.2, material, { architecture: { id: 'roof-annex-east-south-wall', kind: 'wall' } });
  addBox(22, 13.9, -1, 6, 0.2, 2, material); // Roof entry lip.
  addBox(-3, 3.9, 0.9, 32, 0.2, 1.8, material); // Balcony, with no scaffold columns through it.
  addBox(3, -0.075, 14, 66, 0.25, 12, material); // Street surface at y=.05.
  const firstScaffoldObject = World.children.length;
  loadFunctions('../../src/world/zones/scaffolding.js', bindings, ['buildScaffolding']).buildScaffolding();
  World.updateMatrixWorld(true);
  return {
    World, triggers, boxes: [...Colliders.list], records: new Map(Architecture.elements),
    scaffoldObjects: World.children.slice(firstScaffoldObject),
  };
}

const built = fixture();
const records = [...built.records.values()].filter(record => record.id.startsWith('scaffold-'));
const near = (actual, expected, label, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
const vector = values => new THREE.Vector3(...values);

test('four scaffold arenas match the shared expanded footprints and floor elevations', () => {
  assert.equal(SCAFFOLD_LEVELS.length, 4);
  for (const [i, level] of SCAFFOLD_LEVELS.entries()) {
    const record = built.records.get(`scaffold-deck-${i}`);
    near(record.bounds.min.x, level.x1, `deck ${i} west`);
    near(record.bounds.max.x, level.x2, `deck ${i} east`);
    near(record.bounds.min.z, level.z1, `deck ${i} rear`);
    near(record.bounds.max.z, level.z2, `deck ${i} front`);
    near(record.bounds.max.y, level.y, `deck ${i} surface`);
    assert.ok((level.x2 - level.x1) * (level.z2 - level.z1) >= 76, `deck ${i} combat area`);
    assert.ok(record.supports.length >= 6, `deck ${i} has intermediate transoms`);
  }
});

test('registered scaffold geometry and colliders agree and every support touches', () => {
  for (const record of records) {
    const actual = new THREE.Box3().setFromObject(record.mesh);
    assert.ok(actual.min.distanceTo(record.bounds.min) < 1e-5, `${record.id} actual min`);
    assert.ok(actual.max.distanceTo(record.bounds.max) < 1e-5, `${record.id} actual max`);
    if (record.collider) {
      assert.ok(record.collider.min.distanceTo(record.bounds.min) < 1e-5, `${record.id} collision min`);
      assert.ok(record.collider.max.distanceTo(record.bounds.max) < 1e-5, `${record.id} collision max`);
    }
    assert.ok(record.supports.length > 0, `${record.id} declares its support`);
    for (const id of record.supports) {
      const support = built.records.get(id);
      assert.ok(support, `${record.id} references existing ${id}`);
      const overlapX = Math.min(record.bounds.max.x, support.bounds.max.x) - Math.max(record.bounds.min.x, support.bounds.min.x);
      const overlapZ = Math.min(record.bounds.max.z, support.bounds.max.z) - Math.max(record.bounds.min.z, support.bounds.min.z);
      if (record.supportKind === 'bearing') {
        assert.ok(overlapX > 0 && overlapZ > 0, `${record.id} bears on ${id}`);
        const joint = support.bounds.max.y - record.bounds.min.y;
        assert.ok(joint >= -0.031 && joint <= 0.251, `${record.id} vertical bearing on ${id}: ${joint}`);
        assert.ok(support.bounds.getCenter(new THREE.Vector3()).y < record.bounds.getCenter(new THREE.Vector3()).y, `${id} below ${record.id}`);
      } else {
        const gap = axis => Math.max(0, record.bounds.min[axis] - support.bounds.max[axis], support.bounds.min[axis] - record.bounds.max[axis]);
        assert.ok(Math.hypot(gap('x'), gap('y'), gap('z')) <= 0.031, `${record.id} attaches to ${id}`);
      }
    }
  }
});

test('grounded standards form small bays and bridge the balcony on outboard consoles', () => {
  const frontFeet = records.filter(record => record.id.startsWith('scaffold-foot-3-')).sort((a, b) => a.bounds.min.x - b.bounds.min.x);
  assert.equal(frontFeet.length, 11);
  for (let i = 1; i < frontFeet.length; i++) assert.ok(frontFeet[i].bounds.min.x - frontFeet[i - 1].bounds.min.x <= 2.75, 'standard bay span');
  for (const record of records.filter(record => record.kind === 'footplate')) {
    near(record.bounds.min.y, 0.14, `${record.id} bears on apron`);
    assert.ok(record.bounds.min.z >= 0 && record.bounds.max.z <= 8, `${record.id} fits apron depth`);
  }
  const consoles = records.filter(record => record.id.startsWith('scaffold-gallery-console-'));
  assert.equal(consoles.length, 3);
  for (const console of consoles) {
    assert.ok(console.bounds.min.y > BALCONY.floorY + BALCONY.guardHeight);
    assert.ok(console.supports[0].startsWith('scaffold-post-1-'));
  }
  const ties = records.filter(record => record.id.startsWith('scaffold-wall-tie-'));
  assert.ok(ties.length >= 12);
  for (const tie of ties) {
    const x = tie.bounds.getCenter(new THREE.Vector3()).x;
    assert.ok(x <= 25, 'no masonry tie beyond annex');
    assert.equal(tie.supports[0], x < 13 ? 'main-upper-south' : 'roof-annex-east-south-wall');
  }
});

test('no scaffold geometry enters the balcony body or tall rail envelope', () => {
  const gallery = new THREE.Box3(vector([-19, 4.005, 0]), vector([13, 6.7, 1.8]));
  for (const object of built.scaffoldObjects) {
    if (object.isLight) continue;
    const actual = new THREE.Box3().setFromObject(object);
    assert.ok(!actual.intersectsBox(gallery), `${object.name || object.type} enters the balcony`);
  }
  for (let x = -18.5; x < 12.6; x += 0.3) {
    assert.ok(capsuleHasClearance(vector([x, 4.02, 0.95]), 0.32, 1.84, built.boxes), `balcony capsule at ${x}`);
  }
});

test('all fighting lanes and five spawn pockets per deck fit a tall enemy capsule', () => {
  const lanes = [3.2, 4.2, 4.5, 5.2];
  for (const [i, level] of SCAFFOLD_LEVELS.entries()) {
    const positions = [level.x1 + 1.2, level.x1 + 2.8, (level.x1 + level.x2) / 2, level.x2 - 3.2, level.x2 - 1];
    for (let x = level.x1 + 0.6; x <= level.x2 - 0.6; x += 0.2) positions.push(x);
    for (const x of positions) {
      assert.ok(capsuleHasClearance(vector([x, level.y + 0.02, lanes[i]]), 0.48, 2.02, built.boxes), `deck ${i} lane/spawn at ${x}`);
    }
  }
});

function walkTo(body, target, maxSeconds = 8) {
  const dt = 1 / 120;
  for (let tick = 0; tick < maxSeconds / dt; tick++) {
    const dx = target[0] - body.position.x, dz = target[2] - body.position.z;
    const distance = Math.hypot(dx, dz);
    const speed = Math.min(4.2, distance / dt);
    body.velocity.x = distance > 0.001 ? dx / distance * speed : 0;
    body.velocity.z = distance > 0.001 ? dz / distance * speed : 0;
    body.velocity.y = Math.max(-32, body.velocity.y - 22 * dt);
    moveCapsule(body, dt, built.boxes, true);
    if (distance < 0.06 && Math.abs(body.position.y - target[1]) < 0.06 && body.onGround) return;
  }
  assert.fail(`Route blocked toward ${target.join(',')}; reached ${body.position.toArray().map(n => n.toFixed(3)).join(',')}`);
}

test('a standing player can walk the real roof-to-street descent without jumping', () => {
  const body = { position: vector([22, 14.02, -0.5]), velocity: new THREE.Vector3(), radius: 0.32, height: 1.84, onGround: true };
  const route = [
    [22, 10, 2.4],
    [15.2, 10, 3.2], [9.5, 7, 3.2],
    [21.8, 7, 4.2], [25, 4, 4.2],
    [18, 4, 4.5], [13, 1.5, 4.5],
    [24, 1.5, 5.2], [24, 0.05, 10],
  ];
  for (const target of route) {
    walkTo(body, target);
    assert.ok(capsuleHasClearance(body.position, body.radius, body.height, built.boxes), `standing at ${target.join(',')}`);
  }
});

test('scaffold checkpoint and every descent landing have standing clearance and support', () => {
  const points = [[22, 10, 2.4], [9.5, 7, 3.2], [25, 4, 4.2], [13, 1.5, 4.5], [24, 0.05, 10]];
  for (const [x, y, z] of points) {
    assert.ok(capsuleHasClearance(vector([x, y + 0.02, z]), 0.32, 1.84, built.boxes), `landing ${x},${y},${z}`);
    const support = built.boxes.some(box => Math.abs(box.max.y - y) < 0.01 && box.min.x <= x - 0.32 && box.max.x >= x + 0.32 && box.min.z <= z - 0.32 && box.max.z >= z + 0.32);
    assert.ok(support, `supported landing ${x},${y},${z}`);
  }
});

test('scaffold trigger includes every deck lane but excludes the balcony', () => {
  assert.equal(built.triggers.length, 1);
  const trigger = built.triggers[0];
  assert.equal(trigger.name, 'scaffolding');
  for (const [i, level] of SCAFFOLD_LEVELS.entries()) {
    assert.ok(trigger.box.containsPoint(vector([(level.x1 + level.x2) / 2, level.y + 0.02, [3.2, 4.2, 4.5, 5.2][i]])));
  }
  assert.ok(!trigger.box.containsPoint(vector([10, BALCONY.floorY, BALCONY.laneZ])));
  assert.ok(trigger.box.containsPoint(vector([22, 10.02, 2.4])));
});
