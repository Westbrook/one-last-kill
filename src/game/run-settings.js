import { getDifficultyProfile } from './difficulty.js';

export { DIFFICULTY_LEVELS } from './difficulty.js';
export const DEFENSE_WAVE_OPTIONS = Object.freeze([10, 20, 50, 100]);
export const RUN_MODES = Object.freeze(['campaign', 'defense']);
export const DEFENSE_ARENAS = Object.freeze(['roof', 'street']);

const emptyRun = () => Object.freeze({ difficulty: null, mode: 'campaign', arena: 'roof', waves: 10, locked: false });

/** Run choices are session state, deliberately separate from saved preferences. */
export function createRunSettings({ onChange = () => {} } = {}) {
  let state = emptyRun();
  function publish(next) {
    state = Object.freeze(next);
    onChange(state);
    return state;
  }
  return Object.freeze({
    get locked() { return state.locked; },
    // Pre-game rendering can use baseline values; start still requires a choice.
    get profile() { return getDifficultyProfile(state.difficulty ?? 'average'); },
    getDifficulty() { return this.profile; },
    isConfigured() { return state.difficulty !== null; },
    isStarted() { return state.locked; },
    isLocked() { return state.locked; },
    snapshot() { return state; },
    configure(input) {
      if (state.locked) throw new Error('Run settings are locked after gameplay starts');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Run settings are required');
      const next = { ...state, ...input, locked: false };
      getDifficultyProfile(next.difficulty);
      if (!RUN_MODES.includes(next.mode)) throw new RangeError('Choose campaign or tower defense');
      if (!DEFENSE_ARENAS.includes(next.arena)) throw new RangeError('Choose the roof or street arena');
      if (!DEFENSE_WAVE_OPTIONS.includes(next.waves)) throw new RangeError('Choose 10, 20, 50 or 100 waves');
      return publish({ difficulty: next.difficulty, mode: next.mode, arena: next.arena, waves: next.waves, locked: false });
    },
    start() {
      if (state.difficulty === null) throw new Error('Choose a difficulty before starting gameplay');
      if (state.locked) return state;
      return publish({ ...state, locked: true });
    },
    // Call only when starting an entirely new run, never on pause or retry.
    reset() { return publish(emptyRun()); },
  });
}

export const RunSettings = createRunSettings({
  onChange(detail) {
    globalThis.document?.dispatchEvent(new CustomEvent('run:settingschange', { detail }));
  },
});
