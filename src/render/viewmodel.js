// The camera-held model gets its own depth buffer after the world is drawn.
// Disabling depth tests on its materials would also remove self-occlusion:
// fingers, grips and slide details would paint over one another arbitrarily.
export const VIEW_MODEL_LAYER = 1;

/** Convert an authored barrel tip through weapon, hand and camera transforms. */
export function getViewModelMuzzle(model, target) {
  const local = model?.userData.muzzle;
  if (!Array.isArray(local) || local.length !== 3 || !local.every(Number.isFinite)) return null;
  return model.localToWorld(target.fromArray(local));
}

export function prepareViewModel(model) {
  model.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = false;
    object.layers.set(VIEW_MODEL_LAYER);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.depthTest = true;
      material.depthWrite = true;
    }
  });
  return model;
}

export function shareViewModelLighting(scene) {
  scene.traverse(object => {
    if (object.isLight) object.layers.enable(VIEW_MODEL_LAYER);
  });
}

/** Preserve world color, clear only depth, then draw the correctly lit weapon. */
export function renderWithViewModel(renderer, scene, camera, renderWorld = null) {
  const mask = camera.layers.mask;
  const background = scene.background;
  const autoClear = renderer.autoClear;
  const shadowUpdate = renderer.shadowMap.autoUpdate;
  const infoReset = renderer.info.autoReset;
  // Renderer metrics must include both passes, not just the final weapon pass.
  renderer.info.reset();
  renderer.info.autoReset = false;
  try {
    camera.layers.set(0);
    if (renderWorld) renderWorld();
    else renderer.render(scene, camera);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    scene.background = null;
    camera.layers.set(VIEW_MODEL_LAYER);
    renderer.clearDepth();
    renderer.render(scene, camera);
  } finally {
    camera.layers.mask = mask;
    scene.background = background;
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadowUpdate;
    renderer.info.autoReset = infoReset;
  }
}
