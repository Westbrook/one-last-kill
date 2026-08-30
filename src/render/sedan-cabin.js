import * as THREE from 'three';

const BELT_Y = 0.85, GLASS_TOP_Y = 1.45, ROOF_TOP_Y = 1.505, CENTER_X = -0.1;

function finish(geometry, part) {
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.sedanCabin = part;
  return geometry;
}

function crownedRoof(length, width) {
  const hx = length * 0.215, hz = width * 0.385, radius = 0.018;
  const corners = [[hx - radius, hz - radius], [-hx + radius, hz - radius],
    [-hx + radius, -hz + radius], [hx - radius, -hz + radius]];
  const outline = [];
  for (let corner = 0; corner < 4; corner++) for (let step = 0; step <= 3; step++) {
    const angle = (corner + step / 3) * Math.PI / 2;
    outline.push([corners[corner][0] + Math.cos(angle) * radius,
      corners[corner][1] + Math.sin(angle) * radius]);
  }
  outline.reverse();
  const levels = [[GLASS_TOP_Y, 1, 1], [1.472, 1, 1], [1.492, 0.72, 0.70]];
  const positions = [], uv = [], indices = [], count = outline.length;
  for (const [y, sx, sz] of levels) for (const [x, z] of outline) {
    positions.push(CENTER_X + x * sx, y, z * sz);
    uv.push(x * sx / (hx * 2) + 0.5, z * sz / (hz * 2) + 0.5);
  }
  for (let level = 0; level < levels.length - 1; level++) for (let i = 0; i < count; i++) {
    const a = level * count + i, next = level * count + (i + 1) % count;
    indices.push(a, next, a + count, a + count, next, next + count);
  }
  const bottom = positions.length / 3;
  positions.push(CENTER_X, GLASS_TOP_Y, 0); uv.push(0.5, 0.5);
  const top = positions.length / 3;
  positions.push(CENTER_X, ROOF_TOP_Y, 0); uv.push(0.5, 0.5);
  const last = (levels.length - 1) * count;
  for (let i = 0; i < count; i++) {
    indices.push(bottom, (i + 1) % count, i);
    indices.push(top, last + i, last + (i + 1) % count);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices);
  return finish(geometry, 'roof');
}

/**
 * Scene-build geometry only. The vehicle merger owns and disposes these source
 * meshes; no cached object is mutated or retained after the local car batches.
 * The roof keeps its original footprint and maximum height. The closed glass
 * tapers inward enough for the fitted side frames to meet beneath that roof.
 */
export function createSedanCabin(length, width) {
  if (![length, width].every(value => Number.isFinite(value) && value > 0.5)) {
    throw new RangeError('Sedan cabin dimensions must be finite and greater than 0.5 m');
  }
  const height = GLASS_TOP_Y - BELT_Y, baseX = length * 0.275, topX = baseX * 0.78;
  const baseZ = width * 0.45, topZ = baseZ * 0.82;
  const glass = new THREE.BoxGeometry(baseX * 2, height, baseZ * 2);
  const positions = glass.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const high = positions.getY(i) > 0;
    positions.setXYZ(i, CENTER_X + positions.getX(i) * (high ? 0.78 : 1),
      high ? GLASS_TOP_Y : BELT_Y, positions.getZ(i) * (high ? 0.82 : 1));
  }
  finish(glass, 'glass');

  const pillars = [];
  for (const station of [1, -1, 0.1]) for (const side of [-1, 1]) {
    const geometry = new THREE.BoxGeometry(0.06, height, 0.032);
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const high = p.getY(i) > 0, edgeX = station * (high ? topX : baseX);
      // A/C frames end at the actual windshield corner; B frames stay centered.
      const inset = Math.abs(station) === 1 ? -station * 0.03 : 0;
      p.setXYZ(i, CENTER_X + edgeX + inset + p.getX(i), high ? GLASS_TOP_Y : BELT_Y,
        side * ((high ? topZ : baseZ) - 0.004) + p.getZ(i));
    }
    pillars.push(finish(geometry, { part: 'pillar', station, side }));
  }
  return { glass, roof: crownedRoof(length, width), pillars,
    specification: Object.freeze({ length, width, beltY: BELT_Y, glassTopY: GLASS_TOP_Y, roofTopY: ROOF_TOP_Y }) };
}
