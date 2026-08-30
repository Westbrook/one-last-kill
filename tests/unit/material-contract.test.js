import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import * as math from '../../src/core/math.js';
import { SURFACE_METERS, SURFACE_SPECS, bakeSurfaceData, deriveSurfaceData, normalsFromHeights } from '../../src/render/surface-detail.js';
import { PBR_SURFACES, PBR_KTX2_TRIAL, getRequestedSurfaceFormat, supportsPbrCompression, loadPbrMaterial, loadPbrMaterialWithFallback, commitSurfaceMaps } from '../../src/render/pbr-materials.js';

const fixtures = new Map();
const RAW_QA_OPTIONS = { dev: true, search: '?qa=1&mute=1&surfaces=raw' };
function surface(kind) {
  if (!fixtures.has(kind)) fixtures.set(kind, bakeSurfaceData(kind, { size: 64 }));
  return fixtures.get(kind);
}

function assertEdges(map, width, height, label) {
  for (let y = 0; y < height; y++) {
    for (let channel = 0; channel < 4; channel++) {
      assert.equal(map[y * width * 4 + channel], map[(y * width + width - 1) * 4 + channel], `${label} horizontal seam`);
    }
  }
  for (let x = 0; x < width; x++) {
    for (let channel = 0; channel < 4; channel++) {
      assert.equal(map[x * 4 + channel], map[((height - 1) * width + x) * 4 + channel], `${label} vertical seam`);
    }
  }
}

test('procedural channels are deterministic, seamless and within physical finish bounds', () => {
  for (const [kind, spec] of Object.entries(SURFACE_SPECS)) {
    const data = surface(kind);
    assert.ok(SURFACE_METERS[kind] > 0 && SURFACE_METERS[kind] <= 4);
    assert.deepEqual(data.albedo, bakeSurfaceData(kind, { size: 64 }).albedo, `${kind} deterministic color`);
    for (const [name, map] of [['albedo', data.albedo], ['normal', data.normal], ['orm', data.orm]]) {
      assert.equal(map.length, 64 * 64 * 4);
      assertEdges(map, 64, 64, `${kind} ${name}`);
      for (let i = 3; i < map.length; i += 4) assert.equal(map[i], 255, `${kind} is opaque`);
    }
    for (let i = 0; i < data.orm.length; i += 4) {
      assert.ok(data.orm[i + 1] >= Math.round(spec.roughness[0] * 255), `${kind} roughness minimum`);
      assert.ok(data.orm[i + 1] <= Math.round(spec.roughness[1] * 255), `${kind} roughness maximum`);
      assert.equal(data.orm[i], 255, 'no baked directional shadow in the material');
      if (!spec.metallic) assert.equal(data.orm[i + 2], 0, `${kind} is nonmetallic`);
      else assert.ok(data.orm[i + 2] <= 179, `${kind} is weathered rather than mirror chrome`);
      assert.ok(data.normal[i + 2] >= 128, `${kind} normals face outwards`);
    }
    assert.ok(Array.from(data.heights).every(Number.isFinite));
  }
});

test('wood keeps correlated aged-oak channels and shallow staggered joints', () => {
  const data = surface('wood');
  for (let i = 0; i < data.albedo.length; i += 4) {
    assert.equal(data.albedo[i] - data.albedo[i + 1], 9);
    assert.equal(data.albedo[i + 1] - data.albedo[i + 2], 9);
  }
  const lowest = Math.min(...data.heights), highest = Math.max(...data.heights);
  assert.ok(highest - lowest < 0.0015, 'grain/joints stay millimetric');
  const rowSample = row => {
    const y = Math.round((row + 0.5) / 16 * 63);
    let darkest = 255, column = 0;
    for (let x = 0; x < 63; x++) {
      const tone = data.albedo[(y * 64 + x) * 4];
      if (tone < darkest) { darkest = tone; column = x; }
    }
    return column;
  };
  assert.ok(new Set([1, 2, 3, 4, 5, 6].map(rowSample)).size >= 3, 'end joints do not form one repeated vertical stripe');
});

test('surface baking is bounded and normal orientation matches texture flipY', () => {
  assert.throws(() => bakeSurfaceData('unknown'), RangeError);
  for (const size of [0, 31, 1024, NaN, 64.5]) assert.throws(() => bakeSurfaceData('concrete', { size }), RangeError);
  const full = bakeSurfaceData('asphalt');
  assert.equal(full.width, 512); assert.equal(full.height, 512);
  assert.equal(full.albedo.byteLength + full.normal.byteLength + full.orm.byteLength, 3 * 512 * 512 * 4);
  const heights = Float32Array.from({ length: 16 }, (_, i) => (i % 4 + Math.floor(i / 4)) * 0.01);
  const normal = normalsFromHeights(heights, 4, 4, 1);
  assert.ok(normal[(1 * 4 + 1) * 4] < 128, 'rising X tilts normal towards negative X');
  assert.ok(normal[(1 * 4 + 1) * 4 + 1] > 128, 'downward image gradient becomes positive texture Y');
  assert.throws(() => normalsFromHeights(heights, 4, 4, Infinity), RangeError);
  assert.throws(() => normalsFromHeights(heights, 1, 16, 1), RangeError);
});

function sourcePixels(width, height, kind) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = kind === 'brick'
        ? (y % 16 < 3 ? [145, 143, 135] : [131, 78, 55])
        : (x < width / 2 ? [170, 172, 162] : [118, 120, 110]);
      const index = (y * width + x) * 4;
      pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2]; pixels[index + 3] = 255;
    }
  }
  return pixels;
}

test('generated brick recesses pale mortar and plaster does not emboss broad stains', () => {
  const brick = deriveSurfaceData(sourcePixels(64, 64, 'brick'), 64, 64, 'brick');
  const mortarIndex = 1 * 64 + 10, faceIndex = 9 * 64 + 10;
  assert.ok(brick.heights[mortarIndex] < 0.0002);
  assert.ok(brick.heights[faceIndex] > 0.003);
  assert.ok(brick.orm[mortarIndex * 4 + 1] > brick.orm[faceIndex * 4 + 1]);
  for (let i = 1; i < brick.orm.length; i += 4) assert.ok(brick.orm[i] >= 214, 'dry clay/mortar cannot become polished');
  const plaster = deriveSurfaceData(sourcePixels(64, 64, 'plaster'), 64, 64, 'plaster');
  assert.equal(plaster.heights[20 * 64 + 12], 0, 'flat light paint has no invented displacement');
  assert.equal(plaster.heights[20 * 64 + 48], 0, 'flat dark patch has no invented displacement');
  assert.ok(Math.max(...plaster.heights) < 0.00033);
  assert.ok(Math.min(...plaster.heights) > -0.00033);
  assert.throws(() => deriveSurfaceData(new Uint8Array(5), 2, 2, 'brick'), RangeError);
  assert.throws(() => deriveSurfaceData(new Uint8Array(16), 2, 2, 'metal'), RangeError);
});

// The production material factory runs with real Three.js texture/material
// objects, but never imports its browser renderer. Canvas drawing is only a
// controlled image container here; pixel behavior is tested by the pure data
// functions above. Small bake sizes keep this wiring test inexpensive.
function materialHarness({
  failReadback = null, pbrSuccess = false, failPbr = {}, failGenerated = null,
  dev = false, search = '', failKtxImport = false, failKtxInit = false,
  ktxInitGate = null, holdKtx = null, failKtx = {}, ktxWorkerConfig = { astcSupported: true },
} = {}) {
  const canvases = [], requests = [], loaded = [], disposals = new Map();
  const ktx = { imports: 0, instances: [], requests: [], initCalls: 0, ready: false, disposals: 0 };
  const renderer = { capabilities: { getMaxAnisotropy: () => 16 } };
  function trackTexture(texture, url, kind) {
    texture.image.kind = kind;
    texture.userData.fixtureUrl = url;
    disposals.set(texture, 0);
    texture.addEventListener('dispose', () => disposals.set(texture, disposals.get(texture) + 1));
    loaded.push(texture);
    return texture;
  }
  const document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = { width: 0, height: 0, getContext() { return ctx; } };
      const ctx = {
        source: null,
        fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {},
        drawImage(image) { this.source = image; },
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
        createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
        getImageData(x, y, width, height) {
          if (this.source?.kind === failReadback) throw new Error('Fixture readback failure');
          return { data: this.source?.kind ? sourcePixels(width, height, this.source.kind) : new Uint8ClampedArray(width * height * 4) };
        },
        putImageData() {},
      };
      canvases.push(canvas); return canvas;
    },
  };
  class TextureLoader {
    async loadAsync(url) {
      requests.push(url);
      const kind = url.includes('brick') ? 'brick' : 'plaster';
      const pbr = url.startsWith('/assets/materials/');
      const channel = pbr ? Object.entries(PBR_SURFACES[kind].maps).find(([, path]) => path === url)?.[0] : null;
      if (pbr && (!pbrSuccess || failPbr[kind] === channel)) throw new Error(`Fixture PBR load failure: ${url}`);
      if (!pbr && failGenerated === kind) throw new Error(`Fixture generated load failure: ${url}`);
      const resolution = pbr ? 1024 : 1254;
      const texture = new THREE.Texture({ kind, width: resolution, height: resolution });
      return trackTexture(texture, url, kind);
    }
  }
  class KTX2Loader {
    constructor() { ktx.instances.push(this); }
    setTranscoderPath(path) { this.transcoderPath = path; return this; }
    setWorkerLimit(limit) { this.workerLimit = limit; return this; }
    detectSupport(target) {
      this.renderer = target;
      this.workerConfig = { ...ktxWorkerConfig };
      return this;
    }
    init() {
      ktx.initCalls++;
      this.transcoderPending = (async () => {
        if (ktxInitGate) await ktxInitGate;
        if (failKtxInit) throw new Error('Fixture KTX2 initialization failure');
        ktx.ready = true;
      })();
      return this.transcoderPending;
    }
    async loadAsync(url) {
      assert.equal(ktx.ready, true, 'KTX2 requests start after explicit initialization');
      assert.equal(ktx.disposals, 0, 'KTX2 requests never use a disposed worker pool');
      ktx.requests.push(url);
      const kind = url.includes('brick') ? 'brick' : 'plaster';
      const channel = Object.entries(PBR_KTX2_TRIAL[kind].maps).find(([, path]) => path === url)?.[0];
      if (holdKtx?.kind === kind && holdKtx.channel === channel) await holdKtx.promise;
      if (failKtx[kind] === channel) throw new Error(`Fixture KTX2 load failure: ${url}`);
      const mipmaps = [];
      for (let size = 1024; size >= 1; size /= 2) {
        mipmaps.push({ width: size, height: size, data: new Uint8Array(Math.ceil(size / 4) ** 2 * 16) });
      }
      const format = this.workerConfig.astcSupported ? THREE.RGBA_ASTC_4x4_Format
        : this.workerConfig.bptcSupported ? THREE.RGBA_BPTC_Format : THREE.RGBA_ETC2_EAC_Format;
      const texture = new THREE.CompressedTexture(mipmaps, 1024, 1024, format);
      texture.colorSpace = channel === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.flipY = false;
      texture.generateMipmaps = false;
      return trackTexture(texture, url, kind);
    }
    dispose() { ktx.disposals++; }
  }
  async function importKtx2Fixture() {
    ktx.imports++;
    if (failKtxImport) throw new Error('Fixture KTX2 import failure');
    return { KTX2Loader };
  }
  const source = readFileSync(new URL('../../src/render/materials.js', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/\bimport\.meta\.env\.DEV\b/g, String(dev))
    .replace(/import\((['"])three\/addons\/loaders\/KTX2Loader\.js\1\)/g, 'importKtx2Fixture()')
    .replace(/^export \{[^}]+\};\s*$/gm, '')
    .replace(/^export (?=function )/gm, '');
  assert.doesNotMatch(source, /^import\s/m, 'The explicit harness must replace browser-only imports');
  const api = runInNewContext(`${source}\n;({ MATS, loadSurfaceTextures, getSurfaceTextureStatus });`, {
    THREE: { ...THREE, TextureLoader }, document,
    renderer, location: { search }, URLSearchParams, importKtx2Fixture,
    ...math, SURFACE_METERS, SURFACE_SPECS, deriveSurfaceData,
    PBR_SURFACES, PBR_KTX2_TRIAL, getRequestedSurfaceFormat, supportsPbrCompression, loadPbrMaterial, loadPbrMaterialWithFallback, commitSurfaceMaps,
    bakeSurfaceData: kind => bakeSurfaceData(kind, { size: 64 }),
  }, { filename: 'materials.js' });
  return { ...api, canvases, requests, loaded, disposals, ktx, renderer };
}

test('shared lazy materials expose physical scales and aligned static PBR maps', () => {
  const { MATS, canvases } = materialHarness();
  assert.equal(canvases.length, 0, 'loading the module itself does not bake textures');
  for (const [kind, spec] of Object.entries(SURFACE_SPECS)) {
    assert.equal(typeof Object.getOwnPropertyDescriptor(MATS, kind).get, 'function');
    const material = MATS[kind];
    assert.equal(MATS[kind], material, `${kind} uses one shared material`);
    assert.equal(material.userData.surfaceMeters, SURFACE_METERS[kind]);
    assert.equal(material.roughness, 1, 'roughness data is not multiplied down a second time');
    assert.equal(material.bumpMap, null);
    assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
    for (const texture of [material.map, material.normalMap, material.roughnessMap]) {
      assert.deepEqual(texture.repeat.toArray(), [1, 1]);
      assert.equal(texture.wrapS, THREE.RepeatWrapping); assert.equal(texture.wrapT, THREE.RepeatWrapping);
      assert.equal(texture.anisotropy, 8); assert.equal(texture.flipY, true);
      assert.equal(texture.generateMipmaps, true);
    }
    assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace);
    assert.equal(material.roughnessMap.colorSpace, THREE.NoColorSpace);
    if (spec.metallic) assert.equal(material.metalnessMap, material.roughnessMap, 'metal finish shares one packed texture');
    else assert.equal(material.metalnessMap, null);
    const version = material.map.version;
    assert.equal(MATS[kind].map.version, version, 'reading a material does not schedule a texture upload');
  }
  assert.equal(canvases.length, 0, 'new procedural materials do not allocate painting canvases');
});

function installFallback(MATS, kind) {
  const textures = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
  const disposals = [0, 0, 0, 0];
  textures.forEach((texture, index) => texture.addEventListener('dispose', () => disposals[index]++));
  const material = new THREE.MeshStandardMaterial({ map: textures[0], normalMap: textures[1], roughnessMap: textures[2], bumpMap: textures[3] });
  material.userData.surfaceMeters = SURFACE_METERS[kind];
  Object.defineProperty(MATS, kind, { value: material, configurable: true });
  return { material, textures, disposals };
}

test('generated wall loading is idempotent and replaces every mismatched PBR channel', async () => {
  const fixture = materialHarness(RAW_QA_OPTIONS);
  const fallbacks = ['plaster', 'brick'].map(kind => installFallback(fixture.MATS, kind));
  const first = fixture.loadSurfaceTextures();
  assert.equal(fixture.loadSurfaceTextures(), first, 'assets and derived maps load once');
  const outcomes = await first;
  assert.equal(outcomes.length, 2); assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
  assert.deepEqual(fixture.requests.filter(url => !url.startsWith('/assets/materials/')).sort(),
    ['/assets/brick-weathered.png', '/assets/plaster-aged.png']);
  for (const { material, disposals } of fallbacks) {
    assert.deepEqual(disposals, [1, 1, 1, 1]);
    assert.equal(material.bumpMap, null); assert.equal(material.roughness, 1); assert.equal(material.metalness, 0);
    assert.equal(material.map.image.width, 1254, 'original color resolution is preserved');
    assert.equal(material.normalMap.image.width, 512); assert.equal(material.roughnessMap.image.width, 512);
    for (const texture of [material.map, material.normalMap, material.roughnessMap]) assert.deepEqual(texture.repeat.toArray(), [1, 1]);
    assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace);
    assert.equal(material.roughnessMap.colorSpace, THREE.NoColorSpace);
  }
});

test('a generated-map readback failure leaves that procedural fallback intact', async () => {
  const fixture = materialHarness({ ...RAW_QA_OPTIONS, failReadback: 'brick' });
  installFallback(fixture.MATS, 'plaster');
  const fallback = installFallback(fixture.MATS, 'brick');
  const outcomes = await fixture.loadSurfaceTextures();
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected');
  assert.equal(fixture.MATS.brick.map, fallback.textures[0]);
  assert.equal(fixture.MATS.brick.normalMap, fallback.textures[1]);
  assert.deepEqual(fallback.disposals, [0, 0, 0, 0]);
  const failedTexture = fixture.loaded.find(texture => texture.image.kind === 'brick');
  assert.equal(fixture.disposals.get(failedTexture), 1);
});

test('PBR wall loading preserves shared materials, adopts source scales and skips generated downloads', async () => {
  const fixture = materialHarness({ ...RAW_QA_OPTIONS, pbrSuccess: true });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.getSurfaceTextureStatus())), {
    requestedMode: 'ktx2', state: 'idle', materials: {},
  });
  const fallbacks = new Map(['plaster', 'brick'].map(kind => [kind, installFallback(fixture.MATS, kind)]));
  for (const { material } of fallbacks.values()) material.userData.generatedAlbedoUrl = '/assets/previous.png';
  const first = fixture.loadSurfaceTextures();
  assert.equal(fixture.getSurfaceTextureStatus().state, 'loading');
  assert.equal(fixture.loadSurfaceTextures(), first, 'concurrent callers share one loading operation');
  const outcomes = await first;
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
  assert.equal(fixture.loadSurfaceTextures(), first, 'completed loading is also cached');
  assert.deepEqual(fixture.requests.slice().sort(), Object.values(PBR_SURFACES).flatMap(spec => Object.values(spec.maps)).sort());
  assert.equal(fixture.canvases.length, 0, 'authored PBR channels are adopted without canvas readback or rebaking');
  const status = fixture.getSurfaceTextureStatus();
  assert.equal(status.requestedMode, 'raw');
  assert.equal(status.state, 'complete');
  for (const [kind, { material, disposals }] of fallbacks) {
    const spec = PBR_SURFACES[kind];
    assert.equal(fixture.MATS[kind], material, `${kind} preserves references held by scene builders`);
    assert.deepEqual(disposals, [1, 1, 1, 1], `${kind} retires all old channels`);
    assert.equal(material.userData.surfaceMeters, kind === 'brick' ? 1.4 : 4);
    assert.equal(material.userData.surfaceSource, 'polyhaven');
    assert.ok(material.userData.pbrProvenance, `${kind} retains source provenance`);
    assert.equal(material.userData.generatedAlbedoUrl, undefined);
    assert.equal(material.userData.staticSurfaceMaps, true);
    assert.equal(material.userData.textureBytes, 3 * 1024 * 1024 * 4);
    assert.equal(material.bumpMap, null);
    assert.equal(material.metalnessMap, null);
    assert.equal(material.roughness, 1);
    assert.equal(material.metalness, 0);
    assert.equal(status.materials[kind].status, 'ready');
    assert.equal(status.materials[kind].source, 'polyhaven');
    assert.equal(status.materials[kind].format, 'raw');
    assert.equal(status.materials[kind].tileMeters, spec.meters);
    assert.equal(status.materials[kind].fallback, false);
    assert.equal(status.materials[kind].fallbackReason, null);
    assert.equal(status.materials[kind].compressedBytes, 0);
    for (const [channel, url] of Object.entries(spec.maps)) {
      const texture = fixture.loaded.find(candidate => candidate.userData.fixtureUrl === url);
      assert.equal(material[channel], texture, `${kind} adopts the authored ${channel}`);
      assert.equal(texture.image.width, 1024);
      assert.equal(texture.image.height, 1024);
      assert.equal(texture.colorSpace, channel === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace);
      assert.deepEqual(texture.repeat.toArray(), [1, 1]);
      assert.equal(fixture.disposals.get(texture), 0, 'adopted maps remain live');
    }
  }
  status.requestedMode = 'changed-by-caller';
  status.materials.brick.tileMeters = -1;
  status.materials.brick.gpuFormats.map = -1;
  delete status.materials.plaster;
  const nextStatus = fixture.getSurfaceTextureStatus();
  assert.equal(nextStatus.requestedMode, 'raw');
  assert.equal(nextStatus.materials.brick.tileMeters, 1.4);
  assert.equal(nextStatus.materials.brick.gpuFormats.map, fixture.MATS.brick.map.format);
  assert.equal(nextStatus.materials.plaster.status, 'ready', 'status snapshots do not expose mutable internal records');
});

test('an incomplete PBR material falls back to a complete generated set at its original scale', async () => {
  const fixture = materialHarness({ ...RAW_QA_OPTIONS, pbrSuccess: true, failPbr: { brick: 'normalMap' } });
  const plaster = installFallback(fixture.MATS, 'plaster');
  const brick = installFallback(fixture.MATS, 'brick');
  const outcomes = await fixture.loadSurfaceTextures();
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
  assert.deepEqual(fixture.requests.filter(url => !url.startsWith('/assets/materials/')), ['/assets/brick-weathered.png']);
  assert.equal(fixture.MATS.brick, brick.material);
  assert.equal(fixture.MATS.plaster, plaster.material);
  assert.equal(plaster.material.userData.surfaceSource, 'polyhaven', 'one failed material does not roll back the other');
  assert.equal(brick.material.userData.surfaceMeters, SURFACE_METERS.brick);
  assert.equal(brick.material.userData.generatedAlbedoUrl, '/assets/brick-weathered.png');
  assert.equal(brick.material.userData.pbrProvenance, undefined);
  assert.equal(brick.material.userData.surfaceSource, 'generated');
  assert.equal(brick.material.map.image.width, 1254);
  assert.equal(brick.material.normalMap.image.width, 512);
  assert.equal(brick.material.roughnessMap.image.width, 512);
  const status = fixture.getSurfaceTextureStatus();
  assert.equal(status.state, 'complete');
  assert.equal(status.materials.plaster.status, 'ready');
  assert.equal(status.materials.brick.status, 'fallback');
  assert.equal(status.materials.brick.format, 'generated');
  assert.equal(status.materials.brick.fallbackReason, 'raw-pbr-load-failed');
  assert.deepEqual(brick.disposals, [1, 1, 1, 1]);
  const abandoned = fixture.loaded.filter(texture => texture.image.kind === 'brick' && texture.userData.fixtureUrl.startsWith('/assets/materials/'));
  assert.equal(abandoned.length, 2, 'only the failed channel lacks a candidate texture');
  for (const texture of abandoned) assert.equal(fixture.disposals.get(texture), 1, 'partial PBR channels do not leak or mix with fallback maps');
});

test('failed PBR and generated downloads leave procedural channels and metadata intact', async () => {
  const fixture = materialHarness({ ...RAW_QA_OPTIONS, pbrSuccess: true, failPbr: { brick: 'roughnessMap' }, failGenerated: 'brick' });
  installFallback(fixture.MATS, 'plaster');
  const fallback = installFallback(fixture.MATS, 'brick');
  fallback.material.userData.owner = 'procedural-fixture';
  const metadata = { ...fallback.material.userData };
  const version = fallback.material.version;
  const outcomes = await fixture.loadSurfaceTextures();
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(fixture.MATS.brick, fallback.material);
  for (const [index, channel] of ['map', 'normalMap', 'roughnessMap', 'bumpMap'].entries()) {
    assert.equal(fallback.material[channel], fallback.textures[index], `${channel} remains procedural`);
  }
  assert.deepEqual(fallback.material.userData, metadata);
  assert.equal(fallback.material.version, version, 'no incomplete replacement schedules shader compilation');
  assert.deepEqual(fallback.disposals, [0, 0, 0, 0]);
  const status = fixture.getSurfaceTextureStatus();
  assert.equal(status.state, 'complete');
  assert.equal(status.materials.brick.status, 'failed');
  assert.equal(status.materials.brick.source, 'procedural');
  assert.equal(status.materials.brick.format, 'procedural');
  assert.equal(status.materials.brick.fallbackReason, 'all-surface-upgrades-failed');
  assert.ok(fixture.requests.includes('/assets/brick-weathered.png'), 'the generated fallback is attempted');
  const abandoned = fixture.loaded.filter(texture => texture.image.kind === 'brick');
  assert.equal(abandoned.length, 2);
  for (const texture of abandoned) assert.equal(fixture.disposals.get(texture), 1, 'failed attempts release their own resources');
});

const KTX2_QUERY = '?qa=1&mute=1&surfaces=ktx2';

function promiseGate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

// One event-loop turn drains the controlled loader's promise chains. No timers,
// browser work, or real asset downloads determine these lifecycle assertions.
const flushLoads = () => new Promise(resolve => setImmediate(resolve));

test('production and ordinary development boots use KTX2 despite incomplete or production raw overrides', async () => {
  const cases = [
    { dev: false, search: '' },
    { dev: false, search: KTX2_QUERY },
    { dev: false, search: RAW_QA_OPTIONS.search },
    { dev: true, search: '' },
    { dev: true, search: '?mute=1&surfaces=raw' },
    { dev: true, search: '?qa=1&surfaces=raw' },
    { dev: true, search: '?qa=0&mute=1&surfaces=raw' },
    { dev: true, search: '?qa=1&mute=0&surfaces=raw' },
    { dev: true, search: '?qa=1&mute=1&surfaces=RAW' },
    { dev: true, search: KTX2_QUERY },
  ];
  for (const options of cases) {
    const fixture = materialHarness({ ...options, pbrSuccess: true });
    installFallback(fixture.MATS, 'plaster');
    installFallback(fixture.MATS, 'brick');
    const outcomes = await fixture.loadSurfaceTextures();
    assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
    assert.equal(fixture.ktx.imports, 1, JSON.stringify(options));
    assert.equal(fixture.ktx.instances.length, 1);
    assert.equal(fixture.ktx.initCalls, 1);
    assert.equal(fixture.ktx.disposals, 1);
    assert.equal(fixture.ktx.requests.length, 6);
    assert.equal(fixture.requests.length, 0);
    assert.ok(fixture.MATS.brick.map.isCompressedTexture);
    assert.ok(fixture.MATS.plaster.map.isCompressedTexture);
    assert.equal(fixture.getSurfaceTextureStatus().requestedMode, 'ktx2');
  }
});

test('only the complete development raw QA override avoids importing the KTX2 decoder', async () => {
  const fixture = materialHarness({ ...RAW_QA_OPTIONS, pbrSuccess: true });
  installFallback(fixture.MATS, 'plaster');
  installFallback(fixture.MATS, 'brick');
  const outcomes = await fixture.loadSurfaceTextures();
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
  assert.equal(fixture.ktx.imports, 0);
  assert.equal(fixture.ktx.instances.length, 0);
  assert.equal(fixture.ktx.requests.length, 0);
  assert.equal(fixture.ktx.initCalls, 0);
  assert.deepEqual(fixture.requests.slice().sort(), Object.values(PBR_SURFACES).flatMap(spec => Object.values(spec.maps)).sort());
  assert.ok(!fixture.MATS.brick.map.isCompressedTexture);
  assert.ok(!fixture.MATS.plaster.map.isCompressedTexture);
  const status = fixture.getSurfaceTextureStatus();
  assert.equal(status.requestedMode, 'raw');
  assert.equal(status.state, 'complete');
  assert.equal(status.materials.brick.fallback, false);
  assert.equal(status.materials.plaster.fallback, false);
});

test('compressed surface loading shares one initialized worker pool until both materials finish', async () => {
  const initialization = promiseGate(), lastMap = promiseGate();
  const fixture = materialHarness({
    pbrSuccess: true, ktxInitGate: initialization.promise,
    holdKtx: { kind: 'brick', channel: 'normalMap', promise: lastMap.promise },
  });
  const plaster = installFallback(fixture.MATS, 'plaster');
  const brick = installFallback(fixture.MATS, 'brick');
  const pending = fixture.loadSurfaceTextures();
  let settled = false;
  pending.then(() => { settled = true; });
  assert.equal(fixture.loadSurfaceTextures(), pending, 'concurrent boot callers also share the KTX2 setup');
  await flushLoads();
  assert.equal(fixture.ktx.imports, 1);
  assert.equal(fixture.ktx.instances.length, 1);
  const loader = fixture.ktx.instances[0];
  assert.equal(loader.transcoderPath, '/assets/basis/');
  assert.equal(loader.workerLimit, 1);
  assert.equal(loader.renderer, fixture.renderer);
  assert.equal(fixture.ktx.initCalls, 1);
  assert.equal(fixture.getSurfaceTextureStatus().requestedMode, 'ktx2');
  assert.equal(fixture.getSurfaceTextureStatus().state, 'loading');
  assert.equal(fixture.ktx.requests.length, 0, 'surface jobs wait for initialization');
  assert.equal(fixture.ktx.disposals, 0);
  initialization.release();
  await flushLoads();
  assert.equal(fixture.ktx.requests.length, 6);
  assert.equal(fixture.requests.length, 0, 'accepted KTX2 maps do not also download raw or generated maps');
  assert.equal(fixture.ktx.disposals, 0, 'a finished plaster set cannot dispose the pool still serving brick');
  assert.equal(settled, false);
  assert.ok(plaster.material.map.isCompressedTexture);
  assert.equal(fixture.getSurfaceTextureStatus().materials.plaster.status, 'ready');
  assert.equal(fixture.getSurfaceTextureStatus().materials.brick, undefined, 'pending material status is not reported as complete');
  assert.equal(brick.material.map, brick.textures[0], 'an incomplete material remains unchanged');
  lastMap.release();
  const outcomes = await pending;
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
  assert.equal(fixture.ktx.disposals, 1);
  assert.equal(fixture.loadSurfaceTextures(), pending);
  assert.equal(fixture.ktx.imports, 1);
  assert.equal(fixture.ktx.initCalls, 1);
  assert.equal(fixture.ktx.requests.length, 6);
  const status = fixture.getSurfaceTextureStatus();
  assert.equal(status.state, 'complete');
  for (const kind of ['plaster', 'brick']) {
    assert.equal(status.materials[kind].status, 'ready');
    assert.equal(status.materials[kind].format, 'ktx2');
    assert.equal(status.materials[kind].mipCount, 11);
    assert.equal(status.materials[kind].fallback, false);
    assert.equal(status.materials[kind].fallbackReason, null);
    assert.ok(status.materials[kind].compressedBytes > 0);
    assert.equal(status.materials[kind].compressedBytes, fixture.MATS[kind].userData.textureBytesWithMipmaps);
  }
  for (const { material, disposals } of [plaster, brick]) {
    assert.deepEqual(disposals, [1, 1, 1, 1]);
    for (const channel of ['map', 'normalMap', 'roughnessMap']) {
      assert.ok(material[channel].isCompressedTexture);
      assert.equal(material[channel].mipmaps.length, 11);
      assert.equal(material[channel].flipY, false);
      assert.equal(material[channel].generateMipmaps, false);
      assert.equal(fixture.disposals.get(material[channel]), 0, 'worker cleanup does not dispose adopted textures');
    }
  }
});

test('a rejected surface job cannot dispose the KTX2 pool before the other material settles', async () => {
  const lastMap = promiseGate();
  const fixture = materialHarness({
    pbrSuccess: true,
    failKtx: { brick: 'normalMap' }, failPbr: { brick: 'normalMap' }, failGenerated: 'brick',
    holdKtx: { kind: 'plaster', channel: 'roughnessMap', promise: lastMap.promise },
  });
  const plaster = installFallback(fixture.MATS, 'plaster');
  const brick = installFallback(fixture.MATS, 'brick');
  const pending = fixture.loadSurfaceTextures();
  let settled = false;
  pending.then(() => { settled = true; });
  await flushLoads();
  assert.equal(fixture.ktx.requests.length, 6);
  assert.ok(fixture.requests.includes('/assets/brick-weathered.png'), 'brick has exhausted both download fallbacks');
  assert.equal(settled, false, 'one rejected job does not finish the all-settled operation');
  assert.equal(fixture.ktx.disposals, 0);
  assert.equal(plaster.material.map, plaster.textures[0]);
  assert.equal(brick.material.map, brick.textures[0]);
  lastMap.release();
  const outcomes = await pending;
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(fixture.ktx.disposals, 1, 'the shared pool is released after successful and rejected jobs settle');
  assert.equal(fixture.MATS.brick, brick.material);
  assert.deepEqual(brick.disposals, [0, 0, 0, 0]);
  assert.ok(plaster.material.map.isCompressedTexture);
  for (const texture of fixture.loaded.filter(candidate => candidate.image.kind === 'brick')) {
    assert.equal(fixture.disposals.get(texture), 1, 'failed KTX2 and raw candidates are released');
  }
});

for (const stage of ['import', 'init']) {
  test(`KTX2 ${stage} failure still loads raw PBR maps and releases any constructed pool`, async () => {
    const fixture = materialHarness({
      pbrSuccess: true,
      failKtxImport: stage === 'import', failKtxInit: stage === 'init',
    });
    installFallback(fixture.MATS, 'plaster');
    installFallback(fixture.MATS, 'brick');
    const outcomes = await fixture.loadSurfaceTextures();
    assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
    assert.equal(fixture.ktx.imports, 1);
    assert.equal(fixture.ktx.instances.length, stage === 'init' ? 1 : 0);
    assert.equal(fixture.ktx.initCalls, stage === 'init' ? 1 : 0);
    assert.equal(fixture.ktx.requests.length, 0);
    assert.equal(fixture.ktx.disposals, stage === 'init' ? 1 : 0);
    assert.deepEqual(fixture.requests.slice().sort(), Object.values(PBR_SURFACES).flatMap(spec => Object.values(spec.maps)).sort());
    assert.equal(fixture.MATS.brick.userData.surfaceSource, 'polyhaven');
    assert.equal(fixture.MATS.plaster.userData.surfaceSource, 'polyhaven');
    assert.ok(!fixture.MATS.brick.map.isCompressedTexture);
    assert.ok(!fixture.MATS.plaster.map.isCompressedTexture);
    const status = fixture.getSurfaceTextureStatus();
    assert.equal(status.requestedMode, 'ktx2');
    assert.equal(status.state, 'complete');
    for (const kind of ['plaster', 'brick']) {
      assert.equal(status.materials[kind].status, 'fallback');
      assert.equal(status.materials[kind].format, 'raw');
      assert.equal(status.materials[kind].fallbackReason, 'ktx2-decoder-unavailable');
    }
  });
}

test('unsupported compressed textures fall back without initializing or disposing an inactive KTX2 pool', async () => {
  const fixture = materialHarness({ pbrSuccess: true, ktxWorkerConfig: {} });
  installFallback(fixture.MATS, 'plaster');
  installFallback(fixture.MATS, 'brick');
  const outcomes = await fixture.loadSurfaceTextures();
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
  assert.equal(fixture.ktx.imports, 1);
  assert.equal(fixture.ktx.instances.length, 1);
  assert.equal(fixture.ktx.initCalls, 0);
  assert.equal(fixture.ktx.requests.length, 0);
  assert.equal(fixture.ktx.disposals, 0, 'r185 counts only initialized loaders as active');
  assert.deepEqual(fixture.requests.slice().sort(), Object.values(PBR_SURFACES).flatMap(spec => Object.values(spec.maps)).sort());
  const status = fixture.getSurfaceTextureStatus();
  assert.equal(status.requestedMode, 'ktx2');
  assert.equal(status.state, 'complete');
  for (const kind of ['plaster', 'brick']) {
    assert.equal(status.materials[kind].status, 'fallback');
    assert.equal(status.materials[kind].format, 'raw');
    assert.equal(status.materials[kind].fallbackReason, 'compressed-textures-unsupported');
  }
});

test('ASTC and BC7 capability approvals each enable compressed production surfaces', async () => {
  for (const [ktxWorkerConfig, format, name] of [
    [{ astcSupported: true, etc2Supported: true }, THREE.RGBA_ASTC_4x4_Format, 'ASTC 4x4'],
    [{ bptcSupported: true, dxtSupported: true }, THREE.RGBA_BPTC_Format, 'BC7'],
  ]) {
    const fixture = materialHarness({ pbrSuccess: true, ktxWorkerConfig });
    installFallback(fixture.MATS, 'plaster');
    installFallback(fixture.MATS, 'brick');
    const outcomes = await fixture.loadSurfaceTextures();
    assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
    assert.equal(fixture.ktx.initCalls, 1, name);
    assert.equal(fixture.ktx.disposals, 1);
    assert.equal(fixture.ktx.requests.length, 6);
    assert.equal(fixture.requests.length, 0);
    const status = fixture.getSurfaceTextureStatus();
    for (const kind of ['plaster', 'brick']) {
      assert.equal(fixture.MATS[kind].map.format, format);
      assert.equal(status.materials[kind].status, 'ready');
      assert.equal(status.materials[kind].format, 'ktx2');
      assert.equal(status.materials[kind].gpuFormatNames.map, name);
      assert.equal(status.materials[kind].fallbackReason, null);
    }
  }
});

test('other compressed GPU capabilities use raw PBR before decoder initialization', async () => {
  for (const ktxWorkerConfig of [{ etc2Supported: true }, { dxtSupported: true }, { pvrtcSupported: true }]) {
    const fixture = materialHarness({ pbrSuccess: true, ktxWorkerConfig });
    installFallback(fixture.MATS, 'plaster');
    installFallback(fixture.MATS, 'brick');
    const outcomes = await fixture.loadSurfaceTextures();
    assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
    assert.equal(fixture.ktx.instances.length, 1);
    assert.equal(fixture.ktx.initCalls, 0, JSON.stringify(ktxWorkerConfig));
    assert.equal(fixture.ktx.requests.length, 0);
    assert.equal(fixture.ktx.disposals, 0, 'an uninitialized decoder never decrements the active-loader count');
    assert.deepEqual(fixture.requests.slice().sort(), Object.values(PBR_SURFACES).flatMap(spec => Object.values(spec.maps)).sort());
    const status = fixture.getSurfaceTextureStatus();
    assert.equal(status.requestedMode, 'ktx2');
    assert.equal(status.state, 'complete');
    for (const kind of ['plaster', 'brick']) {
      assert.equal(status.materials[kind].status, 'fallback');
      assert.equal(status.materials[kind].format, 'raw');
      assert.equal(status.materials[kind].fallbackReason, 'compressed-format-not-approved');
    }
  }
});

test('KTX2 channel failure reports a raw fallback while the other material stays compressed', async () => {
  const fixture = materialHarness({ pbrSuccess: true, failKtx: { brick: 'map' } });
  installFallback(fixture.MATS, 'plaster');
  installFallback(fixture.MATS, 'brick');
  const outcomes = await fixture.loadSurfaceTextures();
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
  assert.equal(fixture.ktx.disposals, 1);
  assert.deepEqual(fixture.requests.slice().sort(), Object.values(PBR_SURFACES.brick.maps).sort());
  const status = fixture.getSurfaceTextureStatus();
  assert.equal(status.requestedMode, 'ktx2');
  assert.equal(status.state, 'complete');
  assert.equal(status.materials.plaster.status, 'ready');
  assert.equal(status.materials.plaster.format, 'ktx2');
  assert.equal(status.materials.brick.status, 'fallback');
  assert.equal(status.materials.brick.format, 'raw');
  assert.equal(status.materials.brick.compressedBytes, 0);
  assert.equal(status.materials.brick.fallbackReason, 'ktx2-load-or-decode-failed');
  assert.equal(fixture.MATS.brick.userData.pbrProvenance.fallbackFrom, 'ktx2');
});
