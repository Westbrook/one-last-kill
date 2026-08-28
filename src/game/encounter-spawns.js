import { encounterSpawnCandidates, routeDistanceAt } from './encounter-rules.js';
import { selectSafeSpawn } from './mission-data.js';
import { WEAPON_DEFS } from './weapon-data.js';
import { describeOffscreenThreat } from './offscreen-threats.js';
import { encounterSpawnRole, hasSameWaveSeparation, isBehindPlayer, rearEnemyType, rearSpawnPolicy } from './rear-encounter-rules.js';

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
export function selectEncounterSpawn({
  config, waveIndex, entryIndex = 0, waitedSeconds = 0, type,
  playerFoot, yaw, view, weapon, enemies = [], encounterKey,
  routeProgress = 0, startIndex = 0, floorAt, blocked, occluded = () => false,
}) {
  if (!config || !Number.isInteger(waveIndex) || waveIndex < 0 || waveIndex >= config.waveCount) return null;
  if (!playerFoot || !['x', 'y', 'z'].every(axis => Number.isFinite(playerFoot[axis]))) return null;
  const pressure = config.rearPressure;
  const role = pressure ? encounterSpawnRole(entryIndex, config.waves[waveIndex].length) : 'front';
  const policy = rearSpawnPolicy(waitedSeconds, { fallbackAfter: pressure?.fallbackAfter });
  const progress = Math.max(routeProgress, routeDistanceAt(config.route, playerFoot) ?? 0);
  const isRear = point => pressure && isBehindPlayer(playerFoot, yaw, point, { minDistance: 0, minRearDot: 0 });
  const hidden = point => {
    const source = { pos: point, radius: 0.48, height: 2.02 };
    const projection = describeOffscreenThreat(view, source);
    return projection !== null && (!projection.visible || occluded(source));
  };
  function choose(candidates, mustHide) {
    return selectSafeSpawn(candidates, {
      playerFoot, enemies, startIndex, floorAt,
      maxHeightDifference: config.maxHeightDifference,
      blocked(point) {
        if (blocked(point)) return true;
        if ((mustHide || isRear(point)) && !hidden(point)) return true;
        return pressure?.stagger && !hasSameWaveSeparation(playerFoot, point, enemies, waveIndex, { encounterKey });
      },
    });
  }
  let point = null;
  if (role === 'rear' && policy.tryRear) {
    const candidates = rearSpawnCandidates(config, waveIndex, playerFoot).filter(candidate =>
      isBehindPlayer(playerFoot, yaw, candidate)
      && Math.hypot(candidate.x - playerFoot.x, candidate.z - playerFoot.z) <= pressure.maxDistance);
    point = choose(candidates, true);
  }
  const usedRearAnchor = Boolean(point);
  if (!point) {
    if (role === 'rear' && !policy.allowForwardFallback) return null;
    point = choose(encounterSpawnCandidates(config, waveIndex, progress, playerFoot.y), role === 'rear');
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
