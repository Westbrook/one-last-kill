import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeldWeapon, createHumanoidRig, attachHeldWeapon, updateHumanoidPose, resetHumanoidPose } from '../../src/render/humanoid-rig.js';
import { getWeaponFinishes } from '../../src/render/weapon-finishes.js';

const GUNS = {
  pistol: { muzzle: [0, 0.041, 0.22], support: [-0.039, -0.016, -0.012] },
  shotgun: { muzzle: [0, 0.041, 0.735], support: [0, -0.028, 0.270] },
  smg: { muzzle: [0, 0.041, 0.41], support: [0, -0.019, 0.184] },
  machinegun: { muzzle: [0, 0.041, 0.665], support: [0, -0.019, 0.220] },
};
const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap'];
const dropMaterial = () => new THREE.MeshStandardMaterial({ color: 0x303034, roughness: 0.5, metalness: 0.7 });

function materialState(material) {
  return {
    color: material.color.toArray(), roughness: material.roughness, metalness: material.metalness,
    vertexColors: material.vertexColors, normalScale: material.normalScale?.toArray(),
    envMapIntensity: material.envMapIntensity, version: material.version,
    maps: MAPS.map(key => material[key]), userData: JSON.stringify(material.userData),
  };
}

test('NPC firearm copies share cached assets but own exact grip-local anchors and unit transforms', () => {
  const source = dropMaterial(); source.userData.owner = 'world-pickups';
  const before = materialState(source), finishes = getWeaponFinishes();
  const finishStates = new Map(Object.values(finishes).map(material => [material, materialState(material)]));
  let sourceDisposals = 0;
  const onDispose = () => sourceDisposals++;
  source.addEventListener('dispose', onDispose);
  try {
    for (const [type, expected] of Object.entries(GUNS)) {
      const first = createHeldWeapon(type, source), second = createHeldWeapon(type, source);
      assert.ok(first.isMesh && second.isMesh, `${type}: the public attachment remains one Mesh`);
      assert.notEqual(first, second); assert.equal(first.geometry, second.geometry, `${type}: geometry is shared across actors`);
      assert.ok(Array.isArray(first.material)); assert.equal(first.material.length, 2);
      assert.equal(first.material, second.material, `${type}: the material array is cached for this supplied material`);
      assert.notEqual(first.material[0], first.material[1], `${type}: two finishes remain distinct`);
      for (const material of first.material) {
        assert.notEqual(material, source, 'NPC finishes cannot mutate the material shared with world pickups');
        assert.ok(Object.values(finishes).some(finish => MAPS.every(key => material[key] === finish[key])
          && MAPS.every(key => material[key]?.isTexture)), `${type}: all finish maps reuse one coherent shared finish`);
      }
      assert.equal(first.userData.role, 'weapon'); assert.equal(first.userData.weaponType, type);
      assert.equal(first.castShadow, true, `${type}: the drawable mesh casts its own shadow`);
      assert.deepEqual(first.position.toArray(), [0, 0, 0]);
      assert.deepEqual(first.quaternion.toArray(), [0, 0, 0, 1]);
      assert.deepEqual(first.scale.toArray(), [1, 1, 1]);
      assert.equal(first.userData.muzzle, first.userData.anchors.muzzle);
      for (const [key, position] of [['muzzle', expected.muzzle], ['supportHand', expected.support]]) {
        const anchor = first.userData.anchors[key], other = second.userData.anchors[key];
        assert.ok(anchor.isObject3D && !anchor.isMesh); assert.notEqual(anchor, other, `${type}: anchors are per actor`);
        assert.equal(anchor.parent, first); assert.equal(other.parent, second);
        assert.deepEqual(anchor.position.toArray(), position, `${type}: the established ${key} coordinate is unchanged`);
      }
      let meshes = 0; first.traverse(object => { if (object.isMesh) meshes++; });
      assert.equal(meshes, 1, 'Fresh anchors do not add rendering objects');
    }
    assert.deepEqual(materialState(source), before, 'The caller-owned pickup material is unchanged');
    assert.equal(sourceDisposals, 0, 'Building cached NPC assets never disposes the caller material');
    for (const [material, state] of finishStates) assert.deepEqual(materialState(material), state, 'NPC adaptation leaves first-person finishes unchanged');
  } finally {
    source.removeEventListener('dispose', onDispose);
  }
});

test('NPC firearm geometry uses exactly two complete draw groups within the active triangle budget', () => {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (const type of Object.keys(GUNS)) {
    const weapon = createHeldWeapon(type), geometry = weapon.geometry, { position } = geometry.attributes;
    assert.equal(geometry.index, null, `${type}: cached geometry is nonindexed`);
    assert.equal(position.count % 3, 0);
    assert.ok(position.count > 0 && position.count / 3 <= 2200, `${type}: ${position.count / 3} triangles stays within budget`);
    assert.equal(geometry.groups.length, 2, `${type}: count draw groups rather than material or mesh counts`);
    assert.deepEqual(geometry.groups.map(group => group.materialIndex).sort(), [0, 1]);
    let next = 0;
    for (const group of geometry.groups) {
      assert.equal(group.start, next, `${type}: groups do not overlap or omit geometry`);
      assert.ok(group.count > 0); assert.equal(group.count % 3, 0);
      assert.ok(weapon.material[group.materialIndex]?.isMaterial);
      next += group.count;
    }
    assert.equal(next, position.count, `${type}: both groups cover the complete mesh exactly once`);
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) {
      const attribute = geometry.attributes[name];
      assert.ok(attribute, `${type}: ${name} exists`); assert.equal(attribute.itemSize, size);
      assert.equal(attribute.count, position.count);
      assert.ok(attribute.array.every(Number.isFinite), `${type}: ${name} contains no invalid components`);
    }
    for (let i = 0; i < position.count; i += 3) {
      a.fromBufferAttribute(position, i); b.fromBufferAttribute(position, i + 1); c.fromBufferAttribute(position, i + 2);
      assert.ok(ab.subVectors(b, a).cross(ac.subVectors(c, a)).lengthSq() > 1e-24,
        `${type}: triangle ${i / 3} retains a physical surface area`);
    }
    assert.ok(geometry.boundingBox && !geometry.boundingBox.isEmpty(), `${type}: bounds are available before rendering`);
    assert.ok(geometry.boundingSphere && Number.isFinite(geometry.boundingSphere.radius) && geometry.boundingSphere.radius > 0);
  }
});

test('actual ranged poses and the pooled pose reset keep cached firearm buffers, maps, and anchors intact', () => {
  const source = dropMaterial(), sourceBefore = materialState(source), resources = new Set([source]);
  const actors = Object.keys(GUNS).map(type => {
    const root = createHumanoidRig({ height: 1.82, build: 1, kind: 'adult' });
    const weapon = attachHeldWeapon(root, type, source);
    resources.add(weapon.geometry);
    for (const material of weapon.material) {
      resources.add(material);
      for (const key of MAPS) if (material[key]?.isTexture) resources.add(material[key]);
    }
    return { root, weapon, geometry: weapon.geometry, materials: weapon.material, members: [...weapon.material],
      anchors: { ...weapon.userData.anchors }, groups: weapon.geometry.groups.map(group => ({ ...group })),
      buffers: Object.entries(weapon.geometry.attributes).map(([name, attribute]) => ({
        name, attribute, array: attribute.array, contents: attribute.array.slice(), version: attribute.version,
      })) };
  });
  const textures = [...resources].filter(resource => resource?.isTexture).map(texture => ({
    texture, version: texture.version, image: texture.image, data: texture.image?.data,
    contents: texture.image?.data?.slice(),
  }));
  const disposed = [], onDispose = event => disposed.push(event.target);
  for (const resource of resources) resource.addEventListener('dispose', onDispose);
  try {
    for (const { root, weapon, geometry, materials, members, anchors, groups, buffers } of actors) {
      for (const aim of [0, 0.5, 1, 0.25, 0]) {
        for (let frame = 0; frame < 4; frame++) {
          updateHumanoidPose(root, { mode: 'ranged', aim, alert: 1, speed: 2.2,
            forward: 0.6, strafe: 0.4, stagger: frame === 3 }, 1 / 60);
          root.updateMatrixWorld(true);
        }
      }
      assert.ok(root.userData.rig.ranged.aim > 0, 'The real ranged solver ran before the pool reset');
      resetHumanoidPose(root); root.updateMatrixWorld(true);
      assert.equal(root.userData.rig.ranged.aim, 0);
      assert.equal(root.userData.rig.ranged.weapon, weapon); assert.equal(weapon.parent, root.userData.rig.anchors.gripR);
      assert.equal(root.userData.rig.anchors.weaponMuzzle, anchors.muzzle);
      assert.equal(root.userData.rig.anchors.weaponSupportHand, anchors.supportHand);
      const expected = GUNS[weapon.userData.weaponType];
      assert.deepEqual(anchors.muzzle.position.toArray(), expected.muzzle);
      assert.deepEqual(anchors.supportHand.position.toArray(), expected.support);
      assert.equal(weapon.geometry, geometry); assert.equal(weapon.material, materials);
      for (let i = 0; i < members.length; i++) assert.equal(weapon.material[i], members[i]);
      assert.deepEqual(geometry.groups, groups);
      for (const { name, attribute, array, contents, version } of buffers) {
        assert.equal(geometry.attributes[name], attribute); assert.equal(attribute.array, array);
        assert.equal(attribute.version, version, `${name}: no per-frame upload was requested`);
        assert.deepEqual(attribute.array, contents, `${name}: static geometry is unchanged by posing`);
      }
    }
    for (const { texture, version, image, data, contents } of textures) {
      assert.equal(texture.version, version, 'Shared finish maps request no per-frame uploads');
      assert.equal(texture.image, image); assert.equal(texture.image?.data, data);
      if (contents) assert.deepEqual(data, contents, 'Shared finish pixels remain unchanged');
    }
    assert.deepEqual(materialState(source), sourceBefore); assert.deepEqual(disposed, [], 'Pooled animation never disposes shared assets');
  } finally {
    for (const resource of resources) resource.removeEventListener('dispose', onDispose);
  }
});
