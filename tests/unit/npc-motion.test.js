import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createHumanoidRig, attachHeldWeapon, updateHumanoidPose, resetHumanoidPose, getHumanoidVisualBounds,
} from '../../src/render/humanoid-rig.js';
import { sampleBatMotion, NPC_BAT_CONTACT_PHASE } from '../../src/render/humanoid-motion.js';
import { BAT_DIMENSIONS } from '../../src/render/bat-asset.js';
import { beginHumanoidCollapse, updateHumanoidCollapse } from '../../src/render/corpse-pose.js';
import { BALCONY } from '../../src/world/layout.js';

const point = object => object.getWorldPosition(new THREE.Vector3());
const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon,
  `${actual} differs from ${expected} by more than ${epsilon}`);
const state = progress => ({ mode: 'bat', alert: 1, speed: 0, swingProgress: progress });

function bonesStayRigid(rig) {
  const { joints: j, dimensions: d } = rig;
  for (const side of ['L', 'R']) {
    near(point(j[`hip${side}`]).distanceTo(point(j[`knee${side}`])), d.thighLength);
    near(point(j[`knee${side}`]).distanceTo(point(j[`ankle${side}`])), d.shinLength);
    near(point(j[`shoulder${side}`]).distanceTo(point(j[`elbow${side}`])), d.upperArmLength);
    near(point(j[`elbow${side}`]).distanceTo(point(j[`wrist${side}`])), d.forearmLength);
    for (const name of ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle']) {
      assert.deepEqual(j[`${name}${side}`].scale.toArray(), [1, 1, 1]);
    }
  }
}

test('bat motion samples reuse caller storage and return to the same guard', () => {
  const first = {}, last = {}, scratch = {};
  assert.equal(sampleBatMotion(0, first), first);
  sampleBatMotion(1, last);
  assert.deepEqual(last, first);
  for (let i = 0; i <= 1000; i++) {
    assert.equal(sampleBatMotion(i / 1000, scratch), scratch);
    for (const value of Object.values(scratch)) assert.ok(Number.isFinite(value));
  }
  for (const invalid of [NaN, Infinity, -Infinity, -10]) {
    sampleBatMotion(invalid, scratch);
    assert.deepEqual(scratch, first);
  }
  sampleBatMotion(5, scratch);
  assert.deepEqual(scratch, last);
  assert.equal(NPC_BAT_CONTACT_PHASE, 0.5);
});

test('contact has continuous velocity instead of easing to a stop at impact', () => {
  const before = {}, contact = {}, after = {}, epsilon = 1e-5;
  sampleBatMotion(0.5 - epsilon, before);
  sampleBatMotion(0.5, contact);
  sampleBatMotion(0.5 + epsilon, after);
  for (const [field, velocity] of [['yaw', -10.4], ['pitch', 1.2], ['gripX', -0.56], ['chestYaw', -1.6]]) {
    near((contact[field] - before[field]) / epsilon, velocity, 0.01);
    near((after[field] - contact[field]) / epsilon, velocity, 0.01);
  }
});

test('every bat swing keeps both hands on the handle and all bones rigid across body sizes', () => {
  for (const config of [
    { height: 0.9, build: 0.7, kind: 'child' },
    { height: 1.78, build: 1, kind: 'brawler' },
    { height: 1.82, build: 1.05, kind: 'thug' },
    { height: 1.94, build: 1.32, kind: 'bruiser' },
    { height: 2.2, build: 1.5, kind: 'adult' },
  ]) {
    const root = createHumanoidRig(config), bat = attachHeldWeapon(root, 'bat'), rig = root.userData.rig;
    root.position.set(3, 4.02, -2); root.rotation.y = 0.7;
    const spacing = -Math.min(Math.abs(BAT_DIMENSIONS.npcSupportGripZ), rig.dimensions.handLength * 0.87);
    const sampled = {};
    for (let frame = 0; frame <= 100; frame++) {
      const progress = frame / 100;
      updateHumanoidPose(root, state(progress), 1 / 120);
      root.updateMatrixWorld(true);
      const leftGrip = bat.worldToLocal(point(rig.anchors.gripL));
      near(leftGrip.x, 0); near(leftGrip.y, 0); near(leftGrip.z, spacing);
      const rightGrip = bat.worldToLocal(point(rig.anchors.gripR));
      near(rightGrip.length(), 0);
      sampleBatMotion(progress, sampled);
      const desiredGrip = rig.joints.chest.localToWorld(new THREE.Vector3(sampled.gripX, sampled.gripY, sampled.gripZ).multiplyScalar(config.height));
      near(point(rig.anchors.gripR).distanceTo(desiredGrip), 0, 2e-6);
      near(point(bat.userData.anchors.tip).distanceTo(point(bat.userData.anchors.knob)), BAT_DIMENSIONS.length);
      near(point(rig.anchors.soleL).y, root.position.y);
      near(point(rig.anchors.soleR).y, root.position.y);
      bonesStayRigid(rig);
    }
  }
});

test('bat carry and alert transitions preserve the support grip without unreachable arm targets', () => {
  for (const config of [{ height: 0.9, build: 0.7 }, { height: 1.94, build: 1.32 }]) {
    const root = createHumanoidRig(config), bat = attachHeldWeapon(root, 'bat'), rig = root.userData.rig;
    const spacing = -Math.min(0.085, rig.dimensions.handLength * 0.87);
    for (const alert of [0, 1, 0]) {
      for (let frame = 0; frame < 45; frame++) {
        updateHumanoidPose(root, { mode: 'bat', alert, speed: 2.2, swingProgress: -1 }, 1 / 60);
        root.updateMatrixWorld(true);
        const localGrip = bat.worldToLocal(point(rig.anchors.gripL));
        near(localGrip.x, 0); near(localGrip.y, 0); near(localGrip.z, spacing);
        bonesStayRigid(rig);
      }
    }
  }
});

test('relaxed and alert guards hold the barrel up and behind the shoulder, even while walking', () => {
  for (const config of [
    { height: 0.9, build: 0.7 }, { height: 1.82, build: 1.05 },
    { height: 1.94, build: 1.32 }, { height: 2.2, build: 1.5 },
  ]) {
    const root = createHumanoidRig(config), bat = attachHeldWeapon(root, 'bat'), rig = root.userData.rig;
    root.position.set(7, 4, -3); root.rotation.y = -1.2;
    for (const speed of [0, 3.6]) {
      for (const alert of [0, 1, 0]) {
        for (let frame = 0; frame < 90; frame++) {
          updateHumanoidPose(root, { mode: 'bat', alert, speed, swingProgress: -1 }, 1 / 60);
          const tip = root.worldToLocal(point(bat.userData.anchors.tip));
          const grip = root.worldToLocal(point(rig.anchors.gripR));
          const shoulder = root.worldToLocal(point(rig.joints.shoulderR));
          const direction = tip.clone().sub(grip).normalize();
          assert.ok(direction.y > 0.8, 'A resting bat points up, not toward the player');
          assert.ok(direction.z < -0.2 && tip.z < 0, 'The barrel remains behind the body');
          assert.ok(tip.y > shoulder.y + 0.3, 'The barrel is raised above the shoulder');
          assert.ok(grip.x > config.height * 0.06, 'Both hands hold it beside the right shoulder');
          assert.ok(grip.distanceTo(shoulder) < config.height * 0.16, 'The guard does not extend the hands forward like a spear');
        }
      }
    }
  }
});

test('charging and recovered guards stay back; forward extension is limited to the strike', () => {
  const root = createHumanoidRig({ height: 1.82, kind: 'thug' }), bat = attachHeldWeapon(root, 'bat');
  for (let frame = 0; frame <= 200; frame++) {
    const progress = frame / 200;
    updateHumanoidPose(root, state(progress), 1 / 120);
    const tip = point(bat.userData.anchors.tip), grip = point(root.userData.rig.anchors.gripR);
    const direction = tip.clone().sub(grip).normalize();
    if (progress <= 0.32 || progress >= 0.82) {
      assert.ok(tip.z < 0 && direction.z < -0.25, `Guard or load projects forward at ${progress}`);
      assert.ok(direction.y > 0.6, `Guard or load drops the barrel at ${progress}`);
    }
    if (direction.z > 0.6 || tip.z > 0.75) {
      assert.ok(progress > 0.38 && progress < 0.63, `Unintended forward thrust at ${progress}`);
    }
    if (progress >= 0.65) assert.ok(direction.z < 0.3, 'Recovery lifts the bat before turning it back');
  }
});

test('combatant heads stay clear of the full bat throughout the raised recovery', () => {
  for (const config of [
    { height: 1.78, build: 1, kind: 'brawler' },
    { height: 1.82, build: 1.05, kind: 'thug' },
    { height: 1.94, build: 1.32, kind: 'bruiser' },
    { height: 2.2, build: 1.5, kind: 'adult' },
  ]) {
    const root = createHumanoidRig(config), bat = attachHeldWeapon(root, 'bat'), rig = root.userData.rig;
    const head = root.userData.hitZones, radius = BAT_DIMENSIONS.barrelRadius;
    // Expanding by the largest barrel radius is conservative even at the
    // narrower handle and knob. Test the whole segment, not only the tip.
    const bounds = new THREE.Box3(
      new THREE.Vector3(-head.headHalfWidth - radius, -head.headHalfHeight - radius, -head.headHalfDepth - radius),
      new THREE.Vector3(head.headHalfWidth + radius, head.headHalfHeight + radius, head.headHalfDepth + radius),
    );
    for (let frame = 0; frame <= 400; frame++) {
      const progress = frame / 400;
      updateHumanoidPose(root, state(progress), 1 / 120);
      const from = head.headAnchor.worldToLocal(point(bat.userData.anchors.knob));
      const to = head.headAnchor.worldToLocal(point(bat.userData.anchors.tip));
      const direction = to.clone().sub(from).normalize();
      const hit = new THREE.Ray(from, direction).intersectBox(bounds, new THREE.Vector3());
      assert.ok(!bounds.containsPoint(from) && (!hit || hit.distanceTo(from) > from.distanceTo(to)),
        `${config.kind} barrel intersects its head during phase ${progress}`);
      for (const side of ['L', 'R']) {
        const elbow = point(rig.joints[`elbow${side}`]);
        const upper = point(rig.joints[`shoulder${side}`]).sub(elbow);
        const lower = point(rig.joints[`wrist${side}`]).sub(elbow);
        const flex = Math.PI - upper.angleTo(lower);
        assert.ok(flex < 150 * Math.PI / 180, `The raised guard overfolds the ${side} elbow`);
      }
    }
  }
});

test('a planted swing transfers weight while both sole positions stay fixed', () => {
  const root = createHumanoidRig({ height: 1.82, kind: 'thug' }), rig = root.userData.rig;
  attachHeldWeapon(root, 'bat');
  const soles = {}, min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let frame = 0; frame <= 100; frame++) {
    updateHumanoidPose(root, { ...state(frame / 100), speed: 3.6 }, 1 / 60);
    root.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      const current = point(rig.anchors[`sole${side}`]);
      if (frame === 0) soles[side] = current;
      else near(current.distanceTo(soles[side]), 0);
    }
    min.min(rig.joints.hips.position); max.max(rig.joints.hips.position);
  }
  assert.ok(max.x - min.x > 0.06, 'Weight crosses from the loaded side to the leading foot');
  assert.ok(max.z - min.z > 0.05, 'Hips drive forward through the strike');
  assert.ok(max.y - min.y > 0.025, 'Knees absorb the strike and recovery');
  assert.equal(rig.pose.gait, 0, 'Attack feet do not continue a walking cycle');
});

test('the physical barrel loads behind the shoulder, crosses the player at .5 and follows through', () => {
  const root = createHumanoidRig({ height: 1.82, kind: 'thug' }), bat = attachHeldWeapon(root, 'bat');
  const at = progress => {
    updateHumanoidPose(root, state(progress), 1 / 60);
    return point(bat.userData.anchors.tip);
  };
  const windup = at(0.18), before = at(0.49), contact = at(0.50), after = at(0.51), follow = at(0.65);
  assert.ok(windup.x > 0.3 && windup.z < -0.3, 'The barrel visibly loads behind the right shoulder');
  assert.ok(Math.abs(contact.x) < 0.13 && contact.z > 1.15);
  assert.ok(contact.y > 1.15 && contact.y < 1.45, 'Contact crosses the torso at the target, not above it');
  assert.ok(before.x > 0 && after.x < -0.1 && before.distanceTo(after) > 0.19, 'The barrel travels through contact');
  assert.ok(follow.x < -0.8 && follow.z < 0.5, 'Recovery starts from a leftward followthrough, not the old windup');
  let furthestZ = -Infinity, furthestPhase = 0;
  for (let i = 35; i <= 65; i++) {
    const tip = at(i / 100);
    if (tip.z > furthestZ) { furthestZ = tip.z; furthestPhase = i / 100; }
  }
  assert.ok(furthestPhase >= 0.48 && furthestPhase <= 0.51, `Maximum extension occurs at ${furthestPhase}`);
});

test('visible contact follows the requested progress at different frame rates', () => {
  const contacts = [];
  for (const rate of [30, 60, 120]) {
    const root = createHumanoidRig({ height: 1.82, kind: 'thug' }), bat = attachHeldWeapon(root, 'bat');
    const frames = rate / 2;
    for (let frame = 1; frame <= frames; frame++) updateHumanoidPose(root, state(frame / rate), 1 / rate);
    contacts.push(point(bat.userData.anchors.tip));
  }
  for (const contact of contacts.slice(1)) near(contact.distanceTo(contacts[0]), 0, 1e-6);
});

test('pool resets preserve shared geometry, motion caches and bat anchors over repeated attacks', () => {
  const root = createHumanoidRig({ height: 1.82, kind: 'thug' }), bat = attachHeldWeapon(root, 'bat'), rig = root.userData.rig;
  const geometry = rig.bodyMeshes.map(mesh => mesh.geometry), motion = rig.motion;
  const tip = rig.anchors.weaponTip, strike = rig.anchors.weaponStrikeCenter, children = bat.children.slice();
  for (let reuse = 0; reuse < 20; reuse++) {
    for (let frame = 0; frame <= 30; frame++) updateHumanoidPose(root, state(frame / 30), 1 / 60);
    resetHumanoidPose(root);
    assert.equal(rig.motion, motion);
    assert.deepEqual(rig.motion, { batReady: 0, stance: 0, walk: 0, stride: 0 });
    assert.equal(rig.anchors.weaponTip, tip); assert.equal(rig.anchors.weaponStrikeCenter, strike);
    assert.deepEqual(bat.children, children);
    assert.deepEqual(rig.bodyMeshes.map(mesh => mesh.geometry), geometry);
    assert.deepEqual(rig.pose, { mode: 'idle', phase: 'idle', gait: 0, clock: 0 });
    for (const rest of rig.neutral) {
      assert.ok(rest.object.position.equals(rest.position));
      assert.ok(rest.object.quaternion.equals(rest.quaternion));
    }
  }
});

test('paused or invalid simulation deltas leave the whole pose unchanged', () => {
  const root = createHumanoidRig({ kind: 'thug' }), rig = root.userData.rig;
  attachHeldWeapon(root, 'bat');
  updateHumanoidPose(root, state(0.32), 1 / 60);
  const pose = { ...rig.pose }, motion = { ...rig.motion };
  const transforms = Object.values(rig.joints).map(joint => ({ position: joint.position.clone(), quaternion: joint.quaternion.clone() }));
  for (const delta of [0, -1, NaN, Infinity]) {
    updateHumanoidPose(root, state(0.65), delta);
    assert.deepEqual(rig.pose, pose); assert.deepEqual(rig.motion, motion);
    Object.values(rig.joints).forEach((joint, index) => {
      assert.ok(joint.position.equals(transforms[index].position));
      assert.ok(joint.quaternion.equals(transforms[index].quaternion));
    });
  }
});

test('captured raised guards, windup, contact and recovery still collapse inside the gallery', () => {
  for (const config of [{ height: 1.82, build: 1.05, kind: 'thug' }, { height: 1.94, build: 1.32, kind: 'bruiser' }]) {
    for (const progress of [0, 0.18, 0.5, 0.65, 0.73, 0.82, 1]) {
      const root = createHumanoidRig(config);
      root.position.set(0, BALCONY.floorY, BALCONY.laneZ); root.rotation.y = Math.PI / 2;
      updateHumanoidPose(root, state(progress), 1 / 60);
      beginHumanoidCollapse(root, Math.PI / 2, BALCONY.floorY, 'x', 0.08, BALCONY.wrap);
      for (let frame = 0; frame <= 60; frame++) {
        updateHumanoidCollapse(root, frame / 60);
        root.updateMatrixWorld(true);
        const box = getHumanoidVisualBounds(root, new THREE.Box3());
        assert.ok(box.min.y >= BALCONY.floorY - 1e-6 && box.min.y <= BALCONY.floorY + 0.008,
          `Actual deformed surface must meet the floor within 8mm: ${box.min.y - BALCONY.floorY}`);
        assert.ok(box.min.z >= BALCONY.wrap.z1 + 0.1 - 1e-6);
        assert.ok(box.max.z <= BALCONY.wrap.z2 - 0.1 + 1e-6);
      }
    }
  }
});
