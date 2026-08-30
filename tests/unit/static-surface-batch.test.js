import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStaticSurfaceBatch } from '../../src/render/static-surface-batch.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 2e-5, `${label}: ${actual} != ${expected}`);
const entry = overrides => ({ x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1, rx: 0, ry: 0, rz: 0, tint: null, ...overrides });
function material(meters = 2) {
  const result = new THREE.MeshStandardMaterial({ color: 0xa9b2a0, roughness: 0.89, metalness: 0.1 });
  result.name = 'surface-wood';
  result.userData = { surfaceMeters: meters, surfaceKind: 'wood' };
  return result;
}
function matrix(value) {
  return new THREE.Matrix4().compose(new THREE.Vector3(value.x, value.y, value.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(value.rx, value.ry, value.rz)),
    new THREE.Vector3(value.sx, value.sy, value.sz));
}

test('varied and rotated box faces retain physical surface scale and their exact triangles', () => {
  const source = new THREE.BoxGeometry(), originalUV = source.attributes.uv.array.slice();
  const entries = [entry({ x: -18, y: 12, z: 7, sx: 8, sy: 24, sz: 9 }),
    entry({ x: 4, y: 6, z: -10, sx: 0.12, sy: 2.04, sz: 0.17 }),
    entry({ x: -2, y: 1, z: 3, sx: 2.8, sy: 0.18, sz: 1.1, rx: 0.18, ry: 0.37, rz: -0.12 })];
  const mesh = createStaticSurfaceBatch(source, material(), entries);
  const { position, normal, uv } = mesh.geometry.attributes;
  assert.equal(position.count, source.attributes.position.count * entries.length);
  assert.equal(mesh.geometry.index.count, source.index.count * entries.length);
  assert.equal(mesh.geometry.groups.length, 0, 'one material and one draw, without per-box groups');
  assert.deepEqual(source.attributes.uv.array, originalUV, 'shared primitive remains unmodified');
  const expected = new THREE.Vector3(), actual = new THREE.Vector3();
  for (const [index, value] of entries.entries()) {
    const transform = matrix(value), normalMatrix = new THREE.Matrix3().getNormalMatrix(transform);
    const start = index * 24;
    for (let i = 0; i < 24; i++) {
      expected.fromBufferAttribute(source.attributes.position, i).applyMatrix4(transform);
      actual.fromBufferAttribute(position, start + i);
      near(actual.distanceTo(expected), 0, 'authored vertex is unchanged');
      assert.ok(mesh.geometry.boundingBox.containsPoint(actual), 'culling box includes every vertex');
      assert.ok(mesh.geometry.boundingSphere.center.distanceTo(actual) <= mesh.geometry.boundingSphere.radius + 1e-6,
        'culling sphere includes every vertex, allowing float roundoff at its boundary');
      expected.fromBufferAttribute(source.attributes.normal, i).applyNormalMatrix(normalMatrix);
      actual.fromBufferAttribute(normal, start + i);
      near(actual.distanceTo(expected), 0, 'authored normal is unchanged');
    }
    for (let face = 0; face < 6; face++) {
      const a = start + face * 4;
      for (let offset = 1; offset < 4; offset++) {
        const b = a + offset;
        const meters = expected.fromBufferAttribute(position, a).distanceTo(actual.fromBufferAttribute(position, b));
        const tiles = Math.hypot(uv.getX(a) - uv.getX(b), uv.getY(a) - uv.getY(b));
        near(tiles, meters / 2, 'orthonormal UVs measure each surface edge and diagonal in metres');
      }
    }
    for (let i = 0; i < source.index.count; i++) {
      assert.equal(mesh.geometry.index.getX(index * source.index.count + i), source.index.getX(i) + start,
        'topology and winding are unchanged');
    }
  }
});

test('adjacent masonry boxes keep the same texture phase at their shared seam', () => {
  const mesh = createStaticSurfaceBatch(new THREE.BoxGeometry(), material(0.78), [
    entry({ x: -2, y: 1, sx: 4, sy: 2 }), entry({ x: 2, y: 1, sx: 4, sy: 2 }),
  ]);
  const { position, normal, uv } = mesh.geometry.attributes;
  const seam = start => {
    const result = [];
    for (let i = start; i < start + 24; i++) {
      if (Math.abs(position.getX(i)) < 1e-6 && normal.getZ(i) > 0.9) result.push([uv.getX(i), uv.getY(i)]);
    }
    return result.sort((a, b) => a[1] - b[1]);
  };
  assert.equal(seam(0).length, 2);
  assert.deepEqual(seam(0), seam(24));
});

test('linear per-instance tints survive batching while texture maps and tint materials remain shared', () => {
  const sourceMaterial = material();
  sourceMaterial.map = new THREE.Texture(); sourceMaterial.normalMap = new THREE.Texture();
  sourceMaterial.roughnessMap = new THREE.Texture();
  const source = new THREE.BoxGeometry();
  const mesh = createStaticSurfaceBatch(source, sourceMaterial, [entry({ tint: 0x697273 }), entry({ x: 3 })]);
  const colors = mesh.geometry.attributes.color, tint = new THREE.Color(0x697273);
  for (let i = 0; i < 24; i++) {
    near(colors.getX(i), tint.r, 'linear red'); near(colors.getY(i), tint.g, 'linear green'); near(colors.getZ(i), tint.b, 'linear blue');
    assert.equal(colors.getX(i + 24), 1, 'untinted entries stay white');
    assert.equal(colors.getY(i + 24), 1); assert.equal(colors.getZ(i + 24), 1);
  }
  assert.equal(sourceMaterial.vertexColors, false, 'other users of the original material do not change');
  assert.equal(mesh.material.vertexColors, true);
  for (const channel of ['map', 'normalMap', 'roughnessMap']) assert.equal(mesh.material[channel], sourceMaterial[channel]);
  assert.deepEqual(mesh.material.userData, sourceMaterial.userData, 'surface and ballistics metadata survive');
  assert.equal(createStaticSurfaceBatch(source, sourceMaterial, [entry({ tint: 0x121212 })]).material, mesh.material,
    'one tinted material variant is cached per source, never one per prop');
  const neutral = createStaticSurfaceBatch(source, sourceMaterial, [entry()]);
  assert.equal(neutral.material, sourceMaterial);
  assert.equal(neutral.geometry.attributes.color, undefined, 'untinted batches do not allocate unused colors');
});

test('printed planes, curved geometry and materials without physical scale keep their existing instancing', () => {
  const scaled = material(), plain = new THREE.MeshStandardMaterial();
  for (const geometry of [new THREE.PlaneGeometry(), new THREE.CylinderGeometry()]) {
    assert.equal(createStaticSurfaceBatch(geometry, scaled, [entry()]), null);
  }
  assert.equal(createStaticSurfaceBatch(new THREE.BoxGeometry(), plain, [entry()]), null);
  assert.equal(createStaticSurfaceBatch(new THREE.BoxGeometry(), scaled, []), null);
});

test('surface batching preserves bullet and sight hits, normals and open gaps', () => {
  const source = new THREE.BoxGeometry(), sourceMaterial = material();
  const entries = [entry({ x: -3, y: 2, sx: 2, sy: 4, sz: 0.5 }),
    entry({ x: 3, y: 2, sx: 2, sy: 4, sz: 0.5, ry: 0.37 })];
  const original = new THREE.InstancedMesh(source, sourceMaterial, entries.length);
  entries.forEach((value, index) => original.setMatrixAt(index, matrix(value)));
  const merged = createStaticSurfaceBatch(source, sourceMaterial, entries);
  const before = createBallisticWorld({ colliders: { list: [] } });
  const after = createBallisticWorld({ colliders: { list: [] } });
  const oldRoot = new THREE.Group(), newRoot = new THREE.Group();
  oldRoot.add(original); newRoot.add(merged);
  before.rebuild(oldRoot); after.rebuild(newRoot);
  for (const x of [-3, 0, 3]) {
    for (const direction of [-1, 1]) {
      const origin = new THREE.Vector3(x, 2, -direction * 6), target = new THREE.Vector3(x, 2, direction * 6);
      const ray = new THREE.Vector3(0, 0, direction);
      const oldHit = before.raycast(origin, ray, 12), newHit = after.raycast(origin, ray, 12);
      assert.equal(!!newHit, !!oldHit, 'no new invisible cover or missing faces');
      if (oldHit) {
        near(newHit.distance, oldHit.distance, 'hit distance');
        near(newHit.point.distanceTo(oldHit.point), 0, 'hit point');
        near(newHit.normal.distanceTo(oldHit.normal), 0, 'hit normal');
        assert.equal(newHit.surfaceKind, oldHit.surfaceKind);
      }
      for (const channel of ['bullet', 'sight']) {
        assert.equal(after.segmentOccluded(origin, target, channel), before.segmentOccluded(origin, target, channel));
      }
    }
  }
});
