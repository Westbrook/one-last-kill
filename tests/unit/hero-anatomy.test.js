import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHumanoidRig, resetHumanoidPose } from '../../src/render/humanoid-rig.js';

const ARCHETYPES = [
  { role: 'thug', kind: 'thug', height: 1.82, build: 1.05 },
  { role: 'brawler', kind: 'brawler', height: 1.78, build: 1 },
  { role: 'gunman', kind: 'gunman', height: 1.76, build: 0.98 },
  { role: 'bruiser', kind: 'bruiser', height: 1.94, build: 1.32 },
  { role: 'hitman', kind: 'hitman', height: 1.78, build: 1 },
  { role: 'enforcer', kind: 'bruiser', height: 1.92, build: 1.28 },
];

function influence(mesh, vertex, name) {
  const { skinIndex, skinWeight } = mesh.geometry.attributes;
  let result = 0;
  for (let k = 0; k < 4; k++) {
    if (mesh.skeleton.bones[skinIndex.getComponent(vertex, k)].name === `joint:${name}`) result += skinWeight.getComponent(vertex, k);
  }
  return result;
}

// Seed from anatomical bone influences, then walk the actual indexed surface.
// This also includes a fully chest-weighted base without depending on a row
// count, vertex ordering, or a helper's private geometry metadata.
function neckSurface(rig) {
  const mesh = rig.visualMeshes.find(value => value.name === 'hero-skin');
  const { position } = mesh.geometry.attributes, index = mesh.geometry.index;
  const neighbors = Array.from({ length: position.count }, () => new Set());
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    neighbors[a].add(b).add(c); neighbors[b].add(a).add(c); neighbors[c].add(a).add(b);
  }
  const seeds = [];
  for (let i = 0; i < position.count; i++) {
    if (influence(mesh, i, 'neck') + influence(mesh, i, 'head') > 1e-6) seeds.push(i);
  }
  assert.ok(seeds.length > 0, 'Visible skin must contain the anatomical neck');
  const vertices = new Set([seeds[0]]), pending = [seeds[0]];
  while (pending.length) {
    for (const next of neighbors[pending.pop()]) if (!vertices.has(next)) { vertices.add(next); pending.push(next); }
  }
  assert.ok(seeds.every(i => vertices.has(i)), 'Neck and head influences must belong to one connected skin surface');
  const low = Math.min(...[...vertices].map(i => position.getY(i)));
  const high = Math.max(...[...vertices].map(i => position.getY(i)));
  const base = [...vertices].filter(i => Math.abs(position.getY(i) - low) < 1e-6);
  const rim = [...vertices].filter(i => Math.abs(position.getY(i) - high) < 1e-6), rimSet = new Set(rim);
  const rimEdges = [];
  for (const a of rim) for (const b of neighbors[a]) if (a < b && rimSet.has(b)) rimEdges.push([a, b]);
  assert.ok(base.length >= 8 && rim.length >= 8 && rimEdges.length >= 8, 'The neck needs real circumferential joins');
  return { mesh, vertices: [...vertices], base, rim, rimEdges };
}

function worldPoint(mesh, index, target = new THREE.Vector3()) {
  return mesh.getVertexPosition(index, target).applyMatrix4(mesh.matrixWorld);
}

function pointBounds(mesh, indices) {
  const result = new THREE.Box3(), point = new THREE.Vector3();
  for (const index of indices) result.expandByPoint(worldPoint(mesh, index, point));
  return result;
}

function triangles(geometry) {
  const position = geometry.attributes.position, result = [];
  for (let i = 0; i < geometry.index.count; i += 3) {
    result.push([0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(position, geometry.index.getX(i + offset))));
  }
  return result;
}

// Intersect the actual skull triangles with a horizontal plane through a
// posed neck point. Positive clearance means the point is buried inside the
// head; negative clearance exposes the open neck rim. AABB overlap cannot
// detect the side/rear gap this test is intended to catch.
function skullClearance(point, faces, scale) {
  const px = point.x * scale.x, pz = point.z * scale.z;
  let crossings = 0, distance = Infinity;
  for (const triangle of faces) {
    const cut = [];
    for (let j = 0; j < 3; j++) {
      const a = triangle[j], b = triangle[(j + 1) % 3];
      if ((a.y <= point.y && b.y > point.y) || (b.y <= point.y && a.y > point.y)) {
        const t = (point.y - a.y) / (b.y - a.y);
        cut.push([(a.x + (b.x - a.x) * t) * scale.x, (a.z + (b.z - a.z) * t) * scale.z]);
      }
    }
    if (cut.length !== 2) continue;
    const [[ax, az], [bx, bz]] = cut;
    if ((az > pz) !== (bz > pz) && px < ax + (bx - ax) * (pz - az) / (bz - az)) crossings++;
    const dx = bx - ax, dz = bz - az, lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSquared)) : 0;
    distance = Math.min(distance, Math.hypot(px - ax - t * dx, pz - az - t * dz));
  }
  return crossings % 2 ? distance : -distance;
}

test('rendered adult skulls retain tall proportions and a rising jaw instead of a flat lower head ring', () => {
  for (const config of ARCHETYPES) {
    const root = createHumanoidRig(config), rig = root.userData.rig;
    const head = rig.visualMeshes.find(mesh => mesh.name === 'hero-head');
    root.updateMatrixWorld(true);
    const position = head.geometry.attributes.position, whole = new THREE.Box3(), cranium = new THREE.Box3();
    const point = new THREE.Vector3(); let frontChin = Infinity, rearJaw = Infinity;
    for (let i = 0; i < position.count; i++) {
      worldPoint(head, i, point); whole.expandByPoint(point);
      // Above the orbital/ear band, skull width measures the cranium rather
      // than including projecting ear cartilage in the facial aspect ratio.
      if (position.getY(i) >= 0.65 && position.getY(i) <= 0.82) cranium.expandByPoint(point);
      if (position.getZ(i) > 0 && Math.abs(position.getX(i)) < 0.10) frontChin = Math.min(frontChin, point.y);
      if (position.getZ(i) < -0.10) rearJaw = Math.min(rearJaw, point.y);
    }
    const size = whole.getSize(new THREE.Vector3()), cranialWidth = cranium.max.x - cranium.min.x;
    assert.ok(cranialWidth / size.y >= 0.64 && cranialWidth / size.y <= 0.75,
      `${config.role}: rendered cranial width/height is ${cranialWidth / size.y}`);
    assert.ok(size.x / size.y >= 0.70 && size.x / size.y <= 0.85, `${config.role}: ears must preserve a plausible outer silhouette`);
    assert.ok(size.z / size.y >= 0.82 && size.z / size.y <= 1.02, `${config.role}: face depth must remain proportionate to head height`);
    assert.ok(size.y / rig.height >= 0.13 && size.y / rig.height <= 0.14, 'Visual reshaping must preserve the adult head height');
    assert.ok((rearJaw - frontChin) / size.y >= 0.09 && (rearJaw - frontChin) / size.y <= 0.24,
      `${config.role}: the rear jaw must rise above the chin while still enclosing the neck`);
  }
});

test('the connected neck flares into the chest and blends through the head without rewriting shared geometry', () => {
  for (const config of ARCHETYPES) {
    const root = createHumanoidRig(config), rig = root.userData.rig, neck = neckSurface(rig);
    root.updateMatrixWorld(true);
    for (const [a, b] of [['chest', 'neck'], ['neck', 'head']]) {
      assert.ok(neck.vertices.some(i => influence(neck.mesh, i, a) > 0.15 && influence(neck.mesh, i, b) > 0.15),
        `${config.role}: the ${a}/${b} transition must bend through the visible skin`);
    }
    const base = pointBounds(neck.mesh, neck.base), rim = pointBounds(neck.mesh, neck.rim);
    assert.ok(base.max.x - base.min.x > (rim.max.x - rim.min.x) * 1.5, 'A neck needs a flared shoulder transition, not a straight tube');
    assert.ok(rim.getCenter(new THREE.Vector3()).z < rig.anchors.headCenter.getWorldPosition(new THREE.Vector3()).z - 0.005,
      'The upper neck must enter beneath the rear half of the skull');
    const rest = neck.vertices.map(i => worldPoint(neck.mesh, i));
    const geometry = neck.mesh.geometry;
    const saved = Object.fromEntries(['position', 'normal'].map(name => [name, {
      data: geometry.attributes[name].array.slice(), version: geometry.attributes[name].version,
    }]));
    rig.joints.neck.rotation.set(-0.08, -0.12, 0.025);
    rig.joints.head.rotation.set(0.18, 0.35, 0.05); root.updateMatrixWorld(true);
    const displacement = new Map(neck.vertices.map((i, at) => [i, worldPoint(neck.mesh, i).distanceTo(rest[at])]));
    assert.ok(Math.max(...neck.rim.map(i => displacement.get(i))) > 0.01, 'The upper neck must follow a real head turn');
    assert.ok(Math.max(...neck.base.map(i => displacement.get(i))) < 1e-6, 'Looking aside must not detach the neck base from the chest');
    resetHumanoidPose(root); root.updateMatrixWorld(true);
    for (let i = 0; i < neck.vertices.length; i++) assert.ok(worldPoint(neck.mesh, neck.vertices[i]).distanceTo(rest[i]) < 1e-6);
    for (const [name, before] of Object.entries(saved)) {
      assert.equal(geometry.attributes[name].version, before.version, `${name} must not trigger per-frame GPU uploads`);
      assert.deepEqual(geometry.attributes[name].array, before.data, `${name} remains immutable through turns and reset`);
    }
  }
});

test('the actual neck rim stays buried in the jaw through head turns and the visible face stays inside combat bounds', () => {
  for (const config of ARCHETYPES) {
    const root = createHumanoidRig(config), rig = root.userData.rig, neck = neckSurface(rig);
    const head = rig.visualMeshes.find(mesh => mesh.name === 'hero-head'), faces = triangles(head.geometry);
    const faceMeshes = rig.visualMeshes.filter(mesh => !mesh.isSkinnedMesh);
    const inverseHead = new THREE.Matrix4(), point = new THREE.Vector3(), other = new THREE.Vector3();
    for (const yaw of [-0.35, 0, 0.35]) for (const pitch of [-0.18, 0, 0.18]) {
      rig.joints.head.rotation.set(pitch, yaw, 0); root.updateMatrixWorld(true);
      inverseHead.copy(head.matrixWorld).invert();
      const check = value => {
        value.applyMatrix4(inverseHead);
        const clearance = skullClearance(value, faces, head.scale);
        assert.ok(clearance >= -0.001, `${config.role}: upper neck is exposed by ${-clearance} m at yaw ${yaw}, pitch ${pitch}`);
      };
      for (const i of neck.rim) check(worldPoint(neck.mesh, i, point));
      // A concave jaw can enclose edge endpoints while exposing their midpoint.
      for (const [a, b] of neck.rimEdges) {
        worldPoint(neck.mesh, a, point); worldPoint(neck.mesh, b, other);
        check(point.add(other).multiplyScalar(0.5));
      }
      const hit = root.userData.hitZones, center = hit.headAnchor.getWorldPosition(new THREE.Vector3());
      for (const mesh of faceMeshes) for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        worldPoint(mesh, i, point).sub(center);
        assert.ok(Math.abs(point.x) <= hit.headHalfWidth + 1e-6, `${config.role}: turned head exceeds its combat width`);
        assert.ok(Math.abs(point.y) <= hit.headHalfHeight + 1e-6, `${config.role}: turned head exceeds its combat height`);
        assert.ok(Math.abs(point.z) <= hit.headHalfDepth + 1e-6, `${config.role}: turned face exceeds its combat depth`);
      }
    }
  }
});
