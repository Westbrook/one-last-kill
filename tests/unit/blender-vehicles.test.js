import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Box3, Vector3 } from 'three';
import { inspectVehicleAssets, CIVILIAN_VARIANTS, CIVILIAN_CATEGORIES } from '../../tools/validate-vehicle-assets.mjs';
import { loadAuthoredVehicles, getAuthoredVehiclesStatus, getAuthoredVehicleGeometry } from '../../src/render/authored-vehicles.js';
import { createCivilianVehicle } from '../../src/render/civilian-vehicles.js';
import { placeCivilianVehicle } from '../../src/render/parked-vehicle-placement.js';
import { scorchCivilianVehicle } from '../../src/render/street-vehicle-aftermath.js';
import { DISTRICT } from '../../src/world/district-layout.js';

const near = (a, b, label, tolerance = 1e-5) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} versus ${b}`);
const categoryMesh = (vehicle, category) => vehicle.group.children.find(mesh => mesh.name.endsWith('-' + category));
const OBJECTIVE_CATEGORIES = ['paint', 'trim', 'glass', 'tires', 'metal', 'rearlamps', 'headlamps'];

function partBounds(geometry, range) {
  const bounds = new Box3(), point = new Vector3(), positions = geometry.attributes.position;
  for (let i = range.vertexStart; i < range.vertexStart + range.vertexCount; i++) {
    bounds.expandByPoint(point.fromBufferAttribute(positions, i));
  }
  return bounds;
}

test('the Blender vehicle catalog retains the production vehicle contracts', async t => {
  const asset = await inspectVehicleAssets();
  const original = new Map(CIVILIAN_VARIANTS.map(variant => [variant, createCivilianVehicle({ variant })]));

  await t.test('the real catalog is self-contained, static, and inside every civilian triangle and material budget', () => {
    assert.ok(asset.bytes.length <= 6 * 1024 * 1024, 'Bound complete catalog transfer size');
    assert.equal(asset.gltf.animations.length, 0);
    assert.equal(asset.json.skins?.length ?? 0, 0);
    assert.equal(asset.json.extensionsRequired?.length ?? 0, 0, 'No extra decoder dependency');
    assert.equal(asset.json.images?.length ?? 0, 0); assert.equal(asset.json.textures?.length ?? 0, 0);
    for (const variant of CIVILIAN_VARIANTS) {
      const entry = asset.summary.variants[variant], reference = original.get(variant);
      assert.ok(entry, `${variant} is present`);
      assert.ok(entry.triangles > 2000 && entry.triangles <= 4200, `${variant}: actual exported triangle budget`);
      assert.deepEqual(Object.keys(entry.categories).sort(), [...CIVILIAN_CATEGORIES].sort(), `${variant}: six material batches`);
      assert.equal(new Set(entry.parts).size, entry.parts.length, `${variant}: stable unique part identities`);
      for (const part of reference.profile.parts) assert.ok(entry.parts.includes(part), `${variant}: retained ${part}`);
      const bounds = asset.bounds.get(variant), existing = new Box3().setFromObject(reference.group, true);
      near(bounds.min.y, 0, `${variant}: tire contact origin`);
      for (const end of ['min', 'max']) for (const axis of ['x', 'y', 'z']) {
        near(bounds[end][axis], existing[end][axis], `${variant}: unchanged measured ${end}.${axis} envelope`);
      }
    }
  });

  await t.test('exported surfaces have finite positions, normalized normals, useful UVs, and preserved color data', () => {
    for (const mesh of asset.meshes) {
      assert.notEqual(mesh.isSkinnedMesh, true); assert.deepEqual(mesh.geometry.morphAttributes, {});
      const { position, normal, uv, color } = mesh.geometry.attributes, index = mesh.geometry.index;
      assert.ok(position && normal && uv && color, `${mesh.name}: complete surface attributes`);
      assert.equal(position.count, normal.count); assert.equal(position.count, uv.count); assert.equal(position.count, color.count);
      for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
        const data = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
        assert.ok(data.every(Number.isFinite), `${mesh.name}: finite ${name}`);
      }
      for (let i = 0; i < normal.count; i++) {
        near(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)), 1, `${mesh.name}: unit normal`, 0.002);
        for (const value of [color.getX(i), color.getY(i), color.getZ(i)]) {
          assert.ok(value >= 0 && value <= 1, `${mesh.name}: normalized vertex tint`);
        }
      }
      if (index) assert.ok(index.array.every(vertex => vertex >= 0 && vertex < position.count), `${mesh.name}: valid indices`);
      const count = index?.count ?? position.count; let useful = 0;
      assert.equal(count % 3, 0);
      for (let i = 0; i < count; i += 3) {
        const [a, b, c] = [0, 1, 2].map(offset => index ? index.getX(i + offset) : i + offset);
        const area = (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a))
          - (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a));
        if (Math.abs(area) > 1e-12) useful++;
      }
      assert.ok(useful >= count / 3 * 0.99, `${mesh.name}: UV triangles retain their physical surface area`);
    }
  });

  await t.test('the delivery manifest identifies the exact validated catalog bytes and variant costs', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../public/assets/models/vehicles/manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.source, 'original-blender-prepared');
    assert.equal(manifest.textures, 0);
    assert.equal(manifest.glb.bytes, asset.bytes.length);
    assert.equal(manifest.glb.sha256, createHash('sha256').update(asset.bytes).digest('hex'));
    assert.deepEqual(manifest.variants.map(entry => entry.variant).sort(), Object.keys(asset.summary.variants).sort());
    for (const entry of manifest.variants) {
      assert.equal(entry.triangles, asset.summary.variants[entry.variant].triangles, `${entry.variant}: measured delivery cost`);
    }
    for (const path of [manifest.generator, manifest.sourceFile, manifest.sourceInput]) {
      const file = await stat(new URL(`../../${path}`, import.meta.url));
      assert.ok(file.isFile() && file.size > 0, 'Editable source and reproducible input ship with the runtime catalog');
    }
    const input = await readFile(new URL(`../../${manifest.sourceInput}`, import.meta.url));
    assert.equal(manifest.sourceInputSha256, createHash('sha256').update(input).digest('hex'));
  });

  await t.test('failed and timed-out requests preserve fallback, release late resources, and permit one shared retry', async () => {
    for (const variant of CIVILIAN_VARIANTS) assert.equal(getAuthoredVehicleGeometry(variant), null);
    const failed = await loadAuthoredVehicles({ loader: { loadAsync: async () => { throw new Error('offline vehicle fixture'); } } });
    assert.equal(failed.state, 'fallback');
    assert.equal(getAuthoredVehicleGeometry('sedan'), null);
    const late = await asset.loader.parseAsync(asset.arrayBuffer, ''), geometries = new Set(), materials = new Set();
    late.scene.traverse(mesh => {
      if (mesh.geometry) geometries.add(mesh.geometry);
      if (mesh.material) for (const material of [].concat(mesh.material)) materials.add(material);
    });
    const disposed = new Set();
    for (const resource of [...geometries, ...materials]) resource.addEventListener('dispose', () => disposed.add(resource));
    let deliver;
    const timedOut = await loadAuthoredVehicles({ timeoutMs: 5, loader: { loadAsync: () => new Promise(resolve => { deliver = resolve; }) } });
    assert.equal(timedOut.state, 'fallback'); assert.match(timedOut.error, /timed out/i);
    deliver(late); await new Promise(resolve => setTimeout(resolve, 0));
    for (const resource of [...geometries, ...materials]) assert.ok(disposed.has(resource), 'Late imported buffers and unused materials are released');
    assert.equal(getAuthoredVehicleGeometry('sedan'), null);

    const invalid = await asset.loader.parseAsync(asset.arrayBuffer, '');
    let changed = false;
    invalid.scene.traverse(mesh => {
      if (!changed && mesh.isMesh) { mesh.geometry.deleteAttribute('color'); changed = true; }
    });
    const rejected = await loadAuthoredVehicles({ loader: { loadAsync: async () => invalid } });
    assert.equal(rejected.state, 'fallback', 'Missing scorch/paint tint data cannot abort later synchronous world construction');
    assert.equal(getAuthoredVehicleGeometry('sedan'), null);
    let loads = 0;
    const loader = { loadAsync: async () => { loads++; return asset.loader.parseAsync(asset.arrayBuffer, ''); } };
    const results = await Promise.all([loadAuthoredVehicles({ loader }), loadAuthoredVehicles({ loader })]);
    for (const result of results) assert.equal(result.state, 'ready', result.error);
    assert.equal(loads, 1, 'Concurrent startup users share a single decode');
    assert.equal(getAuthoredVehiclesStatus().state, 'ready');
    await loadAuthoredVehicles({ loader }); assert.equal(loads, 1, 'The ready catalog is cached');
    assert.equal(getAuthoredVehicleGeometry('unknown-car'), null);
  });

  await t.test('merged part ranges address the exact imported buffers, including all four actual tire surfaces', () => {
    for (const variant of [...CIVILIAN_VARIANTS, 'objective-sedan']) {
      const loaded = getAuthoredVehicleGeometry(variant), reference = original.get(variant);
      const objective = variant === 'objective-sedan';
      const categories = objective ? OBJECTIVE_CATEGORIES : CIVILIAN_CATEGORIES;
      assert.ok(loaded); assert.equal(getAuthoredVehicleGeometry(variant), loaded, 'The cache shares variant geometry');
      let triangles = 0, geometryBytes = 0;
      for (const category of categories) {
        const geometry = loaded.geometry[category], ranges = geometry.userData.civilianParts;
        assert.equal(geometry.index, null, 'Part ranges address contiguous actual triangle vertices');
        if (objective) assert.equal(geometry.attributes.color, undefined,
          'The objective does not retain vertex colors unused by all seven runtime finishes');
        else assert.ok(geometry.attributes.color, 'Civilian paint and scorch retain their per-vertex tints');
        const sourceParts = asset.meshes.filter(mesh => mesh.userData.vehicleVariant === variant && mesh.userData.vehicleCategory === category);
        assert.equal(ranges.length, sourceParts.length);
        let offset = 0;
        for (const range of ranges) {
          assert.equal(range.vertexStart, offset, 'No hidden gap or overlap between part ranges');
          assert.ok(range.vertexCount > 0 && range.vertexCount % 3 === 0);
          const source = sourceParts.find(mesh => mesh.userData.vehiclePart === range.name);
          assert.ok(source, `${variant}/${category}/${range.name}: original GLB part`);
          const transformed = source.geometry.clone().applyMatrix4(source.matrixWorld);
          const expanded = transformed.index ? transformed.toNonIndexed() : transformed;
          assert.equal(range.vertexCount, expanded.attributes.position.count);
          for (const name of objective ? ['position', 'normal', 'uv'] : ['position', 'normal', 'uv', 'color']) {
            const merged = geometry.attributes[name], originalAttribute = expanded.attributes[name];
            assert.equal(merged.itemSize, name === 'color' ? 3 : originalAttribute.itemSize,
              'The runtime retains RGB and may discard the unused exported alpha component');
            for (let i = 0; i < range.vertexCount; i++) for (let component = 0; component < merged.itemSize; component++) {
              near(merged.getComponent(offset + i, component), originalAttribute.getComponent(i, component),
                `${variant}/${range.name}: ${name} preserved by merging`, 1e-6);
            }
          }
          offset += range.vertexCount;
          if (expanded !== transformed) expanded.dispose(); transformed.dispose();
        }
        assert.equal(offset, geometry.attributes.position.count, 'Every merged vertex has a source part identity');
        triangles += offset / 3;
        geometryBytes += Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
      }
      assert.equal(triangles, asset.summary.variants[variant].triangles);
      assert.equal(loaded.resources.triangles, triangles); assert.equal(loaded.resources.materialDraws, categories.length);
      assert.equal(loaded.resources.geometryBytes, geometryBytes, 'Reported runtime memory counts only retained buffers');
      assert.equal(loaded.resources.textures, 0); assert.equal(loaded.resources.textureBytes, 0);
      if (objective) continue;
      assert.equal(reference.profile.wheels.length, 4);
      for (const wheel of reference.profile.wheels) {
        const name = wheel.surfaceName || 'tire:' + wheel.name, tires = loaded.geometry.tires;
        const range = tires.userData.civilianParts.find(part => part.name === name);
        assert.ok(range, `${variant}/${wheel.name}: tire identity retained`);
        const bounds = partBounds(tires, range), center = bounds.getCenter(new Vector3());
        for (const [i, axis] of ['x', 'y', 'z'].entries()) near(center[axis], wheel.center[i], `${variant}/${wheel.name}: wheel ${axis}`, 0.001);
        near(bounds.min.y, 0, `${variant}/${wheel.name}: unchanged floor contact`);
        near(bounds.max.y, 2 * reference.profile.wheelRadius, `${variant}/${wheel.name}: unchanged radius`, 0.001);
      }
    }
  });

  await t.test('the real civilian factory selects the loaded mesh while retaining paint, collision bounds, and shared geometry', () => {
    for (const variant of CIVILIAN_VARIANTS) {
      const before = original.get(variant), first = createCivilianVehicle({ variant }), second = createCivilianVehicle({ variant });
      const repainted = createCivilianVehicle({ variant, paint: 0x647267, finish: 'kept' });
      assert.equal(first.group.children.length, 6); assert.equal(first.resources.triangles, asset.summary.variants[variant].triangles);
      assert.deepEqual(first.profile, before.profile, 'Variant placement, glass probes, and wheel descriptors remain stable');
      for (const [index, bounds] of first.movementBounds.entries()) {
        assert.ok(bounds.equals(before.movementBounds[index])); assert.notEqual(bounds, second.movementBounds[index]);
      }
      for (const category of CIVILIAN_CATEGORIES) {
        const a = categoryMesh(first, category), b = categoryMesh(second, category), c = categoryMesh(repainted, category);
        assert.equal(a.geometry, getAuthoredVehicleGeometry(variant).geometry[category], `${variant}: runtime selects imported ${category}`);
        assert.notEqual(a.geometry, categoryMesh(before, category).geometry, 'Existing fallback cache does not mask late preload');
        assert.equal(a.geometry, b.geometry); assert.equal(a.geometry, c.geometry);
        assert.equal(a.material, categoryMesh(before, category).material, 'The actual runtime finish and ballistics classifications are retained');
        assert.equal(a.material, b.material);
        assert.equal(a.castShadow, true); assert.equal(a.receiveShadow, true);
      }
      const bounds = new Box3().setFromObject(first.group, true);
      assert.ok(first.visualBounds.clone().expandByScalar(1e-6).containsBox(bounds), 'Declared visual bounds contain the imported model');
    }
  });

  await t.test('the loaded tire meshes still solve real street and curb placement without suspension gaps', () => {
    let raised = 0;
    for (const placement of DISTRICT.street.parkedCars) {
      const vehicle = createCivilianVehicle({ variant: placement.variant }), result = placeCivilianVehicle(vehicle, placement);
      assert.equal(result.wheelContacts.length, 4);
      for (const contact of result.wheelContacts) {
        near(contact.point.y, contact.surfaceY, `${placement.id}/${contact.name}: pavement contact`);
        if (contact.surfaceY > placement.y) raised++;
      }
    }
    assert.equal(raised, 2, 'The authored hatchback retains the two elevated curb-side wheels');
  });

  await t.test('scorch clones only the wreck paint and leaves shared authored buffers and other finishes intact', () => {
    const wreck = createCivilianVehicle(), clean = createCivilianVehicle(), future = createCivilianVehicle();
    const paint = categoryMesh(wreck, 'paint'), shared = categoryMesh(clean, 'paint');
    const positions = shared.geometry.attributes.position.array.slice(), colors = shared.geometry.attributes.color.array.slice();
    const roughness = shared.material.roughness;
    scorchCivilianVehicle(wreck.group);
    assert.notEqual(paint.geometry, shared.geometry); assert.notEqual(paint.material, shared.material);
    assert.deepEqual(paint.geometry.attributes.position.array, positions, 'Scorch preserves visible and ballistic shape');
    assert.deepEqual(shared.geometry.attributes.color.array, colors, 'Other cars keep their original tints');
    assert.deepEqual(categoryMesh(future, 'paint').geometry.attributes.color.array, colors, 'The cached catalog remains undamaged');
    assert.notDeepEqual(paint.geometry.attributes.color.array, colors, 'The wreck has an actual localized burn');
    assert.equal(shared.material.roughness, roughness);
    assert.equal(wreck.group.children.length, clean.group.children.length, 'Scorch adds no draw');
  });
});
