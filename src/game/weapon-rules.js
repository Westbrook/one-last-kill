import { WEAPON_DEFS } from './weapon-data.js';

const whole = value => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export function reloadMagazine(loaded, reserve, capacity) {
  const magazine = Math.min(whole(loaded), whole(capacity));
  const spare = whole(reserve);
  const transfer = Math.min(whole(capacity) - magazine, spare);
  return { loaded: magazine + transfer, reserve: spare - transfer };
}

export function sanitizeWeaponSnapshot(snapshot = {}) {
  const current = Object.hasOwn(WEAPON_DEFS, snapshot.current) ? snapshot.current : 'fists';
  const definition = WEAPON_DEFS[current];
  return {
    current,
    loaded: definition.kind === 'ranged' ? Math.min(whole(snapshot.loaded), definition.mag) : 0,
    reserve: definition.kind === 'ranged' ? Math.min(whole(snapshot.reserve), 999) : 0,
  };
}

export function canPickupWeapon(current, drop) {
  if (!drop || !Object.hasOwn(WEAPON_DEFS, drop.weaponType) || drop.weaponType === 'fists') return false;
  const definition = WEAPON_DEFS[drop.weaponType];
  if (current !== drop.weaponType) return true;
  return definition.kind === 'ranged' && whole(drop.ammo) > 0;
}

export function weaponPickupPrompt(current, drop) {
  if (!canPickupWeapon(current, drop)) return null;
  const definition = WEAPON_DEFS[drop.weaponType];
  if (definition.kind === 'melee') return `[E] PICK UP ${definition.name}`;
  const ammo = whole(drop.ammo);
  return current === drop.weaponType
    ? `[E] +${ammo} ${definition.name} AMMO`
    : `[E] PICK UP ${definition.name} (${ammo})`;
}
