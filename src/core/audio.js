import { createAudioPolicy } from './audio-policy.js';
import { AUDIO_BUSES, DEFAULT_AUDIO_MIX, normalizeAudioMix, audioSurface, surfaceSoundProfile, describeAudioEvent } from './audio-model.js';
import { createScoreScheduler } from './audio-score.js';
import { createSampleBank } from './audio-samples.js';
import { createLocalSpeechAdapter } from './local-speech.js';
import sampleCatalog from './audio-catalog.json' with { type: 'json' };

const MAX_VOICES = 64;
const MAX_RADIO_QUEUE = 3;
const MAX_CHECKPOINT_HISTORY = 64;
const RADIO_SAMPLE_WAIT = 0.65;
const FLOOR_GAIN = 0.0001;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

const WEAPON_SOUNDS = Object.freeze({
  rifle: { duration: 0.22, cutoff: 1750, body: 125, low: 46, gain: 0.72 },
  pistol: { duration: 0.16, cutoff: 2350, body: 175, low: 65, gain: 0.58 },
  shotgun: { duration: 0.38, cutoff: 1250, body: 95, low: 32, gain: 0.86 },
  smg: { duration: 0.105, cutoff: 2850, body: 205, low: 90, gain: 0.43 },
  machinegun: { duration: 0.18, cutoff: 1950, body: 145, low: 52, gain: 0.7 },
});

// These windows were selected from the local PCM energy measurements, not from
// a claim that the object/airsoft recordings depict a specific firearm action.
const MECHANICAL_WINDOWS = Object.freeze({
  pistol: [[0.06, 0.18], [0.98, 0.24], [1.26, 0.24]],
  rifle: [[0.15, 0.24], [1.01, 0.16], [1.18, 0.24]],
  shotgun: [[0.09, 0.29], [0.09, 0.29], [0.09, 0.29]],
});

/**
 * An explicitly enabled, bounded audio graph. Factories and adapters are injected
 * so the complete engine can be tested without an audio device or speech output.
 */
export function createAudioController({
  search = '', webdriver = false, createContext = null, onChange = () => {},
  sampleLoader = null, speechAdapter = null, random = Math.random,
} = {}) {
  const policy = createAudioPolicy({ search, webdriver });
  const score = createScoreScheduler();
  const voices = new Set();
  const noiseCache = new Map();
  const checkpointHistory = new Set();
  const radioQueue = [];
  let ctx = null, master = null, muteGain = null, buses = null;
  let ambient = null, fire = null, listener = null;
  let active = false, ready = false, blocked = false;
  let ambientWanted = false, fireWanted = false;
  let generation = 0, radioGeneration = 0, elapsed = 0;
  let mix = DEFAULT_AUDIO_MIX, voiceEnabled = false, voiceAvailable = false;
  let currentRadio = null, currentZone = '', speechOwned = false;

  function isMuted() { return policy.isMuted(); }
  function isHardMuted() { return policy.hardMuted; }
  function canPlay(bus = 'effects') {
    return active && ready && !isMuted() && ctx?.state === 'running'
      && mix.master > 0 && mix[bus] > 0;
  }
  const samples = createSampleBank({
    load: sampleLoader,
    decode: bytes => {
      if (!active || !ready || isMuted() || !ctx?.decodeAudioData) throw new Error('Audio decoding unavailable');
      return ctx.decodeAudioData(bytes);
    },
    canLoad: bus => canPlay(bus) && (bus !== 'radio' || voiceEnabled),
  });

  function getStatus() {
    return {
      muted: isMuted(), hardMuted: isHardMuted(), supported: typeof createContext === 'function',
      initialized: Boolean(ctx), active, running: ready && ctx?.state === 'running' && active && !isMuted(), blocked,
      mix: { ...mix }, voiceEnabled, voiceAvailable,
      radioActive: Boolean(currentRadio), radioWaiting: Boolean(currentRadio?.waiting), radioQueued: radioQueue.length,
      resources: { voices: voices.size, maxVoices: MAX_VOICES, noiseBuffers: noiseCache.size, samples: samples.snapshot() },
      elapsed, score: score.snapshot(),
    };
  }
  function notify() { onChange(getStatus()); }
  function setParam(param, value, immediate = true) {
    if (!ctx || !param) return;
    param.cancelScheduledValues?.(ctx.currentTime);
    if (!immediate && param.setTargetAtTime) param.setTargetAtTime(value, ctx.currentTime, 0.04);
    else {
      param.setValueAtTime?.(value, ctx.currentTime);
      param.value = value;
    }
  }
  function setOutput(value) { setParam(muteGain?.gain, value); }
  function applyMix() {
    if (!buses) return;
    setParam(master.gain, mix.master);
    for (const bus of AUDIO_BUSES) {
      const level = mix[bus] * (bus === 'music' && currentRadio ? 0.24 : 1);
      setParam(buses[bus].gain, level, level === 0 || bus !== 'music');
    }
  }
  function disposeVoice(voice, stop = false) {
    if (!voices.delete(voice)) return;
    voice.source.onended = null;
    if (stop) { try { voice.source.stop(); } catch { /* Already ended or context closed. */ } }
    for (const node of voice.nodes) { try { node.disconnect(); } catch { /* Already disconnected. */ } }
  }
  function stopVoices(bus) {
    for (const voice of [...voices]) if (!bus || voice.bus === bus) disposeVoice(voice, true);
    if (!bus || bus === 'ambience') { ambient = null; fire = null; }
  }
  function makeVoice(bus, oscillator = false, loop = false) {
    if (!canPlay(bus)) return null;
    // Prefer dropping an old effect to stealing continuous room tone or speech.
    if (voices.size >= MAX_VOICES) {
      const oldest = [...voices].find(voice => !voice.loop && voice.bus === 'effects')
        ?? [...voices].find(voice => !voice.loop && voice.bus !== 'radio');
      if (!oldest) return null;
      disposeVoice(oldest, true);
    }
    const source = oscillator ? ctx.createOscillator() : ctx.createBufferSource();
    const voice = { bus, source, nodes: [source], loop, endsAt: Infinity };
    voices.add(voice);
    source.onended = () => disposeVoice(voice);
    return voice;
  }
  function own(voice, node) { voice.nodes.push(node); return node; }
  function route(voice, output, pan = 0) {
    if (Math.abs(pan) > 0.005 && typeof ctx.createStereoPanner === 'function') {
      const panner = own(voice, ctx.createStereoPanner());
      panner.pan.value = clamp(pan, -1, 1);
      output.connect(panner).connect(buses[voice.bus]);
    } else output.connect(buses[voice.bus]);
  }
  function envelope(param, now, duration, gain, attack = 0.003) {
    param.setValueAtTime(FLOOR_GAIN, now);
    param.linearRampToValueAtTime(Math.max(FLOOR_GAIN, gain), now + Math.min(attack, duration * 0.4));
    param.exponentialRampToValueAtTime(FLOOR_GAIN, now + duration);
  }
  function noiseBuffer(seconds) {
    // Duration buckets are finite; gunshots and footsteps reuse the same data.
    const duration = seconds > 1 ? 4 : seconds > 0.25 ? 0.5 : seconds > 0.12 ? 0.25 : 0.125;
    if (noiseCache.has(duration)) return noiseCache.get(duration);
    const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(duration * ctx.sampleRate)), ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = random() * 2 - 1;
    noiseCache.set(duration, buffer);
    return buffer;
  }
  function noise(bus, {
    duration = 0.1, gain = 0.2, cutoff = 1200, type = 'lowpass', q = 0.7,
    delay = 0, pan = 0, attack = 0.003, loop = false, buffer = null, playbackRate = 1, offset = 0,
  } = {}) {
    if (!canPlay(bus) || gain <= FLOOR_GAIN) return null;
    const voice = makeVoice(bus, false, loop);
    if (!voice) return null;
    const source = voice.source, now = ctx.currentTime + Math.max(0, delay);
    source.buffer = buffer ?? noiseBuffer(loop ? 4 : duration);
    source.loop = loop;
    if (source.playbackRate) source.playbackRate.value = clamp(playbackRate, 0.7, 1.35);
    const filter = own(voice, ctx.createBiquadFilter());
    filter.type = type; filter.frequency.value = cutoff; filter.Q.value = q;
    const gainNode = own(voice, ctx.createGain());
    if (loop) gainNode.gain.value = gain;
    else if (buffer) {
      // Preserve a recorded voice/foley's body; a noise-burst decay would erase
      // its later syllables. Only the clip boundaries receive a short fade.
      gainNode.gain.setValueAtTime(FLOOR_GAIN, now);
      gainNode.gain.linearRampToValueAtTime(gain, now + Math.min(0.005, duration * 0.2));
      gainNode.gain.setValueAtTime(gain, now + Math.max(duration * 0.5, duration - 0.012));
      gainNode.gain.linearRampToValueAtTime(FLOOR_GAIN, now + duration);
    } else envelope(gainNode.gain, now, duration, gain, attack);
    source.connect(filter).connect(gainNode); route(voice, gainNode, pan);
    voice.gain = gainNode; voice.filter = filter;
    if (buffer) source.start(now, offset, duration * clamp(playbackRate, 0.7, 1.35));
    else source.start(now);
    if (!loop) { voice.endsAt = now + duration + 0.02; source.stop(voice.endsAt); }
    return voice;
  }
  function tone(bus, {
    frequency = 120, endFrequency = frequency, duration = 0.14, gain = 0.1,
    waveform = 'sine', cutoff = 0, delay = 0, pan = 0, attack = 0.004, loop = false,
    destination = null,
  } = {}) {
    if (!canPlay(bus) || gain <= FLOOR_GAIN) return null;
    const voice = makeVoice(bus, true, loop);
    if (!voice) return null;
    const source = voice.source, now = ctx.currentTime + Math.max(0, delay);
    source.type = waveform;
    source.frequency.setValueAtTime(frequency, now);
    if (endFrequency !== frequency) source.frequency.exponentialRampToValueAtTime(endFrequency, now + duration * 0.8);
    const gainNode = own(voice, ctx.createGain());
    if (loop) gainNode.gain.value = gain;
    else envelope(gainNode.gain, now, duration, gain, attack);
    let output = source;
    if (cutoff > 0) {
      const filter = own(voice, ctx.createBiquadFilter());
      filter.type = 'lowpass'; filter.frequency.value = cutoff;
      output = output.connect(filter);
    }
    output.connect(gainNode);
    if (destination) gainNode.connect(destination); else route(voice, gainNode, pan);
    voice.gain = gainNode;
    source.start(now);
    if (!loop) { voice.endsAt = now + duration + 0.02; source.stop(voice.endsAt); }
    return voice;
  }
  function sample(id, bus, scene = { gain: 1, pan: 0 }, options = {}) {
    if (!canPlay(bus) || scene.gain <= FLOOR_GAIN) return null;
    const entry = samples.peek(id);
    samples.request(id);
    if (!entry) return null;
    const playbackRate = clamp(finite(options.playbackRate, 1), 0.7, 1.35);
    const start = clamp(finite(options.offset, 0), 0, Math.max(0, entry.buffer.duration - 0.01));
    const duration = Math.max(0.01, Math.min(entry.buffer.duration - start,
      finite(options.duration, 8), finite(options.maxDuration, 8))) / playbackRate;
    return noise(bus, {
      buffer: entry.buffer, duration, offset: start,
      gain: scene.gain * entry.gain * finite(options.gain, 0.55),
      cutoff: finite(options.cutoff, 17000), pan: scene.pan,
      playbackRate, attack: 0.001,
    });
  }
  function suspendContext() {
    if (!ctx || ctx.state === 'closed' || ctx.state === 'suspended') return Promise.resolve(false);
    try { return Promise.resolve(ctx.suspend()).then(() => false, () => false); }
    catch { return Promise.resolve(false); }
  }
  function prepareContext() {
    if (ctx && ctx.state !== 'closed') return true;
    if (isMuted() || typeof createContext !== 'function') return false;
    try {
      stopVoices(); samples.clear();
      ctx = createContext();
      master = ctx.createGain();
      // This gate follows every WebAudio bus and is always allocated second.
      muteGain = ctx.createGain(); muteGain.gain.value = 0;
      buses = Object.fromEntries(AUDIO_BUSES.map(bus => [bus, ctx.createGain()]));
      for (const bus of AUDIO_BUSES) buses[bus].connect(master);
      if (typeof ctx.createDynamicsCompressor === 'function') {
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -9; limiter.knee.value = 5; limiter.ratio.value = 5;
        limiter.attack.value = 0.003; limiter.release.value = 0.16;
        master.connect(limiter).connect(muteGain);
      } else master.connect(muteGain);
      muteGain.connect(ctx.destination);
      noiseCache.clear(); applyMix(); blocked = false;
      return true;
    } catch {
      try { Promise.resolve(ctx?.close()).catch(() => {}); } catch { /* Device unavailable. */ }
      ctx = master = muteGain = buses = null;
      ready = false; blocked = true;
      return false;
    }
  }
  function refreshVoiceAvailability() {
    if (!canPlay('radio') || !voiceEnabled) return;
    try { voiceAvailable = Boolean(speechAdapter && (speechAdapter.available?.() ?? true)); }
    catch { voiceAvailable = false; }
  }
  function resume() {
    active = true;
    const request = ++generation;
    if (isMuted() || !prepareContext()) { notify(); return Promise.resolve(false); }
    let resumed;
    try { resumed = ctx.state === 'running' ? undefined : ctx.resume(); }
    catch { blocked = true; ready = false; setOutput(0); notify(); return Promise.resolve(false); }
    return Promise.resolve(resumed).then(() => {
      if (!active || isMuted()) { ready = false; setOutput(0); return suspendContext(); }
      if (request !== generation) return false;
      blocked = ctx.state !== 'running'; ready = !blocked;
      if (ready) {
        setOutput(1); applyMix();
        if (ambientWanted) startAmbient();
        if (fireWanted) startFireCrackle();
        refreshVoiceAvailability(); samples.preload();
      }
      notify(); return ready;
    }, () => {
      if (request === generation) { blocked = true; ready = false; setOutput(0); notify(); }
      return false;
    });
  }
  function cancelSpeech() {
    if (!speechOwned) return;
    try {
      const cancelled = speechAdapter?.cancel();
      speechOwned = typeof speechAdapter?.pending === 'function' ? speechAdapter.pending() : cancelled === false;
    }
    catch { speechOwned = true; }
  }
  function clearRadio(options = {}) {
    const notifyChange = options?.notifyChange !== false;
    radioGeneration++;
    const previous = currentRadio;
    currentRadio = null; radioQueue.length = 0;
    cancelSpeech();
    stopVoices('radio'); applyMix();
    if (notifyChange && previous) notify();
  }
  function suspend() {
    active = false; ready = false; generation++;
    setOutput(0); clearRadio({ notifyChange: false }); stopVoices(); samples.cancel();
    notify(); return suspendContext();
  }
  function setMuted(on) {
    const muted = policy.setMuted(on);
    if (muted) {
      generation++; ready = false; setOutput(0);
      clearRadio({ notifyChange: false }); stopVoices(); samples.cancel();
      void suspendContext();
    } else if (active) void resume(); // Preserve the caller's direct user gesture.
    notify(); return muted;
  }
  function setMix(update) {
    const previous = mix;
    mix = normalizeAudioMix(update, mix);
    // Speech is outside WebAudio: cancelling is the only reliable immediate
    // response to a changed voice level on all supported browsers.
    if (mix.master === 0 || mix.radio === 0
      || (currentRadio?.speech && (previous.master !== mix.master || previous.radio !== mix.radio))) {
      clearRadio({ notifyChange: false });
    }
    applyMix();
    for (const bus of AUDIO_BUSES) if (mix.master === 0 || mix[bus] === 0) stopVoices(bus);
    if (mix.master === 0 || AUDIO_BUSES.some(bus => previous[bus] > 0 && mix[bus] === 0)) samples.cancel();
    notify(); return { ...mix };
  }
  function setVoiceEnabled(value) {
    voiceEnabled = Boolean(value);
    if (!voiceEnabled) { clearRadio({ notifyChange: false }); samples.cancel(); }
    if (voiceEnabled) refreshVoiceAvailability();
    notify(); return voiceEnabled;
  }
  function setListener(value) {
    const position = value?.position ?? value?.pos;
    if (!position || !['x', 'y', 'z'].every(key => Number.isFinite(position[key]))) { listener = null; return; }
    listener = { position: { x: position.x, y: position.y, z: position.z }, yaw: finite(value.yaw, 0) };
  }
  function setSampleManifest(manifest) {
    samples.setManifest(manifest?.samples ?? manifest);
    return samples.snapshot();
  }
  function reset() {
    ambientWanted = false; fireWanted = false;
    checkpointHistory.clear(); score.reset(); elapsed = 0; currentZone = ''; listener = null;
    return suspend();
  }

  function fireWeapon(kind, options = {}) {
    if (!canPlay('effects')) return;
    const profile = WEAPON_SOUNDS[kind], scene = describeAudioEvent(options, listener);
    if (scene.gain <= FLOOR_GAIN) return;
    const variation = 0.97 + random() * 0.06;
    if (!sample('shot:' + kind, 'effects', scene)) {
      noise('effects', { duration: profile.duration, gain: profile.gain * scene.gain,
        cutoff: profile.cutoff * variation, type: 'bandpass', q: 0.65, pan: scene.pan, attack: 0.0015 });
    }
    tone('effects', { frequency: profile.body * variation, endFrequency: profile.low,
      duration: profile.duration * 0.8, gain: profile.gain * 0.38 * scene.gain, pan: scene.pan });
    if (scene.interior) noise('effects', { duration: 0.15, delay: 0.065, cutoff: 1200,
      gain: profile.gain * 0.11 * scene.gain, pan: -scene.pan * 0.5, attack: 0.015 });
  }
  function footstep(options = {}) {
    if (!canPlay('effects')) return;
    if (typeof options === 'string') options = { surface: options };
    options ??= {};
    const surface = audioSurface(options.surface), profile = surfaceSoundProfile(surface);
    const scene = describeAudioEvent(options, listener);
    scene.gain *= clamp(finite(options.speed, 4) / 4, 0.3, 1.35);
    const recordedSurface = surface === 'metal' ? 'concrete' : surface;
    const recorded = sample('footstep:' + recordedSurface, 'effects', scene, {
      gain: 0.24, playbackRate: 0.96 + random() * 0.08,
    });
    if (!recorded) {
      noise('effects', { duration: profile.duration, gain: 0.15 * scene.gain,
        cutoff: profile.cutoff * (0.94 + random() * 0.12), pan: scene.pan, attack: 0.006 });
      tone('effects', { frequency: profile.body, endFrequency: profile.body * 0.6,
        duration: 0.085, gain: 0.038 * scene.gain, pan: scene.pan });
    }
    // Metal steps use recorded shoe contact plus an explicitly synthetic ring.
    if (surface === 'metal') tone('effects', { frequency: profile.resonance,
      duration: 0.14, gain: 0.02 * scene.gain, waveform: 'triangle', pan: scene.pan });
  }
  function movement(options = {}) {
    if (!canPlay('effects')) return;
    if (options?.action === 'jump') {
      const scene = describeAudioEvent(options, listener);
      noise('effects', { duration: 0.1, cutoff: 900, gain: 0.06 * scene.gain, attack: 0.016, pan: scene.pan });
    } else footstep({ ...options, intensity: finite(options?.intensity, 1.25),
      // A vertical landing has force even with no horizontal travel. Its
      // intensity already carries fall speed; do not reduce it like a slow walk.
      speed: options?.action === 'land' ? 4 : finite(options?.speed, 4) });
  }
  function impact(options = {}) {
    if (!canPlay('effects')) return;
    if (typeof options === 'string') options = { surface: options };
    options ??= {};
    const surface = audioSurface(options.surface), profile = surfaceSoundProfile(surface);
    const scene = describeAudioEvent(options, listener);
    if (sample('impact:' + surface, 'effects', scene, { gain: 0.43 })) return;
    if (surface === 'concrete' && sample('impact:generic', 'effects', scene, { gain: 0.4 })) return;
    noise('effects', { duration: profile.duration, gain: 0.36 * scene.gain,
      cutoff: profile.cutoff, type: surface === 'glass' ? 'highpass' : 'lowpass', pan: scene.pan });
    tone('effects', { frequency: profile.resonance || profile.body * 1.4, endFrequency: profile.body,
      duration: profile.duration * 0.9, gain: 0.12 * scene.gain,
      waveform: surface === 'metal' ? 'triangle' : 'sine', pan: scene.pan });
  }
  function meleeHit(options = {}) { impact({ ...options, surface: options?.surface ?? 'body' }); }
  function meleeSwing(options = {}) {
    if (!canPlay('effects')) return;
    const scene = describeAudioEvent(options, listener);
    noise('effects', { duration: 0.24, cutoff: 1550, type: 'bandpass', q: 0.55,
      gain: 0.13 * scene.gain, attack: 0.05, pan: scene.pan });
  }
  function weaponMechanical(options = {}) {
    if (!canPlay('effects')) return;
    options ??= {};
    const scene = describeAudioEvent(options, listener);
    const action = ['reload', 'reload-start', 'reload-insert', 'reload-end', 'cock', 'equip', 'dry'].includes(options.action)
      ? options.action : 'reload';
    const weapon = options.weapon === 'pistol' ? 'pistol' : options.weapon === 'shotgun' ? 'shotgun' : 'rifle';
    const id = weapon === 'shotgun' ? 'mechanical:cock-shotgun' : 'mechanical:reload-' + weapon;
    const phase = action === 'reload-insert' ? 1 : action === 'reload-end' ? 2 : 0;
    // Phase clips are short excerpts, triggered by simulation contacts rather
    // than a complete reload recording playing ahead of the animation.
    const [offset, duration] = MECHANICAL_WINDOWS[weapon][phase];
    const hasRecordedPhase = weapon !== 'shotgun' || action === 'reload-end';
    if (action.startsWith('reload-') && hasRecordedPhase
      && sample(id, 'effects', scene, { gain: 0.33, offset, duration })) return;
    if (['reload', 'cock', 'equip'].includes(action) && sample(id, 'effects', scene, {
      gain: action === 'equip' ? 0.25 : 0.36, maxDuration: action === 'equip' ? 0.25 : 8,
    })) return;
    const clicks = action === 'reload' ? 3 : action === 'cock' || action === 'equip' ? 2 : 1;
    for (let i = 0; i < clicks; i++) noise('effects', {
      duration: 0.045 + (i + phase) * 0.008, delay: i * 0.14, cutoff: action === 'dry' ? 2600 : 1800 - (i + phase) * 220,
      type: 'bandpass', q: 1.5, gain: (i + phase === 1 ? 0.23 : 0.14) * scene.gain, pan: scene.pan,
    });
  }
  function dryClick(options = {}) { weaponMechanical({ ...options, action: 'dry' }); }
  function reloadClack(options = {}) { weaponMechanical({ ...options, action: 'reload' }); }
  function pickupChime(options = {}) {
    const scene = describeAudioEvent(options, listener);
    tone('effects', { frequency: 660, endFrequency: 990, duration: 0.18,
      gain: 0.1 * scene.gain, waveform: 'triangle', pan: scene.pan });
  }
  function startAmbient() {
    ambientWanted = true;
    if (!canPlay('ambience') || ambient) return;
    const wind = noise('ambience', { cutoff: 340, gain: 0.07, loop: true });
    const drone = tone('ambience', { frequency: 49, gain: 0.018, loop: true });
    ambient = { wind, drone };
  }
  function stopAmbient() {
    ambientWanted = false;
    if (ambient) for (const voice of Object.values(ambient)) if (voice) disposeVoice(voice, true);
    ambient = null;
  }
  function startFireCrackle() {
    fireWanted = true;
    if (!canPlay('ambience') || fire) return;
    const crackle = noise('ambience', { cutoff: 1550, type: 'highpass', gain: 0.075, loop: true });
    const flutter = crackle && tone('ambience', { frequency: 5.3, gain: 0.024, loop: true, destination: crackle.gain.gain });
    fire = { crackle, flutter };
  }
  function stopFireCrackle() {
    fireWanted = false;
    if (fire) for (const voice of Object.values(fire)) if (voice) disposeVoice(voice, true);
    fire = null;
  }

  function tryRecordedRadio() {
    if (!currentRadio || !voiceEnabled || !currentRadio.cue.sampleId) return false;
    const recorded = sample(currentRadio.cue.sampleId, 'radio', { gain: 1, pan: 0 }, { gain: 0.7, cutoff: 6800 });
    if (!recorded) return false;
    currentRadio.waiting = false;
    currentRadio.remaining = Math.min(8.1, recorded.source.buffer.duration + 0.15);
    return true;
  }
  function startRadioFallback() {
    const radio = currentRadio;
    if (!radio || !canPlay('radio')) return;
    const { cue, token } = radio;
    radio.waiting = false;
    if (voiceEnabled && cue.text) {
      refreshVoiceAvailability();
      if (voiceAvailable && !speechOwned && typeof speechAdapter?.speak === 'function') {
        radio.speech = true;
        speechOwned = true;
        const finish = () => {
          if (currentRadio?.token === token) { currentRadio.finished = true; speechOwned = false; }
        };
        const fail = () => {
          // A speech provider can report an error after accepting work, with
          // cancellation still pending. Error is not confirmation of silence.
          if (currentRadio?.token === token) currentRadio.finished = true;
        };
        try {
          const accepted = speechAdapter.speak({ text: cue.text, volume: mix.master * mix.radio * 0.85,
            onend: finish, onerror: fail });
          if (currentRadio !== radio) return;
          if (accepted === true) radio.remaining = clamp(cue.text.split(/\s+/).length * 0.4 + 0.8, 1.2, 8);
          else { radio.speech = false; cancelSpeech(); }
        } catch { radio.speech = false; cancelSpeech(); }
      }
    }
  }
  function startRadio(cue) {
    if (!canPlay('radio')) return false;
    const token = ++radioGeneration;
    currentRadio = { cue, token, remaining: 0.85, speech: false, finished: false,
      waiting: false, waitRemaining: RADIO_SAMPLE_WAIT };
    applyMix();
    noise('radio', { duration: 0.11, cutoff: 1850, type: 'bandpass', gain: 0.038 });
    tone('radio', { frequency: 880, duration: 0.09, gain: 0.047, waveform: 'sine' });
    tone('radio', { frequency: 660, duration: 0.1, delay: 0.11, gain: 0.034, waveform: 'sine' });
    const requested = voiceEnabled && cue.sampleId && samples.request(cue.sampleId, { priority: true });
    if (!tryRecordedRadio()) {
      if (requested) currentRadio.waiting = true;
      else startRadioFallback();
    }
    notify(); return true;
  }
  function announceCheckpoint(options = {}) {
    let { id, text = '', zone = '', sampleId = '' } = options ?? {};
    if (!canPlay('radio') || typeof id !== 'string' || !id.trim()) return false;
    id = id.trim().slice(0, 96);
    if (checkpointHistory.has(id)) return false;
    checkpointHistory.add(id);
    if (checkpointHistory.size > MAX_CHECKPOINT_HISTORY) checkpointHistory.delete(checkpointHistory.values().next().value);
    const cue = { id, text: typeof text === 'string' ? text.trim().slice(0, 240) : '',
      zone: typeof zone === 'string' ? zone.slice(0, 48) : '', sampleId: typeof sampleId === 'string' ? sampleId.slice(0, 96) : '' };
    if (currentRadio?.cue.zone && cue.zone && currentRadio.cue.zone !== cue.zone) clearRadio({ notifyChange: false });
    if (!currentRadio) return startRadio(cue);
    if (radioQueue.length === MAX_RADIO_QUEUE) radioQueue.shift();
    radioQueue.push(cue); notify(); return true;
  }
  function finishRadio() {
    currentRadio = null; radioGeneration++;
    cancelSpeech();
    stopVoices('radio'); applyMix(); notify();
  }
  function tick(dt, state = {}) {
    if (state?.dead || state?.paused) {
      if (active) { if (state.dead) void reset(); else void suspend(); }
      return;
    }
    if (!Number.isFinite(dt) || dt <= 0 || !active || !ready || isMuted()) return;
    const step = Math.min(dt, 0.25); // Never catch up audio after a suspended tab.
    elapsed += step;
    if (state?.listener) setListener(state.listener);
    const zone = typeof state?.zone === 'string' ? state.zone.slice(0, 48) : currentZone;
    if (zone !== currentZone) {
      currentZone = zone;
      if (ambient?.wind) setParam(ambient.wind.filter.frequency, /roof|street|scaffold|balcony/.test(zone) ? 480 : 250);
    }
    for (const voice of [...voices]) if (!voice.loop && voice.endsAt <= ctx.currentTime) disposeVoice(voice, true);
    if (ambientWanted && !ambient) startAmbient();
    if (fireWanted && !fire) startFireCrackle();
    if (currentRadio?.waiting) {
      // Async completion only warms the cache. The active simulation decides
      // whether this still-current cue may start, or should use its fallback.
      currentRadio.waitRemaining -= step;
      if (!tryRecordedRadio() && currentRadio.waitRemaining <= 0) startRadioFallback();
    } else if (currentRadio) {
      currentRadio.remaining -= step;
      if (currentRadio.remaining <= 0 || currentRadio.finished) finishRadio();
    }
    if (!currentRadio && radioQueue.length && canPlay('radio')) startRadio(radioQueue.shift());
    for (const note of score.advance(step, { zone, threat: state?.threat, enabled: canPlay('music') })) {
      tone('music', { ...note, attack: note.kind === 'pad' ? 0.4 : 0.009 });
    }
    samples.preload();
  }

  return Object.freeze({
    resume, suspend, reset, tick, setListener, setSampleManifest, setMix, setVoiceEnabled,
    announceCheckpoint, clearRadio,
    gunshot: options => fireWeapon('rifle', options),
    pistolShot: options => fireWeapon('pistol', options),
    shotgunShot: options => fireWeapon('shotgun', options),
    smgShot: options => fireWeapon('smg', options),
    machinegunShot: options => fireWeapon('machinegun', options),
    meleeHit, meleeSwing, footstep, movement, impact, surfaceImpact: impact, weaponMechanical,
    startAmbient, stopAmbient, startFireCrackle, stopFireCrackle,
    dryClick, reloadClack, pickupChime, setMuted, isMuted, isHardMuted, getStatus,
  });
}

const host = typeof window === 'undefined' ? null : window;
const Context = host?.AudioContext || host?.webkitAudioContext;
const Audio = createAudioController({
  search: host?.location?.search ?? '', webdriver: host?.navigator?.webdriver === true,
  createContext: typeof Context === 'function' ? () => new Context() : null,
  speechAdapter: createLocalSpeechAdapter(host),
  sampleLoader: host?.fetch ? async ({ url, signal }) => {
    const response = await host.fetch(url, { signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error('Local audio asset unavailable');
    return response.arrayBuffer();
  } : null,
  onChange: detail => {
    if (host?.document && typeof host.CustomEvent === 'function') {
      host.document.dispatchEvent(new host.CustomEvent('audiochange', { detail }));
    }
  },
});
Audio.setSampleManifest(sampleCatalog.samples);
// Inspection and preference changes cannot bypass the immutable QA boundary.
if (host) host.__punisherAudio = Audio;
export { Audio };
