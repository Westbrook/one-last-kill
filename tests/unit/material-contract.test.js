import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import * as math from '../../src/core/math.js';
import { SURFACE_METERS, SURFACE_SPECS, bakeSurfaceData, deriveSurfaceData, normalsFromHeights } from '../../src/render/surface-detail.js';

const fixtures = new Map();
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
function materialHarness({ failReadback = null } = {}) {
  const canvases = [], requests = [], loaded = [];
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
      const texture = new THREE.Texture({ kind: url.includes('brick') ? 'brick' : 'plaster', width: 1254, height: 1254 });
      loaded.push(texture); return texture;
    }
  }
  const source = readFileSync(new URL('../../src/render/materials.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export \{[^}]+\};\s*$/gm, '')
    .replace(/^export (?=function )/gm, '');
  assert.doesNotMatch(source, /^import\s/m, 'Update the explicit harness if imports become multiline');
  const api = runInNewContext(`${source}\n;({ MATS, loadSurfaceTextures });`, {
    THREE: { ...THREE, TextureLoader }, document,
    renderer: { capabilities: { getMaxAnisotropy: () => 16 } },
    ...math, SURFACE_METERS, SURFACE_SPECS, deriveSurfaceData,
    bakeSurfaceData: kind => bakeSurfaceData(kind, { size: 64 }),
  }, { filename: 'materials.js' });
  return { ...api, canvases, requests, loaded };
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
  const fixture = materialHarness();
  const fallbacks = ['plaster', 'brick'].map(kind => installFallback(fixture.MATS, kind));
  const first = fixture.loadSurfaceTextures();
  assert.equal(fixture.loadSurfaceTextures(), first, 'assets and derived maps load once');
  const outcomes = await first;
  assert.equal(outcomes.length, 2); assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
  assert.equal(fixture.requests.length, 2);
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
  const fixture = materialHarness({ failReadback: 'brick' });
  installFallback(fixture.MATS, 'plaster');
  const fallback = installFallback(fixture.MATS, 'brick');
  let failedTextureDisposals = 0;
  const pending = fixture.loadSurfaceTextures();
  fixture.loaded.find(texture => texture.image.kind === 'brick').addEventListener('dispose', () => failedTextureDisposals++);
  const outcomes = await pending;
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected');
  assert.equal(fixture.MATS.brick.map, fallback.textures[0]);
  assert.equal(fixture.MATS.brick.normalMap, fallback.textures[1]);
  assert.deepEqual(fallback.disposals, [0, 0, 0, 0]);
  assert.equal(failedTextureDisposals, 1);
});
