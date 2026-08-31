import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createArmorPickupModel } from '../../src/render/armor-pickup-model.js';

function firstHit(root, from, direction) {
  root.updateMatrixWorld(true);
  return new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...direction)).intersectObject(root, true)[0];
}

test('vest drops share bounded solid-material geometry while retaining independent pickup transforms', () => {
  const intact = createArmorPickupModel(), damaged = createArmorPickupModel({ damaged: true });
  const otherDamaged = createArmorPickupModel({ damaged: true });
  assert.equal(intact.children.length, 3);
  assert.equal(damaged.children.length, 4);
  let triangles = 0, bytes = 0;
  for (const [index, mesh] of damaged.children.entries()) {
    assert.ok(mesh.isMesh);
    assert.equal(mesh.geometry, otherDamaged.children[index].geometry);
    assert.equal(mesh.material, otherDamaged.children[index].material);
    if (index < intact.children.length) {
      assert.equal(mesh.geometry, intact.children[index].geometry);
      assert.equal(mesh.material, intact.children[index].material);
    }
    assert.equal(mesh.geometry.groups.length, 0, 'one draw per merged finish');
    assert.equal(mesh.castShadow, false);
    assert.ok(mesh.material.isMeshStandardMaterial);
    assert.equal(mesh.material.transparent, false);
    assert.equal(mesh.material.side, THREE.FrontSide);
    assert.equal(mesh.material.map, null);
    triangles += mesh.geometry.attributes.position.count / 3;
    bytes += Object.values(mesh.geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
  }
  assert.ok(triangles <= 750, `${triangles} triangles fit the small world pickup`);
  assert.ok(bytes <= 64 * 1024, `${bytes} shared geometry bytes`);
  intact.position.set(1, 0.45, 4); intact.rotation.y = 0.7; intact.visible = false;
  assert.deepEqual(damaged.position.toArray(), [0, 0, 0]);
  assert.equal(damaged.visible, true);
});

test('vest silhouette has an open neckline, two shoulder straps and readable front and back plates', () => {
  const root = createArmorPickupModel();
  const bounds = new THREE.Box3().setFromObject(root);
  const size = bounds.getSize(new THREE.Vector3());
  assert.ok(size.x > 0.49 && size.x < 0.52);
  assert.ok(size.y > 0.59 && size.y < 0.62);
  assert.ok(size.z < 0.30);
  assert.ok(bounds.min.y + 0.45 > 0.14, 'floor + 0.45 keeps the entire vest above ground');
  assert.equal(firstHit(root, [0, 0.25, 1], [0, 0, -1]), undefined, 'neckline is open through both panels');
  for (const x of [-0.133, 0.133]) {
    assert.equal(firstHit(root, [x, 0.27, 1], [0, 0, -1]).object.name, 'armor-vest-fabric');
    assert.equal(firstHit(root, [x, 1, 0], [0, -1, 0]).object.name, 'armor-vest-fabric', 'shoulder bridges join front and back');
  }
  for (const z of [-1, 1]) {
    assert.equal(firstHit(root, [0, 0, z], [0, 0, -z]).object.name, 'armor-vest-plates');
    assert.equal(firstHit(root, [0, 0.086, z], [0, 0, -z]).object.name, 'armor-vest-identity');
  }
  for (const x of [-0.098, 0.098]) {
    const pocket = firstHit(root, [x, -0.22, 1], [0, 0, -1]);
    assert.equal(pocket.object.name, 'armor-vest-plates');
    assert.ok(pocket.point.z > 0.13, 'pockets stand proud of the chest plate');
  }
});

test('damaged vest exposes bullet marks without changing the silhouette or corrupting shared geometry', () => {
  const intact = createArmorPickupModel(), damaged = createArmorPickupModel({ damaged: true });
  assert.deepEqual(new THREE.Box3().setFromObject(damaged), new THREE.Box3().setFromObject(intact));
  for (const [x, y] of [[-0.063, -0.015], [0.058, -0.100], [0.103, 0.060]]) {
    assert.equal(firstHit(intact, [x, y, 1], [0, 0, -1]).object.name, 'armor-vest-plates');
    assert.equal(firstHit(damaged, [x, y, 1], [0, 0, -1]).object.name, 'armor-vest-bullet-marks');
  }
  const normal = new THREE.Vector3();
  for (const mesh of damaged.children) {
    const attributes = mesh.geometry.attributes;
    assert.equal(attributes.position.count, attributes.normal.count);
    assert.ok(Array.from(attributes.position.array).every(Number.isFinite));
    for (let i = 0; i < attributes.normal.count; i++) {
      normal.fromBufferAttribute(attributes.normal, i);
      assert.ok(Math.abs(normal.length() - 1) < 1e-6, `${mesh.name} normal ${i} is finite and normalized`);
    }
  }
});
