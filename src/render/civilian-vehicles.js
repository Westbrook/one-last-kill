import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSedanBumper } from './sedan-panels.js';

const geometryCache = new Map(), paintCache = new Map(), trimCache = new Map();
const CATEGORY = ['paint', 'trim', 'metal', 'glass', 'tires', 'lamps'];
const WHEEL_RADIUS = 0.325, WHEEL_WIDTH = 0.27, ARCH_RADIUS = 0.390;
const BELT_Y = 0.86, BODY_BELT_Y = 0.84;

function freezeTree(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeTree(child);
  return Object.freeze(value);
}

export const CIVILIAN_VEHICLE_PROFILES = freezeTree({
  sedan: { variant: 'sedan', length: 4.40, width: 1.80, wheelbase: 2.68,
    cabin: { baseRearX: -1.28, baseFrontX: 1.11, topRearX: -0.88, topFrontX: 0.52, glassTopY: 1.425,
      baseHalfWidth: 0.775, topHalfWidth: 0.680 }, pillars: [[-0.18, -0.14]], doorSeams: [-1.18, -0.21, 1.01], handles: [-0.77, 0.24] },
  hatchback: { variant: 'hatchback', length: 3.88, width: 1.75, wheelbase: 2.43,
    cabin: { baseRearX: -1.68, baseFrontX: 1.00, topRearX: -1.31, topFrontX: 0.48, glassTopY: 1.44,
      baseHalfWidth: 0.755, topHalfWidth: 0.675 }, pillars: [[-0.39, -0.34]], doorSeams: [-0.41, 0.92], handles: [-0.18] },
  wagon: { variant: 'wagon', length: 4.58, width: 1.82, wheelbase: 2.79,
    cabin: { baseRearX: -1.99, baseFrontX: 1.12, topRearX: -1.76, topFrontX: 0.55, glassTopY: 1.45,
      baseHalfWidth: 0.785, topHalfWidth: 0.695 }, pillars: [[-0.20, -0.16], [-1.13, -1.11]], doorSeams: [-1.14, -0.22, 1.01], handles: [-0.79, 0.25] },
  'panel-van': { variant: 'panel-van', architecture: 'van', length: 4.72, width: 1.90, wheelbase: 2.90,
    cabin: { baseRearX: -2.20, baseFrontX: 1.67, topRearX: -2.14, topFrontX: 1.17, glassTopY: 1.872,
      baseHalfWidth: 0.905, topHalfWidth: 0.836 }, cabRearX: 0.20, cargoOpaque: true },
  'passenger-van': { variant: 'passenger-van', architecture: 'van', length: 4.82, width: 1.92, wheelbase: 2.97,
    cabin: { baseRearX: -2.25, baseFrontX: 1.70, topRearX: -2.19, topFrontX: 1.20, glassTopY: 1.892,
      baseHalfWidth: 0.915, topHalfWidth: 0.846 }, cabRearX: 0.22, cargoOpaque: false },
});

const FINISHES = freezeTree({
  kept: { roughness: 0.53, metalness: 0.42, trim: 0x1b2221, exposure: 1 },
  used: { roughness: 0.67, metalness: 0.31, trim: 0x2b302d, exposure: 0.94 },
  workhorse: { roughness: 0.78, metalness: 0.22, trim: 0x34382f, exposure: 0.88 },
});

function material(name, parameters, surfaceKind) {
  const result = new THREE.MeshStandardMaterial(parameters);
  result.name = 'civilian-' + name;
  result.userData = { surfaceKind, staticVehicleFinish: true, textureBytes: 0 };
  return result;
}

const sharedMaterials = {
  metal: material('dull-hardware', { color: 0x88918a, roughness: 0.47, metalness: 0.72, envMapIntensity: 0.34 }, 'metal'),
  glass: material('window-glass', { color: 0x344944, roughness: 0.24, metalness: 0.23,
    transparent: true, opacity: 0.88, envMapIntensity: 0.58 }, 'glass'),
  tires: material('tire-rubber', { color: 0x111615, roughness: 0.97, metalness: 0, envMapIntensity: 0.10 }, 'rubber'),
  lamps: material('unlit-lamp-lenses', { color: 0xffffff, vertexColors: true,
    roughness: 0.35, metalness: 0.08, envMapIntensity: 0.40 }, 'glass'),
};

function getMaterials(paint, finish) {
  const treatment = FINISHES[finish];
  const color = new THREE.Color(paint), key = color.getHexString() + ':' + finish;
  if (!paintCache.has(key)) {
    color.multiplyScalar(treatment.exposure);
    paintCache.set(key, material('paint-' + key, { color, vertexColors: true, roughness: treatment.roughness,
      metalness: treatment.metalness, envMapIntensity: 0.34 }, 'metal'));
  }
  if (!trimCache.has(finish)) trimCache.set(finish, material('trim-' + finish,
    { color: treatment.trim, roughness: 0.87, metalness: 0.06, envMapIntensity: 0.14 }, 'rubber'));
  return { ...sharedMaterials, paint: paintCache.get(key), trim: trimCache.get(finish) };
}

function finishGeometry(geometry) {
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

function closedRoof(profile) {
  const c = profile.cabin, minX = c.topRearX - 0.045, maxX = c.topFrontX + 0.045;
  const halfZ = c.topHalfWidth + 0.037, radius = 0.035, centerX = (minX + maxX) / 2;
  const corners = [[maxX - radius, halfZ - radius], [minX + radius, halfZ - radius],
    [minX + radius, -halfZ + radius], [maxX - radius, -halfZ + radius]];
  const outline = [];
  for (let corner = 0; corner < corners.length; corner++) for (let step = 0; step <= 3; step++) {
    const angle = (corner + step / 3) * Math.PI / 2;
    outline.push([corners[corner][0] + Math.cos(angle) * radius, corners[corner][1] + Math.sin(angle) * radius]);
  }
  outline.reverse();
  const positions = [], uv = [], indices = [], n = outline.length;
  for (const [dy, scale] of [[-0.009, 1], [0.021, 1], [0.047, 0.80]]) for (const [x, z] of outline) {
    positions.push(centerX + (x - centerX) * scale, c.glassTopY + dy, z * scale);
    uv.push((x - minX) / (maxX - minX), (z + halfZ) / (halfZ * 2));
  }
  for (let ring = 0; ring < 2; ring++) for (let i = 0; i < n; i++) {
    const a = ring * n + i, b = ring * n + (i + 1) % n;
    indices.push(a, b, a + n, a + n, b, b + n);
  }
  const bottom = positions.length / 3;
  positions.push(centerX, c.glassTopY - 0.009, 0); uv.push(0.5, 0.5);
  const top = positions.length / 3;
  positions.push(centerX, c.glassTopY + 0.064, 0); uv.push(0.5, 0.5);
  for (let i = 0; i < n; i++) {
    indices.push(bottom, (i + 1) % n, i);
    indices.push(top, n * 2 + i, n * 2 + (i + 1) % n);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices);
  return finishGeometry(geometry);
}

function cabinGlass(profile) {
  const c = profile.cabin, geometry = new THREE.BoxGeometry(1, 1, 1), positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const high = positions.getY(i) > 0, front = positions.getX(i) > 0, side = Math.sign(positions.getZ(i));
    positions.setXYZ(i, high ? (front ? c.topFrontX : c.topRearX) : (front ? c.baseFrontX : c.baseRearX),
      high ? c.glassTopY : BELT_Y, side * (high ? c.topHalfWidth : c.baseHalfWidth));
  }
  return finishGeometry(geometry);
}

function bodyShell(profile) {
  const { length, width, wheelbase, cabin } = profile, shape = new THREE.Shape();
  shape.moveTo(-length / 2, 0.305);
  for (const axleX of [-wheelbase / 2, wheelbase / 2]) {
    shape.lineTo(axleX - ARCH_RADIUS, WHEEL_RADIUS);
    for (let i = 1; i <= 14; i++) {
      const angle = Math.PI * (1 - i / 14);
      shape.lineTo(axleX + Math.cos(angle) * ARCH_RADIUS, WHEEL_RADIUS + Math.sin(angle) * ARCH_RADIUS);
    }
  }
  shape.lineTo(length / 2, 0.325);
  // The stamped nose and tail stay full-height behind the complete lamp
  // panel. The earlier low nose rolled away beneath its upper corners.
  shape.lineTo(length / 2, 0.787); shape.lineTo(length / 2 - 0.15, 0.810);
  shape.lineTo(cabin.baseFrontX + 0.045, BODY_BELT_Y);
  shape.lineTo(cabin.baseRearX - 0.03, BODY_BELT_Y);
  shape.lineTo(-length / 2 + 0.10, 0.810); shape.lineTo(-length / 2, 0.785); shape.closePath();
  const depth = width - 0.06;
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, steps: 1, bevelEnabled: true,
    bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 2, curveSegments: 1 });
  geometry.translate(0, 0, -depth / 2);
  return finishGeometry(geometry);
}

function archLip() {
  const shape = new THREE.Shape(), outer = ARCH_RADIUS + 0.028, inner = ARCH_RADIUS - 0.002;
  shape.moveTo(outer, 0);
  for (let i = 1; i <= 14; i++) shape.lineTo(Math.cos(i * Math.PI / 14) * outer, Math.sin(i * Math.PI / 14) * outer);
  shape.lineTo(-inner, 0);
  for (let i = 13; i >= 0; i--) shape.lineTo(Math.cos(i * Math.PI / 14) * inner, Math.sin(i * Math.PI / 14) * inner);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.026, steps: 1, bevelEnabled: false, curveSegments: 1 });
  geometry.translate(0, 0, -0.013);
  return finishGeometry(geometry);
}

const wheelTire = finishGeometry(new THREE.LatheGeometry([
  new THREE.Vector2(0.125, -WHEEL_WIDTH / 2), new THREE.Vector2(0.263, -WHEEL_WIDTH / 2),
  new THREE.Vector2(0.310, -0.102), new THREE.Vector2(WHEEL_RADIUS, -0.049),
  new THREE.Vector2(WHEEL_RADIUS, 0.049), new THREE.Vector2(0.310, 0.102),
  new THREE.Vector2(0.263, WHEEL_WIDTH / 2), new THREE.Vector2(0.125, WHEEL_WIDTH / 2),
  new THREE.Vector2(0.125, -WHEEL_WIDTH / 2),
], 20));
const wheelHub = new THREE.CylinderGeometry(0.207, 0.207, 0.017, 16);
const wheelCenter = new THREE.CylinderGeometry(0.067, 0.067, 0.021, 12);
const wheelArch = archLip();

function buildGeometry(profile) {
  const buckets = Object.fromEntries(CATEGORY.map(category => [category, []]));
  const localBody = new THREE.Box3(), localCabin = new THREE.Box3(), wheels = [];
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1);
  function part(geometry, category, name, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, tint = 0xffffff, upper = false, dispose = true } = {}) {
    const prepared = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    rotation.setFromEuler(new THREE.Euler(rx, ry, rz)); matrix.compose(new THREE.Vector3(x, y, z), rotation, scale);
    prepared.applyMatrix4(matrix);
    const p = prepared.attributes.position, color = new THREE.Color(tint), colors = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      // Faint road dust belongs to lower painted metal, without a repeating
      // texture, painted illumination or a separately rendered decal layer.
      const dust = category === 'paint' ? 0.78 + 0.22 * THREE.MathUtils.smoothstep(p.getY(i), 0.30, 0.90) : 1;
      colors.set([color.r * dust, color.g * dust, color.b * dust], i * 3);
    }
    prepared.setAttribute('color', new THREE.BufferAttribute(colors, 3)); prepared.computeBoundingBox();
    (upper ? localCabin : localBody).union(prepared.boundingBox);
    buckets[category].push({ geometry: prepared, name });
    if (dispose) geometry.dispose();
  }
  const box = (category, name, x, y, z, width, height, depth, options = {}) =>
    part(new THREE.BoxGeometry(width, height, depth), category, name, { x, y, z, ...options });
  part(bodyShell(profile), 'paint', 'body-shell');
  part(cabinGlass(profile), 'glass', 'cabin-glass', { upper: true });
  part(closedRoof(profile), 'paint', 'crowned-roof', { upper: true });
  box('trim', 'underbody', 0, 0.30, 0, profile.length * 0.80, 0.14, profile.width * 0.66);
  const c = profile.cabin, height = c.glassTopY - BELT_Y;

  function pillar(name, bottomX, topX, side, width, color = 'trim') {
    const geometry = new THREE.BoxGeometry(width, height + 0.025, 0.046), p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const high = p.getY(i) > 0;
      p.setXYZ(i, (high ? topX : bottomX) + p.getX(i),
        high ? c.glassTopY + 0.014 : BELT_Y - 0.011,
        side * ((high ? c.topHalfWidth : c.baseHalfWidth) - 0.002) + p.getZ(i));
    }
    part(finishGeometry(geometry), color, name, { upper: true });
  }

  for (const side of [-1, 1]) {
    const sideName = side > 0 ? 'left' : 'right';
    pillar('a-pillar-' + sideName, c.baseFrontX - 0.031, c.topFrontX - 0.031, side, 0.090, 'paint');
    pillar('rear-pillar-' + sideName, c.baseRearX + 0.036, c.topRearX + 0.036, side,
      profile.variant === 'wagon' ? 0.112 : 0.102, 'paint');
    for (const [index, [bottom, top]] of profile.pillars.entries()) pillar(`division-pillar-${index}-${sideName}`, bottom, top, side, 0.078);
    box('trim', 'window-sill-' + sideName, (c.baseFrontX + c.baseRearX) / 2, BELT_Y + 0.024,
      side * (c.baseHalfWidth + 0.008), c.baseFrontX - c.baseRearX + 0.025, 0.038, 0.045, { upper: true });
    box('trim', 'roof-gutter-' + sideName, (c.topFrontX + c.topRearX) / 2, c.glassTopY + 0.008,
      side * (c.topHalfWidth + 0.017), c.topFrontX - c.topRearX + 0.065, 0.026, 0.034, { upper: true });
    for (const [index, x] of profile.doorSeams.entries()) {
      let bottom = 0.39;
      for (const axle of [-profile.wheelbase / 2, profile.wheelbase / 2]) if (Math.abs(x - axle) < ARCH_RADIUS) {
        bottom = Math.max(bottom, WHEEL_RADIUS + Math.sqrt(ARCH_RADIUS ** 2 - (x - axle) ** 2) + 0.035);
      }
      if (bottom < 0.79) box('trim', `door-seam-${index}-${sideName}`, x, (bottom + 0.79) / 2,
        side * (profile.width / 2 + 0.001), 0.008, 0.79 - bottom, 0.005);
    }
    for (const [index, x] of profile.handles.entries()) box('metal', `door-handle-${index}-${sideName}`,
      x, 0.763, side * (profile.width / 2 + 0.009), 0.16, 0.032, 0.026);
    const skirtLength = profile.wheelbase - ARCH_RADIUS * 2 - 0.04;
    box('trim', 'rocker-' + sideName, 0, profile.variant === 'wagon' ? 0.438 : 0.386,
      side * (profile.width / 2 + 0.002), skirtLength, profile.variant === 'wagon' ? 0.15 : 0.061, 0.028);

    const mirrorX = c.baseFrontX - 0.30, mirrorY = 1.02;
    const glassZ = THREE.MathUtils.lerp(c.baseHalfWidth, c.topHalfWidth, (mirrorY - BELT_Y) / height);
    const mirrorZ = profile.width / 2 + 0.066;
    box('trim', 'mirror-arm-' + sideName, mirrorX, mirrorY - 0.008, side * ((glassZ + mirrorZ - 0.042) / 2),
      0.052, 0.036, mirrorZ - 0.042 - glassZ + 0.028, { upper: true });
    box('paint', 'mirror-housing-' + sideName, mirrorX, mirrorY, side * mirrorZ, 0.184, 0.080, 0.101, { upper: true });
    box('metal', 'mirror-face-' + sideName, mirrorX - 0.093, mirrorY, side * mirrorZ, 0.010, 0.055, 0.078, { upper: true });
  }

  for (const [end, lowX, highX] of [['front', c.baseFrontX, c.topFrontX], ['rear', c.baseRearX, c.topRearX]]) {
    const sign = end === 'front' ? 1 : -1;
    box('trim', end + '-window-bottom-seal', lowX - sign * 0.024, BELT_Y + 0.024, 0,
      0.047, 0.041, c.baseHalfWidth * 2, { upper: true });
    box('trim', end + '-window-top-seal', highX + sign * 0.018, c.glassTopY - 0.016, 0,
      0.038, 0.038, c.topHalfWidth * 2, { upper: true });
  }

  for (const axleSign of [-1, 1]) for (const side of [-1, 1]) {
    const name = (axleSign > 0 ? 'front' : 'rear') + '-' + (side > 0 ? 'left' : 'right');
    const x = axleSign * profile.wheelbase / 2, z = side * (profile.width / 2 - 0.12);
    const surfaceName = 'tire:' + name;
    wheels.push({ name, surfaceName, center: [x, WHEEL_RADIUS, z], radius: WHEEL_RADIUS, width: WHEEL_WIDTH });
    part(wheelTire, 'tires', surfaceName, { x, y: WHEEL_RADIUS, z, rx: Math.PI / 2, dispose: false });
    part(wheelHub, 'metal', 'hub:' + name, { x, y: WHEEL_RADIUS, z: z + side * 0.133, rx: Math.PI / 2, dispose: false });
    part(wheelCenter, 'trim', 'hub-center:' + name, { x, y: WHEEL_RADIUS, z: z + side * 0.145, rx: Math.PI / 2, dispose: false });
    part(wheelArch, 'trim', 'arch:' + name, { x, y: WHEEL_RADIUS, z: side * (profile.width / 2 - 0.004), dispose: false });
  }

  for (const end of [-1, 1]) {
    part(createSedanBumper(profile.width), 'trim', end > 0 ? 'front-bumper' : 'rear-bumper',
      { x: end * (profile.length / 2 - 0.013), y: 0.425 });
    if (profile.variant === 'sedan') box('metal', end > 0 ? 'front-bumper-insert' : 'rear-bumper-insert',
      end * (profile.length / 2 + 0.075), 0.436, 0, 0.022, 0.047, profile.width * 0.77);
    box('trim', end > 0 ? 'front-lamp-panel' : 'rear-lamp-panel', end * (profile.length / 2 + 0.023), 0.645, 0,
      0.052, 0.263, profile.width * 0.85);
    for (const side of [-1, 1]) {
      const tallRear = end < 0 && profile.variant !== 'sedan';
      const height = tallRear ? 0.248 : profile.variant === 'hatchback' ? 0.19 : 0.155;
      const width = tallRear ? 0.18 : profile.variant === 'hatchback' ? 0.32 : 0.42;
      box('lamps', (end > 0 ? 'headlamp-' : 'tail-lamp-') + side, end * (profile.length / 2 + 0.058), 0.654,
        side * profile.width * 0.31, 0.020, height, width, { tint: end > 0 ? 0xc4bda1 : 0x743831 });
      if (end > 0) box('lamps', 'front-indicator-' + side, profile.length / 2 + 0.059, 0.536,
        side * profile.width * 0.31, 0.019, 0.040, width * 0.65, { tint: 0xa87945 });
    }
    box('metal', (end > 0 ? 'front' : 'rear') + '-plate', end * (profile.length / 2 + 0.057), 0.542, 0,
      0.022, 0.105, 0.29);
  }
  for (let i = 0; i < 3; i++) box('metal', 'grille-bar-' + i, profile.length / 2 + 0.052,
    0.602 + i * 0.042, 0, 0.015, 0.010, profile.variant === 'hatchback' ? 0.41 : 0.57);

  const geometry = {}, names = [];
  let triangles = 0, geometryBytes = 0;
  for (const category of CATEGORY) {
    const parts = buckets[category], ranges = []; let first = 0;
    for (const entry of parts) {
      ranges.push(Object.freeze({ name: entry.name, vertexStart: first, vertexCount: entry.geometry.attributes.position.count }));
      first += entry.geometry.attributes.position.count; names.push(entry.name);
    }
    const merged = mergeGeometries(parts.map(entry => entry.geometry), false);
    merged.name = 'civilian-' + profile.variant + '-' + category;
    merged.userData.civilianParts = Object.freeze(ranges);
    merged.computeBoundingBox(); merged.computeBoundingSphere();
    triangles += merged.attributes.position.count / 3;
    geometryBytes += Object.values(merged.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
    geometry[category] = merged;
    for (const entry of parts) entry.geometry.dispose();
  }
  // Each collider encloses exactly the lower or upper authored part family.
  // The complete wagon/hatch glass and mirrors belong to the upper volume;
  // neither inherits the sedan's shorter roof footprint.
  const visualBounds = localBody.clone().union(localCabin);
  const description = freezeTree({ ...profile, wheelRadius: WHEEL_RADIUS, wheelWidth: WHEEL_WIDTH, wheels,
    cabin: { ...c, beltY: BELT_Y, roofTopY: c.glassTopY + 0.064 }, parts: names });
  return { geometry, movementBounds: [localBody, localCabin], visualBounds, profile: description,
    resources: Object.freeze({ triangles, materialDraws: CATEGORY.length, geometryBytes, textures: 0,
      textureBytes: 0, addedLights: 0, geometrySharedByVariant: true, runtimeConstruction: false }) };
}

// Vans have a separate panel/opening builder: a cargo body is not a stretched
// car glazing volume. The existing three car buffers retain their exact build.
function buildVanGeometry(profile) {
  const c = profile.cabin, buckets = Object.fromEntries(CATEGORY.map(category => [category, []]));
  const localBody = new THREE.Box3(), localCabin = new THREE.Box3(), wheels = [], glazingRegions = [];
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1);
  const at = (low, high, y) => THREE.MathUtils.lerp(low, high, (y - BELT_Y) / (c.glassTopY - BELT_Y));
  const frontAt = y => at(c.baseFrontX, c.topFrontX, y);
  const rearAt = y => at(c.baseRearX, c.topRearX, y);
  const halfAt = y => at(c.baseHalfWidth, c.topHalfWidth, y);
  const cabSill = 1.145, cabTop = c.glassTopY - 0.075;
  const cargoSill = 1.160, cargoTop = c.glassTopY - 0.150;
  const upperBottom = BELT_Y - 0.012, upperTop = c.glassTopY + 0.012;
  const cargoFront = profile.cabRearX - 0.08;

  function part(source, category, name, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, tint = 0xffffff, upper = false, dispose = true } = {}) {
    const geometry = source.index ? source.toNonIndexed() : source.clone();
    rotation.setFromEuler(new THREE.Euler(rx, ry, rz)); matrix.compose(new THREE.Vector3(x, y, z), rotation, scale);
    geometry.applyMatrix4(matrix);
    const p = geometry.attributes.position, color = new THREE.Color(tint), colors = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const dust = category === 'paint' ? 0.78 + 0.22 * THREE.MathUtils.smoothstep(p.getY(i), 0.30, 0.90) : 1;
      colors.set([color.r * dust, color.g * dust, color.b * dust], i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometry.computeBoundingBox();
    (upper ? localCabin : localBody).union(geometry.boundingBox);
    buckets[category].push({ geometry, name });
    if (dispose) source.dispose();
  }
  const box = (category, name, x, y, z, width, height, depth, options = {}) =>
    part(new THREE.BoxGeometry(width, height, depth), category, name, { x, y, z, ...options });

  // Six closed faces with independently fitted lower/upper rectangles. Every
  // pane and stamped panel has thickness; there are no one-sided cargo skins.
  function section(category, name, y1, y2, minX, maxX, minZ, maxZ, options = {}) {
    const geometry = new THREE.BoxGeometry(1, 1, 1), p = geometry.attributes.position;
    const value = (bound, y) => typeof bound === 'function' ? bound(y) : bound;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) < 0 ? y1 : y2;
      p.setXYZ(i, value(p.getX(i) < 0 ? minX : maxX, y), y,
        value(p.getZ(i) < 0 ? minZ : maxZ, y));
    }
    part(finishGeometry(geometry), category, name, { upper: true, ...options });
  }
  function sidePanel(category, name, side, y1, y2, minX, maxX, thickness = 0.055, standOff = 0.007) {
    section(category, name, y1, y2, minX, maxX,
      y => side > 0 ? halfAt(y) - thickness : -halfAt(y) - standOff,
      y => side > 0 ? halfAt(y) + standOff : -halfAt(y) + thickness);
  }
  function endPanel(category, name, end, y1, y2, minZ, maxZ, thickness = 0.050, standOff = 0.007) {
    const surface = end > 0 ? frontAt : rearAt;
    section(category, name, y1, y2,
      y => end > 0 ? surface(y) - thickness : surface(y) - standOff,
      y => end > 0 ? surface(y) + standOff : surface(y) + thickness,
      minZ, maxZ);
  }

  part(bodyShell(profile), 'paint', 'body-shell');
  part(closedRoof(profile), 'paint', 'crowned-roof', { upper: true });
  box('trim', 'underbody', 0, 0.30, 0, profile.length * 0.80, 0.14, profile.width * 0.66);
  section('paint', 'van-cab-waist', upperBottom, cabSill + 0.010,
    profile.cabRearX - 0.10, frontAt, y => -halfAt(y), halfAt);
  section('paint', 'van-cab-roof-header', cabTop - 0.010, upperTop,
    profile.cabRearX - 0.10, frontAt, y => -halfAt(y), halfAt);
  if (profile.cargoOpaque) {
    section('paint', 'cargo-body', upperBottom, upperTop, rearAt, cargoFront, y => -halfAt(y), halfAt);
  } else {
    section('paint', 'cargo-waist', upperBottom, cargoSill + 0.010, rearAt, cargoFront, y => -halfAt(y), halfAt);
    section('paint', 'cargo-roof-header', cargoTop - 0.010, upperTop, rearAt, cargoFront, y => -halfAt(y), halfAt);
  }

  endPanel('glass', 'van-cab-glass-front', 1, cabSill, cabTop,
    y => -halfAt(y) + 0.060, y => halfAt(y) - 0.060, 0.014, 0.002);
  const cabMidY = (cabSill + cabTop) / 2;
  glazingRegions.push({ partName: 'van-cab-glass-front', probe: [frontAt(cabMidY) + 0.002, cabMidY, 0], inwardDirection: [-1, 0, 0] });

  for (const side of [-1, 1]) {
    const suffix = side > 0 ? 'left' : 'right';
    sidePanel('paint', 'van-a-pillar-' + suffix, side, upperBottom, upperTop, y => frontAt(y) - 0.105, y => frontAt(y) + 0.006, 0.095);
    sidePanel('paint', 'van-b-pillar-' + suffix, side, upperBottom, upperTop, profile.cabRearX - 0.10, profile.cabRearX + 0.055, 0.070);
    sidePanel('glass', 'van-cab-glass-' + suffix, side, cabSill, cabTop, profile.cabRearX,
      y => frontAt(y) - 0.083, 0.014, 0.002);
    const cabX = (profile.cabRearX + frontAt(cabMidY) - 0.083) / 2;
    glazingRegions.push({ partName: 'van-cab-glass-' + suffix,
      probe: [cabX, cabMidY, side * (halfAt(cabMidY) + 0.002)], inwardDirection: [0, 0, -side] });
    sidePanel('trim', 'van-cab-window-sill-' + suffix, side, cabSill - 0.018, cabSill + 0.021,
      profile.cabRearX - 0.007, y => frontAt(y) - 0.055, 0.018, 0.008);
    sidePanel('trim', 'van-roof-gutter-' + suffix, side, c.glassTopY - 0.007, c.glassTopY + 0.021,
      y => rearAt(y) - 0.015, y => frontAt(y) + 0.014, 0.012, 0.018);

    // The cab door reaches a proper van sill. Seams stop on real painted
    // surfaces instead of running through wheel openings or window panes.
    sidePanel('trim', 'van-cab-door-seam-' + suffix, side, 0.88, cabSill - 0.022,
      profile.cabRearX + 0.028, profile.cabRearX + 0.037, 0.005, 0.003);
    sidePanel('metal', 'van-cab-door-handle-' + suffix, side, 1.036, 1.074,
      profile.cabRearX + 0.14, profile.cabRearX + 0.30, 0.012, 0.020);
    box('trim', 'van-rocker-' + suffix, 0, 0.421, side * (profile.width / 2 + 0.003),
      profile.wheelbase - ARCH_RADIUS * 2 - 0.04, 0.095, 0.027);

    const mirrorY = 1.35, mirrorX = frontAt(mirrorY) - 0.26;
    const glassZ = halfAt(mirrorY), mirrorZ = profile.width / 2 + 0.075;
    box('trim', 'mirror-arm-' + suffix, mirrorX, mirrorY - 0.035, side * ((glassZ + mirrorZ - 0.046) / 2),
      0.048, 0.060, mirrorZ - 0.046 - glassZ + 0.031, { upper: true });
    box('paint', 'mirror-housing-' + suffix, mirrorX, mirrorY, side * mirrorZ,
      0.19, 0.16, 0.106, { upper: true });
    box('metal', 'mirror-face-' + suffix, mirrorX - 0.096, mirrorY, side * mirrorZ,
      0.010, 0.125, 0.084, { upper: true });

    if (profile.cargoOpaque) {
      // One sliding loading door; the opposite side remains a broad pressed
      // cargo panel. Both use subtle relief in the shared paint/trim batches.
      for (const x of [-1.62, cargoFront - 0.04]) sidePanel('trim', 'cargo-panel-seam-' + suffix + '-' + x,
        side, 0.88, c.glassTopY - 0.11, x, x + 0.009, 0.004, 0.002);
      if (side < 0) {
        sidePanel('trim', 'cargo-slider-track', side, 1.395, 1.415, -1.82, cargoFront - 0.07, 0.008, 0.012);
        sidePanel('metal', 'cargo-slider-handle', side, 1.095, 1.135, cargoFront - 0.23, cargoFront - 0.07, 0.011, 0.020);
      }
    } else {
      // Two passenger window bays are actual openings in the opaque side
      // panels. Paired glass transmits sight; it is not pasted over a solid box.
      const bays = [[y => rearAt(y) + 0.15, -1.05], [-0.90, cargoFront + 0.005]];
      sidePanel('paint', 'passenger-rear-pillar-' + suffix, side, upperBottom, upperTop,
        rearAt, y => rearAt(y) + 0.16, 0.095);
      sidePanel('paint', 'passenger-division-pillar-' + suffix, side, cargoSill - 0.01, cargoTop + 0.01, -1.065, -0.885, 0.060);
      for (const [index, [minX, maxX]] of bays.entries()) {
        const name = `passenger-side-glass-${index}-${suffix}`;
        sidePanel('glass', name, side, cargoSill, cargoTop, minX, maxX, 0.015, 0.002);
        for (const [edge, y1, y2] of [['lower', cargoSill - 0.018, cargoSill + 0.019], ['upper', cargoTop - 0.019, cargoTop + 0.016]]) {
          sidePanel('trim', `passenger-window-${index}-${edge}-${suffix}`, side, y1, y2, minX, maxX, 0.017, 0.008);
        }
        const y = (cargoSill + cargoTop) / 2, x = ((typeof minX === 'function' ? minX(y) : minX) + maxX) / 2;
        glazingRegions.push({ partName: name, probe: [x, y, side * (halfAt(y) + 0.002)], inwardDirection: [0, 0, -side] });
      }
      if (side < 0) {
        for (const x of [-1.031, cargoFront + 0.067]) sidePanel('trim', 'passenger-door-seam-' + x,
          side, 0.88, cargoTop + 0.047, x, x + 0.009, 0.005, 0.003);
        sidePanel('metal', 'passenger-door-handle', side, 1.063, 1.112, cargoFront - 0.15, cargoFront - 0.01, 0.012, 0.024);
        box('trim', 'passenger-door-step', -0.47, 0.433, -profile.width / 2 - 0.028,
          0.80, 0.067, 0.13);
      }
    }
  }

  if (profile.cargoOpaque) {
    endPanel('trim', 'cargo-rear-door-center-seam', -1, 0.88, c.glassTopY - 0.07, -0.006, 0.006, 0.006, 0.003);
    endPanel('metal', 'cargo-rear-door-handle', -1, 1.12, 1.27, -0.10, -0.06, 0.011, 0.024);
    for (const side of [-1, 1]) for (const [index, y] of [1.04, 1.67].entries()) {
      endPanel('metal', `cargo-rear-hinge-${side}-${index}`, -1, y, y + 0.11,
        yy => side > 0 ? halfAt(yy) - 0.105 : -halfAt(yy) + 0.068,
        yy => side > 0 ? halfAt(yy) - 0.068 : -halfAt(yy) + 0.105, 0.012, 0.025);
    }
  } else {
    for (const side of [-1, 1]) {
      const suffix = side > 0 ? 'left' : 'right';
      const minZ = side > 0 ? 0.032 : y => -halfAt(y) + 0.12;
      const maxZ = side > 0 ? y => halfAt(y) - 0.12 : -0.032;
      endPanel('glass', 'passenger-rear-glass-' + suffix, -1, cargoSill, cargoTop, minZ, maxZ, 0.014, 0.002);
      endPanel('paint', 'passenger-rear-corner-' + suffix, -1, upperBottom, upperTop,
        y => side > 0 ? halfAt(y) - 0.135 : -halfAt(y) - 0.004,
        y => side > 0 ? halfAt(y) + 0.004 : -halfAt(y) + 0.135, 0.065);
      const y = (cargoSill + cargoTop) / 2;
      glazingRegions.push({ partName: 'passenger-rear-glass-' + suffix,
        probe: [rearAt(y) - 0.002, y, side * halfAt(y) * 0.50], inwardDirection: [1, 0, 0] });
    }
    endPanel('paint', 'passenger-rear-center-pillar', -1, cargoSill - 0.015, cargoTop + 0.015, -0.039, 0.039, 0.058);
    endPanel('metal', 'passenger-tailgate-handle', -1, 1.031, 1.065, -0.13, 0.13, 0.012, 0.023);
  }

  for (const axleSign of [-1, 1]) for (const side of [-1, 1]) {
    const name = (axleSign > 0 ? 'front' : 'rear') + '-' + (side > 0 ? 'left' : 'right');
    const x = axleSign * profile.wheelbase / 2, z = side * (profile.width / 2 - 0.12);
    wheels.push({ name, surfaceName: 'tire:' + name, center: [x, WHEEL_RADIUS, z], radius: WHEEL_RADIUS, width: WHEEL_WIDTH });
    part(wheelTire, 'tires', 'tire:' + name, { x, y: WHEEL_RADIUS, z, rx: Math.PI / 2, dispose: false });
    part(wheelHub, 'metal', 'hub:' + name, { x, y: WHEEL_RADIUS, z: z + side * 0.133, rx: Math.PI / 2, dispose: false });
    part(wheelCenter, 'trim', 'hub-center:' + name, { x, y: WHEEL_RADIUS, z: z + side * 0.145, rx: Math.PI / 2, dispose: false });
    part(wheelArch, 'trim', 'arch:' + name, { x, y: WHEEL_RADIUS, z: side * (profile.width / 2 - 0.004), dispose: false });
  }
  for (const end of [-1, 1]) {
    part(createSedanBumper(profile.width), 'trim', end > 0 ? 'front-bumper' : 'rear-bumper', { x: end * (profile.length / 2 - 0.013), y: 0.425 });
    box('trim', end > 0 ? 'front-lamp-panel' : 'rear-lamp-panel', end * (profile.length / 2 + 0.023), 0.645, 0,
      0.052, 0.263, profile.width * 0.85);
    for (const side of [-1, 1]) {
      box('lamps', (end > 0 ? 'headlamp-' : 'tail-lamp-') + side,
        end * (profile.length / 2 + 0.058), 0.654, side * profile.width * 0.31,
        0.020, end > 0 ? 0.172 : 0.248, end > 0 ? 0.38 : 0.18, { tint: end > 0 ? 0xc4bda1 : 0x743831 });
      if (end > 0) box('lamps', 'front-indicator-' + side, profile.length / 2 + 0.059, 0.540,
        side * profile.width * 0.31, 0.019, 0.035, 0.25, { tint: 0xa87945 });
    }
    box('metal', (end > 0 ? 'front' : 'rear') + '-plate', end * (profile.length / 2 + 0.057), 0.542, 0, 0.022, 0.105, 0.29);
  }
  for (let i = 0; i < 3; i++) box('metal', 'grille-bar-' + i, profile.length / 2 + 0.052,
    0.602 + i * 0.042, 0, 0.015, 0.010, 0.55);

  const geometry = {}, names = []; let triangles = 0, geometryBytes = 0;
  for (const category of CATEGORY) {
    const parts = buckets[category], ranges = []; let first = 0;
    for (const entry of parts) {
      ranges.push(Object.freeze({ name: entry.name, vertexStart: first, vertexCount: entry.geometry.attributes.position.count }));
      first += entry.geometry.attributes.position.count; names.push(entry.name);
    }
    const merged = mergeGeometries(parts.map(entry => entry.geometry), false);
    merged.name = 'civilian-' + profile.variant + '-' + category;
    merged.userData.civilianParts = Object.freeze(ranges); merged.computeBoundingBox(); merged.computeBoundingSphere();
    triangles += merged.attributes.position.count / 3;
    geometryBytes += Object.values(merged.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
    geometry[category] = merged;
    for (const entry of parts) entry.geometry.dispose();
  }
  const cargoProbeY = (cargoSill + cargoTop) / 2, cargoProbeX = (rearAt(cargoProbeY) + 0.15 - 1.05) / 2;
  const description = freezeTree({ ...profile, wheelRadius: WHEEL_RADIUS, wheelWidth: WHEEL_WIDTH, wheels,
    cabin: { ...c, beltY: BELT_Y, roofTopY: c.glassTopY + 0.064 },
    cabWindow: { bottomY: cabSill, topY: cabTop, rearX: profile.cabRearX },
    cargo: { opaque: profile.cargoOpaque, sideProbe: [cargoProbeX, cargoProbeY, halfAt(cargoProbeY)], inwardDirection: [0, 0, -1],
      windowBottomY: cargoSill, windowTopY: cargoTop, rearX: c.baseRearX, frontX: cargoFront }, glazingRegions, parts: names });
  return { geometry, movementBounds: [localBody, localCabin], visualBounds: localBody.clone().union(localCabin), profile: description,
    resources: Object.freeze({ triangles, materialDraws: CATEGORY.length, geometryBytes, textures: 0,
      textureBytes: 0, addedLights: 0, geometrySharedByVariant: true, runtimeConstruction: false }) };
}

/**
 * Original parked-car art, built once per silhouette. Local +X is the nose,
 * +Y is up, and y=0 is the four tire contact points. Callers own placement and
 * collision registration; this factory does not import the world or gameplay.
 */
export function createCivilianVehicle({ variant = 'sedan', paint = 0x66675c, finish = 'used' } = {}) {
  if (!Object.hasOwn(CIVILIAN_VEHICLE_PROFILES, variant)) throw new RangeError('Unknown civilian vehicle variant: ' + variant);
  if (!Object.hasOwn(FINISHES, finish)) throw new RangeError('Unknown civilian finish: ' + finish);
  if (typeof paint !== 'number' || !Number.isInteger(paint) || paint < 0 || paint > 0xffffff) {
    throw new RangeError('Civilian paint must be a 24-bit integer color');
  }
  if (!geometryCache.has(variant)) {
    const profile = CIVILIAN_VEHICLE_PROFILES[variant];
    geometryCache.set(variant, profile.architecture === 'van' ? buildVanGeometry(profile) : buildGeometry(profile));
  }
  const cached = geometryCache.get(variant), materials = getMaterials(paint, finish), group = new THREE.Group();
  group.name = 'civilian-' + variant;
  for (const category of CATEGORY) {
    const mesh = new THREE.Mesh(cached.geometry[category], materials[category]);
    mesh.name = 'civilian-' + variant + '-' + category; mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.civilianVehicle = { variant, paint, finish, profile: cached.profile, resources: cached.resources };
  return { group, movementBounds: cached.movementBounds.map(box => box.clone()), visualBounds: cached.visualBounds.clone(),
    profile: cached.profile, resources: cached.resources };
}
