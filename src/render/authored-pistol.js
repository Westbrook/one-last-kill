import * as THREE from 'three';

export const AUTHORED_PISTOL_URL = '/assets/models/pistol/pistol.glb';
const MUZZLE = [0.201, 0.04, 0];
const SIGHTS = {
  rear: { x: -0.05, length: 0.02, width: 0.032, bottom: 0.069, floor: 0.074, top: 0.087, gap: 0.012 },
  front: { x: 0.13, length: 0.012, width: 0.006, bottom: 0.070, top: 0.079 },
};
let template = null, pending = null;
let status = { state: 'unloaded', url: AUTHORED_PISTOL_URL };

function resources(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root?.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material || [])) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  return { geometries, materials, textures };
}

function dispose(root, complete = true) {
  const owned = resources(root);
  for (const geometry of owned.geometries) geometry.dispose();
  if (!complete) return;
  for (const material of owned.materials) material.dispose();
  const images = new Set();
  for (const texture of owned.textures) { texture.dispose(); images.add(texture.image); }
  for (const image of images) image?.close?.();
}

function prepareAsset(gltf) {
  if (!gltf?.scene || gltf.animations?.length) throw new Error('Pistol must be a static glTF scene');
  const root = new THREE.Group(); root.name = 'vm_pistol';
  gltf.scene.updateMatrixWorld(true);
  let triangles = 0, geometryBytes = 0;
  const materialLayouts = new Map();
  try {
    gltf.scene.traverse(source => {
      if (!source.isMesh) return;
      if (source.isSkinnedMesh || source.isInstancedMesh || Array.isArray(source.material) || !source.material
        || source.morphTargetInfluences?.length) {
        throw new Error('Pistol needs static, single-material mesh primitives');
      }
      const geometry = source.geometry.clone();
      const mesh = new THREE.Mesh(geometry, source.material); mesh.name = source.name;
      root.add(mesh);
      const count = geometry.getAttribute('position')?.count;
      for (const [name, itemSize] of [['position', 3], ['normal', 3], ['uv', 2]]) {
        const attribute = geometry.getAttribute(name);
        if (!attribute || attribute.itemSize !== itemSize || attribute.count !== count) {
          throw new Error(`Pistol has invalid ${name} layout`);
        }
      }
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        const array = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
        if (!array?.length || attribute.count !== count || !array.every(Number.isFinite)) {
          throw new Error(`Pistol has invalid ${name} values`);
        }
      }
      const indices = geometry.index?.array;
      if (geometry.index && (geometry.index.itemSize !== 1 || geometry.index.normalized
        || !['Uint8Array', 'Uint16Array', 'Uint32Array'].includes(indices?.constructor.name)
        || !indices.every(index => Number.isInteger(index) && index >= 0 && index < count))) {
        throw new Error('Pistol has invalid triangle indices');
      }
      const elements = geometry.index?.count ?? count;
      if (!elements || elements % 3) throw new Error('Pistol needs complete triangles');
      geometry.applyMatrix4(source.matrixWorld);
      const layout = Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}:`
          + (attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array).constructor.name).join('|');
      if (materialLayouts.has(source.material) && materialLayouts.get(source.material) !== layout) {
        throw new Error('Pistol material primitives have incompatible vertex attributes');
      }
      materialLayouts.set(source.material, layout);
      triangles += elements / 3;
      for (const attribute of Object.values(geometry.attributes)) {
        geometryBytes += (attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array).byteLength;
      }
      geometryBytes += geometry.index?.array.byteLength ?? 0;
      geometry.userData.weaponSurfaceUV = true;
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    });
    const { materials, textures } = resources(root);
    if (!root.children.length || triangles > 4000 || materials.size > 3) throw new Error('Pistol exceeds its mesh/material budget');
    for (const material of materials) {
      material.userData.weaponFinish = { profile: `blender-${material.name}`, authoredUV: true };
    }
    const bounds = new THREE.Box3().setFromObject(root);
    if (bounds.min.x < -0.10 || bounds.max.x > 0.202 || bounds.min.y < -0.13 || bounds.max.y > 0.088
      || bounds.min.z < -0.038 || bounds.max.z > 0.038) throw new Error('Pistol is outside its grip/framing envelope');
    let textureBytes = 0;
    const imageSources = new Set();
    for (const texture of textures) {
      const { width, height } = texture.image || {};
      if (!width || !height || width > 512 || height > 512) throw new Error('Pistol textures must be decoded and at most 512px');
      texture.anisotropy = 4;
      if (!imageSources.has(texture.source)) {
        textureBytes += Math.ceil(width * height * 4 * 4 / 3);
        imageSources.add(texture.source);
      }
    }
    root.userData = {
      muzzle: [...MUZZLE], ironSights: { rear: { ...SIGHTS.rear }, front: { ...SIGHTS.front } },
      heroWeapon: { version: 1, source: 'original-blender-authored', type: 'pistol',
        parts: root.children.map(mesh => mesh.name) },
    };
    return { root, metrics: { triangles, meshes: root.children.length, materials: materials.size,
      textures: textures.size, geometryBytes, textureBytes } };
  } catch (error) {
    // Materials/images still belong to the loaded scene; caller disposes them.
    dispose(root, false);
    throw error;
  }
}

export function getAuthoredPistolStatus() { return { ...status }; }

/** Await at boot, before the synchronous viewmodel cache and shader warmup. */
export async function loadAuthoredPistol({ loader, url = AUTHORED_PISTOL_URL, timeoutMs = 8000 } = {}) {
  if (template) return getAuthoredPistolStatus();
  if (pending) return pending;
  status = { state: 'loading', url };
  pending = (async () => {
    let timer, expired = false, candidate;
    const started = performance.now();
    try {
      const loading = (async () => {
        const activeLoader = loader ?? new (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader();
        const gltf = await activeLoader.loadAsync(url);
        if (expired) dispose(gltf.scene);
        return gltf;
      })();
      candidate = await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Pistol loading timed out')); }, timeoutMs);
      })]);
      const prepared = prepareAsset(candidate);
      template = prepared.root;
      // Flattened template owns geometry; its materials and textures are shared
      // with the instances. Release only the original imported geometry here.
      dispose(candidate.scene, false);
      status = { state: 'ready', url, ...prepared.metrics, elapsedMs: performance.now() - started };
    } catch (error) {
      if (candidate) dispose(candidate.scene);
      status = { state: 'fallback', url, error: String(error.message || error), elapsedMs: performance.now() - started };
    } finally { clearTimeout(timer); pending = null; }
    return getAuthoredPistolStatus();
  })();
  return pending;
}

/** Batching consumes geometry, so every caller receives its own buffers. */
export function createAuthoredPistol() {
  if (!template) return null;
  const root = template.clone(false);
  for (const source of template.children) {
    const mesh = source.clone(false); mesh.geometry = source.geometry.clone();
    root.add(mesh);
  }
  return root;
}
