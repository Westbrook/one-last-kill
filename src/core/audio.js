import { createAudioPolicy } from './audio-policy.js';

/** WebAudio is created only after an explicit unmute in an active session. */
export function createAudioController({ search = '', webdriver = false, createContext = null, onChange = () => {} } = {}) {
  let ctx = null, master = null, muteGain = null;
  let ambient = null, fire = null;
  let active = false, ambientWanted = false, fireWanted = false;
  let generation = 0, blocked = false;
  const policy = createAudioPolicy({ search, webdriver });
  const sources = new Set();
  const _noiseCache = new Map();

  function isMuted() { return policy.isMuted(); }
  function isHardMuted() { return policy.hardMuted; }
  function getStatus() {
    return {
      muted: isMuted(), hardMuted: isHardMuted(), supported: typeof createContext === 'function',
      initialized: Boolean(ctx), active, running: ctx?.state === 'running' && active && !isMuted(), blocked,
    };
  }
  function notify() { onChange(getStatus()); }
  function setOutput(value) {
    if (!ctx || !muteGain) return;
    // Immediate zeroing is intentional: muting must never leave a ramp audible.
    muteGain.gain.cancelScheduledValues(ctx.currentTime);
    muteGain.gain.setValueAtTime(value, ctx.currentTime);
    muteGain.gain.value = value;
  }
  function stopSources() {
    for (const source of sources) {
      try { source.stop(); } catch { /* The one-shot may already have ended. */ }
      try { source.disconnect(); } catch { /* A closed context is already silent. */ }
    }
    sources.clear();
    ambient = null;
    fire = null;
  }
  function suspendContext() {
    if (!ctx || ctx.state === 'closed' || ctx.state === 'suspended') return Promise.resolve(false);
    try { return Promise.resolve(ctx.suspend()).then(() => false, () => false); }
    catch { return Promise.resolve(false); }
  }
  function prepareContext() {
    if (ctx && ctx.state !== 'closed') return true;
    if (typeof createContext !== 'function') return false;
    try {
      ctx = createContext();
      master = ctx.createGain(); master.gain.value = 0.6;
      muteGain = ctx.createGain(); muteGain.gain.value = 0;
      master.connect(muteGain).connect(ctx.destination);
      _noiseCache.clear();
      blocked = false;
      return true;
    } catch {
      // Missing devices, browser policy, or unsupported APIs must not break play.
      try { Promise.resolve(ctx?.close()).catch(() => {}); } catch { /* Not open. */ }
      ctx = master = muteGain = null;
      blocked = true;
      return false;
    }
  }
  function canPlay() { return active && !isMuted() && ctx?.state === 'running'; }
  function createSource(oscillator = false) {
    const source = oscillator ? ctx.createOscillator() : ctx.createBufferSource();
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      try { source.disconnect(); } catch { /* The context may have closed. */ }
    };
    return source;
  }
  function resume() {
    active = true;
    const request = ++generation;
    if (isMuted() || !prepareContext()) { notify(); return Promise.resolve(false); }
    let resumed;
    try { resumed = ctx.state === 'running' ? undefined : ctx.resume(); }
    catch { blocked = true; notify(); return Promise.resolve(false); }
    return Promise.resolve(resumed).then(() => {
      if (!active || isMuted()) {
        setOutput(0);
        return suspendContext();
      }
      if (request !== generation) return false;
      blocked = ctx.state !== 'running';
      if (!blocked) {
        setOutput(1);
        if (ambientWanted) startAmbient();
        if (fireWanted) startFireCrackle();
      }
      notify();
      return !blocked;
    }, () => {
      if (request === generation) { blocked = true; setOutput(0); notify(); }
      return false;
    });
  }
  function suspend() {
    active = false;
    generation++;
    setOutput(0);
    stopSources();
    notify();
    return suspendContext();
  }
  function setMuted(on) {
    const muted = policy.setMuted(on);
    if (muted) {
      generation++;
      setOutput(0);
      stopSources();
      void suspendContext();
    } else if (active) {
      // Called directly from the button/key handler; no deferred user gesture.
      void resume();
    }
    notify();
    return muted;
  }
  // Reuse noise data rather than allocating thousands of samples per shot.
  function noiseBuffer(seconds = 1) {
    const key = Math.round(seconds * 100) / 100;
    let buf = _noiseCache.get(key);
    if (buf) return buf;
    const len = (key * ctx.sampleRate) | 0;
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    _noiseCache.set(key, buf);
    return buf;
  }
  function gunshot() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    const src = createSource(); src.buffer = noiseBuffer(0.22);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(1.0, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    src.connect(bp).connect(g).connect(master);
    src.start(now); src.stop(now + 0.25);
    const o = createSource(true); o.type = 'sine';
    const og = ctx.createGain();
    o.frequency.setValueAtTime(120, now);
    o.frequency.exponentialRampToValueAtTime(40, now + 0.15);
    og.gain.setValueAtTime(0.7, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    o.connect(og).connect(master); o.start(now); o.stop(now + 0.2);
  }
  function meleeHit() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    const src = createSource(); src.buffer = noiseBuffer(0.12);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    src.connect(lp).connect(g).connect(master); src.start(now); src.stop(now + 0.14);
    const o = createSource(true); o.type = 'square';
    const og = ctx.createGain();
    o.frequency.setValueAtTime(200, now);
    o.frequency.exponentialRampToValueAtTime(70, now + 0.1);
    og.gain.setValueAtTime(0.25, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    o.connect(og).connect(master); o.start(now); o.stop(now + 0.14);
  }
  function footstep() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    const src = createSource(); src.buffer = noiseBuffer(0.08);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400 + Math.random() * 200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    src.connect(lp).connect(g).connect(master); src.start(now); src.stop(now + 0.09);
  }
  function startAmbient() {
    ambientWanted = true;
    if (!canPlay() || ambient) return;
    const src = createSource(); src.buffer = noiseBuffer(4); src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 280;
    const g = ctx.createGain(); g.gain.value = 0.07;
    src.connect(lp).connect(g).connect(master); src.start();
    const o = createSource(true); o.type = 'sine'; o.frequency.value = 55;
    const og = ctx.createGain(); og.gain.value = 0.03;
    o.connect(og).connect(master); o.start();
    ambient = { src, o };
  }
  function startFireCrackle() {
    fireWanted = true;
    if (!canPlay() || fire) return;
    const src = createSource(); src.buffer = noiseBuffer(3); src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
    const g = ctx.createGain(); g.gain.value = 0.06;
    src.connect(hp).connect(g).connect(master); src.start();
    const lfo = createSource(true); lfo.type = 'sine'; lfo.frequency.value = 4 + Math.random() * 4;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.04;
    lfo.connect(lfoGain).connect(g.gain); lfo.start();
    fire = { src, lfo };
  }
  function stopFireCrackle() {
    fireWanted = false;
    if (!fire) return;
    for (const source of [fire.src, fire.lfo]) {
      try { source.stop(); } catch { /* Already stopped. */ }
      source.disconnect();
      sources.delete(source);
    }
    fire = null;
  }
  function pistolShot() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    const src = createSource(); src.buffer = noiseBuffer(0.18);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(0.95, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    src.connect(bp).connect(g).connect(master);
    src.start(now); src.stop(now + 0.18);
    const o = createSource(true); o.type = 'square';
    const og = ctx.createGain();
    o.frequency.setValueAtTime(180, now);
    o.frequency.exponentialRampToValueAtTime(60, now + 0.09);
    og.gain.setValueAtTime(0.45, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    o.connect(og).connect(master); o.start(now); o.stop(now + 0.12);
  }
  function shotgunShot() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    const src = createSource(); src.buffer = noiseBuffer(0.42);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(1.0, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    src.connect(bp).connect(g).connect(master);
    src.start(now); src.stop(now + 0.42);
    const o = createSource(true); o.type = 'sine';
    const og = ctx.createGain();
    o.frequency.setValueAtTime(90, now);
    o.frequency.exponentialRampToValueAtTime(30, now + 0.25);
    og.gain.setValueAtTime(0.9, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    o.connect(og).connect(master); o.start(now); o.stop(now + 0.32);
  }
  function smgShot() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    const src = createSource(); src.buffer = noiseBuffer(0.1);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(0.7, now + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    src.connect(bp).connect(g).connect(master);
    src.start(now); src.stop(now + 0.1);
    const o = createSource(true); o.type = 'square';
    const og = ctx.createGain();
    o.frequency.setValueAtTime(220, now);
    o.frequency.exponentialRampToValueAtTime(110, now + 0.05);
    og.gain.setValueAtTime(0.3, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    o.connect(og).connect(master); o.start(now); o.stop(now + 0.07);
  }
  function machinegunShot() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    const src = createSource(); src.buffer = noiseBuffer(0.16);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1250; bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(0.95, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    src.connect(bp).connect(g).connect(master);
    src.start(now); src.stop(now + 0.16);
    const o = createSource(true); o.type = 'sawtooth';
    const og = ctx.createGain();
    o.frequency.setValueAtTime(150, now);
    o.frequency.exponentialRampToValueAtTime(55, now + 0.09);
    og.gain.setValueAtTime(0.55, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    o.connect(og).connect(master); o.start(now); o.stop(now + 0.12);
  }
  function dryClick() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    const src = createSource(); src.buffer = noiseBuffer(0.05);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    src.connect(hp).connect(g).connect(master); src.start(now); src.stop(now + 0.05);
  }
  function reloadClack() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const t = now + i * 0.18;
      const src = createSource(); src.buffer = noiseBuffer(0.06);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.4, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      src.connect(bp).connect(g).connect(master); src.start(t); src.stop(t + 0.06);
    }
  }
  function pickupChime() {
    if (!canPlay()) return;
    const now = ctx.currentTime;
    const o = createSource(true); o.type = 'triangle';
    const og = ctx.createGain();
    o.frequency.setValueAtTime(660, now);
    o.frequency.exponentialRampToValueAtTime(990, now + 0.12);
    og.gain.setValueAtTime(0.18, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    o.connect(og).connect(master); o.start(now); o.stop(now + 0.2);
  }
  return Object.freeze({
    resume, suspend, gunshot, meleeHit, footstep, startAmbient, startFireCrackle, stopFireCrackle,
    pistolShot, shotgunShot, smgShot, machinegunShot, dryClick, reloadClack, pickupChime,
    setMuted, isMuted, isHardMuted, getStatus,
  });
}

const host = typeof window === 'undefined' ? null : window;
const Context = host?.AudioContext || host?.webkitAudioContext;
const Audio = createAudioController({
  search: host?.location?.search ?? '',
  webdriver: host?.navigator?.webdriver === true,
  createContext: typeof Context === 'function' ? () => new Context() : null,
  onChange: (detail) => {
    if (host?.document && typeof host.CustomEvent === 'function') {
      host.document.dispatchEvent(new host.CustomEvent('audiochange', { detail }));
    }
  },
});
// Inspection is safe in QA: neither this hook nor the M key can undo hard mute.
if (host) host.__punisherAudio = Audio;

export { Audio };
