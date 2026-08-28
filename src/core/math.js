
// ─── 1. MATH / NOISE ─────────────────────────────────────────────────────────
const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, t) => { t = clamp((t - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise sampler with smoothstep interpolation across a wrapping N×N grid.
function makeValueNoise(seed, gridSize = 96) {
  const rng = mulberry32(seed);
  const N = gridSize;
  const g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return function sample(x, y) {
    x = ((x % N) + N) % N; y = ((y % N) + N) % N;
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const x1 = (xi + 1) % N, y1 = (yi + 1) % N;
    const a = g[yi * N + xi], b = g[yi * N + x1];
    const c = g[y1 * N + xi], d = g[y1 * N + x1];
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
  };
}
function fBm(sample, x, y, octaves = 5, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * sample(x * freq, y * freq);
    norm += amp; amp *= gain; freq *= lac;
  }
  return sum / norm;
}

export { TAU, lerp, clamp, smoothstep, mulberry32, makeValueNoise, fBm };
