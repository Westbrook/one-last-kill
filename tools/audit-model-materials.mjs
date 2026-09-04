#!/usr/bin/env node
// Offline delivery integrity/budget gate. Pixel statistics detect malformed data,
// not artistic quality; in-engine review remains the acceptance step.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeMaterialPNG } from './lib/model-material-png.mjs';

export const MATERIAL_AUDIT_VERSION = 1;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = Object.freeze({ file: 32 * 1024 * 1024, json: 2 * 1024 * 1024, items: 10000, accessor: 2000000 });
const COMPONENT = { 5120: [1, 'readInt8'], 5121: [1, 'readUInt8'], 5122: [2, 'readInt16LE'], 5123: [2, 'readUInt16LE'], 5125: [4, 'readUInt32LE'], 5126: [4, 'readFloatLE'] };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const PACK_TYPE = { f32: [4, 'readFloatLE'], i16: [2, 'readInt16LE'], u16: [2, 'readUInt16LE'], u8: [1, 'readUInt8'], Float32Array: [4, 'readFloatLE'], Uint16Array: [2, 'readUInt16LE'], Uint32Array: [4, 'readUInt32LE'], Uint8Array: [1, 'readUInt8'] };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const equal = (actual, expected, why) => assert.deepEqual(actual, expected, why);
const bounded = (number, minimum, maximum, why) => assert.ok(Number.isSafeInteger(number) && number >= minimum && number <= maximum, why);
const list = (value, why) => { assert.ok(Array.isArray(value), why); bounded(value.length, 0, LIMIT.items, `${why}: list budget`); return value; };
const at = (items, index, why) => { bounded(index, 0, items.length - 1, why); return items[index]; };
function range(bytes, start, length, why) { bounded(start, 0, bytes.length, `${why}: offset`); bounded(length, 0, bytes.length - start, `${why}: range`); return bytes.subarray(start, start + length); }
function safeJSON(bytes, why) { bounded(bytes.length, 2, LIMIT.json, `${why}: JSON budget`); const value = JSON.parse(bytes.toString('utf8')); assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${why}: object`); return value; }
async function readBounded(path, maximum = LIMIT.file) { const info = await stat(path); assert.ok(info.isFile(), `${path}: regular file required`); bounded(info.size, 1, maximum, `${path}: file budget`); const bytes = await readFile(path); bounded(bytes.length, 1, maximum, `${path}: file read budget`); return bytes; }
function finiteValues(value, why) { if (typeof value === 'number') assert.ok(Number.isFinite(value), why); else if (value && typeof value === 'object') for (const child of Object.values(value)) finiteValues(child, why); }

export function readMaterialGLB(bytes) {
  bounded(bytes.length, 28, LIMIT.file, 'GLB file budget');
  equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB signature'); equal(bytes.readUInt32LE(4), 2, 'GLB version'); equal(bytes.readUInt32LE(8), bytes.length, 'GLB declared length');
  let cursor = 12; const chunks = [];
  while (cursor < bytes.length) {
    range(bytes, cursor, 8, 'GLB chunk header'); const length = bytes.readUInt32LE(cursor), kind = bytes.readUInt32LE(cursor + 4);
    equal(length % 4, 0, 'GLB chunk alignment'); chunks.push({ kind, data: range(bytes, cursor + 8, length, 'GLB chunk') }); cursor += length + 8;
    assert.ok(chunks.length <= 2, 'GLB must contain exactly JSON and BIN chunks');
  }
  equal(chunks.map(chunk => chunk.kind), [0x4e4f534a, 0x004e4942], 'Self-contained JSON/BIN GLB');
  const json = safeJSON(chunks[0].data, 'GLB JSON'), binary = chunks[1].data;
  equal(json.asset?.version, '2.0', 'glTF asset version'); equal(list(json.buffers, 'GLB buffers').length, 1, 'One GLB buffer');
  equal(json.buffers[0].uri, undefined, 'No external buffers'); bounded(json.buffers[0].byteLength, binary.length - 3, binary.length, 'GLB binary padding');
  assert.ok(!json.extensionsUsed?.length && !json.extensionsRequired?.length, 'Unsupported glTF extensions require an explicit gate implementation');
  const rejectExtensions = object => { if (!object || typeof object !== 'object') return; assert.ok(!object.extensions || Object.keys(object.extensions).length === 0, 'Unsupported glTF extension'); for (const [key, value] of Object.entries(object)) if (key !== 'extras') rejectExtensions(value); };
  rejectExtensions(json); finiteValues(json, 'glTF numeric fields must be finite');
  const views = list(json.bufferViews, 'GLB buffer views').map(view => { equal(view.buffer, 0, 'Embedded buffer view'); return range(binary.subarray(0, json.buffers[0].byteLength), view.byteOffset ?? 0, view.byteLength, 'Buffer view'); });
  return { json, binary, views };
}

function accessorReadBudget(descriptors, countOf, componentsOf = () => 1) {
  let components = 0;
  for (const descriptor of descriptors) {
    const count = countOf(descriptor), width = componentsOf(descriptor); bounded(count, 1, LIMIT.accessor, 'Accessor element budget');
    bounded(width, 1, 16, 'Accessor width'); components += count * width;
    bounded(components, 1, 8 * 1024 * 1024, 'Aggregate accessor read budget');
  }
}
function accessorData(json, views, index) {
  const accessor = at(json.accessors, index, 'Accessor binding'); assert.ok(!accessor.sparse, 'Sparse accessors require an explicit gate implementation');
  const [bytesPerComponent, read] = COMPONENT[accessor.componentType] ?? []; assert.ok(bytesPerComponent && WIDTH[accessor.type], 'Supported accessor layout');
  bounded(accessor.count, 1, LIMIT.accessor, 'Accessor element budget'); const size = bytesPerComponent * WIDTH[accessor.type];
  const view = at(views, accessor.bufferView, 'Accessor buffer view'), stride = json.bufferViews[accessor.bufferView].byteStride ?? size;
  bounded(stride, size, 252, 'Accessor stride'); equal(stride % bytesPerComponent, 0, 'Accessor stride alignment');
  const start = accessor.byteOffset ?? 0; equal(start % bytesPerComponent, 0, 'Accessor offset alignment');
  range(view, start, (accessor.count - 1) * stride + size, 'Accessor data');
  const packed = Buffer.alloc(accessor.count * size), values = [];
  for (let i = 0; i < accessor.count; i++) {
    view.copy(packed, i * size, start + i * stride, start + i * stride + size);
    for (let component = 0; component < WIDTH[accessor.type]; component++) { const value = view[read](start + i * stride + component * bytesPerComponent); assert.ok(Number.isFinite(value), 'Finite accessor value'); values.push(value); }
  }
  return { layout: omit(accessor, ['bufferView', 'byteOffset']), sha256: sha(packed), values };
}

export function inspectTexturePixels(bytes, { label, dimension, semantic, allowPadding = false }) {
  const decoded = decodeMaterialPNG(bytes, { maxDimension: dimension, maxPixels: dimension * dimension });
  equal([decoded.width, decoded.height], [dimension, dimension], `${label}: map dimensions`);
  let opaque = decoded.opaque, validNormals = 0, backwardNormals = 0, padding = 0; const ranges = [[255, 0], [255, 0], [255, 0]], pixels = decoded.pixels;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    opaque &&= pixels[offset + 3] === 255;
    for (let channel = 0; channel < 3; channel++) { const value = pixels[offset + channel]; ranges[channel][0] = Math.min(ranges[channel][0], value); ranges[channel][1] = Math.max(ranges[channel][1], value); }
    if (semantic === 'normal') {
      const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      if (allowPadding && rgb.every(value => value === 0)) { padding++; continue; }
      const vector = rgb.map(value => value / 127.5 - 1), length = Math.hypot(...vector);
      if (length >= .88 && length <= 1.12) validNormals++;
      if (vector[2] < -.02) backwardNormals++;
    }
  }
  assert.ok(opaque, `${label}: opaque material contains transparency`);
  const texels = decoded.width * decoded.height, considered = texels - padding;
  if (semantic === 'normal') {
    assert.ok(considered >= texels * .1, `${label}: normal map contains almost only padding`);
    assert.ok(backwardNormals <= considered * .10, `${label}: normal map predominantly faces behind the tangent surface`);
    assert.ok(validNormals >= considered * .95, `${label}: normal vectors are not sensible (${validNormals}/${considered}; ${padding} black padding texels excluded)`);
  }
  return { name: label, semantic, width: decoded.width, height: decoded.height, bitDepth: decoded.bitDepth, sourceChannels: decoded.channels, bytes: bytes.length, sha256: sha(bytes), opaque,
    channelRanges: ranges, ...(semantic === 'normal' ? { normalCoverage: { considered, validLength: validNormals, backward: backwardNormals, blackPadding: padding, requiredValidFraction: .95 } } : {}) };
}

function effectiveSampler(sampler) {
  const result = { magFilter: sampler.magFilter ?? 9729, minFilter: sampler.minFilter ?? 9987, wrapS: sampler.wrapS ?? 10497, wrapT: sampler.wrapT ?? 10497 };
  assert.ok([9728, 9729].includes(result.magFilter), 'Valid mag filter'); assert.ok([9728, 9729, 9984, 9985, 9986, 9987].includes(result.minFilter), 'Valid min filter');
  for (const axis of ['wrapS', 'wrapT']) assert.ok([33071, 33648, 10497].includes(result[axis]), 'Valid texture wrapping');
  return { ...sampler, ...result };
}

export function inspectGLBMaterialAsset(bytes, { id, manifest }) {
  assert.ok(['pistol', 'weapons'].includes(id), 'Known GLB material catalog');
  const { json, views } = readMaterialGLB(bytes);
  for (const name of ['accessors', 'meshes', 'nodes', 'materials', 'textures', 'images', 'samplers', 'scenes']) list(json[name], `GLB ${name}`);
  equal(json.materials.length, 3, `${id}: material budget`); equal(json.textures.length, 6, `${id}: texture budget`); equal(json.images.length, 6, `${id}: image budget`);
  assert.ok(!json.skins?.length && !json.animations?.length && !json.cameras?.length, 'Static weapon gate rejects skin/animation/camera changes');
  accessorReadBudget(json.accessors, accessor => accessor.count, accessor => WIDTH[accessor.type]);
  const accessors = json.accessors.map((_, index) => accessorData(json, views, index));
  const usedMaterials = new Set(), usedMeshes = new Set(), usedTextures = new Set(), usedImages = new Set(), usedSamplers = new Set(), semantics = new Map(), textureUV = new Map();
  const imageBytes = json.images.map(image => { equal(image.uri, undefined, 'Texture images must be embedded'); equal(image.mimeType, 'image/png', 'Embedded PNG required'); assert.ok(typeof image.name === 'string' && image.name, 'Named embedded image required'); return at(views, image.bufferView, 'Image buffer view'); });
  equal(new Set(json.images.map(image => image.name)).size, json.images.length, 'Unique image names');
  const textureBinding = (info, semantic, materialIndex) => {
    const texture = at(json.textures, info.index, 'Material texture index'); usedTextures.add(info.index);
    const image = at(json.images, texture.source, 'Texture image index'); usedImages.add(texture.source);
    const sampler = effectiveSampler(at(json.samplers, texture.sampler, 'Texture sampler index')); usedSamplers.add(texture.sampler);
    const coord = info.texCoord ?? 0; bounded(coord, 0, 1, 'Texture UV set'); const coords = textureUV.get(materialIndex) ?? new Set(); coords.add(`TEXCOORD_${coord}`); textureUV.set(materialIndex, coords);
    const use = semantics.get(texture.source) ?? new Set(); use.add(semantic); semantics.set(texture.source, use);
    return { ...omit(info, ['index']), texCoord: coord, image: image.name, textureMetadata: omit(texture, ['sampler', 'source']), sampler };
  };
  const materials = json.materials.map((material, materialIndex) => {
    assert.ok(typeof material.name === 'string' && material.name, 'Named material required'); equal(material.alphaMode ?? 'OPAQUE', 'OPAQUE', 'Material opacity budget');
    const copy = structuredClone(material), pbr = copy.pbrMetallicRoughness ??= {};
    const infos = [['baseColorTexture', pbr, 'baseColor'], ['metallicRoughnessTexture', pbr, 'metallicRoughness'], ['normalTexture', copy, 'normal'], ['occlusionTexture', copy, 'occlusion'], ['emissiveTexture', copy, 'emissive']];
    const hasSurfaceMaps = Boolean(pbr.baseColorTexture || pbr.metallicRoughnessTexture || copy.normalTexture);
    if (hasSurfaceMaps) assert.ok(pbr.baseColorTexture && pbr.metallicRoughnessTexture && copy.normalTexture, 'Complete base-color/normal/metal-rough finish required');
    for (const [key, holder, semantic] of infos) if (holder[key]) holder[key] = textureBinding(holder[key], semantic, materialIndex);
    return copy;
  });
  equal(new Set(materials.map(material => material.name)).size, materials.length, 'Unique material names');
  const meshNames = json.meshes.map(mesh => mesh.name), nodeNames = json.nodes.map(node => node.name);
  assert.ok(meshNames.every(name => typeof name === 'string' && name) && new Set(meshNames).size === meshNames.length, 'Unique named meshes');
  assert.ok(nodeNames.every(name => typeof name === 'string' && name) && new Set(nodeNames).size === nodeNames.length, 'Unique named nodes');
  let triangles = 0, primitives = 0; const byMesh = {};
  const meshes = json.meshes.map(mesh => ({ ...omit(mesh, ['primitives']), primitives: list(mesh.primitives, 'Mesh primitives').map(primitive => {
    primitives++; equal(primitive.mode ?? 4, 4, 'Triangle primitives only'); const material = at(materials, primitive.material, 'Primitive material'); usedMaterials.add(primitive.material);
    const position = at(accessors, primitive.attributes?.POSITION, 'Primitive positions'); equal(position.layout.type, 'VEC3', 'Position layout');
    assert.ok(primitive.attributes.NORMAL !== undefined, 'Surface normals required');
    const attributes = Object.fromEntries(Object.entries(primitive.attributes).map(([name, index]) => { const accessor = at(accessors, index, `${name} accessor`); equal(accessor.layout.count, position.layout.count, 'Aligned attribute counts'); return [name, omit(accessor, ['values'])]; }));
    for (const uv of textureUV.get(primitive.material) ?? []) assert.ok(attributes[uv], `${mesh.name}: texture is missing its UV binding`);
    const index = at(accessors, primitive.indices, 'Triangle indices'); equal(index.layout.type, 'SCALAR', 'Index layout'); assert.ok([5121, 5123, 5125].includes(index.layout.componentType), 'Unsigned indices'); equal(index.layout.count % 3, 0, 'Complete triangles');
    assert.ok(index.values.every(value => value < position.layout.count), 'Indices fit vertex attributes'); triangles += index.layout.count / 3; byMesh[mesh.name] = (byMesh[mesh.name] ?? 0) + index.layout.count / 3;
    const targets = primitive.targets?.map(target => Object.fromEntries(Object.entries(target).map(([name, index]) => { const accessor = at(accessors, index, 'Morph accessor'); equal(accessor.layout.count, position.layout.count, 'Morph vertex count'); return [name, omit(accessor, ['values'])]; })));
    return { ...omit(primitive, ['attributes', 'indices', 'material', 'targets']), attributes, indices: omit(index, ['values']), material: material.name, ...(targets ? { targets } : {}) };
  }) }));
  const parents = new Map();
  for (const [parent, node] of json.nodes.entries()) {
    const children = list(node.children ?? [], 'Node children'); equal(new Set(children).size, children.length, 'Node children cannot repeat');
    for (const child of children) { at(json.nodes, child, 'Child node'); assert.ok(!parents.has(child), 'Node cannot have multiple parents'); parents.set(child, parent); }
  }
  const nodes = json.nodes.map(node => {
    const copy = omit(node, ['mesh', 'children']);
    if (node.mesh !== undefined) { at(meshNames, node.mesh, 'Node mesh'); usedMeshes.add(node.mesh); copy.mesh = meshNames[node.mesh]; }
    if (node.children) copy.children = list(node.children, 'Node children').map(index => at(nodeNames, index, 'Child node'));
    for (const [key, length] of [['translation', 3], ['rotation', 4], ['scale', 3], ['matrix', 16]]) if (node[key]) equal(node[key].length, length, 'Node transform dimensions');
    assert.ok(!(node.matrix && (node.translation || node.rotation || node.scale)), 'Node cannot mix matrix and TRS'); return copy;
  });
  const seen = new Set(), visiting = new Set();
  function visit(index) { at(json.nodes, index, 'Scene node'); assert.ok(!visiting.has(index), 'Node graph cycle'); if (seen.has(index)) return; visiting.add(index); for (const child of json.nodes[index].children ?? []) visit(child); visiting.delete(index); seen.add(index); }
  const scenes = json.scenes.map(scene => { const roots = list(scene.nodes, 'Scene nodes'); equal(new Set(roots).size, roots.length, 'Scene roots cannot repeat'); return { ...scene, nodes: roots.map(index => { assert.ok(!parents.has(index), 'Scene roots cannot have a parent'); visit(index); return at(nodeNames, index, 'Scene root'); }) }; });
  at(scenes, json.scene, 'Default scene'); equal(seen.size, json.nodes.length, 'No unreachable nodes');
  for (const [used, items, label] of [[usedMaterials, materials, 'materials'], [usedMeshes, meshes, 'meshes'], [usedTextures, json.textures, 'textures'], [usedImages, json.images, 'images'], [usedSamplers, json.samplers, 'samplers']]) equal(used.size, items.length, `No unused ${label}`);
  const colorClasses = new Map();
  const images = imageBytes.map((png, index) => {
    const use = [...semantics.get(index)].sort(), classes = new Set(use.map(semantic => ['baseColor', 'emissive'].includes(semantic) ? 'sRGB' : 'linear'));
    equal(classes.size, 1, 'One image cannot alias sRGB and linear semantics');
    const hash = sha(png), previous = colorClasses.get(hash); assert.ok(!previous || previous === [...classes][0], 'Identical image content cannot alias sRGB and linear semantics'); colorClasses.set(hash, [...classes][0]);
    return { ...inspectTexturePixels(png, { label: json.images[index].name, dimension: 256, semantic: use.includes('normal') ? 'normal' : use[0] }), metadata: omit(json.images[index], ['bufferView']), uses: use, colorSpace: [...classes][0] };
  });
  const bytesWithMips = images.length * 256 * 256 * 4 * 4 / 3;
  equal(manifest.delivery?.sha256, sha(bytes), `${id}: manifest GLB checksum`); equal(manifest.delivery?.glbBytes, bytes.length, `${id}: manifest GLB bytes`); equal(manifest.delivery?.embeddedImages, images.length, `${id}: manifest image inventory`);
  equal(manifest.delivery?.textureRgba8BytesWithMipmapsEstimate, bytesWithMips, `${id}: texture allocation estimate`); equal(manifest.delivery?.runtimeExternalDependencies, [], 'No external texture dependencies');
  const records = list(manifest.textures, 'Manifest texture records'); equal(records.length, images.length, 'Complete manifest texture inventory');
  for (const image of images) {
    const matches = records.filter(entry => basename(entry.path, '.png') === image.name); equal(matches.length, 1, `${image.name}: unique manifest record`); const record = matches[0];
    equal([record.width, record.height, record.bytes, record.sha256], [image.width, image.height, image.bytes, image.sha256], `${image.name}: embedded pixels match manifest`);
  }
  equal(triangles, manifest.geometry.triangles, 'Manifest triangle count'); equal(materials.length, manifest.geometry.materialGroups, 'Manifest material count');
  if (id === 'pistol') { assert.ok(triangles <= 4000, 'Pistol triangle budget'); equal(primitives, manifest.geometry.meshParts, 'Pistol primitive inventory'); }
  else for (const [type, weapon] of Object.entries(manifest.weapons)) {
    const root = json.nodes.findIndex(node => node.name === `vm_${type}`); assert.ok(root >= 0, 'Named weapon root'); let total = 0;
    const count = index => { const node = json.nodes[index]; if (node.mesh !== undefined) total += byMesh[meshNames[node.mesh]]; for (const child of node.children ?? []) count(child); }; count(root);
    equal(total, weapon.geometry.triangles, `${type}: manifest triangles`); assert.ok(total <= weapon.geometry.budgetTriangles, `${type}: triangle budget`);
  }
  const structure = { defaultScene: json.scene, scenes, nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)), meshes: meshes.sort((a, b) => a.name.localeCompare(b.name)), materials: materials.sort((a, b) => a.name.localeCompare(b.name)), assetExtras: json.extras ?? null,
    images: images.map(image => ({ name: image.name, metadata: image.metadata, width: image.width, height: image.height, uses: image.uses, colorSpace: image.colorSpace })).sort((a, b) => a.name.localeCompare(b.name)) };
  return { id, format: 'GLB', bytes: bytes.length, sha256: sha(bytes), triangles, primitives, materials: materials.length, textures: images, estimatedRGBA8WithMipmaps: bytesWithMips, structuralSHA256: digest(structure), structure };
}

function packData(bytes, descriptor, offset = 0) {
  const [width, read] = PACK_TYPE[descriptor.type] ?? []; assert.ok(width, 'Supported packed component type');
  if (descriptor.scale !== undefined) assert.ok(Number.isFinite(descriptor.scale) && descriptor.scale > 0, 'Positive finite packed scale');
  const count = descriptor.length ?? descriptor.count; bounded(count, 1, LIMIT.accessor, 'Packed component count');
  const start = offset + (descriptor.byteOffset ?? descriptor.offset); equal(start % width, 0, 'Packed component alignment');
  const data = range(bytes, start, count * width, 'Packed component range'), values = [];
  for (let i = 0; i < count; i++) { const value = data[read](i * width); assert.ok(Number.isFinite(value), 'Finite packed value'); values.push(value); }
  return { layout: omit(descriptor, ['byteOffset', 'offset']), sha256: sha(data), values };
}
function validatePackedMesh(surface, attributes, index) {
  for (const key of ['position', 'normal', 'uv']) assert.ok(attributes[key], `Packed ${key} required`);
  const count = attributes.position.values.length / 3; bounded(count, 1, LIMIT.accessor, 'Packed vertex count');
  equal(attributes.normal.values.length, count * 3, 'Packed normal count'); equal(attributes.uv.values.length, count * 2, 'Packed UV count');
  equal(index.values.length % 3, 0, 'Packed triangle indices'); assert.ok(index.values.every(value => Number.isSafeInteger(value) && value >= 0 && value < count), 'Packed index fits vertex count');
  return { ...surface, attributes: Object.fromEntries(Object.entries(attributes).map(([name, data]) => [name, omit(data, ['values'])])), index: omit(index, ['values']) };
}
function verifyMapRecord(record, image, label) {
  equal([record.width, record.height, record.bytes, record.sha256], [image.width, image.height, image.bytes, image.sha256], `${label}: texture manifest checksum/dimensions`);
  equal(record.colorSpace, image.colorSpace, `${label}: texture color space`);
}
export function inspectHandMaterialAsset(bytes, manifest, maps) {
  bounded(bytes.length, 16, 1500000, 'Hand runtime file budget'); equal(manifest.version, 2, 'Hand manifest version');
  equal(bytes.subarray(0, 4).toString(), 'HND1', 'Hand binary magic'); equal(manifest.sha256, sha(bytes), 'Hand manifest checksum'); equal(manifest.bytes, bytes.length, 'Hand manifest bytes');
  const length = bytes.readUInt32LE(4), header = safeJSON(range(bytes, 8, length, 'Hand binary header'), 'Hand header'), offset = 8 + length;
  for (const descriptor of list(header.buffers, 'Hand buffers')) { equal(descriptor.length, undefined, 'Hand descriptors cannot alias length'); equal(descriptor.byteOffset, undefined, 'Hand descriptors cannot alias byteOffset'); }
  accessorReadBudget(header.buffers, descriptor => descriptor.count);
  equal(header.version, 2, 'Baked hand header version'); equal(list(header.meshes, 'Hand meshes').length, 10, 'Hand mesh inventory');
  const buffers = header.buffers.map(descriptor => packData(bytes, descriptor, offset));
  const surfaces = list(header.meshes, 'Hand meshes').map(mesh => {
    const attributes = Object.fromEntries(Object.entries(mesh.attributes).map(([name, id]) => [name, at(buffers, id, 'Hand attribute')]));
    const surface = validatePackedMesh(omit(mesh, ['attributes', 'index', 'morphAttributes', 'morph']), attributes, at(buffers, mesh.index, 'Hand index'));
    if (mesh.morph) surface.morph = Object.fromEntries(Object.entries(mesh.morph).map(([name, id]) => { const morph = at(buffers, id, 'Hand morph'); equal(morph.values.length, attributes[name].values.length, 'Hand morph components'); return [name, omit(morph, ['values'])]; }));
    if (mesh.morphAttributes) surface.morphAttributes = Object.fromEntries(Object.entries(mesh.morphAttributes).map(([name, ids]) => [name, ids.map(id => { const morph = at(buffers, id, 'Hand morph'); equal(morph.values.length, attributes[name].values.length, 'Hand morph components'); return omit(morph, ['values']); })]));
    assert.ok(surface.index.layout.count / 3 <= 3200, 'Per-hand geometry budget'); return surface;
  });
  const records = list(manifest.bake?.textures, 'Hand texture records'); equal(records.length, 3, 'Hand map budget'); equal(manifest.bake.size, 512, 'Hand map size'); equal(manifest.bake.extraDrawCalls, 0, 'Hand additional draws');
  const expected = { 'hand-albedo.png': 'baseColor', 'hand-normal.png': 'normal', 'hand-roughness.png': 'roughness' };
  equal(Object.keys(maps).sort(), Object.keys(expected).sort(), 'Hand map inventory');
  const textures = Object.entries(expected).map(([name, semantic]) => {
    const image = { ...inspectTexturePixels(maps[name], { label: name, dimension: 512, semantic, allowPadding: true }), colorSpace: semantic === 'baseColor' ? 'sRGB' : 'linear' };
    const matches = records.filter(record => record.file === name); equal(matches.length, 1, 'Unique hand texture record'); verifyMapRecord(matches[0], image, name); return image;
  });
  const estimatedRGBA8WithMipmaps = 3 * 512 * 512 * 4 * 4 / 3; equal(manifest.bake.estimatedRuntimeBytesWithMipmaps, estimatedRGBA8WithMipmaps, 'Hand texture memory');
  const structure = { binarySHA256: sha(bytes), headerVersion: header.version, surfaces, rightHandVariants: manifest.rightHandVariants, sharedArmMeshes: manifest.sharedArmMeshes, textures: textures.map(image => ({ name: image.name, semantic: image.semantic, width: image.width, height: image.height, colorSpace: image.colorSpace })), extraDrawCalls: manifest.extraDrawCalls, materials: manifest.materials, normalConvention: manifest.bake.normalConvention };
  return { id: 'hands', format: 'HND1', bytes: bytes.length, sha256: sha(bytes), surfaces: surfaces.length, textures, estimatedRGBA8WithMipmaps, structuralSHA256: digest(structure), structure };
}

export function inspectCharacterMaterialAsset(bytes, manifest, maps, { allowLegacyMetadata = false } = {}) {
  bounded(bytes.length, 1, 12 * 1024 * 1024, 'Character runtime file budget'); equal(manifest.version, 1, 'Character manifest version');
  equal(manifest.binary, 'characters.bin', 'Character binary binding'); equal(manifest.sha256, sha(bytes), 'Character manifest checksum'); equal(manifest.byteLength, bytes.length, 'Character manifest bytes');
  equal(manifest.runtime, { drawsPerCharacter: 4, bonesPerCharacter: 17, additionalTextures: 4, maximumTrianglesPerCharacter: 15000 }, 'Character runtime budgets');
  const catalog = list(manifest.catalog, 'Character catalog'); equal(catalog.length, 8, 'Character catalog budget');
  const descriptors = catalog.flatMap(character => list(character.surfaces, 'Character surfaces').flatMap(surface => [...Object.values(surface.attributes), surface.index]));
  for (const descriptor of descriptors) { equal(descriptor.count, undefined, 'Character descriptors cannot alias count'); equal(descriptor.offset, undefined, 'Character descriptors cannot alias offset'); }
  accessorReadBudget(descriptors, descriptor => descriptor.length);
  const characters = catalog.map(character => {
    equal(character.bones.length, 17, 'Character bone budget'); equal(character.surfaces.length, 4, 'Character surface budget'); let triangles = 0;
    const surfaces = character.surfaces.map(surface => {
      const attributes = Object.fromEntries(Object.entries(surface.attributes).map(([name, descriptor]) => [name, packData(bytes, descriptor)]));
      const index = packData(bytes, surface.index); triangles += index.values.length / 3;
      return validatePackedMesh(omit(surface, ['attributes', 'index']), attributes, index);
    });
    assert.ok(triangles <= 15000, `${character.id}: character triangle budget`); finiteValues(character, 'Finite character bindings');
    return { ...Object.fromEntries(['id', 'config', 'dimensions', 'bones', 'body', 'head', 'revision'].map(key => [key, character[key]])), surfaces, ...(character.finish ? { finish: omit(character.finish, ['textures']) } : {}) };
  });
  const gunman = catalog.find(character => character.id === 'gunman'); assert.ok(gunman?.finish, 'Gunman finish required'); equal(gunman.finish.version, 1, 'Gunman finish version');
  equal(catalog.filter(character => character.finish).length, 1, 'Only gunman has baked finish');
  const expected = Object.fromEntries(['head', 'garments'].flatMap(part => ['normal', 'roughness'].map(semantic => [gunman.finish[part][semantic], semantic])));
  equal(Object.keys(expected).sort(), ['gunman-garments-normal.png', 'gunman-garments-roughness.png', 'gunman-head-normal.png', 'gunman-head-roughness.png']);
  equal(Object.keys(maps).sort(), Object.keys(expected).sort(), 'Character map inventory');
  const records = gunman.finish.textures;
  assert.ok(records || allowLegacyMetadata, 'Character finish requires per-map checksum metadata; legacy exception is reference capture only');
  if (records) equal(list(records, 'Character texture records').length, 4, 'Character map metadata budget');
  const textures = Object.entries(expected).map(([name, semantic]) => {
    const image = { ...inspectTexturePixels(maps[name], { label: name, dimension: 512, semantic, allowPadding: true }), colorSpace: 'linear' };
    if (records) { const matches = records.filter(record => record.file === name); equal(matches.length, 1, 'Unique character texture record'); verifyMapRecord(matches[0], image, name); }
    return image;
  });
  const structure = { binarySHA256: sha(bytes), characters, runtime: manifest.runtime, textures: textures.map(image => ({ name: image.name, semantic: image.semantic, width: image.width, height: image.height, colorSpace: image.colorSpace })) };
  return { id: 'characters', format: 'typed-array pack', bytes: bytes.length, sha256: sha(bytes), characters: characters.length, textures, estimatedRGBA8WithMipmaps: 4 * 512 * 512 * 4 * 4 / 3, textureIntegrity: records ? 'manifest checksums verified' : 'legacy reference: observed PNG hashes, no manifest checksums', structuralSHA256: digest(structure), structure };
}

export async function auditModelMaterials({ root = REPO, asset, assetDir, allowLegacyMetadata = false } = {}) {
  const ids = asset ? [asset] : ['hands', 'characters', 'pistol', 'weapons'];
  assert.ok(ids.every(id => ['hands', 'characters', 'pistol', 'weapons'].includes(id)), 'Unknown material asset');
  assert.ok(!assetDir || asset, '--asset-dir requires --asset');
  const assets = [];
  for (const id of ids) {
    const directory = assetDir ? resolve(assetDir) : resolve(root, 'public/assets/models', id);
    const manifest = safeJSON(await readBounded(resolve(directory, 'manifest.json'), LIMIT.json), `${id} manifest`);
    const bytes = await readBounded(resolve(directory, `${id}.${['hands', 'characters'].includes(id) ? 'bin' : 'glb'}`));
    if (id === 'hands' || id === 'characters') {
      const names = id === 'hands' ? ['hand-albedo.png', 'hand-normal.png', 'hand-roughness.png'] : ['gunman-head-normal.png', 'gunman-head-roughness.png', 'gunman-garments-normal.png', 'gunman-garments-roughness.png'];
      const maps = Object.fromEntries(await Promise.all(names.map(async name => [name, await readBounded(resolve(directory, name))])));
      assets.push(id === 'hands' ? inspectHandMaterialAsset(bytes, manifest, maps) : inspectCharacterMaterialAsset(bytes, manifest, maps, { allowLegacyMetadata }));
    } else assets.push(inspectGLBMaterialAsset(bytes, { id, manifest }));
  }
  return { schemaVersion: MATERIAL_AUDIT_VERSION, generatedAt: new Date().toISOString(), scope: 'Shipped hand, gunman and held-weapon material integrity; other geometry-only families remain covered by their existing contract tests.', limitations: ['RGBA8 plus mip estimates are not measured GPU residency.', 'Normal checks exclude exact black padding, require 95% of remaining vector lengths within 0.88–1.12 and at most 10% backward vectors; atlas edges and ray misses remain visible in the statistics. This is a data sanity check, not a bake-quality score.', 'This gate does not judge realism, seams, lighting neutrality or artistic quality; accept texture content with matched in-game review.', 'Source .blend packing and export reproducibility require the separate saved-source roundtrip checks.'], assets,
    totals: { textures: assets.reduce((sum, item) => sum + item.textures.length, 0), deliveryBytes: assets.reduce((sum, item) => sum + item.bytes + (item.format === 'GLB' ? 0 : item.textures.reduce((n, texture) => n + texture.bytes, 0)), 0), estimatedRGBA8WithMipmaps: assets.reduce((sum, item) => sum + item.estimatedRGBA8WithMipmaps, 0) } };
}

export function compareMaterialAudits(reference, current) {
  equal(reference.schemaVersion, MATERIAL_AUDIT_VERSION, 'Reference audit schema'); equal(current.schemaVersion, MATERIAL_AUDIT_VERSION, 'Current audit schema');
  equal(current.assets.map(asset => asset.id).sort(), reference.assets.map(asset => asset.id).sort(), 'Reference/current asset inventory');
  const changedTextures = [];
  for (const asset of current.assets) {
    const before = reference.assets.find(item => item.id === asset.id);
    equal(digest(before.structure), before.structuralSHA256, `${asset.id}: reference structural report integrity`);
    equal(digest(asset.structure), asset.structuralSHA256, `${asset.id}: current structural report integrity`);
    equal(asset.structuralSHA256, before.structuralSHA256, `${asset.id}: material-only reference forbids geometry/accessor/UV/color/node/transform/extras/material/sampler/binding changes`);
    equal(asset.estimatedRGBA8WithMipmaps, before.estimatedRGBA8WithMipmaps, `${asset.id}: texture allocation changed`);
    for (const texture of asset.textures) {
      const previous = before.textures.find(item => item.name === texture.name); assert.ok(previous, 'Reference texture binding');
      if (previous.sha256 !== texture.sha256) changedTextures.push({ asset: asset.id, name: texture.name, beforeSHA256: previous.sha256, afterSHA256: texture.sha256, byteDelta: texture.bytes - previous.bytes });
    }
  }
  return { status: 'pass', unchanged: 'Named geometry/accessor contents, transforms/extras, semantic material/sampler bindings, and map allocation', changedTextures, deliveryByteDelta: current.totals.deliveryBytes - reference.totals.deliveryBytes, estimatedRGBA8WithMipmapsDelta: current.totals.estimatedRGBA8WithMipmaps - reference.totals.estimatedRGBA8WithMipmaps };
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i]; if (name === '--help') { result.help = true; continue; } if (name === '--allow-legacy-reference') { result.allowLegacyMetadata = true; continue; }
    const key = { '--root': 'root', '--asset': 'asset', '--asset-dir': 'assetDir', '--write-reference': 'writeReference', '--reference': 'reference', '--json': 'json' }[name];
    assert.ok(key && args[i + 1] && !args[i + 1].startsWith('--'), `Unknown/missing argument: ${name}`); result[key] = args[++i];
  }
  assert.ok(!(result.writeReference && result.reference), 'Choose reference capture or comparison'); assert.ok(!result.allowLegacyMetadata || result.writeReference, 'Legacy exception is only allowed while capturing a reference'); return result;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('Usage: node tools/audit-model-materials.mjs [--root DIR] [--asset hands|characters|pistol|weapons --asset-dir DIR] [--write-reference FILE [--allow-legacy-reference] | --reference FILE] [--json FILE]\nCaptures refuse to overwrite existing reference files. Comparison permits texture pixel changes only; browser/source roundtrip review is still required.'); return; }
  const report = await auditModelMaterials(args);
  if (args.reference) {
    const reference = safeJSON(await readBounded(resolve(args.reference), LIMIT.json), 'Reference report');
    if (args.asset) { reference.assets = reference.assets.filter(asset => asset.id === args.asset); reference.totals = { deliveryBytes: reference.assets.reduce((sum, item) => sum + item.bytes + (item.format === 'GLB' ? 0 : item.textures.reduce((n, texture) => n + texture.bytes, 0)), 0), estimatedRGBA8WithMipmaps: reference.assets.reduce((sum, item) => sum + item.estimatedRGBA8WithMipmaps, 0) }; }
    report.comparison = compareMaterialAudits(reference, report);
  }
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (args.writeReference) await writeFile(resolve(args.writeReference), encoded, { flag: 'wx' });
  if (args.json) await writeFile(resolve(args.json), encoded);
  console.log(`PASS: ${report.assets.length} catalogs, ${report.totals.textures} decoded PNGs, ${(report.totals.estimatedRGBA8WithMipmaps / 1048576).toFixed(2)} MiB RGBA8+mip estimate.`);
  for (const asset of report.assets) console.log(`  ${asset.id}: ${asset.textures.length} maps, ${asset.bytes.toLocaleString()} geometry/container bytes, structure ${asset.structuralSHA256}`);
  if (report.comparison) console.log(`  Material-only comparison passed: ${report.comparison.changedTextures.length} changed textures; ${report.comparison.estimatedRGBA8WithMipmapsDelta} added texture allocation bytes.`);
  if (!args.json && !args.writeReference) console.log('Use --json FILE to save the decoded texture inventory and structural fingerprints.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Material audit FAILED: ${error.message}`); process.exitCode = 1; });
