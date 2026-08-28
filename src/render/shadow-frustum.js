import * as THREE from 'three';

/** Fit a static key light to playable geometry instead of distant city dressing. */
export function fitWorldShadow(light, bounds, { mapSize = 2048, margin = 1.5 } = {}) {
  const center = bounds.getCenter(new THREE.Vector3());
  light.target.position.copy(center);
  light.position.copy(center).add(new THREE.Vector3(-38, 58, -34));
  light.target.updateMatrixWorld(true);
  light.updateMatrixWorld(true);
  const camera = light.shadow.camera;
  camera.position.copy(light.position);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  const viewBounds = new THREE.Box3();
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    viewBounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
  }
  camera.left = viewBounds.min.x - margin;
  camera.right = viewBounds.max.x + margin;
  camera.bottom = viewBounds.min.y - margin;
  camera.top = viewBounds.max.y + margin;
  camera.near = Math.max(0.5, -viewBounds.max.z - margin);
  camera.far = -viewBounds.min.z + margin;
  camera.updateProjectionMatrix();
  light.shadow.mapSize.set(mapSize, mapSize);
  light.shadow.bias = -0.0002;
  light.shadow.normalBias = 0.035;
  return camera;
}
