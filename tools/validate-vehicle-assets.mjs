// Inspect the real GLB through Three's production parser. The vehicle catalog
// contains geometry only, so Node needs no image-decoding substitute.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const VEHICLE_GLB_URL = new URL('../public/assets/models/vehicles/vehicles.glb', import.meta.url);
export const CIVILIAN_VARIANTS = ['sedan', 'hatchback', 'wagon', 'panel-van', 'passenger-van'];
export const CIVILIAN_CATEGORIES = ['paint', 'trim', 'metal', 'glass', 'tires', 'lamps'];

function readVehicleGLB(bytes) {
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
      'Every accessor fits inside the binary payload');
  }
  assert.equal(json.images?.length ?? 0, 0, 'Runtime finishes remain shared; no exported image payload');
  assert.equal(json.textures?.length ?? 0, 0, 'No additional texture memory');
  return { json, binary };
}

export async function inspectVehicleAssets(url = VEHICLE_GLB_URL) {
  const bytes = await readFile(url), { json, binary } = readVehicleGLB(bytes);
  const loader = new GLTFLoader();
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await loader.parseAsync(arrayBuffer, '');
  const meshes = [], variants = {}, bounds = new Map();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    meshes.push(object);
    const { vehicleVariant: variant, vehicleCategory: category, vehiclePart: part } = object.userData;
    assert.ok(variant && category && part, `${object.name}: exported part identity`);
    const entry = variants[variant] ??= { triangles: 0, parts: [], categories: {} };
    const triangles = (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
    entry.triangles += triangles; entry.parts.push(part);
    entry.categories[category] = (entry.categories[category] ?? 0) + triangles;
    if (!bounds.has(variant)) bounds.set(variant, new Box3());
    bounds.get(variant).union(new Box3().setFromObject(object, true));
  });
  for (const [variant, bound] of bounds) variants[variant].bounds = {
    min: bound.min.toArray(), max: bound.max.toArray(), size: bound.getSize(new Vector3()).toArray(),
  };
  const summary = { bytes: bytes.length, variants, sourcePrimitives: meshes.length,
    triangles: Object.values(variants).reduce((sum, entry) => sum + entry.triangles, 0), textures: 0 };
  return { gltf, json, binary, bytes, arrayBuffer, meshes, bounds, summary, loader };
}

// An imported preload runs the unchanged fit/contact/ballistics suites against
// the loaded catalog, rather than their normal procedural fallback path.
if (new URL(import.meta.url).searchParams.has('preload')) {
  const { loadAuthoredVehicles } = await import('../src/render/authored-vehicles.js');
  const asset = await inspectVehicleAssets();
  const status = await loadAuthoredVehicles({ loader: { loadAsync: () => asset.loader.parseAsync(asset.arrayBuffer, '') } });
  assert.equal(status.state, 'ready', status.error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--test-existing')) {
    const preload = new URL(import.meta.url); preload.searchParams.set('preload', '1');
    const child = spawn(process.execPath, ['--import', preload.href, '--test',
      'tests/unit/civilian-vehicle-fit.test.js', 'tests/unit/civilian-vehicle-integration.test.js',
      'tests/unit/street-vehicle-aftermath.test.js'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
    });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } else {
    const { summary } = await inspectVehicleAssets();
    console.log(JSON.stringify(summary, null, 2));
  }
}
