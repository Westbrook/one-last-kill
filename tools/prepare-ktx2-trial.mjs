#!/usr/bin/env node
/** Offline trial only. Never overwrites or selects the production raw maps. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureNormalError, measurePixelError } from './texture-quality.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = ['albedo', 'normal', 'roughness'];
const SOURCE_MANIFEST = 'public/assets/materials/manifest.json';
const DEFAULT_OUTPUT = 'artifacts/graphics-ceiling-2026-08-29/ktx2-trial';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function createOptions(kind, { quality = 4, mipmaps = true, encode = true, bits = 8 } = {}) {
  if (!MAPS.includes(kind)) throw new TypeError(`Unknown map kind: ${kind}`);
  if (!Number.isInteger(quality) || quality < 0 || quality > 4) throw new RangeError('UASTC quality must be 0–4');
  if (![8, 16].includes(bits) || (encode && bits !== 8) || (bits === 16 && kind === 'albedo')) {
    throw new RangeError('UASTC LDR requires 8 bits; 16-bit references are data maps only');
  }
  const color = kind === 'albedo';
  const options = [
    '--format', bits === 16 ? 'R16G16B16_UNORM' : color ? 'R8G8B8_SRGB' : 'R8G8B8_UNORM',
    '--assign-tf', color ? 'srgb' : 'linear',
    '--assign-primaries', color ? 'bt709' : 'none',
    // TextureLoader uses flipY=true; block-compressed uploads cannot flip rows.
    // Flip every channel offline without changing the OpenGL normal green sign.
    '--assign-texcoord-origin', 'top-left', '--convert-texcoord-origin', 'bottom-left',
    '--fail-on-color-conversions',
  ];
  if (mipmaps) options.push('--generate-mipmap', '--mipmap-filter', 'box', '--mipmap-wrap', 'wrap');
  if (encode) options.push('--encode', 'uastc', '--uastc-quality', String(quality), '--threads', '2', '--zstd', '18');
  // No normal-mode, input swizzle, normalization, rescaling, or lossy RDO.
  return options;
}

export function validateTrialInfo(info, kind, resolution = 1024) {
  const header = info?.header;
  const block = info?.dataFormatDescriptor?.blocks?.[0];
  const expectedLevels = Math.floor(Math.log2(resolution)) + 1;
  if (!info?.valid || !MAPS.includes(kind) || header?.pixelWidth !== resolution
    || header?.pixelHeight !== resolution || header?.levelCount !== expectedLevels
    || header?.faceCount !== 1 || header?.layerCount !== 0 || header?.pixelDepth !== 0
    || header?.vkFormat !== 'VK_FORMAT_UNDEFINED' || header?.supercompressionScheme !== 'KTX_SS_ZSTD'
    || block?.colorModel !== 'KHR_DF_MODEL_UASTC'
    || block?.samples?.[0]?.channelType !== 'KHR_DF_CHANNEL_UASTC_RGB'
    || block?.transferFunction !== (kind === 'albedo' ? 'KHR_DF_TRANSFER_SRGB' : 'KHR_DF_TRANSFER_LINEAR')
    || block?.colorPrimaries !== (kind === 'albedo' ? 'KHR_DF_PRIMARIES_BT709' : 'KHR_DF_PRIMARIES_UNSPECIFIED')
    || info?.keyValueData?.KTXorientation !== 'ru') {
    throw new Error(`KTX2 trial contract failed for ${kind}`);
  }
  return true;
}

function as16BitLE(bytes) {
  if (bytes.length % 2) throw new Error('Truncated 16-bit reference');
  const values = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < values.length; i++) values[i] = bytes.readUInt16LE(i * 2);
  return values;
}

export function prepareTrial({ ktx, output = DEFAULT_OUTPUT, quality = 4, materials, kinds = MAPS } = {}) {
  if (!ktx) throw new TypeError('Pass --ktx /absolute/path/to/ktx (official KTX-Software 4.4.2)');
  const directory = resolve(ROOT, output);
  // This tool can only write review artifacts. Promotion is a separate reviewed step.
  if (!directory.startsWith(`${join(ROOT, 'artifacts')}/`)) throw new Error('Output must stay inside artifacts/');
  for (const kind of kinds) createOptions(kind, { quality });
  const sourceManifestBytes = readFileSync(join(ROOT, SOURCE_MANIFEST));
  const sourceManifest = JSON.parse(sourceManifestBytes);
  const selected = materials ?? Object.keys(sourceManifest.materials);
  if (!selected.length || !kinds.length) throw new Error('Select at least one material and map');
  const jobs = selected.flatMap(id => {
    const material = sourceManifest.materials[id];
    if (!material) throw new Error(`Unknown material ${id}`);
    return kinds.map(kind => {
      const source = material.maps[kind];
      const bytes = readFileSync(join(ROOT, source.path));
      if (sha256(bytes) !== source.sha256 || bytes.length !== source.bytes) throw new Error(`Source hash changed: ${source.path}`);
      if (source.dimensions_px[0] !== 1024 || source.dimensions_px[1] !== 1024) throw new Error('Only approved 1K sources are supported');
      return { id, kind, material, source, verifiedBytes: bytes };
    });
  });
  const run = args => execFileSync(ktx, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  const version = run(['--version']).trim();
  if (version !== 'ktx version: v4.4.2') throw new Error(`Review CLI semantics before using a different version: ${version}`);
  mkdirSync(join(directory, 'encoded'), { recursive: true });
  mkdirSync(join(directory, 'decoded'), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'one-last-kill-ktx2-'));
  const report = {
    version: 1, status: 'experimental-requires-visual-ab', tool: version,
    officialToolRelease: 'https://github.com/KhronosGroup/KTX-Software/releases/tag/v4.4.2',
    sourceManifest: SOURCE_MANIFEST, sourceManifestSha256: sha256(sourceManifestBytes),
    encoding: { codec: 'UASTC LDR RGB', quality, rdo: false, zstd: 18, mipFilter: 'box', mipWrap: 'wrap', threads: 2 },
    runtimeContract: { flipY: false, generateMipmaps: false, normalConvention: 'OpenGL +Y; RGB retained', roughnessChannel: 'green', color: 'sRGB albedo; NoColorSpace data', orientation: 'ru (offline vertical row flip from raw TextureLoader flipY=true)' },
    limits: [
      'No runtime loader or production default is changed by this tool. Raw sources remain untouched.',
      'Numerical error is measured at base mip; mip filtering and moving highlights still require in-game A/B.',
      'RGBA8 and ASTC decode quality are measured. BC7/ETC2/BC1 target payloads are checked, but their decoded error is not measured here.',
      'Raw 16-bit PNG normals are also compared before quantization; the current TextureLoader path uploads 8-bit RGBA.',
      'GPU byte counts are encoded payload estimates, not device residency measurements; unsupported compressed formats can fall back to RGBA8.',
    ],
    maps: [],
  };
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify({ status: 'incomplete', tool: version, quality, expectedMaps: jobs.length }, null, 2)}\n`);
  try {
    for (const { id, kind, material, source, verifiedBytes } of jobs) {
      const name = basename(source.path).replace(/\.[^.]+$/, '');
      // Every encode and reference reads the same verified snapshot, even if
      // another art task replaces a live source while this offline job runs.
      const verifiedSource = join(scratch, basename(source.path));
      writeFileSync(verifiedSource, verifiedBytes);
      const encodedPath = join(directory, 'encoded', `${name}.ktx2`);
      const options = createOptions(kind, { quality });
      const start = performance.now();
      console.log(`Encoding ${id}/${kind}: UASTC quality ${quality}, no RDO`);
      run(['create', ...options, verifiedSource, encodedPath]);
      const encodeMs = performance.now() - start;
      const info = JSON.parse(run(['info', '--format', 'mini-json', encodedPath]));
      validateTrialInfo(info, kind);
      const referenceKtx = join(scratch, `${name}-reference.ktx2`);
      const referenceRaw = join(scratch, `${name}-reference.rgb`);
      const decodedRaw = join(scratch, `${name}-decoded.rgba`);
      run(['create', ...createOptions(kind, { encode: false, mipmaps: false }), verifiedSource, referenceKtx]);
      run(['extract', '--raw', referenceKtx, referenceRaw]);
      run(['extract', '--transcode', 'rgba8', '--raw', encodedPath, decodedRaw]);
      run(['extract', '--transcode', 'rgba8', encodedPath, join(directory, 'decoded', `${name}-uastc.png`)]);
      const reference = readFileSync(referenceRaw);
      const decoded = readFileSync(decodedRaw);
      const channels = kind === 'roughness' ? [1] : [0, 1, 2];
      const qualityReport = { uastcRgba8: measurePixelError(reference, decoded, { channels }) };
      if (kind === 'normal') qualityReport.uastcNormal = measureNormalError(reference, decoded);
      const targets = {};
      for (const target of ['astc', 'bc7', 'etc-rgb', 'bc1', 'rgba8']) {
        const targetPath = join(scratch, `${name}-${target}.ktx2`);
        run(['transcode', '--target', target, encodedPath, targetPath]);
        const targetInfo = JSON.parse(run(['info', '--format', 'mini-json', targetPath]));
        if (!targetInfo.valid) throw new Error(`Invalid ${target} transcode`);
        targets[target] = { format: targetInfo.header.vkFormat, payloadBytes: targetInfo.index.levels.reduce((sum, level) => sum + level.byteLength, 0), levels: targetInfo.header.levelCount };
        if (target !== 'astc') continue;
        // KTX extract decodes ASTC to PNG. Re-wrap its unchanged bytes to get a
        // raw reference without adding an image library or another color transform.
        const png = join(directory, 'decoded', `${name}-astc.png`);
        const astcKtx = join(scratch, `${name}-astc-decoded.ktx2`);
        const astcRaw = join(scratch, `${name}-astc-decoded.rgba`);
        run(['extract', targetPath, png]);
        run(['create', '--format', 'R8G8B8A8_UNORM', '--assign-tf', 'linear', '--assign-primaries', 'none', png, astcKtx]);
        run(['extract', '--raw', astcKtx, astcRaw]);
        const astc = readFileSync(astcRaw);
        qualityReport.astc = measurePixelError(reference, astc, { channels });
        if (kind === 'normal') qualityReport.astcNormal = measureNormalError(reference, astc);
      }
      if (kind === 'normal' && source.source_bit_depth === 16) {
        const highKtx = join(scratch, `${name}-reference16.ktx2`);
        const highRaw = join(scratch, `${name}-reference16.rgb`);
        run(['create', ...createOptions(kind, { encode: false, mipmaps: false, bits: 16 }), verifiedSource, highKtx]);
        run(['extract', '--raw', highKtx, highRaw]);
        const reference16 = as16BitLE(readFileSync(highRaw));
        qualityReport.source16ToReference8Normal = measureNormalError(reference16, reference, { referenceMax: 65535, decodedStride: 3 });
        qualityReport.source16ToUastcNormal = measureNormalError(reference16, decoded, { referenceMax: 65535 });
      }
      const outputBytes = readFileSync(encodedPath);
      report.maps.push({
        id, kind, sourcePath: source.path, sourceSha256: source.sha256, sourceBytes: source.bytes,
        sourceBitDepth: source.source_bit_depth, license: material.license, sourcePage: material.source_page,
        tileSpanMeters: material.intended_tile_span_m, path: relative(ROOT, encodedPath),
        bytes: outputBytes.length, sha256: sha256(outputBytes), encodeMs,
        command: ['ktx', 'create', ...options, source.path, relative(ROOT, encodedPath)],
        metadata: { header: info.header, dataFormatDescriptor: info.dataFormatDescriptor, keyValueData: info.keyValueData },
        quality: qualityReport, transcodeTargets: targets,
      });
      console.log(`Validated ${id}/${kind}: ${statSync(encodedPath).size} bytes, ${Math.round(encodeMs)}ms encoding`);
    }
    report.totals = {
      rawDownloadBytes: report.maps.reduce((sum, map) => sum + map.sourceBytes, 0),
      ktx2DownloadBytes: report.maps.reduce((sum, map) => sum + map.bytes, 0),
      gpuPayloadBytes: Object.fromEntries(['astc', 'bc7', 'etc-rgb', 'bc1', 'rgba8'].map(target => [target, report.maps.reduce((sum, map) => sum + map.transcodeTargets[target].payloadBytes, 0)])),
    };
    for (const { source } of jobs) {
      if (sha256(readFileSync(join(ROOT, source.path))) !== source.sha256) {
        throw new Error(`Source changed while encoding: ${source.path}`);
      }
    }
    writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    const value = process.argv[i + 1];
    if (!['--ktx', '--output', '--quality', '--materials', '--kinds'].includes(name) || !value) {
      throw new Error('Usage: node tools/prepare-ktx2-trial.mjs --ktx /path/to/ktx [--output artifacts/path] [--quality 0–4] [--materials id,id] [--kinds albedo,normal,roughness]');
    }
    args[name.slice(2)] = name === '--quality' ? Number(value) : ['--materials', '--kinds'].includes(name) ? value.split(',') : value;
  }
  prepareTrial(args);
}
