#!/usr/bin/env node
/** Compare the pinned Three Basis WASM's ASTC output to the measured native decoder. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyRuntimeTrial({ ktx, manifest } = {}) {
  if (!ktx || !manifest) throw new Error('Pass --ktx /path/to/ktx --manifest artifacts/path/manifest.json');
  const manifestPath = resolve(ROOT, manifest);
  if (!manifestPath.startsWith(`${join(ROOT, 'artifacts')}/`)) throw new Error('Read a trial manifest inside artifacts/');
  const manifestBytes = readFileSync(manifestPath);
  const source = JSON.parse(manifestBytes);
  if (source.status !== 'experimental-requires-visual-ab' || !source.maps?.length) throw new Error('The encoding trial is incomplete');
  const version = execFileSync(ktx, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (version !== source.tool) throw new Error('Native decoder version differs from the measured trial');
  const basisDirectory = join(ROOT, 'node_modules/three/examples/jsm/libs/basis');
  const wrapperPath = join(basisDirectory, 'basis_transcoder.js');
  const wasmPath = join(basisDirectory, 'basis_transcoder.wasm');
  const scratch = mkdtempSync(join(tmpdir(), 'one-last-kill-basis-check-'));
  const reportPath = join(dirname(manifestPath), 'runtime-verification.json');
  writeFileSync(reportPath, `${JSON.stringify({ status: 'incomplete', manifestSha256: sha256(manifestBytes) }, null, 2)}\n`);
  try {
    // Three ships a universal wrapper without an ES-module export. Requiring an
    // identical temporary .cjs copy uses its native Node branch, with no network.
    const wrapperCopy = join(scratch, 'basis_transcoder.cjs');
    copyFileSync(wrapperPath, wrapperCopy);
    const createBasis = createRequire(import.meta.url)(wrapperCopy);
    const basis = await createBasis({ wasmBinary: readFileSync(wasmPath) });
    basis.initializeBasis();
    const report = {
      status: 'passed',
      manifestSha256: sha256(manifestBytes),
      threeVersion: JSON.parse(readFileSync(join(ROOT, 'node_modules/three/package.json'), 'utf8')).version,
      wrapper: { bytes: readFileSync(wrapperPath).length, sha256: sha256(readFileSync(wrapperPath)) },
      wasm: { bytes: readFileSync(wasmPath).length, sha256: sha256(readFileSync(wasmPath)) },
      target: 'ASTC 4x4 (Three KTX2Loader TranscoderFormat.ASTC_4x4 = 10)',
      nativeDecoder: version,
      notes: 'All mip block bytes must match. Timings are Node WASM transcodes, not browser startup or GPU timings.',
      maps: [],
    };
    for (const map of source.maps) {
      const path = resolve(ROOT, map.path);
      const bytes = readFileSync(path);
      if (sha256(bytes) !== map.sha256) throw new Error(`Encoded file hash changed: ${map.path}`);
      const file = new basis.KTX2File(bytes);
      try {
        if (!file.isValid() || !file.isUASTC() || file.getHasAlpha()
          || file.getWidth() !== 1024 || file.getHeight() !== 1024 || file.getLevels() !== 11
          || !file.startTranscoding()) throw new Error(`Pinned Basis rejected ${map.path}`);
        let payloadBytes = 0, transcodeMs = 0;
        for (let level = 0; level < file.getLevels(); level++) {
          const data = new Uint8Array(file.getImageTranscodedSizeInBytes(level, 0, 0, 10));
          const start = performance.now();
          if (!file.transcodeImage(data, level, 0, 0, 10, 0, -1, -1)) throw new Error(`Pinned Basis failed at mip ${level}`);
          transcodeMs += performance.now() - start;
          const reference = join(scratch, 'native-astc.bin');
          execFileSync(ktx, ['extract', '--transcode', 'astc', '--level', String(level), '--raw', path, reference], { timeout: 10_000 });
          if (!readFileSync(reference).equals(data)) throw new Error(`Native/Three ASTC differs: ${map.path}, mip ${level}`);
          payloadBytes += data.length;
        }
        if (payloadBytes !== map.transcodeTargets.astc.payloadBytes) throw new Error('ASTC payload count differs');
        report.maps.push({ id: map.id, kind: map.kind, sha256: map.sha256, levelsCompared: file.getLevels(), allBlockBytesMatch: true, payloadBytes, transcodeMs });
      } finally {
        file.close();
        file.delete();
      }
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!['--ktx', '--manifest'].includes(process.argv[i]) || !process.argv[i + 1]) throw new Error('Expected --ktx and --manifest');
    args[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  const report = await verifyRuntimeTrial(args);
  console.log(`Pinned Three ASTC output matches native output for ${report.maps.length} maps / ${report.maps.reduce((sum, map) => sum + map.levelsCompared, 0)} mip levels.`);
}
