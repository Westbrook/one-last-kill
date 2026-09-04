// Read the shipped GLB through Three's production geometry/material parser.
// Node has no image decoder: the test plugin substitutes texture objects only;
// image dimensions and embedded byte ranges are inspected from the real PNGs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Box3, Texture, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const PISTOL_GLB_URL = new URL('../public/assets/models/pistol/pistol.glb', import.meta.url);

export function readGLB(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'Valid glTF binary header');
  assert.equal(bytes.readUInt32LE(4), 2, 'glTF 2.0');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'Declared file size matches shipped bytes');
  let json, binary;
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    assert.equal(length % 4, 0, 'Aligned GLB chunk');
    assert.ok(offset + 8 + length <= bytes.length, 'Chunk is inside file');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) binary = chunk;
    offset += length + 8;
  }
  assert.ok(json && binary, 'Self-contained GLB has JSON and binary chunks');
  assert.equal(json.asset.version, '2.0');
  assert.equal(json.buffers.length, 1, 'One self-contained binary buffer');
  assert.equal(json.buffers[0].uri, undefined, 'No external buffer fetch');
  assert.ok(json.buffers[0].byteLength <= binary.length);
  for (const view of json.bufferViews) {
    assert.equal(view.buffer, 0);
    assert.ok((view.byteOffset ?? 0) + view.byteLength <= json.buffers[0].byteLength,
      'Every accessor and image buffer view fits inside the binary payload');
  }
  const images = (json.images ?? []).map(image => {
    assert.equal(image.uri, undefined, 'Finish textures are embedded');
    assert.equal(image.mimeType, 'image/png', 'Inspect the actual embedded PNG header');
    const view = json.bufferViews[image.bufferView];
    assert.ok(view, 'Image refers to a real buffer view');
    const png = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
  });
  return { json, binary, images };
}

export function createCPUAssetLoader(images) {
  return new GLTFLoader().register(parser => ({
    name: 'CPU_TEXTURE_HEADER_VALIDATION',
    loadTexture(index) {
      const source = parser.json.textures[index].source, image = images[source];
      assert.ok(image, 'Texture uses an embedded image');
      const texture = new Texture({ width: image.width, height: image.height });
      texture.flipY = false;
      parser.associations.set(texture, { textures: index });
      return Promise.resolve(texture);
    },
  }));
}

export async function inspectPistolAsset(url = PISTOL_GLB_URL) {
  const bytes = await readFile(url), { json, binary, images } = readGLB(bytes);
  const loader = createCPUAssetLoader(images);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await loader.parseAsync(arrayBuffer, '');
  const meshes = [], materials = new Set();
  let triangles = 0, draws = 0;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    meshes.push(object);
    triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) materials.add(material);
    draws += Array.isArray(object.material) ? object.geometry.groups.length : 1;
  });
  const bounds = new Box3().setFromObject(gltf.scene, true);
  const summary = { bytes: bytes.length, triangles, sourcePrimitives: draws, materials: materials.size,
    images, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), size: bounds.getSize(new Vector3()).toArray() } };
  return { gltf, json, binary, bytes, arrayBuffer, images, meshes, materials, bounds, summary, loader };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { summary } = await inspectPistolAsset();
  console.log(JSON.stringify(summary, null, 2));
}
