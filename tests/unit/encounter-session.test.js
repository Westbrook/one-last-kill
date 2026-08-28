import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncounterSeedSource } from '../../src/game/encounter-session.js';

test('normal encounter attempts draw fresh seeds independently of ambient random calls', () => {
  let fills = 0, clocks = 0;
  const seeds = createEncounterSeedSource({
    fillRandom(values) { fills++; values[0] = 12345; return values; },
    clock() { clocks++; return 42; },
  });
  assert.equal(fills, 0, 'Constructing the source does not consume an attempt');
  const generated = new Set();
  for (let attempt = 0; attempt < 100; attempt++) {
    const seed = seeds.next();
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
    generated.add(seed);
  }
  assert.equal(generated.size, 100);
  assert.equal(fills, 100);
  assert.equal(clocks, 0);
  assert.equal(seeds.snapshot().attempts, 100);
});

test('authored and fixed QA modes consume no entropy and restore the previous mode exactly', () => {
  let calls = 0;
  const seeds = createEncounterSeedSource({ fillRandom() { calls++; throw new Error('Unavailable'); }, clock: () => 1000 });
  const previous = seeds.setOverride(null);
  assert.equal(previous, undefined);
  assert.equal(seeds.next(), null);
  assert.equal(seeds.snapshot().mode, 'authored');
  assert.equal(seeds.setOverride(0), null);
  for (let i = 0; i < 5; i++) assert.equal(seeds.next(), 0, 'Zero is a valid reproducible seed');
  assert.equal(seeds.snapshot().mode, 'seeded');
  assert.equal(seeds.setOverride(0xffffffff), 0);
  assert.equal(seeds.next(), 0xffffffff);
  assert.equal(calls, 0);
  seeds.setOverride(previous);
  assert.equal(seeds.snapshot().mode, 'random');
  assert.ok(Number.isInteger(seeds.next()));
  assert.equal(calls, 1);
});

test('missing or failing entropy and clocks still produce finite distinct attempt seeds', () => {
  for (const fillRandom of [null, () => undefined, () => { throw new Error('Denied'); }]) {
    for (const clock of [() => 1, () => NaN, () => { throw new Error('Denied'); }]) {
      const seeds = createEncounterSeedSource({ fillRandom, clock });
      const values = Array.from({ length: 16 }, () => seeds.next());
      assert.ok(values.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff));
      assert.equal(new Set(values).size, values.length);
    }
  }
});

test('invalid overrides cannot corrupt a valid fixed seed or its diagnostic snapshot', () => {
  const seeds = createEncounterSeedSource();
  seeds.setOverride(72);
  for (const value of [-1, 2 ** 32, 1.5, Infinity, NaN, '72', {}, true]) {
    assert.throws(() => seeds.setOverride(value), TypeError);
    assert.equal(seeds.next(), 72);
  }
  const snapshot = seeds.snapshot(); snapshot.mode = 'random'; snapshot.override = undefined;
  assert.equal(seeds.next(), 72);
  assert.equal(seeds.snapshot().mode, 'seeded');
});
