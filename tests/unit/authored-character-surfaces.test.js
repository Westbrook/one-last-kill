import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { Box3, Mesh, MeshBasicMaterial, Raycaster, Texture, Vector3 } from 'three';
import {
  loadAuthoredCharacterSurfaces, getAuthoredCharacterStatus, getAuthoredCharacterSurfaces,
} from '../../src/render/authored-character-surfaces.js';
import {
  createHumanoidRig, getHumanoidVisualBounds, updateHumanoidPose, resetHumanoidPose,
  humanoidDimensions, attachHeldWeapon,
} from '../../src/render/humanoid-rig.js';
import { HERO_BIND_ARM_ANGLE } from '../../src/render/hero-character-geometry.js';
import { HUMANOID_PRESETS } from '../../src/render/models.js';
import { DIFFICULTY_LEVELS, scaleEncounter } from '../../src/game/difficulty.js';
import { ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from '../../src/game/mission-data.js';
import { enemyCampaignPoolCapacity } from '../../src/game/enemy-navigation.js';
import { beginHumanoidCollapse, updateHumanoidCollapse, COLLAPSE_DURATION } from '../../src/render/corpse-pose.js';

const rootURL = new URL('../../', import.meta.url);
const manifestURL = '/assets/models/characters/manifest.json';
const clone = value => JSON.parse(JSON.stringify(value));
const triangles = geometry => geometry.index.count / 3;
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should be within ${tolerance} of ${expected}`);
// These hashes cover actual attribute/index bytes from the accepted Blender
// rollout. The gunman pilot must not silently remodel the other appearances.
const unchangedCharacterHashes = {
  thug: 'f0eca7d15a4b0d3785c29cbadadcda5d062a69eb778c3fb27d1e051470376dfe',
  brawler: '18acf881cc6ea3dee30c6df798c82f1d2ad73349f23912334880eccbcefe8f1f',
  bruiser: 'd3a17a8487a265d402e3020d1d80cae1d5fb2c23f9e1d8a33ce0fbcc56412df6',
  hitman: '6bcede2b96bfcd8a728cd1245d5ad34628513b290cfdd92a0499efbd580f70e5',
  enforcer: 'dccd2f0e6b4b99b0151b4ab37b909d7d3d389ae5cb839dee4fc24fd883f58994',
  shopkeeper: 'c56ae54648b56bb0aa5de11a1c75ef9a507a3e70c2d58ddd90ff60292893457f',
  woman: 'bb09133b72148be0826e2d7939ba518fd81f27ac76961e7c10f7af6f7e451541',
};

function characterHash(entry, bytes) {
  const hash = createHash('sha256');
  for (const surface of entry.surfaces) {
    for (const [name, descriptor] of [...Object.entries(surface.attributes), ['index', surface.index]]) {
      hash.update(name);
      hash.update(bytes.subarray(descriptor.byteOffset,
        descriptor.byteOffset + descriptor.length * globalThis[descriptor.type].BYTES_PER_ELEMENT));
    }
  }
  return hash.digest('hex');
}

function triangleArea(geometry, triangle, attributeName = 'position') {
  const attribute = geometry.attributes[attributeName], index = geometry.index;
  const a = index.getX(triangle * 3), b = index.getX(triangle * 3 + 1), c = index.getX(triangle * 3 + 2);
  const ux = attribute.getX(b) - attribute.getX(a), uy = attribute.getY(b) - attribute.getY(a);
  const vx = attribute.getX(c) - attribute.getX(a), vy = attribute.getY(c) - attribute.getY(a);
  if (attribute.itemSize === 2) return Math.abs(ux * vy - uy * vx) / 2;
  const uz = attribute.getZ(b) - attribute.getZ(a), vz = attribute.getZ(c) - attribute.getZ(a);
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

// Decode the shipped PNG scanlines so a nonempty file or manifest claim cannot
// stand in for an actual, useful baked texture. Blender exports RGB/RGBA8.
function pngPixels(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks = [];
  let width, height, channels;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.ok([2, 6].includes(data[9]));
      assert.equal(data[12], 0, 'The runtime atlas is not interlaced');
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  assert.equal(width, 512); assert.equal(height, 512);
  const packed = inflateSync(Buffer.concat(chunks)), stride = width * channels;
  assert.equal(packed.length, height * (stride + 1));
  const pixels = new Uint8Array(width * height * channels);
  const paeth = (a, b, c) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const before = x >= channels ? pixels[y * stride + x - channels] : 0;
      const above = y ? pixels[(y - 1) * stride + x] : 0;
      const diagonal = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor = [0, before, above, Math.floor((before + above) / 2), paeth(before, above, diagonal)][filter];
      pixels[y * stride + x] = packed[y * (stride + 1) + x + 1] + predictor;
    }
  }
  return { pixels, channels };
}

function fetchAsset(manifest, bytes, calls = []) {
  return async url => {
    calls.push(String(url));
    return String(url).endsWith('manifest.json')
      ? { ok: true, status: 200, json: async () => clone(manifest) }
      : { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
}

function surfaceMap(root) {
  return Object.fromEntries(root.userData.rig.visualMeshes.map(mesh => [mesh.name.replace('hero-', ''), mesh]));
}

function preparedSurfaces(root, config) {
  const rig = root.userData.rig, left = rig.joints.shoulderL.rotation.z, right = rig.joints.shoulderR.rotation.z;
  // The installer asks while the skeleton is in its authored bind pose.
  rig.joints.shoulderL.rotation.z = -HERO_BIND_ARM_ANGLE;
  rig.joints.shoulderR.rotation.z = HERO_BIND_ARM_ANGLE;
  root.updateMatrixWorld(true);
  const result = getAuthoredCharacterSurfaces(config, humanoidDimensions(config), rig.hero.skeleton.bones);
  rig.joints.shoulderL.rotation.z = left; rig.joints.shoulderR.rotation.z = right; root.updateMatrixWorld(true);
  return result;
}

function posedVertices(root) {
  root.updateMatrixWorld(true);
  const result = [], point = new Vector3();
  for (const mesh of root.userData.rig.visualMeshes) {
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld); result.push(point.x, point.y, point.z);
    }
  }
  return result;
}

function maxDifference(first, second) {
  assert.equal(first.length, second.length);
  let result = 0;
  for (let i = 0; i < first.length; i++) result = Math.max(result, Math.abs(first[i] - second[i]));
  return result;
}

function boneWeights(geometry, vertex) {
  const weights = Array(17).fill(0);
  for (let component = 0; component < 4; component++) {
    weights[geometry.attributes.skinIndex.getComponent(vertex, component)] += geometry.attributes.skinWeight.getComponent(vertex, component);
  }
  return weights;
}

function correspondingSourceVertices(geometry, seed) {
  assert.equal(geometry.index.count, seed.index.count, 'The body preserves its original triangles when UV seams split vertices');
  const result = new Int32Array(geometry.attributes.position.count).fill(-1);
  for (let corner = 0; corner < geometry.index.count; corner++) {
    const vertex = geometry.index.getX(corner), originalVertex = seed.index.getX(corner);
    assert.ok(result[vertex] === -1 || result[vertex] === originalVertex,
      'Every UV-seam duplicate corresponds consistently to one original bound vertex');
    result[vertex] = originalVertex;
  }
  assert.ok(result.every(vertex => vertex >= 0), 'The exported body contains no unreferenced vertices');
  return result;
}

function poolSize(type) {
  const encounters = Object.entries(ZONE_WAVE_CONFIG).filter(([zone]) => zone !== 'bakery').map(([, value]) => value);
  const finales = Object.values(FINAL_ENCOUNTERS);
  return Math.max(...DIFFICULTY_LEVELS.map(profile => enemyCampaignPoolCapacity(type,
    encounters.map(value => scaleEncounter(value, profile)), finales.map(value => scaleEncounter(value, profile)))),
  (type === 'enforcer' ? 1 : 6) + 2);
}

test('shipped Blender character surfaces retain the production rig, immutable buffers, and rendering budget', async t => {
  const manifest = JSON.parse(await readFile(new URL('public/assets/models/characters/manifest.json', rootURL), 'utf8'));
  const bytes = await readFile(new URL(`public/assets/models/characters/${manifest.binary}`, rootURL));
  const textureLoader = { loadAsync: async () => new Texture({ width: 512, height: 512 }) };
  const loadCharacters = options => loadAuthoredCharacterSurfaces({ textureLoader, ...options });
  // Construct the original assets before successful preload. This independently
  // checks the production seed instead of trusting metrics written by the exporter.
  const original = new Map(manifest.catalog.map(entry => [entry.id, createHumanoidRig(entry.config)]));

  await t.test('the delivery covers every production appearance and identifies its actual bytes and editable source', async () => {
    const enemySource = await readFile(new URL('src/game/enemies.js', rootURL), 'utf8');
    const definitions = enemySource.match(/const ENEMY_TYPES = (\{[\s\S]*?\n\});/)[1];
    const enemies = new Function('MAX_ARMOR', `return (${definitions});`)(100);
    const configs = [...Object.entries(enemies).map(([role, value]) => ({ ...value.visual, role })),
      ...['shopkeeper', 'woman'].map(role => ({ ...HUMANOID_PRESETS[role], role }))];
    assert.equal(manifest.version, 1);
    assert.equal(manifest.binary, 'characters.bin');
    assert.equal(manifest.catalog.length, 8);
    assert.deepEqual(manifest.catalog.map(entry => entry.config), configs, 'No production palette, role, or body scale is omitted');
    assert.equal(manifest.byteLength, bytes.length);
    assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(bytes.length <= 8 * 1024 * 1024, 'The character geometry package stays within 8 MiB');
    for (const path of [manifest.source, manifest.builder]) {
      assert.equal(typeof path, 'string', 'The manifest points to an editable Blender file and its rebuild command');
      const info = await stat(new URL(path, rootURL));
      assert.ok(info.isFile() && info.size > 0);
    }
    for (const entry of manifest.catalog) {
      assert.deepEqual(entry.surfaces.map(surface => surface.name), ['garments', 'skin', 'head', 'face-hair']);
      const bones = original.get(entry.id).userData.rig.hero.skeleton.bones;
      assert.equal(entry.bones.length, 17);
      assert.deepEqual(entry.bones.map(bone => bone.name), bones.map(bone => bone.name));
      assert.equal(new Set(entry.bones.map(bone => bone.name)).size, 17);
      if (entry.id !== 'gunman') {
        assert.equal(characterHash(entry, bytes), unchangedCharacterHashes[entry.id],
          `${entry.id}: all runtime surface bytes remain identical to the accepted Blender rollout`);
      }
    }
  });

  await t.test('offline, malformed, and timed-out loads preserve fallback without a late cache commit', async () => {
    const entry = manifest.catalog[0], rig = original.get(entry.id).userData.rig;
    assert.equal(getAuthoredCharacterSurfaces(entry.config, rig.dimensions, rig.hero.skeleton.bones), null);
    const offline = await loadCharacters({ fetchImpl: async () => { throw new Error('offline fixture'); } });
    assert.equal(offline.state, 'fallback');
    const mutations = [
      value => { value.version++; },
      value => { value.catalog[0].bones[0].name = 'joint:wrong'; },
      value => { value.catalog[0].surfaces[0].attributes.position.byteOffset = bytes.length + 4; },
      value => { value.catalog[0].surfaces[0].attributes.skinWeight.itemSize = 3; },
      value => { value.catalog.pop(); },
    ];
    for (const mutate of mutations) {
      const invalid = clone(manifest); mutate(invalid);
      const result = await loadCharacters({ fetchImpl: fetchAsset(invalid, bytes) });
      assert.equal(result.state, 'fallback', 'An incompatible package never replaces the working procedural characters');
      assert.equal(getAuthoredCharacterSurfaces(entry.config, rig.dimensions, rig.hero.skeleton.bones), null);
    }
    for (const invalidWeight of [NaN, 1.5]) {
      const invalid = clone(manifest), damaged = new Uint8Array(bytes);
      const descriptor = invalid.catalog[0].surfaces[0].attributes.skinWeight;
      new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength).setFloat32(descriptor.byteOffset, invalidWeight, true);
      invalid.sha256 = createHash('sha256').update(damaged).digest('hex');
      const result = await loadCharacters({ fetchImpl: fetchAsset(invalid, damaged) });
      assert.equal(result.state, 'fallback', 'Even a checksum-valid package rejects nonfinite or invalid GPU skin weights');
    }
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const timedOut = await loadCharacters({ timeoutMs: 5,
      fetchImpl: async url => { await gate; return fetchAsset(manifest, bytes)(url); } });
    assert.equal(timedOut.state, 'fallback');
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(getAuthoredCharacterStatus().state, 'fallback', 'A response arriving after timeout cannot silently change geometry');
  });

  await t.test('retry and simultaneous startup callers load one package and preserve a ready cache', async () => {
    const calls = [], fetchImpl = fetchAsset(manifest, bytes, calls);
    const results = await Promise.all([loadCharacters({ fetchImpl }), loadCharacters({ fetchImpl })]);
    for (const result of results) assert.equal(result.state, 'ready', result.error);
    assert.equal(calls.length, 2, 'One manifest and one binary fetch serve concurrent callers');
    assert.equal(calls.filter(url => url === manifestURL).length, 1);
    await loadCharacters({ fetchImpl });
    assert.equal(calls.length, 2, 'Ready character buffers are reused');
    assert.equal(getAuthoredCharacterStatus().state, 'ready');
  });

  assert.equal(getAuthoredCharacterStatus().state, 'ready', 'Loaded geometry is required for the remaining integration checks');
  const loaded = new Map(manifest.catalog.map(entry => [entry.id, createHumanoidRig(entry.config)]));

  await t.test('actual runtime meshes retain the four-draw rig and preserve all seven nonpilot appearances', () => {
    let reshapedGarments = 0, reshapedHeads = 0;
    for (const entry of manifest.catalog) {
      const root = loaded.get(entry.id), rig = root.userData.rig, before = surfaceMap(original.get(entry.id));
      const pilot = entry.id === 'gunman';
      const selected = preparedSurfaces(root, entry.config);
      assert.ok(selected, `${entry.id} selects its prepared Blender geometry`);
      assert.equal(rig.hero.source, pilot ? 'original-blender-sculpted-baked' : 'original-blender-prepared');
      const expected = { garments: selected.body.garments, skin: selected.body.skin, head: selected.head.head, 'face-hair': selected.head.details };
      assert.equal(rig.visualMeshes.length, 4);
      assert.equal(rig.visualMeshes.filter(mesh => mesh.isSkinnedMesh).length, 2);
      let actualTriangles = 0;
      for (const [name, mesh] of Object.entries(surfaceMap(root))) {
        const geometry = mesh.geometry, seed = before[name].geometry;
        assert.equal(geometry, expected[name], 'The production installer uses the preloaded surface, not the fallback builder');
        assert.notEqual(geometry, seed);
        if (!pilot) {
          for (const [key, value] of Object.entries(seed.userData)) assert.deepEqual(geometry.userData[key], value,
            `${entry.id}/${name}: ${key} geometry metadata survives asset preparation`);
          const seedIndex = seed.index ? Array.from(seed.index.array) : Array.from({ length: seed.attributes.position.count }, (_, index) => index);
          assert.deepEqual(Array.from(geometry.index.array), seedIndex, 'Blender processing preserves the original triangle connectivity and ordering');
        }
        assert.deepEqual(Object.keys(geometry.attributes).sort(), Object.keys(seed.attributes).sort());
        for (const [attributeName, attribute] of Object.entries(geometry.attributes)) {
          assert.equal(attribute.itemSize, seed.attributes[attributeName].itemSize);
          assert.equal(attribute.normalized, seed.attributes[attributeName].normalized);
          assert.ok(attribute.array.every(Number.isFinite), `${entry.id}/${name}/${attributeName} contains only finite data`);
          if (!pilot && !['position', 'normal'].includes(attributeName)) {
            assert.deepEqual(attribute.array, seed.attributes[attributeName].array,
              `${entry.id}/${name}: ${attributeName} survives Blender and runtime loading byte for byte`);
          }
        }
        for (let i = 0; i < geometry.attributes.normal.count; i++) {
          const normal = geometry.attributes.normal;
          near(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)), 1, 1e-4);
        }
        assert.ok(geometry.index.array.every(index => index >= 0 && index < geometry.attributes.position.count));
        actualTriangles += triangles(geometry);
        if (!pilot) {
          const displacement = maxDifference(geometry.attributes.position.array, seed.attributes.position.array);
          if (name === 'garments' && displacement > 1e-5) reshapedGarments++;
          if (name === 'head' && displacement > 1e-5) reshapedHeads++;
          if (name === 'face-hair') assert.equal(displacement, 0, 'Separate eyelid, lip, and hair detail geometry retains its fitted landmarks');
        }
        if (mesh.isSkinnedMesh) {
          const { skinWeight, skinIndex } = geometry.attributes;
          for (let i = 0; i < skinWeight.count; i++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
              const weight = skinWeight.getComponent(i, k), bone = skinIndex.getComponent(i, k);
              assert.ok(weight >= 0 && weight <= 1);
              assert.ok(Number.isInteger(bone) && bone >= 0 && bone < 17); sum += weight;
            }
            near(sum, 1);
          }
        }
      }
      assert.ok(actualTriangles <= 15000, `${entry.id}: actual indexed geometry respects the 15,000-triangle ceiling`);
      assert.equal(rig.hero.triangles, actualTriangles);
      assert.equal(rig.hero.draws, 4);
      if (!pilot) {
        assert.equal(actualTriangles, original.get(entry.id).userData.rig.hero.triangles);
        assert.equal(rig.hero.continuousSurfaceTriangles, original.get(entry.id).userData.rig.hero.continuousSurfaceTriangles);
      }
      const bounds = getHumanoidVisualBounds(root);
      near(bounds.min.y, 0); near(bounds.max.y, entry.config.height);
    }
    assert.equal(reshapedGarments, 7, 'The seven established appearances retain their garment refinements');
    assert.equal(reshapedHeads, 7, 'The seven established appearances retain their skull refinements');
  });

  await t.test('the remodeled gunman spends geometry on its head while keeping valid bound skin and useful atlas charts', () => {
    const entry = manifest.catalog.find(value => value.id === 'gunman');
    const meshes = surfaceMap(loaded.get('gunman')), before = surfaceMap(original.get('gunman'));
    assert.ok(triangles(meshes.head.geometry) > triangles(before.head.geometry),
      'The pilot carries real additional facial topology, not only a material or provenance change');
    assert.ok(meshes.head.geometry.attributes.position.count > before.head.geometry.attributes.position.count);
    for (const [name, mesh] of Object.entries(meshes)) {
      const geometry = mesh.geometry;
      for (let triangle = 0; triangle < triangles(geometry); triangle++) {
        assert.ok(triangleArea(geometry, triangle) > 1e-12, `${name}/${triangle}: exported triangles have positive area`);
      }
    }
    for (const name of ['garments', 'head']) {
      const geometry = meshes[name].geometry, uv = geometry.attributes.uv;
      assert.ok(uv.array.every(value => value >= 0 && value <= 1), `${name}: baked UVs remain inside the shared atlas`);
      let area = 0;
      for (let triangle = 0; triangle < triangles(geometry); triangle++) {
        const value = triangleArea(geometry, triangle, 'uv');
        assert.ok(value > 1e-12, `${name}/${triangle}: no atlas triangle collapses to a line`);
        area += value;
      }
      assert.ok(area > 0.05 && area <= 1.00001, `${name}: chart area is useful and fits within a single atlas (${area})`);
      assert.notDeepEqual(uv.array, before[name].geometry.attributes.uv.array,
        `${name}: the baked surface uses a newly unwrapped atlas`);
    }

    const rig = loaded.get('gunman').userData.rig, originalRig = original.get('gunman').userData.rig;
    assert.deepEqual(rig.dimensions, originalRig.dimensions, 'Authored appearance does not alter gameplay body dimensions');
    assert.deepEqual(rig.hero.skeleton.boneInverses.map(matrix => matrix.elements),
      originalRig.hero.skeleton.boneInverses.map(matrix => matrix.elements), 'All 17 bind inverses remain exact');
    near(getHumanoidVisualBounds(loaded.get('gunman')).max.y, entry.config.height);
  });

  await t.test('the gunman shoulder yoke stays fitted through carry and walking while removing the guard ridge', () => {
    const entry = manifest.catalog.find(value => value.id === 'gunman'), d = entry.dimensions;
    const meshes = surfaceMap(loaded.get('gunman')), before = surfaceMap(original.get('gunman'));
    const boneNames = entry.bones.map(bone => bone.name), chest = boneNames.indexOf('joint:chest');
    const shoulderBones = ['L', 'R'].map(side => boneNames.indexOf(`joint:shoulder${side}`));
    const wristBones = ['L', 'R'].map(side => boneNames.indexOf(`joint:wrist${side}`));
    const changedBySide = [new Set(), new Set()], mappings = {}, capVertices = [];
    const point = new Vector3(), oldPoint = new Vector3();
    for (const name of ['garments', 'skin']) {
      const geometry = meshes[name].geometry, seed = before[name].geometry;
      const mapping = correspondingSourceVertices(geometry, seed); mappings[name] = mapping;
      const bodyVertices = new Set(Array.from(seed.index.array).slice(0, entry.body.surfaceTriangles * 3));
      const seamCopies = new Map();
      for (let vertex = 0; vertex < mapping.length; vertex++) {
        const source = mapping[vertex], weights = boneWeights(geometry, vertex), oldWeights = boneWeights(seed, source);
        point.fromBufferAttribute(geometry.attributes.position, vertex);
        oldPoint.fromBufferAttribute(seed.attributes.position, source);
        assert.ok(point.distanceTo(oldPoint) < 0.04, `${name}/${vertex}: the same anatomical surface retains its bound source vertex`);
        if (seamCopies.has(source)) {
          assert.deepEqual({ position: point.toArray(), weights }, seamCopies.get(source),
            'UV seams share exactly the same position and deformation, preventing cracks in every pose');
        } else seamCopies.set(source, { position: point.toArray(), weights });
        if (name === 'skin' && wristBones.some(bone => oldWeights[bone] > 0)) {
          assert.deepEqual(point.toArray(), oldPoint.toArray(), 'Every bound hand/wrist contact vertex remains exactly in place');
        }
        for (const attributeName of ['color', 'heroSurface']) {
          const attribute = geometry.attributes[attributeName], originalAttribute = seed.attributes[attributeName];
          for (let component = 0; component < attribute.itemSize; component++) {
            assert.equal(attribute.getComponent(vertex, component), originalAttribute.getComponent(source, component),
              `${name}/${vertex}: UV seam duplication preserves ${attributeName}`);
          }
        }
        const side = oldPoint.x < 0 ? 0 : 1, sign = side === 0 ? -1 : 1, shoulder = shoulderBones[side];
        const along = ((oldPoint.x - sign * d.shoulderSpacing) * sign * Math.sin(HERO_BIND_ARM_ANGLE)
          - (oldPoint.y - d.shoulderY) * Math.cos(HERO_BIND_ARM_ANGLE)) / (d.upperArmLength + d.forearmLength);
        const allowed = name === 'garments' && bodyVertices.has(source) && oldPoint.y > 0.70 * d.height
          && along < 0.24 && oldWeights[shoulder] > 0;
        if (allowed && oldPoint.y > 0.78 * d.height && along < 0.16) capVertices.push({ vertex, sign, side });
        if (!allowed) {
          assert.deepEqual(weights, oldWeights, `${name}/${vertex}: all bindings outside the proximal shoulder cloth remain exact`);
          continue;
        }
        const transfer = oldWeights[shoulder] - weights[shoulder];
        assert.ok(transfer >= -1e-7 && transfer <= 0.8 + 1e-6, 'Only a bounded part of shoulder influence can move to the chest');
        near(weights[chest] - oldWeights[chest], transfer);
        for (let bone = 0; bone < weights.length; bone++) if (bone !== shoulder && bone !== chest) {
          near(weights[bone], oldWeights[bone], 1e-7);
        }
        if (transfer > 1e-5) changedBySide[side].add(source);
      }
    }
    assert.ok(changedBySide.every(vertices => vertices.size >= 20), 'Both shoulders contain an actual graded yoke transition');

    const geometry = meshes.garments.geometry, seed = before.garments.geometry, mapping = mappings.garments;
    let detailStart = entry.body.surfaceTriangles;
    for (const part of entry.body.garmentDetails.parts) {
      if (part.name === 'neck-fold' || part.name.startsWith('sleeve-hem.')) {
        for (let corner = detailStart * 3; corner < (detailStart + part.triangles) * 3; corner++) {
          const vertex = geometry.index.getX(corner);
          point.fromBufferAttribute(geometry.attributes.position, vertex);
          oldPoint.fromBufferAttribute(seed.attributes.position, mapping[vertex]);
          assert.deepEqual(point.toArray(), oldPoint.toArray(), `${part.name}: the fitted garment contact rim remains exact`);
        }
      }
      detailStart += part.triangles;
    }
    for (let corner = 0; corner < entry.body.surfaceTriangles * 3; corner += 3) {
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const first = geometry.index.getX(corner + a), second = geometry.index.getX(corner + b);
        const firstSource = mapping[first], secondSource = mapping[second];
        const firstWeights = boneWeights(seed, firstSource), secondWeights = boneWeights(seed, secondSource);
        for (const shoulder of shoulderBones) if (firstWeights[shoulder] > 0.999 && secondWeights[shoulder] > 0.999) {
          point.fromBufferAttribute(seed.attributes.position, firstSource);
          oldPoint.fromBufferAttribute(seed.attributes.position, secondSource);
          const change = Math.abs(boneWeights(geometry, first)[shoulder] - boneWeights(geometry, second)[shoulder]);
          assert.ok(change <= 20 * point.distanceTo(oldPoint) + 1e-5,
            'The yoke-to-sleeve transition cannot introduce an abrupt weight step along a cloth edge');
        }
      }
    }

    const actor = createHumanoidRig(entry.config), mesh = surfaceMap(actor).garments;
    attachHeldWeapon(actor, 'pistol'); actor.updateMatrixWorld(true);
    // Restore only original weights in an isolated geometry clone. Both copies
    // use the same remodeled positions and live production skeleton, isolating
    // the deformation improvement from any silhouette or camera change.
    const originalBinding = mesh.clone(); originalBinding.geometry = mesh.geometry.clone();
    for (let vertex = 0; vertex < mapping.length; vertex++) for (const name of ['skinIndex', 'skinWeight']) {
      for (let component = 0; component < 4; component++) {
        originalBinding.geometry.attributes[name].setComponent(vertex, component,
          seed.attributes[name].getComponent(mapping[vertex], component));
      }
    }
    const peak = specimen => {
      let maximum = -Infinity;
      for (let vertex = 0; vertex < mapping.length; vertex++) {
        if (seed.attributes.position.getY(mapping[vertex]) <= 0.70 * d.height) continue;
        specimen.getVertexPosition(vertex, point);
        if (Math.abs(point.x) > 0.074 * d.height && Math.abs(point.x) < 0.171 * d.height) maximum = Math.max(maximum, point.y);
      }
      assert.ok(Number.isFinite(maximum)); return maximum;
    };
    near(peak(mesh), peak(originalBinding), 0.01);
    for (let frame = 0; frame < 30; frame++) updateHumanoidPose(actor,
      { mode: 'ranged', speed: 0, alert: 1, aim: 1, swingProgress: -1, swingSide: 'R' }, 1 / 60);
    actor.updateMatrixWorld(true);
    const removedRidge = peak(originalBinding) - peak(mesh);
    assert.ok(removedRidge >= 0.02, `Actual pistol guard removes at least 20 mm of the weight-induced shoulder ridge (${removedRidge} m)`);
    assert.ok(capVertices.length > 100, 'The carry envelope measures the entire continuous shoulder cap, including its rear and outer edge');
    const angles = [-60, -30, 0, 30, 60].map(degrees => ({ cosine: Math.cos(degrees * Math.PI / 180), sine: Math.sin(degrees * Math.PI / 180) }));
    const modes = {
      neutral: null,
      walk: { mode: 'walk', speed: 2.4, forward: 1, alert: 0, aim: 0, swingProgress: -1 },
      carry: { mode: 'ranged', speed: 2.4, forward: 1, alert: 0, aim: 0, swingProgress: -1 },
      guard: { mode: 'ranged', speed: 0, forward: 1, alert: 1, aim: 1, swingProgress: -1 },
    };
    // The first three seconds use the exact QA motion-review carry input. A
    // frame sweep includes the formerly bad 0.27 s pose and the later gait
    // extremes, while oblique extents catch a wing that faces away from +Z.
    for (const [mode, state] of Object.entries(modes)) {
      resetHumanoidPose(actor);
      let widest = { difference: -Infinity, frame: 0, angle: 0, side: 0 };
      for (let frame = 0; frame <= (state ? 180 : 0); frame++) {
        if (frame) updateHumanoidPose(actor, state, 1 / 60);
        actor.updateMatrixWorld(true);
        if ([0, 16, 30, 90, 180].includes(frame)) {
          const conservative = new Box3();
          for (const proxy of actor.userData.rig.visualBoundsProxies) {
            conservative.union(proxy.geometry.boundingBox.clone().applyMatrix4(proxy.matrixWorld));
          }
          assert.ok(conservative.expandByScalar(1e-6).containsBox(getHumanoidVisualBounds(actor)),
            `${mode}/${frame}: unchanged bone bounds contain the entire visible body`);
        }
        const extents = angles.map(() => [0, 1].map(() => ({ actual: -Infinity, reference: -Infinity })));
        for (const { vertex, sign, side } of capVertices) {
          mesh.getVertexPosition(vertex, point);
          originalBinding.getVertexPosition(vertex, oldPoint);
          for (const [angle, { cosine, sine }] of angles.entries()) {
            const extent = extents[angle][side];
            extent.actual = Math.max(extent.actual, sign * (point.x * cosine + point.z * sine));
            extent.reference = Math.max(extent.reference, sign * (oldPoint.x * cosine + oldPoint.z * sine));
          }
        }
        for (let angle = 0; angle < angles.length; angle++) for (let side = 0; side < 2; side++) {
          const difference = extents[angle][side].actual - extents[angle][side].reference;
          if (difference > widest.difference) widest = { difference, frame, angle, side };
        }
      }
      assert.ok(widest.difference <= 0.008,
        `${mode}: cap expansion stays within 8 mm through all poses and five views (${JSON.stringify(widest)})`);
    }
    originalBinding.geometry.dispose();
  });

  await t.test('the shipped gunman atlases contain four real 512-square normal and roughness bakes', async () => {
    const finish = manifest.catalog.find(value => value.id === 'gunman').finish;
    const meshes = surfaceMap(loaded.get('gunman'));
    assert.equal(finish?.version, 1);
    const paths = [];
    for (const surface of ['garments', 'head']) for (const kind of ['normal', 'roughness']) {
      const path = finish[surface][kind];
      assert.equal(path, `gunman-${surface}-${kind}.png`); paths.push(path);
      const { pixels, channels } = pngPixels(await readFile(new URL(`public/assets/models/characters/${path}`, rootURL)));
      const minima = [255, 255, 255], maxima = [0, 0, 0], sums = [0, 0, 0];
      const geometry = meshes[surface].geometry, uv = geometry.attributes.uv, sampleCount = triangles(geometry);
      let validNormals = 0;
      for (let triangle = 0; triangle < sampleCount; triangle++) {
        let u = 0, v = 0;
        for (let corner = 0; corner < 3; corner++) {
          const vertex = geometry.index.getX(triangle * 3 + corner);
          u += uv.getX(vertex) / 3; v += uv.getY(vertex) / 3;
        }
        // PNG rows run downwards; UV rows and the runtime's flipY run upwards.
        const x = Math.min(511, Math.floor(u * 512)), y = 511 - Math.min(511, Math.floor(v * 512));
        const index = (y * 512 + x) * channels;
        for (let channel = 0; channel < 3; channel++) {
          minima[channel] = Math.min(minima[channel], pixels[index + channel]);
          maxima[channel] = Math.max(maxima[channel], pixels[index + channel]);
          sums[channel] += pixels[index + channel];
        }
        const length = Math.hypot(...[0, 1, 2].map(channel => pixels[index + channel] / 255 * 2 - 1));
        if (Math.abs(length - 1) <= 0.025) validNormals++;
      }
      if (kind === 'normal') {
        assert.ok(maxima[0] - minima[0] >= 8 && maxima[1] - minima[1] >= 8,
          `${surface}: baked tangent normals carry changes on both surface axes`);
        assert.ok(sums[2] / sampleCount > 200, `${surface}: the normal map points predominantly out of the surface`);
        assert.ok(validNormals / sampleCount >= 0.98,
          `${surface}: at least 98% of triangle-interior samples decode to unit tangent normals (${validNormals}/${sampleCount})`);
      } else {
        assert.ok(maxima[0] - minima[0] >= 8, `${surface}: roughness contains actual material variation`);
      }
    }
    assert.equal(new Set(paths).size, 4, 'Both surfaces retain their own normal and roughness maps');
    assert.equal(getAuthoredCharacterStatus().textures, 4);
  });

  await t.test('remodeled brows remain dark and visible above the actual skull triangle interiors', () => {
    const meshes = surfaceMap(loaded.get('gunman'));
    const head = meshes.head.geometry, details = meshes['face-hair'].geometry;
    const material = new MeshBasicMaterial(), surface = new Mesh(head, material);
    surface.updateMatrixWorld(true);
    const ray = new Raycaster(), direction = new Vector3(0, 0, -1), center = new Vector3();
    let visible = 0, total = 0;
    try {
      for (const eye of details.userData.surfaces.eyes) {
        assert.ok(eye.brow?.triangleCount >= 20, 'Each remodeled eyebrow has a continuous tapered surface');
        for (let triangle = eye.brow.triangleStart; triangle < eye.brow.triangleStart + eye.brow.triangleCount; triangle++) {
          center.set(0, 0, 0); let luminance = 0;
          for (let corner = 0; corner < 3; corner++) {
            const vertex = details.index.getX(triangle * 3 + corner);
            center.add(new Vector3().fromBufferAttribute(details.attributes.position, vertex));
            luminance += details.attributes.color.getX(vertex) * 0.2126 + details.attributes.color.getY(vertex) * 0.7152
              + details.attributes.color.getZ(vertex) * 0.0722;
          }
          center.multiplyScalar(1 / 3); luminance /= 3;
          assert.ok(luminance < 0.10, 'The eyebrows retain muted dark-brown density');
          ray.set(new Vector3(center.x, center.y, 2), direction);
          const intersection = ray.intersectObject(surface, false)[0];
          assert.ok(intersection, 'Every brow sample lies over the actual forehead');
          if (center.z > intersection.point.z + 0.001) visible++;
          total++;
        }
      }
      assert.equal(visible, total, 'Convex forehead triangles cannot bury eyebrow interiors');
    } finally { material.dispose(); }
  });

  await t.test('unlisted custom dimensions, palettes, and skeletons keep the procedural fallback', () => {
    const entry = manifest.catalog[0], rig = loaded.get(entry.id).userData.rig;
    for (const config of [{ ...entry.config, height: entry.config.height + 0.1 },
      { ...entry.config, shirt: '#ffffff' }, { ...entry.config, role: 'custom' }]) {
      assert.equal(preparedSurfaces(loaded.get(entry.id), config), null);
    }
    assert.equal(getAuthoredCharacterSurfaces(entry.config, rig.dimensions, rig.hero.skeleton.bones.slice(1)), null);
    const custom = createHumanoidRig({ ...entry.config, role: 'custom' });
    assert.equal(custom.userData.rig.visualMeshes.length, 4);
    assert.notEqual(custom.userData.rig.visualMeshes[0].geometry, rig.visualMeshes[0].geometry);
  });

  await t.test('all 114 enemy pool slots share buffers while keeping skeletons and sorting bounds independent', () => {
    const geometries = new Set(), skeletons = new Set(), pool = [];
    for (const entry of manifest.catalog.filter(value => !['shopkeeper', 'woman'].includes(value.id))) {
      const example = loaded.get(entry.id).userData.rig;
      for (let index = 0; index < poolSize(entry.id); index++) {
        const root = createHumanoidRig({ ...entry.config, seed: 100 + index * 73 });
        const rig = root.userData.rig; pool.push(root); skeletons.add(rig.hero.skeleton);
        for (let part = 0; part < rig.visualMeshes.length; part++) {
          const mesh = rig.visualMeshes[part]; geometries.add(mesh.geometry);
          assert.equal(mesh.geometry, example.visualMeshes[part].geometry);
          assert.equal(mesh.material, example.visualMeshes[part].material);
          if (mesh.isSkinnedMesh) {
            assert.notEqual(mesh.boundingSphere, example.visualMeshes[part].boundingSphere);
            assert.notEqual(mesh.boundingSphere, mesh.geometry.boundingSphere);
          }
        }
      }
    }
    assert.equal(pool.length, 114);
    assert.equal(skeletons.size, 114);
    assert.equal(geometries.size, 24, 'Four shared surfaces per enemy appearance, without per-actor geometry copies');
    for (const entry of manifest.catalog) for (const mesh of loaded.get(entry.id).userData.rig.visualMeshes) geometries.add(mesh.geometry);
    assert.equal(geometries.size, 32, 'The two civilian appearances add exactly eight shared surfaces');
  });

  await t.test('loaded character motion changes only joints and cached bounds still enclose the visible skin', () => {
    for (const entry of manifest.catalog) {
      const root = loaded.get(entry.id), rig = root.userData.rig;
      const other = createHumanoidRig(entry.config), unchanged = posedVertices(other), rest = posedVertices(root);
      const snapshots = rig.visualMeshes.map(mesh => Object.fromEntries(Object.entries(mesh.geometry.attributes)
        .map(([name, attribute]) => [name, { array: attribute.array.slice(), version: attribute.version }])));
      const readers = rig.visualMeshes.map(mesh => mesh.getVertexPosition);
      for (const mesh of rig.visualMeshes) mesh.getVertexPosition = () => { throw new Error('Animation scanned a render vertex'); };
      try {
        for (let i = 0; i < 30; i++) updateHumanoidPose(root, { mode: 'walk', speed: 3.2, forward: 0.65, strafe: -0.7 }, 1 / 60);
      } finally {
        rig.visualMeshes.forEach((mesh, index) => { mesh.getVertexPosition = readers[index]; });
      }
      assert.ok(maxDifference(rest, posedVertices(root)) > 0.05, 'The loaded surface follows its existing animated joints');
      assert.equal(maxDifference(unchanged, posedVertices(other)), 0, 'Other pool slots remain in their own pose');
      root.position.set(3.1, 4.02, -2.8); root.rotation.set(0.11, 0.74, -0.06, 'YXZ');
      const actual = getHumanoidVisualBounds(root), conservative = new Box3();
      for (const proxy of rig.visualBoundsProxies) conservative.union(proxy.geometry.boundingBox.clone().applyMatrix4(proxy.matrixWorld));
      assert.ok(conservative.expandByScalar(1e-6).containsBox(actual), `${entry.id}: the existing bounds contain Blender-refined vertices`);
      root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); resetHumanoidPose(root);
      assert.ok(maxDifference(rest, posedVertices(root)) < 1e-6, 'Recycled actors recover the authored neutral surface');
      for (const [part, mesh] of rig.visualMeshes.entries()) for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
        assert.equal(attribute.version, snapshots[part][name].version, 'Motion never requests a vertex buffer upload');
        assert.deepEqual(attribute.array, snapshots[part][name].array);
      }
      const hit = root.userData.hitZones, point = new Vector3();
      for (const yaw of [-0.35, 0, 0.35]) for (const pitch of [-0.18, 0, 0.18]) {
        rig.joints.head.rotation.set(pitch, yaw, 0); root.updateMatrixWorld(true);
        const center = hit.headAnchor.getWorldPosition(new Vector3());
        for (const mesh of rig.visualMeshes.filter(value => !value.isSkinnedMesh)) {
          for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
            mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld).sub(center);
            assert.ok(Math.abs(point.x) <= hit.headHalfWidth + 1e-6, `${entry.id}: the turned head stays inside its combat width`);
            assert.ok(Math.abs(point.y) <= hit.headHalfHeight + 1e-6, `${entry.id}: the turned head stays inside its combat height`);
            assert.ok(Math.abs(point.z) <= hit.headHalfDepth + 1e-6, `${entry.id}: the turned face stays inside its combat depth`);
          }
        }
      }
      resetHumanoidPose(root);
    }
  });

  await t.test('Blender contours retain grounded collapse contacts without scanning settled corpse vertices', () => {
    for (const entry of manifest.catalog) {
      const root = loaded.get(entry.id), rig = root.userData.rig, floor = 4.02;
      root.position.set(0, floor, 0); root.rotation.y = Math.PI / 2;
      const totalVertices = rig.visualMeshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
      assert.ok(rig.hero.contactSamples < totalVertices / 3, 'A falling actor uses its bounded support cloud');
      assert.equal(beginHumanoidCollapse(root, Math.PI / 2, floor, 'x', 0.08), true);
      for (const progress of [0, 0.125, 0.25, 0.5, 0.75, 1]) {
        assert.equal(updateHumanoidCollapse(root, COLLAPSE_DURATION * progress), true);
        const bounds = getHumanoidVisualBounds(root);
        assert.ok(bounds.min.y >= floor - 1e-6, `${entry.id}: refined skin cannot penetrate the collapse floor`);
        assert.ok(bounds.min.y <= floor + 0.008, `${entry.id}: refined skin cannot float above the collapse floor`);
      }
      const readers = rig.visualMeshes.map(mesh => mesh.getVertexPosition), settledY = root.position.y;
      for (const mesh of rig.visualMeshes) mesh.getVertexPosition = () => { throw new Error('Settled corpse scanned render vertices'); };
      try { updateHumanoidCollapse(root, 20, 0.225); } finally {
        rig.visualMeshes.forEach((mesh, index) => { mesh.getVertexPosition = readers[index]; });
      }
      near(root.position.y, settledY - 0.225);
    }
  });
});
