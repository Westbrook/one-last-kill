/** Verify actual baked character roughness pixels without Blender or a GPU.
 *
 * node tools/blender/verify-character-materials.mjs [--baseline DIR] [--candidate DIR]
 *
 * Base-level bilinear sampling matches the runtime's flipY=true and clamp-to-edge
 * convention. It does not simulate minification, anisotropy, lighting, or visual
 * quality. Every triangle centroid is reported, including zeros. The separate
 * reliable-interior subset requires at least 1.5 texels of distance to every UV
 * triangle edge, so its four bilinear taps remain inside the triangle.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACTS = path.join(ROOT, 'artifacts/blender-material-realism-2026-09-04');
const MATERIALS = new Map([
  ['230,255', 'shirt'], ['219,255', 'trousers'], ['171,26', 'belt'],
  ['171,31', 'bootLeather'], ['245,13', 'rubberSole'], ['168,15', 'buttons'],
]);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rounded = value => value === null ? null : Number(value.toFixed(6));

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function paeth(a, b, c) {
  const prediction = a + b - c;
  const da = Math.abs(prediction - a), db = Math.abs(prediction - b), dc = Math.abs(prediction - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

/** Strict non-interlaced, 8-bit RGB/RGBA PNG decoder; no image dependencies. */
export function decodePng(buffer) {
  requireValue(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG signature');
  let offset = 8, header = null, ended = false;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    requireValue(offset + length + 12 <= buffer.length, `Truncated PNG ${type} chunk`);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      requireValue(!header && length === 13, 'Invalid or duplicate PNG IHDR');
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4);
      requireValue(data[8] === 8 && [2, 6].includes(data[9]), 'Expected 8-bit RGB or RGBA PNG');
      requireValue(data[10] === 0 && data[11] === 0 && data[12] === 0, 'Unsupported PNG compression/filter/interlace');
      requireValue(width > 0 && height > 0 && width * height <= 16777216, 'Invalid or excessive PNG dimensions');
      header = { width, height, channels: data[9] === 2 ? 3 : 4, bitDepth: data[8], colorType: data[9] };
    }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') { ended = true; break; }
    offset += length + 12;
  }
  requireValue(header && ended && idat.length, 'Incomplete PNG');
  const { width, height, channels } = header;
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  requireValue(filtered.length === (stride + 1) * height, 'Invalid PNG scanline length');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    requireValue(filter <= 4, `Invalid PNG row filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const destination = y * stride + x;
      const a = x >= channels ? pixels[destination - channels] : 0;
      const b = y ? pixels[destination - stride] : 0;
      const c = x >= channels && y ? pixels[destination - stride - channels] : 0;
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      pixels[destination] = (filtered[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return { ...header, pixels };
}

export function sampleRoughness(image, u, v) {
  // TextureLoader PNGs have top-first rows; Three's flipY=true places v=1 there.
  const x = clamp(u * image.width - 0.5, 0, image.width - 1);
  const y = clamp((1 - v) * image.height - 0.5, 0, image.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, image.width - 1), y1 = Math.min(y0 + 1, image.height - 1);
  const taps = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([tx, ty]) => image.pixels[(ty * image.width + tx) * image.channels + 1]);
  const top = taps[0] * (1 - (x - x0)) + taps[1] * (x - x0);
  const bottom = taps[2] * (1 - (x - x0)) + taps[3] * (x - x0);
  return { value: (top * (1 - (y - y0)) + bottom * (y - y0)) / 255, zeroTap: taps.includes(0) };
}

function array(buffer, layout) {
  const types = { Float32Array: [4, 'getFloat32'], Uint16Array: [2, 'getUint16'], Uint8Array: [1, 'getUint8'] };
  requireValue(types[layout.type], `Unsupported character attribute ${layout.type}`);
  const [bytes, method] = types[layout.type];
  requireValue(layout.byteOffset >= 0 && layout.byteOffset + layout.length * bytes <= buffer.length, 'Character attribute exceeds binary');
  const view = new DataView(buffer.buffer, buffer.byteOffset + layout.byteOffset, layout.length * bytes);
  return Array.from({ length: layout.length }, (_, i) => view[method](i * bytes, true));
}

export function readSurface(binary, surface) {
  const attributes = Object.fromEntries(Object.entries(surface.attributes).map(([name, layout]) => [name, array(binary, layout)]));
  return { ...attributes, index: array(binary, surface.index) };
}

function summary(samples) {
  const values = samples.map(item => item.value).sort((a, b) => a - b);
  const n = values.length;
  const percentile = fraction => {
    if (!n) return null;
    const location = (n - 1) * fraction, lower = Math.floor(location), upper = Math.ceil(location);
    return values[lower] + (values[upper] - values[lower]) * (location - lower);
  };
  return { count: n, mean: rounded(n ? values.reduce((a, b) => a + b, 0) / n : null),
    p10: rounded(percentile(0.1)), p90: rounded(percentile(0.9)), min: rounded(n ? values[0] : null),
    max: rounded(n ? values[n - 1] : null), zeroSamples: samples.filter(item => item.value <= 1e-12).length,
    samplesTouchingZeroTexels: samples.filter(item => item.zeroTap).length,
    below035Samples: samples.filter(item => item.value < 0.35).length };
}

function headRegion([x, y, z]) {
  // Stable normalized-head windows independent of the material authoring masks.
  if (z > 0.32 && Math.abs(x) < 0.060 && y >= 0.37 && y <= 0.47) return 'nose';
  if (z > 0.26 && Math.abs(x) < 0.12 && y >= 0.63 && y <= 0.73) return 'forehead';
  if (z > 0.22 && Math.abs(x) >= 0.17 && Math.abs(x) <= 0.34 && y >= 0.32 && y <= 0.46) return 'cheek';
  return 'otherHead';
}

function classify(surface, ids, part, center) {
  if (part === 'head') return headRegion(center);
  const tuples = ids.map(i => `${surface.heroSurface[i * 2]},${surface.heroSurface[i * 2 + 1]}`);
  if (new Set(tuples).size !== 1) return 'mixedMaterialBoundary';
  return MATERIALS.get(tuples[0]) || `unknownMaterial:${tuples[0]}`;
}

function uvInterior(uvs, image) {
  const points = uvs.map(([u, v]) => [u * image.width, (1 - v) * image.height]);
  const center = [0, 1].map(k => points.reduce((total, p) => total + p[k], 0) / 3);
  const area2 = Math.abs((points[1][0] - points[0][0]) * (points[2][1] - points[0][1]) - (points[1][1] - points[0][1]) * (points[2][0] - points[0][0]));
  const distances = points.map((a, i) => {
    const b = points[(i + 1) % 3], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return length ? Math.abs((b[0] - a[0]) * (a[1] - center[1]) - (a[0] - center[0]) * (b[1] - a[1])) / length : 0;
  });
  return { reliable: area2 > 1e-8 && Math.min(...distances) >= 1.5, areaPixels: area2 / 2,
    degenerate: area2 <= 1e-8, minimumEdgeDistancePixels: Math.min(...distances) };
}

export function inspectPart(surface, before, after, part) {
  const groups = new Map((part === 'garments' ? [...MATERIALS.values(), 'mixedMaterialBoundary']
    : ['nose', 'forehead', 'cheek', 'otherHead']).map(name => [name, []]));
  const all = [], zeroDetails = [];
  for (let triangle = 0; triangle < surface.index.length / 3; triangle++) {
    const ids = surface.index.slice(triangle * 3, triangle * 3 + 3);
    const center = [0, 1, 2].map(k => ids.reduce((sum, i) => sum + surface.position[i * 3 + k], 0) / 3);
    const uvs = ids.map(i => [surface.uv[i * 2], surface.uv[i * 2 + 1]]);
    const uv = [0, 1].map(k => uvs.reduce((sum, p) => sum + p[k], 0) / 3);
    requireValue(uvs.flat().every(Number.isFinite), `Non-finite ${part} UV`);
    const region = classify(surface, ids, part, center), footprint = uvInterior(uvs, after);
    const a = sampleRoughness(before, ...uv), b = sampleRoughness(after, ...uv);
    const record = { before: a, candidate: b, ...footprint };
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(record); all.push(record);
    if (a.zeroTap || b.zeroTap || a.value < 0.35 || b.value < 0.35) zeroDetails.push({ triangle, region,
      uv: uv.map(rounded), reliableInterior: footprint.reliable, degenerate: footprint.degenerate,
      minimumEdgeDistancePixels: rounded(footprint.minimumEdgeDistancePixels),
      before: { ...a, value: rounded(a.value) }, candidate: { ...b, value: rounded(b.value) } });
  }
  const summarize = records => {
    const interior = records.filter(item => item.reliable);
    return { coverage: { triangles: records.length, reliableInteriorTriangles: interior.length,
      reliableInteriorFraction: rounded(records.length ? interior.length / records.length : 0),
      uvEdgeExcludedTriangles: records.length - interior.length, degenerateUvTriangles: records.filter(item => item.degenerate).length },
    allCentroids: { before: summary(records.map(item => item.before)), candidate: summary(records.map(item => item.candidate)) },
    reliableInterior: { before: summary(interior.map(item => item.before)), candidate: summary(interior.map(item => item.candidate)) } };
  };
  const atlas = image => {
    let zeros = 0, below035 = 0;
    for (let i = 1; i < image.pixels.length; i += image.channels) {
      if (image.pixels[i] === 0) zeros++;
      if (image.pixels[i] / 255 < 0.35) below035++;
    }
    return { width: image.width, height: image.height, channels: image.channels, zeroGreenTexels: zeros, below035GreenTexels: below035 };
  };
  return { atlas: { before: atlas(before), candidate: atlas(after) }, overall: summarize(all),
    regions: Object.fromEntries([...groups].map(([name, records]) => [name, summarize(records)])),
    zeroOrLowSamples: zeroDetails };
}

export async function verify({ baseline, candidate, output }) {
  const [beforeManifest, afterManifest] = await Promise.all([baseline, candidate].map(async directory => JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))));
  const names = ['characters.bin', 'gunman-garments-normal.png', 'gunman-head-normal.png', 'gunman-garments-roughness.png', 'gunman-head-roughness.png'];
  const files = await Promise.all(names.map(async name => {
    const [before, after] = await Promise.all([baseline, candidate].map(directory => readFile(path.join(directory, name))));
    return { name, before, after };
  }));
  const byName = Object.fromEntries(files.map(file => [file.name, file]));
  const binary = byName['characters.bin'];
  const fileIntegrity = Object.fromEntries(files.map(({ name, before, after }) => [name,
    { beforeSha256: sha256(before), candidateSha256: sha256(after), beforeBytes: before.length, candidateBytes: after.length, byteIdentical: before.equals(after) }]));
  const assertions = [];
  const check = (name, passed, detail) => assertions.push({ name, passed: Boolean(passed), detail });
  for (const name of names.slice(0, 3)) check(`${name} retained byte for byte`, fileIntegrity[name].byteIdentical, fileIntegrity[name]);
  check('Both manifests match their binary SHA256 and length',
    beforeManifest.sha256 === sha256(binary.before) && afterManifest.sha256 === sha256(binary.after)
      && beforeManifest.byteLength === binary.before.length && afterManifest.byteLength === binary.after.length,
    { before: beforeManifest.sha256, candidate: afterManifest.sha256 });
  const layouts = manifest => manifest.catalog.map(item => ({ id: item.id,
    surfaces: item.surfaces.map(surface => ({ name: surface.name, presentation: surface.presentation,
      attributes: surface.attributes, index: surface.index })) }));
  const layoutIdentical = JSON.stringify(layouts(beforeManifest)) === JSON.stringify(layouts(afterManifest));
  check('All catalog binary layouts and presentation transforms retained', layoutIdentical,
    'Before and candidate samples use identical binary attribute offsets and UV interpretation');
  requireValue(layoutIdentical, 'Cannot pair pixel samples across changed catalog binary layouts');
  const entry = afterManifest.catalog.find(item => item.id === 'gunman');
  requireValue(entry, 'Missing gunman entry');
  const parts = {};
  for (const part of ['garments', 'head']) {
    const texture = byName[`gunman-${part}-roughness.png`], before = decodePng(texture.before), after = decodePng(texture.after);
    check(`${part} retains 512-square roughness allocation`, before.width === 512 && before.height === 512 && after.width === 512 && after.height === 512,
      { before: [before.width, before.height], candidate: [after.width, after.height] });
    const surface = entry.surfaces.find(item => item.name === part);
    requireValue(surface, `Missing ${part} surface`);
    parts[part] = inspectPart(readSurface(binary.after, surface), before, after, part);
    const report = parts[part].overall.reliableInterior;
    check(`${part} has no new zero or sub-.35 reliable-interior samples`,
      report.candidate.zeroSamples <= report.before.zeroSamples && report.candidate.below035Samples <= report.before.below035Samples,
      { before: report.before, candidate: report.candidate });
  }
  const separation = (part, rougher, smoother, minimumGap, minimumSamples) => {
    const a = parts[part].regions[rougher]?.reliableInterior.candidate;
    const b = parts[part].regions[smoother]?.reliableInterior.candidate;
    check(`${part}: ${rougher} rougher than ${smoother} by at least ${minimumGap}`,
      a?.count >= minimumSamples && b?.count >= minimumSamples && a.mean - b.mean >= minimumGap,
      { rougher: a || null, smoother: b || null, minimumSamples, actualMeanGap: a && b ? rounded(a.mean - b.mean) : null });
  };
  separation('garments', 'shirt', 'trousers', 0.02, 20);
  separation('garments', 'shirt', 'bootLeather', 0.12, 10);
  separation('garments', 'rubberSole', 'bootLeather', 0.20, 10);
  separation('head', 'cheek', 'nose', 0.045, 3);
  separation('head', 'cheek', 'forehead', 0.02, 3);
  const report = { version: 1, method: 'Decoded RGB/RGBA8 PNG green channel; actual UV triangle centroids; base-level bilinear sampling; flipY=true; clamp to edge',
    interpretation: 'Artistic response checks, not measured material constants or visual approval. Means weight each triangle once, not surface area.',
    exclusions: 'Every centroid is reported. Reliable interiors require 1.5 texels of clearance from every UV triangle edge, exceeding the maximum sqrt(2)-texel diagonal of a bilinear tap. Material assertions only use triangles with three identical exact heroSurface tuples. Mixed boundaries, small buttons and the sparsely sampled belt remain reported and require visual review.',
    headWindows: { nose: '|x|<.060, y=.37–.47, z>.32', forehead: '|x|<.12, y=.63–.73, z>.26', cheek: '|x|=.17–.34, y=.32–.46, z>.22' },
    baseline, candidate, fileIntegrity, parts, assertions, passed: assertions.every(item => item.passed) };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { baseline: { type: 'string' }, candidate: { type: 'string' }, output: { type: 'string' } } });
  const baseline = path.resolve(values.baseline || path.join(ARTIFACTS, 'character-baseline/runtime'));
  const candidate = path.resolve(values.candidate || path.join(ARTIFACTS, 'character-candidate'));
  const output = path.resolve(values.output || path.join(candidate, 'material-validation.json'));
  const report = await verify({ baseline, candidate, output });
  console.log(JSON.stringify({ passed: report.passed, output,
    checks: report.assertions.map(({ name, passed }) => ({ name, passed })),
    regions: Object.fromEntries(Object.entries(report.parts).map(([part, value]) => [part,
      Object.fromEntries(Object.entries(value.regions).map(([region, data]) => [region, data.reliableInterior]))])) }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
