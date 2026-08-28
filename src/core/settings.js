export const DEFAULT_SETTINGS = Object.freeze({
  quality: 'auto',
  sensitivity: 1,
  fov: 82,
  reducedMotion: false,
});

const QUALITY_OPTIONS = new Set(['auto', 'high', 'performance']);
const STORAGE_KEY = 'one-last-kill.settings.v1';

function finiteNumber(value, fallback, min, max) {
  if (value === '' || value == null || typeof value === 'boolean') return fallback;
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
  };
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
