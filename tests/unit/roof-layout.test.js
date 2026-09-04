import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { BUILDING, ROOF, OPENINGS } from '../../src/world/layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { Architecture, boxBounds } from '../../src/world/architecture.js';
import { Colliders, capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { applyWaterTankStaveUV } from '../../src/render/water-tank-uv.js';
import { createAuthoredWorldDressingGeometry, refineAuthoredDressingMesh } from '../../src/render/authored-world-dressing.js';

function buildFixture() {
  Architecture.clear(); Colliders.clear();
  const World = new THREE.Group(), materials = new Map();
  const MATS = new Proxy({}, { get(_, key) {
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial());
    return materials.get(key);
  } });
  function addBox(x, y, z, sx, sy, sz, mat, options = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    mesh.position.set(x, y, z); World.add(mesh);
    const collider = options.collide === false ? null : Colliders.addBoxBySize(x, y, z, sx, sy, sz);
    if (options.architecture) Architecture.register(mesh, collider, boxBounds(x, y, z, sx, sy, sz), options.architecture);
    return mesh;
  }
  function pushDecor(geometry, mat, x, y, z, sx, sy, sz, yaw = 0) {
    const mesh = new THREE.Mesh(geometry, mat); mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz); mesh.rotation.y = yaw; World.add(mesh);
  }
  function addBeam(id, from, to, width, supports) {
    const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, start.distanceTo(end), width), MATS.metal);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
    World.add(mesh); mesh.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(mesh);
    Architecture.register(mesh, null, bounds, { id, kind: 'beam', supports, supportKind: 'anchored' });
  }
  const source = readFileSync(new URL('../../src/world/zones/roof.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export (?=function )/gm, '');
  const build = runInNewContext(`${source}\n;buildRoof;`, {
    THREE, BUILDING, ROOF, OPENINGS, STAIRS, World, MATS, Colliders, Architecture, boxBounds, applyWaterTankStaveUV,
    createAuthoredWorldDressingGeometry, refineAuthoredDressingMesh,
    _BG: { unitBox: new THREE.BoxGeometry(1, 1, 1), pipe: new THREE.CylinderGeometry(1, 1, 1, 8) },
    addBox, pushDecor, addBeam, addSign() {}, Triggers: { add() {} },
    addDecor: (x, y, z, sx, sy, sz, mat) => addBox(x, y, z, sx, sy, sz, mat, { collide: false }),
  });
  build(); World.updateMatrixWorld(true);
  return { World, records: new Map(Architecture.elements), colliders: [...Colliders.list] };
}
const fixture = buildFixture();
function floorAt(x, z, nearY = ROOF.floorY) {
  let top = -Infinity;
  for (const box of fixture.colliders) {
    if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z && box.max.y <= nearY + 0.03) top = Math.max(top, box.max.y);
  }
  return top;
}

test('expanded roof gains supported floor area without covering the apartment lightwell', () => {
  const ids = ['roof-deck', 'roof-annex-east-deck', 'roof-annex-north-deck', 'roof-annex-west-link-deck', 'roof-annex-east-link-deck'];
  const area = ids.reduce((sum, id) => {
    const bounds = fixture.records.get(id).bounds;
    assert.equal(bounds.max.y, ROOF.floorY);
    return sum + (bounds.max.x - bounds.min.x) * (bounds.max.z - bounds.min.z);
  }, 0);
  assert.equal(area, 935);
  assert.ok(area > 3 * 280);
  assert.equal(floorAt(-10.1, -12), 0, 'lightwell remains open from ground to sky');
  for (const id of ['north', 'west', 'east', 'south']) assert.ok(fixture.records.has(`lightwell-${id}-guard`));
  assert.ok(capsuleHasClearance(new THREE.Vector3(-10.1, 5.2, -12), 0.32, 1.84, fixture.colliders));
});

test('all authored rooftop spawn and performance fixture pockets have real floor and full body clearance', () => {
  for (const [x, z] of [...ROOF.spawnPockets, [15, -7]]) {
    assert.equal(floorAt(x, z), ROOF.floorY, `floor at ${x},${z}`);
    assert.ok(capsuleHasClearance(new THREE.Vector3(x, ROOF.floorY + 0.02, z), 0.36, 1.98, fixture.colliders), `body at ${x},${z}`);
  }
});

test('a real capsule walks the longer roof route to its relocated scaffold opening', () => {
  const body = { position: new THREE.Vector3(-13.5, 14.02, -8.4), velocity: new THREE.Vector3(), radius: 0.32, height: 1.84, onGround: true };
  let distance = 0;
  for (const [x, y, z] of ROOF.route.slice(1)) {
    distance += Math.hypot(x - body.position.x, z - body.position.z);
    for (let frame = 0; frame < 1200; frame++) {
      const dx = x - body.position.x, dz = z - body.position.z, length = Math.hypot(dx, dz);
      if (length < 0.035 && Math.abs(body.position.y - y) < 0.05) break;
      const speed = Math.min(4.2, length * 120);
      body.velocity.set(dx / Math.max(length, 0.0001) * speed, body.velocity.y - 22 / 120, dz / Math.max(length, 0.0001) * speed);
      moveCapsule(body, 1 / 120, fixture.colliders, true);
    }
    assert.ok(body.position.distanceTo(new THREE.Vector3(x, y, z)) < 0.06, `route stopped at ${body.position.toArray()}`);
  }
  assert.ok(distance > 38, `route too short: ${distance}`);
  const opening = OPENINGS.roofScaffold;
  assert.ok(body.position.x > opening.min[0] + body.radius && body.position.x < opening.max[0] - body.radius);
});

test('roof annexes and mechanical room have grounded masses, connected decks and visible supports', () => {
  for (const [id, record] of fixture.records) {
    const actual = new THREE.Box3().setFromObject(record.mesh);
    assert.ok(actual.min.distanceTo(record.bounds.min) < 1e-5 && actual.max.distanceTo(record.bounds.max) < 1e-5, id);
    if (id.includes('-volume')) assert.equal(record.bounds.min.y, 0, `${id} reaches grade`);
    if (id.startsWith('roof-annex-') && id.endsWith('-deck')) {
      const support = fixture.records.get(record.supports[0]);
      assert.ok(support, id);
      assert.ok(Math.abs(record.bounds.min.y - support.bounds.max.y) < 1e-5, `${id} rests on the building`);
    }
  }
});

test('flush metal scaffold lip declares surface ownership without adding collision or moving the exit', () => {
  const lip = fixture.records.get('roof-scaffold-threshold');
  assert.ok(lip, 'the exit lip participates in the static surface ownership pass');
  assert.equal(lip.kind, 'threshold');
  assert.equal(lip.supportKind, 'anchored');
  assert.deepEqual(lip.supports, ['roof-annex-east-deck']);
  assert.equal(lip.collider, null, 'the previously decorative lip must not extend the collision floor');
  assert.equal(lip.mesh.geometry.type, 'BoxGeometry');
  assert.equal(lip.mesh.material.transparent, false);
  const actual = new THREE.Box3().setFromObject(lip.mesh);
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
  for (const [coordinate, min, max] of [['x', 19.1, 24.9], ['y', 13.91, 14], ['z', -0.1, 0.24]]) {
    near(actual.min[coordinate], min, `lip min ${coordinate}`);
    near(actual.max[coordinate], max, `lip max ${coordinate}`);
    near(lip.bounds.min[coordinate], min, `registered min ${coordinate}`);
    near(lip.bounds.max[coordinate], max, `registered max ${coordinate}`);
  }
  const deck = fixture.records.get(lip.supports[0]).bounds;
  assert.ok(actual.intersectsBox(deck), 'the flush lip remains attached to the annex deck');
  const overlapWidth = Math.min(actual.max.x, deck.max.x) - Math.max(actual.min.x, deck.min.x);
  const overlapDepth = Math.min(actual.max.z, deck.max.z) - Math.max(actual.min.z, deck.min.z);
  near(overlapWidth * overlapDepth, 0.58, 'the explicit threshold owns only the original overlapping strip');
});
