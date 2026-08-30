import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRoofTaskLighting } from '../../src/render/roof-task-lighting.js';
import { createLightBudget } from '../../src/render/lighting.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { ROOF } from '../../src/world/layout.js';

function fixture() {
  const scene = new THREE.Scene(), world = new THREE.Group(), environment = new THREE.Group();
  scene.add(world); world.add(environment);
  const metal = new THREE.MeshStandardMaterial({ metalness: 0.6, roughness: 0.85 }); metal.userData.surfaceMeters = 1.6;
  const bulbMaterial = new THREE.MeshStandardMaterial({ emissive: 0xe1b578, emissiveIntensity: 1.1 });
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.26, 0.10), metal);
  housing.position.set(6.4, 16, -9.85); housing.castShadow = true; world.add(housing);
  const globeGeometry = new THREE.SphereGeometry(0.06, 12, 8);
  const bulb = new THREE.Mesh(globeGeometry, bulbMaterial); bulb.position.set(6.4, 15.99, -9.75); world.add(bulb);
  const source = new THREE.PointLight(0xe1bb80, 1.5, 12, 1.8); source.position.copy(bulb.position); source.userData.zone = 'roof'; world.add(source);
  const other = new THREE.Mesh(globeGeometry, bulbMaterial); other.position.set(-14.8, 15.99, -3.7); world.add(other);
  const roofMeshes = [housing, bulb, source, other];
  return { scene, world, environment, metal, bulbMaterial, housing, bulb, source, other, roofMeshes,
    create: options => createRoofTaskLighting(environment, { roofMeshes, metalMaterial: metal, ...options }) };
}

test('the existing service fixture is reused and the exit source stays within the fixed eight-light pool', () => {
  const f = fixture(), controller = f.create();
  const group = f.environment.getObjectByName('roof-task-lighting'), exit = group.getObjectByName('roof-exit-task-light');
  assert.deepEqual(f.housing.position.toArray(), [-0.06, 16.05, -9.95]);
  assert.deepEqual(f.bulb.position.toArray(), [-0.06, 16.04, -9.77]);
  assert.deepEqual(f.source.position.toArray(), [-0.06, 16.04, -9.64]);
  assert.equal(f.source.intensity, 2); assert.equal(f.source.distance, 7.5); assert.equal(f.source.decay, 2);
  assert.equal(f.other.material, f.bulbMaterial, 'other authored bulbs keep their shared finish');
  assert.equal(exit.visible, false); assert.equal(exit.castShadow, false); assert.equal(exit.userData.zone, 'roof');
  const zones = { activeZones: new Set(['roof']) };
  const budget = createLightBudget(f.scene, zones, 8);
  budget.update({ position: new THREE.Vector3(22, 15.6, -4) });
  assert.equal(budget.pool.length, 8); assert.equal(budget.snapshot().sources, 2);
  assert.ok(budget.pool.some(light => light.position.distanceTo(exit.position) < 1e-6 && light.intensity === 2.7));
  assert.equal(f.source.visible, false);
  zones.activeZones = new Set(['apartment']); budget.update({ position: new THREE.Vector3(22, 15.6, -4) });
  assert.equal(budget.pool.filter(light => light.intensity > 0).length, 0);
  controller.dispose();
});

test('fixture geometry is mounted outside the walk route, clear of the sign/coping, with sources outside the solid hardware', () => {
  const f = fixture(), controller = f.create();
  const group = f.environment.getObjectByName('roof-task-lighting'), hardware = group.getObjectByName('roof-task-lamp-hardware');
  const positions = hardware.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    if (x > 20) {
      assert.ok(x > 24.55 && x <= ROOF.x2 - 0.11 + 1e-5, 'exit hardware is confined to the parapet mount');
      assert.ok(y > ROOF.floorY + 0.7 && y < ROOF.floorY + 1.2, 'fixture clears the roof and coping');
      assert.ok(z < -3.3 && z > -3.8, 'fixture stays clear of the open scaffold threshold');
      assert.ok(x - ROOF.route.at(-2)[0] > 2.5, 'the walk lane remains unobstructed');
    } else {
      assert.ok(x < 0.14, 'service hood remains left of the nearest jamb/header');
      assert.ok(y < 16.27 && y > 15.8, 'service cage stays below the sign and above the walking head clearance');
      assert.ok(z >= -10.01 && z <= -9.63, 'service plate touches the real house face');
    }
  }
  const probeMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const probe = new THREE.Mesh(hardware.geometry, probeMaterial);
  for (const [origin, direction] of [
    [new THREE.Vector3(-0.06, 16.04, -9.64), new THREE.Vector3(0, 0, 1)],
    [new THREE.Vector3(24.60, 14.95, -3.55), new THREE.Vector3(-1, 0, 0)],
  ]) assert.equal(new THREE.Raycaster(origin, direction, 0, 0.4).intersectObject(probe).length, 0);
  assert.equal(hardware.castShadow, false); assert.equal(hardware.userData.collider, null);
  assert.equal(controller.snapshot().addedShadowCasters, 0); assert.equal(controller.snapshot().newShadowMaps, 0);
  probeMaterial.dispose(); controller.dispose();
});

test('A/B toggling restores original transforms/material/light values and returns ballistic entries to refresh', () => {
  const f = fixture(), original = { housing: f.housing.position.clone(), bulb: f.bulb.position.clone(), light: f.source.position.clone(), color: f.source.color.clone() };
  const controller = f.create(), ballistics = createBallisticWorld({ colliders: null }); ballistics.rebuild(f.world);
  const oldOrigin = new THREE.Vector3(6.4, 16, -8), direction = new THREE.Vector3(0, 0, -1);
  assert.equal(ballistics.raycast(oldOrigin, direction, 3), null);
  const changed = controller.setEnabled(false);
  assert.deepEqual(changed, [f.housing, f.bulb]);
  for (const mesh of changed) ballistics.updateObject(mesh);
  assert.ok(ballistics.raycast(oldOrigin, direction, 3), 'restored geometry has refreshed bullet/sight data');
  assert.ok(f.housing.position.equals(original.housing)); assert.ok(f.bulb.position.equals(original.bulb)); assert.ok(f.source.position.equals(original.light));
  assert.equal(f.bulb.material, f.bulbMaterial); assert.ok(f.source.color.equals(original.color));
  assert.equal(f.source.intensity, 1.5); assert.equal(f.source.distance, 12); assert.equal(f.source.decay, 1.8);
  assert.equal(controller.snapshot().exit.intensity, 0);
  assert.deepEqual(controller.setEnabled(false), []);
  for (const mesh of controller.setEnabled(true)) ballistics.updateObject(mesh);
  assert.equal(ballistics.raycast(oldOrigin, direction, 3), null);
  ballistics.clear(); controller.dispose();
});

test('the new pass adds bounded geometry but no textures or per-frame work and disposes only its own resources', () => {
  const f = fixture(); let sharedGeometryDisposals = 0, sharedMaterialDisposals = 0;
  f.bulb.geometry.addEventListener('dispose', () => sharedGeometryDisposals++);
  f.metal.addEventListener('dispose', () => sharedMaterialDisposals++);
  f.bulbMaterial.addEventListener('dispose', () => sharedMaterialDisposals++);
  const controller = f.create(), stats = controller.snapshot();
  const group = f.environment.getObjectByName('roof-task-lighting');
  let ownedGeometryDisposals = 0, ownedMaterialDisposals = 0;
  group.getObjectByName('roof-task-lamp-hardware').geometry.addEventListener('dispose', () => ownedGeometryDisposals++);
  group.getObjectByName('roof-exit-task-lamp').material.addEventListener('dispose', () => ownedMaterialDisposals++);
  assert.equal(stats.addedMeshes, 2); assert.equal(stats.addedTriangles, 324);
  assert.ok(stats.geometryBytes < 12 * 1024); assert.equal(stats.addedTextures, 0); assert.equal(stats.perFrameWork, 0);
  assert.equal(stats.extraFullscreenPasses, 0);
  assert.equal(stats.addedLightSources, 1); assert.equal(stats.retunedLightSources, 1);
  controller.dispose(); controller.dispose(); controller.setEnabled(true);
  assert.equal(f.environment.children.length, 0);
  assert.equal(ownedGeometryDisposals, 1); assert.equal(ownedMaterialDisposals, 1);
  assert.equal(sharedGeometryDisposals, 0); assert.equal(sharedMaterialDisposals, 0);
  assert.equal(f.bulb.material, f.bulbMaterial); assert.equal(controller.snapshot().status, 'disposed');
});

test('ambiguous or missing legacy fixtures are reported without moving unrelated objects or duplicating the service light', () => {
  const f = fixture(), duplicate = f.source.clone(); f.world.add(duplicate);
  const controller = f.create({ roofMeshes: [...f.roofMeshes, duplicate] });
  assert.equal(controller.snapshot().status, 'partial'); assert.equal(controller.snapshot().legacyMatches.light, 2);
  assert.equal(controller.snapshot().retunedLightSources, 0); assert.equal(controller.snapshot().addedLightSources, 1);
  assert.deepEqual(f.housing.position.toArray(), [6.4, 16, -9.85]); assert.equal(f.bulb.material, f.bulbMaterial);
  assert.equal(f.source.intensity, 1.5); assert.equal(duplicate.intensity, 1.5);
  controller.dispose();
});

test('late development installation can register the one new source idempotently', () => {
  const f = fixture(), zones = { activeZones: new Set(['roof']) }, budget = createLightBudget(f.scene, zones, 8);
  const controller = f.create(); controller.registerLights(budget); controller.registerLights(budget);
  assert.equal(budget.snapshot().sources, 2);
  budget.update({ position: new THREE.Vector3(22, 15.6, -4) });
  assert.equal(budget.pool.length, 8); assert.ok(budget.pool.some(light => light.intensity > 0));
  controller.dispose();
});
