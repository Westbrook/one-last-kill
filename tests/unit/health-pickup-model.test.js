import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHealthPickupModel } from '../../src/render/health-pickup-model.js';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
const firstHit = (root, from, direction) => {
  root.updateMatrixWorld(true);
  return new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...direction)).intersectObject(root, true)[0];
};

test('medical case uses three shared solid-material draws with a bounded geometry cost', () => {
  const cases = Array.from({ length: 15 }, createHealthPickupModel);
  const geometries = new Set(), materials = new Set();
  let triangles = 0, bytes = 0;
  for (const [index, root] of cases.entries()) {
    assert.ok(root.isGroup);
    assert.equal(root.children.length, 3);
    assert.deepEqual(root.position.toArray(), [0, 0, 0]);
    assert.deepEqual(root.scale.toArray(), [1, 1, 1]);
    for (const [part, mesh] of root.children.entries()) {
      assert.ok(mesh.isMesh);
      assert.equal(mesh.geometry.groups.length, 0, 'one material and one draw per merged part');
      assert.equal(Array.isArray(mesh.material), false);
      assert.equal(mesh.geometry, cases[0].children[part].geometry);
      assert.equal(mesh.material, cases[0].children[part].material);
      assert.equal(mesh.castShadow, false, 'do not add shadow draws to the former unshadowed pickup');
      geometries.add(mesh.geometry); materials.add(mesh.material);
      if (index === 0) {
        triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
        bytes += Object.values(mesh.geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
        bytes += mesh.geometry.index?.array.byteLength ?? 0;
      }
    }
  }
  assert.equal(geometries.size, 3);
  assert.equal(materials.size, 3);
  assert.ok(triangles <= 800, `${triangles} triangles stay proportional to the pickup's screen size`);
  assert.ok(bytes <= 64 * 1024, `${bytes} shared attribute bytes`);
  for (const material of materials) {
    assert.ok(material.isMeshStandardMaterial);
    for (const property of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'displacementMap']) assert.equal(material[property], null);
    assert.equal(material.transparent, false);
    assert.equal(material.side, THREE.FrontSide);
  }
});

test('all medical-case parts fit the old pickup envelope without changing the hover datum', () => {
  const root = createHealthPickupModel();
  const bounds = new THREE.Box3().setFromObject(root);
  for (const [axis, min, max] of [['x', -0.1225, 0.1225], ['y', -0.04, 0.052], ['z', -0.09, 0.09]]) {
    assert.ok(bounds.min[axis] >= min - 1e-7, `${axis} minimum remains inside original supply`);
    assert.ok(bounds.max[axis] <= max + 1e-7, `${axis} maximum remains inside original supply`);
  }
  near(bounds.min.y, -0.04, 'case base retains the original offset');
  near(bounds.max.y, 0.052, 'badge retains the original maximum height');
  assert.equal(firstHit(root, [0.119, 0.3, 0.086], [0, -1, 0]), undefined, 'curved corners remove the old square silhouette');
});

test('top and both long-side crosses are front-facing, readable silhouettes on the actual case', () => {
  const root = createHealthPickupModel();
  for (const [from, direction] of [
    [[0, 0.3, 0], [0, -1, 0]],
    [[0.043, 0.3, 0], [0, -1, 0]],
    [[0, 0.3, 0.043], [0, -1, 0]],
    [[0, -0.018, 0.4], [0, 0, -1]],
    [[0, -0.018, -0.4], [0, 0, 1]],
  ]) {
    const hit = firstHit(root, from, direction);
    assert.ok(hit, 'cross faces the approach rather than disappearing through back-face culling');
    assert.equal(hit.object.name, 'medical-case-crosses');
  }
  assert.equal(firstHit(root, [0.043, 0.3, 0.043], [0, -1, 0]).object.name, 'medical-case-shell', 'top cross has open corners instead of a solid red square');
  const red = root.getObjectByName('medical-case-crosses').material;
  assert.equal(red.color.getHex(), 0xff3030);
  assert.equal(red.emissive.getHex(), 0xb01010);
  assert.equal(red.emissiveIntensity, 0.9, 'retain the original pickup identity glow');
});

test('carry handle has a real opening and front latches remain visible outside the shell', () => {
  const root = createHealthPickupModel();
  const trim = root.getObjectByName('medical-case-trim');
  assert.equal(firstHit(trim, [0, 0.018, -0.4], [0, 0, 1]), undefined, 'handle aperture is geometry, not a painted black rectangle');
  assert.equal(firstHit(root, [0, 0.018, -0.4], [0, 0, 1]).object.name, 'medical-case-shell', 'the case is visible through the folded handle');
  assert.equal(firstHit(root, [0.030, 0.018, -0.4], [0, 0, 1]).object.name, 'medical-case-trim');
  for (const x of [-0.080, 0.080]) assert.equal(firstHit(root, [x, 0.0085, 0.4], [0, 0, -1]).object.name, 'medical-case-trim');
});

test('shared pickup geometry has finite unit normals, valid faces and no per-instance mutation', () => {
  const root = createHealthPickupModel(), other = createHealthPickupModel();
  for (const mesh of root.children) {
    const { position, normal } = mesh.geometry.attributes;
    assert.equal(position.count, normal.count);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), face = new THREE.Vector3(), average = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      a.fromBufferAttribute(position, i); b.fromBufferAttribute(normal, i);
      assert.ok([...a, ...b].every(Number.isFinite));
      near(b.length(), 1, `${mesh.name} normal ${i}`);
    }
    for (let i = 0; i < position.count; i += 3) {
      a.fromBufferAttribute(position, i); b.fromBufferAttribute(position, i + 1); c.fromBufferAttribute(position, i + 2);
      face.crossVectors(b.sub(a), c.sub(a));
      assert.ok(face.lengthSq() > 1e-17, `${mesh.name} face ${i / 3} is not degenerate`);
      average.fromBufferAttribute(normal, i).add(a.fromBufferAttribute(normal, i + 1)).add(b.fromBufferAttribute(normal, i + 2));
      assert.ok(face.dot(average) > 0, `${mesh.name} face ${i / 3} agrees with its normals`);
    }
  }
  const original = other.children.map(mesh => Array.from(mesh.geometry.attributes.position.array));
  root.position.set(13, 14.18, -5); root.rotation.y = 1.1; root.visible = false;
  assert.deepEqual(other.children.map(mesh => Array.from(mesh.geometry.attributes.position.array)), original);
  assert.deepEqual(other.position.toArray(), [0, 0, 0]);
  assert.equal(other.visible, true, 'collection can hide one supply without changing its shared peers');
});
