import * as THREE from 'three';
import { normalsFromHeights } from './surface-detail.js';

const SIZE = 128, TAU = Math.PI * 2;
const MAP_BYTES = SIZE * SIZE * 4;
// Includes every level down to 1×1; six maps remain just below 512 KiB.
const MIP_MAP_BYTES = (SIZE * SIZE * 4 - 1) / 3 * 4;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = value => value * value * (3 - 2 * value);
let shared = null;

function hash(x, y, seed) {
  let value = Math.imul(x + 37, 374761393) ^ Math.imul(y + 71, 668265263) ^ seed;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function noise(u, v, cellsX, cellsY, seed) {
  const x = u * cellsX, y = v * cellsY, ix = Math.floor(x), iy = Math.floor(y);
  const sx = smooth(x - ix), sy = smooth(y - iy);
  const a = hash(ix % cellsX, iy % cellsY, seed);
  const b = hash((ix + 1) % cellsX, iy % cellsY, seed);
  const c = hash(ix % cellsX, (iy + 1) % cellsY, seed);
  const d = hash((ix + 1) % cellsX, (iy + 1) % cellsY, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function texture(bytes, kind, channel, color = false) {
  const result = new THREE.DataTexture(bytes, SIZE, SIZE, THREE.RGBAFormat);
  result.name = `furniture:${kind}:${channel}`;
  result.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  // Physical repeats are supplied by the furniture geometry's metric UVs.
  result.repeat.set(1, 1);
  result.flipY = true;
  result.generateMipmaps = true;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.anisotropy = 4;
  result.needsUpdate = true;
  return result;
}

function metadata(material, kind, meters, textured = false) {
  material.userData.surfaceKind = kind;
  material.userData.surfaceMeters = meters;
  material.userData.staticSurfaceMaps = textured;
  material.userData.textureBytes = textured ? MAP_BYTES * 3 : 0;
  material.userData.textureBytesWithMipmaps = textured ? MIP_MAP_BYTES * 3 : 0;
  return material;
}

function makeTexturedFinish(kind) {
  const wood = kind === 'wood', meters = wood ? 0.6 : 0.3;
  const base = wood ? [111, 87, 65] : [183, 175, 157];
  const albedo = new Uint8Array(MAP_BYTES), roughness = new Uint8Array(MAP_BYTES);
  const heights = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    // Duplicate borders make all three channels agree at tile boundaries.
    const v = (y % (SIZE - 1)) / (SIZE - 1);
    for (let x = 0; x < SIZE; x++) {
      const u = (x % (SIZE - 1)) / (SIZE - 1), offset = (y * SIZE + x) * 4;
      const broad = noise(u, v, 4, 4, wood ? 701 : 809);
      const fine = noise(u, v, 48, 48, wood ? 703 : 811);
      let tone, finish, height;
      if (wood) {
        // Continuous, gently wandering fibres: cabinet timber has no dark
        // floorboard joints. A sealed finish keeps its relief below 0.2 mm.
        const warp = Math.sin(u * TAU) * 0.72 + Math.sin(u * TAU * 2) * 0.22;
        const growth = Math.sin(v * TAU * 5 + warp * 0.65);
        const fibre = Math.pow((Math.sin(v * TAU * 23 + warp) + 1) * 0.5, 6);
        const streak = noise(u, v, 3, 24, 707);
        tone = growth * 3.5 - fibre * 6.5 + (streak - 0.5) * 6 + (broad - 0.5) * 4 + (fine - 0.5);
        finish = clamp(0.64 + fibre * 0.055 + (streak - 0.5) * 0.07 + (broad - 0.5) * 0.035, 0.55, 0.75);
        height = -fibre * 0.00010 + (streak - 0.5) * 0.000055 + (fine - 0.5) * 0.000015;
      } else {
        // Thread contrast belongs mainly in the matte finish, so a distant
        // cushion does not turn into a checkerboard or shimmer as it moves.
        const warp = Math.sin(u * TAU * 48), weft = Math.sin(v * TAU * 48);
        const weave = warp * weft;
        const slub = noise(u, v, 8, 36, 821) - 0.5;
        tone = (broad - 0.5) * 3 + (fine - 0.5) * 1.3 + weave * 0.65 + slub * 0.9;
        finish = clamp(0.95 + weave * 0.012 + (fine - 0.5) * 0.022 + slub * 0.01, 0.9, 0.98);
        height = weave * 0.000065 + slub * 0.000025 + (fine - 0.5) * 0.000015;
      }
      for (let channel = 0; channel < 3; channel++) albedo[offset + channel] = Math.round(clamp(base[channel] + tone, 0, 255));
      albedo[offset + 3] = 255;
      // Packed AO / roughness / metalness with no baked lighting or metal.
      roughness[offset] = 255; roughness[offset + 1] = Math.round(finish * 255);
      roughness[offset + 2] = 0; roughness[offset + 3] = 255;
      heights[y * SIZE + x] = height;
    }
  }
  const material = new THREE.MeshStandardMaterial({
    map: texture(albedo, kind, 'albedo', true),
    normalMap: texture(normalsFromHeights(heights, SIZE, SIZE, meters, true), kind, 'normal'),
    roughnessMap: texture(roughness, kind, 'roughness'),
    roughness: 1, metalness: 0,
    normalScale: new THREE.Vector2(wood ? 0.7 : 0.55, wood ? 0.7 : 0.55),
    envMapIntensity: wood ? 0.28 : 0.16,
  });
  material.name = `furniture-${kind}`;
  return metadata(material, wood ? 'wood' : 'fabric', meters, true);
}

/** Five shared finishes; textures bake once on first use, without a DOM or GPU. */
export function getFurnitureMaterials() {
  if (!shared) {
    const linen = makeTexturedFinish('linen');
    // Upholstery uses the same quiet weave at the same physical scale. Tint
    // the shared maps instead of retaining a second coarse cloth texture set.
    const upholstery = linen.clone();
    upholstery.name = 'furniture-upholstery';
    upholstery.color.setHex(0x969c91);
    const hardware = new THREE.MeshStandardMaterial({
      color: 0xa2a39a, roughness: 0.36, metalness: 0.78, envMapIntensity: 0.38,
    });
    hardware.name = 'furniture-hardware';
    const glazing = new THREE.MeshStandardMaterial({
      color: 0x151c1d, roughness: 0.22, metalness: 0, envMapIntensity: 0.48,
      transparent: false, opacity: 1,
    });
    glazing.name = 'furniture-glazing';
    shared = Object.freeze({
      wood: makeTexturedFinish('wood'),
      linen,
      upholstery,
      hardware: metadata(hardware, 'metal', 0.6),
      glazing: metadata(glazing, 'glass', 0.6),
    });
  }
  return shared;
}
