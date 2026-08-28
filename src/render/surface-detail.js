import { clamp, mulberry32, TAU } from '../core/math.js';

// A full map covers this many world meters. Materials use repeat=(1,1);
// geometry can divide its world coordinates by this value without guessing
// whether a material has another hidden repeat multiplier.
export const SURFACE_METERS = Object.freeze({
  brick: 0.78, plaster: 2.4, concrete: 2, wood: 4, metal: 1.2,
  asphalt: 2, tar: 2, roofMetal: 1.6, agedStone: 2.4,
  rubber: 0.6, gravel: 1.2, tile: 1.2, wallpaper: 0.8, glass: 1,
});

// Roughness is authored directly in its physical range, never multiplied by
// a mid-gray height map. R/G/B in the data map are AO / roughness / metalness.
export const SURFACE_SPECS = Object.freeze({
  concrete: { color: [103, 104, 98], roughness: [0.86, 0.98], normalScale: 0.7, seed: 4001 },
  wood: { color: [77, 68, 59], roughness: [0.79, 0.96], normalScale: 0.5, seed: 5001 },
  metal: { color: [87, 91, 89], roughness: [0.60, 0.91], normalScale: 0.65, metallic: true, seed: 6001 },
  asphalt: { color: [36, 38, 37], roughness: [0.78, 0.97], normalScale: 0.7, seed: 7001 },
  tar: { color: [41, 43, 40], roughness: [0.79, 0.96], normalScale: 0.65, seed: 8001 },
  roofMetal: { color: [101, 106, 102], roughness: [0.63, 0.92], normalScale: 0.75, metallic: true, seed: 10001 },
  agedStone: { color: [130, 127, 115], roughness: [0.87, 0.99], normalScale: 0.65, seed: 11001 },
  rubber: { color: [29, 31, 30], roughness: [0.86, 0.99], normalScale: 0.45, seed: 12001 },
  gravel: { color: [84, 85, 77], roughness: [0.88, 0.99], normalScale: 0.7, seed: 13001 },
  tile: { color: [157, 153, 138], roughness: [0.55, 0.88], normalScale: 0.65, seed: 14001 },
});

const smooth = (low, high, value) => {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
};
const modulo = (value, span) => ((value % span) + span) % span;
const RUST_COLOR = [93, 73, 54];

function cellNoise(x, y, seed) {
  let h = Math.imul(x + 317, 374761393) ^ Math.imul(y + 733, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function periodicNoise(seed, cells) {
  const random = mulberry32(seed), values = new Float32Array(cells * cells);
  for (let i = 0; i < values.length; i++) values[i] = random();
  return (u, v) => {
    const x = modulo(u, 1) * cells, y = modulo(v, 1) * cells;
    const ix = Math.floor(x), iy = Math.floor(y);
    const sx = smooth(0, 1, x - ix), sy = smooth(0, 1, y - iy);
    const a = values[iy * cells + ix], b = values[iy * cells + (ix + 1) % cells];
    const c = values[((iy + 1) % cells) * cells + ix];
    const d = values[((iy + 1) % cells) * cells + (ix + 1) % cells];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function seamDistance(value, divisions, offset = 0) {
  const t = modulo(value * divisions + offset, 1);
  return Math.min(t, 1 - t) / divisions;
}

function stoneCells(seed, cells) {
  const rng = mulberry32(seed), points = new Float32Array(cells * cells * 3);
  for (let i = 0; i < points.length; i += 3) {
    points[i] = 0.2 + rng() * 0.6; points[i + 1] = 0.2 + rng() * 0.6; points[i + 2] = rng();
  }
  // Write to caller-owned storage: generating gravel does not allocate one
  // object per texel, and there are no individual pebble meshes to render.
  return (u, v, result) => {
    const x = u * cells, y = v * cells, ix = Math.floor(x), iy = Math.floor(y);
    let nearest = 10, next = 10, tone = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const index = (modulo(iy + dy, cells) * cells + modulo(ix + dx, cells)) * 3;
        const px = ix + dx + points[index] - x, py = iy + dy + points[index + 1] - y;
        const distance = px * px + py * py;
        if (distance < nearest) { next = nearest; nearest = distance; tone = points[index + 2]; }
        else if (distance < next) next = distance;
      }
    }
    result[0] = Math.sqrt(nearest); result[1] = Math.sqrt(next); result[2] = tone;
  };
}

/** Heights are meters in image row order. Upload these maps with flipY=true. */
export function normalsFromHeights(heights, width, height, surfaceMeters, duplicateEdges = false) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
    || heights.length !== width * height || !Number.isFinite(surfaceMeters) || surfaceMeters <= 0) throw new RangeError('Invalid height field');
  const data = new Uint8Array(width * height * 4);
  const periodX = duplicateEdges ? width - 1 : width, periodY = duplicateEdges ? height - 1 : height;
  const sx = periodX / (2 * surfaceMeters), sy = periodY / (2 * surfaceMeters);
  for (let y = 0; y < height; y++) {
    const up = modulo(y - 1, periodY), down = (y + 1) % periodY;
    for (let x = 0; x < width; x++) {
      const left = modulo(x - 1, periodX), right = (x + 1) % periodX;
      const row = y % periodY, col = x % periodX;
      const nx = -(heights[row * width + right] - heights[row * width + left]) * sx;
      // Image rows run down, texture V runs up after flipY.
      const ny = (heights[down * width + col] - heights[up * width + col]) * sy;
      const inverseLength = 1 / Math.hypot(nx, ny, 1), offset = (y * width + x) * 4;
      data[offset] = Math.round((nx * inverseLength * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((ny * inverseLength * 0.5 + 0.5) * 255);
      data[offset + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
      data[offset + 3] = 255;
    }
  }
  return data;
}

/** Bake one repeatable, coordinated material set. Called only by lazy material construction. */
export function bakeSurfaceData(kind, { size = 512, seed = SURFACE_SPECS[kind]?.seed } = {}) {
  const spec = SURFACE_SPECS[kind];
  if (!spec) throw new RangeError(`Unknown surface: ${kind}`);
  if (!Number.isInteger(size) || size < 32 || size > 512) throw new RangeError('Surface size must be 32..512');
  const coarseNoise = periodicNoise(seed + 1, 8), fineNoise = periodicNoise(seed + 2, 64);
  const grainNoise = periodicNoise(seed + 3, 192);
  const gravelCells = kind === 'gravel' ? stoneCells(seed + 4, 48) : null;
  const stone = new Float32Array(3);
  const albedo = new Uint8Array(size * size * 4), orm = new Uint8Array(albedo.length);
  const heights = new Float32Array(size * size), meters = SURFACE_METERS[kind];
  const edgeWidth = 0.65 / (size - 1);
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1), px = x % (size - 1), py = y % (size - 1);
      const coarse = coarseNoise(u, v), fine = fineNoise(u, v), grain = grainNoise(u, v);
      const grit = cellNoise(px, py, seed);
      let variation = (coarse - 0.5) * 3 + (fine - 0.5) * 6 + (grit - 0.5) * 3;
      let relief = (grain - 0.5) * 0.0004;
      let roughness = 0.9 + (fine - 0.5) * 0.06, metalness = 0, rust = 0;

      if (kind === 'concrete') {
        const pore = 1 - smooth(0.03, 0.15, grit);
        variation += (grain - 0.5) * 5 - pore * 4;
        relief = (grain - 0.5) * 0.00075 - pore * 0.0005;
        roughness = 0.92 + pore * 0.05 + (fine - 0.5) * 0.05;
      } else if (kind === 'wood') {
        const row = Math.floor(modulo(v, 1) * 16);
        const offset = ((row * 97) % 256) / 512;
        const board = Math.floor(modulo(u - offset, 1) * 2);
        const tone = (cellNoise(board, row, seed) - 0.5) * 7;
        const fiber = Math.pow((Math.sin(v * TAU * 176 + Math.sin(u * TAU * 2) * 0.7) + 1) / 2, 8);
        const joint = 1 - smooth(edgeWidth * 0.25, edgeWidth, Math.min(seamDistance(v, 16), seamDistance(u - offset, 2)));
        variation = tone + (fine - 0.5) * 2 - fiber * 4 - joint * 14;
        relief = (grain - 0.5) * 0.00015 - fiber * 0.00018 - joint * 0.00095;
        roughness = 0.85 + fiber * 0.04 + joint * 0.08 + (coarse - 0.5) * 0.05;
      } else if (kind === 'asphalt') {
        const aggregate = smooth(0.39, 0.76, fine);
        variation = (coarse - 0.5) * 2.5 + aggregate * 7 + (grit - 0.5) * 5;
        relief = aggregate * 0.0016 + (grain - 0.5) * 0.0007;
        roughness = 0.85 + aggregate * 0.07 + (grain - 0.5) * 0.045;
      } else if (kind === 'tar') {
        const row = Math.floor(modulo(v, 1) * 2);
        const edge = 1 - smooth(0.001, 0.004, seamDistance(v, 2));
        const end = 1 - smooth(0.001, 0.003, seamDistance(u, 1, row * 0.5));
        const overlap = Math.max(edge, end * 0.6);
        variation = (grain - 0.5) * 6 + (fine - 0.5) * 3 - overlap * 7;
        relief = (grain - 0.5) * 0.0006 + overlap * 0.0022;
        roughness = 0.91 + (fine - 0.5) * 0.04 - overlap * 0.10;
      } else if (kind === 'metal' || kind === 'roofMetal') {
        const brushing = Math.sin(v * TAU * 104 + fine * 0.3);
        rust = smooth(0.65, 0.83, coarse * 0.35 + fine * 0.65);
        variation = (fine - 0.5) * 7 + (grain - 0.5) * 3 + brushing * 0.65;
        relief = brushing * 0.000035 + (grain - 0.5) * 0.00016 + rust * 0.0003;
        roughness = 0.68 + rust * 0.20 + (grain - 0.5) * 0.08;
        metalness = 0.70 * (1 - rust) + 0.06 * rust;
        if (kind === 'roofMetal') {
          const rib = 1 - smooth(0.001, 0.004, seamDistance(u, 4));
          relief += rib * 0.006;
          variation -= rib * 3;
          roughness += 0.03;
        }
      } else if (kind === 'agedStone' || kind === 'tile') {
        const rows = kind === 'tile' ? 4 : 8, columns = 4;
        const row = Math.floor(modulo(v, 1) * rows), stagger = kind === 'tile' ? 0 : (row % 2) * 0.5;
        const col = Math.floor(modulo(u * columns + stagger, columns));
        const gap = 1 - smooth(0.001, kind === 'tile' ? 0.003 : 0.0025,
          Math.min(seamDistance(u, columns, stagger), seamDistance(v, rows)));
        const tileTone = (cellNoise(col, row, seed) - 0.5) * (kind === 'tile' ? 7 : 10);
        variation = tileTone + (fine - 0.5) * 3 + (grit - 0.5) * 2 - gap * (kind === 'tile' ? 25 : 12);
        relief = (grain - 0.5) * (kind === 'tile' ? 0.00008 : 0.00065) - gap * 0.0022;
        roughness = kind === 'tile' ? 0.62 + gap * 0.25 + (fine - 0.5) * 0.08 : 0.93 + (fine - 0.5) * 0.04 + gap * 0.03;
      } else if (kind === 'rubber') {
        variation = (fine - 0.5) * 2 + (grain - 0.5) * 3;
        relief = (grain - 0.5) * 0.00012;
        roughness = 0.93 + (fine - 0.5) * 0.05;
      } else if (kind === 'gravel') {
        gravelCells(u, v, stone);
        const separation = smooth(0.005, 0.09, stone[1] - stone[0]);
        const crown = Math.sqrt(Math.max(0, 1 - stone[0] / 0.85));
        variation = (stone[2] - 0.5) * 22 + (grain - 0.5) * 5 - (1 - separation) * 11;
        relief = separation * crown * 0.008 + (grain - 0.5) * 0.0006;
        roughness = 0.94 + (stone[2] - 0.5) * 0.04 + (1 - separation) * 0.03;
      }

      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const color = spec.color[channel] + variation;
        albedo[offset + channel] = Math.round(clamp(color * (1 - rust) + RUST_COLOR[channel] * rust, 0, 255));
      }
      albedo[offset + 3] = 255;
      heights[y * size + x] = relief;
      orm[offset] = 255;
      orm[offset + 1] = Math.round(clamp(roughness, spec.roughness[0], spec.roughness[1]) * 255);
      orm[offset + 2] = Math.round(metalness * 255);
      orm[offset + 3] = 255;
    }
  }
  return { width: size, height: size, albedo, heights, orm,
    normal: normalsFromHeights(heights, size, size, meters, true) };
}

/**
 * Estimate restrained relief from existing generated albedo. This is not a
 * measured material scan: neutral pale mortar is explicitly recessed, while
 * plaster uses only local microcontrast so broad stains cannot become bumps.
 */
export function deriveSurfaceData(pixels, width, height, kind) {
  if (!['brick', 'plaster'].includes(kind)) throw new RangeError('Only brick/plaster have generated albedo');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || pixels.length !== width * height * 4) {
    throw new RangeError('Invalid source pixels');
  }
  const luminance = new Float32Array(width * height), heights = new Float32Array(width * height);
  const orm = new Uint8Array(pixels.length);
  for (let i = 0; i < luminance.length; i++) {
    luminance[i] = (pixels[i * 4] * 0.2126 + pixels[i * 4 + 1] * 0.7152 + pixels[i * 4 + 2] * 0.0722) / 255;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x, pixel = index * 4;
      const mean = (luminance[y * width + modulo(x - 2, width)] + luminance[y * width + (x + 2) % width]
        + luminance[modulo(y - 2, height) * width + x] + luminance[((y + 2) % height) * width + x]) * 0.25;
      const residual = clamp(luminance[index] - mean, -0.08, 0.08);
      let roughness;
      if (kind === 'brick') {
        const redness = (pixels[pixel] - pixels[pixel + 2]) / 255;
        const mortar = (1 - smooth(0.035, 0.12, redness)) * smooth(0.28, 0.46, luminance[index]);
        heights[index] = (1 - mortar) * 0.0032 + residual * 0.0014;
        roughness = 0.88 + mortar * 0.09 + residual * 0.10;
      } else {
        heights[index] = residual * 0.004;
        roughness = 0.93 + clamp(0.62 - luminance[index], -0.15, 0.15) * 0.18;
      }
      orm[pixel] = 255; orm[pixel + 1] = Math.round(clamp(roughness, 0.84, 0.99) * 255);
      orm[pixel + 2] = 0; orm[pixel + 3] = 255;
    }
  }
  return { width, height, heights, orm,
    normal: normalsFromHeights(heights, width, height, SURFACE_METERS[kind]) };
}
