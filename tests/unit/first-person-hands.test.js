import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFirstPersonHands, poseFirstPersonHands, punchExtension, FIRST_PERSON_PUNCH_SECONDS, FIRST_PERSON_PUNCH_CONTACT_PHASE } from '../../src/render/first-person-hands.js';
import { getViewModelMuzzle, VIEW_MODEL_LAYER } from '../../src/render/viewmodel.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { weaponHarness } from './helpers/weapon-harness.js';
import { createAuthoredGripHand, createHandDigits, getAuthoredHandGeometry } from '../../src/render/hand-geometry.js';
import { HAND_ATLAS } from '../../src/render/hand-materials.js';

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
      for (let i = 0; i < positions.count; i++) visitor(object.getVertexPosition(i, point).applyMatrix4(matrix), object);
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
  assert.equal(meshes, 6); assert.ok(triangles <= 9000);
  assert.equal(hands.left.surface.geometry, b.userData.firstPersonHands.left.surface.geometry);
  assert.equal(hands.right.surface.geometry, b.userData.firstPersonHands.right.surface.geometry);
  assert.equal(hands.left.sleeve.geometry, hands.right.sleeve.geometry);
  assert.equal(hands.left.surface.material, hands.right.surface.material);
  for (const rig of hands.order) {
    assert.equal(rig.fingers.length, 4);
    assert.equal(rig.thumb.joints.length, 3);
    assert.equal(rig.surface.geometry.type, 'BufferGeometry');
    assert.equal(rig.surface.geometry.morphAttributes.position.length, 1);
    assert.equal(rig.surface.geometry.morphAttributes.normal.length, 1);
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
    assert.deepEqual(a.surface.morphTargetInfluences, b.surface.morphTargetInfluences);
    const buffer = a.surface.geometry.attributes.position.array, version = a.surface.geometry.attributes.position.version;
    const morph = a.surface.geometry.morphAttributes.position[0], morphVersion = morph.version;
    poseFirstPersonHands(stepped, 0.23, 1, 2, 0.5);
    assert.equal(a.surface.geometry.attributes.position.array, buffer);
    assert.equal(a.surface.geometry.attributes.position.version, version);
    assert.equal(a.surface.geometry.morphAttributes.position[0], morph); assert.equal(morph.version, morphVersion);
  }
});

test('authored palm, fingers and thumb form one closed, consistently wound surface', () => {
  for (const side of [-1, 1]) {
    for (const radius of [null, 0.015, 0.022, 0.030, 0.032, 0.036, 0.038, 0.040, 0.044]) {
      const geometry = getAuthoredHandGeometry(side, radius), edges = new Map(), adjacency = new Map();
      const indices = geometry.index.array, positions = geometry.attributes.position;
      // Authored UV islands duplicate coincident vertices at the glove edge.
      // Weld positions for physical topology, as an exported mesh validator does.
      const vertices = new Map(), vertexIds = [];
      for (let i = 0; i < positions.count; i++) {
        const key = [positions.getX(i), positions.getY(i), positions.getZ(i)].map(value => Math.round(value * 1e8)).join(':');
        if (!vertices.has(key)) vertices.set(key, vertices.size);
        vertexIds.push(vertices.get(key));
      }
      let signedVolume = 0;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (let i = 0; i < indices.length; i += 3) {
        a.fromBufferAttribute(positions, indices[i]); b.fromBufferAttribute(positions, indices[i + 1]); c.fromBufferAttribute(positions, indices[i + 2]);
        signedVolume += a.dot(b.cross(c)) / 6;
        for (let corner = 0; corner < 3; corner++) {
          const first = vertexIds[indices[i + corner]], second = vertexIds[indices[i + (corner + 1) % 3]];
          const key = `${Math.min(first, second)}:${Math.max(first, second)}`;
          const edge = edges.get(key) || { count: 0, winding: 0 };
          edge.count++; edge.winding += first < second ? 1 : -1; edges.set(key, edge);
          if (!adjacency.has(first)) adjacency.set(first, new Set());
          adjacency.get(first).add(second);
        }
      }
      for (const edge of edges.values()) { assert.equal(edge.count, 2, 'no exposed joint cracks'); assert.equal(edge.winding, 0, 'consistent face winding'); }
      const visited = new Set(), pending = [vertexIds[indices[0]]];
      while (pending.length) {
        const vertex = pending.pop(); if (visited.has(vertex)) continue;
        visited.add(vertex); pending.push(...adjacency.get(vertex));
      }
      assert.equal(visited.size, vertices.size, 'all digits and the thumb are attached to the palm topology');
      assert.ok(signedVolume > 0.00025 && signedVolume < 0.00040, 'outward-facing human hand volume');
      for (let i = 0; i < positions.count; i++) {
        const normalLength = a.fromBufferAttribute(geometry.attributes.normal, i).length();
        assert.ok(Math.abs(normalLength - 1) < 1e-6, 'no collapsed shading normals');
        const displacement = a.fromBufferAttribute(geometry.morphAttributes.position[0], i).length();
        assert.ok(Number.isFinite(displacement) && displacement < 0.003, 'UV seam repair must preserve clench target vertex correspondence');
        const u = geometry.attributes.uv.getX(i), v = geometry.attributes.uv.getY(i), atlas = HAND_ATLAS[v < 0.5 ? 'skin' : 'glove'];
        assert.ok(u >= atlas.uMin - 1e-7 && u <= atlas.uMax + 1e-7 && v >= atlas.vMin - 1e-7 && v <= atlas.vMax + 1e-7,
          'large stock grips and seam repairs must stay inside the padded material atlas');
      }
      for (let i = 0; i < indices.length; i += 3) {
        const atlasHalves = [0, 1, 2].map(corner => geometry.attributes.uv.getY(indices[i + corner]) < 0.5);
        assert.ok(atlasHalves.every(skin => skin === atlasHalves[0]), 'no triangle samples across two atlas materials');
        if (!atlasHalves[0]) {
          const localV = [0, 1, 2].map(corner => (geometry.attributes.uv.getY(indices[i + corner]) - 136 / 256) / (112 / 256));
          assert.ok(Math.max(...localV) - Math.min(...localV) < 0.4,
            'a finger/thumb collar cannot stretch the dorsal glove panel down its first loft strip');
        }
      }
    }
  }
});

test('static firearm grips own disposable buffers and preserve shared dynamic hand resources', () => {
  const dynamic = getAuthoredHandGeometry(1, 0.022), original = dynamic.attributes.position.array.slice();
  const grip = createAuthoredGripHand(), second = createAuthoredGripHand();
  assert.ok(grip.userData.presentation.triangles <= 4000);
  assert.deepEqual(grip.userData.wristAnchor.toArray(), [0, 0.006, 0.152]);
  const surface = grip.children[0];
  assert.notEqual(surface.geometry, dynamic); assert.notEqual(surface.geometry, second.children[0].geometry);
  assert.equal(surface.material, second.children[0].material); assert.deepEqual(surface.geometry.morphAttributes, {});
  surface.geometry.translate(4, 5, 6); surface.geometry.dispose();
  assert.deepEqual(dynamic.attributes.position.array, original, 'weapon batching cannot mutate cached fist/bat geometry');
});

test('grip fingers retain distinct human-scale reaches as the held stock gets wider', () => {
  for (const side of [-1, 1]) {
    for (const radius of [0.015, 0.022, 0.030, 0.032, 0.036, 0.040, 0.044]) {
      const { fingers } = createHandDigits(side, radius);
      const lengths = fingers.map(digit => new THREE.CatmullRomCurve3([
        new THREE.Vector3(digit.rest[0].x, 0.009, -0.032), ...digit.rest,
      ], false, 'centripetal').getLength());
      assert.ok(lengths[1] > lengths[0] + 0.004, 'middle finger reaches beyond the index');
      assert.ok(lengths[2] > lengths[0] && lengths[2] < lengths[1], 'ring finger lies between index and middle');
      assert.ok(lengths[3] < lengths[1] * 0.90, 'little finger is visibly shorter instead of a fourth equal band');
      for (const length of lengths) assert.ok(length > 0.055 && length < 0.132,
        'a wider stock cannot stretch the fingers to match its full circumference');
      const tips = fingers.map(digit => digit.rest.at(-1));
      assert.ok(Math.abs(tips[3].y - tips[1].y) > 0.005, 'fingertip curl does not end on one straight cross-hand line');
      for (const digit of fingers) {
        for (const point of digit.rest) {
          const distance = Math.hypot(point.y + 0.010, point.z + 0.060);
          assert.ok(distance > radius + digit.radius - 0.002 && distance < radius + digit.radius,
            'individual reach preserves the known inward grip contact envelope');
        }
      }
    }
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
