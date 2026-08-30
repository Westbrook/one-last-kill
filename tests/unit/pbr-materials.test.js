import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import * as THREE from 'three';
import { read as readKtx2 } from 'three/addons/libs/ktx-parse.module.js';
import {
  PBR_SURFACES, PBR_KTX2_TRIAL, getRequestedSurfaceFormat, supportsPbrCompression, loadPbrMaterial,
  loadPbrMaterialWithFallback, commitSurfaceMaps,
} from '../../src/render/pbr-materials.js';
import { applyBoxWorldUV } from '../../src/render/world-uv.js';
import { createStaticSurfaceBatch } from '../../src/render/static-surface-batch.js';

const channels = ['map', 'normalMap', 'roughnessMap'];
const replacedSlots = [...channels, 'metalnessMap', 'bumpMap'];
const manifest = JSON.parse(readFileSync(new URL('../../public/assets/materials/manifest.json', import.meta.url), 'utf8'));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} ≈ ${expected}`);

function trackTexture(texture) {
  const result = { texture, disposals: 0 };
  texture.addEventListener('dispose', () => result.disposals++);
  return result;
}

function trackedTexture(width = 1024, height = width) {
  return trackTexture(new THREE.Texture({ width, height }));
}

function trackedCompressedTexture({ format = THREE.RGBA_ASTC_4x4_Format } = {}) {
  const mipmaps = Array.from({ length: 11 }, (_, level) => {
    const size = Math.max(1, 1024 >> level);
    const bytes = format === THREE.RGBAFormat ? size * size * 4 : Math.ceil(size / 4) ** 2 * 16;
    return { width: size, height: size, data: new Uint8Array(bytes) };
  });
  return trackTexture(new THREE.CompressedTexture(mipmaps, 1024, 1024, format, THREE.UnsignedByteType));
}

function fallback() {
  const resources = replacedSlots.map(() => trackedTexture());
  const material = new THREE.MeshStandardMaterial({
    color: 0x8a725c, roughness: 0.93, metalness: 0.14,
    normalScale: new THREE.Vector2(0.18, 0.22),
  });
  for (const [index, slot] of replacedSlots.entries()) material[slot] = resources[index].texture;
  material.name = 'shared-wall';
  material.userData = { surfaceMeters: 0.78, surfaceKind: 'brick', generatedAlbedoUrl: '/previous.png', owner: 'fixture' };
  return { material, resources };
}

function snapshot(material) {
  return {
    maps: replacedSlots.map(slot => material[slot]),
    color: material.color.getHex(), normalScale: material.normalScale.toArray(),
    roughness: material.roughness, metalness: material.metalness, version: material.version,
    userData: JSON.parse(JSON.stringify(material.userData)),
  };
}

function deferredLoader(spec, resourceFactory = trackedTexture) {
  const requests = [], gates = new Map();
  for (const [slot, url] of Object.entries(spec.maps)) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    gates.set(slot, { url, promise, resolve, reject, resource: resourceFactory() });
  }
  const loader = {
    loadAsync(url) {
      requests.push(url);
      const gate = [...gates.values()].find(value => value.url === url);
      assert.ok(gate, `unexpected asset request ${url}`);
      return gate.promise;
    },
  };
  return { loader, requests, gates };
}

function readyLoader(spec, resources = channels.map(() => trackedTexture())) {
  const byUrl = new Map(channels.map((slot, index) => [spec.maps[slot], resources[index].texture]));
  return { resources, loader: { async loadAsync(url) {
    assert.ok(byUrl.has(url), `unexpected asset request ${url}`);
    return byUrl.get(url);
  } } };
}

test('the runtime PBR catalog matches the shipped source files, hashes, licensing and physical spans', () => {
  assert.deepEqual(Object.keys(PBR_SURFACES).sort(), ['brick', 'plaster']);
  const expected = { brick: ['red_brick', 1.4], plaster: ['plastered_wall_03', 4] };
  const manifestChannels = { map: 'albedo', normalMap: 'normal', roughnessMap: 'roughness' };
  const urls = new Set();
  let totalBytes = 0;
  for (const [kind, [assetId, meters]] of Object.entries(expected)) {
    const spec = PBR_SURFACES[kind], source = manifest.materials[assetId];
    assert.equal(spec.id, assetId);
    assert.equal(spec.meters, meters);
    assert.deepEqual(source.intended_tile_span_m, [meters, meters]);
    assert.equal(spec.resolution, 1024);
    assert.equal(spec.downloadBytes, source.map_bytes);
    assert.deepEqual(source.resolution_px, [1024, 1024]);
    assert.deepEqual(Object.keys(spec.maps).sort(), channels.slice().sort());
    assert.equal(spec.provenance.provider, manifest.provider);
    assert.equal(spec.provenance.assetId, assetId);
    assert.equal(spec.provenance.sourceUrl, source.source_page);
    assert.deepEqual(spec.provenance.authors, source.authors);
    assert.equal(spec.provenance.license, 'CC0-1.0');
    assert.equal(spec.provenance.licenseUrl, manifest.license.provider_confirmation);
    assert.equal(spec.provenance.manifestUrl, '/assets/materials/manifest.json');
    assert.match(spec.provenance.normalConvention, /OpenGL.*\+Y/);
    for (const slot of channels) {
      const entry = source.maps[manifestChannels[slot]], url = spec.maps[slot];
      assert.equal(url, entry.url, `${kind} ${slot} uses its corresponding source channel`);
      assert.equal(entry.path, `public${url}`);
      assert.equal(urls.has(url), false, 'each channel has one distinct file');
      urls.add(url);
      assert.deepEqual(entry.dimensions_px, [1024, 1024]);
      const bytes = readFileSync(new URL(`../../${entry.path}`, import.meta.url));
      assert.equal(bytes.length, entry.bytes, url);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, url);
      assert.equal(createHash('md5').update(bytes).digest('hex'), entry.md5, url);
      assert.equal(entry.copied_without_modification, true);
      assert.equal(entry.matches_official_source_md5, true);
      totalBytes += bytes.length;
    }
  }
  assert.equal(urls.size, 6);
  assert.equal(totalBytes, manifest.total_map_bytes);
});

test('a complete PBR set replaces one shared material only after the final channel arrives', async () => {
  const spec = PBR_SURFACES.brick, prior = fallback(), before = snapshot(prior.material);
  const fixture = deferredLoader(spec);
  const pending = loadPbrMaterial(prior.material, spec, { loader: fixture.loader, maxAnisotropy: 16 });
  await nextTurn();
  assert.deepEqual(fixture.requests.slice().sort(), Object.values(spec.maps).sort());
  for (const slot of ['map', 'normalMap']) {
    const gate = fixture.gates.get(slot);
    gate.resolve(gate.resource.texture);
  }
  await nextTurn();
  assert.deepEqual(snapshot(prior.material), before, 'no mix of photographed and procedural channels is exposed');
  assert.ok(prior.resources.every(resource => resource.disposals === 0));
  const last = fixture.gates.get('roughnessMap'); last.resolve(last.resource.texture);
  assert.equal(await pending, prior.material, 'world users retain the shared material identity');
  for (const slot of channels) assert.equal(prior.material[slot], fixture.gates.get(slot).resource.texture);
  assert.ok(prior.resources.every(resource => resource.disposals === 1));
  assert.equal(prior.material.userData.surfaceMeters, 1.4);
  assert.equal(prior.material.userData.surfaceKind, 'brick');
  assert.equal(prior.material.userData.owner, 'fixture');
});

test('a failed channel waits for late arrivals, disposes the entire candidate once and leaves the fallback untouched', async () => {
  const spec = PBR_SURFACES.brick, prior = fallback(), before = snapshot(prior.material);
  const fixture = deferredLoader(spec);
  let settled = false;
  const outcome = loadPbrMaterial(prior.material, spec, { loader: fixture.loader }).then(
    value => { settled = true; return { value }; },
    error => { settled = true; return { error }; },
  );
  const albedo = fixture.gates.get('map'), normal = fixture.gates.get('normalMap'), roughness = fixture.gates.get('roughnessMap');
  albedo.resolve(albedo.resource.texture);
  normal.reject(new Error('normal image unavailable'));
  await nextTurn();
  assert.equal(settled, false, 'early rejection cannot abandon a still-loading texture');
  assert.deepEqual(snapshot(prior.material), before);
  roughness.resolve(roughness.resource.texture);
  assert.ok((await outcome).error, 'incomplete material set rejects');
  assert.equal(albedo.resource.disposals, 1);
  assert.equal(roughness.resource.disposals, 1, 'successful late arrival is cleaned up');
  assert.deepEqual(snapshot(prior.material), before);
  assert.ok(prior.resources.every(resource => resource.disposals === 0));
});

test('invalid dimensions and aliased channels cannot replace or leak the fallback', async () => {
  const spec = PBR_SURFACES.brick;
  const aliased = trackedTexture();
  for (const resources of [
    [trackedTexture(), trackedTexture(1024, 512), trackedTexture()],
    [aliased, aliased, trackedTexture()],
  ]) {
    const prior = fallback(), before = snapshot(prior.material);
    const { loader } = readyLoader(spec, resources);
    await assert.rejects(loadPbrMaterial(prior.material, spec, { loader }));
    assert.deepEqual(snapshot(prior.material), before);
    assert.ok(prior.resources.every(resource => resource.disposals === 0));
    for (const resource of new Set(resources)) assert.equal(resource.disposals, 1);
  }
});

test('a malformed loader cannot reconfigure or dispose a texture already owned by the fallback', async () => {
  const spec = PBR_SURFACES.brick, prior = fallback(), before = snapshot(prior.material);
  const active = prior.resources[0];
  active.texture.repeat.set(2, 3); active.texture.offset.set(0.2, 0.3);
  active.texture.colorSpace = THREE.NoColorSpace;
  const originalRepeat = active.texture.repeat.toArray(), originalOffset = active.texture.offset.toArray();
  const resources = [active, trackedTexture(), trackedTexture()];
  const { loader } = readyLoader(spec, resources);
  await assert.rejects(loadPbrMaterial(prior.material, spec, { loader }));
  assert.deepEqual(snapshot(prior.material), before);
  assert.deepEqual(active.texture.repeat.toArray(), originalRepeat);
  assert.deepEqual(active.texture.offset.toArray(), originalOffset);
  assert.equal(active.texture.colorSpace, THREE.NoColorSpace);
  assert.equal(active.disposals, 0);
  assert.equal(resources[1].disposals, 1); assert.equal(resources[2].disposals, 1);
});

test('PBR channels use coordinated transforms, correct color handling and bounded sampling', async () => {
  for (const spec of Object.values(PBR_SURFACES)) {
    for (const [maxAnisotropy, expected] of [[undefined, 1], [0, 1], [4, 4], [32, 8]]) {
      const prior = fallback(), fixture = readyLoader(spec);
      prior.material.normalMapType = THREE.ObjectSpaceNormalMap;
      for (const { texture } of fixture.resources) {
        texture.colorSpace = THREE.SRGBColorSpace; texture.repeat.set(3, 5);
        texture.offset.set(0.3, 0.4); texture.center.set(0.5, 0.5); texture.rotation = 0.7;
        texture.channel = 1; texture.flipY = false; texture.generateMipmaps = false;
        texture.minFilter = THREE.NearestFilter; texture.magFilter = THREE.NearestFilter;
        texture.matrixAutoUpdate = false; texture.updateMatrix();
      }
      const result = await loadPbrMaterial(prior.material, spec, { loader: fixture.loader, maxAnisotropy });
      assert.equal(result, prior.material);
      assert.equal(result.map.colorSpace, THREE.SRGBColorSpace);
      assert.equal(result.normalMap.colorSpace, THREE.NoColorSpace);
      assert.equal(result.roughnessMap.colorSpace, THREE.NoColorSpace);
      for (const slot of channels) {
        const texture = result[slot];
        assert.deepEqual(texture.repeat.toArray(), [1, 1]);
        assert.deepEqual(texture.offset.toArray(), [0, 0]);
        assert.deepEqual(texture.center.toArray(), [0, 0]);
        assert.equal(texture.rotation, 0);
        assert.equal(texture.matrixAutoUpdate, true);
        for (const [index, value] of new THREE.Matrix3().elements.entries()) close(texture.matrix.elements[index], value);
        assert.equal(texture.channel, 0, 'PBR channels leave uv1 available for the interior light atlas');
        assert.equal(texture.wrapS, THREE.RepeatWrapping); assert.equal(texture.wrapT, THREE.RepeatWrapping);
        assert.equal(texture.flipY, true); assert.equal(texture.generateMipmaps, true);
        assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
        assert.equal(texture.magFilter, THREE.LinearFilter);
        assert.equal(texture.anisotropy, expected);
      }
      assert.deepEqual(result.normalScale.toArray(), [spec.normalScale, spec.normalScale]);
      assert.equal(result.normalMapType, THREE.TangentSpaceNormalMap);
      assert.ok(result.normalScale.y > 0, 'OpenGL normal maps do not receive a DirectX green inversion');
      assert.equal(result.roughness, 1); assert.equal(result.metalness, 0);
      assert.equal(result.bumpMap, null); assert.equal(result.metalnessMap, null);
      assert.equal(result.color.getHex(), spec.color);
      assert.equal(result.userData.surfaceMeters, spec.meters);
      assert.equal(result.userData.staticSurfaceMaps, true);
      assert.equal(result.userData.generatedAlbedoUrl, undefined);
      assert.equal(result.userData.surfaceSource, 'polyhaven');
      for (const [key, value] of Object.entries(spec.provenance)) assert.deepEqual(result.userData.pbrProvenance[key], value);
      assert.deepEqual(result.userData.pbrProvenance.maps, spec.maps);
      assert.equal(result.userData.pbrProvenance.tileSpanMeters, spec.meters);
      assert.equal(result.userData.pbrProvenance.resolution, spec.resolution);
      assert.equal(result.userData.textureBytes, 3 * 1024 * 1024 * 4);
      assert.equal(result.userData.textureBytesWithMipmaps, Math.ceil(result.userData.textureBytes * 4 / 3));
      assert.ok(result.version > 0, 'new channel bindings require a shader update');
    }
  }
});

test('committing maps disposes shared obsolete textures once and preserves every still-referenced texture', () => {
  const material = new THREE.MeshStandardMaterial();
  const retainedMap = trackedTexture(), retired = trackedTexture(), retainedEmissive = trackedTexture(), retiredBump = trackedTexture();
  material.map = retainedMap.texture;
  material.normalMap = material.roughnessMap = retired.texture;
  material.metalnessMap = material.emissiveMap = retainedEmissive.texture;
  material.bumpMap = retiredBump.texture;
  material.userData = { surfaceKind: 'plaster', owner: 'fixture' };
  const next = { map: retainedMap.texture, normalMap: trackedTexture().texture, roughnessMap: trackedTexture().texture };
  commitSurfaceMaps(material, next, {
    surfaceMeters: 2.4, normalScale: 0.8, color: 0xb4bdae,
    userData: { generatedAlbedoUrl: '/generated.png' },
  });
  for (const slot of channels) assert.equal(material[slot], next[slot]);
  assert.equal(retired.disposals, 1, 'normal/roughness alias owns one texture');
  assert.equal(retiredBump.disposals, 1);
  assert.equal(retainedMap.disposals, 0, 'an adopted map remains alive');
  assert.equal(retainedEmissive.disposals, 0, 'clearing metalness must not dispose an emissive map');
  assert.equal(material.emissiveMap, retainedEmissive.texture);
  assert.equal(material.metalnessMap, null); assert.equal(material.bumpMap, null);
  assert.equal(material.userData.surfaceKind, 'plaster');
  assert.equal(material.userData.owner, 'fixture');
  assert.equal(material.userData.surfaceMeters, 2.4);
  assert.equal(material.userData.generatedAlbedoUrl, '/generated.png');
});

test('adopted physical spans reach world UVs and later tinted batches without duplicating maps', async () => {
  for (const spec of Object.values(PBR_SURFACES)) {
    const material = new THREE.MeshStandardMaterial(), fixture = readyLoader(spec);
    await loadPbrMaterial(material, spec, { loader: fixture.loader });
    const width = spec.meters * 2, height = spec.meters;
    const box = new THREE.BoxGeometry(width, height, 0.2);
    applyBoxWorldUV(box, material.userData.surfaceMeters, { x: -3, y: 2, z: 4 });
    const uv = box.attributes.uv;
    const top = [8, 9, 10, 11].map(index => uv.getX(index));
    close(Math.max(...top) - Math.min(...top), 2);
    const primitive = new THREE.BoxGeometry();
    const batch = createStaticSurfaceBatch(primitive, material, [{
      x: -3, y: 2, z: 4, sx: width, sy: height, sz: 0.2,
      rx: 0, ry: 0, rz: 0, tint: 0xd3c9b7,
    }]);
    assert.notEqual(batch.material, material, 'vertex tint uses a later material clone');
    assert.equal(batch.material.userData.surfaceMeters, spec.meters);
    for (const slot of channels) assert.equal(batch.material[slot], material[slot]);
    const batchUV = batch.geometry.attributes.uv;
    const batchTop = [8, 9, 10, 11].map(index => batchUV.getX(index));
    close(Math.max(...batchTop) - Math.min(...batchTop), 2);
    assert.equal(batch.geometry.index.count, primitive.index.count, 'texture detail adds no triangles');
    assert.equal(batch.geometry.groups.length, 0, 'one surface still draws with one material');
    box.dispose(); primitive.dispose(); batch.geometry.dispose(); batch.material.dispose(); material.dispose();
  }
});

test('compressed delivery is the production default and only muted development QA can request raw maps', () => {
  assert.equal(getRequestedSurfaceFormat(), 'ktx2');
  const raw = '?qa=1&mute=1&surfaces=raw';
  assert.equal(getRequestedSurfaceFormat({ search: raw }), 'ktx2');
  assert.equal(getRequestedSurfaceFormat({ dev: false, search: raw }), 'ktx2');
  assert.equal(getRequestedSurfaceFormat({ dev: true, search: raw }), 'raw');
  assert.equal(getRequestedSurfaceFormat({ dev: true, search: '?surfaces=raw&mute=1&qa=1&view=street' }), 'raw');
  for (const search of [
    '', '?qa=1', '?qa=1&mute=1', '?mute=1&surfaces=raw', '?qa=1&surfaces=raw',
    '?qa=0&mute=1&surfaces=raw', '?qa=1&mute=0&surfaces=raw', '?qa=1&mute=1&surfaces=ktx2',
    '?qa=true&mute=1&surfaces=raw', '?qa=1&mute=true&surfaces=raw', '?qa=1&mute=1&surfaces=RAW',
  ]) {
    assert.equal(getRequestedSurfaceFormat({ dev: true, search }), 'ktx2', search || 'empty query');
    assert.equal(getRequestedSurfaceFormat({ dev: false, search }), 'ktx2', 'production ignores query overrides');
  }
});

test('only approved ASTC or BC7 capabilities allow compressed material initialization', () => {
  for (const capabilities of [undefined, null, {},
    { astcSupported: false, bptcSupported: false },
    { etc1Supported: true }, { etc2Supported: true }, { s3tcSupported: true },
    { pvrtcSupported: true }, { astcHDRSupported: true },
    { etc1Supported: true, etc2Supported: true, s3tcSupported: true, pvrtcSupported: true },
  ]) assert.equal(supportsPbrCompression(capabilities), false);
  for (const capabilities of [
    { astcSupported: true }, { bptcSupported: true },
    { astcSupported: true, bptcSupported: true }, { bptcSupported: true, etc2Supported: true },
  ]) assert.equal(supportsPbrCompression(capabilities), true);
});

test('compressed and raw catalogs retain matching physical surfaces and independent asset paths', () => {
  assert.deepEqual(Object.keys(PBR_KTX2_TRIAL).sort(), Object.keys(PBR_SURFACES).sort());
  for (const [kind, spec] of Object.entries(PBR_KTX2_TRIAL)) {
    const raw = PBR_SURFACES[kind];
    assert.notEqual(spec, raw);
    assert.equal(spec.format, 'ktx2');
    assert.equal(spec.orientation, 'ru', 'flipped encoded rows use the same texture coordinates without runtime flipY');
    assert.equal(spec.mipLevels, 11);
    for (const key of ['id', 'meters', 'resolution', 'normalScale', 'color']) assert.equal(spec[key], raw[key]);
    for (const key of ['provider', 'assetId', 'sourceUrl', 'authors', 'license', 'normalConvention']) {
      assert.deepEqual(spec.provenance[key], raw.provenance[key]);
    }
    for (const [slot, suffix] of [['map', 'diff'], ['normalMap', 'nor_gl'], ['roughnessMap', 'rough']]) {
      assert.equal(spec.maps[slot], `/assets/materials-ktx2-trial/${raw.id}_${suffix}_1k.ktx2`);
      assert.match(raw.maps[slot], /\.(jpg|png)$/, 'raw assets remain an independent fallback');
      assert.notEqual(spec.maps[slot], raw.maps[slot]);
    }
  }
});

test('the encoded trial files match source hashes, container metadata, download totals and decoder provenance', () => {
  const trial = JSON.parse(readFileSync(new URL('../../public/assets/materials-ktx2-trial/manifest.json', import.meta.url), 'utf8'));
  assert.equal(trial.maps.length, 6);
  assert.equal(trial.sourceManifest, '/assets/materials/manifest.json');
  assert.equal(trial.license, 'CC0-1.0');
  const slots = { albedo: 'map', normal: 'normalMap', roughness: 'roughnessMap' };
  const urls = new Set();
  let totalBytes = 0;
  for (const [kind, spec] of Object.entries(PBR_KTX2_TRIAL)) {
    const entries = trial.maps.filter(entry => entry.id === spec.id);
    assert.equal(entries.length, 3);
    let materialBytes = 0;
    for (const entry of entries) {
      const slot = slots[entry.kind], raw = manifest.materials[spec.id].maps[entry.kind];
      assert.ok(slot, entry.kind);
      assert.equal(entry.url, spec.maps[slot]);
      assert.equal(entry.path, `public${entry.url}`);
      assert.equal(urls.has(entry.url), false); urls.add(entry.url);
      const bytes = readFileSync(new URL(`../../${entry.path}`, import.meta.url));
      assert.equal(bytes.length, entry.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.url);
      const container = readKtx2(bytes);
      assert.deepEqual([container.pixelWidth, container.pixelHeight], entry.dimensions);
      assert.deepEqual(entry.dimensions, [spec.resolution, spec.resolution]);
      assert.equal(container.levels.length, spec.mipLevels);
      assert.equal(entry.mipLevels, spec.mipLevels);
      assert.ok(container.levels.every(level => level.levelData.byteLength > 0));
      assert.equal(container.keyValue.KTXorientation, spec.orientation);
      assert.equal(entry.orientation, spec.orientation);
      assert.equal(entry.colorSpace, slot === 'map' ? 'sRGB' : 'NoColorSpace');
      assert.deepEqual(entry.tileSpanMeters, [spec.meters, spec.meters]);
      assert.equal(entry.sourcePath, raw.path);
      assert.equal(entry.sourceSha256, raw.sha256);
      assert.equal(entry.sourceBytes, raw.bytes);
      assert.equal(entry.sourceBitDepth, raw.source_bit_depth);
      const sourceBytes = readFileSync(new URL(`../../${entry.sourcePath}`, import.meta.url));
      assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), entry.sourceSha256);
      materialBytes += bytes.length;
    }
    assert.equal(materialBytes, spec.downloadBytes, `${kind} download estimate matches its three files`);
    totalBytes += materialBytes;
  }
  assert.equal(urls.size, 6); assert.equal(totalBytes, trial.totalBytes);
  assert.equal(trial.decoderManifest, '/assets/basis/provenance.json');
  const decoder = JSON.parse(readFileSync(new URL(`../../public${trial.decoderManifest}`, import.meta.url), 'utf8'));
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(decoder.sourcePackage, 'three'); assert.equal(decoder.sourceVersion, packageJson.dependencies.three);
  assert.equal(decoder.decoderFilesUnchanged, true);
  let decoderBytes = 0;
  for (const entry of decoder.files) {
    const bytes = readFileSync(new URL(`../../public/assets/basis/${entry.file}`, import.meta.url));
    assert.equal(bytes.length, entry.bytes, entry.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.file);
    if (entry.file === 'basis_transcoder.js' || entry.file === 'basis_transcoder.wasm') decoderBytes += bytes.length;
  }
  assert.ok(decoderBytes > 0); assert.equal(decoderBytes, decoder.decoderBytes);
});

test('compressed PBR uploads preserve encoded orientation and report actual compressed mip storage', async () => {
  for (const spec of Object.values(PBR_KTX2_TRIAL)) {
    const prior = fallback();
    const resources = channels.map(() => trackedCompressedTexture());
    const fixture = readyLoader(spec, resources);
    for (const { texture } of resources) {
      texture.flipY = true; texture.generateMipmaps = true;
      texture.repeat.set(2, 3); texture.offset.set(0.25, 0.5); texture.rotation = 0.8;
      texture.colorSpace = THREE.SRGBColorSpace; texture.channel = 1;
    }
    assert.equal(await loadPbrMaterial(prior.material, spec, { loader: fixture.loader, maxAnisotropy: 16 }), prior.material);
    const baseBytes = resources.reduce((sum, { texture }) => sum + texture.mipmaps[0].data.byteLength, 0);
    const totalBytes = resources.reduce((sum, { texture }) => sum + texture.mipmaps.reduce((mipSum, mip) => mipSum + mip.data.byteLength, 0), 0);
    assert.equal(prior.material.userData.surfaceFormat, 'ktx2');
    assert.equal(prior.material.userData.textureBytes, baseBytes);
    assert.equal(prior.material.userData.textureBytesWithMipmaps, totalBytes);
    const provenance = prior.material.userData.pbrProvenance;
    assert.equal(provenance.selectedFormat, 'ktx2');
    assert.equal(provenance.mipLevels, 11);
    assert.equal(provenance.compressedBytes, totalBytes);
    assert.equal(provenance.fallbackFrom, undefined);
    for (const slot of channels) {
      const texture = prior.material[slot];
      assert.equal(texture.isCompressedTexture, true);
      assert.equal(texture.flipY, false, 'compressed uploads cannot use the raw image flip');
      assert.equal(texture.generateMipmaps, false, 'the supplied eleven levels are retained');
      assert.equal(texture.mipmaps.length, 11);
      assert.deepEqual(texture.repeat.toArray(), [1, 1]);
      assert.deepEqual(texture.offset.toArray(), [0, 0]);
      assert.equal(texture.rotation, 0); assert.equal(texture.channel, 0);
      assert.equal(texture.wrapS, THREE.RepeatWrapping); assert.equal(texture.wrapT, THREE.RepeatWrapping);
      assert.equal(texture.anisotropy, 8);
      assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter); assert.equal(texture.magFilter, THREE.LinearFilter);
      assert.equal(texture.colorSpace, slot === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace);
      assert.equal(provenance.gpuFormats[slot], texture.format);
      assert.equal(texture.mipmaps[10].width, 1); assert.equal(texture.mipmaps[10].height, 1);
    }
    assert.deepEqual(prior.material.normalScale.toArray(), [spec.normalScale, spec.normalScale]);
    assert.equal(prior.material.userData.surfaceMeters, spec.meters);
    assert.ok(resources.every(resource => resource.disposals === 0));
  }
});

test('malformed mips and unapproved compressed or uncompressed GPU formats reject the entire set', async () => {
  const spec = PBR_KTX2_TRIAL.brick;
  const cases = [
    ['missing final level', () => { const result = trackedCompressedTexture(); result.texture.mipmaps.pop(); return result; }],
    ['missing internal level', () => { const result = trackedCompressedTexture(); delete result.texture.mipmaps[5]; return result; }],
    ['wrong mip dimensions', () => { const result = trackedCompressedTexture(); result.texture.mipmaps[3].height = 127; return result; }],
    ['empty mip bytes', () => { const result = trackedCompressedTexture(); result.texture.mipmaps[8].data = new Uint8Array(); return result; }],
    ['ordinary decoded image', () => trackedTexture()],
    ['decoded data texture', () => trackTexture(new THREE.DataTexture(new Uint8Array(4 * 1024 * 1024), 1024, 1024))],
    // KTX2Loader returns CompressedTexture even for its unsupported-GPU RGBA32 fallback.
    ['uncompressed RGBA in a CompressedTexture', () => trackedCompressedTexture({ format: THREE.RGBAFormat })],
    ...[
      ['ETC1', THREE.RGB_ETC1_Format], ['ETC2 RGB', THREE.RGB_ETC2_Format], ['ETC2 RGBA', THREE.RGBA_ETC2_EAC_Format],
      ['BC1 RGB', THREE.RGB_S3TC_DXT1_Format], ['BC1 RGBA', THREE.RGBA_S3TC_DXT1_Format],
      ['BC3', THREE.RGBA_S3TC_DXT5_Format], ['PVRTC', THREE.RGBA_PVRTC_4BPPV1_Format],
    ].map(([name, format]) => [name, () => trackedCompressedTexture({ format })]),
  ];
  for (const [label, candidate] of cases) {
    const prior = fallback(), before = snapshot(prior.material);
    const resources = [trackedCompressedTexture(), candidate(), trackedCompressedTexture()];
    const fixture = readyLoader(spec, resources);
    await assert.rejects(loadPbrMaterial(prior.material, spec, { loader: fixture.loader }), undefined, label);
    assert.deepEqual(snapshot(prior.material), before, label);
    assert.ok(prior.resources.every(resource => resource.disposals === 0), label);
    assert.ok(resources.every(resource => resource.disposals === 1), `${label}: all candidate channels are released`);
  }
});

test('approved ASTC and BC7 transcodes retain all three supplied compressed channels', async () => {
  for (const format of [THREE.RGBA_ASTC_4x4_Format, THREE.RGBA_BPTC_Format]) {
    const prior = fallback(), spec = PBR_KTX2_TRIAL.brick;
    const fixture = readyLoader(spec, channels.map(() => trackedCompressedTexture({ format })));
    assert.equal(await loadPbrMaterial(prior.material, spec, { loader: fixture.loader }), prior.material);
    assert.equal(prior.material.userData.surfaceFormat, 'ktx2');
    for (const [index, slot] of channels.entries()) {
      assert.equal(prior.material[slot], fixture.resources[index].texture);
      assert.equal(prior.material.userData.pbrProvenance.gpuFormats[slot], format);
    }
    assert.ok(fixture.resources.every(resource => resource.disposals === 0));
  }
});

test('incorrect KTX2 orientation or declared mip count rejects before starting image work', async () => {
  for (const change of [{ orientation: 'rd' }, { mipLevels: 10 }]) {
    const prior = fallback(), before = snapshot(prior.material);
    let requests = 0;
    await assert.rejects(loadPbrMaterial(prior.material, { ...PBR_KTX2_TRIAL.brick, ...change }, {
      loader: { loadAsync() { requests++; throw new Error('unexpected image request'); } },
    }));
    assert.equal(requests, 0);
    assert.deepEqual(snapshot(prior.material), before);
    assert.ok(prior.resources.every(resource => resource.disposals === 0));
  }
});

test('a raw request cannot silently adopt compressed textures with the wrong upload orientation', async () => {
  const prior = fallback(), before = snapshot(prior.material), spec = PBR_SURFACES.brick;
  const fixture = readyLoader(spec, channels.map(() => trackedCompressedTexture()));
  await assert.rejects(loadPbrMaterial(prior.material, spec, { loader: fixture.loader }));
  assert.deepEqual(snapshot(prior.material), before);
  assert.ok(fixture.resources.every(resource => resource.disposals === 1));
  assert.ok(prior.resources.every(resource => resource.disposals === 0));
});

test('raw-only helper options load raw maps without starting an incomplete compressed request', async () => {
  const rawSpec = PBR_SURFACES.brick, trialSpec = PBR_KTX2_TRIAL.brick;
  for (const options of [{}, { ktx2Spec: trialSpec }, { ktx2Loader: { loadAsync() { assert.fail('a trial requires its separate specification'); } } }]) {
    const prior = fallback(), fixture = readyLoader(rawSpec);
    assert.equal(await loadPbrMaterialWithFallback(prior.material, rawSpec, { loader: fixture.loader, ...options }), prior.material);
    assert.equal(prior.material.userData.surfaceFormat, 'raw');
    assert.equal(prior.material.userData.pbrProvenance.selectedFormat, 'raw');
    assert.equal(prior.material.userData.pbrProvenance.fallbackFrom, undefined);
    for (const [index, slot] of channels.entries()) {
      assert.equal(prior.material[slot], fixture.resources[index].texture);
      assert.equal(prior.material[slot].flipY, true);
    }
  }
});

test('successful compressed loading stays atomic and never downloads raw alternatives', async () => {
  const rawSpec = PBR_SURFACES.brick, trialSpec = PBR_KTX2_TRIAL.brick;
  const prior = fallback(), before = snapshot(prior.material), fixture = deferredLoader(trialSpec, trackedCompressedTexture);
  const pending = loadPbrMaterialWithFallback(prior.material, rawSpec, {
    loader: { loadAsync() { assert.fail('a complete compressed set must not download raw maps'); } },
    ktx2Loader: fixture.loader, ktx2Spec: trialSpec,
  });
  for (const slot of ['map', 'normalMap']) {
    const gate = fixture.gates.get(slot); gate.resolve(gate.resource.texture);
  }
  await nextTurn();
  assert.deepEqual(snapshot(prior.material), before);
  const last = fixture.gates.get('roughnessMap'); last.resolve(last.resource.texture);
  assert.equal(await pending, prior.material);
  assert.equal(prior.material.userData.surfaceFormat, 'ktx2');
  for (const slot of channels) assert.equal(prior.material[slot], fixture.gates.get(slot).resource.texture);
});

test('a delayed compressed failure cleans up before an atomic raw fallback and records the chosen format', async () => {
  const rawSpec = PBR_SURFACES.brick, trialSpec = PBR_KTX2_TRIAL.brick;
  const prior = fallback(), before = snapshot(prior.material);
  const trial = deferredLoader(trialSpec, trackedCompressedTexture), raw = deferredLoader(rawSpec);
  let settled = false;
  const outcome = loadPbrMaterialWithFallback(prior.material, rawSpec, {
    loader: raw.loader, ktx2Loader: trial.loader, ktx2Spec: trialSpec,
  }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  const albedo = trial.gates.get('map'), normals = trial.gates.get('normalMap'), roughness = trial.gates.get('roughnessMap');
  albedo.resolve(albedo.resource.texture); normals.reject(new Error('compressed normal failed'));
  await nextTurn();
  assert.equal(settled, false); assert.equal(raw.requests.length, 0, 'pending compressed maps still own their cleanup');
  assert.deepEqual(snapshot(prior.material), before);
  roughness.resolve(roughness.resource.texture);
  await nextTurn();
  assert.equal(raw.requests.length, 3);
  assert.equal(albedo.resource.disposals, 1); assert.equal(roughness.resource.disposals, 1);
  for (const slot of ['map', 'normalMap']) {
    const gate = raw.gates.get(slot); gate.resolve(gate.resource.texture);
  }
  await nextTurn();
  assert.deepEqual(snapshot(prior.material), before, 'a partially loaded raw fallback cannot mix formats');
  const last = raw.gates.get('roughnessMap'); last.resolve(last.resource.texture);
  const result = await outcome;
  assert.equal(result.error, undefined); assert.equal(result.value, prior.material);
  assert.equal(prior.material.userData.surfaceFormat, 'raw');
  assert.equal(prior.material.userData.pbrProvenance.selectedFormat, 'raw');
  assert.equal(prior.material.userData.pbrProvenance.fallbackFrom, 'ktx2');
  assert.deepEqual(prior.material.userData.pbrProvenance.maps, rawSpec.maps);
  assert.equal(prior.material.userData.textureBytes, 3 * 1024 * 1024 * 4);
  assert.ok(prior.resources.every(resource => resource.disposals === 1));
  for (const slot of channels) {
    assert.equal(prior.material[slot], raw.gates.get(slot).resource.texture);
    assert.equal(prior.material[slot].isCompressedTexture, undefined);
  }
});

test('failed compressed and raw sets leave the procedural material intact and release both attempts', async () => {
  const rawSpec = PBR_SURFACES.brick, trialSpec = PBR_KTX2_TRIAL.brick;
  const prior = fallback(), before = snapshot(prior.material);
  const trial = readyLoader(trialSpec, channels.map(() => trackedCompressedTexture()));
  const raw = readyLoader(rawSpec);
  const trialLoad = trial.loader.loadAsync, rawLoad = raw.loader.loadAsync;
  trial.loader.loadAsync = async url => {
    if (url === trialSpec.maps.normalMap) throw new Error('compressed normal failed');
    return trialLoad(url);
  };
  raw.loader.loadAsync = async url => {
    if (url === rawSpec.maps.roughnessMap) throw new Error('raw roughness failed');
    return rawLoad(url);
  };
  await assert.rejects(loadPbrMaterialWithFallback(prior.material, rawSpec, {
    loader: raw.loader, ktx2Loader: trial.loader, ktx2Spec: trialSpec,
  }));
  assert.deepEqual(snapshot(prior.material), before);
  assert.ok(prior.resources.every(resource => resource.disposals === 0));
  assert.deepEqual(trial.resources.map(resource => resource.disposals), [1, 0, 1]);
  assert.deepEqual(raw.resources.map(resource => resource.disposals), [1, 1, 0]);
});
