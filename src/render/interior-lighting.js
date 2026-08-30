import * as THREE from 'three';
import { createInteriorVisibility } from './interior-visibility.js';

const VERSION = 1;
const PAD = 2;
const OFFSET = 0.018;
const LIGHT_RANGE = 3;
const AO_DIRECTIONS = [[0.58, 0.58, 0.57], [-0.58, 0.58, 0.57], [0.58, -0.58, 0.57], [-0.58, -0.58, 0.57]];
const vector = values => new THREE.Vector3(...values);

// These are authored low-frequency diffuse fills, not a radiosity/GI solve.
// Emitters follow visible fixtures/openings; live lights still supply moving
// characters, specular response, fire and flicker. Fire is deliberately absent:
// a gate can extinguish without leaving a permanent baked orange patch.
export const INTERIOR_LIGHT_ROOMS = Object.freeze([
  {
    id: 'apartment', min: [-14.94, 3.98, -9.94], max: [-3.02, 7.42, -0.06], ambient: 0.76,
    lights: [
      { position: [-9, 6.88, -5], color: 0xffc992, energy: 6.5, radius: 0.24, samples: 3 },
      { position: [-14.45, 6.15, -5.95], color: 0xffc58a, energy: 2.2, radius: 0.08, samples: 1 },
      { position: [-10.1, 6.2, -9.55], color: 0xb5d7eb, energy: 4.2,
        u: [0.75, 0, 0], v: [0, 0.60, 0], direction: [0, 0, 1], samples: 3 },
    ],
  },
  {
    id: 'neighbor', min: [-3.02, 3.98, -9.94], max: [8.96, 7.42, -0.06], ambient: 0.74,
    lights: [
      { position: [3, 6.93, -5], color: 0xffdaa8, energy: 6, radius: 0.25, samples: 3 },
      { position: [8.78, 5.8, -5], color: 0xa8cde5, energy: 4.7,
        u: [0, 0.72, 0], v: [0, 0, 1.2], direction: [-1, 0, 0], samples: 3 },
      { position: [7, 5.1, -7.51], color: 0x87a9f0, energy: 0.8,
        u: [0.22, 0, 0], v: [0, 0.12, 0], direction: [0, 0, -1], samples: 1 },
    ],
  },
  {
    id: 'bakery', min: [-33.95, 0.06, 28.03], max: [-16.05, 4.12, 42.95], ambient: 0.72,
    lights: [
      ...[[-28.3, 3.59, 30.2], [-20.1, 3.59, 31.1], [-28.3, 3.59, 37.3], [-20, 3.59, 38.7]].map(position => ({
        position, color: 0xffdfb5, energy: 4.8, u: [0.48, 0, 0], v: [0, 0, 0.08], direction: [0, -1, 0], samples: 3,
      })),
      { position: [-31.95, 1.24, 39.8], color: 0xffa562, energy: 1.1,
        u: [0, 0.55, 0], v: [0, 0, 0.5], direction: [1, 0, 0], samples: 1 },
      { position: [-18.75, 2.1, 28.32], color: 0xb0cddb, energy: 3.6,
        u: [1.1, 0, 0], v: [0, 0.8, 0], direction: [0, 0, 1], samples: 3 },
    ],
  },
]);

function prepareRoom(room) {
  const bounds = new THREE.Box3(vector(room.min), vector(room.max));
  const sources = [];
  for (const light of room.lights) {
    const position = vector(light.position), color = new THREE.Color(light.color);
    const u = vector(light.u ?? [light.radius ?? 0, 0, 0]);
    const v = vector(light.v ?? [0, 0, light.radius ?? 0]);
    const offsets = light.samples === 1 ? [[0, 0]] : [[-0.62, -0.30], [0.62, -0.30], [0, 0.60]];
    for (const [x, y] of offsets) sources.push({
      position: position.clone().addScaledVector(u, x).addScaledVector(v, y),
      color, energy: light.energy / offsets.length, direction: light.direction ? vector(light.direction).normalize() : null,
    });
  }
  return { ...room, bounds, sources };
}

function opaque(mesh) {
  const material = mesh?.material;
  return mesh?.isMesh && !mesh.isSkinnedMesh && mesh.visible && !Array.isArray(material)
    && material?.isMeshStandardMaterial && material.visible && !material.transparent
    && material.opacity === 1 && !material.alphaTest && !material.alphaMap && !material.alphaHash
    && !(material.transmission > 0) && !material.displacementMap && !material.wireframe
    && material.depthWrite && material.colorWrite && !mesh.userData.dynamic && !mesh.userData.gate;
}

// A bake only owns explicit static zone children. In particular it does not
// descend into articulated people, pickups, doors that can move or fire groups.
function receiverMeshes(zoneMeshes, rooms) {
  const seen = new Set(), result = [];
  for (const room of rooms) for (const mesh of zoneMeshes[room.id] ?? []) {
    if (seen.has(mesh) || !opaque(mesh) || mesh.isInstancedMesh || !mesh.geometry?.attributes.normal
      || mesh.material.lightMap || mesh.userData.interiorLighting) continue;
    seen.add(mesh); result.push(mesh);
  }
  return result;
}

function triangleIndices(geometry) {
  const index = geometry.index, count = index?.count ?? geometry.attributes.position.count;
  const start = Math.max(0, geometry.drawRange.start), end = Math.min(count, start + geometry.drawRange.count);
  const triangles = [];
  for (let i = start; i + 2 < end; i += 3) triangles.push(index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2]);
  return triangles;
}

// Connected coplanar triangles become charts. This also handles anonymous
// merged decoration and the rectangular pieces emitted by surface ownership.
// It does not infer visibility from architecture IDs or collision boxes.
function chartsForMesh(mesh, rooms, minimumArea) {
  const geometry = mesh.geometry, positions = geometry.attributes.position, normals = geometry.attributes.normal;
  mesh.updateWorldMatrix(true, false);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const points = Array.from({ length: positions.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld));
  const worldNormals = Array.from({ length: normals.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(normals, i).applyNormalMatrix(normalMatrix));
  const components = [], membership = new Int32Array(points.length).fill(-1), unsafe = new Set();
  const n = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const indices of triangleIndices(geometry)) {
    const [ia, ib, ic] = indices;
    n.crossVectors(a.subVectors(points[ib], points[ia]), b.subVectors(points[ic], points[ia]));
    const area = n.length() * 0.5;
    if (area < 1e-9) continue;
    n.normalize();
    // Smooth skin, rounded cushions and curved pipes need their normal maps
    // and probe lighting; projecting a planar bake onto them creates seams.
    if (indices.some(i => worldNormals[i].dot(n) < 0.9999)) { for (const i of indices) unsafe.add(i); continue; }
    const attached = [...new Set(indices.map(i => membership[i]).filter(i => i >= 0))];
    let chart = attached.length ? components[attached[0]] : null;
    if (chart && (chart.normal.dot(n) < 0.9999 || Math.abs(n.dot(points[ia]) - chart.plane) > 1e-5)) {
      for (const i of indices) unsafe.add(i); continue;
    }
    if (!chart) {
      chart = { mesh, indices: new Set(), normal: n.clone(), plane: n.dot(points[ia]), area: 0 };
      components.push(chart);
    }
    const target = components.indexOf(chart);
    for (const other of attached.slice(1)) {
      const old = components[other];
      if (!old || old === chart || old.normal.dot(n) < 0.9999) continue;
      for (const index of old.indices) { chart.indices.add(index); membership[index] = target; }
      chart.area += old.area; components[other] = null;
    }
    for (const i of indices) { chart.indices.add(i); membership[i] = target; }
    chart.area += area;
  }
  const charts = [];
  for (const chart of components) {
    if (!chart || chart.area < minimumArea || [...chart.indices].some(index => unsafe.has(index))) continue;
    const center = new THREE.Vector3();
    for (const index of chart.indices) center.add(points[index]);
    center.divideScalar(chart.indices.size).addScaledVector(chart.normal, OFFSET);
    const room = rooms.find(candidate => candidate.bounds.containsPoint(center));
    if (!room) continue;
    // A stable tangent frame supports rotated planar furniture as well as
    // world-axis walls, while retaining the original material UVs verbatim.
    const u = Math.abs(chart.normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    u.addScaledVector(chart.normal, -u.dot(chart.normal)).normalize();
    const v = new THREE.Vector3().crossVectors(chart.normal, u).normalize();
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const index of chart.indices) {
      const pu = points[index].dot(u), pv = points[index].dot(v);
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu); minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
    }
    if (maxU - minU < 1e-6 || maxV - minV < 1e-6) continue;
    charts.push({ ...chart, points, room, u, v, minU, maxU, minV, maxV });
  }
  return charts;
}

function packCharts(charts, size, density, rayBudget) {
  for (let attempt = 0; attempt < 20; attempt++, density *= 0.85) {
    let x = PAD * 2 + 1, y = 0, rowHeight = PAD * 2 + 1, rays = 0;
    for (const chart of charts) {
      chart.width = Math.max(2, Math.min(128, Math.ceil((chart.maxU - chart.minU) * density) + 1));
      chart.height = Math.max(2, Math.min(128, Math.ceil((chart.maxV - chart.minV) * density) + 1));
      rays += chart.width * chart.height * (AO_DIRECTIONS.length + chart.room.sources.length);
    }
    charts.sort((a, b) => b.height - a.height || b.width - a.width);
    if (rays > rayBudget) continue;
    let fits = true;
    for (const chart of charts) {
      const width = chart.width + PAD * 2, height = chart.height + PAD * 2;
      if (width > size || height > size) { fits = false; break; }
      if (x + width > size) { x = 0; y += rowHeight; rowHeight = 0; }
      chart.x = x + PAD; chart.y = y + PAD;
      x += width; rowHeight = Math.max(rowHeight, height);
    }
    if (fits && y + rowHeight <= size) return { density, estimatedRays: rays, usedHeight: y + rowHeight };
  }
  throw new RangeError('Interior lighting cannot fit the requested atlas/ray budget.');
}

function visibilityWorld(world, receivers, rooms) {
  const seen = new Set(receivers);
  // Add the environment's radiator/frames as occluders but not receivers:
  // its distant city batch must not acquire a lightmap texture sample.
  world.getObjectByName('cinematic-environment')?.traverse(mesh => { if (opaque(mesh)) seen.add(mesh); });
  // Contact rays can leave a room by 0.9m at a doorway/corner. Keep that halo
  // while pruning distant city triangles, or ceiling thickness and exterior
  // window recesses would incorrectly disappear from the visibility bake.
  return createInteriorVisibility(seen, rooms.map(room => room.bounds.clone().expandByScalar(1)));
}

function shadedMaterial(source, atlas) {
  const material = source.clone(), originalCompile = source.onBeforeCompile;
  const originalCacheKey = source.customProgramCacheKey.bind(source);
  material.lightMap = atlas; material.lightMapIntensity = LIGHT_RANGE;
  material.userData.interiorLighting = VERSION;
  material.onBeforeCompile = function(shader, renderer) {
    originalCompile.call(this, shader, renderer);
    const include = '#include <lights_fragment_maps>';
    // A pre-existing custom shader can remove this chunk. Its original
    // shading remains usable; never break the game during shader compilation.
    if (!shader.fragmentShader.includes(include)) { material.userData.interiorLightingFallback = true; return; }
    const chunk = THREE.ShaderChunk.lights_fragment_maps
      .replace('irradiance += lightMapIrradiance;', 'irradiance *= lightMapTexel.a;\n\t\tirradiance += lightMapIrradiance;')
      .replace('iblIrradiance += getIBLIrradiance( geometryNormal );', 'iblIrradiance += getIBLIrradiance( geometryNormal ) * lightMapTexel.a;');
    shader.fragmentShader = shader.fragmentShader.replace(include, chunk);
  };
  material.customProgramCacheKey = () => `${originalCacheKey()}:interior-lighting-${VERSION}`;
  return material;
}

/**
 * Bake one bounded, shared linear RGBA lightmap behind the loading menu.
 * RGB stores authored fixture irradiance; alpha attenuates only broad ambient
 * and diffuse sky, leaving live direct lighting and specular response intact.
 * Exact static triangles (not movement colliders) gate every visibility ray.
 *
 * Call AFTER surface ownership and BEFORE Ballistics.rebuild/prewarm. No GPU
 * capture, frame-loop bake, extra light, draw, or triangle is introduced.
 */
export async function createInteriorLighting(world, {
  zoneMeshes, rooms: authoredRooms = INTERIOR_LIGHT_ROOMS, atlasSize = 512,
  texelsPerMeter = 4, rayBudget = 300000, minimumArea = 0.35,
  now = () => performance.now(), yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
} = {}) {
  if (!world?.isObject3D || !zoneMeshes) throw new TypeError('Interior lighting requires the world and captured static zones.');
  if (!Number.isInteger(atlasSize) || atlasSize < 32 || atlasSize > 512 || (atlasSize & atlasSize - 1)
    || !(texelsPerMeter > 0) || !Number.isFinite(texelsPerMeter)
    || !Number.isSafeInteger(rayBudget) || rayBudget < 1 || rayBudget > 300000
    || !(minimumArea > 0) || !Number.isFinite(minimumArea)) throw new RangeError('Invalid interior lighting budget.');
  const started = now(), rooms = authoredRooms.map(prepareRoom);
  const receivers = receiverMeshes(zoneMeshes, rooms);
  let charts = [], yieldCount = 0, cpuMs = 0, sliceStart = started;
  for (const mesh of receivers) {
    charts.push(...chartsForMesh(mesh, rooms, minimumArea));
    if (now() - sliceStart > 12) {
      cpuMs += now() - sliceStart; yieldCount++;
      await yieldTask(); sliceStart = now();
    }
  }
  const packing = packCharts(charts, atlasSize, texelsPerMeter, rayBudget);
  const data = new Uint8Array(atlasSize * atlasSize * 4);
  // Unmapped faces use this neutral sentinel: no added light, no attenuation.
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const visibility = visibilityWorld(world, receivers, rooms);
  const visibilityStats = visibility.snapshot();
  const point = new THREE.Vector3(), origin = new THREE.Vector3(), direction = new THREE.Vector3(), rgb = new THREE.Color();
  let rays = 0, texels = 0;
  try {
    for (const chart of charts) {
      for (let y = 0; y < chart.height; y++) {
        for (let x = 0; x < chart.width; x++) {
          point.copy(chart.normal).multiplyScalar(chart.plane)
            .addScaledVector(chart.u, THREE.MathUtils.lerp(chart.minU, chart.maxU, x / (chart.width - 1)))
            .addScaledVector(chart.v, THREE.MathUtils.lerp(chart.minV, chart.maxV, y / (chart.height - 1)));
          origin.copy(point).addScaledVector(chart.normal, OFFSET);
          // Structural floors extend under their boundary walls. Their chart
          // endpoints must not become a bright neutral strip when filtered;
          // shade those endpoints at the nearest interior boundary instead.
          // Exterior faces were excluded when selecting the whole chart.
          origin.clamp(chart.room.bounds.min, chart.room.bounds.max);
          rgb.setRGB(0, 0, 0);
          let blocked = 0;
          {
            for (const [u, v, n] of AO_DIRECTIONS) {
              direction.copy(chart.u).multiplyScalar(u).addScaledVector(chart.v, v).addScaledVector(chart.normal, n).normalize();
              rays++;
              const distance = visibility.distance(origin, direction, 0.9);
              if (distance !== Infinity) blocked += 1 - Math.min(1, distance / 0.9);
            }
            for (const light of chart.room.sources) {
              direction.subVectors(light.position, origin);
              const distanceSq = direction.lengthSq(), distance = Math.sqrt(distanceSq);
              direction.multiplyScalar(1 / Math.max(distance, 0.001));
              const facing = Math.max(0, chart.normal.dot(direction));
              const emitting = light.direction ? Math.max(0, -light.direction.dot(direction)) : 1;
              const energy = light.energy * facing * emitting / (1 + distanceSq);
              if (energy < 0.001 || distance <= OFFSET) continue;
              rays++;
              if (visibility.occluded(origin, direction, distance - OFFSET)) continue;
              rgb.r += light.color.r * energy; rgb.g += light.color.g * energy; rgb.b += light.color.b * energy;
            }
          }
          const offset = ((chart.y + y) * atlasSize + chart.x + x) * 4;
          data[offset] = Math.min(255, rgb.r / LIGHT_RANGE * 255);
          data[offset + 1] = Math.min(255, rgb.g / LIGHT_RANGE * 255);
          data[offset + 2] = Math.min(255, rgb.b / LIGHT_RANGE * 255);
          data[offset + 3] = chart.room.ambient * (1 - blocked * 0.11) * 255;
          texels++;
        }
        if (now() - sliceStart > 12) {
          cpuMs += now() - sliceStart; yieldCount++;
          await yieldTask(); sliceStart = now();
        }
      }
      // Clamp padding at the edge. No mipmaps: distant chart islands must
      // never bleed into each other or the neutral sentinel.
      for (let y = -PAD; y < chart.height + PAD; y++) for (let x = -PAD; x < chart.width + PAD; x++) {
        if (x >= 0 && x < chart.width && y >= 0 && y < chart.height) continue;
        const sx = chart.x + Math.max(0, Math.min(chart.width - 1, x));
        const sy = chart.y + Math.max(0, Math.min(chart.height - 1, y));
        const source = (sy * atlasSize + sx) * 4, target = ((chart.y + y) * atlasSize + chart.x + x) * 4;
        data.copyWithin(target, source, source + 4);
      }
    }
  } finally { visibility.clear(); }
  cpuMs += now() - sliceStart;
  const atlas = new THREE.DataTexture(data, atlasSize, atlasSize, THREE.RGBAFormat);
  atlas.name = 'static-interior-irradiance-and-occlusion'; atlas.channel = 1;
  atlas.colorSpace = THREE.NoColorSpace; atlas.minFilter = atlas.magFilter = THREE.LinearFilter;
  atlas.generateMipmaps = false; atlas.needsUpdate = true;
  const materialCache = new Map(), changes = [];
  let geometryBytes = 0, retainedGeometryBytes = 0;
  try {
    for (const mesh of new Set(charts.map(chart => chart.mesh))) {
      const geometry = mesh.geometry.clone(), uv = new Float32Array(geometry.attributes.position.count * 2);
      uv.fill(0.5 / atlasSize);
      for (const chart of charts) if (chart.mesh === mesh) for (const index of chart.indices) {
        const p = chart.points[index];
        uv[index * 2] = (chart.x + 0.5 + (p.dot(chart.u) - chart.minU) / (chart.maxU - chart.minU) * (chart.width - 1)) / atlasSize;
        uv[index * 2 + 1] = (chart.y + 0.5 + (p.dot(chart.v) - chart.minV) / (chart.maxV - chart.minV) * (chart.height - 1)) / atlasSize;
      }
      geometry.setAttribute('uv1', new THREE.BufferAttribute(uv, 2));
      geometryBytes += uv.byteLength;
      retainedGeometryBytes += Object.values(mesh.geometry.attributes).reduce((total, attribute) => total + attribute.array.byteLength, 0)
        + (mesh.geometry.index?.array.byteLength ?? 0);
      if (!materialCache.has(mesh.material)) materialCache.set(mesh.material, shadedMaterial(mesh.material, atlas));
      changes.push({ mesh, geometry: mesh.geometry, material: mesh.material, ownedGeometry: geometry });
      mesh.geometry = geometry; mesh.material = materialCache.get(mesh.material);
      mesh.userData.interiorLighting = VERSION;
    }
  } catch (error) {
    for (const change of changes) {
      change.mesh.geometry = change.geometry; change.mesh.material = change.material;
      delete change.mesh.userData.interiorLighting; change.ownedGeometry.dispose();
    }
    for (const material of materialCache.values()) material.dispose();
    atlas.dispose(); throw error;
  }
  const stats = {
    status: 'ready', atlasSize, atlasBytes: data.byteLength, geometryBytes, retainedGeometryBytes,
    receivers: changes.length, materials: materialCache.size, charts: charts.length, texels, rays,
    rayBudget, texelsPerMeter: packing.density, estimatedRays: packing.estimatedRays,
    visibilityTriangles: visibilityStats.triangles, cpuMs, elapsedMs: now() - started, yieldCount,
    addedDrawCalls: 0, addedTriangles: 0, addedLights: 0, extraTextureSamples: 1,
  };
  charts = null;
  const byMesh = new Map(changes.map(change => [change.mesh, change]));
  let disposed = false, enabled = true, reflectionLayer = null;
  function refreshMaterials() {
    for (const change of changes) {
      const reflection = reflectionLayer?.enabled && reflectionLayer.entries.get(change.mesh);
      change.mesh.material = reflection
        ? (enabled ? reflection.baked ?? reflection.plain : reflection.plain)
        : (enabled ? materialCache.get(change.material) : change.material);
    }
    if (reflectionLayer) for (const [mesh, reflection] of reflectionLayer.entries) {
      if (!byMesh.has(mesh)) mesh.material = reflectionLayer.enabled ? reflection.plain : reflection.original;
    }
  }
  return {
    snapshot: () => ({ ...stats, enabled, status: disposed ? 'disposed' : stats.status }),
    setEnabled(value) {
      if (disposed) return;
      enabled = Boolean(value);
      refreshMaterials();
    },
    // A second, independently switchable material layer can add local probes
    // without changing the bake's original material references. The reflection
    // helper owns these variants/textures; this controller owns only assignment.
    materialVariants(mesh) {
      if (disposed) return null;
      const change = byMesh.get(mesh);
      return { plain: change?.material ?? mesh.material, baked: change ? materialCache.get(change.material) : null };
    },
    attachReflectionMaterials(entries) {
      if (disposed) throw new Error('Interior lighting has been disposed.');
      if (reflectionLayer) throw new Error('An interior reflection layer is already attached.');
      const pairs = new Map();
      for (const [mesh, variants] of entries) {
        if (!mesh?.isMesh || !variants.plain?.isMaterial || (variants.baked && !variants.baked.isMaterial)) {
          throw new TypeError('Reflection variants require a mesh and standard material variants.');
        }
        pairs.set(mesh, { ...variants, original: byMesh.get(mesh)?.material ?? mesh.material });
      }
      const layer = { entries: pairs, enabled: true };
      reflectionLayer = layer; refreshMaterials();
      return {
        setEnabled(value) {
          if (disposed || reflectionLayer !== layer) return;
          layer.enabled = Boolean(value); refreshMaterials();
        },
        dispose() {
          if (reflectionLayer !== layer) return;
          layer.enabled = false; refreshMaterials(); reflectionLayer = null; pairs.clear();
        },
      };
    },
    dispose() {
      if (disposed) return;
      if (reflectionLayer) {
        reflectionLayer.enabled = false; refreshMaterials(); reflectionLayer.entries.clear(); reflectionLayer = null;
      }
      disposed = true;
      for (const change of changes) {
        if (change.mesh.geometry === change.ownedGeometry) change.mesh.geometry = change.geometry;
        if (change.mesh.material === materialCache.get(change.material)) change.mesh.material = change.material;
        delete change.mesh.userData.interiorLighting; change.ownedGeometry.dispose();
      }
      for (const material of materialCache.values()) material.dispose();
      materialCache.clear(); changes.length = 0; byMesh.clear(); atlas.dispose();
    },
  };
}
