export function createCombatStats() {
  return {
    kills: 0, shots: 0, hits: 0, headshots: 0, streak: 0, streakRemaining: 0,
    recordShot(hit) { this.shots++; if (hit) this.hits++; },
    recordKill(headshot = false) {
      this.kills++; this.streak++; this.streakRemaining = 5;
      if (headshot) this.headshots++;
    },
    update(dt) {
      this.streakRemaining = Math.max(0, this.streakRemaining - Math.max(0, dt));
      if (!this.streakRemaining) this.streak = 0;
    },
    snapshot() {
      return { kills: this.kills, shots: this.shots, hits: this.hits, headshots: this.headshots,
        streak: this.streak, accuracy: this.shots ? Math.round(this.hits / this.shots * 100) : 0 };
    },
    reset() { this.kills = this.shots = this.hits = this.headshots = this.streak = this.streakRemaining = 0; },
  };
}

export const CombatStats = createCombatStats();
