import * as THREE from 'three';
import { normalsFromHeights } from './surface-detail.js';

/** Canonical meters: handle grip at the origin, barrel along +Z. */
export const BAT_DIMENSIONS = Object.freeze({
  length: 0.84, centerZ: 0.28, knobZ: -0.14, tipZ: 0.70,
  handleRadius: 0.013, gripRadius: 0.015, barrelRadius: 0.033, knobRadius: 0.024,
  gripMinZ: -0.108, gripMaxZ: 0.114,
  primaryGripZ: 0, supportGripZ: 0.085, npcSupportGripZ: -0.085, lowerGripZ: -0.050, upperGripZ: 0.042,
  strikeMinZ: 0.48, strikeMaxZ: 0.70, strikeCenterZ: 0.59,
});

// Radius/axis samples give the barrel a gradual taper and a rounded end.
// The knob is turned from the same wood, not a floating sphere or metal band.
const PROFILE = [
  [0, -0.140], [0.015, -0.139], [0.022, -0.135], [0.024, -0.130],
  [0.024, -0.125], [0.021, -0.120], [0.014, -0.114], [0.0128, -0.105],
  [0.0129, -0.055], [0.0131, 0], [0.0140, 0.12], [0.0158, 0.20],
  [0.0190, 0.29], [0.0235, 0.38], [0.0283, 0.47], [0.0316, 0.55],
  [0.0330, 0.62], [0.0330, 0.655], [0.0323, 0.678], [0.0300, 0.691],
  [0.0230, 0.698], [0, 0.700],
];
let shared = null;

function dataTexture(bytes, width, height, color = false) {
  const texture = new THREE.DataTexture(bytes, width, height, THREE.RGBAFormat);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = true; texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4; texture.needsUpdate = true;
  return texture;
}

function finishTextures(grip = false) {
  const width = 128, height = grip ? 256 : 512;
  const circumference = Math.PI * 2 * (grip ? BAT_DIMENSIONS.gripRadius : BAT_DIMENSIONS.barrelRadius);
  const base = grip ? [35, 39, 38] : [144, 122, 92];
  const albedo = new Uint8Array(width * height * 4), roughness = new Uint8Array(albedo.length);
  const heights = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const v = 1 - y / (height - 1);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1), angle = u * Math.PI * 2;
      const fiber = Math.pow((Math.sin(angle * 23 + Math.sin(v * 12) * 0.7) + 1) * 0.5, 10);
      const broad = Math.sin(angle * 4 + Math.sin(v * 5) * 0.55);
      const scuff = Math.pow(Math.max(0, Math.sin(angle * 7 + v * 31)), 14) * Math.max(0, v - 0.35);
      const phase = ((v * 9 - u) % 1 + 1) % 1;
      const wrapEdge = Math.max(0, 1 - Math.min(phase, 1 - phase) * 45);
      const value = grip ? -wrapEdge * 5 + broad * 1.2 : broad * 2.8 - fiber * 5 + scuff * 7;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) albedo[offset + channel] = Math.round(base[channel] + value);
      albedo[offset + 3] = 255;
      const matte = grip ? 0.95 : 0.73 + fiber * 0.06 + scuff * 0.08;
      roughness[offset] = 255; roughness[offset + 1] = Math.round(matte * 255);
      roughness[offset + 2] = 0; roughness[offset + 3] = 255;
      heights[y * width + x] = grip ? wrapEdge * 0.00018 : -fiber * 0.00006 + broad * 0.00002;
    }
  }
  return {
    map: dataTexture(albedo, width, height, true),
    normalMap: dataTexture(normalsFromHeights(heights, width, height, circumference), width, height),
    roughnessMap: dataTexture(roughness, width, height),
  };
}

function lathe(profile, segments = 24) {
  const geometry = new THREE.LatheGeometry(profile.map(([radius, z]) => new THREE.Vector2(radius, z)), segments);
  geometry.rotateX(Math.PI / 2);
  // LatheGeometry's default V follows sample count, which stretches grain
  // around closely spaced knob rings. Map V by physical length instead.
  const position = geometry.attributes.position, uv = geometry.attributes.uv;
  const low = profile[0][1], high = profile[profile.length - 1][1];
  for (let i = 0; i < position.count; i++) uv.setY(i, (position.getZ(i) - low) / (high - low));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

function resources() {
  if (shared) return shared;
  const wood = lathe(PROFILE);
  const grip = lathe([[0.0139, -0.110], [0.0147, -0.108], [0.0148, -0.102],
    [0.0149, 0.103], [0.0151, 0.111], [0.0148, 0.114]], 20);
  const woodMaterial = new THREE.MeshStandardMaterial({
    ...finishTextures(), roughness: 1, metalness: 0,
    normalScale: new THREE.Vector2(0.65, 0.7 * Math.PI * 2 * BAT_DIMENSIONS.barrelRadius / BAT_DIMENSIONS.length), envMapIntensity: 0.26,
  });
  woodMaterial.name = 'bat-aged-wood';
  const gripMaterial = new THREE.MeshStandardMaterial({
    ...finishTextures(true), roughness: 1, metalness: 0,
    normalScale: new THREE.Vector2(0.5, 0.5 * Math.PI * 2 * BAT_DIMENSIONS.gripRadius / 0.224), envMapIntensity: 0.12,
  });
  gripMaterial.name = 'bat-cloth-grip';
  shared = { wood, grip, woodMaterial, gripMaterial };
  return shared;
}

/** Independent transform nodes sharing immutable geometry/material/texture resources. */
export function createBatAsset({ castShadow = true } = {}) {
  const assets = resources(), bat = new THREE.Group();
  bat.name = 'weapon:bat';
  bat.userData.role = 'weapon'; bat.userData.weaponType = 'bat';
  bat.userData.dimensions = BAT_DIMENSIONS;
  const wood = new THREE.Mesh(assets.wood, assets.woodMaterial);
  const grip = new THREE.Mesh(assets.grip, assets.gripMaterial);
  wood.name = 'bat-wood'; grip.name = 'bat-grip';
  wood.castShadow = grip.castShadow = castShadow;
  wood.receiveShadow = grip.receiveShadow = castShadow;
  bat.add(wood, grip);
  const anchors = {};
  for (const [name, z] of Object.entries({
    grip: 0, supportHand: BAT_DIMENSIONS.supportGripZ, npcSupportHand: BAT_DIMENSIONS.npcSupportGripZ,
    lowerGrip: BAT_DIMENSIONS.lowerGripZ, upperGrip: BAT_DIMENSIONS.upperGripZ,
    tip: BAT_DIMENSIONS.tipZ, knob: BAT_DIMENSIONS.knobZ, strikeCenter: BAT_DIMENSIONS.strikeCenterZ,
  })) {
    const anchor = new THREE.Object3D(); anchor.name = `anchor:bat-${name}`; anchor.position.z = z;
    bat.add(anchor); anchors[name] = anchor;
  }
  bat.userData.anchors = anchors;
  return bat;
}
