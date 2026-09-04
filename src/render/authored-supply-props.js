import * as THREE from 'three';

export const AUTHORED_SUPPLY_PROPS_URL = '/assets/models/supplies-props/catalog.json';
const specifications = {
  health: { names: ['medical-case-shell', 'medical-case-trim', 'medical-case-crosses'], triangles: 800,
    min: [-0.1225, -0.040001, -0.090001], max: [0.1225, 0.052001, 0.090001] },
  armor: { names: ['armor-vest-fabric', 'armor-vest-plates', 'armor-vest-identity', 'armor-vest-bullet-marks'], triangles: 750,
    min: [-0.26, -0.31, -0.14], max: [0.26, 0.31, 0.17] },
  crt: { names: ['crt-molded-housing', 'crt-recessed-details'], triangles: 799,
    min: [-0.500001, -0.305001, -0.302501], max: [0.500001, 0.295001, 0.250001] },
  ammo: { names: ['ammo-case-body-and-lid', 'ammo-case-feet-and-seal', 'ammo-case-handle-and-latches'], triangles: 708,
    min: [-0.329001, -0.000001, -0.149001], max: [0.329001, 0.340001, 0.168001] },
};
let catalog = null, pending = null;
let status = { state: 'unloaded', url: AUTHORED_SUPPLY_PROPS_URL };

function prepare(document) {
  if (document?.version !== 1 || document.source !== 'blender-authored-original') throw new Error('Invalid Blender supply catalog');
  const result = new Map(); let triangles = 0, geometryBytes = 0;
  try {
    for (const [model, spec] of Object.entries(specifications)) {
      const parts = document.models?.[model]?.parts;
      if (!Array.isArray(parts) || parts.length !== spec.names.length) throw new Error(`Incomplete ${model} catalog`);
      let modelTriangles = 0;
      const names = new Set();
      for (const part of parts) {
        if (!spec.names.includes(part.name) || names.has(part.name)) throw new Error(`Invalid ${model} part name`);
        names.add(part.name);
        const { positions, normals, indices } = part;
        if (!Array.isArray(positions) || !positions.length || positions.length % 3
          || !positions.every(Number.isFinite) || !Array.isArray(normals)
          || normals.length !== positions.length || !normals.every(Number.isFinite)) throw new Error(`Invalid ${model} attributes`);
        if (indices !== undefined && (!Array.isArray(indices) || !indices.length || indices.length % 3
          || !indices.every(i => Number.isInteger(i) && i >= 0 && i < positions.length / 3))) throw new Error(`Invalid ${model} indices`);
        if (!indices && positions.length % 9) throw new Error(`Invalid ${model} triangles`);
        for (let i = 0; i < positions.length; i += 3) {
          for (let axis = 0; axis < 3; axis++) if (positions[i + axis] < spec.min[axis] || positions[i + axis] > spec.max[axis]) {
            throw new Error(`${model} exceeds its footprint`);
          }
          if (Math.abs(Math.hypot(...normals.slice(i, i + 3)) - 1) > 0.001) throw new Error(`Invalid ${model} normals`);
        }
        const geometry = new THREE.BufferGeometry(); result.set(`${model}/${part.name}`, geometry);
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        if (model === 'crt') geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2));
        if (indices) geometry.setIndex(indices);
        geometry.name = part.name; geometry.userData.source = 'blender-authored-original';
        geometry.computeBoundingBox(); geometry.computeBoundingSphere();
        modelTriangles += (indices?.length ?? positions.length / 3) / 3;
        geometryBytes += Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0)
          + (geometry.index?.array.byteLength ?? 0);
      }
      if (modelTriangles > spec.triangles) throw new Error(`${model} exceeds its triangle budget`);
      triangles += modelTriangles;
    }
    return { catalog: result, metrics: { models: Object.keys(specifications).length, triangles, geometryBytes, textures: 0 } };
  } catch (error) { for (const geometry of result.values()) geometry.dispose(); throw error; }
}

export function getAuthoredSupplyPropsStatus() { return { ...status }; }

/** Preload once before world construction; synchronous factories retain their original fallback. */
export async function loadAuthoredSupplyProps({ loader, url = AUTHORED_SUPPLY_PROPS_URL, timeoutMs = 8000 } = {}) {
  if (catalog) return getAuthoredSupplyPropsStatus();
  if (pending) return pending;
  status = { state: 'loading', url };
  pending = (async () => {
    const start = performance.now(); let timer;
    try {
      const read = loader ?? (async source => {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Supply catalog HTTP ${response.status}`);
        return response.json();
      });
      const document = await Promise.race([Promise.resolve().then(() => read(url)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Supply catalog loading timed out')), timeoutMs);
      })]);
      const prepared = prepare(document); catalog = prepared.catalog;
      status = { state: 'ready', url, ...prepared.metrics, elapsedMs: performance.now() - start };
    } catch (error) {
      status = { state: 'fallback', url, error: String(error.message || error), elapsedMs: performance.now() - start };
    } finally { clearTimeout(timer); pending = null; }
    return getAuthoredSupplyPropsStatus();
  })();
  return pending;
}

/** These static buffers are shared; callers animate object transforms only. */
export function getAuthoredSupplyGeometry(model, part) { return catalog?.get(`${model}/${part}`) ?? null; }
