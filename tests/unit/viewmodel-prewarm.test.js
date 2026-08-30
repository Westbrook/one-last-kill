import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Scene, PerspectiveCamera, Group, Mesh, BoxGeometry, MeshStandardMaterial,
  DataTexture, Texture, PointLight, Vector3, ACESFilmicToneMapping, SRGBColorSpace,
} from 'three';
import { createFirstPersonHands } from '../../src/render/first-person-hands.js';
import { createFirstPersonBat } from '../../src/render/first-person-bat.js';
import { prepareViewModel, shareViewModelLighting, VIEW_MODEL_LAYER } from '../../src/render/viewmodel.js';
import { warmViewModels } from '../../src/render/viewmodel-prewarm.js';

function fixture({ compileGate = null, failAt = null } = {}) {
  const scene = new Scene(), camera = new PerspectiveCamera(82, 16 / 9, 0.05, 300);
  const light = new PointLight(0xffffff, 4), world = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  scene.background = new Texture();
  scene.environment = new Texture();
  scene.environmentIntensity = 0.8;
  camera.position.set(10, 2, 8);
  camera.rotation.y = 0.3;
  camera.layers.enable(4);
  scene.add(world, camera, light);
  shareViewModelLighting(scene);
  const fists = prepareViewModel(createFirstPersonHands()), bat = prepareViewModel(createFirstPersonBat());
  const map = new DataTexture(new Uint8Array([140, 120, 90, 255]), 1, 1);
  const roughness = new DataTexture(new Uint8Array([255, 180, 0, 255]), 1, 1);
  const material = new MeshStandardMaterial({ map, normalMap: map, roughnessMap: roughness });
  const geometry = new BoxGeometry(0.3, 0.1, 0.07);
  const makeGun = name => {
    const model = new Group(); model.name = name;
    model.rotation.y = Math.PI / 2;
    model.scale.setScalar(1.3);
    model.add(new Mesh(geometry, material), new Mesh(geometry, [material, material]));
    return prepareViewModel(model);
  };
  const pistol = makeGun('vm_pistol'), knife = makeGun('vm_knife');
  const vmGroup = new Group(), before = new Group(), after = new Group();
  vmGroup.name = 'weaponViewModel';
  vmGroup.add(before, fists, after);
  camera.add(vmGroup);
  const models = [fists, bat, pistol, knife];
  const target = { name: 'existing-target' };
  const calls = [], compiledMeshes = new Set(), uploadedGeometries = new Set(), initializedTextures = [];
  let currentTarget = target, cubeFace = 3, mipmapLevel = 2, scissorTest = true;
  const renderer = {
    autoClear: true,
    autoClearColor: false,
    autoClearDepth: false,
    autoClearStencil: true,
    shadowMap: { autoUpdate: true, needsUpdate: true, enabled: true },
    info: { autoReset: true },
    xr: { enabled: true },
    toneMapping: ACESFilmicToneMapping,
    toneMappingExposure: 1.25,
    outputColorSpace: SRGBColorSpace,
    getRenderTarget() { return currentTarget; },
    getActiveCubeFace() { return cubeFace; },
    getActiveMipmapLevel() { return mipmapLevel; },
    setRenderTarget(value, face = 0, level = 0) { currentTarget = value; cubeFace = face; mipmapLevel = level; },
    getScissorTest() { return scissorTest; },
    setScissorTest(value) { scissorTest = value; },
    async compileAsync(root, suppliedCamera, targetScene) {
      calls.push('compile');
      assert.equal(root, camera, 'Only camera-held materials are compiled');
      assert.equal(suppliedCamera, camera);
      assert.equal(targetScene, scene, 'Compile against the real lighting and environment');
      assert.equal(currentTarget, null, 'Compile the canvas tone-mapping/output variant');
      assert.equal(camera.layers.mask, 1 << VIEW_MODEL_LAYER);
      assert.equal(scene.background, null);
      assert.equal(targetScene.environment, scene.environment);
      assert.ok(light.layers.test(camera.layers));
      root.traverse(object => { if (object.isMesh) compiledMeshes.add(object); });
      if (compileGate) await compileGate;
      if (failAt === 'compile') throw new Error('compile failed');
    },
    initTexture(texture) {
      calls.push('texture');
      assert.ok(texture.isTexture);
      initializedTextures.push(texture);
      if (failAt === 'texture') throw new Error('texture failed');
    },
    clearDepth() { calls.push('clear-depth'); },
    render(actualScene, actualCamera) {
      calls.push('render');
      assert.equal(actualScene, scene);
      assert.equal(actualCamera, camera);
      assert.equal(currentTarget, null, 'No offscreen target is created or used');
      assert.equal(camera.layers.mask, 1 << VIEW_MODEL_LAYER);
      assert.equal(renderer.autoClear, false);
      assert.equal(renderer.shadowMap.autoUpdate, false);
      assert.equal(renderer.shadowMap.needsUpdate, false);
      assert.equal(renderer.info.autoReset, false);
      assert.equal(renderer.xr.enabled, false);
      assert.equal(scissorTest, false);
      assert.equal(scene.background, null);
      assert.equal(renderer.toneMapping, ACESFilmicToneMapping);
      assert.equal(renderer.toneMappingExposure, 1.25);
      assert.equal(renderer.outputColorSpace, SRGBColorSpace);
      scene.updateMatrixWorld(true);
      scene.traverseVisible(object => {
        if (!object.isMesh || !object.layers.test(camera.layers)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (!materials.some(entry => entry.visible)) return;
        assert.equal(object.frustumCulled, false, 'Every cached part reaches the upload path');
        uploadedGeometries.add(object.geometry);
      });
      if (failAt === 'render') throw new Error('render failed');
    },
  };
  return {
    scene, camera, light, world, fists, bat, pistol, knife, vmGroup, models, renderer,
    target, calls, compiledMeshes, uploadedGeometries, initializedTextures,
  };
}

function captureObjects(roots) {
  const states = new Map();
  for (const root of roots) root.traverse(object => {
    if (states.has(object)) return;
    states.set(object, {
      parent: object.parent, children: object.children.slice(), visible: object.visible,
      layers: object.layers.mask, frustumCulled: object.frustumCulled,
      position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(),
      rotation: object.rotation.toArray(), matrix: object.matrix.toArray(), matrixWorld: object.matrixWorld.toArray(),
      matrixWorldNeedsUpdate: object.matrixWorldNeedsUpdate,
      geometry: object.geometry, material: object.material,
    });
  });
  return states;
}

function assertObjectsRestored(states) {
  for (const [object, state] of states) {
    assert.equal(object.parent, state.parent, `${object.name} parent`);
    assert.deepEqual(object.children, state.children, `${object.name} child order`);
    assert.equal(object.visible, state.visible, `${object.name} visibility`);
    assert.equal(object.layers.mask, state.layers, `${object.name} layers`);
    assert.equal(object.frustumCulled, state.frustumCulled, `${object.name} culling`);
    assert.deepEqual(object.position.toArray(), state.position);
    assert.deepEqual(object.quaternion.toArray(), state.quaternion);
    assert.deepEqual(object.rotation.toArray(), state.rotation);
    assert.deepEqual(object.scale.toArray(), state.scale);
    assert.deepEqual(object.matrix.toArray(), state.matrix);
    assert.deepEqual(object.matrixWorld.toArray(), state.matrixWorld);
    assert.equal(object.matrixWorldNeedsUpdate, state.matrixWorldNeedsUpdate);
    assert.equal(object.geometry, state.geometry, 'The cached geometry is not cloned or replaced');
    assert.equal(object.material, state.material, 'The cached material is not cloned or replaced');
  }
}

function captureRenderer(renderer) {
  return {
    autoClear: renderer.autoClear,
    autoClearColor: renderer.autoClearColor,
    autoClearDepth: renderer.autoClearDepth,
    autoClearStencil: renderer.autoClearStencil,
    shadowMap: { ...renderer.shadowMap },
    infoAutoReset: renderer.info.autoReset,
    xrEnabled: renderer.xr.enabled,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    outputColorSpace: renderer.outputColorSpace,
    target: renderer.getRenderTarget(),
    face: renderer.getActiveCubeFace(),
    mip: renderer.getActiveMipmapLevel(),
    scissor: renderer.getScissorTest(),
  };
}

test('all real cached hand/bat and held-model resources warm once without changing the equipped model', async () => {
  const f = fixture(), states = captureObjects([f.camera, ...f.models]);
  const rendererState = captureRenderer(f.renderer), background = f.scene.background;
  const sceneChildren = f.scene.children.slice(), environment = f.scene.environment;
  const materials = new Set(), geometries = new Set(), textures = new Set(), meshes = new Set();
  for (const model of f.models) model.traverse(object => {
    if (!object.isMesh) return;
    meshes.add(object); geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const resource of [...materials, ...geometries, ...textures]) {
    resource.addEventListener('dispose', () => assert.fail('Cached resources must remain usable after warmup'));
  }
  let activeParentChanges = 0;
  f.fists.addEventListener('added', () => activeParentChanges++);
  f.fists.addEventListener('removed', () => activeParentChanges++);
  const result = await warmViewModels(f.renderer, f.scene, f.camera, f.models, { basePosition: new Vector3(0.22, -0.22, -0.36) });
  assert.equal(result.status, 'ready');
  assert.equal(result.compileMode, 'async');
  assert.equal(result.models, 4);
  assert.equal(result.meshes, meshes.size);
  assert.equal(result.geometries, geometries.size);
  assert.equal(result.materials, materials.size);
  assert.equal(result.textures, textures.size);
  assert.deepEqual(f.compiledMeshes, meshes, 'Every actual cache mesh is compiled, with no world mesh');
  assert.deepEqual(f.uploadedGeometries, geometries);
  assert.equal(f.initializedTextures.length, textures.size);
  assert.deepEqual(new Set(f.initializedTextures), textures, 'Shared map slots are uploaded once');
  assert.equal(f.calls.filter(call => call === 'compile').length, 1);
  assert.equal(f.calls.filter(call => call === 'render').length, 1);
  assert.deepEqual(f.calls.slice(-2), ['clear-depth', 'render']);
  assert.equal(activeParentChanges, 0, 'The already attached fists never leave their active group');
  assert.equal(f.bat.userData.firstPersonBat.phase, 1, 'Warmup never advances a melee pose');
  assertObjectsRestored(states);
  assert.deepEqual(captureRenderer(f.renderer), rendererState);
  assert.deepEqual(f.scene.children, sceneChildren);
  assert.equal(f.scene.background, background);
  assert.equal(f.scene.environment, environment);
  assert.equal(f.scene.environmentIntensity, 0.8);
});

test('async compilation finishes before upload and the one canvas draw, with meaningful camera-space offsets', async () => {
  let resolveCompilation;
  const compileGate = new Promise(resolve => { resolveCompilation = resolve; });
  const f = fixture({ compileGate }), basePosition = new Vector3(0.24, -0.20, -0.40);
  const originalRender = f.renderer.render;
  f.renderer.render = (scene, camera) => {
    for (const model of [f.pistol, f.knife]) {
      assert.ok(model.getWorldPosition(new Vector3()).applyMatrix4(camera.matrixWorldInverse).distanceTo(basePosition) < 1e-10);
      const projected = model.getWorldPosition(new Vector3()).project(camera);
      assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1,
        'The held-model sample is in the visible frustum, not behind the camera or near plane');
    }
    for (const model of [f.fists, f.bat]) {
      assert.ok(model.getWorldPosition(new Vector3()).applyMatrix4(camera.matrixWorldInverse).length() < 1e-10,
        'Fists and bat retain their authored camera-space rigs without a second held-model offset');
    }
    originalRender(scene, camera);
  };
  const warming = warmViewModels(f.renderer, f.scene, f.camera, f.models, { basePosition });
  assert.deepEqual(f.calls, ['compile']);
  assert.equal(f.fists.parent, f.vmGroup);
  assert.equal(f.renderer.getRenderTarget(), null);
  resolveCompilation();
  await warming;
  assert.ok(f.calls.indexOf('texture') > f.calls.indexOf('compile'));
  assert.ok(f.calls.indexOf('render') > f.calls.lastIndexOf('texture'));
  assert.deepEqual(basePosition.toArray(), [0.24, -0.20, -0.40], 'The caller’s offset vector is never changed');
});

test('hidden roots, hidden active ancestors and material flags are restored after resource upload', async () => {
  const f = fixture();
  f.vmGroup.visible = false;
  f.bat.visible = false;
  f.pistol.children[0].visible = false;
  f.pistol.children[0].layers.set(5);
  f.pistol.children[0].material.visible = false;
  const states = captureObjects([f.camera, ...f.models]);
  const result = await warmViewModels(f.renderer, f.scene, f.camera, f.models);
  assert.equal(result.status, 'ready');
  assert.equal(f.uploadedGeometries.size, result.geometries);
  assert.equal(f.pistol.children[0].material.visible, false);
  assertObjectsRestored(states);
});

test('cached models originally held elsewhere return to their exact parents and sibling order', async () => {
  const f = fixture(), container = new Group();
  const a = new Group(), b = new Group(), c = new Group();
  container.add(a, f.pistol, b, f.knife, c);
  container.position.set(5, 6, 7);
  container.rotation.z = 0.2;
  const states = captureObjects([container, f.camera, f.bat]);
  await warmViewModels(f.renderer, f.scene, f.camera, [f.knife, f.fists, f.pistol, f.bat]);
  assertObjectsRestored(states);
  assert.deepEqual(container.children, [a, f.pistol, b, f.knife, c]);
});

test('an unparented camera is attached only for the warm render and returns detached', async () => {
  const f = fixture();
  f.camera.removeFromParent();
  const states = captureObjects([f.camera, ...f.models]), sceneChildren = f.scene.children.slice();
  await warmViewModels(f.renderer, f.scene, f.camera, f.models);
  assert.equal(f.camera.parent, null);
  assert.deepEqual(f.scene.children, sceneChildren);
  assertObjectsRestored(states);
});

for (const failAt of ['compile', 'texture', 'render']) {
  test(`${failAt} failure restores hierarchy, transforms, layers, resources and renderer state before rejecting`, async () => {
    const f = fixture({ failAt });
    f.bat.visible = false;
    f.knife.children[0].layers.set(6);
    f.knife.children[0].material.visible = false;
    const states = captureObjects([f.camera, ...f.models]);
    const rendererState = captureRenderer(f.renderer), background = f.scene.background;
    const inverse = f.camera.matrixWorldInverse.toArray();
    const sceneChildren = f.scene.children.slice();
    await assert.rejects(warmViewModels(f.renderer, f.scene, f.camera, f.models), new RegExp(`${failAt} failed`));
    assertObjectsRestored(states);
    assert.deepEqual(captureRenderer(f.renderer), rendererState);
    assert.equal(f.scene.background, background);
    assert.deepEqual(f.scene.children, sceneChildren);
    assert.deepEqual(f.camera.matrixWorldInverse.toArray(), inverse);
    assert.equal(f.knife.children[0].material.visible, false);
    assert.equal(f.calls.filter(call => call === 'render').length, failAt === 'render' ? 1 : 0);
  });
}

test('duplicate and nested cache entries do not duplicate attachments or upload work', async () => {
  const f = fixture(), states = captureObjects([f.camera, ...f.models]);
  const result = await warmViewModels(f.renderer, f.scene, f.camera,
    [f.fists, f.fists, f.bat, f.pistol, f.pistol.children[0], f.knife]);
  assert.equal(result.models, 4);
  assert.equal(f.initializedTextures.length, new Set(f.initializedTextures).size);
  assertObjectsRestored(states);
});

test('fallback compilation still uses the actual scene and does not require explicit texture initialization', async () => {
  const f = fixture();
  delete f.renderer.compileAsync;
  delete f.renderer.initTexture;
  f.renderer.compile = (root, camera, scene) => {
    f.calls.push('compile-sync');
    assert.equal(root, f.camera);
    assert.equal(camera, f.camera);
    assert.equal(scene, f.scene);
    assert.equal(f.renderer.getRenderTarget(), null);
  };
  const result = await warmViewModels(f.renderer, f.scene, f.camera, { fists: f.fists, bat: f.bat });
  assert.equal(result.compileMode, 'sync');
  assert.deepEqual(f.calls, ['compile-sync', 'clear-depth', 'render']);
});

test('an empty cache is a zero-work no-op and invalid hierarchies reject before mutation', async () => {
  const noop = await warmViewModels(null, null, null, []);
  assert.equal(noop.status, 'skipped');
  assert.equal(noop.models, 0);
  const f = fixture(), states = captureObjects([f.camera, ...f.models]);
  const rendererState = captureRenderer(f.renderer);
  await assert.rejects(warmViewModels(f.renderer, f.scene, f.camera, [f.camera]), /cached Object3D models/);
  await assert.rejects(warmViewModels(f.renderer, f.scene, f.camera, [f.scene]), /cached Object3D models/);
  await assert.rejects(warmViewModels(f.renderer, f.scene, f.camera, [f.pistol], { basePosition: [0, NaN, -1] }), /finite coordinates/);
  assertObjectsRestored(states);
  assert.deepEqual(captureRenderer(f.renderer), rendererState);
  assert.deepEqual(f.calls, []);
  f.camera.removeFromParent();
  await assert.rejects(warmViewModels(f.renderer, f.scene, f.camera, [f.scene]), /cached Object3D models/);
  assert.equal(f.camera.parent, null, 'A rejected scene root cannot create a parenting cycle');
  assert.deepEqual(f.calls, []);
});
