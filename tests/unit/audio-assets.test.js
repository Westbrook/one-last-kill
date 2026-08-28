import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../../public/assets/audio/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const catalog = JSON.parse(readFileSync(new URL('../../src/core/audio-catalog.json', import.meta.url), 'utf8'));

test('the small runtime audio catalog exactly matches the licensed provenance manifest', () => {
  assert.deepEqual(catalog, { version: manifest.version, samples: manifest.samples },
    'After changing the manifest, run node tools/update-audio-catalog.mjs');
  assert.equal(manifest.license, 'CC0-1.0');
  assert.equal(manifest.auditioned, false, 'Offline technical validation is not an audio audition');
  assert.ok(readFileSync(new URL('LICENSE.txt', root), 'utf8').includes('CC0'));
  const paths = new Set();
  for (const [id, group] of Object.entries(catalog.samples)) {
    for (const entry of Array.isArray(group) ? group : [group]) {
      assert.match(entry.url, /^\/assets\/audio\/(foley|mechanical|radio)\/[a-z0-9-]+\.wav$/);
      assert.equal(entry.bus, id.startsWith('radio:') ? 'radio' : 'effects');
      assert.ok(entry.gain > 0 && entry.gain <= 1);
      assert.equal(paths.has(entry.url), false, 'Each file has one cache identity');
      paths.add(entry.url);
      assert.ok(manifest.files.some(file => file.id === id && file.url === entry.url));
    }
  }
  assert.equal(paths.size, manifest.sampleFileCount);
  assert.equal(paths.size, manifest.files.length);
  assert.equal(readdirSync(root, { recursive: true }).filter(path => path.endsWith('.wav')).length, paths.size);
});

test('every shipped audio file has a source, license record, matching size and SHA-256', () => {
  const sources = new Map(manifest.sources.map(source => [source.id, source]));
  let totalBytes = 0;
  for (const file of manifest.files) {
    const source = sources.get(file.sourceId);
    assert.ok(source, file.url);
    assert.equal(source.license, 'CC0-1.0');
    assert.match(source.sourceUrl, /^https:\/\//);
    assert.ok(readFileSync(new URL(source.licenseFile, root), 'utf8').length > 20);
    assert.match(file.sourceSha256, /^[a-f0-9]{64}$/);
    const bytes = readFileSync(new URL(file.url.slice('/assets/audio/'.length), root));
    assert.equal(bytes.length, file.bytes, file.url);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.url);
    totalBytes += bytes.length;
  }
  assert.equal(totalBytes, manifest.totalWavBytes);
  assert.ok(totalBytes < 3 * 1024 * 1024, 'Keep the local sound subset small');
});

test('local WAVs are short mono PCM16 with headroom and silent endpoints, checked without playback', () => {
  for (const file of manifest.files) {
    const bytes = readFileSync(new URL(file.url.slice('/assets/audio/'.length), root));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    let format = null, data = null;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
      const end = offset + 8 + size;
      assert.ok(end <= bytes.length, file.url);
      if (name === 'fmt ') format = bytes.subarray(offset + 8, end);
      if (name === 'data') data = bytes.subarray(offset + 8, end);
      offset = end + (size & 1);
    }
    assert.ok(format && data, file.url);
    assert.equal(format.readUInt16LE(0), 1, 'Uncompressed PCM');
    assert.equal(format.readUInt16LE(2), 1, 'Mono');
    assert.equal(format.readUInt32LE(4), 44100);
    assert.equal(format.readUInt16LE(14), 16);
    assert.equal(data.length / 2, file.frames);
    assert.ok(file.duration > 0 && file.duration < 8);
    assert.equal(data.readInt16LE(0), 0);
    assert.equal(data.readInt16LE(data.length - 2), 0);
    let peak = 0;
    for (let offset = 0; offset < data.length; offset += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(offset)));
    assert.ok(peak > 0 && peak / 32768 <= 10 ** (-2.99 / 20), `${file.url}: preserve approximately −3 dBFS headroom`);
  }
});
