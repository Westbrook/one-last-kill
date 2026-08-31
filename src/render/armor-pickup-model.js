import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// The upright carrier has separate front/back panels and an open neckline.
// All drops share these solid-color parts; only their Group animates.
let sharedParts;

function panel(points, depth, z, bevel = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(...points[0]);
  for (const point of points.slice(1)) shape.lineTo(...point);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth, steps: 1, curveSegments: 1,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1,
  }).translate(0, 0, z);
}

function box(width, height, depth, x, y, z) {
  return new THREE.BoxGeometry(width, height, depth).translate(x, y, z);
}

function merged(parts) {
  const flat = parts.map(geometry => geometry.index ? geometry.toNonIndexed() : geometry);
  for (const geometry of flat) geometry.deleteAttribute('uv');
  const geometry = mergeGeometries(flat, false);
  for (const part of new Set([...parts, ...flat])) part.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function getParts() {
  if (sharedParts) return sharedParts;
  const outline = [
    [-0.225, -0.30], [0.225, -0.30], [0.25, -0.245], [0.25, -0.075],
    [0.226, 0.025], [0.195, 0.07], [0.173, 0.17], [0.180, 0.30],
    [0.091, 0.30], [0.081, 0.21], [0.058, 0.157], [0, 0.13],
    [-0.058, 0.157], [-0.081, 0.21], [-0.091, 0.30], [-0.180, 0.30],
    [-0.173, 0.17], [-0.195, 0.07], [-0.226, 0.025], [-0.25, -0.075], [-0.25, -0.245],
  ];
  const plateOutline = [
    [-0.154, -0.13], [0.154, -0.13], [0.164, -0.10], [0.164, 0.055],
    [0.105, 0.118], [-0.105, 0.118], [-0.164, 0.055], [-0.164, -0.10],
  ];
  const fabric = [
    panel(outline, 0.040, 0.050, 0.003),
    panel(outline, 0.032, -0.104, 0.003),
    // The side fastening bands and shoulder bridges preserve a hollow carrier.
    ...[-1, 1].flatMap(side => [
      box(0.028, 0.100, 0.160, side * 0.230, -0.175, -0.003),
      box(0.078, 0.022, 0.165, side * 0.133, 0.281, -0.005),
      box(0.142, 0.021, 0.014, side * 0.098, -0.171, 0.150),
    ]),
    box(0.292, 0.018, 0.014, 0, 0.026, 0.123),
    box(0.292, 0.018, 0.014, 0, -0.070, 0.123),
  ];
  const plates = [
    panel(plateOutline, 0.020, 0.095, 0.005),
    panel(plateOutline, 0.014, -0.123, 0.004),
    ...[-1, 1].flatMap(side => [
      box(0.132, 0.104, 0.042, side * 0.098, -0.220, 0.117),
      box(0.056, 0.038, 0.015, side * 0.133, 0.233, 0.098),
    ]),
  ];
  const identity = [
    box(0.105, 0.025, 0.004, 0, 0.086, 0.123),
    box(0.105, 0.025, 0.004, 0, 0.086, -0.130),
    ...[-1, 1].map(side => box(0.031, 0.008, 0.004, side * 0.133, 0.233, 0.108)),
  ];
  const bulletMarks = [
    [-0.063, -0.015, 0.014], [0.058, -0.100, 0.012], [0.103, 0.060, 0.010],
  ].flatMap(([x, y, radius]) => [
    new THREE.CircleGeometry(radius, 7).translate(x, y, 0.121),
    box(radius * 0.35, radius * 2.8, 0.001, 0, 0, 0).rotateZ(0.6).translate(x, y, 0.121),
  ]);
  sharedParts = [
    ['armor-vest-fabric', merged(fabric), new THREE.MeshStandardMaterial({ name: 'armor-vest-fabric', color: 0x26343e, roughness: 0.94 })],
    ['armor-vest-plates', merged(plates), new THREE.MeshStandardMaterial({ name: 'armor-vest-plates', color: 0x475c69, roughness: 0.80 })],
    ['armor-vest-identity', merged(identity), new THREE.MeshStandardMaterial({ name: 'armor-vest-identity', color: 0x6cd8ef, emissive: 0x176478, emissiveIntensity: 0.65, roughness: 0.55 })],
    ['armor-vest-bullet-marks', merged(bulletMarks), new THREE.MeshStandardMaterial({ name: 'armor-vest-bullet-marks', color: 0x0b1218, roughness: 1 })],
  ];
  return sharedParts;
}

/** Presentation only; the caller owns armor strength, pickup state and transforms. */
export function createArmorPickupModel({ damaged = false } = {}) {
  const root = new THREE.Group();
  root.name = 'armor-pickup';
  for (const [index, [name, geometry, material]] of getParts().entries()) {
    if (index === 3 && !damaged) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    root.add(mesh);
  }
  return root;
}
