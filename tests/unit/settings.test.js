import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_MIX_SETTINGS, DEFAULT_SETTINGS, audioMixFromSettings, normalizeSettings, createSettingsStore } from '../../src/core/settings.js';

test('settings validate saved data and clamp numeric ranges', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ quality: 'ultra', sensitivity: -4, fov: 150, reducedMotion: 'true' }), {
    ...DEFAULT_SETTINGS, quality: 'auto', sensitivity: 0.35, fov: 100, reducedMotion: false,
  });
  assert.deepEqual(normalizeSettings({ quality: 'performance', sensitivity: '1.2', fov: '87.6', reducedMotion: true }), {
    ...DEFAULT_SETTINGS, quality: 'performance', sensitivity: 1.2, fov: 88, reducedMotion: true,
  });
  assert.equal(normalizeSettings({ sensitivity: Infinity, fov: '' }).fov, 82);
  assert.equal(normalizeSettings({ sensitivity: Infinity }).sensitivity, 1);
  assert.equal(normalizeSettings({ sensitivity: true }).sensitivity, 1);
});

test('settings persist only normalized changes and expose independent snapshots', () => {
  const changes = [];
  const writes = [];
  const storage = {
    getItem: () => '{"fov":90,"quality":"high","unknown":"discard"}',
    setItem: (key, value) => writes.push({ key, value }),
  };
  const settings = createSettingsStore({ storage, onChange: (value) => changes.push(value) });
  assert.equal(settings.get('fov'), 90);
  settings.snapshot().fov = 40;
  assert.equal(settings.get('fov'), 90);
  settings.set('fov', 90);
  assert.equal(writes.length, 0);
  settings.set({ sensitivity: 5, reducedMotion: true });
  assert.equal(settings.get('sensitivity'), 2.5);
  assert.equal(writes.length, 1);
  assert.equal(changes.length, 1);
  changes[0].quality = 'performance';
  assert.equal(settings.get('quality'), 'high');
  assert.equal(JSON.parse(writes[0].value).unknown, undefined);
  assert.deepEqual(settings.reset(), DEFAULT_SETTINGS);
});

test('blocked or malformed storage does not prevent preference changes', () => {
  const blocked = createSettingsStore({
    storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } },
    initial: { reducedMotion: true },
  });
  assert.equal(blocked.get('reducedMotion'), true);
  assert.equal(blocked.set('fov', 76).fov, 76);
  const corrupt = createSettingsStore({ storage: { getItem: () => '{bad json' } });
  assert.deepEqual(corrupt.snapshot(), DEFAULT_SETTINGS);
});

test('touch controls require an explicit boolean opt-in and persist across sessions and reset', () => {
  for (const value of [undefined, null, 'true', 'false', 0, 1, {}, []]) {
    assert.equal(normalizeSettings({ touchControls: value }).touchControls, false);
  }
  assert.equal(normalizeSettings({ touchControls: true }).touchControls, true);
  assert.equal(normalizeSettings({ touchControls: false }).touchControls, false);

  let saved = JSON.stringify({ quality: 'performance', sensitivity: 1.45 });
  let writes = 0;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; writes++; } };
  const settings = createSettingsStore({ storage });
  assert.equal(settings.get('touchControls'), false, 'older saves keep touch controls off');
  settings.set('touchControls', true);
  assert.equal(writes, 1);
  settings.set('touchControls', true);
  assert.equal(writes, 1, 'unchanged opt-in does not rewrite storage');
  const restored = createSettingsStore({ storage });
  assert.equal(restored.get('touchControls'), true);
  assert.equal(restored.get('quality'), 'performance');
  assert.equal(restored.get('sensitivity'), 1.45);
  restored.set('touchControls', false);
  assert.equal(createSettingsStore({ storage }).get('touchControls'), false);
  restored.set('touchControls', true);
  restored.reset();
  assert.equal(createSettingsStore({ storage }).get('touchControls'), false);
});

test('audio preferences normalize each independent channel without storing mute authority', () => {
  for (const key of Object.values(AUDIO_MIX_SETTINGS)) {
    for (const [value, expected] of [[-1, 0], [2, 1], ['0.37', 0.37], [0, 0], [1, 1]]) {
      const settings = normalizeSettings({ [key]: value, muted: false, hardMuted: false });
      assert.equal(settings[key], expected, key + ' normalizes ' + value);
      for (const other of Object.values(AUDIO_MIX_SETTINGS)) if (other !== key) assert.equal(settings[other], DEFAULT_SETTINGS[other]);
      assert.equal(settings.muted, undefined);
      assert.equal(settings.hardMuted, undefined);
    }
    for (const value of [NaN, Infinity, -Infinity, '', ' ', 'invalid', null, true, false, [], [0.5], {}]) {
      assert.equal(normalizeSettings({ [key]: value })[key], DEFAULT_SETTINGS[key], key + ' rejects malformed input');
    }
  }
  assert.equal(normalizeSettings({ checkpointVoice: false }).checkpointVoice, false);
  assert.equal(normalizeSettings({ checkpointVoice: 'false' }).checkpointVoice, true);
  assert.equal(normalizeSettings({ checkpointVoice: 0 }).checkpointVoice, true);
});

test('engine mix mapping is normalized, independent and detached from settings snapshots', () => {
  assert.deepEqual(audioMixFromSettings(), { master: 0.75, effects: 0.85, ambience: 0.4, music: 0.28, radio: 0.9 });
  assert.deepEqual(audioMixFromSettings({ audioMaster: 0, audioEffects: 0.5, audioAmbience: 1, audioMusic: -2, audioRadio: 0.73 }), {
    master: 0, effects: 0.5, ambience: 1, music: 0, radio: 0.73,
  });
  const settings = createSettingsStore();
  const mix = audioMixFromSettings(settings.snapshot());
  mix.effects = 0;
  assert.equal(settings.get('audioEffects'), 0.85);
  assert.equal(audioMixFromSettings(settings.snapshot()).effects, 0.85);
  assert.ok(Object.isFrozen(AUDIO_MIX_SETTINGS));
});

test('older saves gain audio defaults and volume and voice edits persist across sessions and reset', () => {
  let saved = JSON.stringify({ quality: 'high', fov: 94 });
  let writes = 0;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; writes++; } };
  const settings = createSettingsStore({ storage });
  assert.equal(settings.get('quality'), 'high');
  assert.equal(settings.get('fov'), 94);
  assert.deepEqual(audioMixFromSettings(settings.snapshot()), audioMixFromSettings(DEFAULT_SETTINGS));
  settings.set({ audioMaster: 0.62, audioEffects: 0.24, audioAmbience: 0.13, audioMusic: 0, audioRadio: 0.83, checkpointVoice: false });
  assert.equal(writes, 1);
  settings.set({ audioMaster: 0.62, audioEffects: 0.24, audioAmbience: 0.13, audioMusic: 0, audioRadio: 0.83, checkpointVoice: false });
  assert.equal(writes, 1, 'unchanged levels do not rewrite storage');
  const restored = createSettingsStore({ storage });
  assert.deepEqual(restored.snapshot(), settings.snapshot());
  assert.equal(restored.get('audioMusic'), 0, 'a silent channel survives normalization and reload');
  assert.equal(restored.get('checkpointVoice'), false);
  assert.equal(restored.get('fov'), 94, 'audio changes preserve other preferences');
  assert.deepEqual(restored.reset(), DEFAULT_SETTINGS);
  assert.deepEqual(createSettingsStore({ storage }).snapshot(), DEFAULT_SETTINGS);
});
