import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createConcreteBarrierGeometry, concreteBarrierFace, refineConcreteBarrier } from '../../src/render/street-barrier.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';
import { DISTRICT } from '../../src/world/district-layout.js';

const near = (a, b, label = '', epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${label}: ${a} != ${b}`);
const spec = DISTRICT.street.cover.find(item => item.id === 'street-cover-center');
const fixture = buildWorldSurfaceFixture();
const record = fixture.records.get(spec.id), mesh = record.mesh;
const reflectors = fixture.entries.map(entry => entry.mesh).filter(object => object.geometry?.userData.concreteBarrierReflector);
const actual = new THREE.Group(); actual.add(mesh.clone(false), ...reflectors.map(object => object.clone(false)));
const index = createBallisticWorld({ colliders: null }); index.rebuild(actual);

test('real concrete barrier keeps the old outer AABB, support, collider, height, material and shadow caster', () => {
  const reference = new THREE.Mesh(new THREE.BoxGeometry(spec.width, spec.height, spec.depth));
  reference.position.set(spec.x, DISTRICT.street.road.floorY + spec.height / 2, spec.z);
  const expected = new THREE.Box3().setFromObject(reference), bounds = new THREE.Box3().setFromObject(mesh);
  assert.ok(bounds.equals(expected), 'every extremum is identical to the previous box');
  assert.ok(record.collider.equals(record.bounds));
  near(bounds.min.y, DISTRICT.street.road.floorY);
  near(bounds.max.y, DISTRICT.street.road.floorY + spec.height);
  assert.deepEqual(record.supports, ['street-road']); assert.equal(record.kind, 'cover');
  assert.equal(mesh.material, fixture.materials.get('concrete'));
  assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, true);
  assert.equal(reflectors.length, 2, 'the original two reflectors are replaced, not duplicated');
});

test('actual barrier rays meet the toe, lower shoulder and crown at their shaped contact surfaces', () => {
  for (const aboveFloor of [0.05, 0.25, 0.55, 0.83, 0.94]) {
    const y = DISTRICT.street.road.floorY + aboveFloor;
    const expected = concreteBarrierFace(spec.height, spec.depth, aboveFloor);
    for (const side of [-1, 1]) {
      const origin = new THREE.Vector3(spec.x, y, spec.z + side * 2), direction = new THREE.Vector3(0, 0, -side);
      const hit = index.raycast(origin, direction, 4);
      assert.ok(hit, `height ${aboveFloor}, side ${side}`);
      near(hit.point.z, spec.z - side * expected.z, 'visible concrete face', 2e-6);
      near(hit.normal.y, expected.slope / Math.hypot(expected.slope, 1), 'sloped contact normal');
      near(hit.normal.z, side / Math.hypot(expected.slope, 1));
    }
  }
  const top = index.raycast(new THREE.Vector3(spec.x, 3, spec.z), new THREE.Vector3(0, -1, 0), 3);
  near(top.point.y, DISTRICT.street.road.floorY + spec.height, 'old top height');
  const foot = index.raycast(new THREE.Vector3(spec.x, -1, spec.z), new THREE.Vector3(0, 1, 0), 2);
  near(foot.point.y, DISTRICT.street.road.floorY, 'grounded closed underside');
});

test('empty shoulder corners remain open to bullets while the middle solid still blocks', () => {
  const y = DISTRICT.street.road.floorY + 0.75;
  const outside = new THREE.Vector3(spec.x - 2, y, spec.z - 0.30), end = new THREE.Vector3(spec.x + 2, y, spec.z - 0.30);
  assert.ok(new THREE.Ray(outside, new THREE.Vector3(1, 0, 0)).intersectsBox(record.collider), 'old movement envelope is intentionally conservative');
  for (const channel of ['bullet', 'sight']) {
    assert.equal(index.segmentOccluded(outside, end, channel), false, 'the actual taper leaves this upper corner empty');
    assert.equal(index.segmentOccluded(new THREE.Vector3(spec.x - 2, y, spec.z), new THREE.Vector3(spec.x + 2, y, spec.z), channel), true);
  }
});

test('both reflector plates follow the actual upper face with a half-millimetre embedded back', () => {
  const aboveFloor = mesh.userData.concreteBarrier.reflectorHeight;
  const face = concreteBarrierFace(spec.height, spec.depth, aboveFloor);
  const normal = new THREE.Vector3(0, face.slope, -1).normalize();
  const planePoint = new THREE.Vector3(spec.x, DISTRICT.street.road.floorY + aboveFloor, spec.z + face.z);
  const point = new THREE.Vector3(), direction = new THREE.Vector3();
  for (const reflector of reflectors) {
    reflector.updateMatrixWorld(true);
    const positions = reflector.geometry.attributes.position, normals = reflector.geometry.attributes.normal;
    let rearVertices = 0;
    for (let i = 0; i < positions.count; i++) {
      direction.fromBufferAttribute(normals, i).transformDirection(reflector.matrixWorld);
      if (direction.dot(normal) > -0.999) continue;
      point.fromBufferAttribute(positions, i).applyMatrix4(reflector.matrixWorld);
      near(point.sub(planePoint).dot(normal), -0.0005, 'reflector back contact');
      rearVertices++;
    }
    assert.equal(rearVertices, 4);
  }
});

test('the 28-triangle profile is closed, consistently wound and bounded without extra material or draw work', () => {
  const geometry = mesh.geometry, positions = geometry.attributes.position, normals = geometry.attributes.normal;
  assert.equal(geometry.index.count / 3, 28);
  assert.equal(mesh.userData.concreteBarrier.addedTriangles, 16);
  const edges = new Map(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3(), face = new THREE.Vector3(), normal = new THREE.Vector3();
  const key = vertex => [vertex.x, vertex.y, vertex.z].map(value => value.toFixed(6)).join(',');
  for (let i = 0; i < geometry.index.count; i += 3) {
    const ids = [0, 1, 2].map(offset => geometry.index.getX(i + offset));
    a.fromBufferAttribute(positions, ids[0]); b.fromBufferAttribute(positions, ids[1]); c.fromBufferAttribute(positions, ids[2]);
    face.crossVectors(edge1.copy(b).sub(a), edge2.copy(c).sub(a));
    assert.ok(face.length() > 1e-6, 'no degenerate surface');
    for (const id of ids) assert.ok(face.dot(normal.fromBufferAttribute(normals, id)) > 0, 'stored normals agree with winding');
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      const edge = [key(start), key(end)].sort().join('|'); edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  assert.ok([...edges.values()].every(count => count === 2), 'every geometric edge belongs to exactly two triangles');
  for (const field of ['addedDraws', 'addedMaterials', 'addedTextures', 'addedLights']) assert.equal(mesh.userData.concreteBarrier[field], 0);
  for (const attribute of Object.values(geometry.attributes)) for (const value of attribute.array) assert.ok(Number.isFinite(value));
});

test('repeat refinement is inert and invalid dimensions do not create malformed geometry', () => {
  let decorations = 0;
  const same = refineConcreteBarrier(mesh, { pushDecor() { decorations++; }, reflectorMaterial: reflectors[0].material });
  assert.equal(same, mesh); assert.equal(decorations, 0);
  assert.throws(() => createConcreteBarrierGeometry(2, -1, 0.5), RangeError);
});
