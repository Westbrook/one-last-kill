import * as THREE from 'three';
import { normalsFromHeights } from './surface-detail.js';
import { getFurnitureMaterials } from './furniture-materials.js';
import { getWeaponFinishes } from './weapon-finishes.js';

const BREAD_WIDTH = 256, BREAD_HEIGHT = 128, BREAD_TILE = 128, BREAD_GUTTER = 8;
const PACKAGE_SIZE = 128, PACKAGE_TILE = 64, PACKAGE_GUTTER = 6;
const BREAD_METERS = 0.28;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = value => value * value * (3 - 2 * value);
let shared = null;

function rectangle(x, y, cellWidth, cellHeight, width, height, gutter) {
  return Object.freeze({ uMin: (x + gutter + 0.5) / width, uMax: (x + cellWidth - gutter - 0.5) / width,
    vMin: (y + gutter + 0.5) / height, vMax: (y + cellHeight - gutter - 0.5) / height });
}

function cell(index, width, height, tile, gutter) {
  return rectangle(index % (width / tile) * tile, Math.floor(index / (width / tile)) * tile,
    tile, tile, width, height, gutter);
}

/** All atlas maps use flipY=false: byte row zero is V zero. Insets include gutters. */
export const BAKERY_PROVISION_ATLAS = Object.freeze({
  bread: Object.freeze({ width: BREAD_WIDTH, height: BREAD_HEIGHT, tileSize: BREAD_TILE, gutter: BREAD_GUTTER,
    // The second tile reserves a narrow pale field for physically opened cuts.
    // Its crust UVs exclude that field, so plain loaf shells never show a patch.
    cells: Object.freeze([cell(0, BREAD_WIDTH, BREAD_HEIGHT, BREAD_TILE, BREAD_GUTTER),
      rectangle(128, 32, 128, 96, BREAD_WIDTH, BREAD_HEIGHT, BREAD_GUTTER)]),
    crumb: rectangle(128, 0, 128, 32, BREAD_WIDTH, BREAD_HEIGHT, BREAD_GUTTER) }),
  packages: Object.freeze({ width: PACKAGE_SIZE, height: PACKAGE_SIZE, tileSize: PACKAGE_TILE, gutter: PACKAGE_GUTTER,
    flour: cell(0, PACKAGE_SIZE, PACKAGE_SIZE, PACKAGE_TILE, PACKAGE_GUTTER),
    kraft: cell(1, PACKAGE_SIZE, PACKAGE_SIZE, PACKAGE_TILE, PACKAGE_GUTTER),
    label: cell(2, PACKAGE_SIZE, PACKAGE_SIZE, PACKAGE_TILE, PACKAGE_GUTTER),
    plain: cell(3, PACKAGE_SIZE, PACKAGE_SIZE, PACKAGE_TILE, PACKAGE_GUTTER) }),
});

function hash(x, y, seed) {
  let value = Math.imul(x + 71, 374761393) ^ Math.imul(y + 29, 668265263) ^ seed;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function noise(u, v, cells, seed) {
  const x = u * cells, y = v * cells, ix = Math.floor(x), iy = Math.floor(y);
  const sx = smooth(x - ix), sy = smooth(y - iy);
  const a = hash(ix % cells, iy % cells, seed), b = hash((ix + 1) % cells, iy % cells, seed);
  const c = hash(ix % cells, (iy + 1) % cells, seed), d = hash((ix + 1) % cells, (iy + 1) % cells, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function texture(name, data, width, height, color = false) {
  const map = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  map.name = name; map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.flipY = false; map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter;
  map.anisotropy = 4; map.needsUpdate = true;
  return map;
}

function mapBytes(map, mipmaps = false) {
  const { width, height } = map.image;
  let bytes = 0;
  for (let level = 0; level <= (mipmaps ? Math.log2(Math.max(width, height)) : 0); level++) {
    bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
  }
  return bytes;
}

function metadata(material, kind, ownsMaps = true) {
  const maps = new Set([material.map, material.normalMap, material.roughnessMap, material.metalnessMap].filter(Boolean));
  const bytes = [...maps].reduce((sum, map) => sum + mapBytes(map), 0);
  const mipBytes = [...maps].reduce((sum, map) => sum + mapBytes(map, true), 0);
  material.userData = { surfaceKind: kind, staticSurfaceMaps: true, bakeryProvision: true,
    textureBytes: bytes, textureBytesWithMipmaps: mipBytes,
    newTextureBytes: ownsMaps ? bytes : 0, newTextureBytesWithMipmaps: ownsMaps ? mipBytes : 0 };
  return material;
}

function breadMaps() {
  const albedo = new Uint8Array(BREAD_WIDTH * BREAD_HEIGHT * 4);
  const normal = new Uint8Array(albedo.length), roughness = new Uint8Array(albedo.length);
  const inner = BREAD_TILE - BREAD_GUTTER * 2;
  const crustColors = [[178, 133, 80], [158, 112, 65]], flourColor = [194, 185, 161];
  for (let tile = 0; tile < 2; tile++) {
    const colors = new Uint8Array(inner * inner * 4), finish = new Uint8Array(colors.length);
    const heights = new Float32Array(inner * inner), seed = 1601 + tile * 37;
    for (let y = 0; y < inner; y++) for (let x = 0; x < inner; x++) {
      const u = x / (inner - 1), v = y / (inner - 1), offset = (y * inner + x) * 4;
      const broad = noise(u, v, 4, seed), fine = noise(u, v, 16, seed + 1), pores = noise(u, v, 48, seed + 2);
      const flour = smooth(clamp((noise(u, v, 6, seed + 3) - 0.54) / 0.30, 0, 1)) * 0.30 * (0.72 + pores * 0.5);
      const pore = Math.max(0, (0.30 - pores) / 0.30) ** 2;
      const tone = (broad - 0.5) * 15 + (fine - 0.5) * 4 + (pores - 0.5) * 1.5 - pore * 1.5;
      for (let channel = 0; channel < 3; channel++) {
        const crust = crustColors[tile][channel] + tone;
        colors[offset + channel] = Math.round(crust + (flourColor[channel] - crust) * flour);
      }
      colors[offset + 3] = 255;
      finish[offset] = 255; finish[offset + 1] = Math.round(clamp(0.86 + flour * 0.11 + (fine - 0.5) * 0.05 + pore * 0.025, 0.82, 0.98) * 255);
      finish[offset + 2] = 0; finish[offset + 3] = 255;
      // Only shallow pores and flour dust. Cuts, scores and baked-in shadows
      // would compete with the actual scored bread geometry.
      heights[y * inner + x] = (pores - 0.5) * 0.00009 - pore * 0.000075 + flour * 0.000025;
    }
    const normals = normalsFromHeights(heights, inner, inner, BREAD_METERS, true);
    for (let y = 0; y < BREAD_TILE; y++) for (let x = 0; x < BREAD_TILE; x++) {
      const sx = clamp(x - BREAD_GUTTER, 0, inner - 1), sy = clamp(y - BREAD_GUTTER, 0, inner - 1);
      const source = (sy * inner + sx) * 4, target = (y * BREAD_WIDTH + tile * BREAD_TILE + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        albedo[target + channel] = colors[source + channel];
        roughness[target + channel] = finish[source + channel];
        normal[target + channel] = normals[source + channel];
      }
      // The helper expects downward image rows/flipY=true; this atlas uses
      // ascending V rows. Reverse tangent Y, without flipping the other maps.
      normal[target + 1] = 255 - normal[target + 1];
    }
  }
  // Duplicate the shortened crust cell's new lower gutter before reserving
  // the crumb band. Neither cell samples a border shared with another finish.
  for (let y = 32; y < 40; y++) for (let x = 128; x < 256; x++) {
    const source = (40 * BREAD_WIDTH + x) * 4, target = (y * BREAD_WIDTH + x) * 4;
    for (const map of [albedo, normal, roughness]) for (let channel = 0; channel < 4; channel++) map[target + channel] = map[source + channel];
  }
  for (let y = 0; y < 32; y++) for (let x = 128; x < 256; x++) {
    const sx = clamp(x - 136, 0, 111), sy = clamp(y - 8, 0, 15), target = (y * BREAD_WIDTH + x) * 4;
    const variation = (hash(sx, sy, 2017) - 0.5) * 5;
    albedo[target] = Math.round(188 + variation); albedo[target + 1] = Math.round(170 + variation);
    albedo[target + 2] = Math.round(134 + variation); albedo[target + 3] = 255;
    normal[target] = normal[target + 1] = 128; normal[target + 2] = normal[target + 3] = 255;
    roughness[target] = 255; roughness[target + 1] = Math.round(0.96 * 255);
    roughness[target + 2] = 0; roughness[target + 3] = 255;
  }
  return {
    map: texture('bakery-bread-albedo', albedo, BREAD_WIDTH, BREAD_HEIGHT, true),
    normalMap: texture('bakery-bread-normal', normal, BREAD_WIDTH, BREAD_HEIGHT),
    roughnessMap: texture('bakery-bread-roughness', roughness, BREAD_WIDTH, BREAD_HEIGHT),
  };
}

const LETTERS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};

function lettering(word, u, v) {
  if (u < 0.09 || u >= 0.91 || v < 0.38 || v >= 0.66) return false;
  const column = Math.floor((u - 0.09) / 0.82 * (word.length * 6 - 1));
  const row = 6 - Math.floor((v - 0.38) / 0.28 * 7);
  return LETTERS[word[Math.floor(column / 6)]]?.[row]?.[column % 6] === '1';
}

function packageMap() {
  const data = new Uint8Array(PACKAGE_SIZE * PACKAGE_SIZE * 4), innerSpan = PACKAGE_TILE - PACKAGE_GUTTER * 2 - 1;
  const colors = [[185, 181, 156], [150, 122, 88], [190, 184, 161], [173, 158, 132]];
  const words = ['FLOUR', 'BREAD', 'BAKERY', ''];
  for (let y = 0; y < PACKAGE_SIZE; y++) for (let x = 0; x < PACKAGE_SIZE; x++) {
    const sx = clamp(x % PACKAGE_TILE - PACKAGE_GUTTER, 0, innerSpan), sy = clamp(y % PACKAGE_TILE - PACKAGE_GUTTER, 0, innerSpan);
    const u = sx / innerSpan, v = sy / innerSpan, tile = Math.floor(y / PACKAGE_TILE) * 2 + Math.floor(x / PACKAGE_TILE);
    const offset = (y * PACKAGE_SIZE + x) * 4, grain = (hash(sx, sy, 1901 + tile) - 0.5) * 2;
    const stripe = tile !== 3 && ((v > 0.21 && v < 0.255) || (v > 0.75 && v < 0.79));
    const text = lettering(words[tile], u, v);
    for (let channel = 0; channel < 3; channel++) {
      const ink = tile === 1 ? [80, 64, 47] : [79, 87, 71];
      data[offset + channel] = Math.round(text ? ink[channel] : stripe
        ? colors[tile][channel] * 0.73 + grain : colors[tile][channel] + grain);
    }
    data[offset + 3] = 255;
  }
  return texture('bakery-package-albedo', data, PACKAGE_SIZE, PACKAGE_SIZE, true);
}

/** Three shared materials; only bread/package maps add texture allocations. */
export function getBakeryProvisionMaterials() {
  if (!shared) {
    const bread = new THREE.MeshStandardMaterial({ ...breadMaps(), roughness: 1, metalness: 0,
      normalScale: new THREE.Vector2(0.65, 0.65), envMapIntensity: 0.18 });
    bread.name = 'bakery-bread';
    const packages = new THREE.MeshStandardMaterial({ map: packageMap(), roughness: 0.94, metalness: 0, envMapIntensity: 0.14 });
    packages.name = 'bakery-packages';
    const steel = getWeaponFinishes().metal.clone();
    steel.name = 'bakery-preparation-steel'; steel.vertexColors = false;
    steel.roughnessMap = getFurnitureMaterials().linen.roughnessMap; steel.roughness = 0.65;
    steel.normalScale.set(0.28, 0.28); steel.envMapIntensity = 0.42;
    metadata(steel, 'metal', false); steel.userData.surfaceMeters = 0.18;
    shared = Object.freeze({ bread: metadata(bread, 'fabric'), packages: metadata(packages, 'fabric'), steel });
  }
  return shared;
}
