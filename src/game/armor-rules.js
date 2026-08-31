export const MAX_ARMOR = 100;
export const DAMAGED_ARMOR = MAX_ARMOR / 2;
export const ARMOR_WEAR_RATE = 0.75;

export function clampArmor(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_ARMOR, value)) : 0;
}

/** A later headshot cannot repair a vest already hit in the body. */
export function armorStrengthAfterHit(strength, hitPart = 'body') {
  const armor = clampArmor(strength);
  return hitPart === 'head' || hitPart === 'limb' ? armor : Math.min(armor, DAMAGED_ARMOR);
}

/** Consume armor first; only unabsorbed incoming damage reaches health. */
export function applyArmorDamage(player, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const armor = clampArmor(player.armor);
  const armorDamage = Math.min(armor, amount * ARMOR_WEAR_RATE);
  const healthDamage = Math.max(0, amount - armorDamage / ARMOR_WEAR_RATE);
  player.armor = armor - armorDamage;
  player.health = Math.max(0, player.health - healthDamage);
  return healthDamage;
}
