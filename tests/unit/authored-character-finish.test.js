import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { heroCharacterMaterials } from '../../src/render/hero-character-materials.js';
import { createHumanoidRig } from '../../src/render/humanoid-rig.js';
import { loadAuthoredCharacterSurfaces } from '../../src/render/authored-character-surfaces.js';

const assetRoot = new URL('../../public/assets/models/characters/', import.meta.url);
const clone = value => JSON.parse(JSON.stringify(value));
const finishSpec = () => ({ version: 1,
  garments: { normal: 'gunman-garments-normal.png', roughness: 'gunman-garments-roughness.png' },
  head: { normal: 'gunman-head-normal.png', roughness: 'gunman-head-roughness.png' },
});
let moduleId = 0;
const freshLoader = () => import(`../../src/render/authored-character-surfaces.js?finish-test=${++moduleId}`);
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));
const bindBones = entry => entry.bones.map(bone => ({ name: bone.name, matrixWorld: new THREE.Matrix4().fromArray(bone.matrix) }));

function decodedTexture(width = 512) {
  const texture = new THREE.Texture({ width, height: width });
  let disposals = 0;
  texture.addEventListener('dispose', () => disposals++);
  return { texture, disposals: () => disposals };
}

function assets(manifest, bytes, calls = []) {
  return async url => {
    calls.push(String(url));
    return String(url).endsWith('manifest.json')
      ? { ok: true, json: async () => clone(manifest) }
      : { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
}

test('the gunman sculpt finish is atomic, bounded, and selected only with its matching authored geometry', async t => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', assetRoot), 'utf8'));
  const bytes = await readFile(new URL(manifest.binary, assetRoot));
  const gunman = manifest.catalog.find(entry => entry.id === 'gunman');
  gunman.finish = finishSpec();

  await t.test('unsupported appearances and atlas paths fail before texture requests', async () => {
    for (const mutate of [
      value => { value.catalog.find(entry => entry.id === 'thug').finish = finishSpec(); },
      value => { value.catalog.find(entry => entry.id === 'gunman').finish.version = 2; },
      value => { value.catalog.find(entry => entry.id === 'gunman').finish.head.normal = '../another-normal.png'; },
      value => { delete value.catalog.find(entry => entry.id === 'gunman').finish.garments.roughness; },
    ]) {
      const invalid = clone(manifest); mutate(invalid);
      const loader = await freshLoader(); let requests = 0;
      const result = await loader.loadAuthoredCharacterSurfaces({ fetchImpl: assets(invalid, bytes),
        textureLoader: { loadAsync: async () => { requests++; return decodedTexture().texture; } } });
      assert.equal(result.state, 'fallback'); assert.match(result.error, /finish/);
      assert.equal(requests, 0, 'An invalid manifest never requests a mismatched texture');
      assert.equal(loader.getAuthoredCharacterSurfaces(gunman.config, gunman.dimensions, bindBones(gunman)), null);
    }
  });

  await t.test('one missing map releases acquired textures and late images without publishing the geometry', async () => {
    const loader = await freshLoader(), ready = decodedTexture(), late = [decodedTexture(), decodedTexture()];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let head = 0;
    const result = await loader.loadAuthoredCharacterSurfaces({ fetchImpl: assets(manifest, bytes), textureLoader: {
      loadAsync: async url => {
        if (url.endsWith('garments-normal.png')) return ready.texture;
        if (url.endsWith('garments-roughness.png')) throw new Error('missing finish image');
        const value = late[head++]; await gate; return value.texture;
      },
    } });
    assert.equal(result.state, 'fallback'); assert.match(result.error, /missing finish image/);
    assert.equal(ready.disposals(), 1);
    release(); await nextTurn();
    assert.deepEqual(late.map(value => value.disposals()), [1, 1]);
    assert.equal(loader.getAuthoredCharacterStatus().state, 'fallback');
    assert.equal(loader.getAuthoredCharacterSurfaces(gunman.config, gunman.dimensions, bindBones(gunman)), null);
  });

  await t.test('a checksum-valid mesh cannot publish out-of-range or collapsed bake UVs', async () => {
    for (const collapse of [false, true]) {
      const invalid = clone(manifest), damaged = new Uint8Array(bytes), entry = invalid.catalog.find(value => value.id === 'gunman');
      const surface = entry.surfaces[0], descriptor = surface.attributes.uv;
      const uv = new Float32Array(damaged.buffer, damaged.byteOffset + descriptor.byteOffset, descriptor.length);
      if (collapse) {
        const Type = surface.index.type === 'Uint16Array' ? Uint16Array : Uint32Array;
        const indices = new Type(damaged.buffer, damaged.byteOffset + surface.index.byteOffset, surface.index.length);
        for (const vertex of indices.subarray(0, 3)) { uv[vertex * 2] = 0.5; uv[vertex * 2 + 1] = 0.5; }
      } else uv[0] = 1.01;
      invalid.sha256 = createHash('sha256').update(damaged).digest('hex');
      const loader = await freshLoader(); let requests = 0;
      const result = await loader.loadAuthoredCharacterSurfaces({ fetchImpl: assets(invalid, damaged), textureLoader: {
        loadAsync: async () => { requests++; return decodedTexture().texture; },
      } });
      assert.equal(result.state, 'fallback'); assert.match(result.error, /atlas/);
      assert.equal(requests, 0, 'Broken tangent bases fail before any finish image is loaded');
      assert.equal(loader.getAuthoredCharacterSurfaces(entry.config, entry.dimensions, bindBones(entry)), null);
    }
  });

  await t.test('oversized or undersized decoded images cannot bypass the texture budget', async () => {
    for (const width of [256, 1024]) {
      const loader = await freshLoader(), textures = [];
      const result = await loader.loadAuthoredCharacterSurfaces({ fetchImpl: assets(manifest, bytes), textureLoader: {
        loadAsync: async () => { const value = decodedTexture(width); textures.push(value); return value.texture; },
      } });
      assert.equal(result.state, 'fallback'); assert.match(result.error, /512/);
      assert.equal(textures.length, 4);
      assert.ok(textures.every(value => value.disposals() === 1));
    }
  });

  await t.test('a timed-out texture batch is discarded and a retry owns a fresh complete set', async () => {
    const loader = await freshLoader(), late = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const result = await loader.loadAuthoredCharacterSurfaces({ fetchImpl: assets(manifest, bytes), timeoutMs: 250,
      textureLoader: { loadAsync: async () => {
        const value = decodedTexture(); late.push(value); await gate; return value.texture;
      } } });
    assert.equal(result.state, 'fallback'); assert.match(result.error, /timed out/);
    assert.equal(late.length, 4, 'This timeout occurs during image decoding after the complete geometry candidate was prepared');
    assert.equal(loader.getAuthoredCharacterSurfaces(gunman.config, gunman.dimensions, bindBones(gunman)), null);
    const retry = [];
    const accepted = await loader.loadAuthoredCharacterSurfaces({ fetchImpl: assets(manifest, bytes),
      textureLoader: { loadAsync: async () => { const value = decodedTexture(); retry.push(value); return value.texture; } } });
    assert.equal(accepted.state, 'ready', accepted.error);
    release(); await nextTurn();
    assert.ok(late.every(value => value.disposals() === 1));
    assert.equal(retry.length, 4); assert.ok(retry.every(value => value.disposals() === 0));
    assert.equal(loader.getAuthoredCharacterStatus().state, 'ready', 'A late expired batch cannot replace or revoke a successful retry');
  });

  await t.test('production pools share four maps while same-role fallback and seven other appearances retain their materials', async () => {
    const original = new Map(manifest.catalog.map(entry => [entry.id, createHumanoidRig(entry.config)]));
    const textures = [], mapCalls = [], fetchCalls = [];
    const options = { fetchImpl: assets(manifest, bytes, fetchCalls), textureLoader: { loadAsync: async url => {
      mapCalls.push(url); const value = decodedTexture(); textures.push(value); return value.texture;
    } } };
    const results = await Promise.all([loadAuthoredCharacterSurfaces(options), loadAuthoredCharacterSurfaces(options)]);
    for (const result of results) {
      assert.equal(result.state, 'ready', result.error); assert.equal(result.textures, 4);
      assert.equal(result.textureBytes, 4 * Math.ceil(512 * 512 * 4 * 4 / 3));
      assert.deepEqual(result.finishes, ['gunman']);
    }
    await loadAuthoredCharacterSurfaces(options);
    assert.equal(fetchCalls.length, 2); assert.equal(mapCalls.length, 4);
    const loaded = createHumanoidRig(gunman.config), pooled = createHumanoidRig({ ...gunman.config, seed: 73 });
    const meshes = Object.fromEntries(loaded.userData.rig.visualMeshes.map(mesh => [mesh.name, mesh]));
    const before = original.get('gunman').userData.rig;
    assert.equal(loaded.userData.rig.hero.source, 'original-blender-sculpted-baked');
    assert.equal(loaded.userData.rig.hero.finish, 'gunman-sculpt-bake-v1');
    assert.equal(loaded.userData.rig.hero.draws, 4);
    assert.ok(loaded.userData.rig.hero.triangles <= 15000);
    assert.equal(meshes['hero-garments'].material.normalMap, textures[0].texture);
    assert.equal(meshes['hero-garments'].material.roughnessMap, textures[1].texture);
    assert.equal(meshes['hero-head'].material.normalMap, textures[2].texture);
    assert.equal(meshes['hero-head'].material.roughnessMap, textures[3].texture);
    assert.equal(meshes['hero-garments'].material.map, null, 'A unique UV atlas cannot reuse the old tiling color map');
    assert.equal(meshes['hero-garments'].material.userData.heroSurface, undefined, 'The bake supplies actual roughness and full sculpt normals');
    assert.ok(meshes['hero-head'].material.userData.heroFaceAlbedo, 'Existing face projection remains on the baked head');
    for (let part = 0; part < 4; part++) {
      assert.equal(loaded.userData.rig.visualMeshes[part].material, pooled.userData.rig.visualMeshes[part].material);
      assert.equal(loaded.userData.rig.visualMeshes[part].geometry, pooled.userData.rig.visualMeshes[part].geometry);
    }
    assert.notEqual(loaded.userData.rig.hero.skeleton, pooled.userData.rig.hero.skeleton);
    const fallback = createHumanoidRig({ ...gunman.config, height: gunman.config.height + 0.01 });
    assert.equal(fallback.userData.rig.hero.source, 'original-procedural');
    for (let part = 0; part < 4; part++) assert.equal(fallback.userData.rig.visualMeshes[part].material, before.visualMeshes[part].material);
    for (const entry of manifest.catalog.filter(value => value.id !== 'gunman')) {
      const root = createHumanoidRig(entry.config);
      assert.equal(root.userData.rig.hero.source, 'original-blender-prepared');
      for (let part = 0; part < 4; part++) assert.equal(root.userData.rig.visualMeshes[part].material,
        original.get(entry.id).userData.rig.visualMeshes[part].material, `${entry.id}: an unrelated UV layout keeps its existing material`);
    }
    for (const { texture, disposals } of textures) {
      assert.equal(texture.colorSpace, THREE.NoColorSpace); assert.equal(texture.flipY, true);
      assert.equal(texture.wrapS, THREE.ClampToEdgeWrapping); assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
      assert.equal(texture.generateMipmaps, true); assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
      assert.equal(disposals(), 0, 'Shared live maps are not disposed when pool slots are constructed');
    }
    const accidental = heroCharacterMaterials({ ...gunman.config, role: 'thug' }, { finish: {
      version: 1, role: 'gunman', garments: { normalMap: textures[0].texture }, head: {},
    } });
    assert.notEqual(accidental.garments.normalMap, textures[0].texture);
  });
});
