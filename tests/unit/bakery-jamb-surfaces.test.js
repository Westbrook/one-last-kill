import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DISTRICT } from '../../src/world/district-layout.js';
import { capsuleHasClearance } from '../../src/core/collision.js';
import { buildWorldSurfaceFixture, findCoplanarBoxOverlaps } from './helpers/world-surface-fixture.js';

const fixture = buildWorldSurfaceFixture();
const b = DISTRICT.bakery;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
const frame = fixture.entries.filter(entry => entry.zone === 'bakery' && entry.source?.some(line => line.includes('buildBakeryDoorFrame')));
const uprights = frame.filter(entry => entry.bounds.max.y - entry.bounds.min.y > 1).sort((a, other) => a.bounds.min.x - other.bounds.min.x);
const head = frame.find(entry => entry.bounds.max.x - entry.bounds.min.x > 1);
const region = new THREE.Box3(new THREE.Vector3(-20.75, 0, 27.65), new THREE.Vector3(-16.75, 3.6, 28.3));
const entries = fixture.entries.filter(entry => entry.bounds.intersectsBox(region));

function firstSurface(origin, target, surfaces = entries) {
  const eye = new THREE.Vector3(...origin), direction = new THREE.Vector3(...target).sub(eye).normalize();
  const hits = new THREE.Raycaster(eye, direction).intersectObjects(surfaces.map(entry => entry.mesh), false);
  assert.ok(hits.length, 'authored surface is visible');
  const first = hits[0];
  const coincident = new Set(hits.filter(hit => Math.abs(hit.distance - first.distance) < 1e-6).map(hit => hit.object));
  assert.equal(coincident.size, 1, 'first visible hit has one surface owner');
  return first.object;
}

test('door casing is applied in front of masonry and preserves the full opening', () => {
  assert.equal(frame.length, 3, 'two uprights and one head casing');
  assert.equal(uprights.length, 2);
  const [left, right] = uprights, wallFront = b.z1 - b.wallThickness / 2;
  near(left.bounds.max.x, b.door.x1, 'left opening edge');
  near(right.bounds.min.x, b.door.x2, 'right opening edge');
  near(right.bounds.min.x - left.bounds.max.x, 3.5, 'clear doorway width');
  near(head.bounds.min.y, b.door.topY, 'head stays above the clear opening');
  near(head.bounds.min.x, left.bounds.min.x, 'head joins left upright');
  near(head.bounds.max.x, right.bounds.max.x, 'head joins right upright');
  for (const entry of frame) {
    near(entry.bounds.max.z, wallFront, 'casing stops at wall facade');
    near(entry.bounds.max.z - entry.bounds.min.z, 0.032, 'physical casing projection');
    assert.equal(entry.options.collide, false);
    assert.equal(entry.options.batched, true);
    assert.equal(entry.mesh.material.polygonOffset, false);
    assert.equal(entry.mesh.material.depthTest, true);
    assert.equal(entry.mesh.material.depthWrite, true);
    assert.equal(entry.mesh.renderOrder, 0);
  }
});

test('window sill and rails end at the casing instead of sharing the left reveal', () => {
  const trimEnd = uprights[0].bounds.min.x;
  const trims = entries.filter(entry => entry.bounds.min.x < -24
    && Math.abs(entry.bounds.max.x - trimEnd) < 1e-6
    && entry.bounds.max.z > b.z1 - b.wallThickness / 2);
  assert.equal(trims.filter(entry => entry.materialKey === 'concrete').length, 1, 'sill has a physical butt joint');
  assert.equal(trims.filter(entry => entry.materialKey === 'metal').length, 2, 'both horizontal rails end at the casing');
  for (const entry of trims) near(entry.bounds.max.x, b.door.x1 - 0.09, 'trim ends outside opening');
  const sill = trims.find(entry => entry.materialKey === 'concrete');
  const bottomRail = trims.filter(entry => entry.materialKey === 'metal').sort((a, other) => a.bounds.min.y - other.bounds.min.y)[0];
  near(bottomRail.bounds.min.y, sill.bounds.max.y, 'lower rail rests on the stone instead of passing through it');
  const owned = new Set([...frame, ...trims].map(entry => entry.mesh));
  const overlaps = findCoplanarBoxOverlaps({ ...fixture, entries }, { differentMaterialsOnly: false, minArea: 1e-7 });
  assert.ok(!overlaps.some(pair => owned.has(pair.a.entry.mesh) || owned.has(pair.b.entry.mesh)), 'frame and joined trim have no overlapping same-facing faces');
});

test('street and interior approach rays see one brick reveal rather than tied materials', () => {
  const rightWall = fixture.records.get('bakery-front-east').mesh;
  const leftWall = fixture.records.get('bakery-window-sill').mesh;
  const examples = [
    [[-18.75, 1.65, 27.5], [-17, 1.5, 27.94], rightWall],
    [[-18.75, 1.65, 27.5], [-20.5, 0.45, 27.94], leftWall],
    [[-18.75, 1.65, 28.55], [-17, 1.5, 28.03], rightWall],
    [[-18.75, 1.65, 28.55], [-20.5, 0.45, 28.03], leftWall],
    [[-19.25, 1.73, 28.45], [-20.5, 0.805, 27.9525], leftWall],
  ];
  for (const [eye, target, owner] of examples) assert.equal(firstSurface(eye, target), owner);
  for (const entry of frame) {
    const center = entry.bounds.getCenter(new THREE.Vector3());
    assert.equal(firstSurface([-18.75, 1.65, 27.5], [center.x, center.y, entry.bounds.min.z]), entry.mesh, 'applied metal face stays visible');
  }
});

test('brick and glazing colliders and standing entry routes remain unchanged', () => {
  const right = fixture.records.get('bakery-front-east').collider;
  const sill = fixture.records.get('bakery-window-sill').collider;
  near(right.min.x, b.door.x2, 'right collision edge');
  near(right.min.z, b.z1 - b.wallThickness / 2, 'right collision front');
  near(right.max.z, b.z1 + b.wallThickness / 2, 'right collision back');
  near(sill.max.x, b.door.x1, 'left collision edge');
  near(sill.max.y, 0.85, 'window sill collision height');
  const glazing = fixture.records.get('bakery-display-window-2').collider;
  near(glazing.max.x, b.door.x1 - 0.035, 'unchanged glazing edge');
  near(glazing.min.z, b.z1 - 0.0325, 'unchanged glazing front');
  for (const z of [27.5, 27.89, 28, 28.3, 29]) {
    for (const x of [b.door.x1 + 0.33, -18.75, b.door.x2 - 0.33]) {
      assert.ok(capsuleHasClearance(new THREE.Vector3(x, 0.16, z), 0.32, 1.84, fixture.colliders), `standing entry ${x},${z}`);
    }
  }
});

test('physical fascia corner returns cover the exposed slab join without changing its structures', () => {
  const caps = fixture.entries.filter(entry => entry.source?.some(line => line.includes('buildBakeryFasciaCorners')));
  const ceiling = fixture.records.get('bakery-ceiling'), fascia = fixture.records.get('bakery-fascia');
  assert.equal(caps.length, 2);
  near(ceiling.bounds.min.x, b.x1, 'ceiling west bounds unchanged');
  near(ceiling.bounds.max.x, b.x2, 'ceiling east bounds unchanged');
  near(ceiling.bounds.min.y, b.ceilingY, 'ceiling underside unchanged');
  near(ceiling.bounds.max.y, b.ceilingY + 0.16, 'ceiling top unchanged');
  near(fascia.bounds.min.x, b.x1, 'fascia west bounds unchanged');
  near(fascia.bounds.max.x, b.x2, 'fascia east bounds unchanged');
  assert.ok(ceiling.collider.equals(ceiling.bounds) && fascia.collider.equals(fascia.bounds));
  assert.deepEqual(ceiling.supports, ['bakery-west', 'bakery-east', 'bakery-back', 'bakery-header']);
  assert.deepEqual(fascia.supports, ['bakery-header', 'bakery-west', 'bakery-east']);
  for (const cap of caps) {
    const center = cap.bounds.getCenter(new THREE.Vector3());
    const sign = center.x < (b.x1 + b.x2) / 2 ? -1 : 1;
    const sideX = sign < 0 ? b.x1 : b.x2;
    near(sign < 0 ? sideX - cap.bounds.min.x : cap.bounds.max.x - sideX, 0.03, 'stone return projects 30 mm');
    assert.ok(cap.bounds.intersectsBox(ceiling.bounds) && cap.bounds.intersectsBox(fascia.bounds), 'corner finish bridges both substrates');
    assert.equal(cap.options.batched, true);
    assert.equal(cap.options.collide, false);
    assert.equal(cap.mesh.renderOrder, 0);
    assert.equal(cap.mesh.material.polygonOffset, false);
    const surfaces = [cap, { mesh: ceiling.mesh }, { mesh: fascia.mesh }];
    for (const y of [4.11, 4.18, 4.25]) for (const z of [28.01, 28.07, 28.12]) {
      const target = [sideX, y, z];
      assert.ok(cap.bounds.containsPoint(new THREE.Vector3(...target)), 'old coincident patch is enclosed by the return');
      for (const offset of [0.6, 2, 3]) {
        assert.equal(firstSurface([sideX + sign * offset, 1.7, 26.5], target, surfaces), cap.mesh, 'far-sidewalk view sees the physical corner finish first');
      }
    }
    const region = cap.bounds.clone().expandByScalar(0.03);
    const local = fixture.entries.filter(entry => entry.bounds.intersectsBox(region));
    const overlaps = findCoplanarBoxOverlaps({ ...fixture, entries: local }, { differentMaterialsOnly: false });
    assert.ok(!overlaps.some(pair => pair.a.entry.mesh === cap.mesh || pair.b.entry.mesh === cap.mesh), 'corner return adds no coplanar face');
  }
});
