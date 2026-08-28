/** Preferences are independent of the session's immutable mute policy. */
export const DEFAULT_AUDIO_MIX = Object.freeze({
  master: 0.75, effects: 0.85, ambience: 0.4, music: 0.28, radio: 0.9,
});

export const AUDIO_BUSES = Object.freeze(['effects', 'ambience', 'music', 'radio']);

export function normalizeAudioMix(update, previous = DEFAULT_AUDIO_MIX) {
  const result = {};
  for (const key of Object.keys(DEFAULT_AUDIO_MIX)) {
    const fallback = Number.isFinite(previous?.[key]) ? previous[key] : DEFAULT_AUDIO_MIX[key];
    result[key] = Number.isFinite(update?.[key]) ? Math.max(0, Math.min(1, update[key])) : fallback;
  }
  return Object.freeze(result);
}

const SURFACES = Object.freeze({
  concrete: Object.freeze({ cutoff: 1150, body: 94, duration: 0.105, resonance: 0 }),
  wood: Object.freeze({ cutoff: 780, body: 132, duration: 0.14, resonance: 215 }),
  metal: Object.freeze({ cutoff: 2450, body: 155, duration: 0.17, resonance: 610 }),
  glass: Object.freeze({ cutoff: 3950, body: 180, duration: 0.22, resonance: 1120 }),
  body: Object.freeze({ cutoff: 610, body: 82, duration: 0.125, resonance: 0 }),
  cloth: Object.freeze({ cutoff: 370, body: 68, duration: 0.075, resonance: 0 }),
  dirt: Object.freeze({ cutoff: 920, body: 80, duration: 0.16, resonance: 0 }),
});

const ALIASES = Object.freeze({
  asphalt: 'concrete', stone: 'concrete', agedstone: 'concrete', brick: 'concrete', tile: 'concrete',
  plaster: 'concrete', wallpaper: 'concrete', paint: 'concrete', tar: 'concrete',
  steel: 'metal', iron: 'metal', roofmetal: 'metal', flesh: 'body', skin: 'body',
  carpet: 'cloth', fabric: 'cloth', rubber: 'cloth',
  gravel: 'dirt', earth: 'dirt', sand: 'dirt', timber: 'wood',
});

export function audioSurface(value) {
  const name = typeof value === 'string' ? value.toLowerCase() : '';
  return SURFACES[name] ? name : ALIASES[name] ?? 'concrete';
}

export function surfaceSoundProfile(value) { return SURFACES[audioSurface(value)]; }

const finitePoint = value => value && ['x', 'y', 'z'].every(key => Number.isFinite(value[key]));

/** A small stereo cue, not a wall-penetrating or raycast-based sound simulation. */
export function describeAudioEvent(options = {}, listener = null) {
  if (!options || typeof options !== 'object') options = {};
  const pos = options.pos ?? options.position;
  const eye = listener?.position ?? listener?.pos;
  let distance = 0, pan = 0, attenuation = 1;
  if (finitePoint(pos) && finitePoint(eye)) {
    const dx = pos.x - eye.x, dy = pos.y - eye.y, dz = pos.z - eye.z;
    distance = Math.hypot(dx, dy, dz);
    attenuation = distance >= 90 ? 0 : 1 / (1 + (distance / 16) ** 2);
    if (distance > 0.01) {
      const yaw = Number.isFinite(listener.yaw) ? listener.yaw : 0;
      pan = Math.max(-0.85, Math.min(0.85, (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / distance));
    }
  }
  const environment = typeof options.environment === 'string' ? options.environment : options.environment?.type;
  const interior = ['interior', 'indoor', 'room', 'apartment', 'neighbor', 'stairs', 'stairwell', 'bakery'].includes(environment);
  const intensity = Number.isFinite(options.intensity) ? Math.max(0, Math.min(1.5, options.intensity)) : 1;
  return { gain: attenuation * intensity, pan, distance, interior };
}
