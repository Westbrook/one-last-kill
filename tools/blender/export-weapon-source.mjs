#!/usr/bin/env node
/**
 * Export original procedural weapon meshes as a deterministic Blender input.
 * Run: node tools/blender/export-weapon-source.mjs
 *
 * This imports only the asset builder, so hands, held-weapon framing, and the
 * knife ready pose are deliberately absent. All mesh transforms are baked in
 * game metres (+X forward, +Y up, +Z right). Numeric arrays retain the source
 * precision and stay on one line; the surrounding metadata remains readable.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createHeroWeapon } from '../../src/render/hero-weapons.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = 'assets/blender/weapons-source.json';
const TYPES = ['knife', 'shotgun', 'smg', 'machinegun'];
const SOURCE_FILES = [
  'src/render/hero-weapons.js',
  'src/render/hero-weapon-uv.js',
  'src/render/hero-weapon-shell.js',
  'src/render/weapon-finishes.js',
  'src/render/surface-detail.js',
  'src/core/math.js',
  'package-lock.json',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bounds(box) {
  return { min: box.min.toArray(), max: box.max.toArray(), size: box.getSize(new THREE.Vector3()).toArray() };
}

function attributeInfo(attribute) {
  return {
    itemSize: attribute.itemSize,
    count: attribute.count,
    normalized: attribute.normalized,
    componentType: attribute.array.constructor.name,
  };
}

function materialInfo(material) {
  return {
    name: material.name,
    type: material.type,
    color: material.color?.toArray(),
    roughness: material.roughness,
    metalness: material.metalness,
    vertexColors: material.vertexColors,
    side: material.side,
    normalScale: material.normalScale?.toArray(),
    envMapIntensity: material.envMapIntensity,
    userData: structuredClone(material.userData),
  };
}

function exportWeapon(type) {
  const root = createHeroWeapon(type);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const parts = [];
  const materials = new Set();
  const finishes = new Set();
  root.traverse(mesh => {
    if (mesh === root) return;
    if (!mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh || mesh.children.length
        || Array.isArray(mesh.material) || mesh.geometry.morphAttributes.position?.length) {
      throw new TypeError(`${type}: only ordinary static, single-material leaf meshes are supported`);
    }
    if (mesh.matrixWorld.determinant() < 0) throw new TypeError(`${type}: negative-scale mesh needs explicit winding conversion`);
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
    const name = mesh.name || (type === 'shotgun' ? 'shotgun-front-bead' : `${type}-part-${parts.length}`);
    const attributes = {};
    const sourceAttributes = {};
    const names = Object.keys(geometry.attributes).sort((a, b) => {
      const order = ['position', 'normal', 'uv', 'color'];
      return (order.indexOf(a) < 0 ? order.length : order.indexOf(a))
        - (order.indexOf(b) < 0 ? order.length : order.indexOf(b)) || a.localeCompare(b);
    });
    for (const key of names) {
      const attribute = geometry.attributes[key];
      if (attribute.isInterleavedBufferAttribute) throw new TypeError(`${name}: interleaved ${key} is unsupported`);
      if (attribute.count !== geometry.attributes.position.count) throw new RangeError(`${name}: ${key} count differs from positions`);
      const array = Array.from(attribute.array);
      if (!array.every(Number.isFinite)) throw new RangeError(`${name}: non-finite ${key}`);
      sourceAttributes[key] = attributeInfo(mesh.geometry.attributes[key]);
      attributes[key] = { itemSize: attribute.itemSize, normalized: attribute.normalized, array };
    }
    if (!attributes.position || !attributes.normal) throw new TypeError(`${name}: positions and normals are required`);
    const index = geometry.index ? Array.from(geometry.index.array) : null;
    const elementCount = index?.length ?? geometry.attributes.position.count;
    if (elementCount % 3) throw new RangeError(`${name}: incomplete triangle`);
    if (index?.some(value => !Number.isInteger(value) || value < 0 || value >= geometry.attributes.position.count)) {
      throw new RangeError(`${name}: index outside vertex range`);
    }
    const finish = mesh.material.userData.weaponFinish?.profile || 'sight';
    materials.add(mesh.material);
    finishes.add(finish);
    parts.push({
      partIndex: parts.length,
      name,
      sourceName: mesh.name,
      finish,
      material: materialInfo(mesh.material),
      userData: structuredClone(mesh.userData),
      geometryUserData: structuredClone(mesh.geometry.userData),
      sourceGeometryType: mesh.geometry.type,
      sourceTriangles: elementCount / 3,
      sourceVertices: geometry.attributes.position.count,
      sourceAttributes,
      sourceIndex: mesh.geometry.index ? attributeInfo(mesh.geometry.index) : null,
      sourceMatrixWorld: mesh.matrixWorld.toArray(),
      bounds: bounds(geometry.boundingBox),
      attributes,
      index,
    });
    geometry.dispose();
  });
  const weapon = {
    name: root.name,
    type,
    userData: structuredClone(root.userData),
    sourceCounts: {
      meshes: parts.length,
      triangles: parts.reduce((total, part) => total + part.sourceTriangles, 0),
      vertices: parts.reduce((total, part) => total + part.sourceVertices, 0),
      materials: materials.size,
      finishes: [...finishes],
    },
    bounds: bounds(box),
    parts,
  };
  root.traverse(mesh => { if (mesh.isMesh) mesh.geometry.dispose(); });
  return weapon;
}

// Keep buffers compact without replacing real numeric values with sentinels or
// rounding geometry; every other object is indented for source review.
function formatJSON(value, depth = 0) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const pad = '  '.repeat(depth), next = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.every(item => item === null || typeof item !== 'object')) return JSON.stringify(value);
    return `[\n${value.map(item => next + formatJSON(item, depth + 1)).join(',\n')}\n${pad}]`;
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([key, item]) => `${next}${JSON.stringify(key)}: ${formatJSON(item, depth + 1)}`).join(',\n')}\n${pad}}`;
}

const sourceFiles = await Promise.all(SOURCE_FILES.map(async path => ({
  path, sha256: sha256(await readFile(resolve(ROOT, path))),
})));
const weapons = Object.fromEntries(TYPES.map(type => [type, exportWeapon(type)]));
const output = {
  schemaVersion: 1,
  generator: {
    path: 'tools/blender/export-weapon-source.mjs',
    sha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    command: 'node tools/blender/export-weapon-source.mjs',
    threeRevision: THREE.REVISION,
  },
  coordinateSystem: { units: 'metres', forward: '+X', up: '+Y', right: '+Z', transforms: 'baked world matrices' },
  scope: 'Original weapon-only meshes before batching, hand attachment, and knife ready-pose transforms.',
  sourceFiles,
  totals: {
    weapons: TYPES.length,
    meshes: Object.values(weapons).reduce((total, weapon) => total + weapon.sourceCounts.meshes, 0),
    triangles: Object.values(weapons).reduce((total, weapon) => total + weapon.sourceCounts.triangles, 0),
    vertices: Object.values(weapons).reduce((total, weapon) => total + weapon.sourceCounts.vertices, 0),
  },
  weapons,
};
const text = `${formatJSON(output)}\n`;
await mkdir(dirname(resolve(ROOT, OUTPUT)), { recursive: true });
await writeFile(resolve(ROOT, OUTPUT), text);
console.log(`${OUTPUT}: ${Buffer.byteLength(text)} bytes; sha256 ${sha256(text)}`);
for (const [type, weapon] of Object.entries(weapons)) {
  console.log(`${type}: ${weapon.sourceCounts.meshes} meshes, ${weapon.sourceCounts.triangles} triangles, ${weapon.sourceCounts.materials} materials`);
  for (const part of [...weapon.parts].sort((a, b) => b.sourceTriangles - a.sourceTriangles).slice(0, 6)) {
    console.log(`  ${part.sourceTriangles} triangles: ${part.name}`);
  }
}
