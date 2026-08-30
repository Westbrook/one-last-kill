import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildExteriorDetail, createRoofCowlGeometry, finishExteriorMaterials } from '../../src/render/exterior-detail.js';
import { createStaticSurfaceBatch } from '../../src/render/static-surface-batch.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { Colliders } from '../../src/core/collision.js';
import { BUILDING, ROOF, OPENINGS } from '../../src/world/layout.js';
import { resolveSurfaceOwnership } from '../../src/world/surface-ownership.js';
import { buildWorldSurfaceFixture, findCoplanarBoxOverlaps } from './helpers/world-surface-fixture.js';

function fixture({ finish = true } = {}) {
  const structural = buildWorldSurfaceFixture();
  const world = structural.World, root = new THREE.Group();
  const geometry = { box: new THREE.BoxGeometry(1, 1, 1), cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 10) };
  const metal = new THREE.MeshStandardMaterial(), stone = new THREE.MeshStandardMaterial();
  stone.userData.surfaceMeters = 4;
  const specifications = [];
  const batches = { add(name, source, material, receiveShadow = false) {
    const entries = [];
    specifications.push({ name, source, material, entries, receiveShadow });
    return (x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0, tint = null) =>
      entries.push({ x, y, z, sx, sy, sz, rx, ry, rz, tint });
  } };
  const colliderBounds = Colliders.list.map(box => box.clone());
  const oldGeometry = new Map(world.children.filter(mesh => mesh.isMesh).map(mesh => [mesh, mesh.geometry]));
  const oldMaterials = new Map(world.children.filter(mesh => mesh.isMesh).map(mesh => [mesh, mesh.material]));
  const facadeWindows = [
    { x: -13, y: BUILDING.canopyY + 1.75, z: 0.115, yaw: 0 },
    { x: 25.015, y: 12.35, z: -17.5, yaw: Math.PI / 2 },
    { x: -13, y: 12.35, z: -24.015, yaw: Math.PI },
  ];
  const result = buildExteriorDetail({ world, batches, geometry,
    metal: batches.add('new-metal', geometry.box, metal, true),
    pipe: batches.add('new-pipes', geometry.cylinder, metal, true),
    stone: batches.add('new-stone', geometry.box, stone, true), facadeWindows, roofMetal: metal });
  // Geometry decoration must not install shader hooks before the caller's
  // surface-ownership pass. Materials are a separate explicit finalization.
  for (const [mesh, material] of oldMaterials) assert.equal(mesh.material, material);
  if (finish) result.finishedDecks = finishExteriorMaterials(world);
  const transform = new THREE.Object3D(), color = new THREE.Color();
  const instances = [];
  for (const { name, source, material, entries, receiveShadow } of specifications) {
    let mesh = createStaticSurfaceBatch(source, material, entries);
    if (!mesh) {
      mesh = new THREE.InstancedMesh(source, material, entries.length);
      const tinted = entries.some(entry => entry.tint !== null);
      for (const [i, entry] of entries.entries()) {
        transform.position.set(entry.x, entry.y, entry.z); transform.rotation.set(entry.rx, entry.ry, entry.rz);
        transform.scale.set(entry.sx, entry.sy, entry.sz); transform.updateMatrix();
        mesh.setMatrixAt(i, transform.matrix);
        if (tinted) mesh.setColorAt(i, color.set(entry.tint ?? 0xffffff));
      }
    }
    mesh.name = name; mesh.receiveShadow = receiveShadow; root.add(mesh);
    source.computeBoundingBox();
    for (const entry of entries) {
      transform.position.set(entry.x, entry.y, entry.z); transform.rotation.set(entry.rx, entry.ry, entry.rz);
      transform.scale.set(entry.sx, entry.sy, entry.sz); transform.updateMatrix();
      instances.push({ name, entry, bounds: source.boundingBox.clone().applyMatrix4(transform.matrix) });
    }
  }
  root.updateMatrixWorld(true);
  return { world, root, specifications, instances, structural, oldGeometry, oldMaterials, colliderBounds, result, facadeWindows };
}

const f = fixture();
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-5, `${label}: ${a} != ${b}`);
const intersectsXZ = (box, area) => box.min.x < area.x2 && box.max.x > area.x1
  && box.min.z < area.z2 && box.max.z > area.z1;

test('exterior dressing preserves every authored movement box, support and geometry buffer', () => {
  assert.equal(Colliders.list.length, f.colliderBounds.length);
  for (const [index, box] of Colliders.list.entries()) assert.ok(box.equals(f.colliderBounds[index]));
  for (const [mesh, geometry] of f.oldGeometry) assert.equal(mesh.geometry, geometry, mesh.name);
  for (const record of f.structural.records.values()) assert.equal(record.mesh.geometry, f.oldGeometry.get(record.mesh));
  assert.equal(f.result.finishedDecks.length, 5);
  for (const [mesh, material] of f.oldMaterials) {
    if (f.result.finishedDecks.includes(mesh.name)) assert.notEqual(mesh.material, material);
    else assert.equal(mesh.material, material, `${mesh.name}: material remains unchanged`);
  }
});

test('service cowls have continuous support inside the actual existing cap', () => {
  const cap = new THREE.Box3().setFromObject(f.world.getObjectByName('roof-service-cap'));
  const cowls = f.instances.filter(item => item.name === 'exterior-service-vent-cowls');
  assert.equal(cowls.length, 2);
  for (const cowl of cowls) {
    assert.ok(cowl.bounds.min.x > cap.min.x + 1 && cowl.bounds.max.x < cap.max.x - 1);
    assert.ok(cowl.bounds.min.z > cap.min.z + 1 && cowl.bounds.max.z < cap.max.z - 1);
    const stack = f.instances.filter(item => item.name === 'new-pipes'
      && Math.abs(item.entry.x - cowl.entry.x) < 1e-6 && Math.abs(item.entry.z - cowl.entry.z) < 1e-6)
      .sort((a, b) => a.bounds.min.y - b.bounds.min.y);
    assert.equal(stack.length, 3);
    near(stack[0].bounds.min.y, cap.max.y, 'flange rests on cap');
    assert.ok(stack[1].bounds.min.y <= stack[0].bounds.max.y + 1e-6, 'stem meets flange');
    assert.ok(stack[2].bounds.min.y < stack[1].bounds.max.y, 'collar overlaps stem');
    assert.ok(cowl.bounds.min.y < stack[2].bounds.max.y, 'hood meets collar');
  }
});

test('lintels meet the old sash head, embed into masonry and leave the glazing clear', () => {
  const heads = f.instances.filter(item => item.name === 'new-stone');
  assert.equal(heads.length, f.facadeWindows.length);
  for (const [index, { bounds }] of heads.entries()) {
    const window = f.facadeWindows[index];
    near(bounds.min.y, window.y + 0.9325, 'head meets the old top rail');
    assert.ok(bounds.min.y > window.y + 1.65 / 2, 'glass is fully clear');
    const axis = Math.abs(Math.sin(window.yaw)) > 0.5 ? 'x' : 'z';
    assert.ok(bounds.min[axis] < window[axis] && bounds.max[axis] > window[axis], 'back is embedded');
  }
});

test('new solids cannot enter the lightwell, roof escape opening or walking envelope', () => {
  for (const { name, bounds } of f.instances) {
    assert.ok(!intersectsXZ(bounds, ROOF.lightwell), `${name}: open lightwell`);
    const opening = new THREE.Box3(new THREE.Vector3(...OPENINGS.roofScaffold.min), new THREE.Vector3(...OPENINGS.roofScaffold.max));
    assert.equal(bounds.intersectsBox(opening), false, `${name}: scaffold opening`);
    for (const [x, y, z] of ROOF.route) {
      const body = new THREE.Box3(new THREE.Vector3(x - 0.32, y, z - 0.32), new THREE.Vector3(x + 0.32, y + 1.85, z + 0.32));
      assert.equal(bounds.intersectsBox(body), false, `${name}: route pocket ${x},${z}`);
    }
  }
});

test('actual new ballistic geometry preserves route sight lines and blocks the attached louver', () => {
  const index = createBallisticWorld({ colliders: null }); index.rebuild(f.root);
  const eye = point => new THREE.Vector3(point[0], point[1] + 1.5, point[2]);
  for (let i = 1; i < ROOF.route.length; i++) {
    const from = eye(ROOF.route[i - 1]), to = eye(ROOF.route[i]);
    for (const channel of ['bullet', 'sight']) assert.equal(index.segmentOccluded(from, to, channel), false);
  }
  const from = new THREE.Vector3(-5, 15.67, -11.72), to = new THREE.Vector3(-3.9, 15.67, -11.72);
  for (const channel of ['bullet', 'sight']) assert.equal(index.segmentOccluded(from, to, channel), true);
  const open = OPENINGS.stairRoof;
  for (const dy of [0.35, 1.0, 1.8]) {
    const y = open.min[1] + dy, z = (open.min[2] + open.max[2]) / 2;
    assert.equal(index.segmentOccluded(new THREE.Vector3(-16, y, z), new THREE.Vector3(-14, y, z)), false);
  }
  index.clear();
});

test('cowl profiles and added geometry remain bounded, shared and allocation-free after construction', () => {
  const geometry = createRoofCowlGeometry();
  assert.equal(geometry.index.count / 3, 160);
  assert.ok(geometry.boundingSphere.radius < 0.5);
  for (const attribute of Object.values(geometry.attributes)) {
    for (const value of attribute.array) assert.ok(Number.isFinite(value));
  }
  assert.equal(f.result.addedDraws, 1, 'all other additions append to established material batches');
  assert.deepEqual(f.result.counts, { metalBoxes: 23, stoneBoxes: 3, pipes: 13, cowls: 2 });
  assert.equal(f.result.cowlGeometryBytes, 4320);
  assert.equal(f.result.addedTriangles, 1152);
  assert.equal(f.root.children.filter(mesh => mesh.isLight).length, 0);
  assert.ok(f.root.children.every(mesh => !mesh.material.transparent), 'no alpha overdraw');
});

test('boot finishes original roof ownership before installing membrane shaders, retaining both overlap fixes', () => {
  const boot = fixture({ finish: false });
  const pairs = [
    ['roof-annex-west-link-deck', 'main-upper-north'],
    ['roof-annex-east-deck', 'roof-scaffold-threshold'],
  ];
  const relevantOverlaps = () => findCoplanarBoxOverlaps(boot.structural).filter(overlap =>
    overlap.axis === 'y' && pairs.some(pair => pair.includes(overlap.a.entry.mesh.name) && pair.includes(overlap.b.entry.mesh.name)));
  const before = relevantOverlaps();
  for (const pair of pairs) assert.ok(before.some(overlap => pair.includes(overlap.a.entry.mesh.name)
    && pair.includes(overlap.b.entry.mesh.name)), `${pair.join('/')}: fixture exercises original shared faces`);
  const ownership = resolveSurfaceOwnership(boot.structural.records.values());
  assert.ok(ownership.changes.some(change => change.id === 'main-upper-north'
    && change.faces.some(face => face.owners.includes('roof-annex-west-link-deck'))));
  assert.ok(ownership.changes.some(change => change.id === 'roof-annex-east-deck'
    && change.faces.some(face => face.owners.includes('roof-scaffold-threshold'))));
  assert.equal(relevantOverlaps().length, 0, 'actual referenced faces no longer overlap before finishing');
  const geometries = new Map([...boot.structural.records.values()].map(record => [record.mesh, record.mesh.geometry]));
  const decks = finishExteriorMaterials(boot.world);
  assert.equal(decks.length, 5);
  for (const [mesh, geometry] of geometries) assert.equal(mesh.geometry, geometry, 'finishing cannot restore clipped geometry');
  assert.equal(relevantOverlaps().length, 0, 'shader installation preserves both real overlap fixes');
});
