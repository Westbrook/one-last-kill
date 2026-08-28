import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { resolveSurfaceOwnership } from '../../src/world/surface-ownership.js';

const EPS = 1e-5;
const near = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < EPS, `${message}: ${actual} ≈ ${expected}`);

function fromMesh(id, kind, mesh) {
  mesh.name = id; mesh.updateWorldMatrix(true, true);
  if (mesh.geometry) { mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere(); }
  const bounds = new THREE.Box3().setFromObject(mesh);
  const collider = { min: bounds.min.clone(), max: bounds.max.clone(), enabled: true, tag: id };
  mesh.userData.collider = collider;
  return { id, kind, mesh, bounds, collider, supports: [] };
}

function box(id, kind, min = [-2, 0, -2], max = [2, 2, 2], geometry = null) {
  const mesh = new THREE.Mesh(geometry || new THREE.BoxGeometry(...max.map((value, i) => value - min[i])),
    new THREE.MeshStandardMaterial({ roughness: 0.9 }));
  mesh.position.fromArray(max.map((value, i) => (value + min[i]) / 2));
  return fromMesh(id, kind, mesh);
}

const floor = (id = 'floor', min = [-3, 1.75, -3], max = [3, 2, 3]) => box(id, 'floor', min, max);

// Read the actual index buffer. Unreferenced original cap vertices do not
// represent drawn surface area after a face has been partially removed.
function triangles(mesh) {
  mesh.updateWorldMatrix(true, false);
  const { geometry } = mesh, { position, normal, uv } = geometry.attributes;
  const index = geometry.index, count = index ? index.count : position.count;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const out = [];
  for (let offset = 0; offset < count; offset += 3) {
    const ids = [0, 1, 2].map(i => index ? index.getX(offset + i) : offset + i);
    const points = ids.map(i => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
    const cross = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0]));
    out.push({ offset, ids, points, area: cross.length() / 2, normal: cross.normalize(),
      normals: ids.map(i => new THREE.Vector3().fromBufferAttribute(normal, i).applyNormalMatrix(normalMatrix)),
      uv: ids.map(i => new THREE.Vector2().fromBufferAttribute(uv, i)) });
  }
  return out;
}

const capArea = (mesh, sign = 1) => triangles(mesh).filter(triangle => triangle.normal.y * sign > 1 - EPS)
  .reduce((sum, triangle) => sum + triangle.area, 0);
const totalArea = mesh => triangles(mesh).reduce((sum, triangle) => sum + triangle.area, 0);

function capHits(mesh, x, z, plane = 2, sign = 1) {
  mesh.updateWorldMatrix(true, true);
  const ray = new THREE.Raycaster(new THREE.Vector3(x, plane + sign * 10, z), new THREE.Vector3(0, -sign, 0), 0, 20);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  return ray.intersectObject(mesh, false).filter(hit => Math.abs(hit.point.y - plane) < EPS
    && hit.face.normal.clone().applyNormalMatrix(normalMatrix).y * sign > 1 - EPS);
}

function ownersAt(records, x, z, plane = 2, sign = 1) {
  return records.filter(record => capHits(record.mesh, x, z, plane, sign).length).map(record => record.id).sort();
}

function geometryState(geometry) {
  return {
    index: geometry.index && Array.from(geometry.index.array),
    attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([name, attribute]) => [name,
      { itemSize: attribute.itemSize, normalized: attribute.normalized, values: Array.from(attribute.array) }])),
    groups: geometry.groups.map(group => ({ ...group })), drawRange: { ...geometry.drawRange },
    userData: JSON.parse(JSON.stringify(geometry.userData)),
    box: geometry.boundingBox && [geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()],
    sphere: geometry.boundingSphere && [geometry.boundingSphere.center.toArray(), geometry.boundingSphere.radius],
  };
}

function meshGeometryStates(records) {
  const states = [];
  for (const record of records) record.mesh.traverse(mesh => {
    if (mesh.isMesh) states.push({ mesh, geometry: mesh.geometry, data: geometryState(mesh.geometry) });
  });
  return states;
}

function assertUnchanged(states, message) {
  for (const state of states) {
    assert.equal(state.mesh.geometry, state.geometry, message);
    assert.deepEqual(geometryState(state.mesh.geometry), state.data, message);
  }
}

test('a complete finish removes only a same-facing support cap, measured by triangles and rays', () => {
  const support = box('wall', 'wall'), finish = floor();
  const original = support.mesh.geometry, finishState = meshGeometryStates([finish]);
  near(capArea(support.mesh), 16); near(totalArea(support.mesh), 64);
  resolveSurfaceOwnership([support, finish]);
  assert.notEqual(support.mesh.geometry, original, 'clipping belongs to this mesh, not its source');
  near(capArea(support.mesh), 0); near(capArea(support.mesh, -1), 16);
  near(totalArea(support.mesh), 48, 'all four walls and the opposite cap remain');
  assert.deepEqual(ownersAt([support, finish], 0.23, 0.31), ['floor']);
  assert.ok(capHits(support.mesh, 0.23, 0.31, 0, -1).length, 'underside remains ray-visible');
  assertUnchanged(finishState, 'the winning floor is unchanged');
});

test('partial subtraction preserves exposed support strips and corners', () => {
  const support = box('wall', 'wall'), finish = floor('tile', [-1, 1.75, -1], [1, 2, 1]);
  resolveSurfaceOwnership([support, finish]);
  near(capArea(support.mesh), 12); near(capArea(support.mesh, -1), 16);
  assert.deepEqual(ownersAt([support, finish], 0.21, 0.31), ['tile']);
  for (const [x, z] of [[-1.5, 0], [1.5, 0], [0, -1.5], [0, 1.5], [-1.5, -1.5], [1.5, 1.5]]) {
    assert.deepEqual(ownersAt([support, finish], x, z), ['wall'], `exposed cap at ${x},${z}`);
  }
});

function unionFixture() {
  return [box('wall', 'wall', [0, 0, 0], [6, 2, 4]),
    floor('tile-a', [0, 1.75, 0], [3, 2, 3]),
    floor('tile-b', [2, 1.75, 1], [5, 2, 4]),
    floor('tile-c-duplicate', [0, 1.75, 0], [3, 2, 3])];
}

test('overlapping tiles subtract their union once and keep one finish owner in overlap', () => {
  const records = unionFixture(), support = records[0];
  resolveSurfaceOwnership(records);
  near(capArea(support.mesh), 8, '24 minus the 16 square metre union');
  for (let x = 0.25; x < 6; x += 0.5) {
    for (let z = 0.25; z < 4; z += 0.5) {
      const covered = (x < 3 && z < 3) || (x > 2 && x < 5 && z > 1);
      const owners = ownersAt(records, x, z);
      assert.equal(owners.length, 1, `exactly one drawn owner at ${x},${z}`);
      assert.equal(owners[0] === 'wall', !covered);
    }
  }
  near(records.reduce((area, record) => area + capArea(record.mesh), 0), 24);
});

test('a real gap between finish tiles leaves the exposed support cap intact', () => {
  const support = box('wall', 'wall');
  const left = floor('left', [-2, 1.75, -2], [-0.125, 2, 2]);
  const right = floor('right', [0.125, 1.75, -2], [2, 2, 2]);
  resolveSurfaceOwnership([support, left, right]);
  near(capArea(support.mesh), 1, 'a 25 cm gap across four metres');
  for (const z of [-1.75, -0.25, 0.75, 1.75]) assert.deepEqual(ownersAt([support, left, right], 0, z), ['wall']);
  assert.deepEqual(ownersAt([support, left, right], -0.25, 0.31), ['left']);
  assert.deepEqual(ownersAt([support, left, right], 0.25, 0.31), ['right']);
});

test('49 nm placement error is coplanar at default tolerance but not at a stricter tolerance', () => {
  for (const offset of [-49e-9, 49e-9]) {
    const support = box('wall', 'wall'), finish = floor();
    finish.mesh.position.y += offset; finish.mesh.updateMatrixWorld(true);
    finish.bounds.translate(new THREE.Vector3(0, offset, 0));
    resolveSurfaceOwnership([support, finish]);
    near(capArea(support.mesh), 0, `default plane tolerance accepts ${offset}`);
    const strictSupport = box('wall', 'wall'), strictFinish = floor();
    strictFinish.mesh.position.y += offset; strictFinish.mesh.updateMatrixWorld(true);
    strictFinish.bounds.translate(new THREE.Vector3(0, offset, 0));
    const before = meshGeometryStates([strictSupport, strictFinish]);
    resolveSurfaceOwnership([strictSupport, strictFinish], { tolerance: 1e-8 });
    near(capArea(strictSupport.mesh), 16); assertUnchanged(before, 'strict tolerance keeps distinct planes');
  }
});

test('intentional one-millimetre height offsets are never merged', () => {
  for (const offset of [-0.001, 0.001]) {
    const support = box('wall', 'wall'), finish = floor();
    finish.mesh.position.y += offset; finish.mesh.updateMatrixWorld(true);
    finish.bounds.translate(new THREE.Vector3(0, offset, 0));
    const before = meshGeometryStates([support, finish]);
    resolveSurfaceOwnership([support, finish]);
    near(capArea(support.mesh), 16); assertUnchanged(before, `intentional offset ${offset}`);
  }
});

test('edge-only and corner-only contact have no covered area', () => {
  for (const [min, max] of [[[2, 1.75, -2], [4, 2, 2]], [[2, 1.75, 2], [4, 2, 4]]]) {
    const support = box('wall', 'wall'), finish = floor('tile', min, max);
    const before = meshGeometryStates([support, finish]);
    resolveSurfaceOwnership([support, finish]);
    near(capArea(support.mesh), 16); assertUnchanged(before, 'touching an edge does not erase a face');
  }
});

test('downward caps yield only to a coplanar downward finish', () => {
  const support = box('beam', 'beam'), ceiling = box('ceiling', 'ceiling', [-1, 0, -1], [1, 0.25, 1]);
  resolveSurfaceOwnership([support, ceiling]);
  near(capArea(support.mesh, -1), 12); near(capArea(support.mesh), 16);
  assert.deepEqual(ownersAt([support, ceiling], 0.23, 0.31, 0, -1), ['ceiling']);
  assert.deepEqual(ownersAt([support, ceiling], 1.5, 0.31, 0, -1), ['beam']);
});

test('opposing normals on a shared plane keep both physical faces', () => {
  for (const [min, max] of [[[-3, 2, -3], [3, 2.25, 3]], [[-3, -0.25, -3], [3, 0, 3]]]) {
    const support = box('wall', 'wall'), finish = floor('finish', min, max);
    const before = meshGeometryStates([support, finish]);
    resolveSurfaceOwnership([support, finish]);
    near(capArea(support.mesh), 16); near(capArea(support.mesh, -1), 16);
    assertUnchanged(before, 'opposite sides of a physical contact are not duplicate facing surfaces');
  }
});

test('horizontal ownership never clips coplanar vertical or perpendicular box faces', () => {
  const support = box('wall', 'wall'), finish = floor('finish', [1.5, 0.5, -2], [2, 1, 2]);
  const before = meshGeometryStates([support, finish]);
  // The +X faces share x=2, with a real overlapping rectangle; neither
  // horizontal finish plane matches the wall's top or bottom.
  resolveSurfaceOwnership([support, finish]);
  near(totalArea(support.mesh), 64); assertUnchanged(before, 'vertical ownership is outside this pass');
});

test('all declared finish kinds outrank supports, while two supports do not arbitrate each other', () => {
  const finishKinds = ['floor', 'deck', 'slab', 'roof', 'landing', 'tread', 'ceiling', 'threshold'];
  const supportKinds = ['wall', 'building', 'partition', 'lintel', 'beam', 'parapet', 'column', 'pier', 'foundation', 'structure'];
  for (const kind of finishKinds) {
    const support = box('wall', 'wall'), finish = floor(); finish.kind = kind;
    resolveSurfaceOwnership([support, finish]); near(capArea(support.mesh), 0, kind);
  }
  for (const kind of supportKinds) {
    const support = box('support', kind), finish = floor();
    resolveSurfaceOwnership([support, finish]); near(capArea(support.mesh), 0, kind);
  }
  const wall = box('a-wall', 'wall'), beam = box('b-beam', 'beam');
  const before = meshGeometryStates([wall, beam]);
  resolveSurfaceOwnership([wall, beam]); assertUnchanged(before, 'supports have no finishing-surface priority');
});

test('threshold owns its flush strip over a floor and the floor owns the remaining support cap', () => {
  const support = box('wall', 'wall'), finish = floor('floor', [-2, 1.75, -2], [2, 2, 2]);
  const threshold = box('threshold', 'threshold', [-0.5, 1.5, -2], [0.5, 2, 2]);
  resolveSurfaceOwnership([support, finish, threshold]);
  near(capArea(support.mesh), 0); near(capArea(finish.mesh), 12); near(capArea(threshold.mesh), 4);
  assert.deepEqual(ownersAt([support, finish, threshold], 0.23, 0.31), ['threshold']);
  assert.deepEqual(ownersAt([support, finish, threshold], 1.23, 0.31), ['floor']);
  assert.deepEqual(ownersAt([support, finish, threshold], -1.23, 0.31), ['floor']);
});

test('equal-priority finishes select one stable lexical owner independent of input order', () => {
  for (const reverse of [false, true]) {
    const a = box('a-finish', 'deck', [-2, 1.75, -2], [2, 2, 2]);
    const z = box('z-finish', 'floor', [-2, 1.5, -2], [2, 2, 2]);
    resolveSurfaceOwnership(reverse ? [z, a] : [a, z]);
    near(capArea(a.mesh), 16); near(capArea(z.mesh), 0);
    assert.deepEqual(ownersAt([a, z], 0.23, 0.31), ['a-finish']);
  }
});

function affineUV(position, normal) {
  return [0.31 + 1.25 * position.x - 0.75 * position.z + 0.125 * position.y + normal.x * 2 + normal.y * 3 + normal.z * 5,
    -0.17 + 0.625 * position.x + 1.375 * position.z + 0.25 * position.y - normal.x * 5 + normal.y + normal.z * 2];
}

test('new cut vertices retain affine UVs, matching seam values, normals and outward winding', () => {
  const support = box('wall', 'wall', [-3, 0, -2], [3, 2, 2]);
  const finish = floor('tile', [-1, 1.75, -0.75], [1, 2, 0.75]);
  const source = support.mesh.geometry, position = source.attributes.position, normal = source.attributes.normal;
  for (let i = 0; i < position.count; i++) {
    const values = affineUV(new THREE.Vector3().fromBufferAttribute(position, i), new THREE.Vector3().fromBufferAttribute(normal, i));
    source.attributes.uv.setXY(i, ...values);
  }
  resolveSurfaceOwnership([support, finish]);
  near(capArea(support.mesh), 21);
  const geometry = support.mesh.geometry, seen = new Map();
  let newBoundary = false;
  for (const triangle of triangles(support.mesh)) {
    assert.ok(triangle.area > 0, 'no degenerate replacement triangles');
    for (let slot = 0; slot < 3; slot++) {
      const i = triangle.ids[slot], p = new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, i);
      const n = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, i);
      near(n.length(), 1, 'normal stays normalized');
      assert.ok(triangle.normal.dot(triangle.normals[slot]) > 1 - EPS, 'stored normals agree with triangle winding');
      const expected = affineUV(p, n), actual = triangle.uv[slot].toArray();
      near(actual[0], expected[0], 'affine U'); near(actual[1], expected[1], 'affine V');
      const key = [...p.toArray(), ...n.toArray()].map(value => value.toFixed(6)).join(',');
      if (seen.has(key)) { near(actual[0], seen.get(key)[0], 'seam U'); near(actual[1], seen.get(key)[1], 'seam V'); }
      else seen.set(key, actual);
      if (n.y > 0.99 && (Math.abs(Math.abs(p.x) - 1) < EPS || Math.abs(Math.abs(p.z) - 0.75) < EPS)) newBoundary = true;
    }
  }
  assert.ok(newBoundary, 'the check includes newly introduced clipping vertices');
  const inverse = support.mesh.matrixWorld.clone().invert();
  for (const [x, z] of [[-2, 0.31], [2, 0.31], [0.23, -1.5], [0.23, 1.5], [-1.0001, 0.31], [1.0001, 0.31]]) {
    const hit = capHits(support.mesh, x, z)[0]; assert.ok(hit, 'exposed surface remains ray-visible');
    const expected = affineUV(hit.point.clone().applyMatrix4(inverse), new THREE.Vector3(0, 1, 0));
    near(hit.uv.x, expected[0], 'ray-interpolated U'); near(hit.uv.y, expected[1], 'ray-interpolated V');
  }
});

test('clipping preserves material/depth/shadow state, collision references, bounds and world children', () => {
  const support = box('wall', 'wall'), finish = floor('tile', [-1, 1.75, -1], [1, 2, 1]);
  const world = new THREE.Group(); world.add(support.mesh, finish.mesh);
  support.mesh.castShadow = true; support.mesh.receiveShadow = false; support.mesh.renderOrder = 7;
  const material = support.mesh.material;
  material.depthFunc = THREE.LessDepth; material.depthTest = true; material.depthWrite = true;
  material.polygonOffset = false; material.polygonOffsetFactor = 0; material.polygonOffsetUnits = 0;
  const materialState = { depthFunc: material.depthFunc, depthTest: material.depthTest, depthWrite: material.depthWrite,
    polygonOffset: material.polygonOffset, polygonOffsetFactor: material.polygonOffsetFactor, polygonOffsetUnits: material.polygonOffsetUnits,
    color: material.color.toArray(), side: material.side };
  const collider = support.collider, colliderMin = collider.min, colliderMax = collider.max, bounds = support.bounds;
  const before = geometryState(support.mesh.geometry), collisionCoordinates = [collider.min.toArray(), collider.max.toArray()];
  const transform = [support.mesh.position.toArray(), support.mesh.quaternion.toArray(), support.mesh.scale.toArray()];
  const children = [...world.children], supports = support.supports;
  resolveSurfaceOwnership([support, finish]);
  near(capArea(support.mesh), 12);
  assert.equal(support.mesh.material, material);
  for (const [key, value] of Object.entries(materialState)) assert.deepEqual(key === 'color' ? material.color.toArray() : material[key], value, key);
  assert.equal(support.mesh.castShadow, true); assert.equal(support.mesh.receiveShadow, false); assert.equal(support.mesh.renderOrder, 7);
  assert.equal(support.collider, collider); assert.equal(support.mesh.userData.collider, collider);
  assert.equal(collider.min, colliderMin); assert.equal(collider.max, colliderMax); assert.equal(collider.enabled, true);
  assert.deepEqual([collider.min.toArray(), collider.max.toArray()], collisionCoordinates);
  assert.equal(support.bounds, bounds); assert.equal(support.supports, supports);
  assert.deepEqual([bounds.min.toArray(), bounds.max.toArray()], collisionCoordinates);
  assert.deepEqual([support.mesh.position.toArray(), support.mesh.quaternion.toArray(), support.mesh.scale.toArray()], transform);
  assert.deepEqual(world.children, children);
  const after = geometryState(support.mesh.geometry);
  assert.deepEqual(after.box, before.box); assert.deepEqual(after.sphere, before.sphere);
  assert.equal(after.drawRange.start, 0);
  assert.ok(after.drawRange.count >= support.mesh.geometry.index.count, 'the complete replacement geometry remains drawable');
  const faceNormals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const drawn = triangles(support.mesh), groups = support.mesh.geometry.groups;
  assert.ok(groups.length > 0, 'standard BoxGeometry groups remain valid');
  assert.equal(groups.reduce((sum, group) => sum + group.count, 0), drawn.length * 3);
  for (const triangle of drawn) {
    const matching = groups.filter(group => triangle.offset >= group.start && triangle.offset < group.start + group.count);
    assert.equal(matching.length, 1, 'every triangle belongs to exactly one valid group');
    assert.ok(triangle.normal.dot(new THREE.Vector3(...faceNormals[matching[0].materialIndex])) > 1 - EPS);
  }
});

test('a finite full draw range expands with replacement indices and preserves both Z side faces', () => {
  const support = box('wall', 'wall'), finish = floor('tile', [-1, 1.75, -1], [1, 2, 1]);
  const source = support.mesh.geometry; source.setDrawRange(0, 36);
  const before = geometryState(source);
  const sideHit = sign => {
    support.mesh.updateWorldMatrix(true, false);
    const ray = new THREE.Raycaster(new THREE.Vector3(0.23, 1.13, sign * 10), new THREE.Vector3(0, 0, -sign), 0, 20);
    return ray.intersectObject(support.mesh, false).find(hit => Math.abs(hit.point.z - sign * 2) < EPS
      && hit.face.normal.z * sign > 1 - EPS);
  };
  for (const sign of [-1, 1]) assert.ok(sideHit(sign), `${sign}Z face is initially ray-visible`);
  resolveSurfaceOwnership([support, finish]);
  const geometry = support.mesh.geometry;
  assert.equal(geometry.index.count, 54, 'the central cut adds six triangles');
  assert.equal(geometry.drawRange.start, 0); assert.equal(geometry.drawRange.count, geometry.index.count);
  near(capArea(support.mesh), 12);
  for (const sign of [-1, 1]) {
    const hit = sideHit(sign);
    assert.ok(hit, `${sign}Z side must render after its indices move past the old draw limit of 36`);
    near(hit.point.x, 0.23); near(hit.point.y, 1.13); near(hit.point.z, sign * 2);
  }
  assert.deepEqual(geometryState(source), before, 'the pooled source keeps its original finite draw range');
});

test('multiple meshes sharing one source geometry are clipped independently without changing the source', () => {
  const source = new THREE.BoxGeometry(4, 2, 4);
  source.userData.poolKey = 'shared-wall-box'; source.userData.detail = { retained: true };
  const sourceMetadata = source.userData;
  const a = box('a-wall', 'wall', [-7, 0, -2], [-3, 2, 2], source);
  const b = box('b-wall', 'wall', [3, 0, -2], [7, 2, 2], source);
  const untouched = box('c-wall', 'wall', [18, 0, -2], [22, 2, 2], source);
  const coverA = floor('a-floor', [-7, 1.75, -2], [-3, 2, 2]);
  const coverB = floor('b-floor', [4, 1.75, -1], [6, 2, 1]);
  const before = geometryState(source);
  resolveSurfaceOwnership([a, b, untouched, coverA, coverB]);
  assert.notEqual(a.mesh.geometry, source); assert.notEqual(b.mesh.geometry, source);
  assert.notEqual(a.mesh.geometry, b.mesh.geometry); assert.equal(untouched.mesh.geometry, source);
  assert.equal(source.userData, sourceMetadata);
  assert.notEqual(a.mesh.geometry.userData, sourceMetadata); assert.notEqual(b.mesh.geometry.userData, sourceMetadata);
  near(capArea(a.mesh), 0); near(capArea(b.mesh), 12); near(capArea(untouched.mesh), 16);
  assert.deepEqual(geometryState(source), before, 'pooled geometry, including its indices and bounds, is immutable');
});

test('positive cardinal transforms are resolved in world space without changing object transforms', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.position.set(7, 1, -3); mesh.scale.set(2, 2, 4); mesh.rotation.y = Math.PI / 2;
  const support = fromMesh('wall', 'wall', mesh), finish = floor('tile', [6, 1.75, -3.5], [8, 2, -2.5]);
  const transform = [mesh.position.toArray(), mesh.quaternion.toArray(), mesh.scale.toArray()];
  near(capArea(mesh), 8);
  resolveSurfaceOwnership([support, finish]);
  near(capArea(mesh), 6);
  assert.deepEqual(ownersAt([support, finish], 7.21, -2.83), ['tile']);
  assert.deepEqual(ownersAt([support, finish], 8.51, -2.83), ['wall']);
  assert.deepEqual([mesh.position.toArray(), mesh.quaternion.toArray(), mesh.scale.toArray()], transform);
  for (const triangle of triangles(mesh)) for (const normal of triangle.normals) assert.ok(triangle.normal.dot(normal) > 1 - EPS);
});

test('repeated passes are idempotent and reordered record iterables produce identical visible coverage', () => {
  let expected = null;
  for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1]]) {
    const records = unionFixture(), ordered = order.map(index => records[index]);
    resolveSurfaceOwnership(new Map(ordered.map(record => [record.id, record])).values());
    const firstPass = meshGeometryStates(records);
    const coverage = [];
    for (let x = 0.25; x < 6; x += 0.5) for (let z = 0.25; z < 4; z += 0.5) coverage.push(ownersAt(records, x, z));
    const result = { areas: records.map(record => capArea(record.mesh)), coverage };
    if (expected) assert.deepEqual(result, expected); else expected = result;
    resolveSurfaceOwnership((function* () { yield* ordered; })());
    assertUnchanged(firstPass, 'another build-time pass must not allocate or cut again');
  }
});

test('unsafe, non-box and dynamic records are skipped as both owners and clipping targets', async context => {
  const cases = [
    ['invisible material', record => { record.mesh.material.visible = false; }],
    ['layer 2', record => { record.mesh.layers.set(2); }],
    ['NeverDepth material', record => { record.mesh.material.depthFunc = THREE.NeverDepth; }],
    ['ShaderMaterial', record => { record.mesh.material = new THREE.ShaderMaterial(); }],
    ['custom onBeforeCompile', record => { record.mesh.material.onBeforeCompile = () => {}; }],
    ['BackSide material', record => { record.mesh.material.side = THREE.BackSide; }],
    ['transparent', record => { record.mesh.material.transparent = true; }],
    ['opacity', record => { record.mesh.material.opacity = 0.5; }],
    ['alphaTest', record => { record.mesh.material.alphaTest = 0.25; }],
    ['alphaMap', record => { record.mesh.material.alphaMap = new THREE.Texture(); }],
    ['alphaHash', record => { record.mesh.material.alphaHash = true; }],
    ['transmission', record => { record.mesh.material = new THREE.MeshPhysicalMaterial({ transmission: 0.5 }); }],
    ['wireframe', record => { record.mesh.material.wireframe = true; }],
    ['colorWrite disabled', record => { record.mesh.material.colorWrite = false; }],
    ['clipping plane', record => { record.mesh.material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)]; }],
    ['displacement scale', record => {
      record.mesh.material.displacementMap = new THREE.Texture(); record.mesh.material.displacementScale = 0.1;
    }],
    ['displacement bias', record => {
      record.mesh.material.displacementMap = new THREE.Texture();
      record.mesh.material.displacementScale = 0; record.mesh.material.displacementBias = 0.05;
    }],
    ['material array', record => { record.mesh.material = [record.mesh.material]; }],
    ['group', record => { const group = new THREE.Group(); group.add(record.mesh); record.mesh = group; }],
    ['instanced', record => {
      const old = record.mesh, mesh = new THREE.InstancedMesh(old.geometry, old.material, 1);
      mesh.setMatrixAt(0, new THREE.Matrix4()); mesh.position.copy(old.position); record.mesh = mesh;
    }],
    ['non-box', record => { record.mesh.geometry = new THREE.SphereGeometry(2, 8, 6); }],
    ['deformed', record => {
      const positions = record.mesh.geometry.attributes.position;
      positions.setX(0, positions.getX(0) + 0.1); positions.needsUpdate = true;
    }],
    ['non-affine fourth UV corner', record => {
      const uv = record.mesh.geometry.attributes.uv;
      // The +Y face's first triangle uses 8,10,9; vertex 11 is its fourth corner.
      uv.setX(11, uv.getX(11) + 0.25); uv.needsUpdate = true;
    }],
    ['duplicated face triangle', record => {
      const before = capArea(record.mesh), index = record.mesh.geometry.index;
      for (const [offset, value] of [8, 10, 9, 8, 10, 9].entries()) index.setX(12 + offset, value);
      near(capArea(record.mesh), before, 'duplicate triangle fools a summed-area-only rectangle check');
    }],
    ['triangles sharing an outer edge', record => {
      const before = capArea(record.mesh), index = record.mesh.geometry.index;
      // Four corners and the correct total area still do not prove coverage:
      // sharing boundary edge 8-10 creates an overlap and a hole on the right.
      for (const [offset, value] of [8, 10, 9, 8, 10, 11].entries()) index.setX(12 + offset, value);
      near(capArea(record.mesh), before, 'boundary-edge overlap also has the expected summed area');
    }],
    ['non-cardinal rotation', record => { record.mesh.rotation.y = 0.23; }],
    ['shear', record => {
      record.mesh.updateMatrix(); record.mesh.matrix.elements[8] = 0.2;
      record.mesh.matrixAutoUpdate = false; record.mesh.matrixWorldNeedsUpdate = true;
    }],
    ['mirrored transform', record => { record.mesh.scale.x = -1; }],
    ['dynamic record', record => { record.dynamic = true; }],
    ['dynamic mesh', record => { record.mesh.userData.dynamic = true; }],
    ['gate mesh', record => { record.mesh.userData.gate = true; }],
    ['gate kind', record => { record.kind = 'gate'; }],
    ['door kind', record => { record.kind = 'door'; }],
  ];
  for (const [label, mutate] of cases) {
    for (const role of ['owner', 'target']) {
      await context.test(`${label} ${role}`, () => {
        const support = box('wall', 'wall'), finish = floor();
        const unsafe = role === 'owner' ? finish : support; mutate(unsafe);
        unsafe.mesh.updateWorldMatrix(true, true);
        unsafe.mesh.traverse(mesh => { if (mesh.geometry) { mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere(); } });
        unsafe.bounds.setFromObject(unsafe.mesh);
        const before = meshGeometryStates([support, finish]);
        resolveSurfaceOwnership([support, finish]);
        assertUnchanged(before, `${label} ${role} is not a safe opaque rectangular surface`);
      });
    }
  }
});
