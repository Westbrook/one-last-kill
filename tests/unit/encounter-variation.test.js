import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncounterVariation, variedSpawnCandidates } from '../../src/game/encounter-variation.js';
import { ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from '../../src/game/mission-data.js';

const encounters = [...Object.values(ZONE_WAVE_CONFIG), ...Object.values(FINAL_ENCOUNTERS)];
const seeds = [...Array.from({ length: 64 }, (_, index) => index), 0x80000000, 0xffffffff];
const within = (value, low, high) => assert.ok(value >= low - 1e-9 && value <= high + 1e-9,
  `${value} must stay between ${low} and ${high}`);
const pointKey = point => `${point.x},${point.y},${point.z}`;

test('omitting a seed preserves exact authored timing and candidate order for every encounter', () => {
  for (const config of encounters) {
    const plan = createEncounterVariation(config);
    assert.equal(plan.enabled, false);
    assert.equal(plan.seed, null);
    assert.equal(plan.firstDelay, config.firstWave);
    assert.deepEqual(plan.recoveryDelays, Array(config.waveCount).fill(config.waveInterval));
    assert.equal(plan.reinforcementFirstDelay, config.reinforcements?.firstDelay ?? 0);
    assert.deepEqual(plan.reinforcementIntervals, Array(config.waveCount).fill(config.reinforcements?.interval ?? 0));
    assert.equal(variedSpawnCandidates(config.spawns, plan), config.spawns);
    assert.equal(variedSpawnCandidates(config.spawns, null), config.spawns);
  }
});

test('zero is a valid variation seed and invalid seed representations are rejected', () => {
  const config = ZONE_WAVE_CONFIG.roof;
  for (const seed of [0, 1, 0x80000000, 0xffffffff]) {
    const plan = createEncounterVariation(config, seed);
    assert.equal(plan.enabled, true);
    assert.equal(plan.seed, seed);
  }
  for (const seed of [-1, 0x100000000, 1.5, NaN, Infinity, '0', true, {}]) {
    assert.throws(() => createEncounterVariation(config, seed), RangeError);
  }
});

test('all sampled first, recovery and reinforcement delays stay within their authored bounds', () => {
  for (const config of encounters) for (const seed of seeds) {
    const plan = createEncounterVariation(config, seed), fraction = config.variation.timingFraction;
    within(plan.firstDelay, config.firstWave * (1 - fraction),
      Math.min(config.firstWave * (1 + fraction), config.variation.maxFirstDelay ?? Infinity));
    for (const delay of plan.recoveryDelays) {
      within(delay, Math.max(config.minRecovery ?? 0, config.waveInterval * (1 - fraction)), config.waveInterval * (1 + fraction));
    }
    const policy = config.reinforcements;
    within(plan.reinforcementFirstDelay, (policy?.firstDelay ?? 0) * (1 - fraction), (policy?.firstDelay ?? 0) * (1 + fraction));
    for (const delay of plan.reinforcementIntervals) {
      within(delay, (policy?.interval ?? 0) * (1 - fraction), (policy?.interval ?? 0) * (1 + fraction));
    }
  }
});

test('the short balcony opening never exceeds its proven sprint window and final branches stay immediate', () => {
  for (const seed of seeds) {
    within(createEncounterVariation(ZONE_WAVE_CONFIG.balcony, seed).firstDelay, 0.082, 0.1);
    assert.equal(createEncounterVariation(FINAL_ENCOUNTERS.car, seed).firstDelay, 0);
    assert.equal(createEncounterVariation(FINAL_ENCOUNTERS.bakery, seed).firstDelay, 0);
  }
  assert.equal(ZONE_WAVE_CONFIG.stairwell.stageTransitionDelay, 0);
  assert.equal(FINAL_ENCOUNTERS.bakery.deadlineSeconds, 180);
  assert.equal(ZONE_WAVE_CONFIG.balcony.rearPressure.fallbackAfter, 1.5);
  assert.equal(ZONE_WAVE_CONFIG.stairwell.rearPressure.fallbackAfter, 4.5);
});

test('fixed seeds reproduce timing and placement without consulting ambient randomness', () => {
  const config = ZONE_WAVE_CONFIG.roof, random = Math.random;
  Math.random = () => assert.fail('Encounter variation cannot read ambient Math.random');
  try {
    const first = createEncounterVariation(config, 123456789);
    const expected = variedSpawnCandidates(config.spawns, first, { waveIndex: 1, entryIndex: 2 });
    for (let attempt = 0; attempt < 30; attempt++) {
      const retry = createEncounterVariation(config, 123456789);
      assert.deepEqual(retry, first);
      assert.deepEqual(variedSpawnCandidates(config.spawns, retry, { waveIndex: 1, entryIndex: 2 }), expected);
    }
  } finally { Math.random = random; }
});

test('different seeds produce useful variation in both delay and safe pocket preferences', () => {
  const config = ZONE_WAVE_CONFIG.roof;
  const times = new Set(), positions = new Set(), firstAnchors = new Set();
  for (const seed of seeds) {
    const plan = createEncounterVariation(config, seed);
    const candidates = variedSpawnCandidates(config.spawns, plan, { waveIndex: 1, entryIndex: 0 });
    times.add(plan.recoveryDelays[1]);
    positions.add(pointKey(candidates[0]));
    firstAnchors.add(pointKey(candidates[1]));
  }
  assert.ok(times.size >= 60);
  assert.ok(positions.size >= 60);
  assert.ok(firstAnchors.size >= 8, 'The plan varies actual pocket preference as well as tiny offsets');
});

test('each offset keeps its original height, stays modest and retains the untouched anchor as fallback', () => {
  for (const config of encounters) {
    const originals = config.spawns;
    const plan = createEncounterVariation(config, 0xa52f093c);
    const candidates = variedSpawnCandidates(originals, plan, { waveIndex: 0, entryIndex: 0 });
    assert.equal(candidates.length, originals.length * 2);
    for (let index = 0; index < candidates.length; index += 2) {
      const shifted = candidates[index], original = candidates[index + 1];
      assert.ok(originals.includes(original), 'Fallback is the actual authored point, not a second random attempt');
      assert.equal(shifted.y, original.y);
      within(shifted.x - original.x, -plan.jitterX, plan.jitterX);
      within(shifted.z - original.z, -plan.jitterZ, plan.jitterZ);
      assert.ok(Object.isFrozen(shifted));
    }
    assert.equal(new Set(candidates.filter(point => originals.includes(point))).size, originals.length);
    assert.ok(Object.isFrozen(candidates));
  }
});

test('timing and placement settings cannot perturb each other or consume a shared stream', () => {
  const config = ZONE_WAVE_CONFIG.roof, seed = 77;
  const plan = createEncounterVariation(config, seed);
  const timingChanged = createEncounterVariation({ ...config, firstWave: 4, waveInterval: 8,
    variation: { ...config.variation, timingFraction: 0.03 } }, seed);
  const placementChanged = createEncounterVariation({ ...config, variation: { ...config.variation, jitterX: 0.1, jitterZ: 0.2 } }, seed);
  assert.deepEqual(variedSpawnCandidates(config.spawns, plan), variedSpawnCandidates(config.spawns, timingChanged));
  assert.equal(placementChanged.firstDelay, plan.firstDelay);
  assert.deepEqual(placementChanged.recoveryDelays, plan.recoveryDelays);
  assert.deepEqual(placementChanged.reinforcementIntervals, plan.reinforcementIntervals);
  const expected = variedSpawnCandidates(config.spawns, plan, { waveIndex: 2, entryIndex: 1 });
  for (let index = 0; index < 100; index++) variedSpawnCandidates(config.spawns, plan, {
    waveIndex: index % 4, entryIndex: index % 3, channel: index % 2 ? 'rear' : 'forward',
  });
  assert.deepEqual(variedSpawnCandidates(config.spawns, plan, { waveIndex: 2, entryIndex: 1 }), expected);
  assert.deepEqual(createEncounterVariation(config, seed), plan);
});

test('wave, original entry index, encounter namespace and forward/rear purpose have independent preferences', () => {
  const config = ZONE_WAVE_CONFIG.roof, plan = createEncounterVariation(config, 9988);
  const keys = [
    { waveIndex: 0, entryIndex: 0, channel: 'forward' },
    { waveIndex: 1, entryIndex: 0, channel: 'forward' },
    { waveIndex: 0, entryIndex: 1, channel: 'forward' },
    { waveIndex: 0, entryIndex: 0, channel: 'rear' },
  ];
  assert.equal(new Set(keys.map(key => JSON.stringify(variedSpawnCandidates(config.spawns, plan, key)))).size, keys.length);
  const renamed = createEncounterVariation({ ...config, variation: { ...config.variation, key: 'another-roof' } }, 9988);
  assert.notEqual(renamed.firstDelay, plan.firstDelay);
  assert.notDeepEqual(variedSpawnCandidates(config.spawns, renamed), variedSpawnCandidates(config.spawns, plan));
});

test('filtering or reordering eligible anchors does not reroll the remaining pockets or offsets', () => {
  const config = ZONE_WAVE_CONFIG.roof, plan = createEncounterVariation(config, 42);
  const context = { waveIndex: 2, entryIndex: 1 };
  const full = variedSpawnCandidates(config.spawns, plan, context);
  assert.deepEqual(variedSpawnCandidates([...config.spawns].reverse(), plan, context), full);
  const subset = config.spawns.slice(2, 7), included = new Set(subset);
  const expected = [];
  for (let index = 0; index < full.length; index += 2) {
    if (included.has(full[index + 1])) expected.push(full[index], full[index + 1]);
  }
  assert.deepEqual(variedSpawnCandidates(subset, plan, context), expected);
});

test('disabling offsets still shuffles authored points without inventing duplicates', () => {
  const config = { ...ZONE_WAVE_CONFIG.roof, variation: { key: 'roof', jitterX: 0, jitterZ: 0, timingFraction: 0 } };
  const plan = createEncounterVariation(config, 101);
  const candidates = variedSpawnCandidates(config.spawns, plan);
  assert.equal(plan.firstDelay, config.firstWave);
  assert.deepEqual(plan.recoveryDelays, Array(config.waveCount).fill(config.waveInterval));
  assert.equal(candidates.length, config.spawns.length);
  assert.equal(new Set(candidates).size, config.spawns.length);
  assert.ok(candidates.every(point => config.spawns.includes(point)));
});

test('plans, delay arrays and offsets cannot be changed by inspection', () => {
  const config = ZONE_WAVE_CONFIG.roof, plan = createEncounterVariation(config, 99);
  const candidates = variedSpawnCandidates(config.spawns, plan);
  assert.throws(() => { plan.seed = 100; }, TypeError);
  assert.throws(() => { plan.recoveryDelays[1] = 0; }, TypeError);
  assert.throws(() => { plan.reinforcementIntervals.pop(); }, TypeError);
  assert.throws(() => { candidates[0].x = 100; }, TypeError);
  assert.throws(() => { candidates.push(config.spawns[0]); }, TypeError);
  assert.deepEqual(createEncounterVariation(config, 99), plan);
});

test('invalid authored slots cannot generate a placement and invalid coordinates are never repaired', () => {
  const config = ZONE_WAVE_CONFIG.roof, plan = createEncounterVariation(config, 3);
  for (const context of [{ waveIndex: -1 }, { waveIndex: NaN }, { entryIndex: 0.5 }, { entryIndex: Infinity }]) {
    assert.deepEqual(variedSpawnCandidates(config.spawns, plan, context), []);
  }
  const malformed = Object.freeze({ x: NaN, y: 4, z: 8 });
  assert.deepEqual(variedSpawnCandidates([malformed], plan), [malformed]);
});

test('extreme variation authoring is bounded and never shortens an explicit minimum recovery', () => {
  const config = { ...ZONE_WAVE_CONFIG.roof, minRecovery: 4.9,
    variation: { timingFraction: 5, jitterX: 8, jitterZ: 8 } };
  for (const seed of seeds) {
    const plan = createEncounterVariation(config, seed);
    assert.equal(plan.timingFraction, 0.2);
    assert.equal(plan.jitterX, 1);
    assert.equal(plan.jitterZ, 1);
    for (const delay of plan.recoveryDelays) within(delay, 4.9, 6);
  }
});
