import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Box3, Group, Raycaster, Vector3, Texture, FrontSide, SRGBColorSpace, NoColorSpace } from 'three';
import { inspectWeaponsAssets, WEAPON_ASSET_TYPES } from '../../tools/validate-weapons-assets.mjs';
import { createAuthoredWeapon, loadAuthoredWeapons } from '../../src/render/authored-weapons.js';
import { loadAuthoredHandSurfaces } from '../../src/render/authored-hand-surfaces.js';
import { batchStaticWeaponParts } from '../../src/render/weapon-finishes.js';
import { addHeroWeaponHands } from '../../src/render/hero-weapon-grips.js';
import { getViewModelMuzzle, VIEW_MODEL_LAYER } from '../../src/render/viewmodel.js';
import { weaponHarness } from './helpers/weapon-harness.js';
import { inspectHeroGripFit } from '../../scripts/inspect-hero-grip-fit.mjs';
import { verifyAuthoredKnifeMotion, verifyAuthoredWeaponCombatReuse } from './helpers/authored-weapons-motion.js';

// Existing complete viewmodel envelopes, including the player's fitted hands.
const CONTRACTS = {
  smg: { triangles: 12500, min: [-0.1568459271, -0.2953522435, -0.364], max: [0.0827459271, 0.10075, 0.515485926], muzzle: [0.28, 0.02, 0], radius: 0.013 },
  shotgun: { triangles: 13200, min: [-0.1568459271, -0.2953522435, -0.65], max: [0.13, 0.0845, 0.515485926], muzzle: [0.5, 0.03, 0], radius: 0.021 },
  machinegun: { triangles: 13200, min: [-0.1568459271, -0.2953522435, -0.767], max: [0.0827459271, 0.1235, 0.515485926], muzzle: [0.59, 0.03, 0], radius: 0.023 },
  knife: { triangles: 5000, min: [-0.16, -0.2953522435, -0.3126784609], max: [0.0827459271, 0.08, 0.515485926] },
};
const near = (actual, expected, message, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} versus ${expected}`);
const floats = attribute => attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;

test('the shipped Blender weapon catalog preserves complete held-weapon behavior', async t => {
  // Production boot awaits both catalogs before constructing any held model.
  // Exercise the imported grip surfaces together with the imported weapons.
  const handBytes = await readFile(new URL('../../public/assets/models/hands/hands.bin', import.meta.url));
  const handStatus = await loadAuthoredHandSurfaces({ finishLoader: { loadAsync: async () => new Texture({ width: 512, height: 512 }) }, fetcher: async () => ({ ok: true,
    arrayBuffer: async () => handBytes.buffer.slice(handBytes.byteOffset, handBytes.byteOffset + handBytes.byteLength) }) });
  assert.equal(handStatus.state, 'ready', handStatus.reason);
  const asset = await inspectWeaponsAssets();

  await t.test('the self-contained catalog shares a bounded set of finishes and matches its delivery manifest', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../public/assets/models/weapons/manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.source, 'original-blender-authored');
    assert.ok(asset.bytes.length <= 4 * 1024 * 1024, 'Four weapons remain a bounded startup download');
    assert.equal(manifest.delivery.glbBytes, asset.bytes.length);
    assert.equal(manifest.delivery.sha256, createHash('sha256').update(asset.bytes).digest('hex'));
    assert.equal(manifest.geometry.triangles, asset.summary.triangles);
    assert.equal(manifest.geometry.materialGroups, asset.materials.size);
    assert.equal(manifest.delivery.embeddedImages, asset.images.length);
    assert.deepEqual(manifest.delivery.runtimeExternalDependencies, []);
    assert.ok(asset.materials.size <= 3, 'The whole catalog shares three finish identities');
    assert.equal(asset.gltf.animations.length, 0); assert.equal(asset.json.skins?.length ?? 0, 0);
    assert.equal(asset.json.extensionsRequired?.length ?? 0, 0, 'No runtime decoder or extension dependency');
    assert.ok(asset.images.length > 0 && asset.images.length <= 6);
    for (const image of asset.images) assert.ok(image.width <= 512 && image.height <= 512);
    const texturePixels = asset.images.reduce((sum, image) => sum + image.width * image.height, 0);
    assert.ok(texturePixels <= 6 * 256 * 256, 'Aggregate finishes remain within the shared two-MiB texture allocation');
    near(manifest.delivery.textureRgba8BytesWithMipmapsEstimate, texturePixels * 4 * 4 / 3, 'Reported texture allocation estimate', 1);
    for (const type of WEAPON_ASSET_TYPES) {
      const actual = asset.weapons[type], declared = manifest.weapons[type];
      assert.ok(actual.root && actual.meshes.length, `${type}: named exported root and real draw primitives`);
      assert.equal(declared.geometry.triangles, actual.summary.triangles);
      assert.equal(declared.geometry.exportedVertices, actual.summary.vertices);
      assert.equal(declared.geometry.meshParts, actual.meshes.length);
      assert.equal(declared.geometry.materialGroups, actual.materials.size);
      assert.deepEqual(declared.bounds, actual.summary.bounds);
      if (CONTRACTS[type].muzzle) assert.deepEqual(declared.muzzle, CONTRACTS[type].muzzle);
    }
    for (const path of [manifest.sourceFile, manifest.rebuild, manifest.sourceExport, manifest.sourceGeometry]) {
      const info = await stat(new URL(`../../${path}`, import.meta.url));
      assert.ok(info.isFile() && info.size > 0, 'Editable project and deterministic preparation sources accompany the runtime assets');
    }
    const source = await readFile(new URL(`../../${manifest.sourceGeometry}`, import.meta.url));
    assert.equal(manifest.sourceGeometrySha256, createHash('sha256').update(source).digest('hex'));
    for (const image of manifest.textures) {
      const bytes = await readFile(new URL(`../../${image.path}`, import.meta.url));
      assert.equal(bytes.length, image.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
    }
  });

  await t.test('the exported surfaces have unit normals, active colors, compatible charts and useful UV triangles', () => {
    const tinted = new Set(), layouts = new Map(), point = [new Vector3(), new Vector3(), new Vector3()];
    for (const mesh of asset.meshes) {
      assert.notEqual(mesh.isSkinnedMesh, true); assert.deepEqual(mesh.geometry.morphAttributes, {});
      const { position, normal, uv, color } = mesh.geometry.attributes, index = mesh.geometry.index;
      assert.ok(position && normal && uv && color, `${mesh.name}: complete exported surface data`);
      assert.equal(position.count, normal.count); assert.equal(position.count, uv.count); assert.equal(position.count, color.count);
      assert.equal(mesh.material.vertexColors, true, 'The renderer uses exported COLOR_0 surface tints');
      const layout = Object.keys(mesh.geometry.attributes).sort();
      if (layouts.has(mesh.material)) assert.deepEqual(layout, layouts.get(mesh.material), 'Shared finishes have compatible vertex charts');
      layouts.set(mesh.material, layout);
      for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
        assert.ok(floats(attribute).every(Number.isFinite), `${mesh.name}: finite ${name}`);
      }
      for (let i = 0; i < normal.count; i++) {
        near(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)), 1, `${mesh.name}: unit shading normal`, 0.002);
        for (const value of [color.getX(i), color.getY(i), color.getZ(i)]) {
          assert.ok(value >= 0 && value <= 1, 'Normalized linear tint');
          if (value < 0.9) tinted.add(mesh.material);
        }
      }
      if (index) assert.ok(floats(index).every(vertex => vertex >= 0 && vertex < position.count));
      const count = index?.count ?? position.count; assert.equal(count % 3, 0);
      let nondegenerate = 0, useful = 0;
      for (let i = 0; i < count; i += 3) {
        const ids = [0, 1, 2].map(corner => index ? index.getX(i + corner) : i + corner);
        ids.forEach((id, corner) => point[corner].fromBufferAttribute(position, id));
        if (point[1].sub(point[0]).cross(point[2].sub(point[0])).lengthSq() <= 1e-18) continue;
        nondegenerate++;
        const [a, b, c] = ids;
        const area = (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a))
          - (uv.getX(c) - uv.getX(a)) * (uv.getY(b) - uv.getY(a));
        if (Math.abs(area) > 1e-12) useful++;
      }
      assert.ok(nondegenerate > 0, `${mesh.name}: real surface area`);
      assert.ok(useful >= nondegenerate * 0.99, `${mesh.name}: ${useful}/${nondegenerate} noncollapsed UV triangles`);
    }
    for (const material of asset.materials) {
      assert.equal(material.side, FrontSide); assert.equal(material.transparent, false);
      if (!material.map) continue;
      assert.ok(tinted.has(material), 'Each textured finish retains visible material-zone tint differences');
      assert.equal(material.map.colorSpace, SRGBColorSpace);
      assert.equal(material.normalMap.colorSpace, NoColorSpace);
      assert.equal(material.roughnessMap.colorSpace, NoColorSpace);
      assert.equal(material.roughnessMap, material.metalnessMap);
    }
  });

  const loaded = await loadAuthoredWeapons({ loader: { loadAsync: () => asset.loader.parseAsync(asset.arrayBuffer, '') } });
  await t.test('production preload accepts every shipped entry before synchronous weapon assembly', () => {
    assert.equal(loaded.state, 'ready', JSON.stringify(loaded.types));
    for (const type of WEAPON_ASSET_TYPES) assert.equal(loaded.types[type].state, 'ready');
  });
  if (loaded.state !== 'ready') return;

  await t.test('each complete production weapon retains its framing envelope, fixed anchors and existing draw/triangle limits', () => {
    const { makeWeaponViewModel } = weaponHarness();
    for (const [type, contract] of Object.entries(CONTRACTS)) {
      const assembly = createAuthoredWeapon(type); addHeroWeaponHands(assembly, type);
      const handParts = assembly.children.filter(mesh => /^(primary|support)-/.test(mesh.name));
      assert.equal(handParts.length, type === 'knife' ? 2 : 4, 'The production assembly includes each fitted hand and sleeve');
      for (const mesh of handParts) assert.equal(mesh.geometry.userData.source, 'original-blender-authored',
        `${type}: ${mesh.name} uses the preloaded Blender surface before material batching`);
      const model = makeWeaponViewModel(type), metrics = model.userData.presentation;
      assert.equal(model.userData.heroWeapon.source, 'original-blender-authored');
      assert.ok(metrics.triangles <= contract.triangles, `${type}: complete held triangle cap`);
      assert.ok(metrics.drawCalls <= 5, `${type}: at most three authored finishes plus two hand finishes`);
      assert.equal(metrics.sourceTriangles, metrics.triangles, 'Batching loses no surfaces');
      assert.equal(model.children.length, metrics.drawCalls);
      assert.equal(model.userData.heroWeapon.grips.length, type === 'knife' ? 1 : 2);
      if (contract.muzzle) assert.deepEqual(model.userData.muzzle, contract.muzzle);
      const bounds = new Box3().setFromObject(model, true);
      for (const [index, axis] of ['x', 'y', 'z'].entries()) {
        assert.ok(bounds.min[axis] >= contract.min[index] - 1e-6, `${type}: lower ${axis} framing boundary`);
        assert.ok(bounds.max[axis] <= contract.max[index] + 1e-6, `${type}: upper ${axis} framing boundary`);
      }
      for (const mesh of model.children) {
        assert.equal(mesh.layers.mask, 1 << VIEW_MODEL_LAYER);
        assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false);
        assert.equal(mesh.material.depthWrite, true); assert.equal(mesh.material.depthTest, true);
      }
    }
  });

  await t.test('exported trigger guards, ejection chambers, panel recesses and barrel crowns remain real geometry', () => {
    const ray = new Raycaster(); ray.near = 0; ray.far = 0.20;
    for (const [type, { muzzle, radius }] of Object.entries(CONTRACTS)) {
      if (!muzzle) continue;
      const model = createAuthoredWeapon(type); model.updateMatrixWorld(true);
      const { triggerOpening: opening, recess, panels } = model.userData.heroWeapon;
      assert.ok(opening && recess && panels?.length, `${type}: mechanical metadata survives import`);
      ray.set(new Vector3(opening[0], opening[1], -0.1), new Vector3(0, 0, 1));
      assert.equal(ray.intersectObject(model, true).length, 0, `${type}: trigger space is physically open`);
      ray.set(new Vector3(...recess.point).add(new Vector3(0, 0, -0.02)), new Vector3(0, 0, 1));
      const bolt = ray.intersectObject(model, true)[0];
      assert.ok(bolt, `${type}: chamber contains a visible recessed bolt`);
      assert.match(bolt.object.name, /recessed-bolt/);
      // The existing shell's inset includes a 1 mm wall setback beyond its
      // nominal pocket depth; preserve that visibly recessed chamber range.
      assert.ok(bolt.distance - 0.020 >= recess.depth - 0.0001
        && bolt.distance - 0.020 <= recess.depth + 0.002, `${type}: actual ejection chamber remains recessed`);
      for (const panel of panels) {
        ray.set(new Vector3(...panel.point).add(new Vector3(0, 0, -0.02)), new Vector3(0, 0, 1));
        const hit = ray.intersectObject(model, true)[0];
        assert.ok(hit?.object.name.includes(`${panel.name}-floor`), `${type}: ${panel.name} has a visible floor`);
        near(hit.distance - 0.020, panel.depth, `${type}: ${panel.name} depth`, 0.0001);
      }
      ray.set(new Vector3(muzzle[0] + 0.02, muzzle[1], 0), new Vector3(-1, 0, 0));
      const bore = ray.intersectObject(model, true)[0];
      assert.ok(bore && bore.point.x < muzzle[0] - 0.02, `${type}: an open bore continues inside the barrel`);
      ray.set(new Vector3(muzzle[0] + 0.02, muzzle[1] + radius * 0.9, 0), new Vector3(-1, 0, 0));
      const crown = ray.intersectObject(model, true)[0]; assert.ok(crown, `${type}: crown surrounds the bore`);
      near(crown.point.x, muzzle[0], `${type}: crown meets the unchanged muzzle effect anchor`, 0.0001);
    }
  });

  await t.test('muzzle effects still follow the actual held root in hip and aimed camera transforms', () => {
    const { camera, makeWeaponViewModel } = weaponHarness(); camera.position.set(10, 2, -3);
    const holder = new Group(); holder.position.set(0.22, -0.22, -0.36); camera.add(holder);
    for (const [type, { muzzle }] of Object.entries(CONTRACTS)) {
      if (!muzzle) continue;
      const model = makeWeaponViewModel(type); holder.add(model);
      for (const handX of [0.22, 0]) {
        holder.position.x = handX;
        const expected = new Vector3(10 + handX, 1.78 + muzzle[1] * 1.3, -3.36 - muzzle[0] * 1.3);
        assert.ok(getViewModelMuzzle(model, new Vector3()).distanceTo(expected) < 1e-8, `${type}: attached muzzle effect`);
      }
      holder.remove(model);
    }
  });

  await t.test('the actual imported grips retain finger contact without burying the palm or wrist', () => {
    for (const type of WEAPON_ASSET_TYPES) {
      const reports = inspectHeroGripFit(type, root => {
        // Replace the diagnostic's entire model with an actual imported asset
        // and the same production hands/ready pose used by the real factory.
        root.clear(); const authored = createAuthoredWeapon(type); addHeroWeaponHands(authored, type);
        root.add(...authored.children.slice());
      });
      assert.equal(reports.length, type === 'knife' ? 1 : 2);
      for (const fit of reports) {
        assert.ok(fit.inside > 0, `${type}: shallow finger-pad contact still reaches the fitted held surface`);
        assert.equal(fit.rearPalmOrWristInside, 0, `${type}: palm/wrist remain outside the weapon`);
        assert.ok(fit.maximumDepthMm < 5, `${type}: only shallow contacts (${fit.maximumDepthMm}mm)`);
        assert.ok(fit.deeperThan3mm < fit.vertices * 0.025, `${type}: no substantial buried hand surface`);
      }
    }
  });

  await t.test('rear notches remain physically open and ceramic front sights remain visible at nine camera shapes', () => {
    const { camera, makeWeaponViewModel } = weaponHarness(), holder = new Group();
    holder.position.set(0, -0.12, -0.36); camera.add(holder);
    const ray = new Raycaster();
    for (const type of ['smg', 'machinegun']) {
      const raw = createAuthoredWeapon(type), { rear, front } = raw.userData.ironSights;
      raw.updateMatrixWorld(true); ray.layers.set(0);
      const probe = (x, length, y, z) => {
        ray.set(new Vector3(x - length / 2 - 0.002, y, z), new Vector3(1, 0, 0));
        ray.near = 0; ray.far = length + 0.004; return ray.intersectObject(raw, true);
      };
      for (const height of [0.15, 0.5, 0.85]) for (const width of [-0.35, 0, 0.35]) {
        assert.equal(probe(rear.x, rear.length, rear.floor + (rear.top - rear.floor) * height, rear.gap * width).length, 0,
          `${type}: continuous rear sight opening`);
      }
      for (const sign of [-1, 1]) assert.ok(probe(rear.x, rear.length, (rear.floor + rear.top) / 2, sign * (rear.width + rear.gap) / 4).length);
      assert.ok(probe(rear.x, rear.length, (rear.bottom + rear.floor) / 2, 0).length);
      assert.ok(probe(front.x, front.length, front.top - 0.001, 0).length);
      const ceramic = raw.getObjectByName(`${type}-front-ceramic-insert`); assert.ok(ceramic);
      const ceramicBounds = new Box3().setFromObject(ceramic, true), center = ceramicBounds.getCenter(new Vector3());
      ray.set(new Vector3(-1, center.y, center.z), new Vector3(1, 0, 0)); ray.far = 2;
      assert.ok(ray.intersectObject(ceramic).length, `${type}: the single-sided ceramic insert faces the player`);
      const model = makeWeaponViewModel(type); holder.add(model); ray.layers.set(VIEW_MODEL_LAYER);
      for (const fov of [45, 62, 90]) for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
        camera.fov = fov; camera.aspect = aspect; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
        const project = (x, y, z = 0) => model.localToWorld(new Vector3(x, y, z)).project(camera);
        const rearX = rear.x - rear.length / 2, floor = project(rearX, rear.floor), top = project(rearX, rear.top);
        const tip = project(front.x - front.length / 2, front.top - 0.00075);
        assert.ok(tip.y > floor.y + 1e-5 && tip.y < top.y - 1e-5, `${type}: front sight within rear opening`);
        assert.ok(project(front.x, front.top, -front.width / 2).x > project(rearX, rear.floor, -rear.gap / 2).x);
        assert.ok(project(front.x, front.top, front.width / 2).x < project(rearX, rear.floor, rear.gap / 2).x);
        ray.setFromCamera(tip, camera); ray.near = camera.near; ray.far = 2;
        const sightHit = ray.intersectObject(model, true)[0];
        assert.ok(sightHit && model.worldToLocal(sightHit.point.clone()).x >= front.x - front.length / 2 - 0.003,
          `${type}: the real front post is not hidden by receiver geometry`);
        const radius = (ceramicBounds.max.z - ceramicBounds.min.z) / 4;
        for (const [y, z] of [[0, 0], [-radius, 0], [radius, 0], [0, -radius], [0, radius]]) {
          const point = model.localToWorld(center.clone().add(new Vector3(0, y, z))).project(camera);
          ray.setFromCamera(point, camera);
          assert.equal(ray.intersectObject(model, true)[0]?.object.material.name, ceramic.material.name,
            `${type}: a visible patch of the actual ceramic survives the merged aimed mesh`);
        }
        ray.setFromCamera({ x: 0, y: 0 }, camera);
        assert.equal(ray.intersectObject(model, true).length, 0, `${type}: unobstructed central reticle`);
      }
      holder.remove(model);
    }
  });

  await t.test('batching preserves the real UV/color charts and releases only owned instance buffers', () => {
    const textures = new Set(), materials = new Map(); let disposals = 0;
    for (const type of WEAPON_ASSET_TYPES) {
      const first = createAuthoredWeapon(type), second = createAuthoredWeapon(type), expected = new Map();
      for (const [index, source] of first.children.entries()) {
        assert.notEqual(source.geometry, second.children[index].geometry);
        assert.equal(source.material, second.children[index].material);
        if (materials.has(source.material.name)) assert.equal(source.material, materials.get(source.material.name));
        materials.set(source.material.name, source.material);
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) if (source.material[key]) textures.add(source.material[key]);
        const geometry = source.geometry.index ? source.geometry.toNonIndexed() : source.geometry.clone();
        const data = expected.get(source.material) || { uv: [], color: [] };
        data.uv.push(...geometry.attributes.uv.array); data.color.push(...geometry.attributes.color.array);
        expected.set(source.material, data); geometry.dispose();
      }
      const watched = second.children.map(mesh => ({ mesh, position: mesh.geometry.attributes.position.array.slice(),
        uv: mesh.geometry.attributes.uv.array.slice(), color: mesh.geometry.attributes.color.array.slice() }));
      for (const texture of textures) texture.addEventListener('dispose', () => disposals++);
      batchStaticWeaponParts(first);
      for (const mesh of first.children) {
        assert.deepEqual(Array.from(mesh.geometry.attributes.uv.array), expected.get(mesh.material).uv);
        assert.deepEqual(Array.from(mesh.geometry.attributes.color.array), expected.get(mesh.material).color);
        mesh.geometry.dispose();
      }
      const third = createAuthoredWeapon(type);
      for (const [index, { mesh, position, uv, color }] of watched.entries()) {
        assert.deepEqual(mesh.geometry.attributes.position.array, position);
        assert.deepEqual(mesh.geometry.attributes.uv.array, uv); assert.deepEqual(mesh.geometry.attributes.color.array, color);
        assert.deepEqual(third.children[index].geometry.attributes.position.array, position, 'Template buffers survive disposal of other instances');
      }
    }
    assert.equal(materials.size, 3); assert.equal(textures.size, 6); assert.equal(disposals, 0);
  });

  await t.test('world knife pickups reuse the unposed Blender weapon in two centered cached draw groups', () => {
    const raw = createAuthoredWeapon('knife'), rawBounds = new Box3().setFromObject(raw, true);
    const materials = new Set(raw.children.map(mesh => mesh.material));
    const maps = new Map();
    for (const material of materials) for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
      if (material[key]) maps.set(material[key], material[key].version);
    }
    let disposals = 0;
    for (const resource of [...materials, ...maps.keys()]) resource.addEventListener('dispose', () => disposals++);
    const floor = new Box3(new Vector3(-20, -0.2, -20), new Vector3(20, 0, 20));
    const { WeaponDrops } = weaponHarness({ colliders: { list: [floor] } });
    WeaponDrops._initHaloPool();
    const first = WeaponDrops._build('knife'), second = WeaponDrops._build('knife');
    const mesh = first.getObjectByName('drop-model:knife'), copy = second.getObjectByName('drop-model:knife');
    assert.ok(mesh && copy); assert.notEqual(first, second); assert.notEqual(mesh, copy);
    assert.equal(mesh.geometry, copy.geometry); assert.equal(mesh.material, copy.material);
    assert.equal(mesh.geometry.userData.droppedWeapon.source, 'original-blender-authored');
    assert.equal(mesh.geometry.attributes.position.count / 3, 464);
    assert.equal(mesh.geometry.attributes.position.count / 3, asset.weapons.knife.summary.triangles,
      'The pickup contains the complete exported knife, without hands or ready-pose geometry');
    assert.equal(mesh.geometry.groups.length, 2); assert.equal(mesh.material.length, 2);
    let end = 0;
    for (const group of mesh.geometry.groups) {
      assert.equal(group.start, end); assert.ok(group.count > 0 && group.count % 3 === 0);
      assert.ok(materials.has(mesh.material[group.materialIndex]), 'Drops use the exact shared authored finishes');
      end += group.count;
    }
    assert.equal(end, mesh.geometry.attributes.position.count);
    assert.equal(mesh.layers.mask, 1); assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, false);
    assert.equal(first.userData.heroWeapon?.readyAngle, undefined);
    const bounds = new Box3().setFromObject(first, true), size = bounds.getSize(new Vector3());
    near(bounds.getCenter(new Vector3()).length(), 0, 'The immutable raw knife is centered by its placement node');
    const rawSize = rawBounds.getSize(new Vector3());
    for (const axis of ['x', 'y', 'z']) near(size[axis], rawSize[axis], `Unposed knife ${axis} extent`);
    const buffers = Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attribute]) =>
      [name, { array: attribute.array, copy: attribute.array.slice(), version: attribute.version }]));
    const expected = new Map();
    for (const source of raw.children) {
      const geometry = source.geometry.index ? source.geometry.toNonIndexed() : source.geometry.clone();
      const data = expected.get(source.material) || { uv: [], color: [] };
      data.uv.push(...geometry.attributes.uv.array); data.color.push(...geometry.attributes.color.array);
      expected.set(source.material, data); geometry.dispose();
    }
    for (const group of mesh.geometry.groups) {
      const data = expected.get(mesh.material[group.materialIndex]);
      for (const name of ['uv', 'color']) {
        const attribute = mesh.geometry.attributes[name], stride = attribute.itemSize;
        assert.deepEqual(Array.from(attribute.array.slice(group.start * stride, (group.start + group.count) * stride)), data[name]);
      }
    }
    const entry = WeaponDrops.spawn(1, 0, -2, 'knife', 0);
    assert.equal(entry.mesh.getObjectByName('drop-model:knife').geometry, mesh.geometry);
    near(new Box3().setFromObject(entry.mesh, true).min.y, 0.006, 'The authored knife still settles against the physical floor');
    WeaponDrops.remove(entry); WeaponDrops.clearAll(); WeaponDrops._initHaloPool();
    assert.equal(WeaponDrops._build('knife').getObjectByName('drop-model:knife').geometry, mesh.geometry);
    for (const [name, watched] of Object.entries(buffers)) {
      const attribute = mesh.geometry.attributes[name];
      assert.equal(attribute.array, watched.array); assert.equal(attribute.version, watched.version);
      assert.deepEqual(attribute.array, watched.copy, 'Placement and collection preserve cached buffers');
    }
    for (const [texture, version] of maps) assert.equal(texture.version, version);
    assert.equal(disposals, 0, 'Drop construction and collection retain shared authored finishes');
  });

  await t.test('the actual knife blade remains visible and keeps the reticle and near plane clear throughout attack', verifyAuthoredKnifeMotion);
  await t.test('real fire, aim and completed reloads reuse all cached weapon buffers and finish textures', verifyAuthoredWeaponCombatReuse);
});
