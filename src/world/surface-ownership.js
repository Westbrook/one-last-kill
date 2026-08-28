import * as THREE from 'three';

// Finishes own their visible horizontal surface. A flush threshold is an
// intentional finish within a floor, not another supporting wall cap.
const FINISH_PRIORITY = Object.freeze({
  floor: 10, deck: 10, slab: 10, roof: 10, landing: 10, tread: 10, ceiling: 10, threshold: 20,
});
const SUPPORT_KINDS = new Set(['wall', 'building', 'partition', 'lintel', 'beam', 'parapet',
  'column', 'pier', 'foundation', 'structure']);
const VERSION = 1;
const area = rectangle => (rectangle.maxX - rectangle.minX) * (rectangle.maxZ - rectangle.minZ);

function opaque(material) {
  return material && !Array.isArray(material) && material.visible && !material.wireframe
    && (material.isMeshStandardMaterial || material.isMeshBasicMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial)
    && material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile
    && (material.side === THREE.FrontSide || material.side === THREE.DoubleSide)
    && (material.depthFunc === THREE.LessDepth || material.depthFunc === THREE.LessEqualDepth)
    && (material.blending === THREE.NoBlending || material.blending === THREE.NormalBlending) && !material.stencilWrite
    && !material.transparent && material.opacity === 1 && !material.alphaHash
    && !material.alphaTest && !material.alphaMap && !(material.transmission > 0)
    && !material.clippingPlanes?.length
    && !(material.displacementMap && (material.displacementScale !== 0 || material.displacementBias !== 0))
    && material.colorWrite
    && material.depthTest && material.depthWrite;
}

/** Subtract a rectangle without extending it into neighboring exposed strips. */
function subtract(rectangle, cover, tolerance) {
  const x1 = Math.max(rectangle.minX, cover.minX), x2 = Math.min(rectangle.maxX, cover.maxX);
  const z1 = Math.max(rectangle.minZ, cover.minZ), z2 = Math.min(rectangle.maxZ, cover.maxZ);
  if (x2 - x1 <= tolerance || z2 - z1 <= tolerance) return [rectangle];
  const pieces = [
    { minX: rectangle.minX, maxX: x1, minZ: rectangle.minZ, maxZ: rectangle.maxZ },
    { minX: x2, maxX: rectangle.maxX, minZ: rectangle.minZ, maxZ: rectangle.maxZ },
    { minX: x1, maxX: x2, minZ: rectangle.minZ, maxZ: z1 },
    { minX: x1, maxX: x2, minZ: z2, maxZ: rectangle.maxZ },
  ];
  return pieces.filter(piece => piece.maxX - piece.minX > tolerance && piece.maxZ - piece.minZ > tolerance);
}

function priority(record) {
  if (Object.hasOwn(FINISH_PRIORITY, record.kind)) return FINISH_PRIORITY[record.kind];
  return SUPPORT_KINDS.has(record.kind) ? 0 : null;
}

// BoxGeometry retains its type after arbitrary vertex transforms. Validate the
// actual indexed rectangles and normals instead of trusting its name or bounds.
function prepare(record, tolerance) {
  const mesh = record?.mesh, rank = record && priority(record);
  if (rank === null || !record?.id || typeof record.id !== 'string' || !mesh?.isMesh
    || mesh.isInstancedMesh || mesh.isSkinnedMesh || !mesh.visible || mesh.layers.mask !== 1 || record.dynamic
    || mesh.userData.dynamic || mesh.userData.gate || !opaque(mesh.material)) return null;
  const geometry = mesh.geometry;
  if (geometry?.type !== 'BoxGeometry' || geometry.userData.surfaceOwnership?.version === VERSION
    || geometry.index?.count !== 36 || geometry.attributes.position?.count !== 24
    || geometry.attributes.normal?.count !== 24 || geometry.attributes.uv?.count !== 24
    || geometry.attributes.position.itemSize !== 3 || geometry.attributes.normal.itemSize !== 3 || geometry.attributes.uv.itemSize !== 2
    || Object.keys(geometry.attributes).some(key => !['position', 'normal', 'uv'].includes(key))
    || Object.keys(geometry.morphAttributes).length || geometry.groups.length !== 6
    || geometry.drawRange.start !== 0 || !(geometry.drawRange.count >= 36)) return null;
  for (let ancestor = mesh.parent; ancestor; ancestor = ancestor.parent) {
    if (!ancestor.visible || ancestor.userData.dynamic || ancestor.userData.gate) return null;
  }
  mesh.updateWorldMatrix(true, false);
  if (!(mesh.matrixWorld.determinant() > 0)) return null;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const positions = geometry.attributes.position, normals = geometry.attributes.normal, uv = geometry.attributes.uv;
  const points = Array.from({ length: 24 }, (_, index) => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld));
  if (points.some(point => !point.toArray().every(Number.isFinite))
    || Array.from({ length: 24 }, (_, index) => [uv.getX(index), uv.getY(index)]).flat().some(value => !Number.isFinite(value))) return null;
  const bounds = new THREE.Box3().setFromPoints(points), faces = [], seen = new Set();
  const normal = new THREE.Vector3(), vertexNormal = new THREE.Vector3(), edgeA = new THREE.Vector3(), edgeB = new THREE.Vector3();
  for (const [groupIndex, group] of geometry.groups.entries()) {
    if (group.start !== groupIndex * 6 || group.count !== 6) return null;
    const indices = Array.from({ length: 6 }, (_, offset) => geometry.index.getX(group.start + offset));
    if (indices.some(index => !Number.isInteger(index) || index < 0 || index >= points.length)) return null;
    normal.fromBufferAttribute(normals, indices[0]).applyNormalMatrix(normalMatrix);
    const axis = ['x', 'y', 'z'].find(component => Math.abs(normal[component]) > 1 - 1e-7);
    if (!axis || ['x', 'y', 'z'].some(component => component !== axis && Math.abs(normal[component]) > 1e-7)) return null;
    const sign = Math.sign(normal[axis]), key = axis + sign;
    if (seen.has(key)) return null;
    seen.add(key);
    const plane = sign > 0 ? bounds.max[axis] : bounds.min[axis];
    const tangentAxes = ['x', 'y', 'z'].filter(component => component !== axis);
    for (const index of indices) {
      const point = points[index];
      vertexNormal.fromBufferAttribute(normals, index).applyNormalMatrix(normalMatrix);
      if (vertexNormal.distanceTo(normal) > 1e-7 || Math.abs(point[axis] - plane) > tolerance) return null;
      if (tangentAxes.some(component => Math.min(Math.abs(point[component] - bounds.min[component]),
        Math.abs(point[component] - bounds.max[component])) > tolerance)) return null;
    }
    let triangleArea = 0;
    for (let offset = 0; offset < 6; offset += 3) {
      const a = points[indices[offset]], b = points[indices[offset + 1]], c = points[indices[offset + 2]];
      const signedArea = edgeA.subVectors(b, a).cross(edgeB.subVectors(c, a)).dot(normal) / 2;
      if (!(signedArea > 0)) return null;
      triangleArea += signedArea;
    }
    const expectedArea = tangentAxes.reduce((product, component) => product * (bounds.max[component] - bounds.min[component]), 1);
    if (Math.abs(triangleArea - expectedArea) > tolerance * Math.max(1, expectedArea)) return null;
    const corner = index => tangentAxes.reduce((mask, component, bit) => mask
      | (Math.abs(points[index][component] - bounds.max[component]) <= tolerance ? 1 << bit : 0), 0);
    const first = new Set(indices.slice(0, 3).map(corner)), second = new Set(indices.slice(3).map(corner));
    const shared = [...first].filter(value => second.has(value));
    // Two triangles must tile the rectangle, sharing its diagonal rather than
    // duplicating a triangle or overlapping across one of the outside edges.
    if (first.size !== 3 || second.size !== 3 || shared.length !== 2 || (shared[0] ^ shared[1]) !== 3) return null;
    const [u, v] = tangentAxes, [ia, ib, ic] = indices;
    const a = points[ia], b = points[ib], c = points[ic];
    const bu = b[u] - a[u], bv = b[v] - a[v], cu = c[u] - a[u], cv = c[v] - a[v];
    const determinant = bu * cv - bv * cu;
    for (const index of new Set(indices)) {
      const du = points[index][u] - a[u], dv = points[index][v] - a[v];
      const wb = (du * cv - dv * cu) / determinant, wc = (bu * dv - bv * du) / determinant;
      for (const component of ['getX', 'getY']) {
        const expected = (1 - wb - wc) * uv[component](ia) + wb * uv[component](ib) + wc * uv[component](ic);
        if (Math.abs(uv[component](index) - expected) > 1e-5 * Math.max(1, Math.abs(expected))) return null;
      }
    }
    faces.push({ group, indices, axis, normal: sign, plane,
      rectangle: { minX: bounds.min.x, maxX: bounds.max.x, minZ: bounds.min.z, maxZ: bounds.max.z } });
  }
  return { record, mesh, geometry, rank, points, faces, inverse: mesh.matrixWorld.clone().invert() };
}

function outranks(owner, subject) {
  return owner !== subject && owner.rank > 0 && (owner.rank > subject.rank
    || (owner.rank === subject.rank && owner.record.id < subject.record.id));
}

function appendRectangle(fragment, face, entry, positions, normals, uvs, indices) {
  const sourceUV = entry.geometry.attributes.uv, sourceNormal = entry.geometry.attributes.normal;
  const [ia, ib, ic] = face.indices;
  const a = entry.points[ia], b = entry.points[ib], c = entry.points[ic];
  const bx = b.x - a.x, bz = b.z - a.z, cx = c.x - a.x, cz = c.z - a.z;
  const determinant = bx * cz - bz * cx;
  const corners = face.normal > 0
    ? [[fragment.minX, fragment.minZ], [fragment.minX, fragment.maxZ], [fragment.maxX, fragment.maxZ], [fragment.maxX, fragment.minZ]]
    : [[fragment.minX, fragment.minZ], [fragment.maxX, fragment.minZ], [fragment.maxX, fragment.maxZ], [fragment.minX, fragment.maxZ]];
  const base = positions.length / 3, point = new THREE.Vector3();
  for (const [x, z] of corners) {
    const tx = x - a.x, tz = z - a.z;
    const wb = (tx * cz - tz * cx) / determinant, wc = (bx * tz - bz * tx) / determinant, wa = 1 - wb - wc;
    point.set(x, face.plane, z).applyMatrix4(entry.inverse);
    positions.push(point.x, point.y, point.z);
    normals.push(sourceNormal.getX(ia), sourceNormal.getY(ia), sourceNormal.getZ(ia));
    uvs.push(wa * sourceUV.getX(ia) + wb * sourceUV.getX(ib) + wc * sourceUV.getX(ic),
      wa * sourceUV.getY(ia) + wb * sourceUV.getY(ib) + wc * sourceUV.getY(ic));
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Finalize static architecture once, after every zone is built and before its
 * first render. Only overlapping, same-facing horizontal surfaces compete.
 * Geometry is cloned; colliders, registry bounds, materials and shadow flags
 * remain owned by their original systems. No fragment becomes another mesh.
 */
export function resolveSurfaceOwnership(records, { tolerance = 1e-6 } = {}) {
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError('Surface tolerance must be positive and finite');
  const entries = [...records].map(record => prepare(record, tolerance)).filter(Boolean)
    .sort((a, b) => a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0);
  const finishes = entries.filter(entry => entry.rank > 0);
  const changes = [];
  let clippedFaces = 0, removedArea = 0;
  // All ownership queries use original faces. A threshold can replace part of
  // a floor while that floor still correctly covers the supporting wall cap.
  for (const entry of entries) {
    const replacements = new Map(), details = [];
    for (const face of entry.faces) {
      if (face.axis !== 'y') continue;
      let fragments = [face.rectangle];
      const owners = [];
      for (const finish of finishes) {
        if (!outranks(finish, entry)) continue;
        const cover = finish.faces.find(candidate => candidate.axis === 'y' && candidate.normal === face.normal
          && Math.abs(candidate.plane - face.plane) <= tolerance);
        if (!cover) continue;
        const before = fragments.reduce((sum, rectangle) => sum + area(rectangle), 0);
        fragments = fragments.flatMap(fragment => subtract(fragment, cover.rectangle, tolerance));
        const after = fragments.reduce((sum, rectangle) => sum + area(rectangle), 0);
        if (before - after > tolerance * tolerance) owners.push(finish.record.id);
        if (!fragments.length) break;
      }
      const visibleArea = fragments.reduce((sum, rectangle) => sum + area(rectangle), 0);
      const removed = area(face.rectangle) - visibleArea;
      if (removed <= tolerance * tolerance) continue;
      replacements.set(face, fragments);
      details.push({ normal: face.normal, plane: face.plane, visibleArea, removedArea: removed, owners });
      clippedFaces++; removedArea += removed;
    }
    if (!replacements.size) continue;
    const source = entry.geometry;
    // Attribute accessors decode normalized, interleaved and half-float data.
    // Copying raw storage here would change even the untouched side faces.
    const components = (attribute, names) => Array.from({ length: attribute.count }, (_, index) => names.map(name => attribute[name](index))).flat();
    const positions = components(source.attributes.position, ['getX', 'getY', 'getZ']);
    const normals = components(source.attributes.normal, ['getX', 'getY', 'getZ']);
    const uvs = components(source.attributes.uv, ['getX', 'getY']), indices = [], groups = [];
    for (const face of entry.faces) {
      const start = indices.length;
      const fragments = replacements.get(face);
      if (fragments) for (const fragment of fragments) appendRectangle(fragment, face, entry, positions, normals, uvs, indices);
      else indices.push(...face.indices);
      groups.push({ start, count: indices.length - start, materialIndex: face.group.materialIndex });
    }
    const geometry = source.clone();
    // Three's geometry copy shares userData by reference. Keep source metadata
    // untouched when another mesh still uses the original BoxGeometry.
    geometry.userData = { ...source.userData };
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, indices.length);
    geometry.clearGroups();
    for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    geometry.userData.surfaceOwnership = { version: VERSION, faces: details };
    entry.mesh.geometry = geometry;
    changes.push({ id: entry.record.id, kind: entry.record.kind, faces: details,
      originalTriangles: source.index.count / 3, triangles: indices.length / 3 });
    // The build has not uploaded these sources yet. Do not dispose a source
    // here: another static mesh may legitimately share that original geometry.
  }
  return { processedMeshes: entries.length, clippedMeshes: changes.length, clippedFaces, removedArea, changes };
}
