import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSedanBumper, createSedanHood } from '../../src/render/sedan-panels.js';

const SIZES = [[4.4, 1.8], [4.6, 1.9]];
const EPSILON = 1e-6;
const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < EPSILON,
  `${label}: ${actual} != ${expected}`);
const triangleCount = geometry => (geometry.index?.count ?? geometry.attributes.position.count) / 3;
const key = point => point.toArray().map(value => Math.round(value / EPSILON)).join(',');
const vertices = geometry => Array.from({ length: geometry.attributes.position.count }, (_, i) =>
  new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, i));

function inspectSurface(geometry) {
  assert.ok(geometry.isBufferGeometry);
  assert.deepEqual(Object.keys(geometry.attributes).sort(), ['normal', 'position', 'uv']);
  const { position, normal, uv } = geometry.attributes;
  assert.equal(position.itemSize, 3); assert.equal(normal.itemSize, 3); assert.equal(uv.itemSize, 2);
  assert.equal(normal.count, position.count); assert.equal(uv.count, position.count);
  for (const attribute of [position, normal, uv]) assert.ok(attribute.array.every(Number.isFinite));
  const points = vertices(geometry), center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3())
    .multiplyScalar(1 / points.length);
  const edges = new Map(), n = new THREE.Vector3();
  for (let i = 0; i < normal.count; i++) near(n.fromBufferAttribute(normal, i).length(), 1, 'unit slope normal');
  const count = geometry.index?.count ?? position.count;
  assert.equal(count % 3, 0);
  for (let i = 0; i < count; i += 3) {
    const ids = [0, 1, 2].map(offset => geometry.index ? geometry.index.getX(i + offset) : i + offset);
    assert.ok(ids.every(id => Number.isInteger(id) && id >= 0 && id < position.count));
    const [a, b, c] = ids.map(id => points[id]);
    const cross = b.clone().sub(a).cross(c.clone().sub(a));
    assert.ok(cross.lengthSq() > 1e-20, 'every panel triangle has visible area');
    assert.ok(cross.dot(a.clone().add(b).add(c).multiplyScalar(1 / 3).sub(center)) > 0,
      'closed panel faces point away from their interior');
    for (const id of ids) assert.ok(cross.dot(n.fromBufferAttribute(normal, id)) > 0,
      'rendered slope normals agree with outward triangle winding');
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      const from = key(start), to = key(end), edgeKey = [from, to].sort().join('|');
      const edge = edges.get(edgeKey) || { count: 0, direction: 0 };
      edge.count++; edge.direction += from < to ? 1 : -1; edges.set(edgeKey, edge);
    }
  }
  for (const edge of edges.values()) {
    assert.equal(edge.count, 2, 'each physical edge has two faces, including both end caps');
    assert.equal(edge.direction, 0, 'neighboring faces traverse shared edges in opposite directions');
  }
}

function expectBounds(geometry, width, height, depth) {
  const bounds = new THREE.Box3().setFromPoints(vertices(geometry));
  for (const [axis, size] of [['x', width], ['y', height], ['z', depth]]) {
    near(bounds.min[axis], -size / 2, `${axis} minimum`);
    near(bounds.max[axis], size / 2, `${axis} maximum`);
  }
}

const cast = (mesh, origin, direction, far = 10) =>
  new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction), 0, far).intersectObject(mesh)[0];

test('both production sizes retain closed outward panel geometry and the previous bounding envelopes', () => {
  for (const [length, width] of SIZES) {
    const bumper = createSedanBumper(width), hood = createSedanHood(length, width);
    inspectSurface(bumper); inspectSurface(hood);
    expectBounds(bumper, 0.20, 0.18, width);
    expectBounds(hood, 0.95 * length, 0.10, 0.95 * width);
    const temporary = [bumper, bumper, hood].map(geometry => geometry.index ? geometry.toNonIndexed() : geometry.clone());
    const merged = mergeGeometries(temporary, false);
    assert.ok(merged, 'panel attributes still match the existing car material merger');
    assert.equal(triangleCount(merged), 2 * triangleCount(bumper) + triangleCount(hood));
    assert.ok(triangleCount(bumper) <= 64, 'each beveled bumper stays within its budget');
    assert.ok(triangleCount(hood) <= 112, 'shaping the exposed ends does not overspend the hood');
    assert.ok(triangleCount(merged) <= 324 + 128, 'complete replacement remains within the original geometry and allowed reserve');
    merged.dispose(); for (const geometry of temporary) geometry.dispose();
    bumper.dispose(); hood.dispose();
  }
});

test('bumper corners and end sections visibly retreat inside the unchanged envelope', () => {
  const material = new THREE.MeshBasicMaterial();
  for (const [, width] of SIZES) {
    const geometry = createSedanBumper(width), mesh = new THREE.Mesh(geometry, material);
    for (const [axis, halfSize] of [[0, 0.10], [1, 0.09], [2, width / 2]]) for (const sign of [-1, 1]) {
      const origin = [0, 0, 0], direction = [0, 0, 0];
      origin[axis] = sign * (halfSize + 1); direction[axis] = -sign;
      const hit = cast(mesh, origin, direction);
      assert.ok(hit, 'the closed bumper retains every center face');
      near(hit.point.getComponent(axis), sign * halfSize);
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      assert.equal(cast(mesh, [sx * 0.0999, sy * 0.0899, -width], [0, 0, 1]), undefined,
        'the old rectangular XY corners have real bevel clearance');
    }
    for (const side of [-1, 1]) {
      const z = side * width * 0.495;
      const front = cast(mesh, [0.5, 0, z], [-1, 0, 0]);
      const top = cast(mesh, [0, 0.5, z], [0, -1, 0]);
      assert.ok(front && top, 'tucked ends remain closed and physically present');
      assert.ok(front.point.x > 0 && front.point.x < 0.10 - 1e-4, 'end section rolls inward in X');
      assert.ok(top.point.y > 0 && top.point.y < 0.09 - 1e-4, 'end section rolls inward in Y');
    }
    geometry.dispose();
  }
  material.dispose();
});

test('the hood still supports the full cabin belt, waistline strips and hood ornament', () => {
  const material = new THREE.MeshBasicMaterial();
  for (const [length, width] of SIZES) {
    const geometry = createSedanHood(length, width), mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.82; mesh.updateMatrixWorld(true);
    const topAt = (x, z) => {
      const hit = cast(mesh, [x, 1, z], [0, -1, 0], 0.3);
      assert.ok(hit, `hood exists under support point (${x}, ${z})`);
      return hit.point.y;
    };
    const support = (x, z, bottom, label) => {
      const top = topAt(x, z);
      assert.ok(top >= bottom - EPSILON, `${label} cannot float: hood ${top}, bearing bottom ${bottom}`);
      assert.ok(top <= 0.87 + EPSILON, 'support shaping cannot raise the old hood envelope');
      return top;
    };
    for (const u of [-1, -0.75, -0.5, 0, 0.5, 0.75, 1]) for (const v of [-1, -0.5, 0, 0.5, 1]) {
      const x = -0.1 + u * length * 0.275, z = v * width * 0.45;
      near(support(x, z, 0.85, 'cabin belt'), 0.87, 'top stays flat across the cabin footprint');
    }
    for (const side of [-1, 1]) for (const u of [-1, -0.5, 0, 0.5, 1]) for (const offset of [-0.0125, 0, 0.0125]) {
      support(-0.1 + u * length * 0.275, side * width * 0.46 + offset, 0.865, 'window waistline');
    }
    for (const dx of [-0.09, 0, 0.09]) for (const z of [-0.11, 0, 0.11]) {
      support(length * 0.38 + dx, z, 0.86, 'chrome ornament');
    }
    const underside = cast(mesh, [0, 0.6, 0], [0, 1, 0], 0.3);
    assert.ok(underside); near(underside.point.y, 0.77, 'hood still overlaps the existing body top at y=.8');
    geometry.dispose();
  }
  material.dispose();
});

test('only the exposed hood ends roll down while the outer air remains clear', () => {
  const material = new THREE.MeshBasicMaterial();
  for (const [length, width] of SIZES) {
    const geometry = createSedanHood(length, width), mesh = new THREE.Mesh(geometry, material);
    for (const side of [-1, 1]) {
      const hit = cast(mesh, [side * (length * 0.475 - 0.003), 0.2, 0], [0, -1, 0], 0.3);
      assert.ok(hit, 'front and rear ends remain closed');
      assert.ok(hit.point.y < 0.05 - 1e-4 && hit.point.y > -0.05, 'exposed end has a real lowered profile');
      assert.equal(cast(mesh, [side * (length * 0.475 + 0.001), 0.2, 0], [0, -1, 0]), undefined,
        'new end geometry does not extend past the old length');
      assert.equal(cast(mesh, [0, 0.2, side * (width * 0.475 + 0.001)], [0, -1, 0]), undefined,
        'new panel geometry does not extend past the old width');
    }
    geometry.dispose();
  }
  material.dispose();
});

test('panel calls own independent disposable buffers without material, light or browser allocation', () => {
  const source = readFileSync(new URL('../../src/render/sedan-panels.js', import.meta.url), 'utf8');
  const three = { ...THREE };
  const forbidden = name => class { constructor() { throw new Error(`Unexpected resource allocation: ${name}`); } };
  for (const [name, value] of Object.entries(three)) {
    if (/(Material|Light|Texture|Renderer|RenderTarget)$/.test(name) || value?.prototype instanceof THREE.Object3D) {
      three[name] = forbidden(name);
    }
  }
  const noBrowser = new Proxy({}, { get(_, name) { throw new Error(`Unexpected browser access: ${String(name)}`); } });
  const factories = runInNewContext(source.replace(/^import[^;]*;\s*/gm, '').replace(/\bexport\s+/g, '')
    + '\n;({ createSedanBumper, createSedanHood });', { THREE: three, document: noBrowser, window: noBrowser,
    requestAnimationFrame() { throw new Error('Unexpected frame work'); } });
  for (const [length, width] of SIZES) for (const factory of [() => factories.createSedanBumper(width), () => factories.createSedanHood(length, width)]) {
    const first = factory(), second = factory();
    assert.ok(first.isBufferGeometry && second.isBufferGeometry);
    assert.notEqual(first, second, 'consolidateCar can dispose each source geometry independently');
    for (const name of ['position', 'normal', 'uv']) {
      assert.notEqual(first.attributes[name].array.buffer, second.attributes[name].array.buffer,
        'no retained cache can be changed or disposed by a different car');
    }
    assert.deepEqual(first.attributes.position.array, second.attributes.position.array, 'repeated calls are deterministic');
    first.dispose(); second.dispose();
  }
});
