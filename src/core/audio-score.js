const EMPTY_NOTES = Object.freeze([]);
const EMPTY_OPTIONS = Object.freeze({});
const MAX_STEP = 0.25;
const TIME_EPSILON = 1e-8;
const PULSE_THRESHOLD = 0.2;
const ROOTS = [36, 38, 40, 41];
// Original, low-register minor harmony: i, iv, VI, i. There is no melody or
// sampled score; the controller decides how to render these quiet voices.
const HARMONIES = [[0, 3], [5, 3], [8, 4], [0, 3]];

function zoneSeed(zone) {
  let value = 2166136261;
  for (let i = 0; i < zone.length; i++) {
    value = Math.imul(value ^ zone.charCodeAt(i), 16777619) >>> 0;
  }
  return value;
}

function frequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Pure score descriptions driven only by accepted simulation time. Callers
 * must stop already-rendered voices when pausing or muting; disabled advances
 * do not queue notes, change zones, or consume time. Large steps deliberately
 * discard excess time so returning from a stalled frame cannot produce a burst.
 */
export function createScoreScheduler() {
  let elapsed, zone, seed, threat, harmonyStep, harmonyMidi;
  let padCount, pulseCount, nextPadAt, nextPulseAt;

  function reset() {
    elapsed = 0;
    zone = '';
    seed = zoneSeed(zone);
    threat = 0;
    harmonyStep = 0;
    harmonyMidi = ROOTS[seed % ROOTS.length];
    padCount = 0;
    pulseCount = 0;
    nextPadAt = 0;
    nextPulseAt = 0;
  }

  function emitPad(notes) {
    const [degree, third] = HARMONIES[(harmonyStep + seed % HARMONIES.length) % HARMONIES.length];
    harmonyMidi = ROOTS[seed % ROOTS.length] + degree;
    const duration = 3.5 + (seed % 3) * 0.1;
    notes.push({
      frequency: frequency(harmonyMidi), duration,
      gain: 0.024 + threat * 0.008, waveform: 'triangle',
      cutoff: 420 + threat * 340, kind: 'pad',
    }, {
      frequency: frequency(harmonyMidi + third + 12), duration,
      gain: 0.02 + threat * 0.006, waveform: 'sine',
      cutoff: 600 + threat * 350, kind: 'pad',
    });
    harmonyStep = (harmonyStep + 1) % HARMONIES.length;
    padCount++;
    nextPadAt += 3.25 + (seed % 5) * 0.1;
  }

  function emitPulse(notes) {
    // An occasional fifth gives the pulse shape without adding a lead melody.
    const fifth = pulseCount % 4 === 3 ? 7 : 0;
    notes.push({
      frequency: frequency(harmonyMidi + fifth),
      duration: 0.14 + threat * 0.06,
      gain: 0.035 + threat * 0.025, waveform: 'sine',
      cutoff: 240 + threat * 520, kind: 'pulse',
    });
    pulseCount++;
    nextPulseAt += 1.1 - threat * 0.55;
  }

  function advance(dt, options = EMPTY_OPTIONS) {
    const settings = options && typeof options === 'object' ? options : EMPTY_OPTIONS;
    if (!Number.isFinite(dt) || dt <= 0
      || (settings.enabled !== undefined && settings.enabled !== true)) return EMPTY_NOTES;

    // Keep zone hashing and retained metadata bounded even for malformed input.
    const requestedZone = typeof settings.zone === 'string' ? settings.zone.slice(0, 96) : '';
    if (requestedZone !== zone) {
      zone = requestedZone;
      seed = zoneSeed(zone);
      harmonyStep = 0;
      // Preserve the current chord and deadlines until the next scheduled pad.
    }
    threat = Number.isFinite(settings.threat) ? Math.max(0, Math.min(1, settings.threat)) : 0;
    elapsed += Math.min(dt, MAX_STEP);

    if (threat <= PULSE_THRESHOLD) {
      // Preserve a future deadline through short threat fluctuations. During a
      // long calm stretch, discard missed beats instead of accumulating them.
      nextPulseAt = Math.max(nextPulseAt, elapsed);
    }
    const padDue = elapsed + TIME_EPSILON >= nextPadAt;
    const pulseDue = threat > PULSE_THRESHOLD && elapsed + TIME_EPSILON >= nextPulseAt;
    if (!padDue && !pulseDue) return EMPTY_NOTES;

    const notes = [];
    // A long frame can cross both deadlines. Respect their order so the pulse
    // uses the right chord regardless of whether the game runs at 30 or 120 Hz.
    const pulseFirst = pulseDue && (!padDue || nextPulseAt < nextPadAt - TIME_EPSILON);
    if (pulseFirst) emitPulse(notes);
    if (padDue) emitPad(notes);
    if (pulseDue && !pulseFirst) emitPulse(notes);
    return notes;
  }

  function snapshot() {
    return { elapsed, zone, threat, harmonyStep, padCount, pulseCount, nextPadAt, nextPulseAt };
  }

  reset();
  return Object.freeze({ advance, reset, snapshot });
}
