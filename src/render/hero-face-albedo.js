import * as THREE from 'three';

export const HERO_FACE_ALBEDO_URL = '/assets/characters/face-albedo-trial.png';
const PROVENANCE = 'AI-generated fictional facial albedo accepted after in-game front/profile review; mild source shading remains; original authored geometry and projection, not a calibrated scan; no derived normal map';
const fallback = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
fallback.colorSpace = THREE.SRGBColorSpace; fallback.needsUpdate = true;
const materials = new Set();
const uniforms = {
  heroFaceAlbedo: { value: fallback }, heroFaceEnabled: { value: 0 }, heroFaceStrength: { value: 0.78 },
  heroFaceReference: { value: new THREE.Color('#c09072') },
};
const state = { status: 'unloaded', review: 'accepted-2026-08-29', requestedEnabled: false, url: HERO_FACE_ALBEDO_URL, width: 0, height: 0, memoryBytes: 0 };
let pending = null;

const smooth = (a, b, value) => { const t = Math.max(0, Math.min(1, (value - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Normalized head point -> planar image UV, with a soft side/back exclusion. */
const LANDMARK_ROWS = [[0, 0.04], [0.242, 0.282], [0.371, 0.393], [0.554, 0.58], [0.626, 0.638], [0.76, 0.78], [1, 0.98]];
export function heroFaceProjection(x, y, angle, target = [0, 0, 0, 0]) {
  let row = 0; while (row < LANDMARK_ROWS.length - 2 && y > LANDMARK_ROWS[row + 1][0]) row++;
  const a = LANDMARK_ROWS[row], b = LANDMARK_ROWS[row + 1], t = Math.max(0, Math.min(1, (y - a[0]) / (b[0] - a[0])));
  // Preserve central landmarks while compressing the outer cheek into skin
  // pixels. A linear projection would sample source ears/hair at the temples.
  target[0] = 0.502 + x * 0.75 - Math.sign(x) * Math.max(0, Math.abs(x) - 0.20) * 0.25;
  target[1] = a[1] + (b[1] - a[1]) * t;
  target[2] = smooth(0.30, 0.80, Math.cos(angle)) * smooth(0.015, 0.07, y) * (1 - smooth(0.76, 0.84, y));
  target[3] = y;
  return target;
}

function syncEnabled() { uniforms.heroFaceEnabled.value = state.requestedEnabled && state.status === 'ready' ? 1 : 0; }

export function getHeroFaceTextureStatus() {
  return { ...state, enabled: uniforms.heroFaceEnabled.value === 1, strength: uniforms.heroFaceStrength.value,
    referenceColor: `#${uniforms.heroFaceReference.value.getHexString()}`, materials: materials.size, provenance: PROVENANCE };
}

/** A/B changes only a uniform; existing pooled meshes and shader programs stay put. */
export function setHeroFaceTextureEnabled(enabled) {
  state.requestedEnabled = !!enabled; syncEnabled(); return getHeroFaceTextureStatus();
}

export function setHeroFaceTextureTuning({ strength, referenceColor } = {}) {
  if (strength !== undefined) {
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new RangeError('Face strength must be between zero and one.');
    uniforms.heroFaceStrength.value = strength;
  }
  if (referenceColor !== undefined) uniforms.heroFaceReference.value.set(referenceColor);
  return getHeroFaceTextureStatus();
}

function imageReference(image) {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, 32, 32);
    // Compare diffuse cheeks/forehead, never eye whites, hair or the background.
    const patches = [[15, 8], [17, 8], [10, 17], [21, 17]], sums = [0, 0, 0];
    for (const [x, y] of patches) {
      const rgba = context.getImageData(x, y, 1, 1).data;
      for (let k = 0; k < 3; k++) sums[k] += rgba[k] / (255 * patches.length);
    }
    return new THREE.Color().setRGB(...sums, THREE.SRGBColorSpace);
  } catch { return null; }
}

/** Explicit boot/QA await. Import is inert; the caller controls A/B enablement. */
export async function loadHeroFaceAlbedo({ url = HERO_FACE_ALBEDO_URL, loader = new THREE.TextureLoader(), referenceColor, timeoutMs = 8000 } = {}) {
  if (typeof url !== 'string' || !url || typeof loader?.loadAsync !== 'function') throw new TypeError('Face loading needs a URL and an asynchronous texture loader.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Face loading needs a positive finite timeout.');
  if (state.status === 'ready' && state.url === url) return getHeroFaceTextureStatus();
  if (pending) {
    if (state.url !== url) throw new Error('A different face albedo source is already loading.');
    return pending;
  }
  state.status = 'loading'; state.url = url; syncEnabled();
  pending = (async () => {
    let timer, candidate = null, expired = false;
    try {
      const loading = Promise.resolve().then(() => loader.loadAsync(url)).then(texture => { if (expired) texture?.dispose?.(); return texture; });
      candidate = await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Face albedo timed out')); }, timeoutMs);
      })]);
      const width = candidate?.image?.width, height = candidate?.image?.height;
      if (!candidate?.isTexture || !Number.isInteger(width) || !Number.isInteger(height) || height !== width || width < 512 || width > 1280) {
        throw new RangeError('Facial albedo must be a decoded square texture of 512–1280px; the accepted source is 1254px.');
      }
      candidate.colorSpace = THREE.SRGBColorSpace; candidate.wrapS = candidate.wrapT = THREE.ClampToEdgeWrapping;
      candidate.flipY = true; candidate.generateMipmaps = true;
      candidate.minFilter = THREE.LinearMipmapLinearFilter; candidate.magFilter = THREE.LinearFilter; candidate.anisotropy = 4;
      candidate.name = 'hero-frontal-face-albedo'; candidate.needsUpdate = true;
      const reference = referenceColor !== undefined ? new THREE.Color(referenceColor) : imageReference(candidate.image);
      if (reference) uniforms.heroFaceReference.value.copy(reference);
      const previous = uniforms.heroFaceAlbedo.value;
      uniforms.heroFaceAlbedo.value = candidate;
      for (const material of materials) material.heroFaceMap = candidate;
      if (previous !== fallback) previous.dispose();
      state.width = width; state.height = height; state.memoryBytes = Math.ceil(width * height * 4 * 4 / 3);
      state.status = 'ready'; delete state.error; syncEnabled();
    } catch (error) {
      candidate?.dispose?.(); state.status = 'failed'; state.error = String(error.message || error); syncEnabled();
    } finally { clearTimeout(timer); pending = null; }
    return getHeroFaceTextureStatus();
  })();
  return pending;
}

/** Keep PBR lighting/roughness; replace forward diffuse colour only, in one draw. */
export function heroFaceMaterial(skin, { authored = false } = {}) {
  const material = skin.clone(); material.name = 'hero-projected-face';
  // Enumerable texture reference lets boot prewarming discover the custom sampler.
  material.heroFaceMap = uniforms.heroFaceAlbedo.value;
  material.userData.heroFaceAlbedo = { version: 3, provenance: PROVENANCE,
    paletteResponse: authored ? 'compressed contrast/chroma around shared body skin palette' : 'original palette-relative projection' };
  // Material.clone does not copy custom shader hooks. Keep the same authored
  // skin finish across the jaw, neck and hands before applying facial colour.
  const skinCompile = skin.onBeforeCompile, skinKey = skin.customProgramCacheKey();
  material.customProgramCacheKey = () => `${skinKey}|hero-frontal-face-v3:${authored}`;
  material.onBeforeCompile = shader => {
    skinCompile.call(material, shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
attribute vec4 heroFaceProjection;
varying vec4 vHeroFaceProjection;
varying vec3 vHeroHeadPosition;`).replace('#include <begin_vertex>', `#include <begin_vertex>
vHeroFaceProjection = heroFaceProjection;
vHeroHeadPosition = position;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D heroFaceAlbedo;
uniform float heroFaceEnabled;
uniform float heroFaceStrength;
uniform vec3 heroFaceReference;
varying vec4 vHeroFaceProjection;
varying vec3 vHeroHeadPosition;`).replace('#include <color_fragment>', `#include <color_fragment>
if ( heroFaceEnabled > 0.5 ) {
  vec2 facePoint = vHeroHeadPosition.xy;
  float jawMask = smoothstep(0.025, 0.09, facePoint.y) * (1.0 - smoothstep(0.31, 0.43, facePoint.y)) * smoothstep(-0.26, 0.08, vHeroHeadPosition.z);
  vec2 grainPoint = vHeroHeadPosition.xy * vec2(190.0, 210.0);
  float grain = fract(sin(dot(floor(grainPoint), vec2(12.9898, 78.233))) * 43758.5453);
  vec2 grainFootprint = fwidth(grainPoint);
  grain = mix(grain, 0.5, smoothstep(0.65, 1.5, max(grainFootprint.x, grainFootprint.y)));
  diffuseColor.rgb *= 1.0 - jawMask * (${authored ? '0.018 + grain * 0.025' : '0.035 + grain * 0.055'});
  float eyeMask = smoothstep(0.85, 1.35, length(vec2((abs(facePoint.x) - 0.175) / 0.086, (facePoint.y - 0.554) / 0.033)));
  float browMask = smoothstep(0.8, 1.35, length(vec2((abs(facePoint.x) - 0.175) / 0.098, (facePoint.y - 0.626) / 0.022)));
  float faceMix = vHeroFaceProjection.z * eyeMask * browMask * heroFaceStrength;
  vec3 faceSample = texture2D(heroFaceAlbedo, vHeroFaceProjection.xy).rgb;
  vec3 paletteRelative = clamp(faceSample / max(heroFaceReference, vec3(0.01)), vec3(0.16), vec3(1.85));
  ${authored ? `// Compress the generated source's baked contrast and chroma around the
  // same skin palette used by the neck and arms, retaining diffuse landmarks.
  float faceLuminance = dot(paletteRelative, vec3(0.2126, 0.7152, 0.0722));
  paletteRelative = mix(vec3(1.0), mix(vec3(faceLuminance), paletteRelative, 0.64), 0.78);` : ''}
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * paletteRelative, faceMix);
}`);
  };
  materials.add(material); return material;
}
