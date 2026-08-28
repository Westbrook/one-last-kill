import { WEAPON_DEFS } from './weapon-data.js';

export const REAR_SPAWN_GRACE_SECONDS = 1;
export const REAR_FALLBACK_AFTER_SECONDS = 1.5;
const EPSILON = 1e-8;
const hasHorizontalPosition = point => Number.isFinite(point?.x) && Number.isFinite(point?.z);

/** Rear contacts never carry guns; fists are the weakest available tie. */
export function rearEnemyType(playerWeapon, preferredType = 'thug') {
  const hasFirearm = typeof playerWeapon === 'string' && Object.hasOwn(WEAPON_DEFS, playerWeapon)
    && WEAPON_DEFS[playerWeapon].kind === 'ranged';
  return hasFirearm && preferredType !== 'brawler' ? 'thug' : 'brawler';
}

/**
 * Horizontal geometry only. Floor support, capsule clearance, visibility and
 * occupancy remain mandatory caller checks, including on a forward fallback.
 * Player yaw uses the game's forward vector (-sin(yaw), -cos(yaw)).
 */
export function isBehindPlayer(playerFoot, yaw, candidate, { minDistance = 5, minRearDot = 0.25 } = {}) {
  if (!hasHorizontalPosition(playerFoot) || !hasHorizontalPosition(candidate) || !Number.isFinite(yaw)) return false;
  if (!Number.isFinite(minDistance) || minDistance < 0 || !Number.isFinite(minRearDot) || minRearDot < 0 || minRearDot > 1) return false;
  const dx = candidate.x - playerFoot.x, dz = candidate.z - playerFoot.z;
  const distance = Math.hypot(dx, dz);
  if (!Number.isFinite(distance) || distance <= EPSILON || distance + EPSILON < minDistance) return false;
  const rearDot = dx / distance * Math.sin(yaw) + dz / distance * Math.cos(yaw);
  return rearDot + EPSILON >= minRearDot;
}

/**
 * Use the original composition index, retained on a pending entry. Removing or
 * retrying another pending entry must not change who owns the single rear role.
 */
export function encounterSpawnRole(entryIndex, waveSize = 2) {
  return waveSize === 2 && Number.isInteger(entryIndex) && entryIndex === 1 ? 'rear' : 'front';
}

const BLOCKED_POLICY = Object.freeze({ tryRear: false, allowForwardFallback: false, spawnGraceSeconds: 1 });
const REAR_POLICY = Object.freeze({ tryRear: true, allowForwardFallback: false, spawnGraceSeconds: 1 });
const FALLBACK_POLICY = Object.freeze({ tryRear: true, allowForwardFallback: true, spawnGraceSeconds: 1 });

/**
 * Wait time is eligible simulation time, never wall time or time since a failed
 * individual attempt. A fallback still requires a safe, non-visible position.
 * Attack grace starts on successful spawn and cannot be configured below 1 s.
 */
export function rearSpawnPolicy(waitedSeconds, {
  fallbackAfter = REAR_FALLBACK_AFTER_SECONDS, spawnGrace = REAR_SPAWN_GRACE_SECONDS,
} = {}) {
  const grace = Number.isFinite(spawnGrace) ? Math.max(REAR_SPAWN_GRACE_SECONDS, spawnGrace) : REAR_SPAWN_GRACE_SECONDS;
  const valid = Number.isFinite(waitedSeconds) && waitedSeconds >= 0 && Number.isFinite(fallbackAfter) && fallbackAfter >= 0;
  const allowForwardFallback = valid && waitedSeconds + EPSILON >= fallbackAfter;
  if (grace === REAR_SPAWN_GRACE_SECONDS) return !valid ? BLOCKED_POLICY : allowForwardFallback ? FALLBACK_POLICY : REAR_POLICY;
  return Object.freeze({ tryRear: valid, allowForwardFallback, spawnGraceSeconds: grace });
}

/**
 * Two contacts on the same side of the player need both physical lateral room
 * and an angular gap. Checking the nearer depth makes the result symmetric:
 * swapping which contact spawned first cannot allow two aligned head bearings.
 */
export function hasPairBearingSeparation(playerFoot, candidate, other, {
  minPerp = 0.4, minAngle = 0.04, allowOpposite = true,
} = {}) {
  if (!hasHorizontalPosition(playerFoot) || !hasHorizontalPosition(candidate) || !hasHorizontalPosition(other)) return false;
  if (!Number.isFinite(minPerp) || minPerp < 0 || !Number.isFinite(minAngle) || minAngle < 0 || minAngle > Math.PI) return false;
  const ax = candidate.x - playerFoot.x, az = candidate.z - playerFoot.z;
  const bx = other.x - playerFoot.x, bz = other.z - playerFoot.z;
  const aLength = Math.hypot(ax, az), bLength = Math.hypot(bx, bz);
  if (!Number.isFinite(aLength) || !Number.isFinite(bLength) || aLength <= EPSILON || bLength <= EPSILON) return false;
  const aUnitX = ax / aLength, aUnitZ = az / aLength, bUnitX = bx / bLength, bUnitZ = bz / bLength;
  const dot = Math.max(-1, Math.min(1, aUnitX * bUnitX + aUnitZ * bUnitZ));
  const cross = Math.abs(aUnitX * bUnitZ - aUnitZ * bUnitX);
  if (allowOpposite && dot < 0) return true;
  const angle = Math.atan2(cross, dot);
  const lateral = Math.min(aLength, bLength) * cross;
  return lateral + EPSILON >= minPerp && angle + EPSILON >= minAngle;
}

/** Living contacts from other waves or encounters do not own this pair's lane. */
export function hasSameWaveSeparation(playerFoot, candidate, enemies, waveIndex, options = {}) {
  if (!hasHorizontalPosition(playerFoot) || !hasHorizontalPosition(candidate) || !Array.isArray(enemies)
    || !Number.isInteger(waveIndex) || waveIndex < 0) return false;
  for (const enemy of enemies) {
    if (!enemy?.alive || enemy.removed || enemy.encounterWave !== waveIndex) continue;
    if (options.encounterKey !== undefined && enemy.encounterKey !== options.encounterKey) continue;
    if (!hasPairBearingSeparation(playerFoot, candidate, enemy.pos, options)) return false;
  }
  return true;
}
