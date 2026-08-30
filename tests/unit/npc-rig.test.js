import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createHumanoidRig, humanoidDimensions, resetHumanoidPose, updateHumanoidPose,
  createHeldWeapon, attachHeldWeapon, HUMANOID_GEOMETRY,
} from '../../src/render/humanoid-rig.js';
import { BAT_DIMENSIONS } from '../../src/render/bat-asset.js';

const point = object => object.getWorldPosition(new THREE.Vector3());
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
const bodyBounds = root => {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const mesh of root.userData.rig.bodyMeshes) bounds.union(new THREE.Box3().setFromObject(mesh));
  return bounds;
};

test('adult and civilian rigs have appropriate proportions and exact floor anchors', () => {
  for (const config of [
    { height: 1.78, build: 1, kind: 'brawler' },
    { height: 1.82, build: 1.05, kind: 'thug' },
    { height: 1.94, build: 1.32, kind: 'bruiser' },
    { height: 1.66, build: 0.92, kind: 'woman' },
    { height: 1.28, build: 0.78, kind: 'child' },
  ]) {
    const root = createHumanoidRig(config), { dimensions: d, anchors } = root.userData.rig;
    const bounds = bodyBounds(root);
    near(bounds.min.y, 0);
    near(bounds.max.y, config.height);
    near(point(anchors.soleL).y, 0);
    near(point(anchors.soleR).y, 0);
    near(point(anchors.crown).y, config.height);
    assert.ok(d.hipY / d.height > 0.5 && d.hipY / d.height < 0.55);
    assert.ok(d.headHeight / d.height >= 0.13 && d.headHeight / d.height <= 0.16);
    assert.ok(d.thighLength > d.height * 0.23 && d.thighLength < d.height * 0.26);
    assert.ok(d.upperArmLength > d.forearmLength);
  }
});

test('invalid proportion inputs remain finite and usable', () => {
  for (const config of [{ height: NaN, build: Infinity }, { height: -2, build: -4 }, { height: 12, build: 10 }]) {
    const dimensions = humanoidDimensions(config);
    for (const value of Object.values(dimensions)) assert.ok(Number.isFinite(value) && value > 0);
    assert.ok(dimensions.height >= 0.9 && dimensions.height <= 2.2);
  }
});

test('limbs form anatomical joint chains and retain legacy animation aliases', () => {
  const root = createHumanoidRig();
  const { joints: j, anchors: a } = root.userData.rig;
  assert.equal(j.spine.parent, j.hips);
  assert.equal(j.chest.parent, j.spine);
  assert.equal(j.neck.parent, j.chest);
  assert.equal(j.head.parent, j.neck);
  for (const side of ['L', 'R']) {
    assert.equal(j[`shoulder${side}`].parent, j.chest);
    assert.equal(j[`elbow${side}`].parent, j[`shoulder${side}`]);
    assert.equal(j[`wrist${side}`].parent, j[`elbow${side}`]);
    assert.equal(a[`grip${side}`].parent, j[`wrist${side}`]);
    assert.equal(j[`hip${side}`].parent, j.hips);
    assert.equal(j[`knee${side}`].parent, j[`hip${side}`]);
    assert.equal(j[`ankle${side}`].parent, j[`knee${side}`]);
    assert.equal(a[`sole${side}`].parent, j[`ankle${side}`]);
  }
  assert.equal(root.userData.parts.armR, j.shoulderR);
  assert.equal(root.userData.parts.legL, j.hipL);
  for (const joint of Object.values(j)) assert.deepEqual(joint.scale.toArray(), [1, 1, 1]);
});

test('idle, walking and strafing keep stance soles supported and bone lengths constant', () => {
  const root = createHumanoidRig({ height: 1.82 });
  const { joints: j, anchors: a, dimensions: d } = root.userData.rig;
  for (const state of [
    { mode: 'idle', speed: 0 }, { mode: 'walk', speed: 3.6, forward: 1, strafe: 0 },
    { mode: 'walk', speed: 2.2, forward: 0, strafe: 1 }, { mode: 'walk', speed: 2, forward: -1, strafe: 0 },
  ]) {
    resetHumanoidPose(root);
    for (let frame = 0; frame < 120; frame++) {
      updateHumanoidPose(root, state, 1 / 60);
      root.updateMatrixWorld(true);
      const leftY = point(a.soleL).y, rightY = point(a.soleR).y;
      assert.ok(leftY >= -1e-6 && rightY >= -1e-6, 'Neither sole penetrates the floor');
      near(Math.min(leftY, rightY), 0, 1e-5);
      for (const side of ['L', 'R']) {
        near(point(j[`hip${side}`]).distanceTo(point(j[`knee${side}`])), d.thighLength);
        near(point(j[`knee${side}`]).distanceTo(point(j[`ankle${side}`])), d.shinLength);
        near(point(j[`shoulder${side}`]).distanceTo(point(j[`elbow${side}`])), d.upperArmLength);
        near(point(j[`elbow${side}`]).distanceTo(point(j[`wrist${side}`])), d.forearmLength);
      }
    }
  }
});

test('fist and bat attacks expose windup, contact and recovery poses', () => {
  for (const mode of ['fist', 'bat']) {
    const root = createHumanoidRig({ kind: mode === 'fist' ? 'brawler' : 'thug' });
    for (const [progress, phase] of [[0.18, 'windup'], [0.5, 'contact'], [0.82, 'recovery']]) {
      updateHumanoidPose(root, { mode, speed: 0, alert: 1, swingProgress: progress, swingSide: 'R' }, 1 / 60);
      assert.equal(root.userData.rig.pose.mode, mode);
      assert.equal(root.userData.rig.pose.phase, phase);
    }
    updateHumanoidPose(root, { mode, speed: 0, alert: 1, swingProgress: -1 }, 1 / 60);
    assert.equal(root.userData.rig.pose.phase, 'idle');
  }
});

test('a brawler punch extends the correct attached wrist from its guard', () => {
  const root = createHumanoidRig({ kind: 'brawler' });
  const { joints: j } = root.userData.rig;
  for (let i = 0; i < 30; i++) updateHumanoidPose(root, { mode: 'fist', alert: 1, swingProgress: -1 }, 1 / 60);
  const guardR = point(j.wristR).z;
  for (let i = 0; i < 15; i++) updateHumanoidPose(root, { mode: 'fist', alert: 1, swingProgress: 0.5, swingSide: 'R' }, 1 / 60);
  assert.ok(point(j.wristR).z > guardR + 0.08);
  assert.ok(Math.abs(j.elbowR.rotation.x) < Math.abs(j.elbowL.rotation.x));
  resetHumanoidPose(root);
  for (let i = 0; i < 20; i++) updateHumanoidPose(root, { mode: 'fist', alert: 1, swingProgress: 0.5, swingSide: 'L' }, 1 / 60);
  assert.ok(Math.abs(j.elbowL.rotation.x) < Math.abs(j.elbowR.rotation.x));
});

test('the bat attaches at an unscaled wrist and preserves its full physical length', () => {
  const root = createHumanoidRig({ height: 1.82, kind: 'thug' });
  const bat = attachHeldWeapon(root, 'bat');
  assert.equal(bat.parent, root.userData.rig.anchors.gripR);
  assert.equal(bat.userData.role, 'weapon');
  const length = bat.getObjectByName('bat-wood').geometry.boundingBox.getSize(new THREE.Vector3()).z;
  near(length, BAT_DIMENSIONS.length);
  assert.equal(bat.userData.dimensions, BAT_DIMENSIONS);
  assert.equal(root.userData.rig.anchors.weaponTip, bat.userData.anchors.tip);
  assert.equal(root.userData.rig.anchors.weaponStrikeCenter, bat.userData.anchors.strikeCenter);
  root.updateMatrixWorld(true);
  const scale = bat.getWorldScale(new THREE.Vector3());
  near(scale.x, 1); near(scale.y, 1); near(scale.z, 1);
  for (let i = 0; i < 30; i++) updateHumanoidPose(root, { mode: 'bat', alert: 1, swingProgress: 0.18 }, 1 / 60);
  root.updateMatrixWorld(true);
  const after = bat.getWorldScale(new THREE.Vector3());
  near(after.x, 1); near(after.y, 1); near(after.z, 1);
  assert.equal(root.userData.rig.bodyMeshes.includes(bat), false);
});

test('fists produce no weapon prop; ranged props have real muzzle anchors', () => {
  const root = createHumanoidRig({ kind: 'brawler' });
  assert.equal(createHeldWeapon('fists'), null);
  assert.equal(attachHeldWeapon(root, 'fists'), null);
  assert.equal(root.userData.rig.anchors.gripR.children.length, 0);
  for (const type of ['pistol', 'shotgun', 'smg', 'machinegun']) {
    const weapon = createHeldWeapon(type);
    assert.equal(weapon.userData.role, 'weapon');
    assert.equal(weapon.userData.muzzle.parent, weapon);
    assert.ok(weapon.userData.muzzle.position.z > 0.2);
  }
});

test('neutral reset restores every joint and clears previous attack/gait state', () => {
  const root = createHumanoidRig({ kind: 'thug' });
  const rig = root.userData.rig;
  attachHeldWeapon(root, 'bat');
  for (let i = 0; i < 30; i++) updateHumanoidPose(root, { mode: 'bat', speed: 3, alert: 1, swingProgress: 0.5 }, 1 / 60);
  rig.joints.neck.rotation.y = 0.8;
  rig.joints.wristL.position.x = 0.1;
  rig.joints.ankleR.scale.y = 0.8;
  rig.reset();
  for (const rest of rig.neutral) {
    assert.ok(rest.object.position.equals(rest.position));
    assert.ok(rest.object.quaternion.equals(rest.quaternion));
    assert.ok(rest.object.scale.equals(rest.scale));
  }
  assert.deepEqual(rig.pose, { mode: 'idle', phase: 'idle', gait: 0, clock: 0 });
  assert.deepEqual(rig.motion, { batReady: 0, stance: 0, walk: 0, stride: 0 });
  near(bodyBounds(root).max.y, 1.78);
  near(point(rig.anchors.soleL).y, 0);
});

test('articulation retains shared bounds proxies while actual visible surfaces have an explicit budget', () => {
  const first = createHumanoidRig({ kind: 'bruiser' }), second = createHumanoidRig({ kind: 'brawler' });
  const firstMeshes = first.userData.rig.bodyMeshes, secondMeshes = second.userData.rig.bodyMeshes;
  assert.ok(firstMeshes.length <= 22 && secondMeshes.length <= 20);
  for (const name of ['head', 'torso', 'thigh.L', 'forearm.R', 'hand.R', 'boot.L']) {
    assert.equal(firstMeshes.find(mesh => mesh.name === name).geometry, secondMeshes.find(mesh => mesh.name === name).geometry);
  }
  let triangles = 0;
  for (const mesh of firstMeshes) {
    assert.equal(mesh.userData.role, 'bounds-proxy');
    assert.equal(mesh.visible, false);
    for (const value of mesh.geometry.attributes.position.array) assert.ok(Number.isFinite(value));
  }
  for (const mesh of first.userData.rig.visualMeshes) {
    assert.equal(mesh.userData.role, 'body'); assert.equal(mesh.visible, true);
    triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
  }
  assert.ok(triangles >= 8000 && triangles <= 15000, `${triangles} visible body triangles exceeds the authored budget`);
  assert.equal(first.userData.rig.visualMeshes.length, 4);
  const firstBat = createHeldWeapon('bat'), secondBat = createHeldWeapon('bat');
  for (const name of ['bat-wood', 'bat-grip']) {
    assert.equal(firstBat.getObjectByName(name).geometry, secondBat.getObjectByName(name).geometry);
    assert.equal(firstBat.getObjectByName(name).material, secondBat.getObjectByName(name).material);
  }
});

test('head geometry contains eye sockets, brow, cheekbones, a nasal tip and a rounded cranium', () => {
  const positions = HUMANOID_GEOMETRY.head.attributes.position;
  function band(y, minX, maxX) {
    const points = [];
    for (let i = 0; i < positions.count; i++) {
      if (Math.abs(positions.getY(i) - y) < 1e-5
        && Math.abs(positions.getX(i)) >= minX && Math.abs(positions.getX(i)) <= maxX) {
        points.push({ x: positions.getX(i), z: positions.getZ(i) });
      }
    }
    assert.ok(points.length > 0, `Missing facial ring at ${y}`);
    return points;
  }
  const front = y => Math.max(...band(y, 0.18, 0.24).map(p => p.z));
  assert.ok(front(0.61) > front(0.555) + 0.05, 'Brow protrudes above the recessed eye socket');
  assert.ok(front(0.425) > front(0.555) + 0.03, 'Cheekbone supports the lower orbit');
  assert.ok(Math.max(...band(0.39, 0, 0.04).map(p => p.z)) > 0.65, 'Nasal tip has depth independent of the texture');
  assert.ok(Math.max(...band(0.984, 0, 0.5).map(p => p.x)) > 0.14, 'Crown rounds out before its top cap');
  assert.ok(Math.max(...band(0.455, 0.5, 0.7).map(p => p.x)) > 0.57, 'Ears break the side silhouette');
  assert.ok(Math.max(...band(0.15, 0, 0.5).map(p => p.x)) < 0.43, 'Jaw narrows below the cheekbones');
});

test('shared garment and hand details improve silhouettes without extra body meshes', () => {
  const shirt = HUMANOID_GEOMETRY.torso.attributes.position;
  const hand = HUMANOID_GEOMETRY.hand.attributes.position;
  let collar = false, wristWidth = 0, palmWidth = 0, knuckleFront = -Infinity;
  for (let i = 0; i < shirt.count; i++) {
    if (shirt.getY(i) > 1.04 && Math.abs(shirt.getX(i)) < 0.17) collar = true;
  }
  for (let i = 0; i < hand.count; i++) {
    if (Math.abs(hand.getY(i)) < 1e-6) wristWidth = Math.max(wristWidth, Math.abs(hand.getX(i)));
    if (Math.abs(hand.getY(i) + 0.24) < 1e-6) palmWidth = Math.max(palmWidth, Math.abs(hand.getX(i)));
    if (hand.getY(i) < -0.6) knuckleFront = Math.max(knuckleFront, hand.getZ(i));
  }
  assert.ok(collar, 'Collar is part of the shirt surface');
  assert.ok(palmWidth > wristWidth * 1.3, 'Palm widens from the wrist');
  assert.ok(knuckleFront > 0.34, 'Curled knuckles project in front of the palm');
  assert.ok(hand.count / 3 <= 450, 'Each detailed fist uses fewer triangles than the previous block palm');
  const hair = HUMANOID_GEOMETRY.hair.attributes.position;
  let frontHairline = 1, backHairline = 1;
  for (let i = 0; i < hair.count; i++) {
    if (hair.getZ(i) > 0.42) frontHairline = Math.min(frontHairline, hair.getY(i));
    if (hair.getZ(i) < -0.42) backHairline = Math.min(backHairline, hair.getY(i));
  }
  assert.ok(frontHairline - backHairline > 0.2, 'Hair follows the forehead and temples instead of a horizontal helmet edge');
});

test('head hit bounds follow the animated anatomical head, not the upper chest', () => {
  const root = createHumanoidRig({ height: 1.82, kind: 'thug' });
  const zones = root.userData.hitZones;
  near(point(zones.headAnchor).y, 1.82 - root.userData.rig.dimensions.headHeight * 0.5);
  const start = point(zones.headAnchor);
  for (let i = 0; i < 20; i++) updateHumanoidPose(root, { mode: 'bat', alert: 1, swingProgress: 0.5 }, 1 / 60);
  const animated = point(zones.headAnchor);
  assert.ok(animated.distanceTo(start) > 0.015);
  assert.ok(zones.headHalfWidth < 0.15);
  assert.equal(zones.headAnchor, root.userData.rig.anchors.headCenter);
});

test('head hit bounds include the visible nose, ears and crown without changing body height', () => {
  const root = createHumanoidRig({ height: 1.82, kind: 'thug' }), rig = root.userData.rig;
  const zone = root.userData.hitZones, center = point(zone.headAnchor);
  const face = rig.bodyMeshes.find(mesh => mesh.name === 'head');
  const position = face.geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const vertex = face.localToWorld(new THREE.Vector3().fromBufferAttribute(position, i)).sub(center);
    assert.ok(Math.abs(vertex.x) <= zone.headHalfWidth);
    assert.ok(Math.abs(vertex.y) <= zone.headHalfHeight);
    assert.ok(Math.abs(vertex.z) <= zone.headHalfDepth);
  }
  near(rig.height, 1.82);
  near(bodyBounds(root).max.y, 1.82);
});
