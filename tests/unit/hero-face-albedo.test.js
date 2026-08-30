import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHumanoidRig } from '../../src/render/humanoid-rig.js';
import {
  loadHeroFaceAlbedo, setHeroFaceTextureEnabled, setHeroFaceTextureTuning, getHeroFaceTextureStatus,
} from '../../src/render/hero-face-albedo.js';

const texture = (size = 1254) => { const map = new THREE.Texture({ width: size, height: size }); return map; };
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
const face = config => createHumanoidRig(config).userData.rig.visualMeshes.find(mesh => mesh.name === 'hero-head');

function sampleProjection(geometry, x, y) {
  const { position, heroFaceProjection: uv } = geometry.attributes, index = geometry.index;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    if (Math.min(position.getZ(a), position.getZ(b), position.getZ(c)) < 0.2) continue;
    const ax = position.getX(a), ay = position.getY(a), bx = position.getX(b), by = position.getY(b), cx = position.getX(c), cy = position.getY(c);
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denominator) < 1e-10) continue;
    const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
    const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator, wc = 1 - wa - wb;
    if (Math.min(wa, wb, wc) < -1e-6) continue;
    return Array.from({ length: 4 }, (_, k) => uv.getComponent(a, k) * wa + uv.getComponent(b, k) * wb + uv.getComponent(c, k) * wc);
  }
  throw new Error('Expected frontal head triangle was absent');
}

test('the actual head surface projects into the supplied source landmarks without mapping its back or hair', () => {
  const head = face({ role: 'brawler', skin: '#c09072' }), geometry = head.geometry;
  const projection = geometry.attributes.heroFaceProjection, p = geometry.attributes.position;
  assert.equal(projection.count, p.count); assert.equal(projection.itemSize, 4);
  for (const [x, y, u, imageY] of [[-0.175, 0.554, 0.37075, 0.42], [0.175, 0.554, 0.63325, 0.42], [0, 0.371, 0.502, 0.607], [0, 0.242, 0.502, 0.718]]) {
    const sample = sampleProjection(geometry, x, y);
    near(sample[0], u); near(1 - sample[1], imageY, 0.0025);
    assert.ok(sample[2] > 0.98, 'Landmarks need an uninterrupted forward projection');
    near(sample[3], y);
  }
  for (let i = 0; i < p.count; i++) {
    for (let k = 0; k < 4; k++) assert.ok(Number.isFinite(projection.getComponent(i, k)));
    assert.ok(projection.getZ(i) >= 0 && projection.getZ(i) <= 1);
    if (p.getZ(i) < -0.1 || p.getY(i) > 0.841) near(projection.getZ(i), 0);
  }
  assert.equal(getHeroFaceTextureStatus().status, 'unloaded');
  assert.equal(getHeroFaceTextureStatus().enabled, false);
  assert.equal(face({ kind: 'child' }).material.name, 'hero-skin');
  assert.equal(face({ kind: 'woman' }).material.name, 'hero-skin');
});

test('decoded trial pixels update cached face materials while A/B toggles keep geometry, shader programs and skin palettes unchanged', async () => {
  const first = face({ role: 'brawler', skin: '#c09072' }), second = face({ role: 'gunman', skin: '#c39780' });
  const old = [first, second].map(mesh => ({ geometry: mesh.geometry, material: mesh.material, color: mesh.material.color.clone(), version: mesh.material.version }));
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  first.material.onBeforeCompile(shader);
  assert.ok(shader.vertexShader.includes('vHeroFaceProjection = heroFaceProjection;'));
  assert.ok(shader.fragmentShader.includes('diffuse * paletteRelative'));
  assert.ok(shader.fragmentShader.includes('eyeMask * browMask'));
  assert.ok(shader.fragmentShader.includes('#include <normal_fragment_maps>'), 'PBR normal lighting must stay intact');
  const map = texture(); let loads = 0;
  const options = { url: '/test-face-ready.png', referenceColor: '#b78a72', loader: { loadAsync: async () => { loads++; return map; } } };
  const statuses = await Promise.all([loadHeroFaceAlbedo(options), loadHeroFaceAlbedo(options)]);
  assert.equal(loads, 1); assert.equal(statuses[0].status, 'ready'); assert.equal(statuses[1].enabled, false);
  assert.equal(map.colorSpace, THREE.SRGBColorSpace); assert.equal(map.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(map.generateMipmaps, true); assert.equal(map.flipY, true);
  assert.ok(statuses[0].memoryBytes <= 8 * 1024 * 1024, 'Only one bounded source texture is retained');
  assert.equal(shader.uniforms.heroFaceAlbedo.value, map);
  assert.equal(first.material.heroFaceMap, map); assert.equal(second.material.heroFaceMap, map);
  assert.equal(setHeroFaceTextureEnabled(true).enabled, true); assert.equal(shader.uniforms.heroFaceEnabled.value, 1);
  assert.equal(setHeroFaceTextureEnabled(false).enabled, false); assert.equal(shader.uniforms.heroFaceEnabled.value, 0);
  for (let i = 0; i < old.length; i++) {
    const mesh = [first, second][i]; assert.equal(mesh.geometry, old[i].geometry); assert.equal(mesh.material, old[i].material);
    assert.equal(mesh.material.version, old[i].version); assert.ok(mesh.material.color.equals(old[i].color));
  }
  assert.equal(face({ role: 'hitman', skin: '#ad7a5d' }).material.heroFaceMap, map, 'Later pooled variants use the already decoded source');
  const status = setHeroFaceTextureTuning({ strength: 0.6 }); near(status.strength, 0.6);
  assert.match(status.provenance, /AI-generated fictional facial albedo/);
  assert.match(status.provenance, /mild source shading/);
  assert.equal(status.review, 'accepted-2026-08-29');
  assert.throws(() => setHeroFaceTextureTuning({ strength: 1.5 }), RangeError);
  setHeroFaceTextureTuning({ strength: 0.78 });
});

test('missing, oversized and timed-out assets preserve the authored fallback and dispose rejected texture data', async () => {
  setHeroFaceTextureEnabled(true);
  let status = await loadHeroFaceAlbedo({ url: '/missing.png', loader: { loadAsync: () => { throw new Error('not found'); } } });
  assert.equal(status.status, 'failed'); assert.equal(status.enabled, false); assert.match(status.error, /not found/);
  const large = texture(2048); let disposed = 0; large.addEventListener('dispose', () => disposed++);
  status = await loadHeroFaceAlbedo({ url: '/oversized.png', loader: { loadAsync: async () => large } });
  assert.equal(status.status, 'failed'); assert.equal(status.enabled, false); assert.equal(disposed, 1);
  status = await loadHeroFaceAlbedo({ url: '/undecoded.png', loader: { loadAsync: async () => new THREE.Texture() } });
  assert.equal(status.status, 'failed'); assert.equal(status.enabled, false); assert.ok(Number.isFinite(status.memoryBytes));
  status = await loadHeroFaceAlbedo({ url: '/not-texture.png', loader: { loadAsync: async () => ({ image: { width: 1024, height: 1024 } }) } });
  assert.equal(status.status, 'failed'); assert.equal(status.enabled, false);
  const late = texture(); late.addEventListener('dispose', () => disposed++); let resolve;
  status = await loadHeroFaceAlbedo({ url: '/timeout.png', timeoutMs: 1, loader: { loadAsync: () => new Promise(done => { resolve = done; }) } });
  assert.equal(status.status, 'failed'); assert.equal(status.enabled, false);
  resolve(late); await new Promise(done => setTimeout(done, 0)); assert.equal(disposed, 2);
  setHeroFaceTextureEnabled(false);
  status = await loadHeroFaceAlbedo({ url: '/recovered.png', loader: { loadAsync: async () => texture() } });
  assert.equal(status.status, 'ready'); assert.equal(status.enabled, false, 'Recovery must not enable an unreviewed trial');
});

test('simultaneous distinct face sources cannot silently resolve to the wrong asset', async () => {
  let release;
  const loading = loadHeroFaceAlbedo({ url: '/source-a.png', loader: { loadAsync: () => new Promise(resolve => { release = resolve; }) } });
  await assert.rejects(loadHeroFaceAlbedo({ url: '/source-b.png', loader: { loadAsync: async () => texture() } }), /different face/);
  release(texture()); const status = await loading;
  assert.equal(status.url, '/source-a.png'); assert.equal(status.status, 'ready'); assert.equal(status.enabled, false);
});
