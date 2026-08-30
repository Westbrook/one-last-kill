import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { BAT_DIMENSIONS, createBatAsset } from '../../src/render/bat-asset.js';
import { createFirstPersonHands } from '../../src/render/first-person-hands.js';
import { createFirstPersonBat, poseFirstPersonBat, FIRST_PERSON_BAT_SECONDS, BAT_CONTACT_PHASE } from '../../src/render/first-person-bat.js';

function visitVertices(root, visitor) {
  root.updateWorldMatrix(true, true);
  const point = new THREE.Vector3(), matrix = new THREE.Matrix4(), instance = new THREE.Matrix4();
  root.traverse(object => {
    if (!object.isMesh || !object.visible) return;
    const positions = object.geometry.attributes.position;
    for (let slot = 0; slot < (object.isInstancedMesh ? object.count : 1); slot++) {
      matrix.copy(object.matrixWorld);
      if (object.isInstancedMesh) { object.getMatrixAt(slot, instance); matrix.multiply(instance); }
      for (let i = 0; i < positions.count; i++) visitor(object.getVertexPosition(i, point).applyMatrix4(matrix), object);
    }
  });
}

function sampleTip(model, phase) {
  poseFirstPersonBat(model, 1 - phase);
  return model.userData.firstPersonBat.asset.userData.anchors.tip.getWorldPosition(new THREE.Vector3());
}

test('first-person bat keeps the canonical dimensions and shares both weapon and hand geometry', () => {
  const model = createFirstPersonBat(), other = createFirstPersonBat();
  const rig = model.userData.firstPersonBat, fists = createFirstPersonHands(), worldBat = createBatAsset();
  assert.deepEqual(model.position.toArray(), [0, 0, 0]);
  assert.deepEqual(model.rotation.toArray().slice(0, 3), [0, 0, 0]);
  assert.deepEqual(model.scale.toArray(), [1, 1, 1]);
  assert.deepEqual(rig.asset.scale.toArray(), [1, 1, 1]);
  assert.equal(rig.asset.getObjectByName('bat-wood').geometry, worldBat.getObjectByName('bat-wood').geometry);
  assert.equal(rig.asset.getObjectByName('bat-grip').material, worldBat.getObjectByName('bat-grip').material);
  const grip = rig.hands.userData.firstPersonGripHands;
  assert.equal(grip.left.surface.material, fists.userData.firstPersonHands.left.surface.material);
  assert.equal(grip.left.sleeve.geometry, fists.userData.firstPersonHands.left.sleeve.geometry);
  assert.equal(grip.right.surface.geometry, other.userData.firstPersonBat.hands.userData.firstPersonGripHands.right.surface.geometry);
  let meshes = 0, triangles = 0;
  model.traverse(object => {
    if (!object.isMesh || !object.visible) return;
    meshes++; triangles += object.geometry.index.count / 3 * (object.isInstancedMesh ? object.count : 1);
    assert.equal(object.castShadow, false); assert.equal(object.receiveShadow, false);
    assert.notEqual(object.geometry.type, 'BoxGeometry'); assert.notEqual(object.geometry.type, 'RoundedBoxGeometry');
  });
  assert.equal(meshes, 8); assert.ok(triangles <= 10_000, `first-person triangles ${triangles}`);
});

test('idle guard holds the full-size barrel upright and slightly back beside the right shoulder', () => {
  const model = createFirstPersonBat(), rig = model.userData.firstPersonBat;
  for (const phase of [0, 1]) {
    const tip = sampleTip(model, phase);
    const grip = rig.asset.userData.anchors.grip.getWorldPosition(new THREE.Vector3());
    const shaft = tip.clone().sub(grip).normalize();
    assert.ok(shaft.y > 0.95, 'the barrel is carried up, not projected toward the target');
    assert.ok(shaft.z > 0.10, 'the tip leans back toward the shoulder');
    assert.ok(tip.y - grip.y > 0.65 && tip.z - grip.z > 0.07);
    assert.ok(grip.x >= 0.20 && tip.x > grip.x, 'guard occupies the right side');
    const bounds = new THREE.Box3().setFromObject(rig.asset);
    assert.ok(bounds.max.z - bounds.min.z < 0.20, 'resting bat has little forward depth');
    const barrel = rig.asset.userData.anchors.strikeCenter.getWorldPosition(new THREE.Vector3());
    for (const fov of [70, 82, 100]) {
      for (const aspect of [4 / 3, 16 / 9]) {
        const camera = new THREE.PerspectiveCamera(fov, aspect, 0.05, 100);
        const projectedBarrel = barrel.clone().project(camera), projectedTip = tip.clone().project(camera);
        assert.ok(projectedBarrel.x > 0.25 && projectedBarrel.x < 0.85);
        assert.ok(projectedBarrel.y > 0 && projectedBarrel.y < 0.95, 'barrel is visibly upright along the outer frame');
        // At narrow FOV the very tip naturally leaves the top of frame. The
        // grip and barrel stay visible; near-plane/reticle rules have no exceptions.
        if (fov === 70) assert.ok(projectedTip.y > 1 && projectedTip.y < 1.25);
        else assert.ok(projectedTip.y < 1);
      }
    }
  }
});

test('each articulated finger wraps the handle and both hands stay fixed to their grip anchors', () => {
  const model = createFirstPersonBat(), rig = model.userData.firstPersonBat;
  const grip = rig.hands.userData.firstPersonGripHands;
  assert.equal(grip.left.gripZ, BAT_DIMENSIONS.lowerGripZ);
  assert.equal(grip.right.gripZ, BAT_DIMENSIONS.upperGripZ);
  assert.ok(grip.right.gripZ - grip.left.gripZ > 0.085);
  for (const phase of [0, 0.12, 0.24, 0.36, 0.40, 0.5, 0.60, 0.70, 0.86, 1]) {
    poseFirstPersonBat(model, 1 - phase); model.updateMatrixWorld(true);
    for (const hand of grip.order) {
      const center = hand.gripCenter.clone().applyMatrix4(hand.hand.matrixWorld);
      const anchor = new THREE.Vector3(0, 0, hand.gripZ).applyMatrix4(rig.pivot.matrixWorld);
      assert.ok(center.distanceTo(anchor) < 1e-9, 'hand cannot slide through the shaft during a swing');
      for (const finger of hand.fingers) {
        assert.equal(finger.joints.length, 4);
        for (const joint of finger.joints) {
          const radius = Math.hypot(joint.y - hand.gripCenter.y, joint.z - hand.gripCenter.z);
          assert.ok(radius > BAT_DIMENSIONS.gripRadius + finger.radius - 0.002);
          assert.ok(radius < BAT_DIMENSIONS.gripRadius + finger.radius + 0.0005);
        }
        assert.ok(finger.joints[0].y > hand.gripCenter.y && finger.joints[3].y < hand.gripCenter.y);
        assert.ok(finger.joints[0].z > hand.gripCenter.z && finger.joints[3].z < hand.gripCenter.z);
        for (let i = 0; i < 3; i++) assert.ok(finger.joints[i].distanceTo(finger.joints[i + 1]) < 0.03);
      }
      assert.ok(hand.thumb.joints[2].z < hand.thumb.joints[0].z - 0.05, 'opposed thumb closes over the handle');
      const point = new THREE.Vector3(), vertexCount = hand.surface.geometry.attributes.position.count;
      for (let i = 0; i < vertexCount; i++) {
        hand.surface.getVertexPosition(i, point);
        const distance = Math.hypot(point.y - hand.gripCenter.y, point.z - hand.gripCenter.z);
        assert.ok(distance > BAT_DIMENSIONS.gripRadius - 0.002, 'deformed hand surface cannot pass through the handle');
      }
      const top = new THREE.Vector3(0, 0.5, 0).applyMatrix4(hand.sleeve.matrixWorld);
      const bottom = new THREE.Vector3(0, -0.5, 0).applyMatrix4(hand.sleeve.matrixWorld);
      assert.ok(top.distanceTo(hand.wrist) < 1e-9);
      assert.ok(bottom.distanceTo(hand.anchor) < 1e-9);
    }
  }
});

test('bat winds up, passes the shared contact phase, follows through left and recovers below the reticle', () => {
  const model = createFirstPersonBat(), rig = model.userData.firstPersonBat;
  assert.equal(FIRST_PERSON_BAT_SECONDS, WEAPON_DEFS.bat.attackDuration);
  assert.equal(BAT_CONTACT_PHASE, WEAPON_DEFS.bat.contactPhase);
  assert.equal(FIRST_PERSON_BAT_SECONDS * BAT_CONTACT_PHASE, 0.25);
  const guard = sampleTip(model, 0), windup = sampleTip(model, 0.24);
  assert.ok(windup.x > guard.x + 0.18 && windup.z > guard.z + 0.16, 'windup draws the raised barrel back and right');
  assert.ok(rig.direction.y > 0.85 && rig.direction.z > 0.30);
  const downswing = sampleTip(model, 0.40);
  assert.ok(downswing.x > 0.42 && downswing.y < 0, 'barrel lowers to the right before crossing toward contact');
  sampleTip(model, BAT_CONTACT_PHASE);
  const strike = rig.asset.userData.anchors.strikeCenter.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(strike.x) < 0.025 && strike.z < -1.30);
  assert.ok(strike.y > -0.18 && strike.y < -0.12);
  const follow = sampleTip(model, 0.7), recover = sampleTip(model, 0.86), end = sampleTip(model, 1);
  assert.ok(follow.x < -0.70 && follow.y < -0.30);
  assert.ok(recover.y < -0.35, 'return arc passes low rather than sweeping across the sight');
  assert.ok(end.distanceTo(guard) < 1e-12);
  const epsilon = 1e-4;
  const before = sampleTip(model, BAT_CONTACT_PHASE - epsilon), contact = sampleTip(model, BAT_CONTACT_PHASE);
  const after = sampleTip(model, BAT_CONTACT_PHASE + epsilon);
  const incoming = contact.clone().sub(before).divideScalar(epsilon), outgoing = after.clone().sub(contact).divideScalar(epsilon);
  assert.ok(incoming.length() > 2 && outgoing.length() > 2, 'a miss does not stop at contact like recoil');
  assert.ok(incoming.distanceTo(outgoing) < 0.04, 'velocity remains continuous through contact');
});

test('the complete attack clears the near plane and reticle across supported fields of view', () => {
  const model = createFirstPersonBat();
  const cameras = [70, 82, 100].flatMap(fov => [4 / 3, 16 / 9].map(aspect => new THREE.PerspectiveCamera(fov, aspect, 0.05, 100)));
  const projected = new THREE.Vector3(), ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 0.05, 3);
  const meshes = [];
  model.traverse(object => { if (object.isMesh && object.visible) meshes.push(object); });
  for (let step = 0; step <= 120; step++) {
    const phase = step / 120;
    poseFirstPersonBat(model, 1 - phase, phase * 7, 1);
    visitVertices(model, (point, object) => {
      assert.ok(Number.isFinite(point.x + point.y + point.z));
      assert.ok(point.z < -0.12, `near-plane clearance at ${phase}: ${point.z}`);
      for (const camera of cameras) {
        projected.copy(point).project(camera);
        assert.ok(Math.hypot(projected.x, projected.y) > 0.035, `aim clearance ${phase} at FOV ${camera.fov}`);
        if (object.parent.name.endsWith('-hand')) {
          assert.ok(projected.y < -0.17, 'hands stay below the aiming point');
          assert.ok(projected.y > -1.11 && Math.abs(projected.x) < 0.90, 'grips remain in frame above cropped sleeves');
        }
      }
    });
    assert.equal(ray.intersectObjects(meshes, false).length, 0, 'no triangle covers the exact reticle');
  }
});

test('bat pose is stateless and repeated poses do not allocate geometry or upload joint buffers again', () => {
  const stepped = createFirstPersonBat(), direct = createFirstPersonBat();
  for (const remaining of [1, 0.89, 0.76, 0.6, 0.5, 0.33]) poseFirstPersonBat(stepped, remaining, 2, 0.5);
  poseFirstPersonBat(direct, 0.33, 2, 0.5);
  const a = stepped.userData.firstPersonBat, b = direct.userData.firstPersonBat;
  assert.deepEqual(a.pivot.position.toArray(), b.pivot.position.toArray());
  assert.deepEqual(a.pivot.quaternion.toArray(), b.pivot.quaternion.toArray());
  for (const side of ['left', 'right']) {
    const first = a.hands.userData.firstPersonGripHands[side], second = b.hands.userData.firstPersonGripHands[side];
    assert.deepEqual(first.hand.position.toArray(), second.hand.position.toArray());
    assert.deepEqual(first.hand.quaternion.toArray(), second.hand.quaternion.toArray());
    assert.deepEqual(first.surface.morphTargetInfluences, second.surface.morphTargetInfluences);
    const array = first.surface.geometry.attributes.position.array, version = first.surface.geometry.attributes.position.version;
    const matrix = first.poseMatrix, geometry = first.surface.geometry, morph = geometry.morphAttributes.position[0];
    const morphVersion = morph.version;
    poseFirstPersonBat(stepped, 0.33, 2, 0.5);
    assert.equal(first.surface.geometry.attributes.position.array, array); assert.equal(first.surface.geometry.attributes.position.version, version);
    assert.equal(first.poseMatrix, matrix); assert.equal(first.surface.geometry, geometry);
    assert.equal(geometry.morphAttributes.position[0], morph); assert.equal(morph.version, morphVersion);
  }
});

test('reduced motion suppresses bob without weakening the essential swing and handles invalid state', () => {
  const full = createFirstPersonBat(), reduced = createFirstPersonBat();
  for (const phase of [0, 0.24, 0.5, 0.7, 0.86, 1]) {
    poseFirstPersonBat(full, 1 - phase, 0, 0, false);
    poseFirstPersonBat(reduced, 1 - phase, 324, 1, true);
    const a = full.userData.firstPersonBat, b = reduced.userData.firstPersonBat;
    assert.deepEqual(a.pivot.position.toArray(), b.pivot.position.toArray());
    assert.deepEqual(a.pivot.quaternion.toArray(), b.pivot.quaternion.toArray());
    for (const side of ['left', 'right']) {
      assert.deepEqual(a.hands.userData.firstPersonGripHands[side].hand.position.toArray(), b.hands.userData.firstPersonGripHands[side].hand.position.toArray());
    }
  }
  poseFirstPersonBat(reduced, NaN, Infinity, NaN);
  visitVertices(reduced, point => assert.ok(point.toArray().every(Number.isFinite)));
  assert.doesNotThrow(() => poseFirstPersonBat(null));
});
