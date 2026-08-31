import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildStreetAftermath } from '../../src/render/street-aftermath.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { DISTRICT } from '../../src/world/district-layout.js';

function fixture() {
  const world = new THREE.Group();
  const materials = Object.fromEntries(['wood', 'metal', 'tar'].map(name => {
    const material = new THREE.MeshStandardMaterial({ color: name === 'wood' ? 0x6f5537 : name === 'tar' ? 0x222722 : 0x626860 });
    material.name = 'surface-' + name; material.userData = { surfaceKind: name, surfaceMeters: 2 };
    return [name, material];
  }));
  const colliderBoxes = [];
  const colliders = { addBoxBySize(x, y, z, width, height, depth) {
    const bounds = new THREE.Box3(new THREE.Vector3(x - width / 2, y - height / 2, z - depth / 2),
      new THREE.Vector3(x + width / 2, y + height / 2, z + depth / 2));
    colliderBoxes.push(bounds); return bounds;
  } };
  const result = buildStreetAftermath({ world, materials, colliders });
  world.updateMatrixWorld(true);
  return { world, materials, colliderBoxes, result };
}

const f = fixture(), floor = DISTRICT.street.farWalk.floorY;
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-5, `${label}: ${a} != ${b}`);
const intersectsXZ = (bounds, x, z, radius) => bounds.min.x < x + radius && bounds.max.x > x - radius
  && bounds.min.z < z + radius && bounds.max.z > z - radius;

test('aftermath debris forms two bounded incidents clear of the bakery, car and through sidewalk', () => {
  assert.equal(f.result.clusters.length, 2);
  for (const { role, bounds } of f.result.pieces) {
    assert.ok(bounds.min.x > -15.6 && bounds.max.x < -2, `${role}: remains on the deli/market frontage`);
    assert.ok(bounds.min.z > 25.5 && bounds.max.z < DISTRICT.street.frontageZ, `${role}: stays behind the open curb lane`);
    for (const point of DISTRICT.bakery.accessRoute) assert.equal(intersectsXZ(bounds, point.x, point.z, 1), false, `${role}: bakery route`);
    assert.equal(intersectsXZ(bounds, DISTRICT.car.x, DISTRICT.car.z, DISTRICT.car.commitRadius + 1), false, `${role}: car approach`);
    assert.equal(intersectsXZ(bounds, -12, 26.6, 0.36), false, `${role}: existing deli bin`);
  }
  const produce = f.result.pieces.filter(piece => piece.role === 'spilled-produce');
  assert.ok(produce.length >= 12 && produce.length <= 20);
  assert.ok(produce.some(piece => piece.bounds.min.z < 26), 'spill trails from the crate toward the curb');
  assert.ok(f.result.pieces.some(piece => piece.role === 'broken-display-opening'));
  assert.ok(f.result.pieces.some(piece => piece.role === 'fallen-coffee-sign'));
});

test('the overturned crate rests on the pavement with an exact visual movement envelope', () => {
  assert.equal(f.colliderBoxes.length, 1);
  const visual = new THREE.Box3();
  for (const piece of f.result.pieces.filter(piece => piece.role === 'overturned-crate')) visual.union(piece.bounds);
  assert.ok(visual.equals(f.colliderBoxes[0]), 'the collider uses the actual transformed slatted shell');
  near(visual.min.y, floor, 'crate support');
  assert.ok(visual.max.y > floor + 0.6 && visual.max.y < floor + 0.75);
  for (const piece of f.result.pieces.filter(piece => piece.support === 'pavement')) {
    assert.ok(piece.bounds.min.y >= floor - 1e-5, `${piece.role}: no buried ground detail`);
    assert.ok(piece.bounds.max.y <= floor + 0.26, `${piece.role}: loose debris stays below a walking step`);
  }
  for (const piece of f.result.pieces.filter(piece => ['spilled-produce', 'fallen-glass', 'splintered-slat'].includes(piece.role))) {
    assert.ok(piece.bounds.min.y <= floor + 0.005, `${piece.role}: contact stays within five millimetres of pavement`);
  }
});

test('deli damage follows the real shop display and glass fragments embed instead of floating in front', () => {
  const display = { x1: -15.55, x2: -11.25, y1: 0.82, y2: 3.0, glassFront: DISTRICT.street.frontageZ - 0.092 };
  const facade = f.result.pieces.filter(piece => piece.support === 'storefront-mass-1');
  for (const piece of facade) {
    assert.ok(piece.bounds.min.x >= display.x1 && piece.bounds.max.x <= display.x2);
    assert.ok(piece.bounds.min.y >= display.y1 && piece.bounds.max.y <= display.y2);
    assert.ok(piece.bounds.min.z < display.glassFront, `${piece.role}: visible on the street side of glazing`);
    if (piece.role !== 'broken-display-opening') {
      assert.ok(piece.bounds.max.z > display.glassFront, `${piece.role}: edge embeds in the original pane`);
    }
  }
});

test('static aftermath uses five opaque draws, two untextured materials and no lights', () => {
  assert.equal(f.result.group.parent, f.world);
  assert.ok(f.result.draws <= 5);
  assert.ok(f.result.triangles <= 2600, `${f.result.triangles} triangles`);
  assert.ok(f.result.geometryBytes < 200000, `${f.result.geometryBytes} geometry bytes`);
  assert.equal(f.result.addedMaterials, 2); assert.equal(f.result.addedTextures, 0); assert.equal(f.result.addedLights, 0);
  f.result.group.traverse(object => {
    assert.equal(Boolean(object.isLight), false);
    if (!object.isMesh) return;
    assert.equal(object.material.transparent, false);
    assert.equal(object.material.depthWrite, true);
    assert.equal(object.castShadow, false);
    for (const attribute of Object.values(object.geometry.attributes)) {
      assert.ok(Array.from(attribute.array).every(Number.isFinite));
    }
  });
  assert.equal(f.materials.wood.vertexColors, false, 'the shared wood finish is not modified');
  assert.equal(f.materials.tar.vertexColors, false, 'the shared dark finish is not modified');
});

test('real aftermath triangles meet projectiles while leaving eye-level routes unobstructed', () => {
  const index = createBallisticWorld({ colliders: null }); index.rebuild(f.world);
  const from = new THREE.Vector3(-14.15, 1.89, 27), towardDisplay = new THREE.Vector3(0, 0, 1);
  const hit = index.raycast(from, towardDisplay, 3, 'bullet');
  assert.ok(hit, 'the broken display mask and glass rim remain projectile-visible surfaces');
  near(hit.point.z, DISTRICT.street.frontageZ - 0.095, 'impact meets actual rendered opening');
  for (const z of [25.5, 26.3]) {
    for (const channel of ['bullet', 'sight']) assert.equal(index.segmentOccluded(
      new THREE.Vector3(-16, floor + 1.6, z), new THREE.Vector3(0, floor + 1.6, z), channel), false);
  }
  index.clear();
});
