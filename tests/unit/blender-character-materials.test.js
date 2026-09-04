import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodePng, readSurface, inspectPart } from '../../tools/blender/verify-character-materials.mjs';

const root = new URL('../../public/assets/models/characters/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const bytes = await readFile(new URL(manifest.binary, root));
const gunman = manifest.catalog.find(entry => entry.id === 'gunman');

async function roughnessRegions(part) {
  const image = decodePng(await readFile(new URL(gunman.finish[part].roughness, root)));
  const surface = gunman.surfaces.find(value => value.name === part);
  return inspectPart(readSurface(bytes, surface), image, image, part);
}

test('the Blender character package records the exact dimensions, color space and bytes of every packed finish', async () => {
  assert.equal(gunman.materialFinish.revision, 'gunman-material-zones-v1');
  assert.equal(gunman.finish.textures.length, 4);
  const expected = new Set(['garments', 'head'].flatMap(part => ['normal', 'roughness'].map(kind => gunman.finish[part][kind])));
  assert.deepEqual(new Set(gunman.finish.textures.map(texture => texture.file)), expected);
  for (const texture of gunman.finish.textures) {
    const encoded = await readFile(new URL(texture.file, root));
    const decoded = decodePng(encoded);
    assert.equal(texture.bytes, encoded.length);
    assert.equal(texture.sha256, createHash('sha256').update(encoded).digest('hex'));
    assert.equal(texture.width, 512); assert.equal(texture.height, 512);
    assert.equal(decoded.width, texture.width); assert.equal(decoded.height, texture.height);
    assert.equal(texture.colorSpace, 'linear');
  }
});

test('actual gunman roughness pixels preserve woven cloth, leather boot and rubber sole distinctions', async () => {
  const report = await roughnessRegions('garments');
  const regions = Object.fromEntries(Object.entries(report.regions).map(([name, value]) => [name, value.reliableInterior.candidate]));
  for (const name of ['shirt', 'trousers', 'bootLeather', 'rubberSole']) {
    assert.ok(regions[name].count >= (name === 'shirt' || name === 'trousers' ? 100 : 10), `${name}: enough actual UV-interior samples`);
    assert.equal(regions[name].zeroSamples, 0);
  }
  assert.ok(regions.shirt.mean - regions.trousers.mean >= 0.02);
  assert.ok(regions.shirt.mean - regions.bootLeather.mean >= 0.12);
  assert.ok(regions.rubberSole.mean - regions.bootLeather.mean >= 0.20);
  assert.ok(regions.bootLeather.mean >= 0.55 && regions.bootLeather.mean <= 0.75);
  assert.equal(report.overall.reliableInterior.candidate.below035Samples, 0);
});

test('actual gunman roughness pixels keep cheek skin drier than the nose and central forehead', async () => {
  const report = await roughnessRegions('head');
  const regions = Object.fromEntries(Object.entries(report.regions).map(([name, value]) => [name, value.reliableInterior.candidate]));
  for (const name of ['cheek', 'nose', 'forehead']) {
    assert.ok(regions[name].count >= 10, `${name}: enough actual UV-interior samples`);
    assert.equal(regions[name].zeroSamples, 0);
  }
  assert.ok(regions.cheek.mean - regions.nose.mean >= 0.045);
  assert.ok(regions.cheek.mean - regions.forehead.mean >= 0.02);
  assert.equal(report.overall.reliableInterior.candidate.below035Samples, 0);
});
