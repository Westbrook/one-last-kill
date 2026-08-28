import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, PerspectiveCamera, PointLight } from 'three';
import { createLightBudget } from '../../src/render/lighting.js';

test('practical light count stays fixed when a progression fire appears', () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const initial = new PointLight(0xffaa88, 4, 20);
  scene.add(initial);
  const budget = createLightBudget(scene, { activeZones: new Set(['apartment']) });
  const added = new PointLight(0xffdd88, 6, 12);
  scene.add(added);
  budget.register(added);
  budget.register(added);
  budget.update(camera);
  let visiblePointLights = 0;
  scene.traverse(object => { if (object.isPointLight && object.visible) visiblePointLights++; });
  assert.equal(visiblePointLights, 8);
  assert.equal(budget.snapshot().sources, 2);
  assert.equal(initial.visible, false);
  assert.equal(added.visible, false);
});

test('inactive-zone and expired effect lights cannot illuminate another room', () => {
  const scene = new Scene();
  const light = new PointLight(0xffffff, 4, 20);
  light.userData.zone = 'bakery';
  scene.add(light);
  const zones = { activeZones: new Set(['apartment']) };
  const budget = createLightBudget(scene, zones);
  const camera = new PerspectiveCamera();
  budget.update(camera);
  assert.ok(budget.pool.every(point => point.intensity === 0));
  zones.activeZones.add('bakery');
  budget.update(camera);
  assert.ok(budget.pool.some(point => point.intensity > 0));
  light.intensity = 0;
  budget.update(camera);
  assert.ok(budget.pool.every(point => point.intensity === 0));
});
