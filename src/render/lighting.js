import * as THREE from 'three';

/**
 * Keep the shader's light count constant while selecting relevant practical lights.
 * Authored lights remain data sources; only this small pool reaches the GPU.
 * This avoids a shader recompile whenever a muzzle flash or pickup appears.
 */
export function createLightBudget(scene, zoneCull, count = 8) {
  const sources = [];
  const registered = new Set();
  function register(light) {
    if (!light?.isPointLight || registered.has(light)) return;
    registered.add(light);
    light.visible = false;
    sources.push({ light, position: new THREE.Vector3(), score: 0 });
  }
  scene.traverse(light => {
    register(light);
  });
  const pool = Array.from({ length: count }, () => {
    const light = new THREE.PointLight(0xffffff, 0, 15, 2);
    light.name = 'budgeted-practical-light';
    light.castShadow = false;
    scene.add(light);
    return light;
  });
  const candidates = [];
  return {
    pool, register,
    update(camera) {
      candidates.length = 0;
      for (const entry of sources) {
        const { light } = entry;
        light.visible = false;
        if (light.intensity <= 0) continue;
        if (light.userData.zone && !zoneCull.activeZones.has(light.userData.zone)) continue;
        light.getWorldPosition(entry.position);
        const distanceSq = entry.position.distanceToSquared(camera.position);
        const radius = light.distance || 30;
        if (distanceSq > (radius + 12) ** 2) continue;
        entry.score = light.intensity / (distanceSq + 6);
        candidates.push(entry);
      }
      candidates.sort((a, b) => b.score - a.score);
      for (let i = 0; i < pool.length; i++) {
        const target = pool[i];
        const source = candidates[i];
        target.intensity = source ? source.light.intensity * 1.8 : 0;
        if (!source) continue;
        target.position.copy(source.position);
        target.color.copy(source.light.color);
        target.distance = source.light.distance;
        target.decay = source.light.decay;
      }
    },
    snapshot() { return { budget: pool.length, sources: sources.length, active: candidates.length }; },
  };
}
