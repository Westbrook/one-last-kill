// Immutable appearance/motion data. Sizes are metres; profile and particle
// style objects are allocated only while loading this module.
const dust = (color, life = 0.28) => Object.freeze({
  kind: 'dust', texture: 'dust', color, additive: false,
  width: 0.070, height: 0.065, opacity: 0.42, life, growth: 0.70,
  spread: 0.030, speed: 0.18, scatter: 0.18, rise: 0.035, gravity: 0.25,
});
const metalSpark = Object.freeze({
  kind: 'spark', texture: 'fleck', color: 0xffd4a0, additive: true,
  width: 0.009, height: 0.030, opacity: 0.85, life: 0.12, growth: -0.18,
  spread: 0.012, speed: 0.90, scatter: 0.85, rise: 0.06, gravity: 4.0,
});
const woodChip = Object.freeze({
  kind: 'chip', texture: 'fleck', color: 0xb39a73, additive: false,
  width: 0.014, height: 0.027, opacity: 0.72, life: 0.22, growth: -0.12,
  spread: 0.020, speed: 0.35, scatter: 0.45, rise: 0.04, gravity: 3.2,
});
const glassFleck = Object.freeze({
  kind: 'fleck', texture: 'fleck', color: 0xbacbd0, additive: false,
  width: 0.010, height: 0.022, opacity: 0.70, life: 0.16, growth: -0.18,
  spread: 0.015, speed: 0.45, scatter: 0.55, rise: 0.025, gravity: 2.5,
});
const glassFlash = Object.freeze({
  kind: 'flash', texture: 'fleck', color: 0xd1dfe2, additive: true,
  width: 0.030, height: 0.030, opacity: 0.45, life: 0.055, growth: 0,
  spread: 0.008, speed: 0.10, scatter: 0.04, rise: 0, gravity: 0,
});
const profile = (id, primary, secondary = null, every = 0) => Object.freeze({ id, primary, secondary, every });

export const IMPACT_PROFILES = Object.freeze({
  neutral: profile('neutral', dust(0xa4a59f)),
  concrete: profile('concrete', dust(0xa1a59f)),
  plaster: profile('plaster', dust(0xc1bcb0)),
  brick: profile('brick', dust(0xa28f7f)),
  dark: profile('dark', dust(0x81847d, 0.24)),
  wood: profile('wood', woodChip, dust(0xb39b78, 0.25), 3),
  metal: profile('metal', metalSpark),
  glass: profile('glass', glassFleck, glassFlash, -1),
});

const aliases = Object.create(null);
function bind(target, names) {
  for (const name of names) {
    aliases[name] = aliases[name.toLowerCase()] = target;
    aliases[`surface-${name}`] = aliases[`surface-${name.toLowerCase()}`] = target;
  }
}
bind(IMPACT_PROFILES.metal, ['metal', 'roofMetal', 'roof-metal', 'roof_metal', 'steel', 'iron', 'wire', 'chrome']);
bind(IMPACT_PROFILES.concrete, ['concrete', 'agedStone', 'aged-stone', 'stone', 'gravel']);
bind(IMPACT_PROFILES.plaster, ['plaster', 'wallpaper', 'tile', 'ceramic']);
bind(IMPACT_PROFILES.brick, ['brick', 'masonry']);
bind(IMPACT_PROFILES.dark, ['tar', 'asphalt', 'rubber', 'roof']);
bind(IMPACT_PROFILES.wood, ['wood', 'timber', 'plywood', 'floorboards', 'bat-aged-wood']);
bind(IMPACT_PROFILES.glass, ['glass', 'glazing', 'window']);
Object.freeze(aliases);
const lookup = value => typeof value === 'string' ? aliases[value] || aliases[value.trim().toLowerCase()] : null;

/** Explicit hit metadata wins; unlabelled materials retain a neutral fallback. */
export function resolveImpactProfile(hit) {
  const material = hit?.material;
  return lookup(hit?.surfaceKind) || lookup(material?.userData?.surfaceKind) || lookup(material?.name)
    || (material?.transmission > 0.1 ? IMPACT_PROFILES.glass : null)
    || (material?.metalness >= 0.45 ? IMPACT_PROFILES.metal : IMPACT_PROFILES.neutral);
}

/** Reuses frozen styles: wood mixes dust/chips; glass gets one tiny initial flash. */
export function impactParticleStyle(profile, ordinal = 0) {
  const selected = profile || IMPACT_PROFILES.neutral;
  if (selected.secondary && (selected.every < 0 ? ordinal === 0 : ordinal % selected.every === 0)) return selected.secondary;
  return selected.primary;
}
