import { DISTRICT } from '../world/district-layout.js';

const EMPTY_CUES = Object.freeze([]);
const EMPTY_OPTIONS = Object.freeze({});
const MAX_STEP = 0.25;
const TIME_EPSILON = 1e-8;
const RETRY_DELAY = 1.25;
const CUE_CLEARANCE = 0.25;
const ALARM_SPACING = 0.5;
const ALARM_PULSES = 3;
const ALARM_QUIET_GAPS = [20, 24, 18, 22];
const SIREN_QUIET_GAPS = [34, 38, 32, 36];
const ALARM_CAR = DISTRICT.street.parkedCars.find(car => car.id === 'far');

function profile(kind, values) {
  return Object.freeze({
    kind, ...values, pos: Object.freeze(values.pos),
    frequencyAutomation: Object.freeze(values.frequencyAutomation.map(step => Object.freeze(step))),
  });
}

/** Quiet, positional ambience; automation times are relative to each cue onset. */
export const STREET_ATMOSPHERE = Object.freeze({
  'car-alarm': profile('car-alarm', {
    pos: { x: ALARM_CAR.x, y: ALARM_CAR.y + 0.85, z: ALARM_CAR.z },
    duration: 0.3, gain: 0.05, frequency: 640,
    waveform: 'triangle', cutoff: 1400, attack: 0.015,
    frequencyAutomation: [{ time: 0.12, frequency: 820 }, { time: 0.3, frequency: 640 }],
  }),
  'distant-siren': profile('distant-siren', {
    pos: { x: -48, y: 3, z: 17 },
    duration: 5, gain: 0.16, frequency: 340,
    waveform: 'sine', cutoff: 900, attack: 0.8,
    frequencyAutomation: [
      { time: 1.2, frequency: 540 }, { time: 2.5, frequency: 320 },
      { time: 3.7, frequency: 540 }, { time: 5, frequency: 340 },
    ],
  }),
});

const inDistrict = zone => zone === 'street' || zone === 'bakery';

/**
 * Simulation time only: disabled or invalid advances freeze every field, and
 * excess frame time is discarded. Callers stop rendered cues when pausing or
 * leaving the district, and spatialize the same cues as the listener moves.
 */
export function createStreetAtmosphereScheduler() {
  let elapsed, zone, threat, radioActive;
  let alarmCount, alarmClusterCount, sirenCount, alarmPulsesRemaining;
  let nextAlarmAt, nextSirenAt, busyUntil, busyKind;

  function reset() {
    elapsed = 0;
    zone = '';
    threat = 0;
    radioActive = false;
    alarmCount = 0;
    alarmClusterCount = 0;
    sirenCount = 0;
    alarmPulsesRemaining = 0;
    nextAlarmAt = 3;
    nextSirenAt = 11;
    busyUntil = 0;
    busyKind = null;
  }

  function deferAlarm(deadline) {
    // An interrupted cluster is discarded, so it cannot return as late pulses.
    if (alarmPulsesRemaining && busyKind === 'car-alarm') {
      busyUntil = elapsed;
      busyKind = null;
    }
    alarmPulsesRemaining = 0;
    nextAlarmAt = deadline;
  }

  function emitAlarm() {
    if (!alarmPulsesRemaining) {
      alarmClusterCount++;
      alarmPulsesRemaining = ALARM_PULSES;
    }
    alarmCount++;
    alarmPulsesRemaining--;
    const duration = STREET_ATMOSPHERE['car-alarm'].duration;
    // Reserve the spaces between pulses too: a siren cannot enter those gaps.
    busyKind = 'car-alarm';
    busyUntil = elapsed + alarmPulsesRemaining * ALARM_SPACING + duration;
    nextAlarmAt = alarmPulsesRemaining
      ? elapsed + ALARM_SPACING
      : elapsed + duration + ALARM_QUIET_GAPS[(alarmClusterCount - 1) % ALARM_QUIET_GAPS.length];
    return [STREET_ATMOSPHERE['car-alarm']];
  }

  function emitSiren() {
    sirenCount++;
    busyKind = 'distant-siren';
    busyUntil = elapsed + STREET_ATMOSPHERE['distant-siren'].duration;
    nextSirenAt = busyUntil + SIREN_QUIET_GAPS[(sirenCount - 1) % SIREN_QUIET_GAPS.length];
    return [STREET_ATMOSPHERE['distant-siren']];
  }

  function advance(dt, options = EMPTY_OPTIONS) {
    const settings = options && typeof options === 'object' ? options : EMPTY_OPTIONS;
    if (!Number.isFinite(dt) || dt <= 0
      || (settings.enabled !== undefined && settings.enabled !== true)) return EMPTY_CUES;

    const requestedZone = typeof settings.zone === 'string' ? settings.zone.slice(0, 96) : '';
    if (!inDistrict(requestedZone)) {
      reset();
      zone = requestedZone;
      return EMPTY_CUES;
    }
    zone = requestedZone;
    threat = Number.isFinite(settings.threat) ? Math.max(0, Math.min(1, settings.threat)) : 0;
    radioActive = settings.radioActive === true;
    elapsed += Math.min(dt, MAX_STEP);
    if (elapsed + TIME_EPSILON >= busyUntil) busyKind = null;

    let alarmDue = elapsed + TIME_EPSILON >= nextAlarmAt;
    let sirenDue = elapsed + TIME_EPSILON >= nextSirenAt;
    if (!alarmDue && !sirenDue) return EMPTY_CUES;

    if (threat > 0.6 || radioActive) {
      // Each retry exceeds the maximum step. Advancing the old deadline keeps
      // it in the future without accumulating frame rounding during dialogue.
      if (alarmDue) deferAlarm(nextAlarmAt + RETRY_DELAY);
      if (sirenDue) nextSirenAt += RETRY_DELAY;
      return EMPTY_CUES;
    }

    if (alarmDue && busyKind === 'distant-siren') {
      deferAlarm(Math.max(elapsed + RETRY_DELAY, busyUntil + CUE_CLEARANCE));
      alarmDue = false;
    }
    if (sirenDue && (busyKind === 'car-alarm' || alarmPulsesRemaining)) {
      nextSirenAt = Math.max(elapsed + RETRY_DELAY, busyUntil + CUE_CLEARANCE);
      sirenDue = false;
    }

    // Emit at most one cue per step, resolving simultaneous deadlines the same
    // way at every frame rate. Actual onsets determine spacing, never backlog.
    if (sirenDue && (!alarmDue || nextSirenAt <= nextAlarmAt)) {
      const cues = emitSiren();
      if (alarmDue) deferAlarm(busyUntil + CUE_CLEARANCE);
      return cues;
    }
    if (alarmDue) {
      const cues = emitAlarm();
      if (sirenDue) nextSirenAt = busyUntil + CUE_CLEARANCE;
      return cues;
    }
    return EMPTY_CUES;
  }

  function snapshot() {
    return {
      elapsed, zone, threat, radioActive, alarmCount, alarmClusterCount, sirenCount,
      alarmPulsesRemaining, nextAlarmAt, nextSirenAt, busyUntil, busyKind,
    };
  }

  reset();
  return Object.freeze({ advance, reset, snapshot });
}
