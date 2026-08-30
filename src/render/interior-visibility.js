import * as THREE from 'three';
import { buildBoundsTree, rayBoundsDistance } from '../core/ballistic-bvh.js';

const EPSILON = 1e-7;
const SURFACE_EPSILON = 1e-5;

/**
 * A temporary, immutable world-space triangle BVH for offline room bakes.
 * Unlike gameplay ballistics it needs no collider policy, alpha readback,
 * material lookup, transformed ray, hit point or nearest-object allocation.
 * The caller supplies only static opaque meshes; all buffers are discarded
 * after the bake. Never use it for moving doors, actors or gameplay queries.
 */
export function createInteriorVisibility(meshes, roomBounds) {
  const vertices = [], bounds = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const matrix = new THREE.Matrix4(), instance = new THREE.Matrix4(), box = new THREE.Box3();
  let objects = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry, position = geometry?.attributes.position;
    if (!position || mesh.isSkinnedMesh) continue;
    mesh.updateWorldMatrix(true, false);
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const count = mesh.isInstancedMesh ? mesh.count : 1;
    const index = geometry.index, total = index?.count ?? position.count;
    const start = Math.max(0, geometry.drawRange.start), end = Math.min(total, start + geometry.drawRange.count);
    for (let n = 0; n < count; n++) {
      matrix.copy(mesh.matrixWorld);
      if (mesh.isInstancedMesh) { mesh.getMatrixAt(n, instance); matrix.multiply(instance); }
      if (Math.abs(matrix.determinant()) < 1e-12) continue;
      box.copy(geometry.boundingBox).applyMatrix4(matrix);
      if (!roomBounds.some(room => room.intersectsBox(box))) continue;
      objects++;
      for (let i = start; i + 2 < end; i += 3) {
        a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix);
        b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(matrix);
        c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(matrix);
        box.min.set(Math.min(a.x, b.x, c.x), Math.min(a.y, b.y, c.y), Math.min(a.z, b.z, c.z));
        box.max.set(Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y), Math.max(a.z, b.z, c.z));
        if (!roomBounds.some(room => room.intersectsBox(box))) continue;
        bounds.push(box.min.x - EPSILON, box.min.y - EPSILON, box.min.z - EPSILON,
          box.max.x + EPSILON, box.max.y + EPSILON, box.max.z + EPSILON);
        vertices.push(a.x, a.y, a.z, b.x - a.x, b.y - a.y, b.z - a.z, c.x - a.x, c.y - a.y, c.z - a.z);
      }
    }
  }
  let data = new Float64Array(vertices), tree = buildBoundsTree(new Float64Array(bounds), { leafSize: 6 });
  const statistics = { objects, triangles: data.length / 9, nodes: tree.nodes.length, geometryBytes: data.byteLength };

  function distance(origin, direction, maximum, anyHit = false) {
    if (!tree.nodes.length || !(maximum > 0)) return Infinity;
    const ox = origin.x, oy = origin.y, oz = origin.z, dx = direction.x, dy = direction.y, dz = direction.z;
    const { nodes, order, stack } = tree;
    let nearest = maximum, hit = false, size = 1; stack[0] = 0;
    while (size) {
      const node = nodes[stack[--size]];
      if (rayBoundsDistance(node, ox, oy, oz, dx, dy, dz, nearest) === Infinity) continue;
      if (!node.count) {
        const left = node.left, right = node.right;
        const ld = rayBoundsDistance(nodes[left], ox, oy, oz, dx, dy, dz, nearest);
        const rd = rayBoundsDistance(nodes[right], ox, oy, oz, dx, dy, dz, nearest);
        if (ld < rd) {
          if (rd !== Infinity) stack[size++] = right;
          if (ld !== Infinity) stack[size++] = left;
        } else {
          if (ld !== Infinity) stack[size++] = left;
          if (rd !== Infinity) stack[size++] = right;
        }
        continue;
      }
      for (let i = node.start, end = i + node.count; i < end; i++) {
        const offset = order[i] * 9;
        const ax = data[offset], ay = data[offset + 1], az = data[offset + 2];
        const e1x = data[offset + 3], e1y = data[offset + 4], e1z = data[offset + 5];
        const e2x = data[offset + 6], e2y = data[offset + 7], e2z = data[offset + 8];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const determinant = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(determinant) < 1e-12) continue;
        const inverse = 1 / determinant, tx = ox - ax, ty = oy - ay, tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * inverse;
        if (u < -EPSILON || u > 1 + EPSILON) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inverse;
        if (v < -EPSILON || u + v > 1 + EPSILON) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
        // Coordinates arriving from Float32 geometry can be a few microns
        // beyond a coplanar neighboring face. Match gameplay's surface
        // epsilon so those seams cannot shadow the surface against itself.
        if (t < SURFACE_EPSILON || t > nearest) continue;
        if (anyHit) return t;
        nearest = t; hit = true;
      }
    }
    return hit ? nearest : Infinity;
  }

  return {
    distance,
    occluded: (origin, direction, maximum) => distance(origin, direction, maximum, true) !== Infinity,
    snapshot: () => ({ ...statistics }),
    clear() { data = new Float64Array(); tree = buildBoundsTree([]); },
  };
}
