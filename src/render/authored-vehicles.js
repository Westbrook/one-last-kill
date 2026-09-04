import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const AUTHORED_VEHICLES_URL = '/assets/models/vehicles/vehicles.glb';
const CIVILIAN_VARIANTS = ['sedan', 'hatchback', 'wagon', 'panel-van', 'passenger-van'];
const CIVILIAN_CATEGORIES = ['paint', 'trim', 'metal', 'glass', 'tires', 'lamps'];
const OBJECTIVE_CATEGORIES = ['paint', 'trim', 'glass', 'tires', 'metal', 'rearlamps', 'headlamps'];
let catalog = null, pending = null, status = { state: 'idle' };

function freezeTree(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeTree(child);
  return Object.freeze(value);
}

function disposeScene(scene) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  scene?.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) { texture.dispose(); texture.image?.close?.(); }
}

function box(value) {
  if (!value || !['min', 'max'].every(side => Array.isArray(value[side]) && value[side].length === 3
    && value[side].every(Number.isFinite))) throw new Error('Vehicle has invalid bounds');
  const bounds = new THREE.Box3(new THREE.Vector3(...value.min), new THREE.Vector3(...value.max));
  if (bounds.isEmpty()) throw new Error('Vehicle has empty bounds');
  return bounds;
}

function prepareCatalog(gltf) {
  if (!gltf?.scene || gltf.animations?.length) throw new Error('Vehicles must be static glTF geometry');
  const metadata = new Map(), buckets = new Map(), result = new Map(), temporary = [];
  const names = new Set([...CIVILIAN_VARIANTS, 'objective-sedan']);
  gltf.scene.updateMatrixWorld(true);
  try {
    gltf.scene.traverse(source => {
      const extras = source.userData || {};
      if (extras.vehicleMetadata) {
        const meta = JSON.parse(extras.vehicleMetadata);
        if (!names.has(meta.variant) || metadata.has(meta.variant)) throw new Error('Invalid vehicle metadata');
        metadata.set(meta.variant, freezeTree(meta));
      }
      if (!source.isMesh) return;
      const { vehicleVariant: variant, vehicleCategory: category, vehiclePart: name } = extras;
      const categories = variant === 'objective-sedan' ? OBJECTIVE_CATEGORIES : CIVILIAN_CATEGORIES;
      if (!names.has(variant) || !categories.includes(category) || typeof name !== 'string' || !name
        || source.isSkinnedMesh || source.morphTargetInfluences?.length || Array.isArray(source.material)) {
        throw new Error('Vehicle needs named static material parts');
      }
      for (const value of Object.values(source.material)) if (value?.isTexture) throw new Error('Vehicle catalog must be texture-free');
      const geometry = source.geometry.index ? source.geometry.toNonIndexed() : source.geometry.clone();
      temporary.push(geometry); geometry.applyMatrix4(source.matrixWorld);
      for (const [attributeName, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) {
        const attribute = geometry.getAttribute(attributeName);
        if (!attribute || attribute.itemSize < size || attribute.count !== geometry.attributes.position.count) {
          throw new Error(`Vehicle has invalid ${attributeName}`);
        }
        // The glTF exporter may quantize colours or include alpha. Normalize
        // every part to one float layout before merging and retain RGB tints.
        const values = new Float32Array(attribute.count * size);
        for (let i = 0; i < attribute.count; i++) for (let k = 0; k < size; k++) {
          const value = attribute.getComponent(i, k);
          if (!Number.isFinite(value)) throw new Error(`Vehicle has nonfinite ${attributeName}`);
          values[i * size + k] = value;
        }
        geometry.setAttribute(attributeName, new THREE.BufferAttribute(values, size));
      }
      for (const key of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(key)) geometry.deleteAttribute(key);
      if (geometry.attributes.position.count % 3) throw new Error('Vehicle has incomplete triangles');
      const key = `${variant}:${category}`, entries = buckets.get(key) || [];
      if (entries.some(entry => entry.name === name)) throw new Error('Duplicate vehicle part');
      entries.push({ geometry, name }); buckets.set(key, entries);
    });
    for (const variant of CIVILIAN_VARIANTS) if (!metadata.has(variant)) throw new Error('Incomplete civilian vehicle catalog');
    for (const [variant, meta] of metadata) {
      const categories = variant === 'objective-sedan' ? OBJECTIVE_CATEGORIES : CIVILIAN_CATEGORIES;
      const geometry = {}, visualBounds = box(meta.visualBounds), actualBounds = new THREE.Box3();
      let triangles = 0, geometryBytes = 0;
      for (const category of categories) {
        const entries = buckets.get(`${variant}:${category}`);
        if (!entries?.length) throw new Error(`Missing vehicle category ${variant}/${category}`);
        const ranges = []; let first = 0;
        for (const entry of entries) {
          ranges.push(Object.freeze({ name: entry.name, vertexStart: first, vertexCount: entry.geometry.attributes.position.count }));
          first += entry.geometry.attributes.position.count;
        }
        const merged = mergeGeometries(entries.map(entry => entry.geometry), false);
        temporary.push(merged);
        merged.name = `${variant === 'objective-sedan' ? 'objective' : 'civilian-' + variant}-${category}`;
        merged.userData.civilianParts = Object.freeze(ranges);
        merged.userData.authoredVehicle = true;
        // The objective's original seven finishes never enable vertex colors.
        // Do not retain its all-white Blender interchange attribute on the GPU.
        if (variant === 'objective-sedan') merged.deleteAttribute('color');
        merged.computeBoundingBox(); merged.computeBoundingSphere(); actualBounds.union(merged.boundingBox);
        geometry[category] = merged;
        triangles += merged.attributes.position.count / 3;
        geometryBytes += Object.values(merged.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
      }
      if (triangles > (variant === 'objective-sedan' ? 6500 : 4200)) throw new Error(`Vehicle ${variant} exceeds geometry budget`);
      if (!visualBounds.clone().expandByScalar(0.00001).containsBox(actualBounds)) throw new Error(`Vehicle ${variant} exceeds its placement envelope`);
      const movementBounds = (meta.movementBounds || []).map(box);
      if (variant !== 'objective-sedan') {
        if (movementBounds.length !== 2 || meta.profile?.variant !== variant || meta.profile?.wheels?.length !== 4) {
          throw new Error('Vehicle is missing its collision/wheel contract');
        }
        for (const wheel of meta.profile.wheels) {
          if (!geometry.tires.userData.civilianParts.some(part => part.name === (wheel.surfaceName || 'tire:' + wheel.name))) {
            throw new Error('Vehicle is missing an authored tire surface');
          }
        }
      }
      result.set(variant, { geometry, profile: meta.profile, dimensions: meta.dimensions, movementBounds, visualBounds,
        resources: Object.freeze({ triangles, materialDraws: categories.length, geometryBytes, textures: 0,
          textureBytes: 0, addedLights: 0, geometrySharedByVariant: true, runtimeConstruction: false,
          source: 'original-blender-prepared' }) });
    }
    const retained = new Set([...result.values()].flatMap(entry => Object.values(entry.geometry)));
    for (const geometry of temporary) if (!retained.has(geometry)) geometry.dispose();
    return result;
  } catch (error) {
    for (const geometry of temporary) geometry?.dispose();
    throw error;
  }
}

export function getAuthoredVehiclesStatus() { return { ...status }; }

/** Boot-only loading; world factories remain synchronous and share geometry. */
export async function loadAuthoredVehicles({ loader, url = AUTHORED_VEHICLES_URL, timeoutMs = 8000 } = {}) {
  if (catalog) return getAuthoredVehiclesStatus();
  if (pending) return pending;
  status = { state: 'loading', url };
  pending = (async () => {
    let timer, expired = false, candidate;
    const started = performance.now();
    try {
      const loading = (async () => {
        const activeLoader = loader ?? new (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader();
        const gltf = await activeLoader.loadAsync(url);
        if (expired) disposeScene(gltf.scene);
        return gltf;
      })();
      candidate = await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Vehicle loading timed out')); }, timeoutMs);
      })]);
      catalog = prepareCatalog(candidate);
      status = { state: 'ready', url, variants: catalog.size,
        triangles: [...catalog.values()].reduce((sum, entry) => sum + entry.resources.triangles, 0),
        textures: 0, elapsedMs: performance.now() - started };
    } catch (error) {
      status = { state: 'fallback', url, error: String(error.message || error), elapsedMs: performance.now() - started };
    } finally { clearTimeout(timer); if (candidate) disposeScene(candidate.scene); pending = null; }
    return getAuthoredVehiclesStatus();
  })();
  return pending;
}

/** Caller owns mesh instances; immutable catalog buffers stay shared. */
export function getAuthoredVehicleGeometry(variant) { return catalog?.get(variant) || null; }
