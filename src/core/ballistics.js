import * as THREE from 'three';
import { Colliders } from './collision.js';
import { buildBoundsTree, rayBoundsDistance } from './ballistic-bvh.js';

const EPSILON = 1e-8;
const SURFACE_EPSILON = 1e-5;
const MAX_DISTANCE = 512;
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
// Texture components absent from an RGB/RG/RED upload have the GPU defaults
// alpha=1 and green=0. Alpha-only textures provide only their alpha component.
const MASK_COMPONENTS = new Map([
  [THREE.RGBAFormat, { count: 4, alpha: 3, green: 1 }],
  [THREE.RGBFormat, { count: 3, alpha: -1, green: 1 }],
  [THREE.RGFormat, { count: 2, alpha: -1, green: 1 }],
  [THREE.RedFormat, { count: 1, alpha: -1, green: -2 }],
  [THREE.AlphaFormat, { count: 1, alpha: 0, green: -2 }],
]);

/** Hits are reusable. Pass one to raycast when a later query must not overwrite it. */
export function createBallisticHit() {
  return {
    distance: Infinity, point: new THREE.Vector3(), normal: new THREE.Vector3(),
    material: null, surfaceKind: 'solid', object: null, instanceId: null, triangleIndex: -1,
  };
}

function clearHit(hit) {
  hit.distance = Infinity; hit.material = null; hit.surfaceKind = 'solid';
  hit.object = null; hit.instanceId = null; hit.triangleIndex = -1;
  hit.point.set(0, 0, 0); hit.normal.set(0, 0, 0);
}

function childOf(object, root) {
  for (let parent = object; parent; parent = parent.parent) if (parent === root) return true;
  return false;
}

function materialKind(material) {
  return material.userData?.surfaceKind || material.name?.replace(/^surface-/, '')
    || (material.metalness >= 0.45 ? 'metal' : 'solid');
}

function wrap(value, mode) {
  if (mode === THREE.RepeatWrapping) return value - Math.floor(value);
  if (mode === THREE.MirroredRepeatWrapping) {
    const cell = Math.floor(value), fraction = value - cell;
    return Math.abs(cell % 2) ? 1 - fraction : fraction;
  }
  return Math.max(0, Math.min(1, value));
}

// Pixels are captured once, while building. No canvas work or texture readback
// occurs in a shot/LOS query. A missing cutout mask stays open instead of
// silently turning a wire screen into an opaque rectangular wall.
function readMask(texture, channel) {
  if (!texture) return null;
  const image = texture.image;
  if (!image || !(image.width > 0) || !(image.height > 0)) return null;
  let data = image.data;
  if (!data) {
    try {
      let canvas = image;
      if (!canvas.getContext && typeof document !== 'undefined') {
        canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
      }
      data = canvas.getContext?.('2d')?.getImageData?.(0, 0, image.width, image.height)?.data;
    } catch { return null; }
  }
  if (!data) return null;
  const channels = data.length / (image.width * image.height);
  const components = MASK_COMPONENTS.get(texture.format);
  if (!components || channels !== components.count) return null;
  if (![THREE.UnsignedByteType, THREE.UnsignedShortType, THREE.FloatType, THREE.HalfFloatType].includes(texture.type)) return null;
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  return {
    data, width: image.width, height: image.height, channels,
    channel: components[channel],
    unit: texture.type === THREE.UnsignedShortType ? 1 / 65535 : texture.type === THREE.UnsignedByteType ? 1 / 255 : 1,
    halfFloat: texture.type === THREE.HalfFloatType,
    matrix: texture.matrix.elements.slice(), wrapS: texture.wrapS, wrapT: texture.wrapT, flipY: texture.flipY,
    linear: texture.magFilter !== THREE.NearestFilter,
  };
}

function maskPixel(mask, px, py) {
  const { data, width, height, channels, channel, unit } = mask;
  const sx = Math.min(width - 1, Math.floor(wrap((px + 0.5) / width, mask.wrapS) * width));
  const sy = Math.min(height - 1, Math.floor(wrap((py + 0.5) / height, mask.wrapT) * height));
  const value = data[(sy * width + sx) * channels + channel];
  return (mask.halfFloat ? THREE.DataUtils.fromHalfFloat(value) : value) * unit;
}

function sampleMask(mask, u, v) {
  if (!mask) return 0;
  if (mask.channel < 0) return mask.channel === -1 ? 1 : 0;
  const m = mask.matrix;
  const x = wrap(m[0] * u + m[3] * v + m[6], mask.wrapS);
  let y = wrap(m[1] * u + m[4] * v + m[7], mask.wrapT);
  if (mask.flipY) y = 1 - y;
  const { width, height } = mask;
  if (!mask.linear) return maskPixel(mask, Math.floor(x * width), Math.floor(y * height));
  const px = x * width - 0.5, py = y * height - 0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  return (maskPixel(mask, x0, y0) * (1 - fx) + maskPixel(mask, x0 + 1, y0) * fx) * (1 - fy)
    + (maskPixel(mask, x0, y0 + 1) * (1 - fx) + maskPixel(mask, x0 + 1, y0 + 1) * fx) * fy;
}

function geometryData(geometry, grouped) {
  const position = geometry.attributes.position;
  if (!position || position.itemSize < 3) return null;
  const index = geometry.index;
  const fullCount = index?.count ?? position.count;
  const first = Math.max(0, Math.floor(geometry.drawRange.start));
  const end = Math.min(fullCount, first + geometry.drawRange.count);
  // GPU draw calls restart triangle assembly at their actual first index;
  // neither draw ranges nor material groups need to start at a multiple of 3.
  const chunks = grouped ? geometry.groups.map(group => ({
    start: Math.max(first, group.start), end: Math.min(end, group.start + group.count), materialIndex: group.materialIndex,
  })) : [{ start: first, end, materialIndex: 0 }];
  const count = chunks.reduce((total, chunk) => total + Math.max(0, Math.floor((chunk.end - chunk.start) / 3)), 0);
  if (!count) return null;
  const triangles = new Uint32Array(count * 3), materialIndices = new Int32Array(count);
  const sourceIndices = new Uint32Array(count);
  const bounds = new Float64Array(count * 6);
  let triangle = 0;
  for (const chunk of chunks) {
    for (let start = chunk.start; start + 2 < chunk.end; start += 3, triangle++) {
      const a = index ? index.getX(start) : start;
      const b = index ? index.getX(start + 1) : start + 1;
      const c = index ? index.getX(start + 2) : start + 2;
      triangles.set([a, b, c], triangle * 3);
      materialIndices[triangle] = chunk.materialIndex;
      sourceIndices[triangle] = Math.floor(start / 3);
      const offset = triangle * 6;
      bounds[offset] = Math.min(position.getX(a), position.getX(b), position.getX(c)) - EPSILON;
      bounds[offset + 1] = Math.min(position.getY(a), position.getY(b), position.getY(c)) - EPSILON;
      bounds[offset + 2] = Math.min(position.getZ(a), position.getZ(b), position.getZ(c)) - EPSILON;
      bounds[offset + 3] = Math.max(position.getX(a), position.getX(b), position.getX(c)) + EPSILON;
      bounds[offset + 4] = Math.max(position.getY(a), position.getY(b), position.getY(c)) + EPSILON;
      bounds[offset + 5] = Math.max(position.getZ(a), position.getZ(b), position.getZ(c)) + EPSILON;
    }
  }
  return { position, uv: geometry.attributes.uv, triangles, materialIndices, sourceIndices, tree: buildBoundsTree(bounds) };
}

/**
 * Static rendered surfaces, independent from the generous boxes used to move
 * characters. A world BVH selects meshes/instances; shared geometry BVHs then
 * test actual triangles. Rebuild after batching/surface ownership or editing
 * shared geometry buffers. Transform/material changes and newly added solids
 * use updateObject/addObject explicitly, never a scene walk during a shot.
 * Mesh visibility and linked collider enable state stay live.
 */
export function createBallisticWorld({ colliders = Colliders } = {}) {
  let root = null, ready = false, entries = [], tree = buildBoundsTree([]);
  let geometryCache = new WeakMap(), materialCache = new WeakMap();
  let geometryCount = 0, triangleCount = 0, missingMasks = 0;
  let colliderRevision = -1;
  const enabledColliders = new Set();
  const hit = createBallisticHit(), localOrigin = new THREE.Vector3(), localDirection = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3(), rayDirection = new THREE.Vector3(), segmentDirection = new THREE.Vector3();
  const instanceMatrix = new THREE.Matrix4(), worldMatrix = new THREE.Matrix4();
  const lastQuery = { nodes: 0, objects: 0, triangles: 0 };

  function materialData(material) {
    if (!material) return null;
    let data = materialCache.get(material);
    if (data) return data;
    const alphaTest = material.alphaTest || 0;
    const map = alphaTest > 0 && material.map ? readMask(material.map, 'alpha') : null;
    const alphaMap = alphaTest > 0 && material.alphaMap ? readMask(material.alphaMap, 'green') : null;
    const unreadableMask = alphaTest > 0 && ((material.map && !map) || (material.alphaMap && !alphaMap)) ? 1 : 0;
    missingMasks += unreadableMask;
    const kind = materialKind(material);
    data = {
      material, kind, alphaTest, map, alphaMap, unreadableMask,
      bullet: material.depthWrite !== false,
      sight: material.depthWrite !== false && !material.transparent && material.opacity === 1,
    };
    materialCache.set(material, data);
    return data;
  }

  function refreshMaterials(object) {
    const refreshed = new Set();
    object.traverse(mesh => {
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!material || refreshed.has(material)) continue;
        refreshed.add(material);
        const previous = materialCache.get(material);
        if (!previous) continue;
        missingMasks -= previous.unreadableMask;
        materialCache.delete(material);
        // Retain the policy identity used by other instances of this shared
        // material. Refreshing one door also refreshes its matching trim.
        Object.assign(previous, materialData(material));
        materialCache.set(material, previous);
      }
    });
  }

  function rebuildTree() {
    const bounds = new Float64Array(entries.length * 6);
    for (let index = 0; index < entries.length; index++) {
      const box = entries[index].bounds, offset = index * 6;
      bounds.set([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z], offset);
    }
    tree = buildBoundsTree(bounds, { leafSize: 4 });
  }

  function appendObject(object, options = {}) {
    object.updateWorldMatrix(true, true);
    const attachment = root && childOf(object, root) ? root : object;
    object.traverse(mesh => {
      if (!mesh.isMesh || mesh.isSkinnedMesh) return;
      let collider = options.collider ?? null;
      for (let parent = mesh; parent; parent = parent.parent) {
        if (parent.userData.ballistics === false) return;
        collider ??= parent.userData.collider;
        if (parent === attachment) break;
      }
      const arrayMaterial = Array.isArray(mesh.material);
      let variants = geometryCache.get(mesh.geometry);
      if (!variants) { variants = []; geometryCache.set(mesh.geometry, variants); }
      let geometry = variants[arrayMaterial ? 1 : 0];
      if (!geometry) {
        geometry = geometryData(mesh.geometry, arrayMaterial);
        if (!geometry) return;
        variants[arrayMaterial ? 1 : 0] = geometry; geometryCount++;
        triangleCount += geometry.triangles.length / 3;
      }
      const materials = (arrayMaterial ? mesh.material : [mesh.material]).map(materialData);
      if (!materials.some(value => value && (value.bullet || value.sight))) return;
      const count = mesh.isInstancedMesh ? mesh.count : 1;
      const localBounds = geometry.tree.nodes[0];
      for (let instance = 0; instance < count; instance++) {
        worldMatrix.copy(mesh.matrixWorld);
        if (mesh.isInstancedMesh) {
          mesh.getMatrixAt(instance, instanceMatrix); worldMatrix.multiply(instanceMatrix);
        }
        // A zero scale can park a pooled prop; it has no physical triangles.
        if (Math.abs(worldMatrix.determinant()) < 1e-12) continue;
        const bounds = new THREE.Box3(
          new THREE.Vector3(localBounds.minX, localBounds.minY, localBounds.minZ),
          new THREE.Vector3(localBounds.maxX, localBounds.maxY, localBounds.maxZ),
        ).applyMatrix4(worldMatrix);
        entries.push({
          object: mesh, attachment, collider, geometry, materials, arrayMaterial, bounds,
          instanceId: mesh.isInstancedMesh ? instance : null,
          inverse: worldMatrix.clone().invert(), normalMatrix: new THREE.Matrix3().getNormalMatrix(worldMatrix),
        });
      }
    });
  }

  function active(entry, channel) {
    if (entry.collider && colliders && !enabledColliders.has(entry.collider)) return false;
    for (let object = entry.object; object; object = object.parent) {
      const policy = object.userData.ballistics;
      if (!object.visible || policy === false || policy?.[channel] === false) return false;
      if (object === entry.attachment) return true;
    }
    return false;
  }

  function triangleHit(entry, triangle, nearest, channel, result) {
    const geometry = entry.geometry, offset = triangle * 3;
    const data = entry.materials[entry.arrayMaterial ? geometry.materialIndices[triangle] : 0];
    if (!data || !data[channel] || !data.material.visible || data.material.opacity <= 0
      || data.material.userData.ballistics === false || data.material.userData.ballistics?.[channel] === false) return nearest;
    const { position, triangles } = geometry;
    const ia = triangles[offset], ib = triangles[offset + 1], ic = triangles[offset + 2];
    const ax = position.getX(ia), ay = position.getY(ia), az = position.getZ(ia);
    const e1x = position.getX(ib) - ax, e1y = position.getY(ib) - ay, e1z = position.getZ(ib) - az;
    const e2x = position.getX(ic) - ax, e2y = position.getY(ic) - ay, e2z = position.getZ(ic) - az;
    const px = localDirection.y * e2z - localDirection.z * e2y;
    const py = localDirection.z * e2x - localDirection.x * e2z;
    const pz = localDirection.x * e2y - localDirection.y * e2x;
    const determinant = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(determinant) < 1e-12) return nearest;
    const inverse = 1 / determinant;
    const tx = localOrigin.x - ax, ty = localOrigin.y - ay, tz = localOrigin.z - az;
    const u = (tx * px + ty * py + tz * pz) * inverse;
    if (u < -EPSILON || u > 1 + EPSILON) return nearest;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (localDirection.x * qx + localDirection.y * qy + localDirection.z * qz) * inverse;
    if (v < -EPSILON || u + v > 1 + EPSILON) return nearest;
    const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
    if (distance < SURFACE_EPSILON || distance > nearest) return nearest;
    if (data.alphaTest > 0) {
      let alpha = data.material.opacity;
      if (data.material.map || data.material.alphaMap) {
        const uv = geometry.uv;
        if (!uv) return nearest;
        const w = 1 - u - v;
        const textureU = uv.getX(ia) * w + uv.getX(ib) * u + uv.getX(ic) * v;
        const textureV = uv.getY(ia) * w + uv.getY(ib) * u + uv.getY(ic) * v;
        if (data.material.map) alpha *= sampleMask(data.map, textureU, textureV);
        if (data.material.alphaMap) alpha *= sampleMask(data.alphaMap, textureU, textureV);
      }
      if (alpha < data.alphaTest) return nearest;
    }
    result.distance = distance;
    result.point.copy(rayOrigin).addScaledVector(rayDirection, distance);
    result.normal.set(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x)
      .applyMatrix3(entry.normalMatrix).normalize();
    if (result.normal.dot(rayDirection) > 0) result.normal.negate();
    result.material = data.material; result.surfaceKind = data.kind;
    result.object = entry.object; result.instanceId = entry.instanceId;
    result.triangleIndex = geometry.sourceIndices[triangle];
    return distance;
  }

  function queryGeometry(entry, nearest, channel, result) {
    localOrigin.copy(rayOrigin).applyMatrix4(entry.inverse);
    const m = entry.inverse.elements;
    // Do not normalize this transformed direction: its t remains world metres
    // even for nonuniformly scaled or mirrored instanced decoration.
    localDirection.set(
      m[0] * rayDirection.x + m[4] * rayDirection.y + m[8] * rayDirection.z,
      m[1] * rayDirection.x + m[5] * rayDirection.y + m[9] * rayDirection.z,
      m[2] * rayDirection.x + m[6] * rayDirection.y + m[10] * rayDirection.z,
    );
    const bvh = entry.geometry.tree, { nodes, order, stack } = bvh;
    let size = 1; stack[0] = 0;
    while (size) {
      const node = nodes[stack[--size]]; lastQuery.nodes++;
      if (rayBoundsDistance(node, localOrigin.x, localOrigin.y, localOrigin.z,
        localDirection.x, localDirection.y, localDirection.z, nearest) === Infinity) continue;
      if (node.count) {
        for (let index = node.start, end = index + node.count; index < end; index++) {
          lastQuery.triangles++;
          nearest = triangleHit(entry, order[index], nearest, channel, result);
        }
      } else {
        stack[size++] = node.left; stack[size++] = node.right;
      }
    }
    return nearest;
  }

  function raycast(origin, direction, maxDistance = 120, channel = 'bullet', result = hit) {
    clearHit(result); lastQuery.nodes = 0; lastQuery.objects = 0; lastQuery.triangles = 0;
    if (!ready || !tree.nodes.length || !finitePoint(origin) || !finitePoint(direction)
      || !Number.isFinite(maxDistance) || maxDistance <= 0 || (channel !== 'bullet' && channel !== 'sight')) return null;
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < EPSILON) return null;
    if (colliders && colliderRevision !== colliders.revision) {
      enabledColliders.clear(); for (const box of colliders.list) enabledColliders.add(box);
      colliderRevision = colliders.revision;
    }
    rayOrigin.copy(origin); rayDirection.copy(direction).divideScalar(length);
    let nearest = Math.min(MAX_DISTANCE, maxDistance), size = 1;
    const { nodes, order, stack } = tree; stack[0] = 0;
    while (size) {
      const node = nodes[stack[--size]]; lastQuery.nodes++;
      if (rayBoundsDistance(node, rayOrigin.x, rayOrigin.y, rayOrigin.z,
        rayDirection.x, rayDirection.y, rayDirection.z, nearest) === Infinity) continue;
      if (node.count) {
        for (let index = node.start, end = index + node.count; index < end; index++) {
          const entry = entries[order[index]];
          if (!active(entry, channel)) continue;
          lastQuery.objects++;
          nearest = queryGeometry(entry, nearest, channel, result);
        }
      } else {
        const left = nodes[node.left], right = nodes[node.right];
        const leftDistance = rayBoundsDistance(left, rayOrigin.x, rayOrigin.y, rayOrigin.z, rayDirection.x, rayDirection.y, rayDirection.z, nearest);
        const rightDistance = rayBoundsDistance(right, rayOrigin.x, rayOrigin.y, rayOrigin.z, rayDirection.x, rayDirection.y, rayDirection.z, nearest);
        // Visit nearer surfaces first; a nearby wall then prunes distant rooms.
        if (leftDistance < rightDistance) {
          if (rightDistance !== Infinity) stack[size++] = node.right;
          if (leftDistance !== Infinity) stack[size++] = node.left;
        } else {
          if (leftDistance !== Infinity) stack[size++] = node.left;
          if (rightDistance !== Infinity) stack[size++] = node.right;
        }
      }
    }
    return result.object ? result : null;
  }

  const api = {
    rebuild(object) {
      if (!object?.traverse || !object.updateWorldMatrix) throw new TypeError('Ballistics requires an Object3D root');
      this.clear(); root = object; appendObject(object); rebuildTree(); ready = true;
      return this.snapshot();
    },
    addObject(object, options) {
      if (!object?.traverse || !object.updateWorldMatrix) throw new TypeError('Ballistics requires an Object3D');
      entries = entries.filter(entry => !childOf(entry.object, object));
      refreshMaterials(object);
      appendObject(object, options); rebuildTree(); ready = true;
      return object;
    },
    updateObject(object, options) { return this.addObject(object, options); },
    removeObject(object) { entries = entries.filter(entry => !childOf(entry.object, object)); rebuildTree(); },
    clear() {
      root = null; ready = false; entries = []; tree = buildBoundsTree([]);
      geometryCache = new WeakMap(); materialCache = new WeakMap();
      geometryCount = 0; triangleCount = 0; missingMasks = 0; colliderRevision = -1; enabledColliders.clear();
      clearHit(hit); lastQuery.nodes = 0; lastQuery.objects = 0; lastQuery.triangles = 0;
    },
    raycast,
    segmentOccluded(start, end, channel = 'sight') {
      if (!finitePoint(start) || !finitePoint(end)) return false;
      segmentDirection.copy(end).sub(start);
      const length = segmentDirection.length();
      return length > SURFACE_EPSILON * 2 && Boolean(raycast(start, segmentDirection, length - SURFACE_EPSILON, channel));
    },
    snapshot() {
      return { ready, objects: new Set(entries.map(entry => entry.object)).size, instances: entries.length,
        triangles: triangleCount, geometryCount, nodes: tree.nodes.length, unreadableAlphaMasks: missingMasks,
        lastQuery: { ...lastQuery } };
    },
  };
  return api;
}

export const Ballistics = createBallisticWorld();
