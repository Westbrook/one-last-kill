/**
 * Original, physically inspired effects rather than recordings or simulations
 * of particular firearms. The PCM contains its own attack and release envelope;
 * callers should preserve the initial pressure transient when playing it.
 */
export const WEAPON_TIMBRES = Object.freeze({
  rifle: Object.freeze({ duration: 0.42, gain: 0.72, mechanicalDelay: 0.041 }),
  pistol: Object.freeze({ duration: 0.32, gain: 0.58, mechanicalDelay: 0.032 }),
  shotgun: Object.freeze({ duration: 0.58, gain: 0.86, mechanicalDelay: 0.07 }),
  smg: Object.freeze({ duration: 0.27, gain: 0.43, mechanicalDelay: 0.024 }),
  machinegun: Object.freeze({ duration: 0.46, gain: 0.7, mechanicalDelay: 0.048 }),
});

// Broadband mass and decay distinguish the weapons; no swept pitched oscillator
// stands in for an explosion. The tail here is gas/air noise, not room reverb.
const SHAPES = {
  rifle: { seed: 0x68154b91, crack: 1, bodyCutoff: 4700, bodyFloor: 430, body: 1.45,
    bodyDecay: 0.029, pressureCutoff: 270, pressureFloor: 44, pressure: 3.8,
    pressureDecay: 0.065, tailCutoff: 1900, tail: 0.36, tailDecay: 0.068 },
  pistol: { seed: 0x329da675, crack: 0.91, bodyCutoff: 5400, bodyFloor: 680, body: 1.05,
    bodyDecay: 0.021, pressureCutoff: 400, pressureFloor: 66, pressure: 2.9,
    pressureDecay: 0.042, tailCutoff: 2600, tail: 0.29, tailDecay: 0.05 },
  shotgun: { seed: 0x497eb207, crack: 0.95, bodyCutoff: 2900, bodyFloor: 210, body: 1.45,
    bodyDecay: 0.051, pressureCutoff: 205, pressureFloor: 32, pressure: 4.8,
    pressureDecay: 0.108, tailCutoff: 1400, tail: 0.48, tailDecay: 0.103 },
  smg: { seed: 0x17538cbd, crack: 0.8, bodyCutoff: 6100, bodyFloor: 900, body: 0.85,
    bodyDecay: 0.016, pressureCutoff: 430, pressureFloor: 90, pressure: 2.2,
    pressureDecay: 0.03, tailCutoff: 2600, tail: 0.24, tailDecay: 0.04 },
  machinegun: { seed: 0x54ac903f, crack: 1, bodyCutoff: 3600, bodyFloor: 320, body: 1.48,
    bodyDecay: 0.035, pressureCutoff: 235, pressureFloor: 45, pressure: 4.3,
    pressureDecay: 0.071, tailCutoff: 1650, tail: 0.39, tailDecay: 0.075 },
};

function seededNoise(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2147483648 - 1;
  };
}

/**
 * Render once per cached variant, never per trigger pull. Native AudioContext
 * rates and deliberately tiny test-double rates use the same bounded filters.
 * An unknown weapon uses the rifle timbre. Invalid sample rates fail explicitly.
 */
export function renderWeaponReport(kind, sampleRate, variant = 0) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('Weapon report sampleRate must be positive and finite');
  }
  const weapon = Object.hasOwn(WEAPON_TIMBRES, kind) ? kind : 'rifle';
  const shape = SHAPES[weapon], profile = WEAPON_TIMBRES[weapon];
  const length = Math.max(2, Math.ceil(profile.duration * sampleRate));
  const pcm = new Float32Array(length);
  const variantIndex = Number.isFinite(variant) ? Math.trunc(variant) : 0;
  const noise = seededNoise(shape.seed ^ Math.imul(variantIndex + 1, 0x9e3779b9));
  const color = 1 + noise() * 0.065;
  const decay = 1 + noise() * 0.045;
  const peakTarget = 0.81 + noise() * 0.025;
  const shockFrames = Math.max(0.8, sampleRate * (0.00024 + noise() * 0.000025));
  const inverseShockFrames = 1 / shockFrames;
  const crackGain = shape.crack, bodyGain = shape.body;
  const pressureGain = shape.pressure, tailGain = shape.tail;
  const pole = (frequency, ceiling = 0.42) =>
    1 - Math.exp(-2 * Math.PI * Math.min(frequency, sampleRate * ceiling) / sampleRate);
  const fall = seconds => Math.exp(-1 / (sampleRate * seconds));
  const bodyPole = pole(shape.bodyCutoff * color);
  const bodyFloorPole = pole(shape.bodyFloor * color, 0.15);
  const pressurePole = pole(shape.pressureCutoff * color, 0.3);
  const pressureFloorPole = pole(shape.pressureFloor, 0.05);
  const tailPole = pole(shape.tailCutoff * color);
  const tailDarkPole = pole(390, 0.12);
  const turbulencePole = pole(650, 0.18);
  const dcPole = 1 - pole(25, 0.025);
  const bodyFall = fall(shape.bodyDecay * decay);
  const pressureFall = fall(shape.pressureDecay * decay);
  const tailFall = fall(shape.tailDecay * decay);
  const crackFall = fall(0.0013);
  const riseFall = fall(0.00065);
  const tailRiseFall = fall(0.009);
  const brightnessFall = fall(0.055);
  const attackFrames = Math.max(1, sampleRate * 0.00012);
  const releaseFrames = Math.max(1, sampleRate * 0.016);
  const inverseAttackFrames = 1 / attackFrames, inverseReleaseFrames = 1 / releaseFrames;
  const releaseStart = length - 1 - releaseFrames, inverseLength = 1 / (length - 1);
  let bodyLow = 0, bodyFloor = 0, pressureLow = 0, pressureSmooth = 0, pressureFloor = 0;
  let tailLow = 0, tailDark = 0, previous = 0, highpass = 0;
  let bodyEnvelope = 1, pressureEnvelope = 1, tailEnvelope = 1, crackEnvelope = 1;
  let pressureRise = 1, tailRise = 1, brightness = 1;
  let turbulence = 1, turbulenceTarget = 1, nextBurst = 0, sum = 0;

  for (let i = 0; i < length; i++) {
    // Uneven short gas bursts break up the body without making a periodic buzz.
    if (i >= nextBurst) {
      turbulenceTarget = 0.93 + noise() * 0.32;
      nextBurst = i + Math.max(1, Math.round(sampleRate * (0.004 + noise() * 0.0025)));
    }
    turbulence += turbulencePole * (turbulenceTarget - turbulence);
    const air = noise(), pressureAir = noise(), tailAir = noise();
    bodyLow += bodyPole * (air - bodyLow);
    bodyFloor += bodyFloorPole * (air - bodyFloor);
    pressureLow += pressurePole * (pressureAir - pressureLow);
    pressureSmooth += pressurePole * (pressureLow - pressureSmooth);
    pressureFloor += pressureFloorPole * (pressureSmooth - pressureFloor);
    tailLow += tailPole * (tailAir - tailLow);
    tailDark += tailDarkPole * (tailAir - tailDark);

    // A compact bipolar pressure pulse: its two lobes have equal continuous
    // area. The stochastic layers carry the body instead of a tonal sub drop.
    const shockTime = i * inverseShockFrames;
    const shock = shockTime < 9
      ? 6.5 * crackGain * shockTime * (1 - shockTime) * Math.exp(-2 * shockTime) : 0;
    const crack = (air - bodyLow) * crackEnvelope * crackGain * 0.3;
    const body = (bodyLow - bodyFloor) * bodyEnvelope * bodyGain * turbulence;
    const pressure = (pressureSmooth - pressureFloor) * pressureEnvelope
      * (1 - pressureRise) * pressureGain;
    const tail = (tailLow * brightness + tailDark * (1 - brightness))
      * tailEnvelope * (1 - tailRise) * tailGain;
    const raw = shock + crack + body + pressure + tail;
    // Gentle symmetric saturation rounds peaks, then a DC blocker removes
    // subsonic drift from the pressure and turbulent noise layers.
    const rounded = raw / (1 + Math.abs(raw) * 0.35);
    highpass = dcPole * (highpass + rounded - previous);
    previous = rounded;
    let boundary = i < attackFrames ? i * inverseAttackFrames : 1;
    if (i > releaseStart) boundary = Math.min(boundary, (length - 1 - i) * inverseReleaseFrames);
    const window = boundary < 1 ? boundary * boundary * (3 - 2 * boundary) : 1;
    pcm[i] = highpass * window;
    sum += pcm[i];

    bodyEnvelope *= bodyFall; pressureEnvelope *= pressureFall; tailEnvelope *= tailFall;
    crackEnvelope *= crackFall; pressureRise *= riseFall; tailRise *= tailRiseFall;
    brightness *= brightnessFall;
  }

  // Finite-clip DC correction has zero endpoints, avoiding a constant step at
  // the clip boundaries. It is tiny after the 25 Hz high-pass above.
  const weightSum = (length * (length - 2)) / (6 * (length - 1));
  const correction = weightSum > 0 ? sum / weightSum : 0;
  let peak = 0;
  for (let i = 1; i < length - 1; i++) {
    const x = i * inverseLength;
    pcm[i] -= correction * x * (1 - x);
    peak = Math.max(peak, Math.abs(pcm[i]));
  }
  const scale = peak > 0 ? peakTarget / peak : 0;
  for (let i = 1; i < length - 1; i++) pcm[i] *= scale;
  pcm[0] = 0; pcm[length - 1] = 0;
  return pcm;
}
