import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getNPCFirearmGeometry, getNPCFirearmMaterials } from './npc-firearms.js';
import { createHeroWeapon } from './hero-weapons.js';
import { getWeaponFinishes } from './weapon-finishes.js';

const FIREARMS = ['pistol', 'shotgun', 'smg', 'machinegun'];
const descriptors = new Map();
const dropMaterials = new WeakMap();
const NPC_TO_DROP = new THREE.Matrix4().makeRotationY(Math.PI / 2);
let knife = null;

function averageAlbedo(material) {
  const data = material.map.image.data, channels = [0, 0, 0];
  for (let offset = 0; offset < data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) channels[channel] += data[offset + channel];
  }
  return new THREE.Color().setRGB(...channels.map(sum => sum / (data.length / 4) / 255), THREE.SRGBColorSpace);
}

function knifeResources() {
  if (knife) return knife;
  // The original weapon-only knife has no hands or first-person ready pose.
  // Keep wood separate; its scale and roughness differ from the metal family.
  // Metal/metalDark/blade all have 18cm UVs, so their finish can share one draw
  // with a linear tint preserving the guard/pommel's darker actual albedo.
  const source = createHeroWeapon('knife'), finishes = getWeaponFinishes();
  const materials = Object.freeze([finishes.blade, finishes.wood]);
  const buckets = [[], []], tints = new Map(), target = averageAlbedo(finishes.blade);
  for (const mesh of source.children) {
    const materialIndex = mesh.material === finishes.wood ? 1 : 0;
    const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    mesh.updateMatrix(); geometry.applyMatrix4(mesh.matrix);
    if (materialIndex === 0 && mesh.material !== finishes.blade) {
      if (!tints.has(mesh.material)) {
        const tint = averageAlbedo(mesh.material);
        tint.setRGB(tint.r / target.r, tint.g / target.g, tint.b / target.b);
        tints.set(mesh.material, tint);
      }
      const tint = tints.get(mesh.material), color = geometry.attributes.color;
      for (let i = 0; i < color.count; i++) color.setXYZ(i,
        color.getX(i) * tint.r, color.getY(i) * tint.g, color.getZ(i) * tint.b);
    }
    buckets[materialIndex].push(geometry);
    mesh.geometry.dispose();
  }
  const merged = buckets.map(bucket => mergeGeometries(bucket, false));
  const geometry = mergeGeometries(merged, true);
  for (const part of [...buckets.flat(), ...merged]) part.dispose();
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.weaponSurfaceUV = true;
  geometry.userData.droppedWeapon = Object.freeze({ type: 'knife', source: 'original-profile-procedural',
    triangles: geometry.attributes.position.count / 3, drawCalls: geometry.groups.length });
  knife = { geometry, materials };
  return knife;
}

function descriptor(type) {
  if (!descriptors.has(type)) {
    const geometry = type === 'knife' ? knifeResources().geometry : getNPCFirearmGeometry(type);
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    if (type !== 'knife') center.applyMatrix4(NPC_TO_DROP);
    descriptors.set(type, { geometry, offset: center.negate(), rotationY: type === 'knife' ? 0 : Math.PI / 2 });
  }
  return descriptors.get(type);
}

function firearmMaterials(type, sourceMaterial) {
  const held = getNPCFirearmMaterials(type, sourceMaterial);
  if (!dropMaterials.has(held)) {
    // A pickup's close halo grazes its exposed side much more strongly than
    // an upright held gun. Existing darker steel maps keep that broad face
    // readable without making it look chrome, adding maps, or changing NPCs.
    // Both steel families use the same 18cm mapping already in the buffers.
    const steel = getWeaponFinishes().metalDark.clone();
    steel.name = 'drop-weapon-steel';
    steel.color.copy(held[0].color).multiplyScalar(1.08);
    steel.metalness = 0.85; steel.envMapIntensity = 0.70;
    steel.userData.droppedWeaponFinish = { source: 'metalDark', linearTint: 1.08, metalness: 0.85, environment: 0.70 };
    dropMaterials.set(held, Object.freeze([steel, held[1]]));
  }
  return dropMaterials.get(held);
}

/** Fresh placement nodes, shared immutable geometry/materials, +X floor axis. */
export function createDroppedWeaponAsset(type, sourceMaterial) {
  if (type !== 'knife' && !FIREARMS.includes(type)) return null;
  const asset = descriptor(type), root = new THREE.Group();
  root.name = `drop:${type}`;
  const materials = type === 'knife' ? knifeResources().materials : firearmMaterials(type, sourceMaterial);
  const mesh = new THREE.Mesh(asset.geometry, materials);
  mesh.name = `drop-model:${type}`;
  mesh.position.copy(asset.offset); mesh.rotation.y = asset.rotationY;
  mesh.castShadow = true; mesh.receiveShadow = false;
  root.add(mesh);
  return root;
}

/** Build static buffers during existing pickup startup, never on the first kill. */
export function warmDroppedWeaponAssets(materialForType) {
  for (const type of [...FIREARMS, 'knife']) {
    descriptor(type);
    if (type !== 'knife') firearmMaterials(type, materialForType?.(type));
  }
}
