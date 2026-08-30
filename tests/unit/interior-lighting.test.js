import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createInteriorLighting, INTERIOR_LIGHT_ROOMS } from '../../src/render/interior-lighting.js';

function fixture() {
  const world = new THREE.Group(), material = new THREE.MeshStandardMaterial({ color: 0x987a56 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 8), material);
  floor.position.y = -0.1; world.add(floor);
  const outside = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 8), material);
  outside.position.set(12, -0.1, 0); world.add(outside);
  const room = { id: 'test', min: [-4, -0.01, -4], max: [4, 4, 4], ambient: 0.8,
    lights: [{ position: [-2, 2, 0], color: 0xffc080, energy: 8, samples: 1 }] };
  const meshes = [floor];
  const addBox = (x, y, z, width, height, depth) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z); world.add(mesh); meshes.push(mesh); return mesh;
  };
  return { world, material, floor, outside, room, meshes, addBox,
    bake: options => createInteriorLighting(world, { zoneMeshes: { test: meshes }, rooms: [room], ...options }) };
}

function sampleFloor(floor, x, z) {
  floor.updateWorldMatrix(true, false);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(x, 0.5, z), new THREE.Vector3(0, -1, 0));
  const hit = raycaster.intersectObject(floor)[0];
  assert.ok(hit?.uv1, 'real floor triangle has a second UV coordinate');
  const texture = floor.material.lightMap, { data, width, height } = texture.image;
  const sx = Math.max(0, Math.min(width - 1, Math.round(hit.uv1.x * width - 0.5)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(hit.uv1.y * height - 0.5)));
  return Array.from(data.slice((sy * width + sx) * 4, (sy * width + sx) * 4 + 4));
}

test('interior atlas preserves actual geometry, first UVs, outside shared materials and renderer topology', async () => {
  const f = fixture(), originalGeometry = f.floor.geometry;
  f.material.map = new THREE.Texture();
  const beforePosition = originalGeometry.attributes.position.array.slice();
  const beforeNormal = originalGeometry.attributes.normal.array.slice();
  const beforeUV = originalGeometry.attributes.uv.array.slice();
  const beforeIndex = originalGeometry.index.array.slice();
  const bake = await f.bake();
  assert.notEqual(f.floor.material, f.material);
  assert.equal(f.floor.material.map, f.material.map);
  assert.equal(f.outside.material, f.material);
  assert.equal(f.material.lightMap, null);
  assert.equal(originalGeometry.attributes.uv1, undefined);
  assert.deepEqual(f.floor.geometry.attributes.position.array, beforePosition);
  assert.deepEqual(f.floor.geometry.attributes.normal.array, beforeNormal);
  assert.deepEqual(f.floor.geometry.attributes.uv.array, beforeUV);
  assert.deepEqual(f.floor.geometry.index.array, beforeIndex);
  assert.equal(f.floor.material.lightMap.channel, 1);
  assert.equal(f.floor.material.lightMap.colorSpace, THREE.NoColorSpace);
  assert.equal(f.floor.material.lightMap.generateMipmaps, false);
  assert.equal(f.floor.material.lightMap.minFilter, THREE.LinearFilter);
  assert.equal(bake.snapshot().atlasBytes, 512 * 512 * 4);
  assert.equal(bake.snapshot().addedDrawCalls, 0);
  assert.equal(bake.snapshot().addedTriangles, 0);
  assert.equal(bake.snapshot().addedLights, 0);
  assert.equal(bake.snapshot().extraTextureSamples, 1);
  const color = sampleFloor(f.floor, -2, 0);
  assert.ok(color[0] > color[1] && color[1] > color[2] && color[2] > 0, 'fixture delivers warm irradiance');
  assert.ok(color[3] <= 204 && color[3] > 150, 'only room ambient is reduced');
  bake.dispose();
});

test('real partition triangles stop fixture light while an actual doorway transmits it', async () => {
  const solid = fixture(); solid.addBox(0, 1.5, 0, 0.18, 3, 8);
  const solidBake = await solid.bake();
  assert.equal(sampleFloor(solid.floor, 2, 0)[0], 0, 'wall stops the warm fixture');
  assert.ok(sampleFloor(solid.floor, -2, 0)[0] > 80);
  solidBake.dispose();

  const doorway = fixture();
  doorway.addBox(0, 1.5, -2.5, 0.18, 3, 3);
  doorway.addBox(0, 1.5, 2.5, 0.18, 3, 3);
  doorway.addBox(0, 2.7, 0, 0.18, 0.6, 2);
  const openBake = await doorway.bake();
  assert.ok(sampleFloor(doorway.floor, 2, 0)[0] > 4, 'no coarse collider fills the opening');
  assert.equal(sampleFloor(doorway.floor, 2, 3.2)[0], 0, 'wall beside the doorway remains closed');
  openBake.dispose();
});

test('table top and separated feet cast light/contact shading without filling the empty space below', async () => {
  const f = fixture();
  f.room.lights[0].position = [-2, 0.65, 0];
  f.addBox(0, 1.0, 0, 2, 0.12, 2);
  for (const x of [-0.85, 0.85]) for (const z of [-0.85, 0.85]) f.addBox(x, 0.44, z, 0.1, 0.88, 0.1);
  const bake = await f.bake();
  assert.ok(sampleFloor(f.floor, 1.5, 0)[0] > 2, 'light passes under an actual tabletop');
  const contact = sampleFloor(f.floor, 0.75, 0.85)[3], open = sampleFloor(f.floor, 3, 3)[3];
  assert.ok(contact < open, `${contact} < ${open}: nearby foot softens the ambient at floor contact`);
  bake.dispose();
});

test('anonymous merged finish batches receive independent charts while exterior faces sample a neutral sentinel', async () => {
  const f = fixture();
  f.world.remove(f.floor); f.meshes.length = 0;
  const inside = new THREE.BoxGeometry(8, 0.2, 8).translate(0, -0.1, 0);
  const outside = new THREE.BoxGeometry(8, 0.2, 8).translate(12, -0.1, 0);
  f.floor = new THREE.Mesh(mergeGeometries([inside, outside]), f.material);
  f.world.add(f.floor); f.meshes.push(f.floor);
  const bake = await f.bake();
  assert.ok(sampleFloor(f.floor, -2, 0)[0] > 80);
  assert.deepEqual(sampleFloor(f.floor, 12, 0), [0, 0, 0, 255], 'outdoor surface receives no tint or attenuation');
  assert.equal(bake.snapshot().receivers, 1);
  assert.equal(bake.snapshot().charts, 1);
  bake.dispose(); inside.dispose(); outside.dispose();
});

test('transparent glazing, dynamic objects and articulated groups do not become permanent occluders or receivers', async () => {
  const f = fixture();
  const pane = f.addBox(0, 1.5, 0, 0.18, 3, 8);
  pane.material = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 });
  const dynamic = f.addBox(0.5, 1.5, 0, 0.18, 3, 8); dynamic.userData.dynamic = true;
  const articulated = new THREE.Group(), limb = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3, 8), f.material);
  limb.position.set(1, 1.5, 0); articulated.add(limb); f.world.add(articulated); f.meshes.push(articulated);
  const bake = await f.bake();
  assert.ok(sampleFloor(f.floor, 2, 0)[0] > 4);
  assert.equal(pane.material.lightMap, null);
  assert.equal(dynamic.material.lightMap, null);
  assert.equal(limb.material.lightMap, null);
  assert.ok(bake.snapshot().visibilityTriangles > 0 && bake.snapshot().visibilityTriangles <= 12);
  bake.dispose();
});

test('room bounds exclude backside faces and caches do not contaminate another room sharing a finish', async () => {
  const f = fixture();
  const second = { id: 'second', min: [8, -0.01, -4], max: [16, 4, 4], ambient: 0.7,
    lights: [{ position: [12, 2, 0], color: 0x80b4ff, energy: 8, samples: 1 }] };
  const bake = await createInteriorLighting(f.world, { zoneMeshes: { test: f.meshes, second: [f.outside] }, rooms: [f.room, second] });
  const warm = sampleFloor(f.floor, -2, 0), cool = sampleFloor(f.outside, 12, 0);
  assert.ok(warm[0] > warm[2]); assert.ok(cool[2] > cool[0]);
  assert.equal(f.floor.material, f.outside.material, 'one cloned material can share atlas islands across rooms');
  assert.equal(bake.snapshot().materials, 1);
  const uv = f.floor.geometry.attributes.uv1;
  const downward = f.floor.geometry.attributes.normal;
  for (let i = 0; i < uv.count; i++) if (downward.getY(i) === -1) {
    assert.equal(uv.getX(i), 0.5 / 512); assert.equal(uv.getY(i), 0.5 / 512);
  }
  bake.dispose();
});

test('inset room boundaries do not create a neutral bright strip around a selected floor chart', async () => {
  const f = fixture();
  f.room.min = [-3.94, -0.01, -3.94]; f.room.max = [3.94, 4, 3.94];
  const bake = await f.bake({ texelsPerMeter: 1 });
  const center = sampleFloor(f.floor, 0, 0), edge = sampleFloor(f.floor, -4, -4);
  assert.ok(edge[3] <= center[3]); assert.ok(edge[3] < 255);
  bake.dispose();
});

test('hard ray/atlas budgets reduce density and queued chunks yield before continuing', async () => {
  const f = fixture();
  let clock = 0, yields = 0;
  const bake = await f.bake({ atlasSize: 64, texelsPerMeter: 30, rayBudget: 900,
    now: () => ++clock, yieldTask: async () => { yields++; } });
  const stats = bake.snapshot();
  assert.ok(stats.rays <= 900); assert.ok(stats.estimatedRays <= 900);
  assert.ok(stats.texelsPerMeter < 30);
  assert.equal(stats.atlasBytes, 64 * 64 * 4);
  assert.ok(yields > 0); assert.equal(stats.yieldCount, yields);
  const uv = f.floor.geometry.attributes.uv1;
  for (let i = 0; i < uv.count; i++) assert.ok(uv.getX(i) >= 0 && uv.getX(i) <= 1 && uv.getY(i) >= 0 && uv.getY(i) <= 1);
  bake.dispose();
});

test('an oversized first chart reduces density and cannot wrap over the neutral sentinel', async () => {
  const world = new THREE.Group(), material = new THREE.MeshStandardMaterial();
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 20), material); world.add(wall);
  const room = { id: 'test', min: [-2, -11, -2], max: [2, 11, 2], ambient: 0.5, lights: [] };
  const bake = await createInteriorLighting(world, { zoneMeshes: { test: [wall] }, rooms: [room], atlasSize: 32 });
  assert.deepEqual(Array.from(wall.material.lightMap.image.data.slice(0, 4)), [0, 0, 0, 255]);
  const uv = wall.geometry.attributes.uv1;
  for (let i = 0; i < uv.count; i++) assert.ok(uv.getX(i) >= 0 && uv.getX(i) <= 1 && uv.getY(i) >= 0 && uv.getY(i) <= 1);
  assert.ok(bake.snapshot().texelsPerMeter < 4);
  bake.dispose();
});

test('a flat face sharing vertices with a rejected curved face never interpolates across atlas islands', async () => {
  const f = fixture(), geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 1, 0, 1, 1, 0, -1, 3, 0, 1, 3, 0.4], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, -0.2, -0.2, 0.96], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geometry.setIndex([0, 1, 2, 1, 3, 2]);
  const curved = new THREE.Mesh(geometry, f.material); f.world.add(curved); f.meshes.push(curved);
  const bake = await f.bake();
  assert.equal(curved.geometry, geometry);
  assert.equal(curved.geometry.attributes.uv1, undefined);
  assert.equal(curved.material, f.material);
  bake.dispose();
});

test('A/B switching reuses the atlas and geometry, and disposal also restores disabled receivers', async () => {
  const f = fixture(), geometry = f.floor.geometry;
  const bake = await f.bake(), ownedGeometry = f.floor.geometry, ownedMaterial = f.floor.material, atlas = f.floor.material.lightMap;
  bake.setEnabled(false);
  assert.equal(f.floor.geometry, ownedGeometry); assert.equal(f.floor.material, f.material);
  assert.equal(bake.snapshot().enabled, false);
  bake.setEnabled(true);
  assert.equal(f.floor.geometry, ownedGeometry); assert.equal(f.floor.material, ownedMaterial);
  assert.equal(f.floor.material.lightMap, atlas); assert.equal(bake.snapshot().enabled, true);
  bake.setEnabled(false); bake.dispose(); bake.setEnabled(true);
  assert.equal(f.floor.geometry, geometry); assert.equal(f.floor.material, f.material);
});

test('disposal is idempotent and restores original resources without disposing shared maps or geometry', async () => {
  const f = fixture(), originalGeometry = f.floor.geometry, originalMaterial = f.material;
  let originalGeometriesDisposed = 0, originalMaterialsDisposed = 0, ownGeometriesDisposed = 0, ownMaterialsDisposed = 0, texturesDisposed = 0;
  originalGeometry.addEventListener('dispose', () => originalGeometriesDisposed++);
  originalMaterial.addEventListener('dispose', () => originalMaterialsDisposed++);
  const bake = await f.bake();
  f.floor.geometry.addEventListener('dispose', () => ownGeometriesDisposed++);
  f.floor.material.addEventListener('dispose', () => ownMaterialsDisposed++);
  f.floor.material.lightMap.addEventListener('dispose', () => texturesDisposed++);
  bake.dispose(); bake.dispose();
  assert.equal(f.floor.geometry, originalGeometry); assert.equal(f.floor.material, originalMaterial);
  assert.equal(f.floor.userData.interiorLighting, undefined);
  assert.equal(originalGeometriesDisposed, 0); assert.equal(originalMaterialsDisposed, 0);
  assert.equal(ownGeometriesDisposed, 1); assert.equal(ownMaterialsDisposed, 1); assert.equal(texturesDisposed, 1);
  assert.equal(bake.snapshot().status, 'disposed');
});

test('shader keeps direct/specular lighting and prior compile hooks while shading the two indirect diffuse terms', async () => {
  const f = fixture(); let originalHookCalls = 0;
  f.material.onBeforeCompile = shader => { originalHookCalls++; shader.uniforms.original = { value: 2 }; };
  f.material.customProgramCacheKey = () => 'existing-hook';
  const bake = await f.bake();
  const shader = { uniforms: {}, fragmentShader: '#include <lights_fragment_begin>\n#include <lights_fragment_maps>\n#include <lights_fragment_end>' };
  f.floor.material.onBeforeCompile(shader, {});
  assert.equal(originalHookCalls, 1); assert.equal(shader.uniforms.original.value, 2);
  assert.match(shader.fragmentShader, /irradiance \*= lightMapTexel\.a/);
  assert.match(shader.fragmentShader, /getIBLIrradiance\( geometryNormal \) \* lightMapTexel\.a/);
  assert.match(shader.fragmentShader, /radiance \+= getIBLRadiance\( geometryViewDir, geometryNormal, material\.roughness \);/);
  assert.match(shader.fragmentShader, /#include <lights_fragment_begin>/);
  assert.equal(f.floor.material.customProgramCacheKey(), 'existing-hook:interior-lighting-1');
  const custom = { uniforms: {}, fragmentShader: 'void main() {}' };
  assert.doesNotThrow(() => f.floor.material.onBeforeCompile(custom, {}));
  assert.equal(f.floor.material.userData.interiorLightingFallback, true);
  assert.equal(custom.fragmentShader, 'void main() {}');
  bake.dispose();
});

test('invalid budgets fail before mutating a mesh and authored rooms avoid permanent fire emitters', async () => {
  for (const options of [{ atlasSize: 1024 }, { atlasSize: 100 }, { rayBudget: 300001 }, { rayBudget: 0 }, { texelsPerMeter: Infinity }]) {
    const f = fixture(), geometry = f.floor.geometry;
    await assert.rejects(f.bake(options), RangeError);
    assert.equal(f.floor.geometry, geometry); assert.equal(f.floor.material, f.material);
  }
  assert.deepEqual(INTERIOR_LIGHT_ROOMS.map(room => room.id), ['apartment', 'neighbor', 'bakery']);
  assert.ok(INTERIOR_LIGHT_ROOMS.every(room => room.lights.every(light => light.position.length === 3 && light.energy > 0)));
});
