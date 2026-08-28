import * as THREE from 'three';

/** Build-time records for intentionally structural elements, not loose props. */
export const Architecture = {
  elements: new Map(),
  clear() { this.elements.clear(); },
  register(mesh, collider, bounds, specification) {
    const { id, kind = 'structure', supports = [], supportKind = 'bearing' } = specification;
    if (!id || this.elements.has(id)) throw new Error(`Invalid or duplicate architectural element: ${id}`);
    const record = {
      id, kind, mesh, collider: collider || null,
      bounds: bounds.clone(), supports: [...supports], supportKind,
    };
    mesh.name = id;
    mesh.userData.architectureId = id;
    this.elements.set(id, record);
    return record;
  },
};

export function boxBounds(cx, cy, cz, sx, sy, sz) {
  return new THREE.Box3(
    new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
    new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
  );
}

/** The local front of a sign is +Z, before applying this yaw. */
export function signYaw(normal) {
  const angles = { '+z': 0, '-z': Math.PI, '+x': Math.PI / 2, '-x': -Math.PI / 2 };
  if (!(normal in angles)) throw new Error(`Unsupported sign normal: ${normal}`);
  return angles[normal];
}
