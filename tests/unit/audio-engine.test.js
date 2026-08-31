import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioController } from '../../src/core/audio.js';
import { DEFAULT_AUDIO_MIX, normalizeAudioMix, audioSurface, surfaceSoundProfile, describeAudioEvent } from '../../src/core/audio-model.js';
import { createLocalSpeechAdapter } from '../../src/core/local-speech.js';
import { STREET_ATMOSPHERE } from '../../src/core/street-atmosphere.js';

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
const streetState = (zone = 'street') => ({ zone, threat: 0,
  listener: { position: { x: 8, y: 1.77, z: 18 }, yaw: 0 } });
function atmosphereSources(fake, kind) {
  const frequencies = kind ? [STREET_ATMOSPHERE[kind].frequency]
    : Object.values(STREET_ATMOSPHERE).map(profile => profile.frequency);
  return fake.sources.filter(source => source.kind === 'oscillator'
    && frequencies.includes(source.frequency.events[0]?.[1]));
}
function atmosphereGraph(source) {
  const filter = source.connections[0], envelope = filter.connections[0];
  const spatial = envelope.connections[0], panner = spatial.connections[0];
  assert.equal(filter.kind, 'filter'); assert.equal(spatial.kind, 'gain'); assert.equal(panner.kind, 'panner');
  return { filter, envelope, spatial, panner, bus: panner.connections[0] };
}
async function activeStreet(options) {
  const h = await makeActive(options);
  h.audio.setMix({ effects: 0, music: 0 });
  h.audio.startAmbient();
  return h;
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
      for (const zone of ['street', 'bakery']) for (let tick = 0; tick < 200; tick++) audio.tick(0.25, streetState(zone));
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

test('street alarm and distant siren are sparse positional ambience with no samples or effect-bus output', async () => {
  let loads = 0;
  const { audio, fake } = await activeStreet({ sampleLoader: () => { loads++; throw new Error('Atmosphere must be synthesized'); } });
  const state = streetState();
  advance(audio, fake, 11.05, state);
  assert.equal(atmosphereSources(fake, 'car-alarm').length, 3, 'One short alarm cluster precedes a long quiet gap');
  assert.equal(atmosphereSources(fake, 'distant-siren').length, 1);
  assert.equal(loads, 0); assert.equal(fake.counts.decodes, 0);
  assert.ok(audio.getStatus().resources.voices <= 3, 'Room tone plus at most one short atmospheric source');
  for (const [kind, profile] of Object.entries(STREET_ATMOSPHERE)) {
    const source = atmosphereSources(fake, kind)[0], graph = atmosphereGraph(source);
    assert.equal(source.type, profile.waveform);
    assert.equal(graph.bus, fake.gains[3], 'The existing ambience slider owns the cue');
    assert.equal(source.frequency.events.filter(event => event[0] === 'linear').length, profile.frequencyAutomation.length);
    assert.ok(source.stops[0] - source.starts[0][0] <= 5.1, 'Every cue has a bounded native-audio lifetime');
  }
  const siren = atmosphereSources(fake, 'distant-siren')[0], graph = atmosphereGraph(siren);
  const farGain = graph.spatial.gain.value, farPan = graph.panner.pan.value;
  assert.ok(farGain > 0 && farGain < 0.1); assert.ok(farPan < 0, 'The siren is beyond the west end of the block');
  const origin = STREET_ATMOSPHERE['distant-siren'].pos;
  state.listener.position = { x: origin.x + 4, y: 1.77, z: origin.z + 4 };
  audio.tick(0.01, state);
  assert.ok(graph.spatial.gain.value > farGain * 4, 'Approaching the source changes distance attenuation');
  const nearPan = graph.panner.pan.value;
  state.listener.yaw = Math.PI;
  audio.tick(0.01, state);
  assert.ok(nearPan < 0 && graph.panner.pan.value > 0, 'An already playing cue follows listener rotation');
});

test('street-to-bakery transitions muffle active atmosphere without restarting it and other zones stop it', async () => {
  const { audio, fake } = await activeStreet();
  const state = streetState();
  advance(audio, fake, 11.05, state);
  const siren = atmosphereSources(fake, 'distant-siren')[0], graph = atmosphereGraph(siren);
  const level = graph.spatial.gain.value, cutoff = graph.filter.frequency.value;
  const envelopeEvents = [...graph.envelope.gain.events], before = audio.getStatus().streetAtmosphere;
  state.zone = 'bakery'; audio.tick(0.05, state);
  assert.ok(Math.abs(graph.spatial.gain.value - level * 0.3) < 1e-8);
  assert.equal(graph.filter.frequency.value, cutoff * 0.5);
  assert.deepEqual(graph.envelope.gain.events, envelopeEvents, 'Position and ducking retain the original fade envelope');
  assert.equal(audio.getStatus().streetAtmosphere.sirenCount, before.sirenCount);
  assert.equal(audio.getStatus().streetAtmosphere.nextSirenAt, before.nextSirenAt);
  state.zone = 'street'; audio.tick(0.05, state);
  assert.ok(Math.abs(graph.spatial.gain.value - level) < 1e-8);
  state.zone = 'roof'; audio.tick(0.05, state);
  assert.ok(siren.stops.includes(undefined), 'Leaving the district stops the cue immediately');
  const starts = atmosphereSources(fake).length;
  advance(audio, fake, 30, state);
  assert.equal(atmosphereSources(fake).length, starts);
  state.zone = 'street'; advance(audio, fake, 2.5, state);
  assert.equal(atmosphereSources(fake).length, starts, 'Returning starts with quiet, never a backlog');
});

test('street cues stop for pause, mute, zero ambience/master, reset and ambient shutdown without deferred tails', async () => {
  for (const operation of ['pause', 'mute', 'ambienceZero', 'masterZero', 'reset', 'stopAmbient']) {
    const { audio, fake } = await activeStreet(), state = streetState();
    advance(audio, fake, 11.05, state);
    const siren = atmosphereSources(fake, 'distant-siren')[0];
    if (operation === 'pause') { audio.tick(0.05, { ...state, paused: true }); await settle(); }
    if (operation === 'mute') audio.setMuted(true);
    if (operation === 'ambienceZero') audio.setMix({ ambience: 0 });
    if (operation === 'masterZero') audio.setMix({ master: 0 });
    if (operation === 'reset') await audio.reset();
    if (operation === 'stopAmbient') audio.stopAmbient();
    assert.ok(siren.stops.includes(undefined), operation + ' stops the current siren');
    const snapshot = audio.getStatus().streetAtmosphere, allocations = fake.nodes.length;
    advance(audio, fake, 40, state);
    assert.equal(fake.nodes.length, allocations, operation + ' cannot allocate delayed cues');
    assert.deepEqual(audio.getStatus().streetAtmosphere, snapshot, operation + ' freezes or resets accepted atmosphere time');
    if (operation === 'mute') audio.setMuted(false);
    if (operation === 'ambienceZero') audio.setMix({ ambience: DEFAULT_AUDIO_MIX.ambience });
    if (operation === 'masterZero') audio.setMix({ master: DEFAULT_AUDIO_MIX.master });
    if (['pause', 'mute', 'reset'].includes(operation)) await audio.resume();
    if (['reset', 'stopAmbient'].includes(operation)) audio.startAmbient();
    const starts = atmosphereSources(fake).length;
    audio.tick(0, state);
    assert.equal(atmosphereSources(fake).length, starts, 'Resume never emits an old tail without simulation');
    advance(audio, fake, 35, state);
    assert.ok(atmosphereSources(fake).length > starts, operation + ' resumes ordinary intermittent scheduling');
  }
});

test('radio and combat defer new street cues and duck an already playing cue through its separate spatial gain', async () => {
  const speech = mockSpeech(), { audio, fake } = await activeStreet({ speechAdapter: speech });
  const state = streetState();
  audio.setVoiceEnabled(true);
  advance(audio, fake, 2.8, state);
  audio.announceCheckpoint({ id: 'street-priority', zone: 'street',
    text: 'Keep moving. The shop is across the street. Watch the door and stay away from the open road until the family is safe.' });
  advance(audio, fake, 1.5, state);
  assert.equal(atmosphereSources(fake).length, 0, 'Radio takes precedence over a due alarm cluster');
  audio.clearRadio();
  for (let tick = 0; tick < 120 && !atmosphereSources(fake).length; tick++) advance(audio, fake, 0.05, state);
  const alarm = atmosphereSources(fake, 'car-alarm')[0];
  assert.ok(alarm, 'The missed alarm resumes after a quiet retry');
  const graph = atmosphereGraph(alarm), level = graph.spatial.gain.value;
  const envelopeEvents = [...graph.envelope.gain.events];
  state.threat = 1; audio.tick(0.01, state);
  assert.ok(Math.abs(graph.spatial.gain.value - level * 0.2) < 1e-8);
  assert.deepEqual(graph.envelope.gain.events, envelopeEvents);
  audio.announceCheckpoint({ id: 'street-priority-2', zone: 'street', text: 'Keep moving.' });
  audio.tick(0.01, { ...state, threat: 0 });
  assert.ok(Math.abs(graph.spatial.gain.value - level * 0.12) < 1e-8);
  const starts = atmosphereSources(fake).length;
  advance(audio, fake, 60, state);
  assert.equal(atmosphereSources(fake).length, starts, 'Sustained combat produces no alarm or siren backlog');
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

test('weapon reports keep local origin, lose brightness with distance, and reflect only indoors', async () => {
  const { audio, fake } = await makeActive();
  audio.setListener({ position: { x: 10, y: 2, z: 10 }, yaw: 0 });
  audio.pistolShot();
  assert.equal(fake.sources.length, 2);
  assert.ok(fake.sources.every(source => source.kind === 'source'), 'No pitched oscillator under gunfire');
  const localReport = fake.sources[0];
  assert.equal(localReport.connections[0].frequency.value, 16000);
  assert.equal(fake.nodes.filter(node => node.kind === 'panner').length, 0);
  audio.pistolShot({ pos: { x: 20, y: 2, z: 9 }, environment: 'neighbor' });
  assert.equal(fake.sources.length, 6);
  const distantReport = fake.sources[2];
  assert.ok(distantReport.connections[0].frequency.value < localReport.connections[0].frequency.value);
  assert.ok(Math.abs(distantReport.starts[0][0] - Math.hypot(10, 1) / 343) < 1e-9,
    'Remote reports arrive after the sound travel time');
  assert.ok(fake.nodes.some(node => node.kind === 'panner' && node.pan.value > 0));
  assert.ok(fake.sources.at(-2).starts[0][0] > distantReport.starts[0][0]);
  assert.ok(fake.sources.at(-1).starts[0][0] > fake.sources.at(-2).starts[0][0]);
  const nodes = fake.nodes.length;
  audio.pistolShot({ pos: { x: 400, y: 0, z: 0 } });
  assert.equal(fake.nodes.length, nodes);
});

test('mechanical phase contacts and jump/landing are immediate, bounded events, not a scheduled full reload', async () => {
  const { audio, fake } = await makeActive();
  for (const action of ['reload-start', 'reload-insert', 'reload-end']) audio.weaponMechanical({ action, weapon: 'pistol' });
  assert.equal(fake.sources.length, 3);
  assert.ok(fake.sources.every(source => source.starts[0][0] === fake.context.currentTime));
  const cutoffs = fake.nodes.filter(node => node.kind === 'filter' && node.type === 'bandpass').map(node => node.frequency.value);
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

test('radio transmissions duck only music, queues remain bounded, and duplicate checkpoint IDs do not replay', async () => {
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

test('a voice-end callback waits for positive simulation time and closing squelch before the next cue', async () => {
  const speech = mockSpeech();
  const { audio, fake } = await makeActive({ speechAdapter: speech });
  audio.setVoiceEnabled(true);
  audio.announceCheckpoint({ id: 'first', text: 'Hold.' });
  audio.announceCheckpoint({ id: 'next', text: 'Go.' });
  speech.state.active = false; speech.requests[0].onend();
  for (let i = 0; i < 10; i++) audio.tick(0);
  assert.equal(speech.requests.length, 1);
  audio.tick(0.01);
  assert.equal(speech.requests.length, 1, 'Let the receiver close before another transmission');
  advance(audio, fake, 0.09);
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

test('recorded radio preserves syllables through a band-limited compressed receiver and replaces native speech', async () => {
  const speech = mockSpeech();
  const { audio, fake } = await makeActive({ speechAdapter: speech, sampleLoader: async () => new ArrayBuffer(8) });
  audio.setSampleManifest({ 'radio:ready': { url: '/assets/audio/ready.wav', bus: 'radio' } });
  audio.setVoiceEnabled(true); audio.tick(0.01); await settle();
  const before = fake.sources.length;
  audio.announceCheckpoint({ id: 'ready', text: 'Ready to move.', sampleId: 'radio:ready' });
  assert.equal(speech.requests.length, 0);
  assert.equal(fake.sources.length, before + 4);
  const newSources = fake.sources.slice(before);
  assert.ok(newSources.every(source => source.kind === 'source'), 'Receiver contacts contain no pure-tone beeps');
  const clip = newSources.find(source => source.buffer?.duration === 1.6);
  const filter = clip.connections[0], highpass = filter.connections[0];
  const compressor = highpass.connections[0], clipGain = compressor.connections[0];
  assert.equal(clip.buffer.duration, 1.6);
  assert.equal(filter.type, 'lowpass'); assert.equal(filter.frequency.value, 3300);
  assert.equal(highpass.type, 'highpass'); assert.equal(highpass.frequency.value, 350);
  assert.equal(compressor.kind, 'compressor'); assert.equal(compressor.ratio.value, 4);
  assert.equal(clip.starts[0][0], fake.context.currentTime + 0.065);
  assert.equal(clipGain.gain.events.some(event => event[0] === 'exponential'), false);
  const holds = clipGain.gain.events.filter(event => event[0] === 'set' && event[1] === 0.7);
  assert.ok(holds.some(event => event[2] > fake.context.currentTime + 1.5));
  assert.equal(audio.getStatus().radioWaiting, false);
});

test('pickup foley distinguishes objects without musical tones or firearm handling on melee weapons', async () => {
  for (const options of [
    { kind: 'weapon', weapon: 'pistol' }, { kind: 'weapon', weapon: 'shotgun' },
    { kind: 'weapon', weapon: 'bat' }, { kind: 'weapon', weapon: 'knife' },
    { kind: 'ammo' }, { kind: 'health' },
  ]) {
    const { audio, fake } = await makeActive();
    audio.pickupChime(options);
    assert.ok(fake.sources.length >= 2 && fake.sources.length <= 3, JSON.stringify(options));
    assert.ok(fake.sources.every(source => source.kind === 'source'));
    assert.ok(fake.sources.every(source => source.starts[0][0] <= 0.15));
    if (options.weapon === 'bat' || options.weapon === 'knife') {
      assert.equal(fake.sources.length, 2, 'No reload/cocking proxy for a melee pickup');
    }
    fake.advance(1);
    assert.equal(audio.getStatus().resources.voices, 0);
  }
});

test('receiver carrier and closing squelch are bounded and mute cannot emit a delayed tail', async () => {
  const { audio, fake } = await makeActive();
  audio.setMix({ music: 0 });
  audio.announceCheckpoint({ id: 'receiver' });
  const carrier = fake.sources.find(source => source.starts[0][0] === 0.065);
  assert.ok(carrier);
  assert.ok(Number.isFinite(carrier.endsAt), 'Even an unresponsive game cannot leave an endless carrier');
  advance(audio, fake, 0.9);
  assert.equal(carrier.finished, true);
  assert.equal(audio.getStatus().radioActive, true, 'Closing squelch owns its short release');
  const count = fake.sources.length;
  audio.setMuted(true);
  advance(audio, fake, 2);
  assert.equal(fake.sources.length, count);
  assert.equal(audio.getStatus().resources.voices, 0);
  assert.equal(audio.getStatus().radioActive, false);
});

test('slow frames cannot prolong a finished recording, carrier or music ducking', async () => {
  const { audio, fake } = await makeActive({ sampleLoader: async () => new ArrayBuffer(8) });
  audio.setSampleManifest({ 'radio:ready': { url: '/assets/audio/ready.wav', bus: 'radio' } });
  audio.setVoiceEnabled(true); audio.tick(0.01); await settle();
  audio.announceCheckpoint({ id: 'slow', sampleId: 'radio:ready' });
  // Five FPS: the audio clock advances 200 ms, but the fixed-step simulation
  // accepts at most 8 × 1/120 s. Speech must still finish on its real deadline.
  for (let i = 0; i < 10; i++) { fake.advance(0.2); audio.tick(8 / 120); }
  assert.equal(audio.getStatus().radioActive, false);
  assert.equal(fake.gains[4].gain.value, DEFAULT_AUDIO_MIX.music);
  assert.ok(fake.sources.filter(source => source.buffer?.duration === 4).every(source => source.finished));
});

test('recorded gunshot reflections retain the selected sample calibration gain', async () => {
  const { audio, fake } = await makeActive({ sampleLoader: async () => new ArrayBuffer(8) });
  audio.setSampleManifest({ 'shot:pistol': { url: '/assets/audio/pistol.wav', bus: 'effects', gain: 0.1 } });
  audio.tick(0.01); await settle();
  const start = fake.sources.length;
  audio.pistolShot({ environment: 'interior' });
  const reports = fake.sources.slice(start).filter(source => source.buffer.duration === 1.6);
  assert.equal(reports.length, 3);
  const gains = reports.map(source => source.connections[0].connections[0].connections[0].gain.events
    .find(event => event[0] === 'linear')[1]);
  assert.ok(Math.abs(gains[0] - 0.058) < 1e-9);
  assert.ok(Math.abs(gains[1] / gains[0] - 0.13) < 1e-9);
  assert.ok(Math.abs(gains[2] / gains[0] - 0.065) < 1e-9);
});

test('automatic fire rotates finite report buffers and never reuses the immediately previous waveform', async () => {
  const { audio, fake } = await makeActive();
  const reports = [];
  for (let i = 0; i < 24; i++) {
    const before = fake.sources.length;
    audio.smgShot(); reports.push(fake.sources[before].buffer);
  }
  assert.equal(new Set(reports).size, 4);
  assert.equal(audio.getStatus().resources.weaponBuffers, 4);
  for (let i = 1; i < reports.length; i++) assert.notEqual(reports[i], reports[i - 1]);
  assert.equal(reports[0], reports[4]);
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
