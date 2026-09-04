import * as THREE from 'three';

export const AUTHORED_CHARACTERS_URL = '/assets/models/characters/manifest.json';
const ROLES = ['thug', 'brawler', 'gunman', 'bruiser', 'hitman', 'enforcer', 'shopkeeper', 'woman'];
const SURFACES = ['garments', 'skin', 'head', 'face-hair'];
const BONE_NAMES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'wristL', 'hipL', 'kneeL', 'ankleL',
  'shoulderR', 'elbowR', 'wristR', 'hipR', 'kneeR', 'ankleR'].map(name => `joint:${name}`);
const ARRAY_TYPES = { Float32Array, Uint8Array, Uint16Array, Uint32Array };
const LAYOUT = { position: 3, normal: 3, uv: 2, color: 3, skinIndex: 4, skinWeight: 4, heroSurface: 2, heroFaceProjection: 4 };
const FINISH_SIZE = 512;
const FINISH_MAPS = ['normal', 'roughness'];
const FINISH_SURFACES = ['garments', 'head'];
let catalog = null, pending = null;
let status = { state: 'unloaded', url: AUTHORED_CHARACTERS_URL };

const keyFor = (config, dimensions) => JSON.stringify([
  config.role || config.kind || 'adult', dimensions.height, dimensions.width,
  config.skin, config.shirt, config.pants, config.hair,
]);

function readAttribute(buffer, descriptor) {
  const Type = ARRAY_TYPES[descriptor?.type], offset = descriptor?.byteOffset, length = descriptor?.length;
  if (!Type || !Number.isInteger(offset) || offset < 0 || offset % Type.BYTES_PER_ELEMENT
    || !Number.isInteger(length) || length < 1 || offset + length * Type.BYTES_PER_ELEMENT > buffer.byteLength
    || !Number.isInteger(descriptor.itemSize) || length % descriptor.itemSize) {
    throw new Error('Invalid character buffer range');
  }
  const array = new Type(buffer, offset, length);
  if (!array.every(Number.isFinite)) throw new Error('Character attribute contains non-finite data');
  return new THREE.BufferAttribute(array, descriptor.itemSize, !!descriptor.normalized);
}

function validateAtlas(geometry) {
  const uv = geometry.attributes.uv, positions = geometry.attributes.position, index = geometry.index;
  if (uv.array.some(value => value < -0.000001 || value > 1.000001)) throw new Error('Character baked atlas UVs must stay within the texture');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const ia = index.getX(triangle), ib = index.getX(triangle + 1), ic = index.getX(triangle + 2);
    a.fromBufferAttribute(positions, ia); b.fromBufferAttribute(positions, ib); c.fromBufferAttribute(positions, ic);
    b.sub(a); c.sub(a);
    if (b.cross(c).lengthSq() <= 1e-20) continue;
    const area = (uv.getX(ib) - uv.getX(ia)) * (uv.getY(ic) - uv.getY(ia))
      - (uv.getY(ib) - uv.getY(ia)) * (uv.getX(ic) - uv.getX(ia));
    if (Math.abs(area) <= 1e-14) throw new Error('Character baked atlas contains a collapsed triangle');
  }
}

function prepareCatalog(manifest, buffer) {
  const owned = [], result = new Map(), finishes = [], roles = new Set();
  let triangles = 0, vertices = 0;
  try {
    if (manifest.version !== 1 || manifest.byteLength !== buffer.byteLength || buffer.byteLength > 12 * 1024 * 1024
      || manifest.catalog?.length !== ROLES.length) throw new Error('Unsupported character asset version or size');
    for (const entry of manifest.catalog) {
      if (!ROLES.includes(entry.id) || roles.has(entry.id) || result.has(keyFor(entry.config, entry.dimensions))
        || entry.surfaces?.length !== 4 || entry.bones?.length !== 17
        || entry.bones.some((bone, index) => bone.name !== BONE_NAMES[index]
          || bone.matrix?.length !== 16 || !bone.matrix.every(Number.isFinite))) {
        throw new Error('Character configuration or named skeleton contract is invalid');
      }
      roles.add(entry.id);
      if (entry.finish) {
        if (entry.id !== 'gunman' || entry.finish.version !== 1 || FINISH_SURFACES.some(surface =>
          FINISH_MAPS.some(map => entry.finish[surface]?.[map] !== `gunman-${surface}-${map}.png`))) {
          throw new Error('Unsupported character baked finish');
        }
      }
      const source = entry.finish ? 'original-blender-sculpted-baked' : 'original-blender-prepared';
      const geometries = {};
      let characterTriangles = 0;
      for (const [surfaceIndex, surface] of entry.surfaces.entries()) {
        if (surface.name !== SURFACES[surfaceIndex]) throw new Error('Character surface order is invalid');
        const geometry = new THREE.BufferGeometry(); owned.push(geometry);
        for (const [name, descriptor] of Object.entries(surface.attributes)) {
          if (LAYOUT[name] !== descriptor.itemSize) throw new Error(`Unexpected character attribute ${name}`);
          geometry.setAttribute(name, readAttribute(buffer, descriptor));
        }
        const attributes = geometry.attributes, count = attributes.position?.count;
        for (const name of ['position', 'normal', 'uv', 'color']) {
          if (!attributes[name] || attributes[name].count !== count) throw new Error(`Character has invalid ${name}`);
        }
        for (const attribute of Object.values(attributes)) {
          if (attribute.count !== count) throw new Error('Character vertex attributes have incompatible lengths');
        }
        const index = readAttribute(buffer, surface.index);
        if (index.itemSize !== 1 || !['Uint16Array', 'Uint32Array'].includes(index.array.constructor.name)
          || index.count % 3 || index.array.some(value => value >= count)) throw new Error('Character index is invalid');
        geometry.setIndex(index);
        for (let vertex = 0; vertex < count; vertex++) {
          const length = Math.hypot(attributes.normal.getX(vertex), attributes.normal.getY(vertex), attributes.normal.getZ(vertex));
          if (Math.abs(length - 1) > 0.001) throw new Error('Character normals must be normalized');
          if (surfaceIndex < 2) {
            if (!attributes.skinIndex || !attributes.skinWeight) throw new Error('Character skin attributes are missing');
            let sum = 0;
            for (let component = 0; component < 4; component++) {
              const bone = attributes.skinIndex.getComponent(vertex, component), weight = attributes.skinWeight.getComponent(vertex, component);
              if (!Number.isInteger(bone) || bone < 0 || bone >= 17 || weight < 0 || weight > 1) throw new Error('Character skin binding is invalid');
              sum += weight;
            }
            if (Math.abs(sum - 1) > 0.00001) throw new Error('Character skin weights must sum to one');
          }
        }
        if (surfaceIndex === 2 && !attributes.heroFaceProjection) throw new Error('Character face projection is missing');
        if (ROLES.indexOf(entry.id) < 6 && !attributes.heroSurface) throw new Error('Character finish attributes are missing');
        if (entry.finish && FINISH_SURFACES.includes(surface.name)) validateAtlas(geometry);
        geometry.userData = { ...surface.userData, authoredCharacter: { version: 1, source, role: entry.id,
          ...(entry.revision ? { revision: entry.revision } : {}) } };
        geometry.name = `blender-${entry.id}-${surface.name}`;
        geometry.computeBoundingBox(); geometry.computeBoundingSphere();
        geometries[surface.name] = geometry;
        characterTriangles += index.count / 3; vertices += count;
      }
      if (characterTriangles > 15000 || characterTriangles < 1000) throw new Error('Character exceeds its triangle budget');
      const { dimensions: d } = entry;
      for (const name of ['garments', 'skin']) {
        const box = geometries[name].boundingBox;
        if (box.min.x < -d.height * 0.5 || box.max.x > d.height * 0.5 || box.min.y < -0.002
          || box.max.y > d.height || box.min.z < -d.height * 0.2 || box.max.z > d.height * 0.25) {
          throw new Error('Character body is outside its bind-space envelope');
        }
      }
      const scale = entry.head?.scale;
      if (!scale || ['x', 'y', 'z'].some(axis => !Number.isFinite(scale[axis]) || scale[axis] <= 0 || scale[axis] > 1)) {
        throw new Error('Character head scale is invalid');
      }
      const value = { bones: entry.bones, source, ...(entry.revision ? { revision: entry.revision } : {}),
        body: { ...entry.body, garments: geometries.garments, skin: geometries.skin,
          provenance: entry.finish
            ? 'Original Blender sculpt with a budgeted game mesh and baked normal/roughness atlases; retained named GPU skeleton'
            : 'Original project topology, tailored and surface-refined in Blender; unchanged named GPU skin binding' },
        head: { head: geometries.head, details: geometries['face-hair'], scale: Object.freeze({ ...scale }) } };
      if (entry.finish) finishes.push({ spec: entry.finish, value });
      result.set(keyFor(entry.config, entry.dimensions), value); triangles += characterTriangles;
    }
    return { catalog: result, finishes, dispose: () => owned.forEach(geometry => geometry.dispose()),
      metrics: { characters: result.size, meshes: owned.length, triangles, vertices,
        geometryBytes: buffer.byteLength, textures: 0, textureBytes: 0, finishes: [], drawsPerCharacter: 4 } };
  } catch (error) {
    for (const geometry of owned) geometry.dispose();
    throw error;
  }
}

export function getAuthoredCharacterStatus() { return { ...status, ...(status.finishes ? { finishes: [...status.finishes] } : {}) }; }

async function prepareFinishes(prepared, baseUrl, textureLoader, textures, expired) {
  await Promise.all(prepared.finishes.map(async ({ spec, value }) => {
    const finish = { version: 1, id: 'gunman-sculpt-bake-v1', role: 'gunman' };
    await Promise.all(FINISH_SURFACES.map(async surface => {
      const maps = {};
      await Promise.all(FINISH_MAPS.map(async map => {
        const candidate = await textureLoader.loadAsync(baseUrl + spec[surface][map]);
        if (expired()) { candidate?.dispose?.(); throw new Error('Character finish arrived after loading expired'); }
        if (candidate?.isTexture) textures.add(candidate);
        if (!candidate?.isTexture || candidate.image?.width !== FINISH_SIZE || candidate.image?.height !== FINISH_SIZE) {
          throw new Error('Character baked finish must contain decoded 512-pixel square textures');
        }
        candidate.name = `hero-gunman-${surface}-${map}`;
        candidate.colorSpace = THREE.NoColorSpace;
        candidate.wrapS = candidate.wrapT = THREE.ClampToEdgeWrapping;
        candidate.flipY = true; candidate.generateMipmaps = true;
        candidate.minFilter = THREE.LinearMipmapLinearFilter; candidate.magFilter = THREE.LinearFilter;
        candidate.anisotropy = 4; candidate.needsUpdate = true;
        maps[`${map}Map`] = candidate;
      }));
      finish[surface] = Object.freeze(maps);
    }));
    value.finish = Object.freeze(finish);
  }));
  prepared.metrics.textures = textures.size;
  prepared.metrics.textureBytes = textures.size * Math.ceil(FINISH_SIZE * FINISH_SIZE * 4 * 4 / 3);
  prepared.metrics.finishes = prepared.finishes.map(({ value }) => value.finish.role);
}

/** Boot-only preparation. Failure leaves the existing synchronous builder available. */
export async function loadAuthoredCharacterSurfaces({ fetchImpl = globalThis.fetch, manifestUrl = AUTHORED_CHARACTERS_URL,
  textureLoader = new THREE.TextureLoader(), timeoutMs = 8000 } = {}) {
  if (catalog) return getAuthoredCharacterStatus();
  if (pending) return pending;
  status = { state: 'loading', url: manifestUrl };
  pending = (async () => {
    const started = performance.now(), controller = new globalThis.AbortController();
    let timer, prepared = null, expired = false;
    const textures = new Set();
    try {
      const loading = (async () => {
        const response = await fetchImpl(manifestUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`Character manifest HTTP ${response.status}`);
        const manifest = await response.json();
        if (manifest.binary !== 'characters.bin') throw new Error('Unexpected character binary path');
        const binaryUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1) + manifest.binary;
        const binary = await fetchImpl(binaryUrl, { signal: controller.signal });
        if (!binary.ok) throw new Error(`Character geometry HTTP ${binary.status}`);
        const buffer = await binary.arrayBuffer();
        if (globalThis.crypto?.subtle) {
          const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
          const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
          if (hash !== manifest.sha256) throw new Error('Character geometry checksum mismatch');
        }
        if (expired) throw new Error('Character geometry arrived after loading expired');
        prepared = prepareCatalog(manifest, buffer);
        await prepareFinishes(prepared, manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1), textureLoader, textures, () => expired);
        return prepared;
      })();
      const loaded = await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error('Character loading timed out')); }, timeoutMs);
      })]);
      catalog = loaded.catalog;
      status = { state: 'ready', url: manifestUrl, ...loaded.metrics, elapsedMs: performance.now() - started };
    } catch (error) {
      expired = true; controller.abort(); prepared?.dispose();
      for (const texture of textures) texture.dispose();
      status = { state: 'fallback', url: manifestUrl, error: String(error.message || error), elapsedMs: performance.now() - started };
    } finally { clearTimeout(timer); pending = null; }
    return getAuthoredCharacterStatus();
  })();
  return pending;
}

/** Shared immutable geometry; every pool slot still creates its own skeleton. */
export function getAuthoredCharacterSurfaces(config, dimensions, bones) {
  const entry = catalog?.get(keyFor(config, dimensions));
  if (!entry || bones.length !== entry.bones.length) return null;
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i], contract = entry.bones[i];
    if (bone.name !== contract.name || bone.matrixWorld.elements.some((value, component) => Math.abs(value - contract.matrix[component]) > 0.000001)) return null;
  }
  return entry;
}
