import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { crc32 } from '../../tools/lib/model-material-png.mjs';
import { auditModelMaterials, compareMaterialAudits, inspectGLBMaterialAsset, inspectTexturePixels, readMaterialGLB, inspectHandMaterialAsset, inspectCharacterMaterialAsset } from '../../tools/audit-model-materials.mjs';

const base = new URL('../../public/assets/models/', import.meta.url);
const pistol = await readFile(new URL('pistol/pistol.glb', base));
const pistolManifest = JSON.parse(await readFile(new URL('pistol/manifest.json', base), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function pack(json, binary) {
  const text = Buffer.from(JSON.stringify(json)), jsonChunk = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32); text.copy(jsonChunk);
  const result = Buffer.alloc(28 + jsonChunk.length + binary.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonChunk.length, 12); result.writeUInt32LE(0x4e4f534a, 16); jsonChunk.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + jsonChunk.length); result.writeUInt32LE(0x004e4942, 24 + jsonChunk.length); binary.copy(result, 28 + jsonChunk.length);
  return result;
}
function mutatePistol(edit) {
  const { json, binary } = readMaterialGLB(pistol), copy = Buffer.from(binary), manifest = globalThis.structuredClone(pistolManifest);
  edit(json, copy, manifest); const bytes = pack(json, copy); manifest.delivery.sha256 = sha(bytes); manifest.delivery.glbBytes = bytes.length;
  return { bytes, manifest };
}
function inspectMutation(edit) { const { bytes, manifest } = mutatePistol(edit); return inspectGLBMaterialAsset(bytes, { id: 'pistol', manifest }); }
function single(asset) { return { schemaVersion: 1, assets: [asset], totals: { deliveryBytes: asset.bytes, estimatedRGBA8WithMipmaps: asset.estimatedRGBA8WithMipmaps } }; }
const reference = single(inspectGLBMaterialAsset(pistol, { id: 'pistol', manifest: pistolManifest }));
const imageStart = (json, image = 0) => json.bufferViews[json.images[image].bufferView].byteOffset ?? 0;

test('shipped material catalogs fully decode inside fixed delivery budgets', async () => {
  const report = await auditModelMaterials();
  assert.deepEqual(report.assets.map(asset => [asset.id, asset.textures.length]), [['hands', 3], ['characters', 4], ['pistol', 6], ['weapons', 6]]);
  assert.equal(report.totals.textures, 19);
  for (const asset of report.assets) for (const map of asset.textures) { assert.equal(map.opaque, true); assert.equal(map.width, asset.id === 'hands' || asset.id === 'characters' ? 512 : 256); }
  assert.equal(compareMaterialAudits(report, report).changedTextures.length, 0);
});

test('material gate rejects unused texture slots and missing shader map bindings', () => {
  assert.throws(() => inspectMutation(json => { json.materials[0].normalTexture.index = json.materials[1].normalTexture.index; }), /No unused textures/);
  assert.throws(() => inspectMutation(json => { delete json.materials[0].normalTexture; }), /Complete base-color\/normal\/metal-rough/);
  assert.throws(() => inspectMutation(json => { json.textures[0].sampler = 999; }), /sampler index/);
  assert.throws(() => inspectMutation(json => { delete json.meshes[0].primitives[0].attributes.TEXCOORD_0; }), /missing its UV binding/);
});

test('an image cannot be sampled as both sRGB color and linear normal data', () => {
  assert.throws(() => inspectMutation(json => { json.materials[0].emissiveTexture = { index: json.materials[0].normalTexture.index }; }), /alias sRGB and linear/);
});

test('the embedded PNG bytes, CRCs and complete payload are inspected', () => {
  assert.throws(() => inspectMutation((json, binary) => { binary[imageStart(json) + 20] ^= 1; }), /CRC mismatch/);
  assert.throws(() => inspectMutation(json => { json.bufferViews[json.images[0].bufferView].byteLength -= 9; }), /truncated|missing IEND/);
  assert.throws(() => inspectMutation((json, binary) => { const start = imageStart(json); binary.writeUInt32BE(257, start + 16); binary.writeUInt32BE(crc32(binary.subarray(start + 12, start + 29)), start + 29); }), /dimensions exceed pixel budget/);
  assert.throws(() => inspectMutation((json, binary, manifest) => { manifest.textures[0].width = 128; }), /embedded pixels match manifest/);
});

test('GLB lengths, accessor ranges and manifest checksums fail closed', () => {
  assert.throws(() => inspectGLBMaterialAsset(pistol.subarray(0, -4), { id: 'pistol', manifest: pistolManifest }), /declared length/);
  assert.throws(() => inspectMutation(json => { json.accessors[0].count = 10000000; }), /element budget/);
  assert.throws(() => inspectMutation(json => { json.accessors = Array.from({ length: 2000 }, () => ({ ...json.accessors[0], count: 10000 })); }), /Aggregate accessor read budget/);
  assert.throws(() => inspectMutation(json => { json.bufferViews[0].byteOffset = -1; }), /Buffer view: offset/);
  assert.throws(() => inspectMutation(json => { json.accessors[0].byteOffset = 0x7ffffffc; }), /Accessor data: offset/);
  assert.throws(() => inspectMutation(json => { const root = json.nodes.find(node => node.children?.length); root.children.push(root.children[0]); }), /children cannot repeat/);
  assert.throws(() => inspectMutation(json => { json.nodes[0].children = [json.nodes.find(node => node.children?.length).children[1]]; }), /multiple parents/);
  assert.throws(() => inspectGLBMaterialAsset(pistol, { id: 'pistol', manifest: { ...pistolManifest, delivery: { ...pistolManifest.delivery, sha256: '0'.repeat(64) } } }), /manifest GLB checksum/);
});

test('material-only comparison catches actual UV, position, normal, color and index bytes', () => {
  for (const attribute of ['TEXCOORD_0', 'POSITION', 'NORMAL', 'COLOR_0', 'indices']) {
    const changed = inspectMutation((json, binary) => {
      const primitive = json.meshes[0].primitives[0], accessor = json.accessors[attribute === 'indices' ? primitive.indices : primitive.attributes[attribute]];
      const start = (json.bufferViews[accessor.bufferView].byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      if (attribute === 'indices') { const second = binary.readUInt16LE(start + 2); binary.writeUInt16LE(second, start); }
      else binary[start] ^= 1;
    });
    assert.throws(() => compareMaterialAudits(reference, single(changed)), /material-only reference forbids/, attribute);
  }
});

test('material-only comparison catches transforms, extras, materials and samplers', () => {
  const changes = [json => { json.nodes[0].translation = [.001, 0, 0]; }, json => { json.nodes[0].extras.assetPart += '-changed'; }, json => { json.materials[0].normalTexture.scale = .8; }, json => { json.samplers[0].wrapS = 33071; }];
  for (const change of changes) assert.throws(() => compareMaterialAudits(reference, single(inspectMutation(change))), /material-only reference forbids/);
});

test('structural identity ignores exporter version labels', () => {
  const changed = inspectMutation(json => { json.asset.generator = 'Another tool version'; });
  assert.equal(compareMaterialAudits(reference, single(changed)).changedTextures.length, 0);
});

function solidPNG(size, rgba = [128, 128, 255, 255]) {
  const chunk = (type, data) => { const block = Buffer.alloc(12 + data.length); block.writeUInt32BE(data.length); block.write(type, 4, 'ascii'); data.copy(block, 8); block.writeUInt32BE(crc32(block.subarray(4, -4)), block.length - 4); return block; };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 4; c++) rows[y * (size * 4 + 1) + 1 + x * 4 + c] = rgba[c];
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('valid texture changes pass comparison without a golden art-quality claim', () => {
  const { json, binary } = readMaterialGLB(pistol), manifest = globalThis.structuredClone(pistolManifest);
  const source = json.textures[json.materials[0].pbrMetallicRoughness.baseColorTexture.index].source, image = json.images[source];
  const replacement = solidPNG(256, [40, 40, 41, 255]), appended = Buffer.alloc(binary.length + Math.ceil(replacement.length / 4) * 4);
  binary.copy(appended); replacement.copy(appended, binary.length);
  const view = json.bufferViews[image.bufferView]; view.byteOffset = binary.length; view.byteLength = replacement.length; json.buffers[0].byteLength = appended.length;
  const bytes = pack(json, appended); manifest.delivery.glbBytes = bytes.length; manifest.delivery.sha256 = sha(bytes);
  const record = manifest.textures.find(item => item.path.endsWith(`${image.name}.png`)); record.bytes = replacement.length; record.sha256 = sha(replacement);
  const candidate = inspectGLBMaterialAsset(bytes, { id: 'pistol', manifest }), compared = compareMaterialAudits(reference, single(candidate));
  assert.equal(compared.changedTextures.length, 1); assert.equal(compared.estimatedRGBA8WithMipmapsDelta, 0);
});

test('malformed baked normal data and transparent opaque maps are rejected', async () => {
  const png = await readFile(new URL('hands/hand-albedo.png', base));
  assert.throws(() => inspectTexturePixels(png, { label: 'color wrongly used as normal', dimension: 512, semantic: 'normal' }), /normal map|normal vectors/);
  assert.throws(() => inspectTexturePixels(solidPNG(256, [128, 128, 255, 254]), { label: 'transparent material', dimension: 256, semantic: 'normal' }), /contains transparency/);
  assert.throws(() => inspectTexturePixels(solidPNG(128), { label: 'wrong size', dimension: 256, semantic: 'normal' }), /map dimensions/);
});

test('custom hand/character manifests must agree with actual buffers and every image', async () => {
  for (const id of ['hands', 'characters']) {
    const directory = new URL(`${id}/`, base), manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
    const bytes = await readFile(new URL(`${id}.bin`, directory));
    const names = id === 'hands' ? manifest.bake.textures.map(record => record.file) : manifest.catalog.find(entry => entry.id === 'gunman').finish.textures.map(record => record.file);
    const maps = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL(name, directory))])));
    const inspect = id === 'hands' ? inspectHandMaterialAsset : inspectCharacterMaterialAsset;
    assert.throws(() => inspect(bytes, { ...manifest, sha256: '0'.repeat(64) }, maps), /manifest checksum/);
    assert.throws(() => inspect(bytes, { ...manifest, version: 999 }, maps), /manifest version/);
    const wrongTexture = globalThis.structuredClone(manifest), records = id === 'hands' ? wrongTexture.bake.textures : wrongTexture.catalog.find(entry => entry.id === 'gunman').finish.textures;
    records[0].sha256 = '0'.repeat(64); assert.throws(() => inspect(bytes, wrongTexture, maps), /texture manifest checksum/);
    if (id === 'hands') {
      const oldHeaderSize = bytes.readUInt32LE(4), header = JSON.parse(bytes.subarray(8, 8 + oldHeaderSize).toString());
      header.buffers[0].length = 1000000; header.buffers[0].count = 1;
      const encoded = Buffer.from(JSON.stringify(header)), newHeaderSize = Math.ceil(encoded.length / 4) * 4;
      const altered = Buffer.alloc(8 + newHeaderSize + bytes.length - 8 - oldHeaderSize, 32);
      altered.write('HND1'); altered.writeUInt32LE(newHeaderSize, 4); encoded.copy(altered, 8); bytes.copy(altered, 8 + newHeaderSize, 8 + oldHeaderSize);
      assert.throws(() => inspect(altered, { ...manifest, bytes: altered.length, sha256: sha(altered) }, maps), /cannot alias length/);
    }
  }
});
