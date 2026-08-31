import * as THREE from 'three';

const COMBAT_ROLES = new Set(['brawler', 'thug', 'gunman', 'bruiser', 'hitman', 'enforcer']);
export const hasHeroSurfaceFinish = role => COMBAT_ROLES.has(role);

/** Two immutable bytes per vertex: authored roughness and microdetail weight. */
export function authorHeroSurface(geometry, sample) {
  const position = geometry.attributes.position, values = new Uint8Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const finish = sample(position.getX(i), position.getY(i), position.getZ(i), i);
    values[i * 2] = Math.round(THREE.MathUtils.clamp(finish[0], 0, 1) * 255);
    values[i * 2 + 1] = Math.round(THREE.MathUtils.clamp(finish[1], 0, 1) * 255);
  }
  geometry.setAttribute('heroSurface', new THREE.Uint8BufferAttribute(values, 2, true));
  return geometry;
}

/** Keep one PBR draw while sewn cloth, leather, skin and hair retain their finish. */
export function applyHeroSurfaceFinish(material, roughnessReference = 1) {
  const previousCompile = material.onBeforeCompile, previousKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${previousKey}|hero-authored-surface-v1`;
  material.onBeforeCompile = shader => {
    previousCompile.call(material, shader);
    shader.uniforms.heroRoughnessReference = { value: roughnessReference };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
attribute vec2 heroSurface;
varying vec2 vHeroSurface;`).replace('#include <begin_vertex>', `#include <begin_vertex>
vHeroSurface = heroSurface;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform float heroRoughnessReference;
varying vec2 vHeroSurface;`).replace('#include <map_fragment>', `
vec3 heroBaseColor = diffuseColor.rgb;
#include <map_fragment>
diffuseColor.rgb = mix(heroBaseColor, diffuseColor.rgb, vHeroSurface.y);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(vHeroSurface.x + (roughnessFactor - heroRoughnessReference) * 0.28, 0.25, 1.0);`)
      .replace('#include <normal_fragment_maps>', `
vec3 heroBaseNormal = normal;
#include <normal_fragment_maps>
normal = normalize(mix(heroBaseNormal, normal, vHeroSurface.y));`);
  };
  material.userData.heroSurface = { version: 1, vertexBytes: 2, roughnessReference,
    provenance: 'Original code-authored material regions; immutable shared vertex data; existing PBR maps and lighting' };
  return material;
}
