// Production GLTFLoader geometry/material parsing with CPU-only texture objects.
// The embedded PNG headers provide sizes; browser QA performs actual decoding.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Box3 } from 'three';
import { readGLB, createCPUAssetLoader } from './validate-pistol-asset.mjs';

export const WEAPONS_GLB_URL = new URL('../public/assets/models/weapons/weapons.glb', import.meta.url);
export const WEAPON_ASSET_TYPES = Object.freeze(['smg', 'shotgun', 'machinegun', 'knife']);

export async function inspectWeaponsAssets(url = WEAPONS_GLB_URL) {
  const bytes = await readFile(url), { json, binary, images } = readGLB(bytes);
  const loader = createCPUAssetLoader(images);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await loader.parseAsync(arrayBuffer, '');
  gltf.scene.updateMatrixWorld(true);
  const weapons = {}, materials = new Set(), meshes = [];
  let triangles = 0;
  for (const type of WEAPON_ASSET_TYPES) {
    const root = gltf.scene.getObjectByName(`vm_${type}`), parts = [], finishes = new Set();
    let count = 0, vertices = 0;
    root?.traverse(mesh => {
      if (!mesh.isMesh) return;
      parts.push(mesh); meshes.push(mesh);
      count += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
      vertices += mesh.geometry.attributes.position.count;
      for (const material of [].concat(mesh.material)) { finishes.add(material); materials.add(material); }
    });
    const bounds = root ? new Box3().setFromObject(root, true) : null;
    weapons[type] = { root, meshes: parts, materials: finishes, bounds,
      summary: { triangles: count, vertices, meshes: parts.length, materials: finishes.size,
        bounds: bounds ? { min: bounds.min.toArray(), max: bounds.max.toArray() } : null } };
    triangles += count;
  }
  const summary = { bytes: bytes.length, triangles, materials: materials.size, images,
    weapons: Object.fromEntries(Object.entries(weapons).map(([type, asset]) => [type, asset.summary])) };
  return { gltf, json, binary, bytes, arrayBuffer, images, meshes, materials, weapons, summary, loader };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { summary } = await inspectWeaponsAssets(process.argv[2] ? pathToFileURL(process.argv[2]) : WEAPONS_GLB_URL);
  console.log(JSON.stringify(summary, null, 2));
}
