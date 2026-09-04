#!/usr/bin/env node
/**
 * Export the original objective sedan into a deterministic Blender source.
 * Run: node tools/blender/export-objective-vehicle.mjs
 *
 * The production factory is evaluated without the world/browser imports. Its
 * real fallback parts, materials, and collision boxes are captured before its
 * existing material merge. Local game axes are +X nose, +Y up, +Z right; metres.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSedanCabin } from '../../src/render/sedan-cabin.js';
import { createSedanBumper, createSedanHood } from '../../src/render/sedan-panels.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = 'assets/blender/objective-vehicle-source.json';
const CATEGORY = ['paint', 'trim', 'glass', 'tires', 'metal', 'rearlamps', 'headlamps'];
const SOURCE_FILES = ['src/world/zones/street.js', 'src/render/models.js',
  'src/render/sedan-cabin.js', 'src/render/sedan-panels.js', 'package-lock.json'];

const describeBounds = box => ({ min: box.min.toArray(), max: box.max.toArray() });

function semanticName(mesh, shared, category, counters) {
  const cached = Object.entries(shared).find(([, geometry]) => geometry === mesh.geometry)?.[0];
  let part = cached;
  if (!part) {
    if (mesh.geometry.type === 'RoundedBoxGeometry') part = 'body';
    else if (category === 'paint') part = mesh.position.y > 0 ? 'hood' : 'roof';
    else if (category === 'trim') part = mesh.position.y > 0 ? 'rocker' : 'cabin-pillar';
    else if (category === 'glass') part = 'cabin-glass';
    else if (category === 'metal') part = mesh.position.x > 0 ? 'front-bumper' : 'rear-bumper';
    else throw new Error('Unidentified objective sedan part: ' + category);
  }
  if (part === 'unitBox') part = mesh.scale.x < 1 ? 'hood-ornament' : 'window-waistline';
  part = part.replace(/[A-Z]/g, character => '-' + character.toLowerCase());
  const count = (counters.get(part) || 0) + 1;
  counters.set(part, count);
  return `objective-sedan-${part}-${count}`;
}

function materialInfo(material) {
  return { color: material.color.toArray(), roughness: material.roughness,
    metalness: material.metalness, transparent: material.transparent, opacity: material.opacity,
    emissive: material.emissive.toArray(), emissiveIntensity: material.emissiveIntensity,
    side: material.side, vertexColors: material.vertexColors };
}

/** Return the single variant record used by the combined vehicle source. */
export async function createObjectiveVehicleSource() {
  const [street, models] = await Promise.all([
    readFile(resolve(ROOT, SOURCE_FILES[0]), 'utf8'),
    readFile(resolve(ROOT, SOURCE_FILES[1]), 'utf8'),
  ]);
  const factoryStart = street.indexOf('function spawnParkedCar(');
  const factoryEnd = street.indexOf('/** Retail,', factoryStart);
  const cacheStart = models.indexOf('const _CG = {');
  const cacheEnd = models.indexOf('\n};', cacheStart) + 3;
  if (factoryStart < 0 || factoryEnd < factoryStart || cacheStart < 0 || cacheEnd < cacheStart) {
    throw new Error('Objective car source boundaries changed; update the explicit export harness.');
  }
  const parts = [], movementBounds = [], counters = new Map();
  const shared = runInNewContext(models.slice(cacheStart, cacheEnd) + '\n;_CG;', { THREE });
  const factory = street.slice(factoryStart, factoryEnd);
  const capturePoint = 'consolidateCar(car);';
  if (factory.split(capturePoint).length !== 2) throw new Error('Expected one objective consolidation call.');
  const bindings = { THREE, RoundedBoxGeometry, mergeGeometries, createSedanCabin,
    createSedanBumper, createSedanHood, _CG: shared, getAuthoredVehicleGeometry: () => null,
    World: { add() {} }, Colliders: { addBoxBySize(x, y, z, width, height, depth) {
      movementBounds.push(describeBounds(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x, y, z), new THREE.Vector3(width, height, depth))));
    } },
    recordObjectiveParts(car, materials) {
      for (const mesh of car.children) {
        const category = CATEGORY.find(key => materials[key] === mesh.material);
        if (!category || !mesh.isMesh || Array.isArray(mesh.material)) throw new Error('Unexpected objective part.');
        mesh.updateMatrix();
        const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrix);
        const attributes = {};
        for (const key of ['position', 'normal', 'uv']) {
          const attribute = geometry.getAttribute(key);
          if (!attribute || attribute.isInterleavedBufferAttribute
              || attribute.count !== geometry.attributes.position.count
              || !attribute.array.every(Number.isFinite)) throw new Error('Invalid objective ' + key);
          attributes[key] = { itemSize: attribute.itemSize, array: Array.from(attribute.array) };
        }
        attributes.color = { itemSize: 3, array: Array(geometry.attributes.position.count * 3).fill(1) };
        geometry.computeBoundingBox();
        parts.push({ name: semanticName(mesh, shared, category, counters), category,
          sourceGeometry: mesh.geometry.type, material: materialInfo(mesh.material),
          attributes, index: geometry.index ? Array.from(geometry.index.array) : null,
          bounds: describeBounds(geometry.boundingBox) });
        geometry.dispose();
      }
    },
  };
  const spawn = runInNewContext(factory.replace(capturePoint,
    'recordObjectiveParts(car, materials); consolidateCar(car);') + '\n;spawnParkedCar;', bindings);
  const car = spawn(0, 0, 0, 0, 0x111716, { idling: true, length: 4.6, width: 1.9 });
  let triangles = 0, geometryBytes = 0;
  for (const mesh of car.children) {
    triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
    geometryBytes += Object.values(mesh.geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0)
      + (mesh.geometry.index?.array.byteLength ?? 0);
  }
  const box = new THREE.Box3().setFromObject(car, true);
  const result = { variant: 'objective-sedan',
    profile: { variant: 'objective-sedan', length: 4.6, width: 1.9, wheelRadius: 0.35, wheelWidth: 0.30,
      wheels: [1, -1].flatMap(sx => [1, -1].map(sz => ({ center: [sx * 4.6 * 0.35, 0.35, sz * 1.9 * 0.45] }))),
      tailpipe: [-4.6 / 2 - 0.05, 0.34, 0.54], categories: CATEGORY },
    resources: { triangles, materialDraws: car.children.length, geometryBytes, sourceParts: parts.length,
      textures: 0, textureBytes: 0, addedLights: 0 },
    movementBounds, visualBounds: describeBounds(box), parts };
  for (const mesh of car.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
  for (const geometry of Object.values(shared)) geometry.dispose();
  return result;
}

export async function exportObjectiveVehicleSource(output = resolve(ROOT, OUTPUT)) {
  const sourceFiles = Object.fromEntries(await Promise.all(SOURCE_FILES.map(async path =>
    [path, createHash('sha256').update(await readFile(resolve(ROOT, path))).digest('hex')])));
  const record = { version: 1, coordinateSystem: 'game metres: +X forward, +Y up, +Z right',
    provenance: 'Original project geometry; no third-party assets.', sourceFiles,
    variants: [await createObjectiveVehicleSource()] };
  await mkdir(dirname(output), { recursive: true });
  // Compact numeric payload avoids inflating the editable source snapshot.
  await writeFile(output, JSON.stringify(record) + '\n');
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const record = await exportObjectiveVehicleSource();
  console.log(JSON.stringify({ output: OUTPUT, resources: record.variants[0].resources,
    categories: CATEGORY, bounds: record.variants[0].visualBounds }, null, 2));
}
