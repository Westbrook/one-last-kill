import * as THREE from 'three';
import { applyBoxWorldUV } from './world-uv.js';

export const AUTHORED_WORLD_DRESSING_URL = '/assets/models/world-dressing/catalog.json';
let templates = null, pending = null;
let status = { state: 'unloaded', url: AUTHORED_WORLD_DRESSING_URL };

const BOX_FAMILIES = new Set(['hvac-body', 'hvac-vent-blade', 'concrete-barrier', 'workbench-case',
  'workbench-handle', 'pallet-supply-case', 'roof-pallet-board', 'roof-tool-case']);

function envelope(entry) {
  const [width, height, depth] = entry.dimensions;
  if (BOX_FAMILIES.has(entry.family) && entry.dimensions.length === 3) return [width / 2, height / 2, depth / 2];
  if (['water-tank-barrel', 'water-tank-cap'].includes(entry.family) && entry.dimensions.length === 3) return [width, height / 2, width];
  if (entry.family === 'hvac-fan-guard' && entry.dimensions.length === 2) return [width + height, width + height, height];
  throw new Error(`Unknown world dressing family: ${entry.family}`);
}

function prepare(catalog) {
  if (catalog?.version !== 1 || catalog.source !== 'original-blender-authored'
    || catalog.materials !== 0 || catalog.textures !== 0 || !Array.isArray(catalog.entries)
    || !catalog.entries.length || catalog.entries.length > 48) throw new Error('Invalid world dressing catalog');
  const prepared = [];
  try {
    for (const entry of catalog.entries) {
      if (typeof entry.id !== 'string' || typeof entry.family !== 'string'
        || !Array.isArray(entry.dimensions) || !entry.dimensions.length
        || !entry.dimensions.every(value => Number.isFinite(value) && value > 0)
        || !Array.isArray(entry.positions) || !entry.positions.length || entry.positions.length % 3
        || entry.positions.length > 18000 || !entry.positions.every(Number.isFinite)
        || !Array.isArray(entry.normals) || entry.normals.length !== entry.positions.length
        || !entry.normals.every(Number.isFinite) || !Array.isArray(entry.uv)
        || entry.uv.length !== entry.positions.length / 3 * 2 || !entry.uv.every(Number.isFinite)
        || !Array.isArray(entry.index) || !entry.index.length || entry.index.length % 3
        || entry.index.length / 3 > 768 || entry.triangles !== entry.index.length / 3
        || !Number.isInteger(entry.sourceTriangles) || entry.sourceTriangles < 1
        || !Number.isInteger(entry.instances) || entry.instances < 1 || entry.instances > 64
        || !entry.index.every(value => Number.isInteger(value) && value >= 0 && value < entry.positions.length / 3)
        || prepared.some(other => other.entry.id === entry.id)) throw new Error(`Invalid world dressing template: ${entry.id}`);
      const geometry = new THREE.BufferGeometry();
      // Register ownership before validation so failures dispose all allocated sources.
      prepared.push({ entry, geometry });
      geometry.type = 'AuthoredWorldDressingGeometry';
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(entry.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(entry.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(entry.uv, 2));
      geometry.setIndex(entry.index);
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const halfSize = envelope(entry);
      for (const side of ['min', 'max']) {
        if (!Array.isArray(entry.bounds?.[side]) || entry.bounds[side].length !== 3
          || !entry.bounds[side].every(Number.isFinite)
          || geometry.boundingBox[side].distanceTo(new THREE.Vector3(...entry.bounds[side])) > 1e-5) {
          throw new Error(`Invalid world dressing envelope: ${entry.id}`);
        }
        const sign = side === 'min' ? -1 : 1;
        if (geometry.boundingBox[side].distanceTo(new THREE.Vector3(...halfSize.map(value => value * sign))) > 1e-5) {
          throw new Error(`World dressing changed its placement envelope: ${entry.id}`);
        }
      }
      geometry.userData.authoredWorldDressing = { ...entry.metadata, id: entry.id,
        source: 'original-blender-authored', family: entry.family,
        triangles: entry.triangles, sourceTriangles: entry.sourceTriangles };
      if (entry.metadata?.waterTankStaves) geometry.userData.waterTankStaves = { ...entry.metadata.waterTankStaves };
    }
    const triangleDelta = prepared.reduce((sum, { entry }) => sum + (entry.triangles - entry.sourceTriangles) * entry.instances, 0);
    if (!Number.isFinite(triangleDelta) || triangleDelta > 1200) throw new Error('World dressing exceeds placed geometry budget');
    return { prepared, triangleDelta };
  } catch (error) {
    for (const { geometry } of prepared) geometry.dispose();
    throw error;
  }
}

/** Preload once before world construction. Offline/failing loads keep the original meshes. */
export function loadAuthoredWorldDressing({ loader, url = AUTHORED_WORLD_DRESSING_URL, timeoutMs = 8000 } = {}) {
  if (templates) return Promise.resolve(getAuthoredWorldDressingStatus());
  if (pending) return pending;
  const started = performance.now();
  status = { state: 'loading', url };
  pending = (async () => {
    let timer, controller;
    try {
      controller = new globalThis.AbortController();
      const load = loader ? Promise.resolve().then(() => loader(url)) : fetch(url, { signal: controller.signal }).then(response => {
        if (!response.ok) throw new Error(`World dressing fetch failed: ${response.status}`);
        return response.json();
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('World dressing load timed out')); }, timeoutMs);
      });
      const result = prepare(await Promise.race([load, timeout]));
      templates = result.prepared;
      status = { state: 'ready', url, templates: templates.length, triangleDelta: result.triangleDelta,
        addedDraws: 0, addedMaterials: 0, addedTextures: 0, loadMs: performance.now() - started };
    } catch (error) {
      status = { state: 'fallback', url, reason: error.message, loadMs: performance.now() - started };
    } finally {
      clearTimeout(timer);
      pending = null;
    }
    return getAuthoredWorldDressingStatus();
  })();
  return pending;
}

export function getAuthoredWorldDressingStatus() { return { ...status }; }

/** Owned geometry clone; unsupported dimensions preserve the procedural fallback. */
export function createAuthoredWorldDressingGeometry(family, { dimensions, meters, offset } = {}) {
  if (!templates || !Array.isArray(dimensions) || !dimensions.every(Number.isFinite)) return null;
  const match = templates.find(({ entry }) => entry.family === family && entry.dimensions.length === dimensions.length
    && entry.dimensions.every((value, index) => Math.abs(value - dimensions[index]) < 1e-7));
  if (!match) return null;
  const geometry = match.geometry.clone();
  geometry.userData = { ...match.geometry.userData,
    authoredWorldDressing: { ...match.geometry.userData.authoredWorldDressing } };
  if (geometry.userData.waterTankStaves) geometry.userData.waterTankStaves = { ...geometry.userData.waterTankStaves };
  else applyBoxWorldUV(geometry, meters, offset);
  return geometry;
}

/** Refine a known owned box without changing its collider, registry, material or flags. */
export function refineAuthoredDressingMesh(mesh, family) {
  if (mesh?.geometry?.type !== 'BoxGeometry') return mesh;
  const { width, height, depth } = mesh.geometry.parameters;
  const geometry = createAuthoredWorldDressingGeometry(family, { dimensions: [width, height, depth],
    meters: mesh.material?.userData?.surfaceMeters, offset: mesh.position });
  if (!geometry) return mesh;
  const original = mesh.geometry;
  mesh.geometry = geometry;
  original.dispose();
  return mesh;
}
