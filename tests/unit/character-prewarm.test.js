import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Bone, BoxGeometry, DataTexture, DirectionalLight, Float32BufferAttribute, Group, Matrix4, Mesh,
  MeshStandardMaterial, PerspectiveCamera, Scene, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute, Vector4,
} from 'three';
import { warmCharacters } from '../../src/render/character-prewarm.js';
import { createHumanoidRig, attachHeldWeapon } from '../../src/render/humanoid-rig.js';

const materialsOf = object => Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];

function fixture({ asyncCompile = true, floatSupported = true, failAt = null } = {}) {
  const scene = new Scene(), camera = new PerspectiveCamera(82, 16 / 9, 0.05, 300), container = new Group();
  const light = new DirectionalLight(), ignoredLight = new DirectionalLight();
  light.castShadow = true; ignoredLight.layers.set(5);
  scene.background = new Texture(); scene.environment = new Texture(); scene.environmentIntensity = 0.7;
  const world = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  scene.add(camera, container, light, ignoredLight, world); scene.add(light.target);
  const geometry = new BoxGeometry(0.4, 1.6, 0.2), count = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4); for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  const rigid = new BoxGeometry(0.2, 0.2, 0.2), weaponGeometry = new BoxGeometry(0.1, 0.1, 0.3);
  weaponGeometry.clearGroups();
  weaponGeometry.addGroup(0, weaponGeometry.index.count / 2, 0);
  weaponGeometry.addGroup(weaponGeometry.index.count / 2, weaponGeometry.index.count / 2, 1);
  const map = new DataTexture(new Uint8Array([150, 140, 130, 255]), 1, 1);
  const skin = new MeshStandardMaterial({ map }), cloth = new MeshStandardMaterial({ map, normalMap: map });
  const different = new MeshStandardMaterial({ color: 0x883344, map });
  const roots = [];
  for (let i = 0; i < 3; i++) {
    const root = new Group(), hips = new Bone(), headBone = new Bone(); hips.name = 'hips'; headBone.name = 'head';
    headBone.position.y = 1.5; hips.add(headBone); root.add(hips);
    root.updateMatrixWorld(true);
    const skeleton = new Skeleton([hips, headBone]), visualMeshes = [];
    for (const material of [i === 2 ? different : cloth, skin]) {
      const mesh = new SkinnedMesh(geometry, material); mesh.castShadow = mesh.receiveShadow = true;
      root.add(mesh); mesh.bind(skeleton, new Matrix4()); visualMeshes.push(mesh);
    }
    for (let part = 0; part < 2; part++) {
      const mesh = new Mesh(rigid, part ? cloth : skin); headBone.add(mesh); visualMeshes.push(mesh);
    }
    const proxy = new Mesh(rigid, new MeshStandardMaterial()); proxy.userData.role = 'bounds-proxy'; proxy.visible = false;
    root.add(proxy);
    const held = new Group(); held.userData.role = 'weapon'; held.add(new Mesh(weaponGeometry, [cloth, skin])); headBone.add(held);
    root.userData.rig = { visualMeshes, hero: { skeleton }, bodyMeshes: [proxy], poseTime: 9 + i };
    root.name = `pooled-${i}`; root.position.set(i, -200, 0); root.visible = false; container.add(root); roots.push(root);
  }
  const calls = [], compiled = new Set(), rendered = new Set(), renderedGroups = new Map();
  const initialized = [], temporaryTargets = new Set(), disposedTargets = new Set();
  let target = { name: 'original-target' }, cube = 2, mip = 3, scissorTest = true;
  const viewport = new Vector4(3, 4, 900, 600), scissor = new Vector4(2, 5, 600, 400);
  const renderer = {
    autoClear: true, autoClearColor: false, autoClearDepth: true, autoClearStencil: false,
    shadowMap: { enabled: true, autoUpdate: true, needsUpdate: true, type: 1 }, info: { autoReset: true }, xr: { enabled: true },
    toneMapping: 4, toneMappingExposure: 1.12, outputColorSpace: 'srgb', extensions: { has: () => floatSupported },
    getRenderTarget: () => target, getActiveCubeFace: () => cube, getActiveMipmapLevel: () => mip,
    setRenderTarget(value, face = 0, level = 0) { target = value; cube = face; mip = level; },
    getViewport: destination => destination.copy(viewport), setViewport: value => viewport.copy(value),
    getScissor: destination => destination.copy(scissor), setScissor: value => scissor.copy(value),
    getScissorTest: () => scissorTest, setScissorTest: value => { scissorTest = value; },
    compile(selection, suppliedCamera, targetScene) {
      calls.push('compile'); assert.equal(suppliedCamera, camera); assert.equal(targetScene, scene);
      assert.equal(scene.environmentIntensity, 0.7); assert.equal(scene.background, null);
      assert.ok(light.layers.test(camera.layers)); assert.equal(ignoredLight.layers.test(camera.layers), false);
      assert.equal(selection.parent, null, 'Selection never reparents the real cached meshes');
      selection.traverse(object => {
        if (!object.isMesh) return;
        assert.notEqual(object, world); assert.notEqual(object.userData.role, 'bounds-proxy'); compiled.add(object);
      });
      if (target?.isWebGLRenderTarget && !temporaryTargets.has(target)) {
        temporaryTargets.add(target); const owned = target;
        target.addEventListener('dispose', () => disposedTargets.add(owned));
      }
      if (failAt === 'compile') throw new Error('compile failed');
    },
    initTexture(texture) {
      calls.push('texture'); initialized.push(texture); assert.ok(texture.isTexture);
      if (failAt === 'texture') throw new Error('texture failed');
    },
    clearDepth() { calls.push('depth'); },
    render(actualScene, actualCamera) {
      calls.push('render'); assert.equal(actualScene, scene); assert.equal(actualCamera, camera);
      assert.equal(scene.matrixWorldAutoUpdate, false, 'Unrelated scene transform caches are not updated');
      assert.equal(renderer.autoClear, false); assert.equal(renderer.xr.enabled, false);
      actualScene.traverseVisible(object => {
        if (!object.isMesh || !object.layers.test(camera.layers)) return;
        const groups = Array.isArray(object.material)
          ? object.geometry.groups.map((group, index) => ({ ...group, index }))
            .filter(group => group.count > 0 && object.material[group.materialIndex]?.visible)
          : object.material?.visible ? [{ index: 0 }] : [];
        if (!groups.length) return;
        assert.notEqual(object, world); assert.notEqual(object.userData.role, 'bounds-proxy');
        assert.equal(object.frustumCulled, false); rendered.add(object);
        if (!renderedGroups.has(object)) renderedGroups.set(object, new Set());
        for (const group of groups) renderedGroups.get(object).add(`${target?.isWebGLRenderTarget ? 'linear' : 'canvas'}:${group.index}`);
        if (object.isSkinnedMesh) object.skeleton.update();
        object.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
        object.normalMatrix.getNormalMatrix(object.modelViewMatrix);
      });
      if (failAt === 'render') throw new Error('render failed');
    },
  };
  if (asyncCompile) renderer.compileAsync = async (...args) => renderer.compile(...args);
  return { renderer, scene, camera, roots, container, light, ignoredLight, world, calls, compiled, rendered,
    renderedGroups, initialized, temporaryTargets, disposedTargets };
}

function snapshot(f) {
  const objects = new Map(), materials = new Map(), skeletons = new Map();
  function save(object) {
    const fields = ['visible', 'frustumCulled', 'matrixAutoUpdate', 'matrixWorldAutoUpdate', 'matrixWorldNeedsUpdate'];
    const state = { parent: object.parent, children: object.children.slice(), layers: object.layers.mask,
      material: object.material, materialMembers: materialsOf(object).slice(),
      rotation: object.rotation.toArray(), ...Object.fromEntries(fields.map(key => [key, object[key]])) };
    for (const key of ['position', 'quaternion', 'scale', 'up', 'matrix', 'matrixWorld', 'modelViewMatrix', 'normalMatrix',
      'matrixWorldInverse', 'bindMatrixInverse', 'projectionMatrix', 'projectionMatrixInverse']) {
      if (object[key]) state[key] = object[key].toArray();
    }
    objects.set(object, state);
    for (const material of materialsOf(object)) materials.set(material, { ref: material, visible: material.visible });
    if (object.skeleton && !skeletons.has(object.skeleton)) skeletons.set(object.skeleton, object.skeleton.boneMatrices.slice());
  }
  f.scene.traverse(save); save(f.light.shadow.camera);
  const r = f.renderer;
  return { objects, materials, skeletons, background: f.scene.background, environment: f.scene.environment,
    shadowMatrix: f.light.shadow.matrix.toArray(), shadowNeedsUpdate: f.light.shadow.needsUpdate,
    renderer: { autoClear: r.autoClear, shadowAutoUpdate: r.shadowMap.autoUpdate, shadowNeedsUpdate: r.shadowMap.needsUpdate,
      infoAutoReset: r.info.autoReset, xr: r.xr.enabled, target: r.getRenderTarget(), cube: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(),
      viewport: r.getViewport(new Vector4()).toArray(), scissor: r.getScissor(new Vector4()).toArray(), scissorTest: r.getScissorTest() } };
}

function assertRestored(f, before) {
  const after = snapshot(f);
  assert.equal(after.objects.size, before.objects.size);
  for (const [object, state] of before.objects) {
    const current = after.objects.get(object);
    assert.ok(current, `${object.name} remains attached`);
    assert.ok(current.parent === state.parent, `${object.name} parent`);
    assert.equal(current.children.length, state.children.length, `${object.name} child count`);
    assert.ok(current.children.every((child, index) => child === state.children[index]), `${object.name} child order`);
    assert.equal(current.material, state.material, `${object.name} material or material-array identity`);
    assert.equal(current.materialMembers.length, state.materialMembers.length);
    assert.ok(current.materialMembers.every((material, index) => material === state.materialMembers[index]), `${object.name} material member identities`);
    for (const key of Object.keys(state)) {
      if (['parent', 'children', 'material', 'materialMembers'].includes(key)) continue;
      assert.deepEqual(current[key], state[key], `${object.name || object.type}.${key}`);
    }
  }
  for (const [material, state] of before.materials) assert.equal(material.visible, state.visible, material.name);
  assert.deepEqual(after.renderer, before.renderer);
  assert.equal(after.background, before.background); assert.equal(after.environment, before.environment);
  assert.deepEqual(after.shadowMatrix, before.shadowMatrix); assert.equal(after.shadowNeedsUpdate, before.shadowNeedsUpdate);
  for (const [skeleton, values] of before.skeletons) {
    assert.deepEqual(skeleton.boneMatrices.slice(0, values.length), values, 'Warm rendering cannot advance bone state');
    assert.ok(skeleton.boneMatrices.slice(values.length).every(value => value === 0));
  }
  assert.equal(f.disposedTargets.size, f.temporaryTargets.size, 'Every allocated temporary HDR target is disposed');
  for (const target of f.temporaryTargets) assert.ok(f.disposedTargets.has(target));
}

test('real pool variants compile once per output while every actor gets its own warmed bone texture', async () => {
  const f = fixture(), before = snapshot(f), resources = new Set();
  f.scene.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of materialsOf(object)) {
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  for (const resource of resources) resource.addEventListener('dispose', () => assert.fail('Cached pool resources cannot be disposed'));
  let yields = 0;
  const result = await warmCharacters(f.renderer, f.scene, f.camera, f.roots, { batchSize: 2, yieldControl: async () => { yields++; } });
  assert.equal(result.status, 'ready'); assert.equal(result.characters, 3); assert.equal(result.pooledMeshes, 15);
  assert.equal(result.meshes, 6, 'Five shared visual/weapon variants plus the distinct garment material');
  assert.equal(result.geometries, 3); assert.equal(result.materials, 3); assert.equal(result.textures, 1);
  assert.equal(result.skeletons, 3); assert.equal(result.createdBoneTextures, 3);
  assert.deepEqual(result.variants, ['canvas', 'linear']); assert.equal(result.compileMode, 'async');
  assert.equal(result.batches, 6); assert.equal(result.shadowWarmup, true); assert.equal(yields, 7);
  assert.equal(f.calls.filter(call => call === 'compile').length, 2);
  assert.equal(f.compiled.size, result.meshes); assert.equal(f.rendered.size, f.compiled.size);
  for (const mesh of f.compiled) assert.ok(f.rendered.has(mesh), `compiled mesh ${mesh.type} reaches upload draw`);
  assert.equal(f.initialized.length, 4); assert.equal(new Set(f.initialized).size, 4);
  for (const root of f.roots) assert.ok(f.initialized.includes(root.userData.rig.hero.skeleton.boneTexture));
  assertRestored(f, before);
});

test('hidden character ancestors and material flags warm without showing legacy proxies or unrelated world objects', async () => {
  const f = fixture(); f.container.visible = false; f.roots[0].userData.rig.visualMeshes[2].parent.visible = false;
  f.roots[0].userData.rig.visualMeshes[0].material.visible = false;
  const before = snapshot(f), result = await warmCharacters(f.renderer, f.scene, f.camera, f.roots, { yieldControl: async () => {} });
  assert.equal(f.rendered.size, result.meshes); assertRestored(f, before);
});

test('existing per-actor bone textures are reused and no float support safely warms only the canvas path', async () => {
  const f = fixture({ floatSupported: false, asyncCompile: false }), skeleton = f.roots[0].userData.rig.hero.skeleton;
  skeleton.computeBoneTexture(); const existing = skeleton.boneTexture, before = snapshot(f);
  const result = await warmCharacters(f.renderer, f.scene, f.camera, f.roots, { yieldControl: async () => {} });
  assert.equal(result.createdBoneTextures, 2); assert.equal(result.compileMode, 'sync');
  assert.deepEqual(result.variants, ['canvas']); assert.equal(skeleton.boneTexture, existing); assertRestored(f, before);
});

test('a light excluded by the game camera cannot become a warmup light through the temporary draw layer', async () => {
  const f = fixture(); f.ignoredLight.layers.set(31);
  const before = snapshot(f);
  await warmCharacters(f.renderer, f.scene, f.camera, f.roots, { yieldControl: async () => {} });
  assertRestored(f, before);
});

test('frozen per-light shadow maps are not overwritten with the temporary pool contents', async () => {
  const f = fixture(); f.light.shadow.autoUpdate = false; f.light.shadow.needsUpdate = false;
  const before = snapshot(f), original = f.renderer.render;
  f.renderer.render = (...args) => {
    assert.equal(f.light.shadow.needsUpdate, false, 'Frozen maps must stay untouched throughout the temporary render');
    assert.equal(f.renderer.shadowMap.needsUpdate, false); original(...args);
  };
  const result = await warmCharacters(f.renderer, f.scene, f.camera, f.roots, { yieldControl: async () => {} });
  assert.equal(result.shadowWarmup, false); assert.equal(result.frozenShadowMaps, 1); assertRestored(f, before);
});

test('target-specific viewport/scissor restoration runs after the canvas defaults are restored', async () => {
  const f = fixture(), before = snapshot(f), order = [];
  for (const method of ['setRenderTarget', 'setViewport', 'setScissor', 'setScissorTest']) {
    const original = f.renderer[method];
    f.renderer[method] = (...args) => { order.push(method); return original(...args); };
  }
  await warmCharacters(f.renderer, f.scene, f.camera, f.roots, { yieldControl: async () => {} });
  assert.deepEqual(order.slice(-4), ['setViewport', 'setScissor', 'setScissorTest', 'setRenderTarget']);
  assertRestored(f, before);
});

for (const failAt of ['texture', 'compile', 'render', 'yield']) {
  test(`${failAt} failure restores the pool and renderer before rejecting`, async () => {
    const f = fixture({ failAt }); f.roots[0].userData.rig.visualMeshes[0].material.visible = false;
    const before = snapshot(f);
    await assert.rejects(warmCharacters(f.renderer, f.scene, f.camera, f.roots, { batchSize: 2,
      yieldControl: async () => { if (failAt === 'yield') throw new Error('yield failed'); } }), new RegExp(`${failAt} failed`));
    assertRestored(f, before);
  });
}

test('a rejected HDR compile disposes its target after the successful canvas upload', async () => {
  const f = fixture(), original = f.renderer.compileAsync, before = snapshot(f);
  f.renderer.compileAsync = async (...args) => {
    await original(...args); if (f.renderer.getRenderTarget()?.isWebGLRenderTarget) throw new Error('linear compile failed');
  };
  await assert.rejects(warmCharacters(f.renderer, f.scene, f.camera, f.roots, { yieldControl: async () => {} }), /linear compile failed/);
  assert.equal(f.temporaryTargets.size, 1); assert.ok(f.calls.includes('render')); assertRestored(f, before);
});

test('owned targets and the concurrency guard are released even if renderer restoration fails', async () => {
  const f = fixture(), setTarget = f.renderer.setRenderTarget, originalTarget = f.renderer.getRenderTarget();
  f.renderer.setRenderTarget = (...args) => {
    if (args[0] === originalTarget) throw new Error('target restoration failed');
    setTarget(...args);
  };
  await assert.rejects(warmCharacters(f.renderer, f.scene, f.camera, f.roots, { yieldControl: async () => {} }), /target restoration failed/);
  assert.equal(f.disposedTargets.size, 1); assert.equal(f.temporaryTargets.size, 1);
  f.renderer.setRenderTarget = setTarget; setTarget(originalTarget);
  assert.equal((await warmCharacters(f.renderer, f.scene, f.camera, f.roots, { yieldControl: async () => {} })).status, 'ready');
});

test('duplicate roots and concurrent calls cannot duplicate resource work or interleave renderer state', async () => {
  const f = fixture(), before = snapshot(f); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const running = warmCharacters(f.renderer, f.scene, f.camera, [...f.roots, f.roots[0]], { batchSize: 1, yieldControl: () => gate });
  await assert.rejects(warmCharacters(f.renderer, f.scene, f.camera, f.roots), /already running/);
  release(); const result = await running; assert.equal(result.characters, 3); assertRestored(f, before);
});

test('actual hero rigs expose only the rendered skinned surfaces and held weapon for warmup', async () => {
  const f = fixture(), root = createHumanoidRig({ role: 'gunman', kind: 'gunman' });
  const weapon = attachHeldWeapon(root, 'pistol'); root.visible = false; root.position.y = -200; f.scene.add(root);
  const before = snapshot(f), result = await warmCharacters(f.renderer, f.scene, f.camera, [root], { yieldControl: async () => {} });
  assert.equal(result.pooledMeshes, root.userData.rig.visualMeshes.length + 1); assert.equal(result.skeletons, 1);
  assert.ok(f.rendered.has(root.userData.rig.visualMeshes[0]));
  assert.ok(f.rendered.has(weapon), 'The two-finish weapon reaches the real upload draw');
  assert.deepEqual([...f.renderedGroups.get(weapon)].sort(), ['canvas:0', 'canvas:1', 'linear:0', 'linear:1']);
  for (const proxy of root.userData.rig.bodyMeshes) assert.equal(f.rendered.has(proxy), false);
  assertRestored(f, before);
});

test('invalid input is rejected before mutation and empty pools skip cleanly', async () => {
  const f = fixture(), before = snapshot(f);
  assert.equal((await warmCharacters(f.renderer, null, null, [])).status, 'skipped');
  await assert.rejects(warmCharacters(f.renderer, f.scene, f.camera, [new Group()]), /attached/);
  await assert.rejects(warmCharacters(f.renderer, f.scene, f.camera, f.roots, { batchSize: 0 }), /batchSize/);
  f.renderer.shadowMap.autoUpdate = false;
  await assert.rejects(warmCharacters(f.renderer, f.scene, f.camera, f.roots, { warmShadows: true }), /auto-updating/);
  f.renderer.shadowMap.autoUpdate = true; assertRestored(f, before);
});
