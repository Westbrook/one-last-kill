import * as THREE from 'three';

export const AUTHORED_HAND_FINISH_URL = '/assets/models/hands';
export const AUTHORED_HAND_FINISH_PROFILE = 'blender-hand-bake-v2';
const SIZE = 512;
const FILES = Object.freeze({ map: 'hand-albedo.png', normalMap: 'hand-normal.png', roughnessMap: 'hand-roughness.png' });
let maps = null, pending = null;
let status = { state: 'unloaded', url: AUTHORED_HAND_FINISH_URL };

export function getAuthoredHandFinishStatus() { return { ...status }; }

/** Shared, immutable maps. A material must only use them with their baked UV layout. */
export function getAuthoredHandFinishMaps() { return maps; }

/**
 * Prepare the three Blender-baked maps before viewmodel construction. A failed
 * or timed-out set never replaces the procedural finish with a partial atlas.
 * TextureLoader cannot abort a decode, so late arrivals are disposed as well.
 */
export async function loadAuthoredHandFinish({ loader, url = AUTHORED_HAND_FINISH_URL, timeoutMs = 8000 } = {}) {
  if (maps) return getAuthoredHandFinishStatus();
  if (pending) return pending;
  status = { state: 'loading', url };
  pending = (async () => {
    const start = performance.now(), owned = new Set(), disposed = new Set(), closed = new Set();
    let timer, expired = false;
    function dispose(texture) {
      if (!texture?.isTexture || disposed.has(texture)) return;
      disposed.add(texture); texture.dispose();
      if (!closed.has(texture.image)) { closed.add(texture.image); texture.image?.close?.(); }
    }
    try {
      const activeLoader = loader ?? new THREE.TextureLoader();
      const loading = Promise.all(Object.entries(FILES).map(async ([key, file]) => {
        const texture = await activeLoader.loadAsync(`${url.replace(/\/$/, '')}/${file}`);
        if (texture?.isTexture) owned.add(texture);
        if (expired) { dispose(texture); return [key, null]; }
        if (!texture?.isTexture || texture.image?.width !== SIZE || texture.image?.height !== SIZE) {
          throw new Error(`Hand ${key} must be a decoded ${SIZE}px texture`);
        }
        texture.name = `hands:blender-${key}`;
        texture.colorSpace = key === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        // Blender exports an ordinary bottom-left UV atlas into a top-row-first
        // PNG. Unlike the procedural DataTexture atlas, it needs flipY=true.
        texture.flipY = true;
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
        return [key, texture];
      }));
      const entries = await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Hand finish loading timed out')); }, timeoutMs);
      })]);
      if (owned.size !== 3 || new Set(entries.map(([, texture]) => texture.source)).size !== 3) {
        throw new Error('Hand finish requires three independent baked maps');
      }
      maps = Object.freeze(Object.fromEntries(entries));
      status = { state: 'ready', url, profile: AUTHORED_HAND_FINISH_PROFILE, textures: 3,
        textureSize: SIZE, textureBytes: 3 * SIZE * SIZE * 4 * 4 / 3, loadMs: performance.now() - start };
    } catch (error) {
      expired = true;
      for (const texture of owned) dispose(texture);
      status = { state: 'fallback', url, reason: String(error.message || error), loadMs: performance.now() - start };
    } finally { clearTimeout(timer); pending = null; }
    return getAuthoredHandFinishStatus();
  })();
  return pending;
}
