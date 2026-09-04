// Snapshot original project vehicle parts before Blender preparation. This is
// build input only; it is never downloaded by the game or used at runtime.
import { mkdir, writeFile } from 'node:fs/promises';
import { createCivilianVehicle, CIVILIAN_VEHICLE_PROFILES } from '../../src/render/civilian-vehicles.js';
import { createObjectiveVehicleSource } from './export-objective-vehicle.mjs';

const out = new URL('../../assets/blender/vehicles-source.json', import.meta.url);
const bounds = box => ({ min: box.min.toArray(), max: box.max.toArray() });
const variants = [];
for (const variant of Object.keys(CIVILIAN_VEHICLE_PROFILES)) {
  // No authored preload runs in this standalone process: these are the
  // independent production fallback geometries, never a previous GLB export.
  const vehicle = createCivilianVehicle({ variant });
  const parts = vehicle.group.children.flatMap(mesh => mesh.geometry.userData.civilianParts.map(part => ({
    name: part.name, category: mesh.name.slice(`civilian-${variant}-`.length),
    attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([key, attribute]) => [key,
      { itemSize: attribute.itemSize, array: Array.from(attribute.array.slice(part.vertexStart * attribute.itemSize,
        (part.vertexStart + part.vertexCount) * attribute.itemSize)) }])),
  })));
  variants.push({ variant, profile: vehicle.profile, resources: vehicle.resources,
    movementBounds: vehicle.movementBounds.map(bounds), visualBounds: bounds(vehicle.visualBounds), parts });
}
variants.push(await createObjectiveVehicleSource());
await mkdir(new URL('../../assets/blender/', import.meta.url), { recursive: true });
await writeFile(out, JSON.stringify({ version: 1, provenance: 'Original project procedural vehicle surfaces, prepared in Blender.', variants }));
console.log(JSON.stringify(variants.map(entry => ({ variant: entry.variant, parts: entry.parts.length, triangles: entry.resources.triangles })), null, 2));
