import * as THREE from 'three';
import { clamp, mulberry32 } from '../core/math.js';

const SIZE = 128;
const METERS = 16;
const SEED = 823701;
const VERSION = 'roof-membrane-v1';
const finishes = new WeakMap();
const finishMaterials = new WeakSet();
let macroTexture;

export const ROOF_MEMBRANE_DIAGNOSTICS = Object.freeze({
  version: VERSION,
  textureCount: 1,
  textureWidth: SIZE,
  textureHeight: SIZE,
  textureBytes: SIZE * SIZE * 4,
  textureBytesWithMipmaps: 87380,
  repeatMeters: METERS,
  extraTextureSamplesPerFragment: 1,
  extraDrawCallsPerMesh: 0,
  extraTriangles: 0,
  extraPasses: 0,
  perFrameUpdates: 0,
});

const wrap = value => ((value % 1) + 1) % 1;
const smooth = value => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

function periodicNoise(random, cells) {
  const values = Float32Array.from({ length: cells * cells }, () => random());
  return (u, v) => {
    const x = wrap(u) * cells, y = wrap(v) * cells;
    const ix = Math.floor(x), iy = Math.floor(y);
    const tx = smooth(x - ix), ty = smooth(y - iy);
    const a = values[iy * cells + ix], b = values[iy * cells + (ix + 1) % cells];
    const c = values[((iy + 1) % cells) * cells + ix];
    const d = values[((iy + 1) % cells) * cells + (ix + 1) % cells];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

/**
 * Linear data, not baked lighting: R is broad roll tone, G is dry weathering,
 * and B is a sparse repair mask. The original tar maps retain their small
 * aggregate, roll overlaps, normal relief and roughness. Duplicate border
 * samples keep both axes continuous under repeat and trilinear filtering.
 */
export function bakeRoofMembraneData({ size = SIZE, seed = SEED } = {}) {
  if (!Number.isInteger(size) || size < 32 || size > 256 || (size & (size - 1)) !== 0) {
    throw new RangeError('Roof membrane size must be a power of two from 32 to 256');
  }
  if (!Number.isSafeInteger(seed)) throw new RangeError('Roof membrane seed must be an integer');
  const random = mulberry32(seed);
  const broad = periodicNoise(random, 5), weather = periodicNoise(random, 11);
  const rolls = Float32Array.from({ length: 16 }, () => random() - 0.5);
  const repairs = Array.from({ length: 8 }, () => ({
    u: random(), v: random(),
    halfWidth: (0.7 + random() * 1.5) / (METERS * 2),
    halfHeight: (1.0 + random() * 2.8) / (METERS * 2),
    strength: 0.6 + random() * 0.4,
  }));
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1), row = wrap(v) * rolls.length;
    const rowIndex = Math.floor(row), rowFraction = row - rowIndex;
    // The micro map already supplies 1 m sheet seams. Only change the sheet
    // tone here, with a soft join rather than painting another dark grid.
    const rollTone = rolls[rowIndex] + (rolls[(rowIndex + 1) % rolls.length] - rolls[rowIndex])
      * smooth((rowFraction - 0.92) / 0.08);
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1), low = broad(u, v), worn = weather(u, v);
      let repair = 0;
      for (const patch of repairs) {
        const dx = Math.abs(wrap(u - patch.u + 0.5) - 0.5);
        const dy = Math.abs(wrap(v - patch.v + 0.5) - 0.5);
        const edgeWobble = (worn - 0.5) * 0.007;
        const edge = Math.max(dx - patch.halfWidth, dy - patch.halfHeight) + edgeWobble;
        const mask = 1 - smooth((edge + 0.006) / 0.013);
        repair = Math.max(repair, mask * patch.strength);
      }
      const offset = (y * size + x) * 4;
      data[offset] = Math.round(clamp(0.50 + (low - 0.5) * 0.56 + rollTone * 0.24 + (worn - 0.5) * 0.10, 0, 1) * 255);
      data[offset + 1] = Math.round(clamp(0.5 + (worn - 0.5) * 0.8 + (low - 0.5) * 0.15, 0, 1) * 255);
      data[offset + 2] = Math.round(repair * 255);
      data[offset + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

function getMacroTexture() {
  if (macroTexture) return macroTexture;
  const { width, height, data } = bakeRoofMembraneData();
  macroTexture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  macroTexture.name = VERSION;
  macroTexture.colorSpace = THREE.NoColorSpace;
  macroTexture.wrapS = macroTexture.wrapT = THREE.RepeatWrapping;
  macroTexture.minFilter = THREE.LinearMipmapLinearFilter;
  macroTexture.magFilter = THREE.LinearFilter;
  macroTexture.generateMipmaps = true;
  macroTexture.flipY = false;
  macroTexture.anisotropy = 4;
  macroTexture.needsUpdate = true;
  return macroTexture;
}

/**
 * Cached clone for roof deck meshes only. Keep the source untouched so other
 * tar-coated objects can retain their existing finish and shared micro maps.
 */
export function applyRoofMembraneFinish(source) {
  if (!source?.isMeshStandardMaterial) throw new TypeError('Roof membrane needs a standard material');
  if (finishMaterials.has(source)) return source;
  if (finishes.has(source)) return finishes.get(source);
  const material = source.clone();
  const originalCompile = source.onBeforeCompile;
  // The native key reads this.onBeforeCompile. Bind it to the untouched source
  // so two different prior hooks cannot collapse to our wrapper's same key.
  const originalCacheKey = source.customProgramCacheKey.bind(source);
  material.name = `${source.name || 'tar'}-${VERSION}`;
  material.userData.roofMembraneFinish = ROOF_MEMBRANE_DIAGNOSTICS;
  // An enumerable reference makes this custom sampler discoverable by the
  // project's existing texture/prewarm accounting without another upload.
  material.roofMembraneMap = getMacroTexture();
  material.onBeforeCompile = function(shader, renderer) {
    originalCompile.call(this, shader, renderer);
    const vertexChunks = ['#include <common>', '#include <uv_vertex>'];
    const fragmentChunks = ['#include <common>', '#include <map_fragment>', '#include <roughnessmap_fragment>'];
    if (!vertexChunks.every(chunk => shader.vertexShader.includes(chunk))
      || !fragmentChunks.every(chunk => shader.fragmentShader.includes(chunk))) {
      material.userData.roofMembraneFallback = true;
      return;
    }
    shader.uniforms.roofMembraneMap = { value: material.roofMembraneMap };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
varying vec2 vRoofMembraneUv;`).replace('#include <uv_vertex>', `#include <uv_vertex>
vRoofMembraneUv = uv * 0.125;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D roofMembraneMap;
varying vec2 vRoofMembraneUv;`).replace('#include <map_fragment>', `#include <map_fragment>
vec3 roofMembraneData = texture2D(roofMembraneMap, vRoofMembraneUv).rgb;
diffuseColor.rgb *= mix(1.03, 1.45, roofMembraneData.r) * mix(1.0, 0.86, roofMembraneData.b);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (roofMembraneData.g - 0.5) * 0.08 - roofMembraneData.b * 0.020, 0.78, 0.99);`);
  };
  material.customProgramCacheKey = () => `${originalCacheKey()}:${VERSION}`;
  finishes.set(source, material);
  finishMaterials.add(material);
  return material;
}
