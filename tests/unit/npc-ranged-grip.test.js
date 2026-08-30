import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHumanoidRig, createHeldWeapon, attachHeldWeapon, updateHumanoidPose, resetHumanoidPose } from '../../src/render/humanoid-rig.js';
import { beginHumanoidCollapse, updateHumanoidCollapse } from '../../src/render/corpse-pose.js';

const GUNS = {
  pistol: { triangles: 856, muzzleZ: 0.22 }, shotgun: { triangles: 1172, muzzleZ: 0.735 },
  smg: { triangles: 1280, muzzleZ: 0.41 }, machinegun: { triangles: 1320, muzzleZ: 0.665 },
};
const CONFIGS = [
  { height: 0.9, build: 0.7, kind: 'child' }, { height: 1.5, build: 0.8, kind: 'adult' },
  { height: 1.76, build: 0.98, kind: 'gunman' }, { height: 1.94, build: 1.32, kind: 'bruiser' },
  { height: 2.2, build: 1.5, kind: 'adult' },
];
const point = object => object.getWorldPosition(new THREE.Vector3());
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should be within ${tolerance} of ${expected}`);

function assertGripAndBones(root, gun) {
  const { anchors, joints, dimensions: d } = root.userData.rig;
  near(point(anchors.gripL).distanceTo(point(gun.userData.anchors.supportHand)), 0);
  near(gun.worldToLocal(point(anchors.gripR)).length(), 0);
  for (const side of ['L', 'R']) {
    near(point(joints[`shoulder${side}`]).distanceTo(point(joints[`elbow${side}`])), d.upperArmLength);
    near(point(joints[`elbow${side}`]).distanceTo(point(joints[`wrist${side}`])), d.forearmLength);
    for (const name of ['shoulder', 'elbow', 'wrist']) assert.deepEqual(joints[`${name}${side}`].scale.toArray(), [1, 1, 1]);
  }
  const scale = gun.getWorldScale(new THREE.Vector3());
  near(scale.x, 1); near(scale.y, 1); near(scale.z, 1);
  const leftHand = root.userData.rig.bodyMeshes.find(mesh => mesh.name === 'hand.L');
  assert.ok(new THREE.Box3().setFromObject(leftHand).containsPoint(point(gun.userData.anchors.supportHand)),
    'The support point lies inside the visible palm, not just near its arm');
}

test('firearm support anchors retain canonical geometry, muzzle coordinates and two grouped draws', () => {
  for (const [type, expected] of Object.entries(GUNS)) {
    const first = createHeldWeapon(type), second = createHeldWeapon(type);
    assert.equal(first.geometry, second.geometry);
    assert.equal(first.geometry.attributes.position.count / 3, expected.triangles);
    assert.equal(first.geometry.groups.length, 2);
    assert.equal(first.userData.anchors.muzzle, first.userData.muzzle);
    assert.deepEqual(first.userData.muzzle.position.toArray(), [0, 0.041, expected.muzzleZ]);
    const support = first.userData.anchors.supportHand;
    assert.equal(support.parent, first);
    assert.ok(first.geometry.boundingBox.clone().expandByScalar(0.04).containsPoint(support.position));
    let meshes = 0; first.traverse(object => { if (object.isMesh) meshes++; });
    assert.equal(meshes, 1, 'Anchors add no rendered meshes');
  }
});

test('reduced firearm meshes retain real barrel, ejection and trigger openings', () => {
  const rimRadii = { pistol: 0.010, shotgun: 0.016, smg: 0.016, machinegun: 0.019 };
  const receiverWidths = { pistol: 0.052, shotgun: 0.065, smg: 0.057, machinegun: 0.066 };
  for (const [type, expected] of Object.entries(GUNS)) {
    const gun = createHeldWeapon(type); gun.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0.041, expected.muzzleZ + 0.05), new THREE.Vector3(0, 0, -1));
    const bore = ray.intersectObject(gun, false)[0];
    assert.ok(bore, `${type}: bore has an inset dark floor`);
    assert.ok(expected.muzzleZ - bore.point.z > 0.03, `${type}: muzzle is not a solid cylinder cap`);
    ray.ray.origin.x = rimRadii[type];
    const rim = ray.intersectObject(gun, false)[0];
    assert.ok(rim, `${type}: a real annular crown surrounds the opening`);
    near(rim.point.z, expected.muzzleZ);
    ray.set(new THREE.Vector3(-0.1, 0.038, 0.09), new THREE.Vector3(1, 0, 0));
    const bolt = ray.intersectObject(gun, false)[0];
    assert.ok(bolt, `${type}: the open ejection pocket has a bolt behind it`);
    near(bolt.point.x, -receiverWidths[type] / 2 + 0.006);
    ray.set(new THREE.Vector3(-0.1, -0.031, 0.042), new THREE.Vector3(1, 0, 0));
    assert.equal(ray.intersectObject(gun, false).length, 0, `${type}: trigger guard has an actual clear opening`);
    ray.ray.origin.y = -0.052;
    assert.ok(ray.intersectObject(gun, false).length, `${type}: guard has a visible lower wall`);
  }
});

test('actual ranged poses keep both grips attached throughout aim, motion and stagger transitions', () => {
  for (const config of CONFIGS) {
    for (const type of Object.keys(GUNS)) {
      const root = createHumanoidRig(config), gun = attachHeldWeapon(root, type), rig = root.userData.rig;
      root.position.set(3, 4.02, -2); root.rotation.set(0.025, 0.7, -0.015, 'YXZ');
      assert.equal(rig.ranged.weapon, gun);
      assert.equal(rig.anchors.weaponSupportHand, gun.userData.anchors.supportHand);
      const geometries = rig.bodyMeshes.map(mesh => mesh.geometry);
      for (const aim of [0, 0.25, 0.5, 0.75, 1, 0, 1]) {
        for (let frame = 0; frame < 24; frame++) {
          updateHumanoidPose(root, { mode: 'ranged', aim, alert: 1, speed: 2.2,
            forward: 0.4, strafe: 0.8, stagger: frame > 18 }, 1 / 60);
          root.updateMatrixWorld(true);
          assertGripAndBones(root, gun);
        }
      }
      assert.deepEqual(rig.bodyMeshes.map(mesh => mesh.geometry), geometries);
      assert.equal(gun.geometry.attributes.position.count / 3, GUNS[type].triangles);
    }
  }
});

test('adult gun silhouettes clear the face and point forward from low ready through aim', () => {
  for (const config of CONFIGS.slice(1)) {
    for (const type of Object.keys(GUNS)) {
      const root = createHumanoidRig(config), gun = attachHeldWeapon(root, type), rig = root.userData.rig;
      const head = rig.bodyMeshes.find(mesh => mesh.name === 'head');
      const muzzleHeights = [];
      for (const aim of [0, 0.5, 1]) {
        for (let frame = 0; frame < 90; frame++) updateHumanoidPose(root, { mode: 'ranged', aim, alert: 1, speed: 0 }, 1 / 60);
        root.updateMatrixWorld(true);
        const direction = new THREE.Vector3(0, 0, 1).transformDirection(gun.matrixWorld);
        assert.ok(direction.z > 0.65, `${type}: the barrel remains forward`);
        if (aim === 0) assert.ok(direction.y < -0.35, `${type}: visibly lowered ready pose`);
        if (aim === 1) {
          assert.ok(direction.z > 1 - 1e-10, `${type}: aimed barrel follows the forward axis`);
          assert.ok(Math.abs(direction.y) < 1e-6, `${type}: level aim`);
        }
        muzzleHeights.push(point(gun.userData.muzzle).y);
        const faceBounds = new THREE.Box3().setFromObject(head, true), vertex = new THREE.Vector3();
        const positions = gun.geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          vertex.fromBufferAttribute(positions, i).applyMatrix4(gun.matrixWorld);
          assert.equal(faceBounds.containsPoint(vertex), false, `${type}: weapon geometry clears the head`);
        }
      }
      assert.ok(muzzleHeights[2] - muzzleHeights[0] > config.height * 0.08, 'Raising the gun provides a readable aim cue');
    }
  }
});

test('full aim follows the actual actor forward axis despite root yaw, stride and chest reactions', () => {
  for (const type of Object.keys(GUNS)) {
    const root = createHumanoidRig({ height: 1.94, build: 1.32, kind: 'bruiser' }), gun = attachHeldWeapon(root, type);
    root.position.set(-8, 4.02, 7);
    for (const yaw of [-2.4, -0.7, 0.5, 2.1]) {
      root.rotation.set(0, yaw, 0, 'YXZ');
      for (let frame = 0; frame < 100; frame++) {
        updateHumanoidPose(root, { mode: 'ranged', aim: 1, alert: 1, speed: 2.8, forward: 0, strafe: 1, stagger: true }, 1 / 60);
      }
      root.updateMatrixWorld(true);
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const barrel = new THREE.Vector3(0, 0, 1).transformDirection(gun.matrixWorld);
      assert.ok(barrel.distanceTo(forward) < 1e-6, `${type}: muzzle direction matches actor yaw ${yaw}`);
      assertGripAndBones(root, gun);
    }
  }
});

test('ranged pose updates use no matrix traversal and smooth abrupt aim changes', () => {
  const root = createHumanoidRig({ height: 1.94, build: 1.32, kind: 'bruiser' });
  const gun = attachHeldWeapon(root, 'machinegun');
  const previous = new THREE.Quaternion(), current = new THREE.Quaternion();
  for (const aim of [0, 1, 0, 1]) {
    for (let frame = 0; frame < 45; frame++) {
      gun.getWorldQuaternion(previous);
      updateHumanoidPose(root, { mode: 'ranged', aim, alert: 1, speed: 2.8 }, 1 / 60);
      gun.getWorldQuaternion(current);
      if (frame > 0 || aim > 0) assert.ok(previous.angleTo(current) < 0.23, 'Aim blending avoids a sudden weapon rotation');
      assertGripAndBones(root, gun);
    }
  }
  root.traverse(object => {
    object.updateMatrixWorld = () => assert.fail('Pose must not traverse world matrices');
    object.updateWorldMatrix = () => assert.fail('Pose must not traverse world matrices');
  });
  updateHumanoidPose(root, { mode: 'ranged', aim: 0.5, alert: 1, speed: 1.5 }, 1 / 60);
});

test('collapse and pooled reset retain firearm attachments and clear the new aim state', () => {
  const root = createHumanoidRig({ height: 1.76, kind: 'gunman' }), gun = attachHeldWeapon(root, 'pistol');
  const rig = root.userData.rig;
  for (let frame = 0; frame < 90; frame++) updateHumanoidPose(root, { mode: 'ranged', aim: 1, alert: 1 }, 1 / 60);
  assert.ok(rig.ranged.aim > 0.99);
  assert.equal(beginHumanoidCollapse(root, 0, 0), true);
  assert.equal(updateHumanoidCollapse(root, 0.6), true);
  assert.equal(rig.pose.phase, 'settled');
  resetHumanoidPose(root);
  root.position.set(0, 0, 0); root.rotation.set(0, 0, 0);
  assert.equal(rig.ranged.aim, 0);
  assert.equal(rig.ranged.weapon, gun);
  assert.equal(rig.anchors.weaponMuzzle, gun.userData.muzzle);
  assert.equal(gun.parent, rig.anchors.gripR);
  for (const rest of rig.neutral) {
    assert.ok(rest.object.position.equals(rest.position));
    assert.ok(rest.object.quaternion.equals(rest.quaternion));
    assert.ok(rest.object.scale.equals(rest.scale));
  }
  updateHumanoidPose(root, { mode: 'ranged', aim: 0, alert: 0 }, 1 / 60);
  root.updateMatrixWorld(true); assertGripAndBones(root, gun);
  const melee = createHumanoidRig({ kind: 'thug' });
  attachHeldWeapon(melee, 'bat');
  assert.equal(melee.userData.rig.ranged.weapon, null, 'The bat retains its separate grip solver');
});
