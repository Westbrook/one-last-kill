import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BALCONY } from '../../src/world/layout.js';
import { createHumanoidRig, resetHumanoidPose, updateHumanoidPose } from '../../src/render/humanoid-rig.js';
import {
  COLLAPSE_DURATION, alignedFallYaw, fitIntervalTranslation,
  beginHumanoidCollapse, updateHumanoidCollapse,
} from '../../src/render/corpse-pose.js';

function bounds(root) {
  root.updateMatrixWorld(true);
  const result = new THREE.Box3();
  for (const mesh of root.userData.rig.bodyMeshes) result.union(new THREE.Box3().setFromObject(mesh));
  return result;
}

function armedPose(kind, yaw, x = 0, z = BALCONY.laneZ, floor = BALCONY.floorY) {
  const root = createHumanoidRig({ height: kind === 'thug' ? 1.82 : 1.78, kind });
  root.position.set(x, floor, z); root.rotation.y = yaw;
  for (let i = 0; i < 20; i++) {
    updateHumanoidPose(root, { mode: kind === 'thug' ? 'bat' : 'fist', alert: 1, swingProgress: 0.18 }, 1 / 60);
  }
  return root;
}

test('gallery yaw alignment keeps the facing sign without a world-axis fall', () => {
  assert.equal(alignedFallYaw(Math.PI / 2 + 0.2, 'x'), Math.PI / 2);
  assert.equal(alignedFallYaw(3 * Math.PI / 2 - 0.2, 'x'), -Math.PI / 2);
  assert.equal(alignedFallYaw(0.4, 'z'), 0);
  assert.equal(alignedFallYaw(2.9, 'z'), Math.PI);
  assert.equal(alignedFallYaw(0.7), 0.7);
});

test('90 and 270 degree collapses stay narrow and grounded throughout the fall', () => {
  for (const yaw of [Math.PI / 2, 3 * Math.PI / 2]) {
    const root = armedPose('thug', yaw);
    beginHumanoidCollapse(root, yaw, BALCONY.floorY, 'x', 0.08);
    for (let frame = 0; frame <= 90; frame++) {
      updateHumanoidCollapse(root, frame / 120);
      const box = bounds(root);
      assert.ok(box.min.y >= BALCONY.floorY - 1e-6);
      assert.ok(box.min.y <= BALCONY.floorY + 0.008);
      assert.ok(box.max.z - box.min.z < 0.8, 'The fall must not sweep a full body across the railing');
    }
    const settled = bounds(root);
    assert.ok(settled.max.x - settled.min.x > 1.6);
    assert.ok(settled.max.y < BALCONY.floorY + 0.5);
    assert.equal(root.rotation.order, 'YXZ');
    const head = root.userData.rig.anchors.headCenter.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.sign(head.x - root.position.x) === Math.sign(Math.sin(yaw)));
  }
});

test('gallery end caps select a backward collapse and outer rails contain the full body', () => {
  for (const fixture of [
    { kind: 'thug', x: -18.25, z: 0.56, yaw: 3 * Math.PI / 2 },
    { kind: 'brawler', x: 12.25, z: 1.3, yaw: Math.PI / 2 },
    { kind: 'thug', x: 0, z: 1.48, yaw: Math.PI / 2 },
    { kind: 'brawler', x: 0, z: 0.32, yaw: 3 * Math.PI / 2 },
  ]) {
    const root = armedPose(fixture.kind, fixture.yaw, fixture.x, fixture.z, 4.02);
    beginHumanoidCollapse(root, fixture.yaw, 4.02, 'x', -0.08, BALCONY.wrap);
    for (let frame = 0; frame <= 90; frame++) {
      updateHumanoidCollapse(root, frame / 120);
      const box = bounds(root);
      assert.ok(box.min.y >= 4.02 - 1e-6 && box.min.y <= 4.03);
      assert.ok(box.min.x >= BALCONY.wrap.x1 + 0.1 - 1e-6, `West end: ${box.min.x}`);
      assert.ok(box.max.x <= BALCONY.wrap.x2 - 0.1 + 1e-6, `East end: ${box.max.x}`);
      assert.ok(box.min.z >= BALCONY.wrap.z1 + 0.1 - 1e-6, `Wall side: ${box.min.z}`);
      assert.ok(box.max.z <= BALCONY.wrap.z2 - 0.1 + 1e-6, `Outer rail: ${box.max.z}`);
    }
    assert.ok(bounds(root).max.y < 4.85);
    if (Math.abs(fixture.x) > 12) assert.equal(root.userData.rig.collapse.fallSign, -1);
  }
});

test('falling relaxes a raised attack into compact arms and flexed knees', () => {
  const root = armedPose('thug', Math.PI / 2);
  const j = root.userData.rig.joints;
  const original = j.shoulderR.quaternion.clone();
  beginHumanoidCollapse(root, Math.PI / 2, BALCONY.floorY, 'x');
  updateHumanoidCollapse(root, 0);
  assert.ok(j.shoulderR.quaternion.equals(original), 'Capture must not snap an attack pose');
  updateHumanoidCollapse(root, COLLAPSE_DURATION);
  assert.ok(Math.abs(j.shoulderR.rotation.x - 0.10) < 1e-6);
  assert.ok(Math.abs(j.elbowR.rotation.x + 0.35) < 1e-6);
  assert.ok(j.kneeL.rotation.x > 0.2);
  assert.equal(root.userData.rig.pose.mode, 'dead');
  assert.equal(root.userData.rig.pose.phase, 'settled');
});

test('collapse results depend on simulation age, not rendering frequency', () => {
  const results = [];
  for (const rate of [30, 60, 120]) {
    const root = armedPose('brawler', 3 * Math.PI / 2);
    beginHumanoidCollapse(root, 3 * Math.PI / 2, BALCONY.floorY, 'x', 0.08);
    for (let frame = 0; frame <= rate; frame++) updateHumanoidCollapse(root, frame / rate);
    results.push({ position: root.position.clone(), quaternion: root.quaternion.clone(), bounds: bounds(root) });
  }
  for (const result of results.slice(1)) {
    assert.ok(result.position.distanceTo(results[0].position) < 1e-8);
    assert.ok(Math.abs(result.quaternion.dot(results[0].quaternion)) > 1 - 1e-8);
    assert.ok(result.bounds.min.distanceTo(results[0].bounds.min) < 1e-8);
  }
});

test('settled corpses stop matrix/bounds updates while retaining their despawn sink', () => {
  const root = armedPose('thug', Math.PI / 2);
  beginHumanoidCollapse(root, Math.PI / 2, BALCONY.floorY, 'x');
  updateHumanoidCollapse(root, COLLAPSE_DURATION);
  const standingY = root.position.y;
  root.updateMatrixWorld = () => { throw new Error('Settled corpse should not rescan geometry'); };
  assert.equal(updateHumanoidCollapse(root, 10), true);
  assert.equal(root.position.y, standingY);
  updateHumanoidCollapse(root, 17.5, 0.225);
  assert.ok(Math.abs(root.position.y - standingY + 0.225) < 1e-8);
});

test('pool-style reset clears collapse state and cannot resume an old death', () => {
  const root = armedPose('thug', Math.PI / 2);
  const state = root.userData.rig.collapse;
  const cachedBones = state.bones, cachedBodies = state.bodies;
  beginHumanoidCollapse(root, Math.PI / 2, BALCONY.floorY, 'x', 0.08, BALCONY.wrap);
  updateHumanoidCollapse(root, 1);
  root.rotation.set(0, 0, 0, 'YXZ');
  root.position.set(0, 0, 0);
  resetHumanoidPose(root);
  assert.equal(state.active, false);
  assert.equal(state.settled, false);
  assert.equal(state.bones, cachedBones);
  assert.equal(state.bodies, cachedBodies);
  assert.equal(updateHumanoidCollapse(root, 2), false);
  const upright = bounds(root);
  assert.ok(Math.abs(upright.min.y) < 1e-6 && Math.abs(upright.max.y - 1.82) < 1e-6);
  beginHumanoidCollapse(root, 0, 0);
  assert.equal(state.hasRegion, false, 'The next zone cannot inherit gallery constraints');
});

test('interval fitting applies only the translation needed to clear a boundary', () => {
  assert.equal(fitIntervalTranslation(-0.3, 0.3, -0.8, 0.8), 0);
  assert.ok(Math.abs(fitIntervalTranslation(0.6, 1.2, -0.8, 0.8) + 0.4) < 1e-8);
  assert.ok(Math.abs(fitIntervalTranslation(-1.2, -0.6, -0.8, 0.8) - 0.4) < 1e-8);
});
