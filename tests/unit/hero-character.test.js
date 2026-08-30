import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createHumanoidRig, attachHeldWeapon, resetHumanoidPose, updateHumanoidPose,
  getHumanoidVisualBounds,
} from '../../src/render/humanoid-rig.js';
import {
  beginHumanoidCollapse, updateHumanoidCollapse, COLLAPSE_DURATION,
} from '../../src/render/corpse-pose.js';

// Production proportions include the enforcer's distinct visual role even
// though it shares the bruiser's underlying animation/body kind.
const ARCHETYPES = [
  { role: 'thug', kind: 'thug', height: 1.82, build: 1.05, weapon: 'bat' },
  { role: 'brawler', kind: 'brawler', height: 1.78, build: 1, weapon: 'fists' },
  { role: 'gunman', kind: 'gunman', height: 1.76, build: 0.98, weapon: 'pistol' },
  { role: 'bruiser', kind: 'bruiser', height: 1.94, build: 1.32, weapon: 'shotgun' },
  { role: 'hitman', kind: 'hitman', height: 1.78, build: 1, weapon: 'smg' },
  { role: 'enforcer', kind: 'bruiser', height: 1.92, build: 1.28, weapon: 'machinegun' },
];
const triangleCount = mesh => (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
const near = (actual, expected, tolerance = 1e-6) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`,
);

function posedVertices(root) {
  root.updateMatrixWorld(true);
  const vertex = new THREE.Vector3(), positions = [];
  for (const mesh of root.userData.rig.visualMeshes) {
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  }
  return positions;
}

function maxDifference(a, b) {
  assert.equal(a.length, b.length);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference = Math.max(difference, Math.abs(a[i] - b[i]));
  return difference;
}

function attackState(config) {
  if (config.weapon === 'fists') return { mode: 'fist', alert: 1, swingProgress: 0.5, swingSide: 'L' };
  if (config.weapon === 'bat') return { mode: 'bat', alert: 1, swingProgress: 0.18 };
  return { mode: 'ranged', alert: 1, aim: 1 };
}

test('all enemy archetypes render four budgeted surfaces with exact neutral sole and crown bounds', () => {
  for (const config of ARCHETYPES) {
    const root = createHumanoidRig(config), rig = root.userData.rig;
    const visible = [];
    root.traverseVisible(object => { if (object.isMesh) visible.push(object); });
    assert.deepEqual(new Set(visible), new Set(rig.visualMeshes));
    assert.equal(visible.length, 4, `${config.role} must retain four body draws`);
    assert.equal(visible.filter(mesh => mesh.isSkinnedMesh).length, 2);
    assert.equal(rig.hero.role, config.role);
    const triangles = visible.reduce((sum, mesh) => sum + triangleCount(mesh), 0);
    assert.ok(triangles >= 8000 && triangles <= 15000, `${config.role}: ${triangles} rendered triangles`);
    assert.equal(rig.hero.triangles, triangles);
    assert.equal(rig.hero.draws, visible.length);
    for (const proxy of rig.bodyMeshes) {
      assert.equal(proxy.visible, false, `${proxy.name} must not duplicate the visible skin`);
      assert.equal(proxy.userData.role, 'bounds-proxy');
      assert.equal(visible.includes(proxy), false);
    }
    const actual = getHumanoidVisualBounds(root);
    near(actual.min.y, 0); near(actual.max.y, config.height);
    for (const bone of rig.hero.skeleton.bones) assert.equal(bone.isBone, true);
    for (const mesh of visible) {
      assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, true);
      if (mesh.isSkinnedMesh) {
        assert.equal(mesh.skeleton, rig.hero.skeleton);
        assert.equal(mesh.frustumCulled, false, 'A cached bind-pose sphere cannot cull the animated surface');
        // Three requests a sorting sphere even with frustum culling disabled.
        // A null sphere would trigger a full CPU skin scan on first visibility.
        assert.ok(mesh.boundingSphere instanceof THREE.Sphere, 'Each pool slot needs a prepared sorting sphere');
        assert.ok(Number.isFinite(mesh.boundingSphere.radius) && mesh.boundingSphere.radius > 0);
        for (const value of mesh.boundingSphere.center.toArray()) assert.ok(Number.isFinite(value));
        assert.notEqual(mesh.boundingSphere, mesh.geometry.boundingSphere, 'A per-actor bound must not alias shared asset data');
        assert.notEqual(mesh.boundingSphere.center, mesh.geometry.boundingSphere.center);
      }
    }
    // This checks the new head and hair vertices, not the retained legacy head.
    const hit = root.userData.hitZones, center = hit.headAnchor.getWorldPosition(new THREE.Vector3());
    const vertex = new THREE.Vector3();
    for (const mesh of visible.filter(mesh => !mesh.isSkinnedMesh)) {
      for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld).sub(center);
        assert.ok(Math.abs(vertex.x) <= hit.headHalfWidth + 1e-6, `${config.role}: head side lies outside its hit zone`);
        assert.ok(Math.abs(vertex.y) <= hit.headHalfHeight + 1e-6, `${config.role}: crown lies outside its hit zone`);
        assert.ok(Math.abs(vertex.z) <= hit.headHalfDepth + 1e-6, `${config.role}: face lies outside its hit zone`);
      }
    }
  }
});

test('the garment body has one welded component joining both legs, torso and sleeves', () => {
  for (const config of ARCHETYPES) {
    const rig = createHumanoidRig(config).userData.rig;
    const geometry = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments').geometry;
    const index = geometry.index, positions = geometry.attributes.position;
    const parents = new Int32Array(positions.count).fill(-1), used = new Set();
    const find = vertex => {
      let parent = vertex;
      while (parents[parent] !== parent) parent = parents[parent];
      while (parents[vertex] !== vertex) { const next = parents[vertex]; parents[vertex] = parent; vertex = next; }
      return parent;
    };
    for (let i = 0; i < rig.hero.continuousSurfaceTriangles * 3; i += 3) {
      const vertices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      for (const vertex of vertices) { if (parents[vertex] < 0) parents[vertex] = vertex; used.add(vertex); }
      parents[find(vertices[1])] = find(vertices[0]); parents[find(vertices[2])] = find(vertices[0]);
    }
    const components = new Set([...used].map(find));
    assert.equal(components.size, 1, `${config.role}: the authored body must not be disconnected limb pieces`);
    assert.equal(used.size, rig.hero.continuousSurfaceVertices);
    const extent = new THREE.Box3(), vertex = new THREE.Vector3();
    for (const i of used) extent.expandByPoint(vertex.fromBufferAttribute(positions, i));
    assert.ok(extent.min.y < config.height * 0.10 && extent.max.y > config.height * 0.82);
    assert.ok(extent.min.x < -config.height * 0.20 && extent.max.x > config.height * 0.20);

    const ids = Object.fromEntries(rig.hero.skeleton.bones.map((bone, i) => [bone.name.slice(6), i]));
    const weights = geometry.attributes.skinWeight, skinIndex = geometry.attributes.skinIndex;
    const influence = (vertex, bone) => {
      let value = 0;
      for (let k = 0; k < 4; k++) if (skinIndex.getComponent(vertex, k) === ids[bone]) value += weights.getComponent(vertex, k);
      return value;
    };
    const transitions = [['hipL', 'kneeL'], ['hipR', 'kneeR']];
    if (config.role !== 'brawler') transitions.push(['shoulderL', 'elbowL'], ['shoulderR', 'elbowR']);
    for (const [a, b] of transitions) {
      assert.ok([...used].some(i => influence(i, a) > 0.15 && influence(i, b) > 0.15),
        `${config.role}: ${a}/${b} needs a blended surface across the bending joint`);
    }
  }
});

test('every rendered skin vertex has finite normalized weights and valid bone indices', () => {
  for (const config of ARCHETYPES) {
    const rig = createHumanoidRig(config).userData.rig;
    for (const mesh of rig.visualMeshes.filter(mesh => mesh.isSkinnedMesh)) {
      const { position, normal, skinWeight, skinIndex } = mesh.geometry.attributes;
      assert.equal(skinWeight.count, position.count); assert.equal(skinIndex.count, position.count);
      for (let i = 0; i < position.count; i++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const weight = skinWeight.getComponent(i, k), bone = skinIndex.getComponent(i, k);
          assert.ok(Number.isFinite(weight) && weight >= 0 && weight <= 1);
          assert.ok(Number.isInteger(bone) && bone >= 0 && bone < rig.hero.skeleton.bones.length);
          sum += weight;
        }
        near(sum, 1);
        for (let k = 0; k < 3; k++) assert.ok(Number.isFinite(position.getComponent(i, k)));
        near(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)), 1, 1e-5);
      }
    }
  }
});

test('pooled actors share immutable GPU geometry while their posed surfaces and resets remain independent', () => {
  const config = ARCHETYPES[0], first = createHumanoidRig(config), second = createHumanoidRig(config);
  const firstRig = first.userData.rig, secondRig = second.userData.rig;
  assert.notEqual(firstRig.hero.skeleton, secondRig.hero.skeleton);
  const sharedBounds = firstRig.visualMeshes.map(mesh => mesh.geometry.boundingSphere.clone());
  const snapshots = firstRig.visualMeshes.map((mesh, i) => {
    assert.equal(mesh.geometry, secondRig.visualMeshes[i].geometry);
    assert.equal(mesh.material, secondRig.visualMeshes[i].material);
    if (mesh.isSkinnedMesh) assert.notEqual(mesh.boundingSphere, secondRig.visualMeshes[i].boundingSphere);
    return Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attribute]) => [name, {
      array: attribute.array.slice(), version: attribute.version,
    }]));
  });
  for (let i = 0; i < firstRig.hero.skeleton.bones.length; i++) {
    assert.notEqual(firstRig.hero.skeleton.bones[i], secondRig.hero.skeleton.bones[i]);
  }
  const rest = posedVertices(first), untouched = posedVertices(second);
  assert.ok(maxDifference(rest, untouched) < 1e-8);
  const readers = firstRig.visualMeshes.map(mesh => mesh.getVertexPosition);
  // Ordinary animation must only move joints; no CPU vertex inspection is
  // allowed here. The explicit inspection below is outside the hot path.
  for (const mesh of firstRig.visualMeshes) mesh.getVertexPosition = () => { throw new Error('Animation scanned render vertices'); };
  try {
    for (let i = 0; i < 45; i++) updateHumanoidPose(first, attackState(config), 1 / 60);
  } finally {
    firstRig.visualMeshes.forEach((mesh, i) => { mesh.getVertexPosition = readers[i]; });
  }
  assert.ok(maxDifference(rest, posedVertices(first)) > 0.1, 'The actual skin must follow its animated skeleton');
  assert.ok(maxDifference(untouched, posedVertices(second)) < 1e-8, 'Animating one pool slot must not deform another');
  resetHumanoidPose(first);
  assert.ok(maxDifference(rest, posedVertices(first)) < 1e-6, 'A recycled actor must recover its original visible surface');
  for (let i = 0; i < firstRig.visualMeshes.length; i++) {
    assert.deepEqual(firstRig.visualMeshes[i].geometry.boundingSphere, sharedBounds[i], 'Posing and recycling must preserve shared geometry bounds');
    for (const [name, saved] of Object.entries(snapshots[i])) {
      const attribute = firstRig.visualMeshes[i].geometry.attributes[name];
      assert.equal(attribute.version, saved.version, `${name} must not request a GPU buffer upload during animation`);
      assert.deepEqual(attribute.array, saved.array, `${name} is shared immutable asset data`);
    }
  }
});

test('cached bone influence bounds enclose actual deformed surfaces in motion and transformed world space', () => {
  for (const config of ARCHETYPES) {
    const root = createHumanoidRig(config), rig = root.userData.rig;
    attachHeldWeapon(root, config.weapon);
    root.position.set(3.1, 4.02, -2.8); root.rotation.set(0.11, 0.74, -0.06, 'YXZ');
    for (const state of [
      { mode: 'walk', speed: 3.2, forward: 0.65, strafe: -0.7 },
      attackState(config),
      { mode: config.weapon === 'fists' ? 'fist' : 'bat', alert: 1, swingProgress: 0.5, swingSide: 'R' },
    ]) {
      for (let i = 0; i < 24; i++) updateHumanoidPose(root, state, 1 / 60);
      const actual = getHumanoidVisualBounds(root), conservative = new THREE.Box3();
      for (const proxy of rig.visualBoundsProxies) {
        conservative.union(proxy.geometry.boundingBox.clone().applyMatrix4(proxy.matrixWorld));
      }
      assert.ok(conservative.expandByScalar(1e-6).containsBox(actual), `${config.role}/${state.mode}: bounds omit animated visible skin`);
    }
  }
});

test('collapse samples a bounded support cloud, grounds actual skin and performs no settled vertex scans', () => {
  for (const config of ARCHETYPES) {
    const root = createHumanoidRig(config), rig = root.userData.rig, floor = 4.02;
    attachHeldWeapon(root, config.weapon);
    root.position.set(0, floor, 0); root.rotation.y = Math.PI / 2;
    for (let i = 0; i < 24; i++) updateHumanoidPose(root, attackState(config), 1 / 60);
    const totalVertices = rig.visualMeshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
    let vertexReads = 0;
    const readers = rig.visualMeshes.map(mesh => mesh.getVertexPosition);
    for (let i = 0; i < rig.visualMeshes.length; i++) {
      rig.visualMeshes[i].getVertexPosition = function (index, target) { vertexReads++; return readers[i].call(this, index, target); };
    }
    assert.ok(rig.hero.contactSamples < totalVertices / 3, 'Collapse must not scan the full render geometry');
    for (const { mesh, indices } of rig.contactSurfaces) {
      assert.equal(new Set(indices).size, indices.length);
      for (const index of indices) assert.ok(index >= 0 && index < mesh.geometry.attributes.position.count);
    }
    assert.equal(beginHumanoidCollapse(root, Math.PI / 2, floor, 'x', 0.08), true);
    for (let frame = 0; frame <= 32; frame++) {
      const age = COLLAPSE_DURATION * frame / 32;
      vertexReads = 0; assert.equal(updateHumanoidCollapse(root, age), true);
      assert.equal(vertexReads, rig.hero.contactSamples, `${config.role}: active collapse must read only its cached support samples`);
      const actual = getHumanoidVisualBounds(root);
      assert.ok(actual.min.y >= floor - 1e-6, `${config.role}: visible skin penetrates the floor by ${floor - actual.min.y}`);
      assert.ok(actual.min.y <= floor + 0.008, `${config.role}: visible skin floats ${actual.min.y - floor} above the floor`);
    }
    vertexReads = 0;
    const settledY = root.position.y;
    updateHumanoidCollapse(root, 20, 0.225);
    assert.equal(vertexReads, 0, 'Settled corpses must leave the skinning inspection path');
    near(root.position.y, settledY - 0.225);
  }
});
