import { WEAPON_DEFS } from './weapon-data.js';
import { BALCONY, OPENINGS, ROOF } from '../world/layout.js';

// One shared budget follows a cache across weapon swaps. Integer units avoid
// rounding a partial refill into a fresh magazine for a different weapon.
export const AMMO_SUPPLY_UNITS = 120;
export const AMMO_SUPPLY_LOADS = Object.freeze({ pistol: 24, shotgun: 6, smg: 30, machinegun: 40 });
export const AMMO_RESERVE_LIMITS = Object.freeze({ pistol: 48, shotgun: 18, smg: 90, machinegun: 120 });
export const AMMO_SUPPLY_COSTS = Object.freeze(Object.fromEntries(
  Object.entries(AMMO_SUPPLY_LOADS).map(([type, rounds]) => [type, AMMO_SUPPLY_UNITS / rounds]),
));

export const AMMO_SUPPLY_CACHES = Object.freeze([
  Object.freeze({
    id: 'balcony-reserve', zone: 'balcony',
    visibleZones: Object.freeze(['balcony', 'stairwell']),
    position: Object.freeze({
      x: OPENINGS.balconyStair.max[0] + 0.9,
      y: BALCONY.floorY,
      z: BALCONY.wrap.z1 + 0.25,
    }),
    approach: Object.freeze({ x: OPENINGS.balconyStair.max[0] + 0.9, y: BALCONY.floorY, z: BALCONY.laneZ }),
    floorY: BALCONY.floorY,
    width: 0.64, height: 0.34, depth: 0.28,
    support: 'balcony-wrap-deck',
    units: AMMO_SUPPLY_UNITS,
  }),
  Object.freeze({
    id: 'roof-west-reserve', zone: 'roof', visibleZones: Object.freeze(['roof']),
    position: Object.freeze({ x: ROOF.serviceHouse.x1 + 0.5, y: ROOF.floorY, z: ROOF.serviceHouse.z2 + 1.2 }),
    approach: Object.freeze({ x: ROOF.serviceHouse.x1 - 0.45, y: ROOF.floorY, z: ROOF.serviceHouse.z2 + 1.2 }),
    floorY: ROOF.floorY,
    width: 0.64, height: 0.34, depth: 0.28,
    support: 'roof-deck',
    units: AMMO_SUPPLY_UNITS,
  }),
  Object.freeze({
    id: 'roof-east-reserve', zone: 'roof', visibleZones: Object.freeze(['roof']),
    position: Object.freeze({ x: ROOF.x2 - 1.55, y: ROOF.floorY, z: ROOF.serviceHouse.z2 + 3 }),
    approach: Object.freeze({ x: ROOF.x2 - 1.55, y: ROOF.floorY, z: ROOF.serviceHouse.z2 + 4 }),
    floorY: ROOF.floorY,
    width: 0.64, height: 0.34, depth: 0.28,
    support: 'roof-annex-east-deck',
    units: AMMO_SUPPLY_UNITS,
  }),
]);

/** Reserve only: an existing full magazine or richer looted reserve is intact. */
export function ammoSupplyAmount(weapon, remainingUnits) {
  if (!weapon || WEAPON_DEFS[weapon.current]?.kind !== 'ranged') return 0;
  const cost = AMMO_SUPPLY_COSTS[weapon.current], cap = AMMO_RESERVE_LIMITS[weapon.current];
  if (!cost || !Number.isSafeInteger(remainingUnits) || remainingUnits <= 0) return 0;
  if (!Number.isSafeInteger(weapon.reserve) || weapon.reserve < 0 || weapon.reserve >= cap) return 0;
  return Math.min(Math.floor(remainingUnits / cost), cap - weapon.reserve);
}

/** Stateful inventory only; no clock, renderer, input, weapon mutation or audio. */
export class AmmoSupplyLedger {
  constructor(caches = AMMO_SUPPLY_CACHES) {
    this.baseCapacities = new Map(caches.map(cache => [cache.id, cache.units]));
    if (this.baseCapacities.size !== caches.length || caches.some(cache => !cache.id || !Number.isSafeInteger(cache.units) || cache.units < 0)) {
      throw new RangeError('Ammo supplies require unique ids and finite integer budgets');
    }
    this.remaining = new Map();
    this.reset();
  }

  reset(ammoMultiplier = 1) {
    if (!Number.isFinite(ammoMultiplier) || ammoMultiplier < 0) throw new RangeError('Ammo supply multiplier must be finite and nonnegative');
    const capacities = new Map([...this.baseCapacities].map(([id, units]) => [id, Math.round(units * ammoMultiplier)]));
    if ([...capacities.values()].some(units => !Number.isSafeInteger(units))) throw new RangeError('Ammo supply budgets must remain finite integers');
    this.capacities = capacities;
    this.remaining = new Map(capacities);
  }
  capacity(id) { return this.capacities.get(id) ?? 0; }
  units(id) { return this.remaining.get(id) ?? 0; }
  available(id, weapon) { return ammoSupplyAmount(weapon, this.units(id)); }

  /** Charge only rounds accepted by the held weapon; a failed pickup is inert. */
  take(id, weapon, acceptReserve, { active = false, dead = false } = {}) {
    if (!active || dead || typeof acceptReserve !== 'function') return 0;
    const amount = this.available(id, weapon);
    if (!amount) return 0;
    // Capture the type before the callback; even a caller changing its weapon
    // object cannot make this transaction charge another ammunition budget.
    const type = weapon.current;
    const accepted = acceptReserve(amount, AMMO_RESERVE_LIMITS[type]);
    if (!Number.isSafeInteger(accepted) || accepted <= 0 || accepted > amount) return 0;
    this.remaining.set(id, this.units(id) - accepted * AMMO_SUPPLY_COSTS[type]);
    return accepted;
  }

  snapshot() {
    return Object.freeze({
      version: 1,
      caches: Object.freeze([...this.remaining].map(([id, remainingUnits]) => Object.freeze({ id, remainingUnits }))),
    });
  }

  /** Invalid or incomplete saves fail atomically instead of refilling a cache. */
  restore(snapshot) {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.caches) || snapshot.caches.length !== this.capacities.size) return false;
    const restored = new Map();
    for (const entry of snapshot.caches) {
      const capacity = this.capacities.get(entry?.id);
      if (capacity === undefined || restored.has(entry.id) || !Number.isSafeInteger(entry.remainingUnits)
        || entry.remainingUnits < 0 || entry.remainingUnits > capacity) return false;
      restored.set(entry.id, entry.remainingUnits);
    }
    this.remaining = restored;
    return true;
  }
}
