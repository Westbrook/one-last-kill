import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const AUTHORED_WORLD_WEAPONS_URL = '/assets/models/world-weapons/world-weapons.glb';
const CAPS = { pistol: 856, shotgun: 1172, smg: 1280, machinegun: 1320, bat: 1300 };
const ENVELOPES = {
  pistol: [[-.027, -.112, -.066], [.027, .080, .2201]],
  shotgun: [[-.039, -.112, -.334], [.039, .081, .7351]],
  smg: [[-.044, -.147, -.331], [.034, .092, .4101]],
  machinegun: [[-.049, -.178, -.334], [.034, .103, .6651]],
  bat: [[-.0331, -.0331, -.1401], [.0331, .0331, .7001]],
};
let prepared = null, pending = null;
let status = { state: 'unloaded', url: AUTHORED_WORLD_WEAPONS_URL };

function disposeScene(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root?.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material || [])) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) { texture.dispose(); texture.image?.close?.(); }
}

function flatten(source) {
  const transformed = source.geometry.clone().applyMatrix4(source.matrixWorld);
  const flat = transformed.index ? transformed.toNonIndexed() : transformed;
  if (flat !== transformed) transformed.dispose();
  const geometry = new THREE.BufferGeometry();
  try {
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) {
      const attribute = flat.getAttribute(name);
      if (!attribute || attribute.itemSize < size || attribute.count !== flat.attributes.position.count) {
        throw new Error(`World weapon has invalid ${name}`);
      }
      const values = new Float32Array(attribute.count * size);
      for (let i = 0; i < attribute.count; i++) for (let component = 0; component < size; component++) {
        const value = attribute.getComponent(i, component);
        if (!Number.isFinite(value)) throw new Error(`World weapon has nonfinite ${name}`);
        values[i * size + component] = value;
      }
      geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, size));
    }
    if (geometry.attributes.position.count % 3) throw new Error('World weapon has incomplete triangles');
    return geometry;
  } catch (error) { geometry.dispose(); throw error; }
  finally { flat.dispose(); }
}

function prepare(gltf) {
  if (!gltf?.scene || gltf.animations?.length) throw new Error('World weapons must be static geometry');
  const buckets = Object.fromEntries(Object.keys(CAPS).map(type => [type, [[], []]]));
  const names = Object.fromEntries(Object.keys(CAPS).map(type => [type, [[], []]]));
  const geometries = new Map(), all = new Set();
  gltf.scene.updateMatrixWorld(true);
  try {
    gltf.scene.traverse(source => {
      if (!source.isMesh) return;
      const { weaponType: type, weaponPart: name, materialGroup: group } = source.userData;
      if (!buckets[type] || ![0, 1].includes(group) || typeof name !== 'string') throw new Error('World weapon part metadata is invalid');
      if (source.isSkinnedMesh || source.morphTargetInfluences?.length || Array.isArray(source.material)) {
        throw new Error('World weapons require static single-material parts');
      }
      if (Object.values(source.material).some(value => value?.isTexture)) throw new Error('World weapons must not introduce textures');
      const geometry = flatten(source); all.add(geometry);
      buckets[type][group].push(geometry); names[type][group].push(name);
    });
    const counts = {};
    for (const [type, groups] of Object.entries(buckets)) {
      if (groups.some(group => !group.length)) throw new Error(`World weapon ${type} is incomplete`);
      counts[type] = groups.flat().reduce((sum, geometry) => sum + geometry.attributes.position.count / 3, 0);
      if (counts[type] > CAPS[type]) throw new Error(`World weapon ${type} exceeds its triangle budget`);
      const bounds = new THREE.Box3();
      for (const geometry of groups.flat()) { geometry.computeBoundingBox(); bounds.union(geometry.boundingBox); }
      for (const [index, axis] of ['x', 'y', 'z'].entries()) {
        if (bounds.min[axis] < ENVELOPES[type][0][index] || bounds.max[axis] > ENVELOPES[type][1][index]) {
          throw new Error(`World weapon ${type} exceeds its canonical envelope`);
        }
      }
      if (type === 'bat') {
        for (const [group, name] of ['bat-wood', 'bat-grip'].entries()) {
          if (groups[group].length !== 1 || names[type][group][0] !== name) throw new Error('Bat requires its named wood and grip parts');
          const geometry = groups[group][0];
          // The shared bat API historically exposes indexed buffers. Retain
          // that representation for all held, world and pickup consumers.
          geometry.setIndex(Array.from({ length: geometry.attributes.position.count }, (_, i) => i));
          geometry.computeBoundingSphere();
          geometry.userData.authoredWorldWeapon = { source: 'original-project-blender-refined', type, part: name };
          geometries.set(`bat:${name}`, geometry);
        }
      } else {
        const mergedGroups = groups.map(group => { const merged = mergeGeometries(group, false); all.add(merged); return merged; });
        const geometry = mergeGeometries(mergedGroups, true); all.add(geometry);
        let start = 0;
        const parts = groups.flatMap((group, materialIndex) => group.map((part, index) => {
          const info = { name: names[type][materialIndex][index], start, count: part.attributes.position.count, materialIndex };
          start += info.count; return info;
        }));
        geometry.computeBoundingBox(); geometry.computeBoundingSphere();
        geometry.userData.weaponSurfaceUV = true;
        geometry.userData.npcWeapon = { version: 1, type, source: 'original-project-blender-refined', parts,
          triangles: counts[type], drawCalls: 2 };
        geometries.set(type, geometry);
      }
    }
    const retained = new Set(geometries.values());
    for (const geometry of all) if (!retained.has(geometry)) geometry.dispose();
    return { geometries, counts };
  } catch (error) {
    for (const geometry of all) geometry?.dispose();
    throw error;
  }
}

/** Read-only shared buffers; callers create their own transform/anchor nodes. */
export function getAuthoredWorldWeaponGeometry(type, part = null) {
  return prepared?.geometries.get(type === 'bat' ? `bat:${part}` : type) ?? null;
}
export function getAuthoredWorldWeaponsStatus() { return { ...status }; }

/** Preload before actor, pickup and held-bat caches are warmed. */
export async function loadAuthoredWorldWeapons({ loader, url = AUTHORED_WORLD_WEAPONS_URL, timeoutMs = 8000 } = {}) {
  if (prepared) return getAuthoredWorldWeaponsStatus();
  if (pending) return pending;
  status = { state: 'loading', url };
  pending = (async () => {
    const started = performance.now();
    let timer, expired = false, candidate;
    try {
      const loading = (async () => {
        const active = loader ?? new (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader();
        const gltf = await active.loadAsync(url);
        if (expired) disposeScene(gltf?.scene);
        return gltf;
      })();
      candidate = await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('World weapons loading timed out')); }, timeoutMs);
      })]);
      prepared = prepare(candidate);
      status = { state: 'ready', url, triangles: prepared.counts, drawsPerWeapon: 2, textures: 0, elapsedMs: performance.now() - started };
    } catch (error) {
      status = { state: 'fallback', url, error: String(error.message || error), elapsedMs: performance.now() - started };
    } finally { clearTimeout(timer); disposeScene(candidate?.scene); pending = null; }
    return getAuthoredWorldWeaponsStatus();
  })();
  return pending;
}
