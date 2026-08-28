import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFirstPersonHands, poseFirstPersonHands, punchExtension, FIRST_PERSON_PUNCH_SECONDS, FIRST_PERSON_PUNCH_CONTACT_PHASE } from '../../src/render/first-person-hands.js';
import { getViewModelMuzzle, VIEW_MODEL_LAYER } from '../../src/render/viewmodel.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { weaponHarness } from './helpers/weapon-harness.js';

// Traverse the actual vertices, including every instance. A union of rotated
// boxes can greatly overstate the size of a curved finger or diagonal wrist.
function visitVertices(root, visitor) {
  root.updateWorldMatrix(true, true);
  const point = new THREE.Vector3(), matrix = new THREE.Matrix4(), instance = new THREE.Matrix4();
  root.traverse(object => {
    if (!object.isMesh) return;
    const positions = object.geometry.attributes.position;
    for (let slot = 0; slot < (object.isInstancedMesh ? object.count : 1); slot++) {
      matrix.copy(object.matrixWorld);
      if (object.isInstancedMesh) { object.getMatrixAt(slot, instance); matrix.multiply(instance); }
      for (let i = 0; i < positions.count; i++) visitor(point.fromBufferAttribute(positions, i).applyMatrix4(matrix), object);
    }
  });
}

test('two articulated fists share geometry and remain within a small draw budget', () => {
  const a = createFirstPersonHands(), b = createFirstPersonHands();
  const hands = a.userData.firstPersonHands;
  assert.equal(hands.order.length, 2);
  assert.equal(a.rotation.y, 0); assert.deepEqual(a.scale.toArray(), [1, 1, 1]);
  let meshes = 0, triangles = 0;
  a.traverse(object => {
    if (!object.isMesh) return;
    meshes++;
    triangles += object.geometry.index.count / 3 * (object.isInstancedMesh ? object.count : 1);
    assert.notEqual(object.geometry.type, 'BoxGeometry');
    assert.notEqual(object.geometry.type, 'RoundedBoxGeometry');
    assert.equal(object.castShadow, false); assert.equal(object.receiveShadow, false);
  });
  assert.equal(meshes, 12); assert.ok(triangles <= 9000);
  assert.equal(hands.left.palm.geometry, hands.right.palm.geometry);
  assert.equal(hands.left.segments.geometry, b.userData.firstPersonHands.right.segments.geometry);
  assert.equal(hands.left.knuckles.geometry, hands.right.knuckles.geometry);
  assert.equal(hands.left.segments.material, hands.right.segments.material);
  for (const rig of hands.order) {
    assert.equal(rig.fingers.length, 4);
    assert.equal(rig.thumb.joints.length, 3);
    assert.equal(rig.segments.count, 15); assert.equal(rig.knuckles.count, 15);
    assert.equal(rig.palm.geometry.type, 'SphereGeometry');
  }
});

test('fingers curl into a human-scale palm, opposed thumbs and connected sleeves', () => {
  const model = createFirstPersonHands();
  for (const remaining of [0, 0.8, 0.5, 0.3]) {
    poseFirstPersonHands(model, remaining, 1);
    model.updateMatrixWorld(true);
    for (const rig of model.userData.firstPersonHands.order) {
      const inverse = rig.hand.matrixWorld.clone().invert(), bounds = new THREE.Box3();
      visitVertices(rig.hand, point => bounds.expandByPoint(point.applyMatrix4(inverse)));
      const size = bounds.getSize(new THREE.Vector3());
      assert.ok(size.x > 0.085 && size.x < 0.108, `hand width ${size.x}`);
      assert.ok(size.y < 0.08 && size.z < 0.20);
      for (const finger of rig.fingers) {
        assert.equal(finger.joints.length, 4);
        assert.ok(finger.joints[1].z < finger.joints[0].z, 'proximal phalanx faces forward');
        assert.ok(finger.joints[3].y < finger.joints[0].y - 0.027, 'finger is curled below its knuckle');
        assert.ok(finger.joints[3].z > finger.joints[2].z, 'fingertip curls back into the palm');
        for (let i = 0; i < 3; i++) {
          const length = finger.joints[i].distanceTo(finger.joints[i + 1]);
          assert.ok(length > 0.010 && length < 0.030, `bounded phalanx ${length}`);
        }
      }
      assert.ok(rig.thumb.joints[1].x * rig.side < -0.04, 'thumb lies on the inner side of each hand');
      assert.ok(Math.abs(rig.thumb.joints[2].x) < Math.abs(rig.thumb.joints[1].x), 'thumb opposes curled fingers');
      const top = new THREE.Vector3(0, 0.5, 0).applyMatrix4(rig.sleeve.matrixWorld);
      const bottom = new THREE.Vector3(0, -0.5, 0).applyMatrix4(rig.sleeve.matrixWorld);
      assert.ok(top.distanceTo(rig.wrist) < 1e-9, 'sleeve reaches the moving wrist');
      assert.ok(bottom.distanceTo(rig.anchor) < 1e-9, 'forearm stays connected to its fixed lower-frame anchor');
      assert.ok(rig.cuff.position.distanceTo(rig.wrist) < 0.01);
    }
  }
});

test('jabs alternate sides, extend forward and recover smoothly to the lower guard', () => {
  const model = createFirstPersonHands(), { left, right } = model.userData.firstPersonHands;
  const restLeft = left.hand.position.clone(), restRight = right.hand.position.clone();
  assert.equal(FIRST_PERSON_PUNCH_SECONDS, WEAPON_DEFS.fists.attackDuration);
  assert.equal(FIRST_PERSON_PUNCH_CONTACT_PHASE, WEAPON_DEFS.fists.contactPhase);
  assert.equal(punchExtension(1), 0); assert.equal(punchExtension(0), 0);
  assert.equal(punchExtension(0.5), 1);
  assert.ok(Math.abs(punchExtension(0.50001) - punchExtension(0.49999)) < 1e-7);
  for (let i = 0; i <= 100; i++) assert.ok(punchExtension(i / 100) >= 0 && punchExtension(i / 100) <= 1);
  poseFirstPersonHands(model, 0.5, 1);
  assert.ok(left.hand.position.z < restLeft.z - 0.24);
  assert.ok(Math.abs(right.hand.position.z - restRight.z) < 0.01);
  poseFirstPersonHands(model, 0.5, 0);
  assert.ok(right.hand.position.z < restRight.z - 0.24);
  assert.ok(Math.abs(left.hand.position.z - restLeft.z) < 0.01);
  poseFirstPersonHands(model, 0, 0);
  assert.deepEqual(left.hand.position.toArray(), restLeft.toArray());
  assert.deepEqual(right.hand.position.toArray(), restRight.toArray());
});

test('guard and jabs clear the reticle and near plane across supported fields of view', () => {
  const model = createFirstPersonHands();
  const cameras = [70, 82, 100].flatMap(fov => [4 / 3, 16 / 9].map(aspect => new THREE.PerspectiveCamera(fov, aspect, 0.05, 100)));
  const projected = new THREE.Vector3();
  for (const punch of [0, 1]) {
    for (const phase of [0, 0.15, 0.5, 0.62, 0.85, 1]) {
      poseFirstPersonHands(model, 1 - phase, punch, phase * 7, 1);
      visitVertices(model, point => {
        assert.ok(Number.isFinite(point.x + point.y + point.z));
        assert.ok(point.z < -0.12, `near-plane clearance ${point.z}`);
        for (const camera of cameras) {
          projected.copy(point).project(camera);
          assert.ok(projected.y < -0.07, `reticle clearance ${projected.y} at ${camera.fov}`);
        }
      });
      for (const rig of model.userData.firstPersonHands.order) {
        visitVertices(rig.hand, point => {
          for (const camera of cameras) {
            projected.copy(point).project(camera);
            assert.ok(Math.abs(projected.x) < 0.95, 'fist stays within horizontal frame');
            assert.ok(projected.y > -1.10, 'hand is visible above its cropped sleeve');
          }
        });
      }
    }
  }
});

test('poses depend on simulation state rather than frame history and avoid repeated buffer uploads', () => {
  const stepped = createFirstPersonHands(), direct = createFirstPersonHands();
  for (const remaining of [1, 0.82, 0.5, 0.45, 0.23]) poseFirstPersonHands(stepped, remaining, 1, 2, 0.5);
  poseFirstPersonHands(direct, 0.23, 1, 2, 0.5);
  for (const side of ['left', 'right']) {
    const a = stepped.userData.firstPersonHands[side], b = direct.userData.firstPersonHands[side];
    assert.deepEqual(a.hand.position.toArray(), b.hand.position.toArray());
    assert.deepEqual(Array.from(a.segments.instanceMatrix.array), Array.from(b.segments.instanceMatrix.array));
    const buffer = a.segments.instanceMatrix.array, version = a.segments.instanceMatrix.version;
    poseFirstPersonHands(stepped, 0.23, 1, 2, 0.5);
    assert.equal(a.segments.instanceMatrix.array, buffer);
    assert.equal(a.segments.instanceMatrix.version, version);
  }
});

test('reduced motion removes bob, retains contact travel and safely handles invalid inputs', () => {
  const model = createFirstPersonHands(), { left } = model.userData.firstPersonHands;
  poseFirstPersonHands(model, 0, 1, 1, 1, true);
  const guard = left.hand.position.clone();
  poseFirstPersonHands(model, 0, 1, 400, 1, true);
  assert.deepEqual(left.hand.position.toArray(), guard.toArray());
  poseFirstPersonHands(model, 0.5, 1, 400, 1, true);
  assert.ok(guard.z - left.hand.position.z > 0.24 && guard.z - left.hand.position.z < 0.26);
  const fullContact = left.hand.position.clone();
  poseFirstPersonHands(model, 0.5, 1, 0, 0, false);
  assert.deepEqual(left.hand.position.toArray(), fullContact.toArray());
  poseFirstPersonHands(model, NaN, NaN, NaN, Infinity);
  assert.ok(left.hand.position.toArray().every(Number.isFinite));
  assert.doesNotThrow(() => poseFirstPersonHands(null));
});

test('only successful fist input toggles jab side and each jab lands once at contact', () => {
  const { Weapons, calls } = weaponHarness();
  Weapons.init();
  assert.equal(Weapons.punchIndex, 0);
  Weapons.handleInput({ leftPressed: true }, 1 / 120);
  assert.equal(Weapons.punchIndex, 1); assert.equal(Weapons.cooldown, WEAPON_DEFS.fists.rate);
  assert.equal(Weapons.swingT, 1);
  Weapons.handleInput({ leftPressed: true }, 1 / 120);
  assert.equal(Weapons.punchIndex, 1); assert.equal(calls.sounds, 0, 'windup has no impact sound');
  assert.equal(calls.damage.length, 0); assert.equal(calls.ranges.length, 0);
  Weapons.tick(0.08);
  assert.ok(Math.abs(Weapons.swingT - (1 - 0.08 / FIRST_PERSON_PUNCH_SECONDS)) < 1e-12);
  assert.ok(Math.abs(Weapons.cooldown - (WEAPON_DEFS.fists.rate - 0.08)) < 1e-12);
  Weapons.tick(FIRST_PERSON_PUNCH_SECONDS * FIRST_PERSON_PUNCH_CONTACT_PHASE - 0.08);
  assert.equal(calls.sounds, 1); assert.deepEqual(calls.damage, [WEAPON_DEFS.fists.dmg]);
  Weapons.tick(WEAPON_DEFS.fists.rate);
  Weapons.handleInput({ leftPressed: true }, 1 / 120);
  assert.equal(Weapons.punchIndex, 0); assert.equal(calls.sounds, 1);
  Weapons.tick(FIRST_PERSON_PUNCH_SECONDS * FIRST_PERSON_PUNCH_CONTACT_PHASE);
  assert.equal(calls.sounds, 2);
  assert.deepEqual(calls.damage, [WEAPON_DEFS.fists.dmg, WEAPON_DEFS.fists.dmg]);
  assert.deepEqual(calls.ranges, Array(6).fill(WEAPON_DEFS.fists.range));
  Weapons.update(0);
  assert.deepEqual(Weapons.vmGroup.position.toArray(), [0, 0, 0]);
  assert.deepEqual(Weapons.vmGroup.scale.toArray(), [1, 1, 1]);
  Weapons._vm('fists').traverse(object => {
    if (!object.isMesh) return;
    assert.equal(object.layers.mask, 1 << VIEW_MODEL_LAYER);
    assert.equal(object.material.depthTest, true); assert.equal(object.material.depthWrite, true);
  });
});

test('ranged model orientation, barrel attachment and recoil clock remain unchanged', () => {
  const { Weapons, makeWeaponViewModel } = weaponHarness();
  const pistol = makeWeaponViewModel('pistol');
  assert.equal(pistol.rotation.y, Math.PI / 2);
  assert.deepEqual(pistol.scale.toArray(), [1.3, 1.3, 1.3]);
  assert.deepEqual(Array.from(pistol.userData.muzzle), [0.201, 0.04, 0]);
  Weapons.init(); Weapons._equip('pistol', 24); Weapons.update(0);
  assert.deepEqual(Weapons.vmGroup.position.toArray(), [0.22, -0.22, -0.36]);
  const muzzle = getViewModelMuzzle(Weapons._vm('pistol'), new THREE.Vector3());
  assert.ok(muzzle.distanceTo(new THREE.Vector3(0.22, -0.168, -0.6213)) < 1e-8);
  assert.equal(Weapons.loaded, 12); assert.equal(Weapons.reserve, 12);
  const punchIndex = Weapons.punchIndex;
  Weapons.swingT = 1; Weapons.tick(0.05);
  assert.ok(Math.abs(Weapons.swingT - 0.725) < 1e-12);
  assert.equal(Weapons.punchIndex, punchIndex);
});
