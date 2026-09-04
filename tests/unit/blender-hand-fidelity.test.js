import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as THREE from 'three';

const base = new URL('../../public/assets/models/hands/', import.meta.url);
const bytes = await readFile(new URL('hands.bin', base));
const baseline = JSON.parse(await readFile(new URL('./fixtures/hand-fidelity-baseline.json', import.meta.url), 'utf8'));
const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const headerBytes = new DataView(arrayBuffer).getUint32(4, true), payload = 8 + headerBytes;
const header = JSON.parse(new globalThis.TextDecoder().decode(new Uint8Array(arrayBuffer, 8, headerBytes)).trim());
const types = { f32: Float32Array, i16: Int16Array, u16: Uint16Array, u8: Uint8Array };
const array = id => {
  const entry = header.buffers[id], encoded = new types[entry.type](arrayBuffer, payload + entry.offset, entry.count);
  return entry.scale ? Float32Array.from(encoded, value => value * entry.scale) : encoded;
};
const geometry = entry => {
  const result = new THREE.BufferGeometry();
  for (const [name, size] of Object.entries({ position: 3, normal: 3, uv: 2 })) {
    result.setAttribute(name, new THREE.BufferAttribute(array(entry.attributes[name]), size));
  }
  result.setIndex(new THREE.BufferAttribute(array(entry.index), 1));
  return result;
};

function rayMesh(surface) {
  const mesh = new THREE.Mesh(surface, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  return mesh;
}

test('the remodeled hand pack preserves all prior wrist loops and actual inward grip contacts', () => {
  assert.equal(header.version, 2, 'The game receives the sculpted, semantically unwrapped hand generation');
  const ray = new THREE.Raycaster(), point = new THREE.Vector3();
  for (const entry of header.meshes.filter(item => baseline.meshes[item.key])) {
    const before = baseline.meshes[entry.key], surface = geometry(entry), mesh = rayMesh(surface);
    const positions = surface.attributes.position;
    assert.ok(surface.index.count / 3 <= 3200);
    for (const expected of baseline.wrist) {
      const target = new THREE.Vector3(...expected);
      let distance = Infinity;
      for (let index = 0; index < positions.count; index++) {
        point.fromBufferAttribute(positions, index);
        distance = Math.min(distance, point.distanceTo(target));
      }
      assert.ok(distance < 2e-7, `${entry.key}: the authored wrist still matches its sleeve attachment`);
    }
    for (const contact of before.contacts) {
      ray.set(new THREE.Vector3(contact.x, -.010, -.060), new THREE.Vector3(0, Math.cos(contact.angle), Math.sin(contact.angle)));
      const hit = ray.intersectObject(mesh, false)[0];
      assert.ok(hit, `${entry.key}: the finger still covers its previous handle contact`);
      assert.ok(Math.abs(hit.distance - contact.distance) < baseline.contactToleranceM,
        `${entry.key}: held cylinder contact moved ${(hit.distance - contact.distance) * 1000} mm`);
    }
    surface.dispose(); mesh.material.dispose();
  }
});

test('actual camera-facing hand surfaces carry a measurable sculpt while keeping the established silhouette envelope', () => {
  const ray = new THREE.Raycaster();
  for (const entry of header.meshes.filter(item => baseline.meshes[item.key])) {
    const before = baseline.meshes[entry.key], surface = geometry(entry), mesh = rayMesh(surface);
    let moved = 0, maximum = 0; const changedColumns = new Set();
    for (const probe of [...before.dorsal, ...before.digits]) {
      ray.set(new THREE.Vector3(probe.x, .08, probe.z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(mesh, false)[0];
      if (!hit) {
        // Tapering can move an old silhouette-edge sample outside the hand.
        // Check the true nearest surface rather than requiring its old width.
        const prior = new THREE.Vector3(probe.x, probe.y, probe.z), closest = new THREE.Vector3();
        const triangle = new THREE.Triangle(), position = surface.attributes.position, ids = surface.index.array;
        let distance = Infinity;
        for (let face = 0; face < ids.length; face += 3) {
          triangle.a.fromBufferAttribute(position, ids[face]);
          triangle.b.fromBufferAttribute(position, ids[face + 1]);
          triangle.c.fromBufferAttribute(position, ids[face + 2]);
          distance = Math.min(distance, triangle.closestPointToPoint(prior, closest).distanceTo(prior));
        }
        assert.ok(distance < .010, `${entry.key}: the compacted fist/finger silhouette stays within the 1 cm remodeling allowance`);
        continue;
      }
      const movement = Math.abs(hit.point.y - probe.y);
      if (movement > .0015) { moved++; changedColumns.add(probe.x); }
      maximum = Math.max(maximum, movement);
    }
    assert.ok(moved >= 4 && changedColumns.size >= 2,
      `${entry.key}: the low mesh must contain broadly distributed visible shape changes, not only a new texture (${moved} probes)`);
    assert.ok(maximum < .010, `${entry.key}: visible shape changes stay within the 1 cm remodeling allowance`);
    surface.dispose(); mesh.material.dispose();
  }
});

// Decode the PNG rows directly so this check examines shipped pixels without a
// browser, image loader mock, native library, or build-script implementation.
function pngPixels(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const compressed = []; let offset = 8, width, height, depth, channels;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), kind = png.subarray(offset + 4, offset + 8).toString();
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8];
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      assert.ok(channels && [8, 16].includes(depth), 'The baked finish uses RGB/RGBA PNG pixels');
      assert.equal(data[12], 0, 'The atlas is not interlaced');
    }
    if (kind === 'IDAT') compressed.push(data);
    offset += length + 12;
  }
  const source = inflateSync(Buffer.concat(compressed)), stride = width * channels * depth / 8;
  const bpp = channels * depth / 8, pixels = new Uint8Array(height * stride);
  assert.equal(source.length, (stride + 1) * height);
  const paeth = (a, b, c) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let row = 0; row < height; row++) {
    const filter = source[row * (stride + 1)]; assert.ok(filter <= 4);
    for (let col = 0; col < stride; col++) {
      const i = row * stride + col, left = col >= bpp ? pixels[i - bpp] : 0;
      const up = row ? pixels[i - stride] : 0, upperLeft = row && col >= bpp ? pixels[i - stride - bpp] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      pixels[i] = (source[row * (stride + 1) + 1 + col] + predictor) & 255;
    }
  }
  return { width, height, channels, depth, pixels };
}

test('the shipped 512px finish contains baked surface relief within the declared map and memory budgets', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  assert.equal(manifest.revision, 'hands-sculpt-v2');
  assert.ok(manifest.bake.sourceTriangles > 3200 * 16, 'The editable sculpt master holds detail that is absent from the runtime mesh');
  assert.equal(manifest.bake.size, 512);
  assert.equal(manifest.bake.extraDrawCalls, 0);
  assert.equal(manifest.bake.estimatedRuntimeBytesWithMipmaps, 3 * 512 * 512 * 4 * 4 / 3);
  assert.deepEqual(manifest.bake.textures.map(item => item.file).sort(), ['hand-albedo.png', 'hand-normal.png', 'hand-roughness.png']);
  const maps = {};
  for (const entry of manifest.bake.textures) {
    const png = await readFile(new URL(entry.file, base)), decoded = pngPixels(png);
    assert.equal(entry.sha256, createHash('sha256').update(png).digest('hex'));
    assert.equal(entry.bytes, png.length);
    assert.equal(decoded.width, 512); assert.equal(decoded.height, 512);
    assert.equal(entry.width, decoded.width); assert.equal(entry.height, decoded.height);
    assert.equal(entry.colorSpace, entry.file.includes('albedo') ? 'sRGB' : 'linear');
    maps[entry.file] = decoded;
  }
  const sample = (map, u, v) => {
    const x = Math.max(0, Math.min(511, Math.round(u * 511)));
    const y = Math.max(0, Math.min(511, Math.round((1 - v) * 511)));
    const offset = (y * 512 + x) * map.channels * map.depth / 8;
    return [0, 1, 2].map(channel => map.pixels[offset + channel * map.depth / 8]);
  };
  let sampled = 0, valid = 0, detail = 0; const colors = [new Set(), new Set()], roughness = [new Set(), new Set()];
  const normal = maps['hand-normal.png'];
  for (const entry of header.meshes.filter(item => baseline.meshes[item.key])) {
    const surface = geometry(entry), uv = surface.attributes.uv, index = surface.index.array;
    for (let triangle = 0; triangle < index.length; triangle += 3) {
      const ids = [index[triangle], index[triangle + 1], index[triangle + 2]];
      const u = ids.reduce((sum, id) => sum + uv.getX(id), 0) / 3;
      const v = ids.reduce((sum, id) => sum + uv.getY(id), 0) / 3;
      const rgb = sample(normal, u, v), vector = rgb.map(value => value / 127.5 - 1);
      const length = Math.hypot(...vector); sampled++;
      if (length > .92 && length < 1.08 && vector[2] > 0) valid++;
      if (Math.hypot(vector[0], vector[1]) > .035) detail++;
      const half = Number(v >= .5);
      const albedo = sample(maps['hand-albedo.png'], u, v);
      const matte = sample(maps['hand-roughness.png'], u, v)[1];
      assert.ok(albedo.some(channel => channel > 0) && matte > 0,
        `${entry.key}: the actual skin/glove surface cannot sample an unbaked black texel at UV ${u}, ${v}`);
      colors[half].add(albedo.join(','));
      roughness[half].add(matte);
    }
    surface.dispose();
  }
  assert.ok(valid > sampled * .98, `UVs sampled by actual triangles resolve to valid outward tangent-space normals (${valid}/${sampled})`);
  assert.ok(detail > sampled * .10, 'The atlas transfers actual surface relief rather than a flat normal placeholder');
  for (const [half, label] of ['skin', 'glove'].entries()) {
    assert.ok(colors[half].size > 16, `${label} includes spatial albedo variation`);
    assert.ok(roughness[half].size > 8, `${label} includes spatial roughness variation`);
  }
});
