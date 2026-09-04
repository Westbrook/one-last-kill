/** Export original runtime geometry as editable input for the Blender authoring pass. */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createHealthPickupModel } from '../../src/render/health-pickup-model.js';
import { createArmorPickupModel } from '../../src/render/armor-pickup-model.js';
import { addCrtHousing } from '../../src/render/crt-housing.js';
import { buildAmmoBox, createResources } from '../../src/game/ammo-supplies.js';
import { AMMO_SUPPLY_CACHES } from '../../src/game/ammo-supply-rules.js';

const out = fileURLToPath(new URL('../../assets/blender/supplies-props-source.json', import.meta.url));
const crt = new THREE.Group();
addCrtHousing((geometry, material) => { const mesh = new THREE.Mesh(geometry, material); mesh.name = 'crt-recessed-details'; crt.add(mesh); },
  { parent: crt, x: 0, y: 0, z: 0 });
crt.children[0].name = 'crt-molded-housing';
const ammo = buildAmmoBox({ ...AMMO_SUPPLY_CACHES[0], position: { x: 0, y: 0, z: 0 } }, createResources()).mesh;
const groups = { health: createHealthPickupModel(), armor: createArmorPickupModel({ damaged: true }), crt, ammo };
const source = { version: 1, source: 'original-runtime-meshes', models: {} };
for (const [name, root] of Object.entries(groups)) {
  const parts = [];
  for (const mesh of root.children) {
    if (name === 'ammo' && /labels|indicator/.test(mesh.name)) continue;
    let geometry = mesh.geometry;
    if (mesh.isInstancedMesh) {
      const transform = new THREE.Matrix4(), instances = [];
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, transform); instances.push(geometry.clone().applyMatrix4(transform));
      }
      geometry = mergeGeometries(instances, false);
    }
    const attrs = geometry.attributes;
    parts.push({ name: mesh.name, positions: [...attrs.position.array], normals: [...attrs.normal.array],
      indices: geometry.index ? [...geometry.index.array] : undefined,
      material: { color: [...mesh.material.color], roughness: mesh.material.roughness, metalness: mesh.material.metalness,
        emissive: [...mesh.material.emissive], emissiveIntensity: mesh.material.emissiveIntensity },
      triangles: (geometry.index?.count ?? attrs.position.count) / 3 });
  }
  source.models[name] = { parts };
}
await mkdir(fileURLToPath(new URL('../../assets/blender/', import.meta.url)), { recursive: true });
await writeFile(out, JSON.stringify(source));
console.log(out);
