import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoundsTree, rayBoundsDistance } from '../../src/core/ballistic-bvh.js';

const nodeFor = (bounds) => buildBoundsTree(bounds).nodes[0];
const cube = Object.freeze(nodeFor([-1, -1, -1, 1, 1, 1]));
const near = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

function verifyTree(tree, bounds, leafSize) {
  const { nodes, order } = tree;
  const seen = new Set();
  let deepest = 0;
  function inspect(index, depth) {
    deepest = Math.max(deepest, depth);
    const node = nodes[index];
    assert.ok(node);
    const range = [node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ];
    assert.ok(range.every(Number.isFinite));
    if (node.count) {
      assert.equal(node.left, -1);
      assert.equal(node.right, -1);
      assert.ok(node.count >= 1 && node.count <= leafSize);
      for (let offset = node.start; offset < node.start + node.count; offset++) {
        const item = order[offset];
        assert.equal(seen.has(item), false, `duplicate item ${item}`);
        seen.add(item);
        for (let axis = 0; axis < 3; axis++) {
          assert.ok(range[axis] <= bounds[item * 6 + axis]);
          assert.ok(range[axis + 3] >= bounds[item * 6 + axis + 3]);
        }
      }
      return node.count;
    }
    const left = nodes[node.left], right = nodes[node.right];
    assert.ok(node.left > index && node.right > index);
    assert.equal(left.start, node.start);
    for (const key of ['minX', 'minY', 'minZ']) assert.equal(node[key], Math.min(left[key], right[key]));
    for (const key of ['maxX', 'maxY', 'maxZ']) assert.equal(node[key], Math.max(left[key], right[key]));
    const leftCount = inspect(node.left, depth + 1), rightCount = inspect(node.right, depth + 1);
    assert.equal(right.start, left.start + leftCount);
    assert.ok(Math.abs(leftCount - rightCount) <= 1, 'median split stays balanced');
    return leftCount + rightCount;
  }
  assert.equal(inspect(0, 0), bounds.length / 6);
  assert.equal(seen.size, order.length);
  assert.equal(deepest, tree.maxDepth);
  assert.ok(tree.stack instanceof Int32Array);
  assert.equal(tree.stack.length, tree.maxDepth + 2);
}

test('empty trees have an empty order and a reusable two-slot stack', () => {
  for (const bounds of [[], new Float64Array()]) {
    const tree = buildBoundsTree(bounds);
    assert.deepEqual(tree.nodes, []);
    assert.deepEqual(tree.order, new Uint32Array());
    assert.deepEqual(tree.stack, new Int32Array(2));
    assert.equal(tree.maxDepth, 0);
  }
});

test('one item is a root leaf and the input bounds remain independent', () => {
  const bounds = new Float64Array([-4, -3, -2, 1, 2, 3]);
  const original = bounds.slice(), tree = buildBoundsTree(bounds);
  assert.deepEqual(bounds, original);
  assert.deepEqual(tree.nodes, [{ minX: -4, minY: -3, minZ: -2, maxX: 1, maxY: 2, maxZ: 3, left: -1, right: -1, start: 0, count: 1 }]);
  assert.deepEqual(tree.order, new Uint32Array([0]));
  assert.equal(tree.maxDepth, 0);
  bounds.fill(0);
  assert.equal(tree.nodes[0].minX, -4);
  assert.equal(tree.nodes[0].maxZ, 3);
});

test('median splits follow the longest centroid axis, not the widest individual box', () => {
  for (let axis = 0; axis < 3; axis++) {
    const bounds = [];
    for (const center of [40, -10, 20, 0]) {
      const min = [-1000, -1000, -1000], max = [1000, 1000, 1000];
      min[axis] = center - 0.5; max[axis] = center + 0.5;
      bounds.push(...min, ...max);
    }
    const original = bounds.slice(), tree = buildBoundsTree(bounds, { leafSize: 2 });
    assert.deepEqual([...tree.order], [1, 3, 2, 0]);
    assert.equal(tree.nodes[0].count, 0);
    assert.equal(tree.nodes.length, 3);
    assert.deepEqual(bounds, original);
    verifyTree(tree, bounds, 2);
  }
});

test('equal centroids and planar bounds produce deterministic nonempty leaves', () => {
  const bounds = [];
  for (let index = 0; index < 101; index++) {
    const extent = 1 + index % 11;
    bounds.push(-extent, 0, -extent, extent, 0, extent);
  }
  const first = buildBoundsTree(bounds, { leafSize: 3 });
  const second = buildBoundsTree(bounds, { leafSize: 3 });
  assert.deepEqual([...first.order], Array.from({ length: 101 }, (_, index) => index));
  assert.deepEqual(first, second);
  verifyTree(first, bounds, 3);
});

test('finite extreme coordinates never create infinite tree bounds or an unbalanced split', () => {
  const huge = Number.MAX_VALUE;
  const bounds = [
    huge * 0.5, 0, 0, huge, 0, 0,
    -huge, 0, 0, -huge * 0.5, 0, 0,
    -huge, -huge, -huge, huge, huge, huge,
    0, 0, 0, 0, 0, 0,
  ];
  const tree = buildBoundsTree(bounds, { leafSize: 1 });
  assert.deepEqual([...tree.order], [1, 2, 3, 0]);
  verifyTree(tree, bounds, 1);
});

test('centroid ordering retains very small finite coordinates', () => {
  const small = Number.MIN_VALUE, bounds = [0, small, 0, 0, small, 0, 0, 0, 0, 0, 0, 0];
  const tree = buildBoundsTree(bounds, { leafSize: 1 });
  assert.deepEqual([...tree.order], [1, 0]);
  verifyTree(tree, bounds, 1);
});

test('10,000 items stay balanced with bounded traversal scratch space', () => {
  for (const identical of [false, true]) {
    const bounds = new Float64Array(10_000 * 6);
    for (let item = 0; item < 10_000; item++) {
      const x = identical ? 0 : (item * 37) % 103;
      const y = identical ? 0 : (item * 19) % 97;
      const z = identical ? 0 : (item * 53) % 109;
      bounds.set([x, y, z, x + 0.5, y, z + 0.25], item * 6);
    }
    const original = bounds.slice(), tree = buildBoundsTree(bounds);
    assert.deepEqual(bounds, original);
    verifyTree(tree, bounds, 8);
    assert.equal(tree.maxDepth, Math.ceil(Math.log2(10_000 / 8)));
    let size = 1, visited = 0;
    tree.stack[0] = 0;
    while (size) {
      const node = tree.nodes[tree.stack[--size]];
      visited++;
      if (!node.count) {
        assert.ok(size + 2 <= tree.stack.length);
        tree.stack[size++] = node.left;
        tree.stack[size++] = node.right;
      }
    }
    assert.equal(visited, tree.nodes.length);
  }
});

test('invalid flat bounds and leaf sizes fail with descriptive errors', () => {
  for (const value of [null, undefined, {}, '0,0,0,1,1,1']) {
    assert.throws(() => buildBoundsTree(value), /Bounds must be an Array or Float64Array/);
  }
  assert.throws(() => buildBoundsTree([0, 1]), /six values per item/);
  for (const value of [NaN, Infinity, -Infinity, undefined, '0']) {
    assert.throws(() => buildBoundsTree([value, 0, 0, 1, 1, 1]), /item 0, axis 0.*finite numeric/);
  }
  for (let axis = 0; axis < 3; axis++) {
    const bounds = [0, 0, 0, 1, 1, 1];
    bounds[axis] = 2;
    assert.throws(() => buildBoundsTree(bounds), /minimum greater than its maximum/);
  }
  for (const leafSize of [0, -1, 0.5, Infinity, NaN, '8', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildBoundsTree([], { leafSize }), /leafSize must be a positive safe integer/);
  }
});

test('rays return the near hit and honor the inclusive far limit', () => {
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const origin = [0, 0, 0], direction = [0, 0, 0];
    origin[axis] = sign * 4; direction[axis] = -sign;
    assert.equal(rayBoundsDistance(cube, ...origin, ...direction, 10), 3);
    assert.equal(rayBoundsDistance(cube, ...origin, ...direction, 3), 3);
    assert.equal(rayBoundsDistance(cube, ...origin, ...direction, 2.99), Infinity);
    direction[axis] = sign;
    assert.equal(rayBoundsDistance(cube, ...origin, ...direction, Infinity), Infinity);
  }
});

test('unnormalized directions preserve t instead of converting to world distance', () => {
  assert.equal(rayBoundsDistance(cube, -4, 0, 0, 2, 0, 0, 1.5), 1.5);
  assert.equal(rayBoundsDistance(cube, -4, 0, 0, 2, 0, 0, 1.49), Infinity);
  assert.equal(rayBoundsDistance(cube, -4, 0, 0, 0.5, 0, 0, 6), 6);
  assert.equal(rayBoundsDistance(cube, 4, 4, 4, -2, -2, -2, 2), 1.5);
  near(rayBoundsDistance(cube, -4, 0, 0, 7, 0, 0, Infinity), 3 / 7);
});

test('origins inside or on a box return zero, including stationary rays', () => {
  assert.equal(rayBoundsDistance(cube, 0, 0, 0, 1, 2, 3, 0), 0);
  assert.equal(rayBoundsDistance(cube, 0, 0, 0, 0, 0, 0, Infinity), 0);
  assert.equal(rayBoundsDistance(cube, 1, -1, 1, 1, -1, 1, 0), 0);
  assert.equal(rayBoundsDistance(cube, 1, -1, 1, -0, 0, -0, 0), 0);
  assert.equal(rayBoundsDistance(cube, 2, 0, 0, 0, 0, 0, Infinity), Infinity);
});

test('parallel rays accept face contact and reject even a small gap on every axis', () => {
  for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
    const traveling = (axis + 1) % 3;
    const origin = [0, 0, 0], direction = [-0, -0, -0];
    origin[axis] = side; origin[traveling] = -4; direction[traveling] = 1;
    assert.equal(rayBoundsDistance(cube, ...origin, ...direction, 10), 3);
    origin[axis] += side * 1e-10;
    assert.equal(rayBoundsDistance(cube, ...origin, ...direction, 10), Infinity);
  }
});

test('overlapping axis projections must still intersect at the same t', () => {
  const node = nodeFor([1, 1, 1, 2, 2, 2]);
  assert.equal(rayBoundsDistance(node, 0, 0, 0, 1, 3, 1, Infinity), Infinity);
  assert.equal(rayBoundsDistance(node, 0, 0, 0, 1, 1, 3, Infinity), Infinity);
  assert.equal(rayBoundsDistance(node, 0, 0, 0, 3, 1, 1, Infinity), Infinity);
  assert.equal(rayBoundsDistance(node, 0, 0, 0, 1, 2, 1, Infinity), 1);
});

test('planar, line and point bounds are hittable without inflating their thickness', () => {
  const plane = nodeFor([-1, 0, -1, 1, 0, 1]);
  assert.equal(rayBoundsDistance(plane, 0, -2, 0, 0, 2, 0, 1), 1);
  assert.equal(rayBoundsDistance(plane, -2, 0, 0, 1, 0, 0, 1), 1);
  assert.equal(rayBoundsDistance(plane, -2, 1e-12, 0, 1, 0, 0, Infinity), Infinity);
  const line = nodeFor([0, 0, -1, 0, 0, 1]);
  assert.equal(rayBoundsDistance(line, -2, -2, 0, 2, 2, 0, 1), 1);
  const point = nodeFor([0, 0, 0, 0, 0, 0]);
  assert.equal(rayBoundsDistance(point, -2, -2, -2, 2, 2, 2, 1), 1);
  assert.equal(rayBoundsDistance(point, -2, -2, -2, 2, 2, 3, Infinity), Infinity);
});

test('very small nonzero directions are not treated as parallel', () => {
  const point = nodeFor([1, 0, 0, 1, 0, 0]);
  assert.equal(rayBoundsDistance(point, 0, 0, 0, 1e-300, 0, 0, Infinity), 1 / 1e-300);
  assert.equal(rayBoundsDistance(point, 1, 0, 0, Number.MIN_VALUE, 0, 0, Infinity), 0);
});

test('finite ray parameters survive subtraction overflow at extreme coordinates', () => {
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const point = [0, 0, 0], origin = [0, 0, 0], direction = [0, 0, 0];
    point[axis] = sign * Number.MAX_VALUE;
    origin[axis] = -point[axis]; direction[axis] = point[axis];
    const node = nodeFor([...point, ...point]);
    assert.equal(rayBoundsDistance(node, ...origin, ...direction, 2), 2);
    assert.equal(rayBoundsDistance(node, ...origin, ...direction, 1.99), Infinity);
  }
});

test('invalid rays and negative limits cannot produce false hits', () => {
  for (const value of [NaN, Infinity, -Infinity]) for (let component = 0; component < 6; component++) {
    const ray = [0, 0, 0, 1, 0, 0];
    ray[component] = value;
    assert.equal(rayBoundsDistance(cube, ...ray, Infinity), Infinity);
  }
  for (const limit of [-1, -Infinity, NaN]) assert.equal(rayBoundsDistance(cube, 0, 0, 0, 1, 0, 0, limit), Infinity);
});

test('external stack traversal agrees with a flat scan and leaves the tree unchanged', () => {
  const bounds = [];
  for (let item = 0; item < 257; item++) {
    const x = item % 13, y = Math.floor(item / 13) % 7, z = Math.floor(item / 91);
    bounds.push(x, y, z, x + 0.75, y + (item % 2 ? 0.5 : 0), z + 0.25);
  }
  const tree = buildBoundsTree(bounds, { leafSize: 4 });
  const savedNodes = tree.nodes.map((node) => ({ ...node })), savedOrder = tree.order.slice();
  const items = Array.from({ length: 257 }, (_, item) => nodeFor(bounds.slice(item * 6, item * 6 + 6)));
  for (let query = 0; query < 80; query++) {
    const origin = [query % 15 - 1, query % 9 - 1, query % 5 - 1];
    const direction = [query % 3 - 1, (query * 3) % 5 - 2, (query * 7) % 3 - 1];
    const expected = items.flatMap((item, index) => rayBoundsDistance(item, ...origin, ...direction, 20) < Infinity ? [index] : []);
    const actual = [];
    let size = 1;
    tree.stack[0] = 0;
    while (size) {
      const node = tree.nodes[tree.stack[--size]];
      if (rayBoundsDistance(node, ...origin, ...direction, 20) === Infinity) continue;
      if (node.count) {
        for (let offset = node.start; offset < node.start + node.count; offset++) {
          const item = tree.order[offset];
          if (rayBoundsDistance(items[item], ...origin, ...direction, 20) < Infinity) actual.push(item);
        }
      } else {
        tree.stack[size++] = node.left;
        tree.stack[size++] = node.right;
      }
    }
    actual.sort((a, b) => a - b);
    assert.deepEqual(actual, expected);
  }
  assert.deepEqual(tree.nodes, savedNodes);
  assert.deepEqual(tree.order, savedOrder);
});
