import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { addCrtHousing, crtHousingBudget } from '../../src/render/crt-housing.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

function fixture() {
  const group = new THREE.Group();
  const body = addCrtHousing((geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); group.add(mesh);
  }, { parent: group, x: 7, y: 5.105, z: -6.99 });
  group.updateMatrixWorld(true);
  return { group, body };
}

test('molded CRT preserves the original outer limits and both console contacts', () => {
  const { group, body } = fixture(), bounds = new THREE.Box3().setFromObject(group);
  near(bounds.min.x, 6.5); near(bounds.max.x, 7.5);
  near(bounds.min.y, 4.8); near(bounds.max.y, 5.4);
  near(bounds.min.z, -7.2925); near(bounds.max.z, -6.74);
  for (const x of [6.67, 7.33]) {
    const hits = new THREE.Raycaster(new THREE.Vector3(x, 4.7, -6.99), new THREE.Vector3(0, 1, 0)).intersectObject(group);
    assert.ok(hits.length); near(hits[0].point.y, 4.8);
  }
  assert.equal(body.castShadow, true, 'replacement retains the old single body shadow caster');
  assert.equal(group.children.filter(mesh => mesh.castShadow).length, 1);
});

test('the rear remains closed opaque cover and the unchanged glass face stays unobstructed', () => {
  const { group, body } = fixture();
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.45, 0.04),
    new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.3 }));
  glass.material.userData.surfaceKind = 'glass';
  glass.position.set(7.05, 5.105, -7.26); group.add(glass); group.updateMatrixWorld(true);
  for (const x of [6.67, 6.86, 7.05, 7.24, 7.43]) for (const y of [4.89, 5.105, 5.32]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(x, y, -8), new THREE.Vector3(0, 0, 1)).intersectObject(group)[0];
    assert.equal(hit?.object, glass, 'bezel does not cover the existing screen or change its front impact material');
    near(hit.point.z, -7.28);
  }
  for (const x of [6.75, 7, 7.25]) for (const y of [4.9, 5.05, 5.20]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(x, y, -6), new THREE.Vector3(0, 0, -1)).intersectObject(body)[0];
    assert.ok(hit, 'closed rear cap and shoulders stop a ray even behind vent gaps');
    assert.ok(hit.point.z >= -6.76 && hit.point.z <= -6.74);
  }
  for (const mesh of group.children) {
    assert.equal(mesh.material.transparent, false); assert.equal(mesh.material.opacity, 1);
  }
});

test('CRT uses bounded cached geometry with valid normals and no texture or runtime effects', () => {
  const first = fixture(), second = fixture(), budget = crtHousingBudget();
  assert.equal(budget.draws, 2); assert.ok(budget.triangles < 800);
  assert.ok(budget.geometryBytes < 40 * 1024); assert.equal(budget.textureBytes, 0);
  const normal = new THREE.Vector3();
  for (const [index, mesh] of first.group.children.entries()) {
    assert.equal(mesh.geometry, second.group.children[index].geometry);
    assert.equal(mesh.material, second.group.children[index].material);
    assert.equal(mesh.material.map, null); assert.equal(mesh.material.normalMap, null);
    assert.equal(mesh.material.metalness, 0); assert.ok(mesh.material.roughness >= 0.8);
    for (const attribute of Object.values(mesh.geometry.attributes)) assert.ok(attribute.array.every(Number.isFinite));
    for (let i = 0; i < mesh.geometry.attributes.normal.count; i++) near(normal.fromBufferAttribute(mesh.geometry.attributes.normal, i).length(), 1);
  }
});
