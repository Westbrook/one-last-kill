import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, PerspectiveCamera, PointLight, Mesh, Group, MeshStandardMaterial, Vector3 } from 'three';
import { VIEW_MODEL_LAYER, getViewModelMuzzle, prepareViewModel, shareViewModelLighting, renderWithViewModel } from '../../src/render/viewmodel.js';

test('muzzle effects follow the visible barrel through hip-fire and aim offsets', () => {
  const camera = new PerspectiveCamera(), hands = new Group(), weapon = new Group();
  camera.position.set(10, 2, -3);
  hands.position.set(0.22, -0.22, -0.36);
  weapon.rotation.y = Math.PI / 2;
  weapon.scale.setScalar(1.3);
  weapon.userData.muzzle = [0.201, 0.04, 0];
  camera.add(hands); hands.add(weapon);
  const result = new Vector3();
  assert.equal(getViewModelMuzzle(weapon, result), result);
  assert.ok(result.distanceTo(new Vector3(10.22, 1.832, -3.6213)) < 1e-8);
  hands.position.x = 0;
  getViewModelMuzzle(weapon, result);
  assert.ok(Math.abs(result.x - 10) < 1e-8, 'aim position follows the hand transform immediately');
  camera.rotation.y = Math.PI / 2;
  getViewModelMuzzle(weapon, result);
  assert.ok(result.distanceTo(new Vector3(9.3787, 1.832, -3)) < 1e-8);
});

test('missing or invalid barrel tips do not corrupt the effect position', () => {
  const model = new Group(), position = new Vector3(1, 2, 3);
  for (const muzzle of [undefined, [], [NaN, 0, 0]]) {
    model.userData.muzzle = muzzle;
    assert.equal(getViewModelMuzzle(model, position), null);
    assert.deepEqual(position.toArray(), [1, 2, 3]);
  }
});

function fixture({ failAt = 0 } = {}) {
  const scene = new Scene();
  scene.background = { name: 'sky' };
  const camera = new PerspectiveCamera();
  const calls = [];
  let renders = 0;
  const renderer = {
    autoClear: true,
    shadowMap: { autoUpdate: true },
    info: { autoReset: true, render: { calls: 0 }, reset() { this.render.calls = 0; calls.push('reset-info'); } },
    clearDepth() { calls.push('clear-depth'); },
    render(scene, camera) {
      calls.push({ mask: camera.layers.mask, background: scene.background, clear: this.autoClear, shadows: this.shadowMap.autoUpdate });
      this.info.render.calls += camera.layers.mask === 1 ? 500 : 40;
      if (++renders === failAt) throw new Error('render interrupted');
    },
  };
  return { renderer, scene, camera, calls };
}

test('view-model parts retain depth tests and writes on a dedicated layer', () => {
  const model = new Group();
  const materials = [new MeshStandardMaterial({ depthTest: false, depthWrite: false }), new MeshStandardMaterial()];
  const part = new Mesh(undefined, materials);
  part.castShadow = part.receiveShadow = true;
  model.add(part);
  assert.equal(prepareViewModel(model), model);
  assert.equal(part.layers.mask, 1 << VIEW_MODEL_LAYER);
  assert.equal(part.castShadow, false);
  assert.equal(part.receiveShadow, false);
  for (const material of materials) {
    assert.equal(material.depthTest, true);
    assert.equal(material.depthWrite, true);
  }
});

test('weapon pass clears only depth after rendering the world', () => {
  const { renderer, scene, camera, calls } = fixture();
  const background = scene.background;
  renderWithViewModel(renderer, scene, camera);
  assert.deepEqual(calls, [
    'reset-info',
    { mask: 1, background, clear: true, shadows: true },
    'clear-depth',
    { mask: 1 << VIEW_MODEL_LAYER, background: null, clear: false, shadows: false },
  ]);
  assert.equal(renderer.info.render.calls, 540, 'counts world and weapon draws together');
  assert.equal(scene.background, background);
  assert.equal(camera.layers.mask, 1);
  assert.equal(renderer.autoClear, true);
  assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.equal(renderer.info.autoReset, true);
});

test('render failures restore all pass state before a subsequent frame', () => {
  for (const failAt of [1, 2]) {
    const { renderer, scene, camera } = fixture({ failAt });
    camera.layers.enable(5);
    renderer.shadowMap.autoUpdate = false;
    const mask = camera.layers.mask, background = scene.background;
    assert.throws(() => renderWithViewModel(renderer, scene, camera), /render interrupted/);
    assert.equal(camera.layers.mask, mask);
    assert.equal(scene.background, background);
    assert.equal(renderer.autoClear, true);
    assert.equal(renderer.shadowMap.autoUpdate, false);
    assert.equal(renderer.info.autoReset, true);
  }
});

test('an optional world presentation pass runs once before the separate weapon depth pass', () => {
  const { renderer, scene, camera, calls } = fixture();
  let worldCalls = 0;
  renderWithViewModel(renderer, scene, camera, () => {
    worldCalls++;
    assert.equal(camera.layers.mask, 1, 'postprocessing sees only world geometry');
    renderer.info.render.calls += 506;
    calls.push('present-world');
  });
  assert.equal(worldCalls, 1);
  assert.equal(renderer.info.render.calls, 546);
  assert.deepEqual(calls.slice(0, 3), ['reset-info', 'present-world', 'clear-depth']);
  assert.equal(calls[3].mask, 1 << VIEW_MODEL_LAYER);
  assert.equal(calls[3].background, null);
});

test('a failed presentation callback restores layer, background and pass state', () => {
  const { renderer, scene, camera } = fixture();
  const background = scene.background;
  camera.layers.enable(4);
  const mask = camera.layers.mask;
  assert.throws(() => renderWithViewModel(renderer, scene, camera, () => { throw new Error('presentation failed'); }), /presentation failed/);
  assert.equal(camera.layers.mask, mask);
  assert.equal(scene.background, background);
  assert.equal(renderer.autoClear, true);
  assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.equal(renderer.info.autoReset, true);
});

test('only lighting is shared between world and view-model layers', () => {
  const scene = new Scene(), light = new PointLight(), prop = new Mesh();
  scene.add(light, prop);
  shareViewModelLighting(scene);
  assert.equal(light.layers.mask, 1 | (1 << VIEW_MODEL_LAYER));
  assert.equal(prop.layers.mask, 1);
});
