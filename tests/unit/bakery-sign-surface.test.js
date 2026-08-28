import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DISTRICT } from '../../src/world/district-layout.js';
import { buildWorldSurfaceFixture, collectAxisAlignedBoxFaces, findCoplanarBoxOverlaps } from './helpers/world-surface-fixture.js';

const fixture = buildWorldSurfaceFixture();
const faces = collectAxisAlignedBoxFaces(fixture);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
const frontFace = (mesh) => faces.find(face => face.entry.mesh === mesh && face.axis === 'z' && face.sign === -1);

function localEntries(label) {
  const region = new THREE.Box3().setFromObject(label).expandByVector(new THREE.Vector3(0.12, 0.12, 0.18));
  return fixture.entries.filter(entry => entry.bounds.intersectsBox(region));
}

test('bakery family notice has a real anchored plaque between its face and the plaster', () => {
  const label = fixture.World.getObjectByName('bakery-family-notice');
  const board = fixture.records.get(label.userData.mountId);
  const wall = fixture.records.get('bakery-back');
  const labelFace = frontFace(label), boardFace = frontFace(board.mesh);
  const plaster = faces.find(face => face.axis === 'z' && face.sign === -1 && face.materialKey === 'plaster'
    && face.minU < labelFace.minU && face.maxU > labelFace.maxU
    && face.minV < labelFace.minV && face.maxV > labelFace.maxV
    && Math.abs(face.plane - (DISTRICT.bakery.z2 - 0.127)) < 1e-6);
  assert.ok(plaster, 'actual back-wall finish face exists');
  near(board.bounds.max.z - board.bounds.min.z, 0.024, 'wood backing thickness');
  near(boardFace.plane - labelFace.plane, 0.002, 'printed face clearance from board');
  near(plaster.plane - labelFace.plane, 0.024, 'printed face clearance from plaster');
  near(label.position.x, -18.8, 'unchanged horizontal placement');
  near(label.position.y, 2.63, 'unchanged vertical placement');
  assert.equal(label.material.name, 'sign:FAMILY COMES FIRST');
  assert.equal(board.collider, null, 'decorative backing adds no gameplay collision');
  assert.equal(board.supports.length, 2);
  for (const id of board.supports) {
    const anchor = fixture.records.get(id);
    assert.ok(anchor.bounds.intersectsBox(wall.bounds), id + ' enters the masonry');
    assert.ok(anchor.bounds.intersectsBox(board.bounds), id + ' reaches the board');
    assert.equal(anchor.collider, null);
  }
});

test('parking label is in front of both its backing and the unchanged collision post', () => {
  const label = fixture.World.getObjectByName('car-parking-sign');
  const board = fixture.records.get(label.userData.mountId);
  const post = fixture.records.get('car-placard-post');
  const labelFace = frontFace(label), boardFace = frontFace(board.mesh), postFace = frontFace(post.mesh);
  near(board.bounds.max.z - board.bounds.min.z, 0.03, 'parking backing thickness');
  near(boardFace.plane - labelFace.plane, 0.002, 'parking print-to-board clearance');
  near(postFace.plane - labelFace.plane, 0.028, 'parking print-to-post clearance');
  assert.ok(board.bounds.intersectsBox(post.bounds), 'board remains physically attached to post');
  const p = DISTRICT.car.placard;
  near(post.collider.min.x, p.x - 0.05, 'post collider west');
  near(post.collider.max.x, p.x + 0.05, 'post collider east');
  near(post.collider.min.z, p.z - 0.05, 'post collider front');
  near(post.collider.max.z, p.z + 0.05, 'post collider back');
  near(post.collider.min.y, p.y, 'post collider ground');
  near(post.collider.max.y, p.y + 2.26, 'post collider top');
  assert.equal(board.collider, null);
  assert.equal(label.material.name, "sign:GNUCCI'S");
});

test('both printed faces remain the first visible surface at frontal and oblique angles', () => {
  for (const name of ['bakery-family-notice', 'car-parking-sign']) {
    const label = fixture.World.getObjectByName(name), entries = localEntries(label);
    const board = fixture.records.get(label.userData.mountId).mesh;
    const coplanar = findCoplanarBoxOverlaps({ ...fixture, entries }, { differentMaterialsOnly: false });
    assert.ok(!coplanar.some(pair => [pair.a.entry.mesh, pair.b.entry.mesh].some(mesh => mesh === label || mesh === board)), name + ' has no overlapping same-facing support/label face');
    for (const [dx, dy] of [[0, 0], [-2.4, 0], [2.4, 0], [-1.7, 0.7], [1.7, -0.7]]) {
      const origin = label.position.clone().add(new THREE.Vector3(dx, dy, -2));
      const direction = label.position.clone().sub(origin).normalize();
      const hit = new THREE.Raycaster(origin, direction).intersectObjects(entries.map(entry => entry.mesh), false)[0];
      assert.equal(hit?.object, label, name + ' remains in front at ' + dx + ',' + dy);
    }
    assert.equal(label.renderOrder, 0);
    assert.equal(label.material.polygonOffset, false);
    assert.equal(label.material.depthTest, true);
    assert.equal(label.material.depthWrite, true);
    assert.equal(board.renderOrder, 0);
    assert.equal(board.material.polygonOffset, false);
  }
});
