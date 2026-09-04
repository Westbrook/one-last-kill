import * as THREE from 'three';
import { applyBoxWorldUV } from './world-uv.js';
import { createAuthoredWorldDressingGeometry } from './authored-world-dressing.js';

const TOE_FRACTION = 0.12;
const SHOULDER_HEIGHT = 0.45;
const SHOULDER_DEPTH = 0.46;
const TOP_DEPTH = 0.32;

function profile(width, height, depth) {
  if (![width, height, depth].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Barrier dimensions must be positive and finite');
  }
  const halfHeight = height / 2, halfDepth = depth / 2;
  return [
    [-halfDepth, -halfHeight], [halfDepth, -halfHeight],
    [halfDepth, height * TOE_FRACTION - halfHeight],
    [halfDepth * SHOULDER_DEPTH, height * SHOULDER_HEIGHT - halfHeight],
    [halfDepth * TOP_DEPTH, halfHeight], [-halfDepth * TOP_DEPTH, halfHeight],
    [-halfDepth * SHOULDER_DEPTH, height * SHOULDER_HEIGHT - halfHeight],
    [-halfDepth, height * TOE_FRACTION - halfHeight],
  ].map(point => new THREE.Vector2(...point));
}

/** Closed extrusion with a broad grounded toe, lower shoulder and narrow crown. */
export function createConcreteBarrierGeometry(width, height, depth, meters = 2, offset) {
  const section = profile(width, height, depth), positions = [], normals = [], indices = [];
  const authored = createAuthoredWorldDressingGeometry('concrete-barrier', { dimensions: [width, height, depth], meters, offset });
  if (authored) {
    authored.userData.concreteBarrier = { width, height, depth };
    return authored;
  }
  for (let i = 0; i < section.length; i++) {
    const a = section[i], b = section[(i + 1) % section.length], base = positions.length / 3;
    const normal = new THREE.Vector3(0, a.x - b.x, b.y - a.y).normalize();
    for (const [x, point] of [[-width / 2, a], [width / 2, a], [width / 2, b], [-width / 2, b]]) {
      positions.push(x, point.y, point.x); normals.push(...normal.toArray());
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const caps = THREE.ShapeUtils.triangulateShape(section, []);
  for (const side of [-1, 1]) {
    const base = positions.length / 3;
    for (const point of section) { positions.push(side * width / 2, point.y, point.x); normals.push(side, 0, 0); }
    for (const triangle of caps) {
      const [a, b, c] = triangle.map(index => section[index]);
      const crossX = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y);
      const order = crossX * side > 0 ? triangle : [triangle[0], triangle[2], triangle[1]];
      indices.push(...order.map(index => base + index));
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.type = 'ConcreteBarrierGeometry';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2));
  geometry.setIndex(indices);
  applyBoxWorldUV(geometry, meters, offset);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.concreteBarrier = { width, height, depth };
  return geometry;
}

/** Front-face depth/slope at an existing reflector's height above the floor. */
export function concreteBarrierFace(height, depth, aboveFloor) {
  const halfDepth = depth / 2, shoulderY = height * SHOULDER_HEIGHT;
  if (aboveFloor <= height * TOE_FRACTION) return { z: -halfDepth, slope: 0 };
  if (aboveFloor <= shoulderY) {
    const slope = halfDepth * (1 - SHOULDER_DEPTH) / (height * (SHOULDER_HEIGHT - TOE_FRACTION));
    return { z: -halfDepth + (aboveFloor - height * TOE_FRACTION) * slope, slope };
  }
  const slope = halfDepth * (SHOULDER_DEPTH - TOP_DEPTH) / (height * (1 - SHOULDER_HEIGHT));
  return { z: -halfDepth * SHOULDER_DEPTH + (aboveFloor - shoulderY) * slope, slope };
}

/** Refine the owned cover mesh and reuse the two original paint reflectors. */
export function refineConcreteBarrier(mesh, { pushDecor, reflectorMaterial }) {
  if (mesh?.geometry?.userData.concreteBarrier) return mesh;
  if (mesh?.geometry?.type !== 'BoxGeometry' || !mesh.isMesh || typeof pushDecor !== 'function' || !reflectorMaterial?.isMaterial) {
    throw new TypeError('Concrete barrier requires an owned box, decoration callback and existing reflector material');
  }
  const { width, height, depth } = mesh.geometry.parameters;
  const original = mesh.geometry;
  mesh.geometry = createConcreteBarrierGeometry(width, height, depth, mesh.material.userData?.surfaceMeters ?? 2, mesh.position);
  // addBox owns this one source, and construction precedes the first upload.
  original.dispose();
  const aboveFloor = Math.min(0.63, height - 0.10), face = concreteBarrierFace(height, depth, aboveFloor);
  const normal = new THREE.Vector3(0, face.slope, -1).normalize();
  const reflector = new THREE.BoxGeometry(0.34, 0.14, 0.01);
  reflector.rotateX(Math.atan(face.slope));
  reflector.userData.concreteBarrierReflector = true;
  // Half a millimetre of embed prevents a gap while keeping the front plate
  // visible. Its long edges follow the actual sloped concrete face.
  for (const offset of [-0.9, 0.9]) pushDecor(reflector, reflectorMaterial,
    mesh.position.x + offset, mesh.position.y - height / 2 + aboveFloor + normal.y * 0.0045,
    mesh.position.z + face.z + normal.z * 0.0045, 1, 1, 1);
  reflector.dispose();
  mesh.userData.concreteBarrier = {
    addedTriangles: mesh.geometry.index.count / 3 - original.index.count / 3,
    addedDraws: 0, addedMaterials: 0, addedTextures: 0, addedLights: 0,
    reflectorHeight: aboveFloor, reflectorSlope: face.slope,
  };
  return mesh;
}
