import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { getFurnitureMaterials } from '../../src/render/furniture-materials.js';
import { normalsFromHeights } from '../../src/render/surface-detail.js';
import { IMPACT_PROFILES, resolveImpactProfile } from '../../src/render/impact-profile.js';

function assertSeam(texture) {
  const { data, width, height } = texture.image;
  for (let y = 0; y < height; y++) {
    for (let channel = 0; channel < 4; channel++) {
      assert.equal(data[(y * width) * 4 + channel], data[(y * width + width - 1) * 4 + channel], `${texture.name}: horizontal seam`);
    }
  }
  for (let x = 0; x < width; x++) {
    for (let channel = 0; channel < 4; channel++) {
      assert.equal(data[x * 4 + channel], data[((height - 1) * width + x) * 4 + channel], `${texture.name}: vertical seam`);
    }
  }
}

test('importing furniture finishes allocates no materials or textures before first use', () => {
  let materials = 0, textures = 0;
  class CountedMaterial extends THREE.MeshStandardMaterial {
    constructor(...args) { super(...args); materials++; }
  }
  class CountedTexture extends THREE.DataTexture {
    constructor(...args) { super(...args); textures++; }
  }
  const source = readFileSync(new URL('../../src/render/furniture-materials.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export (?=function )/gm, '');
  const getFinishes = runInNewContext(`${source}\n;getFurnitureMaterials;`, {
    THREE: { ...THREE, MeshStandardMaterial: CountedMaterial, DataTexture: CountedTexture }, normalsFromHeights,
  });
  assert.equal(materials, 0); assert.equal(textures, 0);
  const finishes = getFinishes();
  assert.equal(materials, 5); assert.equal(textures, 6);
  assert.equal(getFinishes(), finishes);
  assert.equal(materials, 5); assert.equal(textures, 6);
});

test('furniture finishes are shared, opaque and usable without a browser renderer', () => {
  const finishes = getFurnitureMaterials();
  assert.equal(getFurnitureMaterials(), finishes);
  assert.ok(Object.isFrozen(finishes));
  assert.deepEqual(Object.keys(finishes), ['wood', 'linen', 'upholstery', 'hardware', 'glazing']);
  for (const material of Object.values(finishes)) {
    assert.ok(material.isMeshStandardMaterial);
    assert.equal(material.transparent, false);
    assert.equal(material.opacity, 1);
    assert.equal(material.depthWrite, true);
  }
  for (const [key, profile] of [['wood', 'wood'], ['linen', 'dark'], ['upholstery', 'dark'], ['hardware', 'metal'], ['glazing', 'glass']]) {
    assert.equal(resolveImpactProfile({ material: finishes[key] }), IMPACT_PROFILES[profile]);
  }
  assert.equal(finishes.wood.userData.surfaceMeters, 0.6);
  assert.equal(finishes.linen.userData.surfaceMeters, 0.3);
  assert.equal(finishes.upholstery.userData.surfaceMeters, 0.3);
  assert.equal(finishes.upholstery.color.getHex(), 0x969c91);
  assert.notEqual(finishes.upholstery, finishes.linen);
  for (const channel of ['map', 'normalMap', 'roughnessMap']) {
    assert.equal(finishes.upholstery[channel], finishes.linen[channel], `upholstery shares the linen ${channel}`);
  }
  assert.deepEqual(finishes.upholstery.userData, finishes.linen.userData, 'the tint references the same static texture budget');
  assert.equal(finishes.hardware.roughness, 0.36);
  assert.equal(finishes.glazing.roughness, 0.22);
  for (const key of ['hardware', 'glazing']) {
    for (const channel of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) assert.equal(finishes[key][channel], null);
    assert.equal(finishes[key].userData.textureBytes, 0);
  }
});

test('all furniture texture channels tile, retain physical finish bounds and fit 512 KiB with mipmaps', () => {
  const finishes = getFurnitureMaterials(), maps = new Set();
  let totalBaseBytes = 0, totalMipBytes = 0;
  for (const [key, bounds] of [['wood', [0.55, 0.75]], ['linen', [0.9, 0.98]]]) {
    const material = finishes[key];
    assert.equal(material.roughness, 1, 'roughness is not multiplied down twice');
    assert.equal(material.metalness, 0);
    assert.equal(material.userData.staticSurfaceMaps, true);
    assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
    assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace);
    assert.equal(material.roughnessMap.colorSpace, THREE.NoColorSpace);
    let materialBytes = 0, materialMipBytes = 0;
    for (const channel of ['map', 'normalMap', 'roughnessMap']) {
      const texture = material[channel];
      maps.add(texture);
      assert.equal(texture.image.width, 128); assert.equal(texture.image.height, 128);
      assert.equal(texture.wrapS, THREE.RepeatWrapping); assert.equal(texture.wrapT, THREE.RepeatWrapping);
      assert.deepEqual(texture.repeat.toArray(), [1, 1]);
      assert.equal(texture.flipY, true); assert.equal(texture.generateMipmaps, true);
      assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
      assert.equal(texture.magFilter, THREE.LinearFilter);
      assert.ok(texture.anisotropy <= 4);
      const version = texture.version;
      assert.equal(getFurnitureMaterials()[key][channel].version, version, 'reuse never requests another texture upload');
      assertSeam(texture);
      for (let i = 3; i < texture.image.data.length; i += 4) assert.equal(texture.image.data[i], 255);
      materialBytes += texture.image.data.byteLength;
      for (let size = 128; size >= 1; size /= 2) materialMipBytes += size * size * 4;
    }
    assert.equal(material.userData.textureBytes, materialBytes);
    assert.equal(material.userData.textureBytesWithMipmaps, materialMipBytes);
    totalBaseBytes += materialBytes; totalMipBytes += materialMipBytes;
    const finish = material.roughnessMap.image.data, normal = material.normalMap.image.data;
    for (let i = 0; i < finish.length; i += 4) {
      assert.equal(finish[i], 255, 'the material has no painted shadow');
      assert.equal(finish[i + 2], 0, 'wood and linen are nonmetallic');
      assert.ok(finish[i + 1] >= Math.round(bounds[0] * 255));
      assert.ok(finish[i + 1] <= Math.round(bounds[1] * 255));
      assert.ok(normal[i + 2] >= 253, 'relief stays shallow and does not produce glittery normals');
    }
  }
  assert.equal(maps.size, 6);
  const allReferencedMaps = new Set(Object.values(finishes).flatMap(material =>
    [material.map, material.normalMap, material.roughnessMap].filter(Boolean)));
  assert.deepEqual(allReferencedMaps, maps, 'tinted upholstery adds no texture resources');
  assert.equal(totalBaseBytes, 384 * 1024);
  assert.equal(totalMipBytes, 524280);
  assert.ok(totalMipBytes <= 512 * 1024);
});
