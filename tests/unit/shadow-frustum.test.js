import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fitWorldShadow } from '../../src/render/shadow-frustum.js';

test('the static shadow frustum contains the full expanded playable block', () => {
  const light = new THREE.DirectionalLight();
  const bounds = new THREE.Box3(new THREE.Vector3(-38, -0.2, -24), new THREE.Vector3(38, 19.2, 43));
  const camera = fitWorldShadow(light, bounds);
  light.shadow.updateMatrices(light);
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const clip = new THREE.Vector3(x, y, z).project(camera);
    assert.ok(Math.abs(clip.x) < 1 && Math.abs(clip.y) < 1 && Math.abs(clip.z) < 1, `outside shadow map: ${clip.toArray()}`);
  }
  assert.equal(light.shadow.mapSize.x, 2048);
  assert.equal(light.shadow.mapSize.y, 2048);
  assert.ok(camera.near > 0 && camera.far > camera.near);
});
