import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMMO_SUPPLY_UNITS, AMMO_SUPPLY_LOADS, AMMO_RESERVE_LIMITS, AMMO_SUPPLY_COSTS,
  AMMO_SUPPLY_CACHES, AmmoSupplyLedger, ammoSupplyAmount,
} from '../../src/game/ammo-supply-rules.js';
import { createCheckpoint } from '../../src/game/mission-data.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';

const id = AMMO_SUPPLY_CACHES[0].id;
const weapon = (current = 'pistol', reserve = 0, loaded = 4) => ({ current, loaded, reserve });
const acceptInto = held => (amount, cap) => {
  const accepted = Math.max(0, Math.min(amount, cap - held.reserve));
  held.reserve += accepted;
  return accepted;
};
const take = (ledger, held, options = { active: true }) => ledger.take(id, held, acceptInto(held), options);

test('three finite reserve boxes support each carried firearm without granting a gun', () => {
  assert.equal(AMMO_SUPPLY_CACHES.length, 3);
  assert.deepEqual(AMMO_SUPPLY_CACHES.map(cache => cache.id), ['balcony-reserve', 'roof-west-reserve', 'roof-east-reserve']);
  assert.deepEqual(AMMO_SUPPLY_CACHES.map(cache => cache.zone), ['balcony', 'roof', 'roof']);
  for (const [type, rounds] of Object.entries(AMMO_SUPPLY_LOADS)) {
    const ledger = new AmmoSupplyLedger(), held = weapon(type);
    const before = { ...held };
    assert.equal(ledger.available(id, held), rounds);
    assert.equal(take(ledger, held), rounds);
    assert.equal(held.current, before.current);
    assert.equal(held.loaded, before.loaded, 'A cache never silently reloads a magazine');
    assert.equal(held.reserve, rounds);
    assert.equal(ledger.units(id), 0);
    assert.equal(take(ledger, held), 0);
  }
});

test('cache yields and limits are immutable and every full grant consumes the same budget', () => {
  assert.deepEqual(AMMO_SUPPLY_LOADS, { pistol: 24, shotgun: 6, smg: 30, machinegun: 40 });
  assert.deepEqual(AMMO_RESERVE_LIMITS, { pistol: 48, shotgun: 18, smg: 90, machinegun: 120 });
  for (const [type, rounds] of Object.entries(AMMO_SUPPLY_LOADS)) {
    assert.equal(AMMO_SUPPLY_COSTS[type] * rounds, AMMO_SUPPLY_UNITS);
  }
  assert.throws(() => { AMMO_SUPPLY_CACHES[0].position.x = 0; }, TypeError);
  assert.throws(() => { AMMO_SUPPLY_LOADS.pistol = 999; }, TypeError);
  assert.throws(() => { AMMO_RESERVE_LIMITS.pistol = 999; }, TypeError);
});

test('fists, bats and knives leave the cache and held equipment untouched', () => {
  const ledger = new AmmoSupplyLedger();
  for (const current of ['fists', 'bat', 'knife', 'missing']) {
    const held = weapon(current), before = { ...held };
    assert.equal(take(ledger, held), 0);
    assert.deepEqual(held, before);
    assert.equal(ledger.units(id), AMMO_SUPPLY_UNITS);
  }
});

test('full or richer looted reserves cannot consume supply or lose existing ammunition', () => {
  for (const [type, cap] of Object.entries(AMMO_RESERVE_LIMITS)) {
    for (const reserve of [cap, cap + 1, 999]) {
      const ledger = new AmmoSupplyLedger(), held = weapon(type, reserve), before = { ...held };
      assert.equal(take(ledger, held), 0);
      assert.deepEqual(held, before);
      assert.equal(ledger.units(id), AMMO_SUPPLY_UNITS);
    }
  }
});

test('partial refills conserve integer stock across weapon swaps', () => {
  const ledger = new AmmoSupplyLedger(), pistol = weapon('pistol', 47);
  assert.equal(take(ledger, pistol), 1);
  assert.equal(pistol.reserve, 48);
  assert.equal(ledger.units(id), 115);
  assert.equal(take(ledger, pistol), 0);
  assert.equal(ledger.units(id), 115);
  const smg = weapon('smg');
  assert.equal(take(ledger, smg), 28);
  assert.equal(ledger.units(id), 3);
  assert.equal(take(ledger, weapon('pistol')), 0);
  assert.equal(ledger.units(id), 3);
  assert.equal(take(ledger, weapon('machinegun')), 1);
  assert.equal(ledger.units(id), 0);
});

test('zero acceptance, invalid reports and exceptions never consume cache stock', () => {
  const ledger = new AmmoSupplyLedger(), held = weapon();
  for (const accepted of [0, -1, NaN, Infinity, 0.5, 999]) {
    assert.equal(ledger.take(id, held, () => accepted, { active: true }), 0);
    assert.equal(ledger.units(id), AMMO_SUPPLY_UNITS);
  }
  assert.throws(() => ledger.take(id, held, () => { throw new Error('unavailable'); }, { active: true }));
  assert.equal(ledger.units(id), AMMO_SUPPLY_UNITS);
  assert.equal(ledger.take('missing', held, () => 10, { active: true }), 0);
});

test('a transaction charges the original round type even if a callback mutates its input object', () => {
  const ledger = new AmmoSupplyLedger(), held = weapon();
  assert.equal(ledger.take(id, held, () => { held.current = 'smg'; return 1; }, { active: true }), 1);
  assert.equal(ledger.units(id), 115);
});

test('paused, dead and unspecified sessions cannot take ammunition', () => {
  const ledger = new AmmoSupplyLedger(), held = weapon(), before = { ...held };
  for (const state of [{ active: false }, { active: true, dead: true }, {}]) {
    assert.equal(take(ledger, held, state), 0);
    assert.deepEqual(held, before);
    assert.equal(ledger.units(id), AMMO_SUPPLY_UNITS);
  }
});

test('invalid quantities never become an empty reserve that can accept free ammunition', () => {
  for (const reserve of [-1, NaN, Infinity, 0.1, '0']) assert.equal(ammoSupplyAmount(weapon('pistol', reserve), 120), 0);
  for (const units of [-1, NaN, Infinity, 0.1, '120']) assert.equal(ammoSupplyAmount(weapon(), units), 0);
  assert.equal(ammoSupplyAmount(null, 120), 0);
});

test('snapshots copy and freeze cache state, including a completely empty cache', () => {
  const ledger = new AmmoSupplyLedger(), initial = ledger.snapshot();
  take(ledger, weapon());
  const empty = ledger.snapshot();
  assert.equal(initial.caches[0].remainingUnits, 120);
  assert.equal(empty.caches[0].remainingUnits, 0);
  assert.throws(() => { initial.caches[0].remainingUnits = 0; }, TypeError);
  assert.throws(() => { initial.caches.push({ id: 'another', remainingUnits: 120 }); }, TypeError);
  ledger.reset();
  assert.equal(ledger.restore(empty), true);
  assert.equal(ledger.units(id), 0, 'Zero must not fall back to a full cache');
  assert.equal(ledger.restore(initial), true);
  assert.equal(ledger.units(id), 120);
});

test('malformed or partial snapshots fail atomically without resetting remaining supply', () => {
  const ledger = new AmmoSupplyLedger();
  take(ledger, weapon('pistol', 47));
  const withFirst = entry => ({ version: 1, caches: [entry, ...ledger.snapshot().caches.slice(1)] });
  for (const snapshot of [null, {}, { version: 2, caches: [] }, { version: 1, caches: [] },
    withFirst({ id: 'missing', remainingUnits: 120 }),
    { version: 1, caches: [ledger.snapshot().caches[1], ...ledger.snapshot().caches.slice(1)] },
    ...[-1, 121, NaN, 3.5].map(remainingUnits => withFirst({ id, remainingUnits })),
  ]) {
    assert.equal(ledger.restore(snapshot), false);
    assert.equal(ledger.units(id), 115);
  }
});

test('retry restores cache and exact weapon together without stacking repeated collections', () => {
  const ledger = new AmmoSupplyLedger();
  let held = weapon('pistol', 2, 4);
  const checkpoint = { ...createCheckpoint('balcony', held), ammoSupplies: ledger.snapshot() };
  for (let life = 0; life < 3; life++) {
    assert.equal(take(ledger, held), 24);
    assert.equal(held.reserve, 26);
    assert.equal(held.loaded, 4);
    assert.equal(take(ledger, held), 0, 'A revisit during one life cannot refill the box');
    held.loaded = 0; held.reserve = 0;
    held = { ...checkpoint.weapon };
    assert.equal(ledger.restore(checkpoint.ammoSupplies), true);
    assert.deepEqual(held, { current: 'pistol', loaded: 4, reserve: 2 });
  }
});

test('a later checkpoint includes prior collection, so returning to the balcony cannot duplicate it', () => {
  const ledger = new AmmoSupplyLedger();
  let held = weapon('pistol', 0, 3);
  take(ledger, held);
  const checkpoint = { ...createCheckpoint('stairwell', held), ammoSupplies: ledger.snapshot() };
  held.loaded = 0; held.reserve = 0;
  held = { ...checkpoint.weapon };
  assert.equal(ledger.restore(checkpoint.ammoSupplies), true);
  assert.equal(take(ledger, held), 0);
  assert.deepEqual(held, { current: 'pistol', loaded: 3, reserve: 24 });
  assert.equal(ledger.units(id), 0);
  ledger.reset();
  assert.equal(ledger.units(id), 120, 'Only explicit new-campaign reset replenishes prior supply');
});

test('residual units too small for any round cannot trigger another pickup', () => {
  const ledger = new AmmoSupplyLedger();
  for (const remainingUnits of [1, 2]) {
    ledger.restore({ version: 1, caches: ledger.snapshot().caches.map(entry => entry.id === id ? { id, remainingUnits } : entry) });
    for (const type of Object.keys(AMMO_SUPPLY_LOADS)) assert.equal(take(ledger, weapon(type)), 0);
    assert.equal(ledger.units(id), remainingUnits);
  }
});

test('each floor box owns an independent finite budget and a shared snapshot restores all of them', () => {
  const ledger = new AmmoSupplyLedger();
  const [balcony, west, east] = AMMO_SUPPLY_CACHES;
  const held = weapon('pistol', 47);
  assert.equal(ledger.take(balcony.id, held, acceptInto(held), { active: true }), 1);
  held.reserve = 0;
  assert.equal(ledger.take(west.id, held, acceptInto(held), { active: true }), 24);
  assert.deepEqual(ledger.snapshot().caches.map(entry => entry.remainingUnits), [115, 0, 120]);
  const checkpoint = { ...createCheckpoint('roof', held), ammoSupplies: ledger.snapshot() };
  assert.equal(ledger.take(east.id, held, acceptInto(held), { active: true }), 24);
  assert.deepEqual(ledger.snapshot().caches.map(entry => entry.remainingUnits), [115, 0, 0]);
  assert.equal(ledger.restore(checkpoint.ammoSupplies), true);
  assert.deepEqual(ledger.snapshot().caches.map(entry => entry.remainingUnits), [115, 0, 120]);
  assert.equal(ledger.available(west.id, weapon()), 0, 'Retry cannot refill a box that was already spent at the checkpoint');
  assert.equal(ledger.available(east.id, checkpoint.weapon), 24, 'An uncollected checkpoint box remains available');
  ledger.reset();
  assert.deepEqual(ledger.snapshot().caches.map(entry => entry.remainingUnits), [120, 120, 120]);
});

test('collecting every independent box remains bounded even when the player swaps weapons', () => {
  const ledger = new AmmoSupplyLedger();
  let rounds = 0;
  for (const cache of AMMO_SUPPLY_CACHES) {
    const held = weapon('machinegun', 0, 7);
    rounds += ledger.take(cache.id, held, acceptInto(held), { active: true });
    assert.equal(ledger.take(cache.id, weapon('pistol'), () => 24, { active: true }), 0);
  }
  assert.equal(rounds, AMMO_SUPPLY_CACHES.length * AMMO_SUPPLY_LOADS.machinegun);
  assert.ok(ledger.snapshot().caches.every(entry => entry.remainingUnits === 0));
});

test('mixed purchases stay within one supply budget and cannot exceed the largest full grant', () => {
  let combinations = 0;
  for (let pistol = 0; pistol <= 24; pistol++) for (let shotgun = 0; shotgun <= 6; shotgun++) {
    for (let smg = 0; smg <= 30; smg++) for (let machinegun = 0; machinegun <= 40; machinegun++) {
      const cost = pistol * 5 + shotgun * 20 + smg * 4 + machinegun * 3;
      if (cost > 120) continue;
      combinations++;
      const damage = pistol * WEAPON_DEFS.pistol.dmg + shotgun * WEAPON_DEFS.shotgun.dmg * WEAPON_DEFS.shotgun.pellets
        + smg * WEAPON_DEFS.smg.dmg + machinegun * WEAPON_DEFS.machinegun.dmg;
      assert.ok(damage <= AMMO_SUPPLY_LOADS.machinegun * WEAPON_DEFS.machinegun.dmg);
    }
  }
  assert.equal(combinations, 11911);
});
