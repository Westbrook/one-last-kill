import * as THREE from 'three';
import { applyBoxWorldUV } from './world-uv.js';

export const AUTHORED_FURNITURE_URL = '/assets/models/furniture/catalog.json';
const limits = { 'milled-box': 44, 'soft-box': 300, 'profiled-leg': 160, knob: 48, cup: 192, 'cup-handle': 192 };
let templates = null, pending = null;
let status = { state: 'unloaded', url: AUTHORED_FURNITURE_URL };
const used = new Set();

function validate(catalog) {
  if (catalog?.version !== 1 || catalog.source !== 'original-blender-authored') throw new Error('Unsupported furniture catalog');
  const prepared = new Map();
  let triangles = 0, geometryBytes = 0;
  for (const [name, limit] of Object.entries(limits)) {
    const source = catalog.templates?.[name];
    if (!source || !Array.isArray(source.position) || !Array.isArray(source.normal) || !Array.isArray(source.index)
      || !source.index.length || source.index.length % 3 || source.index.length / 3 > limit
      || !source.position.length || source.position.length % 3 || source.position.length > limit * 9
      || source.normal.length !== source.position.length) throw new Error(`Invalid furniture template: ${name}`);
    if (!source.position.every(value => Number.isFinite(value) && Math.abs(value) <= 1.001)
      || !source.normal.every(Number.isFinite)
      || !source.index.every(value => Number.isInteger(value) && value >= 0 && value < source.position.length / 3)) {
      throw new Error(`Invalid furniture vertex data: ${name}`);
    }
    for (let i = 0; i < source.normal.length; i += 3) {
      if (Math.abs(Math.hypot(...source.normal.slice(i, i + 3)) - 1) > 0.001) throw new Error(`Invalid furniture normal: ${name}`);
    }
    const entry = { position: new Float32Array(source.position), normal: new Float32Array(source.normal), index: new Uint16Array(source.index) };
    prepared.set(name, entry);
    triangles += source.index.length / 3;
    geometryBytes += entry.position.byteLength + entry.normal.byteLength + entry.index.byteLength;
  }
  return { templates: prepared, metrics: { templates: prepared.size, triangles, geometryBytes, materials: 0, textures: 0 } };
}

export function getAuthoredFurnitureStatus() { return { ...status, usedTemplates: [...used] }; }

/** Preload once before room builders populate their immutable geometry cache. */
export async function loadAuthoredFurniture({ fetchImpl = globalThis.fetch, url = AUTHORED_FURNITURE_URL, timeoutMs = 8000 } = {}) {
  if (templates) return getAuthoredFurnitureStatus();
  if (pending) return pending;
  status = { state: 'loading', url };
  pending = (async () => {
    const start = performance.now(), controller = new globalThis.AbortController();
    let timer;
    try {
      const loading = (async () => {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Furniture HTTP ${response.status}`);
        return response.json();
      })();
      const catalog = await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Furniture loading timed out')); }, timeoutMs);
      })]);
      const prepared = validate(catalog);
      templates = prepared.templates;
      status = { state: 'ready', url, ...prepared.metrics, elapsedMs: performance.now() - start };
    } catch (error) {
      status = { state: 'fallback', url, error: String(error.message || error), elapsedMs: performance.now() - start };
    } finally { clearTimeout(timer); pending = null; }
    return getAuthoredFurnitureStatus();
  })();
  return pending;
}

export function authoredFurnitureCacheKey() { return templates ? 'blender-v1' : 'procedural'; }

function unwrapLeg(geometry, width, height, depth, meters) {
  const original = geometry.attributes, position = [], normal = [], uv = [], index = [], vertices = new Map();
  for (let face = 0; face < geometry.index.count; face += 3) {
    const ids = [0, 1, 2].map(offset => geometry.index.getX(face + offset));
    const cap = ids.every(id => Math.abs(original.position.getY(id) - original.position.getY(ids[0])) < 1e-7);
    const around = ids.map(id => (Math.atan2(original.position.getZ(id) / depth, original.position.getX(id) / width) / (2 * Math.PI) + 1) % 1);
    if (Math.max(...around) - Math.min(...around) > 0.5) {
      for (let i = 0; i < around.length; i++) if (around[i] < 0.5) around[i]++;
    }
    ids.forEach((id, corner) => {
      const x = original.position.getX(id), y = original.position.getY(id), z = original.position.getZ(id);
      const u = cap ? x / meters : (y + height / 2) / meters;
      const v = cap ? z / meters : around[corner] * 2 * (width + depth) / meters;
      const key = `${id}:${u.toFixed(7)}:${v.toFixed(7)}`;
      if (!vertices.has(key)) {
        vertices.set(key, position.length / 3);
        position.push(x, y, z);
        normal.push(original.normal.getX(id), original.normal.getY(id), original.normal.getZ(id));
        uv.push(u, v);
      }
      index.push(vertices.get(key));
    });
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
}

/** Return owned metric buffers for the existing immutable furniture cache. */
export function createAuthoredFurnitureGeometry(name, { width = 1, height = 1, depth = 1, radius = 0.012, meters = 1 } = {}) {
  const source = templates?.get(name);
  if (!source) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(source.position.slice(), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(source.normal.slice(), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(source.position.length / 3 * 2), 2));
  geometry.setIndex(new THREE.BufferAttribute(source.index.slice(), 1));
  if (name.endsWith('-box')) {
    // The Blender bevel uses half-extent 1 and radius .25. Expand only its
    // central flat spans; its actual corner arcs keep the requested radius.
    const dimensions = [width, height, depth], p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) for (let axis = 0; axis < 3; axis++) {
      const value = p.array[i * 3 + axis], sign = Math.sign(value), magnitude = Math.abs(value);
      const inner = dimensions[axis] / 2 - radius;
      p.array[i * 3 + axis] = sign * (magnitude <= 0.75 ? magnitude / 0.75 * inner : inner + (magnitude - 0.75) * radius / 0.25);
    }
  } else if (name === 'profiled-leg') geometry.scale(width, height, depth);
  if (name === 'profiled-leg') unwrapLeg(geometry, width, height, depth, meters);
  else applyBoxWorldUV(geometry, meters);
  geometry.userData.authoredFurniture = { source: 'original-blender-authored', template: name, version: 1 };
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  used.add(name);
  return geometry;
}
