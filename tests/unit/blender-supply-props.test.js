import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as THREE from 'three';
import { loadAuthoredSupplyProps, getAuthoredSupplyGeometry, getAuthoredSupplyPropsStatus } from '../../src/render/authored-supply-props.js';
import { createHealthPickupModel } from '../../src/render/health-pickup-model.js';
import { createArmorPickupModel } from '../../src/render/armor-pickup-model.js';
import { addCrtHousing, crtHousingBudget } from '../../src/render/crt-housing.js';
import { buildAmmoBox, createResources, createAmmoSupplies } from '../../src/game/ammo-supplies.js';
import { AMMO_SUPPLY_CACHES } from '../../src/game/ammo-supply-rules.js';
import { Colliders } from '../../src/core/collision.js';
import { Architecture } from '../../src/world/architecture.js';

const catalogUrl = new URL('../../public/assets/models/supplies-props/catalog.json', import.meta.url);
const expectedParts = {
  health: ['medical-case-shell', 'medical-case-trim', 'medical-case-crosses'],
  armor: ['armor-vest-fabric', 'armor-vest-plates', 'armor-vest-identity', 'armor-vest-bullet-marks'],
  crt: ['crt-molded-housing', 'crt-recessed-details'],
  ammo: ['ammo-case-body-and-lid', 'ammo-case-feet-and-seal', 'ammo-case-handle-and-latches'],
};
const maximumTriangles = { health: 800, armor: 750, crt: 799, ammo: 708 };
const near = (actual, expected, message, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} versus ${expected}`);
const triangles = geometry => (geometry.index?.count ?? geometry.attributes.position.count) / 3;
const bytes = geometry => (geometry.index?.array.byteLength ?? 0)
  + Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
const firstHit = (root, from, direction) => {
  root.updateMatrixWorld(true);
  return new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...direction)).intersectObject(root, true)[0];
};
let freshSequence = 0;
const freshLoader = () => import(`../../src/render/authored-supply-props.js?supply-test=${++freshSequence}`);
const readCatalog = async () => JSON.parse(await readFile(catalogUrl, 'utf8'));

function crtFixture() {
  const group = new THREE.Group();
  const body = addCrtHousing((geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); group.add(mesh);
  }, { parent: group, x: 0, y: 0, z: 0 });
  return { group, body };
}

test('the shipped Blender supplies catalog loads into the actual production factories', async t => {
  const catalog = await readCatalog();
  assert.equal(catalog.version, 1);
  assert.equal(catalog.source, 'blender-authored-original');
  assert.deepEqual(Object.keys(catalog.models).sort(), Object.keys(expectedParts).sort());
  const fallbackHealth = createHealthPickupModel();
  const fallbackArmor = createArmorPickupModel({ damaged: true });
  const fallbackCrt = crtFixture();
  const localAmmoConfig = { ...AMMO_SUPPLY_CACHES[0], position: { x: 0, y: 0, z: 0 } };
  const fallbackAmmo = buildAmmoBox(localAmmoConfig, createResources()).mesh;
  assert.equal(getAuthoredSupplyGeometry('health', 'medical-case-shell'), null);
  let calls = 0;
  const loader = async () => { calls++; return catalog; };
  const results = await Promise.all([
    loadAuthoredSupplyProps({ loader }), loadAuthoredSupplyProps({ loader }),
  ]);
  assert.equal(calls, 1, 'Concurrent startup callers parse and allocate the catalog once');
  for (const status of results) assert.equal(status.state, 'ready');
  assert.equal(getAuthoredSupplyPropsStatus().state, 'ready');
  assert.equal(getAuthoredSupplyGeometry('unknown', 'medical-case-shell'), null);
  assert.equal(getAuthoredSupplyGeometry('health', 'unknown'), null);

  await t.test('the delivery manifest identifies the validated catalog and retained editable source', async () => {
    const raw = await readFile(catalogUrl);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', catalogUrl), 'utf8'));
    assert.equal(manifest.bytes, raw.length);
    assert.equal(manifest.sha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(manifest.textures, 0);
    for (const [model, names] of Object.entries(expectedParts)) {
      assert.equal(manifest.metrics[model].triangles,
        names.reduce((sum, name) => sum + triangles(getAuthoredSupplyGeometry(model, name)), 0));
      assert.equal(manifest.metrics[model].geometryBytes,
        names.reduce((sum, name) => sum + bytes(getAuthoredSupplyGeometry(model, name)), 0));
      assert.equal(manifest.metrics[model].draws, names.length);
    }
    for (const path of [manifest.sourceFile, manifest.sourceInput, 'tools/blender/build-supplies-props.py']) {
      const info = await stat(new URL(`../../${path}`, import.meta.url));
      assert.ok(info.isFile() && info.size > 0, `${path} retains an editable and reproducible asset`);
    }
  });

  await t.test('all shipped buffers fit their world-prop budgets and have valid front-facing surfaces', () => {
    let totalBytes = 0, totalTriangles = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const face = new THREE.Vector3(), average = new THREE.Vector3(), normal = new THREE.Vector3();
    for (const [model, names] of Object.entries(expectedParts)) {
      assert.deepEqual(catalog.models[model].parts.map(part => part.name).sort(), [...names].sort());
      let modelTriangles = 0, modelBytes = 0;
      for (const name of names) {
        const geometry = getAuthoredSupplyGeometry(model, name);
        assert.ok(geometry?.isBufferGeometry, `${model}/${name} loads actual drawable geometry`);
        assert.equal(geometry.groups.length, 0, 'Each part remains one material draw');
        const { position, normal: normals } = geometry.attributes;
        assert.equal(position.count, normals.count);
        for (const attribute of Object.values(geometry.attributes)) {
          assert.ok(attribute.array.every(Number.isFinite), `${model}/${name} has finite attributes`);
        }
        for (let i = 0; i < normals.count; i++) {
          near(normal.fromBufferAttribute(normals, i).length(), 1, `${model}/${name} normal ${i}`, 0.002);
        }
        const count = geometry.index?.count ?? position.count;
        assert.equal(count % 3, 0);
        if (geometry.index) assert.ok(geometry.index.array.every(i => i >= 0 && i < position.count));
        for (let i = 0; i < count; i += 3) {
          const [ia, ib, ic] = [0, 1, 2].map(corner => geometry.index?.getX(i + corner) ?? i + corner);
          a.fromBufferAttribute(position, ia); b.fromBufferAttribute(position, ib); c.fromBufferAttribute(position, ic);
          face.crossVectors(b.sub(a), c.sub(a));
          assert.ok(face.lengthSq() > 1e-19, `${model}/${name} face ${i / 3} is not degenerate`);
          average.fromBufferAttribute(normals, ia).add(a.fromBufferAttribute(normals, ib)).add(b.fromBufferAttribute(normals, ic));
          assert.ok(face.dot(average) > 0, `${model}/${name} face ${i / 3} agrees with its normals`);
        }
        modelTriangles += triangles(geometry); modelBytes += bytes(geometry);
      }
      assert.ok(modelTriangles > 0 && modelTriangles <= maximumTriangles[model], `${model}: ${modelTriangles} triangles`);
      const limit = model === 'crt' ? 40 * 1024 : 64 * 1024;
      assert.ok(modelBytes <= limit, `${model}: ${modelBytes} shared geometry bytes`);
      totalTriangles += modelTriangles; totalBytes += modelBytes;
    }
    const status = getAuthoredSupplyPropsStatus();
    assert.equal(status.triangles, totalTriangles);
    assert.equal(status.geometryBytes, totalBytes);
    assert.ok(Number.isFinite(status.elapsedMs) && status.elapsedMs >= 0);
  });

  await t.test('preloaded health cases retain readable crosses, real handle clearance, and shared finishes', () => {
    const root = createHealthPickupModel(), other = createHealthPickupModel();
    assert.equal(root.children.length, 3);
    for (const [index, mesh] of root.children.entries()) {
      assert.equal(mesh.geometry, getAuthoredSupplyGeometry('health', mesh.name));
      assert.equal(mesh.geometry, other.children[index].geometry);
      assert.notEqual(mesh.geometry, fallbackHealth.children[index].geometry, 'Early fallback creation does not stale-lock the factory');
      assert.equal(mesh.material, fallbackHealth.children[index].material);
      assert.equal(mesh.material, other.children[index].material);
      assert.equal(mesh.material.transparent, false); assert.equal(mesh.material.side, THREE.FrontSide);
      assert.equal(mesh.castShadow, false); assert.equal(mesh.material.map, null);
    }
    const bounds = new THREE.Box3().setFromObject(root);
    near(bounds.min.y, -0.04, 'Case hover datum'); near(bounds.max.y, 0.052, 'Raised cross height');
    assert.ok(bounds.min.x >= -0.122501 && bounds.max.x <= 0.122501);
    assert.ok(bounds.min.z >= -0.090001 && bounds.max.z <= 0.090001);
    for (const [from, direction] of [
      [[0, 0.3, 0], [0, -1, 0]], [[0.043, 0.3, 0], [0, -1, 0]], [[0, 0.3, 0.043], [0, -1, 0]],
      [[0, -0.018, 0.4], [0, 0, -1]], [[0, -0.018, -0.4], [0, 0, 1]],
    ]) assert.equal(firstHit(root, from, direction)?.object.name, 'medical-case-crosses');
    assert.equal(firstHit(root, [0.043, 0.3, 0.043], [0, -1, 0])?.object.name, 'medical-case-shell');
    assert.equal(firstHit(root.getObjectByName('medical-case-trim'), [0, 0.018, -0.4], [0, 0, 1]), undefined);
    assert.equal(firstHit(root, [0, 0.018, -0.4], [0, 0, 1])?.object.name, 'medical-case-shell');
    assert.equal(firstHit(root, [0.030, 0.018, -0.4], [0, 0, 1])?.object.name, 'medical-case-trim');
    for (const x of [-0.08, 0.08]) assert.equal(firstHit(root, [x, 0.0085, 0.4], [0, 0, -1])?.object.name, 'medical-case-trim');
    root.position.set(10, 20, 30); root.visible = false;
    assert.deepEqual(other.position.toArray(), [0, 0, 0]); assert.equal(other.visible, true);
  });

  await t.test('preloaded armor retains the hollow neckline, shoulder bridges, plate silhouette, and damage overlay', () => {
    const root = createArmorPickupModel(), damaged = createArmorPickupModel({ damaged: true });
    assert.equal(root.children.length, 3); assert.equal(damaged.children.length, 4);
    for (const [index, mesh] of damaged.children.entries()) {
      assert.equal(mesh.geometry, getAuthoredSupplyGeometry('armor', mesh.name));
      assert.notEqual(mesh.geometry, fallbackArmor.children[index].geometry);
      assert.equal(mesh.material, fallbackArmor.children[index].material);
      assert.equal(mesh.castShadow, false); assert.equal(mesh.material.map, null);
      assert.equal(mesh.material.transparent, false); assert.equal(mesh.material.side, THREE.FrontSide);
    }
    const bounds = new THREE.Box3().setFromObject(root), size = bounds.getSize(new THREE.Vector3());
    assert.ok(size.x > 0.49 && size.x < 0.52 && size.y > 0.59 && size.y < 0.62 && size.z < 0.3);
    assert.deepEqual(new THREE.Box3().setFromObject(damaged), bounds);
    assert.equal(firstHit(root, [0, 0.25, 1], [0, 0, -1]), undefined);
    for (const x of [-0.133, 0.133]) {
      assert.equal(firstHit(root, [x, 0.27, 1], [0, 0, -1])?.object.name, 'armor-vest-fabric');
      assert.equal(firstHit(root, [x, 1, 0], [0, -1, 0])?.object.name, 'armor-vest-fabric');
    }
    for (const z of [-1, 1]) {
      assert.equal(firstHit(root, [0, 0, z], [0, 0, -z])?.object.name, 'armor-vest-plates');
      assert.equal(firstHit(root, [0, 0.086, z], [0, 0, -z])?.object.name, 'armor-vest-identity');
    }
    for (const [x, y] of [[-0.063, -0.015], [0.058, -0.100], [0.103, 0.060]]) {
      assert.equal(firstHit(root, [x, y, 1], [0, 0, -1])?.object.name, 'armor-vest-plates');
      assert.equal(firstHit(damaged, [x, y, 1], [0, 0, -1])?.object.name, 'armor-vest-bullet-marks');
    }
    for (const x of [-0.098, 0.098]) assert.ok(firstHit(root, [x, -0.22, 1], [0, 0, -1])?.point.z > 0.13);
  });

  await t.test('preloaded CRT preserves its exact support envelope, opaque cover, screen clearance, and shadow policy', () => {
    const { group, body } = crtFixture(), second = crtFixture();
    const names = expectedParts.crt;
    for (const [index, mesh] of group.children.entries()) {
      assert.equal(mesh.geometry, getAuthoredSupplyGeometry('crt', names[index]));
      assert.equal(mesh.geometry, second.group.children[index].geometry);
      assert.notEqual(mesh.geometry, fallbackCrt.group.children[index].geometry);
      assert.equal(mesh.material, fallbackCrt.group.children[index].material);
      assert.equal(mesh.material.transparent, false); assert.equal(mesh.material.map, null);
    }
    const bounds = new THREE.Box3().setFromObject(group);
    for (const [axis, min, max] of [['x', -0.5, 0.5], ['y', -0.305, 0.295], ['z', -0.3025, 0.25]]) {
      near(bounds.min[axis], min, `CRT minimum ${axis}`); near(bounds.max[axis], max, `CRT maximum ${axis}`);
    }
    assert.equal(body.castShadow, true); assert.equal(group.children.filter(mesh => mesh.castShadow).length, 1);
    for (const x of [-0.33, 0.33]) near(firstHit(group, [x, -1, 0], [0, 1, 0])?.point.y, -0.305, 'Console contact');
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.45, 0.04), new THREE.MeshStandardMaterial());
    glass.position.set(0.05, 0, -0.27); group.add(glass);
    for (const x of [-0.33, -0.14, 0.05, 0.24, 0.43]) for (const y of [-0.215, 0, 0.215]) {
      assert.equal(firstHit(group, [x, y, -1], [0, 0, 1])?.object, glass);
    }
    for (const x of [-0.25, 0, 0.25]) for (const y of [-0.205, -0.055, 0.095]) {
      assert.ok(firstHit(body, [x, y, 1], [0, 0, -1]), 'Rear vent gaps never create a sightline through solid cover');
    }
    const budget = crtHousingBudget();
    assert.equal(budget.draws, 2); assert.ok(budget.triangles < 800); assert.equal(budget.textureBytes, 0);
  });

  await t.test('preloaded ammo cases keep the floor datum, cached labels, movable supply indicator, and custom-size fallback', () => {
    const config = { ...AMMO_SUPPLY_CACHES[0], position: { x: 0, y: 0, z: 0 } };
    const resources = createResources();
    const first = buildAmmoBox(config, resources), second = buildAmmoBox(config, resources);
    let renderedTriangles = 0;
    for (const mesh of first.mesh.children) renderedTriangles += triangles(mesh.geometry) * (mesh.isInstancedMesh ? mesh.count : 1);
    assert.equal(first.mesh.children.length, 5); assert.ok(renderedTriangles <= 724, `${renderedTriangles} ammo triangles`);
    for (const name of expectedParts.ammo) {
      const mesh = first.mesh.getObjectByName(name);
      assert.equal(mesh.geometry, getAuthoredSupplyGeometry('ammo', name));
      assert.equal(mesh.geometry, second.mesh.getObjectByName(name).geometry);
      assert.equal(mesh.material, second.mesh.getObjectByName(name).material);
      assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, true);
    }
    const bounds = new THREE.Box3().setFromObject(first.mesh);
    near(bounds.min.y, 0, 'Ammo feet sit on the registered floor'); near(bounds.max.y, 0.34, 'Handle height');
    near(bounds.min.x, -0.329, 'Ammo width minimum'); near(bounds.max.x, 0.329, 'Ammo width maximum');
    near(bounds.min.z, -0.149, 'Ammo depth minimum'); near(bounds.max.z, 0.168, 'Ammo latch depth maximum');
    assert.equal(first.indicator.geometry, resources.box);
    assert.equal(first.indicator.material, resources.indicator);
    assert.equal(first.indicatorWidth, 0.64 * 0.53);
    assert.equal(first.mesh.getObjectByName('ammo-case-lid-and-front-labels').geometry, resources.plane);
    const custom = buildAmmoBox({ ...config, width: 0.50 }, resources);
    assert.notEqual(custom.mesh.getObjectByName('ammo-case-body-and-lid').geometry,
      getAuthoredSupplyGeometry('ammo', 'ammo-case-body-and-lid'), 'A catalog for one size cannot distort custom supply boxes');
  });

  await t.test('Blender refinements create actual recessed surfaces and chamfered silhouettes in the shipped geometry', () => {
    const health = createHealthPickupModel(), armor = createArmorPickupModel(), crt = crtFixture();
    const lidFrom = [0.032, 0.3, 0.032], down = [0, -1, 0];
    const oldLid = firstHit(fallbackHealth, lidFrom, down), lid = firstHit(health, lidFrom, down);
    assert.equal(lid.object.name, 'medical-case-shell');
    assert.ok(oldLid.point.y - lid.point.y > 0.0005, 'The molded lid has a real depression beside the medical cross');
    for (const side of [-1, 1]) {
      const centerX = side * 0.098, edgeX = centerX + side * 0.064;
      const cornerFrom = [edgeX, -0.27, 1], front = [0, 0, -1];
      assert.equal(firstHit(fallbackArmor, cornerFrom, front).object.name, 'armor-vest-plates');
      assert.equal(firstHit(armor, cornerFrom, front).object.name, 'armor-vest-fabric', 'Clipped pouch corners expose the backing fabric');
      const face = firstHit(armor, [centerX, -0.22, 1], front);
      const chamfer = firstHit(armor, [edgeX, -0.22, 1], front);
      assert.equal(chamfer.object.name, 'armor-vest-plates');
      assert.ok(face.point.z - chamfer.point.z > 0.001 && face.point.z - chamfer.point.z < 0.0041);
      assert.ok(Math.abs(chamfer.face.normal.x) > 0.5, 'The pouch highlight follows a physical sloping face');
    }
    for (const x of [-0.272, 0.272]) {
      const from = [x, -0.025, 1], front = [0, 0, -1];
      const oldRear = firstHit(fallbackCrt.group, from, front), rim = firstHit(crt.group, from, front);
      assert.ok(rim.point.z - oldRear.point.z > 0.004, 'The vent rim stands above the original closed rear shell');
      assert.ok(Math.abs(rim.face.normal.x) > 0.2, 'The new vent rim has a tapered shoulder');
    }
    const ammo = buildAmmoBox(localAmmoConfig, createResources()).mesh;
    for (const x of [-0.2496, 0.2496]) {
      const centerFrom = [x, 0.22, 1], front = [0, 0, -1];
      assert.equal(firstHit(fallbackAmmo, centerFrom, front).object.name, 'ammo-case-handle-and-latches');
      const well = firstHit(ammo, centerFrom, front), rim = firstHit(ammo, [x + Math.sign(x) * 0.014, 0.22, 1], front);
      assert.equal(well.object.name, 'ammo-case-feet-and-seal');
      assert.equal(rim.object.name, 'ammo-case-handle-and-latches');
      near(rim.point.z - well.point.z, 0.003, 'Ammo latch well depth');
    }
  });

  await t.test('an authored ammo case remains solid through partial collection, checkpoint restore, depletion, and reset', () => {
    Colliders.clear(); Architecture.clear();
    const config = { ...AMMO_SUPPLY_CACHES[0], position: { x: 0, y: 0, z: 0 }, floorY: 0 };
    const world = new THREE.Group(), player = { pos: new THREE.Vector3(0, 1.72, 1), _eyeH: 1.72 };
    const supplies = createAmmoSupplies([config]);
    supplies.init({ world, player, canInteract: () => true }); supplies.setZone(config.zone);
    const entry = supplies.list[0], geometry = entry.mesh.children.map(mesh => mesh.geometry), collider = entry.collider;
    const bounds = new THREE.Box3().setFromObject(entry.mesh);
    assert.deepEqual(collider.min, bounds.min); assert.deepEqual(collider.max, bounds.max);
    assert.ok(entry.interactionPosition.y > bounds.max.y);
    const held = { current: 'pistol', loaded: 3, reserve: 47 };
    const accept = amount => { const accepted = Math.min(amount, 48 - held.reserve); held.reserve += accepted; return accepted; };
    assert.equal(supplies.findNearest(held), entry); assert.equal(supplies.pickup(entry, held, accept), 1);
    const partial = supplies.snapshot();
    near(entry.indicator.scale.x, entry.indicatorWidth * 115 / 120, 'Partial stock updates the existing indicator');
    supplies.reset(); assert.equal(supplies.restore(partial), true); supplies.setZone(config.zone);
    assert.equal(entry.remainingUnits, 115);
    held.reserve = 0;
    assert.equal(supplies.pickup(entry, held, accept), 23);
    assert.equal(entry.indicator.visible, false); assert.equal(entry.mesh.visible, true);
    supplies.reset();
    assert.equal(entry.indicator.visible, true); assert.equal(entry.mesh.visible, true);
    assert.equal(entry.collider, collider); assert.ok(Colliders.list.includes(collider));
    assert.deepEqual(entry.mesh.children.map(mesh => mesh.geometry), geometry);
    assert.equal(held.loaded, 3, 'Presentation never refills the loaded magazine');
  });
});

test('supplies loader failures stay atomic, preserve fallback, and permit a successful retry', async t => {
  const catalog = await readCatalog();
  const cases = [
    ['wrong version', data => { data.version = 2; }],
    ['missing required part', data => { data.models.health.parts.pop(); }],
    ['duplicate part name', data => { data.models.health.parts[1].name = data.models.health.parts[0].name; }],
    ['nonfinite position', data => { data.models.health.parts[0].positions[0] = NaN; }],
    ['truncated normals', data => { data.models.armor.parts[0].normals.pop(); }],
    ['out-of-range index', data => { data.models.crt.parts[0].indices[0] = 999999; }],
    ['excess geometry', data => {
      const part = data.models.health.parts[0];
      part.positions = Array.from({ length: 8 }, () => part.positions).flat();
      part.normals = Array.from({ length: 8 }, () => part.normals).flat();
    }],
  ];
  for (const [label, corrupt] of cases) await t.test(label, async () => {
    const isolated = await freshLoader(), invalid = globalThis.structuredClone(catalog);
    corrupt(invalid);
    const failure = await isolated.loadAuthoredSupplyProps({ loader: async () => invalid });
    assert.equal(failure.state, 'fallback');
    for (const [model, names] of Object.entries(expectedParts)) {
      for (const name of names) assert.equal(isolated.getAuthoredSupplyGeometry(model, name), null, 'No partial catalog leaks through failure');
    }
    const retry = await isolated.loadAuthoredSupplyProps({ loader: async () => catalog });
    assert.equal(retry.state, 'ready');
    assert.ok(isolated.getAuthoredSupplyGeometry('health', expectedParts.health[0]));
  });
});

test('a timed-out supplies load cannot overwrite a later successful retry', async () => {
  const isolated = await freshLoader(), catalog = await readCatalog();
  let completeSlow;
  const slow = new Promise(resolve => { completeSlow = resolve; });
  const timedOut = await isolated.loadAuthoredSupplyProps({ loader: () => slow, timeoutMs: 1 });
  assert.equal(timedOut.state, 'fallback');
  assert.equal(isolated.getAuthoredSupplyGeometry('health', expectedParts.health[0]), null);
  assert.equal((await isolated.loadAuthoredSupplyProps({ loader: async () => catalog })).state, 'ready');
  const geometry = isolated.getAuthoredSupplyGeometry('health', expectedParts.health[0]);
  completeSlow(globalThis.structuredClone(catalog));
  await slow; await Promise.resolve(); await Promise.resolve();
  assert.equal(isolated.getAuthoredSupplyPropsStatus().state, 'ready');
  assert.equal(isolated.getAuthoredSupplyGeometry('health', expectedParts.health[0]), geometry);
});
