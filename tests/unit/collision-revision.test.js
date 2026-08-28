import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Colliders } from '../../src/core/collision.js';

test('collision revision changes only when registered geometry or its active set changes', () => {
  Colliders.clear();
  let revision = Colliders.revision;
  const box = Colliders.addBoxBySize(0, 0, 0, 1, 1, 1);
  assert.equal(Colliders.revision, ++revision);
  Colliders.setEnabled(box, true);
  assert.equal(Colliders.revision, revision);
  Colliders.setEnabled(box, false);
  assert.equal(Colliders.revision, ++revision);
  Colliders.setEnabled(box, false);
  assert.equal(Colliders.revision, revision);
  Colliders.setEnabled(box, true);
  assert.equal(Colliders.revision, ++revision);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  Colliders.addFromMesh(mesh);
  assert.equal(Colliders.revision, ++revision);
  Colliders.clear();
  assert.equal(Colliders.revision, ++revision);
  assert.equal(Colliders.setEnabled(box, true), false);
  Colliders.clear();
  assert.equal(Colliders.revision, revision);
  mesh.geometry.dispose(); mesh.material.dispose();
});
