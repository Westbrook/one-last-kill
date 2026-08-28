import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBallisticHit, createBallisticWorld } from '../../src/core/ballistics.js';
import { Colliders } from '../../src/core/collision.js';

const vector = coordinates => new THREE.Vector3(...coordinates);
const near = (actual, expected, label = 'distance', tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance,
  `${label}: ${actual} != ${expected}`);
const nearVector = (actual, expected, label = 'vector') => assert.ok(actual.distanceTo(expected) < 1e-6,
  `${label}: ${actual.toArray()} != ${expected.toArray()}`);
const cast = (world, origin = [0, 0, 3], direction = [0, 0, -1], range = 10, channel = 'bullet', output) =>
  world.raycast(vector(origin), vector(direction), range, channel, output);

function fixture(t, objects = [], colliders = null) {
  const root = new THREE.Group();
  root.add(...objects);
  const world = createBallisticWorld({ colliders });
  world.rebuild(root);
  t.after(() => world.clear());
  return { world, root };
}

function plane(z = 0, material = new THREE.MeshStandardMaterial()) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.position.z = z;
  return mesh;
}

function splitQuads() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -3, -1, 0, -1, -1, 0, -1, 1, 0, -3, 1, 0,
    1, -1, 0, 3, -1, 0, 3, 1, 0, 1, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  geometry.addGroup(0, 6, 0);
  geometry.addGroup(6, 6, 1);
  return geometry;
}

function checkerTexture() {
  const texture = new THREE.DataTexture(new Uint8Array([
    255, 255, 255, 0, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 0,
  ]), 2, 2);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

test('unbuilt worlds and empty roots cannot produce hits', () => {
  const world = createBallisticWorld({ colliders: null });
  assert.deepEqual(world.snapshot(), {
    ready: false, objects: 0, instances: 0, triangles: 0, geometryCount: 0,
    nodes: 0, unreadableAlphaMasks: 0, lastQuery: { nodes: 0, objects: 0, triangles: 0 },
  });
  assert.equal(cast(world), null);
  assert.equal(world.segmentOccluded(vector([0, 0, 3]), vector([0, 0, -3])), false);
  assert.equal(world.rebuild(new THREE.Group()).ready, true);
  assert.equal(cast(world), null);
  world.clear();
});

test('nearest rendered face wins independently of insertion order and shot direction', t => {
  const metal = new THREE.MeshStandardMaterial({ metalness: 0.9 });
  const stone = new THREE.MeshStandardMaterial(); stone.userData.surfaceKind = 'stone';
  const front = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1), metal);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1), stone); rear.position.z = -4;
  const { world, root } = fixture(t, [rear, front]);
  for (let order = 0; order < 2; order++) {
    let hit = cast(world, [0.2, 0.1, 3], [0, 0, -7], 10);
    assert.equal(hit?.object, front); assert.equal(hit.material, metal); assert.equal(hit.surfaceKind, 'metal');
    near(hit.distance, 2.5); nearVector(hit.point, vector([0.2, 0.1, 0.5]));
    nearVector(hit.normal, vector([0, 0, 1])); assert.equal(hit.instanceId, null);
    assert.ok(hit.triangleIndex >= 0 && hit.triangleIndex < 12);
    hit = cast(world, [0.2, 0.1, -7], [0, 0, 4], 10);
    assert.equal(hit?.object, rear); assert.equal(hit.material, stone); assert.equal(hit.surfaceKind, 'stone');
    near(hit.distance, 2.5); nearVector(hit.point, vector([0.2, 0.1, -4.5]));
    nearVector(hit.normal, vector([0, 0, -1]));
    root.clear(); root.add(front, rear); world.rebuild(root);
  }
});

test('real ring triangles block their members but preserve the hole and empty AABB corners', t => {
  const ring = new THREE.Mesh(new THREE.RingGeometry(1, 2, 48), new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
  const { world } = fixture(t, [ring]);
  for (const sign of [-1, 1]) {
    for (const [x, y] of [[0, 0], [0.5, 0], [1.8, 1.8]]) {
      assert.equal(cast(world, [x, y, sign * 3], [0, 0, -sign], 6), null, `open at ${x}, ${y}`);
    }
    const hit = cast(world, [1.5, 0.07, sign * 3], [0, 0, -sign], 6);
    assert.equal(hit?.object, ring); near(hit.distance, 3);
    nearVector(hit.normal, vector([0, 0, sign]), 'two-sided physical surface');
  }
});

test('rotated, nonuniform and mirrored parent transforms preserve world distance and face normals', t => {
  for (const mirrored of [false, true]) {
    const parent = new THREE.Group();
    parent.position.set(-2, 1, 4); parent.rotation.set(0.17, -0.4, 0.23); parent.scale.set(1.5, 0.8, 1.1);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.rotation.set(-0.3, 0.61, 0.2); mesh.position.set(0.5, 2, -1);
    mesh.scale.set(mirrored ? -2 : 2, 0.7, 1.8); parent.add(mesh);
    const { world } = fixture(t, [parent]);
    const contact = vector([0.12, -0.17, 0.5]).applyMatrix4(mesh.matrixWorld);
    const normal = vector([0, 0, 1]).applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize();
    const origin = contact.clone().addScaledVector(normal, 4), direction = normal.clone().multiplyScalar(-3);
    const originalOrigin = origin.clone(), originalDirection = direction.clone();
    const hit = world.raycast(origin, direction, 5);
    assert.equal(hit?.object, mesh); near(hit.distance, 4); nearVector(hit.point, contact); nearVector(hit.normal, normal);
    nearVector(origin, originalOrigin, 'origin remains untouched'); nearVector(direction, originalDirection, 'direction remains untouched');
  }
});

test('InstancedMesh retains per-instance transforms and identity while sharing its triangle hierarchy', t => {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 3);
  mesh.position.set(1, -2, 3); mesh.rotation.set(0.2, 0.1, -0.15);
  const matrices = [];
  for (let index = 0; index < 3; index++) {
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1 * index, 0.3, -0.2));
    const matrix = new THREE.Matrix4().compose(vector([index * 4, 0, 0]), rotation, vector([index === 1 ? -2 : 1.2, 0.7, 1.5]));
    matrices.push(matrix); mesh.setMatrixAt(index, matrix);
  }
  const { world } = fixture(t, [mesh]);
  assert.equal(world.snapshot().objects, 1); assert.equal(world.snapshot().instances, 3);
  assert.equal(world.snapshot().geometryCount, 1); assert.equal(world.snapshot().triangles, 12);
  for (let index = 0; index < 3; index++) {
    const matrix = mesh.matrixWorld.clone().multiply(matrices[index]);
    const contact = vector([0.1, -0.1, 0.5]).applyMatrix4(matrix);
    const normal = vector([0, 0, 1]).applyMatrix3(new THREE.Matrix3().getNormalMatrix(matrix)).normalize();
    const hit = world.raycast(contact.clone().addScaledVector(normal, 2), normal.clone().negate(), 3);
    assert.equal(hit?.object, mesh); assert.equal(hit.instanceId, index);
    near(hit.distance, 2); nearVector(hit.point, contact); nearVector(hit.normal, normal);
  }
});

test('indexed and non-indexed material groups return the rendered material and original triangle index', t => {
  for (const indexed of [true, false]) {
    let geometry = splitQuads();
    if (!indexed) geometry = geometry.toNonIndexed();
    const left = new THREE.MeshStandardMaterial(); left.name = 'surface-brick';
    const right = new THREE.MeshStandardMaterial(); right.userData.surfaceKind = 'wood';
    const mesh = new THREE.Mesh(geometry, [left, right]);
    const { world } = fixture(t, [mesh]);
    let hit = cast(world, [-2, 0.1, 3]);
    assert.equal(hit?.material, left); assert.equal(hit.surfaceKind, 'brick'); assert.ok(hit.triangleIndex < 2);
    hit = cast(world, [2, 0.1, 3]);
    assert.equal(hit?.material, right); assert.equal(hit.surfaceKind, 'wood'); assert.ok(hit.triangleIndex >= 2 && hit.triangleIndex < 4);
    right.visible = false;
    assert.equal(cast(world, [2, 0.1, 3]), null);
    assert.equal(cast(world, [-2, 0.1, 3])?.material, left);
  }
});

test('draw ranges exclude unrendered triangles while retaining source triangle indices', t => {
  for (const indexed of [true, false]) {
    let geometry = splitQuads();
    if (!indexed) geometry = geometry.toNonIndexed();
    geometry.setDrawRange(6, 6);
    const mesh = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
    const { world } = fixture(t, [mesh]);
    assert.equal(cast(world, [-2, 0.1, 3]), null);
    const hit = cast(world, [2, 0.1, 3]);
    assert.equal(hit?.object, mesh); assert.ok(hit.triangleIndex >= 2 && hit.triangleIndex < 4);
    assert.equal(world.snapshot().triangles, 2);
  }
});

test('triangle assembly starts at the exact draw-range or material-group index', t => {
  for (const indexed of [true, false]) for (const mode of ['range', 'group', 'group-and-range']) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      10, 10, 10, -1, -1, 0, 1, -1, 0, 0, 1, 0,
    ], 3));
    if (indexed) geometry.setIndex([0, 1, 2, 3]);
    const material = new THREE.MeshBasicMaterial();
    if (mode !== 'group') geometry.setDrawRange(1, 3);
    if (mode !== 'range') geometry.addGroup(mode === 'group' ? 1 : 0, mode === 'group' ? 3 : 4, 0);
    const mesh = new THREE.Mesh(geometry, mode === 'range' ? material : [material]);
    const { world } = fixture(t, [mesh]);
    const ray = new THREE.Raycaster(vector([0, 0, 2]), vector([0, 0, -1]), 0, 5);
    const reference = ray.intersectObject(mesh, false)[0];
    assert.ok(reference, `Three.js renders/raycasts ${indexed ? 'indexed' : 'nonindexed'} ${mode}`);
    const hit = cast(world, [0, 0, 2]);
    assert.equal(hit?.object, mesh); near(hit.distance, reference.distance);
    assert.equal(hit.triangleIndex, reference.faceIndex);
    assert.equal(world.snapshot().triangles, 1);
  }
});

test('array materials do not fill ungrouped triangles and single materials ignore groups', t => {
  const geometry = splitQuads(); geometry.clearGroups(); geometry.addGroup(0, 6, 0);
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, [material]);
  const { world, root } = fixture(t, [mesh]);
  assert.equal(cast(world, [-2, 0.1, 3])?.object, mesh);
  assert.equal(cast(world, [2, 0.1, 3]), null);
  mesh.material = material; world.rebuild(root);
  assert.equal(cast(world, [2, 0.1, 3])?.object, mesh);
});

test('transparent glass stops bullets while sight reaches the next opaque surface', t => {
  const glassMaterial = new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.35 });
  glassMaterial.userData.surfaceKind = 'glass';
  const glass = plane(1, glassMaterial), wall = plane(-2);
  const { world } = fixture(t, [wall, glass]);
  let hit = cast(world);
  assert.equal(hit?.object, glass); assert.equal(hit.surfaceKind, 'glass'); near(hit.distance, 2);
  hit = cast(world, [0, 0, 3], [0, 0, -1], 10, 'sight');
  assert.equal(hit?.object, wall); near(hit.distance, 5);
  assert.equal(world.segmentOccluded(vector([0, 0, 3]), vector([0, 0, 0]), 'bullet'), true);
  assert.equal(world.segmentOccluded(vector([0, 0, 3]), vector([0, 0, 0]), 'sight'), false);
});

test('transparent glass stays sight-clear at full opacity while an opaque glass-tagged screen blocks', t => {
  for (const material of [new THREE.MeshStandardMaterial({ transparent: true }), new THREE.MeshStandardMaterial()]) {
    material.name = 'surface-glass';
    const mesh = plane(0, material), { world } = fixture(t, [mesh]);
    assert.equal(cast(world)?.object, mesh);
    assert.equal(cast(world, [0, 0, 3], [0, 0, -1], 10, 'sight')?.object ?? null, material.transparent ? null : mesh);
  }
});

test('non-depth-writing overlays and zero-opacity materials never create invisible cover', t => {
  const overlay = plane(1, new THREE.MeshBasicMaterial({ depthWrite: false }));
  const hidden = plane(0, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }));
  const wall = plane(-1), { world } = fixture(t, [overlay, hidden, wall]);
  for (const channel of ['bullet', 'sight']) assert.equal(cast(world, [0, 0, 3], [0, 0, -1], 10, channel)?.object, wall);
  assert.equal(world.snapshot().instances, 2, 'the nonphysical overlay is not indexed');
});

test('nearest alpha-tested DataTexture pixels preserve holes for both bullets and sight', t => {
  const mesh = plane(0, new THREE.MeshBasicMaterial({ map: checkerTexture(), alphaTest: 0.5 }));
  const { world } = fixture(t, [mesh]);
  for (const channel of ['bullet', 'sight']) for (const [u, v, solid] of [
    [0.25, 0.25, false], [0.75, 0.25, true], [0.25, 0.75, true], [0.75, 0.75, false],
  ]) {
    assert.equal(Boolean(cast(world, [u * 2 - 1, v * 2 - 1, 3], [0, 0, -1], 10, channel)), solid, `${channel} UV ${u}, ${v}`);
  }
  assert.equal(world.snapshot().unreadableAlphaMasks, 0);
});

test('alpha coverage follows texture repeat, mirrored wrapping, offsets, rotation and flipY', t => {
  for (const flipY of [false, true]) {
    const texture = checkerTexture();
    texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.MirroredRepeatWrapping;
    texture.repeat.set(2, 3); texture.offset.set(0.1, -0.15); texture.center.set(0.2, 0.3); texture.rotation = 0.23;
    texture.flipY = flipY; texture.updateMatrix();
    const pixels = texture.image.data;
    const mesh = plane(0, new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5 }));
    const { world } = fixture(t, [mesh]);
    for (const u of [0.11, 0.27, 0.46, 0.71, 0.87]) for (const v of [0.19, 0.33, 0.63, 0.81]) {
      const uv = texture.transformUv(new THREE.Vector2(u, v));
      const column = Math.min(1, Math.floor(uv.x * 2)), row = Math.min(1, Math.floor(uv.y * 2));
      const expected = pixels[(row * 2 + column) * 4 + 3] >= 128;
      assert.equal(Boolean(cast(world, [u * 2 - 1, v * 2 - 1, 3])), expected, `flip ${flipY}, UV ${u}, ${v}`);
    }
  }
});

test('alphaMap samples green, multiplies map alpha and accepts float pixels', t => {
  const map = checkerTexture();
  const alphaMap = new THREE.DataTexture(new Float32Array([
    1, 1, 1, 1, 1, 0, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
  ]), 2, 2, THREE.RGBAFormat, THREE.FloatType);
  alphaMap.magFilter = alphaMap.minFilter = THREE.NearestFilter; alphaMap.flipY = false;
  const mesh = plane(0, new THREE.MeshBasicMaterial({ map, alphaMap, alphaTest: 0.5 }));
  const { world } = fixture(t, [mesh]);
  assert.equal(cast(world, [0.5, -0.5, 3]), null, 'zero green opens an otherwise opaque map texel');
  assert.equal(cast(world, [-0.5, 0.5, 3])?.object, mesh, 'unit float green preserves map coverage');
  assert.equal(cast(world, [-0.5, -0.5, 3]), null, 'opaque alphaMap cannot fill a hole in map alpha');
});

test('RED, RG and RGB masks use GPU defaults for absent alpha and green components', t => {
  for (const [format, pixels, mapBlocks, alphaMapBlocks] of [
    [THREE.RedFormat, [255], true, false],
    [THREE.RGFormat, [255, 0], true, false],
    [THREE.RGFormat, [0, 255], true, true],
    [THREE.RGBFormat, [255, 0, 255], true, false],
    [THREE.AlphaFormat, [0], false, false],
    [THREE.AlphaFormat, [255], true, false],
  ]) {
    for (const [property, expected] of [['map', mapBlocks], ['alphaMap', alphaMapBlocks]]) {
      const texture = new THREE.DataTexture(new Uint8Array(pixels), 1, 1, format);
      texture.magFilter = THREE.NearestFilter;
      const mesh = plane(0, new THREE.MeshBasicMaterial({ [property]: texture, alphaTest: 0.5 }));
      const { world } = fixture(t, [mesh]);
      assert.equal(Boolean(cast(world)), expected, `format ${format}, ${property}`);
      assert.equal(world.snapshot().unreadableAlphaMasks, 0);
    }
  }
});

test('cutout texture pixels and UV transforms are captured at build time without query readback', t => {
  const texture = checkerTexture(), image = texture.image, pixels = image.data;
  let imageReads = 0, pixelReads = 0;
  Object.defineProperty(texture, 'image', { configurable: true, get() { imageReads++; return image; } });
  Object.defineProperty(image, 'data', { configurable: true, get() { pixelReads++; return pixels; } });
  const mesh = plane(0, new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5 }));
  const { world } = fixture(t, [mesh]);
  assert.equal(imageReads, 1); assert.equal(pixelReads, 1);
  texture.updateMatrix = () => assert.fail('query must not rebuild a texture matrix');
  Object.defineProperty(texture, 'image', { get() { assert.fail('query must not access texture.image'); } });
  Object.defineProperty(image, 'data', { get() { assert.fail('query must not read image.data again'); } });
  for (let index = 0; index < 10; index++) {
    assert.equal(cast(world, [-0.5, -0.5, 3]), null);
    assert.equal(cast(world, [0.5, -0.5, 3])?.object, mesh);
  }
});

test('unreadable alpha masks remain open and are reported instead of becoming solid walls', t => {
  const texture = new THREE.Texture({ width: 2, height: 2 });
  const mesh = plane(0, new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5 }));
  const { world } = fixture(t, [mesh]);
  assert.equal(world.snapshot().unreadableAlphaMasks, 1);
  assert.equal(cast(world), null);
  assert.equal(cast(world, [0, 0, 3], [0, 0, -1], 10, 'sight'), null);
});

test('constant alpha testing does not require UV attributes when there is no texture', t => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ alphaTest: 0.5 }));
  const { world } = fixture(t, [mesh]);
  assert.equal(cast(world)?.object, mesh);
  mesh.material.opacity = 0.25;
  assert.equal(cast(world), null);
});

test('byte, unsigned-short, float and half-float masks use the same alpha threshold', t => {
  const formats = [
    [THREE.UnsignedByteType, Uint8Array, value => Math.round(value * 255)],
    [THREE.UnsignedShortType, Uint16Array, value => Math.round(value * 65535)],
    [THREE.FloatType, Float32Array, value => value],
    [THREE.HalfFloatType, Uint16Array, value => THREE.DataUtils.toHalfFloat(value)],
  ];
  for (const [type, ArrayType, encode] of formats) {
    const pixels = new ArrayType([1, 1, 1, 0.1, 1, 1, 1, 0.9].map(encode));
    const texture = new THREE.DataTexture(pixels, 2, 1, THREE.RGBAFormat, type);
    texture.magFilter = texture.minFilter = THREE.NearestFilter; texture.flipY = false;
    const mesh = plane(0, new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5 }));
    const { world } = fixture(t, [mesh]);
    assert.equal(cast(world, [-0.5, 0, 3]), null, `alpha 0.1 stays open for type ${type}`);
    assert.equal(cast(world, [0.5, 0, 3])?.object, mesh, `alpha 0.9 stays solid for type ${type}`);
    assert.equal(world.snapshot().unreadableAlphaMasks, 0);
  }
});

test('linear alpha filtering interpolates neighboring texels instead of expanding a cutout', t => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]), 2, 1);
  texture.magFilter = texture.minFilter = THREE.LinearFilter; texture.flipY = false;
  const mesh = plane(0, new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.6 }));
  const { world } = fixture(t, [mesh]);
  assert.equal(cast(world, [0, 0, 3]), null, 'the halfway texel blend is below 0.6');
  assert.equal(cast(world, [0.2, 0, 3])?.object, mesh, 'a 0.7 blend is above 0.6');
  assert.equal(cast(world, [-0.75, 0, 3]), null, 'clamped transparent edge stays open');
  assert.equal(cast(world, [0.75, 0, 3])?.object, mesh, 'clamped opaque edge stays solid');
});

test('addObject is idempotent and updateObject refreshes transforms and replaced geometry', t => {
  const world = createBallisticWorld({ colliders: null }); t.after(() => world.clear());
  const mesh = plane();
  assert.equal(world.addObject(mesh), mesh);
  assert.equal(world.snapshot().ready, true);
  assert.equal(cast(world)?.object, mesh);
  world.addObject(mesh); assert.equal(world.snapshot().instances, 1);
  mesh.position.x = 4;
  assert.equal(world.updateObject(mesh), mesh);
  assert.equal(cast(world), null); assert.equal(cast(world, [4, 0, 3])?.object, mesh);
  mesh.geometry = new THREE.BoxGeometry(2, 2, 2);
  mesh.material = new THREE.MeshStandardMaterial(); mesh.material.name = 'surface-steel';
  world.updateObject(mesh);
  const hit = cast(world, [4, 0, 3]);
  assert.equal(hit?.object, mesh); assert.equal(hit.surfaceKind, 'steel'); assert.equal(hit.material, mesh.material);
  near(hit.distance, 2); near(hit.point.z, 1);
  assert.equal(world.snapshot().instances, 1);
});

test('live ancestor and material visibility or channel policies do not require reindexing', t => {
  const mesh = plane(), parent = new THREE.Group(); parent.add(mesh);
  const { world, root } = fixture(t, [parent]);
  const solid = () => assert.equal(cast(world)?.object, mesh);
  const clear = () => assert.equal(cast(world), null);
  solid(); mesh.visible = false; clear(); mesh.visible = true; solid();
  parent.visible = false; clear(); parent.visible = true; solid();
  root.visible = false; clear(); root.visible = true; solid();
  mesh.material.visible = false; clear(); mesh.material.visible = true; solid();
  parent.userData.ballistics = false; clear(); parent.userData.ballistics = true; solid();
  parent.userData.ballistics = { bullet: false }; clear();
  assert.equal(cast(world, [0, 0, 3], [0, 0, -1], 10, 'sight')?.object, mesh);
  parent.userData.ballistics = { sight: false }; solid();
  assert.equal(cast(world, [0, 0, 3], [0, 0, -1], 10, 'sight'), null);
  parent.userData.ballistics = true; mesh.material.userData.ballistics = { bullet: false }; clear();
  assert.equal(cast(world, [0, 0, 3], [0, 0, -1], 10, 'sight')?.object, mesh);
  mesh.material.userData.ballistics = false;
  assert.equal(cast(world, [0, 0, 3], [0, 0, -1], 10, 'sight'), null);
  mesh.material.userData.ballistics = true; solid();
  assert.equal(world.snapshot().instances, 1);
});

test('a mesh indexed while invisible can become visible without missing geometry', t => {
  const mesh = plane(); mesh.visible = false;
  const { world } = fixture(t, [mesh]);
  assert.equal(cast(world), null); assert.equal(world.snapshot().instances, 1);
  mesh.visible = true; assert.equal(cast(world)?.object, mesh);
});

test('linked collider enable revisions suppress gates without reviving cleared collider identities', t => {
  Colliders.clear(); t.after(() => Colliders.clear());
  const collider = Colliders.addBoxBySize(0, 0, 0, 2, 2, 0.2);
  const mesh = plane(), gate = new THREE.Group(); gate.userData.collider = collider; gate.add(mesh);
  const { world } = fixture(t, [gate], Colliders);
  Colliders.setEnabled(collider, false);
  assert.equal(cast(world), null, 'the first query sees a gate disabled after build');
  Colliders.setEnabled(collider, true); assert.equal(cast(world)?.object, mesh);
  Colliders.setEnabled(collider, false); assert.equal(cast(world), null);
  Colliders.setEnabled(collider, true); assert.equal(cast(world)?.object, mesh);
  Colliders.clear(); assert.equal(cast(world), null);
  assert.equal(Colliders.setEnabled(collider, true), false); assert.equal(cast(world), null);
  const replacement = Colliders.addBoxBySize(0, 0, 0, 2, 2, 0.2);
  assert.equal(cast(world), null, 'a new box cannot activate an old linked identity');
  gate.userData.collider = replacement; world.updateObject(gate);
  assert.equal(cast(world)?.object, mesh);
  Colliders.setEnabled(replacement, false);
  const override = Colliders.addBoxBySize(0, 0, 0, 2, 2, 0.2);
  world.updateObject(gate, { collider: override }); assert.equal(cast(world)?.object, mesh);
  Colliders.setEnabled(override, false); assert.equal(cast(world), null);
});

test('material refresh applies opacity, surface classification and depth policy to shared siblings', t => {
  const material = new THREE.MeshStandardMaterial(), left = plane(0, material), right = plane(0, material);
  left.position.x = -2; right.position.x = 2;
  const { world } = fixture(t, [left, right]);
  for (const x of [-2, 2]) assert.ok(cast(world, [x, 0, 3], [0, 0, -1], 10, 'sight'));
  material.transparent = true; material.opacity = 0.25; material.userData.surfaceKind = 'glass';
  world.updateObject(left);
  for (const [x, mesh] of [[-2, left], [2, right]]) {
    const hit = cast(world, [x, 0, 3]);
    assert.equal(hit?.object, mesh); assert.equal(hit.surfaceKind, 'glass'); assert.equal(hit.material, material);
    assert.equal(cast(world, [x, 0, 3], [0, 0, -1], 10, 'sight'), null);
  }
  material.depthWrite = false; world.updateObject(left);
  for (const x of [-2, 2]) assert.equal(cast(world, [x, 0, 3]), null);
  material.depthWrite = true; material.transparent = false; material.opacity = 1; material.userData.surfaceKind = 'stone';
  world.updateObject(left);
  for (const [x, mesh] of [[-2, left], [2, right]]) {
    const hit = cast(world, [x, 0, 3], [0, 0, -1], 10, 'sight');
    assert.equal(hit?.object, mesh); assert.equal(hit.surfaceKind, 'stone');
  }
});

test('material mask refresh updates shared coverage and unreadable-mask diagnostics without double counting', t => {
  const material = new THREE.MeshBasicMaterial({ map: new THREE.Texture({ width: 2, height: 2 }), alphaTest: 0.5 });
  const left = plane(0, material), right = plane(0, material); left.position.x = -2; right.position.x = 2;
  const { world } = fixture(t, [left, right]);
  assert.equal(world.snapshot().unreadableAlphaMasks, 1);
  for (const x of [-2, 2]) assert.equal(cast(world, [x + 0.5, -0.5, 3]), null);
  material.map = checkerTexture(); world.updateObject(left);
  for (const [x, mesh] of [[-2, left], [2, right]]) {
    assert.equal(cast(world, [x + 0.5, -0.5, 3])?.object, mesh);
    assert.equal(cast(world, [x - 0.5, -0.5, 3]), null);
  }
  assert.equal(world.snapshot().unreadableAlphaMasks, 0);
  material.map.flipY = true; world.updateObject(left);
  for (const [x, mesh] of [[-2, left], [2, right]]) {
    assert.equal(cast(world, [x + 0.5, -0.5, 3]), null);
    assert.equal(cast(world, [x - 0.5, -0.5, 3])?.object, mesh);
  }
  world.updateObject(left); assert.equal(world.snapshot().unreadableAlphaMasks, 0);
});

test('rebuild reflects edits to shared geometry buffers and draw ranges', t => {
  const geometry = splitQuads(), left = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const right = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); right.position.y = 4;
  const { world, root } = fixture(t, [left, right]);
  assert.equal(cast(world, [-2, 0.1, 3])?.object, left);
  assert.equal(cast(world, [-2, 4.1, 3])?.object, right);
  geometry.translate(8, 0, 0); geometry.setDrawRange(6, 6);
  world.rebuild(root);
  for (const [y, mesh] of [[0.1, left], [4.1, right]]) {
    assert.equal(cast(world, [-2, y, 3]), null, 'old bounds are gone');
    assert.equal(cast(world, [6, y, 3]), null, 'removed draw-range triangles are gone');
    assert.equal(cast(world, [10, y, 3])?.object, mesh);
  }
  assert.equal(world.snapshot().geometryCount, 1); assert.equal(world.snapshot().triangles, 2);
});

test('updating instance matrices and count replaces old bounds and skips zero-scale instances', t => {
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial(), 3);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.setMatrixAt(1, new THREE.Matrix4().makeScale(0, 0, 0));
  mesh.setMatrixAt(2, new THREE.Matrix4().makeTranslation(6, 0, 0));
  const { world } = fixture(t, [mesh]);
  assert.equal(world.snapshot().instances, 2);
  assert.equal(cast(world, [6, 0, 3])?.instanceId, 2);
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(-6, 0, 0));
  mesh.setMatrixAt(2, new THREE.Matrix4().makeTranslation(10, 0, 0));
  world.updateObject(mesh);
  assert.equal(world.snapshot().instances, 3);
  assert.equal(cast(world, [-6, 0, 3])?.instanceId, 1);
  assert.equal(cast(world, [10, 0, 3])?.instanceId, 2);
  assert.equal(cast(world, [6, 0, 3]), null);
  mesh.count = 1; world.updateObject(mesh);
  assert.equal(world.snapshot().instances, 1); assert.equal(cast(world)?.instanceId, 0);
  assert.equal(cast(world, [-6, 0, 3]), null); assert.equal(cast(world, [10, 0, 3]), null);
  assert.equal(world.snapshot().geometryCount, 1); assert.equal(world.snapshot().triangles, 2);
});

test('removed, detached, rebuilt and cleared objects leave no stale query hits', t => {
  const first = plane(), second = plane(-2), group = new THREE.Group(); group.add(first);
  const { world, root } = fixture(t, [group, second]);
  assert.equal(cast(world)?.object, first);
  world.removeObject(group); assert.equal(cast(world)?.object, second); assert.equal(world.snapshot().instances, 1);
  world.addObject(group); assert.equal(cast(world)?.object, first);
  root.remove(group); assert.equal(cast(world)?.object, second, 'detaching an indexed child disables its old attachment');
  const replacement = plane(1), replacementRoot = new THREE.Group(); replacementRoot.add(replacement);
  world.rebuild(replacementRoot);
  assert.equal(world.snapshot().objects, 1); assert.equal(world.snapshot().triangles, 2);
  const pooled = cast(world); assert.equal(pooled?.object, replacement);
  world.clear(); assert.equal(pooled.object, null); assert.equal(pooled.material, null); assert.equal(pooled.distance, Infinity);
  assert.equal(cast(world), null);
  assert.deepEqual(world.snapshot(), {
    ready: false, objects: 0, instances: 0, triangles: 0, geometryCount: 0,
    nodes: 0, unreadableAlphaMasks: 0, lastQuery: { nodes: 0, objects: 0, triangles: 0 },
  });
  world.addObject(second); assert.equal(cast(world)?.object, second, 'adding after clear starts a fresh standalone index');
  world.removeObject(second); assert.equal(cast(world), null); assert.equal(world.snapshot().nodes, 0);
});

test('finite rays honor world-metre ranges, the default range and the bounded maximum', t => {
  const mesh = plane(), { world, root } = fixture(t, [mesh]);
  assert.equal(cast(world, [0, 0, 3], [0, 0, -8], 2.99), null);
  near(cast(world, [0, 0, 3], [0, 0, -8], 3).distance, 3);
  mesh.position.z = 121; world.updateObject(mesh);
  assert.equal(world.raycast(vector([0, 0, 0]), vector([0, 0, 1])), null, 'default range stops at 120 metres');
  near(cast(world, [0, 0, 0], [0, 0, 1], 122).distance, 121);
  mesh.position.z = 512; world.updateObject(mesh);
  near(cast(world, [0, 0, 0], [0, 0, 5], 1e9).distance, 512);
  mesh.position.z = 513; world.updateObject(mesh);
  assert.equal(cast(world, [0, 0, 0], [0, 0, 5], 1e9), null, 'oversized requests cannot exceed the 512 metre cap');
  root.remove(mesh); world.rebuild(root); assert.equal(cast(world), null);
});

test('invalid origins, directions, channels and limits return no hit and reset output and metrics', t => {
  const { world } = fixture(t, [plane()]), output = createBallisticHit();
  const invalidQueries = [];
  for (const value of [NaN, Infinity, -Infinity]) for (let axis = 0; axis < 3; axis++) {
    const origin = [0, 0, 3], direction = [0, 0, -1];
    origin[axis] = value; invalidQueries.push([vector(origin), vector([0, 0, -1]), 10, 'bullet']);
    direction[axis] = value; invalidQueries.push([vector([0, 0, 3]), vector(direction), 10, 'bullet']);
  }
  for (const range of [0, -1, NaN, Infinity, -Infinity]) invalidQueries.push([vector([0, 0, 3]), vector([0, 0, -1]), range, 'bullet']);
  invalidQueries.push([null, vector([0, 0, -1]), 10, 'bullet'], [vector([0, 0, 3]), null, 10, 'bullet'],
    [vector([0, 0, 3]), vector([0, 0, 0]), 10, 'bullet'], [vector([0, 0, 3]), vector([0, 0, -1]), 10, 'invalid']);
  for (const query of invalidQueries) {
    assert.ok(cast(world, [0, 0, 3], [0, 0, -1], 10, 'bullet', output));
    assert.equal(world.raycast(...query, output), null);
    assert.equal(output.object, null); assert.equal(output.material, null); assert.equal(output.distance, Infinity);
    assert.equal(output.triangleIndex, -1); assert.equal(output.instanceId, null);
    nearVector(output.point, vector([0, 0, 0])); nearVector(output.normal, vector([0, 0, 0]));
    assert.deepEqual(world.snapshot().lastQuery, { nodes: 0, objects: 0, triangles: 0 });
  }
});

test('segment queries exclude their endpoints and reject empty or invalid segments', t => {
  const { world } = fixture(t, [plane()]);
  for (const sign of [-1, 1]) {
    const start = vector([0, 0, sign * 3]);
    assert.equal(world.segmentOccluded(start, vector([0, 0, 0]), 'bullet'), false);
    assert.equal(world.segmentOccluded(start, vector([0, 0, -sign * 0.1]), 'bullet'), true);
    assert.equal(world.segmentOccluded(vector([0, 0, 0]), start, 'sight'), false);
  }
  assert.equal(cast(world, [0, 0, 0], [0, 0, 1]), null, 'a ray does not strike its starting surface');
  assert.equal(cast(world, [0, 0, 1e-6], [0, 0, -1]), null, 'surface roundoff cannot create an immediate hit');
  assert.ok(cast(world, [0, 0, 0.001], [0, 0, -1]));
  assert.equal(world.segmentOccluded(vector([0, 0, 3]), vector([0, 0, 3])), false);
  assert.equal(world.segmentOccluded(vector([0, 0, 1e-6]), vector([0, 0, -1e-6])), false);
  assert.equal(world.segmentOccluded(null, vector([0, 0, 0])), false);
  assert.equal(world.segmentOccluded(vector([0, 0, 0]), vector([0, NaN, 0])), false);
});

test('retained output objects stay independent while the default hit is deliberately pooled', t => {
  const mesh = plane(), { world } = fixture(t, [mesh]);
  const retained = createBallisticHit(), unused = createBallisticHit();
  assert.notEqual(retained.point, unused.point); assert.notEqual(retained.normal, unused.normal);
  assert.equal(cast(world, [0.25, -0.2, 3], [0, 0, -1], 10, 'bullet', retained), retained);
  const savedPoint = retained.point.clone(), savedNormal = retained.normal.clone();
  const first = cast(world, [0, 0, 3]), second = cast(world, [0, 0, -5], [0, 0, 1]);
  assert.equal(first, second); assert.notEqual(first, retained); near(first.distance, 5);
  nearVector(first.normal, vector([0, 0, -1]));
  assert.equal(cast(world, [4, 0, 3]), null); assert.equal(first.object, null); assert.equal(first.distance, Infinity);
  assert.equal(retained.object, mesh); near(retained.distance, 3);
  nearVector(retained.point, savedPoint); nearVector(retained.normal, savedNormal);
  assert.equal(cast(world, [4, 0, 3], [0, 0, -1], 10, 'bullet', retained), null);
  assert.equal(retained.object, null); assert.equal(retained.material, null); assert.equal(retained.distance, Infinity);
  const other = fixture(t, [plane()]).world;
  assert.notEqual(cast(world), cast(other), 'each world owns its own default pool');
});

test('query work remains bounded and never traverses the scene, updates transforms or calls Mesh.raycast', t => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial(), meshes = [];
  for (let row = -12; row <= 12; row++) for (let column = -12; column <= 12; column++) {
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(column * 3, row * 3, 0); meshes.push(mesh);
  }
  const { world, root } = fixture(t, meshes), center = meshes.find(mesh => mesh.position.x === 0 && mesh.position.y === 0);
  const build = world.snapshot();
  assert.equal(build.objects, 625); assert.equal(build.instances, 625); assert.equal(build.geometryCount, 1); assert.equal(build.triangles, 12);
  const forbidden = () => assert.fail('shot queries must use the built spatial index');
  root.traverse = root.updateWorldMatrix = forbidden;
  for (const mesh of meshes) mesh.traverse = mesh.updateWorldMatrix = mesh.raycast = forbidden;
  for (let index = 0; index < 12; index++) assert.equal(cast(world, [0.1, 0.1, 10], [0, 0, -1], 20)?.object, center);
  const stats = world.snapshot();
  assert.ok(stats.lastQuery.nodes > 0 && stats.lastQuery.nodes < 100, `nodes: ${stats.lastQuery.nodes}`);
  assert.ok(stats.lastQuery.objects <= 8, `objects: ${stats.lastQuery.objects}`);
  assert.ok(stats.lastQuery.triangles <= 24, `triangles: ${stats.lastQuery.triangles}`);
  assert.equal(cast(world, [100, 100, 10], [0, 0, -1], 20), null);
  assert.deepEqual(world.snapshot().lastQuery, { nodes: 1, objects: 0, triangles: 0 });
  assert.ok(stats.lastQuery.objects > 0, 'snapshot metrics are copies, not mutable aliases');
});

test('a detailed curved mesh uses its triangle hierarchy instead of scanning every face', t => {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2, 64, 32), new THREE.MeshStandardMaterial());
  const { world } = fixture(t, [mesh]);
  const hit = cast(world, [0.12, 0.17, 6], [0, 0, -1], 10);
  assert.equal(hit?.object, mesh); assert.ok(hit.distance > 4 && hit.distance < 4.1);
  near(hit.normal.length(), 1); assert.ok(hit.normal.z > 0.98);
  const stats = world.snapshot();
  assert.ok(stats.triangles > 3_000); assert.equal(stats.lastQuery.objects, 1);
  assert.ok(stats.lastQuery.triangles > 0 && stats.lastQuery.triangles < 128, `tested ${stats.lastQuery.triangles} of ${stats.triangles} triangles`);
});

test('invalid roots and objects fail without replacing an already valid index', t => {
  const mesh = plane(), { world } = fixture(t, [mesh]);
  for (const object of [null, undefined, {}, { traverse() {} }]) {
    assert.throws(() => world.rebuild(object), /Object3D root/);
    assert.throws(() => world.addObject(object), /Object3D/);
    assert.throws(() => world.updateObject(object), /Object3D/);
    assert.equal(cast(world)?.object, mesh);
  }
});
