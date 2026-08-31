// Difficulty changes pressure around authored encounters. Their locations,
// stage gates and first weapon appearances remain campaign progression data.
export const ENEMY_WEAPONS = Object.freeze({
  brawler: 'fists', thug: 'bat', gunman: 'pistol',
  hitman: 'smg', bruiser: 'shotgun', enforcer: 'machinegun',
});

const ENEMY_LEVEL = Object.freeze({ brawler: 0, thug: 1, gunman: 2, hitman: 3, bruiser: 4, enforcer: 5 });

export const DIFFICULTY_LEVELS = Object.freeze([
  {
    id: 'very-easy', label: 'Very easy',
    description: 'Fewer, weaker enemies; generous supplies; fast health regeneration.',
    enemyCount: 0.65, weaponPressure: -2, waveInterval: 1.5,
    playerDamage: 1.35, enemyDamage: 0.55,
    weaponDrop: 1, ammo: 1.6, health: 1.5, armor: 1.5,
    regen: 5, regenDelay: 3,
  },
  {
    id: 'easy', label: 'Easy',
    description: 'Lighter waves, more supplies and gradual health regeneration.',
    enemyCount: 0.8, weaponPressure: -1, waveInterval: 1.25,
    playerDamage: 1.15, enemyDamage: 0.75,
    weaponDrop: 1, ammo: 1.3, health: 1.25, armor: 1.25,
    regen: 2, regenDelay: 5,
  },
  {
    id: 'average', label: 'Average',
    description: 'The original enemy pressure, damage and supplies; no health regeneration.',
    enemyCount: 1, weaponPressure: 0, waveInterval: 1,
    playerDamage: 1, enemyDamage: 1,
    weaponDrop: 1, ammo: 1, health: 1, armor: 1,
    regen: 0, regenDelay: 0,
  },
  {
    id: 'hard', label: 'Hard',
    description: 'Larger, better armed waves with shorter breaks and scarcer supplies.',
    enemyCount: 1.2, weaponPressure: 1, waveInterval: 0.85,
    playerDamage: 0.95, enemyDamage: 1.2,
    weaponDrop: 0.82, ammo: 0.85, health: 0.8, armor: 0.85,
    regen: 0, regenDelay: 0,
  },
  {
    id: 'very-hard', label: 'Very hard',
    description: 'The largest, strongest waves; brief recovery and limited supplies.',
    enemyCount: 1.4, weaponPressure: 2, waveInterval: 0.7,
    playerDamage: 0.9, enemyDamage: 1.45,
    weaponDrop: 0.65, ammo: 0.7, health: 0.6, armor: 0.7,
    regen: 0, regenDelay: 0,
  },
].map(level => Object.freeze(level)));

const profiles = Object.freeze(Object.fromEntries(DIFFICULTY_LEVELS.map(level => [level.id, level])));
const encounterCache = new WeakMap();

export function getDifficultyProfile(id) {
  if (typeof id !== 'string' || !Object.hasOwn(profiles, id)) {
    throw new RangeError(`Unknown difficulty: ${String(id)}`);
  }
  return profiles[id];
}

function scaleWaves(config, profile) {
  const encountered = new Set();
  return Object.freeze(config.waves.map((wave, waveIndex) => {
    const required = new Set();
    for (const [index, type] of wave.entries()) {
      // Each archetype's first carrier stays in its authored wave. A capped
      // carrier also retains every authored slot, so the roof has one MG.
      if (!encountered.has(type) || config.typeCaps?.[type] !== undefined) required.add(index);
      encountered.add(type);
    }
    // The roof's opening sentries frame arrival before its timed reserves.
    if (waveIndex === 0 && config.variation?.key === 'roof') return wave;

    // Rear roles and atomic pairs use original entry indices. Preserve that
    // small roster and vary its loadout/damage rather than shifting its slots.
    const targetSize = config.rearPressure ? wave.length
      : Math.max(1, required.size, Math.round(wave.length * profile.enemyCount));
    const retained = new Set(required);
    const optional = wave.map((type, index) => ({ type, index }))
      .filter(entry => !required.has(entry.index))
      .sort((a, b) => ENEMY_LEVEL[a.type] - ENEMY_LEVEL[b.type] || a.index - b.index);
    for (const entry of optional) {
      if (retained.size >= targetSize) break;
      retained.add(entry.index);
    }
    const ceiling = Math.max(...wave.map(type => ENEMY_LEVEL[type]));
    const available = [...encountered].filter(type => ENEMY_LEVEL[type] <= ceiling
      && config.typeCaps?.[type] === undefined).sort((a, b) => ENEMY_LEVEL[a] - ENEMY_LEVEL[b]);

    const result = wave.flatMap((type, index) => {
      if (!retained.has(index)) return [];
      if (required.has(index) || (Math.abs(profile.weaponPressure) === 1 && (index + waveIndex) % 2 !== 0)) return [type];
      const rear = config.rearPressure && config.rearEntryIndices?.includes(index);
      const choices = rear ? available.filter(candidate => ENEMY_LEVEL[candidate] <= 1) : available;
      const current = choices.indexOf(type);
      if (current < 0 || !choices.length) return [type];
      const next = Math.max(0, Math.min(choices.length - 1, current + profile.weaponPressure));
      return [choices[next]];
    });
    // Additional enemies queue behind existing live/type caps. They only use
    // weapons already introduced by this wave and never add a capped carrier.
    while (result.length < targetSize) {
      const choices = available.length ? available : wave;
      const index = profile.weaponPressure > 0
        ? Math.max(0, choices.length - (profile.weaponPressure === 1 && result.length % 2 ? 2 : 1)) : 0;
      const type = choices[index];
      if (config.typeCaps?.[type] !== undefined) break;
      result.push(type);
    }
    return Object.freeze(result);
  }));
}

/**
 * Preserve every authored wave/stage boundary, safe spawn anchor and live cap.
 * Average returns the original object, including its exact roster and timings.
 */
export function scaleEncounter(config, difficulty = 'average') {
  const profile = getDifficultyProfile(typeof difficulty === 'string' ? difficulty : difficulty?.id);
  if (!config || !Array.isArray(config.waves)) throw new TypeError('An authored encounter is required');
  if (profile.id === 'average') return config;
  let cached = encounterCache.get(config);
  if (!cached) { cached = new Map(); encounterCache.set(config, cached); }
  if (cached.has(profile.id)) return cached.get(profile.id);
  const waves = scaleWaves(config, profile);
  const scaled = Object.freeze({
    ...config,
    firstWave: Math.min(config.firstWave * profile.waveInterval, config.variation?.maxFirstDelay ?? Infinity),
    waveInterval: Math.max(config.minRecovery ?? 0, config.waveInterval * profile.waveInterval),
    reinforcements: config.reinforcements ? Object.freeze({
      ...config.reinforcements,
      firstDelay: config.reinforcements.firstDelay * profile.waveInterval,
      interval: config.reinforcements.interval * profile.waveInterval,
    }) : config.reinforcements,
    waves, waveCount: waves.length,
    totalContacts: waves.reduce((sum, wave) => sum + wave.length, 0),
    composition(index) { return waves[index] || []; },
  });
  cached.set(profile.id, scaled);
  return scaled;
}
