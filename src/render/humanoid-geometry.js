import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;

// Width and depth are diameters. Profiles describe one connected surface,
// keeping silhouettes smooth without adding a draw call for every detail.
function profileGeometry(rings, segments = 14) {
  const positions = [], uvs = [], indices = [];
  const minY = rings[0][0], maxY = rings[rings.length - 1][0];
  for (const [y, width, depth, offsetZ = 0] of rings) {
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * TAU - Math.PI;
      positions.push(Math.sin(angle) * width * 0.5, y, Math.cos(angle) * depth * 0.5 + offsetZ);
      // The existing face texture has its eyes at U~.45/.55, V~.55.
      uvs.push(i / segments, (y - minY) / (maxY - minY));
    }
  }
  for (let row = 0; row < rings.length - 1; row++) {
    for (let i = 0; i < segments; i++) {
      const a = row * (segments + 1) + i, b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  for (const [row, top] of [[0, false], [rings.length - 1, true]]) {
    const center = positions.length / 3;
    positions.push(0, rings[row][0], rings[row][3] || 0);
    uvs.push(0.1, top ? 1 : 0);
    for (let i = 0; i < segments; i++) {
      const edge = row * (segments + 1) + i;
      if (top) indices.push(center, edge, edge + 1);
      else indices.push(center, edge + 1, edge);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return finish(geometry);
}

function finish(geometry) {
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function mergeRigGeometry(parts) {
  const compatible = parts.map(part => part.index ? part.toNonIndexed() : part);
  const geometry = mergeGeometries(compatible, false);
  for (let i = 0; i < parts.length; i++) if (compatible[i] !== parts[i]) compatible[i].dispose();
  for (const part of parts) part.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function skinUV(geometry) {
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.12, 0.5);
  return geometry;
}

const HEAD_RINGS = [
  [0, 0.40, 0.43, 0.075], [0.065, 0.64, 0.61, 0.062],
  [0.15, 0.82, 0.76, 0.035], [0.235, 0.86, 0.78, 0.033],
  [0.32, 0.91, 0.84, 0.014], [0.425, 1, 0.94, 0.003],
  [0.49, 0.97, 0.98, -0.006], [0.555, 0.965, 1, -0.015],
  [0.61, 0.975, 1.015, -0.02], [0.745, 0.96, 1.01, -0.022],
  [0.85, 0.855, 0.94, -0.022], [0.94, 0.615, 0.73, -0.02],
  [0.984, 0.295, 0.37, -0.018], [1, 0.02, 0.026, -0.018],
];
const gaussian = (distance, width) => Math.exp(-((distance / width) ** 2));

function headGeometry() {
  const segments = 28;
  const head = profileGeometry(HEAD_RINGS, segments);
  const positions = head.getAttribute('position');
  for (let row = 0; row < HEAD_RINGS.length; row++) {
    const [y, , depth, offsetZ = 0] = HEAD_RINGS[row];
    for (let i = 0; i <= segments; i++) {
      const index = row * (segments + 1) + i;
      const front = Math.cos(i / segments * TAU - Math.PI);
      if (front <= 0) continue;
      const x = Math.abs(positions.getX(index));
      // Flatter facial planes, recessed eye sockets, raised cheekbones and a
      // brow ridge catch light even when the small texture is far away.
      const paired = gaussian(x - 0.175, 0.105);
      const socket = -0.071 * paired * gaussian(y - 0.555, 0.045);
      const brow = 0.037 * paired * gaussian(y - 0.615, 0.027);
      const cheek = 0.028 * gaussian(x - 0.285, 0.15) * gaussian(y - 0.425, 0.075);
      const lip = 0.023 * gaussian(x, 0.15) * gaussian(y - 0.235, 0.04);
      positions.setZ(index, offsetZ + depth * 0.5 * Math.pow(front, 0.75)
        + (socket + brow + cheek + lip) * front);
    }
  }
  finish(head);

  const ears = [];
  for (const sign of [-1, 1]) {
    const ear = profileGeometry([
      [0.295, 0.035, 0.055, 0.005], [0.35, 0.105, 0.11],
      [0.455, 0.14, 0.095, -0.017], [0.565, 0.115, 0.13, -0.018],
      [0.62, 0.032, 0.045, -0.015],
    ], 8);
    ear.translate(sign * 0.51, 0, 0);
    ears.push(skinUV(ear));
  }
  const nose = skinUV(profileGeometry([
    [0.305, 0.10, 0.085, 0.503], [0.345, 0.175, 0.18, 0.538],
    [0.39, 0.13, 0.235, 0.538], [0.51, 0.073, 0.12, 0.49],
    [0.61, 0.029, 0.028, 0.487],
  ], 8));
  return mergeRigGeometry([head, ...ears, nose]);
}

function hairGeometry() {
  const segments = 28;
  const hair = profileGeometry([
    [0.72, 0.978, 1.026, -0.022], [0.79, 0.944, 0.994, -0.022],
    [0.85, 0.86, 0.946, -0.022], [0.94, 0.621, 0.736, -0.02],
    [0.984, 0.30, 0.376, -0.018], [1, 0.025, 0.03, -0.018],
  ], segments);
  const positions = hair.getAttribute('position');
  for (let i = 0; i <= segments; i++) {
    const angle = i / segments * TAU - Math.PI;
    const front = Math.cos(angle);
    // A hairline, temples and a lower back replace the horizontal helmet edge.
    const height = front > 0 ? 0.63 + 0.105 * front + 0.015 * Math.cos(angle * 3) : 0.63 + front * 0.15;
    positions.setY(i, height);
    if (front < 0) positions.setZ(i, positions.getZ(i) * 0.985);
  }
  return finish(hair);
}

function torsoGeometry() {
  const shirt = profileGeometry([
    [0, 0.695, 0.76], [0.045, 0.72, 0.785], [0.08, 0.69, 0.75],
    [0.25, 0.75, 0.815], [0.49, 0.88, 0.95], [0.72, 1, 1],
    [0.88, 0.99, 0.92], [1, 0.72, 0.675],
  ], 16);
  const collar = profileGeometry([
    [0.978, 0.302, 0.41], [1.012, 0.324, 0.434], [1.05, 0.289, 0.394],
  ], 16);
  return mergeRigGeometry([shirt, collar]);
}

function handGeometry() {
  const palm = profileGeometry([
    [-0.68, 0.735, 0.47, 0.055], [-0.52, 0.855, 0.575, 0.015],
    [-0.24, 0.81, 0.55], [-0.07, 0.605, 0.46], [0, 0.565, 0.40],
  ], 10);
  const parts = [palm];
  for (let i = 0; i < 4; i++) {
    const knuckle = new THREE.SphereGeometry(0.5, 8, 5);
    const stagger = i === 0 ? 0.025 : i === 3 ? 0.075 : 0;
    knuckle.scale(0.232, 0.35, 0.435).translate((i - 1.5) * 0.216, -0.70 + stagger, 0.155);
    parts.push(knuckle);
  }
  const thumb = profileGeometry([
    [-0.59, 0.18, 0.29], [-0.41, 0.255, 0.38], [-0.17, 0.27, 0.365], [0, 0.155, 0.29],
  ], 8);
  thumb.rotateZ(-0.5).translate(0.39, -0.08, 0.19);
  parts.push(thumb);
  return mergeRigGeometry(parts);
}

function bootGeometry() {
  const heel = new RoundedBoxGeometry(0.79, 0.87, 0.58, 2, 0.11);
  heel.translate(0, 0.5, -0.23);
  const toe = new RoundedBoxGeometry(0.98, 0.58, 0.88, 2, 0.16);
  toe.translate(0, 0.30, 0.15);
  const geometry = mergeRigGeometry([heel, toe]);
  geometry.translate(0, -geometry.boundingBox.min.y, 0);
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  geometry.scale(1 / size.x, 1 / size.y, 1 / size.z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// Geometry is allocated once, shared by every pool slot, and never edited by a pose.
export const HUMANOID_GEOMETRY = {
  unitBox: new RoundedBoxGeometry(1, 1, 1, 2, 0.12),
  unitCapsule: new THREE.CapsuleGeometry(0.5, 1, 4, 10),
  unitSphere: new THREE.SphereGeometry(0.5, 12, 8),
  smallSphere: new THREE.SphereGeometry(0.5, 8, 6),
  unitCyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
  hand: handGeometry(), boot: bootGeometry(),
  belt: profileGeometry([[0, 0.99, 0.96], [1, 1, 1]], 14),
  chin: new THREE.SphereGeometry(0.5, 8, 6),
  torso: torsoGeometry(),
  vest: profileGeometry([[0, 0.81, 0.89], [0.12, 0.85, 0.94], [0.6, 1, 1], [0.83, 0.99, 0.94], [1, 0.77, 0.79]], 16),
  pelvis: profileGeometry([[-0.5, 0.78, 0.79], [-0.3, 1, 1], [0.23, 0.98, 0.94], [0.5, 0.8, 0.78]], 14),
  upperArm: profileGeometry([[-1.04, 0.45, 0.48], [-0.99, 0.76, 0.77], [-0.92, 0.70, 0.71], [-0.54, 0.91, 0.90], [-0.18, 1, 1], [0.015, 0.88, 0.86], [0.075, 0.40, 0.39]], 12),
  forearm: profileGeometry([[-1.035, 0.51, 0.54], [-0.9, 0.61, 0.65], [-0.36, 0.88, 0.86], [-0.09, 1, 0.96], [0.035, 0.63, 0.65]], 12),
  thigh: profileGeometry([[-1.04, 0.49, 0.52], [-0.89, 0.7, 0.72], [-0.48, 0.87, 0.87], [-0.15, 1, 1], [0.05, 0.7, 0.73]], 12),
  shin: profileGeometry([[-1.04, 0.48, 0.5], [-0.87, 0.59, 0.64], [-0.45, 0.91, 1], [-0.09, 1, 0.9], [0.035, 0.64, 0.66]], 12),
  head: headGeometry(), hair: hairGeometry(),
};
