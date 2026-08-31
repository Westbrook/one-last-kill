// Finite arena waves and resupply budgets, independent of rendering and input.
import { CHECKPOINTS, ZONE_ORDER, ZONE_WAVE_CONFIG } from './mission-data.js';
import { ENEMY_WEAPONS, getDifficultyProfile } from './difficulty.js';
import { WEAPON_DEFS } from './weapon-data.js';
import { AMMO_SUPPLY_UNITS } from './ammo-supply-rules.js';
import { ROOF } from '../world/layout.js';
import { DISTRICT } from '../world/district-layout.js';

export const DEFENSE_WAVE_COUNTS = Object.freeze([10, 20, 50, 100]);

export const DEFENSE_ARENAS = Object.freeze({
  roof: Object.freeze({
    id: 'roof', label: 'ROOFTOP', floorY: ROOF.floorY,
    bounds: Object.freeze({ x1: ROOF.x1, x2: ROOF.x2, z1: ROOF.z1, z2: ROOF.z2 }),
    checkpoint: CHECKPOINTS.roof,
  }),
  street: Object.freeze({
    id: 'street', label: 'STREET', floorY: DISTRICT.street.road.floorY,
    bounds: Object.freeze({
      x1: DISTRICT.street.road.x1, x2: DISTRICT.street.road.x2,
      z1: DISTRICT.street.nearApron.z1, z2: DISTRICT.street.farWalk.z2,
    }),
    checkpoint: CHECKPOINTS.street,
  }),
});

// Preserve the campaign's absolute first appearances at every difficulty and
// duration: fists/bat 1, pistol 3 (neighbor 2), SMG 9 (stairwell 3), shotgun and
// machine gun 12 (roof 2). A ten-wave defense consequently ends at SMGs. The
// knife has no campaign source and is not introduced as an early supply.
export const DEFENSE_UNLOCKS = (() => {
  const seen = new Set(), unlocks = [];
  let wave = 0;
  for (const zone of ZONE_ORDER) {
    for (const [index, group] of ZONE_WAVE_CONFIG[zone].waves.entries()) {
      wave++;
      for (const enemy of group) {
        if (seen.has(enemy)) continue;
        seen.add(enemy);
        unlocks.push(Object.freeze({ wave, zone, zoneWave: index + 1, enemy, weapon: ENEMY_WEAPONS[enemy] }));
      }
    }
  }
  return Object.freeze(unlocks);
})();

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const EMPTY = Object.freeze([]);

function arenaDefinition(arena) {
  if (!Object.hasOwn(DEFENSE_ARENAS, arena)) throw new RangeError(`Unknown defense arena: ${arena}`);
  return DEFENSE_ARENAS[arena];
}

function waveNumber(wave) {
  if (!Number.isInteger(wave) || wave < 1 || wave > 100) throw new RangeError('Defense wave must be from 1 to 100');
  return wave;
}

function defenseDifficulty(difficulty) {
  const id = typeof difficulty === 'object' && difficulty !== null ? difficulty.id : difficulty;
  if (id === undefined || id === null) throw new RangeError('Choose a difficulty before starting a defense');
  return getDifficultyProfile(id);
}

export function defenseUnlockedWeapons(wave) {
  waveNumber(wave);
  return Object.freeze(DEFENSE_UNLOCKS.filter(unlock => unlock.wave <= wave).map(unlock => unlock.weapon));
}

function defenseRoster(wave, profile) {
  const unlocked = DEFENSE_UNLOCKS.filter(unlock => unlock.wave <= wave);
  const roster = unlocked.filter(unlock => unlock.wave === wave).map(unlock => unlock.enemy);
  const baseCount = Math.min(10, 2 + Math.floor((wave - 1) / 3));
  const count = Math.max(roster.length, 1, Math.min(12, Math.round(baseCount * profile.enemyCount)));
  const distribution = [0.1, 0.5, 0.2, 0.8, 0.4, 1, 0.6, 0.3, 0.9, 0.7];
  const pressure = profile.weaponPressure * 0.1 + Math.min(1, (wave - 1) / 40) * 0.3;
  while (roster.length < count) {
    const value = distribution[(roster.length + wave) % distribution.length] + pressure;
    const tier = Math.floor(clamp(value, 0, 0.999) * unlocked.length);
    roster.push(unlocked[tier].enemy);
  }
  return Object.freeze(roster);
}

/**
 * All waves share the arena's tested spawn pockets. No route gate, retirement,
 * rear role or reinforcement policy can overlap waves or grant skipped clears.
 * A larger roster queues behind the six-live ceiling until every contact dies.
 */
export function createDefenseEncounter({ arena, waves, difficulty } = {}) {
  const location = arenaDefinition(arena), profile = defenseDifficulty(difficulty);
  if (!DEFENSE_WAVE_COUNTS.includes(waves)) throw new RangeError('Choose 10, 20, 50 or 100 defense waves');
  const groups = Object.freeze(Array.from({ length: waves }, (_, index) => defenseRoster(index + 1, profile)));
  const source = ZONE_WAVE_CONFIG[arena];
  return Object.freeze({
    mode: 'defense', arena, difficulty: profile.id,
    firstWave: 6 * profile.waveInterval,
    waveInterval: 6 * profile.waveInterval,
    minRecovery: 3 * profile.waveInterval,
    maxAlive: Math.min(6, Math.max(2, Math.ceil(4 * profile.enemyCount))),
    maxHeightDifference: 1.2,
    retireLive: false,
    advanceOnFrontClear: false,
    route: null, stages: null, rearPressure: null, rearSpawns: EMPTY,
    reinforcements: null,
    typeCaps: Object.freeze({ enforcer: 1 }),
    variation: Object.freeze({ ...source.variation, key: 'defense-' + arena, timingFraction: 0.12 }),
    spawns: source.spawns,
    waves: groups, waveCount: waves,
    totalContacts: groups.reduce((sum, group) => sum + group.length, 0),
    exitHint: 'HOLD THE ' + location.label,
    composition(index) { return groups[index] || EMPTY; },
  });
}

/**
 * One finite distribution for the next one-based wave. Health is an additive
 * healing amount; armor is a replacement vest strength; ammo uses the existing
 * shared cache units. The caller expires the previous wave's unclaimed supply.
 */
export function defenseSupplyBudget({
  difficulty, wave, health = 100, armor = 0, weapon = {}, performance = {},
} = {}) {
  waveNumber(wave);
  const profile = defenseDifficulty(difficulty), unlocked = defenseUnlockedWeapons(wave);
  const healthMissing = 100 - clamp(finite(health, 100), 0, 100);
  const currentArmor = clamp(finite(armor), 0, 100);
  const adversity = clamp(finite(performance.damageTaken) / 80, 0, 1);
  const shots = Math.max(0, finite(performance.shots));
  const hitRate = shots > 0 ? clamp(finite(performance.hits) / shots, 0, 1) : 0.5;
  const success = clamp(finite(performance.kills) / 6, 0, 1) * hitRate;
  const healing = Math.min(healthMissing, Math.round(Math.min(60, (20 + 20 * adversity + 8 * (1 - hitRate)) * profile.health)));
  const vest = Math.round(clamp((40 + 20 * adversity + 10 * success) * profile.armor, 0, 100));

  const ranged = unlocked.filter(type => WEAPON_DEFS[type].kind === 'ranged');
  const heldRanged = ranged.includes(weapon?.current);
  const refillType = heldRanged ? weapon.current : ranged.at(-1);
  const currentAmmo = heldRanged ? Math.max(0, finite(weapon.loaded)) + Math.max(0, finite(weapon.reserve)) : 0;
  const ammoShortfall = refillType ? 1 - clamp(currentAmmo / (WEAPON_DEFS[refillType].mag * 3), 0, 1) : 0;
  const ammoUnits = refillType ? Math.round(clamp(AMMO_SUPPLY_UNITS * profile.ammo
    * (0.4 + 0.7 * ammoShortfall + 0.2 * success), 0, AMMO_SUPPLY_UNITS * 2)) : 0;

  const weapons = DEFENSE_UNLOCKS.filter(unlock => unlock.wave === wave && unlock.weapon !== 'fists')
    .map(unlock => unlock.weapon);
  const replacementInterval = Math.max(2, Math.round(4 / Math.max(0.25, profile.weaponDrop)));
  if (!weapons.length && !heldRanged && ranged.length && wave % replacementInterval === 0) {
    weapons.push(ranged.at(-1));
  }
  return Object.freeze({
    health: healing,
    armor: vest > currentArmor ? vest : 0,
    ammoUnits,
    weapons: Object.freeze(weapons.map(type => Object.freeze({
      type, ammo: WEAPON_DEFS[type].kind === 'ranged'
        ? Math.max(1, Math.round(WEAPON_DEFS[type].mag * profile.ammo)) : 0,
    }))),
  });
}

function insideRectangle(point, rectangle, margin) {
  return point.x >= rectangle.x1 + margin && point.x <= rectangle.x2 - margin
    && point.z >= rectangle.z1 + margin && point.z <= rectangle.z2 - margin;
}

/** Feet may jump or stand on cover, but leaving the arena or falling returns. */
export function isInsideDefenseArena(arena, foot, { margin = 0.35 } = {}) {
  const location = arenaDefinition(arena);
  if (!foot || !['x', 'y', 'z'].every(axis => Number.isFinite(foot[axis]))
    || !Number.isFinite(margin) || margin < 0) return false;
  if (foot.y < location.floorY - 0.8 || foot.y > location.floorY + 3.6
    || !insideRectangle(foot, location.bounds, margin)) return false;
  if (arena === 'roof' && insideRectangle(foot, ROOF.lightwell, -margin)) return false;
  return true;
}

/**
 * Nearby choices only; none bypass the caller's floor, capsule, visibility and
 * walking-path probes. Rotation changes the distribution without using RNG.
 */
export function defenseSupplyCandidates({ arena, playerFoot, wave } = {}) {
  const location = arenaDefinition(arena);
  waveNumber(wave);
  if (!playerFoot || !['x', 'y', 'z'].every(axis => Number.isFinite(playerFoot[axis]))) return EMPTY;
  const rotation = ((wave - 1) * 0.61803398875 % 1) * Math.PI * 2;
  const candidates = [];
  for (const radius of [2, 3.25, 4.5]) {
    for (let index = 0; index < 12; index++) {
      const angle = rotation + index * Math.PI / 6;
      const point = {
        x: playerFoot.x + Math.cos(angle) * radius,
        y: location.floorY,
        z: playerFoot.z + Math.sin(angle) * radius,
      };
      if (!isInsideDefenseArena(arena, point, { margin: 0.6 })) continue;
      if (arena === 'roof' && insideRectangle(point, ROOF.serviceHouse, -0.6)) continue;
      candidates.push(Object.freeze(point));
    }
  }
  return Object.freeze(candidates);
}
