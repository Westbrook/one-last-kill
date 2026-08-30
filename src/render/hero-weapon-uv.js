import * as THREE from 'three';

const TAU = Math.PI * 2;
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

/**
 * Map fresh weapon-space geometry in metres. A triangle gets one projection,
 * never a different projection at each smoothly shaded corner. This keeps
 * chamfers and tapered tips from collapsing or spanning unrelated UV planes.
 * Indexed inputs return an owned nonindexed copy; callers own both buffers.
 * Tube inputs follow +X and unwrap the actual inner/outer circumference around
 * (y, z); the two annular crowns retain planar metric mapping.
 */
export function applyHeroWeaponUV(geometry, material, { kind = 'surface', y = 0, z = 0 } = {}) {
  const meters = material.userData.weaponFinish?.surfaceMeters;
  if (!(meters > 0) || !Number.isFinite(meters)) return geometry;
  const result = geometry.index ? geometry.toNonIndexed() : geometry;
  if (result !== geometry) result.userData = { ...geometry.userData };
  const position = result.attributes.position;
  let uv = result.attributes.uv;
  if (!uv) {
    uv = new THREE.Float32BufferAttribute(new Float32Array(position.count * 2), 2);
    result.setAttribute('uv', uv);
  }
  const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
  const uAxis = new THREE.Vector3(), vAxis = new THREE.Vector3();
  for (let start = 0; start < position.count; start += 3) {
    for (let corner = 0; corner < 3; corner++) points[corner].fromBufferAttribute(position, start + corner);
    ab.subVectors(points[1], points[0]); ac.subVectors(points[2], points[0]); normal.crossVectors(ab, ac);
    // Degenerate triangles cannot carry an area in either space. Keep finite
    // coordinates without pretending a useful texture frame exists there.
    if (normal.lengthSq() < 1e-24) {
      for (let corner = 0; corner < 3; corner++) uv.setXY(start + corner, 0, 0);
      continue;
    }
    normal.normalize();
    const transverse = Math.max(Math.abs(ab.x), Math.abs(ac.x)) < 1e-7;
    if (kind === 'tube' && !transverse) {
      const angles = points.map(point => Math.atan2(point.z - z, point.y - y));
      if (Math.max(...angles) - Math.min(...angles) > Math.PI) {
        for (let corner = 0; corner < 3; corner++) if (angles[corner] < 0) angles[corner] += TAU;
      }
      // The bore has its own smaller circumference. Deriving it from the
      // current side strip also covers collars without a guessed diameter.
      const radius = points.reduce((sum, point) => sum + Math.hypot(point.y - y, point.z - z) / 3, 0);
      for (let corner = 0; corner < 3; corner++) {
        uv.setXY(start + corner, points[corner].x / meters, angles[corner] * radius / meters);
      }
      continue;
    }
    const nx = Math.abs(normal.x), ny = Math.abs(normal.y), nz = Math.abs(normal.z);
    const dominantX = nx > ny && nx > nz, dominantY = !dominantX && ny > nz;
    const horizontal = dominantX ? Z : X, vertical = dominantY ? Z : Y;
    // An orthonormal frame measures sloping loft faces at their actual length,
    // while world-space dot products keep coplanar adjacent parts in phase.
    uAxis.copy(horizontal).addScaledVector(normal, -horizontal.dot(normal)).normalize();
    vAxis.crossVectors(normal, uAxis);
    if (vAxis.dot(vertical) < 0) vAxis.negate();
    for (let corner = 0; corner < 3; corner++) {
      uv.setXY(start + corner, points[corner].dot(uAxis) / meters, points[corner].dot(vAxis) / meters);
    }
  }
  uv.needsUpdate = true;
  result.userData.weaponSurfaceUV = true;
  return result;
}
