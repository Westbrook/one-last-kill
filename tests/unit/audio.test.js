import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPolicy } from '../../src/core/audio-policy.js';
import { createAudioController } from '../../src/core/audio.js';

const soundMethods = [
  'gunshot', 'meleeHit', 'footstep', 'startAmbient', 'startFireCrackle',
  'pistolShot', 'shotgunShot', 'smgShot', 'machinegunShot', 'dryClick', 'reloadClack', 'pickupChime',
];

// A deterministic in-memory WebAudio double. These tests never open audio devices.
function fakeAudio({ resumeError = false, suspendError = false } = {}) {
  const counts = { contexts: 0, nodes: 0, buffers: 0, starts: 0, resumes: 0, suspends: 0, stops: 0 };
  const gains = [];
  function param(value = 0) {
    return {
      value,
      cancelScheduledValues() {},
      setValueAtTime(next) { this.value = next; },
      linearRampToValueAtTime(next) { this.value = next; },
      exponentialRampToValueAtTime(next) { this.value = next; },
    };
  }
  function node() {
    counts.nodes++;
    return {
      gain: param(), frequency: param(), Q: param(),
      connect(target) { return target; },
      disconnect() {},
      start() { counts.starts++; },
      stop(when) {
        if (when === undefined) { counts.stops++; this.onended?.(); }
      },
    };
  }
  const context = {
    state: 'suspended', currentTime: 0, sampleRate: 100,
    destination: {},
    createGain() { const value = node(); gains.push(value); return value; },
    createBufferSource: node,
    createOscillator: node,
    createBiquadFilter: node,
    createBuffer(channels, length) { counts.buffers++; return { getChannelData: () => new Float32Array(length) }; },
    resume() {
      counts.resumes++;
      if (resumeError) return Promise.reject(new Error('Autoplay blocked'));
      this.state = 'running';
      return Promise.resolve();
    },
    suspend() {
      counts.suspends++;
      if (suspendError) return Promise.reject(new Error('Context unavailable'));
      this.state = 'suspended';
      return Promise.resolve();
    },
    close() { this.state = 'closed'; return Promise.resolve(); },
  };
  return { counts, gains, context, createContext: () => { counts.contexts++; return context; } };
}

test('audio starts muted even with no URL flag or an explicit mute=0', () => {
  for (const search of ['', '?mute=0', '?qa=0']) {
    const policy = createAudioPolicy({ search });
    assert.equal(policy.isMuted(), true);
    assert.equal(policy.hardMuted, false);
    assert.equal(policy.setMuted(false), false);
  }
});

test('silent and QA flags are immutable, including repeated query parameters', () => {
  for (const search of ['?mute=1', '?mute=true', '?qa=1', '?qa=TRUE', '?mute=0&mute=1']) {
    const policy = createAudioPolicy({ search });
    assert.equal(policy.hardMuted, true, search);
    for (let attempt = 0; attempt < 3; attempt++) assert.equal(policy.setMuted(false), true, search);
  }
  assert.equal(createAudioPolicy({ webdriver: true }).setMuted(false), true);
});

test('all sounds and resume are allocation-free while muted', async () => {
  const fake = fakeAudio();
  const audio = createAudioController({ createContext: fake.createContext });
  for (const method of soundMethods) audio[method]();
  await audio.resume();
  for (const method of soundMethods) audio[method]();
  assert.deepEqual(fake.counts, { contexts: 0, nodes: 0, buffers: 0, starts: 0, resumes: 0, suspends: 0, stops: 0 });
  assert.equal(audio.getStatus().initialized, false);
});

test('neither the public API nor repeated resumes can unmute a silent session', async () => {
  for (const options of [{ search: '?mute=1' }, { search: '?qa=1' }, { webdriver: true }]) {
    const fake = fakeAudio();
    const audio = createAudioController({ ...options, createContext: fake.createContext });
    for (let attempt = 0; attempt < 3; attempt++) {
      audio.setMuted(false);
      await audio.resume();
      for (const method of soundMethods) audio[method]();
    }
    assert.equal(audio.isHardMuted(), true);
    assert.equal(audio.isMuted(), true);
    assert.equal(fake.counts.contexts, 0);
    assert.equal(fake.counts.starts, 0);
  }
});

test('unmuting a menu preserves preference without creating a context', async () => {
  const fake = fakeAudio();
  const audio = createAudioController({ createContext: fake.createContext });
  audio.startFireCrackle();
  assert.equal(audio.setMuted(false), false);
  assert.equal(fake.counts.contexts, 0);
  assert.equal(await audio.resume(), true);
  assert.equal(fake.counts.contexts, 1);
  assert.equal(fake.counts.starts, 2);
  assert.equal(audio.getStatus().running, true);
});

test('normal audio starts after explicit unmute and reuses cached noise', async () => {
  const fake = fakeAudio();
  const audio = createAudioController({ createContext: fake.createContext });
  await audio.resume();
  audio.setMuted(false);
  await Promise.resolve();
  audio.pistolShot();
  const buffers = fake.counts.buffers;
  audio.pistolShot();
  assert.equal(fake.counts.contexts, 1);
  assert.equal(fake.counts.buffers, buffers);
  assert.equal(fake.counts.starts, 4);
});

test('mute immediately silences output, stops sounds, and prevents further allocation', async () => {
  const fake = fakeAudio();
  const audio = createAudioController({ createContext: fake.createContext });
  audio.setMuted(false);
  await audio.resume();
  audio.startAmbient();
  audio.pistolShot();
  audio.setMuted(true);
  const nodesAtMute = fake.counts.nodes;
  assert.equal(fake.gains[1].gain.value, 0);
  assert.equal(fake.counts.stops, 4);
  for (const method of soundMethods) audio[method]();
  assert.equal(fake.counts.nodes, nodesAtMute);
  assert.equal(fake.context.state, 'suspended');
});

test('pausing suspends audio without changing its preference, then restores desired ambience', async () => {
  const fake = fakeAudio();
  const audio = createAudioController({ createContext: fake.createContext });
  audio.setMuted(false);
  await audio.resume();
  audio.startAmbient();
  await audio.suspend();
  assert.equal(audio.isMuted(), false);
  assert.equal(audio.getStatus().active, false);
  const startsBeforeResume = fake.counts.starts;
  audio.gunshot();
  assert.equal(fake.counts.starts, startsBeforeResume);
  await audio.resume();
  assert.equal(fake.counts.starts, startsBeforeResume + 2);
});

test('a muted pause/resume cycle cannot change the preference', async () => {
  const fake = fakeAudio();
  const audio = createAudioController({ createContext: fake.createContext });
  await audio.resume();
  await audio.suspend();
  await audio.resume();
  assert.equal(audio.isMuted(), true);
  assert.equal(fake.counts.contexts, 0);
});

test('unsupported and blocked audio remain safe, non-throwing game states', async () => {
  for (const createContext of [null, () => { throw new Error('No output device'); }]) {
    const audio = createAudioController({ createContext });
    audio.setMuted(false);
    assert.equal(await audio.resume(), false);
    for (const method of soundMethods) assert.doesNotThrow(() => audio[method]());
    await audio.suspend();
  }
  const fake = fakeAudio({ resumeError: true });
  const audio = createAudioController({ createContext: fake.createContext });
  audio.setMuted(false);
  assert.equal(await audio.resume(), false);
  assert.equal(audio.getStatus().blocked, true);
  audio.gunshot();
  assert.equal(fake.counts.starts, 0);
});

test('a failed suspend is still silent and does not reject', async () => {
  const fake = fakeAudio({ suspendError: true });
  const audio = createAudioController({ createContext: fake.createContext });
  audio.setMuted(false);
  await audio.resume();
  await audio.suspend();
  assert.equal(fake.gains[1].gain.value, 0);
  audio.gunshot();
  assert.equal(fake.counts.starts, 0);
});

test('a late resume cannot restore audio after a mute', async () => {
  const fake = fakeAudio();
  let finishResume;
  fake.context.resume = () => new Promise((resolve) => {
    finishResume = () => { fake.context.state = 'running'; resolve(); };
  });
  const audio = createAudioController({ createContext: fake.createContext });
  audio.setMuted(false);
  const pending = audio.resume();
  audio.setMuted(true);
  finishResume();
  assert.equal(await pending, false);
  assert.equal(fake.gains[1].gain.value, 0);
  assert.equal(fake.context.state, 'suspended');
  assert.equal(fake.counts.starts, 0);
});

test('overlapping resumes cannot suspend the newest active session', async () => {
  const fake = fakeAudio();
  const finishes = [];
  fake.context.resume = () => new Promise((resolve) => {
    finishes.push(() => { fake.context.state = 'running'; resolve(); });
  });
  const audio = createAudioController({ createContext: fake.createContext });
  audio.setMuted(false);
  const first = audio.resume();
  const second = audio.resume();
  finishes[0]();
  finishes[1]();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(fake.context.state, 'running');
  assert.equal(fake.gains[1].gain.value, 1);
});

test('audio status updates report effective hard mute, not the attempted preference', () => {
  const updates = [];
  const audio = createAudioController({ search: '?qa=1', onChange: (status) => updates.push(status) });
  audio.setMuted(false);
  assert.equal(updates.at(-1).hardMuted, true);
  assert.equal(updates.at(-1).muted, true);
});
