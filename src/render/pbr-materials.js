import * as THREE from 'three';

const MAP_KEYS = Object.freeze(['map', 'normalMap', 'roughnessMap']);
const REPLACED_KEYS = Object.freeze([...MAP_KEYS, 'metalnessMap', 'bumpMap']);
const GPU_FORMAT_NAMES = Object.freeze({
  [THREE.RGBA_ASTC_4x4_Format]: 'ASTC 4x4',
  [THREE.RGBA_BPTC_Format]: 'BC7',
});

function surfaceSpec(id, meters, normalScale, color, downloadBytes) {
  const root = `/assets/materials/${id}/${id}`;
  return Object.freeze({
    id, meters, normalScale, color, downloadBytes, resolution: 1024, format: 'raw',
    maps: Object.freeze({
      map: `${root}_diff_1k.jpg`,
      normalMap: `${root}_nor_gl_1k.png`,
      roughnessMap: `${root}_rough_1k.jpg`,
    }),
    provenance: Object.freeze({
      provider: 'Poly Haven', assetId: id,
      sourceUrl: `https://polyhaven.com/a/${id}`,
      authors: Object.freeze(['Rob Tuytel']),
      license: 'CC0-1.0', licenseUrl: 'https://polyhaven.com/license',
      manifestUrl: '/assets/materials/manifest.json', normalConvention: 'OpenGL +Y',
    }),
  });
}

// Keep the prior wall palette and restrained relief while using the source
// material's measured scale. Tests compare these URLs and spans to provenance.
export const PBR_SURFACES = Object.freeze({
  brick: surfaceSpec('red_brick', 1.4, 0.65, 0xffffff, 3181338),
  plaster: surfaceSpec('plastered_wall_03', 4, 0.8, 0xb4bdae, 5903369),
});

function compressedSpec(raw, downloadBytes) {
  const root = `/assets/materials-ktx2-trial/${raw.id}`;
  return Object.freeze({
    ...raw, format: 'ktx2', orientation: 'ru', mipLevels: 11, downloadBytes,
    maps: Object.freeze({ map: `${root}_diff_1k.ktx2`, normalMap: `${root}_nor_gl_1k.ktx2`, roughnessMap: `${root}_rough_1k.ktx2` }),
    provenance: Object.freeze({ ...raw.provenance, manifestUrl: '/assets/materials-ktx2-trial/manifest.json', encoding: 'UASTC4 + Zstd18; no RDO' }),
  });
}

// Retain the trial filenames as provenance: these exact encoded bytes passed
// visual ASTC review and the independent BC7 quality/decoder checks.
export const PBR_KTX2_TRIAL = Object.freeze({
  brick: compressedSpec(PBR_SURFACES.brick, 3096559),
  plaster: compressedSpec(PBR_SURFACES.plaster, 2832460),
});

export function getRequestedSurfaceFormat({ dev = false, search = '' } = {}) {
  if (dev !== true) return 'ktx2';
  const params = new URLSearchParams(search);
  return params.get('qa') === '1' && params.get('mute') === '1' && params.get('surfaces') === 'raw' ? 'raw' : 'ktx2';
}

export function supportsPbrCompression(workerConfig) {
  // Other transcode targets have not passed the same quality review. Do not
  // alter the decoder's format choice or reinterpret its returned block data.
  return workerConfig?.astcSupported === true || workerConfig?.bptcSupported === true;
}

function materialTextures(material) {
  return new Set(Object.values(material).filter(value => value?.isTexture));
}

function disposeTextures(textures, retained = new Set()) {
  for (const texture of new Set(textures)) {
    if (!texture?.isTexture || retained.has(texture)) continue;
    try {
      texture.dispose();
    } catch (error) {
      // Disposal listeners must not turn a completed material swap into a
      // failed load, or prevent the remaining detached maps being released.
      console.warn('Could not release a detached surface texture.', error);
    }
  }
}

function validateMaterial(material) {
  if (!material?.isMeshStandardMaterial) throw new TypeError('A standard surface material is required');
}

/**
 * Commit a prepared triplet without replacing the shared material object.
 * Call during boot, before world geometry or material clones capture its UV
 * scale and texture references. Runtime replacement needs clone ownership.
 */
export function commitSurfaceMaps(material, maps, { surfaceMeters, normalScale, color, userData = {} }) {
  validateMaterial(material);
  if (!Number.isFinite(surfaceMeters) || surfaceMeters <= 0
    || !Number.isFinite(normalScale) || normalScale <= 0) {
    throw new RangeError('Surface scale and normal strength must be positive');
  }
  if (!MAP_KEYS.every(key => maps[key]?.isTexture)) throw new TypeError('A complete surface triplet is required');
  const nextColor = color === undefined ? null : new THREE.Color(color);
  const previous = REPLACED_KEYS.map(key => material[key]);
  const nextUserData = { ...material.userData, ...userData, surfaceMeters, staticSurfaceMaps: true };

  material.map = maps.map;
  material.normalMap = maps.normalMap;
  material.roughnessMap = maps.roughnessMap;
  material.normalMapType = THREE.TangentSpaceNormalMap;
  material.normalScale.set(normalScale, normalScale);
  material.bumpMap = null;
  material.metalnessMap = null;
  material.roughness = 1;
  material.metalness = 0;
  if (nextColor) material.color.copy(nextColor);
  material.userData = nextUserData;
  material.needsUpdate = true;

  // A texture can occupy several old slots, or remain live in another slot
  // such as envMap. Dispose only detached textures, once each.
  disposeTextures(previous, materialTextures(material));
  return material;
}

function configureTexture(texture, color, maxAnisotropy, compressed) {
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.offset.set(0, 0);
  texture.center.set(0, 0);
  texture.rotation = 0;
  texture.channel = 0;
  texture.matrixAutoUpdate = true;
  texture.updateMatrix();
  // Compressed blocks cannot be flipped during upload. The experimental
  // encoder stored bottom-left rows (ru), without changing normal green.
  texture.flipY = !compressed;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = !compressed;
  texture.anisotropy = Math.min(8, Math.max(1, Number.isFinite(maxAnisotropy) ? maxAnisotropy : 1));
  texture.needsUpdate = true;
}

function validCompressedTexture(texture, spec) {
  if (!texture.isCompressedTexture || !GPU_FORMAT_NAMES[texture.format]
    || !Array.isArray(texture.mipmaps) || texture.mipmaps.length !== spec.mipLevels) return false;
  for (let level = 0; level < spec.mipLevels; level++) {
    const mip = texture.mipmaps[level];
    if (!mip || mip.width !== Math.max(1, spec.resolution >> level)
      || mip.height !== Math.max(1, spec.resolution >> level)
      || !ArrayBuffer.isView(mip.data) || mip.data.byteLength === 0) return false;
  }
  return true;
}

/** Load every channel before publishing any of them; rejected sets own cleanup. */
export async function loadPbrMaterial(material, spec, { loader = new THREE.TextureLoader(), maxAnisotropy = 1 } = {}) {
  validateMaterial(material);
  if (!spec || !Number.isInteger(spec.resolution) || spec.resolution < 1
    || !MAP_KEYS.every(key => typeof spec.maps?.[key] === 'string' && spec.maps[key])) {
    throw new TypeError('A complete PBR surface specification is required');
  }
  const compressed = spec.format === 'ktx2';
  const mipLevels = Math.floor(Math.log2(spec.resolution)) + 1;
  if (compressed && (spec.orientation !== 'ru' || spec.mipLevels !== mipLevels)) {
    throw new TypeError('KTX2 trial maps require bottom-left rows and a complete mip chain');
  }

  // Waiting for every request prevents a late successful map leaking after a
  // different request fails. Async callbacks also capture synchronous errors.
  const results = await Promise.allSettled(MAP_KEYS.map(async key => loader.loadAsync(spec.maps[key])));
  const loaded = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) {
    disposeTextures(loaded, materialTextures(material));
    throw new AggregateError(failures.map(result => result.reason), `Could not load the complete PBR set: ${spec.id}`);
  }

  try {
    const active = materialTextures(material);
    if (new Set(loaded).size !== MAP_KEYS.length
      || loaded.some(texture => !texture?.isTexture || active.has(texture)
        || texture.image?.width !== spec.resolution || texture.image?.height !== spec.resolution
        || (compressed ? !validCompressedTexture(texture, spec) : texture.isCompressedTexture))) {
      throw new TypeError(`PBR maps must be distinct new ${spec.resolution}px textures: ${spec.id}`);
    }
    const maps = Object.fromEntries(MAP_KEYS.map((key, index) => [key, loaded[index]]));
    for (const key of MAP_KEYS) configureTexture(maps[key], key === 'map', maxAnisotropy, compressed);
    const compressedBytes = compressed ? loaded.reduce((sum, texture) => sum + texture.mipmaps.reduce((bytes, mip) => bytes + mip.data.byteLength, 0), 0) : 0;
    const textureBytes = compressed ? loaded.reduce((sum, texture) => sum + texture.mipmaps[0].data.byteLength, 0) : spec.resolution * spec.resolution * 4 * MAP_KEYS.length;
    const selectedFormat = compressed ? 'ktx2' : 'raw';
    return commitSurfaceMaps(material, maps, {
      surfaceMeters: spec.meters, normalScale: spec.normalScale, color: spec.color,
      userData: {
        surfaceSource: 'polyhaven', surfaceFormat: selectedFormat, generatedAlbedoUrl: undefined,
        pbrProvenance: {
          ...spec.provenance, maps: { ...spec.maps }, tileSpanMeters: spec.meters, resolution: spec.resolution,
          selectedFormat, mipLevels, compressedBytes, orientation: compressed ? 'ru' : 'top-left; flipY',
          gpuFormats: Object.fromEntries(MAP_KEYS.map(key => [key, maps[key].format])),
          gpuFormatNames: Object.fromEntries(MAP_KEYS.map(key => [key, compressed ? GPU_FORMAT_NAMES[maps[key].format] : 'RGBA8'])),
        },
        // TextureLoader uploads these images as unsigned-byte RGBA, including
        // the 16-bit PNG source. These are residency estimates, not file bytes.
        textureBytes, textureBytesWithMipmaps: compressed ? compressedBytes : Math.ceil(textureBytes * 4 / 3),
        textureDownloadBytes: spec.downloadBytes,
      },
    });
  } catch (error) {
    disposeTextures(loaded, materialTextures(material));
    throw error;
  }
}

/** A failed compressed triplet cannot contaminate the independent raw triplet. */
export async function loadPbrMaterialWithFallback(material, rawSpec, { loader, maxAnisotropy = 1, ktx2Loader, ktx2Spec } = {}) {
  let compressedError;
  if (ktx2Loader && ktx2Spec) {
    try {
      return await loadPbrMaterial(material, ktx2Spec, { loader: ktx2Loader, maxAnisotropy });
    } catch (error) {
      compressedError = error;
    }
  }
  try {
    const result = await loadPbrMaterial(material, rawSpec, { loader, maxAnisotropy });
    if (compressedError) result.userData.pbrProvenance.fallbackFrom = 'ktx2';
    return result;
  } catch (rawError) {
    if (compressedError) throw new AggregateError([compressedError, rawError], `Compressed and raw PBR sets failed: ${rawSpec.id}`);
    throw rawError;
  }
}
