import * as THREE from 'three';

function valid(...values) {
  if (!values.every(value => Number.isFinite(value) && value > 0.5)) {
    throw new RangeError('Sedan panel dimensions must be finite and greater than 0.5 m');
  }
}

// Small closed convex profiles, built once and consumed by consolidateCar.
// Face winding follows actual positions after shaping; smooth normals give
// rolled metal a continuous highlight without any extra surface/material pass.
function closedLoft(rings, kind) {
  const positions = rings.flat(2), uv = [], indices = [], count = rings[0].length;
  const center = new THREE.Vector3();
  for (const ring of rings) for (const point of ring) center.add(new THREE.Vector3(...point));
  center.multiplyScalar(1 / (rings.length * count));
  for (let ring = 0; ring < rings.length; ring++) for (let point = 0; point < count; point++) uv.push(ring / (rings.length - 1), point / count);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3(), outward = new THREE.Vector3();
  function triangle(i, j, k) {
    a.fromArray(positions, i * 3); b.fromArray(positions, j * 3); c.fromArray(positions, k * 3);
    outward.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(center);
    normal.copy(b).sub(a).cross(c.clone().sub(a));
    if (normal.dot(outward) < 0) indices.push(i, k, j); else indices.push(i, j, k);
  }
  for (let ring = 0; ring < rings.length - 1; ring++) for (let point = 0; point < count; point++) {
    const i = ring * count + point, next = ring * count + (point + 1) % count;
    triangle(i, next, i + count); triangle(i + count, next, next + count);
  }
  for (const ring of [0, rings.length - 1]) {
    const center = rings[ring].reduce((sum, point) => sum.add(new THREE.Vector3(...point)), new THREE.Vector3()).multiplyScalar(1 / count);
    const cap = positions.length / 3; positions.push(...center.toArray()); uv.push(0.5, 0.5);
    for (let point = 0; point < count; point++) triangle(cap, ring * count + point, ring * count + (point + 1) % count);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices);
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.sedanPanel = kind;
  return geometry;
}

/** Chrome bumper within the original 20×18 cm section and exact overall width. */
export function createSedanBumper(width) {
  valid(width);
  const cross = [[-0.10, -0.045], [-0.055, -0.09], [0.055, -0.09], [0.10, -0.045],
    [0.10, 0.045], [0.055, 0.09], [-0.055, 0.09], [-0.10, 0.045]];
  const sections = [[-width / 2, 0.55], [-width / 2 + 0.065, 1], [width / 2 - 0.065, 1], [width / 2, 0.55]];
  return closedLoft(sections.map(([z, scale]) => cross.map(([x, y]) => [x * scale, y * scale, z])), 'bumper');
}

/**
 * Keep the center support bands at the former hood height; only the exposed
 * nose/trunk ends roll down. The complete panel retains its original bounds.
 */
export function createSedanHood(length, width) {
  valid(length, width);
  const hx = length * 0.475, hz = width * 0.475, bottom = -0.05, bevel = 0.015;
  const sections = [[-hx, 0.015, hz - 0.025], [-hx + 0.035, 0.027, hz],
    [-length * 0.34, 0.05, hz], [-length * 0.30, 0.05, hz],
    [length * 0.38 + 0.09, 0.05, hz], [hx - 0.04, 0.018, hz], [hx, 0.010, hz - 0.025]];
  const rings = sections.map(([x, top, halfWidth]) => [
    [x, top, -halfWidth + bevel], [x, top, halfWidth - bevel],
    [x, top - bevel, halfWidth], [x, bottom + bevel, halfWidth],
    [x, bottom, halfWidth - bevel], [x, bottom, -halfWidth + bevel],
    [x, bottom + bevel, -halfWidth], [x, top - bevel, -halfWidth],
  ]);
  return closedLoft(rings, 'hood');
}
