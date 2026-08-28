/**
 * Build a static bounds hierarchy without changing the flat input bounds.
 * The root is node 0. Leaves have count > 0 and left/right === -1; their
 * original item indices occupy order[start .. start + count). Internal nodes
 * have count === 0. The caller owns the scratch stack used during traversal.
 */
export function buildBoundsTree(bounds, { leafSize = 8 } = {}) {
  if (!Array.isArray(bounds) && !(bounds instanceof Float64Array)) {
    throw new TypeError('Bounds must be an Array or Float64Array of six values per item.');
  }
  if (bounds.length % 6 !== 0) {
    throw new RangeError('Bounds must contain six values per item: minX, minY, minZ, maxX, maxY, maxZ.');
  }
  if (!Number.isSafeInteger(leafSize) || leafSize < 1) {
    throw new RangeError('leafSize must be a positive safe integer.');
  }

  const count = bounds.length / 6;
  if (count > 0xffffffff) throw new RangeError('Bounds contain too many items for Uint32 indices.');
  const order = new Uint32Array(count);
  const centers = new Float64Array(count * 3);
  for (let item = 0; item < count; item++) {
    order[item] = item;
    for (let axis = 0; axis < 3; axis++) {
      const min = bounds[item * 6 + axis], max = bounds[item * 6 + axis + 3];
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        throw new RangeError(`Bounds item ${item}, axis ${axis} must have finite numeric limits.`);
      }
      if (min > max) {
        throw new RangeError(`Bounds item ${item}, axis ${axis} has a minimum greater than its maximum.`);
      }
      const span = max - min;
      // Use a half-sum only when subtraction overflows; otherwise preserve
      // tiny coordinates that would underflow if both limits were halved.
      centers[item * 3 + axis] = Number.isFinite(span) ? min + span * 0.5 : min * 0.5 + max * 0.5;
    }
  }

  const nodes = [];
  let maxDepth = 0;
  function buildNode(start, end, depth) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let centerMinX = Infinity, centerMinY = Infinity, centerMinZ = Infinity;
    let centerMaxX = -Infinity, centerMaxY = -Infinity, centerMaxZ = -Infinity;
    for (let offset = start; offset < end; offset++) {
      const item = order[offset], base = item * 6, center = item * 3;
      minX = Math.min(minX, bounds[base]); maxX = Math.max(maxX, bounds[base + 3]);
      minY = Math.min(minY, bounds[base + 1]); maxY = Math.max(maxY, bounds[base + 4]);
      minZ = Math.min(minZ, bounds[base + 2]); maxZ = Math.max(maxZ, bounds[base + 5]);
      centerMinX = Math.min(centerMinX, centers[center]); centerMaxX = Math.max(centerMaxX, centers[center]);
      centerMinY = Math.min(centerMinY, centers[center + 1]); centerMaxY = Math.max(centerMaxY, centers[center + 1]);
      centerMinZ = Math.min(centerMinZ, centers[center + 2]); centerMaxZ = Math.max(centerMaxZ, centers[center + 2]);
    }
    const index = nodes.length;
    const node = { minX, minY, minZ, maxX, maxY, maxZ, left: -1, right: -1, start, count: end - start };
    nodes.push(node);
    maxDepth = Math.max(maxDepth, depth);
    if (node.count > leafSize) {
      let spanX = centerMaxX - centerMinX;
      let spanY = centerMaxY - centerMinY;
      let spanZ = centerMaxZ - centerMinZ;
      if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || !Number.isFinite(spanZ)) {
        // Scale all spans equally so extreme coordinates still select the
        // longest centroid axis instead of treating every overflow as a tie.
        spanX = centerMaxX * 0.5 - centerMinX * 0.5;
        spanY = centerMaxY * 0.5 - centerMinY * 0.5;
        spanZ = centerMaxZ * 0.5 - centerMinZ * 0.5;
      }
      let axis = spanY > spanX ? 1 : 0;
      if (spanZ > (axis === 0 ? spanX : spanY)) axis = 2;
      order.subarray(start, end).sort((a, b) => centers[a * 3 + axis] - centers[b * 3 + axis] || a - b);
      const middle = start + Math.floor((end - start) / 2);
      node.count = 0;
      node.left = buildNode(start, middle, depth + 1);
      node.right = buildNode(middle, end, depth + 1);
    }
    return index;
  }
  if (count) buildNode(0, count, 0);
  return { nodes, order, stack: new Int32Array(maxDepth + 2), maxDepth };
}

function boundaryParameter(bound, origin, direction) {
  const offset = bound - origin;
  // Opposite, very large coordinates can overflow before division even when
  // the resulting ray parameter is finite. Divide first only in that case.
  return Number.isFinite(offset) ? offset / direction : bound / direction - origin / direction;
}

/**
 * Return the first nonnegative t in origin + direction * t, or Infinity.
 * Direction need not be normalized; maxDistance is in the same t units.
 * Bounds are inclusive, so an origin on or inside them returns 0. This query
 * allocates nothing and changes neither the node nor any traversal state.
 */
export function rayBoundsDistance(node, ox, oy, oz, dx, dy, dz, maxDistance = Infinity) {
  if (!(maxDistance >= 0) || !Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)
    || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return Infinity;

  let near = 0, far = maxDistance;
  if (dx === 0) {
    if (ox < node.minX || ox > node.maxX) return Infinity;
  } else {
    let a = boundaryParameter(node.minX, ox, dx), b = boundaryParameter(node.maxX, ox, dx);
    if (a > b) { const swap = a; a = b; b = swap; }
    if (a > near) near = a;
    if (b < far) far = b;
    if (near > far) return Infinity;
  }
  if (dy === 0) {
    if (oy < node.minY || oy > node.maxY) return Infinity;
  } else {
    let a = boundaryParameter(node.minY, oy, dy), b = boundaryParameter(node.maxY, oy, dy);
    if (a > b) { const swap = a; a = b; b = swap; }
    if (a > near) near = a;
    if (b < far) far = b;
    if (near > far) return Infinity;
  }
  if (dz === 0) {
    if (oz < node.minZ || oz > node.maxZ) return Infinity;
  } else {
    let a = boundaryParameter(node.minZ, oz, dz), b = boundaryParameter(node.maxZ, oz, dz);
    if (a > b) { const swap = a; a = b; b = swap; }
    if (a > near) near = a;
    if (b < far) far = b;
    if (near > far) return Infinity;
  }
  return near;
}
