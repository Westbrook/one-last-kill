import { createAudioPolicy } from './audio-policy.js';
import { AUDIO_BUSES, DEFAULT_AUDIO_MIX, normalizeAudioMix, audioSurface, surfaceSoundProfile, describeAudioEvent } from './audio-model.js';
import { createScoreScheduler } from './audio-score.js';
import { createSampleBank } from './audio-samples.js';
import { createLocalSpeechAdapter } from './local-speech.js';
import { WEAPON_TIMBRES, renderWeaponReport } from './weapon-timbres.js';
import sampleCatalog from './audio-catalog.json' with { type: 'json' };

const MAX_VOICES = 64;
const MAX_RADIO_QUEUE = 3;
const MAX_CHECKPOINT_HISTORY = 64;
const RADIO_SAMPLE_WAIT = 0.65;
const FLOOR_GAIN = 0.0001;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

const SHOT_VARIANTS = 4;
const RADIO_OPEN = 0.065;
const RADIO_CLOSE = 0.085;

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
  const weaponCache = new Map();
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
      resources: { voices: voices.size, maxVoices: MAX_VOICES, noiseBuffers: noiseCache.size,
        weaponBuffers: weaponCache.size * SHOT_VARIANTS, samples: samples.snapshot() },
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
    highpass = 0, compress = false, sustain = false,
  } = {}) {
    if (!canPlay(bus) || gain <= FLOOR_GAIN) return null;
    const voice = makeVoice(bus, false, loop);
    if (!voice) return null;
    const source = voice.source, now = ctx.currentTime + Math.max(0, delay);
    source.buffer = buffer ?? noiseBuffer(loop ? 4 : duration);
    source.loop = loop || (!buffer && duration > source.buffer.duration);
    if (source.playbackRate) source.playbackRate.value = clamp(playbackRate, 0.7, 1.35);
    const filter = own(voice, ctx.createBiquadFilter());
    filter.type = type; filter.frequency.value = cutoff; filter.Q.value = q;
    const gainNode = own(voice, ctx.createGain());
    if (loop) gainNode.gain.value = gain;
    else if (buffer || sustain) {
      // Preserve a recorded voice/foley's body; a noise-burst decay would erase
      // its later syllables. Only the clip boundaries receive a short fade.
      gainNode.gain.setValueAtTime(FLOOR_GAIN, now);
      gainNode.gain.linearRampToValueAtTime(gain, now + Math.min(attack, duration * 0.2));
      gainNode.gain.setValueAtTime(gain, now + Math.max(duration * 0.5, duration - 0.012));
      gainNode.gain.linearRampToValueAtTime(FLOOR_GAIN, now + duration);
    } else envelope(gainNode.gain, now, duration, gain, attack);
    let output = source.connect(filter);
    if (highpass > 0) {
      const lowCut = own(voice, ctx.createBiquadFilter());
      lowCut.type = 'highpass'; lowCut.frequency.value = highpass; lowCut.Q.value = 0.7;
      output = output.connect(lowCut);
    }
    if (compress && typeof ctx.createDynamicsCompressor === 'function') {
      const compressor = own(voice, ctx.createDynamicsCompressor());
      compressor.threshold.value = -24; compressor.knee.value = 8; compressor.ratio.value = 4;
      compressor.attack.value = 0.003; compressor.release.value = 0.08;
      output = output.connect(compressor);
    }
    output.connect(gainNode); route(voice, gainNode, pan);
    voice.gain = gainNode; voice.filter = filter; voice.level = gain;
    if (buffer) source.start(now, offset, duration * clamp(playbackRate, 0.7, 1.35));
    else source.start(now, loop ? 0 : random() * Math.max(0, finite(source.buffer.duration, duration) - duration * playbackRate));
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
      playbackRate, attack: finite(options.attack, 0.003), delay: finite(options.delay, 0),
      highpass: finite(options.highpass, 0), compress: options.compress === true,
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
      noiseCache.clear(); weaponCache.clear(); applyMix(); blocked = false;
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
    const profile = WEAPON_TIMBRES[kind], scene = describeAudioEvent(options, listener);
    if (scene.gain <= FLOOR_GAIN) return;
    const playbackRate = 0.985 + random() * 0.03;
    const delay = scene.distance / 343;
    const cutoff = Math.max(1800, 16000 / (1 + scene.distance * 0.055));
    const recorded = sample('shot:' + kind, 'effects', scene, {
      gain: profile.gain, playbackRate, cutoff, highpass: 35, delay, attack: 0.00008,
    });
    let buffer = recorded?.source.buffer;
    const duration = buffer ? buffer.duration / playbackRate : profile.duration / playbackRate;
    const reportGain = recorded?.level ?? profile.gain * scene.gain;
    if (!recorded) {
      let bank = weaponCache.get(kind);
      if (!bank) {
        const buffers = Array.from({ length: SHOT_VARIANTS }, (_, variant) => {
          const pcm = renderWeaponReport(kind, ctx.sampleRate, variant);
          const value = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
          value.getChannelData(0).set(pcm);
          return value;
        });
        bank = { buffers, cursor: 0 }; weaponCache.set(kind, bank);
      }
      buffer = bank.buffers[bank.cursor++ % SHOT_VARIANTS];
      noise('effects', { buffer, duration, playbackRate, delay, cutoff, highpass: 35,
        gain: profile.gain * scene.gain, pan: scene.pan, attack: 0.00008 });
    }
    // A nearby action returns after the pressure transient. It is a tiny metal
    // contact, never the old descending pitched body underneath every report.
    if (scene.distance < 18) noise('effects', { duration: 0.025, delay: delay + profile.mechanicalDelay,
      cutoff: 2700, type: 'bandpass', highpass: 850, q: 0.65,
      gain: 0.038 * scene.gain, pan: scene.pan, attack: 0.0008 });
    if (scene.interior) {
      // Short, darker copies retain the report's timbre. These are authored
      // early room reflections, not an acoustic raycast or a second discharge.
      for (const [time, gain, pan] of [[0.032, 0.13, -0.45], [0.087, 0.065, 0.35]]) {
        noise('effects', { buffer, duration, playbackRate, delay: delay + time,
          cutoff: 2100, highpass: 120, gain: reportGain * gain,
          pan: clamp(scene.pan * 0.3 + pan, -0.85, 0.85), attack: 0.004 });
      }
    }
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
    if (scene.gain <= FLOOR_GAIN) return;
    const action = ['reload', 'reload-start', 'reload-insert', 'reload-end', 'cock', 'equip', 'dry'].includes(options.action)
      ? options.action : 'reload';
    if (['bat', 'knife', 'fists'].includes(options.weapon)) {
      if (action === 'equip' && options.weapon !== 'fists') noise('effects', {
        duration: 0.12, cutoff: 750, highpass: 180, gain: 0.055 * scene.gain, pan: scene.pan, attack: 0.025,
      });
      return;
    }
    const weapon = options.weapon === 'pistol' ? 'pistol' : options.weapon === 'shotgun' ? 'shotgun' : 'rifle';
    const id = weapon === 'shotgun' ? 'mechanical:cock-shotgun' : 'mechanical:reload-' + weapon;
    const phase = action === 'reload-insert' ? 1 : action === 'reload-end' ? 2 : 0;
    // Phase clips are short excerpts, triggered by simulation contacts rather
    // than a complete reload recording playing ahead of the animation.
    const [offset, duration] = MECHANICAL_WINDOWS[weapon][phase];
    const hasRecordedPhase = weapon !== 'shotgun' || action === 'reload-end';
    const playbackRate = 0.975 + random() * 0.05;
    if (action.startsWith('reload-') && hasRecordedPhase
      && sample(id, 'effects', scene, { gain: 0.3, offset, duration, highpass: 110, cutoff: 8500, playbackRate })) return;
    // Equip is a short grip/latch contact, not the start of an unrelated full
    // reload. The source windows avoid the leading silence in these recordings.
    const handlingWindow = action === 'equip' ? MECHANICAL_WINDOWS[weapon][1] : MECHANICAL_WINDOWS[weapon][2];
    if (['cock', 'equip'].includes(action) && sample(id, 'effects', scene, {
      gain: action === 'equip' ? 0.16 : 0.3, offset: handlingWindow[0],
      duration: action === 'equip' ? Math.min(0.12, handlingWindow[1]) : handlingWindow[1],
      highpass: 140, cutoff: 7800, playbackRate,
    })) return;
    const clicks = action === 'reload' ? 3 : action === 'cock' || action === 'equip' ? 2 : 1;
    for (let i = 0; i < clicks; i++) noise('effects', {
      duration: 0.045 + (i + phase) * 0.008, delay: i * 0.14, cutoff: action === 'dry' ? 2600 : 1800 - (i + phase) * 220,
      type: 'bandpass', q: 0.8, highpass: 420,
      gain: (action === 'equip' ? 0.055 : i + phase === 1 ? 0.18 : 0.11) * scene.gain, pan: scene.pan,
    });
  }
  function dryClick(options = {}) { weaponMechanical({ ...options, action: 'dry' }); }
  function reloadClack(options = {}) { weaponMechanical({ ...options, action: 'reload' }); }
  function pickupChime(options = {}) {
    if (!canPlay('effects')) return;
    options ??= {};
    const scene = describeAudioEvent(options, listener);
    if (scene.gain <= FLOOR_GAIN) return;
    // Kept under the existing public method name for callers. Inventory is
    // heard as a hand, fabric and an object settling, without a musical reward.
    noise('effects', { duration: 0.17, cutoff: 1050, highpass: 220,
      gain: 0.085 * scene.gain, attack: 0.022, pan: scene.pan });
    if (options.kind === 'health') {
      noise('effects', { duration: 0.11, delay: 0.06, cutoff: 2400, highpass: 900,
        gain: 0.043 * scene.gain, attack: 0.02, pan: scene.pan });
    } else if (options.kind === 'ammo') {
      for (const delay of [0.025, 0.075]) noise('effects', {
        duration: 0.032, delay, cutoff: 3100, highpass: 1200, type: 'bandpass', q: 0.75,
        gain: 0.065 * scene.gain, pan: scene.pan, attack: 0.001,
      });
    } else if (options.weapon === 'bat') {
      // Quiet recorded wood contact beneath the cloth, not a bat strike.
      if (!sample('impact:wood', 'effects', scene, { gain: 0.09, maxDuration: 0.14, cutoff: 1600, delay: 0.045 })) {
        noise('effects', { duration: 0.075, delay: 0.045, cutoff: 650,
          gain: 0.075 * scene.gain, pan: scene.pan });
      }
    } else if (options.weapon === 'knife') {
      noise('effects', { duration: 0.065, delay: 0.04, cutoff: 4200, highpass: 1600,
        gain: 0.045 * scene.gain, pan: scene.pan, attack: 0.012 });
    } else if (options.kind === 'weapon') weaponMechanical({ ...options, action: 'equip' });
    else noise('effects', { duration: 0.055, delay: 0.04, cutoff: 700, gain: 0.07 * scene.gain, pan: scene.pan });
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

  function openRadioReceiver() {
    if (!currentRadio || currentRadio.opened) return;
    currentRadio.opened = true;
    noise('radio', { duration: 0.055, cutoff: 4200, highpass: 550,
      gain: 0.045, attack: 0.002 });
    noise('radio', { duration: 0.008, cutoff: 1900, gain: 0.028, attack: 0.0005 });
    // The quiet carrier exists only while a current transmission owns it.
    // Pause/mute/zone changes dispose it alongside the voice, never in a timer.
    currentRadio.endsAt = ctx.currentTime + currentRadio.remaining;
    currentRadio.carrier = noise('radio', { cutoff: 3100, highpass: 700,
      gain: 0.007, duration: Math.max(0.05, currentRadio.remaining - RADIO_OPEN),
      sustain: true, delay: RADIO_OPEN, attack: 0.012 });
  }
  function closeRadioReceiver() {
    if (!currentRadio || currentRadio.closing) return;
    if (currentRadio.carrier) disposeVoice(currentRadio.carrier, true);
    cancelSpeech();
    currentRadio.closing = true; currentRadio.finished = false;
    currentRadio.remaining = RADIO_CLOSE;
    currentRadio.endsAt = ctx.currentTime + RADIO_CLOSE;
    noise('radio', { duration: RADIO_CLOSE - 0.012, cutoff: 2900, highpass: 600,
      gain: 0.04, attack: 0.001 });
    noise('radio', { duration: 0.009, delay: 0.058, cutoff: 1700,
      gain: 0.023, attack: 0.0005 });
  }
  function tryRecordedRadio() {
    if (!currentRadio || !voiceEnabled || !currentRadio.cue.sampleId) return false;
    const recorded = sample(currentRadio.cue.sampleId, 'radio', { gain: 1, pan: 0 }, {
      gain: 0.7, highpass: 350, cutoff: 3300, compress: true, delay: RADIO_OPEN,
    });
    if (!recorded) return false;
    currentRadio.waiting = false;
    currentRadio.remaining = Math.min(8, recorded.source.buffer.duration) + RADIO_OPEN + 0.02;
    openRadioReceiver();
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
          if (currentRadio?.token === token && !currentRadio.closing) { currentRadio.finished = true; speechOwned = false; }
        };
        const fail = () => {
          // A speech provider can report an error after accepting work, with
          // cancellation still pending. Error is not confirmation of silence.
          if (currentRadio?.token === token && !currentRadio.closing) currentRadio.finished = true;
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
    if (currentRadio === radio) openRadioReceiver();
  }
  function startRadio(cue) {
    if (!canPlay('radio')) return false;
    const token = ++radioGeneration;
    currentRadio = { cue, token, remaining: 0.85, speech: false, finished: false,
      waiting: false, waitRemaining: RADIO_SAMPLE_WAIT, opened: false, closing: false, carrier: null, endsAt: Infinity };
    applyMix();
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
      // Recordings progress on the audio clock even when the fixed-step game
      // discards stalled frame time. The receiver must not hiss/duck for several
      // more seconds; only this positive simulation tick may advance its queue.
      if (currentRadio.remaining <= 0 || currentRadio.finished || currentRadio.endsAt <= ctx.currentTime) {
        if (currentRadio.closing) finishRadio(); else closeRadioReceiver();
      }
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
