import { encounterSpawnCandidates, routeDistanceAt } from './encounter-rules.js';
import { selectSafeSpawn } from './mission-data.js';
import { WEAPON_DEFS } from './weapon-data.js';
import { describeOffscreenThreat } from './offscreen-threats.js';
import { encounterSpawnRole, hasSameWaveSeparation, isBehindPlayer, rearEnemyType, rearSpawnPolicy } from './rear-encounter-rules.js';
import { variedSpawnCandidates } from './encounter-variation.js';

/** An empty firearm cannot justify a stronger rear attacker. */
export function effectiveRearWeapon(weapon) {
  const type = weapon?.current;
  if (typeof type !== 'string' || !Object.hasOwn(WEAPON_DEFS, type)) return 'fists';
  if (WEAPON_DEFS[type].kind !== 'ranged') return type;
  const usable = [weapon.loaded, weapon.reserve].some(amount => Number.isFinite(amount) && amount > 0);
  return usable ? type : 'fists';
}

/** Rear anchors are on traversed balcony ground or this flight's lower landing. */
export function rearSpawnCandidates(config, waveIndex, foot) {
  const stage = config.stages?.[waveIndex];
  if (!config.rearPressure || !stage || !Number.isFinite(foot?.y)
    || (stage.minFootY !== undefined && foot.y < stage.minFootY)
    || (stage.departAbove !== undefined && foot.y > stage.departAbove)) return [];
  const candidates = stage.rearSpawnIndices
    ? stage.rearSpawnIndices.map(index => config.rearSpawns[index]).filter(Boolean)
    : config.spawns;
  if (!config.route) return candidates;
  const current = routeDistanceAt(config.route, foot);
  if (current === null) return [];
  return candidates.filter(point => {
    const distance = routeDistanceAt(config.route, point);
    return distance !== null && distance < current - (config.forwardSpawnMargin ?? 0.25);
  });
}

/**
 * Placement and loadout are selected together. Every branch, including a
 * delayed forward fallback, goes through the same floor/capsule/crowd checks.
 * The caller commits the result only after acquiring an actual enemy rig.
 */
function placementContext({
  config, waveIndex, entryIndex = 0, waitedSeconds = 0, type,
  playerFoot, yaw, view, weapon, enemies = [], encounterKey,
  routeProgress = 0, startIndex = 0, variation = null, floorAt, blocked, occluded = () => false,
}) {
  if (!config || !Number.isInteger(waveIndex) || waveIndex < 0 || waveIndex >= config.waveCount) return null;
  if (!playerFoot || !['x', 'y', 'z'].every(axis => Number.isFinite(playerFoot[axis]))) return null;
  const pressure = config.rearPressure;
  const role = pressure ? encounterSpawnRole(entryIndex, config.waves[waveIndex].length, config.rearEntryIndices) : 'front';
  const policy = rearSpawnPolicy(waitedSeconds, { fallbackAfter: pressure?.fallbackAfter });
  const progress = Math.max(routeProgress, routeDistanceAt(config.route, playerFoot) ?? 0);
  const isRear = point => pressure && isBehindPlayer(playerFoot, yaw, point, { minDistance: 0, minRearDot: 0 });
  const concealment = point => {
    const source = { pos: point, radius: 0.48, height: 2.02 };
    const projection = describeOffscreenThreat(view, source);
    return projection === null ? null : !projection.visible || occluded(source);
  };
  function forwardCandidates(slot = entryIndex) {
    const authored = encounterSpawnCandidates(config, waveIndex, progress, playerFoot.y);
    const address = { waveIndex, entryIndex: slot, channel: 'forward' };
    const preferred = config.stages?.[waveIndex]?.preferredSpawnIndices;
    let candidates;
    if (variation?.enabled && preferred?.length) {
      // The opening's exposed pair takes priority over partly hidden corner
      // pockets. Randomize within each tier without sacrificing that framing.
      const firstTier = new Set(preferred.map(index => config.spawns[index]));
      candidates = [
        ...variedSpawnCandidates(authored.filter(point => firstTier.has(point)), variation, address),
        ...variedSpawnCandidates(authored.filter(point => !firstTier.has(point)), variation, address),
      ];
    } else candidates = variedSpawnCandidates(authored, variation, address);
    if (!variation?.enabled || !config.route) return candidates;
    // An offset must not move an otherwise eligible anchor behind the retained
    // route progress. The original point remains available if the offset fails.
    return candidates.filter(point => {
      const distance = routeDistanceAt(config.route, point);
      return distance !== null && distance > progress + (config.forwardSpawnMargin ?? 0.25);
    });
  }
  function rearCandidates() {
    const candidates = variedSpawnCandidates(rearSpawnCandidates(config, waveIndex, playerFoot), variation,
      { waveIndex, entryIndex, channel: 'rear' });
    const current = routeDistanceAt(config.route, playerFoot);
    return candidates.filter(candidate => {
      if (!isBehindPlayer(playerFoot, yaw, candidate)
        || Math.hypot(candidate.x - playerFoot.x, candidate.z - playerFoot.z) > pressure.maxDistance) return false;
      if (!config.route) return true;
      const distance = routeDistanceAt(config.route, candidate);
      return current !== null && distance !== null && distance < current - (config.forwardSpawnMargin ?? 0.25);
    });
  }
  function choose(candidates, { mustHide = false, frontOnly = false, visibleOnly = false, occupants = enemies } = {}) {
    return selectSafeSpawn(candidates, {
      playerFoot, enemies: occupants, startIndex: variation?.enabled ? 0 : startIndex, floorAt,
      maxHeightDifference: config.maxHeightDifference,
      blocked(point) {
        if (blocked(point)) return true;
        if (frontOnly && (!Number.isFinite(yaw)
          || isBehindPlayer(playerFoot, yaw, point, { minDistance: 0, minRearDot: 0 }))) return true;
        if ((mustHide || isRear(point)) && concealment(point) !== true) return true;
        if (visibleOnly && concealment(point) !== false) return true;
        return (frontOnly || pressure?.stagger)
          && !hasSameWaveSeparation(playerFoot, point, occupants, waveIndex, { encounterKey });
      },
    });
  }
  return { config, waveIndex, type, role, policy, progress, isRear, choose, forwardCandidates, rearCandidates,
    playerFoot, yaw, weapon, enemies, encounterKey };
}

export function selectEncounterSpawn(args) {
  const context = placementContext(args);
  if (!context) return null;
  const { type, role, policy, isRear, choose, forwardCandidates, rearCandidates, weapon } = context;
  let point = null;
  if (role === 'rear' && policy.tryRear) {
    point = choose(rearCandidates(), { mustHide: true });
  }
  const usedRearAnchor = Boolean(point);
  if (!point) {
    if (role === 'rear' && !policy.allowForwardFallback) return null;
    point = choose(forwardCandidates(), { mustHide: role === 'rear' });
  }
  if (!point) return null;
  // A player can turn around during any arrival. Classify the actual spawn,
  // not just its intended slot, before assigning its weapon and grace period.
  const rear = Boolean(isRear(point));
  return {
    point, rear, role, usedRearAnchor,
    type: rear ? rearEnemyType(effectiveRearWeapon(weapon), type) : type,
    graceSeconds: rear || role === 'rear' ? policy.spawnGraceSeconds : 0,
  };
}

/**
 * A forward pair is one placement decision. Backtracking the first candidate
 * avoids committing a singleton whose position leaves its partner no bearing.
 * This is still only a proposal: the caller must acquire both rigs atomically.
 */
export function selectEncounterFrontPair({ entries, ...args }) {
  const context = placementContext(args);
  if (!context || context.config.frontPairSize !== 2 || !Array.isArray(entries) || entries.length !== 2) return null;
  const { config, waveIndex, choose, forwardCandidates, enemies, encounterKey } = context;
  if (new Set(entries.map(entry => entry?.entryIndex)).size !== 2 || entries.some(entry =>
    entry?.waveIndex !== waveIndex || ![0, 1].includes(entry.entryIndex)
    || encounterSpawnRole(entry.entryIndex, config.waves[waveIndex].length, config.rearEntryIndices) !== 'front')) return null;
  const candidates = forwardCandidates(entries[0].entryIndex);
  const secondCandidates = forwardCandidates(entries[1].entryIndex);
  const startIndex = !args.variation?.enabled && Number.isInteger(args.startIndex) ? args.startIndex : 0;
  // Prefer two readable contacts in the current view. If the player has
  // already rounded a corner, a safe pair ahead may approach from cover.
  for (const visibleOnly of [true, false]) {
    for (let offset = 0; offset < candidates.length; offset++) {
      const index = ((startIndex + offset) % candidates.length + candidates.length) % candidates.length;
      const first = choose([candidates[index]], { frontOnly: true, visibleOnly });
      if (!first) continue;
      const proposedFirst = { alive: true, pos: first, encounterWave: waveIndex, encounterKey };
      const second = choose(secondCandidates, { frontOnly: true, visibleOnly, occupants: [...enemies, proposedFirst] });
      if (!second) continue;
      return [first, second].map((point, entryIndex) => ({
        point, type: entries[entryIndex].type, role: 'front', rear: false, usedRearAnchor: false, graceSeconds: 0,
      }));
    }
  }
  return null;
}
