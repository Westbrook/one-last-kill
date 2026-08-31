import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import * as THREE from 'three';

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(output, '../..'));
const phase = process.argv[3] || 'after';
const { buildWorldSurfaceFixture } = await import(pathToFileURL(path.join(root, 'tests/unit/helpers/world-surface-fixture.js')));
const fixture = buildWorldSurfaceFixture();
const vehicles = fixture.World.children.filter(object => object.name.startsWith('parked-') || object.name === 'gnucci-sedan');
const geometries = new Set(), materials = new Set(), textures = new Set();
const rows = vehicles.map(group => {
  let triangles = 0, draws = 0, bytes = 0;
  const fingerprint = crypto.createHash('sha256');
  const finish = [];
  group.traverse(mesh => {
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    draws += Array.isArray(mesh.material) ? geometry.groups.length : 1;
    for (const attribute of [...Object.values(geometry.attributes), ...(geometry.index ? [geometry.index] : [])]) {
      const array = attribute.array;
      fingerprint.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
      if (!geometries.has(geometry)) bytes += array.byteLength;
    }
    geometries.add(geometry);
    for (const material of [mesh.material].flat()) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      const description = { color: material.color?.getHex(), roughness: material.roughness, metalness: material.metalness,
        transparent: material.transparent, opacity: material.opacity, emissive: material.emissive?.getHex(),
        emissiveIntensity: material.emissiveIntensity, vertexColors: material.vertexColors };
      fingerprint.update(JSON.stringify(description)); finish.push(description);
    }
  });
  const bounds = new THREE.Box3().setFromObject(group);
  return { name: group.name, position: group.position.toArray(), yaw: group.rotation.y,
    triangles, draws, uniqueGeometryBytes: bytes, fingerprint: fingerprint.digest('hex'),
    visualBounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, finish,
    collision: group.userData.movementColliders?.map(box => ({ min: box.min.toArray(), max: box.max.toArray() })) ?? null,
    resources: group.userData.civilianVehicle?.resources ?? null };
});
const result = { source: root, note: 'Real street builder, exact vehicle batches. Geometry bytes count each shared buffer once; driver memory and repeated render passes are separate.',
  vehicles: rows, uniqueGeometries: geometries.size, uniqueMaterials: materials.size, uniqueTextures: textures.size,
  totals: rows.reduce((sum, row) => ({ triangles: sum.triangles + row.triangles, draws: sum.draws + row.draws,
    geometryBytes: sum.geometryBytes + row.uniqueGeometryBytes }), { triangles: 0, draws: 0, geometryBytes: 0 }),
  totalColliders: fixture.colliders.length };
fs.writeFileSync(path.join(output, `${phase}-vehicle-resources.json`), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ phase, totals: result.totals, geometries: geometries.size, materials: materials.size, textures: textures.size,
  objective: rows.find(row => row.name === 'gnucci-sedan')?.fingerprint }));
