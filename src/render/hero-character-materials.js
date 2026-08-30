import * as THREE from 'three';
import { normalsFromHeights } from './surface-detail.js';
import { heroFaceMaterial } from './hero-face-albedo.js';

const cache = new Map();
let detail = null;
const SIZE = 256, TAU = Math.PI * 2;

function texture(bytes, color = false) {
  const map = new THREE.DataTexture(bytes, SIZE, SIZE, THREE.RGBAFormat);
  map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.flipY = true; map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter; map.anisotropy = 4; map.needsUpdate = true;
  return map;
}

function details() {
  if (detail) return detail;
  const clothColor = new Uint8Array(SIZE * SIZE * 4), clothFinish = new Uint8Array(clothColor.length);
  const skinColor = new Uint8Array(clothColor.length), skinFinish = new Uint8Array(clothColor.length);
  const clothHeight = new Float32Array(SIZE * SIZE), skinHeight = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = y * SIZE + x, offset = i * 4, u = x / SIZE, v = y / SIZE;
    const weave = Math.sin(u * TAU * 64) * Math.sin(v * TAU * 64);
    const grain = Math.sin(u * TAU * 41 + Math.sin(v * TAU * 23)) * Math.sin(v * TAU * 57 + Math.sin(u * TAU * 19));
    const crease = Math.pow(Math.max(0, Math.cos(v * TAU * 3 + Math.sin(u * TAU * 2) * 0.7)), 18);
    const cloth = Math.round(236 + weave * 5 - crease * 9 + grain * 3);
    clothColor.set([cloth, cloth, cloth, 255], offset);
    clothFinish.set([255, Math.round(226 + weave * 6 + crease * 9), 0, 255], offset);
    clothHeight[i] = weave * 0.000075 - crease * 0.00026;
    const skin = Math.round(245 + grain * 4);
    skinColor.set([skin, skin - 2, skin - 3, 255], offset);
    skinFinish.set([255, Math.round(188 + grain * 14), 0, 255], offset);
    skinHeight[i] = grain * 0.00002;
  }
  detail = {
    cloth: { map: texture(clothColor, true), normalMap: texture(normalsFromHeights(clothHeight, SIZE, SIZE, 0.55)), roughnessMap: texture(clothFinish) },
    skin: { map: texture(skinColor, true), normalMap: texture(normalsFromHeights(skinHeight, SIZE, SIZE, 0.18)), roughnessMap: texture(skinFinish) },
  };
  return detail;
}

/** Original authored microdetail, with palette carried by static vertex colours. */
export function heroCharacterMaterials(config) {
  const role = config.role || config.kind || 'adult';
  const projectedFace = !['child', 'woman'].includes(role);
  const key = [config.skin || '#bd957e', config.hair || '#201b16', projectedFace].join('|');
  if (cache.has(key)) return cache.get(key);
  const maps = details();
  const garments = new THREE.MeshStandardMaterial({ ...maps.cloth, vertexColors: true, roughness: 1, metalness: 0,
    normalScale: new THREE.Vector2(0.45, 0.45), envMapIntensity: 0.25 });
  garments.name = 'hero-woven-garments';
  const skin = new THREE.MeshStandardMaterial({ ...maps.skin, color: config.skin || '#bd957e', vertexColors: true, roughness: 1,
    normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 0.25 });
  skin.name = 'hero-skin';
  const detailsMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0, envMapIntensity: 0.3 });
  detailsMaterial.name = 'hero-face-hair-details';
  const result = { garments, skin, face: projectedFace ? heroFaceMaterial(skin) : skin, details: detailsMaterial };
  cache.set(key, result); return result;
}
