import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { heroGarmentDetails } from './hero-garment-details.js';
import { authorHeroSurface, hasHeroSurfaceFinish } from './hero-surface-finish.js';

export const HERO_BIND_ARM_ANGLE = 0.45;
const cache = new Map(), TAU = Math.PI * 2;
const FIELD_MATERIAL = new THREE.MeshBasicMaterial();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const gauss = (x, w) => Math.exp(-((x / w) ** 2));
const blendDistance = (a, b, k) => { const t = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return b + (a - b) * t - k * t * (1 - t); };
const SHIRT = [[0.542, 0.092, 0.057], [0.558, 0.103, 0.064], [0.595, 0.102, 0.060],
  [0.65, 0.108, 0.063], [0.72, 0.124, 0.074], [0.775, 0.125, 0.073],
  [0.811, 0.102, 0.061], [0.843, 0.044, 0.035]];
const PELVIS = [[0.492, 0.054, 0.050], [0.515, 0.091, 0.063], [0.55, 0.104, 0.066], [0.583, 0.096, 0.059]];
const LEG = [[0.056, 0.029, 0.032], [0.075, 0.032, 0.034], [0.12, 0.032, 0.034],
  [0.19, 0.038, 0.039], [0.265, 0.037, 0.040], [0.295, 0.036, 0.038],
  [0.34, 0.042, 0.043], [0.43, 0.049, 0.054], [0.515, 0.054, 0.058], [0.558, 0.04, 0.046]];

function profile(rows, y, width = 1) {
  let index = 0;
  while (index < rows.length - 2 && y > rows[index + 1][0]) index++;
  const a = rows[index], b = rows[index + 1], t = clamp((y - a[0]) / (b[0] - a[0]), 0, 1);
  return [(a[1] + (b[1] - a[1]) * t) * width, (a[2] + (b[2] - a[2]) * t) * width];
}

function loftDistance(x, y, z, rows, width = 1, folds = 0) {
  const [rx, rz] = profile(rows, y, width);
  const angle = Math.atan2(x / rx, z / rz);
  const fold = folds * Math.sin(y * 112 + Math.sin(angle * 3) * 1.5) * (0.35 + 0.65 * Math.cos(angle * 2) ** 2);
  const radial = (Math.hypot(x / rx, z / rz) - 1) * Math.min(rx, rz) - fold;
  const cap = Math.max(rows[0][0] - y, y - rows.at(-1)[0]);
  return Math.hypot(Math.max(0, radial), Math.max(0, cap)) + Math.min(Math.max(radial, cap), 0);
}

function armSample(x, y, z, sign, d, shortSleeve = false) {
  const angle = HERO_BIND_ARM_ANGLE, ax = sign * Math.sin(angle), ay = -Math.cos(angle);
  const sx = sign * d.shoulderSpacing / d.height, sy = d.shoulderY / d.height;
  const dx = x - sx, dy = y - sy, along = dx * ax + dy * ay;
  const length = (d.upperArmLength + d.forearmLength) / d.height;
  const t = clamp(along / length, 0, 1), across = dx * Math.cos(angle) + dy * sign * Math.sin(angle);
  const radii = [[0, 0.030], [0.12, 0.040], [0.27, 0.039], [0.40, 0.034], [0.54, 0.031], [0.66, 0.034], [0.86, 0.026], [1, 0.022]];
  let k = 0; while (k < radii.length - 2 && t > radii[k + 1][0]) k++;
  const a = radii[k], b = radii[k + 1], f = (t - a[0]) / (b[0] - a[0]);
  const radius = (a[1] + (b[1] - a[1]) * f) * Math.sqrt(d.width);
  const fold = 0.0018 * Math.sin(t * 47 + Math.atan2(across, z) * 2) * (gauss(t - 0.53, 0.13) + gauss(t - 0.93, 0.06));
  const radial = Math.hypot(across, z / 1.04) - radius - fold;
  const cap = Math.max(-along - radius * 0.20, along - length * (shortSleeve ? 0.38 : 0.99));
  return { distance: Math.hypot(Math.max(0, radial), Math.max(0, cap)) + Math.min(Math.max(radial, cap), 0), t, across };
}

function distances(x, y, z, d, shortSleeve) {
  let torso = loftDistance(x, y, z, SHIRT, d.width);
  const hemGather = gauss(y - 0.570, 0.023) * (0.35 + 0.65 * gauss(Math.abs(x) - 0.063 * d.width, 0.047));
  torso -= 0.0011 * Math.sin(y * 170 + x * 61) * hemGather;
  if (y > 0.81) torso = Math.max(torso, -(Math.hypot(x / (0.036 * d.width), z / 0.032) - 1) * 0.032);
  const left = armSample(x, y, z, -1, d, shortSleeve), right = armSample(x, y, z, 1, d, shortSleeve);
  const shirt = blendDistance(blendDistance(torso, left.distance, 0.016), right.distance, 0.016);
  const legLeft = loftDistance(x + d.hipSpacing / d.height, y, z, LEG, Math.sqrt(d.width), 0.0017);
  const legRight = loftDistance(x - d.hipSpacing / d.height, y, z, LEG, Math.sqrt(d.width), 0.0017);
  const pelvis = loftDistance(x, y, z, PELVIS, d.width);
  const trousers = blendDistance(blendDistance(pelvis, legLeft, 0.016), legRight, 0.016);
  return { distance: blendDistance(shirt, trousers, 0.007), torso, left, right, pelvis, legLeft, legRight };
}

function bodyWeights(x, y, z, d, shortSleeve) {
  const sample = distances(x, y, z, d, shortSleeve);
  const weights = {};
  const add = (name, value) => { if (value > 0) weights[name] = (weights[name] || 0) + value; };
  if (y < 0.583 && Math.min(sample.pelvis, sample.legLeft, sample.legRight) <= Math.min(sample.torso, sample.left.distance, sample.right.distance)) {
    const side = x < 0 ? 'L' : 'R', leg = side === 'L' ? sample.legLeft : sample.legRight;
    const pelvis = smooth((leg - sample.pelvis + 0.022) / 0.044) * smooth((y - 0.47) / 0.055);
    add('hips', pelvis);
    const knee = d.kneeY / d.height, ankle = d.ankleY / d.height;
    const kneeWeight = 1 - smooth((y - knee + 0.045) / 0.09);
    const ankleWeight = 1 - smooth((y - ankle - 0.008) / 0.05);
    add(`hip${side}`, (1 - pelvis) * (1 - kneeWeight));
    add(`knee${side}`, (1 - pelvis) * kneeWeight * (1 - ankleWeight));
    add(`ankle${side}`, (1 - pelvis) * ankleWeight);
  } else {
    const side = x < 0 ? 'L' : 'R', arm = side === 'L' ? sample.left : sample.right;
    const armWeight = smooth((sample.torso - arm.distance + 0.022) / 0.044);
    const elbow = smooth((arm.t - 0.40) / 0.24);
    const wrist = smooth((arm.t - 0.90) / 0.10);
    add(`shoulder${side}`, armWeight * (1 - elbow));
    add(`elbow${side}`, armWeight * elbow * (1 - wrist));
    add(`wrist${side}`, armWeight * wrist);
    const chest = smooth((y - 0.61) / 0.15);
    add('spine', (1 - armWeight) * (1 - chest)); add('chest', (1 - armWeight) * chest);
  }
  return weights;
}

function attributes(geometry, boneIndex, weightFor, colorFor, preserveUV = false) {
  const p = geometry.attributes.position, weights = [], indices = [], colors = [], uv = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const entries = Object.entries(weightFor(x, y, z)).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    for (let k = 0; k < 4; k++) { indices.push(k < entries.length ? boneIndex[entries[k][0]] : 0); weights.push(k < entries.length ? entries[k][1] / total : 0); }
    const color = colorFor(x, y, z, i); colors.push(color.r, color.g, color.b);
    uv.push(x * 4, y * 4);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  if (!preserveUV || !geometry.attributes.uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}

function wornGarmentColor(x, y, z, d, palette, role) {
  const py = y / d.height, px = x / d.height, pz = z / d.height;
  const front = smooth((pz + 0.015) / 0.06), side = Math.abs(px) / d.width;
  // Construction and wear follow garment regions, never a painted light.
  const wear = role === 'hitman' ? 0.42 : role === 'gunman' ? 0.72 : 1;
  const mottling = Math.sin(px * 47 + py * 23) * Math.sin(py * 31 - pz * 37) * 0.023 * wear;
  if (py < 0.578 && Math.abs(x) < d.height * 0.18) {
    if (py > 0.563) return palette.belt;
    const knees = gauss(py - 0.285, 0.05) * front, seat = gauss(py - 0.50, 0.050) * (1 - front);
    const seam = gauss(side - 0.095, 0.006) * smooth((py - 0.13) / 0.35);
    return palette.pants.clone().multiplyScalar(1 + mottling + wear * (knees * 0.20 + seat * 0.12 - seam * 0.11));
  }
  if (z > 0 && Math.abs(x) < d.height * 0.005 && role !== 'brawler') return palette.trim;
  const shoulderWear = gauss(py - 0.78, 0.055) * smooth((side - 0.035) / 0.065);
  const hemWear = gauss(py - 0.589, 0.017), sideSeam = gauss(side - 0.106, 0.010) * gauss(py - 0.69, 0.085);
  return palette.shirt.clone().multiplyScalar(1.04 + mottling + wear * (shoulderWear * 0.18 + hemWear * 0.07 - sideSeam * 0.13));
}

function garmentFinish(role, trousers = false, belt = false) {
  if (belt) return [0.67, 0.10];
  if (trousers) return [role === 'hitman' ? 0.88 : 0.86, role === 'hitman' ? 0.8 : 1];
  if (role === 'thug') return [0.69, 0.12];
  if (role === 'hitman') return [0.84, 0.8];
  if (role === 'gunman') return [0.90, 1];
  return [role === 'brawler' ? 0.94 : 0.88, 1];
}

function exteriorSurface(geometry) {
  const index = geometry.index.array, parents = Array.from({ length: geometry.attributes.position.count }, (_, i) => i);
  const find = value => { while (parents[value] !== value) { parents[value] = parents[parents[value]]; value = parents[value]; } return value; };
  for (let i = 0; i < index.length; i += 3) {
    const root = find(index[i]); parents[find(index[i + 1])] = root; parents[find(index[i + 2])] = root;
  }
  const counts = new Map();
  for (let i = 0; i < parents.length; i++) { const root = find(i); counts.set(root, (counts.get(root) || 0) + 1); }
  const largest = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  // Subtracting a neckline can leave an enclosed extraction shell inside the
  // neck. Keep the single exterior, including both sleeves and trouser legs.
  if (counts.size > 1) {
    const kept = [];
    for (let i = 0; i < index.length; i += 3) if (find(index[i]) === largest) kept.push(index[i], index[i + 1], index[i + 2]);
    geometry.setIndex(kept);
    const flat = geometry.toNonIndexed(), welded = mergeVertices(flat, 1e-5);
    flat.dispose(); geometry.dispose(); return welded;
  }
  return geometry;
}

function tailorShortSleeveSurface(geometry, d, boneIndex) {
  const { position, skinIndex, skinWeight } = geometry.attributes;
  const h = d.height, armLength = d.upperArmLength + d.forearmLength, build = Math.sqrt(d.width);
  // Work in the neutral garment silhouette, then map the displacement back
  // through the existing bind blend. No joint, skin weight, UV, or triangle
  // changes, and no deformation work remains for the animation loop.
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i), sign = x < 0 ? -1 : 1;
    const side = sign < 0 ? 'L' : 'R', sx = sign * d.shoulderSpacing, sy = d.shoulderY;
    let armWeight = 0;
    for (let k = 0; k < 4; k++) {
      const bone = skinIndex.getComponent(i, k);
      if (bone === boneIndex[`shoulder${side}`] || bone === boneIndex[`elbow${side}`] || bone === boneIndex[`wrist${side}`]) armWeight += skinWeight.getComponent(i, k);
    }
    const angle = -sign * HERO_BIND_ARM_ANGLE, cosine = Math.cos(angle), sine = Math.sin(angle);
    const a = 1 + armWeight * (cosine - 1), b = armWeight * sine;
    const tx = armWeight * (sx - cosine * sx + sine * sy), ty = armWeight * (sy - sine * sx - cosine * sy);
    let px = a * x - b * y + tx, py = b * x + a * y + ty, pz = z;
    const across = Math.abs(px) / (h * d.width), height = py / h;
    const cap = smooth((across - 0.08) / 0.035) * (1 - smooth((across - 0.152) / 0.023)) * smooth((height - 0.775) / 0.055);
    const bridge = gauss(across - 0.081, 0.016) * smooth((across - 0.055) / 0.015) * smooth((height - 0.778) / 0.050);
    const along = (sy - py) / armLength;
    const taper = 0.08 * gauss(along - 0.15, 0.13) * (1 - smooth((along - 0.26) / 0.06)) * armWeight;
    px = sx + (px - sx) * (1 - taper); pz *= 1 - taper;
    py += h * build * (0.005 * bridge - 0.010 * cap);
    const dx = px - tx, dy = py - ty, determinant = a * a + b * b;
    position.setXYZ(i, (a * dx + b * dy) / determinant, (-b * dx + a * dy) / determinant, pz);
  }
  geometry.computeVertexNormals();
}

function fieldSurface(d, role, boneIndex, palette) {
  const authored = hasHeroSurfaceFinish(role);
  const resolution = ['brawler', 'bruiser', 'enforcer'].includes(role) ? 36 : 37;
  const field = new MarchingCubes(resolution, FIELD_MATERIAL, false, false, 18000);
  // Three extracts cube corners 1..N-2, leaving samples for normal gradients.
  // Express the usable interval first: treating it as the raw sample range
  // clipped shoulder caps at .833h and left both trouser ankles uncapped.
  const usableY = { min: 0.04, max: 0.875 }, yStep = (usableY.max - usableY.min) / (resolution - 3);
  const bounds = { x: 0.38, y0: usableY.min - yStep, y1: usableY.max + yStep * 2, z: 0.12 }, short = role === 'brawler';
  field.isolation = 0;
  for (let z = 0; z < resolution; z++) for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const px = (x / resolution * 2 - 1) * bounds.x, py = bounds.y0 + y / resolution * (bounds.y1 - bounds.y0), pz = (z / resolution * 2 - 1) * bounds.z;
    field.field[x + y * resolution + z * resolution * resolution] = -distances(px, py, pz, d, short).distance;
  }
  field.update();
  const geometry = new THREE.BufferGeometry();
  const positions = field.geometry.attributes.position.array.slice(0, field.count * 3);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] *= bounds.x * d.height;
    positions[i + 1] = (bounds.y0 + (positions[i + 1] + 1) / 2 * (bounds.y1 - bounds.y0)) * d.height;
    positions[i + 2] *= bounds.z * d.height;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  field.geometry.dispose();
  // Weld the extracted surface before authoring normals/weights. Shoulders,
  // elbows, hips and knees are part of one indexed surface, not capped parts.
  const connected = exteriorSurface(mergeVertices(geometry, 1e-5)); geometry.dispose(); connected.computeVertexNormals();
  attributes(connected, boneIndex, (x, y, z) => bodyWeights(x / d.height, y / d.height, z / d.height, d, short),
    (x, y, z) => {
      const py = y / d.height;
      if (authored) return wornGarmentColor(x, y, z, d, palette, role);
      if (py < 0.578 && Math.abs(x) < d.height * 0.18) return py > 0.563 ? palette.belt : palette.pants;
      if (z > 0 && Math.abs(x) < d.height * 0.005 && role !== 'brawler') return palette.trim;
      return palette.shirt;
    });
  if (short) tailorShortSleeveSurface(connected, d, boneIndex);
  if (authored) authorHeroSurface(connected, (x, y) => {
    const trousers = y / d.height < 0.578 && Math.abs(x) < d.height * 0.18;
    return garmentFinish(role, trousers, trousers && y / d.height >= 0.563);
  });
  connected.userData.continuousBody = true;
  return connected;
}

function smoothRingNormals(geometry, rows, segments) {
  const normal = geometry.attributes.normal, shared = new THREE.Vector3();
  for (let row = 0; row < rows; row++) {
    const start = row * (segments + 1), end = start + segments;
    shared.set(normal.getX(start) + normal.getX(end), normal.getY(start) + normal.getY(end), normal.getZ(start) + normal.getZ(end)).normalize();
    normal.setXYZ(start, shared.x, shared.y, shared.z); normal.setXYZ(end, shared.x, shared.y, shared.z);
  }
}

function lathe(rows, segments = 24, closeBottom = false) {
  const positions = [], uv = [], indices = [];
  for (let j = 0; j < rows.length; j++) for (let i = 0; i <= segments; i++) {
    const a = i / segments * TAU, [y, rx, rz, z = 0] = rows[j];
    positions.push(Math.sin(a) * rx, y, Math.cos(a) * rz + z); uv.push(i / segments, j / (rows.length - 1));
    if (j && i < segments) { const n = j * (segments + 1) + i, p = n - segments - 1; indices.push(p, p + 1, n, p + 1, n + 1, n); }
  }
  if (closeBottom) {
    const center = positions.length / 3; positions.push(0, rows[0][0], rows[0][3] || 0); uv.push(0.5, 0.5);
    for (let i = 0; i < segments; i++) indices.push(center, i + 1, i);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(indices); g.computeVertexNormals();
  smoothRingNormals(g, rows.length, segments);
  return g;
}

function merge(parts) {
  const converted = parts.map(g => g.index ? g.toNonIndexed() : g);
  const merged = mergeGeometries(converted, false);
  for (const geometry of converted) geometry.dispose();
  for (const geometry of parts) if (!converted.includes(geometry)) geometry.dispose();
  const indexed = mergeVertices(merged, 1e-5); merged.dispose();
  indexed.computeBoundingBox(); indexed.computeBoundingSphere(); return indexed;
}

function boot(d, side, boneIndex, palette, authored = false) {
  const h = d.height, bottom = -d.ankleY, toe = d.bootLength;
  const geometry = lathe([
    [bottom, d.bootWidth * 0.40, toe * 0.43, toe * 0.13],
    [bottom + h * 0.008, d.bootWidth * 0.50, toe * 0.50, toe * 0.13],
    [bottom + h * 0.020, d.bootWidth * 0.49, toe * 0.49, toe * 0.13],
    [bottom + h * 0.034, d.bootWidth * 0.47, toe * 0.46, toe * 0.12],
    [bottom + h * 0.048, d.bootWidth * 0.40, toe * 0.34, toe * 0.02],
    [bottom + h * 0.065, d.bootWidth * 0.32, toe * 0.20, -toe * 0.08],
    [bottom + h * 0.088, d.bootWidth * 0.32, toe * 0.19, -toe * 0.08],
    [bottom + h * 0.098, d.bootWidth * 0.34, toe * 0.20, -toe * 0.08],
  ], 24, true);
  geometry.translate((side === 'L' ? -1 : 1) * d.hipSpacing, d.ankleY, 0);
  attributes(geometry, boneIndex, () => ({ [`ankle${side}`]: 1 }), (x, y, z) => {
    if (y < h * 0.023) return palette.sole;
    return authored ? palette.boot.clone().multiplyScalar(1 + gauss(y / h - 0.040, 0.018) * smooth(z / toe) * 0.24) : palette.boot;
  }, authored);
  if (authored) authorHeroSurface(geometry, (x, y) => [y < h * 0.023 ? 0.96 : 0.67, y < h * 0.023 ? 0.05 : 0.12]);
  return geometry;
}

function garmentSurfaceSampler(d, shortSleeve) {
  const samples = new Map();
  return (x, y) => {
    const key = `${x.toFixed(6)}:${y.toFixed(6)}`;
    if (samples.has(key)) return samples.get(key);
    const px = x / d.height, py = y / d.height;
    let outer = 0.12, inner = 0, found = false;
    for (let step = 1; step <= 24; step++) {
      const z = 0.12 * (1 - step / 24);
      if (distances(px, py, z, d, shortSleeve).distance <= 0) { inner = z; found = true; break; }
      outer = z;
    }
    if (found) for (let pass = 0; pass < 10; pass++) {
      const z = (inner + outer) * 0.5;
      if (distances(px, py, z, d, shortSleeve).distance <= 0) inner = z; else outer = z;
    }
    const result = found ? (inner + outer) * 0.5 * d.height : 0;
    samples.set(key, result); return result;
  };
}

function bareArm(d, side, boneIndex) {
  const sign = side === 'L' ? -1 : 1, h = d.height, length = d.upperArmLength + d.forearmLength;
  const rows = [], angle = HERO_BIND_ARM_ANGLE;
  for (let i = 0; i <= 18; i++) {
    const t = 0.32 + i / 18 * 0.68, radius = h * (0.024 + gauss(t - 0.58, 0.15) * 0.004 - smooth((t - 0.80) / 0.20) * 0.010);
    // Match the existing palm's wrist ellipse. The former round forearm end
    // was wider and deeper than the hand, leaving a visible step in a punch.
    const wrist = smooth((t - 0.80) / 0.20);
    rows.push([-t * length, radius * (1 - wrist) + d.handWidth * 0.565 * 0.5 * wrist,
      radius * (1 - smooth((t - 0.62) / 0.38) * 0.12) * (1 - wrist) + d.handDepth * 0.40 * 0.5 * wrist]);
  }
  const g = lathe(rows.reverse(), 20), position = g.attributes.position;
  // The palm uses ten sides. Fit alternating distal samples to its actual
  // polygon instead of placing a higher-resolution ellipse outside that rim.
  for (let row = 0; row < rows.length; row++) for (let i = 0; i <= 20; i++) {
    const index = row * 21 + i, t = -rows[row][0] / length;
    const polygon = 1 - smooth((t - 0.90) / 0.10) * (i % 2 ? 1 - Math.cos(Math.PI / 10) : 0);
    position.setX(index, position.getX(index) * polygon); position.setZ(index, position.getZ(index) * polygon);
  }
  g.computeVertexNormals(); smoothRingNormals(g, rows.length, 20);
  g.rotateZ(sign * angle).translate(sign * d.shoulderSpacing, d.shoulderY, 0);
  attributes(g, boneIndex, (x, y, z) => {
    const t = armSample(x / h, y / h, z / h, sign, d).t;
    const elbow = smooth((t - 0.4) / 0.24), wrist = smooth((t - 0.9) / 0.1);
    return { [`shoulder${side}`]: 1 - elbow, [`elbow${side}`]: elbow * (1 - wrist), [`wrist${side}`]: wrist };
  }, (x, y, z) => {
    const t = armSample(x / h, y / h, z / h, sign, d).t;
    const elbow = gauss(t - 0.54, 0.10), wrist = gauss(t - 0.94, 0.065);
    return new THREE.Color(1 - elbow * 0.025 - wrist * 0.012, 0.985 - elbow * 0.065 - wrist * 0.025, 0.965 - elbow * 0.072 - wrist * 0.026);
  }, true);
  return authorHeroSurface(g, (x, y, z) => {
    const t = armSample(x / h, y / h, z / h, sign, d).t;
    return [0.76 + gauss(t - 0.54, 0.12) * 0.045, 0.9];
  });
}

function neckSurface(d, boneIndex, authored = false) {
  const h = d.height, top = d.headChinY + d.headHeight * 0.35;
  // A narrow middle and curved nape soften the former straight neck silhouette.
  // Keep the buried base and head-weighted upper rim in their existing frames.
  const rows = [[0.805 * h, 0.062 * h, 0.045 * h, -0.008 * h],
    [0.814 * h, 0.052 * h, 0.042 * h, -0.008 * h], [0.824 * h, 0.040 * h, 0.038 * h, -0.007 * h],
    [0.835 * h, 0.032 * h, 0.031 * h, -0.007 * h], [0.848 * h, 0.0275 * h, 0.0265 * h, -0.0085 * h],
    [0.864 * h, 0.0245 * h, 0.024 * h, -0.010 * h], [0.881 * h, 0.0255 * h, 0.0245 * h, -0.014 * h],
    [Math.min(0.900 * h, top - h * 0.009), 0.027 * h, 0.024 * h, -0.014 * h], [top, 0.028 * h, 0.024 * h, -0.012 * h]];
  const geometry = lathe(rows, 24), p = geometry.attributes.position;
  for (let row = 0; row < rows.length; row++) for (let i = 0; i <= 24; i++) {
    const index = row * 25 + i, angle = i / 24 * TAU, y = rows[row][0];
    const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle)), t = clamp((y / h - 0.815) / 0.085, 0, 1);
    const tendon = h * 0.0018 * gauss(Math.abs(wrapped) - (0.55 + t * 0.7), 0.18) * Math.sin(t * Math.PI);
    const throat = h * 0.0018 * gauss(wrapped, 0.25) * gauss(y / h - 0.856, 0.011);
    p.setXYZ(index, p.getX(index) + Math.sin(angle) * tendon, y,
      p.getZ(index) + Math.cos(angle) * tendon + throat);
  }
  geometry.computeVertexNormals();
  smoothRingNormals(geometry, rows.length, 24);
  // The lower flare follows the chest, the middle follows the neck, and the
  // hidden upper rim follows the head exactly. No rigid tube is left behind
  // when a guard looks aside or recoils; all deformation stays on the GPU.
  attributes(geometry, boneIndex, (x, y) => {
    const head = smooth((y - (d.headChinY - h * 0.006)) / (top - (d.headChinY - h * 0.006)));
    const chest = 1 - smooth((y / h - 0.818) / 0.030);
    return { chest: (1 - head) * chest, neck: (1 - head) * (1 - chest), head };
  }, (x, y, z) => {
    const upper = smooth((y / h - 0.837) / 0.045);
    const throatShadow = gauss(y / h - 0.869, 0.020) * Math.max(0, z / (h * 0.03)) * 0.055;
    const warmth = authored ? gauss(y / h - 0.843, 0.022) * 0.020 : 0;
    return new THREE.Color(1 - upper * 0.035 - throatShadow, 0.99 - upper * 0.055 - throatShadow - warmth, 0.98 - upper * 0.060 - throatShadow - warmth);
  }, authored);
  if (authored) authorHeroSurface(geometry, (x, y) => [0.74 - smooth((y / h - 0.84) / 0.05) * 0.025, 0.9]);
  return geometry;
}

/** Original field-sculpted, welded body topology and authored garment details. */
export function heroBodyGeometry(config, d, bones, proxies) {
  const role = config.role || config.kind || 'adult';
  const authored = hasHeroSurfaceFinish(role);
  const key = JSON.stringify([role, d.height, d.width, config.skin, config.shirt, config.pants, config.hair]);
  if (cache.has(key)) return cache.get(key);
  const boneIndex = Object.fromEntries(bones.map((bone, i) => [bone.name.slice(6), i]));
  const tint = (color, lift = 0) => new THREE.Color(color).lerp(new THREE.Color('#879080'), lift);
  const palette = { shirt: tint(config.shirt || '#41484b', role === 'brawler' ? 0.20 : 0.12), pants: tint(config.pants || '#2c3237', role === 'brawler' ? 0.12 : 0.08),
    trim: tint('#232a29'), equipment: tint(role === 'enforcer' ? '#343c36' : '#414237'),
    belt: tint('#222522'), boot: tint('#242a29'), sole: tint('#111615') };
  const surface = fieldSurface(d, role, boneIndex, palette);
  const surfaceTriangles = surface.index.count / 3, surfaceVertices = surface.attributes.position.count;
  const details = heroGarmentDetails({ dimensions: d, role, palette,
    frontAt: garmentSurfaceSampler(d, role === 'brawler'), bindArmAngle: HERO_BIND_ARM_ANGLE });
  const garmentDetails = { triangles: details.userData.triangles,
    parts: details.map(part => ({ name: part.name, triangles: part.geometry.index.count / 3 })) };
  const garments = merge([surface, ...details.map(part => {
    const colorFor = (x, y, z) => {
      const base = part.colorFor(x, y, z);
      if (!authored || !part.name.startsWith('sleeve-hem.')) return base;
      const sign = part.name.endsWith('.L') ? -1 : 1;
      const t = armSample(x / d.height, y / d.height, z / d.height, sign, d).t;
      const edge = role === 'brawler' ? smooth((t - 0.358) / 0.023) : smooth((t - 0.971) / 0.012);
      return base.clone().multiplyScalar(0.98 + edge * (role === 'hitman' ? 0.10 : 0.21));
    };
    const geometry = attributes(part.geometry, boneIndex, part.weightFor, colorFor);
    if (authored) authorHeroSurface(geometry, () => {
      if (part.name.includes('webbing') || part.name.includes('strap') || part.name.includes('pouch')) return [0.97, 0.75];
      if (part.name.startsWith('vest-')) return [0.94, 0.8];
      if (part.name === 'zipper-pull') return [0.53, 0.03];
      if (part.name.startsWith('shirt-button.')) return [0.66, 0.06];
      return role === 'brawler' ? [0.96, 0.8] : garmentFinish(role);
    });
    return geometry;
  }), boot(d, 'L', boneIndex, palette, authored), boot(d, 'R', boneIndex, palette, authored)]);
  const skinParts = [];
  for (const side of ['L', 'R']) {
    const hand = proxies.find(mesh => mesh.name === `hand.${side}`);
    const g = hand.geometry.clone(); hand.updateWorldMatrix(true, false); g.applyMatrix4(hand.matrixWorld);
    if (hand.matrixWorld.determinant() < 0) {
      const count = g.attributes.position.count, index = [];
      for (let i = 0; i < count; i += 3) index.push(i + 2, i + 1, i);
      g.setIndex(index);
    }
    const local = new THREE.Vector3(), inverse = hand.matrixWorld.clone().invert();
    skinParts.push(attributes(g, boneIndex, () => ({ [`wrist${side}`]: 1 }), (x, y, z) => {
      if (!authored) return new THREE.Color(1, 1, 1);
      local.set(x, y, z).applyMatrix4(inverse);
      const knuckle = gauss(local.y + 0.64, 0.13), palm = smooth(local.z / 0.32);
      return new THREE.Color(1 - knuckle * 0.025, 0.985 - knuckle * 0.075 + palm * 0.012, 0.965 - knuckle * 0.082 + palm * 0.018);
    }, authored));
    if (authored) authorHeroSurface(g, () => [0.72, 0.85]);
    if (role === 'brawler') skinParts.push(bareArm(d, side, boneIndex));
  }
  skinParts.push(neckSurface(d, boneIndex, authored));
  const skin = merge(skinParts);
  const result = { garments, skin, role, surfaceTriangles, surfaceVertices, garmentDetails,
    provenance: 'Original authored implicit surface, welded topology, folded and sewn garment surfaces, anatomical neck and GPU skin weights' };
  cache.set(key, result); return result;
}
