import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createOffscreenThreatTracker } from '../../src/game/offscreen-threats.js';

const adapterSource = readFileSync(new URL('../../src/game/threat-feedback.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, match => match.replace(/[^\n]/g, ''))
  .replace(/^export (?=function\b|const\b)/gm, '');
assert.doesNotMatch(adapterSource, /^import\s|^export\s/m, 'Keep the explicit runtime adapter harness current');
const missionSource = readFileSync(new URL('../../src/game/mission.js', import.meta.url), 'utf8');
function actualMissionFunction(name) {
  const source = missionSource.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(source, `Missing actual mission function ${name}`);
  return source;
}

const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected} by more than ${tolerance}`);
const enemy = (changes = {}) => ({
  pos: new THREE.Vector3(0, 0, 5), height: 1.8, radius: 0.3, alive: true, removed: false,
  state: 'attack', staggerTime: 0, spawnGrace: 0, windupRemaining: 0.2, burstLeft: 0, attackTimer: 0,
  ...changes,
});

// Execute the actual adapter with a real camera and tracker. Only presentation
// sinks are replaced: no DOM, renderer, event loop or audio device is involved.
function feedbackHarness() {
  const camera = new THREE.PerspectiveCamera(80, 16 / 9, 0.05, 1000);
  camera.position.set(0, 1.72, 0); camera.rotation.order = 'YXZ';
  const PlayerState = { dead: false };
  const Player = { pos: new THREE.Vector3(0, 1.72, 0), health: 100, yaw: 0, pitch: 0, eyeHeight: 1.72 };
  const calls = { threats: [], health: [], blood: [], directions: [], hitSources: [], lifecycle: [] };
  const record = name => (...args) => { calls.lifecycle.push([name, ...args]); };
  const HUD = {
    setOffscreenThreat(value) { calls.threats.push(value ? { ...value } : null); },
    setHealth(value) { calls.health.push(value); },
    bloodFlash(value) { calls.blood.push(value); },
    damageDirection(value) { calls.directions.push(value); },
    showDeath: record('showDeath'), message: record('message'),
  };
  const api = runInNewContext(`${adapterSource}\n;({ readThreatView, ThreatFeedback });`,
    { camera, PlayerState, HUD, createOffscreenThreatTracker }, { filename: 'src/game/threat-feedback.js' });
  const actualHit = api.ThreatFeedback.hit;
  api.ThreatFeedback.hit = function(source) {
    calls.hitSources.push(source);
    return actualHit.call(this, source);
  };
  const actualClear = api.ThreatFeedback.clear;
  api.ThreatFeedback.clear = function() {
    calls.lifecycle.push(['threatClear']);
    return actualClear.call(this);
  };
  return { ...api, camera, PlayerState, Player, HUD, calls, record,
    lastThreat: () => calls.threats.at(-1),
    update(dt = 0, enemies = []) {
      camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      api.ThreatFeedback.update(dt, enemies);
      return calls.threats.at(-1);
    },
  };
}

// These three functions run verbatim. Checkpoint validation and the surrounding
// mission systems are explicit sinks, so tests isolate their damage/reset calls
// without replacing the threat adapter or its timing/visibility behavior.
function missionHarness() {
  const h = feedbackHarness(), { record } = h;
  const checkpoint = {
    zone: 'apartment', branch: null, anchor: { x: -9, y: 4, z: -4, yaw: 0.35 },
    weapon: { id: 'fists' }, ammoSupplies: { collected: [] },
  };
  const checkpointStatus = { valid: true, foot: { x: -9, y: 4, z: -4 } };
  const bindings = {
    ...h, checkpointSeed: checkpoint, checkpointStatus,
    getCheckpointStatus: () => checkpointStatus,
    saveCheckpoint() { throw new Error('The fixture already provides a saved checkpoint'); },
    WaveDirector: { stop: record('waveStop'), reset: record('waveReset'), start: record('waveStart') },
    Endings: { reset: record('endingsReset') },
    StreetChoice: { dismiss: record('choiceDismiss'), reset: record('choiceReset'), arm: record('choiceArm'),
      commitCar: record('carCommit'), commitBakery: record('bakeryCommit') },
    Enemies: { clearAll: record('enemiesClear') }, WeaponDrops: { clearAll: record('dropsClear') },
    Input: { pause: record('pause'), reset: record('inputReset') }, EndCard: { hide: record('endCardHide') },
    Audio: { clearRadio: record('radioClear'), reset: record('audioReset') },
    Weapons: { cancelAttack: record('cancelAttack'), restore: record('weaponRestore') },
    AmmoSupplies: { restore: record('ammoRestore'), setZone: record('ammoZone') },
    HealPickups: { restoreZone: record('healRestore') }, ZoneCull: { setHidden: record('zoneCull') },
    zoneChanged: record('zoneChanged'), resetPlayerMotion: record('motionReset'),
  };
  const source = ['applyPlayerDamage', 'playerDie', 'restartFromZone'].map(actualMissionFunction).join('\n');
  const api = runInNewContext(`let checkpoint = checkpointSeed; let restoringCheckpoint = false;\n${source}\n`
    + ';({ applyPlayerDamage, playerDie, restartFromZone });', bindings, { filename: 'src/game/mission.js:damage-lifecycle' });
  return { ...h, ...api, checkpoint, checkpointStatus };
}

test('readThreatView reuses the actual camera position and refreshes every projection field', () => {
  const h = feedbackHarness(), first = h.readThreatView();
  assert.equal(first.position, h.camera.position);
  h.camera.position.set(4, 5.2, -8); h.camera.rotation.set(0.8, -1.4, 0, 'YXZ');
  h.camera.fov = 54; h.camera.aspect = 0.55; h.camera.zoom = 1.6;
  h.update(0);
  const refreshed = h.readThreatView();
  assert.equal(refreshed, first, 'The runtime view object remains reusable');
  assert.equal(refreshed.position, h.camera.position);
  assert.deepEqual(refreshed.position.toArray(), [4, 5.2, -8]);
  near(refreshed.yaw, -1.4); near(refreshed.pitch, 0.8);
  near(refreshed.fov, 54); near(refreshed.aspect, 0.55); near(refreshed.zoom, 1.6);
});

test('adapter updates use current aspect, aim FOV and zoom rather than cached defaults', () => {
  const h = feedbackHarness(), source = enemy({ pos: new THREE.Vector3(3, 0, -3) });
  assert.equal(h.update(0, [source]), null, 'Wide view includes the actor');
  h.camera.aspect = 0.5;
  assert.equal(h.update(0, [source]).direction, 'RIGHT', 'Portrait view clips the actor');
  h.camera.aspect = 16 / 9; h.camera.zoom = 2;
  assert.equal(h.update(0, [source]).direction, 'RIGHT', 'Zoom narrows the real view');
  h.camera.fov = 100;
  assert.equal(h.update(0, [source]), null, 'A changed camera FOV is read on the next update');
});

test('adapter uses camera yaw, steep pitch and eye motion including the partially visible body', () => {
  const h = feedbackHarness(), source = enemy();
  assert.equal(h.update(0, [source]).direction, 'BEHIND');
  h.camera.rotation.y = Math.PI;
  assert.equal(h.update(0, [source]), null, 'Turning the actual camera suppresses the rear cue');
  h.camera.rotation.set(80 * Math.PI / 180, 0, 0, 'YXZ');
  source.pos.set(0, 0, -1);
  assert.equal(h.update(0, [source]).direction, 'BELOW');
  h.camera.rotation.set(-80 * Math.PI / 180, 0, 0, 'YXZ'); source.pos.y = 3.5;
  assert.equal(h.update(0, [source]).direction, 'ABOVE');
  h.camera.rotation.set(0, 0, 0, 'YXZ'); h.camera.position.y = 0.9; h.camera.aspect = 1;
  source.pos.set(0, 0, -0.65);
  assert.equal(h.update(0, [source]), null, 'A close body fills the frame even with every corner outside');
  h.camera.position.y = 3;
  assert.equal(h.update(0, [source]).direction, 'BELOW', 'Camera bob/step eye displacement is not replaced by Player.pos');
  assert.equal(h.Player.pos.y, 1.72);
});

test('real adapter detects current windups, the contact boundary and active bursts', () => {
  const h = feedbackHarness(), source = enemy();
  for (const [windupRemaining, burstLeft] of [[0.4, 0], [0, 0], [-1, 2]]) {
    Object.assign(source, { windupRemaining, burstLeft });
    assert.deepEqual(h.update(0, [source]), { angle: Math.PI, direction: 'BEHIND', phase: 'windup', count: 1 });
  }
  source.windupRemaining = -1; source.burstLeft = 0; source.attackTimer = 0.8;
  assert.equal(h.update(0, [source]), null, 'A cooldown timer is not an attack windup');
});

test('idle, cooldown, stagger, spawn grace, dead, removed and visible actors create no active cue', () => {
  const h = feedbackHarness();
  for (const [name, changes] of [
    ['idle', { state: 'idle' }], ['chase', { state: 'chase' }],
    ['cooldown', { windupRemaining: -1, burstLeft: 0, attackTimer: 1 }],
    ['stagger state', { state: 'stagger' }], ['stagger timer', { staggerTime: 0.2 }],
    ['spawn grace', { spawnGrace: 0.2 }], ['dead', { alive: false }],
    ['removed', { removed: true }], ['visible', { pos: new THREE.Vector3(0, 0, -5) }],
  ]) assert.equal(h.update(0, [enemy(changes)]), null, name);
});

test('one live actor remains one threat when it both hits and continues its windup', () => {
  const h = feedbackHarness(), source = enemy(), nearby = enemy({ pos: new THREE.Vector3(5, 0, -1) });
  h.ThreatFeedback.hit(source);
  assert.deepEqual(h.update(0, [source, source, nearby, nearby]),
    { angle: Math.PI, direction: 'BEHIND', phase: 'hit', count: 2 });
  source.windupRemaining = -1;
  assert.equal(h.update(0, [nearby]).phase, 'hit', 'A real recent hit can linger during the attacker cooldown');
  assert.equal(h.update(1.1, [nearby]).direction, 'RIGHT', 'When the hit expires, the active attack takes priority');
});

test('movement and turning acknowledge hits so old cues cannot reappear after looking away', () => {
  const h = feedbackHarness(), source = enemy({ windupRemaining: -1 });
  h.ThreatFeedback.hit(source); assert.equal(h.update(0).direction, 'BEHIND');
  source.pos.set(-8, 0, -2);
  assert.equal(h.update(0).direction, 'LEFT', 'Hit tracking follows the original live object');
  source.pos.set(0, 0, -5);
  assert.equal(h.update(0), null, 'Moving into the rendered frame acknowledges the hit');
  source.pos.set(0, 0, 5);
  assert.equal(h.update(0), null);
  h.ThreatFeedback.hit(source); h.camera.rotation.y = Math.PI;
  assert.equal(h.update(0), null, 'Turning also acknowledges a newly received hit');
  h.camera.rotation.y = 0;
  assert.equal(h.update(0), null);
});

test('dead or removed source identities cannot leave a recent-hit warning behind', () => {
  const h = feedbackHarness();
  for (const flag of ['alive', 'removed']) {
    const source = enemy(); h.ThreatFeedback.hit(source);
    assert.equal(h.update(0, [source]).phase, 'hit');
    source[flag] = flag === 'alive' ? false : true;
    assert.equal(h.update(0, [source]), null);
    source.alive = true; source.removed = false; source.windupRemaining = -1;
    assert.equal(h.update(0, [source]), null, 'Reusing the actor cannot restore cleared damage history');
  }
});

test('adapter clear and player death clear both active and retained cues; dead players cannot record new hits', () => {
  const h = feedbackHarness(), source = enemy();
  h.ThreatFeedback.hit(source); h.update(0, [source]); h.ThreatFeedback.clear();
  assert.equal(h.lastThreat(), null); assert.equal(h.update(0), null);
  h.ThreatFeedback.hit(source); h.update(0);
  h.PlayerState.dead = true;
  assert.equal(h.update(0, [source]), null);
  h.ThreatFeedback.hit(source);
  h.PlayerState.dead = false;
  assert.equal(h.update(0), null, 'A dead-player hit must not survive respawn');
  assert.ok(h.calls.lifecycle.filter(([name]) => name === 'threatClear').length >= 2);
});

test('paused adapter updates keep hit lifetime frozen while active lists remain current', () => {
  const h = feedbackHarness(), source = enemy({ windupRemaining: -1 });
  h.ThreatFeedback.hit(source); assert.equal(h.update(1).phase, 'hit');
  for (let frame = 0; frame < 240; frame++) assert.equal(h.update(0).phase, 'hit');
  assert.equal(h.update(0.1), null);
  source.windupRemaining = 0.2;
  assert.equal(h.update(0, [source]).phase, 'windup');
  assert.equal(h.update(0), null, 'The scratch attack list is emptied on every call');
});

test('actual damage keeps health, blood and legacy angle while retaining the third attacker identity', () => {
  const h = missionHarness(), source = enemy();
  h.Player.pos.set(0, 1.72, 0); h.Player.yaw = 0.35;
  h.applyPlayerDamage(9, source.pos, source);
  assert.equal(h.Player.health, 91); assert.deepEqual(h.calls.health, [91]);
  near(h.calls.blood[0], 0.71);
  near(h.calls.directions[0], Math.atan2(source.pos.x - h.Player.pos.x, -(source.pos.z - h.Player.pos.z)) + h.Player.yaw);
  assert.equal(h.calls.hitSources[0], source, 'The original enemy object reaches the real tracker');
  assert.deepEqual(h.update(0, [source]), { angle: Math.PI, direction: 'BEHIND', phase: 'hit', count: 1 },
    'Damage identity and active attacker are not counted twice');
});

test('legacy positional damage and source-free damage still work without an attacker object', () => {
  const h = missionHarness(), source = new THREE.Vector3(0, 0, 5);
  delete h.HUD.damageDirection;
  assert.doesNotThrow(() => h.applyPlayerDamage(5, source));
  assert.equal(h.Player.health, 95); near(h.calls.blood[0], 0.55);
  const fallback = h.calls.hitSources[0];
  assert.deepEqual({ ...fallback.pos }, { x: 0, y: 0, z: 5 });
  assert.equal(fallback.height, 1.8); assert.equal(fallback.radius, 0.35);
  assert.equal(h.update(0).phase, 'hit');
  h.ThreatFeedback.clear(); h.applyPlayerDamage(7);
  assert.equal(h.Player.health, 88);
  assert.equal(h.calls.hitSources.length, 1, 'Source-free damage invents no direction or actor');
  assert.equal(h.update(0), null);
});

test('invalid damage and damage after death leave health and all feedback unchanged', () => {
  const h = missionHarness(), source = enemy();
  for (const amount of [0, -2, NaN, Infinity, -Infinity, undefined]) h.applyPlayerDamage(amount, source.pos, source);
  assert.equal(h.Player.health, 100);
  assert.equal(h.calls.health.length, 0); assert.equal(h.calls.blood.length, 0);
  assert.equal(h.calls.directions.length, 0); assert.equal(h.calls.hitSources.length, 0);
  h.PlayerState.dead = true; h.applyPlayerDamage(20, source.pos, source);
  assert.equal(h.Player.health, 100); assert.equal(h.calls.hitSources.length, 0);
});

test('actual lethal damage clears its just-recorded threat immediately and death is idempotent', () => {
  const h = missionHarness(), source = enemy(); h.Player.health = 7;
  h.applyPlayerDamage(30, source.pos, source);
  assert.equal(h.Player.health, 0); assert.equal(h.PlayerState.dead, true);
  assert.deepEqual(h.calls.health, [0, 0]); near(h.calls.blood[0], 1);
  assert.equal(h.calls.hitSources[0], source);
  assert.equal(h.lastThreat(), null, 'playerDie clears the cue without waiting for another frame');
  const lifecycleCount = h.calls.lifecycle.length;
  h.playerDie(); h.applyPlayerDamage(9, source.pos, source);
  assert.equal(h.calls.lifecycle.length, lifecycleCount, 'Repeated death or postmortem damage adds no feedback');
  for (const name of ['cancelAttack', 'waveStop', 'choiceDismiss', 'threatClear']) {
    assert.ok(h.calls.lifecycle.some(([event]) => event === name), name);
  }
  const pause = h.calls.lifecycle.find(([name]) => name === 'pause');
  assert.equal(pause[1].showOverlay, false);
  const events = h.calls.lifecycle.map(([name]) => name);
  assert.equal(events.filter(name => name === 'radioClear').length, 1);
  assert.ok(events.indexOf('pause') < events.indexOf('radioClear'), 'Death pauses input before cancelling checkpoint radio');
  h.PlayerState.dead = false;
  assert.equal(h.update(0), null, 'The lethal hit cannot return when play resumes');
});

test('actual checkpoint restart clears threat state before resuming the restored player', () => {
  const h = missionHarness(), source = enemy();
  h.ThreatFeedback.hit(source); assert.equal(h.update(0.5, [source]).phase, 'hit');
  h.PlayerState.dead = true; h.Player.health = 0;
  assert.equal(h.restartFromZone(), true);
  assert.equal(h.PlayerState.dead, false); assert.equal(h.Player.health, 100);
  assert.equal(h.lastThreat(), null); assert.equal(h.update(0), null);
  assert.deepEqual(h.Player.pos.toArray(), [-9, 5.72, -4]); near(h.Player.yaw, 0.35);
  const events = h.calls.lifecycle.map(([name]) => name);
  assert.ok(events.indexOf('threatClear') < events.indexOf('waveStart'), 'Old cues are cleared before the new encounter starts');
  assert.equal(events.filter(name => name === 'audioReset').length, 1);
  assert.ok(events.indexOf('audioReset') < events.indexOf('zoneChanged'),
    'Successful retry drops old audio and cue history before announcing the restored checkpoint');
  assert.ok(events.includes('enemiesClear') && events.includes('inputReset'));
  assert.equal(h.calls.health.at(-1), 100);
  h.ThreatFeedback.hit(source);
  assert.equal(h.update(1).phase, 'hit', 'A new hit gets a full lifetime after restart');
  assert.equal(h.update(0.1), null);
});

test('a blocked checkpoint does not execute the successful restart feedback path', () => {
  const h = missionHarness(); h.checkpointStatus.valid = false;
  h.PlayerState.dead = true; h.Player.health = 0;
  assert.equal(h.restartFromZone(), false);
  assert.equal(h.PlayerState.dead, true); assert.equal(h.Player.health, 0);
  assert.equal(h.calls.lifecycle.some(([name]) => name === 'threatClear'), false);
  assert.equal(h.calls.lifecycle.some(([name]) => name === 'audioReset'), false);
  assert.ok(h.calls.lifecycle.some(([name, text]) => name === 'message' && text.includes('CHECKPOINT BLOCKED')));
});
