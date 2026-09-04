// Rig-compatible seed meshes. Refinement and final normal generation happen in
// Blender; this keeps palm topology, atlas islands and clench correspondence.
import { writeFile } from 'node:fs/promises';
import { getProceduralHandGeometry, getProceduralArmGeometry } from '../../src/render/hand-geometry.js';
import { AUTHORED_HAND_RADII } from '../../src/render/authored-hand-surfaces.js';

const meshes = AUTHORED_HAND_RADII.map(radius => ({
  key: radius === null ? 'fist' : `grip-${Math.round(radius * 1000).toString().padStart(3, '0')}`,
  radius, geometry: getProceduralHandGeometry(1, radius),
})).concat(Object.entries(getProceduralArmGeometry()).map(([key, geometry]) => ({ key, geometry })));
const result = meshes.map(({ key, radius, geometry }) => ({ key, radius,
  attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([name, attribute]) => [name, Array.from(attribute.array)])),
  index: Array.from(geometry.index.array),
  morph: Object.fromEntries(Object.entries(geometry.morphAttributes).map(([name, targets]) => [name, Array.from(targets[0].array)])),
}));
await writeFile(process.argv[2], JSON.stringify({ meshes: result }));
