import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { weaponHarness } from './helpers/weapon-harness.js';
import { getNPCFirearmGeometry, getNPCFirearmMaterials } from '../../src/render/npc-firearms.js';
import { createHeroWeapon } from '../../src/render/hero-weapons.js';
import { getWeaponFinishes } from '../../src/render/weapon-finishes.js';
import { weaponPickupPrompt } from '../../src/game/weapon-rules.js';

const FIREARMS = ['pistol', 'shotgun', 'smg', 'machinegun'];
const TYPES = [...FIREARMS, 'knife'];
const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap'];
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} versus ${b}`);
const floor = () => new THREE.Box3(new THREE.Vector3(-20, -0.2, -20), new THREE.Vector3(20, 0, 20));

function onlyMesh(root) {
  const meshes = []; root.traverse(object => { if (object.isMesh) meshes.push(object); });
  assert.equal(meshes.length, 1, 'The authored gun or knife adds exactly one drawable mesh');
  return meshes[0];
}

function assertTwoDraws(mesh) {
  assert.ok(Array.isArray(mesh.material)); assert.equal(mesh.material.length, 2);
  assert.equal(mesh.geometry.groups.length, 2, 'Count actual draw groups, not just material identities');
  assert.deepEqual(mesh.geometry.groups.map(group => group.materialIndex).sort(), [0, 1]);
  let end = 0;
  for (const group of mesh.geometry.groups) {
    assert.equal(group.start, end); assert.ok(group.count > 0); assert.equal(group.count % 3, 0);
    assert.ok(mesh.material[group.materialIndex]?.visible); end += group.count;
  }
  assert.equal(end, mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count);
}

function materialState(material) {
  return { color: material.color.toArray(), roughness: material.roughness, metalness: material.metalness,
    vertexColors: material.vertexColors, normalScale: material.normalScale?.toArray(), envMapIntensity: material.envMapIntensity,
    version: material.version,
    maps: MAPS.map(key => material[key]), userData: JSON.stringify(material.userData) };
}

function watchAssets(geometries, materials) {
  const geometryStates = [...new Set(geometries)].map(geometry => ({ geometry,
    bounds: [geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()],
    groups: geometry.groups.map(group => ({ ...group })),
    buffers: Object.entries(geometry.attributes).map(([name, attribute]) => ({
      name, attribute, array: attribute.array, contents: attribute.array.slice(), version: attribute.version,
    })),
  }));
  const materialStates = new Map([...new Set(materials)].map(material => [material, materialState(material)]));
  const textures = [...new Set([...materialStates.keys()].flatMap(material => MAPS.map(key => material[key]).filter(Boolean)))];
  const textureStates = textures.map(texture => ({ texture, version: texture.version, image: texture.image,
    data: texture.image?.data, contents: texture.image?.data?.slice() }));
  const resources = new Set([...geometryStates.map(state => state.geometry), ...materialStates.keys(), ...textures]);
  const disposed = [], listener = event => disposed.push(event.target);
  for (const resource of resources) resource.addEventListener('dispose', listener);
  return {
    verify() {
      assert.deepEqual(disposed, [], 'Drop construction and collection never dispose shared assets');
      for (const { geometry, bounds, groups, buffers } of geometryStates) {
        assert.deepEqual([geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()], bounds);
        assert.deepEqual(geometry.groups, groups);
        for (const { name, attribute, array, contents, version } of buffers) {
          assert.equal(geometry.attributes[name], attribute); assert.equal(attribute.array, array);
          assert.equal(attribute.version, version, `${name}: no shared-buffer upload was requested`);
          assert.deepEqual(attribute.array, contents, `${name}: source vertices and surface data remain byte-identical`);
        }
      }
      for (const [material, state] of materialStates) assert.deepEqual(materialState(material), state);
      for (const { texture, version, image, data, contents } of textureStates) {
        assert.equal(texture.version, version); assert.equal(texture.image, image); assert.equal(texture.image?.data, data);
        if (contents) assert.deepEqual(data, contents, 'Shared finish pixels remain unchanged');
      }
    },
    release() { for (const resource of resources) resource.removeEventListener('dispose', listener); },
  };
}

test('production drop builds reuse centered NPC firearms and the unposed authored knife in two draws', () => {
  const { WeaponDrops } = weaponHarness(), finishes = getWeaponFinishes();
  const sources = new Map(FIREARMS.map(type => [type, { geometry: getNPCFirearmGeometry(type),
    materials: getNPCFirearmMaterials(type, WeaponDrops._mat(type)) }]));
  const knifeSource = createHeroWeapon('knife'); knifeSource.updateMatrixWorld(true);
  const knifeSize = new THREE.Box3().setFromObject(knifeSource, true).getSize(new THREE.Vector3());
  const knifeTriangles = knifeSource.children.reduce((sum, mesh) =>
    sum + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3, 0);
  const sourceMaterials = TYPES.map(type => WeaponDrops._mat(type));
  const watch = watchAssets([...sources.values()].map(source => source.geometry),
    [...sourceMaterials, ...Object.values(finishes), ...[...sources.values()].flatMap(source => source.materials)]);
  try {
    for (const type of TYPES) {
      const first = WeaponDrops._build(type), second = WeaponDrops._build(type);
      const mesh = onlyMesh(first), copy = onlyMesh(second);
      assert.notEqual(first, second); assert.notEqual(mesh, copy);
      assert.equal(mesh.geometry, copy.geometry); assert.equal(mesh.material, copy.material);
      assert.deepEqual(first.position.toArray(), [0, 0, 0]); assert.deepEqual(first.scale.toArray(), [1, 1, 1]);
      assert.deepEqual(mesh.scale.toArray(), [1, 1, 1]); assertTwoDraws(mesh);
      assert.equal(mesh.layers.mask, 1, 'World drops do not inherit the first-person rendering layer');
      assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, false);
      assert.notEqual(mesh.isSkinnedMesh, true); assert.deepEqual(mesh.geometry.morphAttributes, {});
      assert.equal(first.userData.heroWeapon?.readyAngle, undefined, 'No first-person ready pose is copied');
      first.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(first, true), size = bounds.getSize(new THREE.Vector3());
      near(bounds.getCenter(new THREE.Vector3()).length(), 0, `${type}: placement origin is the complete local bounds center`);
      if (type === 'knife') {
        assert.equal(mesh.geometry.attributes.position.count / 3, 444);
        assert.equal(mesh.geometry.attributes.position.count / 3, knifeTriangles, 'The weapon-only knife retains all authored geometry');
        for (const axis of ['x', 'y', 'z']) near(size[axis], knifeSize[axis], `knife: unchanged ${axis} extent`);
        assert.ok(mesh.material.some(material => MAPS.every(key => material[key] === finishes.wood[key])), 'Wood keeps its own nonmetal finish maps');
        assert.ok(mesh.material.some(material => MAPS.every(key => material[key] === finishes.blade[key])), 'The blade retains its metal finish maps');
      } else {
        const source = sources.get(type), sourceSize = source.geometry.boundingBox.getSize(new THREE.Vector3());
        assert.equal(mesh.geometry, source.geometry, `${type}: the exact NPC buffer is reused`);
        assert.notEqual(mesh.material, source.materials, `${type}: drops own their cached finish variant`);
        const steel = mesh.material[0];
        assert.notEqual(steel, source.materials[0], 'Drop steel cannot modify the NPC metal material');
        assert.notEqual(steel, finishes.metalDark, 'Drop steel cannot modify the shared dark-metal finish');
        assert.equal(mesh.material[1], source.materials[1], `${type}: the exact NPC wood or polymer material is reused`);
        assert.equal(steel.name, 'drop-weapon-steel');
        for (const key of MAPS) assert.equal(steel[key], finishes.metalDark[key], `${type}: ${key} reuses the existing dark-metal map`);
        for (const channel of ['r', 'g', 'b']) near(steel.color[channel], source.materials[0].color[channel] * 1.08,
          `${type}: the drop-only steel tint preserves the NPC base color`);
        assert.equal(steel.metalness, 0.85); assert.equal(steel.envMapIntensity, 0.70); assert.equal(steel.roughness, 1);
        const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
        near(axis.x, 1, `${type}: NPC +Z becomes drop +X`); near(axis.y, 0, 'level axis'); near(axis.z, 0, 'no residual forward axis');
        near(size.x, sourceSize.z, `${type}: full weapon length is retained`);
        near(size.y, sourceSize.y, `${type}: height is not rescaled`);
        near(size.z, sourceSize.x, `${type}: width is not rescaled`);
      }
    }
    watch.verify();
  } finally {
    watch.release(); for (const mesh of knifeSource.children) mesh.geometry.dispose();
  }
});

test('production drop overflow and clear reuse the fixed 16 halos without replacing or disposing asset caches', () => {
  const h = weaponHarness({ colliders: { list: [floor()] } }), { WeaponDrops, World, GameTime } = h;
  WeaponDrops._initHaloPool();
  const lights = Array.from(WeaponDrops._haloPool, slot => slot.light), prototypes = new Map();
  assert.equal(WeaponDrops._haloPoolSize, 16); assert.equal(lights.length, 16);
  WeaponDrops._initHaloPool();
  assert.equal(World.children.filter(object => object.isPointLight).length, 16, 'Repeated warmup adds no lights');
  for (const type of TYPES) prototypes.set(type, onlyMesh(WeaponDrops._build(type)));
  const watch = watchAssets([...prototypes.values()].map(mesh => mesh.geometry),
    [...Object.values(getWeaponFinishes()), ...TYPES.map(type => WeaponDrops._mat(type)),
      ...[...prototypes.values()].flatMap(mesh => mesh.material)]);
  const spawned = [];
  try {
    for (let index = 0; index < 21; index++) {
      const type = TYPES[index % TYPES.length], ammo = type === 'knife' ? 0 : 7 + index;
      GameTime.elapsed = 11 + index * 0.5;
      const entry = WeaponDrops.spawn((index % 5) * 2, 0, Math.floor(index / 5) * 2, type, ammo);
      spawned.push(entry);
      assert.equal(entry.weaponType, type); assert.equal(entry.ammo, ammo);
      assert.equal(entry.mesh.userData.kind, 'weaponDrop'); assert.equal(entry.mesh.userData.weaponType, type);
      assert.equal(entry.mesh.userData.ammo, ammo); assert.equal(entry.mesh.userData.spawnTime, GameTime.elapsed);
      assert.equal(entry.mesh.userData.floorY, 0); assert.equal(entry.mesh.userData.settled, true);
      near(new THREE.Box3().setFromObject(entry.mesh, true).min.y, 0.006, `${type}: actual spawned geometry rests on the floor`);
      assert.equal(entry.mesh.parent, World); assert.ok(lights.includes(entry.halo));
      assert.equal(entry.halo.intensity, 0.45); assert.equal(entry.halo.visible, true);
      near(entry.halo.position.y - entry.mesh.position.y, 0.15, 'The existing halo offset is retained');
      const mesh = onlyMesh(entry.mesh), reference = prototypes.get(type);
      assert.equal(mesh.geometry, reference.geometry); assert.equal(mesh.material, reference.material);
      assert.equal(WeaponDrops.list.length, Math.min(index + 1, 16));
    }
    for (const old of spawned.slice(0, 5)) {
      assert.equal(old.mesh.parent, null); assert.equal(WeaponDrops.list.includes(old), false, 'Overflow releases the oldest entry');
    }
    const removed = WeaponDrops.list[4]; WeaponDrops.remove(removed);
    assert.equal(removed.mesh.parent, null); assert.equal(removed.halo.intensity, 0); assert.equal(removed.halo.visible, false);
    WeaponDrops.clearAll();
    assert.equal(WeaponDrops.list.length, 0);
    assert.equal(World.children.filter(object => object.isPointLight).length, 16);
    for (const slot of WeaponDrops._haloPool) {
      assert.equal(slot.inUse, false); assert.equal(slot.light.intensity, 0); assert.equal(slot.light.visible, false);
      assert.equal(slot.light.position.y, -200);
    }
    for (const type of TYPES) {
      const entry = WeaponDrops.spawn(0, 0, 0, type, type === 'knife' ? 0 : 9), reference = prototypes.get(type);
      assert.ok(lights.includes(entry.halo)); assert.equal(onlyMesh(entry.mesh).geometry, reference.geometry);
      assert.equal(onlyMesh(entry.mesh).material, reference.material); WeaponDrops.remove(entry);
    }
    watch.verify();
  } finally {
    WeaponDrops.clearAll(); watch.release();
  }
});

test('authored drop meshes preserve real pickup prompts, ammunition payloads, and stale-reference rejection', () => {
  const h = weaponHarness({ colliders: { list: [floor()] } });
  const { Weapons, WeaponDrops, Player, calls } = h;
  WeaponDrops._initHaloPool(); Weapons.init(); Player.pos.set(0, Player._eyeH, 0);
  const first = WeaponDrops.spawn(0, 0, 0, 'pistol', 9);
  assert.equal(weaponPickupPrompt(Weapons.current, first), '[E] PICK UP PISTOL (9)');
  assert.equal(Weapons.findNearestPickup(), first); assert.equal(Weapons.pickup(first), true);
  assert.equal(Weapons.current, 'pistol'); assert.equal(Weapons.loaded, 9); assert.equal(Weapons.reserve, 0);
  const refill = WeaponDrops.spawn(0, 0, 0, 'pistol', 7);
  assert.equal(weaponPickupPrompt(Weapons.current, refill), '[E] +7 PISTOL AMMO');
  assert.equal(Weapons.pickup(refill), true); assert.equal(Weapons.loaded, 9); assert.equal(Weapons.reserve, 7);
  assert.equal(Weapons.pickup(first), false); assert.equal(Weapons.pickup(refill), false);
  const knife = WeaponDrops.spawn(0, 0, 0, 'knife', 0);
  assert.equal(weaponPickupPrompt(Weapons.current, knife), '[E] PICK UP KNIFE');
  assert.equal(Weapons.pickup(knife), true); assert.equal(Weapons.current, 'knife');
  assert.equal(WeaponDrops.list.length, 1, 'Swapping retains the dropped pistol instead of losing its ammunition');
  const returnedPistol = WeaponDrops.list[0];
  assert.equal(returnedPistol.weaponType, 'pistol'); assert.equal(returnedPistol.ammo, 16);
  assert.equal(onlyMesh(returnedPistol.mesh).geometry, getNPCFirearmGeometry('pistol'));
  assert.equal(calls.pickups, 3);
  WeaponDrops.clearAll();
  assert.equal(Weapons.pickup(returnedPistol), false); assert.equal(calls.pickups, 3);
});
