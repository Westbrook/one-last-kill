/** Keep masonry courses, floorboards and surface grain at an authored metre scale. */
export function applyBoxWorldUV(geometry, surfaceMeters, offset = { x: 0, y: 0, z: 0 }) {
  if (!Number.isFinite(surfaceMeters) || surfaceMeters <= 0) return geometry;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  if (!positions || !normals || !uv) return geometry;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i) + offset.x;
    const y = positions.getY(i) + offset.y;
    const z = positions.getZ(i) + offset.z;
    const nx = Math.abs(normals.getX(i)), ny = Math.abs(normals.getY(i)), nz = Math.abs(normals.getZ(i));
    if (nx >= ny && nx >= nz) uv.setXY(i, z / surfaceMeters, y / surfaceMeters);
    else if (ny >= nz) uv.setXY(i, x / surfaceMeters, z / surfaceMeters);
    else uv.setXY(i, x / surfaceMeters, y / surfaceMeters);
  }
  uv.needsUpdate = true;
  return geometry;
}
