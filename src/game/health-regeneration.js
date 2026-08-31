/** Recovery advances only on the shared gameplay clock. Damage restarts the delay. */
export function createHealthRegeneration() {
  let quietTime = 0;
  return {
    reset() { quietTime = 0; },
    damaged() { quietTime = 0; },
    update(dt, player, profile) {
      if (!Number.isFinite(dt) || dt <= 0 || !player || player.health <= 0) return 0;
      const before = quietTime;
      quietTime += dt;
      if (!(profile?.regen > 0) || player.health >= 100) return 0;
      const delay = Math.max(0, profile.regenDelay || 0);
      const healingTime = Math.max(0, quietTime - Math.max(before, delay));
      const gained = Math.min(100 - player.health, profile.regen * healingTime);
      player.health += gained;
      return gained;
    },
    snapshot() { return { quietTime }; },
  };
}

export const HealthRegeneration = createHealthRegeneration();
