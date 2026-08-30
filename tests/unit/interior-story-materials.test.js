import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { getInteriorStoryMaterials, INTERIOR_STORY_ATLAS } from '../../src/render/interior-story-materials.js';
import { getFurnitureMaterials } from '../../src/render/furniture-materials.js';
import { IMPACT_PROFILES, resolveImpactProfile } from '../../src/render/impact-profile.js';

function freshFactory() {
  let textures = 0, materials = 0;
  class CountedTexture extends THREE.DataTexture {
    constructor(...args) { super(...args); textures++; }
  }
  class CountedMaterial extends THREE.MeshStandardMaterial {
    constructor(...args) { super(...args); materials++; }
  }
  const furniture = getFurnitureMaterials();
  const base = { linen: new CountedMaterial().copy(furniture.linen), upholstery: new CountedMaterial().copy(furniture.upholstery) };
  materials = 0;
  const source = readFileSync(new URL('../../src/render/interior-story-materials.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export (?=(function|const) )/gm, '');
  const get = runInNewContext(`${source}\n;getInteriorStoryMaterials;`, {
    THREE: { ...THREE, DataTexture: CountedTexture, MeshStandardMaterial: CountedMaterial },
    getFurnitureMaterials: () => base,
  });
  return { get, counts: () => ({ textures, materials }) };
}

test('story material creation is lazy, deterministic and reuses the existing linen maps', () => {
  const fixture = freshFactory();
  assert.deepEqual(fixture.counts(), { textures: 0, materials: 0 });
  const first = fixture.get();
  assert.deepEqual(fixture.counts(), { textures: 2, materials: 4 });
  assert.equal(fixture.get(), first);
  assert.deepEqual(fixture.counts(), { textures: 2, materials: 4 });
  const fresh = freshFactory().get();
  for (const key of ['books', 'rugs']) assert.deepEqual(Array.from(first[key].map.image.data), Array.from(fresh[key].map.image.data));
  const materials = getInteriorStoryMaterials(), furniture = getFurnitureMaterials();
  assert.equal(getInteriorStoryMaterials(), materials);
  assert.ok(Object.isFrozen(materials));
  assert.equal(new Set(Object.values(materials)).size, 4);
  assert.deepEqual(Object.keys(materials), ['books', 'rugs', 'upholsteryWarm', 'upholsteryCool']);
  for (const key of ['upholsteryWarm', 'upholsteryCool']) {
    assert.equal(materials[key].userData.surfaceMeters, 0.3);
    for (const channel of ['map', 'normalMap', 'roughnessMap']) assert.equal(materials[key][channel], furniture.linen[channel]);
  }
  assert.equal(materials.upholsteryWarm.color.getHex(), furniture.upholstery.color.getHex());
  assert.equal(materials.upholsteryCool.color.getHex(), 0x80928a);
});

test('story atlases stay opaque, preserve explicit UV ownership and add at most 256 KiB', () => {
  const materials = getInteriorStoryMaterials(), furniture = getFurnitureMaterials();
  const mapsOf = material => [material.map, material.normalMap, material.roughnessMap].filter(Boolean);
  const previous = new Set(Object.values(furniture).flatMap(mapsOf));
  const added = new Set(Object.values(materials).flatMap(mapsOf).filter(map => !previous.has(map)));
  assert.equal(added.size, 2);
  let baseBytes = 0, mipBytes = 0;
  for (const key of ['books', 'rugs']) {
    const material = materials[key], texture = material.map;
    assert.equal(material.userData.surfaceMeters, undefined);
    assert.equal(material.userData.interiorStoryAtlas, true);
    assert.equal(material.normalMap, null); assert.equal(material.roughnessMap, null);
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
    assert.equal(texture.flipY, false); assert.equal(texture.generateMipmaps, true);
    assert.equal(texture.wrapS, THREE.ClampToEdgeWrapping); assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
    assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter); assert.equal(texture.magFilter, THREE.LinearFilter);
    assert.ok(texture.anisotropy <= 4); assert.deepEqual(texture.repeat.toArray(), [1, 1]);
    for (let i = 3; i < texture.image.data.length; i += 4) assert.equal(texture.image.data[i], 255);
    const { width, height } = texture.image;
    let expectedMips = 0;
    for (let level = 0; level <= Math.log2(Math.max(width, height)); level++) {
      expectedMips += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
    }
    assert.equal(material.userData.textureBytes, texture.image.data.byteLength);
    assert.equal(material.userData.textureBytesWithMipmaps, expectedMips);
    baseBytes += texture.image.data.byteLength; mipBytes += expectedMips;
  }
  assert.equal(baseBytes, 192 * 1024);
  assert.equal(mipBytes, 256 * 1024);
  for (const [key, material] of Object.entries(materials)) {
    assert.ok(material.isMeshStandardMaterial);
    assert.equal(material.transparent, false); assert.equal(material.opacity, 1);
    assert.equal(material.depthWrite, true); assert.equal(material.metalness, 0);
    assert.equal(resolveImpactProfile({ material }), IMPACT_PROFILES[key === 'books' ? 'wood' : 'dark']);
  }
});

test('atlas cells have isolated gutters, distinct book palettes and distinct rug borders', () => {
  const materials = getInteriorStoryMaterials(), atlas = INTERIOR_STORY_ATLAS;
  const books = [...atlas.books.spines, ...['paper', 'pages', 'label', 'postcard', 'note'].map(key => atlas.books[key])];
  assert.equal(atlas.books.spines.length, 8); assert.equal(books.length, 13);
  const pixel = (texture, x, y) => Array.from(texture.image.data.slice((y * texture.image.width + x) * 4, (y * texture.image.width + x) * 4 + 4));
  const sample = (texture, cell, u, v) => pixel(texture,
    Math.round((cell.uMin + (cell.uMax - cell.uMin) * u) * texture.image.width - 0.5),
    Math.round((cell.vMin + (cell.vMax - cell.vMin) * v) * texture.image.height - 0.5));
  for (const [name, cells] of [['books', books], ['rugs', [atlas.rugs.warm, atlas.rugs.cool]]]) {
    const spec = atlas[name], texture = materials[name].map;
    for (const cell of cells) {
      assert.ok(Object.isFrozen(cell));
      assert.ok(cell.uMin > 0 && cell.uMax < 1 && cell.vMin > 0 && cell.vMax < 1);
      const startX = Math.round(cell.uMin * spec.width - 0.5), endX = Math.round(cell.uMax * spec.width - 0.5);
      const startY = Math.round(cell.vMin * spec.height - 0.5), endY = Math.round(cell.vMax * spec.height - 0.5);
      for (let y = startY - spec.gutter; y <= endY + spec.gutter; y++) {
        for (let x = startX - spec.gutter; x <= endX + spec.gutter; x++) {
          if (x >= startX && x <= endX && y >= startY && y <= endY) continue;
          assert.deepEqual(pixel(texture, x, y), pixel(texture, Math.max(startX, Math.min(endX, x)), Math.max(startY, Math.min(endY, y))));
        }
      }
    }
  }
  const spineColors = atlas.books.spines.map(cell => sample(materials.books.map, cell, 0.5, 0.4).join(','));
  assert.equal(new Set(spineColors).size, 8);
  assert.notDeepEqual(sample(materials.books.map, atlas.books.postcard, 0.5, 0.5), sample(materials.books.map, atlas.books.paper, 0.5, 0.5));
  assert.notDeepEqual(sample(materials.books.map, atlas.books.note, 0.5, 0.79), sample(materials.books.map, atlas.books.paper, 0.5, 0.79));
  assert.notDeepEqual(sample(materials.rugs.map, atlas.rugs.warm, 0.5, 0.5), sample(materials.rugs.map, atlas.rugs.cool, 0.5, 0.5));
  for (const cell of [atlas.rugs.warm, atlas.rugs.cool]) {
    assert.notDeepEqual(sample(materials.rugs.map, cell, 0, 0.5), sample(materials.rugs.map, cell, 0.5, 0.5));
  }
});
