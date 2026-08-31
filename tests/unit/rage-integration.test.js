import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createInputState } from '../../src/core/input-state.js';
import { FixedStepClock } from '../../src/core/frame-budget.js';
import { capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { createBallisticHit } from '../../src/core/ballistics.js';
import { lerp, clamp } from '../../src/core/math.js';
import { createRageState } from '../../src/game/rage-rules.js';
import { applyArmorDamage, clampArmor } from '../../src/game/armor-rules.js';
import { createCombatStats } from '../../src/game/combat-stats.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { createFireHazards } from '../../src/game/fire-hazards.js';

const mainSource = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
const missionSource = readFileSync(new URL('../../src/game/mission.js', import.meta.url), 'utf8');
const fireInitialization = missionSource.match(/  FireHazards = createFireHazards\(\{[^]*?\n  \}\);/)?.[0];
assert.ok(fireInitialization, 'Exercise the production fire controller and damage callback wiring');
const playerSource = readFileSync(new URL('../../src/game/player.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '');
assert.doesNotMatch(playerSource, /^import\s|^export\s/m, 'Keep the explicit player fixture bindings current');

function actualFunction(source, name) {
  const result = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(result, `Keep the production function boundary current: ${name}`);
  return result;
}

// Real input, Player, rage, CombatStats, fixed simulation loop and mission
// damage/restart functions. Rendering, audio and unrelated encounter services
// are quiet sinks; attacks can credit a kill at an exact simulation step.
function fixture(options) {
  const Rage = createRageState(options), CombatStats = createCombatStats({ rage: Rage });
  const Input = createInputState(), clock = new FixedStepClock(), GameTime = { elapsed: 0 };
  Input.activate();
  const calls = { health: [], armor: [], rage: [], messages: [], blood: [], attacks: 0, audioTime: [], touchContexts: [] };
  Input.setTouchContext = value => calls.touchContexts.push({ ...value });
  const noop = () => {}, hooks = { attack: noop, enemy: noop, input: noop };
  const conditions = { intro: false, ending: false };
  const checkpointSeed = { zone: 'apartment', branch: null, anchor: { yaw: 0 },
    weapon: { current: 'pistol', loaded: 4, reserve: 12 }, ammoSupplies: { collected: [] } };
  const HUD = {
    setHealth(value) { calls.health.push(value); },
    setArmor(value) { calls.armor.push(value); },
    setRage(value) { calls.rage.push({ ...value }); },
    message(value) { calls.messages.push(value); },
    bloodFlash(value) { calls.blood.push(value); }, showDeath: noop, update: noop,
  };
  const bindings = {
    THREE, lerp, clamp, Rage, CombatStats, Input, clock, GameTime, HUD, applyArmorDamage, clampArmor,
    createFireHazards, WorldState: { fires: [] },
    camera: new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 300),
    Colliders: { list: [new THREE.Box3(new THREE.Vector3(-100, -1, -100), new THREE.Vector3(100, 0, 100))] },
    capsuleHasClearance, moveCapsule, createBallisticHit, Ballistics: { raycast: () => null },
    Settings: { get: key => key === 'reducedMotion' ? false : 1 }, currentZone: 'apartment',
    Audio: { footstep: noop, movement: noop, clearRadio: noop, reset: noop },
    Weapons: {
      current: 'pistol', def() { return WEAPON_DEFS[this.current]; },
      tick(dt) { calls.attacks++; hooks.attack(dt); },
      handleInput(frame, dt) { hooks.input(frame, dt); },
      update: noop, cancelAttack: noop, restore: noop,
    },
    enemiesUpdate(dt) { hooks.enemy(dt); },
    Enemies: { list: [], clearAll: noop },
    WaveDirector: { update: noop, stop: noop, reset: noop, start: noop },
    FireHazards: { update: noop, reset: noop },
    HealPickups: { update: noop, restoreZone: noop },
    ArmorPickups: { update: noop, clearAll: noop, setZone: noop },
    StreetChoice: { update: noop, dismiss: noop, reset: noop, arm: noop },
    Endings: { update: noop, reset: noop, isResolved: () => conditions.ending },
    IntroCard: { isOpen: () => conditions.intro },
    document: { hidden: false }, contextLost: false,
    triggersUpdate: noop, animateFires: noop, animateFlickerLights: noop, animateSmoke: noop,
    updateEnvironment: noop, Blood: { update: noop }, FX: { update: noop },
    ThreatFeedback: { update: noop, clear: noop }, ObjectiveBanner: { update: noop },
    updateNavigation: noop, updateAudioScene: dt => calls.audioTime.push(dt),
    checkpointSeed, getCheckpointStatus: () => ({ valid: true, foot: { x: 0, y: 0, z: 0 } }),
    saveCheckpoint() { assert.fail('This fixture supplies an existing checkpoint'); },
    WeaponDrops: { clearAll: noop }, EndCard: { hide: noop },
    AmmoSupplies: { restore: noop, setZone: noop }, ZoneCull: { setHidden: noop }, zoneChanged: noop,
  };
  const simulation = ['isPlaying', 'syncTouchContext', 'stepFrame'].map(name => actualFunction(mainSource, name)).join('\n');
  const lifecycle = ['applyPlayerDamage', 'playerDie', 'restartFromZone']
    .map(name => actualFunction(missionSource, name)).join('\n');
  const api = runInNewContext(`${playerSource}\nlet hudTimer = 0;\n`
    + 'let checkpoint = checkpointSeed; let restoringCheckpoint = false;\n'
    + `${simulation}\n${lifecycle}\n${fireInitialization}\n`
    + ';({ Player, PlayerState, playerInit, playerUpdate, stepFrame, applyPlayerDamage, playerDie, restartFromZone });',
  bindings, { filename: 'actual-player-main-mission:rage' });
  api.Player.pos.set(0, api.Player.eyeHeight, 0);
  api.playerInit(); calls.health.length = 0;
  return {
    ...api, Rage, CombatStats, Input, clock, GameTime, HUD, calls, hooks, conditions, bindings,
    kills(count = 4) { for (let i = 0; i < count; i++) CombatStats.recordKill(); },
    steps(count = 1) { for (let i = 0; i < count; i++) api.stepFrame(clock.step); },
    pressRage() { Input.keyUp('KeyT'); Input.keyDown('KeyT'); api.stepFrame(clock.step); },
  };
}

test('mission damage consumes armor before health and keeps the HUD and checkpoint retry synchronized', () => {
  const h = fixture();
  assert.equal(h.Player.armor, 0, 'new missions start without armor');
  h.Player.armor = 30;
  h.applyPlayerDamage(20);
  assert.equal(h.Player.armor, 15); assert.equal(h.Player.health, 100);
  h.applyPlayerDamage(40);
  assert.equal(h.Player.armor, 0); assert.equal(h.Player.health, 80);
  assert.equal(h.calls.armor.at(-1), 0); assert.equal(h.calls.health.at(-1), 80);
  h.bindings.checkpointSeed.armor = 62.5;
  let clears = 0;
  h.bindings.ArmorPickups.clearAll = () => clears++;
  h.applyPlayerDamage(100);
  assert.equal(h.PlayerState.dead, true); assert.equal(h.Player.armor, 0);
  h.restartFromZone();
  assert.equal(h.Player.armor, 62.5); assert.equal(h.calls.armor.at(-1), 62.5);
  assert.equal(h.Player.health, 100); assert.equal(clears, 1);
  delete h.bindings.checkpointSeed.armor;
  h.restartFromZone();
  assert.equal(h.Player.armor, 0, 'a checkpoint without armor cannot grant it');
});

function addContactFire(h) {
  h.bindings.WorldState.fires.push({ active: true,
    damageBounds: new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)),
    damageSource: new THREE.Vector3(0, 1, 0),
  });
}

test('production fire damage uses gameplay time, bypasses armor, and stops on exit without changing combat credit', () => {
  const h = fixture(); addContactFire(h);
  h.Player.armor = 75;
  const before = h.CombatStats.snapshot();
  h.steps(Math.round(1 / h.clock.step));
  assert.ok(Math.abs(h.Player.health - 80) < 1e-8);
  assert.equal(h.Player.armor, 75);
  assert.ok(h.calls.blood.length >= 4 && h.calls.blood.length <= 5, 'Contact feedback is throttled, not flashed every tick');
  h.Input.pause(); h.stepFrame(30);
  assert.ok(Math.abs(h.Player.health - 80) < 1e-8, 'Paused wall time cannot burn or accumulate damage');
  h.Input.activate(); h.steps();
  assert.ok(Math.abs(h.Player.health - (80 - 20 * h.clock.step)) < 1e-8);
  h.Player.pos.x = 3;
  const escapedHealth = h.Player.health;
  h.steps(Math.round(1 / h.clock.step));
  assert.equal(h.Player.health, escapedHealth, 'There is no residual burn after leaving');
  assert.deepEqual(h.CombatStats.snapshot(), before);
});

test('lethal fire runs normal death and retry without activating checkpoints or collecting supplies that tick', () => {
  const h = fixture(); addContactFire(h);
  h.Player.health = 0.1; h.Player.armor = 75;
  h.bindings.checkpointSeed.armor = 50;
  h.bindings.triggersUpdate = () => assert.fail('A dead player cannot save a new checkpoint');
  h.bindings.HealPickups.update = () => assert.fail('A dead player cannot collect a health supply');
  h.bindings.StreetChoice.update = () => assert.fail('A dead player cannot commit a final branch');
  h.steps();
  assert.equal(h.PlayerState.dead, true); assert.equal(h.Player.health, 0);
  assert.equal(h.Input.active, false);
  assert.equal(h.bindings.FireHazards.snapshot().touching, false);
  assert.equal(h.stepFrame(5), 0);
  h.bindings.WorldState.fires[0].active = false;
  h.restartFromZone();
  assert.equal(h.PlayerState.dead, false); assert.equal(h.Player.health, 100); assert.equal(h.Player.armor, 50);
  assert.equal(h.bindings.FireHazards.snapshot().touching, false);
});

test('the main loop exposes sights only for a held firearm and refreshes availability after a weapon change', () => {
  const h = fixture();
  h.steps();
  assert.deepEqual(h.calls.touchContexts.at(-1), { canAim: true, canRage: false });
  h.hooks.input = frame => { if (frame.gPressed) h.bindings.Weapons.current = 'fists'; };
  h.Input.touchButton('drop', true);
  h.steps();
  assert.deepEqual(h.calls.touchContexts.at(-1), { canAim: false, canRage: false });
  h.bindings.Weapons.current = 'bat';
  h.steps();
  assert.equal(h.calls.touchContexts.at(-1).canAim, false);
  h.bindings.Weapons.current = 'shotgun';
  h.steps();
  assert.equal(h.calls.touchContexts.at(-1).canAim, true);
  h.PlayerState.dead = true;
  h.stepFrame(0);
  assert.deepEqual(h.calls.touchContexts.at(-1), { canAim: false, canRage: false });
});

test('touch rage availability follows the real controller through entry, healing, expiry, and death', () => {
  // Non-default limits demonstrate that the UI consumes Rage.available;
  // it cannot quietly reproduce the normal health or kill thresholds.
  const h = fixture({ healthThreshold: 0.8, minimumKills: 1, durationSeconds: 0.1, killWindowSeconds: 0.5 });
  h.Player.health = 70;
  h.steps();
  assert.equal(h.calls.touchContexts.at(-1).canRage, false);
  h.kills(1);
  h.steps();
  assert.equal(h.calls.touchContexts.at(-1).canRage, true);
  h.Input.touchButton('rage', true);
  h.steps();
  assert.equal(h.Rage.snapshot(h.Player).active, true);
  assert.equal(h.calls.touchContexts.at(-1).canRage, false);
  h.applyPlayerDamage(60);
  h.steps();
  assert.equal(h.calls.touchContexts.at(-1).canRage, false, 'low health cannot expose rage while already active');
  h.steps(12);
  assert.equal(h.Rage.snapshot(h.Player).active, false);
  assert.equal(h.calls.touchContexts.at(-1).canRage, true, 'expiration restores current eligibility');
  h.Player.health = 90;
  h.steps();
  assert.equal(h.calls.touchContexts.at(-1).canRage, false, 'healing removes eligibility');
  h.Player.health = 70;
  h.steps(60);
  assert.equal(h.calls.touchContexts.at(-1).canRage, false, 'old kills stop offering rage');
  h.kills(1);
  h.steps();
  assert.equal(h.calls.touchContexts.at(-1).canRage, true);
  h.applyPlayerDamage(100);
  h.stepFrame(0);
  assert.deepEqual(h.calls.touchContexts.at(-1), { canAim: false, canRage: false });
  h.restartFromZone();
  h.stepFrame(0);
  assert.equal(h.calls.touchContexts.at(-1).canRage, false, 'checkpoint restoration cannot retain prior eligibility');
});

test('the real T input and Player controller require a fresh eligible press and cannot stack held rage', () => {
  const h = fixture(); h.Player.health = 10; h.kills(3);
  h.pressRage();
  assert.equal(h.Player.health, 10);
  assert.equal(h.Rage.snapshot(h.Player).active, false);
  h.kills(1); h.steps();
  assert.equal(h.Player.health, 10, 'a newly available action does not trigger from the old held key');
  h.pressRage();
  assert.equal(h.Player.health, 20);
  assert.equal(h.calls.health.at(-1), 20);
  assert.equal(h.calls.rage.at(-1).active, true);
  h.steps(1200);
  assert.equal(h.Player.health, 10, 'holding T cannot re-enter after expiration');
  assert.equal(h.Rage.snapshot(h.Player).active, false);
  h.pressRage();
  assert.equal(h.Player.health, 20, 'a fresh press can use the still-recent kills');
  assert.equal(h.Rage.snapshot(h.Player).active, true);
});

test('a controller D-pad up edge activates rage through the same Player path', () => {
  const h = fixture(); h.Player.health = 22; h.kills();
  const pad = { connected: true, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: index === 12, value: index === 12 ? 1 : 0 })) };
  h.Input.setGamepad(pad); h.steps();
  assert.equal(h.Player.health, 44);
  assert.equal(h.calls.rage.at(-1).active, true);
  assert.equal(h.calls.rage.at(-1).gamepad, true);
  h.Input.setGamepad(pad); h.steps();
  assert.equal(h.Player.health, 44);
});

test('the actual gameplay loop freezes rage and kill age across every paused state', () => {
  for (const pause of [
    h => { h.Input.pause(); return () => h.Input.activate(); },
    h => { h.bindings.document.hidden = true; return () => { h.bindings.document.hidden = false; }; },
    h => { h.conditions.intro = true; return () => { h.conditions.intro = false; }; },
    h => { h.conditions.ending = true; return () => { h.conditions.ending = false; }; },
    h => { h.bindings.contextLost = true; return () => { h.bindings.contextLost = false; }; },
  ]) {
    const h = fixture({ killWindowSeconds: 1 }); h.Player.health = 20; h.kills(); h.pressRage();
    h.steps(30);
    const before = h.Rage.snapshot(h.Player), elapsed = h.GameTime.elapsed, attacks = h.calls.attacks;
    const resume = pause(h);
    assert.equal(h.stepFrame(180), 0);
    assert.deepEqual(h.Rage.snapshot(h.Player), before);
    assert.equal(h.GameTime.elapsed, elapsed);
    assert.equal(h.calls.attacks, attacks);
    resume(); h.steps();
    assert.equal(h.Rage.snapshot(h.Player).recentKills, 4, 'paused time does not age credited kills');
    assert.ok(Math.abs(h.GameTime.elapsed - elapsed - h.clock.step) < 1e-9, 'no wall-time catch-up');
    assert.ok(h.Rage.snapshot(h.Player).remaining < before.remaining);
    assert.equal(h.Player.health, 40);
  }
});

test('an attack kill just before the deadline secures remaining health and emits one HUD outcome', () => {
  const h = fixture(); h.Player.health = 20; h.kills(); h.pressRage();
  h.applyPlayerDamage(13);
  h.steps(1198);
  h.hooks.attack = () => { h.CombatStats.recordKill(); h.hooks.attack = () => {}; };
  h.steps();
  assert.equal(h.Player.health, 27);
  assert.equal(h.Rage.snapshot(h.Player).active, false);
  assert.equal(h.calls.messages.filter(value => value.startsWith('RAGE SECURED')).length, 1);
  h.steps(120);
  assert.equal(h.Player.health, 27);
  assert.equal(h.calls.messages.filter(value => value.startsWith('RAGE SECURED')).length, 1);
  assert.equal(h.calls.messages.some(value => value.startsWith('RAGE ENDED')), false);
});

test('the loop expires rage before an attack at exactly ten seconds and synchronizes health to the HUD', () => {
  const h = fixture(); h.Player.health = 20; h.kills(); h.pressRage();
  h.steps(1199);
  assert.equal(h.Player.health, 40);
  let healthAtAttack;
  h.hooks.attack = () => { healthAtAttack = h.Player.health; h.CombatStats.recordKill(); };
  h.steps();
  assert.equal(healthAtAttack, 20, 'attacks see the expired state at the boundary');
  assert.equal(h.Player.health, 20);
  assert.equal(h.calls.health.at(-1), 20);
  assert.equal(h.calls.rage.at(-1).active, false);
  assert.equal(h.calls.messages.filter(value => value.startsWith('RAGE ENDED')).length, 1);
  assert.equal(h.calls.messages.some(value => value.startsWith('RAGE SECURED')), false);
});

test('a firing input can secure rage during the same step as its activation', () => {
  const h = fixture(); h.Player.health = 20; h.kills();
  h.hooks.input = frame => { if (frame.leftPressed) h.CombatStats.recordKill(); };
  h.Input.keyDown('KeyT'); h.Input.keyDown('KeyJ'); h.steps();
  assert.equal(h.Player.health, 40);
  assert.equal(h.Rage.snapshot(h.Player).active, false);
  assert.equal(h.calls.messages.filter(value => value.startsWith('RAGE SECURED')).length, 1);
});

test('actual lethal damage clears rage immediately and a dead simulation cannot restore health', () => {
  const h = fixture(); h.Player.health = 20; h.kills(); h.pressRage();
  h.applyPlayerDamage(100);
  assert.equal(h.PlayerState.dead, true);
  assert.equal(h.Player.health, 0);
  assert.equal(h.Input.active, false);
  assert.deepEqual(h.Rage.snapshot(h.Player), { available: false, active: false, remaining: 0, recentKills: 0 });
  assert.deepEqual(h.calls.rage.at(-1), {});
  assert.equal(h.stepFrame(60), 0);
  assert.equal(h.Player.health, 0);
  assert.equal(h.Rage.takeOutcome(), null);
});

test('actual checkpoint restoration clears both active and secured rage and cannot reuse previous kills', () => {
  for (const secured of [false, true]) {
    const h = fixture(); h.Player.health = 20; h.kills(); h.pressRage();
    if (secured) h.CombatStats.recordKill();
    assert.equal(h.restartFromZone(), true);
    assert.equal(h.Player.health, 100);
    assert.equal(h.PlayerState.dead, false);
    assert.equal(h.Rage.takeOutcome(), null);
    assert.deepEqual(h.Rage.snapshot(h.Player), { available: false, active: false, remaining: 0, recentKills: 0 });
    assert.deepEqual(h.calls.rage.at(-1), {});
    h.Player.health = 20; h.pressRage();
    assert.equal(h.Player.health, 20);
    assert.equal(h.Rage.snapshot(h.Player).active, false);
  }
});
