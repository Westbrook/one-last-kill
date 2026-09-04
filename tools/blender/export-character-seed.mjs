/** Export the project's original topology and exact production bind contract. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { createHumanoidRig } from '../../src/render/humanoid-rig.js';
import { HERO_BIND_ARM_ANGLE } from '../../src/render/hero-character-geometry.js';
import { HUMANOID_PRESETS } from '../../src/render/models.js';

const output = resolve(process.argv[2] || '/tmp/character-seed.json');
const source = await readFile(new URL('../../src/game/enemies.js', import.meta.url), 'utf8');
const definitions = source.match(/const ENEMY_TYPES = (\{[\s\S]*?\n\});/)[1];
const enemies = new Function('MAX_ARMOR', `return (${definitions});`)(100);
const configs = [
  ...Object.entries(enemies).map(([role, value]) => ({ ...value.visual, role })),
  ...['shopkeeper', 'woman'].map(role => ({ ...HUMANOID_PRESETS[role], role })),
];
const attributes = geometry => Object.fromEntries(Object.entries(geometry.attributes).map(([name, attribute]) => [name, {
  type: attribute.array.constructor.name, itemSize: attribute.itemSize, normalized: attribute.normalized,
  values: Array.from(attribute.array),
}]));
const catalog = configs.map(config => {
  const root = createHumanoidRig(config), rig = root.userData.rig;
  const { joints } = rig;
  joints.shoulderL.rotation.z = -HERO_BIND_ARM_ANGLE;
  joints.shoulderR.rotation.z = HERO_BIND_ARM_ANGLE;
  root.updateMatrixWorld(true);
  const oldHead = rig.bodyMeshes.find(mesh => mesh.name === 'head');
  const head = rig.visualMeshes.find(mesh => mesh.name === 'hero-head');
  const headScale = head.scale.clone().divide(oldHead.scale);
  return {
    id: config.role, config, dimensions: rig.dimensions,
    bones: rig.hero.skeleton.bones.map(bone => ({ name: bone.name, parent: bone.parent?.isBone ? bone.parent.name : null,
      matrix: bone.matrixWorld.toArray(), inverse: bone.matrixWorld.clone().invert().toArray(),
      position: bone.getWorldPosition(new THREE.Vector3()).toArray() })),
    body: { role: rig.hero.role, surfaceTriangles: rig.hero.continuousSurfaceTriangles,
      surfaceVertices: rig.hero.continuousSurfaceVertices, garmentDetails: rig.hero.garmentDetails },
    head: { scale: Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, headScale[axis]])) },
    surfaces: rig.visualMeshes.map(mesh => ({ name: mesh.name.replace('hero-', ''),
      presentation: mesh.matrixWorld.toArray(),
      attributes: attributes(mesh.geometry), index: Array.from(mesh.geometry.index?.array ??
        Uint32Array.from({ length: mesh.geometry.attributes.position.count }, (_, index) => index)),
      userData: mesh.geometry.userData,
    })),
  };
});
await writeFile(output, JSON.stringify({ version: 1, provenance: 'Original project geometry, with exact bind and vertex attributes', catalog }));
console.log(`Exported ${catalog.length} original character configurations to ${output}`);
