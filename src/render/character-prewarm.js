import { Group, HalfFloatType, LinearFilter, LinearSRGBColorSpace, Vector4, WebGLRenderTarget } from 'three';

const active = new WeakSet();
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
const drawable = object => object.isMesh || object.isPoints || object.isLine || object.isSprite;

function belongsTo(object, ancestor) {
  for (let parent = object; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
}

// compileAsync accepts an Object3D and traverses its materials. This selection
// enumerates the actual cached meshes without cloning/reparenting a skeleton,
// or traversing hidden legacy bounds proxies along with the visible character.
class MeshSelection extends Group {
  constructor(meshes) { super(); this.meshes = meshes; this.name = 'character-prewarm-selection'; }
  traverse(callback) { callback(this); for (const mesh of this.meshes) callback(mesh); }
}

function characterDrawables(root) {
  const visual = root.userData.rig?.visualMeshes;
  if (!Array.isArray(visual)) throw new TypeError('Character warmup requires rig.visualMeshes on every pooled root.');
  const result = new Set(visual);
  root.traverse(object => {
    if (!drawable(object)) return;
    for (let ancestor = object; ancestor && ancestor !== root; ancestor = ancestor.parent) {
      if (ancestor.userData.role === 'bounds-proxy') return;
      if (ancestor.userData.role === 'weapon') { result.add(object); return; }
    }
  });
  for (const mesh of result) {
    if (!drawable(mesh) || !belongsTo(mesh, root) || mesh.userData.role === 'bounds-proxy') {
      throw new TypeError('Character visual meshes must be real drawable descendants, never bounds proxies.');
    }
  }
  return result;
}

function saveObject(object) {
  return {
    visible: object.visible, layers: object.layers.mask, frustumCulled: object.frustumCulled,
    position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone(), rotation: object.rotation.clone(), up: object.up.clone(),
    matrix: object.matrix.clone(), matrixWorld: object.matrixWorld.clone(), matrixWorldNeedsUpdate: object.matrixWorldNeedsUpdate,
    matrixAutoUpdate: object.matrixAutoUpdate, matrixWorldAutoUpdate: object.matrixWorldAutoUpdate,
    modelViewMatrix: object.modelViewMatrix?.clone(), normalMatrix: object.normalMatrix?.clone(),
    bindMatrixInverse: object.bindMatrixInverse?.clone(), matrixWorldInverse: object.matrixWorldInverse?.clone(),
    projectionMatrix: object.projectionMatrix?.clone(), projectionMatrixInverse: object.projectionMatrixInverse?.clone(),
    projection: object.isCamera ? Object.fromEntries(['near', 'far', 'fov', 'aspect', 'left', 'right', 'top', 'bottom', 'zoom']
      .filter(key => key in object).map(key => [key, object[key]])) : null,
  };
}

function restoreObject(object, state) {
  object.visible = state.visible; object.layers.mask = state.layers; object.frustumCulled = state.frustumCulled;
  object.position.copy(state.position); object.scale.copy(state.scale); object.up.copy(state.up);
  // Ordinary pooled bones never change rotation here. Avoid unnecessarily
  // round-tripping their exact Euler/quaternion representation on restore.
  if (!object.quaternion.equals(state.quaternion) || !object.rotation.equals(state.rotation)) {
    object.quaternion.copy(state.quaternion);
    if (!object.rotation.equals(state.rotation)) object.rotation.copy(state.rotation);
  }
  object.matrix.copy(state.matrix); object.matrixWorld.copy(state.matrixWorld); object.matrixWorldNeedsUpdate = state.matrixWorldNeedsUpdate;
  object.matrixAutoUpdate = state.matrixAutoUpdate; object.matrixWorldAutoUpdate = state.matrixWorldAutoUpdate;
  for (const key of ['modelViewMatrix', 'normalMatrix', 'bindMatrixInverse', 'matrixWorldInverse', 'projectionMatrix', 'projectionMatrixInverse']) {
    if (state[key]) object[key].copy(state[key]);
  }
  if (state.projection) Object.assign(object, state.projection);
}

/**
 * Boot-only: initialize the real pool before simulation/animation starts. The
 * loading screen must cover the canvas; the caller redraws the world afterwards.
 * Visible hero/held meshes are selected, never old hidden collision/bounds proxies.
 * Shared geometry/material variants draw once, but every per-actor bone texture
 * is initialized. Original poses, hierarchy, visibility and renderer state are
 * restored even on failure. Newly initialized bone/shadow resources remain owned
 * by their Skeleton/Light; the temporary linear target is always disposed.
 *
 * Canvas and linear output compile separately because Automatic/High world
 * rendering uses an HDR target, while Performance/adaptive fallback uses canvas.
 * Shadow warmup defaults on only for auto-updating shadow maps: the caller's next
 * ordinary world draw replaces the temporary pooled-character shadow contents.
 */
export async function warmCharacters(renderer, scene, camera, candidates, {
  batchSize = 8, linear = true, warmShadows = renderer?.shadowMap?.enabled && renderer?.shadowMap?.autoUpdate,
  yieldControl = yieldTask,
} = {}) {
  const unique = [...new Set(candidates?.[Symbol.iterator] ? [...candidates].filter(Boolean) : Object.values(candidates ?? {}).filter(Boolean))];
  const result = { status: 'skipped', characters: unique.length, pooledMeshes: 0, meshes: 0, geometries: 0, materials: 0,
    textures: 0, skeletons: 0, createdBoneTextures: 0, compileMode: null, variants: [], batches: 0, shadowWarmup: false, frozenShadowMaps: 0 };
  if (!unique.length) return result;
  if (!scene?.isScene || !camera?.isCamera) throw new TypeError('Character warmup requires the real scene and camera.');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64 || typeof yieldControl !== 'function') {
    throw new TypeError('Character warmup requires batchSize 1–64 and an async yieldControl function.');
  }
  if (unique.some(root => !root.isObject3D || root === scene || root === camera || !belongsTo(root, scene) || belongsTo(camera, root))) {
    throw new TypeError('Character warmup requires pooled roots already attached to the render scene.');
  }
  if (camera.parent && !belongsTo(camera, scene)) throw new TypeError('Character warmup camera belongs to another scene.');
  if (warmShadows && !renderer.shadowMap?.autoUpdate) throw new TypeError('Shadow warmup requires auto-updating maps so the next world draw refreshes them.');
  if (active.has(renderer)) throw new Error('Character warmup is already running for this renderer.');
  const roots = unique.filter(root => !unique.some(other => other !== root && belongsTo(root, other)));
  result.characters = roots.length;
  const meshes = new Set(), geometries = new Set(), materials = new Map(), textures = new Set(), skeletons = new Map();
  for (const root of roots) {
    for (const mesh of characterDrawables(root)) {
      meshes.add(mesh); if (mesh.geometry) geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!material || materials.has(material)) continue;
        materials.set(material, material.visible);
        for (const value of Object.values(material)) if (value?.isTexture && !value.isRenderTargetTexture) textures.add(value);
      }
      if (mesh.isSkinnedMesh && mesh.skeleton && !skeletons.has(mesh.skeleton)) {
        skeletons.set(mesh.skeleton, mesh.skeleton.boneMatrices.slice());
      }
    }
  }
  const variants = new Map();
  for (const mesh of meshes) {
    const materialKey = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => material?.uuid).join(',');
    const key = `${mesh.geometry?.uuid}|${materialKey}|${!!mesh.isSkinnedMesh}|${mesh.receiveShadow}|${mesh.castShadow}|${mesh.customDepthMaterial?.uuid || ''}|${mesh.customDistanceMaterial?.uuid || ''}`;
    if (!variants.has(key)) variants.set(key, mesh);
  }
  const representatives = [...variants.values()], selection = new MeshSelection(representatives);
  result.pooledMeshes = meshes.size; result.meshes = representatives.length; result.geometries = geometries.size;
  result.materials = materials.size; result.textures = textures.size; result.skeletons = skeletons.size;
  if (!representatives.length) return result;

  const objects = new Map(), lights = [], shadowStates = new Map();
  function remember(object) { if (!objects.has(object)) objects.set(object, saveObject(object)); }
  function rememberAncestors(object) { for (let parent = object; parent; parent = parent.parent) remember(parent); }
  for (const root of roots) { root.traverse(remember); rememberAncestors(root); }
  rememberAncestors(camera);
  const originalCameraLayers = camera.layers.mask;
  let usedLayers = 0;
  scene.traverse(object => { if (drawable(object) || object.isLight || object.isLightProbeGrid) usedLayers |= object.layers.mask; });
  let warmLayer = 31;
  while (warmLayer >= 0 && (usedLayers & (1 << warmLayer))) warmLayer--;
  if (warmLayer < 0) throw new Error('Character warmup needs one unused draw layer.');
  scene.traverseVisible(object => {
    if (!object.isLight || !(object.layers.mask & originalCameraLayers)) return;
    lights.push(object); rememberAncestors(object);
    if (object.target) rememberAncestors(object.target);
    if (object.shadow) {
      shadowStates.set(object.shadow, { needsUpdate: object.shadow.needsUpdate, matrix: object.shadow.matrix.clone(), frustum: object.shadow.getFrustum().clone() });
      remember(object.shadow.camera);
    }
  });
  const warmableShadows = [...shadowStates.keys()].filter(shadow => shadow.autoUpdate || shadow.needsUpdate);
  result.frozenShadowMaps = shadowStates.size - warmableShadows.length;
  const saved = {
    background: scene.background, overrideMaterial: scene.overrideMaterial,
    autoClear: renderer.autoClear, shadowAutoUpdate: renderer.shadowMap.autoUpdate, shadowNeedsUpdate: renderer.shadowMap.needsUpdate,
    infoAutoReset: renderer.info.autoReset, xrEnabled: renderer.xr?.enabled,
    target: renderer.getRenderTarget(), cubeFace: renderer.getActiveCubeFace?.() ?? 0, mip: renderer.getActiveMipmapLevel?.() ?? 0,
    viewport: renderer.getViewport?.(new Vector4()), scissor: renderer.getScissor?.(new Vector4()), scissorTest: renderer.getScissorTest(),
  };
  let linearTarget = null;
  active.add(renderer);
  try {
    scene.background = null; scene.overrideMaterial = null; scene.matrixWorldAutoUpdate = false;
    for (const root of roots) {
      root.parent?.updateWorldMatrix(true, false);
      // Unlike updateWorldMatrix(), this dispatches SkinnedMesh's override and
      // gives the upload draw a correct attached bindMatrixInverse as well.
      root.updateMatrixWorld(true);
    }
    for (const light of lights) {
      light.updateWorldMatrix(true, false); light.target?.updateWorldMatrix(true, false); light.layers.enable(warmLayer);
    }
    camera.updateWorldMatrix(true, false); camera.matrixWorldAutoUpdate = false; camera.layers.set(warmLayer);
    for (const mesh of representatives) for (let parent = mesh.parent; parent; parent = parent.parent) parent.visible = true;
    for (const material of materials.keys()) material.visible = true;
    renderer.autoClear = false; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
    renderer.info.autoReset = false; if (renderer.xr) renderer.xr.enabled = false; renderer.setScissorTest(false);

    let initialized = 0;
    for (const skeleton of skeletons.keys()) {
      if (skeleton.boneTexture === null) { skeleton.computeBoneTexture(); result.createdBoneTextures++; }
      renderer.initTexture?.(skeleton.boneTexture);
      if (++initialized % batchSize === 0) await yieldControl();
    }
    for (const texture of textures) renderer.initTexture?.(texture);
    const outputs = [{ name: 'canvas', target: null }];
    if (linear && renderer.extensions?.has('EXT_color_buffer_float')) {
      linearTarget = new WebGLRenderTarget(4, 4, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter,
        generateMipmaps: false, depthBuffer: true, stencilBuffer: false });
      linearTarget.texture.colorSpace = LinearSRGBColorSpace; linearTarget.texture.name = 'character-prewarm-linear';
      outputs.push({ name: 'linear', target: linearTarget });
    }
    for (const output of outputs) {
      renderer.setRenderTarget(output.target);
      if (typeof renderer.compileAsync === 'function') { result.compileMode = 'async'; await renderer.compileAsync(selection, camera, scene); }
      else if (typeof renderer.compile === 'function') { result.compileMode = 'sync'; renderer.compile(selection, camera, scene); }
      else result.compileMode = 'render';
      for (let start = 0; start < representatives.length; start += batchSize) {
        const batch = representatives.slice(start, start + batchSize);
        for (const mesh of batch) { mesh.visible = true; mesh.frustumCulled = false; mesh.layers.set(warmLayer); }
        if (warmShadows && output.name === 'canvas' && warmableShadows.length) {
          renderer.shadowMap.needsUpdate = true;
          for (const shadow of warmableShadows) shadow.needsUpdate = true;
          result.shadowWarmup = true;
        }
        renderer.clearDepth(); renderer.render(scene, camera); result.batches++;
        renderer.shadowMap.needsUpdate = false;
        for (const mesh of batch) {
          const original = objects.get(mesh);
          mesh.visible = original.visible; mesh.frustumCulled = original.frustumCulled; mesh.layers.mask = original.layers;
        }
        await yieldControl();
      }
      result.variants.push(output.name);
    }
    result.status = 'ready'; return result;
  } finally {
    try {
      for (const [object, state] of objects) restoreObject(object, state);
      for (const [material, visible] of materials) material.visible = visible;
      for (const [skeleton, matrices] of skeletons) {
        skeleton.boneMatrices.fill(0); skeleton.boneMatrices.set(matrices);
        if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true;
      }
      for (const [shadow, state] of shadowStates) {
        shadow.needsUpdate = state.needsUpdate; shadow.matrix.copy(state.matrix); shadow.getFrustum().copy(state.frustum);
      }
      scene.background = saved.background; scene.overrideMaterial = saved.overrideMaterial;
      renderer.autoClear = saved.autoClear; renderer.shadowMap.autoUpdate = saved.shadowAutoUpdate; renderer.shadowMap.needsUpdate = saved.shadowNeedsUpdate;
      renderer.info.autoReset = saved.infoAutoReset; if (renderer.xr) renderer.xr.enabled = saved.xrEnabled;
      // These public getters/setters describe the canvas/global defaults. Restore
      // them before binding a target, whose own viewport/scissor must win last.
      if (saved.viewport) renderer.setViewport(saved.viewport);
      if (saved.scissor) renderer.setScissor(saved.scissor);
      renderer.setScissorTest(saved.scissorTest);
      renderer.setRenderTarget(saved.target, saved.cubeFace, saved.mip);
    } finally {
      // Even a lost/broken renderer that rejects target restoration cannot keep
      // the helper's owned target or its concurrency guard alive indefinitely.
      try { linearTarget?.dispose(); } finally { active.delete(renderer); }
    }
  }
}
