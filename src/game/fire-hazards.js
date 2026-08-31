import { isSegmentOccluded } from './combat-rules.js';

export const FIRE_DAMAGE_PER_SECOND = 20;
export const FIRE_FEEDBACK_INTERVAL = 0.25;
export const FIRE_CONTACT_SKIN = 0.02;
const EPSILON = 1e-9;
const AXES = ['x', 'y', 'z'];
const finitePoint = point => point && AXES.every(axis => Number.isFinite(point[axis]));
const validBounds = box => finitePoint(box?.min) && finitePoint(box?.max)
  && AXES.every(axis => box.min[axis] <= box.max[axis]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Direct capsule contact, driven only by accepted simulation time. Damage is
 * exact per step; feedback is immediate on entry and throttled while touching.
 * applyDamage(amount, source, { feedback }) consumes pooled arguments during
 * the call. The caller owns health/armor policy, death and presentation.
 */
export function createFireHazards({
  player, fires = [], canDamage = () => true, applyDamage,
  colliders = [], isColliderEnabled = null,
  damagePerSecond = FIRE_DAMAGE_PER_SECOND,
  feedbackInterval = FIRE_FEEDBACK_INTERVAL,
  contactSkin = FIRE_CONTACT_SKIN,
} = {}) {
  const rate = Number.isFinite(damagePerSecond) && damagePerSecond >= 0 ? damagePerSecond : FIRE_DAMAGE_PER_SECOND;
  const interval = Number.isFinite(feedbackInterval) && feedbackInterval > 0 ? feedbackInterval : FIRE_FEEDBACK_INTERVAL;
  const margin = Number.isFinite(contactSkin) && contactSkin >= 0 ? contactSkin : FIRE_CONTACT_SKIN;
  const fireColliders = new Set(), occluders = [];
  const source = { x: 0, y: 0, z: 0 }, capsulePoint = { x: 0, y: 0, z: 0 };
  const damageOptions = { feedback: false };
  let touching = false, feedbackRemaining = 0;
  let contactSeconds = 0, damageRequested = 0, feedbackCount = 0;

  function clearContact() {
    touching = false;
    feedbackRemaining = 0;
  }
  function reset() {
    clearContact();
    contactSeconds = 0; damageRequested = 0; feedbackCount = 0;
    fireColliders.clear(); occluders.length = 0;
  }
  function collectOccluders() {
    fireColliders.clear(); occluders.length = 0;
    // Fire collision boxes stop movement but do not shield another flame in
    // an overlapping patch. Keep actual walls, floors, debris and car bodies.
    for (const fire of fires) if (fire?.collider) fireColliders.add(fire.collider);
    for (const box of colliders) {
      if (fireColliders.has(box) || !validBounds(box)) continue;
      if (typeof isColliderEnabled === 'function' && !isColliderEnabled(box)) continue;
      occluders.push(box);
    }
  }
  function update(dt) {
    if (!Number.isFinite(dt) || dt <= 0 || !canDamage()) return 0;
    if (!Number.isFinite(player?.health) || player.health <= 0 || typeof applyDamage !== 'function'
      || !finitePoint(player?.pos) || !Number.isFinite(player._eyeH) || player._eyeH < 0
      || !Number.isFinite(player.radius) || player.radius <= 0
      || !Number.isFinite(player._bodyH) || player._bodyH < player.radius * 2) {
      clearContact();
      return 0;
    }
    const feet = player.pos.y - player._eyeH;
    const low = feet + player.radius, high = feet + player._bodyH - player.radius;
    const reachSquared = (player.radius + margin) ** 2;
    let contact = false, occludersReady = false;
    for (const fire of fires) {
      const bounds = fire?.damageBounds;
      if (fire?.active !== true || !validBounds(bounds)) continue;
      const dx = player.pos.x - clamp(player.pos.x, bounds.min.x, bounds.max.x);
      const dz = player.pos.z - clamp(player.pos.z, bounds.min.z, bounds.max.z);
      const dy = Math.max(bounds.min.y - high, low - bounds.max.y, 0);
      // Keep the original capsule segment. Inflating its radius alone covers
      // the small heat/contact margin without shrinking or lifting its caps.
      if (dx * dx + dy * dy + dz * dz > reachSquared + EPSILON) continue;
      const authoredSource = finitePoint(fire.damageSource) ? fire.damageSource : null;
      for (const axis of AXES) source[axis] = authoredSource
        ? authoredSource[axis] : (bounds.min[axis] + bounds.max[axis]) / 2;
      capsulePoint.x = player.pos.x; capsulePoint.y = clamp(source.y, low, high); capsulePoint.z = player.pos.z;
      if (colliders.length) {
        if (!occludersReady) { collectOccluders(); occludersReady = true; }
        // A visual flame center, rather than an engine/ground origin, keeps
        // real cover protective without letting the fire's own support hide it.
        if (isSegmentOccluded(capsulePoint, source, occluders)) continue;
      }
      contact = true;
      break;
    }
    if (!contact) { clearContact(); return 0; }
    const amount = Math.min(player.health, rate * dt);
    if (!(amount > 0)) return 0;
    damageOptions.feedback = !touching;
    if (!touching) feedbackRemaining = interval;
    else {
      feedbackRemaining -= dt;
      if (feedbackRemaining <= EPSILON) {
        damageOptions.feedback = true;
        // Large accepted steps still request one feedback event, not a burst
        // of missed flashes or a delayed burn after the player leaves.
        feedbackRemaining = interval - (Math.max(0, -feedbackRemaining) % interval);
      }
    }
    touching = true;
    contactSeconds += dt;
    damageRequested += amount;
    if (damageOptions.feedback) feedbackCount++;
    applyDamage(amount, source, damageOptions);
    return amount;
  }
  function snapshot() {
    return { touching, contactSeconds, damageRequested, feedbackCount };
  }
  return Object.freeze({ update, reset, snapshot });
}
