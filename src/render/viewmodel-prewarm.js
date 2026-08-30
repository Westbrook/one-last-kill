import { Group, Vector3 } from 'three';
import { VIEW_MODEL_LAYER } from './viewmodel.js';

function belongsTo(object, ancestor) {
  for (let parent = object; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
}

/**
 * Warm actual cached models during boot, before the animation loop starts.
 * The caller builds the cache without equipping weapons and redraws the world
 * afterwards. The loading menu must cover the one temporary canvas render.
 * No asset is cloned/disposed, no gameplay pose is advanced, and failures reject
 * only after restoring the scene. basePosition should be Weapons.basePos.
 */
export async function warmViewModels(renderer, scene, camera, models, {
  basePosition = [0.22, -0.22, -0.36],
} = {}) {
  const candidates = models?.[Symbol.iterator] ? [...models] : Object.values(models ?? {});
  const unique = [...new Set(candidates.filter(Boolean))];
  if (unique.some(model => !model.isObject3D || model === scene || model === camera || belongsTo(camera, model))) {
    throw new TypeError('Viewmodel warmup requires cached Object3D models, not the camera or scene.');
  }
  // A nested entry is already covered by its cached root. Never attach it twice.
  const roots = unique.filter(model => !unique.some(other => other !== model && belongsTo(model, other)));
  const result = { status: 'skipped', models: roots.length, meshes: 0, geometries: 0, materials: 0, textures: 0, compileMode: null };
  if (!roots.length) return result;
  if (!scene?.isScene || !camera?.isCamera) throw new TypeError('Viewmodel warmup requires the real scene and camera.');
  if (camera.parent && !belongsTo(camera, scene)) {
    throw new Error('The viewmodel camera must belong to the render scene or have no parent.');
  }
  const offset = basePosition?.isVector3 ? basePosition.clone() : new Vector3(...basePosition);
  if (!offset.toArray().every(Number.isFinite)) throw new TypeError('Viewmodel basePosition must have three finite coordinates.');

  const objectStates = new Map(), materialStates = new Map(), textures = new Set(), geometries = new Set();
  const visibleObjects = new Set(), drawables = new Set();
  function rememberObject(object, show = false) {
    if (show) visibleObjects.add(object);
    if (objectStates.has(object)) return;
    objectStates.set(object, {
      visible: object.visible, layers: object.layers.mask, frustumCulled: object.frustumCulled,
      matrix: object.matrix.clone(), matrixWorld: object.matrixWorld.clone(),
      matrixWorldNeedsUpdate: object.matrixWorldNeedsUpdate,
    });
  }
  for (const model of roots) {
    model.traverse(object => {
      rememberObject(object, true);
      if (!object.isMesh && !object.isPoints && !object.isLine && !object.isSprite) return;
      drawables.add(object);
      result.meshes++;
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material || materialStates.has(material)) continue;
        materialStates.set(material, { visible: material.visible });
        for (const value of Object.values(material)) if (value?.isTexture && !value.isRenderTargetTexture) textures.add(value);
      }
    });
    if (belongsTo(model, camera)) {
      for (let parent = model.parent; parent && parent !== camera; parent = parent.parent) rememberObject(parent, true);
    }
  }
  for (let parent = camera; parent; parent = parent.parent) {
    rememberObject(parent, true);
    if (parent === scene) break;
  }
  rememberObject(scene, true);
  // A scene update also touches other camera children. Restore their cached
  // matrices without changing their visibility, layers or render eligibility.
  camera.traverse(rememberObject);
  result.geometries = geometries.size;
  result.materials = materialStates.size;
  result.textures = textures.size;

  const moved = roots.filter(model => !belongsTo(model, camera)).map(model => ({
    model, parent: model.parent, index: model.parent?.children.indexOf(model) ?? -1,
  }));
  const cameraWasDetached = camera.parent === null;
  const cameraWorldInverse = camera.matrixWorldInverse.clone();
  const state = {
    background: scene.background,
    autoClear: renderer.autoClear,
    shadowAutoUpdate: renderer.shadowMap.autoUpdate,
    shadowNeedsUpdate: renderer.shadowMap.needsUpdate,
    infoAutoReset: renderer.info.autoReset,
    xrEnabled: renderer.xr?.enabled,
    target: renderer.getRenderTarget(),
    cubeFace: renderer.getActiveCubeFace?.() ?? 0,
    mipmapLevel: renderer.getActiveMipmapLevel?.() ?? 0,
    scissorTest: renderer.getScissorTest(),
  };
  const staging = new Group(), held = new Group();
  staging.name = 'viewmodel-prewarm';
  held.position.copy(offset);
  staging.add(held);

  try {
    if (cameraWasDetached) scene.add(camera);
    if (moved.length) camera.add(staging);
    for (const { model } of moved) {
      const cameraSpace = model.userData.firstPersonHands || model.userData.firstPersonBat;
      (cameraSpace ? staging : held).add(model);
    }
    for (const object of visibleObjects) object.visible = true;
    for (const object of drawables) {
      object.layers.set(VIEW_MODEL_LAYER);
      object.frustumCulled = false;
    }
    for (const material of materialStates.keys()) material.visible = true;
    camera.layers.set(VIEW_MODEL_LAYER);
    scene.background = null;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.info.autoReset = false;
    if (renderer.xr) renderer.xr.enabled = false;
    // Canvas output keeps tone mapping and output color space identical to the
    // gameplay viewmodel pass; an HDR render target would compile another variant.
    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    scene.updateMatrixWorld(true);
    if (typeof renderer.compileAsync === 'function') {
      result.compileMode = 'async';
      // Three accepts an Object3D plus a target scene: gather only camera-held
      // materials, while retaining the actual scene's fog, environment and lights.
      await renderer.compileAsync(camera, camera, scene);
    } else if (typeof renderer.compile === 'function') {
      result.compileMode = 'sync';
      renderer.compile(camera, camera, scene);
    } else {
      result.compileMode = 'render';
    }
    if (typeof renderer.initTexture === 'function') for (const texture of textures) renderer.initTexture(texture);
    renderer.clearDepth();
    renderer.render(scene, camera);
    result.status = 'ready';
    return result;
  } finally {
    for (const { model } of moved) model.removeFromParent();
    // Restore original sibling positions as well as parents, including multiple
    // cached roots originally held by the same off-camera container.
    for (const { model, parent, index } of moved.slice().sort((a, b) => a.index - b.index)) {
      if (!parent) continue;
      parent.add(model);
      parent.children.splice(parent.children.indexOf(model), 1);
      parent.children.splice(index, 0, model);
    }
    staging.removeFromParent();
    if (cameraWasDetached) camera.removeFromParent();
    for (const [object, saved] of objectStates) {
      object.visible = saved.visible;
      object.layers.mask = saved.layers;
      object.frustumCulled = saved.frustumCulled;
      object.matrix.copy(saved.matrix);
      object.matrixWorld.copy(saved.matrixWorld);
      object.matrixWorldNeedsUpdate = saved.matrixWorldNeedsUpdate;
    }
    camera.matrixWorldInverse.copy(cameraWorldInverse);
    for (const [material, saved] of materialStates) material.visible = saved.visible;
    scene.background = state.background;
    renderer.autoClear = state.autoClear;
    renderer.shadowMap.autoUpdate = state.shadowAutoUpdate;
    renderer.shadowMap.needsUpdate = state.shadowNeedsUpdate;
    renderer.info.autoReset = state.infoAutoReset;
    if (renderer.xr) renderer.xr.enabled = state.xrEnabled;
    renderer.setScissorTest(state.scissorTest);
    renderer.setRenderTarget(state.target, state.cubeFace, state.mipmapLevel);
  }
}
