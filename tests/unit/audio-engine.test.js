import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioController } from '../../src/core/audio.js';
import { DEFAULT_AUDIO_MIX, normalizeAudioMix, audioSurface, surfaceSoundProfile, describeAudioEvent } from '../../src/core/audio-model.js';
import { createLocalSpeechAdapter } from '../../src/core/local-speech.js';

// Pure in-memory audio graph. No device, browser, fetch, speech service, or timer
// is used. The test advances its own clock and records every allocation/call.
function mockContext() {
  const nodes = [], sources = [], gains = [], events = [];
  const counts = { contexts: 0, buffers: 0, decodes: 0, resumes: 0, suspends: 0 };
  function param(value = 0) {
    return {
      value, events: [],
      cancelScheduledValues(time) { this.events.push(['cancel', time]); },
      setValueAtTime(next, time) { assert.ok(Number.isFinite(next)); this.value = next; this.events.push(['set', next, time]); },
      linearRampToValueAtTime(next, time) { assert.ok(Number.isFinite(next)); this.value = next; this.events.push(['linear', next, time]); },
      exponentialRampToValueAtTime(next, time) { assert.ok(next > 0 && Number.isFinite(next)); this.value = next; this.events.push(['exponential', next, time]); },
    };
  }
  function node(kind) {
    const value = {
      kind, connections: [], disconnects: 0, stops: [], starts: [],
      gain: param(), frequency: param(), Q: param(), pan: param(), playbackRate: param(1),
      threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
      connect(target) { this.connections.push(target); return target; },
      disconnect() { this.disconnects++; },
      start(...args) { this.starts.push(args); events.push({ type: 'start', source: this, args }); },
      stop(time) {
        this.stops.push(time);
        if (time === undefined) this.finish();
        else this.endsAt = time;
      },
      finish() {
        if (this.finished) return;
        this.finished = true;
        this.onended?.();
      },
    };
    nodes.push(value);
    if (kind === 'gain') gains.push(value);
    if (kind === 'source' || kind === 'oscillator') sources.push(value);
    return value;
  }
  const context = {
    state: 'suspended', sampleRate: 1000, currentTime: 0, destination: { kind: 'destination' },
    createGain: () => node('gain'), createBufferSource: () => node('source'),
    createOscillator: () => node('oscillator'), createBiquadFilter: () => node('filter'),
    createStereoPanner: () => node('panner'), createDynamicsCompressor: () => node('compressor'),
    createBuffer(channels, length, sampleRate) {
      counts.buffers++;
      const pcm = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, duration: length / sampleRate, sampleRate, numberOfChannels: channels, getChannelData: channel => pcm[channel] };
    },
    decodeAudioData() { counts.decodes++; return Promise.resolve(decodedSample()); },
    resume() { counts.resumes++; this.state = 'running'; return Promise.resolve(); },
    suspend() { counts.suspends++; this.state = 'suspended'; return Promise.resolve(); },
    close() { this.state = 'closed'; return Promise.resolve(); },
  };
  return {
    context, nodes, sources, gains, events, counts,
    createContext: () => { counts.contexts++; return context; },
    advance(dt) {
      if (context.state !== 'running') return;
      context.currentTime += dt;
      for (const source of sources) if (source.endsAt <= context.currentTime) source.finish();
    },
  };
}

function decodedSample(duration = 1.6) {
  const length = Math.round(duration * 1000), pcm = new Float32Array(length);
  return { duration: length / 1000, length, sampleRate: 1000, numberOfChannels: 1, getChannelData: () => pcm };
}

function mockSpeech() {
  const requests = [];
  const state = { available: 0, cancels: 0, active: false };
  return {
    requests, state,
    available() { state.available++; return true; },
    speak(request) { requests.push(request); state.active = true; return true; },
    cancel() { state.cancels++; state.active = false; return true; },
    pending: () => state.active,
  };
}

async function makeActive(options = {}) {
  const fake = mockContext();
  const audio = createAudioController({ createContext: fake.createContext, random: () => 0.5, ...options });
  audio.setMuted(false);
  assert.equal(await audio.resume(), true);
  return { audio, fake };
}

async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function advance(audio, fake, duration, state = {}) {
  for (let remaining = duration; remaining > 0.000001; remaining -= 0.05) {
    const step = Math.min(0.05, remaining); fake.advance(step); audio.tick(step, state);
  }
}
const allEffects = [
  'gunshot', 'pistolShot', 'shotgunShot', 'smgShot', 'machinegunShot', 'footstep',
  'meleeHit', 'meleeSwing', 'movement', 'impact', 'surfaceImpact', 'weaponMechanical',
  'dryClick', 'reloadClack', 'pickupChime', 'startAmbient', 'startFireCrackle',
];

test('vertical landing weight is independent of horizontal walking speed', async () => {
  const { audio, fake } = await makeActive();
  const levels = speed => {
    const first = fake.gains.length;
    audio.movement({ action: 'land', surface: 'concrete', intensity: 1.25, speed });
    return fake.gains.slice(first).flatMap(node => node.gain.events.filter(event => event[0] === 'linear').map(event => event[1]));
  };
  const standing = levels(0), running = levels(7);
  assert.deepEqual(standing, running);
  assert.ok(standing[0] > 0.15, 'Fall intensity remains stronger than an ordinary footstep');
});

test('mix preferences clamp finite values, ignore unknowns, and cannot mutate defaults or snapshots', () => {
  const next = normalizeAudioMix({ master: 2, effects: -1, ambience: NaN, music: '1', radio: 0.3, unknown: 1 });
  assert.deepEqual(next, { ...DEFAULT_AUDIO_MIX, master: 1, effects: 0, radio: 0.3 });
  assert.ok(Object.isFrozen(next));
  const fake = mockContext(), audio = createAudioController({ createContext: fake.createContext });
  audio.setMix(next); audio.setVoiceEnabled(true);
  const status = audio.getStatus(); status.mix.master = 0.9;
  assert.equal(audio.getStatus().mix.master, 1);
  assert.equal(fake.counts.contexts, 0);
  assert.equal(audio.isMuted(), true);
});

test('every new feature remains allocation-free under immutable hard mute', async () => {
  for (const policy of [{ search: '?mute=1' }, { search: '?qa=1' }, { search: '?qa=0&qa=TRUE' }, { webdriver: true }]) {
    const fake = mockContext(), speech = mockSpeech();
    let loads = 0;
    const audio = createAudioController({ ...policy, createContext: fake.createContext, speechAdapter: speech,
      sampleLoader: async () => { loads++; return new ArrayBuffer(4); } });
    audio.setSampleManifest({ 'radio:ready': { url: '/assets/audio/ready.wav', bus: 'radio' },
      'footstep:concrete': { url: '/assets/audio/step.wav', bus: 'effects' } });
    audio.setMix({ master: 1, effects: 1, ambience: 1, music: 1, radio: 1 });
    audio.setVoiceEnabled(true);
    for (let i = 0; i < 3; i++) {
      audio.setMuted(false); await audio.resume();
      for (const name of allEffects) audio[name]({ surface: 'metal', action: 'land' });
      audio.announceCheckpoint({ id: String(i), text: 'Hold position.', sampleId: 'radio:ready' });
      audio.tick(0.1, { zone: 'roof', threat: 1 });
      await audio.suspend();
    }
    await audio.reset(); await settle();
    assert.deepEqual(fake.counts, { contexts: 0, buffers: 0, decodes: 0, resumes: 0, suspends: 0 });
    assert.equal(fake.nodes.length, 0);
    assert.equal(loads, 0);
    assert.equal(speech.state.available, 0);
    assert.equal(speech.requests.length, 0);
    assert.equal(speech.state.cancels, 0);
    assert.equal(audio.isHardMuted(), true);
    assert.equal(audio.isMuted(), true);
  }
});

test('bus graph separates effects, ambience, score, and radio behind master and immediate mute gate', async () => {
  const { audio, fake } = await makeActive();
  const [master, gate, effects, ambience, music, radio] = fake.gains;
  assert.equal(master.gain.value, DEFAULT_AUDIO_MIX.master);
  assert.equal(gate.gain.value, 1);
  for (const [bus, key] of [[effects, 'effects'], [ambience, 'ambience'], [music, 'music'], [radio, 'radio']]) {
    assert.equal(bus.gain.value, DEFAULT_AUDIO_MIX[key]);
    assert.ok(bus.connections.includes(master));
  }
  const limiter = fake.nodes.find(node => node.kind === 'compressor');
  assert.ok(master.connections.includes(limiter));
  assert.ok(limiter.connections.includes(gate));
  assert.ok(gate.connections.includes(fake.context.destination));
  audio.setMix({ effects: 0.2, ambience: 0.1, music: 0.15, radio: 0.7 });
  assert.equal(effects.gain.value, 0.2);
  assert.equal(ambience.gain.value, 0.1);
  assert.equal(music.gain.value, 0.15);
  assert.equal(radio.gain.value, 0.7);
});

test('zero effect volume forbids sources and buffers while the other buses remain usable', async () => {
  const { audio, fake } = await makeActive();
  audio.setMix({ effects: 0 });
  const before = fake.nodes.length;
  for (const name of allEffects.filter(name => !name.startsWith('start'))) audio[name]();
  assert.equal(fake.nodes.length, before);
  assert.equal(fake.counts.buffers, 0);
  audio.startAmbient();
  assert.equal(audio.getStatus().resources.voices, 2);
  audio.setMix({ ambience: 0 });
  assert.equal(audio.getStatus().resources.voices, 0);
  const after = fake.nodes.length;
  audio.startAmbient(); audio.startFireCrackle();
  assert.equal(fake.nodes.length, after);
  audio.setMix({ ambience: 0.3 });
  assert.equal(fake.nodes.length, after, 'preference change does not allocate sound nodes');
  audio.tick(0.01);
  assert.ok(audio.getStatus().resources.voices >= 4);
});

test('master zero immediately stops every voice and blocks speech, samples, and all further sound nodes', async () => {
  const speech = mockSpeech();
  const { audio, fake } = await makeActive({ speechAdapter: speech });
  audio.setVoiceEnabled(true); audio.startAmbient(); audio.pistolShot();
  audio.announceCheckpoint({ id: 'one', text: 'Keep moving.' });
  audio.tick(0.01, { threat: 1 });
  audio.setMix({ master: 0 });
  const allocated = fake.nodes.length;
  assert.equal(fake.gains[0].gain.value, 0);
  assert.equal(audio.getStatus().resources.voices, 0);
  assert.equal(audio.getStatus().radioActive, false);
  assert.equal(speech.state.cancels, 1);
  for (const name of allEffects) audio[name]();
  audio.announceCheckpoint({ id: 'two', text: 'Stop.' });
  advance(audio, fake, 10, { threat: 1 });
  assert.equal(fake.nodes.length, allocated);
  assert.equal(speech.requests.length, 1);
});

test('surface foley and environment profiles are distinct, bounded, and normalize common material names', () => {
  assert.equal(audioSurface('brick'), 'concrete'); assert.equal(audioSurface('flesh'), 'body');
  assert.equal(audioSurface('rubber'), 'cloth'); assert.equal(audioSurface('unknown'), 'concrete');
  assert.equal(audioSurface('roofMetal'), 'metal'); assert.equal(audioSurface('agedStone'), 'concrete');
  assert.equal(audioSurface('wallpaper'), 'concrete'); assert.equal(audioSurface('tar'), 'concrete');
  assert.notEqual(surfaceSoundProfile('wood').cutoff, surfaceSoundProfile('metal').cutoff);
  assert.ok(surfaceSoundProfile('metal').resonance > 0);
  assert.equal(describeAudioEvent({ environment: 'neighbor' }).interior, true);
  assert.equal(describeAudioEvent({ environment: 'roof' }).interior, false);
});

test('listener yaw pans to the correct ear and distant attenuation cannot silence a local event with no position', () => {
  const eye = { position: { x: 0, y: 2, z: 0 }, yaw: 0 };
  const right = describeAudioEvent({ pos: { x: 8, y: 2, z: -4 } }, eye);
  const left = describeAudioEvent({ pos: { x: -8, y: 2, z: -4 } }, eye);
  assert.ok(right.pan > 0 && left.pan < 0);
  assert.equal(right.gain, left.gain);
  assert.ok(describeAudioEvent({ pos: { x: 0, y: 2, z: -8 } }, { ...eye, yaw: Math.PI / 2 }).pan > 0);
  assert.equal(describeAudioEvent({ pos: { x: 100, y: 2, z: 0 } }, eye).gain, 0);
  assert.equal(describeAudioEvent({}, { position: { x: 300, y: 100, z: 400 }, yaw: 2 }).gain, 1);
  assert.equal(describeAudioEvent({ intensity: -2 }).gain, 0);
  assert.equal(describeAudioEvent({ pos: { x: NaN, y: 0, z: 0 } }, eye).pan, 0);
});

test('actual event graph supports positional balance and a short interior reflection without changing own-shot origin', async () => {
  const { audio, fake } = await makeActive();
  audio.setListener({ position: { x: 10, y: 2, z: 10 }, yaw: 0 });
  audio.pistolShot();
  assert.equal(fake.sources.length, 2);
  assert.equal(fake.nodes.filter(node => node.kind === 'panner').length, 0);
  audio.pistolShot({ pos: { x: 20, y: 2, z: 9 }, environment: 'neighbor' });
  assert.equal(fake.sources.length, 5);
  assert.ok(fake.nodes.some(node => node.kind === 'panner' && node.pan.value > 0));
  assert.ok(fake.sources.at(-1).starts[0][0] > fake.context.currentTime);
  const nodes = fake.nodes.length;
  audio.pistolShot({ pos: { x: 400, y: 0, z: 0 } });
  assert.equal(fake.nodes.length, nodes);
});

test('mechanical phase contacts and jump/landing are immediate, bounded events, not a scheduled full reload', async () => {
  const { audio, fake } = await makeActive();
  for (const action of ['reload-start', 'reload-insert', 'reload-end']) audio.weaponMechanical({ action, weapon: 'pistol' });
  assert.equal(fake.sources.length, 3);
  assert.ok(fake.sources.every(source => source.starts[0][0] === fake.context.currentTime));
  const cutoffs = fake.nodes.filter(node => node.kind === 'filter').map(node => node.frequency.value);
  assert.equal(new Set(cutoffs).size, 3);
  audio.movement({ action: 'jump' }); audio.movement({ action: 'land', surface: 'wood' });
  assert.equal(fake.sources.length, 6);
});

test('finished and stolen voices disconnect every owned filter, gain, and panner and stay within the voice budget', async () => {
  const { audio, fake } = await makeActive();
  audio.setListener({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });
  const baseNodes = fake.nodes.length;
  audio.footstep({ pos: { x: 2, y: 0, z: 0 }, surface: 'metal' });
  fake.advance(1);
  assert.equal(audio.getStatus().resources.voices, 0);
  assert.ok(fake.nodes.slice(baseNodes).every(node => node.disconnects === 1));
  for (let i = 0; i < 180; i++) audio.shotgunShot();
  assert.equal(audio.getStatus().resources.voices, 64);
  assert.ok(audio.getStatus().resources.noiseBuffers <= 4);
  await audio.suspend();
  assert.equal(audio.getStatus().resources.voices, 0);
  assert.ok(fake.nodes.slice(baseNodes).every(node => node.disconnects === 1));
});

test('score progresses only on positive active simulation time, skips walltime catchup, and resets deterministically', async () => {
  const { audio, fake } = await makeActive();
  audio.tick(0.01, { zone: 'roof', threat: 1 });
  const before = audio.getStatus();
  for (const dt of [0, -1, NaN, Infinity, '1']) audio.tick(dt, { zone: 'street', threat: 0 });
  assert.deepEqual(audio.getStatus().score, before.score);
  audio.tick(1000, { zone: 'roof', threat: 1 });
  assert.ok(audio.getStatus().elapsed - before.elapsed <= 0.2500001);
  await audio.suspend();
  const paused = audio.getStatus().score, starts = fake.sources.length;
  fake.context.currentTime += 3600;
  audio.tick(3600, { threat: 1 });
  assert.deepEqual(audio.getStatus().score, paused);
  assert.equal(fake.sources.length, starts);
  await audio.resume(); audio.tick(0.01, { zone: 'roof', threat: 1 });
  assert.ok(fake.sources.length - starts <= 3);
  await audio.reset();
  assert.equal(audio.getStatus().elapsed, 0);
  assert.equal(audio.getStatus().score.padCount, 0);
  assert.equal(audio.isMuted(), false);
  assert.equal(audio.getStatus().active, false);
});

test('radio tones duck only music, queues remain bounded, and duplicate checkpoint IDs do not replay', async () => {
  const { audio, fake } = await makeActive();
  audio.tick(0.01);
  const effects = fake.gains[2].gain.value, ambience = fake.gains[3].gain.value;
  assert.equal(audio.announceCheckpoint({ id: 'one', text: 'Start.' }), true);
  assert.equal(audio.announceCheckpoint({ id: 'one', text: 'Again.' }), false);
  assert.equal(fake.gains[4].gain.value, DEFAULT_AUDIO_MIX.music * 0.24);
  assert.equal(fake.gains[2].gain.value, effects); assert.equal(fake.gains[3].gain.value, ambience);
  for (let i = 0; i < 40; i++) audio.announceCheckpoint({ id: 'queued-' + i });
  assert.equal(audio.getStatus().radioQueued, 3);
  advance(audio, fake, 5);
  assert.equal(audio.getStatus().radioActive, false);
  assert.equal(audio.getStatus().radioQueued, 0);
  assert.equal(fake.gains[4].gain.value, DEFAULT_AUDIO_MIX.music);
});

test('voice opt-in, live volume products, and radio zero are independent from mute preference', async () => {
  const speech = mockSpeech();
  const { audio, fake } = await makeActive({ speechAdapter: speech });
  audio.announceCheckpoint({ id: 'tone', text: 'Silent narration preference.' });
  assert.equal(speech.requests.length, 0);
  audio.clearRadio(); audio.setVoiceEnabled(true);
  audio.setMix({ master: 0.5, radio: 0.6 });
  audio.announceCheckpoint({ id: 'voice', text: 'Move to the roof.' });
  assert.equal(speech.requests.length, 1);
  assert.equal(speech.requests[0].volume, 0.5 * 0.6 * 0.85);
  audio.setMix({ radio: 0.3 });
  assert.equal(speech.state.cancels, 1, 'an ongoing native voice cannot retain the old louder level');
  assert.equal(audio.getStatus().radioActive, false);
  audio.setMix({ radio: 0 });
  const nodes = fake.nodes.length;
  audio.announceCheckpoint({ id: 'zero', text: 'Do not speak.' });
  assert.equal(fake.nodes.length, nodes);
  assert.equal(speech.requests.length, 1);
  assert.equal(audio.isMuted(), false);
});

test('speech completion callbacks cannot start queued cues during dt zero or after pause/mute/reset', async () => {
  for (const operation of ['suspend', 'mute', 'reset', 'voiceOff', 'radioOff', 'dead']) {
    const speech = mockSpeech();
    const { audio, fake } = await makeActive({ speechAdapter: speech });
    audio.setVoiceEnabled(true);
    audio.announceCheckpoint({ id: 'first', text: 'Hold.' });
    audio.announceCheckpoint({ id: 'queued', text: 'Move.' });
    const stale = speech.requests[0];
    if (operation === 'suspend') await audio.suspend();
    if (operation === 'mute') audio.setMuted(true);
    if (operation === 'reset') await audio.reset();
    if (operation === 'voiceOff') audio.setVoiceEnabled(false);
    if (operation === 'radioOff') audio.setMix({ radio: 0 });
    if (operation === 'dead') audio.tick(0.01, { dead: true });
    const sources = fake.sources.length;
    stale.onend(); stale.onerror(); audio.tick(0);
    assert.equal(speech.requests.length, 1, operation);
    assert.equal(fake.sources.length, sources, operation);
    assert.equal(audio.getStatus().radioQueued, 0, operation);
    assert.equal(audio.getStatus().radioActive, false, operation);
  }
});

test('a voice-end callback marks completion but the next cue waits for a positive simulation step', async () => {
  const speech = mockSpeech();
  const { audio } = await makeActive({ speechAdapter: speech });
  audio.setVoiceEnabled(true);
  audio.announceCheckpoint({ id: 'first', text: 'Hold.' });
  audio.announceCheckpoint({ id: 'next', text: 'Go.' });
  speech.state.active = false; speech.requests[0].onend();
  for (let i = 0; i < 10; i++) audio.tick(0);
  assert.equal(speech.requests.length, 1);
  audio.tick(0.01);
  assert.equal(speech.requests.length, 2);
});

test('real local speech adapter retains failed cancellation through a partially scheduled error until mute retries', async () => {
  const spoken = [], state = { cancels: 0, speaking: false };
  const host = {
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {
      getVoices: () => [{ localService: true, lang: 'en-US', default: true }],
      speak(utterance) { spoken.push(utterance); state.speaking = true; throw new Error('Failed after scheduling'); },
      cancel() {
        state.cancels++;
        if (state.cancels < 3) throw new Error('Voice service still busy');
        state.speaking = false;
      },
    },
  };
  const adapter = createLocalSpeechAdapter(host);
  const { audio } = await makeActive({ speechAdapter: adapter });
  audio.setVoiceEnabled(true);
  assert.doesNotThrow(() => audio.announceCheckpoint({ id: 'failed', text: 'Hold.' }));
  assert.equal(state.cancels, 2, 'both the adapter and controller retain cancellation responsibility');
  assert.equal(state.speaking, true); assert.equal(adapter.pending(), true);
  audio.setMuted(true);
  assert.equal(state.cancels, 3);
  assert.equal(state.speaking, false); assert.equal(adapter.pending(), false);
  assert.equal(spoken.length, 1);
  await audio.reset();
  assert.equal(state.cancels, 3, 'an idle adapter is never touched');
});

test('sample loading and decoding never play old events when promises resolve', async () => {
  let finishLoad;
  const { audio, fake } = await makeActive({ sampleLoader: () => new Promise(resolve => { finishLoad = resolve; }) });
  audio.setSampleManifest({ 'footstep:wood': { url: '/assets/audio/wood.wav', bus: 'effects' } });
  audio.footstep({ surface: 'wood' });
  const starts = fake.sources.length;
  finishLoad(new ArrayBuffer(8)); await settle();
  assert.equal(fake.sources.length, starts);
  assert.equal(audio.getStatus().resources.samples.cached, 1);
  audio.footstep({ surface: 'wood' });
  assert.equal(fake.sources.length, starts + 1);
  assert.equal(fake.counts.decodes, 1);
});

test('mute or bus-zero during an asynchronous sample load blocks decode and discards stale work', async () => {
  for (const operation of ['mute', 'pause', 'reset', 'effectsOff', 'masterOff']) {
    let finishLoad;
    const { audio, fake } = await makeActive({ sampleLoader: () => new Promise(resolve => { finishLoad = resolve; }) });
    audio.setSampleManifest({ 'footstep:wood': { url: '/assets/audio/wood.wav', bus: 'effects' } });
    audio.footstep({ surface: 'wood' });
    if (operation === 'mute') audio.setMuted(true);
    if (operation === 'pause') await audio.suspend();
    if (operation === 'reset') await audio.reset();
    if (operation === 'effectsOff') audio.setMix({ effects: 0 });
    if (operation === 'masterOff') audio.setMix({ master: 0 });
    const starts = fake.sources.length;
    finishLoad(new ArrayBuffer(8)); await settle();
    assert.equal(fake.counts.decodes, 0, operation);
    assert.equal(fake.sources.length, starts, operation);
    assert.equal(audio.getStatus().resources.samples.cached, 0, operation);
  }
});

test('recorded radio retains its complete level with short edge fades and replaces native speech when ready', async () => {
  const speech = mockSpeech();
  const { audio, fake } = await makeActive({ speechAdapter: speech, sampleLoader: async () => new ArrayBuffer(8) });
  audio.setSampleManifest({ 'radio:ready': { url: '/assets/audio/ready.wav', bus: 'radio' } });
  audio.setVoiceEnabled(true); audio.tick(0.01); await settle();
  const before = fake.sources.length;
  audio.announceCheckpoint({ id: 'ready', text: 'Ready to move.', sampleId: 'radio:ready' });
  assert.equal(speech.requests.length, 0);
  assert.equal(fake.sources.length, before + 4);
  const clip = fake.sources.at(-1), filter = clip.connections[0], clipGain = filter.connections[0];
  assert.equal(clip.buffer.duration, 1.6);
  assert.equal(clipGain.gain.events.some(event => event[0] === 'exponential'), false);
  const holds = clipGain.gain.events.filter(event => event[0] === 'set' && event[1] === 0.7);
  assert.ok(holds.some(event => event[2] > fake.context.currentTime + 1.5));
  assert.equal(audio.getStatus().radioWaiting, false);
});

test('recorded footstep rate changes adjust clip end time and preserve the complete source duration', async () => {
  const { audio, fake } = await makeActive({ random: () => 0, sampleLoader: async () => new ArrayBuffer(8) });
  audio.setSampleManifest({ 'footstep:wood': { url: '/assets/audio/wood.wav', bus: 'effects' } });
  audio.tick(0.01); await settle();
  audio.footstep({ surface: 'wood' });
  const clip = fake.sources.at(-1);
  assert.equal(clip.playbackRate.value, 0.96);
  assert.ok(Math.abs(clip.starts[0][2] - 1.6) < 1e-9);
  assert.ok(Math.abs(clip.stops[0] - fake.context.currentTime - 1.6 / 0.96 - 0.02) < 1e-9);
});

test('actual reload phase calls use measured non-overlapping excerpts from one cached recorded buffer', async () => {
  const { audio, fake } = await makeActive({ sampleLoader: async () => new ArrayBuffer(8) });
  audio.setSampleManifest({ 'mechanical:reload-pistol': { url: '/assets/audio/reload.wav', bus: 'effects' } });
  audio.tick(0.01); await settle();
  const clips = [];
  for (const action of ['reload-start', 'reload-insert', 'reload-end']) {
    audio.weaponMechanical({ weapon: 'pistol', action }); clips.push(fake.sources.at(-1));
  }
  assert.deepEqual(clips.map(clip => clip.starts[0].slice(1)), [[0.06, 0.18], [0.98, 0.24], [1.26, 0.24]]);
  assert.ok(clips.every(clip => clip.buffer === clips[0].buffer));
  assert.equal(fake.counts.decodes, 1);
  assert.ok(clips.every(clip => clip.starts[0][0] === fake.context.currentTime));
});

test('first checkpoint waits a bounded simulation interval for its sample; async completion alone cannot start it', async () => {
  const speech = mockSpeech(); let finishLoad;
  const { audio, fake } = await makeActive({ speechAdapter: speech,
    sampleLoader: () => new Promise(resolve => { finishLoad = resolve; }) });
  audio.setSampleManifest({ 'radio:ready': { url: '/assets/audio/ready.wav', bus: 'radio' } });
  audio.setVoiceEnabled(true);
  audio.announceCheckpoint({ id: 'first', text: 'Ready.', zone: 'apartment', sampleId: 'radio:ready' });
  assert.equal(audio.getStatus().radioWaiting, true);
  assert.equal(speech.requests.length, 0);
  const initial = fake.sources.length;
  audio.tick(0); finishLoad(new ArrayBuffer(8)); await settle();
  assert.equal(fake.sources.length, initial);
  audio.tick(0);
  assert.equal(fake.sources.length, initial);
  audio.tick(0.01);
  assert.equal(audio.getStatus().radioWaiting, false);
  assert.equal(speech.requests.length, 0);
  assert.equal(fake.sources.filter(source => source.buffer?.duration === 1.6).length, 1);
});

test('slow radio sample falls back once after 650ms of active simulation and never replays when it finally arrives', async () => {
  const speech = mockSpeech(); let finishLoad;
  const { audio, fake } = await makeActive({ speechAdapter: speech,
    sampleLoader: () => new Promise(resolve => { finishLoad = resolve; }) });
  audio.setSampleManifest({ 'radio:ready': { url: '/assets/audio/ready.wav', bus: 'radio' } });
  audio.setVoiceEnabled(true);
  audio.announceCheckpoint({ id: 'first', text: 'Ready.', sampleId: 'radio:ready' });
  advance(audio, fake, 0.6); assert.equal(speech.requests.length, 0);
  for (let i = 0; i < 100; i++) audio.tick(0);
  assert.equal(speech.requests.length, 0);
  advance(audio, fake, 0.1); assert.equal(speech.requests.length, 1);
  const before = fake.sources.length;
  finishLoad(new ArrayBuffer(8)); await settle();
  assert.equal(fake.sources.length, before);
  advance(audio, fake, 0.2);
  assert.equal(fake.sources.filter(source => source.buffer?.duration === 1.6).length, 0);
  assert.equal(speech.requests.length, 1);
});

test('waiting radio samples cannot survive pause, mute, reset, or a superseding zone cue', async () => {
  for (const operation of ['pause', 'mute', 'reset', 'zone']) {
    let finishLoad;
    const speech = mockSpeech();
    const { audio, fake } = await makeActive({ speechAdapter: speech,
      sampleLoader: () => new Promise(resolve => { finishLoad = resolve; }) });
    audio.setSampleManifest({ 'radio:old': { url: '/assets/audio/old.wav', bus: 'radio' } });
    audio.setVoiceEnabled(true);
    audio.announceCheckpoint({ id: 'old', text: 'Old route.', zone: 'apartment', sampleId: 'radio:old' });
    if (operation === 'pause') await audio.suspend();
    if (operation === 'mute') audio.setMuted(true);
    if (operation === 'reset') await audio.reset();
    if (operation === 'zone') audio.announceCheckpoint({ id: 'new', text: 'New route.', zone: 'roof' });
    finishLoad(new ArrayBuffer(8)); await settle();
    advance(audio, fake, 1);
    assert.equal(fake.sources.filter(source => source.buffer?.duration === 1.6).length, 0, operation);
    assert.equal(speech.requests.some(request => request.text === 'Old route.'), false, operation);
  }
});

test('reset removes checkpoint history so a restarted checkpoint can speak exactly once again', async () => {
  const speech = mockSpeech(); const { audio } = await makeActive({ speechAdapter: speech });
  audio.setVoiceEnabled(true);
  const cue = { id: 'apartment', text: 'Move.' };
  audio.announceCheckpoint(cue); audio.clearRadio();
  assert.equal(audio.announceCheckpoint(cue), false);
  await audio.reset(); assert.equal(audio.getStatus().active, false);
  assert.equal(audio.announceCheckpoint(cue), false);
  await audio.resume();
  assert.equal(audio.announceCheckpoint(cue), true);
  assert.equal(speech.requests.length, 2);
});

test('invalid optional event values stay finite and malformed checkpoint data cannot allocate a cue', async () => {
  const { audio, fake } = await makeActive();
  for (const options of [undefined, null, {}, { intensity: Infinity, speed: NaN, pos: { x: NaN, y: 0, z: 0 } }]) {
    for (const name of allEffects) assert.doesNotThrow(() => audio[name](options), name);
  }
  const sources = fake.sources.length;
  for (const cue of [undefined, null, {}, { id: '' }, { id: 2 }]) assert.equal(audio.announceCheckpoint(cue), false);
  assert.equal(fake.sources.length, sources);
});
