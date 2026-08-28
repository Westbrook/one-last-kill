import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSpeechAdapter } from '../../src/core/local-speech.js';

const localEnglish = { name: 'Local English', localService: true, lang: 'en-US', default: false };

// No browser objects, audio devices, or speech services are used in this suite.
function fakeSpeech({ voices = [localEnglish], speakError = false, cancelError = false } = {}) {
  const counts = { apiReads: 0, voices: 0, utterances: 0, speaks: 0, cancels: 0 };
  const spoken = [];
  const synthesis = {
    getVoices() { counts.voices++; return voices; },
    speak(utterance) {
      counts.speaks++;
      spoken.push(utterance);
      if (speakError) throw new Error('Speech blocked');
    },
    cancel() {
      counts.cancels++;
      if (cancelError) throw new Error('Speech unavailable');
    },
  };
  class Utterance {
    constructor(text) { counts.utterances++; this.text = text; }
  }
  const host = {
    get speechSynthesis() { counts.apiReads++; return synthesis; },
    get SpeechSynthesisUtterance() { counts.apiReads++; return Utterance; },
  };
  return { host, counts, spoken, synthesis };
}

test('constructing, inspecting, and cancelling an idle adapter never access the host', () => {
  let reads = 0;
  const host = {
    get speechSynthesis() { reads++; throw new Error('Must remain untouched'); },
    get SpeechSynthesisUtterance() { reads++; throw new Error('Must remain untouched'); },
  };
  const adapter = createLocalSpeechAdapter(host);
  assert.equal(reads, 0);
  assert.equal(adapter.pending(), false);
  assert.equal(adapter.cancel(), false);
  assert.equal(adapter.pending(), false);
  assert.equal(reads, 0);
});

test('pending inspection tracks active speech and normal completion without any API access', () => {
  const fake = fakeSpeech();
  const adapter = createLocalSpeechAdapter(fake.host);
  assert.equal(adapter.pending(), false);
  adapter.speak({ text: 'Checkpoint secured.', volume: 0.3 });
  const beforeInspection = { ...fake.counts };
  assert.equal(adapter.pending(), true);
  assert.deepEqual(fake.counts, beforeInspection);
  fake.spoken[0].onend();
  assert.equal(adapter.pending(), false);
  assert.deepEqual(fake.counts, beforeInspection);
});

test('invalid, silent, empty, and overlong requests are rejected before API access', () => {
  const fake = fakeSpeech();
  const adapter = createLocalSpeechAdapter(fake.host);
  for (const request of [
    undefined, null, {}, { text: 'Copy.' },
    ...[0, -1, NaN, Infinity, -Infinity, '1', null].map(volume => ({ text: 'Copy.', volume })),
    ...['', ' \n\t ', 'x'.repeat(241), null, 42].map(text => ({ text, volume: 1 })),
  ]) assert.equal(adapter.speak(request), false);
  assert.deepEqual(fake.counts, { apiReads: 0, voices: 0, utterances: 0, speaks: 0, cancels: 0 });
});

test('availability is lazy and never constructs or schedules an utterance', () => {
  const fake = fakeSpeech();
  const adapter = createLocalSpeechAdapter(fake.host);
  assert.equal(adapter.available(), true);
  assert.equal(fake.counts.voices, 1);
  assert.equal(fake.counts.utterances, 0);
  assert.equal(fake.counts.speaks, 0);
  assert.equal(fake.counts.cancels, 0);
});

test('missing or remote-only voices cannot trigger fallback speech', () => {
  for (const voices of [
    [], null, {},
    [{ ...localEnglish, localService: false }],
    [{ ...localEnglish, localService: 'true' }],
    [{ lang: 'en-US', default: true }],
  ]) {
    const fake = fakeSpeech({ voices });
    const adapter = createLocalSpeechAdapter(fake.host);
    assert.equal(adapter.available(), false);
    assert.equal(adapter.speak({ text: 'Checkpoint secured.', volume: 0.5 }), false);
    assert.equal(fake.counts.utterances, 0);
    assert.equal(fake.counts.speaks, 0);
  }
});

test('voice choice prefers local English, then a local default, never a remote default', () => {
  const englishDefault = { ...localEnglish, name: 'English Default', default: true };
  const localDefault = { name: 'Local Default', localService: true, lang: 'fr-FR', default: true };
  const localOther = { name: 'Local Other', localService: true, lang: 'de-DE', default: false };
  const remoteDefault = { ...englishDefault, name: 'Remote Default', localService: false };
  for (const [voices, expected] of [
    [[remoteDefault, localDefault, localEnglish, englishDefault], englishDefault],
    [[remoteDefault, localDefault, localEnglish], localEnglish],
    [[remoteDefault, localOther, localDefault], localDefault],
    [[remoteDefault, localOther], localOther],
  ]) {
    const fake = fakeSpeech({ voices });
    const adapter = createLocalSpeechAdapter(fake.host);
    assert.equal(adapter.speak({ text: '  Checkpoint secured.  ', volume: 0.4 }), true);
    const utterance = fake.spoken[0];
    assert.equal(utterance.voice, expected);
    assert.equal(utterance.lang, expected.lang);
    assert.equal(utterance.text, 'Checkpoint secured.');
    assert.equal(utterance.volume, 0.4);
  }
});

test('valid requests clamp excessive gain and accept at most 240 trimmed characters', () => {
  const fake = fakeSpeech();
  const adapter = createLocalSpeechAdapter(fake.host);
  assert.equal(adapter.speak({ text: ` ${'x'.repeat(240)} `, volume: 5 }), true);
  assert.equal(fake.spoken[0].text.length, 240);
  assert.equal(fake.spoken[0].volume, 1);
});

test('superseding speech detaches and cancels the old utterance without queuing it', () => {
  const fake = fakeSpeech();
  const adapter = createLocalSpeechAdapter(fake.host);
  const calls = [];
  adapter.speak({ text: 'First.', volume: 0.3, onend: () => calls.push('old end'), onerror: () => calls.push('old error') });
  const old = fake.spoken[0];
  const oldEnd = old.onend;
  const oldError = old.onerror;
  fake.synthesis.cancel = () => {
    fake.counts.cancels++;
    assert.equal(old.onend, null);
    assert.equal(old.onerror, null);
    oldEnd();
    oldError();
  };
  assert.equal(adapter.speak({ text: 'Second.', volume: 0.3, onend: () => calls.push('new end') }), true);
  assert.equal(fake.counts.cancels, 1);
  oldEnd();
  oldError();
  assert.deepEqual(calls, []);
  fake.spoken[1].onend();
  assert.deepEqual(calls, ['new end']);
  assert.equal(adapter.cancel(), false);
  assert.equal(fake.counts.cancels, 1);
});

test('explicit cancellation detaches before stopping and ignores late callbacks', () => {
  const fake = fakeSpeech();
  const adapter = createLocalSpeechAdapter(fake.host);
  let callbacks = 0;
  adapter.speak({ text: 'Clear.', volume: 0.2, onend: () => callbacks++, onerror: () => callbacks++ });
  const utterance = fake.spoken[0];
  const end = utterance.onend;
  const error = utterance.onerror;
  fake.synthesis.cancel = () => {
    fake.counts.cancels++;
    assert.equal(utterance.onend, null);
    assert.equal(utterance.onerror, null);
    end();
    error();
  };
  assert.equal(adapter.cancel(), true);
  assert.equal(utterance.volume, 0);
  end();
  error();
  assert.equal(callbacks, 0);
  assert.equal(adapter.cancel(), false);
  assert.equal(fake.counts.cancels, 1);
});

test('end and error callbacks settle once, including when the callback itself throws', () => {
  for (const firstEvent of ['onend', 'onerror']) {
    const fake = fakeSpeech();
    const adapter = createLocalSpeechAdapter(fake.host);
    const calls = [];
    adapter.speak({
      text: 'Clear.', volume: 0.2,
      onend: event => { calls.push(['end', event]); throw new Error('Caller failed'); },
      onerror: event => { calls.push(['error', event]); throw new Error('Caller failed'); },
    });
    const utterance = fake.spoken[0];
    const handlers = { onend: utterance.onend, onerror: utterance.onerror };
    const event = { type: firstEvent };
    assert.doesNotThrow(() => handlers[firstEvent](event));
    handlers.onend();
    handlers.onerror();
    assert.deepEqual(calls, [[firstEvent === 'onend' ? 'end' : 'error', event]]);
    assert.equal(utterance.onend, null);
    assert.equal(utterance.onerror, null);
    assert.equal(adapter.cancel(), false);
  }
});

test('a completion callback may safely start the next utterance', () => {
  const fake = fakeSpeech();
  const adapter = createLocalSpeechAdapter(fake.host);
  let nextEnded = 0;
  adapter.speak({
    text: 'First.', volume: 0.2,
    onend: () => adapter.speak({ text: 'Next.', volume: 0.2, onend: () => nextEnded++ }),
  });
  const firstEnd = fake.spoken[0].onend;
  firstEnd();
  firstEnd();
  assert.equal(fake.spoken.length, 2);
  assert.equal(fake.counts.cancels, 0);
  fake.spoken[1].onend();
  assert.equal(nextEnded, 1);
});

test('blocked speech reports failure once and cancels partially scheduled work', () => {
  const fake = fakeSpeech({ speakError: true });
  const adapter = createLocalSpeechAdapter(fake.host);
  let errors = 0;
  assert.equal(adapter.speak({ text: 'Clear.', volume: 0.2, onerror: () => errors++ }), false);
  assert.equal(errors, 1);
  assert.equal(fake.counts.cancels, 1);
  assert.equal(fake.spoken[0].onend, null);
  assert.equal(fake.spoken[0].onerror, null);
  assert.equal(adapter.cancel(), false);
});

test('a synchronously reported speech error returns false without duplicate completion', () => {
  const fake = fakeSpeech();
  fake.synthesis.speak = utterance => {
    fake.spoken.push(utterance);
    const error = utterance.onerror;
    error({ error: 'not-allowed' });
    error({ error: 'not-allowed' });
  };
  const adapter = createLocalSpeechAdapter(fake.host);
  let errors = 0;
  assert.equal(adapter.speak({ text: 'Clear.', volume: 0.2, onerror: () => errors++ }), false);
  assert.equal(errors, 1);
  assert.equal(adapter.cancel(), false);
});

test('missing APIs and synchronous service or constructor errors are non-throwing', () => {
  const inaccessible = { get speechSynthesis() { throw new Error('Disabled'); } };
  const voicesFailure = fakeSpeech();
  voicesFailure.synthesis.getVoices = () => { throw new Error('No voice service'); };
  const constructorFailure = fakeSpeech();
  const brokenConstructorHost = {
    speechSynthesis: constructorFailure.synthesis,
    SpeechSynthesisUtterance: class { constructor() { throw new Error('Disabled'); } },
  };
  for (const host of [undefined, null, {}, inaccessible, voicesFailure.host, brokenConstructorHost]) {
    const adapter = createLocalSpeechAdapter(host);
    assert.doesNotThrow(() => adapter.available());
    assert.equal(adapter.speak({ text: 'Clear.', volume: 0.2 }), false);
    assert.equal(adapter.cancel(), false);
  }
});

test('cancellation failures retain one detached record for retry and block queued replacements', () => {
  const fake = fakeSpeech({ cancelError: true });
  const adapter = createLocalSpeechAdapter(fake.host);
  let ended = 0;
  adapter.speak({ text: 'Clear.', volume: 0.2, onend: () => ended++ });
  const end = fake.spoken[0].onend;
  assert.equal(adapter.cancel(), false);
  assert.equal(adapter.pending(), true);
  assert.equal(fake.spoken[0].volume, 0);
  end();
  assert.equal(ended, 0);
  assert.equal(adapter.speak({ text: 'Replacement.', volume: 0.3 }), false);
  assert.equal(fake.counts.speaks, 1);
  assert.equal(fake.counts.cancels, 2);
  fake.synthesis.cancel = () => { fake.counts.cancels++; };
  assert.equal(adapter.cancel(), true);
  assert.equal(adapter.pending(), false);
  assert.equal(adapter.cancel(), false);
  assert.equal(fake.counts.cancels, 3);
  assert.equal(adapter.speak({ text: 'Retry.', volume: 0.3 }), true);
  assert.equal(fake.counts.speaks, 2);
});

test('a partially scheduled failed utterance also blocks replacements until cancellation succeeds', () => {
  const fake = fakeSpeech({ speakError: true, cancelError: true });
  const adapter = createLocalSpeechAdapter(fake.host);
  let errors = 0;
  let pendingOnError;
  assert.equal(adapter.speak({
    text: 'Clear.', volume: 0.2,
    onerror: () => { errors++; pendingOnError = adapter.pending(); },
  }), false);
  assert.equal(errors, 1);
  assert.equal(pendingOnError, true);
  assert.equal(adapter.pending(), true);
  assert.equal(fake.spoken[0].volume, 0);
  assert.equal(fake.spoken[0].onend, null);
  assert.equal(fake.spoken[0].onerror, null);
  assert.equal(adapter.speak({ text: 'Replacement.', volume: 0.3, onerror: () => errors++ }), false);
  assert.equal(fake.counts.speaks, 1);
  assert.equal(errors, 1);
  fake.synthesis.cancel = () => { fake.counts.cancels++; };
  assert.equal(adapter.cancel(), true);
  assert.equal(adapter.pending(), false);
  assert.equal(adapter.cancel(), false);
});
