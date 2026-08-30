import * as THREE from 'three';
import { getHandMaterials, HAND_ATLAS } from './hand-materials.js';

const TAU = Math.PI * 2;
const cache = new Map();
const WRIST = new THREE.Vector3(0, -0.004, 0.092);
const GRIP_CENTER = new THREE.Vector3(0, -0.010, -0.060);
const UP = new THREE.Vector3(0, 1, 0);
// V landmarks are authored in material space, independently of subdivision.
// Adding a fold/knuckle section must not slide the glove's seams over the hand.
const profiles = [
  [0.092, 0.022, 0.0145, -0.004, 0], [0.078, 0.023, 0.015, -0.0035, 1 / 7], [0.068, 0.025, 0.0165, -0.003, 2 / 7],
  [0.066, 0.0261, 0.0174, -0.0029, 0.302], [0.064, 0.0265, 0.0172, -0.0028, 0.319],
  [0.050, 0.031, 0.019, -0.002, 3 / 7], [0.030, 0.037, 0.0215, -0.001, 4 / 7],
  [0.012, 0.040, 0.0225, 0, 5 / 7], [-0.003, 0.0407, 0.0232, 0.0007, 0.812],
  [-0.010, 0.041, 0.0235, 0.001, 6 / 7], [-0.020, 0.041, 0.0238, 0.0015, 0.922],
  [-0.032, 0.041, 0.024, 0.002, 1],
];
const signPow = (value, exponent) => Math.sign(value) * Math.pow(Math.abs(value), exponent);

/** Camera-space metres: dorsal +Y, fingertips -Z, opposed right thumb -X. */
export function createHandDigits(side = 1, radius = null) {
  const make = (name, points, digitRadius) => ({
    name, radius: digitRadius,
    rest: points.map(point => new THREE.Vector3(...point)),
    joints: points.map(point => new THREE.Vector3(...point)),
  });
  const fingers = [
    [-0.027, -0.044, 1], [-0.009, -0.049, 1.04],
    [0.010, -0.046, 0.97], [0.028, -0.040, 0.84],
  ].map(([x, z, length], index) => make(['index', 'middle', 'ring', 'little'][index], [
    [side * x, 0.015, z],
    [side * x, 0.015 - 0.006 * length, z - 0.014 * length],
    [side * x, 0.015 - 0.027 * length, z - 0.016 * length],
    [side * x, 0.015 - 0.040 * length, z + 0.003 * length],
  ], 0.0085 * Math.sqrt(length)));
  const thumb = make('thumb', [
    [-side * 0.036, 0.001, 0.019], [-side * 0.051, -0.006, -0.012], [-side * 0.030, -0.023, -0.038],
  ], 0.011);
  if (radius !== null) {
    // Fingers retain their individual reach around a handle. A single set of
    // angles made thick stocks stretch all four digits into equal-length bands.
    // The middle finger reaches furthest; the little finger has a shorter arc
    // and sits slightly lower at its knuckle. Keep the inward contact radius.
    const gripCurls = [
      [0.72, 2.85, 0.100], [0.72, 3.07, 0.108],
      [0.68, 2.91, 0.102], [0.62, 2.57, 0.087],
    ];
    for (const [fingerIndex, digit] of fingers.entries()) {
      const centerline = radius + digit.radius - 0.001;
      const [start, maximumCurl, reach] = gripCurls[fingerIndex];
      const curl = Math.min(maximumCurl, reach / centerline);
      for (const [index, along] of [0, 0.34, 0.68, 1].entries()) {
        const angle = start - curl * along;
        digit.rest[index].y = GRIP_CENTER.y + centerline * Math.cos(angle);
        digit.rest[index].z = GRIP_CENTER.z + centerline * Math.sin(angle);
      }
    }
    thumb.rest[0].set(-side * 0.035, 0.004, -0.010);
    const thumbArc = radius + thumb.radius + 0.003;
    thumb.rest[1].set(-side * 0.047, GRIP_CENTER.y - thumbArc * 0.72, GRIP_CENTER.z + thumbArc * 0.70);
    thumb.rest[2].set(-side * 0.026, GRIP_CENTER.y - thumbArc * 0.90, GRIP_CENTER.z - thumbArc * 0.435);
    for (const digit of [...fingers, thumb]) digit.joints.forEach((point, index) => point.copy(digit.rest[index]));
  }
  return { fingers, thumb, digits: [...fingers, thumb] };
}

function builder() {
  const positions = [], uv = [], colors = [], indices = [];
  const points = [], ab = new THREE.Vector3(), ac = new THREE.Vector3();
  function vertex(point, kind, u, v, tint = 1) {
    const atlas = HAND_ATLAS[kind];
    points.push(point.clone()); positions.push(point.x, point.y, point.z);
    uv.push(atlas.uMin + (atlas.uMax - atlas.uMin) * u, atlas.vMin + (atlas.vMax - atlas.vMin) * v);
    colors.push(tint, tint, tint); return points.length - 1;
  }
  function triangle(a, b, c, outward) {
    ab.subVectors(points[b], points[a]); ac.subVectors(points[c], points[a]);
    if (ab.cross(ac).dot(outward) < 0) indices.push(a, c, b);
    else indices.push(a, b, c);
  }
  function strip(a, b, centerA, centerB) {
    const center = centerA.clone().add(centerB).multiplyScalar(0.5);
    if (a.length !== b.length) {
      // Join the unchanged thumb opening to a more evenly sampled ring.
      // Integer index fractions keep this topology identical for every morph
      // pose; comparing angles would let tiny pose changes alter the zipper.
      let i = 0, j = 0;
      const face = (first, second, third) => {
        const outward = points[first].clone().add(points[second]).add(points[third])
          .multiplyScalar(1 / 3).sub(center);
        triangle(first, second, third, outward);
      };
      while (i < a.length || j < b.length) {
        const first = a[i % a.length], second = b[j % b.length];
        const nextA = (i + 1) * b.length, nextB = (j + 1) * a.length;
        if (nextA <= nextB) {
          face(first, second, a[(i + 1) % a.length]);
          i++;
        }
        if (nextB <= nextA) {
          face(a[i % a.length], second, b[(j + 1) % b.length]);
          j++;
        }
      }
      return;
    }
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      const outward = points[a[i]].clone().add(points[a[j]]).add(points[b[i]]).add(points[b[j]])
        .multiplyScalar(0.25).sub(center);
      triangle(a[i], b[i], a[j], outward); triangle(a[j], b[i], b[j], outward);
    }
  }
  return { positions, uv, colors, indices, points, vertex, triangle, strip };
}

function clenchPoints(digit, clench) {
  return digit.rest.map((point, i) => point.clone().add(new THREE.Vector3(0, -clench * i * 0.00065, clench * i * 0.0005)));
}

function appendDigit(mesh, root, pathPoints, radius, kind, clench, digit, gripRadius) {
  const center = root.reduce((sum, index) => sum.add(mesh.points[index]), new THREE.Vector3()).multiplyScalar(1 / root.length);
  const joints = clenchPoints(digit, clench);
  const path = new THREE.CatmullRomCurve3([center, ...pathPoints(joints)], false, 'centripetal');
  const collarPath = new THREE.CatmullRomCurve3([center, ...pathPoints(digit.rest)], false, 'centripetal');
  const tangent = collarPath.getTangent(0).normalize();
  const basisA = kind === 'thumb' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  basisA.addScaledVector(tangent, -basisA.dot(tangent)).normalize();
  const basisB = new THREE.Vector3().crossVectors(tangent, basisA).normalize();
  const angles = root.map(index => {
    const relative = mesh.points[index].clone().sub(center);
    return Math.atan2(relative.dot(basisB), relative.dot(basisA));
  });
  // Preserve the collar's exact vertices: the thumb web and finger roots are
  // actual openings in the palm, not intersecting capsules hidden by spheres.
  // The opened collars retain their welded topology. Uniform downstream rings
  // describe the phalanges instead of carrying a sparse palm-opening profile
  // all the way to their tips. Both endpoints use identical zipper indices.
  const winding = kind === 'thumb' ? 1 : -1;
  const ringAngles = Array.from({ length: 16 }, (_, i) => angles[0] + winding * i * TAU / 16);
  const atlasU = angle => ((angle + Math.PI) / TAU % 1 + 1) % 1;
  // The palm has a separate stitched-panel UV island. Give each finger/thumb
  // collar its own angular coordinates instead of stretching that panel down
  // the first loft strip from palm V≈.9 to digit V≈.07.
  let previous = root.map((index, i) => mesh.vertex(mesh.points[index], 'glove', atlasU(angles[i]), 0));
  let previousCenter = center, previousKind = 'glove';
  const stations = [0.07, 0.14, 0.22, 0.30, 0.39, 0.48, 0.57, 0.66, 0.75, 0.84, 0.91, 0.96, 0.988];
  const grippingFinger = kind === 'finger' && gripRadius !== null;
  for (const t of stations) {
    // Sample grip phalanges by distance, not by control-point index. Their
    // short root bridge previously consumed a third of the loft rings while
    // the much longer visible curl was left angular. The neutral path fixes
    // this correspondence for both morph targets without adding vertices.
    const pathT = grippingFinger ? collarPath.getUtoTmapping(t) : t;
    const point = path.getPoint(pathT), direction = path.getTangent(pathT).normalize();
    const a = (kind === 'thumb' ? UP : new THREE.Vector3(1, 0, 0)).clone();
    a.addScaledVector(direction, -a.dot(direction)).normalize();
    const b = new THREE.Vector3().crossVectors(direction, a).normalize();
    const tip = t > 0.84 ? Math.sqrt(Math.max(0.05, 1 - ((t - 0.84) / 0.17) ** 2)) : 1;
    const taper = 1.02 - t * 0.20;
    // Subtle broad knuckle plateaus and narrow flexion creases replace beads.
    const crease = Math.exp(-(((t - 0.48) / 0.035) ** 2)) + Math.exp(-(((t - 0.75) / 0.03) ** 2));
    const web = kind === 'thumb' && gripRadius === null ? Math.exp(-(((t - 0.10) / 0.10) ** 2)) * 0.00055 : 0;
    const thickness = radius * taper * tip * (1 - crease * 0.10) + web;
    const gloveEnd = kind === 'thumb' ? 0.30 : 0.22;
    const materialKind = t <= gloveEnd ? 'glove' : 'skin';
    if (materialKind !== previousKind) {
      // A texture seam duplicates a ring at identical positions. No triangle
      // interpolates between the atlas's skin and glove material islands.
      previous = previous.map((index, i) => mesh.vertex(mesh.points[index], materialKind, atlasU(ringAngles[i]), gloveEnd));
    }
    const loop = ringAngles.map(angle => {
      const isFinger = kind === 'finger', distal = isFinger ? Math.max(0, (t - 0.75) / 0.25) : 0;
      const distalTaper = grippingFinger ? 0.14 : 0.025;
      const p = point.clone().addScaledVector(a, Math.cos(angle) * thickness * (1 - distal * distalTaper))
        .addScaledVector(b, Math.sin(angle) * thickness * (0.90 - distal * 0.02));
      if (isFinger) {
        // A broad dorsal knuckle and flatter distal pad retain the existing
        // contact surface on the inward side of the held handle.
        const jointPlateau = Math.exp(-(((t - 0.43) / 0.09) ** 2)) + Math.exp(-(((t - 0.70) / 0.075) ** 2)) * 0.7;
        const dorsal = Math.pow(Math.max(0, -Math.sin(angle)), 4);
        p.addScaledVector(b, -jointPlateau * dorsal * 0.00045);
      }
      // Stitch/lip at the fingerless opening is part of the surface silhouette.
      if (Math.abs(t - gloveEnd) < 0.001) p.addScaledVector(p.clone().sub(point).normalize(), 0.0007);
      if (grippingFinger) {
        // The soft finger pad conforms to the known handle surface. Catmull
        // interpolation can otherwise dip through it between the authored
        // knuckles, especially where the short palm bridge enters the curl.
        const dy = p.y - GRIP_CENTER.y, dz = p.z - GRIP_CENTER.z;
        const distance = Math.hypot(dy, dz), contact = gripRadius - 0.00075;
        if (distance < contact) {
          p.y = GRIP_CENTER.y + dy * contact / distance;
          p.z = GRIP_CENTER.z + dz * contact / distance;
        }
      }
      return mesh.vertex(p, materialKind, atlasU(angle), t, 1 - crease * 0.055);
    });
    mesh.strip(previous, loop, previousCenter, point); previous = loop; previousCenter = point; previousKind = materialKind;
  }
  const tip = path.getPoint(1), cap = mesh.vertex(tip, 'skin', 0.5, 0.94);
  const outward = path.getTangent(1);
  for (let i = 0; i < previous.length; i++) mesh.triangle(previous[i], cap, previous[(i + 1) % previous.length], outward);
}

function orientSurface(mesh) {
  const edges = new Map(), faces = mesh.indices.length / 3, direction = new Int8Array(faces), links = Array.from({ length: faces }, () => []);
  const welded = new Map(), vertexIds = mesh.points.map(point => {
    const key = `${Math.round(point.x * 1e9)}:${Math.round(point.y * 1e9)}:${Math.round(point.z * 1e9)}`;
    if (!welded.has(key)) welded.set(key, welded.size);
    return welded.get(key);
  });
  for (let face = 0; face < faces; face++) {
    for (let edge = 0; edge < 3; edge++) {
      const a = vertexIds[mesh.indices[face * 3 + edge]], b = vertexIds[mesh.indices[face * 3 + (edge + 1) % 3]];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`, winding = a < b ? 1 : -1;
      const previous = edges.get(key);
      if (previous) {
        const relative = -previous.winding * winding;
        links[face].push([previous.face, relative]); links[previous.face].push([face, relative]);
      } else edges.set(key, { face, winding });
    }
  }
  for (let start = 0; start < faces; start++) {
    if (direction[start]) continue;
    direction[start] = 1;
    const stack = [start];
    while (stack.length) {
      const face = stack.pop();
      for (const [neighbor, relative] of links[face]) {
        if (direction[neighbor]) continue;
        direction[neighbor] = direction[face] * relative; stack.push(neighbor);
      }
    }
  }
  for (let face = 0; face < faces; face++) {
    if (direction[face] < 0) [mesh.indices[face * 3 + 1], mesh.indices[face * 3 + 2]] = [mesh.indices[face * 3 + 2], mesh.indices[face * 3 + 1]];
  }
  // Remove the three unused vertices inside the thumb opening. All retained
  // vertices belong to the same closed surface, with no isolated normal zeros.
  const used = new Set(mesh.indices), remap = new Map(), positions = [], uv = [], colors = [];
  for (let i = 0; i < mesh.points.length; i++) {
    if (!used.has(i)) continue;
    remap.set(i, positions.length / 3); positions.push(...mesh.positions.slice(i * 3, i * 3 + 3));
    uv.push(...mesh.uv.slice(i * 2, i * 2 + 2)); colors.push(...mesh.colors.slice(i * 3, i * 3 + 3));
  }
  mesh.positions = positions; mesh.uv = uv; mesh.colors = colors; mesh.indices = mesh.indices.map(index => remap.get(index));
}

function repairUVSeams(mesh) {
  const replacements = new Map();
  let projectionMeters = 0.20;
  for (const point of mesh.points) {
    projectionMeters = Math.max(projectionMeters, Math.abs(point.x) * 2.2, Math.abs(point.y) * 2.2, Math.abs(point.z) * 2.2);
  }
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    let triangle = mesh.indices.slice(offset, offset + 3);
    const us = triangle.map(index => mesh.uv[index * 2]), atlas = HAND_ATLAS[mesh.uv[triangle[0] * 2 + 1] < 0.5 ? 'skin' : 'glove'];
    if (Math.max(...us) - Math.min(...us) > (atlas.uMax - atlas.uMin) * 0.5) {
      for (let corner = 0; corner < 3; corner++) {
        const index = triangle[corner]; if (mesh.uv[index * 2] > 0.5) continue;
        const key = `${index}:seam`;
        if (!replacements.has(key)) {
          const next = mesh.points.length;
          mesh.points.push(mesh.points[index].clone()); mesh.positions.push(...mesh.positions.slice(index * 3, index * 3 + 3));
          mesh.colors.push(...mesh.colors.slice(index * 3, index * 3 + 3)); mesh.uv.push(atlas.uMax, mesh.uv[index * 2 + 1]);
          replacements.set(key, next);
        }
        mesh.indices[offset + corner] = replacements.get(key);
      }
      triangle = mesh.indices.slice(offset, offset + 3);
    }
    const [a, b, c] = triangle.map(index => new THREE.Vector2(...mesh.uv.slice(index * 2, index * 2 + 2)));
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) > 1e-10) continue;
    const normal = mesh.points[triangle[1]].clone().sub(mesh.points[triangle[0]])
      .cross(mesh.points[triangle[2]].clone().sub(mesh.points[triangle[0]]));
    const axis = Math.abs(normal.x) > Math.abs(normal.y) && Math.abs(normal.x) > Math.abs(normal.z) ? 'x'
      : Math.abs(normal.y) > Math.abs(normal.z) ? 'y' : 'z';
    for (let corner = 0; corner < 3; corner++) {
      const index = triangle[corner], p = mesh.points[index], next = mesh.points.length;
      const u = axis === 'x' ? p.z : p.x, v = axis === 'y' ? p.z : p.y;
      mesh.points.push(p.clone()); mesh.positions.push(p.x, p.y, p.z); mesh.colors.push(...mesh.colors.slice(index * 3, index * 3 + 3));
      // Fallback slivers sample only feature-free material: no dorsal panel or
      // unrelated skin crease may appear at an angular seam. Normalize against
      // the real hand extent so larger stock grips still stay inside padding.
      const plainV = atlas === HAND_ATLAS.glove ? 0.385 + v / projectionMeters * 0.11 : 0.365 + v / projectionMeters * 0.10;
      mesh.uv.push(atlas.uMin + (atlas.uMax - atlas.uMin) * (0.5 + u / projectionMeters), atlas.vMin + (atlas.vMax - atlas.vMin) * plainV);
      mesh.indices[offset + corner] = next;
    }
  }
}

function computeWeldedNormals(geometry) {
  const groups = new Map(), vertexGroups = [], position = geometry.attributes.position;
  const normal = geometry.attributes.normal || new THREE.Float32BufferAttribute(new Float32Array(position.array.length), 3);
  geometry.setAttribute('normal', normal);
  for (let i = 0; i < position.count; i++) {
    const key = `${Math.round(position.getX(i) * 1e8)}:${Math.round(position.getY(i) * 1e8)}:${Math.round(position.getZ(i) * 1e8)}`;
    if (!groups.has(key)) groups.set(key, new THREE.Vector3());
    vertexGroups.push(groups.get(key));
  }
  const indices = geometry.index, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  // Sum unnormalized face contributions once per physical vertex. Averaging
  // already-normalized UV-island normals made their lighting depend on how
  // many seam copies a face happened to need, creating false shading facets.
  for (let i = 0; i < indices.count; i += 3) {
    const first = indices.getX(i), second = indices.getX(i + 1), third = indices.getX(i + 2);
    a.fromBufferAttribute(position, first); b.fromBufferAttribute(position, second); c.fromBufferAttribute(position, third);
    b.sub(a).cross(c.sub(a));
    vertexGroups[first].add(b); vertexGroups[second].add(b); vertexGroups[third].add(b);
  }
  for (const group of groups.values()) group.normalize();
  for (let i = 0; i < position.count; i++) {
    const group = vertexGroups[i]; normal.setXYZ(i, group.x, group.y, group.z);
  }
}

function buildHand(side, radius, clench) {
  const mesh = builder(), { fingers, thumb } = createHandDigits(1, radius);
  const rows = [], centers = [], perimeter = 40, thumbStart = perimeter / 2 - 2, thumbEnd = perimeter / 2 + 2;
  const thumbRow = profiles.findIndex(profile => profile[0] === 0.050);
  for (let row = 0; row < profiles.length; row++) {
    const [z, width, depth, cy, v] = profiles[row], center = new THREE.Vector3(0, cy, z);
    centers.push(center);
    rows.push(Array.from({ length: perimeter }, (_, i) => {
      const angle = i / perimeter * TAU, x = signPow(Math.cos(angle), 0.67) * width;
      let y = signPow(Math.sin(angle), 0.78) * depth + cy;
      if (y > cy && z < 0.05) {
        const spread = 0.42 + Math.min(1, Math.max(0, (0.05 - z) / 0.082)) * 0.58;
        const metacarpals = fingers.reduce((sum, digit) => sum + Math.exp(-(((x - digit.rest[0].x * spread) / 0.0065) ** 2)), 0);
        const dorsal = Math.pow(Math.max(0, (y - cy) / depth), 3);
        y += metacarpals * dorsal * (0.00125 + Math.exp(-(((z + 0.022) / 0.022) ** 2)) * 0.003);
      }
      return mesh.vertex(new THREE.Vector3(x, y, z), row <= 2 ? 'skin' : 'glove', i / perimeter, v);
    }));
  }
  for (let row = 0; row < rows.length - 1; row++) {
    const start = row === 2 ? rows[row].map((index, i) => mesh.vertex(mesh.points[index], 'glove', i / perimeter, profiles[row][4])) : rows[row];
    for (let i = 0; i < perimeter; i++) {
      // A real side opening is reserved for the thumb and thenar web.
      if (row >= thumbRow && row < thumbRow + 2 && i >= thumbStart && i < thumbEnd) continue;
      const j = (i + 1) % perimeter;
      const outward = mesh.points[rows[row][i]].clone().sub(centers[row]);
      mesh.triangle(start[i], rows[row + 1][i], start[j], outward);
      mesh.triangle(start[j], rows[row + 1][i], rows[row + 1][j], outward);
    }
  }
  const rearLoop = rows[0].map(index => { const p = mesh.points[index]; return mesh.vertex(p, 'skin', 0.5 + p.x / 0.06, 0.5 + p.y / 0.06); });
  const rear = mesh.vertex(centers[0], 'skin', 0.5, 0.5);
  for (let i = 0; i < perimeter; i++) mesh.triangle(rear, rearLoop[i], rearLoop[(i + 1) % perimeter], new THREE.Vector3(0, 0, 1));
  const collars = fingers.map(digit => Array.from({ length: 12 }, (_, i) => {
    const angle = i / 12 * TAU;
    return mesh.vertex(new THREE.Vector3(digit.rest[0].x + Math.cos(angle) * digit.radius * 0.93,
      0.009 + Math.sin(angle) * digit.radius * 1.10, -0.032), 'glove', i / 12, 0.91);
  }));
  const front = rows.at(-1), contour = front.map(index => new THREE.Vector2(mesh.points[index].x, mesh.points[index].y));
  const holes = collars.map(loop => loop.map(index => new THREE.Vector2(mesh.points[index].x, mesh.points[index].y)));
  const frontIndices = [...front, ...collars.flat()].map(index => {
    // The small webs between digits use the glove's plain fabric region. The
    // dorsal leather panel must not repeat on the forward-facing palm closure.
    const p = mesh.points[index]; return mesh.vertex(p, 'glove', 0.5 + p.x / 0.10, 0.385 + p.y / 0.065 * 0.11);
  });
  for (const triangle of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    mesh.triangle(...triangle.map(index => frontIndices[index]), new THREE.Vector3(0, 0, -1));
  }
  for (const [index, digit] of fingers.entries()) {
    appendDigit(mesh, collars[index], joints => joints, digit.radius, 'finger', clench, digit, radius);
  }
  const thumbCollar = [
    ...rows[thumbRow].slice(thumbStart, thumbEnd + 1), rows[thumbRow + 1][thumbEnd],
    ...rows[thumbRow + 2].slice(thumbStart, thumbEnd + 1).reverse(), rows[thumbRow + 1][thumbStart],
  ];
  appendDigit(mesh, thumbCollar, joints => joints, thumb.radius, 'thumb', clench, thumb, radius);
  repairUVSeams(mesh);
  orientSurface(mesh);
  if (side < 0) {
    for (let i = 0; i < mesh.positions.length; i += 3) mesh.positions[i] *= -1;
    for (let i = 0; i < mesh.indices.length; i += 3) [mesh.indices[i + 1], mesh.indices[i + 2]] = [mesh.indices[i + 2], mesh.indices[i + 1]];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(mesh.positions.length), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uv, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(mesh.colors, 3));
  geometry.setIndex(mesh.indices);
  // UV islands share a smooth geometric normal at the fingerless cut edge.
  computeWeldedNormals(geometry);
  geometry.userData.authoredHand = { kind: radius === null ? 'fist' : 'grip', side, radius, connected: true };
  return geometry;
}

function sleeveGeometry(cuff = false) {
  const positions = [], uv = [], indices = [], radial = 24;
  const rings = cuff ? 7 : 15;
  const sleeveSections = [0, 0.09, 0.18, 0.27, 0.36, 0.45, 0.54, 0.63, 0.72, 0.79, 0.84, 0.89, 0.94, 0.975, 1];
  for (let row = 0; row < rings; row++) {
    const t = cuff ? row / (rings - 1) : sleeveSections[row], y = t - 0.5;
    for (let i = 0; i <= radial; i++) {
      const angle = i / radial * TAU;
      const hem = Math.exp(-(((t - 0.97) / 0.026) ** 2)) * 0.0008 - Math.exp(-(((t - 0.935) / 0.018) ** 2)) * 0.00065;
      const wristTaper = Math.max(0, (t - 0.85) / 0.15);
      const radius = cuff ? 0.98 + Math.sin(t * Math.PI) * 0.045 - t * t * 0.115
        : 0.044 - t * 0.013 + hem - wristTaper * wristTaper * 0.00055;
      const fold = cuff ? 0 : (Math.sin(t * 4.6 * Math.PI + Math.sin(angle) * 1.4) * 0.0015
        + Math.sin(t * 9 * Math.PI - Math.cos(angle) * 2) * 0.0007) * Math.sin(t * Math.PI)
        + Math.sin(angle * 5 + t * 3) * Math.exp(-(((t - 0.84) / 0.14) ** 2)) * Math.sin(t * Math.PI) * 0.0020;
      positions.push(Math.cos(angle) * (radius + fold), y, Math.sin(angle) * (radius + fold) * 0.94);
      uv.push(i / radial, t);
    }
  }
  for (let row = 0; row < rings - 1; row++) {
    for (let i = 0; i < radial; i++) {
      const a = row * (radial + 1) + i, b = a + radial + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Closed ends remain covered by the hand/camera crop but avoid open sleeves.
  for (const row of [0, rings - 1]) {
    const center = positions.length / 3; positions.push(0, row / (rings - 1) - 0.5, 0); uv.push(0.5, 0.5);
    for (let i = 0; i < radial; i++) {
      const a = row * (radial + 1) + i;
      if (row === 0) indices.push(center, a, a + 1); else indices.push(center, a + 1, a);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices);
  computeWeldedNormals(geometry); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.authoredSleeve = true; return geometry;
}

let armGeometry = null, cuffGeometry = null;
export function getHandArmGeometry() {
  if (!armGeometry) { armGeometry = sleeveGeometry(); cuffGeometry = sleeveGeometry(true); }
  return { sleeve: armGeometry, cuff: cuffGeometry };
}

/** Immutable shared buffers; clenching changes one GPU morph influence only. */
export function getAuthoredHandGeometry(side = 1, radius = null) {
  const key = `${side}:${radius}`;
  if (cache.has(key)) return cache.get(key);
  const geometry = buildHand(side, radius, 0), clenched = buildHand(side, radius, 1);
  geometry.morphTargetsRelative = true;
  for (const name of ['position', 'normal']) {
    const base = geometry.attributes[name], target = clenched.attributes[name], values = new Float32Array(base.array.length);
    for (let i = 0; i < values.length; i++) values[i] = target.array[i] - base.array[i];
    geometry.morphAttributes[name] = [new THREE.Float32BufferAttribute(values, 3)];
  }
  clenched.dispose(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  cache.set(key, geometry); return geometry;
}

/**
 * Owned static meshes for firearm batching. The +X shaft passes through the
 * origin, dorsal palm is +Y, and the wrist trails +Z. No timers or bones.
 */
export function createAuthoredGripHand({ side = 1, radius = 0.022, forearmLength = 0.14, forearmDirection = null } = {}) {
  const root = new THREE.Group(), materials = getHandMaterials(), geometry = getAuthoredHandGeometry(side, radius).clone();
  geometry.morphAttributes = {}; geometry.translate(-GRIP_CENTER.x, -GRIP_CENTER.y, -GRIP_CENTER.z);
  const hand = new THREE.Mesh(geometry, materials.hand); hand.name = 'authored-grip-hand'; root.add(hand);
  const wrist = WRIST.clone().sub(GRIP_CENTER); root.userData.wristAnchor = wrist.clone();
  if (forearmLength > 0) {
    const sleeve = new THREE.Mesh(getHandArmGeometry().sleeve.clone(), materials.sleeve);
    const direction = forearmDirection?.isVector3 ? forearmDirection.clone() : new THREE.Vector3(...(forearmDirection || [side * 0.35, 0, 1]));
    if (direction.lengthSq() < 1e-12) direction.set(side * 0.35, 0, 1);
    direction.normalize();
    sleeve.name = 'authored-grip-sleeve'; sleeve.position.copy(wrist).addScaledVector(direction, forearmLength * 0.5);
    sleeve.quaternion.setFromUnitVectors(UP, direction.clone().negate()); sleeve.scale.y = forearmLength; root.add(sleeve);
  }
  root.userData.presentation = { authoredHand: true, triangles: root.children.reduce((sum, child) => sum + child.geometry.index.count / 3, 0) };
  return root;
}
