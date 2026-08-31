import { WEAPON_DEFS } from './weapon-data.js';

/** Finite enemy rewards, with the first copy of each weapon always available. */
export class DifficultyLootLedger {
  constructor() { this.reset(); }
  reset() { this.deaths = new Map(); }

  drop(type, baseAmmo, profile) {
    if (!Object.hasOwn(WEAPON_DEFS, type) || type === 'fists') return null;
    const deaths = (this.deaths.get(type) ?? 0) + 1;
    this.deaths.set(type, deaths);
    // Deterministic spacing avoids unlucky runs removing an entire weapon
    // tier. Only duplicate weapons become scarce on harder difficulties.
    const rate = profile.weaponDrop;
    const shouldDrop = deaths === 1 || Math.floor((deaths - 1) * rate) > Math.floor((deaths - 2) * rate);
    if (!shouldDrop) return null;
    const ammo = Number.isFinite(baseAmmo) && baseAmmo > 0 ? Math.max(1, Math.round(baseAmmo * profile.ammo)) : 0;
    return { type, ammo };
  }

  snapshot() {
    return Object.freeze({
      version: 1,
      weapons: Object.freeze([...this.deaths].map(([type, deaths]) => Object.freeze({ type, deaths }))),
    });
  }

  /** A checkpoint rolls back both the first-drop guarantee and its cadence. */
  restore(snapshot) {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.weapons)) return false;
    const deaths = new Map();
    for (const entry of snapshot.weapons) {
      if (!entry || !Object.hasOwn(WEAPON_DEFS, entry.type) || entry.type === 'fists' || deaths.has(entry.type)
        || !Number.isSafeInteger(entry.deaths) || entry.deaths <= 0) return false;
      deaths.set(entry.type, entry.deaths);
    }
    this.deaths = deaths;
    return true;
  }
}
