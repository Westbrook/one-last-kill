import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ROOF, OPENINGS } from '../../src/world/layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { capsuleHasClearance } from '../../src/core/collision.js';
import { resolveSurfaceOwnership } from '../../src/world/surface-ownership.js';
import { buildWorldSurfaceFixture, findCoplanarBoxOverlaps } from './helpers/world-surface-fixture.js';

const fixture = buildWorldSurfaceFixture();
resolveSurfaceOwnership(fixture.records.values());
const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-6,
  `${label}: ${actual} != ${expected}`);
const halfWall = 0.13;
const parapets = [
  { id: 'roof-north-parapet', axis: 'z', side: 1, x1: ROOF.x1, x2: ROOF.x2, z1: ROOF.z1 - halfWall, z2: ROOF.z1 + halfWall },
  { id: 'roof-west-north-parapet', axis: 'x', side: 1, x1: STAIRS.roofThreshold.wallExteriorX, x2: ROOF.x1 + halfWall, z1: ROOF.z1, z2: OPENINGS.stairRoof.min[2] },
  { id: 'roof-west-south-parapet', axis: 'x', side: 1, x1: STAIRS.roofThreshold.wallExteriorX, x2: ROOF.x1 + halfWall, z1: OPENINGS.stairRoof.max[2], z2: ROOF.z2 },
  { id: 'roof-east-parapet', axis: 'x', side: -1, x1: ROOF.x2 - halfWall, x2: ROOF.x2 + halfWall, z1: ROOF.z1, z2: ROOF.z2 },
  { id: 'roof-south-parapet', axis: 'z', side: -1, x1: ROOF.x1, x2: ROOF.exit.x1, z1: ROOF.z2 - halfWall, z2: ROOF.z2 + halfWall },
  { id: 'lightwell-north-guard', axis: 'z', side: -1, x1: ROOF.lightwell.x1, x2: ROOF.lightwell.x2, z1: ROOF.lightwell.z1 - halfWall, z2: ROOF.lightwell.z1 + halfWall },
  { id: 'lightwell-west-guard', axis: 'x', side: -1, x1: ROOF.lightwell.x1 - halfWall, x2: ROOF.lightwell.x1 + halfWall, z1: ROOF.lightwell.z1, z2: ROOF.lightwell.z2 },
  { id: 'lightwell-east-guard', axis: 'x', side: 1, x1: ROOF.lightwell.x2 - halfWall, x2: ROOF.lightwell.x2 + halfWall, z1: ROOF.lightwell.z1, z2: ROOF.lightwell.z2 },
  { id: 'lightwell-south-guard', axis: 'z', side: 1, x1: ROOF.lightwell.x1, x2: ROOF.lightwell.x2, z1: ROOF.lightwell.z2 - halfWall, z2: ROOF.lightwell.z2 + halfWall },
];
const parapetIds = new Set(parapets.map(item => item.id));
const sheets = fixture.entries.filter(entry => entry.zone === 'roof' && entry.materialKey === 'roofMetal'
  && Math.abs(entry.bounds.min.y - ROOF.floorY) < 1e-6
  && Math.abs(entry.bounds.max.y - ROOF.floorY - 0.16) < 1e-6);
const sheetMeshes = new Set(sheets.map(entry => entry.mesh));

function sheetFor(parapet) {
  const brick = fixture.records.get(parapet.id).bounds;
  const tangent = parapet.axis === 'x' ? 'z' : 'x';
  const candidates = sheets.filter(entry => {
    const center = entry.bounds.getCenter(new THREE.Vector3());
    return center[tangent] > brick.min[tangent] && center[tangent] < brick.max[tangent]
      && Math.abs(center[parapet.axis] - (brick.min[parapet.axis] + brick.max[parapet.axis]) / 2) < 0.2;
  });
  assert.equal(candidates.length, 1, `${parapet.id} has one flashing sheet`);
  return candidates[0];
}

function firstOwners(origin, target, meshes = fixture.World.children) {
  const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
  const hits = ray.intersectObjects(meshes, true);
  assert.ok(hits.length, 'the ray must reach real visible geometry');
  const first = hits[0];
  assert.ok(first.point.distanceTo(target) < 1e-5, `ray stopped at ${first.point.toArray()} instead of ${target.toArray()}`);
  return [...new Set(hits.filter(hit => Math.abs(hit.distance - first.distance) < 1e-5)
    .map(hit => hit.object.userData.architectureId || hit.object.material.name))];
}

test('all nine parapet flashings sit outside brick as mounted two-centimetre sheets', () => {
  assert.equal(sheets.length, 9, 'each original assembly keeps a single batched sheet');
  for (const parapet of parapets) {
    const record = fixture.records.get(parapet.id), brick = new THREE.Box3().setFromObject(record.mesh);
    const sheet = sheetFor(parapet), bounds = new THREE.Box3().setFromObject(sheet.mesh);
    const face = parapet.side > 0 ? brick.max[parapet.axis] : brick.min[parapet.axis];
    const back = parapet.side > 0 ? bounds.min[parapet.axis] : bounds.max[parapet.axis];
    near(back, face, `${parapet.id} metal back touches its roof-facing brick surface`);
    near(bounds.max[parapet.axis] - bounds.min[parapet.axis], 0.02, `${parapet.id} sheet thickness`);
    assert.equal(sheet.mesh.userData.collider ?? null, null, 'flashing does not change collision');
    assert.equal(sheet.mesh.material.polygonOffset, false);
    assert.equal(sheet.mesh.material.depthTest, true);
    assert.equal(sheet.mesh.material.depthWrite, true);
  }
});

test('flashing face triangles never overlap brick or each other at parapet corners', () => {
  const overlaps = findCoplanarBoxOverlaps(fixture, { differentMaterialsOnly: false });
  const conflicts = overlaps.filter(hit => (sheetMeshes.has(hit.a.entry.mesh)
    && (parapetIds.has(hit.b.id) || sheetMeshes.has(hit.b.entry.mesh)))
    || (sheetMeshes.has(hit.b.entry.mesh) && parapetIds.has(hit.a.id)));
  assert.deepEqual(conflicts.map(hit => ({ ids: [hit.a.id, hit.b.id], axis: hit.axis, sign: hit.sign, area: hit.area })), []);
});

test('both exposed scaffold views see one masonry underside instead of tied brick and metal', () => {
  const probes = [
    { foot: [27, 10.02, 3.2], eye: [27, 11.65, 3.2], target: [25.075, 14, -0.6], id: 'roof-east-parapet' },
    { foot: [18, 10.02, 3.2], eye: [18, 11.65, 3.2], target: [17.5, 14, 0.065], id: 'roof-south-parapet' },
  ];
  for (const probe of probes) {
    assert.ok(capsuleHasClearance(new THREE.Vector3(...probe.foot), 0.32, 1.84, fixture.colliders), 'the scaffold viewpoint is physically clear');
    assert.deepEqual(firstOwners(new THREE.Vector3(...probe.eye), new THREE.Vector3(...probe.target)), [probe.id]);
  }
});

test('lightwell undersides retain a single exposed brick surface on three open sides', () => {
  const eye = new THREE.Vector3(-10, 11.6, -12.5);
  for (const [target, id] of [
    [[-10, 14, -14.925], 'lightwell-north-guard'],
    [[-12.425, 14, -12.5], 'lightwell-west-guard'],
    [[-7.575, 14, -12.5], 'lightwell-east-guard'],
  ]) assert.deepEqual(firstOwners(eye, new THREE.Vector3(...target)), [id]);
});

test('roof-facing metal remains visible in front of its brick without changing either depth plane', () => {
  for (const parapet of parapets) {
    const brick = fixture.records.get(parapet.id).mesh, sheet = sheetFor(parapet).mesh;
    const sheetBounds = new THREE.Box3().setFromObject(sheet);
    const aim = sheetBounds.getCenter(new THREE.Vector3());
    const origin = aim.clone(); origin[parapet.axis] += parapet.side * 0.5;
    const ray = new THREE.Raycaster(origin, aim.clone().sub(origin).normalize());
    const hits = ray.intersectObjects([sheet, brick], false);
    const metal = hits.find(hit => hit.object === sheet), masonry = hits.find(hit => hit.object === brick);
    assert.ok(metal && masonry, `${parapet.id} keeps both physical faces`);
    near(masonry.distance - metal.distance, 0.02, `${parapet.id} metal is mounted ahead of brick`);
  }
});

test('parapet solids and collision retain every authored edge, support and clear opening', () => {
  for (const parapet of parapets) {
    const record = fixture.records.get(parapet.id);
    for (const [axis, low, high] of [['x', parapet.x1, parapet.x2], ['z', parapet.z1, parapet.z2]]) {
      near(record.bounds.min[axis], low, `${parapet.id} min ${axis}`);
      near(record.bounds.max[axis], high, `${parapet.id} max ${axis}`);
      near(record.collider.min[axis], low, `${parapet.id} collider min ${axis}`);
      near(record.collider.max[axis], high, `${parapet.id} collider max ${axis}`);
    }
    near(record.bounds.min.y, ROOF.floorY);
    near(record.bounds.max.y, ROOF.floorY + (parapet.id.startsWith('lightwell-') ? 1.1 : 1.2));
    assert.ok(record.supports.length && record.supports.every(id => fixture.records.has(id)), `${parapet.id} retains its floor supports`);
  }
  for (const [x, y, z] of [STAIRS.roofExit, ...ROOF.route]) {
    assert.ok(capsuleHasClearance(new THREE.Vector3(x, y + 0.02, z), 0.32, 1.84, fixture.colliders), 'door and roof route remain clear');
  }
});

test('reintroducing the old wraparound flashing is detected by both triangles and the exposed ray', () => {
  const legacy = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, ROOF.z2 - ROOF.z1), fixture.materials.get('roofMetal'));
  legacy.position.set(ROOF.x2, ROOF.floorY + 0.08, (ROOF.z1 + ROOF.z2) / 2);
  legacy.updateMatrixWorld(true);
  const diagnostic = { ...fixture, entries: [...fixture.entries, { id: 'legacy-east-flashing', mesh: legacy }] };
  const overlaps = findCoplanarBoxOverlaps(diagnostic);
  const underside = overlaps.find(hit => hit.axis === 'y' && hit.sign === -1
    && [hit.a.id, hit.b.id].includes('legacy-east-flashing') && [hit.a.id, hit.b.id].includes('roof-east-parapet'));
  assert.ok(underside, 'the geometric test catches the prior exposed overlap');
  near(underside.area, 6.24);
  const brick = fixture.records.get('roof-east-parapet').mesh;
  assert.deepEqual(firstOwners(new THREE.Vector3(27, 11.65, 3.2), new THREE.Vector3(25.075, 14, -0.6), [brick, legacy]).sort(),
    ['roof-east-parapet', 'roofMetal'].sort());
  legacy.geometry.dispose();
});

test('south stone belts finish with physical end reveals instead of sharing the annex brick plane', () => {
  const belts = fixture.entries.filter(entry => entry.zone === 'roof' && entry.materialKey === 'agedStone'
    && Math.abs(entry.bounds.min.z + 0.05) < 1e-6 && Math.abs(entry.bounds.max.z - 0.13) < 1e-6
    && Math.abs(entry.bounds.max.y - entry.bounds.min.y - 0.18) < 1e-6);
  assert.equal(belts.length, 4);
  const beltMeshes = new Set(belts.map(entry => entry.mesh));
  for (const belt of belts) {
    near(belt.bounds.min.x, 13.02, 'west stone end has a two-centimetre reveal');
    near(belt.bounds.max.x, 24.98, 'east stone end has a two-centimetre reveal');
    assert.equal(belt.mesh.userData.collider ?? null, null);
  }
  const conflicts = findCoplanarBoxOverlaps(fixture).filter(hit => beltMeshes.has(hit.a.entry.mesh) || beltMeshes.has(hit.b.entry.mesh));
  assert.deepEqual(conflicts, [], 'stone ends retain their own planes instead of fighting the building surface');

  const origin = new THREE.Vector3(12.35, 8.65, 2.75), target = new THREE.Vector3(13, 7.2, -0.025);
  assert.ok(capsuleHasClearance(new THREE.Vector3(12.35, 7.02, 2.75), 0.32, 1.84, fixture.colliders));
  const firstMaterials = objects => {
    const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
    const hits = ray.intersectObjects(objects, true);
    assert.ok(hits.length && hits[0].point.distanceTo(target) < 1e-5);
    return [...new Set(hits.filter(hit => Math.abs(hit.distance - hits[0].distance) < 1e-5)
      .map(hit => hit.object.material.name))].sort();
  };
  assert.deepEqual(firstMaterials(fixture.World.children), ['brick']);
  const legacy = new THREE.Mesh(new THREE.BoxGeometry(12, 0.18, 0.18), fixture.materials.get('agedStone'));
  legacy.position.set(19, 7.2, 0.04); legacy.updateMatrixWorld(true);
  assert.deepEqual(firstMaterials([...fixture.World.children, legacy]), ['agedStone', 'brick'],
    'the actual scaffold ray detects the original coincident stone end');
  legacy.geometry.dispose();
});

test('the annex junction has one physically mounted edge finish while the brick and tar solids remain intact', () => {
  const covers = fixture.entries.filter(entry => entry.zone === 'roof' && entry.materialKey === 'roofMetal'
    && Math.abs(entry.bounds.min.x - 12.84) < 1e-6 && Math.abs(entry.bounds.max.x - 13.16) < 1e-6
    && Math.abs(entry.bounds.min.y - 13.78) < 1e-6 && Math.abs(entry.bounds.max.y - 14.02) < 1e-6);
  assert.equal(covers.length, 1, 'one fitted cover spans the entire brick/tar junction');
  const cover = covers[0];
  near(cover.bounds.min.z, 0, 'cover is mounted against the wall, without a gap');
  near(cover.bounds.max.z, 0.02, 'cover has physical two-centimetre depth');
  assert.equal(cover.mesh.userData.collider ?? null, null);
  assert.equal(cover.mesh.material.polygonOffset, false);
  assert.ok(fixture.records.get('main-upper-east').bounds.intersectsBox(cover.bounds));
  assert.ok(fixture.records.get('roof-annex-east-deck').bounds.intersectsBox(cover.bounds));
  assert.deepEqual(findCoplanarBoxOverlaps(fixture).filter(hit => hit.a.entry.mesh === cover.mesh || hit.b.entry.mesh === cover.mesh), []);

  const origin = new THREE.Vector3(14.45, 11.65, 2.05), target = new THREE.Vector3(13.05, 13.9, 0);
  assert.ok(capsuleHasClearance(new THREE.Vector3(14.45, 10.02, 2.05), 0.32, 1.84, fixture.colliders));
  const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
  const hits = ray.intersectObjects(fixture.World.children, true);
  assert.equal(hits[0].object, cover.mesh, 'the clear scaffold view sees the fitted finish first');
  near(hits[0].point.z, 0.02);
  assert.deepEqual([...new Set(hits.filter(hit => Math.abs(hit.distance - hits[0].distance) < 1e-5)
    .map(hit => hit.object.material.name))], ['roofMetal']);
  const uncovered = hits.filter(hit => hit.object !== cover.mesh);
  assert.ok(uncovered[0].point.distanceTo(target) < 1e-5);
  assert.deepEqual([...new Set(uncovered.filter(hit => Math.abs(hit.distance - uncovered[0].distance) < 1e-5)
    .map(hit => hit.object.material.name))].sort(), ['brick', 'tar'],
  'removing only the cover reproduces the exact original exposed conflict');
});
