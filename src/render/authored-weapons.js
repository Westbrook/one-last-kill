import * as THREE from 'three';

export const AUTHORED_WEAPONS_URL = '/assets/models/weapons/weapons.glb';
export const AUTHORED_WEAPON_TYPES = Object.freeze(['smg', 'shotgun', 'machinegun', 'knife']);

// These caps reserve the existing 7,716 firearm / 3,858 knife hand triangles.
// Bounds are the original raw assets, before hands, ready pose and framing.
const CONTRACTS = {
  smg: { triangles: 4784, min: [-0.1925, -0.160500005, -0.035], max: [0.280000001, 0.077500001, 0.033],
    muzzle: [0.28, 0.02, 0], sights: {
      rear: { x: -0.05, length: 0.022, width: 0.030, bottom: 0.0525, floor: 0.0585, top: 0.0775, gap: 0.014 },
      front: { x: 0.16, length: 0.009, width: 0.005, bottom: 0.055, top: 0.061 },
    } },
  shotgun: { triangles: 5484, min: [-0.25, -0.068000004, -0.034000002], max: [0.5, 0.064999998, 0.034000002],
    muzzle: [0.5, 0.03, 0] },
  machinegun: { triangles: 5484, min: [-0.192000002, -0.199530914, -0.043000001], max: [0.589999974, 0.094999999, 0.030999999],
    muzzle: [0.59, 0.03, 0], sights: {
      rear: { x: 0.06, length: 0.04, width: 0.040, bottom: 0.065, floor: 0.071, top: 0.095, gap: 0.014 },
      front: { x: 0.46, length: 0.009, width: 0.006, bottom: 0.048, top: 0.090 },
    } },
  knife: { triangles: 1142, min: [-0.115699999, -0.040786710, -0.0209999997], max: [0.238999993, 0.0286999997, 0.0209999979] },
};

let templates = new Map(), pending = null;
const typeStates = state => Object.fromEntries(AUTHORED_WEAPON_TYPES.map(type => [type, { state }]));
let status = { state: 'unloaded', url: AUTHORED_WEAPONS_URL, types: typeStates('unloaded') };
const copy = value => JSON.parse(JSON.stringify(value));
const arrayOf = attribute => attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;

function resources(roots) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  for (const root of roots) root?.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material || [])) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  return { geometries, materials, textures };
}

// Successful templates own cloned geometry and retain shared imported finishes.
// Invalid catalog entries must not dispose a finish used by a successful entry.
function release(roots, retained = []) {
  const owned = resources(roots), keep = resources(retained);
  for (const geometry of owned.geometries) if (!keep.geometries.has(geometry)) geometry.dispose();
  for (const material of owned.materials) if (!keep.materials.has(material)) material.dispose();
  const keepImages = new Set([...keep.textures].map(texture => texture.image)), images = new Set();
  for (const texture of owned.textures) if (!keep.textures.has(texture)) {
    texture.dispose(); images.add(texture.image);
  }
  for (const image of images) if (!keepImages.has(image)) image?.close?.();
}

function textureMetrics(textures) {
  let textureBytes = 0;
  const sources = new Set();
  for (const texture of textures) {
    const { width, height } = texture.image || {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 512 || height > 512) {
      throw new Error('Textures must be decoded and at most 512px');
    }
    texture.anisotropy = 4;
    if (!sources.has(texture.source)) {
      textureBytes += Math.ceil(width * height * 4 * 4 / 3);
      sources.add(texture.source);
    }
  }
  return textureBytes;
}

function assetMetadata(node, type, parts) {
  const contract = CONTRACTS[type], data = node.userData, hero = data.heroWeapon || {};
  const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  if (data.muzzle && (!vector(data.muzzle) || !contract.muzzle
    || data.muzzle.some((value, index) => Math.abs(value - contract.muzzle[index]) > 1e-7))) {
    throw new Error('Muzzle metadata changes the established effect anchor');
  }
  if (data.ironSights) {
    if (!contract.sights) throw new Error('Unexpected iron-sight metadata');
    for (const [part, values] of Object.entries(contract.sights)) for (const [key, value] of Object.entries(values)) {
      const actual = data.ironSights[part]?.[key];
      if (!Number.isFinite(actual) || Math.abs(value - actual) > 1e-7) throw new Error('Iron-sight metadata changes the established aim alignment');
    }
  }
  if (hero.triggerOpening && !vector(hero.triggerOpening)) throw new Error('Invalid trigger-opening metadata');
  if (hero.recess && (!vector(hero.recess.point) || !Number.isFinite(hero.recess.depth) || hero.recess.depth < 0)) {
    throw new Error('Invalid mechanical recess metadata');
  }
  if (hero.panels && (!Array.isArray(hero.panels) || hero.panels.some(panel => !panel || typeof panel.name !== 'string'
    || !vector(panel.point) || !Number.isFinite(panel.depth) || panel.depth < 0))) throw new Error('Invalid mechanical panel metadata');
  return {
    ...(contract.muzzle ? { muzzle: [...contract.muzzle] } : {}),
    ...(contract.sights ? { ironSights: copy(contract.sights) } : {}),
    heroWeapon: { ...copy(hero), version: 1, source: 'original-blender-authored', type, parts },
  };
}

function prepareWeapon(node, type) {
  const root = new THREE.Group(); root.name = `vm_${type}`;
  const contract = CONTRACTS[type], layouts = new Map();
  let triangles = 0, geometryBytes = 0;
  try {
    node.traverse(source => {
      if (!source.isMesh) return;
      if (source.isSkinnedMesh || source.isInstancedMesh || Array.isArray(source.material) || !source.material
        || source.morphTargetInfluences?.length) throw new Error('Expected static, single-material mesh primitives');
      const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld);
      const mesh = new THREE.Mesh(geometry, source.material); mesh.name = source.name; root.add(mesh);
      const count = geometry.getAttribute('position')?.count;
      for (const [name, itemSize] of [['position', 3], ['normal', 3], ['uv', 2]]) {
        const attribute = geometry.getAttribute(name);
        if (!attribute || attribute.itemSize !== itemSize || attribute.count !== count) throw new Error(`Invalid ${name} layout`);
      }
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        const array = arrayOf(attribute);
        if (!array?.length || attribute.count !== count || !array.every(Number.isFinite)) throw new Error(`Invalid ${name} values`);
        geometryBytes += array.byteLength;
      }
      const indices = geometry.index?.array;
      if (indices && !indices.every(index => Number.isInteger(index) && index >= 0 && index < count)) throw new Error('Invalid triangle indices');
      const elements = geometry.index?.count ?? count;
      if (!elements || elements % 3) throw new Error('Expected complete triangles');
      triangles += elements / 3;
      geometryBytes += indices?.byteLength ?? 0;
      const layout = Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}:${arrayOf(attribute).constructor.name}`).join('|');
      if (layouts.has(source.material) && layouts.get(source.material) !== layout) throw new Error('Material primitives have incompatible vertex attributes');
      layouts.set(source.material, layout);
      geometry.userData.weaponSurfaceUV = true;
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    });
    const { materials, textures } = resources([root]);
    if (!root.children.length || triangles > contract.triangles || materials.size > 3) throw new Error('Asset exceeds its mesh/material budget');
    const bounds = new THREE.Box3().setFromObject(root, true);
    for (const [index, axis] of ['x', 'y', 'z'].entries()) {
      if (bounds.min[axis] < contract.min[index] - 1e-6 || bounds.max[axis] > contract.max[index] + 1e-6) {
        throw new Error('Asset is outside its original grip/framing envelope');
      }
    }
    const textureBytes = textureMetrics(textures);
    root.userData = assetMetadata(node, type, root.children.map(mesh => mesh.name));
    for (const material of materials) {
      material.userData.weaponFinish = { profile: `blender-${material.name}`, authoredUV: true };
    }
    return { root, metrics: { triangles, meshes: root.children.length, materials: materials.size,
      textures: textures.size, geometryBytes, textureBytes } };
  } catch (error) {
    // Loaded scene still owns all materials/images, including shared finishes.
    for (const geometry of resources([root]).geometries) geometry.dispose();
    throw error;
  }
}

function prepareCatalog(gltf) {
  if (!gltf?.scene || gltf.animations?.length) throw new Error('Weapons must be a static glTF scene');
  gltf.scene.updateMatrixWorld(true);
  const prepared = new Map(), types = {};
  for (const type of AUTHORED_WEAPON_TYPES) {
    try {
      const nodes = [];
      gltf.scene.traverse(node => { if (node.name === `vm_${type}`) nodes.push(node); });
      if (nodes.length !== 1) throw new Error(`Expected one vm_${type} root`);
      nodes[0].traverse(node => {
        if (node !== nodes[0] && AUTHORED_WEAPON_TYPES.some(other => node.name === `vm_${other}`)) {
          throw new Error('Weapon catalog roots must not contain one another');
        }
      });
      const { root, metrics } = prepareWeapon(nodes[0], type);
      prepared.set(type, root); types[type] = { state: 'ready', ...metrics };
    } catch (error) { types[type] = { state: 'fallback', error: String(error.message || error) }; }
  }
  return { prepared, types };
}

export function getAuthoredWeaponsStatus() { return copy(status); }

/** Finish once at boot, before the synchronous viewmodel cache/shader warmup. */
export async function loadAuthoredWeapons({ loader, url = AUTHORED_WEAPONS_URL, timeoutMs = 8000 } = {}) {
  if (templates.size) return getAuthoredWeaponsStatus();
  if (pending) return pending;
  status = { state: 'loading', url, types: typeStates('loading') };
  pending = (async () => {
    let timer, expired = false, candidate;
    const started = performance.now();
    try {
      const loading = (async () => {
        const activeLoader = loader ?? new (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader();
        const gltf = await activeLoader.loadAsync(url);
        if (expired) release([gltf?.scene]);
        return gltf;
      })();
      candidate = await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Weapon catalog loading timed out')); }, timeoutMs);
      })]);
      const { prepared, types } = prepareCatalog(candidate), roots = [...prepared.values()];
      const { materials, textures } = resources(roots);
      // Original imported buffers and unused finishes can now be released.
      release([candidate.scene], roots); candidate = null; templates = prepared;
      status = { state: templates.size === AUTHORED_WEAPON_TYPES.length ? 'ready' : templates.size ? 'partial' : 'fallback',
        url, types, elapsedMs: performance.now() - started, materials: materials.size, textures: textures.size,
        geometryBytes: Object.values(types).reduce((sum, result) => sum + (result.geometryBytes || 0), 0),
        textureBytes: textureMetrics(textures) };
    } catch (error) {
      if (candidate) release([candidate.scene]);
      status = { state: 'fallback', url, types: typeStates('fallback'), error: String(error.message || error), elapsedMs: performance.now() - started };
    } finally { clearTimeout(timer); pending = null; }
    return getAuthoredWeaponsStatus();
  })();
  return pending;
}

/** The material batcher consumes geometry; each instance gets owned buffers. */
export function createAuthoredWeapon(type) {
  const template = templates.get(type);
  if (!template) return null;
  const root = template.clone(false);
  for (const source of template.children) {
    const mesh = source.clone(false); mesh.geometry = source.geometry.clone(); root.add(mesh);
  }
  return root;
}
