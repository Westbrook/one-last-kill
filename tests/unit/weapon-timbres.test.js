import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_TIMBRES, renderWeaponReport } from '../../src/core/weapon-timbres.js';

const weaponKinds = ['rifle', 'pistol', 'shotgun', 'smg', 'machinegun'];
const playbackRates = [44100, 48000];
const variants = [0, 1, 2, 3];

function energy(pcm, start = 0, end = pcm.length) {
  let sum = 0;
  for (let index = start; index < end; index++) sum += pcm[index] ** 2;
  return sum;
}

function rms(pcm, start = 0, end = pcm.length) {
  return Math.sqrt(energy(pcm, start, end) / (end - start));
}

function correlation(left, right) {
  const length = Math.min(left.length, right.length);
  let dot = 0, leftEnergy = 0, rightEnergy = 0;
  for (let index = 0; index < length; index++) {
    dot += left[index] * right[index];
    leftEnergy += left[index] ** 2;
    rightEnergy += right[index] ** 2;
  }
  return dot / Math.sqrt(leftEnergy * rightEnergy);
}

function energySignature(pcm, sampleRate) {
  const totalEnergy = energy(pcm);
  let accumulated = 0, decayIndex = 0, lowPassed = 0, lowEnergy = 0;
  while (accumulated < totalEnergy * 0.9 && decayIndex < pcm.length) {
    accumulated += pcm[decayIndex] ** 2;
    decayIndex++;
  }
  // A broad low-frequency energy measure avoids depending on particular peaks
  // or oscillators while detecting when the weapon bodies become interchangeable.
  const alpha = 1 - Math.exp(-2 * Math.PI * 500 / sampleRate);
  for (const value of pcm) {
    lowPassed += alpha * (value - lowPassed);
    lowEnergy += lowPassed ** 2;
  }
  return { decayTime: decayIndex / sampleRate, lowShare: lowEnergy / totalEnergy };
}

test('weapon report profiles are immutable and keep their body and action timing within one bounded shot', () => {
  assert.deepEqual(Object.keys(WEAPON_TIMBRES).sort(), [...weaponKinds].sort());
  assert.ok(Object.isFrozen(WEAPON_TIMBRES));
  for (const [kind, profile] of Object.entries(WEAPON_TIMBRES)) {
    assert.ok(Object.isFrozen(profile), kind);
    assert.ok(profile.duration > 0.1 && profile.duration < 1, kind + ' report duration');
    assert.ok(profile.gain > 0 && profile.gain <= 1, kind + ' report gain');
    assert.ok(profile.mechanicalDelay > 0 && profile.mechanicalDelay < profile.duration,
      kind + ' action follows its muzzle report');
  }
});

test('every report variant has finite PCM, headroom, and silent endpoints at device and mock sample rates', () => {
  for (const sampleRate of [...playbackRates, 100, 1000]) {
    for (const kind of weaponKinds) for (const variant of variants) {
      const label = `${kind} variant ${variant} at ${sampleRate} Hz`;
      const pcm = renderWeaponReport(kind, sampleRate, variant);
      assert.ok(pcm instanceof Float32Array, label);
      assert.equal(pcm.length, Math.ceil(WEAPON_TIMBRES[kind].duration * sampleRate), label);
      assert.equal(pcm[0], 0, label + ' begins at zero');
      assert.equal(pcm.at(-1), 0, label + ' ends at zero');
      for (const value of pcm) {
        assert.ok(Number.isFinite(value), label + ' is finite');
        assert.ok(Math.abs(value) <= 0.850001, label + ' retains mix headroom');
      }
    }
  }
});

test('shots retain an audible body and decay away without a DC offset', () => {
  for (const sampleRate of playbackRates) for (const kind of weaponKinds) for (const variant of variants) {
    const label = `${kind} variant ${variant} at ${sampleRate} Hz`;
    const pcm = renderWeaponReport(kind, sampleRate, variant);
    const quarter = Math.floor(pcm.length / 4);
    const totalEnergy = energy(pcm);
    const mean = pcm.reduce((sum, value) => sum + value, 0) / pcm.length;
    assert.ok(rms(pcm) > 0.01, label + ' is audible');
    assert.ok(Math.abs(mean) < 0.0001, label + ' has negligible DC');
    assert.ok(energy(pcm, 0, Math.floor(sampleRate * 0.08)) > totalEnergy * 0.45,
      label + ' places the main impact near the trigger');
    assert.ok(energy(pcm, Math.floor(sampleRate * 0.03), Math.floor(sampleRate * 0.1)) > totalEnergy * 0.005,
      label + ' has a body beyond its initial transient');
    assert.ok(rms(pcm, pcm.length - quarter) < rms(pcm, 0, quarter) * 0.25,
      label + ' tail decays before the buffer ends');
  }
});

test('repeat renders are deterministic while alternate shots are not copies or simple gain changes', () => {
  for (const sampleRate of playbackRates) for (const kind of weaponKinds) {
    const reports = variants.map(variant => renderWeaponReport(kind, sampleRate, variant));
    for (const variant of variants) {
      assert.deepEqual(renderWeaponReport(kind, sampleRate, variant), reports[variant],
        `${kind} variant ${variant} at ${sampleRate} Hz reproduces exactly`);
      for (let other = variant + 1; other < reports.length; other++) {
        assert.ok(Math.abs(correlation(reports[variant], reports[other])) < 0.98,
          `${kind} variants ${variant} and ${other} at ${sampleRate} Hz have distinct waveforms`);
      }
    }
  }
});

test('weapon families have distinct waveforms, not one shared report with a different gain or trailing silence', () => {
  for (const sampleRate of playbackRates) for (const variant of variants) {
    const reports = weaponKinds.map(kind => renderWeaponReport(kind, sampleRate, variant));
    for (let index = 0; index < reports.length; index++) for (let other = index + 1; other < reports.length; other++) {
      assert.ok(Math.abs(correlation(reports[index], reports[other])) < 0.95,
        `${weaponKinds[index]} and ${weaponKinds[other]} variant ${variant} at ${sampleRate} Hz differ`);
    }
  }
});

test('the shotgun sustains a longer energy decay than rifle and SMG and a heavier low-frequency body than SMG', () => {
  for (const sampleRate of playbackRates) {
    const averageSignature = kind => {
      const reports = variants.map(variant => energySignature(renderWeaponReport(kind, sampleRate, variant), sampleRate));
      return {
        decayTime: reports.reduce((sum, report) => sum + report.decayTime, 0) / reports.length,
        lowShare: reports.reduce((sum, report) => sum + report.lowShare, 0) / reports.length,
      };
    };
    const shotgun = averageSignature('shotgun'), rifle = averageSignature('rifle'), smg = averageSignature('smg');
    assert.ok(shotgun.decayTime > rifle.decayTime * 1.4,
      `${sampleRate} Hz shotgun energy lasts substantially longer than rifle energy`);
    assert.ok(shotgun.decayTime > smg.decayTime * 2,
      `${sampleRate} Hz shotgun energy lasts substantially longer than SMG energy`);
    assert.ok(shotgun.lowShare > smg.lowShare * 1.25,
      `${sampleRate} Hz shotgun retains substantially more low-frequency weight than SMG`);
  }
});

test('unknown weapons use the rifle report and invalid sample rates fail before rendering', () => {
  for (const kind of ['unknown', 'toString', 'constructor', '__proto__', undefined, null]) {
    assert.deepEqual(renderWeaponReport(kind, 48000, 2), renderWeaponReport('rifle', 48000, 2));
  }
  for (const sampleRate of [0, -1, NaN, Infinity, -Infinity, undefined, null, '48000']) {
    assert.throws(() => renderWeaponReport('rifle', sampleRate), RangeError, String(sampleRate));
  }
});
