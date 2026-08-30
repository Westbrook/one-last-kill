import * as THREE from 'three';

// Profile buffers are Float32. Snap intended shared planes within their input
// precision, rather than creating nanometre slivers which collapse on output.
const EPSILON = 1e-8;
const CROWN_BANDS = [-0.8, -0.45, 0, 0.45, 0.8];

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON
    && Math.abs(a[2] - b[2]) < EPSILON;
}

function cleanBoundary(vertices) {
  const result = vertices.filter((vertex, i) => !samePoint(vertex, vertices[(i + vertices.length - 1) % vertices.length]));
  return result.length >= 3 ? result : [];
}

// Every cut continues across the closing faces too. Restricting Z cuts to the
// crown would leave unmatched vertices along its seam with the lower shell.
function splitPolygon(polygon, axis, plane) {
  polygon = polygon.map(vertex => {
    if (Math.abs(vertex[axis] - plane) >= EPSILON) return vertex;
    const snapped = [...vertex]; snapped[axis] = plane; return snapped;
  });
  const distances = polygon.map(vertex => vertex[axis] - plane);
  if (!distances.some(distance => distance > EPSILON) || !distances.some(distance => distance < -EPSILON)) return [polygon];
  const low = [], high = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = distances[i], db = distances[(i + 1) % polygon.length];
    if (da <= EPSILON) low.push(a);
    if (da >= -EPSILON) high.push(a);
    if ((da > EPSILON && db < -EPSILON) || (da < -EPSILON && db > EPSILON)) {
      // Canonical endpoint ordering makes intersections on a shared edge
      // bit-identical even when its two triangles wind in opposite directions.
      const first = a[axis] < b[axis] ? a : b, last = first === a ? b : a;
      const t = (plane - first[axis]) / (last[axis] - first[axis]);
      const intersection = first.map((value, component) => value + (last[component] - value) * t);
      intersection[axis] = plane;
      low.push(intersection); high.push(intersection);
    }
  }
  return [cleanBoundary(low), cleanBoundary(high)].filter(vertices => vertices.length);
}

function cross(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Clipping makes convex polygons. Preserve every boundary vertex: discarding
// a collinear vertex before the nonlinear deformation can open a real crack.
function triangulate(polygon, faceNormal) {
  const remaining = [...polygon], triangles = [];
  while (remaining.length > 3) {
    let best = -1, bestArea = 0;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length];
      const b = remaining[i], c = remaining[(i + 1) % remaining.length];
      const area = dot(cross(a, b, c), faceNormal);
      if (area <= bestArea || area < 1e-22) continue;
      const containsBoundary = remaining.some(point => point !== a && point !== b && point !== c
        && dot(cross(a, b, point), faceNormal) >= -1e-20
        && dot(cross(b, c, point), faceNormal) >= -1e-20
        && dot(cross(c, a, point), faceNormal) >= -1e-20);
      if (!containsBoundary) { best = i; bestArea = area; }
    }
    if (best < 0) throw new Error('Weapon shell clipping produced a non-convex or degenerate boundary');
    triangles.push([remaining[(best + remaining.length - 1) % remaining.length], remaining[best], remaining[(best + 1) % remaining.length]]);
    remaining.splice(best, 1);
  }
  if (dot(cross(...remaining), faceNormal) > 1e-22) triangles.push(remaining);
  return triangles;
}

function smoothCrownNormals(geometry, crownTriangles) {
  const { position, normal } = geometry.attributes, sums = new Map();
  const key = i => `${Math.round(position.getX(i) * 1e8)},${Math.round(position.getY(i) * 1e8)},${Math.round(position.getZ(i) * 1e8)}`;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let triangle = 0; triangle < crownTriangles.length; triangle++) {
    if (!crownTriangles[triangle]) continue;
    const start = triangle * 3;
    for (let corner = 0; corner < 3; corner++) {
      const i = start + corner;
      a.fromBufferAttribute(position, i); b.fromBufferAttribute(position, start + (corner + 1) % 3); c.fromBufferAttribute(position, start + (corner + 2) % 3);
      const angle = ab.subVectors(b, a).angleTo(ac.subVectors(c, a));
      const id = key(i), sum = sums.get(id) ?? new THREE.Vector3();
      sum.x += normal.getX(i) * angle; sum.y += normal.getY(i) * angle; sum.z += normal.getZ(i) * angle;
      sums.set(id, sum);
    }
  }
  for (const sum of sums.values()) sum.normalize();
  for (let triangle = 0; triangle < crownTriangles.length; triangle++) {
    if (!crownTriangles[triangle]) continue;
    for (let corner = 0; corner < 3; corner++) {
      const i = triangle * 3 + corner, sum = sums.get(key(i));
      normal.setXYZ(i, sum.x, sum.y, sum.z);
    }
  }
}

/**
 * Give an owned profile extrusion an explicit arched crown and rear heel.
 * Returns a fresh nonindexed geometry; the caller still owns the source.
 * Splits precede deformation, so lower walls/ports stay planar and every
 * crown/heel boundary has matching vertices on its adjoining faces.
 */
export function reshapeWeaponShell(geometry, {
  width, top, crownBase, crownDrop = 0, rearStart, rearEnd, rearScale = 1,
}) {
  if (!(width > 0) || !Number.isFinite(width) || !Number.isFinite(top) || !Number.isFinite(crownBase)
    || crownBase > top || !Number.isFinite(crownDrop) || crownDrop < 0 || crownDrop >= 1
    || !Number.isFinite(rearScale) || rearScale <= 0 || rearScale > 1) throw new RangeError('Invalid weapon shell dimensions');
  const taperRear = rearScale < 1;
  if (taperRear && (!Number.isFinite(rearStart) || !Number.isFinite(rearEnd) || rearStart >= rearEnd)) {
    throw new RangeError('Weapon shell heel needs an increasing rearStart/rearEnd interval');
  }
  const position = geometry.attributes.position;
  if (!position || position.itemSize !== 3) throw new TypeError('Weapon shell needs three-dimensional positions');
  const sourceAttributes = [['position', position], ...Object.entries(geometry.attributes).filter(([name]) => name !== 'position' && name !== 'normal')];
  const attributes = sourceAttributes.map(([name, attribute]) => ({ name, attribute, size: attribute.itemSize, values: [] }));
  const halfWidth = width / 2, planes = [];
  if (crownDrop > 0) planes.push([1, crownBase], ...CROWN_BANDS.map(band => [2, halfWidth * band]));
  if (taperRear) planes.push([0, rearStart], [0, rearEnd]);
  const count = geometry.index?.count ?? position.count, output = new THREE.BufferGeometry();
  const crownTriangles = [];
  let group = null;
  for (let start = 0; start < count; start += 3) {
    const triangle = [0, 1, 2].map(corner => {
      const vertex = geometry.index ? geometry.index.getX(start + corner) : start + corner;
      return attributes.flatMap(({ attribute, size }) => Array.from({ length: size }, (_, component) => attribute.getComponent(vertex, component)));
    });
    const faceNormal = cross(...triangle), magnitude = Math.hypot(...faceNormal);
    if (magnitude < 1e-16) continue;
    for (let axis = 0; axis < 3; axis++) faceNormal[axis] /= magnitude;
    let polygons = [triangle];
    for (const [axis, plane] of planes) polygons = polygons.flatMap(polygon => splitPolygon(polygon, axis, plane));
    const materialIndex = geometry.groups.find(candidate => start >= candidate.start && start < candidate.start + candidate.count)?.materialIndex ?? 0;
    for (const polygon of polygons) for (const vertices of triangulate(polygon, faceNormal)) {
      const mapped = vertices.map(vertex => {
        const result = [...vertex], [x, y, z] = vertex;
        if (crownDrop > 0 && y > crownBase) result[1] = crownBase + (y - crownBase) * (1 - crownDrop * (z / halfWidth) ** 2);
        if (taperRear) {
          const blend = Math.max(0, Math.min(1, (x - rearStart) / (rearEnd - rearStart)));
          result[2] *= rearScale + (1 - rearScale) * blend;
        }
        return result;
      });
      if (Math.hypot(...cross(...mapped)) < 1e-16) continue;
      const triangleIndex = crownTriangles.length;
      crownTriangles.push(crownDrop > 0 && faceNormal[1] > 0.25 && Math.abs(faceNormal[0]) < 0.25
        && vertices.some(vertex => vertex[1] > crownBase + EPSILON));
      for (const vertex of mapped) {
        let offset = 0;
        for (const attribute of attributes) {
          attribute.values.push(...vertex.slice(offset, offset + attribute.size)); offset += attribute.size;
        }
      }
      if (!group || group.materialIndex !== materialIndex) {
        group = { start: triangleIndex * 3, count: 0, materialIndex }; output.groups.push(group);
      }
      group.count += 3;
    }
  }
  for (const { name, values, size } of attributes) output.setAttribute(name, new THREE.Float32BufferAttribute(values, size));
  if (!output.attributes.uv) output.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(output.attributes.position.count * 2), 2));
  output.computeVertexNormals();
  if (crownDrop > 0) smoothCrownNormals(output, crownTriangles);
  output.computeBoundingBox(); output.computeBoundingSphere();
  output.userData = { ...geometry.userData, weaponShell: {
    sourceTriangles: count / 3, triangles: crownTriangles.length, crownBase, crownDrop, rearStart, rearEnd, rearScale,
  } };
  return output;
}
