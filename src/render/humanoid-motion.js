// Chest-local targets are proportions of body height; angles are radians.
// The held bat remains in meters, with its primary grip at the wrist anchor.
const FIELDS = ['gripX', 'gripY', 'gripZ', 'yaw', 'pitch', 'chestYaw', 'hipX', 'hipZ', 'sink'];
const READY_GUARD = [0.105, 0.100, 0.065, 2.20, -1.08, 0.16, 0, 0, 0.023];
export const NPC_BAT_RELAXED_GUARD = Object.freeze({
  gripX: 0.085, gripY: 0.035, gripZ: 0.05, yaw: 2.35, pitch: -1.02,
});

const BAT_KEYS = [
  [0, ...READY_GUARD],
  [0.22,  0.105, 0.085,  0.065,  2.450, -0.700,  0.28,  0.018, -0.012,  0.035],
  [0.32,  0.105, 0.085,  0.065,  2.450, -0.700,  0.28,  0.018, -0.012,  0.035],
  [0.50,  0,     0.100,  0.250,  0,      0.080, -0.06, -0.010,  0.018,  0.040],
  [0.65, -0.095, 0,      0.140, -1.006,  0.242, -0.38, -0.018,  0.020,  0.035],
  // Lift beside the face before turning across it. Rotating a low barrel
  // straight behind the shoulder would sweep the shaft through the head.
  [0.73,  0.045, 0.130,  0.160, -1.006, -1.520, -0.18, -0.012,  0.012,  0.032],
  [0.82,  0.105, 0.085,  0.065,  2.600, -1.060, -0.04, -0.007,  0.006,  0.028],
  [1, ...READY_GUARD],
];

// Nonzero velocity through impact prevents a mechanical stop at contact.
// Every other knot eases into a readable load, followthrough or guard.
const CONTACT_TANGENT = [-0.56, -0.16, 0, -10.4, 1.2, -1.6, 0, 0, 0];
export const NPC_BAT_CONTACT_PHASE = 0.5;

/** Samples into a caller-owned object; the animation loop never allocates. */
export function sampleBatMotion(progress, out) {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  let segment = 0;
  while (segment < BAT_KEYS.length - 2 && p > BAT_KEYS[segment + 1][0]) segment++;
  const from = BAT_KEYS[segment], to = BAT_KEYS[segment + 1];
  const span = to[0] - from[0], t = (p - from[0]) / span;
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  for (let i = 0; i < FIELDS.length; i++) {
    const startVelocity = from[0] === NPC_BAT_CONTACT_PHASE ? CONTACT_TANGENT[i] : 0;
    const endVelocity = to[0] === NPC_BAT_CONTACT_PHASE ? CONTACT_TANGENT[i] : 0;
    out[FIELDS[i]] = h00 * from[i + 1] + h10 * span * startVelocity
      + h01 * to[i + 1] + h11 * span * endVelocity;
  }
  return out;
}
