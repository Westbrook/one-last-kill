import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Texture } from 'three';
import { batchStaticWeaponParts } from '../../src/render/weapon-finishes.js';
import { loadAuthoredWeapons } from '../../src/render/authored-weapons.js';
import { weaponHarness } from './helpers/weapon-harness.js';

const TYPES = ['smg', 'shotgun', 'machinegun', 'knife'];
let sequence = 0;
const isolated = () => import(`../../src/render/authored-weapons.js?loader-test=${++sequence}`);

function catalog() {
  const scene = new Group(), texture = new Texture({ width: 256, height: 256 });
  const material = new MeshStandardMaterial({ map: texture }); material.name = 'catalog-steel';
  const nodes = {};
  for (const type of TYPES) {
    const root = new Group(); root.name = `vm_${type}`;
    root.userData.heroWeapon = { triggerOpening: [-0.034, -0.041, 0],
      recess: { point: [0.035, 0.025, -0.0185], depth: 0.012 },
      panels: [{ name: 'side-pocket', point: [-0.045, 0.015, -0.0173], depth: 0.0012 }] };
    for (let index = 0; index < 2; index++) {
      const geometry = new BoxGeometry(0.008, 0.008, 0.008);
      geometry.translate(index * 0.02, 0, 0);
      geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(0.9), 3));
      const mesh = new Mesh(geometry, material); mesh.name = `${type}-part-${index}`; root.add(mesh);
    }
    nodes[type] = root; scene.add(root);
  }
  return { gltf: { scene, animations: [] }, nodes, material, texture };
}

test('catalog preloading coalesces work and caches independently owned geometry with shared finishes', async () => {
  const api = await isolated(), fixture = catalog();
  assert.equal(api.createAuthoredWeapon('smg'), null);
  assert.equal(api.createAuthoredWeapon('bat'), null);
  let resolveLoad, calls = 0, originalDisposals = 0, finishDisposals = 0;
  fixture.gltf.scene.traverse(mesh => mesh.geometry?.addEventListener('dispose', () => originalDisposals++));
  fixture.material.addEventListener('dispose', () => finishDisposals++);
  fixture.texture.addEventListener('dispose', () => finishDisposals++);
  const loader = { loadAsync: () => { calls++; return new Promise(resolve => { resolveLoad = resolve; }); } };
  const firstLoad = api.loadAuthoredWeapons({ loader }), secondLoad = api.loadAuthoredWeapons({ loader });
  assert.equal(api.getAuthoredWeaponsStatus().state, 'loading');
  assert.equal(calls, 1);
  resolveLoad(fixture.gltf);
  const [firstResult, secondResult] = await Promise.all([firstLoad, secondLoad]);
  assert.equal(firstResult.state, 'ready'); assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.materials, 1); assert.equal(firstResult.textures, 1);
  assert.equal(firstResult.textureBytes, Math.ceil(256 * 256 * 4 * 4 / 3), 'Shared maps count once for the catalog');
  assert.equal(originalDisposals, 8); assert.equal(finishDisposals, 0);
  firstResult.types.smg.state = 'changed outside the loader';
  assert.equal(api.getAuthoredWeaponsStatus().types.smg.state, 'ready', 'Reported nested metrics do not expose mutable cache state');
  const first = api.createAuthoredWeapon('smg'), second = api.createAuthoredWeapon('smg');
  assert.notEqual(first.children[0].geometry, second.children[0].geometry);
  assert.equal(first.children[0].material, second.children[0].material);
  assert.equal(first.children[0].material, api.createAuthoredWeapon('knife').children[0].material);
  assert.deepEqual(first.userData.muzzle, [0.28, 0.02, 0]);
  assert.deepEqual(first.userData.heroWeapon.recess, fixture.nodes.smg.userData.heroWeapon.recess);
  first.userData.heroWeapon.recess.depth = 0;
  assert.equal(second.userData.heroWeapon.recess.depth, 0.012, 'Instance metadata is also independent');
  const uv = second.children[0].geometry.attributes.uv.array.slice();
  batchStaticWeaponParts(first); first.children[0].geometry.dispose();
  assert.deepEqual(api.createAuthoredWeapon('smg').children[0].geometry.attributes.uv.array, uv,
    'Batching one instance cannot consume the template or another instance');
  assert.equal(finishDisposals, 0);
  await api.loadAuthoredWeapons({ loader }); assert.equal(calls, 1);
});

test('a malformed entry falls back independently without disposing another weapon’s shared maps', async () => {
  const api = await isolated(), fixture = catalog(); let sharedDisposals = 0;
  fixture.material.addEventListener('dispose', () => sharedDisposals++);
  fixture.texture.addEventListener('dispose', () => sharedDisposals++);
  fixture.nodes.smg.userData.muzzle = [0.30, 0.02, 0];
  fixture.gltf.scene.remove(fixture.nodes.knife);
  const result = await api.loadAuthoredWeapons({ loader: { loadAsync: async () => fixture.gltf } });
  assert.equal(result.state, 'partial');
  assert.match(result.types.smg.error, /effect anchor/);
  assert.match(result.types.knife.error, /Expected one vm_knife/);
  assert.equal(api.createAuthoredWeapon('smg'), null); assert.equal(api.createAuthoredWeapon('knife'), null);
  assert.equal(api.createAuthoredWeapon('shotgun').userData.heroWeapon.source, 'original-blender-authored');
  assert.equal(sharedDisposals, 0);
});

test('catalog guards reject invalid buffers, incompatible batches, enlarged framing, and excess materials per type', async t => {
  const cases = [
    ['nonfinite positions', fixture => fixture.nodes.smg.children[0].geometry.attributes.position.setX(0, NaN), /Invalid position/],
    ['missing UVs', fixture => fixture.nodes.smg.children[0].geometry.deleteAttribute('uv'), /Invalid uv layout/],
    ['incompatible finish attributes', fixture => fixture.nodes.smg.children[0].geometry.deleteAttribute('color'), /incompatible vertex attributes/],
    ['enlarged framing', fixture => fixture.nodes.smg.position.set(1, 0, 0), /grip\/framing envelope/],
    ['excess material draws', fixture => {
      for (let index = 0; index < 3; index++) fixture.nodes.smg.add(new Mesh(new BoxGeometry(0.01, 0.01, 0.01), new MeshStandardMaterial()));
    }, /mesh\/material budget/],
    ['excess triangles', fixture => {
      const geometry = fixture.nodes.smg.children[0].geometry;
      const count = 4785 * 3;
      geometry.setIndex(null);
      for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) {
        geometry.setAttribute(name, new Float32BufferAttribute(new Float32Array(count * size), size));
      }
    }, /mesh\/material budget/],
    ['changed sight alignment', fixture => { fixture.nodes.smg.userData.ironSights = { rear: { x: 0 } }; }, /aim alignment/],
    ['invalid mechanical metadata', fixture => { fixture.nodes.smg.userData.heroWeapon.panels[0].depth = NaN; }, /panel metadata/],
  ];
  for (const [name, mutate, error] of cases) await t.test(name, async () => {
    const api = await isolated(), fixture = catalog(); mutate(fixture);
    const result = await api.loadAuthoredWeapons({ loader: { loadAsync: async () => fixture.gltf } });
    assert.equal(result.state, 'partial'); assert.match(result.types.smg.error, error);
    assert.equal(result.types.shotgun.state, 'ready'); assert.equal(api.createAuthoredWeapon('smg'), null);
  });
});

test('an entirely invalid catalog releases its resources and permits a later successful load', async () => {
  const api = await isolated(), fixture = catalog(); let disposed = 0, closed = 0;
  fixture.texture.image.width = 1024; fixture.texture.image.close = () => closed++;
  fixture.texture.addEventListener('dispose', () => disposed++);
  fixture.material.addEventListener('dispose', () => disposed++);
  const failed = await api.loadAuthoredWeapons({ loader: { loadAsync: async () => fixture.gltf } });
  assert.equal(failed.state, 'fallback'); assert.equal(disposed, 2); assert.equal(closed, 1);
  assert.match(failed.types.machinegun.error, /at most 512px/);
  const fresh = catalog();
  const succeeded = await api.loadAuthoredWeapons({ loader: { loadAsync: async () => fresh.gltf } });
  assert.equal(succeeded.state, 'ready');
});

test('late results after a timeout are released and cannot replace a successful retry', async () => {
  const api = await isolated(), late = catalog(); let resolveLate, disposed = 0, closed = 0;
  late.texture.image.close = () => closed++;
  late.texture.addEventListener('dispose', () => disposed++);
  late.material.addEventListener('dispose', () => disposed++);
  const failure = await api.loadAuthoredWeapons({ timeoutMs: 1,
    loader: { loadAsync: () => new Promise(resolve => { resolveLate = resolve; }) } });
  assert.equal(failure.state, 'fallback'); assert.match(failure.error, /timed out/);
  const fresh = catalog();
  assert.equal((await api.loadAuthoredWeapons({ loader: { loadAsync: async () => fresh.gltf } })).state, 'ready');
  resolveLate(late.gltf);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(disposed, 2); assert.equal(closed, 1);
  assert.equal(api.createAuthoredWeapon('smg').children[0].material, fresh.material);
});

test('the production factory selects preloaded catalog assets and retains the existing hands and knife ready pose', async () => {
  const fixture = catalog();
  assert.equal((await loadAuthoredWeapons({ loader: { loadAsync: async () => fixture.gltf } })).state, 'ready');
  const { makeWeaponViewModel } = weaponHarness();
  for (const type of TYPES) {
    const model = makeWeaponViewModel(type);
    assert.equal(model.userData.heroWeapon.source, 'original-blender-authored');
    assert.equal(model.userData.heroWeapon.grips.length, type === 'knife' ? 1 : 2);
    assert.equal(model.userData.presentation.drawCalls, 3, 'A shared finish plus the established two hand finishes');
  }
  assert.deepEqual(makeWeaponViewModel('knife').userData.heroWeapon.readyAngle, { side: 25, up: 10 });
  assert.equal(makeWeaponViewModel('pistol').userData.heroWeapon.source, 'original-profile-procedural', 'The pistol keeps its separate preload contract');
});
