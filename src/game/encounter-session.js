/**
 * One seed per encounter attempt, independent of particles, audio and AI spread.
 * Authored/fixed overrides are used by explicit QA fixtures; normal play always
 * asks for new entropy. The clock is a fallback seed source, never a timer.
 */
export function createEncounterSeedSource({
  fillRandom = values => globalThis.crypto?.getRandomValues(values),
  clock = () => Date.now(),
} = {}) {
  const entropy = new Uint32Array(1);
  let override;
  let sequence = 0;
  let lastSeed = null;

  function next() {
    if (override !== undefined) {
      lastSeed = override;
      return override;
    }
    sequence = (sequence + 1) >>> 0;
    let value;
    try {
      entropy[0] = 0;
      if (typeof fillRandom === 'function' && fillRandom(entropy) === entropy) value = entropy[0];
    } catch { /* Offline/restricted hosts still get independent attempts. */ }
    if (value === undefined) {
      try { value = clock(); } catch { value = 0; }
      value = Number.isFinite(value) ? Math.trunc(value) >>> 0 : 0;
    }
    // The counter also prevents repeated attempts from sharing a seed when a
    // restricted host has only a coarse clock or a deterministic entropy stub.
    let seed = (value ^ Math.imul(sequence, 0x9e3779b9)) >>> 0;
    if (seed === lastSeed) seed = (seed + 1) >>> 0;
    lastSeed = seed;
    return seed;
  }

  function setOverride(seed) {
    if (seed !== undefined && seed !== null
      && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
      throw new TypeError('An encounter seed must be a uint32, null for authored fixtures, or undefined for fresh attempts');
    }
    const previous = override;
    override = seed;
    return previous;
  }

  function snapshot() {
    return { mode: override === undefined ? 'random' : override === null ? 'authored' : 'seeded',
      override, lastSeed, attempts: sequence };
  }

  return Object.freeze({ next, setOverride, snapshot });
}

export const EncounterSeeds = createEncounterSeedSource();
