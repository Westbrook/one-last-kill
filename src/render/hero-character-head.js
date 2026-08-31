import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heroFaceProjection } from './hero-face-albedo.js';
import { authorHeroSurface, hasHeroSurfaceFinish } from './hero-surface-finish.js';

const cache = new Map(), TAU = Math.PI * 2;
const gauss = (x, width) => Math.exp(-((x / width) ** 2));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const RINGS = [[0, 0.32, 0.36, 0.08], [0.06, 0.50, 0.50, 0.080], [0.14, 0.66, 0.62, 0.060],
  [0.24, 0.75, 0.72, 0.038], [0.34, 0.84, 0.83, 0.006], [0.44, 0.96, 0.94, -0.014],
  [0.56, 0.95, 0.99, -0.025], [0.69, 0.98, 1.00, -0.023], [0.79, 0.93, 0.99, -0.025],
  [0.88, 0.81, 0.90, -0.030], [0.94, 0.62, 0.73, -0.028], [0.978, 0.35, 0.44, -0.025],
  [0.995, 0.13, 0.17, -0.025], [1, 0.003, 0.004, -0.025]];
const HEAD_ROWS = [0, 0.025, 0.06, 0.10, 0.14, 0.18, 0.22, 0.25, 0.28, 0.32, 0.35, 0.375,
  0.40, 0.43, 0.46, 0.49, 0.515, 0.54, 0.56, 0.58, 0.61, 0.64, 0.69, 0.74, 0.79, 0.84, 0.88, 0.92, 0.95, 0.978, 0.993, 1];
const frontAngles = Array.from({ length: 16 }, (_, i) => i / 30 * Math.PI);
frontAngles.splice(-1, 0, Math.PI / 2 - 0.052);
const positiveAngles = [...frontAngles, ...[0.055, 0.11, 0.24, 0.48, 0.74, 1.0, 1.28, Math.PI / 2].map(a => Math.PI / 2 + a)];
const HEAD_ANGLES = [...positiveAngles.slice(1).reverse().map(a => -a), ...positiveAngles];
const HAIRCUTS = {
  brawler: { front: 0.80, temple: 0.58, nape: 0.44, recession: 0.034, sideburn: 0.036, short: true },
  thug: { front: 0.745, temple: 0.61, nape: 0.42, recession: 0.015, sideburn: 0.026 },
  gunman: { front: 0.75, temple: 0.60, nape: 0.44, recession: 0.024, sideburn: 0.027, part: 0.20 },
  bruiser: { front: 0.775, temple: 0.60, nape: 0.45, recession: 0.042, sideburn: 0.029, short: true },
  hitman: { front: 0.73, temple: 0.60, nape: 0.44, recession: 0.018, sideburn: 0.030, part: 0.38 },
  enforcer: { front: 0.79, temple: 0.59, nape: 0.435, recession: 0.040, sideburn: 0.025, short: true },
};

function hairline(angle, role) {
  const front = Math.cos(angle);
  const cut = HAIRCUTS[role];
  if (cut) {
    // One continuous crew-cut perimeter: the old front/rear branches jumped
    // at the temple and produced a square dark flap in profile.
    const receded = gauss(Math.abs(angle) - 0.88, 0.28) * cut.recession;
    const sideburn = gauss(Math.abs(angle) - 1.48, 0.13) * cut.sideburn;
    return cut.temple + (front > 0 ? smooth(front) * (cut.front - cut.temple) : front * (cut.temple - cut.nape)) + receded - sideburn
      + Math.sin(angle * 3 + 0.4) * 0.006;
  }
  return front > 0 ? 0.68 + front * 0.065 + Math.sin(angle * 3 + 0.4) * 0.023 : 0.61 + front * 0.19;
}

function curvedProfile(index, t, channel) {
  const a = RINGS[index], b = RINGS[index + 1], span = b[0] - a[0];
  const slope = at => {
    if (at === 0) return (RINGS[1][channel] - RINGS[0][channel]) / (RINGS[1][0] - RINGS[0][0]);
    if (at === RINGS.length - 1) return (RINGS[at][channel] - RINGS[at - 1][channel]) / (RINGS[at][0] - RINGS[at - 1][0]);
    const before = (RINGS[at][channel] - RINGS[at - 1][channel]) / (RINGS[at][0] - RINGS[at - 1][0]);
    const after = (RINGS[at + 1][channel] - RINGS[at][channel]) / (RINGS[at + 1][0] - RINGS[at][0]);
    return before * after > 0 ? Math.sign(before) * Math.min(Math.abs(before), Math.abs(after)) : 0;
  };
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a[channel] + (t3 - 2 * t2 + t) * span * slope(index)
    + (-2 * t3 + 3 * t2) * b[channel] + (t3 - t2) * span * slope(index + 1);
}

function dimensions(y, role) {
  let i = 0; while (i < RINGS.length - 2 && y > RINGS[i + 1][0]) i++;
  const a = RINGS[i], b = RINGS[i + 1], t = clamp((y - a[0]) / (b[0] - a[0]), 0, 1);
  const jaw = ['bruiser', 'enforcer', 'brawler'].includes(role) ? 1.075 : role === 'hitman' ? 0.96 : 1;
  return [
    curvedProfile(i, t, 1) * (1 + (jaw - 1) * gauss(y - 0.20, 0.19)),
    curvedProfile(i, t, 2), curvedProfile(i, t, 3),
  ];
}

function relief(x, y, role) {
  const eye = gauss(Math.abs(x) - 0.175, 0.087);
  const heavy = ['bruiser', 'enforcer'].includes(role) ? 1.2 : 1;
  return -0.085 * eye * gauss(y - 0.555, 0.041)
    + 0.052 * heavy * eye * gauss(y - 0.615, 0.026)
    + 0.043 * gauss(Math.abs(x) - 0.285, 0.10) * gauss(y - 0.44, 0.065)
    - 0.024 * gauss(Math.abs(x) - 0.30, 0.11) * gauss(y - 0.31, 0.08)
    + 0.173 * gauss(x, 0.060) * gauss(y - 0.405, 0.059)
    + 0.080 * gauss(x, 0.033) * gauss(y - 0.515, 0.12)
    + 0.038 * gauss(Math.abs(x) - 0.067, 0.030) * gauss(y - 0.382, 0.032)
    - 0.035 * gauss(Math.abs(x) - 0.091, 0.029) * gauss(y - 0.426, 0.085)
    - 0.016 * gauss(x, 0.028) * gauss(y - 0.307, 0.034)
    + 0.035 * gauss(x, 0.127) * gauss(y - 0.252, 0.035)
    + 0.031 * gauss(x, 0.113) * gauss(y - 0.205, 0.025)
    - 0.026 * gauss(x, 0.13) * gauss(y - 0.155, 0.030)
    + 0.022 * gauss(x, 0.17) * gauss(y - 0.085, 0.045);
}

function frontZ(x, y, role) {
  const [width, depth, offset] = dimensions(y, role);
  const front = Math.sqrt(Math.max(0, 1 - (2 * x / width) ** 2));
  return offset + depth * 0.5 * front ** 0.65 + relief(x, y, role) * front;
}

function headPoint(angle, y, role) {
  const [width, depth, offset] = dimensions(y, role), front = Math.cos(angle);
  let x = Math.sin(angle) * width * 0.5, z = offset + front * depth * 0.5;
  if (front > 0) z = offset + depth * 0.5 * front ** 0.65 + relief(x, y, role) * front;
  // Ear cartilage grows continuously out of the side surface. A recessed
  // concha, helix ridge and lobe are sculpted into the same vertex rings.
  const sideAngle = Math.abs(angle) - Math.PI / 2;
  const earRadius = Math.hypot((sideAngle - 0.018) / 0.14, (y - 0.493 - sideAngle * 0.055) / 0.127);
  const helix = gauss(earRadius - 0.77, 0.18), concha = gauss(earRadius, 0.46);
  const antihelix = gauss(earRadius - 0.40, 0.15) * smooth((sideAngle + 0.09) / 0.13);
  const lobe = gauss(sideAngle + 0.01, 0.054) * gauss(y - 0.391, 0.029);
  x += Math.sign(x) * (0.010 * gauss(earRadius, 0.95) + 0.063 * helix + 0.018 * antihelix + 0.015 * lobe - 0.004 * concha);
  z += 0.006 * helix * Math.sin((y - 0.37) * 17);
  // A mandible has a posterior angle below the ear. Reusing the narrow chin
  // footprint around the whole lower ring made its profile a flat triangle.
  const lowerJaw = 1 - smooth(y / 0.30), jawSide = smooth((0.65 - front) / 0.60);
  x += Math.sin(angle) * 0.075 * gauss(Math.abs(angle) - 1.62, 0.65) * lowerJaw;
  z -= (0.070 * jawSide + 0.035 * Math.max(0, -front)) * lowerJaw;
  // The mandibular edge rises toward the ear and occiput. A horizontal bottom
  // ring made the old face look sliced off above a cylindrical neck.
  const side = clamp((0.70 - front) / 0.80, 0, 1), smoothSide = side * side * (3 - 2 * side);
  const lower = clamp(y / 0.42, 0, 1);
  const jawLift = (0.145 + Math.max(0, -front) * 0.025 - 0.045 * gauss(Math.abs(angle) - 1.75, 0.60)) * smoothSide;
  return [x, y + jawLift * (1 - lower * lower * (3 - 2 * lower)), z];
}

function skinPoint(angle, y, role) {
  const point = headPoint(angle, y, role), covered = smooth((y - hairline(angle, role)) / 0.065);
  // The scalp lies below the hair surface. A small inward offset preserves the
  // authored outer crown height without two coincident caps or visible slits.
  point[0] *= 1 - covered * 0.012;
  point[2] = -0.025 + (point[2] + 0.025) * (1 - covered * 0.012);
  point[1] -= covered * 0.006 * smooth((y - 0.72) / 0.18);
  return point;
}

function finish(positions, indices, colors = null, uv = null) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv || positions.flatMap((_, i) => i % 3 === 0 ? [positions[i] * 3, positions[i + 1] * 3] : []), 2));
  if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}

function complexion(x, y, front, role) {
  const facing = Math.max(0, front);
  const eye = gauss(Math.abs(x) - 0.175, 0.102), socket = eye * gauss(y - 0.567, 0.043);
  const lowerLid = eye * gauss(y - 0.507, 0.022), temple = gauss(Math.abs(x) - 0.35, 0.065) * gauss(y - 0.57, 0.13);
  const noseSide = gauss(Math.abs(x) - 0.082, 0.029) * gauss(y - 0.414, 0.079);
  const mouthCorner = gauss(Math.abs(x) - 0.119, 0.034) * gauss(y - 0.247, 0.04);
  const hollow = gauss(Math.abs(x) - 0.29, 0.105) * gauss(y - 0.30, 0.075);
  const authored = hasHeroSurfaceFinish(role);
  const shadow = (socket * 0.34 + lowerLid * 0.12 + temple * 0.12 + noseSide * 0.22 + mouthCorner * 0.20 + hollow * 0.14) * facing * (authored ? 0.65 : 1);
  const beard = role === 'hitman' ? 0.075 : authored ? 0.125 : 0.15;
  const side = clamp((front + 0.30) / 0.52, 0, 1);
  const stubble = gauss(y - 0.17, 0.18) * (0.5 + 0.5 * gauss(Math.abs(x) - 0.24, 0.20)) * beard * side;
  const warm = gauss(Math.abs(x) - 0.265, 0.13) * gauss(y - 0.43, 0.08) * 0.07 * facing;
  const sideTone = (1 - facing) * (0.025 + gauss(y - 0.57, 0.15) * 0.025);
  const earBowl = gauss(front + 0.018, 0.072) * gauss(y - 0.493, 0.047) * 0.16;
  return [1 - shadow - stubble - sideTone - earBowl * 0.55, 0.98 - shadow * 1.10 - stubble - warm - sideTone - earBowl,
    0.96 - shadow * 1.11 - stubble - warm * 0.7 - sideTone - earBowl * 0.9];
}

function skull(role) {
  const ys = HEAD_ROWS, angles = HEAD_ANGLES;
  // Extra samples sit at the front and rear helix, where the former sparse
  // side columns stretched the ear ridge into a triangular flap.
  const segments = angles.length - 1, positions = [], indices = [], uv = [], colors = [], projection = [];
  for (let row = 0; row < ys.length; row++) for (let i = 0; i <= segments; i++) {
    const point = skinPoint(angles[i], ys[row], role);
    positions.push(...point); uv.push(i / segments * 3, ys[row] * 3);
    colors.push(...complexion(point[0], point[1], Math.cos(angles[i]), role));
    projection.push(...heroFaceProjection(point[0], point[1], angles[i]));
    if (row && i < segments) {
      const n = row * (segments + 1) + i, p = n - segments - 1;
      indices.push(p, p + 1, n, p + 1, n + 1, n);
    }
  }
  const jawStart = indices.length / 3;
  for (const [row, point, top] of [[0, [0, 0.10, 0.055], false], [ys.length - 1, [0, 0.994, -0.025], true]]) {
    const center = positions.length / 3;
    positions.push(...point); uv.push(0.5, 0.5);
    colors.push(...complexion(point[0], point[1], top ? -1 : 0.3, role));
    projection.push(0.5, 0.5, 0, point[1]);
    for (let i = 0; i < segments; i++) {
      const edge = row * (segments + 1) + i;
      if (top) indices.push(center, edge, edge + 1);
      else indices.push(center, edge + 1, edge);
    }
  }
  const geometry = finish(positions, indices, colors, uv);
  if (hasHeroSurfaceFinish(role)) authorHeroSurface(geometry, (x, y, z) => {
    const front = smooth((z + 0.02) / 0.40), brow = gauss(y - 0.70, 0.14), nose = gauss(x, 0.10) * gauss(y - 0.45, 0.14);
    return [0.73 - front * (brow * 0.095 + nose * 0.09), 0.85];
  });
  const normal = geometry.attributes.normal, shared = new THREE.Vector3();
  for (let row = 0; row < ys.length; row++) {
    const start = row * (segments + 1), end = start + segments;
    shared.set(normal.getX(start) + normal.getX(end), normal.getY(start) + normal.getY(end), normal.getZ(start) + normal.getZ(end)).normalize();
    normal.setXYZ(start, shared.x, shared.y, shared.z); normal.setXYZ(end, shared.x, shared.y, shared.z);
  }
  geometry.setAttribute('heroFaceProjection', new THREE.Float32BufferAttribute(projection, 4));
  geometry.userData.surfaces = { jaw: { triangleStart: jawStart, triangleCount: segments },
    crown: { triangleStart: jawStart + segments, triangleCount: segments } };
  return geometry;
}

function hairSurface(role, hairColor, skin) {
  // Common angular columns and curvature-focused crown rings avoid the old
  // independently sampled cap cutting through the skull between vertices.
  const ys = [0.40, 0.49, 0.58, 0.69, 0.79, 0.88, 0.95, 0.978, 0.993, 1];
  const angles = HEAD_ANGLES, segments = angles.length - 1, source = [], triangles = [];
  for (let row = 0; row < ys.length; row++) for (let i = 0; i <= segments; i++) {
    const y = ys[row], angle = angles[i];
    source.push({ point: headPoint(angle, y, role), y, angle, distance: y - hairline(angle, role), key: source.length });
    if (row && i < segments) {
      const n = row * (segments + 1) + i, p = n - segments - 1;
      triangles.push([p, p + 1, n], [p + 1, n + 1, n]);
    }
  }
  const crown = source.length;
  source.push({ point: [0, 1, -0.025], y: 1, angle: 0, distance: 1, key: crown });
  for (let i = 0; i < segments; i++) triangles.push([crown, (ys.length - 1) * (segments + 1) + i, (ys.length - 1) * (segments + 1) + i + 1]);
  const intersections = new Map(), vertices = new Map(), positions = [], colors = [], indices = [];
  const crossing = (a, b) => {
    const key = `${Math.min(a.key, b.key)}:${Math.max(a.key, b.key)}`;
    if (!intersections.has(key)) {
      const t = a.distance / (a.distance - b.distance);
      intersections.set(key, { key, point: a.point.map((p, i) => p + (b.point[i] - p) * t),
        y: a.y + (b.y - a.y) * t, angle: a.angle + (b.angle - a.angle) * t, distance: 0 });
    }
    return intersections.get(key);
  };
  const vertex = value => {
    if (vertices.has(value.key)) return vertices.get(value.key);
    const index = positions.length / 3, { point, y, angle, distance } = value, cut = HAIRCUTS[role], shaved = !!cut?.short;
    const crop = cut ? gauss(y - 0.90, 0.075) * (0.004 + 0.007 * Math.sin(angle * 5 + y * 13 + 0.8) ** 2
      + (cut.part ? gauss(angle + cut.part, 0.5) * 0.012 : 0)) * smooth(distance / 0.06) : 0;
    const thickness = (shaved ? 0.011 : 0.022) * (0.8 + 0.2 * Math.sin(angle * 7 + y * 8) ** 2) + crop;
    positions.push(point[0] * (1 + thickness), point[1] + (1 - point[1]) * thickness * 0.4,
      -0.025 + (point[2] + 0.025) * (1 + thickness));
    const strand = cut ? 0.97 + 0.10 * Math.sin(angle * 11 + y * 9 + (cut.part || 0) * 4) ** 2 : 0.88 + 0.24 * Math.sin(angle * 17 + y * 6) ** 2;
    const fadeWidth = cut ? (shaved ? 0.045 : 0.026) + (1 - Math.max(0, Math.cos(angle))) * (shaved ? 0.11 : 0.067) : 0.025;
    const tint = hairColor.clone().multiplyScalar(strand).lerp(skin, (shaved ? 0.87 : cut ? 0.58 : 0.12) * (1 - smooth(distance / fadeWidth)));
    colors.push(tint.r, tint.g, tint.b); vertices.set(value.key, index); return index;
  };
  for (const triangle of triangles) {
    const polygon = [];
    for (let i = 0; i < 3; i++) {
      const a = source[triangle[i]], b = source[triangle[(i + 1) % 3]];
      if (a.distance >= 0) polygon.push(a);
      if ((a.distance >= 0) !== (b.distance >= 0)) polygon.push(crossing(a, b));
    }
    for (let i = 1; i < polygon.length - 1; i++) indices.push(vertex(polygon[0]), vertex(polygon[i]), vertex(polygon[i + 1]));
  }
  const geometry = finish(positions, indices, colors), normal = geometry.attributes.normal;
  if (hasHeroSurfaceFinish(role)) authorHeroSurface(geometry, () => [role === 'hitman' ? 0.86 : HAIRCUTS[role].short ? 0.93 : 0.90, 0]);
  const coincident = new Map();
  for (let i = 0; i < positions.length; i += 3) {
    const key = positions.slice(i, i + 3).map(value => Math.round(value * 1e6)).join(':');
    if (!coincident.has(key)) coincident.set(key, []);
    coincident.get(key).push(i / 3);
  }
  const shared = new THREE.Vector3();
  for (const indices of coincident.values()) if (indices.length > 1) {
    shared.set(0, 0, 0);
    for (const index of indices) shared.add(new THREE.Vector3().fromBufferAttribute(normal, index));
    shared.normalize();
    for (const index of indices) normal.setXYZ(index, shared.x, shared.y, shared.z);
  }
  return geometry;
}

function detailParts(config, role) {
  const skin = new THREE.Color(config.skin || '#bd957e'), hairColor = new THREE.Color(config.hair || '#201b16').lerp(new THREE.Color('#5f5b50'), 0.20);
  const parts = [], positions = [], colors = [], indices = [], eyes = [];
  const add = (x, y, z, color) => { const index = positions.length / 3; positions.push(x, y, z); colors.push(color.r, color.g, color.b); return index; };
  function disk(cx, cy, rx, ry, color, depth = 0.002, segments = 20, almond = false, surface = null, opening = null) {
    const triangleStart = indices.length / 3;
    const zAt = surface || ((x, y) => frontZ(x, y, role));
    const center = add(cx, cy, zAt(cx, cy) + depth, color);
    for (let i = 0; i <= segments; i++) {
      const a = i / segments * TAU, x = cx + Math.cos(a) * rx;
      let y = cy + Math.sin(a) * ry * (almond ? Math.sqrt(Math.max(opening ? 0 : 0.08, 1 - ((x - cx) / rx) ** 2)) : 1);
      if (opening) { const [low, high] = opening(x); y = clamp(y, low, high); }
      add(x, y, zAt(x, y) + depth, color);
      if (i) indices.push(center, center + i, center + i + 1);
    }
    return { triangleStart, triangleCount: indices.length / 3 - triangleStart };
  }
  const sclera = new THREE.Color('#a39e91'), iris = new THREE.Color('#3e463a'), pupil = new THREE.Color('#0b1211');
  for (const sign of [-1, 1]) {
    const x = sign * 0.175;
    const eyeSurface = (px, py) => frontZ(x, 0.554, role) + 0.043 - 0.035 * ((px - x) / 0.08) ** 2 - 0.010 * ((py - 0.554) / 0.032) ** 2;
    const openingRim = Array.from({ length: 15 }, (_, i) => {
      const u = -Math.cos(i / 14 * Math.PI), arch = 1 - u * u;
      return [x + 0.078 * u, 0.554 - 0.024 * arch, 0.554 + 0.0195 * arch];
    });
    const opening = px => {
      let i = 0; while (i < openingRim.length - 2 && px > openingRim[i + 1][0]) i++;
      const a = openingRim[i], b = openingRim[i + 1], t = clamp((px - a[0]) / (b[0] - a[0]), 0, 1);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    };
    const aspect = (config.kind === 'child' ? 0.118 / 0.16 : 0.109 / 0.135) * (role === 'hitman' ? 0.84 : 0.86);
    const eye = { center: [x, 0.554],
      sclera: disk(x, 0.554, 0.078, 0.024, sclera, 0.005, 28, true, eyeSurface, opening),
      iris: disk(x, 0.554, 0.030, 0.030 * aspect, iris, 0.009, 24, false, eyeSurface, opening),
      pupil: disk(x, 0.554, 0.017, 0.017 * aspect, pupil, 0.012, 20, false, eyeSurface, opening) };
    // The lid edges share the actual opening. The old lower lid arched upward
    // and left a tall white disk exposed beneath it. Iris and pupil geometry is
    // clipped before batching; the centered gaze does not move or add a draw.
    for (const upper of [true, false]) {
      const start = positions.length / 3, triangleStart = indices.length / 3;
      const tone = skin.clone().multiplyScalar(upper ? (hasHeroSurfaceFinish(role) ? 0.81 : 0.73) : 0.88);
      for (let i = 0; i <= 12; i++) {
        const u = i / 12, px = x + (u - 0.5) * 0.156, arc = Math.sin(u * Math.PI);
        const edge = opening(px)[upper ? 1 : 0], direction = upper ? 1 : -1;
        const inner = edge - direction * 0.0015 * (0.25 + 0.75 * arc);
        const outer = edge + direction * (upper ? 0.010 : 0.009) * (0.16 + 0.84 * arc);
        for (const [py, inside] of upper ? [[inner, true], [outer, false]] : [[outer, false], [inner, true]]) {
          add(px, py, inside ? Math.max(frontZ(px, py, role), eyeSurface(px, py)) + 0.014 : frontZ(px, py, role) + 0.005, tone);
        }
        if (i) { const n = start + i * 2; indices.push(n - 2, n, n - 1, n - 1, n, n + 1); }
      }
      eye[upper ? 'upperLid' : 'lowerLid'] = { triangleStart, triangleCount: indices.length / 3 - triangleStart };
    }
    eyes.push(eye);
    // Brows retain the existing placement relative to the projected albedo.
    {
      const start = positions.length / 3;
      for (let i = 0; i <= 12; i++) {
        const u = i / 12, px = x + (u - 0.5) * 0.164, py = 0.612 + Math.sin(u * Math.PI) * 0.016;
        const half = 0.012 * Math.sin(u * Math.PI);
        for (const dy of [-half, half]) add(px, py + dy, frontZ(px, py + dy, role) + 0.006, hairColor);
        if (i) { const n = start + i * 2; indices.push(n - 2, n, n - 1, n - 1, n, n + 1); }
      }
    }
    disk(sign * 0.058, 0.371, 0.025, 0.012, skin.clone().multiplyScalar(0.28), 0.007, 16);
  }
  const lip = skin.clone().lerp(new THREE.Color('#8d5650'), 0.50);
  disk(0, 0.254, 0.124, 0.017, lip.clone().multiplyScalar(0.77), 0.006, 28, true);
  disk(0, 0.224, 0.115, 0.017, lip, 0.006, 28, true);
  disk(0, 0.242, 0.125, 0.0038, skin.clone().multiplyScalar(0.25), 0.012, 28);
  const facialDetails = finish(positions, indices, colors);
  if (hasHeroSurfaceFinish(role)) authorHeroSurface(facialDetails, (x, y) => {
    const eye = gauss(Math.abs(x) - 0.175, 0.071) * gauss(y - 0.554, 0.018), lips = gauss(x, 0.10) * gauss(y - 0.24, 0.025);
    return [0.74 - eye * 0.28 - lips * 0.10, 0];
  });
  parts.push(facialDetails);

  parts.push(hairSurface(role, hairColor, skin));
  const hair = { triangleStart: parts[0].index.count / 3, triangleCount: parts[1].index.count / 3 };
  const nonIndexed = parts.map(part => part.toNonIndexed()), merged = mergeGeometries(nonIndexed, false);
  for (const part of [...parts, ...nonIndexed]) part.dispose();
  merged.userData.surfaces = { hair, eyes };
  merged.computeBoundingBox(); merged.computeBoundingSphere(); return merged;
}

/** Continuous sculpted skull/nose/ears plus actual eye, lid, lip and hair surfaces. */
export function heroHeadGeometry(config) {
  const role = config.role || config.kind || 'adult';
  const key = [role, config.skin, config.hair].join('|');
  if (!cache.has(key)) cache.set(key, { head: skull(role), details: detailParts(config, role),
    // Only the visual skull is narrowed. Combat dimensions, anchors and bone
    // lengths retain their established coordinate system.
    scale: Object.freeze({ x: role === 'hitman' ? 0.84 : 0.86, y: 1, z: 0.90 }) });
  return cache.get(key);
}
