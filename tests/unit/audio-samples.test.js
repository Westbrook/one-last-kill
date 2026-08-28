import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampleBank } from '../../src/core/audio-samples.js';

const sample = (url = '/audio/step.wav', bus = 'effects', gain = 1) => ({ url, bus, gain });

// These are plain arrays and objects. No audio context, device, file, or URL is opened.
function fakeBuffer({ length = 400, numberOfChannels = 1, sampleRate = 8000, duration = length / sampleRate } = {}) {
  const data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  return { length, numberOfChannels, sampleRate, duration, getChannelData: channel => data[channel] };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settled(bank) {
  for (let attempt = 0; attempt < 512; attempt++) {
    const state = bank.snapshot();
    if (!state.pending && !state.queued && !state.inFlight) return;
    await Promise.resolve();
  }
  assert.fail(`Sample work did not settle: ${JSON.stringify(bank.snapshot())}`);
}

function fixture({ canLoad = () => true, load = null, decode = null } = {}) {
  const calls = { load: [], decode: [] };
  const bank = createSampleBank({
    canLoad,
    load: entry => { calls.load.push(entry); return load ? load(entry) : Promise.resolve(new ArrayBuffer(16)); },
    decode: bytes => { calls.decode.push(bytes); return decode ? decode(bytes) : Promise.resolve(fakeBuffer()); },
  });
  return { bank, calls };
}

test('sample loading defaults closed and never calls injected work without permission', async () => {
  let calls = 0;
  const bank = createSampleBank({ load: () => { calls++; }, decode: () => { calls++; } });
  bank.setManifest({ step: sample() });
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(bank.request('step'), false);
    assert.equal(bank.preload(), 0);
    assert.equal(bank.peek('step'), null);
  }
  await settled(bank);
  assert.equal(calls, 0);
  assert.equal(bank.snapshot().cached, 0);
});

test('hard mute, inactive state, mute preference, and zero bus level all block loading', async () => {
  const state = { hardMuted: true, active: true, muted: false, master: 1, effects: 1 };
  const { bank, calls } = fixture({ canLoad: bus => !state.hardMuted && state.active && !state.muted && state.master > 0 && state[bus] > 0 });
  bank.setManifest({ step: sample() });
  const blockedStates = [
    { hardMuted: true, active: true, muted: false, master: 1, effects: 1 },
    { hardMuted: false, active: false, muted: false, master: 1, effects: 1 },
    { hardMuted: false, active: true, muted: true, master: 1, effects: 1 },
    { hardMuted: false, active: true, muted: false, master: 0, effects: 1 },
    { hardMuted: false, active: true, muted: false, master: 1, effects: 0 },
  ];
  for (const next of blockedStates) {
    Object.assign(state, next);
    assert.equal(bank.request('step'), false);
    assert.equal(bank.preload(), 0);
    await settled(bank);
  }
  assert.equal(calls.load.length, 0);
  assert.equal(calls.decode.length, 0);
  state.effects = 1;
  assert.equal(bank.request('step'), true);
  await settled(bank);
  assert.equal(calls.decode.length, 1);
  state.hardMuted = true;
  assert.equal(bank.peek('step'), null);
});

test('manifest registration is allocation-free and accepts only bounded local paths', async () => {
  const { bank, calls } = fixture();
  const accepted = ['/audio/step.wav', '/assets/audio/step.ogg', 'audio/step.wav', './audio/step.wav', 'step.wav'];
  const rejected = [
    'https://example.com/step.wav', 'http://example.com/step.wav', '//example.com/step.wav',
    'data:audio/wav;base64,a', 'blob:sample', 'file:///tmp/step.wav', '/private/step.wav',
    '../step.wav', './audio/../step.wav', '/audio/step..wav', '/audio/%2e%2e/step.wav',
    '/audio/%2F%2Fevil/step.wav', 'audio\\step.wav', 'audio//step.wav', ' audio/step.wav',
    'audio/step.wav ', 'audio/step.wav?url=https://evil', 'audio/step.wav#hash', '/audio/', '.', '', null,
  ];
  const manifest = Object.fromEntries([...accepted, ...rejected].map((url, index) => [`sample-${index}`, sample(url)]));
  manifest.badBus = sample('/audio/step.wav', 'master');
  manifest.invalidEntry = 'audio/step.wav';
  manifest.emptyVariants = [];
  bank.setManifest(manifest);
  assert.equal(bank.snapshot().groups, accepted.length);
  assert.equal(calls.load.length, 0);
  assert.equal(calls.decode.length, 0);
  assert.equal(bank.preload(), accepted.length);
  await settled(bank);
  assert.deepEqual(calls.load.map(call => call.url), accepted);
});

test('requests reuse cached buffers and cached variants rotate without starting work', async () => {
  const { bank, calls } = fixture();
  bank.setManifest({ step: [sample('/audio/step-a.wav', 'effects', 0.4), sample('/audio/step-b.wav', 'effects', 0.7)] });
  assert.equal(bank.peek('step'), null);
  assert.equal(bank.request('step'), true);
  assert.equal(bank.request('step'), true);
  await settled(bank);
  const first = bank.peek('step');
  const second = bank.peek('step');
  const third = bank.peek('step');
  assert.equal(first.gain, 0.4);
  assert.equal(second.gain, 0.7);
  assert.ok(first.buffer !== second.buffer);
  assert.ok(first.buffer === third.buffer);
  assert.equal(bank.request('step'), true);
  assert.equal(calls.load.length, 2);
  assert.equal(calls.decode.length, 2);
  assert.equal(bank.peek('missing'), null);
  assert.equal(bank.request('missing'), false);
});

test('each variant respects its own bus and zero gain prevents pointless loads', async () => {
  const allowed = new Set(['effects']);
  const { bank, calls } = fixture({ canLoad: bus => allowed.has(bus) });
  bank.setManifest({ cue: [sample('/audio/fx.wav'), sample('/audio/radio.wav', 'radio'), sample('/audio/silent.wav', 'effects', 0)] });
  bank.request('cue');
  await settled(bank);
  assert.deepEqual(calls.load.map(call => call.url), ['/audio/fx.wav']);
  allowed.clear();
  allowed.add('radio');
  assert.equal(bank.peek('cue'), null);
  bank.request('cue');
  await settled(bank);
  assert.deepEqual(calls.load.map(call => call.url), ['/audio/fx.wav', '/audio/radio.wav']);
  assert.ok(bank.peek('cue'));
  assert.equal(bank.snapshot().cached, 2);
});

test('muting while a load awaits prevents decoding and can be retried after unmute', async () => {
  let allowed = true;
  const loading = deferred();
  const { bank, calls } = fixture({ canLoad: () => allowed, load: () => loading.promise });
  bank.setManifest({ step: sample() });
  bank.request('step');
  allowed = false;
  loading.resolve(new ArrayBuffer(16));
  await settled(bank);
  assert.equal(calls.decode.length, 0);
  assert.equal(bank.snapshot().failed, 0);
  allowed = true;
  bank.request('step');
  await settled(bank);
  assert.equal(calls.decode.length, 1);
});

test('muting while decoding awaits discards the result instead of caching it', async () => {
  let allowed = true;
  const decoding = deferred();
  const { bank, calls } = fixture({ canLoad: () => allowed, decode: () => decoding.promise });
  bank.setManifest({ step: sample() });
  bank.request('step');
  await Promise.resolve();
  assert.equal(calls.decode.length, 1);
  allowed = false;
  decoding.resolve(fakeBuffer());
  await settled(bank);
  assert.equal(bank.snapshot().cached, 0);
  assert.equal(bank.snapshot().failed, 0);
  assert.equal(bank.peek('step'), null);
});

test('a queued variant rechecks its gate before it starts a load', async () => {
  let allowed = true;
  const loading = deferred();
  const { bank, calls } = fixture({ canLoad: () => allowed, load: () => loading.promise });
  bank.setManifest({ step: [sample('/audio/a.wav'), sample('/audio/b.wav'), sample('/audio/c.wav')] });
  bank.request('step');
  assert.equal(bank.snapshot().pending, 2);
  assert.equal(bank.snapshot().queued, 1);
  allowed = false;
  loading.resolve(new ArrayBuffer(16));
  await settled(bank);
  assert.equal(calls.load.length, 2);
  assert.equal(calls.decode.length, 0);
  assert.equal(bank.snapshot().queued, 0);
});

test('a decode retains its worker slot until it settles', async () => {
  const decoding = deferred();
  const { bank, calls } = fixture({ decode: () => decoding.promise });
  bank.setManifest({ step: [sample('/audio/a.wav'), sample('/audio/b.wav'), sample('/audio/c.wav')] });
  bank.request('step');
  await Promise.resolve();
  assert.equal(calls.load.length, 2);
  assert.equal(calls.decode.length, 2);
  assert.equal(bank.snapshot().pending, 2);
  assert.equal(bank.snapshot().queued, 1);
  decoding.resolve(fakeBuffer());
  await settled(bank);
  assert.equal(calls.load.length, 3);
  assert.equal(calls.decode.length, 3);
});

test('cancel aborts loads, clears pending work, and prevents late decode', async () => {
  const loading = deferred();
  const { bank, calls } = fixture({ load: () => loading.promise });
  bank.setManifest({ step: sample() });
  bank.request('step');
  const generation = bank.snapshot().generation;
  bank.cancel();
  assert.equal(bank.snapshot().generation, generation + 1);
  assert.equal(bank.snapshot().pending, 0);
  assert.equal(bank.snapshot().queued, 0);
  assert.equal(calls.load[0].signal.aborted, true);
  loading.resolve(new ArrayBuffer(16));
  await settled(bank);
  assert.equal(calls.decode.length, 0);
  assert.equal(bank.snapshot().cached, 0);
});

test('cancel also rejects an already-decoding result from an earlier generation', async () => {
  const decoding = deferred();
  const { bank, calls } = fixture({ decode: () => decoding.promise });
  bank.setManifest({ step: sample() });
  bank.request('step');
  await Promise.resolve();
  assert.equal(calls.decode.length, 1);
  bank.cancel();
  decoding.resolve(fakeBuffer());
  await settled(bank);
  assert.equal(bank.snapshot().cached, 0);
  assert.equal(bank.snapshot().failed, 0);
});

test('new manifests cannot receive old results or failure state', async () => {
  const loading = deferred();
  const { bank, calls } = fixture({ load: entry => entry.url.endsWith('old.wav') ? loading.promise : new ArrayBuffer(16) });
  bank.setManifest({ cue: sample('/audio/old.wav') });
  bank.request('cue');
  bank.setManifest({ cue: sample('/audio/new.wav', 'radio', 0.6) });
  assert.equal(calls.load[0].signal.aborted, true);
  bank.request('cue');
  loading.reject(new Error('Old request failed'));
  await settled(bank);
  assert.equal(calls.decode.length, 1);
  assert.equal(bank.snapshot().failed, 0);
  assert.equal(bank.peek('cue').gain, 0.6);
});

test('cancel retains valid cache and manifest while clear drops cache too', async () => {
  const { bank, calls } = fixture();
  bank.setManifest({ step: sample() });
  bank.request('step');
  await settled(bank);
  const original = bank.peek('step').buffer;
  bank.cancel();
  assert.ok(bank.peek('step').buffer === original);
  assert.equal(bank.snapshot().groups, 1);
  bank.clear();
  assert.equal(bank.peek('step'), null);
  assert.equal(bank.snapshot().bytes, 0);
  assert.equal(bank.snapshot().groups, 1);
  bank.request('step');
  await settled(bank);
  assert.equal(calls.load.length, 2);
});

test('cancelled loaders that ignore abort still occupy the two physical worker slots', async () => {
  const loading = deferred();
  const { bank, calls } = fixture({ load: entry => entry.url.includes('old') ? loading.promise : new ArrayBuffer(16) });
  bank.setManifest({ old: [sample('/audio/old-a.wav'), sample('/audio/old-b.wav')], fresh: sample('/audio/fresh.wav') });
  bank.request('old');
  bank.cancel();
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(bank.request('fresh'), true);
    assert.equal(bank.snapshot().pending, 0);
    assert.equal(bank.snapshot().inFlight, 2);
    assert.equal(bank.snapshot().queued, 1);
    assert.equal(calls.load.length, 2);
  }
  loading.resolve(new ArrayBuffer(16));
  await settled(bank);
  assert.equal(calls.load.length, 3);
  assert.equal(calls.decode.length, 1);
  assert.ok(bank.peek('fresh'));
});

test('manifest and request floods stay within group, variant, entry, and queue limits', async () => {
  const loading = deferred();
  const { bank, calls } = fixture({ load: () => loading.promise });
  const variants = Array.from({ length: 12 }, (_, index) => sample(`/audio/step-${index}.wav`));
  bank.setManifest({ step: variants });
  assert.equal(bank.snapshot().entries, 5);
  bank.setManifest(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`single-${index}`, sample()])));
  assert.equal(bank.snapshot().groups, 32);
  assert.equal(bank.snapshot().entries, 32);
  bank.setManifest(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`group-${index}`, variants])));
  assert.equal(bank.snapshot().groups, 13);
  assert.equal(bank.snapshot().entries, 64);
  for (let attempt = 0; attempt < 100; attempt++) bank.preload();
  assert.equal(bank.snapshot().pending, 2);
  assert.equal(bank.snapshot().queued, 62);
  assert.equal(calls.load.length, 2);
  loading.resolve(new ArrayBuffer(16));
  await settled(bank);
  assert.equal(calls.load.length, 64);
  assert.equal(bank.snapshot().cached, 32);
});

test('repeated preloads do not reload evicted warm samples, but explicit requests can', async () => {
  const { bank, calls } = fixture();
  bank.setManifest(Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`group-${index}`, [
    sample(`/audio/${index}-a.wav`), sample(`/audio/${index}-b.wav`),
  ]])));
  assert.equal(bank.preload(), 32);
  await settled(bank);
  assert.equal(calls.load.length, 64);
  assert.equal(bank.snapshot().cached, 32);
  assert.equal(bank.peek('group-0'), null);
  for (let tick = 0; tick < 100; tick++) assert.equal(bank.preload(), 0);
  await settled(bank);
  assert.equal(calls.load.length, 64);
  assert.equal(bank.snapshot().pending, 0);
  assert.equal(bank.snapshot().queued, 0);

  bank.cancel();
  assert.equal(bank.preload(), 0, 'completed warmup survives cancellation');
  assert.equal(bank.request('group-0'), true, 'a real event can request evicted variants');
  await settled(bank);
  assert.equal(calls.load.length, 66);
  assert.ok(bank.peek('group-0'));
  assert.equal(bank.snapshot().cached, 32);
  for (let tick = 0; tick < 100; tick++) assert.equal(bank.preload(), 0);
  assert.equal(calls.load.length, 66);
});

test('canceled in-flight and queued preloads retry without repeating completed warmup', async () => {
  let allowed = true;
  const loading = deferred();
  const { bank, calls } = fixture({
    canLoad: () => allowed,
    load: entry => entry.id === 'warm' ? new ArrayBuffer(16) : loading.promise,
  });
  bank.setManifest({
    warm: sample('/audio/warm.wav'),
    cold: Array.from({ length: 4 }, (_, index) => sample(`/audio/cold-${index}.wav`)),
  });
  bank.request('warm');
  await settled(bank);
  assert.equal(bank.preload(), 1);
  assert.equal(bank.snapshot().pending, 2);
  assert.equal(bank.snapshot().queued, 2);
  allowed = false;
  bank.cancel();
  assert.equal(bank.preload(), 0);
  assert.equal(bank.snapshot().queued, 0);
  allowed = true;
  assert.equal(bank.preload(), 1);
  assert.equal(bank.snapshot().pending, 0);
  assert.equal(bank.snapshot().inFlight, 2);
  assert.equal(bank.snapshot().queued, 4);
  loading.resolve(new ArrayBuffer(16));
  await settled(bank);
  assert.equal(calls.load.filter(entry => entry.id === 'warm').length, 1);
  assert.equal(calls.load.length, 7, 'the two canceled loads retry, along with the untouched queue');
  assert.equal(calls.decode.length, 5);
  assert.equal(bank.snapshot().cached, 5);
  assert.equal(bank.snapshot().failed, 0);
  assert.equal(bank.preload(), 0);
});

test('clearing buffers or replacing a manifest allows a fresh warmup', async () => {
  const { bank, calls } = fixture();
  const manifest = { step: sample() };
  bank.setManifest(manifest);
  bank.preload();
  await settled(bank);
  bank.cancel();
  assert.equal(bank.preload(), 0);
  bank.clear();
  assert.equal(bank.preload(), 1);
  await settled(bank);
  assert.equal(calls.load.length, 2);
  bank.setManifest(manifest);
  assert.equal(bank.preload(), 1);
  await settled(bank);
  assert.equal(calls.load.length, 3);
});

test('a priority request promotes queued radio variants without adding workers or duplicate loads', async () => {
  const loading = deferred();
  let peakWorkers = 0;
  const { bank, calls } = fixture({ load: entry => {
    peakWorkers = Math.max(peakWorkers, bank.snapshot().inFlight);
    return entry.url.endsWith('foley-0.wav') || entry.url.endsWith('foley-1.wav') ? loading.promise : new ArrayBuffer(16);
  } });
  bank.setManifest({
    foley: Array.from({ length: 4 }, (_, index) => sample(`/audio/foley-${index}.wav`)),
    radio: [sample('/audio/radio-a.wav', 'radio'), sample('/audio/radio-b.wav', 'radio')],
    ambience: sample('/audio/room.wav', 'ambience'),
  });
  bank.preload();
  assert.equal(bank.snapshot().pending, 2);
  assert.equal(bank.snapshot().queued, 5);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal(bank.request('radio', { priority: true }), true);
  assert.equal(calls.load.length, 2);
  assert.equal(bank.snapshot().pending, 2);
  assert.equal(bank.snapshot().queued, 5);
  loading.resolve(new ArrayBuffer(16));
  await settled(bank);
  assert.deepEqual(calls.load.map(entry => entry.url), [
    '/audio/foley-0.wav', '/audio/foley-1.wav', '/audio/radio-a.wav', '/audio/radio-b.wav',
    '/audio/foley-2.wav', '/audio/foley-3.wav', '/audio/room.wav',
  ]);
  assert.equal(peakWorkers, 2);
  assert.equal(bank.snapshot().cached, 7);
  assert.equal(bank.preload(), 0);
});

test('new priority variants join the front while a normal request keeps queue order', async () => {
  for (const priority of [false, true]) {
    const loading = deferred();
    const { bank, calls } = fixture({ load: entry => entry.url.includes('busy-') ? loading.promise : new ArrayBuffer(16) });
    bank.setManifest({
      foley: [sample('/audio/busy-a.wav'), sample('/audio/busy-b.wav'), sample('/audio/queued.wav')],
      radio: [sample('/audio/radio-a.wav', 'radio'), sample('/audio/radio-b.wav', 'radio')],
    });
    bank.request('foley');
    bank.request('radio', { priority });
    bank.request('radio', { priority });
    assert.equal(bank.snapshot().pending, 2);
    assert.equal(bank.snapshot().queued, 3);
    assert.equal(calls.load.length, 2);
    loading.resolve(new ArrayBuffer(16));
    await settled(bank);
    assert.deepEqual(calls.load.slice(2).map(entry => entry.url), priority
      ? ['/audio/radio-a.wav', '/audio/radio-b.wav', '/audio/queued.wav']
      : ['/audio/queued.wav', '/audio/radio-a.wav', '/audio/radio-b.wav']);
  }
});

test('the decoded cache uses a bounded least-recently-used budget', async () => {
  const { bank, calls } = fixture();
  const manifest = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`sample-${index}`, sample(`/audio/${index}.wav`)]));
  manifest['sample-31'] = [sample('/audio/31.wav'), sample('/audio/extra.wav')];
  bank.setManifest(manifest);
  for (let index = 0; index < 31; index++) bank.request(`sample-${index}`);
  await settled(bank);
  assert.ok(bank.peek('sample-0'));
  bank.request('sample-31');
  await settled(bank);
  assert.equal(bank.snapshot().cached, 32);
  assert.ok(bank.peek('sample-0'), 'a recently read sample is kept');
  assert.equal(bank.peek('sample-1'), null, 'the oldest sample is evicted');
  assert.equal(calls.load.length, 33);
});

test('decoded memory stays under 16 MiB independently of the sample count', async () => {
  const buffer = fakeBuffer({ length: 393216, numberOfChannels: 2, sampleRate: 65536 });
  const { bank } = fixture({ decode: () => buffer });
  bank.setManifest(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`sample-${index}`, sample(`/audio/${index}.wav`)])));
  bank.preload();
  await settled(bank);
  assert.equal(bank.snapshot().cached, 5);
  assert.equal(bank.snapshot().bytes, 15 * 1024 * 1024);
  assert.equal(bank.peek('sample-0'), null);
  assert.ok(bank.peek('sample-11'));
});

test('channel views cannot conceal oversized backing allocations from the memory budget', async () => {
  const valid = fakeBuffer();
  const largeView = new Float32Array(3 * 1024 * 1024 / 4 + 1).subarray(0, valid.length);
  const rejected = fixture({ decode: () => ({ ...valid, getChannelData: () => largeView }) });
  rejected.bank.setManifest({ step: sample() });
  rejected.bank.request('step');
  await settled(rejected.bank);
  assert.equal(rejected.bank.snapshot().failed, 1);
  assert.equal(rejected.bank.snapshot().cached, 0);

  const shared = new Float32Array(4096);
  const accepted = fixture({ decode: () => ({ ...valid, numberOfChannels: 2, getChannelData: channel => shared.subarray(channel * valid.length, (channel + 1) * valid.length) }) });
  accepted.bank.setManifest({ step: sample() });
  accepted.bank.request('step');
  await settled(accepted.bank);
  assert.equal(accepted.bank.snapshot().cached, 1);
  assert.equal(accepted.bank.snapshot().bytes, shared.byteLength, 'shared channel backing is counted once');
});

test('invalid or excessive encoded data is rejected before decoding', async () => {
  for (const bytes of [null, new Uint8Array(16), new ArrayBuffer(0), new ArrayBuffer(3 * 1024 * 1024 + 1)]) {
    const { bank, calls } = fixture({ load: () => bytes });
    bank.setManifest({ step: sample() });
    bank.request('step');
    await settled(bank);
    assert.equal(calls.decode.length, 0);
    assert.equal(bank.snapshot().failed, 1);
    assert.equal(bank.request('step'), false);
  }
  const { bank, calls } = fixture({ load: () => new ArrayBuffer(3 * 1024 * 1024) });
  bank.setManifest({ step: sample() });
  bank.request('step');
  await settled(bank);
  assert.equal(calls.decode.length, 1);
  assert.equal(bank.snapshot().cached, 1);
});

test('decoded samples must have sane duration, dimensions, and channel data', async () => {
  const valid = fakeBuffer();
  const invalid = [
    null, {}, { ...valid, length: 0 }, { ...valid, length: 4.5 }, { ...valid, duration: 0 },
    { ...valid, duration: NaN }, { ...valid, duration: Infinity }, { ...valid, duration: 8.1 },
    { ...valid, numberOfChannels: 0 }, { ...valid, numberOfChannels: 3 },
    { ...valid, sampleRate: 0 }, { ...valid, sampleRate: NaN }, { ...valid, duration: 1 },
    { ...valid, getChannelData: () => new Float32Array(3) },
    { ...valid, getChannelData: () => new Uint8Array(400) },
    { ...valid, getChannelData: () => { throw new Error('Detached channel'); } },
    fakeBuffer({ length: 64001, sampleRate: 8000, duration: 8 }),
    fakeBuffer({ length: 768000, numberOfChannels: 2, sampleRate: 96000 }),
  ];
  for (const buffer of invalid) {
    const { bank } = fixture({ decode: () => buffer });
    bank.setManifest({ step: sample() });
    bank.request('step');
    await settled(bank);
    assert.equal(bank.snapshot().cached, 0);
    assert.equal(bank.snapshot().failed, 1);
  }
  const { bank } = fixture({ decode: () => fakeBuffer({ length: 384000, numberOfChannels: 2, sampleRate: 48000 }) });
  bank.setManifest({ step: sample() });
  bank.request('step');
  await settled(bank);
  assert.equal(bank.snapshot().cached, 1, 'an eight-second stereo 48 kHz sample fits');
});

test('load and decode failures are contained and do not retry until the manifest changes', async () => {
  for (const failure of ['load', 'decode']) {
    const { bank, calls } = fixture({ [failure]: () => { throw new Error('Unavailable asset'); } });
    bank.setManifest({ step: sample() });
    bank.request('step');
    await settled(bank);
    for (let attempt = 0; attempt < 20; attempt++) assert.equal(bank.request('step'), false);
    bank.cancel();
    bank.clear();
    assert.equal(bank.preload(), 0);
    assert.equal(calls.load.length, 1);
    assert.equal(bank.snapshot().failed, 1);
    bank.setManifest({ step: sample() });
    bank.request('step');
    await settled(bank);
    assert.equal(calls.load.length, 2);
  }
});

test('asynchronous failures release workers and allow other samples to finish', async () => {
  const { bank, calls } = fixture({
    load: entry => entry.url.endsWith('load-fail.wav') ? Promise.reject(new Error('Missing sample')) : new ArrayBuffer(entry.url.endsWith('decode-fail.wav') ? 8 : 16),
    decode: bytes => bytes.byteLength === 8 ? Promise.reject(new Error('Unsupported sample')) : fakeBuffer(),
  });
  bank.setManifest({ step: [sample('/audio/load-fail.wav'), sample('/audio/decode-fail.wav'), sample('/audio/good.wav')] });
  bank.request('step');
  await settled(bank);
  assert.equal(calls.load.length, 3);
  assert.equal(calls.decode.length, 2);
  assert.equal(bank.snapshot().failed, 2);
  assert.equal(bank.snapshot().cached, 1);
  assert.ok(bank.peek('step'));
  assert.equal(bank.request('step'), true, 'a usable variant remains despite failures');
  assert.equal(calls.load.length, 3);
});

test('unsupported or throwing gates remain safe without scheduling work', () => {
  for (const canLoad of [null, () => { throw new Error('No audio state'); }, () => 1]) {
    const { bank, calls } = fixture({ canLoad });
    bank.setManifest({ step: sample() });
    assert.equal(bank.request('step'), false);
    assert.equal(bank.preload(), 0);
    assert.equal(calls.load.length, 0);
  }
  for (const options of [{}, { load: () => new ArrayBuffer(16) }, { decode: () => fakeBuffer() }]) {
    const bank = createSampleBank({ ...options, canLoad: () => true });
    bank.setManifest({ step: sample() });
    assert.equal(bank.request('step'), false);
  }
});

test('manifest state is copied, snapshots cannot mutate it, and replacement clears cache', async () => {
  const entry = sample('/audio/step.wav', 'effects', 0.5);
  const { bank, calls } = fixture();
  bank.setManifest(new Map([['step', entry]]));
  entry.url = 'https://evil.example/step.wav';
  entry.gain = 0;
  const status = bank.snapshot();
  status.groups = 10000;
  bank.request('step');
  await settled(bank);
  assert.equal(calls.load[0].url, '/audio/step.wav');
  assert.equal(bank.peek('step').gain, 0.5);
  assert.equal(bank.snapshot().groups, 1);
  bank.setManifest(null);
  assert.equal(bank.snapshot().groups, 0);
  assert.equal(bank.snapshot().cached, 0);
  assert.equal(bank.snapshot().bytes, 0);
  assert.equal(bank.request('step'), false);
});
