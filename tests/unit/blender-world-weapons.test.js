import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Box3, Raycaster, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadAuthoredWorldWeapons, getAuthoredWorldWeaponGeometry, getAuthoredWorldWeaponsStatus } from '../../src/render/authored-world-weapons.js';
import { getNPCFirearmGeometry, getNPCFirearmMaterials } from '../../src/render/npc-firearms.js';
import { createBatAsset, BAT_DIMENSIONS } from '../../src/render/bat-asset.js';
import { createHeldWeapon, createHumanoidRig, attachHeldWeapon, updateHumanoidPose } from '../../src/render/humanoid-rig.js';
import { createDroppedWeaponAsset } from '../../src/render/dropped-weapon-assets.js';
import { createFirstPersonBat, poseFirstPersonBat } from '../../src/render/first-person-bat.js';
import { placeWeaponDrop } from '../../src/game/drop-placement.js';

const CAPS = { pistol: 856, shotgun: 1172, smg: 1280, machinegun: 1320, bat: 1300 };
const MUZZLES = { pistol: .22, shotgun: .735, smg: .41, machinegun: .665 };
const SUPPORT = { pistol: [-.039, -.016, -.012], shotgun: [0, -.028, .270], smg: [0, -.019, .184], machinegun: [0, -.019, .220] };
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} versus ${expected}`);

test('prepared Blender world weapons preserve real shared weapon, grip and pickup contracts', async t => {
  const path = new URL('../../public/assets/models/world-weapons/world-weapons.glb', import.meta.url);
  const bytes = await readFile(path), buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  const loader = new GLTFLoader();
  const parse = () => loader.parseAsync(buffer, '');
  const baseline = Object.fromEntries(Object.keys(MUZZLES).map(type => [type, getNPCFirearmGeometry(type)]));
  const baselineBat = createBatAsset();
  const runtimeMaterials = Object.fromEntries(Object.keys(MUZZLES).map(type => [type, getNPCFirearmMaterials(type)]));

  await t.test('a failed load and malformed geometry keep the working fallback, then one cached load prepares every type', async () => {
    assert.equal(getAuthoredWorldWeaponGeometry('pistol'), null);
    const failed = await loadAuthoredWorldWeapons({ loader: { loadAsync: async () => { throw new Error('offline fixture'); } } });
    assert.equal(failed.state, 'fallback');
    assert.equal(getNPCFirearmGeometry('pistol'), baseline.pistol);
    const invalid = await parse();
    let invalidMesh;
    invalid.scene.traverse(mesh => { if (mesh.isMesh && !invalidMesh) invalidMesh = mesh; });
    invalidMesh.geometry.deleteAttribute('uv');
    const malformed = await loadAuthoredWorldWeapons({ loader: { loadAsync: async () => invalid } });
    assert.equal(malformed.state, 'fallback');
    assert.match(malformed.error, /uv/);
    let requests = 0;
    const injected = { loadAsync: () => { requests++; return parse(); } };
    const results = await Promise.all([loadAuthoredWorldWeapons({ loader: injected }), loadAuthoredWorldWeapons({ loader: injected })]);
    assert.equal(requests, 1);
    for (const result of results) assert.equal(result.state, 'ready', result.error);
    await loadAuthoredWorldWeapons({ loader: injected });
    assert.equal(requests, 1);
    assert.equal(getAuthoredWorldWeaponsStatus().textures, 0);
  });

  await t.test('the delivery stays geometry-only and records the exact GLB and editable source', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../public/assets/models/world-weapons/manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.delivery.glbBytes, bytes.length);
    assert.equal(manifest.delivery.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(json.images?.length ?? 0, 0);
    assert.equal(json.textures?.length ?? 0, 0);
    assert.equal(json.skins?.length ?? 0, 0);
    assert.equal(json.animations?.length ?? 0, 0);
    assert.equal(json.extensionsRequired?.length ?? 0, 0);
    assert.ok(bytes.length < 750_000);
    for (const assetPath of [manifest.sourceFile, manifest.rebuild, manifest.sourceExport]) {
      assert.ok((await stat(new URL(`../../${assetPath}`, import.meta.url))).size > 0);
    }
    assert.deepEqual(manifest.geometry.triangles, getAuthoredWorldWeaponsStatus().triangles);
  });

  await t.test('all delivered buffers have finite normals and UVs within the original per-type triangle and draw budgets', () => {
    for (const type of Object.keys(CAPS)) {
      const geometries = type === 'bat' ? ['bat-wood', 'bat-grip'].map(part => getAuthoredWorldWeaponGeometry(type, part)) : [getAuthoredWorldWeaponGeometry(type)];
      let triangles = 0;
      for (const geometry of geometries) {
        assert.ok(geometry);
        triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
        for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) {
          const attribute = geometry.attributes[name];
          assert.equal(attribute.itemSize, size, 'Attribute layout matches the existing shader variant');
          assert.ok(attribute.array.every(Number.isFinite), `${type}: finite ${name}`);
          assert.equal(attribute.count, geometry.attributes.position.count);
        }
        const normal = geometry.attributes.normal;
        for (let i = 0; i < normal.count; i++) near(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)), 1, .003);
      }
      assert.ok(triangles <= CAPS[type], `${type}: ${triangles}`);
      if (type !== 'bat') {
        assert.equal(geometries[0].groups.length, 2);
        assert.equal(geometries[0].userData.npcWeapon.triangles, triangles);
        assert.equal(getNPCFirearmGeometry(type), geometries[0]);
        assert.notEqual(geometries[0], baseline[type]);
        assert.equal(getNPCFirearmMaterials(type), runtimeMaterials[type], 'Original shared finish materials are reused');
      }
    }
  });

  await t.test('real muzzle crowns retain open bores and receive new geometric edge chamfers', () => {
    const radii = { pistol: .012, shotgun: .020, smg: .019, machinegun: .022 };
    for (const [type, muzzle] of Object.entries(MUZZLES)) {
      const gun = createHeldWeapon(type); gun.updateMatrixWorld(true);
      assert.deepEqual(gun.userData.muzzle.position.toArray(), [0, .041, muzzle]);
      assert.deepEqual(gun.userData.anchors.supportHand.position.toArray(), SUPPORT[type]);
      const ray = new Raycaster(new Vector3(0, .041, muzzle + .05), new Vector3(0, 0, -1));
      const bore = ray.intersectObject(gun, false)[0];
      assert.ok(bore && muzzle - bore.point.z > .03, `${type}: bore remains hollow`);
      // Probe the cardinal upper crown so the radial tessellation cannot hide
      // an accidentally capped bore or the authored edge break.
      ray.ray.origin.y = .041 + radii[type] - .0002;
      const bevel = ray.intersectObject(gun, false)[0];
      assert.ok(bevel && bevel.point.z < muzzle - .0001 && bevel.point.z > muzzle - .0012, `${type}: actual muzzle chamfer`);
      ray.set(new Vector3(-.1, -.031, .042), new Vector3(1, 0, 0));
      assert.equal(ray.intersectObject(gun, false).length, 0, `${type}: open trigger`);
      ray.set(new Vector3(-.1, .038, .09), new Vector3(1, 0, 0));
      const bolt = ray.intersectObject(gun, false)[0];
      assert.ok(bolt && bolt.point.x > -.034 && bolt.point.x < -.019, `${type}: recessed bolt retained`);
    }
  });

  await t.test('NPC attachment, two-hand aim and drops share the exact unchanged prepared buffers', () => {
    for (const type of Object.keys(MUZZLES)) {
      const actor = createHumanoidRig({ height: 1.78, build: 1, kind: 'gunman' });
      const gun = attachHeldWeapon(actor, type), geometry = gun.geometry;
      const vertices = geometry.attributes.position.array.slice();
      const drop = createDroppedWeaponAsset(type), dropMesh = drop.getObjectByName(`drop-model:${type}`);
      assert.equal(dropMesh.geometry, geometry);
      assert.deepEqual(dropMesh.scale.toArray(), [1, 1, 1]);
      for (const aim of [0, .5, 1]) {
        for (let frame = 0; frame < 60; frame++) updateHumanoidPose(actor, { mode: 'ranged', aim, alert: 1, speed: 2 }, 1 / 60);
        actor.updateMatrixWorld(true);
        const support = gun.userData.anchors.supportHand.getWorldPosition(new Vector3());
        near(support.distanceTo(actor.userData.rig.anchors.gripL.getWorldPosition(new Vector3())), 0);
      }
      // Match the existing drop placement orientation from WeaponDrops._build.
      drop.rotation.x = Math.PI / 2;
      const floor = new Box3(new Vector3(-3, -.2, -3), new Vector3(3, 0, 3));
      const placed = placeWeaponDrop(drop, type, { x: 0, y: 1, z: 0 }, [floor]);
      assert.equal(placed.settled, true);
      near(new Box3().setFromObject(drop).min.y, .006);
      assert.deepEqual(geometry.attributes.position.array, vertices, 'Actor motion and drop placement cannot mutate pooled buffers');
    }
  });

  await t.test('the refined bat keeps its full-size anchors, shared finishes and first-person swing', () => {
    const bat = createBatAsset(), other = createBatAsset({ castShadow: false }), held = createFirstPersonBat();
    const wood = bat.getObjectByName('bat-wood'), bounds = new Box3().setFromObject(bat);
    assert.notEqual(wood.geometry, baselineBat.getObjectByName('bat-wood').geometry);
    assert.equal(wood.material, baselineBat.getObjectByName('bat-wood').material);
    assert.equal(wood.geometry, other.getObjectByName('bat-wood').geometry);
    assert.equal(wood.geometry, held.userData.firstPersonBat.asset.getObjectByName('bat-wood').geometry);
    near(bounds.min.z, BAT_DIMENSIONS.knobZ); near(bounds.max.z, BAT_DIMENSIONS.tipZ);
    near(bounds.max.x - bounds.min.x, BAT_DIMENSIONS.barrelRadius * 2);
    const position = wood.geometry.attributes.position, uv = wood.geometry.attributes.uv;
    const radial = new Set();
    for (let i = 0; i < position.count; i++) {
      near(uv.getY(i), (position.getZ(i) + .14) / .84);
      if (Math.abs(position.getZ(i) - .62) < 1e-6) radial.add(`${position.getX(i).toFixed(6)}:${position.getY(i).toFixed(6)}`);
    }
    assert.equal(radial.size, 28, 'The visible body uses a finer radial contour');
    let triangles = 0, draws = 0;
    held.traverse(mesh => { if (mesh.isMesh) { draws++; triangles += mesh.geometry.index.count / 3; } });
    assert.equal(draws, 8); assert.ok(triangles <= 10_000);
    const buffers = held.userData.firstPersonBat.asset.children.filter(child => child.isMesh).map(mesh => mesh.geometry);
    for (const phase of [0, .25, .4, .6, 1]) poseFirstPersonBat(held, 1 - phase);
    assert.deepEqual(held.userData.firstPersonBat.asset.children.filter(child => child.isMesh).map(mesh => mesh.geometry), buffers);
  });
});
