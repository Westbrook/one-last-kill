import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getAuthoredSupplyGeometry } from './authored-supply-props.js';

let shared = null;

// The original one-metre television keeps its front and supporting footprint.
// Only the empty rear corners taper away: the tube remains an opaque solid.
function moldedShell() {
  const profiles = [
    [-0.25, 0.966, 0.556, 0, 0.035],
    [-0.225, 1.0, 0.59, 0, 0.04],
    [-0.12, 0.98, 0.574, 0, 0.045],
    [0.115, 0.82, 0.472, -0.018, 0.045],
    [0.24, 0.68, 0.39, -0.045, 0.04],
  ];
  const positions = [], uv = [], indices = [], segments = 3, row = 4 * (segments + 1);
  for (const [z, width, height, cy, radius] of profiles) {
    const corners = [[1, 1, 0], [-1, 1, Math.PI / 2], [-1, -1, Math.PI], [1, -1, Math.PI * 1.5]];
    for (const [sx, sy, start] of corners) for (let i = 0; i <= segments; i++) {
      const angle = start + i / segments * Math.PI / 2;
      const x = sx * (width / 2 - radius) + Math.cos(angle) * radius;
      const y = cy + sy * (height / 2 - radius) + Math.sin(angle) * radius;
      positions.push(x, y, z); uv.push(x + 0.5, y + 0.305);
    }
  }
  for (let ring = 0; ring < profiles.length - 1; ring++) for (let i = 0; i < row; i++) {
    const a = ring * row + i, b = ring * row + (i + 1) % row, c = a + row, d = b + row;
    indices.push(a, b, d, a, d, c);
  }
  // Duplicate cap vertices keep the shoulder's soft normals off the flat
  // front and rear panels, while both caps still close the same solid shell.
  for (const end of [0, profiles.length - 1]) {
    const base = positions.length / 3, [z, , , cy] = profiles[end];
    positions.push(0, cy, z); uv.push(0.5, cy + 0.305);
    for (let i = 0; i < row; i++) {
      const offset = (end * row + i) * 3;
      positions.push(...positions.slice(offset, offset + 3));
      uv.push(positions[offset] + 0.5, positions[offset + 1] + 0.305);
    }
    for (let i = 0; i < row; i++) {
      const a = base + 1 + i, b = base + 1 + (i + 1) % row;
      indices.push(...(end === 0 ? [base, b, a] : [base, a, b]));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

function material(name, color, roughness) {
  const result = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, envMapIntensity: 0.18 });
  result.name = name;
  result.userData.surfaceKind = 'solid';
  return result;
}

function getHousing() {
  if (shared) return shared;
  const casing = [moldedShell()], details = [];
  function box(parts, x, y, z, width, height, depth) {
    parts.push(new THREE.BoxGeometry(width, height, depth).translate(x, y, z));
  }
  function dial(parts, x, y, z, radius, depth) {
    parts.push(new THREE.CylinderGeometry(radius, radius, depth, 10).rotateX(Math.PI / 2).translate(x, y, z));
  }

  // Both low rails still meet the unchanged console top at bodyY - 0.305.
  for (const x of [-0.33, 0.33]) box(details, x, -0.285, 0, 0.10, 0.04, 0.34);

  // A slim inset bezel surrounds, but never covers, the existing opaque glass.
  for (const y of [-0.242, 0.242]) box(details, 0.05, y, -0.272, 0.834, 0.03, 0.044);
  for (const x of [-0.354, 0.454]) box(details, x, 0, -0.272, 0.025, 0.454, 0.044);
  for (const y of [-0.115, 0.085]) {
    dial(casing, -0.42, y, -0.257, 0.029, 0.016);
    dial(details, -0.42, y, -0.281, 0.025, 0.039);
    box(casing, -0.42, y + 0.010, -0.3015, 0.004, 0.016, 0.002);
  }

  // Recessed dark backs and raised ribs give the rear real vent depth without
  // an alpha map, open sightline, dense grille or a third material bucket.
  for (const x of [-0.145, 0.145]) {
    box(details, x, -0.025, 0.2415, 0.246, 0.196, 0.003);
    for (let row = 0; row < 6; row++) box(casing, x, -0.105 + row * 0.032, 0.246, 0.246, 0.012, 0.008);
  }
  box(details, 0, -0.175, 0.242, 0.21, 0.026, 0.004);
  for (const x of [-0.295, 0.295]) for (const y of [-0.20, 0.105]) {
    details.push(new THREE.CircleGeometry(0.007, 8).translate(x, y, 0.2405));
  }

  function merge(parts, name) {
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    geometry.name = name;
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return geometry;
  }
  shared = Object.freeze([
    { geometry: merge(casing, 'crt-molded-housing'), material: material('crt-molded-casing', 0x575e55, 0.80) },
    { geometry: merge(details, 'crt-recessed-details'), material: material('crt-recesses', 0x262b27, 0.91) },
  ]);
  return shared;
}

/** Preserve the old body's shadow caster; small details share one decor draw. */
export function addCrtHousing(pushDecor, { parent, x, y, z }) {
  const [casing, details] = getHousing();
  const body = new THREE.Mesh(getAuthoredSupplyGeometry('crt', 'crt-molded-housing') ?? casing.geometry, casing.material);
  body.name = 'neighbor-crt-housing'; body.position.set(x, y, z);
  body.castShadow = true; body.receiveShadow = true;
  parent.add(body);
  pushDecor(getAuthoredSupplyGeometry('crt', 'crt-recessed-details') ?? details.geometry, details.material, x, y, z, 1, 1, 1);
  return body;
}

export function crtHousingBudget() {
  const parts = getHousing().map(part => ({ ...part,
    geometry: getAuthoredSupplyGeometry('crt', part.geometry.name) ?? part.geometry }));
  return {
    draws: parts.length,
    triangles: parts.reduce((sum, { geometry }) => sum + geometry.index.count / 3, 0),
    geometryBytes: parts.reduce((sum, { geometry }) => sum + geometry.index.array.byteLength
      + Object.values(geometry.attributes).reduce((total, attribute) => total + attribute.array.byteLength, 0), 0),
    textureBytes: 0,
  };
}
