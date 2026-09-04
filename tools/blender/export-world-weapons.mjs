// Deterministic source geometry for Blender. This reads the procedural fallback;
// it does not load the prepared GLB or modify game resources.
import { writeFile } from 'node:fs/promises';
import { getNPCFirearmGeometry } from '../../src/render/npc-firearms.js';
import { createBatAsset } from '../../src/render/bat-asset.js';

const parts = [];
function add(type, name, group, geometry, start = 0, count = null) {
  const indices = geometry.index;
  const size = count ?? (indices?.count ?? geometry.attributes.position.count);
  const attributes = {};
  for (const attributeName of ['position', 'normal', 'uv', 'color']) {
    const source = geometry.attributes[attributeName];
    if (!source) continue;
    const values = [];
    for (let i = start; i < start + size; i++) {
      const vertex = indices ? indices.getX(i) : i;
      for (let component = 0; component < source.itemSize; component++) values.push(source.array[vertex * source.itemSize + component]);
    }
    attributes[attributeName] = values;
  }
  parts.push({ type, name, group, attributes });
}
for (const type of ['pistol', 'shotgun', 'smg', 'machinegun']) {
  const geometry = getNPCFirearmGeometry(type);
  for (const part of geometry.userData.npcWeapon.parts) add(type, part.name, part.materialIndex, geometry, part.start, part.count);
}
for (const mesh of createBatAsset().children.filter(child => child.isMesh)) add('bat', mesh.name, mesh.name === 'bat-wood' ? 0 : 1, mesh.geometry);
const output = process.argv[2];
if (!output) throw new Error('Pass the output JSON path');
await writeFile(output, JSON.stringify({ schemaVersion: 1, source: 'original-project-procedural-fallback', parts }));
console.log(`Wrote ${parts.length} original weapon parts to ${output}`);
