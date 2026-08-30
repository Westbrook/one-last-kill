import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const colorMaterials = new WeakMap();

function tintedMaterial(material) {
  if (material.vertexColors) return material;
  let tinted = colorMaterials.get(material);
  if (!tinted) {
    tinted = material.clone();
    tinted.vertexColors = true;
    colorMaterials.set(material, tinted);
  }
  return tinted;
}

// Project onto an orthonormal frame in each box face. Axis-aligned faces use
// the same world axes as applyBoxWorldUV; rotated props still retain a metre
// of texture per metre of surface instead of shrinking by the projected angle.
function applyMetricUV(geometry, meters) {
  const { position, normal, uv } = geometry.attributes;
  const point = new THREE.Vector3(), n = new THREE.Vector3();
  const u = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    n.fromBufferAttribute(normal, i).normalize();
    const nx = Math.abs(n.x), ny = Math.abs(n.y), nz = Math.abs(n.z);
    if (nx >= ny && nx >= nz) { u.set(0, 0, 1); v.set(0, 1, 0); }
    else if (ny >= nz) { u.set(1, 0, 0); v.set(0, 0, 1); }
    else { u.set(1, 0, 0); v.set(0, 1, 0); }
    u.addScaledVector(n, -u.dot(n)).normalize();
    v.addScaledVector(n, -v.dot(n)).addScaledVector(u, -v.dot(u)).normalize();
    point.fromBufferAttribute(position, i);
    uv.setXY(i, point.dot(u) / meters, point.dot(v) / meters);
  }
  return geometry;
}

/**
 * Bake differently sized static surface boxes into one ordinary mesh. Stock
 * instanced UVs cannot express a separate physical scale for each box face.
 * This spends bounded vertex storage at build time, retaining one draw call,
 * the same triangles/culling extent, and the original shared texture maps.
 * Untextured shapes, cloth and printed planes retain their existing instancing.
 */
export function createStaticSurfaceBatch(source, material, entries) {
  const meters = material.userData?.surfaceMeters;
  if (source.type !== 'BoxGeometry' || !Number.isFinite(meters) || meters <= 0 || !entries.length) return null;
  const colored = entries.some(entry => entry.tint !== null && entry.tint !== undefined);
  const transform = new THREE.Object3D(), color = new THREE.Color();
  const transforms = new Float32Array(entries.length * 16);
  const geometries = [];
  for (const [index, entry] of entries.entries()) {
    transform.position.set(entry.x, entry.y, entry.z);
    transform.rotation.set(entry.rx, entry.ry, entry.rz);
    transform.scale.set(entry.sx, entry.sy, entry.sz);
    transform.updateMatrix();
    transform.matrix.toArray(transforms, index * 16);
    const geometry = source.clone().applyMatrix4(transform.matrix);
    applyMetricUV(geometry, meters);
    if (colored) {
      color.set(entry.tint ?? 0xffffff);
      const colors = new Float32Array(geometry.attributes.position.count * 3);
      for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    geometries.push(geometry);
  }
  const geometry = mergeGeometries(geometries, false);
  for (const part of geometries) part.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, colored ? tintedMaterial(material) : material);
  // Retain authored transforms for diagnostics without retaining helper meshes.
  mesh.userData.surfaceBatch = {
    count: entries.length, transforms,
    verticesPerEntry: source.attributes.position.count,
    indicesPerEntry: source.index?.count ?? source.attributes.position.count,
  };
  return mesh;
}
