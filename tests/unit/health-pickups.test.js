import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, PerspectiveCamera, Vector3 } from 'three';
import { HEALTH_SUPPLIES } from '../../src/game/health-supply-data.js';
import { ZONE_WAVE_CONFIG } from '../../src/game/mission-data.js';
import { createLightBudget } from '../../src/render/lighting.js';
import { createHealthPickupHarness } from './helpers/health-pickup-harness.js';
import { DIFFICULTY_LEVELS } from '../../src/game/difficulty.js';

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${label}: ${actual} != ${expected}`);

function place(harness, x, y, z) {
  harness.Player.pos.set(x, y + harness.Player._eyeH, z);
}

function advance(harness, dt = 1 / 120) {
  harness.GameTime.elapsed += dt;
  harness.HealPickups.update(dt);
}

function isolated(amount = 30) {
  const harness = createHealthPickupHarness();
  const pickup = harness.HealPickups.spawn(0, 14, 0, amount, 'roof', 'test-roof-pack');
  harness.HealPickups.setZone('roof');
  place(harness, 0, 14, 0);
  return { ...harness, pickup };
}

test('authored health supplies have unique identities and finite positive healing amounts', () => {
  assert.equal(HEALTH_SUPPLIES.length, 15, 'the original thirteen supplies and two northern roof packs');
  assert.equal(new Set(HEALTH_SUPPLIES.map(supply => supply.id)).size, HEALTH_SUPPLIES.length);
  for (const supply of HEALTH_SUPPLIES) {
    assert.equal(typeof supply.id, 'string');
    assert.ok(supply.id.length > 0);
    assert.ok(Object.hasOwn(ZONE_WAVE_CONFIG, supply.zone), `${supply.id}: authored mission zone`);
    assert.ok([supply.x, supply.y, supply.z, supply.amount].every(Number.isFinite), supply.id);
    assert.ok(Number.isSafeInteger(supply.amount) && supply.amount > 0 && supply.amount <= 100, supply.id);
  }
  const roof = HEALTH_SUPPLIES.filter(supply => supply.zone === 'roof');
  assert.equal(roof.length, 4);
  assert.ok(roof.every(supply => supply.amount === 30));
});

test('actual mission initialization creates each authored record once with its exact identity and position', () => {
  const h = createHealthPickupHarness();
  h.initMission();
  assert.equal(h.HealPickups.list.length, HEALTH_SUPPLIES.length);
  for (const [index, config] of HEALTH_SUPPLIES.entries()) {
    const pickup = h.HealPickups.list[index];
    assert.equal(pickup.id, config.id);
    assert.equal(pickup.zone, config.zone);
    assert.equal(pickup.amount, config.amount);
    near(pickup.mesh.position.x, config.x, `${config.id}: x`);
    near(pickup.mesh.position.y, config.y + 0.18, `${config.id}: mesh floor offset`);
    near(pickup.baseY, config.y + 0.18, `${config.id}: stable bob datum`);
    near(pickup.mesh.position.z, config.z, `${config.id}: z`);
    assert.equal(pickup.active, true);
    assert.equal(pickup.mesh.visible, config.zone === 'apartment');
    assert.equal(pickup.halo.visible, pickup.mesh.visible);
  }
  const entries = Array.from(h.HealPickups.list), objects = [...h.World.children];
  h.initMission(); h.initMission();
  assert.deepEqual(Array.from(h.HealPickups.list), entries, 'repeat startup does not replace pickup records');
  assert.deepEqual(h.World.children, objects, 'repeat startup does not add meshes or lights');
  assert.equal(h.World.children.length, HEALTH_SUPPLIES.length * 2);
  assert.equal(h.calls.zoneListeners.length, 1);
  assert.deepEqual(h.calls.ammoZones, ['apartment']);
  assert.deepEqual(h.calls.checkpoints, ['apartment']);
  assert.deepEqual(h.calls.waves, ['apartment']);
  assert.equal(h.calls.domEvents.length, 1);
  assert.equal(h.calls.domEvents[0].id, 'restartbutton');
  assert.equal(h.calls.domEvents[0].type, 'click');
  assert.equal(h.calls.windowEvents.length, 1);
  assert.equal(h.calls.windowEvents[0].type, 'keydown');
  assert.equal(h.calls.chimes, 0, 'initialization does not collect any supply');
});

test('starting a configured run scales finite health supplies once and retries preserve their scaled value', () => {
  for (const profile of DIFFICULTY_LEVELS) {
    const h = createHealthPickupHarness({ difficulty: profile.id });
    h.initMission();
    const objects = [...h.World.children];
    h.HealPickups.reset(); h.HealPickups.reset();
    for (const [index, supply] of HEALTH_SUPPLIES.entries()) {
      const pickup = h.HealPickups.list[index];
      const expected = Math.max(1, Math.round(supply.amount * profile.health));
      assert.equal(pickup.baseAmount, supply.amount);
      assert.equal(pickup.amount, expected);
      pickup.active = false;
      h.HealPickups.restoreZone(supply.zone);
      assert.equal(pickup.active, true);
      assert.equal(pickup.amount, expected, 'retries cannot compound difficulty scaling');
    }
    assert.deepEqual(h.World.children, objects, 'difficulty changes availability without duplicating caches');
  }
});

test('full health leaves a nearby pack active through repeated animation updates', () => {
  const h = isolated();
  for (let tick = 0; tick < 120; tick++) advance(h);
  assert.equal(h.Player.health, 100);
  assert.equal(h.pickup.active, true);
  assert.equal(h.pickup.mesh.visible, true);
  assert.equal(h.pickup.halo.visible, true);
  assert.deepEqual(h.calls.health, []);
  assert.deepEqual(h.calls.messages, []);
  assert.equal(h.calls.chimes, 0);
});

test('legacy spawn calls retain their default amount and optional zone and identity', () => {
  const h = createHealthPickupHarness();
  const pickup = h.HealPickups.spawn(0, 4, 0);
  assert.equal(pickup.amount, 25);
  assert.equal(pickup.zone, null);
  assert.equal(pickup.id, null);
  h.HealPickups.setZone('roof');
  assert.equal(pickup.mesh.visible, true, 'an explicitly unscoped pickup remains visible');
  place(h, 0, 4, 0); h.Player.health = 80;
  advance(h);
  assert.equal(h.Player.health, 100);
  assert.equal(pickup.active, false);
});

test('collection grants exactly the needed health, clamps at 100 and consumes the pack only once', () => {
  for (const [initial, amount, expected] of [[1, 25, 26], [50, 30, 80], [89, 30, 100], [99, 35, 100], [99.5, 30, 100]]) {
    const h = isolated(amount);
    h.Player.health = initial;
    advance(h);
    assert.equal(h.Player.health, expected);
    assert.deepEqual(h.calls.health, [expected]);
    assert.deepEqual(h.calls.messages, [[`+${Math.round(expected - initial)} HP`, 1.2]],
      'The HUD rounds fractional recovery while actual health preserves the exact gain');
    assert.equal(h.calls.chimes, 1, 'the audio service is a counter only');
    assert.equal(h.pickup.active, false);
    assert.equal(h.pickup.mesh.visible, false);
    assert.equal(h.pickup.halo.visible, false);
    advance(h);
    assert.equal(h.Player.health, expected);
    assert.equal(h.calls.chimes, 1);
    assert.equal(h.calls.health.length, 1);
  }
});

test('two adjacent packs cannot consume the second after the first fills health', () => {
  const h = isolated();
  const second = h.HealPickups.spawn(0, 14, 0, 30, 'roof', 'test-roof-second');
  h.Player.health = 95;
  advance(h);
  assert.equal(h.Player.health, 100);
  assert.equal(h.pickup.active, false);
  assert.equal(second.active, true);
  assert.equal(second.mesh.visible, true);
  assert.equal(second.halo.visible, true);
  assert.equal(h.calls.chimes, 1);
  h.Player.health = 50;
  advance(h);
  assert.equal(h.Player.health, 80, 'the preserved second pack remains available after later damage');
  assert.equal(second.active, false);
  assert.equal(h.calls.chimes, 2);
});

test('supplies from another zone remain hidden and cannot heal until that zone is active', () => {
  const h = isolated();
  h.Player.health = 50;
  h.HealPickups.setZone('stairwell');
  advance(h);
  assert.equal(h.Player.health, 50);
  assert.equal(h.pickup.active, true);
  assert.equal(h.pickup.mesh.visible, false);
  assert.equal(h.pickup.halo.visible, false);
  assert.equal(h.calls.chimes, 0);
  h.HealPickups.setZone('roof');
  advance(h);
  assert.equal(h.Player.health, 80);
  assert.equal(h.pickup.active, false);
});

test('a dead player cannot consume a nearby supply', () => {
  const h = isolated();
  h.Player.health = 40;
  h.PlayerState.dead = true;
  advance(h);
  assert.equal(h.Player.health, 40);
  assert.equal(h.pickup.active, true);
  assert.equal(h.calls.chimes, 0);
  h.PlayerState.dead = false;
  advance(h);
  assert.equal(h.Player.health, 70);
  assert.equal(h.pickup.active, false);
});

test('collection requires proximity in all three dimensions, including separation between floors', () => {
  const h = isolated();
  h.Player.health = 40;
  place(h, 1, 14, 0);
  advance(h);
  assert.equal(h.pickup.active, true, 'a pack one metre away is outside collection range');
  place(h, 0, 11.6, 0);
  advance(h);
  assert.equal(h.pickup.active, true, 'matching x/z on the preceding landing is not enough');
  assert.equal(h.Player.health, 40);
  assert.equal(h.calls.chimes, 0);
  place(h, 0.75, 14, 0);
  advance(h);
  assert.equal(h.Player.health, 70);
  assert.equal(h.pickup.active, false);
});

test('changing eye height preserves the same floor-based collection distance', () => {
  for (const eyeHeight of [1.72, 0.95]) {
    const h = isolated();
    h.Player._eyeH = eyeHeight;
    place(h, 0.75, 14, 0);
    h.Player.health = 60;
    advance(h);
    assert.equal(h.Player.health, 90);
    assert.equal(h.pickup.active, false);
  }
});

test('restoring a zone reuses its records and graphics while leaving other spent zones unchanged', () => {
  const h = isolated();
  const other = h.HealPickups.spawn(4, 14, 0, 25, 'balcony', 'test-other-zone');
  h.HealPickups.setZone('balcony');
  place(h, 4, 14, 0); h.Player.health = 50;
  advance(h);
  assert.equal(other.active, false);
  const records = Array.from(h.HealPickups.list), objects = [...h.World.children];
  const resources = records.map(pickup => ({
    mesh: pickup.mesh, halo: pickup.halo, children: [...pickup.mesh.children],
    geometries: pickup.mesh.children.map(mesh => mesh.geometry),
    materials: pickup.mesh.children.map(mesh => mesh.material),
  }));
  for (let retry = 0; retry < 5; retry++) {
    place(h, 0, 14, 0); h.Player.health = 40;
    const chimes = h.calls.chimes;
    h.HealPickups.restoreZone('roof');
    h.HealPickups.restoreZone('roof');
    assert.equal(h.Player.health, 40, 'restoring availability does not grant health by itself');
    assert.equal(h.calls.chimes, chimes);
    assert.equal(h.pickup.active, true);
    assert.equal(h.pickup.mesh.visible, true);
    assert.equal(h.pickup.halo.visible, true);
    assert.equal(other.active, false, 'a retry does not refill an earlier zone');
    assert.equal(other.mesh.visible, false);
    assert.equal(other.halo.visible, false);
    advance(h);
    assert.equal(h.Player.health, 70);
    assert.equal(h.pickup.active, false);
  }
  assert.deepEqual(Array.from(h.HealPickups.list), records);
  assert.deepEqual(h.World.children, objects);
  for (const [index, pickup] of records.entries()) {
    const saved = resources[index];
    assert.equal(pickup.mesh, saved.mesh);
    assert.equal(pickup.halo, saved.halo);
    assert.deepEqual(pickup.mesh.children, saved.children);
    assert.ok(pickup.mesh.children.every((mesh, i) => mesh.geometry === saved.geometries[i] && mesh.material === saved.materials[i]),
      'retry never allocates replacement geometry or material resources');
  }
});

test('collection removes the actual pooled health glow and restoration reuses the same lighting resources', () => {
  const h = createHealthPickupHarness(); h.initMission();
  const pickup = h.HealPickups.list.find(value => value.id === 'roof-front-east');
  const otherZone = h.HealPickups.list.find(value => value.id === 'balcony-east');
  h.HealPickups.setZone('roof');
  place(h, 13, 14, -5);
  const scene = new Scene(), camera = new PerspectiveCamera();
  scene.add(h.World); camera.position.copy(h.Player.pos);
  // Both zones are allowed by the practical-light selector, and the balcony
  // pack is within its distance budget. Health availability must silence it;
  // relying on source.visible or the zone selector would hide the original bug.
  const budget = createLightBudget(scene, { activeZones: new Set(['roof', 'balcony', 'stairwell']) });
  const sourcePosition = new Vector3();
  const emits = source => {
    source.getWorldPosition(sourcePosition);
    return budget.pool.some(light => light.intensity > 0 && light.position.distanceTo(sourcePosition) < 1e-6);
  };
  assert.ok(otherZone.halo.getWorldPosition(sourcePosition).distanceTo(camera.position) < otherZone.halo.distance + 12);
  for (const entry of h.HealPickups.list) {
    assert.equal(entry.halo.userData.zone, entry.zone);
    near(entry.halo.intensity, entry.zone === 'roof' ? 0.35 : 0, `${entry.id}: availability intensity`);
  }
  const worldObjects = [...h.World.children], sceneObjects = [...scene.children], pool = [...budget.pool];
  const mesh = pickup.mesh, halo = pickup.halo;
  const geometry = [...mesh.children].map(part => part.geometry), material = [...mesh.children].map(part => part.material);
  for (let retry = 0; retry < 3; retry++) {
    h.HealPickups.restoreZone('roof'); h.Player.health = 40;
    budget.update(camera);
    assert.equal(halo.visible, false, 'the budget renders pooled lights, not the authored source');
    assert.equal(emits(halo), true, 'an available pack lights its own physical position');
    assert.equal(emits(otherZone.halo), false, 'a nearby pack from another zone contributes no pooled glow');
    assert.equal(budget.snapshot().active, 1);
    near(budget.pool.find(light => light.intensity > 0).intensity, 0.35 * 1.8, 'copied practical intensity');

    advance(h); budget.update(camera);
    assert.equal(h.Player.health, 70); assert.equal(pickup.active, false);
    assert.equal(halo.intensity, 0); assert.equal(emits(halo), false);
    assert.ok(budget.pool.every(light => light.intensity === 0), 'collecting the sole nearby roof pack extinguishes its pooled light');

    h.HealPickups.restoreZone('roof'); budget.update(camera);
    assert.equal(pickup.active, true); near(halo.intensity, 0.35, 'restored source intensity');
    assert.equal(emits(halo), true); assert.equal(emits(otherZone.halo), false);
    assert.equal(pickup.mesh, mesh); assert.equal(pickup.halo, halo);
    assert.deepEqual(h.World.children, worldObjects); assert.deepEqual(scene.children, sceneObjects);
    assert.deepEqual(budget.pool, pool);
    assert.equal(budget.snapshot().sources, HEALTH_SUPPLIES.length);
    assert.equal(budget.snapshot().budget, pool.length);
    assert.ok(mesh.children.every((part, index) => part.geometry === geometry[index] && part.material === material[index]));
  }
  h.HealPickups.setZone('balcony'); budget.update(camera);
  assert.equal(halo.intensity, 0); assert.equal(emits(halo), false, 'a roof pack cannot glow after leaving its zone');
  assert.equal(emits(otherZone.halo), true, 'the newly active zone uses its own existing source');
  assert.deepEqual(budget.pool, pool); assert.deepEqual(scene.children, sceneObjects);
});
