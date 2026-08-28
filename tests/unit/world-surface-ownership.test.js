import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { resolveSurfaceOwnership } from '../../src/world/surface-ownership.js';
import { Colliders, capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { OPENINGS, ROOF } from '../../src/world/layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { buildWorldSurfaceFixture, collectAxisAlignedBoxFaces, findCoplanarBoxOverlaps } from './helpers/world-surface-fixture.js';

const fixture = buildWorldSurfaceFixture();
const originalFaces = collectAxisAlignedBoxFaces(fixture);
const originalOverlaps = findCoplanarBoxOverlaps(fixture);
const originals = new Map([...fixture.records].map(([id, record]) => [id, {
  record, geometry: record.mesh.geometry, material: record.mesh.material,
  bounds: record.bounds.clone(), supports: [...record.supports], collider: record.collider,
  parent: record.mesh.parent, visible: record.mesh.visible,
  transform: [...record.mesh.position.toArray(), ...record.mesh.quaternion.toArray(), ...record.mesh.scale.toArray()],
  flags: [record.mesh.castShadow, record.mesh.receiveShadow, record.mesh.renderOrder,
    record.mesh.material?.depthTest, record.mesh.material?.depthWrite, record.mesh.material?.polygonOffset],
}]));
const colliderState = fixture.colliders.map(collider => ({ collider, min: collider.min.clone(), max: collider.max.clone() }));
const collisionRevision = Colliders.revision;
const children = [...fixture.World.children];
const report = resolveSurfaceOwnership(fixture.records.values());
const faces = collectAxisAlignedBoxFaces(fixture);
const overlaps = findCoplanarBoxOverlaps(fixture);
const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} != ${expected}`);
const finishes = new Set(['floor', 'deck', 'slab', 'roof', 'landing', 'tread', 'ceiling', 'threshold']);
const supports = new Set(['wall', 'building', 'partition', 'lintel', 'beam', 'parapet', 'column', 'pier', 'foundation', 'structure']);

function architectureConflict(overlap) {
  const a = fixture.records.get(overlap.a.id), b = fixture.records.get(overlap.b.id);
  return overlap.axis === 'y' && a && b && ((finishes.has(a.kind) && (finishes.has(b.kind) || supports.has(b.kind)))
    || (finishes.has(b.kind) && supports.has(a.kind)));
}

function capArea(id, sign, source = faces) {
  return source.filter(face => face.id === id && face.axis === 'y' && face.sign === sign).reduce((sum, face) => sum + face.area, 0);
}

// Sample actual indexed triangles at a surface from frontal and shallow
// angles. Filtering to that plane separates visibility ownership from other
// props that can legitimately obscure it in the full scene.
function ownersAt(ids, point, sign, offset) {
  const target = new THREE.Vector3(...point), origin = target.clone().add(new THREE.Vector3(offset[0], sign * offset[1], offset[2]));
  const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
  const meshes = ids.map(id => fixture.records.get(id).mesh);
  return [...new Set(ray.intersectObjects(meshes, false)
    .filter(hit => Math.abs(hit.point.y - point[1]) < 1e-5 && hit.point.distanceTo(target) < 1e-4)
    .map(hit => hit.object.userData.architectureId))].sort();
}

test('the complete authored world loses every registered finish/support coplanar conflict', () => {
  const before = originalOverlaps.filter(architectureConflict);
  assert.equal(before.length, 28, 'the fixture must reproduce the actual floor, threshold and ceiling conflicts');
  assert.deepEqual(overlaps.filter(architectureConflict), []);
  assert.equal(report.clippedMeshes, 11);
  assert.equal(report.clippedFaces, 16);
  near(report.removedArea, 33.42, 'redundant face area');
  for (const id of ['main-upper-north', 'main-upper-south', 'main-upper-east', 'main-ground-north',
    'main-ground-south', 'neighbor-floor', 'balcony-east-deck', 'roof-annex-east-deck']) {
    assert.ok(report.changes.some(change => change.id === id), `${id} is actually finalized`);
  }
});

test('roof floors retain their finish while the lightwell and outside wall strips keep their brick caps', () => {
  near(capArea('main-upper-north', 1, originalFaces), 5.6);
  near(capArea('main-upper-north', 1), 0.5, 'open lightwell strip');
  near(capArea('main-upper-south', 1), 2.8, 'uncovered exterior strip');
  near(capArea('main-upper-east', 1), 0, 'both attached decks cover the eastern wall');
  const ids = ['main-upper-north', 'roof-deck', 'roof-annex-west-link-deck', 'roof-annex-east-link-deck'];
  const cases = [
    [[-13.7, 14, -10.05], 'roof-annex-west-link-deck'],
    [[-10.2, 14, -10.05], 'main-upper-north'],
    [[-6.2, 14, -10.05], 'roof-annex-east-link-deck'],
    [[-10.2, 14, -9.95], 'roof-deck'],
  ];
  for (const [point, owner] of cases) for (const offset of [[0, 0.6, 0], [0.47, 0.03, 0.019], [-0.47, 0.03, -0.019]]) {
    assert.deepEqual(ownersAt(ids, point, 1, offset), [owner], `${point} from ${offset}`);
  }
  assert.deepEqual(ownersAt(['main-upper-south', 'roof-deck'], [1.17, 14, 0.05], 1, [0.47, 0.03, 0.019]), ['main-upper-south']);
});

test('ceilings and canopy undersides own their finish without erasing exterior wall bottoms', () => {
  for (const id of ['main-upper-north', 'main-upper-south']) near(capArea(id, -1), 2.8, `${id} exposed underside`);
  near(capArea('main-upper-east', -1), 1);
  const ids = ['main-upper-north', 'apartment-ceiling', 'neighbor-ceiling', 'terrace-canopy'];
  for (const [x, owner] of [[-11.13, 'apartment-ceiling'], [2.37, 'neighbor-ceiling'], [11.41, 'terrace-canopy']]) {
    for (const offset of [[0, 0.6, 0], [0.43, 0.03, 0.009], [-0.43, 0.03, -0.009]]) {
      assert.deepEqual(ownersAt(ids, [x, 7.4, -9.95], -1, offset), [owner]);
      assert.deepEqual(ownersAt(ids, [x, 7.4, -10.05], -1, offset), ['main-upper-north']);
    }
  }
});

test('stone and metal thresholds own their flush strips and preserve the neighboring floor texture', () => {
  const terrace = ['neighbor-floor', 'balcony-east-deck', 'neighbor-terrace-threshold'];
  for (const [x, owner] of [[8.87, 'neighbor-floor'], [8.96, 'neighbor-terrace-threshold'],
    [9.04, 'neighbor-terrace-threshold'], [9.13, 'balcony-east-deck']]) {
    for (const offset of [[0, 0.5, 0], [0.01, 0.03, 0.43], [-0.01, 0.03, -0.43]]) {
      assert.deepEqual(ownersAt(terrace, [x, 4, -5.137], 1, offset), [owner]);
    }
  }
  near(capArea('neighbor-terrace-threshold', 1), 0.8);
  near(capArea('neighbor-floor', 1), 119.6);
  near(capArea('balcony-east-deck', 1), 39.6);
  near(capArea('roof-annex-east-deck', 1), 119.42);
  const roof = ['roof-annex-east-deck', 'roof-scaffold-threshold'];
  for (const [z, owner] of [[-0.13, 'roof-annex-east-deck'], [-0.05, 'roof-scaffold-threshold'], [0.15, 'roof-scaffold-threshold']]) {
    assert.deepEqual(ownersAt(roof, [21.137, 14, z], 1, [0.43, 0.03, 0.009]), [owner]);
  }
});

test('same-plane gaps are not filled and stair wall/threshold opposing contacts stay intact', () => {
  const ids = ['main-upper-north', 'roof-deck', 'roof-annex-west-link-deck', 'roof-annex-east-link-deck'];
  assert.deepEqual(ownersAt(ids, [-10.2, 14, -10.15], 1, [0, 0.6, 0]), [], 'the lightwell remains open');
  const wall = fixture.records.get('stair-east-wall'), threshold = fixture.records.get('stair-roof-threshold');
  assert.equal(wall.mesh.geometry, originals.get(wall.id).geometry, 'an opposing bearing joint is not clipped');
  near(wall.bounds.max.y, threshold.bounds.min.y);
  near(capArea(wall.id, 1), capArea(wall.id, 1, originalFaces));
  assert.ok(capArea(wall.id, 1) > 0);
});

test('mesh ownership does not change collision, support records, scene membership or render flags', () => {
  assert.deepEqual([...fixture.World.children], children);
  assert.equal(Colliders.revision, collisionRevision);
  assert.equal(Colliders.list.length, colliderState.length);
  for (const { collider, min, max } of colliderState) {
    assert.ok(Colliders.list.includes(collider));
    assert.ok(collider.min.equals(min) && collider.max.equals(max));
  }
  for (const [id, before] of originals) {
    const record = fixture.records.get(id), mesh = record.mesh;
    assert.equal(record, before.record); assert.equal(record.collider, before.collider);
    assert.ok(record.bounds.equals(before.bounds)); assert.deepEqual([...record.supports], before.supports);
    assert.equal(mesh.material, before.material); assert.equal(mesh.parent, before.parent); assert.equal(mesh.visible, before.visible);
    assert.deepEqual([...mesh.position.toArray(), ...mesh.quaternion.toArray(), ...mesh.scale.toArray()], before.transform);
    assert.deepEqual([mesh.castShadow, mesh.receiveShadow, mesh.renderOrder,
      mesh.material?.depthTest, mesh.material?.depthWrite, mesh.material?.polygonOffset], before.flags);
  }
  assert.equal(report.changes.reduce((sum, change) => sum + change.triangles - change.originalTriangles, 0), 22,
    'clipped rectangles add only 22 triangles without adding a mesh or draw call');
});

test('every vertical face is unchanged and the one-time pass cannot allocate again on finalized geometry', () => {
  const vertical = source => source.filter(face => face.axis !== 'y').map(face => [face.id, face.axis, face.sign, face.plane, face.area]);
  assert.deepEqual(vertical(faces), vertical(originalFaces));
  const geometries = [...fixture.records.values()].map(record => record.mesh.geometry);
  const repeated = resolveSurfaceOwnership(fixture.records.values());
  assert.equal(repeated.clippedMeshes, 0);
  assert.deepEqual([...fixture.records.values()].map(record => record.mesh.geometry), geometries);
});

test('the finalized world still supports a smooth bidirectional walk through the roof doorway', () => {
  const z = (OPENINGS.stairRoof.min[2] + OPENINGS.stairRoof.max[2]) / 2, dt = 1 / 120;
  const body = { position: new THREE.Vector3(-16.6, STAIRS.exitY, z), velocity: new THREE.Vector3(), radius: 0.32, height: 1.84, onGround: true };
  for (const targetX of [-14.4, -16.6, -15.1, -14.4]) {
    for (let step = 0; step < 420; step++) {
      body.velocity.x = Math.sign(targetX - body.position.x) * Math.min(4.2, Math.abs(targetX - body.position.x) / dt);
      body.velocity.y -= 22 * dt;
      moveCapsule(body, dt, fixture.colliders, true);
      near(body.position.y, ROOF.floorY, 'stable floor');
      assert.equal(body.velocity.y, 0); assert.equal(body.stepped, 0); assert.equal(body.onGround, true);
    }
    near(body.position.x, targetX, 'actual forward/back movement');
    assert.ok(capsuleHasClearance(body.position, body.radius, body.height, fixture.colliders, 1e-6));
  }
});

test('boot finalizes all zones before rendering and repeated finalization returns the original report', () => {
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const boot = main.slice(main.indexOf('async function boot()'));
  assert.ok(boot.indexOf('buildWorld();') < boot.indexOf('buildEnvironment();'));
  assert.ok(boot.indexOf('buildEnvironment();') < boot.indexOf('finalizeWorldSurfaces();'));
  assert.ok(boot.indexOf('finalizeWorldSurfaces();') < boot.indexOf('  render();'));
  const source = readFileSync(new URL('../../src/world/world.js', import.meta.url), 'utf8');
  const declaration = source.match(/^function finalizeWorldSurfaces\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(declaration, 'explicit world finalization entry point');
  let calls = 0;
  const finalize = runInNewContext(`${declaration}; finalizeWorldSurfaces;`, {
    WorldState: { surfaceOwnership: null }, Architecture: { elements: fixture.records },
    resolveSurfaceOwnership(records) { calls++; assert.equal([...records].length, fixture.records.size); return report; },
  });
  assert.equal(finalize(), report); assert.equal(finalize(), report); assert.equal(calls, 1);
});
