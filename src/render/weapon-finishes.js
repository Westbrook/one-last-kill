import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { normalsFromHeights } from './surface-detail.js';

const SIZE = 128, TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = value => value * value * (3 - 2 * value);
const SPECS = {
  metal: { color: [119, 129, 135], roughness: 0.38, metalness: 0.84, meters: 0.18, seed: 17 },
  metalDark: { color: [51, 59, 63], roughness: 0.47, metalness: 0.74, meters: 0.18, seed: 29 },
  polymer: { color: [34, 38, 39], roughness: 0.82, metalness: 0, meters: 0.12, seed: 43 },
  wood: { color: [105, 78, 51], roughness: 0.72, metalness: 0, meters: 0.34, seed: 61 },
  blade: { color: [176, 184, 187], roughness: 0.29, metalness: 0.94, meters: 0.18, seed: 73 },
  glove: { color: [38, 44, 44], roughness: 0.91, metalness: 0, meters: 0.10, seed: 89 },
  sleeve: { color: [25, 31, 32], roughness: 0.96, metalness: 0, meters: 0.14, seed: 101 },
};
let shared = null;

function hash(x, y, seed) {
  let value = Math.imul(x + 19, 374761393) ^ Math.imul(y + 53, 668265263) ^ seed;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function noise(u, v, cells, seed) {
  const x = u * cells, y = v * cells, ix = Math.floor(x), iy = Math.floor(y);
  const tx = smooth(x - ix), ty = smooth(y - iy);
  const a = hash(ix % cells, iy % cells, seed), b = hash((ix + 1) % cells, iy % cells, seed);
  const c = hash(ix % cells, (iy + 1) % cells, seed), d = hash((ix + 1) % cells, (iy + 1) % cells, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

function dataTexture(bytes, color = false) {
  const texture = new THREE.DataTexture(bytes, SIZE, SIZE, THREE.RGBAFormat);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.flipY = true; texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4; texture.needsUpdate = true;
  return texture;
}

function makeFinish(kind, spec) {
  const albedo = new Uint8Array(SIZE * SIZE * 4), finish = new Uint8Array(albedo.length);
  const heights = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const v = y / (SIZE - 1);
    for (let x = 0; x < SIZE; x++) {
      const u = x / (SIZE - 1), offset = (y * SIZE + x) * 4;
      const broad = noise(u, v, 8, spec.seed), fine = noise(u, v, 48, spec.seed + 1);
      let tone = (broad - 0.5) * 3 + (fine - 0.5) * 2;
      let roughness = spec.roughness + (fine - 0.5) * 0.06;
      let height = (fine - 0.5) * 0.00002, metallic = spec.metalness;
      if (kind === 'wood') {
        // Fibres follow the stock's long axis, with subdued worn patches.
        const grain = Math.pow((Math.sin(v * TAU * 25 + Math.sin(u * TAU) * 0.7) + 1) * 0.5, 8);
        const growth = Math.sin(v * TAU * 5 + Math.sin(u * TAU) * 0.35);
        tone += growth * 4 - grain * 8 + (broad - 0.5) * 7;
        roughness += grain * 0.06 + broad * 0.06;
        height -= grain * 0.000055;
      } else if (kind === 'glove' || kind === 'sleeve') {
        const weave = Math.sin(u * TAU * 32) * Math.sin(v * TAU * 32);
        tone += weave * (kind === 'glove' ? 1.4 : 0.9);
        height += weave * 0.000035;
      } else if (kind === 'polymer') {
        const stipple = Math.pow(fine, 3);
        tone += (stipple - 0.25) * 4;
        height += stipple * 0.000055;
        roughness += stipple * 0.05;
      } else {
        // Brushing and shallow scratches coordinate colour and finish without
        // painting directional lighting or a bright border onto every part.
        const brushing = Math.sin(v * TAU * 46 + Math.sin(u * TAU * 3) * 0.3);
        const scratch = Math.pow(Math.max(0, Math.cos(v * TAU * 11 + Math.sin(u * TAU) * 0.8)), 48)
          * Math.max(0, broad - 0.45) * 1.8;
        const handling = Math.pow(noise(u, v, 5, spec.seed + 31), 3);
        tone += brushing * 1.4 + scratch * (kind === 'metalDark' ? 22 : 14) + handling * 6;
        roughness += (broad - 0.5) * 0.17 - scratch * 0.14 - handling * 0.08;
        height += brushing * 0.000009 - scratch * 0.00004;
        metallic = clamp(metallic + scratch * 0.12, 0, 1);
      }
      for (let channel = 0; channel < 3; channel++) albedo[offset + channel] = clamp(Math.round(spec.color[channel] + tone), 0, 255);
      albedo[offset + 3] = 255;
      finish[offset] = 255; finish[offset + 1] = Math.round(clamp(roughness, 0.18, 0.99) * 255);
      finish[offset + 2] = Math.round(metallic * 255); finish[offset + 3] = 255;
      heights[y * SIZE + x] = height;
    }
  }
  const finishMap = dataTexture(finish);
  const material = new THREE.MeshStandardMaterial({
    map: dataTexture(albedo, true), normalMap: dataTexture(normalsFromHeights(heights, SIZE, SIZE, spec.meters, true)),
    roughnessMap: finishMap, metalnessMap: finishMap, roughness: 1, metalness: 1,
    vertexColors: true, normalScale: new THREE.Vector2(0.55, 0.55), envMapIntensity: spec.metalness ? 1.05 : 0.24,
  });
  material.name = `weapon-finish:${kind}`;
  material.userData.weaponFinish = { profile: kind, surfaceMeters: spec.meters, textureSize: SIZE };
  return material;
}

/** Small immutable-in-use finishes are shared by every cached firearm/knife. */
export function getWeaponFinishes() {
  if (!shared) {
    shared = Object.fromEntries(Object.entries(SPECS).map(([kind, spec]) => [kind, makeFinish(kind, spec)]));
    shared.sight = new THREE.MeshBasicMaterial({ color: 0xaebfb0 });
    shared.sight.name = 'weapon-sight-dot';
    Object.freeze(shared);
  }
  return shared;
}

const _size = new THREE.Vector3();

function mapSurface(geometry, source, meters) {
  const uv = geometry.attributes.uv;
  if (!uv || !meters) return;
  // Profile/loft assets can author physical UVs alongside their geometry.
  // Preserve that explicit mapping instead of treating every custom buffer as
  // a cylindrical primitive. Existing primitive mapping remains unchanged.
  if (source.geometry.userData.weaponSurfaceUV) return;
  if (source.geometry.type === 'BoxGeometry' || source.geometry.type === 'RoundedBoxGeometry') {
    const position = geometry.attributes.position, normal = geometry.attributes.normal;
    // These coordinates are already in weapon space, so adjacent receiver
    // pieces use the same centimetre scale instead of stretching one tile.
    for (let i = 0; i < uv.count; i++) {
      const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i)), nz = Math.abs(normal.getZ(i));
      if (nx > ny && nx > nz) uv.setXY(i, position.getZ(i) / meters, position.getY(i) / meters);
      else if (ny > nz) uv.setXY(i, position.getX(i) / meters, position.getZ(i) / meters);
      else uv.setXY(i, position.getX(i) / meters, position.getY(i) / meters);
    }
  } else {
    // Preserve cylindrical/spherical UV topology and scale the repeat by the
    // authored dimensions. Projecting these surfaces would split the barrel.
    source.geometry.computeBoundingBox();
    source.geometry.boundingBox.getSize(_size).multiply(source.scale);
    const circumference = Math.PI * Math.max(Math.abs(_size.x), Math.abs(_size.z));
    const height = Math.abs(_size.y);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circumference / meters, uv.getY(i) * height / meters);
  }
}

/**
 * Consume a freshly built viewmodel's owned static mesh children. It has no
 * animated subparts; root transforms and muzzle metadata are left untouched.
 * A material batch is one draw, with the original triangle count unchanged.
 */
export function batchStaticWeaponParts(root) {
  const sources = [...root.children], buckets = new Map(), owned = new Set();
  let sourceTriangles = 0;
  for (const source of sources) {
    if (!source.isMesh || source.isInstancedMesh || source.isSkinnedMesh || source.children.length || Array.isArray(source.material)) {
      throw new TypeError('Only owned static weapon meshes can be batched');
    }
    source.updateMatrix();
    const geometry = source.geometry.index ? source.geometry.toNonIndexed() : source.geometry.clone();
    geometry.applyMatrix4(source.matrix);
    mapSurface(geometry, source, source.material.userData.weaponFinish?.surfaceMeters);
    if (source.material.vertexColors && !geometry.attributes.color) {
      // Legacy accents can share a vertex-tinted finish without losing their
      // neutral colour or making the merged attribute layouts incompatible.
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(
        new Float32Array(geometry.attributes.position.count * 3).fill(1), 3));
    }
    sourceTriangles += geometry.attributes.position.count / 3;
    let bucket = buckets.get(source.material);
    if (!bucket) { bucket = []; buckets.set(source.material, bucket); }
    bucket.push(geometry); owned.add(source.geometry);
  }
  const meshes = [];
  for (const [material, geometries] of buckets) {
    const geometry = mergeGeometries(geometries, false);
    if (!geometry) throw new Error('Weapon geometry attributes must be compatible');
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `weapon-batch:${material.userData.weaponFinish?.profile || material.userData.handFinish?.profile || 'sight'}`;
    meshes.push(mesh);
    for (const part of geometries) part.dispose();
  }
  for (const source of sources) root.remove(source);
  for (const geometry of owned) geometry.dispose();
  root.add(...meshes);
  root.userData.presentation = Object.freeze({
    sourceMeshes: sources.length, drawCalls: meshes.length, sourceTriangles,
    triangles: meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count / 3, 0),
    finishProfiles: [...buckets.keys()].map(material => material.userData.weaponFinish?.profile || material.userData.handFinish?.profile || 'sight'),
  });
  return root;
}
