import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHumanoidRig, updateHumanoidPose, resetHumanoidPose, attachHeldWeapon } from '../../src/render/humanoid-rig.js';
import { gaitStrideAmplitude, sampleGaitFoot } from '../../src/render/humanoid-motion.js';

const TAU = Math.PI * 2;
const point = object => object.getWorldPosition(new THREE.Vector3());
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should be within ${tolerance} of ${expected}`);
const settle = (root, state) => {
  for (let frame = 0; frame < 180; frame++) updateHumanoidPose(root, state, 1 / 60);
};

test('support and swing have continuous positions and velocity at lift-off and touchdown', () => {
  const stride = 0.35, before = {}, contact = {}, after = {}, epsilon = 1e-5;
  for (const phase of [0, Math.PI, TAU]) {
    sampleGaitFoot(phase - epsilon, stride, 0.085, before);
    assert.equal(sampleGaitFoot(phase, stride, 0.085, contact), contact);
    sampleGaitFoot(phase + epsilon, stride, 0.085, after);
    near((contact.travel - before.travel) / epsilon, -2 * stride / Math.PI, 1e-5);
    near((after.travel - contact.travel) / epsilon, -2 * stride / Math.PI, 1e-5);
    near(contact.lift, 0);
    near((after.lift - before.lift) / (2 * epsilon), 0, 1e-5);
  }
  for (let frame = 0; frame <= 500; frame++) {
    sampleGaitFoot(frame / 500 * TAU, stride, 0.085, before);
    sampleGaitFoot(frame / 500 * TAU + Math.PI, stride, 0.085, after);
    assert.ok(before.lift >= 0 && after.lift >= 0);
    near(Math.min(before.lift, after.lift), 0);
  }
});

test('actual rig support feet stay planted against steady translation at different speeds, directions and frame rates', () => {
  for (const config of [
    { height: 0.9, build: 0.7, kind: 'child' },
    { height: 1.82, build: 1.05, kind: 'thug' },
    { height: 2.2, build: 1.5, kind: 'adult' },
  ]) {
    const root = createHumanoidRig(config), rig = root.userData.rig;
    for (const speed of [0.25, 1.2, 2.4, 4]) {
      for (const direction of [[1, 0], [-1, 0], [0, 1], [0.6, -0.8]]) {
        for (const rate of [30, 120]) {
          resetHumanoidPose(root);
          root.position.set(3, 4, -2); root.rotation.y = 0.7;
          const state = { mode: 'walk', speed, forward: direction[0], strafe: direction[1] };
          settle(root, state);
          const velocity = new THREE.Vector3(direction[1], 0, direction[0]).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.7).multiplyScalar(speed);
          const previous = { L: null, R: null }, previousSupported = { L: false, R: false };
          const sample = {};
          let checked = 0;
          for (let frame = 0; frame < rate; frame++) {
            root.position.addScaledVector(velocity, 1 / rate);
            updateHumanoidPose(root, state, 1 / rate);
            for (const [side, offset] of [['L', 0], ['R', Math.PI]]) {
              sampleGaitFoot(rig.pose.gait + offset, rig.motion.stride, 0, sample);
              const sole = point(rig.anchors[`sole${side}`]);
              assert.ok(sole.y >= 4 - 1e-6, 'A boot cannot penetrate the floor');
              if (sample.support) {
                near(sole.y, 4);
                if (previousSupported[side]) {
                  near(sole.distanceTo(previous[side]), 0, 2e-5);
                  checked++;
                }
              }
              previous[side] = sole; previousSupported[side] = sample.support;
            }
          }
          assert.ok(checked > rate * 0.45, 'The test must measure real support intervals');
        }
      }
    }
  }
});

test('pelvis turn preserves actual skinned boot soles and level ankle orientation', () => {
  const root = createHumanoidRig({ height: 1.28, build: 0.78, kind: 'child' }), rig = root.userData.rig;
  const garment = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments');
  const positions = garment.geometry.attributes.position;
  const weights = garment.geometry.attributes.skinWeight, indices = garment.geometry.attributes.skinIndex;
  const feet = { L: [], R: [] }, vertex = new THREE.Vector3(), sample = {}, up = new THREE.Vector3(0, 1, 0);
  for (const side of ['L', 'R']) {
    const bone = garment.skeleton.bones.indexOf(rig.joints[`ankle${side}`]);
    for (let index = 0; index < positions.count; index++) {
      if (positions.getY(index) < 1e-6 && indices.getX(index) === bone && weights.getX(index) > 0.999) feet[side].push(index);
    }
    assert.ok(feet[side].length >= 6, 'Inspect the rendered sole surface, not a legacy bounds proxy');
  }
  const state = { mode: 'walk', speed: 4, forward: 0.6, strafe: 0.8 };
  settle(root, state);
  let pelvisTurn = 0;
  for (let frame = 0; frame < 80; frame++) {
    updateHumanoidPose(root, state, 1 / 120); root.updateMatrixWorld(true);
    pelvisTurn = Math.max(pelvisTurn, Math.abs(rig.joints.hips.rotation.y));
    for (const [side, offset] of [['L', 0], ['R', Math.PI]]) {
      sampleGaitFoot(rig.pose.gait + offset, rig.motion.stride, Math.min(0.09, rig.height * 0.047 * rig.motion.walk), sample);
      for (const index of feet[side]) {
        garment.getVertexPosition(index, vertex).applyMatrix4(garment.matrixWorld);
        near(vertex.y, sample.lift, 1e-6);
      }
      const orientation = rig.joints[`ankle${side}`].getWorldQuaternion(new THREE.Quaternion());
      near(up.clone().applyQuaternion(orientation).distanceTo(up), 0, 1e-6);
    }
  }
  assert.ok(pelvisTurn > 0.015, 'The pelvis moves over the supported leg');
});

test('free arms oppose the stepping leg while neck and head reduce torso yaw', () => {
  const root = createHumanoidRig({ height: 1.78, kind: 'brawler' }), rig = root.userData.rig;
  const state = { mode: 'walk', speed: 2.4, forward: 1, alert: 0.6 };
  settle(root, state);
  const values = [];
  let neckRange = 0, chestRange = 0, headRange = 0;
  for (let frame = 0; frame < 180; frame++) {
    updateHumanoidPose(root, state, 1 / 120);
    const leftFoot = point(rig.anchors.soleL), rightHand = point(rig.anchors.gripR);
    const chestForward = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.joints.chest.getWorldQuaternion(new THREE.Quaternion()));
    const headForward = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.joints.head.getWorldQuaternion(new THREE.Quaternion()));
    chestRange = Math.max(chestRange, Math.abs(Math.atan2(chestForward.x, chestForward.z)));
    headRange = Math.max(headRange, Math.abs(Math.atan2(headForward.x, headForward.z)));
    neckRange = Math.max(neckRange, Math.abs(rig.joints.neck.rotation.y));
    values.push([leftFoot.z, rightHand.z]);
  }
  const footMean = values.reduce((sum, value) => sum + value[0], 0) / values.length;
  const handMean = values.reduce((sum, value) => sum + value[1], 0) / values.length;
  let cross = 0, footSquared = 0, handSquared = 0;
  for (const [foot, hand] of values) {
    cross += (foot - footMean) * (hand - handMean);
    footSquared += (foot - footMean) ** 2; handSquared += (hand - handMean) ** 2;
  }
  assert.ok(cross / Math.sqrt(footSquared * handSquared) > 0.8, 'The opposite hand advances with the stepping leg');
  assert.ok(neckRange > 0.002, 'Gaze movement is shared with the neck');
  assert.ok(headRange < chestRange * 0.72, 'The head remains more stable than the turning torso');
});

test('starting and stopping settle leg reach without resetting gait or bobbing while still', () => {
  const root = createHumanoidRig({ height: 1.82, kind: 'thug' }), rig = root.userData.rig;
  const stopped = { mode: 'walk', speed: 0 };
  settle(root, { mode: 'walk', speed: 4 });
  const gait = rig.pose.gait, stride = rig.motion.stride;
  updateHumanoidPose(root, stopped, 1 / 60);
  assert.equal(rig.pose.gait, gait, 'Stopped translation cannot continue taking steps');
  assert.ok(rig.motion.stride > stride * 0.5 && rig.motion.stride < stride, 'Feet ease toward rest instead of snapping');
  settle(root, stopped);
  assert.equal(rig.pose.gait, gait);
  near(point(rig.anchors.soleL).y, 0); near(point(rig.anchors.soleR).y, 0);
  const hip = rig.joints.hips.position.clone();
  for (let frame = 0; frame < 60; frame++) updateHumanoidPose(root, stopped, 1 / 60);
  near(rig.joints.hips.position.distanceTo(hip), 0);
  assert.equal(gaitStrideAmplitude(0, rig.height), 0);
});

test('motion updates change bones only and retain exact firearm forward aim through new pelvis motion', () => {
  const root = createHumanoidRig({ height: 1.94, build: 1.32, kind: 'bruiser' });
  const weapon = attachHeldWeapon(root, 'shotgun'), rig = root.userData.rig;
  const state = { mode: 'ranged', speed: 3.6, forward: 0.6, strafe: 0.8, aim: 1, alert: 1 };
  settle(root, state);
  const attributes = rig.visualMeshes.flatMap(mesh => Object.values(mesh.geometry.attributes).map(attribute => [attribute, attribute.version]));
  for (let frame = 0; frame < 120; frame++) {
    updateHumanoidPose(root, state, 1 / 120);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(weapon.getWorldQuaternion(new THREE.Quaternion()));
    near(forward.distanceTo(new THREE.Vector3(0, 0, 1)), 0);
    near(point(rig.anchors.gripL).distanceTo(point(weapon.userData.anchors.supportHand)), 0);
  }
  for (const [attribute, version] of attributes) assert.equal(attribute.version, version, 'No geometry or skin buffer upload is needed');
  root.traverse(object => {
    object.updateMatrixWorld = () => assert.fail('Pose must not traverse matrices');
    object.updateWorldMatrix = () => assert.fail('Pose must not traverse matrices');
  });
  updateHumanoidPose(root, state, 1 / 60);
});

test('moving firearm poses clear the actual rendered head through aim and stagger transitions', () => {
  for (const [kind, height, build, type] of [
    ['gunman', 1.76, 0.98, 'pistol'], ['bruiser', 1.94, 1.32, 'shotgun'],
    ['hitman', 1.78, 1, 'smg'], ['bruiser', 1.92, 1.28, 'machinegun'],
  ]) {
    const root = createHumanoidRig({ kind, height, build }), weapon = attachHeldWeapon(root, type);
    const head = root.userData.rig.visualMeshes.find(mesh => mesh.name === 'hero-head');
    const positions = weapon.geometry.attributes.position, box = new THREE.Box3(), vertex = new THREE.Vector3();
    for (const aim of [0, 1, 0.3, 1]) {
      for (let frame = 0; frame < 36; frame++) {
        updateHumanoidPose(root, { mode: 'ranged', speed: 3.6, forward: 0.6, strafe: 0.8,
          aim, alert: 1, stagger: frame > 24 }, 1 / 60);
        root.updateMatrixWorld(true); box.setFromObject(head, true);
        for (let index = 0; index < positions.count; index++) {
          vertex.fromBufferAttribute(positions, index).applyMatrix4(weapon.matrixWorld);
          assert.equal(box.containsPoint(vertex), false, `${type} must clear the rendered head during moving aim`);
        }
      }
    }
  }
});
