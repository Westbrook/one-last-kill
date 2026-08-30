// The shared wood atlas has sixteen board rows across V and grain along U.
// Two circumferential repeats make 32 staves on the authored 2.8 m tank.
export const WATER_TANK_STAVE_UV = Object.freeze({
  staves: 32, circumferentialRepeats: 2, grainUMin: 0.525, grainUMax: 0.559,
  addedVertices: 0, addedTriangles: 0, addedDraws: 0, addedTextureBytes: 0,
  addedGeometryBytes: 0, perFrameUpdates: 0,
});

/** Reorient only the existing cylinder-side UV pairs; caps keep their old UVs. */
export function applyWaterTankStaveUV(geometry) {
  const { normal, uv } = geometry?.attributes ?? {};
  if (geometry?.type !== 'CylinderGeometry' || !normal || !uv || normal.count !== uv.count) {
    throw new TypeError('Water-tank staves require cylinder normals and UVs');
  }
  if (geometry.userData.waterTankStaves) return geometry;
  const { grainUMin, grainUMax, circumferentialRepeats } = WATER_TANK_STAVE_UV;
  let sideVertices = 0;
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(normal.getY(i)) > 1e-6) continue;
    const around = uv.getX(i), height = uv.getY(i);
    // A narrow joint-free strip avoids splicing tank staves across their
    // height. It deliberately stretches the atlas's long grain; it does not
    // claim a measured grain scale. The 32 stave widths remain metric.
    uv.setXY(i, grainUMin + height * (grainUMax - grainUMin), around * circumferentialRepeats);
    sideVertices++;
  }
  uv.needsUpdate = true;
  geometry.userData.waterTankStaves = { ...WATER_TANK_STAVE_UV, sideVertices };
  return geometry;
}
