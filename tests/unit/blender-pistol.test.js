import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Box3, Float32BufferAttribute, Group, Raycaster, Vector3, SRGBColorSpace, NoColorSpace } from 'three';
import { inspectPistolAsset } from '../../tools/validate-pistol-asset.mjs';
import { createAuthoredPistol, getAuthoredPistolStatus, loadAuthoredPistol } from '../../src/render/authored-pistol.js';
import { batchStaticWeaponParts } from '../../src/render/weapon-finishes.js';
import { getHandMaterials } from '../../src/render/hand-materials.js';
import { getViewModelMuzzle, VIEW_MODEL_LAYER } from '../../src/render/viewmodel.js';
import { weaponHarness } from './helpers/weapon-harness.js';
import { inspectHeroGripFit } from '../../scripts/inspect-hero-grip-fit.mjs';

const MUZZLE = [0.201, 0.04, 0];
const near = (actual, expected, message, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} versus ${expected}`);

test('the shipped Blender pistol survives loading and the actual first-person assembly', async t => {
  const asset = await inspectPistolAsset();

  await t.test('the self-contained file stays inside its geometry, texture, and draw budgets', () => {
    const { json, summary, bounds, gltf } = asset;
    assert.ok(summary.bytes <= 2 * 1024 * 1024, 'The pilot GLB stays below 2 MiB');
    assert.ok(summary.triangles > 500 && summary.triangles <= 4000, 'Actual exported weapon triangle budget');
    assert.ok(summary.sourcePrimitives > 0, 'The file exports drawable mesh primitives');
    assert.ok(summary.materials > 0 && summary.materials <= 3, 'Bound the number of material programs');
    assert.equal(gltf.animations.length, 0, 'The existing rigid controller remains responsible for motion');
    assert.equal(json.skins?.length ?? 0, 0);
    assert.equal(json.extensionsRequired?.length ?? 0, 0, 'No decoder or extension dependency is introduced');
    assert.ok(summary.images.length > 0, 'The finish is authored and embedded with the mesh');
    for (const image of summary.images) {
      assert.ok(image.width > 0 && image.width <= 512 && image.height > 0 && image.height <= 512,
        'Every embedded finish image remains small enough for the pilot');
    }
    assert.ok(summary.images.reduce((sum, image) => sum + image.width * image.height, 0) <= 6 * 512 * 512,
      'Bound aggregate image memory as well as individual texture size');
    const size = bounds.getSize(new Vector3());
    assert.ok(size.x >= 0.26 && size.x <= 0.30, 'The barrel remains along game +X in metres');
    assert.ok(size.y >= 0.18 && size.y <= 0.23, 'The grip remains below the slide along game +Y');
    assert.ok(size.z >= 0.03 && size.z <= 0.06, 'No Blender axis conversion expands the lateral silhouette');
    near(bounds.max.x, MUZZLE[0], 'The actual barrel lip ends at the established muzzle', 0.001);
    for (const material of asset.materials) {
      assert.equal(material.transparent, false, 'No transparent draw or sorting cost');
      if (material.name === 'pistol-finish:ceramic-sight') {
        const sightColor = material.isMeshBasicMaterial ? material.color : material.emissive;
        assert.ok(sightColor && Math.max(...sightColor.toArray()) > 0,
          'The small ceramic sight retains its self-lit cue in dark scenes');
        const sightMeshes = asset.meshes.filter(mesh => mesh.material === material);
        assert.equal(sightMeshes.length, 1);
        assert.equal(sightMeshes[0].name, '25-front-ceramic-dot');
        assert.ok((sightMeshes[0].geometry.index?.count ?? sightMeshes[0].geometry.attributes.position.count) / 3 <= 24,
          'The self-lit finish is limited to the small front-sight dot');
      } else {
        assert.ok(material.map, 'Both weapon surfaces retain their authored albedo');
        assert.equal(material.map.colorSpace, SRGBColorSpace);
      }
      for (const key of ['normalMap', 'roughnessMap', 'metalnessMap']) {
        if (material[key]) assert.equal(material[key].colorSpace, NoColorSpace, `${key} retains linear data`);
      }
    }
  });

  await t.test('the delivery manifest matches the shipped bytes and retains editable source and rebuild script', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../public/assets/models/pistol/manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.source, 'original-blender-authored');
    assert.deepEqual(manifest.muzzle, MUZZLE);
    assert.deepEqual(manifest.gripCenter, [-0.052, -0.060, 0.012]);
    assert.equal(manifest.geometry.triangles, asset.summary.triangles);
    assert.equal(manifest.geometry.materialGroups, asset.summary.materials);
    assert.equal(manifest.delivery.glbBytes, asset.bytes.length);
    assert.equal(manifest.delivery.sha256, createHash('sha256').update(asset.bytes).digest('hex'),
      'The manifest identifies the exact validated GLB');
    assert.equal(manifest.delivery.embeddedImages, asset.images.length);
    for (const path of [manifest.sourceFile, manifest.rebuild]) {
      const info = await stat(new URL(`../../${path}`, import.meta.url));
      assert.ok(info.isFile() && info.size > 0, 'The editable source and exporter ship alongside the runtime model');
    }
  });

  await t.test('the actual exported buffers have finite surface data, active surface tints, valid indices, and useful UV triangles', () => {
    const tintedMaterials = new Set();
    for (const mesh of asset.meshes) {
      assert.notEqual(mesh.isSkinnedMesh, true);
      assert.deepEqual(mesh.geometry.morphAttributes, {});
      const { position, normal, uv, color } = mesh.geometry.attributes, index = mesh.geometry.index;
      assert.ok(position && normal && uv && color, 'Positions, normals, authored UVs, and COLOR_0 tints are exported');
      assert.equal(position.count, normal.count); assert.equal(position.count, uv.count);
      assert.equal(position.count, color.count);
      assert.equal(mesh.material.vertexColors, true, 'The loaded material applies the exported surface tints');
      for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
        assert.ok(attribute.array.every(Number.isFinite), `${mesh.name}: finite ${name}`);
      }
      for (let i = 0; i < normal.count; i++) {
        near(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)), 1, 'Unit shading normal', 0.002);
        for (const value of [color.getX(i), color.getY(i), color.getZ(i)]) {
          assert.ok(value >= 0 && value <= 1, 'The vertex tint is valid normalized linear color');
          if (value < 0.9) tintedMaterials.add(mesh.material);
        }
      }
      if (index) assert.ok(index.array.every(vertex => vertex >= 0 && vertex < position.count), 'Indices address actual vertices');
      const count = index?.count ?? position.count;
      assert.equal(count % 3, 0);
      let usefulUVs = 0;
      for (let i = 0; i < count; i += 3) {
        const [a, b, c] = [0, 1, 2].map(corner => index ? index.getX(i + corner) : i + corner);
        const area = (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a))
          - (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a));
        if (Math.abs(area) > 1e-12) usefulUVs++;
      }
      assert.ok(usefulUVs >= count / 3 * 0.99, `${mesh.name}: at least 99% of triangles have noncollapsed UVs`);
    }
    for (const material of asset.materials) if (material.map) {
      assert.ok(tintedMaterials.has(material), 'Each textured surface retains meaningful tint modulation');
    }
  });

  await t.test('failed loads preserve fallback, retry succeeds, and repeated callers share one cached load', async () => {
    assert.equal(createAuthoredPistol(), null, 'The synchronous factory is safe before startup preload');
    const failure = await loadAuthoredPistol({ loader: { loadAsync: async () => { throw new Error('offline fixture'); } } });
    assert.equal(failure.state, 'fallback');
    assert.equal(createAuthoredPistol(), null, 'A failed request leaves the existing weapon available');
    // The first Blender export left an extra UV channel on only its slide.
    // Reject that incompatibility before the synchronous batcher can abort boot.
    const invalid = await asset.loader.parseAsync(asset.arrayBuffer, '');
    const slide = invalid.scene.getObjectByName('pistol-slide');
    slide.geometry.setAttribute('uv1', slide.geometry.attributes.uv.clone());
    const incompatible = await loadAuthoredPistol({ loader: { loadAsync: async () => invalid } });
    assert.equal(incompatible.state, 'fallback', 'Incompatible primitive layouts preserve a working procedural viewmodel');
    assert.equal(createAuthoredPistol(), null);
    const malformed = [
      ['wrong normal layout', geometry => geometry.setAttribute('normal', new Float32BufferAttribute(
        new Float32Array(geometry.attributes.position.count * 2), 2)), /normal layout/],
      ['truncated UVs', geometry => geometry.setAttribute('uv', new Float32BufferAttribute(
        new Float32Array((geometry.attributes.position.count - 1) * 2), 2)), /uv layout/],
      ['truncated colors', geometry => geometry.setAttribute('color', new Float32BufferAttribute(
        new Float32Array((geometry.attributes.position.count - 1) * 3), 3)), /color values/],
      ['nonfinite colors', geometry => {
        const colors = new Float32Array(geometry.attributes.position.count * 3).fill(1); colors[0] = NaN;
        geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
      }, /color values/],
      ['out-of-range indices', geometry => geometry.setIndex([0, 1, geometry.attributes.position.count]), /triangle indices/],
      ['incomplete triangles', geometry => geometry.setIndex([0, 1]), /complete triangles/],
      ['empty triangles', geometry => geometry.setIndex([]), /complete triangles/],
    ];
    for (const [label, mutate, expected] of malformed) {
      const candidate = await asset.loader.parseAsync(asset.arrayBuffer, '');
      mutate(candidate.scene.getObjectByName('pistol-slide').geometry);
      const rejected = await loadAuthoredPistol({ loader: { loadAsync: async () => candidate } });
      assert.equal(rejected.state, 'fallback', `${label} cannot enter the synchronous viewmodel batcher`);
      assert.match(rejected.error, expected, label);
      assert.equal(createAuthoredPistol(), null, `${label} leaves the procedural fallback selected`);
    }
    let loads = 0;
    const loader = { loadAsync: async () => {
      loads++;
      return asset.loader.parseAsync(asset.arrayBuffer, '');
    } };
    const results = await Promise.all([loadAuthoredPistol({ loader }), loadAuthoredPistol({ loader })]);
    assert.equal(loads, 1, 'Concurrent startup callers do not duplicate decoding');
    for (const result of results) assert.equal(result.state, 'ready', result.error);
    assert.equal(getAuthoredPistolStatus().state, 'ready');
    await loadAuthoredPistol({ loader });
    assert.equal(loads, 1, 'A ready asset is reused');
  });

  await t.test('batching consumes only owned copies and preserves the authored UV layout', () => {
    const first = createAuthoredPistol(), second = createAuthoredPistol();
    assert.ok(first && second); assert.notEqual(first, second);
    assert.equal(first.children.length, second.children.length);
    const textures = new Set();
    const watched = second.children.map((mesh, index) => {
      const source = first.children[index];
      assert.ok(mesh.isMesh && source.isMesh, 'The loader supplies flat static mesh children');
      assert.equal(Array.isArray(mesh.material), false, 'Each source can be batched by a single material');
      assert.notEqual(mesh.geometry, source.geometry, 'A viewmodel owns its disposable geometry');
      assert.notEqual(mesh.geometry.attributes.position.array, source.geometry.attributes.position.array);
      assert.equal(mesh.material, source.material, 'Material and texture resources remain shared');
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) if (mesh.material[key]) textures.add(mesh.material[key]);
      return { mesh, positions: mesh.geometry.attributes.position.array.slice(), uv: mesh.geometry.attributes.uv.array.slice(),
        colors: mesh.geometry.attributes.color.array.slice() };
    });
    const disposal = [];
    for (const texture of textures) texture.addEventListener('dispose', () => disposal.push(texture));
    const before = new Map();
    for (const source of first.children) {
      const geometry = source.geometry.index ? source.geometry.toNonIndexed() : source.geometry.clone();
      const values = before.get(source.material) ?? { uv: [], colors: [] };
      values.uv.push(...geometry.attributes.uv.array); values.colors.push(...geometry.attributes.color.array);
      before.set(source.material, values); geometry.dispose();
    }
    batchStaticWeaponParts(first);
    for (const mesh of first.children) {
      assert.deepEqual(Array.from(mesh.geometry.attributes.uv.array), before.get(mesh.material).uv,
        'The runtime batch preserves the exported UVs byte for byte');
      assert.deepEqual(Array.from(mesh.geometry.attributes.color.array), before.get(mesh.material).colors,
        'The runtime batch preserves the authored surface tints byte for byte');
      mesh.geometry.dispose();
    }
    for (const { mesh, positions, uv, colors } of watched) {
      assert.deepEqual(mesh.geometry.attributes.position.array, positions, 'Other instances retain their original positions');
      assert.deepEqual(mesh.geometry.attributes.uv.array, uv, 'Other instances retain their original UVs');
      assert.deepEqual(mesh.geometry.attributes.color.array, colors, 'Other instances retain their original surface tints');
    }
    const third = createAuthoredPistol();
    for (const [index, mesh] of third.children.entries()) {
      assert.deepEqual(mesh.geometry.attributes.position.array, watched[index].positions, 'The cached template survives batching and disposal');
      assert.deepEqual(mesh.geometry.attributes.color.array, watched[index].colors, 'The cached template retains its authored tints');
    }
    assert.deepEqual(disposal, [], 'No shared finish textures are disposed with a viewmodel');
  });

  await t.test('the real weapon factory keeps hand placement, framing, layers, and the complete viewmodel budget', () => {
    const { makeWeaponViewModel } = weaponHarness(), model = makeWeaponViewModel('pistol');
    assert.equal(model.userData.heroWeapon.source, 'original-blender-authored', 'The production factory selects the preloaded asset');
    assert.deepEqual(model.userData.muzzle, MUZZLE);
    assert.equal(model.userData.heroWeapon.grips.length, 1);
    assert.deepEqual(model.userData.heroWeapon.grips[0].center, [-0.052, -0.060, 0.012]);
    assert.ok(model.userData.presentation.triangles <= 6500, 'The existing complete pistol and hand triangle limit is retained');
    assert.ok(model.userData.presentation.drawCalls <= 6, 'The existing complete pistol and hand draw limit is retained');
    for (const mesh of model.children) {
      assert.equal(mesh.layers.mask, 1 << VIEW_MODEL_LAYER);
      assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false);
      assert.equal(mesh.material.depthWrite, true); assert.equal(mesh.material.depthTest, true);
    }
    const bounds = new Box3().setFromObject(model, true);
    for (const [axis, minimum, maximum] of [['x', -0.0481, 0.0827459271], ['y', -0.2953522435, 0.1131], ['z', -0.2613, 0.515485926]]) {
      assert.ok(bounds.min[axis] >= minimum - 1e-6, `Established lower ${axis} framing extent`);
      assert.ok(bounds.max[axis] <= maximum + 1e-6, `Established upper ${axis} framing extent`);
    }
  });

  await t.test('the real barrel has an open bore and muzzle effects follow hip and aimed transforms', () => {
    const raw = createAuthoredPistol(); raw.updateMatrixWorld(true);
    const ray = new Raycaster(new Vector3(0.24, 0.04, 0), new Vector3(-1, 0, 0), 0, 0.1);
    const bore = ray.intersectObject(raw, true)[0];
    assert.ok(bore, 'The muzzle has a recessed interior surface');
    assert.ok(bore.point.x < MUZZLE[0] - 0.01, 'A front cap does not fill the barrel opening');
    ray.ray.origin.y += 0.010;
    const crown = ray.intersectObject(raw, true)[0];
    assert.ok(crown, 'The bore is surrounded by real barrel-wall geometry');
    near(crown.point.x, MUZZLE[0], 'The crown is aligned to the existing muzzle anchor', 0.001);
    ray.set(new Vector3(0.028, -0.031, -0.10), new Vector3(0, 0, 1)); ray.far = 0.20;
    assert.equal(ray.intersectObject(raw, true).length, 0, 'The trigger guard remains a physical opening');
    ray.set(new Vector3(0.055, 0.044, -0.037), new Vector3(0, 0, 1));
    const recess = ray.intersectObject(raw, true)[0];
    ray.set(new Vector3(0.013, 0.044, -0.037), new Vector3(0, 0, 1));
    const rim = ray.intersectObject(raw, true)[0];
    const recessDepth = recess && rim ? recess.point.z - rim.point.z : 0;
    assert.ok(recessDepth >= 0.001 && recessDepth <= 0.012,
      'The chamber has a measurable 1–12 mm inset from the actual neighboring slide surface');
    const { camera, makeWeaponViewModel } = weaponHarness();
    camera.position.set(10, 2, -3);
    const holder = new Group(); holder.position.set(0.22, -0.22, -0.36); camera.add(holder);
    const model = makeWeaponViewModel('pistol'); holder.add(model);
    for (const handX of [0.22, 0]) {
      holder.position.x = handX;
      const muzzle = getViewModelMuzzle(model, new Vector3());
      assert.ok(muzzle.distanceTo(new Vector3(10 + handX, 1.832, -3.6213)) < 1e-8,
        'The authored asset preserves the established effect transform');
    }
  });

  await t.test('the actual imported grip meets the existing hand without burying palm or wrist vertices', () => {
    const reports = inspectHeroGripFit('pistol', root => {
      // Keep the diagnostic's real production hand and substitute every gun
      // mesh with the actual decoded asset before the solid-contact probes.
      for (const mesh of [...root.children]) if (!mesh.name.startsWith('primary-')) root.remove(mesh);
      root.add(createAuthoredPistol());
    });
    assert.equal(reports.length, 1);
    for (const fit of reports) {
      assert.ok(fit.parts['pistol-canted-grip'] > 0, 'Finger pads still meet the physical grip');
      assert.equal(fit.rearPalmOrWristInside, 0, 'The rear palm and wrist remain outside the weapon');
      assert.ok(fit.maximumDepthMm < 5, 'Only shallow finger-pad contact is permitted');
      assert.ok(fit.deeperThan3mm < fit.vertices * 0.025, 'The grip cannot bury a substantial part of the hand');
    }
  });

  await t.test('the exported rear sight is physically open, with ears, a floor, and a visible front post', () => {
    const model = createAuthoredPistol(), { rear, front } = model.userData.ironSights;
    model.updateMatrixWorld(true);
    const ray = new Raycaster();
    const probe = (x, length, y, z) => {
      ray.set(new Vector3(x - length / 2 - 0.002, y, z), new Vector3(1, 0, 0));
      ray.near = 0; ray.far = length + 0.004;
      return ray.intersectObject(model, true);
    };
    for (const heightFraction of [0.15, 0.5, 0.85]) for (const widthFraction of [-0.35, 0, 0.35]) {
      assert.equal(probe(rear.x, rear.length, rear.floor + (rear.top - rear.floor) * heightFraction, rear.gap * widthFraction).length, 0,
        'The sight opening continues through the complete exported mesh');
    }
    for (const sign of [-1, 1]) {
      assert.ok(probe(rear.x, rear.length, (rear.floor + rear.top) / 2, sign * (rear.width + rear.gap) / 4).length > 0,
        'A solid ear protects each side of the notch');
    }
    assert.ok(probe(rear.x, rear.length, (rear.bottom + rear.floor) / 2, 0).length > 0, 'The notch has a supporting floor');
    assert.ok(probe(front.x, front.length, front.top - 0.001, 0).length > 0, 'The front post is physical geometry');
  });

  await t.test('the ceramic dot faces the player and has visible area through the actual aimed geometry', () => {
    const raw = createAuthoredPistol(); raw.updateMatrixWorld(true);
    const ceramic = raw.getObjectByName('25-front-ceramic-dot');
    const bounds = new Box3().setFromObject(ceramic, true), center = bounds.getCenter(new Vector3());
    const ray = new Raycaster(new Vector3(-1, center.y, center.z), new Vector3(1, 0, 0), 0, 2);
    assert.ok(ray.intersectObject(ceramic).length > 0,
      'The exported single-sided dot is visible from the rear of the gun');
    const { camera, makeWeaponViewModel } = weaponHarness(), model = makeWeaponViewModel('pistol');
    const holder = new Group(); holder.position.set(0, -0.12, -0.36); camera.add(holder); holder.add(model);
    ray.layers.set(VIEW_MODEL_LAYER);
    const radius = (bounds.max.z - bounds.min.z) / 4;
    for (const fov of [45, 62, 90]) for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      camera.fov = fov; camera.aspect = aspect; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      const projected = [];
      for (const [y, z] of [[0, 0], [-radius, 0], [radius, 0], [0, -radius], [0, radius]]) {
        const point = model.localToWorld(center.clone().add(new Vector3(0, y, z))).project(camera);
        projected.push(point);
        ray.setFromCamera(point, camera); ray.near = camera.near; ray.far = 2;
        const hit = ray.intersectObject(model, true)[0];
        assert.equal(hit?.object.material.name, 'pistol-finish:ceramic-sight',
          'A visible patch of ceramic survives culling and is not covered by the sight post or rear notch');
      }
      const screenBounds = new Box3().setFromPoints(projected), size = screenBounds.getSize(new Vector3());
      assert.ok(size.x * size.y > 1e-7, 'The visible ceramic patch projects to positive area');
    }
  });

  await t.test('aiming retains the visible front sight and a continuous thumb at supported camera shapes', () => {
    const { camera, makeWeaponViewModel } = weaponHarness(), model = makeWeaponViewModel('pistol');
    const holder = new Group(); holder.position.set(0, -0.12, -0.36); camera.add(holder); holder.add(model);
    const { rear, front } = model.userData.ironSights, ray = new Raycaster(); ray.layers.set(VIEW_MODEL_LAYER);
    for (const fov of [45, 62, 90]) for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      camera.fov = fov; camera.aspect = aspect; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      const project = (x, y, z = 0) => model.localToWorld(new Vector3(x, y, z)).project(camera);
      const rearX = rear.x - rear.length / 2, floor = project(rearX, rear.floor), top = project(rearX, rear.top);
      const tip = project(front.x - front.length / 2, front.top - 0.00075);
      assert.ok(tip.y > floor.y + 1e-5 && tip.y < top.y - 1e-5, 'The front tip projects within the rear opening');
      const left = project(rearX, rear.floor, -rear.gap / 2), right = project(rearX, rear.floor, rear.gap / 2);
      assert.ok(project(front.x - front.length / 2, front.top, -front.width / 2).x > left.x);
      assert.ok(project(front.x - front.length / 2, front.top, front.width / 2).x < right.x);
      ray.setFromCamera(tip, camera); ray.near = camera.near; ray.far = 2;
      const hit = ray.intersectObject(model, true)[0];
      assert.ok(hit, 'The front sight remains visible through the actual merged geometry');
      assert.ok(model.worldToLocal(hit.point.clone()).x >= front.x - front.length / 2 - 0.003,
        'The receiver or rear notch does not obscure the front sight');
      ray.setFromCamera({ x: 0, y: 0 }, camera);
      assert.equal(ray.intersectObject(model, true).length, 0, 'The central reticle remains clear');
    }
    camera.fov = 62; camera.aspect = 1280 / 720; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    for (const [x, y] of [[588, 674], [590, 680], [581, 670], [586, 687]]) {
      ray.setFromCamera({ x: x / 1280 * 2 - 1, y: 1 - y / 720 * 2 }, camera);
      const hit = ray.intersectObject(model, true)[0];
      assert.ok(hit, 'The existing thumb silhouette remains visible');
      assert.equal(hit.object.material, getHandMaterials().hand, 'The authored grip does not cut through the aimed thumb');
    }
  });

  await t.test('the real combat clock reuses the imported buffers and finish textures through fire, aim, and reload', () => {
    const { Weapons, Player } = weaponHarness(); Weapons.init(); Weapons._equip('pistol', 120);
    const model = Weapons._vm('pistol');
    const buffers = model.children.map(mesh => ({ geometry: mesh.geometry,
      attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([key, attribute]) => [key, attribute.array])) }));
    const textures = new Map();
    for (const mesh of model.children) for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
      if (mesh.material[key]) textures.set(mesh.material[key], mesh.material[key].version);
    }
    Weapons._fireRanged(); Weapons.startReload();
    for (let frame = 0; frame < 160; frame++) {
      Player.aiming = frame >= 60; Weapons.tick(1 / 120); Weapons.update(1 / 120);
    }
    assert.equal(Weapons._vm('pistol'), model, 'The combat controller retains the cached viewmodel');
    for (const [index, mesh] of model.children.entries()) {
      assert.equal(mesh.geometry, buffers[index].geometry, 'Rigid animation does not rebuild exported geometry');
      for (const [key, array] of Object.entries(buffers[index].attributes)) assert.equal(mesh.geometry.attributes[key].array, array);
    }
    for (const [texture, version] of textures) assert.equal(texture.version, version, 'Combat does not upload finish textures again');
  });
});
