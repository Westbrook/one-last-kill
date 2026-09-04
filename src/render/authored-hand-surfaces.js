import * as THREE from 'three';
import { loadAuthoredHandFinish } from './authored-hand-finish.js';

export const AUTHORED_HAND_SURFACES_URL = '/assets/models/hands/hands.bin';
export const AUTHORED_HAND_RADII = Object.freeze([null, 0.015, 0.022, 0.030, 0.034, 0.036, 0.038, 0.040]);
const keyFor = radius => radius === null ? 'fist' : `grip-${Math.round(radius * 1000).toString().padStart(3, '0')}`;
const constructors = { f32: Float32Array, i16: Int16Array, u16: Uint16Array, u8: Uint8Array };
let templates = null, arms = null, pending = null;
let status = { state: 'unloaded', url: AUTHORED_HAND_SURFACES_URL };

function parsePack(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16 || buffer.byteLength > 1_500_000) {
    throw new Error('Hand surface pack has an invalid size');
  }
  const view = new DataView(buffer), magic = new globalThis.TextDecoder().decode(new Uint8Array(buffer, 0, 4));
  const headerBytes = view.getUint32(4, true), payload = 8 + headerBytes;
  if (magic !== 'HND1' || headerBytes > 32_768 || payload % 4 || payload >= buffer.byteLength) {
    throw new Error('Hand surface pack has an invalid header');
  }
  const header = JSON.parse(new globalThis.TextDecoder().decode(new Uint8Array(buffer, 8, headerBytes)).trim());
  if (![1, 2].includes(header.version) || header.meshes?.length !== 10 || !Array.isArray(header.buffers)) {
    throw new Error('Hand surface pack has an unsupported layout');
  }
  const arrays = header.buffers.map(item => {
    const Type = constructors[item.type], bytes = Type?.BYTES_PER_ELEMENT;
    if (!bytes || !Number.isInteger(item.offset) || !Number.isInteger(item.count) || item.offset < 0
      || item.count < 1 || (payload + item.offset) % bytes || payload + item.offset + item.count * bytes > buffer.byteLength) {
      throw new Error('Hand surface pack has an invalid buffer');
    }
    const encoded = new Type(buffer, payload + item.offset, item.count);
    if (item.type === 'u16' && item.scale === undefined) return encoded;
    const scale = item.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Hand surface pack has an invalid scale');
    const decoded = Float32Array.from(encoded, value => value * scale);
    if (!decoded.every(Number.isFinite)) throw new Error('Hand surface pack has a non-finite value');
    return decoded;
  });
  const loaded = new Map(), all = [];
  try {
    for (const mesh of header.meshes) {
      if (loaded.has(mesh.key) || typeof mesh.key !== 'string') throw new Error('Hand surface pack has duplicate mesh keys');
      const geometry = new THREE.BufferGeometry(); all.push(geometry);
      const isHand = mesh.key !== 'sleeve' && mesh.key !== 'cuff';
      for (const [name, itemSize] of Object.entries({ position: 3, normal: 3, uv: 2, ...(isHand ? { color: 3 } : {}) })) {
        const values = arrays[mesh.attributes?.[name]];
        if (!(values instanceof Float32Array) || !values.length || values.length % itemSize) {
          throw new Error(`Hand surface pack has invalid ${name}`);
        }
        geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
      }
      const count = geometry.attributes.position.count;
      if (count > 3000 || Object.values(geometry.attributes).some(attribute => attribute.count !== count)) {
        throw new Error('Hand surface pack has incompatible attributes');
      }
      const index = arrays[mesh.index];
      if (!(index instanceof Uint16Array) || index.length % 3 || index.some(vertex => vertex >= count)
        || index.length / 3 > (isHand ? 3200 : mesh.key === 'sleeve' ? 750 : 350)) {
        throw new Error('Hand surface pack exceeds its topology budget');
      }
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      if (isHand && header.version === 2) {
        const uv = geometry.attributes.uv;
        for (let i = 0; i < count; i++) {
          const u = uv.getX(i), v = uv.getY(i), low = v < .5 ? .03125 : .53125;
          if (u < .03125 - 1e-7 || u > .96875 + 1e-7 || v < low - 1e-7 || v > low + .4375 + 1e-7) {
            throw new Error('Hand surface pack has UVs outside its padded material islands');
          }
        }
        for (let i = 0; i < index.length; i += 3) {
          const a = index[i], b = index[i + 1], c = index[i + 2];
          const area = (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a))
            - (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a));
          if ((uv.getY(a) < .5) !== (uv.getY(b) < .5) || (uv.getY(a) < .5) !== (uv.getY(c) < .5)
            || Math.abs(area) < 1e-12) throw new Error('Hand surface pack has a collapsed or crossing UV island');
        }
      }
      const normal = geometry.attributes.normal, vector = new THREE.Vector3();
      // Quantized directions are normalized once when loading, never per pose.
      for (let i = 0; i < count; i++) {
        vector.fromBufferAttribute(normal, i);
        if (vector.lengthSq() < 0.9 || vector.lengthSq() > 1.1) throw new Error('Hand surface pack has invalid normals');
        vector.normalize(); normal.setXYZ(i, vector.x, vector.y, vector.z);
      }
      if (isHand) {
        if (!AUTHORED_HAND_RADII.some(radius => keyFor(radius) === mesh.key)) throw new Error('Hand surface pack has an unknown grip');
        geometry.morphTargetsRelative = true;
        for (const name of ['position', 'normal']) {
          const values = arrays[mesh.morph?.[name]];
          if (!(values instanceof Float32Array) || values.length !== count * 3) throw new Error('Hand surface pack has an invalid clench target');
          geometry.morphAttributes[name] = [new THREE.BufferAttribute(values, 3)];
        }
        const positionMorph = geometry.morphAttributes.position[0], normalMorph = geometry.morphAttributes.normal[0];
        for (let i = 0; i < count; i++) {
          if (vector.fromBufferAttribute(positionMorph, i).length() > 0.003) throw new Error('Hand surface pack has an excessive clench displacement');
          vector.fromBufferAttribute(normalMorph, i).add(new THREE.Vector3().fromBufferAttribute(normal, i));
          if (vector.lengthSq() < 0.9 || vector.lengthSq() > 1.1) throw new Error('Hand surface pack has invalid clench normals');
          vector.normalize();
          normalMorph.setXYZ(i, vector.x - normal.getX(i), vector.y - normal.getY(i), vector.z - normal.getZ(i));
        }
        const radius = AUTHORED_HAND_RADII.find(radius => keyFor(radius) === mesh.key);
        geometry.userData.authoredHand = { kind: radius === null ? 'fist' : 'grip', side: 1, radius, connected: true,
          source: 'original-blender-authored', ...(header.version === 2 ? { revision: 'hands-sculpt-v2', finish: 'blender-baked-v2' } : {}) };
      } else geometry.userData.authoredSleeve = true;
      geometry.userData.source = 'original-blender-authored';
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const { min, max } = geometry.boundingBox;
      if (isHand && (min.x < -0.065 || max.x > 0.048 || min.y < -0.08 || max.y > 0.06 || min.z < -0.125 || max.z > 0.095)) {
        throw new Error('Hand surface pack is outside its grip/framing envelope');
      }
      if (!isHand && (min.y !== -0.5 || max.y !== 0.5 || Math.max(Math.abs(min.x), Math.abs(max.x), Math.abs(min.z), Math.abs(max.z)) > (mesh.key === 'cuff' ? 1.1 : 0.05))) {
        throw new Error('Hand surface pack moved a sleeve attachment');
      }
      loaded.set(mesh.key, geometry);
    }
    for (const key of [...AUTHORED_HAND_RADII.map(keyFor), 'sleeve', 'cuff']) {
      if (!loaded.has(key)) throw new Error('Hand surface pack is missing a production shape');
    }
    loaded.version = header.version;
    return loaded;
  } catch (error) { all.forEach(geometry => geometry.dispose()); throw error; }
}

function mirror(source) {
  const geometry = source.clone();
  for (const name of ['position', 'normal']) {
    for (const attribute of [geometry.attributes[name], ...geometry.morphAttributes[name]]) {
      for (let i = 0; i < attribute.count; i++) attribute.setX(i, -attribute.getX(i));
    }
  }
  const index = geometry.index.array;
  for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
  geometry.userData = { ...source.userData, authoredHand: { ...source.userData.authoredHand, side: -1 } };
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export function getAuthoredHandSurfacesStatus() { return { ...status }; }

/** Load all production shapes before constructing or warming viewmodels. */
export async function loadAuthoredHandSurfaces({ url = AUTHORED_HAND_SURFACES_URL, fetcher = globalThis.fetch, finishLoader, timeoutMs = 8000 } = {}) {
  if (templates) return getAuthoredHandSurfacesStatus();
  if (pending) return pending;
  status = { state: 'loading', url };
  pending = (async () => {
    const started = performance.now(), controller = new globalThis.AbortController(); let timer, loaded;
    try {
      const download = (async () => {
        const response = await fetcher(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Hand surface request failed (${response.status})`);
        return response.arrayBuffer();
      })();
      const buffer = await Promise.race([download, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Hand surface loading timed out')); }, timeoutMs);
      })]);
      loaded = parsePack(buffer);
      clearTimeout(timer);
      let finish = null;
      if (loaded.version === 2) {
        finish = await loadAuthoredHandFinish({ loader: finishLoader, url: url.slice(0, url.lastIndexOf('/')),
          timeoutMs: Math.max(1, timeoutMs - (performance.now() - started)) });
        if (finish.state !== 'ready') throw new Error(`Hand geometry/finish bundle unavailable: ${finish.reason}`);
      }
      const hands = new Map();
      for (const radius of AUTHORED_HAND_RADII) {
        const geometry = loaded.get(keyFor(radius));
        hands.set(`1:${radius}`, geometry); hands.set(`-1:${radius}`, mirror(geometry));
      }
      arms = { sleeve: loaded.get('sleeve'), cuff: loaded.get('cuff') }; templates = hands;
      status = { state: 'ready', url, bytes: buffer.byteLength, variants: AUTHORED_HAND_RADII.length,
        trianglesPerHand: loaded.get('fist').index.count / 3, revision: loaded.version === 2 ? 'hands-sculpt-v2' : 'hands-v1',
        ...(finish ? { finish: finish.profile, textureBytes: finish.textureBytes, textures: finish.textures } : {}), loadMs: performance.now() - started };
    } catch (error) {
      if (!templates) for (const geometry of loaded?.values() || []) geometry.dispose();
      status = { state: 'fallback', url, reason: error.message, loadMs: performance.now() - started };
    } finally { clearTimeout(timer); pending = null; }
    return getAuthoredHandSurfacesStatus();
  })();
  return pending;
}

/** Shared immutable templates. Static firearm batching clones them upstream. */
export function getBlenderHandGeometry(side = 1, radius = null) { return templates?.get(`${side}:${radius}`) || null; }
export function getBlenderArmGeometry() { return arms; }
