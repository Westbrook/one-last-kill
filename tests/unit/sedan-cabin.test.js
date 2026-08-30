import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSedanCabin } from '../../src/render/sedan-cabin.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';

const SIZES = [[4.4, 1.8], [4.6, 1.9]];
const EPSILON = 1e-6;
const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < EPSILON,
  `${label}: ${actual} != ${expected}`);
const parts = cabin => [cabin.glass, cabin.roof, ...cabin.pillars];
const triangles = geometry => (geometry.index?.count ?? geometry.attributes.position.count) / 3;
const pointKey = point => point.toArray().map(value => Math.round(value / EPSILON)).join(',');
const halfLengthAt = (length, y) => THREE.MathUtils.lerp(length * 0.275, length * 0.2145, (y - 0.85) / 0.6);
const halfWidthAt = (width, y) => THREE.MathUtils.lerp(width * 0.45, width * 0.369, (y - 0.85) / 0.6);

function vertices(geometry) {
  return Array.from({ length: geometry.attributes.position.count }, (_, i) =>
    new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, i));
}

function endCap(geometry, y) {
  const points = [...new Map(vertices(geometry)
    .filter(point => Math.abs(point.y - y) < EPSILON).map(point => [pointKey(point), point])).values()];
  assert.equal(points.length, 4, 'each pillar has a real four-corner bearing cap');
  return { points, bounds: new THREE.Box3().setFromPoints(points),
    center: points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length) };
}

function inspectClosedSurface(geometry) {
  assert.ok(geometry.isBufferGeometry);
  assert.deepEqual(Object.keys(geometry.attributes).sort(), ['normal', 'position', 'uv'],
    'car material buckets need matching vertex attributes');
  const { position, normal, uv } = geometry.attributes;
  assert.equal(position.itemSize, 3); assert.equal(normal.itemSize, 3); assert.equal(uv.itemSize, 2);
  assert.equal(normal.count, position.count); assert.equal(uv.count, position.count);
  for (const attribute of [position, normal, uv]) assert.ok(attribute.array.every(Number.isFinite));
  const points = vertices(geometry), center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3())
    .multiplyScalar(1 / points.length);
  const edges = new Map(), normalAt = new THREE.Vector3();
  for (let i = 0; i < normal.count; i++) near(normalAt.fromBufferAttribute(normal, i).length(), 1, 'unit normal');
  const count = geometry.index?.count ?? position.count;
  assert.equal(count % 3, 0);
  for (let i = 0; i < count; i += 3) {
    const ids = [0, 1, 2].map(offset => geometry.index ? geometry.index.getX(i + offset) : i + offset);
    assert.ok(ids.every(id => Number.isInteger(id) && id >= 0 && id < position.count));
    const [a, b, c] = ids.map(id => points[id]);
    const cross = b.clone().sub(a).cross(c.clone().sub(a));
    assert.ok(cross.lengthSq() > 1e-20, 'no collapsed or zero-area triangles');
    const outward = a.clone().add(b).add(c).multiplyScalar(1 / 3).sub(center);
    assert.ok(cross.dot(outward) > 0, 'triangle winding points out of the closed convex part');
    for (const id of ids) assert.ok(cross.dot(normalAt.fromBufferAttribute(normal, id)) > 0,
      'rendered normals agree with outward winding');
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      const from = pointKey(start), to = pointKey(end), key = [from, to].sort().join('|');
      const edge = edges.get(key) || { count: 0, direction: 0 };
      edge.count++; edge.direction += from < to ? 1 : -1; edges.set(key, edge);
    }
  }
  for (const edge of edges.values()) {
    assert.equal(edge.count, 2, 'every physical edge belongs to two faces; no cabin holes');
    assert.equal(edge.direction, 0, 'adjacent faces use opposite edge winding');
  }
}

test('both sedan sizes have closed outward geometry compatible with the existing material batches', () => {
  for (const [length, width] of SIZES) {
    const cabin = createSedanCabin(length, width);
    assert.equal(cabin.pillars.length, 6);
    for (const geometry of parts(cabin)) inspectClosedSurface(geometry);
    const temporary = parts(cabin).map(geometry => geometry.index ? geometry.toNonIndexed() : geometry.clone());
    const merged = mergeGeometries(temporary, false);
    assert.ok(merged, 'new parts remain compatible with consolidateCar');
    assert.equal(triangles(merged), parts(cabin).reduce((sum, geometry) => sum + triangles(geometry), 0));
    assert.ok(triangles(cabin.roof) <= 96, 'crowned roof remains within its authored budget');
    assert.ok(cabin.pillars.every(geometry => triangles(geometry) <= 12));
    assert.ok(triangles(merged) <= 180, 'complete cabin improves on the previous 384 triangles without spending its 128-triangle reserve');
    merged.dispose(); for (const geometry of temporary) geometry.dispose();
  }
});

test('glass and roof retain the authored cabin envelope in both production sizes', () => {
  for (const [length, width] of SIZES) {
    const cabin = createSedanCabin(length, width);
    const glass = new THREE.Box3().setFromPoints(vertices(cabin.glass));
    near(glass.min.x, -0.1 - 0.275 * length); near(glass.max.x, -0.1 + 0.275 * length);
    near(glass.min.y, 0.85); near(glass.max.y, 1.45);
    near(glass.min.z, -0.45 * width); near(glass.max.z, 0.45 * width);
    for (const point of vertices(cabin.glass)) {
      assert.ok(Math.abs(point.x + 0.1) <= halfLengthAt(length, point.y) + EPSILON);
      assert.ok(Math.abs(point.z) <= halfWidthAt(width, point.y) + EPSILON);
    }
    const glassTop = new THREE.Box3().setFromPoints(vertices(cabin.glass).filter(point => Math.abs(point.y - 1.45) < EPSILON));
    near(glassTop.min.x, -0.1 - 0.2145 * length); near(glassTop.max.x, -0.1 + 0.2145 * length);
    near(glassTop.min.z, -0.369 * width); near(glassTop.max.z, 0.369 * width);
    const roof = new THREE.Box3().setFromPoints(vertices(cabin.roof));
    near(roof.min.x, -0.1 - 0.215 * length); near(roof.max.x, -0.1 + 0.215 * length);
    near(roof.min.z, -0.385 * width); near(roof.max.z, 0.385 * width);
    near(roof.min.y, 1.45, 'roof meets greenhouse'); near(roof.max.y, 1.505, 'old maximum roof height');
  }
});

test('all six sloped pillars engage the glass throughout their height and bear beneath the roof', () => {
  const material = new THREE.MeshBasicMaterial();
  for (const [length, width] of SIZES) {
    const cabin = createSedanCabin(length, width), roof = new THREE.Mesh(cabin.roof, material);
    const bySide = new Map([[-1, []], [1, []]]);
    for (const geometry of cabin.pillars) {
      const lower = endCap(geometry, 0.85), upper = endCap(geometry, 1.45);
      const side = Math.sign(lower.center.z), mesh = new THREE.Mesh(geometry, material);
      assert.ok(bySide.has(side)); bySide.get(side).push({ lower, upper });
      for (const cap of [lower, upper]) {
        near(cap.bounds.max.x - cap.bounds.min.x, 0.06, 'pillar width');
        const sideDistances = cap.points.map(point => side * point.z);
        near(Math.min(...sideDistances), halfWidthAt(width, cap.center.y) - 0.020, 'frame engages inner glass');
        near(Math.max(...sideDistances), halfWidthAt(width, cap.center.y) + 0.012, 'restrained exterior frame');
        assert.ok(cap.points.every(point => Math.abs(point.x + 0.1) <= halfLengthAt(length, point.y) + EPSILON),
          'end pillars stay inside the windshield and rear-window planes');
      }
      assert.ok(Math.abs(upper.center.z - lower.center.z) > 0.1, 'pillars actually follow the transverse glass taper');
      for (const t of [0.01, 0.2, 0.5, 0.8, 0.99]) {
        const center = lower.center.clone().lerp(upper.center, t), glassSide = halfWidthAt(width, center.y);
        for (const [offset, direction, expected] of [[0.08, -side, 0.012], [-0.08, side, -0.020]]) {
          const origin = new THREE.Vector3(center.x, center.y, side * (glassSide + offset));
          const hit = new THREE.Raycaster(origin, new THREE.Vector3(0, 0, direction), 0, 0.2).intersectObject(mesh)[0];
          assert.ok(hit, 'both sides of the physical prism remain present along its full sloped length');
          near(side * hit.point.z, glassSide + expected, 'glass lies inside the frame cross-section');
        }
      }
      for (const point of upper.points) {
        const origin = point.clone(); origin.y -= 0.01;
        const hit = new THREE.Raycaster(origin, new THREE.Vector3(0, 1, 0), 0, 0.1).intersectObject(roof)[0];
        assert.ok(hit, 'roof covers every pillar-cap corner'); near(hit.point.y, 1.45, 'no floating frame or roof');
      }
    }
    for (const pillars of bySide.values()) {
      assert.equal(pillars.length, 3, 'front, middle and rear frame on each side');
      pillars.sort((a, b) => a.lower.center.x - b.lower.center.x);
      assert.ok(pillars[0].lower.center.x < -0.1 && pillars[2].lower.center.x > -0.1);
      near(pillars[1].lower.center.x + 0.1, 0.1 * 0.275 * length, 'middle pillar lower station');
      near(pillars[1].upper.center.x + 0.1, 0.1 * 0.2145 * length, 'middle pillar upper station');
    }
    for (const u of [-0.98, 0, 0.98]) for (const v of [-0.98, 0, 0.98]) {
      const origin = new THREE.Vector3(-0.1 + u * 0.2145 * length, 1.44, v * 0.369 * width);
      const hit = new THREE.Raycaster(origin, new THREE.Vector3(0, 1, 0), 0, 0.1).intersectObject(roof)[0];
      assert.ok(hit, 'roof closes the entire top of the glass'); near(hit.point.y, 1.45);
    }
  }
  material.dispose();
});

test('physical cabin rays preserve bullet cover, glass visibility and clear exterior air', () => {
  const glassMaterial = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.88, metalness: 0.45 });
  const opaqueMaterial = new THREE.MeshStandardMaterial();
  for (const [length, width] of SIZES) {
    const cabin = createSedanCabin(length, width), root = new THREE.Group();
    root.add(new THREE.Mesh(cabin.glass, glassMaterial), new THREE.Mesh(cabin.roof, opaqueMaterial));
    for (const geometry of cabin.pillars) root.add(new THREE.Mesh(geometry, opaqueMaterial));
    if (length === 4.6) { root.position.set(23, 0.05, 21.5); root.rotation.y = Math.PI; }
    root.updateMatrixWorld(true);
    const index = createBallisticWorld({ colliders: null }); index.rebuild(root);
    const segment = (a, b, channel) => index.segmentOccluded(new THREE.Vector3(...a).applyMatrix4(root.matrixWorld),
      new THREE.Vector3(...b).applyMatrix4(root.matrixWorld), channel);
    for (const y of [0.86, 1.05, 1.30, 1.44]) {
      for (const [a, b] of [
        [[-length, y, 0], [length, y, 0]],
        [[-0.1, y, -width], [-0.1, y, width]],
      ]) for (const [start, end] of [[a, b], [b, a]]) {
        assert.equal(segment(start, end, 'bullet'), true, 'closed glass blocks bullets from either side');
        assert.equal(segment(start, end, 'sight'), false, 'existing transparent glass does not become opaque sight cover');
      }
    }
    const opaqueSegments = [[[-0.1, 1.6, 0], [-0.1, 1.40, 0]]];
    for (const geometry of cabin.pillars) {
      const center = endCap(geometry, 0.85).center.lerp(endCap(geometry, 1.45).center, 0.5);
      opaqueSegments.push([[center.x, center.y, center.z - 0.1], [center.x, center.y, center.z + 0.1]]);
    }
    for (const [a, b] of opaqueSegments) for (const channel of ['bullet', 'sight']) {
      assert.equal(segment(a, b, channel), true, 'real opaque frame and roof block both channels');
      assert.equal(segment(b, a, channel), true, 'opaque cover works from the reverse side');
    }
    const outsideX = -0.1 + halfLengthAt(length, 1.30) + 0.015;
    const airSegments = [
      [[-length, 0.83, 0], [length, 0.83, 0]],
      [[-length, 1.52, 0], [length, 1.52, 0]],
      [[outsideX, 1.30, -width], [outsideX, 1.30, width]],
      [[-length, 1.10, width * 0.45 + 0.04], [length, 1.10, width * 0.45 + 0.04]],
    ];
    for (const [a, b] of airSegments) for (const channel of ['bullet', 'sight']) {
      assert.equal(segment(a, b, channel), false, 'air beyond the actual silhouette stays open');
      assert.equal(segment(b, a, channel), false);
    }
    index.clear();
  }
  glassMaterial.dispose(); opaqueMaterial.dispose();
});

test('the geometry helper allocates no materials, lights, textures or browser resources', () => {
  const source = readFileSync(new URL('../../src/render/sedan-cabin.js', import.meta.url), 'utf8');
  const three = { ...THREE };
  const forbidden = name => class { constructor() { throw new Error(`Unexpected resource allocation: ${name}`); } };
  for (const name of Object.keys(three)) if (/(Material|Light|Texture|Renderer)$/.test(name)) three[name] = forbidden(name);
  const noBrowser = new Proxy({}, { get(_, name) { throw new Error(`Unexpected browser access: ${String(name)}`); } });
  const createWithoutResources = runInNewContext(source.replace(/^import[^;]*;\s*/gm, '').replace(/\bexport\s+/g, '')
    + '\n;createSedanCabin;', { THREE: three, document: noBrowser, window: noBrowser,
    requestAnimationFrame() { throw new Error('Unexpected frame work'); } });
  for (const [length, width] of SIZES) {
    const cabin = createWithoutResources(length, width);
    assert.equal(cabin.pillars.length, 6);
    assert.ok(parts(cabin).every(geometry => geometry.isBufferGeometry));
  }
});
