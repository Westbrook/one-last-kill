// Transfer the project's existing geometry into Blender before refining it.
// Run once before build-world-dressing.py; no runtime dependency on this tool.
import { writeFileSync, mkdirSync } from 'node:fs';
import * as THREE from 'three';
import { createConcreteBarrierGeometry } from '../../src/render/street-barrier.js';
import { applyWaterTankStaveUV } from '../../src/render/water-tank-uv.js';

const entries = [];
function add(family, dimensions, geometry, refinement, instances = 1) {
  entries.push({ id: `${family}-${entries.filter(entry => entry.family === family).length}`, family, dimensions,
    refinement, instances, sourceTriangles: geometry.index.count / 3,
    positions: [...geometry.attributes.position.array], normals: [...geometry.attributes.normal.array],
    uv: [...geometry.attributes.uv.array], index: [...geometry.index.array] });
  geometry.dispose();
}
for (const [width, height, depth, instances] of [[2.2, 1, 1.2, 3], [2.4, 1.25, 1.8, 3], [3.3, 1.25, 1.9, 1]]) {
  add('hvac-body', [width, height, depth], new THREE.BoxGeometry(width, height, depth), 'body-edge-break', instances);
  add('hvac-vent-blade', [width * 0.8, 0.018, 0.025], new THREE.BoxGeometry(width * 0.8, 0.018, 0.025), 'folded-blade', instances * 18);
  const radius = Math.min(width * 0.24, depth * 0.34);
  for (let ring = 1; ring <= 4; ring++) add('hvac-fan-guard', [radius * ring / 4, 0.009],
    new THREE.TorusGeometry(radius * ring / 4, 0.009, 4, 32), 'guard-retopology', instances);
}
add('water-tank-barrel', [1.4, 2.2, 48], applyWaterTankStaveUV(new THREE.CylinderGeometry(1.4, 1.4, 2.2, 48)), 'stave-end-bevel');
add('water-tank-cap', [1.55, 0.7, 48], new THREE.ConeGeometry(1.55, 0.7, 48), 'folded-eave-crown');
add('concrete-barrier', [2.8, 0.95, 0.75], createConcreteBarrierGeometry(2.8, 0.95, 0.75), 'cast-end-bevel');
add('workbench-case', [0.58, 0.18, 0.38], new THREE.BoxGeometry(0.58, 0.18, 0.38), 'case-edge-break', 2);
add('workbench-handle', [0.22, 0.05, 0.07], new THREE.BoxGeometry(0.22, 0.05, 0.07), 'open-bridge-handle', 2);
for (const [width, instances] of [[1.15, 1], [0.95, 1], [1.25, 3]]) {
  add('pallet-supply-case', [width, 0.5, 0.63], new THREE.BoxGeometry(width, 0.5, 0.63), 'case-vertical-corners', instances);
}
add('roof-pallet-board', [0.2, 0.06, 1.1], new THREE.BoxGeometry(0.2, 0.06, 1.1), 'board-edge-break', 10);
add('roof-tool-case', [1.2, 0.68, 0.9], new THREE.BoxGeometry(1.2, 0.68, 0.9), 'case-vertical-corners', 2);
mkdirSync('assets/blender', { recursive: true });
writeFileSync('assets/blender/world-dressing-source.json', JSON.stringify({ version: 1,
  provenance: 'Original Three.js project meshes, exported before Blender refinement',
  sources: ['src/world/zones/roof.js', 'src/world/zones/scaffolding.js', 'src/render/street-barrier.js'], entries }));
console.log(`Transferred ${entries.length} original source meshes for Blender refinement.`);
