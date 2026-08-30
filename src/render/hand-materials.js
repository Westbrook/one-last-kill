import * as THREE from 'three';
import { normalsFromHeights } from './surface-detail.js';

const SIZE = 256, HALF = SIZE / 2, CLOTH_SIZE = 128, GUTTER = 8;
const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = value => value * value * (3 - 2 * value);
const ramp = (low, high, value) => smooth(clamp((value - low) / (high - low), 0, 1));
const band = (value, center, width) => Math.exp(-(((value - center) / width) ** 2));
const wrappedDistance = (value, center) => Math.min(Math.abs(value - center), 1 - Math.abs(value - center));
let shared = null;

/**
 * Actual texture UVs, with eight texels of padding around each region. Albedo
 * contains the base colors: hand vertex colors should be white or subtle
 * multipliers. Neither triangles nor their UV interpolation should cross the
 * skin/glove boundary. The atlas uses unflipped data, so row zero is V zero.
 */
export const HAND_ATLAS = Object.freeze({
  size: SIZE,
  skin: Object.freeze({ uMin: GUTTER / SIZE, uMax: (SIZE - GUTTER) / SIZE,
    vMin: GUTTER / SIZE, vMax: (HALF - GUTTER) / SIZE }),
  glove: Object.freeze({ uMin: GUTTER / SIZE, uMax: (SIZE - GUTTER) / SIZE,
    vMin: (HALF + GUTTER) / SIZE, vMax: (SIZE - GUTTER) / SIZE }),
});

function hash(x, y, seed) {
  let value = Math.imul(x + 19, 374761393) ^ Math.imul(y + 53, 668265263) ^ seed;
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

function texture(bytes, size, name, color = false, repeat = false) {
  const result = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  result.name = name;
  result.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  result.wrapS = result.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  result.flipY = false;
  result.generateMipmaps = true;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.anisotropy = 4;
  result.needsUpdate = true;
  return result;
}

function writeColor(bytes, offset, color, variation) {
  for (let channel = 0; channel < 3; channel++) {
    bytes[offset + channel] = Math.round(clamp(color[channel] + variation[channel], 0, 255));
  }
  bytes[offset + 3] = 255;
}

function writeRoughness(bytes, offset, roughness) {
  bytes[offset] = 255;
  bytes[offset + 1] = Math.round(clamp(roughness, 0.35, 0.98) * 255);
  bytes[offset + 2] = 0;
  bytes[offset + 3] = 255;
}

function atlasMaps() {
  const albedo = new Uint8Array(SIZE * SIZE * 4);
  const roughness = new Uint8Array(albedo.length), normal = new Uint8Array(albedo.length);
  const innerWidth = SIZE - GUTTER * 2, innerHeight = HALF - GUTTER * 2;
  for (let region = 0; region < 2; region++) {
    const heights = new Float32Array(innerWidth * innerHeight);
    const skin = region === 0, seed = skin ? 203 : 307;
    for (let y = 0; y < innerHeight; y++) {
      const v = y / (innerHeight - 1);
      for (let x = 0; x < innerWidth; x++) {
        const u = x / (innerWidth - 1);
        const broad = noise(u, v, 5, 4, seed), fine = noise(u, v, 56, 36, seed + 1);
        const micro = noise(u, v, 96, 56, seed + 2);
        const offset = ((region * HALF + GUTTER + y) * SIZE + GUTTER + x) * 4;
        if (skin) {
          // Digit V follows the authored curl: the two flexion regions sit at
          // .48 and .75. Contact-side creases are slightly deeper than dorsal
          // folds; relief and dry-skin roughness supply most of their contrast.
          const dorsal = Math.exp(-((wrappedDistance(u, 0.25) / 0.16) ** 4));
          const contact = Math.exp(-((wrappedDistance(u, 0.75) / 0.20) ** 4));
          const curve = Math.sin((u - 0.25) * TAU) * 0.008;
          const crease = band(v, 0.48 + curve, 0.0055) + band(v, 0.75 + curve * 0.7, 0.005)
            + band(v, 0.463 + curve, 0.0038) * 0.32 + band(v, 0.767 + curve * 0.7, 0.0038) * 0.24;
          // A faint continuous fold also serves the thumb's rotated UV frame;
          // no nail or other directional anatomy is painted into this atlas.
          const folds = crease * (0.18 + contact * 0.82 + dorsal * 0.40);
          const knuckle = (band(v, 0.48, 0.055) + band(v, 0.75, 0.044) * 0.7) * dorsal;
          const contactPolish = contact * ramp(0.36, 0.44, v) * (1 - ramp(0.82, 0.93, v));
          const tone = (broad - 0.5) * 8 + (fine - 0.5) * 1.2 - folds * 1.2;
          const pore = Math.pow(Math.max(0, (micro - 0.52) / 0.48), 2);
          // Restrained blood-color variation avoids a single uniform tan, with
          // no baked light direction, knuckle highlights or dark painted pits.
          const warmth = (noise(u, v, 8, 5, seed + 3) - 0.5) * 5 + knuckle * 2.5;
          writeColor(albedo, offset, [184, 146, 125], [tone + warmth, tone + warmth * 0.10, tone - warmth * 0.25]);
          writeRoughness(roughness, offset, 0.625 + (fine - 0.5) * 0.045 + pore * 0.065
            + folds * 0.12 + knuckle * 0.025 - contactPolish * 0.025);
          heights[y * innerWidth + x] = (fine - 0.5) * 0.000017 - pore * 0.000020 - folds * 0.000070;
        } else {
          // A sewn leather back panel widens toward the knuckles. Palm UV .25
          // is dorsal; V .46..96 leaves the real wrist hem and digits clear.
          // The surrounding shell is matte woven cloth, not a shiny rubber mitt.
          const halfWidth = 0.093 + ramp(0.48, 0.90, v) * 0.055, cornerRadius = 0.018;
          const qx = Math.abs(u - 0.25) - halfWidth + cornerRadius;
          const qy = Math.abs(v - 0.715) - 0.245 + cornerRadius;
          const panelDistance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
            + Math.min(Math.max(qx, qy), 0) - cornerRadius;
          const panel = 1 - ramp(-0.004, 0.004, panelDistance);
          const seam = band(panelDistance, 0, 0.0055);
          const sewingAngle = Math.atan2((v - 0.715) / 0.245, (u - 0.25) / halfWidth);
          const stitch = band(panelDistance, -0.015, 0.0055) * Math.pow(Math.max(0, Math.cos(sewingAngle * 28)), 4);
          // Two short dashed hems serve the .22 finger and .30 thumb cutoffs.
          // They read as stitching, without a continuous bright plastic band.
          const hem = band(v, 0.200, 0.007) + band(v, 0.279, 0.007);
          const hemStitch = hem * Math.pow(Math.max(0, Math.cos(u * TAU * 28)), 4);
          const weave = Math.sin(u * TAU * 40) * Math.sin(v * TAU * 28);
          const grain = Math.pow(Math.max(0, fine - 0.20), 1.4);
          const wear = smooth(clamp((broad - 0.49) / 0.42, 0, 1));
          const tone = (broad - 0.5) * 3.5 + (micro - 0.5) * 1.2 + wear * panel * 2
            + panel * 13 - seam * 5 + stitch * 18 + hemStitch * 13 + weave * (1 - panel) * 0.7;
          writeColor(albedo, offset, [42, 48, 47], [tone + panel, tone, tone - panel * 2]);
          writeRoughness(roughness, offset, 0.91 - panel * 0.16 + (micro - 0.5) * 0.035
            - wear * panel * 0.035 + seam * 0.04 + stitch * 0.10 + hemStitch * 0.01);
          heights[y * innerWidth + x] = grain * (0.000024 + panel * 0.000045)
            + (micro - 0.5) * 0.000016 + weave * (1 - panel) * 0.000026
            + panel * 0.000080 - seam * 0.000120 + stitch * 0.000160 + hemStitch * 0.000110;
        }
      }
    }
    // Each region has its own periodic relief. Deriving one normal field from
    // the entire atlas would create a false raised edge at the material split.
    const regionNormal = normalsFromHeights(heights, innerWidth, innerHeight, skin ? 0.10 : 0.13, true);
    for (let y = 0; y < HALF; y++) {
      const sourceY = clamp(y - GUTTER, 0, innerHeight - 1);
      for (let x = 0; x < SIZE; x++) {
        const sourceX = clamp(x - GUTTER, 0, innerWidth - 1);
        const destination = ((region * HALF + y) * SIZE + x) * 4;
        const source = ((region * HALF + GUTTER + sourceY) * SIZE + GUTTER + sourceX) * 4;
        const normalSource = (sourceY * innerWidth + sourceX) * 4;
        for (let channel = 0; channel < 4; channel++) {
          albedo[destination + channel] = albedo[source + channel];
          roughness[destination + channel] = roughness[source + channel];
          normal[destination + channel] = regionNormal[normalSource + channel];
        }
        // normalsFromHeights expects image rows running down and flipY=true.
        // This atlas stores V ascending; reverse green for that UV convention.
        normal[destination + 1] = 255 - normal[destination + 1];
      }
    }
  }
  return {
    map: texture(albedo, SIZE, 'hands:skin-glove-albedo', true),
    normalMap: texture(normal, SIZE, 'hands:skin-glove-normal'),
    roughnessMap: texture(roughness, SIZE, 'hands:skin-glove-roughness'),
  };
}

function clothMaps() {
  const albedo = new Uint8Array(CLOTH_SIZE * CLOTH_SIZE * 4);
  const roughness = new Uint8Array(albedo.length), heights = new Float32Array(CLOTH_SIZE * CLOTH_SIZE);
  for (let y = 0; y < CLOTH_SIZE; y++) {
    const v = y / (CLOTH_SIZE - 1);
    for (let x = 0; x < CLOTH_SIZE; x++) {
      const u = x / (CLOTH_SIZE - 1), offset = (y * CLOTH_SIZE + x) * 4;
      const weave = Math.sin(u * TAU * 32) * Math.sin(v * TAU * 32);
      const twill = Math.cos((u + v) * TAU * 32);
      const broad = noise(u, v, 6, 6, 419), grain = noise(u, v, 48, 48, 421);
      const seam = band(v, 0.08, 0.009) + band(v, 0.92, 0.009);
      const stitch = seam * Math.pow(Math.max(0, Math.cos(u * TAU * 24)), 4);
      const innerStitch = (band(v, 0.11, 0.008) + band(v, 0.89, 0.008))
        * Math.pow(Math.max(0, Math.cos(u * TAU * 24 + Math.PI)), 4) * 0.60;
      const thread = stitch + innerStitch;
      const tone = (broad - 0.5) * 3.5 + weave * 1.2 + twill * 0.6 + thread * 17 - seam * 1.2;
      writeColor(albedo, offset, [37, 45, 43], [tone, tone, tone]);
      writeRoughness(roughness, offset, 0.93 + (grain - 0.5) * 0.025 + weave * 0.012 - thread * 0.025);
      heights[y * CLOTH_SIZE + x] = weave * 0.000035 + twill * 0.000015 + (grain - 0.5) * 0.000014
        + thread * 0.000180 - seam * 0.000018;
    }
  }
  const normal = normalsFromHeights(heights, CLOTH_SIZE, CLOTH_SIZE, 0.15, true);
  for (let i = 1; i < normal.length; i += 4) normal[i] = 255 - normal[i];
  return {
    map: texture(albedo, CLOTH_SIZE, 'hands:cloth-albedo', true, true),
    normalMap: texture(normal, CLOTH_SIZE, 'hands:cloth-normal', false, true),
    roughnessMap: texture(roughness, CLOTH_SIZE, 'hands:cloth-roughness', false, true),
  };
}

/**
 * Shared, bake-once resources: 960 KiB of base RGBA maps (1.25 MiB with mips).
 * Sleeve and cuff share their maps; no canvas, image decode, or frame updates.
 * The caller owns geometry, but should not dispose these shared materials/maps.
 */
export function getHandMaterials() {
  if (shared) return shared;
  const hand = new THREE.MeshStandardMaterial({
    ...atlasMaps(), color: 0xffffff, vertexColors: true, roughness: 1, metalness: 0,
    normalScale: new THREE.Vector2(0.65, 0.65), envMapIntensity: 0.32,
  });
  const sleeve = new THREE.MeshStandardMaterial({
    ...clothMaps(), color: 0xffffff, roughness: 1, metalness: 0,
    normalScale: new THREE.Vector2(0.65, 0.65), envMapIntensity: 0.18,
  });
  const cuff = sleeve.clone();
  cuff.color.setHex(0xe3e5df);
  cuff.normalScale.set(0.80, 0.80);
  hand.name = 'hands:skin-and-fingerless-glove';
  sleeve.name = 'hands:woven-sleeve';
  cuff.name = 'hands:woven-cuff';
  hand.userData.handFinish = { profile: 'skin-glove-atlas', textureSize: SIZE, atlas: HAND_ATLAS };
  sleeve.userData.handFinish = { profile: 'woven-sleeve', textureSize: CLOTH_SIZE };
  cuff.userData.handFinish = { profile: 'woven-cuff', textureSize: CLOTH_SIZE };
  shared = Object.freeze({ hand, sleeve, cuff });
  return shared;
}
