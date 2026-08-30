/** Rage uses gameplay seconds, so pausing never ages kills or spends the boost. */
export const RAGE_CONFIG = Object.freeze({
  healthThreshold: 0.30,
  minimumKills: 4,
  killWindowSeconds: 60,
  durationSeconds: 10,
  healthMultiplier: 2,
});

const TIME_EPSILON = 1e-9;

/** Pure simulation state. The player argument only needs a numeric health field. */
export function createRageState(options = {}) {
  const config = Object.freeze({ ...RAGE_CONFIG, ...options });
  if (!(Number.isFinite(config.healthThreshold) && config.healthThreshold > 0 && config.healthThreshold <= 1)
    || !Number.isInteger(config.minimumKills) || config.minimumKills < 1
    || !Number.isFinite(config.killWindowSeconds) || config.killWindowSeconds <= 0
    || !Number.isFinite(config.durationSeconds) || config.durationSeconds <= 0
    || !Number.isFinite(config.healthMultiplier) || config.healthMultiplier <= 1) {
    throw new RangeError('Invalid rage configuration');
  }

  let elapsed = 0;
  const kills = [];
  let active = false, expiresAt = 0, startingHealth = 0, outcome = null;

  function pruneKills() {
    while (kills.length && elapsed - kills[0] + TIME_EPSILON >= config.killWindowSeconds) kills.shift();
  }

  function available(player, maxHealth = 100) {
    return !active && Number.isFinite(player.health) && player.health > 0
      && Number.isFinite(maxHealth) && maxHealth > 0
      && player.health < maxHealth * config.healthThreshold && kills.length >= config.minimumKills;
  }

  return {
    config,
    available,
    enter(player, maxHealth = 100) {
      if (!available(player, maxHealth)) return false;
      startingHealth = player.health;
      player.health = Math.min(maxHealth, startingHealth * config.healthMultiplier);
      active = true;
      expiresAt = elapsed + config.durationSeconds;
      outcome = null;
      return true;
    },
    // Only credited player kills call this, never despawns or checkpoint cleanup.
    recordKill() {
      kills.push(elapsed);
      if (active && elapsed + TIME_EPSILON < expiresAt) {
        active = false;
        outcome = 'secured';
      }
    },
    update(dt, player) {
      if (!Number.isFinite(player.health) || player.health <= 0) {
        this.reset();
        return;
      }
      if (!Number.isFinite(dt) || dt <= 0) return;
      elapsed += dt;
      pruneKills();
      if (active && elapsed + TIME_EPSILON >= expiresAt) {
        // The failed wager returns to its original HP, including after damage
        // or healing. A dead player is reset above and can never be resurrected.
        player.health = startingHealth;
        active = false;
        outcome = 'expired';
      }
    },
    takeOutcome() {
      const value = outcome;
      outcome = null;
      return value;
    },
    snapshot(player, maxHealth = 100) {
      return { available: available(player, maxHealth), active,
        remaining: active ? Math.max(0, expiresAt - elapsed) : 0, recentKills: kills.length };
    },
    reset() {
      elapsed = expiresAt = startingHealth = 0;
      kills.length = 0;
      active = false;
      outcome = null;
    },
  };
}

export const Rage = createRageState();
