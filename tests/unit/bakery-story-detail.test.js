import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildBakeryStoryDetail } from '../../src/render/bakery-story-detail.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { HEALTH_SUPPLIES } from '../../src/game/health-supply-data.js';
import { DISTRICT } from '../../src/world/district-layout.js';

const fixture = buildWorldSurfaceFixture();
const materials = new Proxy({}, { get: (_, key) => fixture.materials.get(key) });
const root = buildBakeryStoryDetail(fixture.World, materials);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

test('bakery vignette rests on the actual prep island and clears all existing bread boards', () => {
  assert.ok(root);
  const support = new THREE.Box3().setFromObject(fixture.World.getObjectByName('bakery-prep-island-top'));
  const bounds = new THREE.Box3().setFromObject(root);
  near(bounds.min.y, support.max.y);
  assert.ok(bounds.min.x > support.min.x && bounds.max.x < support.max.x);
  assert.ok(bounds.min.z > support.min.z && bounds.max.z < support.max.z);
  near(root.userData.storyDetail.x, -28.5); near(root.userData.storyDetail.z, 38.8);
  near(bounds.max.y - bounds.min.y, 0.087);
  for (const x of [-29.25, -27.75, -26.25]) {
    const board = fixture.entries.find(({ mesh }) => Math.abs(mesh.position.x - x) < 1e-6 && Math.abs(mesh.position.y - 1.279) < 1e-6);
    assert.ok(board, `existing board ${x} is exercised`);
    const existing = new THREE.Box3().setFromObject(board.mesh);
    assert.equal(bounds.intersectsBox(existing), false);
    assert.ok(Math.max(existing.min.x - bounds.max.x, bounds.min.x - existing.max.x) >= 0.0699);
  }
});

test('small prep dressing preserves health supply approach lines and the authored bakery route', () => {
  const index = createBallisticWorld({ colliders: null }); index.rebuild(root);
  for (const pack of HEALTH_SUPPLIES.filter(item => item.zone === 'bakery')) {
    const target = new THREE.Vector3(pack.x, pack.y + 0.12, pack.z);
    for (const [dx, dz] of [[0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) {
      const origin = new THREE.Vector3(pack.x + dx, pack.y + 1.65, pack.z + dz);
      assert.equal(index.segmentOccluded(origin, target), false, pack.id);
    }
  }
  for (let i = 1; i < DISTRICT.bakery.accessRoute.length; i++) {
    const previous = DISTRICT.bakery.accessRoute[i - 1], next = DISTRICT.bakery.accessRoute[i];
    const a = new THREE.Vector3(previous.x, previous.y + 1.5, previous.z);
    const b = new THREE.Vector3(next.x, next.y + 1.5, next.z);
    assert.equal(index.segmentOccluded(a, b), false);
  }
  assert.equal(index.segmentOccluded(new THREE.Vector3(-28.5, 1.32, 37.5), new THREE.Vector3(-28.5, 1.32, 39.5)), true,
    'actual rolling-pin geometry remains a solid instead of opting out of ballistics');
  index.clear();
});

test('merged story geometry reuses three opaque finishes and missing supports produce no floating props', () => {
  assert.equal(root.userData.storyDetail.triangles, 504);
  assert.equal(root.children.length, 3);
  assert.ok(root.children.every(mesh => mesh.isMesh && !mesh.material.transparent && !mesh.castShadow));
  assert.equal(buildBakeryStoryDetail(new THREE.Group(), materials), null);
  assert.equal(root.userData.storyDetail.geometryBytes, 16720);
});
