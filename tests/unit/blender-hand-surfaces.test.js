import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import * as THREE from 'three';
import { AUTHORED_HAND_RADII, loadAuthoredHandSurfaces, getBlenderHandGeometry, getBlenderArmGeometry } from '../../src/render/authored-hand-surfaces.js';
import { getAuthoredHandGeometry, getProceduralHandGeometry, getHandArmGeometry, getProceduralArmGeometry, createAuthoredGripHand } from '../../src/render/hand-geometry.js';
import { createFirstPersonHands, poseFirstPersonHands } from '../../src/render/first-person-hands.js';
import { createFirstPersonBat, poseFirstPersonBat } from '../../src/render/first-person-bat.js';
import { HAND_ATLAS } from '../../src/render/hand-materials.js';

const bytes = await readFile(new URL('../../public/assets/models/hands/hands.bin', import.meta.url));
const fetcher = async () => new globalThis.Response(bytes);
const finishLoader = { loadAsync: async () => new THREE.Texture({ width: 512, height: 512 }) };

test('the compact Blender hand pack loads once, retries failures, and preserves procedural fallback', async () => {
  assert.equal(getBlenderHandGeometry(), null);
  const fallback = getAuthoredHandGeometry(1, .031);
  assert.equal(fallback, getProceduralHandGeometry(1, .031));
  const failed = await loadAuthoredHandSurfaces({ fetcher: async () => new globalThis.Response('', { status: 503 }) });
  assert.equal(failed.state, 'fallback'); assert.equal(getBlenderArmGeometry(), null);
  const invalid = await loadAuthoredHandSurfaces({ fetcher: async () => new globalThis.Response(new Uint8Array(32)) });
  assert.equal(invalid.state, 'fallback');
  const corrupt = Buffer.from(bytes), payload = 8 + corrupt.readUInt32LE(4);
  const header = JSON.parse(corrupt.subarray(8, payload).toString().trim());
  const fist = header.meshes.find(mesh => mesh.key === 'fist');
  const normal = header.buffers[fist.attributes.normal], morph = header.buffers[fist.morph.normal];
  for (let axis = 0; axis < 3; axis++) {
    const base = corrupt.readInt16LE(payload + normal.offset + axis * 2) * normal.scale;
    corrupt.writeInt16LE(Math.round(-base / morph.scale), payload + morph.offset + axis * 2);
  }
  const collapsed = await loadAuthoredHandSurfaces({ fetcher: async () => new globalThis.Response(corrupt) });
  assert.equal(collapsed.state, 'fallback'); assert.match(collapsed.reason, /clench normals/);
  const escapedUV = Buffer.from(bytes), uvOffset = payload + header.buffers[fist.attributes.uv].offset;
  escapedUV.writeFloatLE(0, uvOffset);
  const escaped = await loadAuthoredHandSurfaces({ fetcher: async () => new globalThis.Response(escapedUV) });
  assert.equal(escaped.state, 'fallback'); assert.match(escaped.reason, /padded material islands/);
  const collapsedUV = Buffer.from(bytes), indexOffset = payload + header.buffers[fist.index].offset;
  const first = collapsedUV.readUInt16LE(indexOffset);
  for (let corner = 1; corner < 3; corner++) {
    const vertex = collapsedUV.readUInt16LE(indexOffset + corner * 2);
    for (let axis = 0; axis < 2; axis++) collapsedUV.writeFloatLE(
      collapsedUV.readFloatLE(uvOffset + first * 8 + axis * 4), uvOffset + vertex * 8 + axis * 4);
  }
  const collapsedIsland = await loadAuthoredHandSurfaces({ fetcher: async () => new globalThis.Response(collapsedUV) });
  assert.equal(collapsedIsland.state, 'fallback'); assert.match(collapsedIsland.reason, /collapsed or crossing UV/);
  const finishFailed = await loadAuthoredHandSurfaces({ fetcher,
    finishLoader: { loadAsync: async () => { throw new Error('Baked finish unavailable'); } } });
  assert.equal(finishFailed.state, 'fallback'); assert.match(finishFailed.reason, /Baked finish unavailable/);
  assert.equal(getBlenderHandGeometry(1, .030), null, 'Semantic UV geometry cannot escape before its baked material is ready');
  assert.equal(getBlenderArmGeometry(), null, 'An incomplete generation is not partially published');
  const timedOut = await loadAuthoredHandSurfaces({ fetcher: () => new Promise(() => {}), timeoutMs: 5 });
  assert.equal(timedOut.state, 'fallback'); assert.match(timedOut.reason, /timed out/);
  let calls = 0;
  const load = async () => { calls++; return fetcher(); };
  const results = await Promise.all([loadAuthoredHandSurfaces({ fetcher: load, finishLoader }), loadAuthoredHandSurfaces({ fetcher: load, finishLoader })]);
  assert.equal(calls, 1);
  assert.ok(results.every(status => status.state === 'ready'), JSON.stringify(results));
  await loadAuthoredHandSurfaces({ fetcher: load, finishLoader }); assert.equal(calls, 1);
  assert.equal(getAuthoredHandGeometry(1, .031), fallback, 'Unprepared arbitrary-radius requests keep their original cached shape');
});

test('the shipped pack and editable Blender source match a bounded geometry and baked-finish manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../public/assets/models/hands/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(manifest.bytes, bytes.length); assert.ok(bytes.length < 1_500_000);
  assert.deepEqual(manifest.rightHandVariants, AUTHORED_HAND_RADII);
  assert.equal(manifest.textures, 3); assert.equal(manifest.materials, 0); assert.equal(manifest.extraDrawCalls, 0);
  for (const path of [manifest.source, manifest.generator, 'tools/blender/export-hands-input.mjs']) {
    assert.ok((await stat(new URL(`../../${path}`, import.meta.url))).size > 0);
  }
});

test('all production hand surfaces preserve mirrored ownership and the authored finish contract', () => {
  for (const radius of AUTHORED_HAND_RADII) {
    const right = getAuthoredHandGeometry(1, radius), left = getAuthoredHandGeometry(-1, radius);
    assert.equal(right.userData.authoredHand.source, 'original-blender-authored');
    assert.equal(right.userData.authoredHand.revision, 'hands-sculpt-v2');
    assert.equal(right.userData.authoredHand.finish, 'blender-baked-v2');
    assert.equal(right.userData.authoredHand.side, 1); assert.equal(left.userData.authoredHand.side, -1);
    assert.equal(right, getBlenderHandGeometry(1, radius)); assert.equal(left, getBlenderHandGeometry(-1, radius));
    assert.notEqual(left.attributes.position.array, right.attributes.position.array);
    assert.notEqual(left.userData.authoredHand, right.userData.authoredHand);
    assert.ok(right.index.count / 3 <= 3200, 'The remodeled anatomy stays inside the established per-hand triangle budget');
    for (const name of ['position', 'normal']) {
      for (const [source, mirrored] of [[right.attributes[name], left.attributes[name]],
        [right.morphAttributes[name][0], left.morphAttributes[name][0]]]) {
        for (let i = 0; i < source.count; i++) {
          assert.equal(mirrored.getX(i), -source.getX(i));
          assert.equal(mirrored.getY(i), source.getY(i));
          assert.equal(mirrored.getZ(i), source.getZ(i));
        }
      }
    }
    for (let i = 0; i < right.index.count; i += 3) {
      assert.equal(left.index.array[i], right.index.array[i]);
      assert.equal(left.index.array[i + 1], right.index.array[i + 2]);
      assert.equal(left.index.array[i + 2], right.index.array[i + 1]);
    }
  }
});

function verifySurface(geometry, clench) {
  const { position, normal, uv } = geometry.attributes, indices = geometry.index.array;
  const morph = geometry.morphAttributes.position[0], normalMorph = geometry.morphAttributes.normal[0];
  const points = [], ids = [], physical = new Map(), edges = new Map(), neighbors = new Map();
  for (let i = 0; i < position.count; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(position, i).addScaledVector(new THREE.Vector3().fromBufferAttribute(morph, i), clench);
    points.push(point);
    const key = point.toArray().map(axis => Math.round(axis * 1e7)).join(':');
    if (!physical.has(key)) physical.set(key, physical.size);
    ids.push(physical.get(key));
    const direction = new THREE.Vector3().fromBufferAttribute(normal, i).addScaledVector(new THREE.Vector3().fromBufferAttribute(normalMorph, i), clench);
    assert.ok(direction.toArray().every(Number.isFinite));
    assert.ok(Math.abs(direction.length() - 1) < 1e-6, 'Both clench endpoints have unit surface normals');
    const atlas = HAND_ATLAS[uv.getY(i) < .5 ? 'skin' : 'glove'];
    assert.ok(uv.getX(i) >= atlas.uMin - 1e-7 && uv.getX(i) <= atlas.uMax + 1e-7
      && uv.getY(i) >= atlas.vMin - 1e-7 && uv.getY(i) <= atlas.vMax + 1e-7);
  }
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3);
    volume += points[a].dot(points[b].clone().cross(points[c])) / 6;
    const skin = uv.getY(a) < .5;
    assert.ok([b, c].every(index => (uv.getY(index) < .5) === skin), 'No triangle interpolates through another atlas island');
    for (let corner = 0; corner < 3; corner++) {
      const a = ids[indices[i + corner]], b = ids[indices[i + (corner + 1) % 3]];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`, edge = edges.get(key) || { count: 0, winding: 0 };
      edge.count++; edge.winding += a < b ? 1 : -1; edges.set(key, edge);
      if (!neighbors.has(a)) neighbors.set(a, new Set());
      neighbors.get(a).add(b);
    }
  }
  for (const edge of edges.values()) { assert.equal(edge.count, 2, 'Clench cannot open UV-seam cracks'); assert.equal(edge.winding, 0); }
  const visited = new Set(), pending = [ids[indices[0]]];
  while (pending.length) {
    const current = pending.pop(); if (visited.has(current)) continue;
    visited.add(current); pending.push(...neighbors.get(current));
  }
  assert.equal(visited.size, physical.size);
  assert.ok(volume > .00025 && volume < .00040);
}

test('every loaded grip and clench endpoint is connected, watertight, outward-wound, and has valid material seams', () => {
  for (const radius of AUTHORED_HAND_RADII) for (const side of [-1, 1]) {
    for (const clench of [0, 1]) verifySurface(getAuthoredHandGeometry(side, radius), clench);
  }
});

test('loaded sleeves keep fixed attachment endpoints and static grip batching owns its buffers', () => {
  const arms = getHandArmGeometry(), originalArms = getProceduralArmGeometry();
  for (const name of ['sleeve', 'cuff']) {
    const geometry = arms[name], seed = originalArms[name];
    assert.equal(geometry.userData.source, 'original-blender-authored');
    assert.equal(geometry.index.count, seed.index.count);
    const previousByUV = new Map();
    for (let i = 0; i < seed.attributes.position.count; i++) {
      const key = `${seed.attributes.uv.getX(i)},${seed.attributes.uv.getY(i)}`;
      const points = previousByUV.get(key) || [];
      points.push(new THREE.Vector3().fromBufferAttribute(seed.attributes.position, i));
      previousByUV.set(key, points);
    }
    let moved = 0;
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, i);
      const key = `${geometry.attributes.uv.getX(i)},${geometry.attributes.uv.getY(i)}`;
      const candidates = previousByUV.get(key);
      assert.ok(candidates, 'The exported sleeve preserves its physical fabric UV coordinates');
      const prior = candidates.reduce((nearest, candidate) => candidate.distanceTo(point) < nearest.distanceTo(point) ? candidate : nearest);
      assert.equal(point.y, prior.y);
      if (Math.abs(point.y) === .5) assert.deepEqual(point.toArray(), prior.toArray(), 'The authored sleeve retains both rig attachment loops');
      if (point.distanceTo(prior) > 1e-7) moved++;
    }
    assert.ok(moved > 100);
  }
  const shared = getAuthoredHandGeometry(1, .030), buffer = shared.attributes.position.array.slice();
  const first = createAuthoredGripHand({ radius: .030 }), second = createAuthoredGripHand({ radius: .030 });
  assert.equal(first.userData.presentation.triangles, 3858);
  const hand = first.children[0];
  assert.notEqual(hand.geometry, shared); assert.notEqual(hand.geometry, second.children[0].geometry);
  assert.equal(hand.material, second.children[0].material); assert.deepEqual(hand.geometry.morphAttributes, {});
  hand.geometry.translate(2, 3, 4); hand.geometry.dispose();
  assert.deepEqual(shared.attributes.position.array, buffer);
});

test('real fist and bat rigs use the prepared surfaces throughout animation without geometry uploads or added draws', () => {
  const fists = createFirstPersonHands(), bat = createFirstPersonBat();
  const watched = [];
  for (const model of [fists, bat]) model.traverse(mesh => {
    if (!mesh.isMesh) return;
    if (mesh.geometry.userData.authoredHand) assert.equal(mesh.geometry.userData.authoredHand.source, 'original-blender-authored');
    watched.push({ geometry: mesh.geometry, position: mesh.geometry.attributes.position, version: mesh.geometry.attributes.position.version,
      morph: mesh.geometry.morphAttributes.position?.[0], morphVersion: mesh.geometry.morphAttributes.position?.[0]?.version });
  });
  let fistDraws = 0, fistTriangles = 0;
  fists.traverse(mesh => { if (mesh.isMesh) { fistDraws++; fistTriangles += mesh.geometry.index.count / 3; } });
  assert.equal(fistDraws, 6); assert.equal(fistTriangles, 8388);
  for (let phase = 0; phase <= 1; phase += .02) {
    poseFirstPersonHands(fists, 1 - phase, phase < .5 ? 0 : 1, phase, .7);
    poseFirstPersonBat(bat, 1 - phase, phase, .7);
  }
  for (const { geometry, position, version, morph, morphVersion } of watched) {
    assert.equal(geometry.attributes.position, position); assert.equal(position.version, version);
    assert.equal(geometry.morphAttributes.position?.[0], morph); assert.equal(morph?.version, morphVersion);
  }
});

test('the shipped sculpt and clench targets keep fists and bat grips clear of the camera and aiming point', () => {
  const cameras = [70, 82, 100].flatMap(fov => [4 / 3, 16 / 9]
    .map(aspect => new THREE.PerspectiveCamera(fov, aspect, .05, 100)));
  const point = new THREE.Vector3(), projected = new THREE.Vector3();
  const fists = createFirstPersonHands(), bat = createFirstPersonBat();
  for (const model of [fists, bat]) {
    const surfaces = [];
    model.traverse(mesh => { if (mesh.isMesh && mesh.geometry.userData.authoredHand) surfaces.push(mesh); });
    assert.equal(surfaces.length, 2, 'Both visible hands use the shipped sculpt rather than the procedural fallback');
    for (let step = 0; step <= 60; step++) {
      const phase = step / 60;
      if (model === fists) poseFirstPersonHands(model, 1 - phase, step % 2, phase * 7, 1);
      else poseFirstPersonBat(model, 1 - phase, phase * 7, 1);
      model.updateMatrixWorld(true);
      for (const mesh of surfaces) {
        assert.equal(mesh.material.userData.handFinish.profile, 'blender-hand-bake-v2');
        for (let index = 0; index < mesh.geometry.attributes.position.count; index++) {
          mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
          assert.ok(point.z < -.12, 'The actual morphing hand never crosses the viewmodel near-plane margin');
          for (const camera of cameras) {
            projected.copy(point).project(camera);
            assert.ok(projected.y < -.07, 'The sculpt stays below the aiming point throughout attack motion');
            assert.ok(projected.y > -1.11 && Math.abs(projected.x) < .95,
              'The complete hand silhouette stays visible above its cropped sleeve');
          }
        }
      }
    }
  }
});
