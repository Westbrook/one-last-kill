import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { applyBoxWorldUV } from './world-uv.js';
import { authoredFurnitureCacheKey, createAuthoredFurnitureGeometry } from './authored-furniture.js';

// Only the authored room builders request these shapes, once during boot.
// A key includes real dimensions so neither bevel radii nor texture density
// change when the same profile is reused by a differently sized furnishing.
const cache = new Map();
const keyOf = values => values.map(value => typeof value === 'number' ? value.toFixed(6) : value).join(':');
function cached(key, build) {
  key = `${authoredFurnitureCacheKey()}:${key}`;
  if (!cache.has(key)) {
    const geometry = build();
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    cache.set(key, geometry);
  }
  return cache.get(key);
}
function dimensions(...values) {
  if (values.some(value => !Number.isFinite(value) || value <= 0)) throw new RangeError('Furniture dimensions must be positive and finite');
}

// Tiny milled edges need only six faces, twelve bevel strips and eight corner
// triangles. Smooth vertex normals soften the 44-triangle shell; dense rounded
// boxes are reserved for the upholstery silhouettes seen across the room.
function chamferedBox(width, height, depth, radius) {
  const half = [width / 2 - radius, height / 2 - radius, depth / 2 - radius];
  const positions = [], normals = [];
  const vertex = (signs, normal) => ({
    p: signs.map((sign, axis) => sign * half[axis] + normal[axis] * radius), n: normal,
  });
  const axisNormal = (axis, sign) => [0, 1, 2].map(index => index === axis ? sign : 0);
  const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3(), face = new THREE.Vector3();
  function polygon(points) {
    for (let i = 1; i < points.length - 1; i++) {
      let triangle = [points[0], points[i], points[i + 1]];
      edge1.fromArray(triangle[1].p).sub(new THREE.Vector3().fromArray(triangle[0].p));
      edge2.fromArray(triangle[2].p).sub(new THREE.Vector3().fromArray(triangle[0].p));
      face.crossVectors(edge1, edge2);
      const outward = triangle.reduce((sum, point) => sum.add(new THREE.Vector3().fromArray(point.n)), new THREE.Vector3());
      if (face.dot(outward) < 0) triangle = [triangle[0], triangle[2], triangle[1]];
      for (const point of triangle) { positions.push(...point.p); normals.push(...point.n); }
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    const other = [0, 1, 2].filter(index => index !== axis);
    for (const sign of [-1, 1]) polygon([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(pair => {
      const signs = [0, 0, 0]; signs[axis] = sign;
      other.forEach((index, i) => { signs[index] = pair[i]; });
      return vertex(signs, axisNormal(axis, sign));
    }));
  }
  for (const [a, b, along] of [[0, 1, 2], [1, 2, 0], [2, 0, 1]]) {
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
      const signs = [0, 0, 0]; signs[a] = sa; signs[b] = sb;
      polygon([[-1, a, sa], [1, a, sa], [1, b, sb], [-1, b, sb]].map(([level, axis, sign]) => {
        signs[along] = level; return vertex(signs, axisNormal(axis, sign));
      }));
    }
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const signs = [sx, sy, sz];
    polygon(signs.map((sign, axis) => vertex(signs, axisNormal(axis, sign))));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2));
  return geometry;
}

/** Rounded padding or a small milled edge, with the original outer bounds. */
export function furnitureBox(width, height, depth, radius = 0.012, meters = 1, segments = 1, unit = false) {
  dimensions(width, height, depth, radius, meters);
  if (segments !== 1 && segments !== 2) throw new RangeError('Furniture bevels use one or two segments');
  radius = Math.min(radius, width * 0.49, height * 0.49, depth * 0.49);
  return cached(keyOf(['box', width, height, depth, radius, meters, segments, unit]), () => {
    const geometry = createAuthoredFurnitureGeometry(segments === 1 ? 'milled-box' : 'soft-box', { width, height, depth, radius, meters })
      ?? (segments === 1 ? chamferedBox(width, height, depth, radius)
        : new RoundedBoxGeometry(width, height, depth, segments, radius));
    geometry.type = 'FurnitureRoundedBoxGeometry';
    applyBoxWorldUV(geometry, meters);
    if (unit) geometry.scale(1 / width, 1 / height, 1 / depth);
    geometry.userData.furnitureShape = { kind: 'rounded-box', width, height, depth, radius, segments, unit };
    return geometry;
  });
}

/**
 * A tapered square leg with chamfered corners and a turned shoulder/collar.
 * The middle collar retains the old leg's full flat ballistic contact faces;
 * the narrow foot and upper shoulder still meet the floor and tabletop.
 */
export function furnitureLeg(width, height, depth, meters = 0.6) {
  dimensions(width, height, depth, meters);
  return cached(keyOf(['leg', width, height, depth, meters]), () => {
    const authored = createAuthoredFurnitureGeometry('profiled-leg', { width, height, depth, meters });
    if (authored) {
      authored.userData.furnitureShape = { kind: 'profiled-leg', width, height, depth };
      return authored;
    }
    const profile = [[0, 0.64], [0.06, 0.64], [0.10, 0.77], [0.43, 0.80],
      [0.47, 1], [0.55, 1], [0.60, 0.82], [0.91, 0.86], [0.94, 1], [1, 1]];
    const cross = [[-0.76, -1], [0.76, -1], [1, -0.76], [1, 0.76],
      [0.76, 1], [-0.76, 1], [-1, 0.76], [-1, -0.76]];
    const positions = [], normals = [], uv = [], indices = [];
    for (const [level, scale] of profile) {
      for (let point = 0; point <= cross.length; point++) {
        const [x, z] = cross[point % cross.length];
        positions.push(x * width * scale / 2, (level - 0.5) * height, z * depth * scale / 2);
        normals.push(x, 0, z);
        uv.push(level * height / meters, point / cross.length * (width + depth) * 2 / meters);
      }
    }
    const row = cross.length + 1;
    for (let level = 0; level < profile.length - 1; level++) {
      for (let point = 0; point < cross.length; point++) {
        const a = level * row + point, b = a + row;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    for (const [level, upward] of [[0, false], [profile.length - 1, true]]) {
      const center = positions.length / 3;
      positions.push(0, (profile[level][0] - 0.5) * height, 0);
      normals.push(0, upward ? 1 : -1, 0); uv.push(0, 0);
      for (let point = 0; point < cross.length; point++) {
        const a = level * row + point, b = a + 1;
        if (upward) indices.push(center, b, a);
        else indices.push(center, a, b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    // The UV wrap needs distinct vertices but must not become a hard seam.
    const normalAttribute = geometry.attributes.normal;
    const first = new THREE.Vector3(), last = new THREE.Vector3();
    for (let level = 0; level < profile.length; level++) {
      const start = level * row, end = start + cross.length;
      first.fromBufferAttribute(normalAttribute, start);
      last.fromBufferAttribute(normalAttribute, end);
      first.add(last).normalize();
      normalAttribute.setXYZ(start, first.x, first.y, first.z);
      normalAttribute.setXYZ(end, first.x, first.y, first.z);
    }
    geometry.userData.furnitureShape = { kind: 'profiled-leg', width, height, depth };
    return geometry;
  });
}

/** Five-sided piping follows actual rounded corners, with no alpha texture. */
export function furniturePiping(width, height, corner = 0.035, radius = 0.0025, plane = 'xy', meters = 0.3) {
  dimensions(width, height, corner, radius, meters);
  if (!['xy', 'xz'].includes(plane)) throw new RangeError('Unsupported piping plane');
  corner = Math.min(corner, width * 0.45, height * 0.45);
  return cached(keyOf(['piping', width, height, corner, radius, plane, meters]), () => {
    const points = [], positions = [], normals = [], uv = [], indices = [];
    const centers = [[width / 2 - corner, -height / 2 + corner, -Math.PI / 2],
      [width / 2 - corner, height / 2 - corner, 0],
      [-width / 2 + corner, height / 2 - corner, Math.PI / 2],
      [-width / 2 + corner, -height / 2 + corner, Math.PI]];
    for (const [x, y, start] of centers) {
      for (let segment = 0; segment <= 4; segment++) {
        const angle = start + segment * Math.PI / 8, nx = Math.cos(angle), ny = Math.sin(angle);
        points.push({ x: x + nx * corner, y: y + ny * corner, nx, ny });
      }
    }
    let distance = 0;
    const sides = 5, row = sides + 1;
    for (let ring = 0; ring <= points.length; ring++) {
      const point = points[ring % points.length];
      if (ring) {
        const previous = points[(ring - 1) % points.length];
        distance += Math.hypot(point.x - previous.x, point.y - previous.y);
      }
      for (let side = 0; side <= sides; side++) {
        const angle = side / sides * Math.PI * 2, out = Math.cos(angle), z = Math.sin(angle);
        positions.push(point.x + point.nx * out * radius, point.y + point.ny * out * radius, z * radius);
        normals.push(point.nx * out, point.ny * out, z);
        uv.push(distance / meters, side / sides * Math.PI * radius * 2 / meters);
      }
    }
    for (let ring = 0; ring < points.length; ring++) {
      for (let side = 0; side < sides; side++) {
        const a = ring * row + side, b = a + row;
        indices.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    if (plane === 'xz') geometry.rotateX(Math.PI / 2);
    geometry.userData.furnitureShape = { kind: 'piping', width, height, radius, plane };
    return geometry;
  });
}

/** Unit dimensions, with the knob face pointing in the fixture's local +Z. */
export function furnitureKnob() {
  return cached('knob', () => createAuthoredFurnitureGeometry('knob')
    ?? new THREE.CylinderGeometry(0.5, 0.5, 1, 12).rotateX(Math.PI / 2));
}

export function furnitureCup() {
  return cached('cup', () => {
    const authored = createAuthoredFurnitureGeometry('cup', { meters: 0.3 });
    if (authored) return authored;
    // A closed ceramic wall and rim; the open top is a real recess.
    const profile = [[0, 0], [0.033, 0], [0.037, 0.009], [0.044, 0.10],
      [0.040, 0.10], [0.034, 0.015], [0, 0.015]].map(point => new THREE.Vector2(...point));
    return new THREE.LatheGeometry(profile, 16);
  });
}

export function furnitureCupHandle() {
  return cached('cup-handle', () => {
    const authored = createAuthoredFurnitureGeometry('cup-handle', { meters: 0.3 });
    if (authored) return authored;
    // An exterior half-loop ends within the tapered cup wall; a full torus
    // would put its hidden crescent visibly through the hollow bowl.
    const curve = new THREE.Curve();
    curve.getPoint = (t, target = new THREE.Vector3()) => {
      const angle = -Math.PI / 2 + t * Math.PI;
      return target.set(Math.cos(angle) * 0.024 + Math.sin(angle) * 0.0022,
        Math.sin(angle) * 0.029, 0);
    };
    return new THREE.TubeGeometry(curve, 16, 0.003, 6, false);
  });
}

export function furnitureGeometryBudget() {
  let triangles = 0, bytes = 0;
  for (const geometry of cache.values()) {
    triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    bytes += Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
    bytes += geometry.index?.array.byteLength ?? 0;
  }
  return { geometries: cache.size, triangles, bytes };
}
