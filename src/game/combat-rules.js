/** Combat rules without rendering, browser state, or wall-clock timers. */
export const DAMAGE_MULTIPLIERS = Object.freeze({ body: 1, head: 2.5, limb: 0.7 });
export const ENEMY_MEMORY_SECONDS = 4;
export const CORPSE_LIMIT = 6;
export const CORPSE_LIFETIME = 18;
const AXES = ['x', 'y', 'z'];

export function damageForHit(baseDamage, part = 'body') {
  if (!Number.isFinite(baseDamage) || baseDamage <= 0) return 0;
  const multiplier = Object.hasOwn(DAMAGE_MULTIPLIERS, part) ? DAMAGE_MULTIPLIERS[part] : DAMAGE_MULTIPLIERS.body;
  return baseDamage * multiplier;
}

/** A negative windup is inactive. A completed windup fires exactly once. */
export function advanceAttackWindup(attack, dt, interrupted = false) {
  if (interrupted) {
    attack.windupRemaining = -1;
    return false;
  }
  if (!(attack.windupRemaining >= 0) || !Number.isFinite(dt) || dt <= 0) return false;
  attack.windupRemaining -= dt;
  if (attack.windupRemaining > 1e-9) return false;
  attack.windupRemaining = -1;
  return true;
}

/** Remember observed positions, never the target's position through a wall. */
export function updateAwareness(memory, targetPosition, visible, dt, duration = ENEMY_MEMORY_SECONDS) {
  if (visible) {
    memory.lastSeenPosition.x = targetPosition.x;
    memory.lastSeenPosition.y = targetPosition.y;
    memory.lastSeenPosition.z = targetPosition.z;
    memory.lastSeenPlayer = true;
    memory.timeSinceSeen = 0;
    return 'visible';
  }
  if (!memory.lastSeenPlayer) return 'idle';
  memory.timeSinceSeen += Number.isFinite(dt) ? Math.max(0, dt) : 0;
  if (memory.timeSinceSeen >= duration) {
    memory.lastSeenPlayer = false;
    return 'idle';
  }
  return 'investigate';
}

export function canMeleeHit({ distance, heightDifference, facingDot, clear, range }) {
  return clear === true && Number.isFinite(range) && range >= 0 && Number.isFinite(distance) && distance >= 0 &&
    distance <= range + 0.2 && Math.abs(heightDifference) <= 0.9 && facingDot >= 0.25;
}

/** Slab intersection against the open segment; boxes may be THREE.Box3s. */
export function isSegmentOccluded(start, end, boxes) {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const length = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(length)) return true;
  if (length < 1e-6) return false;
  const endMargin = Math.min(0.01, 0.025 / length);
  for (const box of boxes) {
    let entry = 0, exit = 1;
    let intersects = true;
    for (const axis of AXES) {
      const delta = axis === 'x' ? dx : axis === 'y' ? dy : dz;
      if (Math.abs(delta) < 1e-9) {
        if (start[axis] < box.min[axis] || start[axis] > box.max[axis]) {
          intersects = false;
          break;
        }
      } else {
        let near = (box.min[axis] - start[axis]) / delta;
        let far = (box.max[axis] - start[axis]) / delta;
        if (near > far) { const swap = near; near = far; far = swap; }
        entry = Math.max(entry, near);
        exit = Math.min(exit, far);
        if (entry > exit) { intersects = false; break; }
      }
    }
    if (intersects && exit > endMargin && entry < 1 - endMargin) return true;
  }
  return false;
}

/** Returns an index, so callers can release pooled ownership before removal. */
export function oldestCorpseIndex(enemies, type = null) {
  let oldest = -1, age = -1;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (enemy.alive || enemy.removed || (type && enemy.type !== type)) continue;
    if (enemy.corpseTimer > age) { age = enemy.corpseTimer; oldest = i; }
  }
  return oldest;
}

/** Invalidated references cannot attack when a pooled rig is reused. */
export function invalidateEnemy(enemy) {
  enemy.alive = false;
  enemy.removed = true;
  enemy.state = 'removed';
  enemy.windupRemaining = -1;
  enemy.burstLeft = 0;
  enemy.swingTimer = 0;
  enemy.aimCommitted = false;
}
