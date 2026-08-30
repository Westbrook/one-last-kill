import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { getBakeryProvisionMaterials, BAKERY_PROVISION_ATLAS } from '../../src/render/bakery-provision-materials.js';
import { getFurnitureMaterials } from '../../src/render/furniture-materials.js';
import { getWeaponFinishes } from '../../src/render/weapon-finishes.js';
import { normalsFromHeights } from '../../src/render/surface-detail.js';

function freshFactory() {
  let textures = 0, materials = 0;
  const normalCalls = [];
  class CountedTexture extends THREE.DataTexture {
    constructor(...args) { super(...args); textures++; }
  }
  class CountedMaterial extends THREE.MeshStandardMaterial {
    constructor(...args) { super(...args); materials++; }
  }
  const metal = new CountedMaterial().copy(getWeaponFinishes().metal);
  materials = 0;
  const source = readFileSync(new URL('../../src/render/bakery-provision-materials.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export (?=(function|const) )/gm, '');
  const get = runInNewContext(`${source}\n;getBakeryProvisionMaterials;`, {
    THREE: { ...THREE, DataTexture: CountedTexture, MeshStandardMaterial: CountedMaterial },
    getWeaponFinishes: () => ({ metal }), getFurnitureMaterials,
    normalsFromHeights(...args) { const result = normalsFromHeights(...args); normalCalls.push(result); return result; },
  });
  return { get, normalCalls, counts: () => ({ textures, materials }) };
}

test('bakery finishes are lazy and deterministic with no browser or frame dependencies', () => {
  const fixture = freshFactory();
  assert.deepEqual(fixture.counts(), { textures: 0, materials: 0 });
  const first = fixture.get();
  assert.equal(fixture.get(), first);
  assert.deepEqual(fixture.counts(), { textures: 4, materials: 3 });
  const fresh = freshFactory().get();
  for (const [key, channels] of [['bread', ['map', 'normalMap', 'roughnessMap']], ['packages', ['map']]]) {
    for (const channel of channels) assert.deepEqual(Array.from(first[key][channel].image.data), Array.from(fresh[key][channel].image.data));
  }
  const atlas = BAKERY_PROVISION_ATLAS.bread, inner = atlas.tileSize - atlas.gutter * 2;
  for (let tile = 0; tile < 2; tile++) for (let y = tile ? 32 : 0; y < inner; y += 7) for (let x = 0; x < inner; x += 7) {
    const source = (y * inner + x) * 4;
    const target = ((y + atlas.gutter) * atlas.width + tile * atlas.tileSize + atlas.gutter + x) * 4;
    assert.equal(first.bread.normalMap.image.data[target], fixture.normalCalls[tile][source]);
    assert.equal(first.bread.normalMap.image.data[target + 1], 255 - fixture.normalCalls[tile][source + 1], 'ascending V reverses the helper image-row tangent Y');
  }
});

test('bread/package atlas channels retain isolated gutters, restrained finishes and a 640 KiB ceiling', () => {
  const materials = getBakeryProvisionMaterials();
  assert.equal(getBakeryProvisionMaterials(), materials);
  assert.ok(Object.isFrozen(materials)); assert.equal(new Set(Object.values(materials)).size, 3);
  assert.deepEqual(Object.keys(materials), ['bread', 'packages', 'steel']);
  let totalBase = 0, totalMips = 0;
  for (const [name, cells, channels] of [
    ['bread', [...BAKERY_PROVISION_ATLAS.bread.cells, BAKERY_PROVISION_ATLAS.bread.crumb], ['map', 'normalMap', 'roughnessMap']],
    ['packages', ['flour', 'kraft', 'label', 'plain'].map(key => BAKERY_PROVISION_ATLAS.packages[key]), ['map']],
  ]) {
    const spec = BAKERY_PROVISION_ATLAS[name], material = materials[name];
    assert.equal(material.userData.surfaceMeters, undefined, 'explicit atlas UVs cannot be remapped by generic batching');
    assert.equal(material.userData.surfaceKind, 'fabric');
    let bytes = 0, mipBytes = 0;
    for (const channel of channels) {
      const map = material[channel], { width, height, data } = map.image;
      assert.equal(width, spec.width); assert.equal(height, spec.height);
      assert.equal(map.colorSpace, channel === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace);
      assert.equal(map.flipY, false); assert.equal(map.generateMipmaps, true);
      assert.equal(map.minFilter, THREE.LinearMipmapLinearFilter); assert.equal(map.magFilter, THREE.LinearFilter);
      assert.equal(map.wrapS, THREE.ClampToEdgeWrapping); assert.equal(map.wrapT, THREE.ClampToEdgeWrapping);
      assert.deepEqual(map.repeat.toArray(), [1, 1]); assert.ok(map.anisotropy <= 4);
      for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 255);
      bytes += data.byteLength;
      for (let level = 0; level <= Math.log2(Math.max(width, height)); level++) mipBytes += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
      for (const cell of cells) {
        assert.ok(Object.isFrozen(cell));
        const x0 = Math.round(cell.uMin * width - 0.5), x1 = Math.round(cell.uMax * width - 0.5);
        const y0 = Math.round(cell.vMin * height - 0.5), y1 = Math.round(cell.vMax * height - 0.5);
        for (let y = y0 - spec.gutter; y <= y1 + spec.gutter; y++) for (let x = x0 - spec.gutter; x <= x1 + spec.gutter; x++) {
          const source = (Math.max(y0, Math.min(y1, y)) * width + Math.max(x0, Math.min(x1, x))) * 4;
          const target = (y * width + x) * 4;
          for (let c = 0; c < 4; c++) assert.equal(data[target + c], data[source + c], `${name} ${channel}: gutter remains within its cell`);
        }
      }
    }
    assert.equal(material.userData.newTextureBytes, bytes);
    assert.equal(material.userData.newTextureBytesWithMipmaps, mipBytes);
    totalBase += bytes; totalMips += mipBytes;
  }
  assert.equal(totalBase, 458752); assert.equal(totalMips, 611672); assert.ok(totalMips <= 640 * 1024);
  const breadAtlas = BAKERY_PROVISION_ATLAS.bread;
  assert.equal(breadAtlas.cells.length, 2);
  assert.ok(breadAtlas.crumb.vMax < breadAtlas.cells[1].vMin, 'crumb is isolated from both full crust UV regions');
  assert.equal(materials.bread.roughness, 1); assert.equal(materials.bread.metalness, 0);
  const finish = materials.bread.roughnessMap.image.data, normal = materials.bread.normalMap.image.data;
  for (let i = 0; i < finish.length; i += 4) {
    assert.equal(finish[i], 255); assert.equal(finish[i + 2], 0);
    assert.ok(finish[i + 1] >= Math.round(0.82 * 255) && finish[i + 1] <= Math.round(0.98 * 255));
    assert.ok(normal[i + 2] >= 253, 'pores do not emboss scored grooves or large relief');
  }
  for (const material of Object.values(materials)) {
    assert.ok(material.isMeshStandardMaterial); assert.equal(material.transparent, false);
    assert.equal(material.opacity, 1); assert.equal(material.depthWrite, true);
    assert.equal(material.onBeforeCompile, THREE.Material.prototype.onBeforeCompile);
  }
});

test('preparation steel reuses existing maps without adding texture payload or vertex tinting', () => {
  const { steel } = getBakeryProvisionMaterials(), weapon = getWeaponFinishes().metal, linen = getFurnitureMaterials().linen;
  for (const channel of ['map', 'normalMap', 'metalnessMap']) assert.equal(steel[channel], weapon[channel]);
  assert.equal(steel.roughnessMap, linen.roughnessMap);
  assert.notEqual(steel, weapon); assert.equal(steel.vertexColors, false);
  assert.equal(steel.userData.surfaceKind, 'metal'); assert.equal(steel.userData.surfaceMeters, 0.18);
  assert.deepEqual(steel.normalScale.toArray(), [0.28, 0.28]); assert.equal(steel.envMapIntensity, 0.42);
  assert.equal(steel.userData.newTextureBytes, 0); assert.equal(steel.userData.newTextureBytesWithMipmaps, 0);
  assert.equal(steel.userData.textureBytes, 262144); assert.equal(steel.userData.textureBytesWithMipmaps, 349520);
  const roughness = steel.roughnessMap.image.data;
  for (let i = 1; i < roughness.length; i += 4) assert.ok(roughness[i] / 255 * steel.roughness >= 0.5 && roughness[i] / 255 * steel.roughness <= 0.65);
});
