import * as THREE from 'three';

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = value => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const area = points => points.reduce((sum, point, i) => {
  const next = points[(i + 1) % points.length]; return sum + point[0] * next[1] - next[0] * point[1];
}, 0);

function geometry(positions, indices, name) {
  const result = new THREE.BufferGeometry();
  result.name = name;
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setIndex(indices); result.computeVertexNormals();
  result.computeBoundingBox(); result.computeBoundingSphere();
  result.userData.garmentPart = name;
  result.userData.construction = 'authored sewn surface';
  return result;
}

/** A shallow closed panel with a beveled edge and a curved, sampled face. */
function sewnPanel(name, outline, surfaceAt, { offset, depth, outward = 1, conform = false, maxEdge = Infinity }) {
  const ordered = area(outline) < 0 ? [...outline].reverse() : outline;
  // Long straight borders still travel over a curved torso. Sampling those
  // borders prevents a wide lower edge from cutting a chord through the shirt.
  const points = ordered.flatMap((point, i) => {
    const next = ordered[(i + 1) % ordered.length];
    const divisions = Math.max(1, Math.ceil(Math.hypot(next[0] - point[0], next[1] - point[1]) / maxEdge));
    return Array.from({ length: divisions }, (_, j) => [point[0] + (next[0] - point[0]) * j / divisions,
      point[1] + (next[1] - point[1]) * j / divisions]);
  });
  const count = points.length, center = points.reduce((sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count], [0, 0]);
  const positions = [], indices = [], rings = conform ? [1, 0.94, 0.50] : [1, 0.86];
  for (let ring = 0; ring < rings.length; ring++) {
    for (const point of points) {
      const x = center[0] + (point[0] - center[0]) * rings[ring];
      const y = center[1] + (point[1] - center[1]) * rings[ring];
      positions.push(x, y, outward * (surfaceAt(x, y) + offset + (ring ? depth : 0)));
    }
    if (ring) for (let i = 0; i < count; i++) {
      const next = (i + 1) % count, previous = (ring - 1) * count, current = ring * count;
      indices.push(previous + i, previous + next, current + i, previous + next, current + next, current + i);
    }
  }
  const top = positions.length / 3;
  positions.push(center[0], center[1], outward * (surfaceAt(...center) + offset + depth));
  const bottom = positions.length / 3;
  positions.push(center[0], center[1], outward * (surfaceAt(...center) + offset));
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count, last = (rings.length - 1) * count;
    indices.push(top, last + i, last + next, bottom, next, i);
  }
  if (outward < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  return geometry(positions, indices, name);
}

/** A folded ribbon with real edges, used for plackets, welts and webbing. */
function sewnRibbon(name, path, width, thickness, surfaceAt, offset, outward = 1) {
  const positions = [], indices = [];
  for (let i = 0; i < path.length; i++) {
    const previous = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
    const length = Math.hypot(next[0] - previous[0], next[1] - previous[1]);
    const nx = -(next[1] - previous[1]) / length * width / 2, ny = (next[0] - previous[0]) / length * width / 2;
    const [x, y] = path[i];
    for (const [side, raised] of [[1, 0], [-1, 0], [-1, 1], [1, 1]]) {
      const px = x + nx * side, py = y + ny * side;
      positions.push(px, py, outward * (surfaceAt(px, py) + offset + thickness * raised));
    }
    if (i) for (let j = 0; j < 4; j++) {
      const nextCorner = (j + 1) % 4, a = (i - 1) * 4, b = i * 4;
      indices.push(a + j, b + j, a + nextCorner, a + nextCorner, b + j, b + nextCorner);
    }
  }
  const last = (path.length - 1) * 4;
  indices.push(0, 1, 2, 0, 2, 3, last, last + 2, last + 1, last, last + 3, last + 2);
  if (outward < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  return geometry(positions, indices, name);
}

/** Four section loops make the edge a folded band, not an open cylinder. */
function foldedBand(name, loops, segments, pointAt, start = 0, end = TAU) {
  const closed = end - start >= TAU - 1e-6, columns = closed ? segments : segments + 1;
  const positions = [], indices = [];
  for (let row = 0; row < loops.length; row++) for (let i = 0; i < columns; i++) {
    positions.push(...pointAt(loops[row], start + (end - start) * i / segments));
  }
  for (let row = 0; row < loops.length; row++) for (let i = 0; i < segments; i++) {
    const nextRow = (row + 1) % loops.length, next = (i + 1) % columns;
    const a = row * columns + i, b = row * columns + next;
    const c = nextRow * columns + i, d = nextRow * columns + next;
    indices.push(a, b, c, b, d, c);
  }
  if (!closed) for (const endIndex of [0, columns - 1]) {
    const points = loops.map((_, row) => row * columns + endIndex);
    if (!endIndex) indices.push(points[0], points[1], points[2], points[0], points[2], points[3]);
    else indices.push(points[0], points[2], points[1], points[0], points[3], points[2]);
  }
  return geometry(positions, indices, name);
}

/**
 * All geometry is in the existing root/A-pose space. The caller assigns skin
 * attributes and merges these pieces into its one garment draw. No material,
 * texture, object, or per-frame callback is created by this construction pass.
 * frontAt accepts meters and returns the positive-Z shirt exterior in meters.
 */
export function heroGarmentDetails({ dimensions: d, role, palette, frontAt, bindArmAngle = 0.45 }) {
  const h = d.height, width = d.width, parts = [];
  const armored = ['bruiser', 'enforcer', 'player'].includes(role), shortSleeve = role === 'brawler';
  const clothEdge = palette.shirt.clone().lerp(palette.trim, 0.24);
  const stitch = palette.shirt.clone().lerp(palette.trim, 0.13);
  const webbing = palette.equipment.clone().lerp(palette.trim, 0.38);
  const chestWeights = () => ({ chest: 1 });
  const torsoWeights = (x, y) => { const chest = smooth((y / h - 0.61) / 0.15); return { spine: 1 - chest, chest }; };
  const add = (name, mesh, weightFor, color) => {
    mesh.userData.role = role;
    parts.push({ name, geometry: mesh, weightFor, colorFor: () => color });
  };
  const points = outline => outline.map(([x, y]) => [x * h * width, y * h]);
  const panel = (name, outline, color, { depth = 0.0018, offset = 0.0010, outward = 1, conform = false, surface = frontAt, weights = torsoWeights } = {}) => {
    add(name, sewnPanel(name, points(outline), surface, {
      offset: offset * h, depth: depth * h, outward, conform, maxEdge: conform ? h * 0.036 : Infinity,
    }), weights, color);
  };
  const ribbon = (name, path, bandWidth, color, { thickness = 0.0006, offset = 0.0013, outward = 1, surface = frontAt } = {}) => {
    add(name, sewnRibbon(name, points(path), bandWidth * h, thickness * h, surface, offset * h, outward), torsoWeights, color);
  };

  // The front dips into the clavicle while the back meets the raised nape.
  // This seam follows the flared neck root instead of building a tall tube.
  // A tighter sampled opening at this segment budget intersected the posed
  // neck and was rejected; retain this reviewed opening and its chest weights.
  const neckLoops = [
    { rx: 0.0445, rz: 0.0410, y: 0.8300 }, { rx: 0.0440, rz: 0.0405, y: 0.8330 },
    { rx: 0.0365, rz: 0.0340, y: 0.8375 }, { rx: 0.0360, rz: 0.0335, y: 0.8350 },
  ];
  const neckPoint = (loop, angle) => {
    const front = Math.max(0, Math.cos(angle)), back = Math.max(0, -Math.cos(angle));
    return [Math.sin(angle) * loop.rx * h * Math.sqrt(width),
      (loop.y - front * 0.009 + back * 0.005) * h, (Math.cos(angle) * loop.rz - 0.006) * h];
  };
  const openCollar = !shortSleeve && !armored;
  const collarSegments = armored ? 12 : shortSleeve ? 18 : 16;
  add('neck-fold', foldedBand('neck-fold', neckLoops, collarSegments, neckPoint,
    openCollar ? 0.28 : 0, openCollar ? TAU - 0.28 : TAU), chestWeights, clothEdge);

  for (const [side, sign] of [['L', -1], ['R', 1]]) {
    // The extracted short sleeve rounds inward before its nominal end. Bury
    // the cuff's upper loops farther into it so oblique views cannot see skin
    // between that cap and the hem; retain the same four loops and weights.
    const end = shortSleeve ? 0.381 : 0.983, beginning = shortSleeve ? 0.320 : 0.940;
    const armLength = d.upperArmLength + d.forearmLength;
    const baseRadius = (shortSleeve ? 0.0352 : 0.0240) * h * Math.sqrt(width);
    const loops = [
      { t: end, radius: baseRadius + h * 0.0012 }, { t: beginning, radius: baseRadius + h * 0.0012 },
      { t: beginning + 0.001, radius: baseRadius - h * 0.0008 }, { t: end - 0.001, radius: baseRadius - h * 0.0008 },
    ];
    const sin = Math.sin(bindArmAngle), cos = Math.cos(bindArmAngle);
    const sleevePoint = (loop, angle) => {
      const across = Math.sin(angle) * loop.radius;
      return [sign * d.shoulderSpacing + sign * sin * loop.t * armLength + cos * across,
        d.shoulderY - cos * loop.t * armLength + sign * sin * across, Math.cos(angle) * loop.radius * 1.04];
    };
    const weights = (x, y) => {
      const t = ((x - sign * d.shoulderSpacing) * sign * sin - (y - d.shoulderY) * cos) / armLength;
      const elbow = smooth((t - 0.40) / 0.24), wrist = smooth((t - 0.90) / 0.10);
      return { [`shoulder${side}`]: 1 - elbow, [`elbow${side}`]: elbow * (1 - wrist), [`wrist${side}`]: wrist };
    };
    add(`sleeve-hem.${side}`, foldedBand(`sleeve-hem.${side}`, loops, 12, sleevePoint), weights, stitch);
  }

  if (shortSleeve) {
    ribbon('shirt-bottom-hem', [[-0.075, 0.584], [-0.039, 0.580], [0, 0.579], [0.039, 0.580], [0.075, 0.584]], 0.005, stitch);
  } else if (armored) {
    const frontOutline = [[-0.070, 0.604], [0.070, 0.604], [0.091, 0.627], [0.091, 0.743],
      [0.073, 0.787], [0.043, 0.806], [-0.043, 0.806], [-0.073, 0.787], [-0.091, 0.743], [-0.091, 0.627]];
    const backOutline = [[-0.073, 0.605], [0.073, 0.605], [0.093, 0.630], [0.092, 0.755],
      [0.070, 0.802], [-0.070, 0.802], [-0.092, 0.755], [-0.093, 0.630]];
    const vestSurface = (x, y) => frontAt(x, y) + 0.0052 * h;
    panel('vest-front-panel', frontOutline, palette.equipment, { depth: 0.0042, offset: 0.0010, conform: true });
    panel('vest-back-panel', backOutline, palette.equipment, { depth: 0.0042, offset: 0.0010, conform: true, outward: -1 });

    // Wide shoulder straps cross the upper shoulder in seven sections, with
    // an underside and folded edges rather than floating dark rectangles.
    for (const sign of [-1, 1]) {
      const x = sign * 0.060 * h * width, half = 0.011 * h * width;
      const section = [[0.782, 1], [0.800, 1], [0.817, 1], [0.833, 0], [0.817, -1], [0.800, -1], [0.782, -1]];
      const positions = [], indices = [];
      for (let i = 0; i < section.length; i++) {
        const [y, side] = section[i];
        for (const [edge, top] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
          const px = x + edge * half, py = (y + (side === 0 ? 0.0017 * top : 0)) * h;
          const z = side ? side * (frontAt(px, py) + h * (0.0026 + top * 0.0017)) : 0;
          positions.push(px, py, z);
        }
        if (i) for (let j = 0; j < 4; j++) {
          const next = (j + 1) % 4, previous = (i - 1) * 4, current = i * 4;
          indices.push(previous + j, previous + next, current + j, previous + next, current + next, current + j);
        }
      }
      const last = (section.length - 1) * 4;
      indices.push(0, 2, 1, 0, 3, 2, last, last + 1, last + 2, last, last + 2, last + 3);
      for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      const name = `vest-shoulder-strap.${sign < 0 ? 'L' : 'R'}`;
      add(name, geometry(positions, indices, name), chestWeights, webbing);

      const cx = sign * 0.045;
      panel(`vest-pouch.${sign < 0 ? 'L' : 'R'}`, [[cx - 0.023, 0.636], [cx + 0.023, 0.636],
        [cx + 0.027, 0.642], [cx + 0.027, 0.697], [cx - 0.027, 0.697], [cx - 0.027, 0.642]],
      webbing, { depth: 0.0032, offset: 0.0008, surface: vestSurface });
      panel(`vest-pouch-flap.${sign < 0 ? 'L' : 'R'}`, [[cx - 0.027, 0.696], [cx + 0.027, 0.696],
        [cx + 0.026, 0.711], [cx - 0.026, 0.711]], palette.equipment,
      { depth: 0.0013, offset: 0.0044, surface: vestSurface });
    }
    ribbon('vest-chest-webbing', [[-0.069, 0.750], [0, 0.750], [0.069, 0.750]], 0.006, webbing,
      { offset: 0.0006, surface: vestSurface });
  } else {
    const jacket = role === 'thug', slim = role === 'hitman';
    for (const sign of [-1, 1]) {
      const collar = jacket ? [[0.009, 0.829], [0.033, 0.844], [0.071, 0.814], [0.043, 0.788], [0.029, 0.814]]
        : [[0.007, 0.830], [0.031, 0.843], [slim ? 0.060 : 0.064, 0.817], [slim ? 0.035 : 0.040, 0.788]];
      panel(`folded-collar.${sign < 0 ? 'L' : 'R'}`, collar.map(([x, y]) => [x * sign, y]), palette.shirt,
        { depth: 0.0020, offset: 0.0015, surface: (x, y) => Math.max(frontAt(x, y), h * 0.019), weights: chestWeights });
    }
    const closure = jacket ? palette.shirt.clone().lerp(palette.trim, 0.40) : stitch;
    ribbon(jacket ? 'jacket-zip-placket' : 'shirt-button-placket',
      [[0, 0.590], [0, 0.623], [0, 0.657], [0, 0.691], [0, 0.725], [0, 0.759], [0, 0.797]],
      jacket ? 0.008 : slim ? 0.007 : 0.009, closure, { offset: 0.0016 });
    if (jacket) {
      panel('zipper-pull', [[-0.0022, 0.776], [0.0022, 0.776], [0.0022, 0.785], [-0.0022, 0.785]],
        palette.equipment, { depth: 0.0008, offset: 0.0026 });
      for (const sign of [-1, 1]) {
        ribbon(`jacket-pocket-welt.${sign < 0 ? 'L' : 'R'}`, [[sign * 0.043, 0.636], [sign * 0.069, 0.659], [sign * 0.081, 0.671]],
          0.007, clothEdge, { offset: 0.0018 });
        const cx = sign * 0.056;
        panel(`jacket-pocket-flap.${sign < 0 ? 'L' : 'R'}`, [[cx - 0.026, 0.733], [cx + 0.026, 0.733],
          [cx + 0.026, 0.746], [cx, 0.753], [cx - 0.026, 0.746]], stitch, { depth: 0.0015 });
      }
    } else {
      const cx = -0.057;
      panel('shirt-patch-pocket', [[cx - 0.022, 0.698], [cx, 0.693], [cx + 0.022, 0.698],
        [cx + 0.022, 0.746], [cx - 0.022, 0.746]], stitch);
      panel('shirt-pocket-flap', [[cx - 0.023, 0.738], [cx, 0.734], [cx + 0.023, 0.738],
        [cx + 0.023, 0.750], [cx - 0.023, 0.750]], palette.shirt, { depth: 0.0012, offset: 0.0030 });
      for (const y of [0.635, 0.700, 0.767]) {
        const button = Array.from({ length: 6 }, (_, i) => [Math.cos(i * TAU / 6) * 0.0018, y + Math.sin(i * TAU / 6) * 0.0018]);
        panel(`shirt-button.${y}`, button, clothEdge, { depth: 0.0006, offset: 0.0024 });
      }
    }
  }
  parts.userData = {
    role, triangles: parts.reduce((sum, part) => sum + part.geometry.index.count / 3, 0),
    construction: 'folded collars, sleeve hems, beveled sewn panels and closures',
  };
  return parts;
}
