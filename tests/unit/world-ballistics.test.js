import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { Colliders } from '../../src/core/collision.js';
import { isSegmentOccluded } from '../../src/game/combat-rules.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { resolveSurfaceOwnership } from '../../src/world/surface-ownership.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';

const fixture = buildWorldSurfaceFixture();
resolveSurfaceOwnership(fixture.records.values());

// The existing CPU world fixture has a no-op canvas. Supply pixels for its
// authored 32px diamond screen instead of pretending those no-op draw calls
// produced an image. Physical frames, panels, UVs and transforms remain real.
const maskSize = 32;
const maskPixels = new Uint8Array(maskSize * maskSize * 4);
for (let row = 0; row < maskSize; row++) {
  for (let column = 0; column < maskSize; column++) {
    const x = column + 0.5, y = row + 0.5;
    const distance = Math.min(Math.abs(x + y - 16), Math.abs(x + y - 48),
      Math.abs(x - y - 16), Math.abs(x - y + 16)) / Math.SQRT2;
    const offset = (row * maskSize + column) * 4;
    maskPixels.set([103, 115, 108, distance <= 0.625 ? 255 : 0], offset);
  }
}
const screenMask = new THREE.DataTexture(maskPixels, maskSize, maskSize);
screenMask.wrapS = screenMask.wrapT = THREE.RepeatWrapping;
screenMask.magFilter = screenMask.minFilter = THREE.LinearFilter;
screenMask.flipY = true;
screenMask.needsUpdate = true;
for (const { mesh } of fixture.entries) {
  if (mesh.material.alphaTest > 0 && mesh.material.map?.isCanvasTexture) mesh.material.map = screenMask;
}

const index = createBallisticWorld({ colliders: Colliders });
index.rebuild(fixture.World);

const vector = point => new THREE.Vector3(...point);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-5,
  `${label}: ${actual} != ${expected}`);

function meshAt(position) {
  const point = vector(position);
  const matches = fixture.entries.filter(entry => entry.zone === 'neighbor' && entry.mesh.position.distanceTo(point) < 1e-6);
  assert.equal(matches.length, 1, `one authored mesh at ${position.join(', ')}`);
  return matches[0].mesh;
}

function assertSolidSegment(label, start, end, expectedObject, axis, surfaceCoordinates, { twoSided = false } = {}) {
  for (const [directionIndex, [a, b]] of [[start, end], [end, start]].entries()) {
    const origin = vector(a), target = vector(b), range = origin.distanceTo(target);
    const direction = target.clone().sub(origin).normalize();
    const hit = index.raycast(origin, direction, range, 'bullet');
    assert.ok(hit, `${label}: solid from side ${directionIndex}`);
    assert.equal(hit.object, expectedObject, `${label}: exact rendered member from side ${directionIndex}`);
    assert.equal(hit.material, expectedObject.material, `${label}: rendered material`);
    near(hit.point[axis], surfaceCoordinates[directionIndex], `${label}: contact surface`);
    near(hit.distance, Math.abs(origin[axis] - surfaceCoordinates[directionIndex]), `${label}: contact distance`);
    near(hit.normal.length(), 1, `${label}: unit normal`);
    assert.ok((twoSided ? Math.abs(hit.normal.dot(direction)) : -hit.normal.dot(direction)) > 0.99,
      `${label}: surface normal follows the actual face`);
    for (const channel of ['bullet', 'sight']) {
      assert.equal(index.segmentOccluded(origin, target, channel), true, `${label}: ${channel} blocked from side ${directionIndex}`);
    }
  }
}

function assertClearSegment(label, start, end) {
  for (const [a, b] of [[start, end], [end, start]]) {
    const origin = vector(a), target = vector(b);
    assert.equal(index.raycast(origin, target.clone().sub(origin).normalize(), origin.distanceTo(target), 'bullet'), null,
      `${label}: no invisible bullet cover`);
    for (const channel of ['bullet', 'sight']) {
      assert.equal(index.segmentOccluded(origin, target, channel), false, `${label}: ${channel} sees the opening`);
    }
  }
}

for (const [name, x, facing] of [['left', 1.7, 1], ['right', 4.3, -1]]) {
  test(`real ${name} dining chair blocks its seat, back and all four legs from both sides`, () => {
    const backX = x - facing * 0.19;
    assertSolidSegment(`${name} seat`, [x, 4.415, -5.6], [x, 4.415, -4.4],
      meshAt([x, 4.415, -5]), 'z', [-5.2, -4.8]);
    assertSolidSegment(`${name} back`, [backX - 0.35, 4.82, -5], [backX + 0.35, 4.82, -5],
      meshAt([backX, 4.72, -5]), 'x', [backX - 0.025, backX + 0.025]);
    for (const dx of [-0.15, 0.15]) {
      for (const dz of [-0.15, 0.15]) {
        const z = -5 + dz, legX = x + dx;
        const start = [legX, 4.195, z - 0.12], end = [legX, 4.195, z + 0.12];
        assert.equal(isSegmentOccluded(vector(start), vector(end), Colliders.list), false,
          'this decorative leg is not already protected by a movement box');
        assertSolidSegment(`${name} leg ${dx}, ${dz}`, start, end,
          meshAt([legX, 4.195, z]), 'z', [z - 0.0275, z + 0.0275]);
      }
    }
  });

  test(`real ${name} dining chair preserves the openings under and above its seat`, () => {
    assertClearSegment(`${name} between legs`, [x, 4.195, -5.6], [x, 4.195, -4.4]);
    assertClearSegment(`${name} above seat beside back`, [x, 4.6, -5.6], [x, 4.6, -4.4]);
  });
}

test('the actual CRT and television case stop shots at their front, rear and side surfaces', () => {
  const screen = meshAt([7.05, 5.105, -7.26]), housing = meshAt([7, 5.105, -6.99]);
  const front = vector([7.05, 5.105, -7.7]), rear = vector([7.05, 5.105, -6.3]);
  assert.equal(isSegmentOccluded(front, rear, Colliders.list), false, 'the TV has no movement collider at screen height');
  for (const [origin, target, object, coordinate] of [[front, rear, screen, -7.28], [rear, front, housing, -6.74]]) {
    const hit = index.raycast(origin, target.clone().sub(origin).normalize(), origin.distanceTo(target));
    assert.equal(hit?.object, object, 'nearest visible TV component wins');
    near(hit.point.z, coordinate, 'TV face');
    assert.equal(index.segmentOccluded(origin, target, 'bullet'), true);
    assert.equal(index.segmentOccluded(origin, target, 'sight'), true);
  }
  assertSolidSegment('TV case sides', [6.2, 5.36, -6.99], [7.8, 5.36, -6.99], housing, 'x', [6.5, 7.5]);
});

test('the television does not fill the gap between its feet or the air beside its case', () => {
  assertClearSegment('TV stand foot gap', [7, 4.805, -7.5], [7, 4.805, -6.4]);
  assertClearSegment('beside TV above console', [7.55, 5.1, -7.5], [7.55, 5.1, -6.4]);
});

test('all four real stair guards block their balusters and sloped rails, not the spaces between', () => {
  for (const flight of STAIRS.flights) {
    const guard = fixture.records.get(`${flight.id}-central-guard`).mesh;
    const tread = flight.treads[6], next = flight.treads[7];
    const postZ = (tread.z1 + tread.z2) / 2, nextZ = (next.z1 + next.z2) / 2;
    const railZ = (postZ + nextZ) / 2, meanFloor = (tread.topY + next.topY) / 2;
    const x1 = flight.guardX - 0.55, x2 = flight.guardX + 0.25;
    const surfaces = [flight.guardX - 0.0225, flight.guardX + 0.0225];
    assertSolidSegment(`${flight.id} baluster`, [x1, tread.topY + 0.3, postZ], [x2, tread.topY + 0.3, postZ], guard, 'x', surfaces);
    for (const height of [0.54, STAIRS.guardHeight]) {
      assertSolidSegment(`${flight.id} sloped rail ${height}`, [x1, meanFloor + height, railZ], [x2, meanFloor + height, railZ],
        guard, 'x', surfaces);
    }
    assertClearSegment(`${flight.id} between balusters`, [x1, meanFloor + 0.32, railZ], [x2, meanFloor + 0.32, railZ]);

    // This ray crosses a short sloping member's movement AABB, but passes
    // above its actual inclined surface. Even per-member boxes are too coarse.
    const start = [x1, meanFloor + 0.62, railZ], end = [x2, meanFloor + 0.62, railZ];
    assert.equal(isSegmentOccluded(vector(start), vector(end), Colliders.list), true, `${flight.id}: exercises the old false cover`);
    assertClearSegment(`${flight.id} above inclined rail`, start, end);
  }
});

test('the roof landing guard retains its open bays instead of acting as a solid panel', () => {
  const guard = fixture.records.get('stair-roof-landing-guard').mesh;
  assertSolidSegment('roof landing rail', [-20.68, 14.54, -7.6], [-20.68, 14.54, -6.8],
    guard, 'z', [-7.1625, -7.1175]);
  assertClearSegment('roof landing open bay', [-20.68, 14.3, -7.6], [-20.68, 14.3, -6.8]);
});

const southScreen = fixture.records.get('balcony-screen-south').mesh;
const screenFrame = southScreen.children.find(mesh => mesh.isMesh && !mesh.material.alphaTest);
const screenPanel = southScreen.children.find(mesh => mesh.material.alphaTest > 0);

function screenPixelPoint(column, row) {
  const { width, height } = screenPanel.geometry.parameters;
  const uv = screenPanel.geometry.attributes.uv;
  const uScale = Math.max(...Array.from({ length: uv.count }, (_, i) => uv.getX(i)));
  const vScale = Math.max(...Array.from({ length: uv.count }, (_, i) => uv.getY(i)));
  const nearPoint = screenPanel.worldToLocal(vector([0, 5.6, 1.75]));
  const uRepeat = Math.floor((nearPoint.x / width + 0.5) * uScale);
  const vRepeat = Math.floor((nearPoint.y / height + 0.5) * vScale);
  return screenPanel.localToWorld(new THREE.Vector3(
    ((uRepeat + (column + 0.5) / maskSize) / uScale - 0.5) * width,
    ((vRepeat + 1 - (row + 0.5) / maskSize) / vScale - 0.5) * height, 0,
  ));
}

test('the real balcony screen frame stops shots at its top rail, waist rail and vertical post', () => {
  for (const [label, x, y] of [['top rail', 0, 6.665], ['waist rail', 0, 5.1], ['post', 0.193, 5.6]]) {
    assertSolidSegment(`balcony ${label}`, [x, y, 1.2], [x, y, 2.3], screenFrame, 'z', [1.71, 1.79]);
  }
});

test('the authored balcony panel uses the local fixture mask without filling its transparent holes', () => {
  const air = screenPixelPoint(16, 16), wire = screenPixelPoint(8, 7);
  const airStart = [air.x, air.y, 1.2], airEnd = [air.x, air.y, 2.3];
  assert.equal(isSegmentOccluded(vector(airStart), vector(airEnd), Colliders.list), true,
    'the movement boundary deliberately fills the screen, unlike bullet cover');
  assertClearSegment('balcony diamond opening', airStart, airEnd);
  assertSolidSegment('balcony visible diamond wire', [wire.x, wire.y, 1.2], [wire.x, wire.y, 2.3],
    screenPanel, 'z', [1.75, 1.75], { twoSided: true });
});

test('world insertion order cannot move the nearest TV impact behind its visible screen', () => {
  const originalOrder = [...fixture.World.children];
  const colliderRevision = Colliders.revision, colliderBounds = Colliders.list.map(box => box.clone());
  try {
    fixture.World.children.reverse();
    index.rebuild(fixture.World);
    const origin = vector([7.05, 5.105, -7.7]), direction = vector([0, 0, 1]);
    const hit = index.raycast(origin, direction, 1.4);
    assert.equal(hit?.object, meshAt([7.05, 5.105, -7.26]));
    near(hit.distance, 0.42, 'nearest front surface regardless of traversal order');
    assert.equal(index.raycast(origin, direction, 0.4), null, 'a target before the screen is unobstructed');
    assert.equal(Colliders.revision, colliderRevision, 'ballistic rebuild does not change movement collision');
    assert.equal(Colliders.list.length, colliderBounds.length);
    assert.ok(Colliders.list.every((box, i) => box.equals(colliderBounds[i])), 'authored movement bounds remain unchanged');
  } finally {
    fixture.World.children.splice(0, fixture.World.children.length, ...originalOrder);
    index.rebuild(fixture.World);
  }
});

test('a local full-world query visits only a fraction of the registered mesh geometry', () => {
  const hit = index.raycast(vector([7.05, 5.105, -7.7]), vector([0, 0, 1]), 1.4);
  assert.ok(hit);
  const stats = index.snapshot();
  assert.equal(stats.ready, true);
  assert.ok(stats.objects > 100, 'test retains the full authored world, not just one room');
  assert.ok(stats.geometryCount > 0 && stats.triangles > 0 && stats.nodes > 0);
  assert.ok(stats.lastQuery.nodes > 0 && stats.lastQuery.nodes <= stats.nodes);
  assert.ok(stats.lastQuery.objects > 0 && stats.lastQuery.objects < stats.objects / 4,
    'spatial traversal rejects distant objects before triangle checks');
  assert.ok(stats.lastQuery.triangles > 0 && stats.lastQuery.triangles < stats.triangles / 5,
    'a shot at the TV does not scan every authored triangle');
});
