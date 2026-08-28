import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, createSettingsStore } from '../../src/core/settings.js';

test('settings validate saved data and clamp numeric ranges', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ quality: 'ultra', sensitivity: -4, fov: 150, reducedMotion: 'true' }), {
    quality: 'auto', sensitivity: 0.35, fov: 100, reducedMotion: false,
  });
  assert.deepEqual(normalizeSettings({ quality: 'performance', sensitivity: '1.2', fov: '87.6', reducedMotion: true }), {
    quality: 'performance', sensitivity: 1.2, fov: 88, reducedMotion: true,
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
