export const DEFAULT_SETTINGS = Object.freeze({
  quality: 'auto',
  sensitivity: 1,
  fov: 82,
  reducedMotion: false,
  audioMaster: 0.75,
  audioEffects: 0.85,
  audioAmbience: 0.4,
  audioMusic: 0.28,
  audioRadio: 0.9,
  checkpointVoice: true,
});

export const AUDIO_MIX_SETTINGS = Object.freeze({
  master: 'audioMaster',
  effects: 'audioEffects',
  ambience: 'audioAmbience',
  music: 'audioMusic',
  radio: 'audioRadio',
});

const QUALITY_OPTIONS = new Set(['auto', 'high', 'performance']);
const STORAGE_KEY = 'one-last-kill.settings.v1';

function finiteNumber(value, fallback, min, max) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** Keep saved preferences and form values inside the engine's supported ranges. */
export function normalizeSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    quality: QUALITY_OPTIONS.has(source.quality) ? source.quality : DEFAULT_SETTINGS.quality,
    sensitivity: finiteNumber(source.sensitivity, DEFAULT_SETTINGS.sensitivity, 0.35, 2.5),
    fov: Math.round(finiteNumber(source.fov, DEFAULT_SETTINGS.fov, 70, 100)),
    reducedMotion: typeof source.reducedMotion === 'boolean' ? source.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
    ...Object.fromEntries(Object.values(AUDIO_MIX_SETTINGS).map((key) => [key, finiteNumber(source[key], DEFAULT_SETTINGS[key], 0, 1)])),
    checkpointVoice: typeof source.checkpointVoice === 'boolean' ? source.checkpointVoice : DEFAULT_SETTINGS.checkpointVoice,
  };
}

/** Mix preferences never contain mute state or permission to create an audio device. */
export function audioMixFromSettings(value = {}) {
  const settings = normalizeSettings(value);
  return Object.fromEntries(Object.entries(AUDIO_MIX_SETTINGS).map(([channel, key]) => [channel, settings[key]]));
}

/** Storage is optional: restricted browsers still get working session preferences. */
export function createSettingsStore({ storage = null, initial = {}, onChange = () => {} } = {}) {
  let saved = {};
  try { saved = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}'); } catch { /* Ignore corrupt or inaccessible storage. */ }
  let state = normalizeSettings({ ...initial, ...(saved && typeof saved === 'object' ? saved : {}) });

  return {
    get(key) { return state[key]; },
    snapshot() { return { ...state }; },
    set(key, value) {
      const patch = typeof key === 'string' ? { [key]: value } : key;
      const next = normalizeSettings({ ...state, ...(patch && typeof patch === 'object' ? patch : {}) });
      if (Object.keys(DEFAULT_SETTINGS).every((name) => next[name] === state[name])) return { ...state };
      state = next;
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Preferences remain usable without persistence. */ }
      onChange({ ...state });
      return { ...state };
    },
    reset() { return this.set(DEFAULT_SETTINGS); },
  };
}

function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export const Settings = createSettingsStore({
  storage: browserStorage(),
  initial: { reducedMotion: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false },
  onChange(detail) {
    globalThis.document?.dispatchEvent(new CustomEvent('settingschange', { detail }));
  },
});
