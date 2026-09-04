import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { getHandMaterials } from '../../src/render/hand-materials.js';
import { loadAuthoredHandFinish, getAuthoredHandFinishMaps } from '../../src/render/authored-hand-finish.js';

let fixture = 0;
const isolated = () => import(`../../src/render/authored-hand-finish.js?fixture=${fixture++}`);
function imageTexture(size = 512) {
  const texture = new THREE.Texture({ width: size, height: size });
  texture.userData.disposals = 0;
  texture.addEventListener('dispose', () => { texture.userData.disposals++; });
  return texture;
}
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

test('baked hand maps load once across concurrent callers and keep correct PNG color and UV conventions', async () => {
  const api = await isolated(), textures = [], urls = [];
  const loader = { loadAsync: async url => { urls.push(url); const texture = imageTexture(); textures.push(texture); return texture; } };
  const result = await Promise.all([api.loadAuthoredHandFinish({ loader }), api.loadAuthoredHandFinish({ loader })]);
  assert.equal(urls.length, 3);
  assert.ok(result.every(status => status.state === 'ready'));
  assert.equal(result[0].textureBytes, 4 * 1024 * 1024);
  assert.equal(result[0].textures, 3);
  assert.deepEqual(urls, ['/assets/models/hands/hand-albedo.png', '/assets/models/hands/hand-normal.png', '/assets/models/hands/hand-roughness.png']);
  const maps = api.getAuthoredHandFinishMaps(), versions = textures.map(texture => texture.version);
  for (const [key, texture] of Object.entries(maps)) {
    assert.equal(texture.colorSpace, key === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace);
    assert.equal(texture.flipY, true);
    assert.equal(texture.wrapS, THREE.ClampToEdgeWrapping); assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
    assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter); assert.equal(texture.magFilter, THREE.LinearFilter);
    assert.equal(texture.generateMipmaps, true); assert.equal(texture.anisotropy, 4);
  }
  await api.loadAuthoredHandFinish({ loader, url: '/unused-catalog' });
  assert.equal(urls.length, 3, 'A ready catalog never reassigns resources already used by live viewmodels');
  assert.equal(api.getAuthoredHandFinishMaps(), maps);
  assert.deepEqual(textures.map(texture => texture.version), versions);
  assert.ok(textures.every(texture => texture.userData.disposals === 0));
  const status = api.getAuthoredHandFinishStatus(); status.state = 'changed';
  assert.equal(api.getAuthoredHandFinishStatus().state, 'ready');
});

test('a failed map discards both decoded and late textures without exposing an incomplete atlas', async () => {
  const api = await isolated(), first = imageTexture(), late = imageTexture(); let finishLate;
  let call = 0;
  const result = await api.loadAuthoredHandFinish({ loader: { loadAsync: () => {
    call++;
    if (call === 1) return Promise.resolve(first);
    if (call === 2) return Promise.reject(new Error('Texture HTTP 404'));
    return new Promise(resolve => { finishLate = resolve; });
  } } });
  assert.equal(result.state, 'fallback'); assert.match(result.reason, /404/);
  assert.equal(api.getAuthoredHandFinishMaps(), null);
  assert.equal(first.userData.disposals, 1);
  finishLate(late); await nextTurn();
  assert.equal(late.userData.disposals, 1);
  assert.equal(api.getAuthoredHandFinishStatus().state, 'fallback');
});

test('a timed-out decode disposes its eventual images and cannot replace a successful retry', async () => {
  const api = await isolated(), deferred = [], late = [imageTexture(), imageTexture(), imageTexture()];
  const timedOut = await api.loadAuthoredHandFinish({ timeoutMs: 5,
    loader: { loadAsync: () => new Promise(resolve => deferred.push(resolve)) } });
  assert.equal(timedOut.state, 'fallback'); assert.match(timedOut.reason, /timed out/);
  assert.equal(api.getAuthoredHandFinishMaps(), null);
  const retry = await api.loadAuthoredHandFinish({ loader: { loadAsync: async () => imageTexture() } });
  assert.equal(retry.state, 'ready');
  const retryMaps = api.getAuthoredHandFinishMaps();
  deferred.forEach((resolve, index) => resolve(late[index])); await nextTurn();
  assert.ok(late.every(texture => texture.userData.disposals === 1));
  assert.equal(api.getAuthoredHandFinishMaps(), retryMaps);
  assert.equal(api.getAuthoredHandFinishStatus().state, 'ready');
});

test('the hand texture budget rejects oversized and missing images while allowing a later valid set', async () => {
  for (const bad of [imageTexture(1024), new THREE.Texture()]) {
    const api = await isolated(), textures = [bad, imageTexture(), imageTexture()]; let call = 0;
    const failed = await api.loadAuthoredHandFinish({ loader: { loadAsync: async () => textures[call++] } });
    assert.equal(failed.state, 'fallback'); assert.match(failed.reason, /decoded 512px/);
    assert.equal(api.getAuthoredHandFinishMaps(), null);
    assert.equal(textures[1].userData.disposals, 1); assert.equal(textures[2].userData.disposals, 1);
    const recovered = await api.loadAuthoredHandFinish({ loader: { loadAsync: async () => imageTexture() } });
    assert.equal(recovered.state, 'ready');
  }
});

test('three finish slots cannot alias a single image or texture', async () => {
  for (const sharedSource of [false, true]) {
    const api = await isolated(), texture = imageTexture(), copies = [texture, texture, texture];
    if (sharedSource) { copies[1] = texture.clone(); copies[2] = texture.clone(); }
    let call = 0;
    const result = await api.loadAuthoredHandFinish({ loader: { loadAsync: async () => copies[call++] } });
    assert.equal(result.state, 'fallback'); assert.match(result.reason, /independent baked maps/);
    assert.equal(api.getAuthoredHandFinishMaps(), null);
    assert.equal(texture.userData.disposals, 1);
  }
});

test('baked and procedural geometry use separate hand atlases with the same shader and shared sleeves', async () => {
  const fallback = getHandMaterials(), originalMap = fallback.hand.map;
  assert.equal(getHandMaterials({ authored: true }), fallback, 'A missing finish preserves the existing material');
  const status = await loadAuthoredHandFinish({ loader: { loadAsync: async () => imageTexture() } });
  assert.equal(status.state, 'ready');
  const baked = getHandMaterials({ authored: true }), maps = getAuthoredHandFinishMaps();
  assert.notEqual(baked.hand, fallback.hand);
  assert.equal(baked.sleeve, fallback.sleeve); assert.equal(baked.cuff, fallback.cuff);
  assert.equal(baked.sleeve.map, baked.cuff.map);
  assert.equal(getHandMaterials(), fallback, 'Unsupported or original UV layouts still select the procedural atlas');
  assert.equal(fallback.hand.map, originalMap); assert.equal(originalMap.image.width, 256);
  for (const key of ['map', 'normalMap', 'roughnessMap']) assert.equal(baked.hand[key], maps[key]);
  assert.equal(baked.hand.type, fallback.hand.type);
  assert.equal(baked.hand.customProgramCacheKey(), fallback.hand.customProgramCacheKey());
  assert.deepEqual(baked.hand.defines, fallback.hand.defines);
  assert.equal(baked.hand.vertexColors, fallback.hand.vertexColors);
  assert.equal(baked.hand.metalness, 0); assert.equal(baked.hand.roughness, 1);
  assert.deepEqual(baked.hand.normalScale.toArray(), [1, 1], 'The sculpt normal bake keeps its authored strength');
  assert.equal(baked.hand.userData.handFinish.profile, 'blender-hand-bake-v2');
  const versions = Object.values(maps).map(texture => texture.version);
  for (let frame = 0; frame < 100; frame++) assert.equal(getHandMaterials({ authored: true }), baked);
  assert.deepEqual(Object.values(maps).map(texture => texture.version), versions, 'Material reuse never uploads maps per pose');
});
