import * as THREE from 'three';
import { getFurnitureMaterials } from './furniture-materials.js';

const BOOK_SIZE = 128, BOOK_TILE = 32, BOOK_GUTTER = 4;
const RUG_WIDTH = 256, RUG_HEIGHT = 128, RUG_TILE = 128, RUG_GUTTER = 8;
const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
let shared = null;

function cell(index, width, height, tileSize, gutter) {
  const columns = width / tileSize, x = index % columns * tileSize, y = Math.floor(index / columns) * tileSize;
  return Object.freeze({
    uMin: (x + gutter + 0.5) / width, uMax: (x + tileSize - gutter - 0.5) / width,
    vMin: (y + gutter + 0.5) / height, vMax: (y + tileSize - gutter - 0.5) / height,
  });
}

const bookCell = index => cell(index, BOOK_SIZE, BOOK_SIZE, BOOK_TILE, BOOK_GUTTER);

/**
 * Explicit atlas UVs, inset to content texel centres with duplicated gutters.
 * Both textures use flipY=false: byte row zero is V zero. Map a complete book
 * face or rug into one cell; do not apply world/metric UV projection afterward.
 */
export const INTERIOR_STORY_ATLAS = Object.freeze({
  books: Object.freeze({
    width: BOOK_SIZE, height: BOOK_SIZE, tileSize: BOOK_TILE, gutter: BOOK_GUTTER,
    spines: Object.freeze(Array.from({ length: 8 }, (_, index) => bookCell(index))),
    paper: bookCell(8), pages: bookCell(9), label: bookCell(10), postcard: bookCell(11), note: bookCell(12),
  }),
  rugs: Object.freeze({
    width: RUG_WIDTH, height: RUG_HEIGHT, tileSize: RUG_TILE, gutter: RUG_GUTTER,
    warm: cell(0, RUG_WIDTH, RUG_HEIGHT, RUG_TILE, RUG_GUTTER),
    cool: cell(1, RUG_WIDTH, RUG_HEIGHT, RUG_TILE, RUG_GUTTER),
  }),
});

const SPINE_COLORS = [[112, 81, 64], [71, 91, 79], [136, 124, 95], [72, 87, 103],
  [133, 91, 66], [111, 80, 88], [101, 109, 89], [86, 82, 75]];
const RUG_COLORS = [[107, 96, 79], [99, 113, 105]];
const PAPER = [184, 180, 160], INK = [89, 88, 76];

function grain(x, y, seed) {
  let value = Math.imul(x + 29, 374761393) ^ Math.imul(y + 41, 668265263) ^ seed;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296 - 0.5;
}

function color(out, base, tone = 0) {
  out[0] = base[0] + tone; out[1] = base[1] + tone; out[2] = base[2] + tone;
}

function bookPixel(tile, u, v, x, y, out) {
  const textureGrain = grain(x, y, 317 + tile) * 2;
  if (tile < SPINE_COLORS.length) {
    const base = SPINE_COLORS[tile];
    color(out, base, textureGrain);
    // Restrained binding bands and abstract title marks, never readable text
    // or painted directional lighting. Colour variation belongs to the book.
    const band = (v > 0.095 && v < 0.145) || (v > 0.855 && v < 0.905);
    if (band) color(out, base, 13 + textureGrain);
    if (u > 0.10 && u < 0.17) color(out, base, -5 + textureGrain);
    if (tile % 3 !== 1 && u > 0.22 && u < 0.78 && v > 0.57 && v < 0.73) {
      color(out, base, 27 + textureGrain);
      if ((v > 0.605 && v < 0.625) || (v > 0.67 && v < 0.69)) color(out, base, 4);
    } else if (tile % 3 === 1 && u > 0.25 && u < 0.75 && v > 0.64 && v < 0.70) color(out, base, 18);
    return;
  }
  color(out, PAPER, textureGrain);
  if (tile === 9) {
    // Page-edge groups are subtle enough not to turn into dark shelf stripes.
    color(out, PAPER, textureGrain + (y % 3 === 0 ? -5 : 1));
  } else if (tile === 10) {
    const edge = Math.min(u, v, 1 - u, 1 - v);
    if (edge > 0.07 && edge < 0.13) color(out, [146, 137, 112], textureGrain);
  } else if (tile === 11 && u > 0.07 && u < 0.93 && v > 0.10 && v < 0.90) {
    // An original geometric landscape illustration, not a photograph: sky,
    // two angular hills and a small ochre sun inside an unprinted paper frame.
    color(out, [139, 157, 158], textureGrain * 0.3);
    const distantHill = 0.44 + Math.max(0, 1 - Math.abs(u - 0.32) * 2.8) * 0.25;
    const nearHill = 0.23 + Math.max(0, 1 - Math.abs(u - 0.76) * 2.2) * 0.25;
    if (v < distantHill) color(out, [108, 126, 105], textureGrain * 0.3);
    if (v < nearHill) color(out, [90, 109, 91], textureGrain * 0.3);
    if ((u - 0.73) ** 2 + (v - 0.76) ** 2 < 0.055 ** 2) color(out, [185, 165, 121]);
  } else if (tile === 12) {
    const heading = u > 0.15 && u < 0.75 && v > 0.76 && v < 0.81;
    const line = u > 0.15 && ((u < 0.83 && v > 0.59 && v < 0.62)
      || (u < 0.70 && v > 0.47 && v < 0.50) || (u < 0.77 && v > 0.33 && v < 0.37));
    if (heading || line) color(out, INK, textureGrain);
  }
}

function rugPixel(tile, u, v, x, y, out) {
  const base = RUG_COLORS[tile];
  const edge = Math.min(u, v, 1 - u, 1 - v);
  const weave = Math.sin(u * TAU * 45) * Math.sin(v * TAU * 45) * 0.6;
  const variation = grain(x, y, 911 + tile) * 1.3 + weave;
  let border = 0;
  if (edge < 0.025) border = -12;
  else if (edge < 0.045) border = 5;
  else if (edge > 0.075 && edge < 0.105) border = -7;
  else if (edge > 0.105 && edge < 0.12) border = 3;
  color(out, base, border + variation);
}

function atlasTexture(name, width, height, tileSize, gutter, sample) {
  const data = new Uint8Array(width * height * 4), out = [0, 0, 0];
  const innerSpan = tileSize - gutter * 2 - 1, columns = width / tileSize;
  for (let y = 0; y < height; y++) {
    const sy = clamp(y % tileSize - gutter, 0, innerSpan);
    for (let x = 0; x < width; x++) {
      const sx = clamp(x % tileSize - gutter, 0, innerSpan);
      const tile = Math.floor(y / tileSize) * columns + Math.floor(x / tileSize);
      sample(tile, sx / innerSpan, sy / innerSpan, sx, sy, out);
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.round(clamp(out[channel], 0, 255));
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.name = name;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function atlasMaterial(name, map, kind, roughness) {
  const material = new THREE.MeshStandardMaterial({ map, roughness, metalness: 0, envMapIntensity: 0.16 });
  material.name = name;
  let width = map.image.width, height = map.image.height, mipBytes = 0;
  for (;;) {
    mipBytes += width * height * 4;
    if (width === 1 && height === 1) break;
    width = Math.max(1, width / 2); height = Math.max(1, height / 2);
  }
  // Atlas geometry owns its UVs. A surfaceMeters value would invite generic
  // box batching to replace those cells with an incompatible metric projection.
  material.userData = { surfaceKind: kind, staticSurfaceMaps: true, interiorStoryAtlas: true,
    textureBytes: map.image.data.byteLength, textureBytesWithMipmaps: mipBytes };
  return material;
}

/** Four materials; only two new textures (192 KiB base, 256 KiB with mipmaps). */
export function getInteriorStoryMaterials() {
  if (!shared) {
    const furniture = getFurnitureMaterials();
    const upholsteryWarm = furniture.upholstery.clone(), upholsteryCool = furniture.linen.clone();
    upholsteryWarm.name = 'interior-story-upholstery-warm';
    upholsteryCool.name = 'interior-story-upholstery-cool'; upholsteryCool.color.setHex(0x80928a);
    shared = Object.freeze({
      books: atlasMaterial('interior-story-books',
        atlasTexture('interior-story-book-atlas', BOOK_SIZE, BOOK_SIZE, BOOK_TILE, BOOK_GUTTER, bookPixel), 'wood', 0.91),
      rugs: atlasMaterial('interior-story-rugs',
        atlasTexture('interior-story-rug-atlas', RUG_WIDTH, RUG_HEIGHT, RUG_TILE, RUG_GUTTER, rugPixel), 'fabric', 0.96),
      upholsteryWarm, upholsteryCool,
    });
  }
  return shared;
}
