// Encounter randomness is addressed by purpose, wave and authored slot. There
// is no advancing random generator, so a failed probe or extra frame cannot
// change a later arrival time or reroll a pending contact's preferred pocket.
const UINT32_LIMIT = 0x100000000;
const DEFAULT_TIMING_FRACTION = 0.18;

function normalizeSeed(seed) {
  if (seed === null || seed === undefined) return null;
  if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_LIMIT) {
    throw new RangeError('Encounter seed must be null or an unsigned 32-bit integer');
  }
  return seed;
}

function bounded(value, fallback, maximum) {
  return Number.isFinite(value) && value >= 0 ? Math.min(maximum, value) : fallback;
}

function hash(seed, ...parts) {
  let value = (seed ^ 0x811c9dc5) >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index++) {
      value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
    }
    value = Math.imul(value ^ 0xff, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return (value ^ value >>> 16) >>> 0;
}

/**
 * A null seed preserves authored timings exactly. Runtime callers supply a
 * fresh seed once per attempt; a fixed seed reproduces this immutable plan.
 * Stage handoffs, branch deadlines, recovery rewards and attack grace are not
 * randomized. Recovery arrays are indexed by the wave that is about to arrive.
 */
export function createEncounterVariation(config, seed = null) {
  const normalizedSeed = normalizeSeed(seed), enabled = normalizedSeed !== null;
  const settings = config.variation ?? {};
  const namespace = typeof settings.key === 'string' ? settings.key : 'encounter';
  const timingFraction = bounded(settings.timingFraction, DEFAULT_TIMING_FRACTION, 0.2);
  const jitterX = bounded(settings.jitterX, 0.18, 1);
  const jitterZ = bounded(settings.jitterZ, 0.18, 1);
  const maxFirstDelay = bounded(settings.maxFirstDelay, Infinity, Infinity);
  const minRecovery = bounded(config.minRecovery, 0, Infinity);
  function delay(base, phase, waveIndex = 0, minimum = 0, maximum = Infinity) {
    if (!enabled || base === 0) return base;
    const low = Math.min(maximum, Math.max(minimum, base * (1 - timingFraction)));
    const high = Math.max(low, Math.min(maximum, base * (1 + timingFraction)));
    const amount = hash(normalizedSeed, namespace, 'timing', phase, waveIndex) / UINT32_LIMIT;
    return low + (high - low) * amount;
  }
  return Object.freeze({
    seed: normalizedSeed, enabled, namespace, timingFraction, jitterX, jitterZ,
    firstDelay: delay(config.firstWave, 'first', 0, 0, maxFirstDelay),
    recoveryDelays: Object.freeze(Array.from({ length: config.waveCount }, (_, index) =>
      delay(config.waveInterval, 'recovery', index, minRecovery))),
    reinforcementFirstDelay: delay(config.reinforcements?.firstDelay ?? 0, 'first-reinforcement'),
    reinforcementIntervals: Object.freeze(Array.from({ length: config.waveCount }, (_, index) =>
      delay(config.reinforcements?.interval ?? 0, 'reinforcement', index))),
  });
}

/**
 * Return a stable pocket order and one bounded X/Z offset per authored point.
 * Every offset is immediately followed by the untouched original anchor.
 * Neither is pre-approved: the caller must run the usual route, distance,
 * support, capsule, crowding, bearing and visibility checks on both choices.
 */
export function variedSpawnCandidates(candidates, variation, {
  waveIndex = 0, entryIndex = 0, channel = 'forward',
} = {}) {
  if (!variation?.enabled) return candidates;
  const seed = normalizeSeed(variation.seed);
  if (seed === null || !Number.isInteger(waveIndex) || waveIndex < 0
    || !Number.isInteger(entryIndex) || entryIndex < 0) return [];
  const ranked = candidates.map(anchor => {
    const key = `${anchor.x},${anchor.y},${anchor.z}`;
    return { anchor, key, rank: hash(seed, variation.namespace, 'placement', channel, waveIndex, entryIndex, key, 'order') };
  }).sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const result = [];
  for (const { anchor, key } of ranked) {
    if ([anchor.x, anchor.y, anchor.z].every(Number.isFinite)) {
      const offset = axis => (hash(seed, variation.namespace, 'placement', channel, waveIndex, entryIndex, key, axis)
        / UINT32_LIMIT * 2 - 1) * (axis === 'x' ? variation.jitterX : variation.jitterZ);
      const dx = offset('x'), dz = offset('z');
      if (dx || dz) result.push(Object.freeze({ x: anchor.x + dx, y: anchor.y, z: anchor.z + dz }));
    }
    result.push(anchor);
  }
  return Object.freeze(result);
}
