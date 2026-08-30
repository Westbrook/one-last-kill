import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// A 24 cm molded case replaces the four intersecting pickup boxes. Geometry
// and the three finishes are shared by every supply; animation stays on the
// existing mission-owned Group and never touches vertices or materials.
let sharedParts;

function roundedRectangle(width, depth, radius, segments) {
  const points = [];
  for (const [cx, cz, start] of [
    [width / 2 - radius, -depth / 2 + radius, -Math.PI / 2],
    [width / 2 - radius, depth / 2 - radius, 0],
    [-width / 2 + radius, depth / 2 - radius, Math.PI / 2],
    [-width / 2 + radius, -depth / 2 + radius, Math.PI],
  ]) {
    for (let step = 0; step <= segments; step++) {
      const angle = start + step / segments * Math.PI / 2;
      points.push([cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius]);
    }
  }
  return points;
}

function profiledShell(layers, segments = 3) {
  const positions = [], indices = [], outlines = layers.map(layer => roundedRectangle(layer.width, layer.depth, layer.radius, segments));
  const count = outlines[0].length;
  for (const [level, layer] of layers.entries()) {
    for (const [x, z] of outlines[level]) positions.push(x, layer.y, z);
  }
  for (let level = 0; level < layers.length - 1; level++) {
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      const a = level * count + i, b = a + count;
      indices.push(a, b, level * count + next, b, b + next - i, level * count + next);
    }
  }
  // Separate cap vertices keep the broad lid flat while corner/bevel normals
  // blend around the silhouette. Caps share exact positions with the shell.
  for (const [level, top] of [[0, false], [layers.length - 1, true]]) {
    const center = positions.length / 3;
    positions.push(0, layers[level].y, 0);
    for (const [x, z] of outlines[level]) positions.push(x, layers[level].y, z);
    for (let i = 0; i < count; i++) {
      const a = center + 1 + i, b = center + 1 + (i + 1) % count;
      indices.push(center, top ? b : a, top ? a : b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function beveledShell(width, height, depth, bevel, radius, segments = 3) {
  return profiledShell([
    { y: -height / 2, width: width - bevel * 2, depth: depth - bevel * 2, radius: radius - bevel },
    { y: -height / 2 + bevel, width, depth, radius },
    { y: height / 2 - bevel, width, depth, radius },
    { y: height / 2, width: width - bevel * 2, depth: depth - bevel * 2, radius: radius - bevel },
  ], segments);
}

function carryHandle() {
  const outer = roundedRectangle(0.068, 0.023, 0.0045, 2);
  const inner = roundedRectangle(0.052, 0.012, 0.002, 2);
  const positions = [], indices = [], count = outer.length;
  for (const z of [-0.090, -0.086]) {
    for (const outline of [outer, inner]) for (const [x, y] of outline) positions.push(x, y + 0.018, z);
  }
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    const a = i, b = next, c = i + count, d = next + count;
    const e = a + count * 2, f = b + count * 2, g = c + count * 2, h = d + count * 2;
    indices.push(a, c, b, c, d, b, e, f, g, g, f, h); // Open front/back ring.
    indices.push(a, b, e, b, f, e, c, g, d, d, g, h); // Outer/inner walls.
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function crossShape(size, arm) {
  const r = size / 2, a = arm / 2;
  const points = [[-a, -r], [a, -r], [a, -a], [r, -a], [r, a], [a, a],
    [a, r], [-a, r], [-a, a], [-r, a], [-r, -a], [-a, -a]];
  const shape = new THREE.Shape();
  shape.moveTo(...points[0]);
  for (const point of points.slice(1)) shape.lineTo(...point);
  shape.closePath();
  return shape;
}

function merged(parts) {
  const flat = parts.map(geometry => geometry.index ? geometry.toNonIndexed() : geometry);
  // These solid-color parts have no texture samplers. Matching attributes also
  // lets planar identity marks and the extruded badge share a single draw.
  for (const geometry of flat) geometry.deleteAttribute('uv');
  const geometry = mergeGeometries(flat, false);
  for (const part of new Set([...parts, ...flat])) part.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function getParts() {
  if (sharedParts) return sharedParts;
  const shell = merged([
    beveledShell(0.240, 0.044, 0.174, 0.006, 0.020).translate(0, -0.018, 0),
    beveledShell(0.240, 0.032, 0.174, 0.005, 0.020).translate(0, 0.023, 0),
    beveledShell(0.188, 0.008, 0.126, 0.002, 0.009, 2).translate(0, 0.043, 0),
  ]);
  const trim = merged([
    profiledShell([
      { y: 0.002, width: 0.236, depth: 0.170, radius: 0.018 },
      { y: 0.010, width: 0.236, depth: 0.170, radius: 0.018 },
    ]),
    carryHandle(),
    ...[-0.080, 0.080].map(x => beveledShell(0.018, 0.019, 0.0054, 0.0007, 0.0015, 1).translate(x, 0.0085, 0.0873)),
  ]);
  const crosses = merged([
    new THREE.ExtrudeGeometry(crossShape(0.100, 0.028), { depth: 0.0045, steps: 1, bevelEnabled: false, curveSegments: 1 })
      .rotateX(-Math.PI / 2).translate(0, 0.0475, 0),
    new THREE.ShapeGeometry(crossShape(0.032, 0.009), 1).translate(0, -0.018, 0.0873),
    new THREE.ShapeGeometry(crossShape(0.032, 0.009), 1).rotateY(Math.PI).translate(0, -0.018, -0.0873),
  ]);
  sharedParts = [
    ['medical-case-shell', shell, new THREE.MeshStandardMaterial({ name: 'medical-case-shell', color: 0xe3e5dd, roughness: 0.68 })],
    ['medical-case-trim', trim, new THREE.MeshStandardMaterial({ name: 'medical-case-trim', color: 0x454e48, roughness: 0.76, metalness: 0.12 })],
    ['medical-case-crosses', crosses, new THREE.MeshStandardMaterial({ name: 'medical-case-crosses', color: 0xff3030, emissive: 0xb01010, emissiveIntensity: 0.9, roughness: 0.5 })],
  ];
  return sharedParts;
}

/** Presentation only; the mission owns supply identity, transforms and state. */
export function createHealthPickupModel() {
  const root = new THREE.Group();
  for (const [name, geometry, material] of getParts()) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    root.add(mesh);
  }
  return root;
}
