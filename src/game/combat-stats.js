import { Rage } from './rage-rules.js';
import { WEAPON_DEFS } from './weapon-data.js';

const weaponTypes = Object.keys(WEAPON_DEFS);
const nonnegative = value => Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value)) : 0;
const count = value => Math.floor(nonnegative(value));
const accuracy = (hits, attacks) => attacks ? Math.min(100, Math.round(hits / attacks * 100)) : 0;
const emptyWeaponStats = () => ({ attacks: 0, shots: 0, hits: 0, kills: 0, headshots: 0, damageDealt: 0 });

export function createCombatStats({ rage = null } = {}) {
  const weapons = Object.fromEntries(weaponTypes.map(type => [type, emptyWeaponStats()]));

  function recordAttack(stats, hit, type, damage, ranged) {
    const dealt = hit ? nonnegative(damage) : 0;
    stats.attacks++;
    if (hit) stats.attackHits++;
    stats.damageDealt += dealt;
    if (!Object.hasOwn(weapons, type)) return;
    const weapon = weapons[type];
    weapon.attacks++;
    if (ranged) weapon.shots++;
    if (hit) weapon.hits++;
    weapon.damageDealt += dealt;
  }

  return {
    kills: 0, shots: 0, hits: 0, headshots: 0, streak: 0, bestStreak: 0, streakRemaining: 0,
    attacks: 0, attackHits: 0, damageDealt: 0,
    // One record per trigger pull, after all pellets have resolved. Aggregate
    // shots/hits retain their firearm-only meaning for the HUD and QA tools.
    recordShot(hit, type = null, damage = 0) {
      this.shots++;
      if (hit) this.hits++;
      recordAttack(this, hit, type, damage, true);
    },
    // A completed contact query counts a swing whether it hits or misses;
    // windups canceled by death, reload or equipment changes never resolve.
    recordMelee(hit, type = 'fists', damage = 0) {
      recordAttack(this, hit, type, damage, false);
    },
    recordKill(headshot = false, type = null) {
      this.kills++; this.streak++; this.streakRemaining = 5;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      if (headshot) this.headshots++;
      if (Object.hasOwn(weapons, type)) {
        weapons[type].kills++;
        if (headshot) weapons[type].headshots++;
      }
      rage?.recordKill();
    },
    update(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return;
      this.streakRemaining = Math.max(0, this.streakRemaining - Math.max(0, dt));
      if (!this.streakRemaining) this.streak = 0;
    },
    snapshot() {
      const rows = weaponTypes.map(type => ({
        type, name: WEAPON_DEFS[type].name, kind: WEAPON_DEFS[type].kind,
        ...weapons[type], accuracy: accuracy(weapons[type].hits, weapons[type].attacks),
      }));
      // Favorite means most attacks. Kill count breaks ties, followed by the
      // stable weapon-data order, so the result cannot flicker between rows.
      const favorite = rows.reduce((best, row) => row.attacks > 0
        && (!best || row.attacks > best.attacks || (row.attacks === best.attacks && row.kills > best.kills)) ? row : best, null);
      return { kills: this.kills, shots: this.shots, hits: this.hits, headshots: this.headshots,
        streak: this.streak, bestStreak: this.bestStreak, accuracy: accuracy(this.hits, this.shots), attacks: this.attacks,
        attackHits: this.attackHits, damageDealt: this.damageDealt,
        favoriteWeapon: favorite?.type ?? null, favoriteWeaponName: favorite?.name ?? null, weapons: rows };
    },
    restore(snapshot) {
      this.reset();
      if (!snapshot || typeof snapshot !== 'object') return;
      this.kills = count(snapshot.kills);
      this.shots = count(snapshot.shots);
      this.hits = Math.min(this.shots, count(snapshot.hits));
      this.headshots = Math.min(this.kills, count(snapshot.headshots));
      this.bestStreak = Math.min(this.kills, Math.max(count(snapshot.bestStreak), count(snapshot.streak)));
      this.attacks = Math.max(this.shots, count(snapshot.attacks));
      this.attackHits = Math.min(this.attacks, Math.max(this.hits, count(snapshot.attackHits)));
      this.damageDealt = nonnegative(snapshot.damageDealt);
      for (const row of Array.isArray(snapshot.weapons) ? snapshot.weapons : []) {
        if (!row || !Object.hasOwn(weapons, row.type)) continue;
        const weapon = weapons[row.type];
        weapon.attacks = count(row.attacks);
        weapon.shots = WEAPON_DEFS[row.type].kind === 'ranged' ? weapon.attacks : 0;
        weapon.hits = Math.min(weapon.attacks, count(row.hits));
        weapon.kills = count(row.kills);
        weapon.headshots = Math.min(weapon.kills, count(row.headshots));
        weapon.damageDealt = nonnegative(row.damageDealt);
      }
      // A checkpoint restores credited results, never a previous life's
      // active kill streak or pending rage health wager.
    },
    reset() {
      this.kills = this.shots = this.hits = this.headshots = this.streak = this.bestStreak = this.streakRemaining = 0;
      this.attacks = this.attackHits = this.damageDealt = 0;
      for (const type of weaponTypes) Object.assign(weapons[type], emptyWeaponStats());
      rage?.reset();
    },
  };
}

export const CombatStats = createCombatStats({ rage: Rage });
