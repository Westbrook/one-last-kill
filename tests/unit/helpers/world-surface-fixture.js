import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Architecture, boxBounds, signYaw } from '../../../src/world/architecture.js';
import { BUILDING, BALCONY, ROOF, OPENINGS, APARTMENT_DOORS, SCAFFOLD_LEVELS, SCAFFOLD_TRIGGER_MIN_Z } from '../../../src/world/layout.js';
import { STAIRS } from '../../../src/world/stair-layout.js';
import { DISTRICT } from '../../../src/world/district-layout.js';
import { createInteriorProps } from '../../../src/world/interior-props.js';
import { createDoorAssemblies } from '../../../src/world/door-assemblies.js';
import { applyBoxWorldUV } from '../../../src/render/world-uv.js';
import { SURFACE_METERS } from '../../../src/render/surface-detail.js';
import { Colliders } from '../../../src/core/collision.js';
import { createBallisticWorld } from '../../../src/core/ballistics.js';
import { mulberry32 } from '../../../src/core/math.js';
import { addBakeryBread, addBakeryPackage } from '../../../src/render/bakery-provisions.js';
import { getBakeryProvisionMaterials } from '../../../src/render/bakery-provision-materials.js';
import { addCrtHousing } from '../../../src/render/crt-housing.js';
import { applyWaterTankStaveUV } from '../../../src/render/water-tank-uv.js';
import { refineConcreteBarrier } from '../../../src/render/street-barrier.js';
import { createSedanCabin } from '../../../src/render/sedan-cabin.js';
import { createSedanBumper, createSedanHood } from '../../../src/render/sedan-panels.js';

function loadFunctions(path, bindings, names) {
  // Preserve source line numbers in captured VM stacks while removing imports.
  const source = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, match => match.replace(/[^\n]/g, ''))
    .replace(/^export \{[^}]+\};\s*$/gm, match => match.replace(/[^\n]/g, ''))
    .replace(/^export (?=function )/gm, '');
  assert.doesNotMatch(source, /^import\s/m, `Update the explicit fixture for multiline imports: ${path}`);
  return runInNewContext(`${source}\n;({ ${names.join(', ')} });`, { ...bindings }, { filename: path });
}

/**
 * Real authored geometry for all eight zones, without a renderer, browser or
 * audio. Decoration is retained as separate meshes so overlapping contributors
 * can be attributed before material batching. Character rigs, transient effect
 * geometry and distant environmental instances are outside this fixture.
 */
export function buildWorldSurfaceFixture({ ballistics = createBallisticWorld() } = {}) {
  Architecture.clear(); Colliders.clear();
  const World = new THREE.Group(), materials = new Map(), additions = new Map();
  const boxes = [], decorations = [], triggers = [];
  let zone = 'setup';
  const sourceTrace = () => new Error().stack.split('\n').filter(line => line.includes('src/')).map(line => line.trim());
  const worldAdd = World.add.bind(World);
  World.add = (...objects) => {
    for (const object of objects) additions.set(object, { zone, source: sourceTrace() });
    return worldAdd(...objects);
  };
  const MATS = new Proxy({}, { get(_, key) {
    if (!materials.has(key)) {
      const material = new THREE.MeshStandardMaterial();
      material.name = String(key); material.userData.surfaceKind = key;
      if (key === 'glass') { material.transparent = true; material.opacity = 0.45; }
      material.userData.surfaceMeters = SURFACE_METERS[key] ?? 1;
      materials.set(key, material);
    }
    return materials.get(key);
  } });
  const fakeCanvas = () => ({ getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {} }) });
  const caches = loadFunctions('src/render/models.js', {
    THREE, mulberry32, applyBoxWorldUV, HUMANOID_GEOMETRY: {},
    createHumanoidRig: () => new THREE.Group(), makeCanvas: fakeCanvas, canvasToTexture: () => new THREE.Texture(),
  }, ['_CG', '_BG']);
  function remember(mesh, collection, options) {
    const record = { mesh, zone, source: sourceTrace(), options,
      rawBoxGeometry: mesh.geometry.type === 'BoxGeometry' ? mesh.geometry.clone() : null };
    collection.push(record);
    return mesh;
  }
  function addBox(x, y, z, width, height, depth, material, options = {}) {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    applyBoxWorldUV(geometry, material.userData?.surfaceMeters, { x, y, z });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); World.add(mesh);
    mesh.castShadow = options.cast !== false; mesh.receiveShadow = options.recv !== false;
    const collider = options.collide === false ? null : Colliders.addBoxBySize(x, y, z, width, height, depth);
    mesh.userData.collider = collider;
    if (options.architecture) Architecture.register(mesh, collider, boxBounds(x, y, z, width, height, depth), options.architecture);
    return remember(mesh, boxes, options);
  }
  function addDecor(x, y, z, width, height, depth, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.set(x, y, z); World.add(mesh);
    return remember(mesh, decorations, { collide: false });
  }
  function pushDecor(geometry, material, x, y, z, width, height, depth, yaw = 0) {
    const mesh = new THREE.Mesh(geometry.clone(), material);
    mesh.position.set(x, y, z); mesh.scale.set(width, height, depth); mesh.rotation.y = yaw;
    World.add(mesh); remember(mesh, decorations, { collide: false, batched: true });
  }
  function wall(axis, x, floor, z, length, height, thickness, material, opening) {
    const make = (tangent, y, width, h) => axis === 'x'
      ? addBox(tangent, y, z, width, h, thickness, material)
      : addBox(x, y, tangent, thickness, h, width, material);
    const middle = axis === 'x' ? x : z, low = middle - length / 2, high = middle + length / 2;
    if (!opening) return make(middle, floor + height / 2, length, height);
    const start = axis === 'x' ? opening.xStart : opening.zStart;
    const end = axis === 'x' ? opening.xEnd : opening.zEnd;
    const { headerH = 0.3, sillH = 0 } = opening;
    if (start > low) make((low + start) / 2, floor + height / 2, start - low, height);
    if (end < high) make((end + high) / 2, floor + height / 2, high - end, height);
    if (headerH > 0) make((start + end) / 2, floor + height - headerH / 2, end - start, headerH);
    if (sillH > 0) make((start + end) / 2, floor + sillH / 2, end - start, sillH);
  }
  const WorldState = { fires: [], smokeSystems: [], flickerLights: [], bakeryLights: [] };
  const bindings = {
    refineConcreteBarrier,
    THREE, RoundedBoxGeometry, mergeGeometries, World, WorldState, MATS, ...caches,
    Architecture, boxBounds, Colliders, Ballistics: ballistics, BUILDING, BALCONY, ROOF, OPENINGS, APARTMENT_DOORS, STAIRS, DISTRICT,
    SCAFFOLD_LEVELS, SCAFFOLD_TRIGGER_MIN_Z, createInteriorProps, createDoorAssemblies,
    addBox, addDecor, pushDecor, addBakeryBread, addBakeryPackage, getBakeryProvisionMaterials, addCrtHousing, applyWaterTankStaveUV, createSedanCabin, createSedanBumper, createSedanHood,
    addWallX: (...args) => wall('x', ...args), addWallZ: (...args) => wall('z', ...args),
    makeCanvas: fakeCanvas, makeSignTexture: () => new THREE.Texture(),
    addSign(x, y, z, width, height, normal, text) {
      const material = new THREE.MeshStandardMaterial(); material.name = `sign:${text}`;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
      mesh.position.set(x, y, z); mesh.rotation.y = signYaw(normal); World.add(mesh); return mesh;
    },
    makeHumanoid: () => new THREE.Group(), HUMANOID_PRESETS: { shopkeeper: {}, woman: {} },
    makeSmokeSystem: () => ({ points: new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()) }),
    addFlickerLight() {},
    setFireActive(entry, active) { entry.group.visible = active; },
    spawnFire() { const group = new THREE.Group(), light = new THREE.PointLight(); group.userData.ballistics = false; group.add(light); World.add(group); return { group, light }; },
    Triggers: { add(name, min, max, onEnter, onReset) { triggers.push({ name, bounds: new THREE.Box3(min, max), onEnter, onReset }); } },
  };
  Object.assign(bindings, loadFunctions('src/world/structures.js', bindings, ['addBeam', 'addProtectiveScreen']));
  const builders = [
    ['apartment', 'apartments', 'buildPlayerApartment'], ['neighbor', 'apartments', 'buildNeighborApartment'],
    ['balcony', 'balcony', 'buildBalcony'], ['stairwell', 'stairwell', 'buildStairwell'],
    ['roof', 'roof', 'buildRoof'], ['scaffolding', 'scaffolding', 'buildScaffolding'],
    ['street', 'street', 'buildStreet'], ['bakery', 'street', 'buildBakeryAndCar'],
  ];
  for (const [name, file, builder] of builders) {
    zone = name;
    loadFunctions(`src/world/zones/${file}.js`, bindings, [builder])[builder]();
  }
  World.updateMatrixWorld(true);
  const entries = new Map([...boxes, ...decorations].map(entry => [entry.mesh, entry]));
  World.traverse(mesh => {
    if (!mesh.isMesh || mesh.isInstancedMesh) return;
    let origin = additions.get(mesh), parent = mesh.parent;
    while (!origin && parent) { origin = additions.get(parent); parent = parent.parent; }
    const entry = entries.get(mesh) || { mesh, ...origin, rawBoxGeometry: mesh.geometry.type === 'BoxGeometry' ? mesh.geometry.clone() : null };
    entry.materialKey = Array.isArray(mesh.material) ? 'multiple' : mesh.material.name || `material:${mesh.material.id}`;
    entry.id = mesh.userData.architectureId || mesh.name || `${entry.zone}:${mesh.id}`;
    entry.bounds = new THREE.Box3().setFromObject(mesh);
    entries.set(mesh, entry);
  });
  return { World, boxes, decorations, entries: [...entries.values()], records: new Map(Architecture.elements), materials, triggers, colliders: [...Colliders.list], ballistics };
}

const AXES = ['x', 'y', 'z'];
const area2 = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;

/** Read actual referenced rectangular face triangles, never just a mesh AABB. */
export function collectAxisAlignedBoxFaces(fixture, { epsilon = 1e-5 } = {}) {
  fixture.World.updateMatrixWorld(true);
  const faces = [];
  for (const entry of fixture.entries) {
    const { mesh } = entry, geometry = mesh.geometry;
    const positions = geometry.attributes.position, normals = geometry.attributes.normal;
    if (!positions || !normals) continue;
    const count = geometry.index?.count ?? positions.count;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let start = 0; start + 5 < count; start += 6) {
      const indices = Array.from({ length: 6 }, (_, i) => geometry.index ? geometry.index.getX(start + i) : start + i);
      const directions = indices.map(index => new THREE.Vector3().fromBufferAttribute(normals, index).applyMatrix3(normalMatrix).normalize());
      const axis = AXES.find(value => Math.abs(directions[0][value]) > 1 - epsilon);
      if (!axis) continue;
      const sign = Math.sign(directions[0][axis]);
      if (!directions.every(normal => normal[axis] * sign > 1 - epsilon)) continue;
      const points = indices.map(index => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld));
      const plane = points[0][axis];
      if (!points.every(point => Math.abs(point[axis] - plane) < epsilon)) continue;
      const [u, v] = AXES.filter(value => value !== axis);
      const minU = Math.min(...points.map(point => point[u])), maxU = Math.max(...points.map(point => point[u]));
      const minV = Math.min(...points.map(point => point[v])), maxV = Math.max(...points.map(point => point[v]));
      const area = (maxU - minU) * (maxV - minV);
      if (area <= epsilon * epsilon) continue;
      // Reject curved caps, tapered faces and unrelated triangle pairs whose
      // bounding rectangle contains space that the actual triangles do not.
      if (!points.every(point => (Math.abs(point[u] - minU) < epsilon || Math.abs(point[u] - maxU) < epsilon)
        && (Math.abs(point[v] - minV) < epsilon || Math.abs(point[v] - maxV) < epsilon))) continue;
      const projected = points.map(point => [point[u], point[v]]);
      const triangleArea = area2(...projected.slice(0, 3)) + area2(...projected.slice(3));
      if (Math.abs(triangleArea - area) > Math.max(1e-9, area * epsilon)) continue;
      const group = geometry.groups.find(value => start >= value.start && start < value.start + value.count);
      const material = Array.isArray(mesh.material) ? mesh.material[group?.materialIndex || 0] : mesh.material;
      if (!material || !material.visible) continue;
      faces.push({ entry, id: entry.id, axis, sign, plane, u, v, minU, maxU, minV, maxV, area,
        material, materialKey: material.name || `material:${material.id}`, triangleOffset: start });
    }
  }
  return faces;
}

/** Positive-area, same-facing overlaps; opposite-facing support contacts are excluded. */
export function findCoplanarBoxOverlaps(fixture, { epsilon = 1e-5, minArea = 1e-5, differentMaterialsOnly = true } = {}) {
  const faces = collectAxisAlignedBoxFaces(fixture, { epsilon });
  const groups = new Map(), overlaps = [];
  for (const face of faces) {
    const key = `${face.axis}:${face.sign}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(face);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.plane - b.plane);
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      for (let j = i + 1; j < group.length && group[j].plane - a.plane <= epsilon; j++) {
        const b = group[j];
        if (a.entry.mesh === b.entry.mesh || (differentMaterialsOnly && a.material === b.material)) continue;
        const minU = Math.max(a.minU, b.minU), maxU = Math.min(a.maxU, b.maxU);
        const minV = Math.max(a.minV, b.minV), maxV = Math.min(a.maxV, b.maxV);
        const area = Math.max(0, maxU - minU) * Math.max(0, maxV - minV);
        if (area <= minArea) continue;
        overlaps.push({ a, b, axis: a.axis, sign: a.sign, plane: a.plane, area, overlap: { u: a.u, v: a.v, minU, maxU, minV, maxV } });
      }
    }
  }
  return overlaps.sort((a, b) => b.area - a.area);
}
