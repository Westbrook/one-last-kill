import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { Colliders, capsuleHasClearance } from '../../src/core/collision.js';
import { createEncounterSeedSource } from '../../src/game/encounter-session.js';
import { EncounterSchedule, EncounterRouteProgress } from '../../src/game/encounter-rules.js';
import { selectEncounterSpawn, selectEncounterFrontPair } from '../../src/game/encounter-spawns.js';
import { CHECKPOINTS, ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS, createCheckpoint } from '../../src/game/mission-data.js';
import { isSegmentOccluded } from '../../src/game/combat-rules.js';
import { describeOffscreenThreat } from '../../src/game/offscreen-threats.js';
import { hasPairBearingSeparation } from '../../src/game/rear-encounter-rules.js';
import { humanoidDimensions } from '../../src/render/humanoid-rig.js';
import { Architecture } from '../../src/world/architecture.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

const STEP = 1 / 120;
const SEEDS = [0, 1, 72, 74, 100, 0x71e6b20d, 0xdeadbeef, 0xffffffff];
const near = (actual, expected, message = 'Values agree', tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, message + ': ' + actual + ' versus ' + expected);
const noOp = () => {};
const source = readFileSync(new URL('../../src/game/mission.js', import.meta.url), 'utf8');
function actualFunction(name) {
  const result = source.match(new RegExp('^function ' + name + '\\([^]*?^\\}', 'm'))?.[0];
  assert.ok(result, 'Keep the actual mission function fixture current: ' + name);
  return result;
}
const spawnStart = source.indexOf('function playerFootPosition()');
const spawnEnd = source.indexOf('\nfunction handleZoneChange(', spawnStart);
const endingStart = source.indexOf('const Endings = (() => {');
const endingEnd = source.indexOf('\nfunction initMission()', endingStart);
assert.ok(spawnStart >= 0 && spawnEnd > spawnStart && endingStart >= 0 && endingEnd > endingStart);

// Full authored geometry, ballistic cover, pool ownership and AI movement are
// real. GPU/rig presentation, audio, input and HUD are explicit quiet sinks.
// Scripted deaths below are fixture damage, never simulated player kill credit.
const ai = createEnemyAIHarness(), messages = [], checkpointCalls = [];
const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 220);
let entropyCalls = 0, weapon = { current: 'fists', loaded: 0, reserve: 0 };
const seeds = createEncounterSeedSource({
  fillRandom(values) { entropyCalls++; values[0] = 12345; return values; },
  clock() { throw new Error('The deterministic entropy fixture must not need a clock'); },
});
seeds.setOverride(null);
Object.assign(ai.player, { eyeHeight: 1.72, bodyHeight: 1.84, vel: new THREE.Vector3(), yaw: 0, pitch: 0, onGround: true });
ai.playerState.lastZoneSpawn = { pos: new THREE.Vector3(), yaw: 0 };
const readThreatView = () => ({ position: camera.position, yaw: camera.rotation.y, pitch: camera.rotation.x,
  fov: camera.fov, aspect: camera.aspect, zoom: camera.zoom });
let mission;
const bindings = {
  THREE, camera, Architecture, Colliders, capsuleHasClearance, EncounterSeeds: seeds,
  Player: ai.player, PlayerState: ai.playerState, Enemies: ai.Enemies,
  surfaceTopAt: ai.surfaceTopAt, isBlocked: ai.isBlocked, primeEnemyInvestigation: ai.primeEnemyInvestigation,
  EncounterSchedule, EncounterRouteProgress, selectEncounterSpawn, selectEncounterFrontPair,
  isSegmentOccluded, readThreatView, CHECKPOINTS, ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS, createCheckpoint, DISTRICT,
  currentZone: 'apartment',
  Weapons: { snapshot: () => ({ ...weapon }), restore(value) { weapon = { ...value }; } },
  AmmoSupplies: ai.supplies, HealPickups: { setZone: noOp, restoreZone: noOp },
  WeaponDrops: { clearAll: noOp }, Input: { reset: noOp }, Audio: { reset: noOp },
  ThreatFeedback: { clear: noOp }, ZoneCull: { setHidden: noOp },
  HUD: { setHealth: noOp, setObjective: noOp, showDeath: noOp, message: (...values) => messages.push(values) },
  EndCard: { hide: noOp, show: noOp }, ObjectiveBanner: { show: noOp },
  StreetChoice: {
    reset: noOp, dismiss: noOp, arm: noOp, isPresented: () => false,
    isCommitted: () => mission.Endings.isCommitted(), getDelay: () => null,
    commitCar: () => mission.Endings.beginCar(), commitBakery: () => mission.Endings.beginBakery(),
  },
  zoneChanged(zone) { bindings.currentZone = zone; checkpointCalls.push(zone); },
  resetPlayerMotion() { ai.player.vel.set(0, 0, 0); ai.player._eyeH = ai.player.eyeHeight; ai.player.onGround = true; },
};
mission = runInNewContext('let checkpoint = null, restoringCheckpoint = false; const initialized = true;\n'
  + 'const spawnCursors = new Map(); const routePlayerFoot = {x:0,y:0,z:0};\n'
  + ['saveCheckpoint', 'getCheckpointStatus', 'restartFromZone'].map(actualFunction).join('\n')
  + '\n' + source.slice(spawnStart, spawnEnd) + '\n' + source.slice(endingStart, endingEnd)
  + '\n' + actualFunction('getMissionState')
  + '\n;({WaveDirector,Endings,spawnScheduled,spawnCursors,pickSafeSpawn,spawnConcealed,'
  + 'saveCheckpoint,restartFromZone,getMissionState});', bindings, { filename: 'src/game/mission.js:seeded-runtime' });

function place(point, yaw = point.yaw ?? Math.PI / 2) {
  ai.placePlayer({ x: point.x, y: point.y + 0.02, z: point.z });
  ai.player.yaw = yaw; ai.player.pitch = 0; ai.player.onGround = true;
  camera.position.copy(ai.player.pos); camera.rotation.set(0, yaw, 0, 'YXZ'); camera.updateMatrixWorld(true);
}
function reset(seed, zone = 'balcony', point = CHECKPOINTS[zone], yaw = point.yaw) {
  mission.Endings.reset(); mission.WaveDirector.reset(); ai.reset();
  seeds.setOverride(seed); messages.length = 0; checkpointCalls.length = 0;
  weapon = { current: 'fists', loaded: 0, reserve: 0 };
  bindings.currentZone = zone; ai.player.health = 100;
  place(point, yaw); mission.WaveDirector.start(zone); mission.saveCheckpoint(zone);
}
const living = () => Array.from(ai.Enemies.list).filter(enemy => enemy.alive);
function defeat(predicate = () => true) {
  for (const enemy of living().filter(predicate)) {
    assert.equal(ai.damageEnemy(enemy, enemy.health, 'body', enemy.pos.clone()).killed, true);
  }
}
function step(capture = noOp, moveActors = true) {
  if (moveActors) ai.step(STEP); else ai.clock.elapsed += STEP;
  mission.WaveDirector.update(STEP); mission.Endings.update(STEP);
  capture();
}
function until(predicate, seconds, capture = noOp, moveActors = true) {
  for (let tick = 0; tick < Math.ceil(seconds / STEP) && !predicate(); tick++) step(capture, moveActors);
  assert.ok(predicate(), 'Bounded encounter progress: ' + JSON.stringify(mission.getMissionState().wave));
}
function advance(seconds, capture = noOp, moveActors = true) {
  for (let tick = 0; tick < Math.ceil(seconds / STEP); tick++) step(capture, moveActors);
}
function birthRecorder(zone) {
  const config = ZONE_WAVE_CONFIG[zone], births = new Map();
  function capture() {
    const alive = living(), added = new Set(alive.filter(enemy => !births.has(enemy)));
    assert.ok(alive.length <= config.maxAlive);
    if (config.maxRearAlive) assert.ok(alive.filter(enemy => enemy.arrivalRole === 'rear').length <= config.maxRearAlive);
    for (const enemy of added) {
      assert.equal(enemy.encounterKey, zone);
      assert.equal(enemy.authoredType, config.waves[enemy.encounterWave][enemy.encounterEntry]);
      assert.equal(enemy.poolSlot.owner, enemy);
      assert.ok(Math.hypot(enemy.pos.x - ai.player.pos.x, enemy.pos.z - ai.player.pos.z) >= 5 - 1e-8);
      assert.equal(capsuleHasClearance(enemy.pos, 0.48, 2.02, ai.colliders, 1e-8), true,
        'The complete director envelope must fit, including seeds whose offsets need the original-anchor fallback');
      assert.equal(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, ai.colliders, 1e-8), true);
      near(enemy.pos.y - ai.surfaceTopAt(enemy.pos.x, enemy.pos.y, enemy.pos.z), 0.03);
      if (config.frontPairSize === 2 && enemy.encounterEntry < 2) {
        const pair = alive.filter(other => other.encounterWave === enemy.encounterWave && other.encounterEntry < 2);
        assert.deepEqual(pair.map(other => other.encounterEntry).sort(), [0, 1]);
        assert.ok(pair.every(other => added.has(other) && other.arrivalRole === 'front' && other.arrivalSide === 'front'));
        assert.equal(hasPairBearingSeparation(ai.player.pos, pair[0].pos, pair[1].pos), true);
        // The real rig's neutral head dimensions give an independent readable
        // head target even though this CPU AI fixture stubs GPU rig creation.
        const d = humanoidDimensions(enemy.def.visual);
        const head = enemy.pos.clone(); head.y += d.height - d.headHeight * 0.5;
        const projected = head.clone().project(camera);
        assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && projected.z >= -1 && projected.z <= 1,
          'Both front heads remain inside the real camera projection');
        assert.equal(ai.ballistics.segmentOccluded(camera.position, head, 'sight'), false,
          'A seeded pair cannot substitute a head concealed behind the balcony corner');
      }
      if (enemy.arrivalRole === 'rear') {
        near(enemy.spawnGrace, 1);
        assert.equal(enemy.lastSeenPlayer, true);
        const projected = describeOffscreenThreat(readThreatView(), { pos: enemy.pos, radius: 0.48, height: 2.02 });
        assert.ok(!projected.visible || mission.spawnConcealed({ pos: enemy.pos, radius: 0.48, height: 2.02 }));
      }
      births.set(enemy, { time: ai.clock.elapsed, wave: enemy.encounterWave, entry: enemy.encounterEntry,
        role: enemy.arrivalRole, type: enemy.type, position: enemy.pos.toArray() });
    }
  }
  return { births, capture };
}

function finishBalcony(seed) {
  reset(seed);
  const config = ZONE_WAVE_CONFIG.balcony, plan = mission.WaveDirector.schedule.variation;
  const record = birthRecorder('balcony');
  assert.equal(plan.seed, seed); assert.equal(plan.enabled, true);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.recoveryDelays));
  assert.ok(plan.firstDelay >= 0.082 && plan.firstDelay <= 0.1);
  for (let wave = 0; wave < config.waveCount; wave++) {
    if (wave) place({ x: wave === 1 ? 4 : -6, y: 4, z: 0.95 }, Math.PI / 2);
    until(() => living().filter(enemy => enemy.encounterWave === wave).length === config.waves[wave].length
      && mission.WaveDirector.pendingTypes.length === 0, 7, record.capture);
    if (wave === 0) for (const birth of record.births.values()) {
      assert.ok(birth.time >= plan.firstDelay - 1e-8 && birth.time <= plan.firstDelay + STEP + 1e-8);
    }
    assert.equal(mission.WaveDirector.schedule.variation, plan);
    assert.deepEqual(living().map(enemy => enemy.authoredType), config.waves[wave]);
    defeat(); step(record.capture);
    if (wave < config.waveCount - 1) {
      near(mission.WaveDirector.schedule.recoveryDelay, plan.recoveryDelays[wave + 1]);
      near(mission.WaveDirector.schedule.timerDuration, plan.recoveryDelays[wave + 1]);
    }
  }
  assert.equal(mission.WaveDirector.cleared, true);
  assert.equal(mission.WaveDirector.schedule.spawned, 8);
  assert.equal(mission.WaveDirector.schedule.skipped, 0);
  assert.equal(mission.WaveDirector.schedule.clearedWaves, 3);
  const births = [...record.births.values()];
  assert.equal(births.length, 8);
  assert.equal(births.filter(birth => birth.role === 'front').length, 6);
  assert.equal(births.filter(birth => birth.role === 'rear').length, 2);
  assert.equal(ai.player.health, 100);
  return { firstDelay: plan.firstDelay, recoveryDelays: [...plan.recoveryDelays], births };
}

test('fixed seeds reproduce safe actual balcony births, while different seeds vary positions and timing without changing the finite roster', () => {
  const outputs = new Set();
  for (const seed of SEEDS) {
    const first = finishBalcony(seed), replay = finishBalcony(seed);
    assert.deepEqual(replay, first, 'Fixed seed ' + seed + ' reproduces actual birth positions and accepted step times');
    outputs.add(JSON.stringify(first));
  }
  assert.ok(outputs.size >= 5, 'Comparisons exclude the seed field: actual placements/times must differ');
});

test('failed real pool acquisitions cannot reroll a pending seeded pair or consume its original entries', () => {
  reset(72);
  const plan = mission.WaveDirector.schedule.variation, held = [], proposals = [];
  const spawn = ai.Enemies.spawn;
  ai.Enemies.spawn = function(type, x, z, y) {
    proposals.push({ type, x, y, z });
    return spawn.call(this, type, x, z, y);
  };
  try {
    for (let slot = ai.EnemyPool.acquire('thug'); slot; slot = ai.EnemyPool.acquire('thug')) held.push(slot);
    advance(0.2, noOp, false);
    const entries = [...mission.WaveDirector.schedule.pending];
    assert.equal(entries.length, 2); assert.equal(living().length, 0);
    for (let retry = 0; retry < 5; retry++) {
      for (let query = 0; query < 7; query++) mission.pickSafeSpawn('balcony');
      advance(0.66, noOp, false);
      assert.equal(mission.WaveDirector.schedule.variation, plan);
      assert.deepEqual(mission.WaveDirector.schedule.pending, entries, 'Pending identities and authored types survive every retry');
      assert.ok(mission.WaveDirector.schedule.pending.every((entry, index) => entry === entries[index]),
        'A failed request preserves the original pending objects, not merely equal replacements');
      assert.equal(mission.WaveDirector.schedule.spawned, 0);
      assert.equal(living().length, 0);
      assert.ok(ai.EnemyPool.pools.brawler.every(slot => !slot.inUse && slot.owner === null));
    }
    assert.ok(proposals.length >= 8);
    const first = proposals.slice(0, 2);
    for (let index = 0; index < proposals.length; index++) assert.deepEqual(proposals[index], first[index % 2],
      'Extra frames and read-only probes cannot reroll a pending point');
    for (const slot of held) ai.EnemyPool.release(slot);
    held.length = 0;
    until(() => living().length === 2, 0.8, noOp, false);
    assert.deepEqual(living().map(enemy => ({ type: enemy.type, x: enemy.pos.x, y: enemy.pos.y, z: enemy.pos.z })), first);
    assert.equal(mission.WaveDirector.schedule.spawned, 2); assert.equal(mission.WaveDirector.pendingTypes.length, 0);
    assert.equal(ai.player.health, 100);
  } finally { ai.Enemies.spawn = spawn; for (const slot of held) ai.EnemyPool.release(slot); }
});

test('sampled balcony recovery retains a living rear and never awards health before the entire group is defeated', () => {
  for (const seed of [0, 74, 0xffffffff]) {
    reset(seed);
    const config = ZONE_WAVE_CONFIG.balcony, record = birthRecorder('balcony');
    until(() => living().length === 2, 0.3, record.capture); defeat(); step(record.capture);
    place({ x: 4, y: 4, z: 0.95 }, Math.PI / 2);
    until(() => living().length === 3 && mission.WaveDirector.pendingTypes.length === 0, 7, record.capture);
    const rear = living().find(enemy => enemy.arrivalRole === 'rear');
    ai.player.health = 40;
    defeat(enemy => enemy.arrivalRole === 'front'); step(record.capture);
    const fullDelay = mission.WaveDirector.schedule.recoveryDelay;
    assert.ok(fullDelay >= config.waveInterval * 0.82 && fullDelay <= config.waveInterval * 1.18);
    near(mission.WaveDirector.schedule.timerDuration, fullDelay);
    place({ x: -6, y: 4, z: 0.95 }, Math.PI / 2);
    advance(config.minRecovery - STEP * 2, record.capture);
    assert.equal(mission.WaveDirector.waveIndex, 2, 'Variation cannot bypass the minimum front-pair recovery');
    assert.equal(ai.player.health, 40);
    until(() => living().filter(enemy => enemy.encounterWave === 2).length === 2, 0.8, record.capture);
    assert.equal(living().length, 3); assert.ok(living().includes(rear));
    assert.equal(rear.poolSlot.owner, rear);
    assert.equal(mission.WaveDirector.schedule.spawned, 7);
    assert.deepEqual(mission.WaveDirector.schedule.pending.map(entry => [entry.waveIndex, entry.entryIndex]), [[2, 2]]);
    assert.equal(ai.player.health, 40);
    defeat(enemy => enemy === rear); step(record.capture);
    assert.equal(ai.player.health, 65);
    until(() => mission.WaveDirector.schedule.spawned === 8, 0.8, record.capture);
    assert.equal(living().length, 3); assert.equal(mission.WaveDirector.schedule.skipped, 0);
  }
});

test('sampled rooftop reinforcement timers still require the first pair to die and obey global/type capacities', () => {
  const outcomes = new Set(), config = ZONE_WAVE_CONFIG.roof;
  for (const seed of [0, 100, 0xdeadbeef]) {
    reset(seed, 'roof');
    const schedule = mission.WaveDirector.schedule, plan = schedule.variation, record = birthRecorder('roof');
    until(() => living().length === 2 && !schedule.pending.length, 4, record.capture, false);
    // Keep actual pooled actors stationary to isolate scheduler gates. No
    // player attack, kill credit or ordinary-play performance is simulated.
    advance(8, record.capture, false);
    assert.equal(schedule.waveIndex, 1); assert.equal(schedule.spawned, 2);
    assert.equal(schedule.reinforcementsActive, false);
    defeat(); step(record.capture, false);
    assert.equal(schedule.reinforcementsActive, true);
    near(schedule.timerDuration, plan.reinforcementFirstDelay); near(schedule.timer, plan.reinforcementFirstDelay);
    advance(plan.reinforcementFirstDelay - STEP * 2, record.capture, false);
    assert.equal(schedule.waveIndex, 1, 'Reserve contacts cannot arrive before the sampled activation delay');
    until(() => schedule.spawned === 6 && !schedule.pending.length, 1, record.capture, false);
    assert.equal(living().length, 4); assert.equal(schedule.waveIndex, 2);
    const firstReserve = [...living()];
    until(() => schedule.waveIndex === 3, plan.reinforcementIntervals[2] + 1, record.capture, false);
    assert.equal(living().length, 5, 'An overlapping reserve may fill, but never exceed, the rooftop live cap');
    assert.ok(firstReserve.every(enemy => enemy.alive && living().includes(enemy)));
    assert.equal(schedule.pending.length, 2);
    let peak = living().length;
    for (let cycle = 0; cycle < 12 && !schedule.cleared; cycle++) {
      defeat(); step(record.capture, false);
      if (schedule.cleared) break;
      until(() => living().length > 0 || schedule.cleared, 8, () => {
        record.capture(); peak = Math.max(peak, living().length);
        assert.ok(living().filter(enemy => enemy.type === 'enforcer').length <= (config.typeCaps.enforcer ?? Infinity));
      }, false);
    }
    assert.equal(schedule.spawned, 12); assert.equal(schedule.cleared, true); assert.equal(schedule.skipped, 0);
    assert.equal(record.births.size, 12); assert.equal(peak, config.maxAlive);
    outcomes.add(JSON.stringify([plan.firstDelay, plan.reinforcementFirstDelay, plan.reinforcementIntervals]));
  }
  assert.equal(outcomes.size, 3);
});

test('actual starts, checkpoint retries and final branches draw new normal seeds while fixed overrides replay and deadlines stay authored', () => {
  reset(undefined, 'apartment');
  const first = mission.WaveDirector.schedule.seed, initialDraws = entropyCalls;
  assert.ok(Number.isInteger(first));
  mission.WaveDirector.update(mission.WaveDirector.schedule.variation.firstDelay);
  const old = living(); assert.ok(old.length > 0);
  ai.playerState.dead = true; ai.player.health = 0;
  assert.equal(mission.restartFromZone(), true);
  const second = mission.WaveDirector.schedule.seed;
  assert.notEqual(second, first); assert.equal(entropyCalls, initialDraws + 1);
  assert.ok(old.every(enemy => enemy.removed && enemy.poolSlot === null));
  assert.equal(mission.getMissionState().wave.seed, second);
  assert.equal(mission.getMissionState().wave.variationEnabled, true);
  seeds.setOverride(0);
  assert.equal(mission.restartFromZone(), true); assert.equal(mission.WaveDirector.schedule.seed, 0);
  const fixed = mission.WaveDirector.schedule.variation;
  assert.equal(mission.restartFromZone(), true);
  assert.deepEqual(mission.WaveDirector.schedule.variation, fixed);
  assert.equal(entropyCalls, initialDraws + 1, 'Fixed attempts do not consume ambient entropy');
  seeds.setOverride(null);
  assert.equal(mission.restartFromZone(), true);
  assert.equal(mission.WaveDirector.schedule.seed, null);
  near(mission.WaveDirector.timer, ZONE_WAVE_CONFIG.apartment.firstWave);
  for (const branch of ['car', 'bakery']) {
    const zone = branch === 'car' ? 'street' : 'bakery';
    reset(undefined, zone);
    const ordinarySeed = mission.WaveDirector.schedule.seed;
    mission.Endings[branch === 'car' ? 'beginCar' : 'beginBakery']();
    const started = mission.Endings.getStatus();
    assert.notEqual(started.seed, ordinarySeed);
    assert.equal(started.variationEnabled, true);
    assert.equal(started.remaining, FINAL_ENCOUNTERS[branch].waves.flat().length);
    near(started.deadline, FINAL_ENCOUNTERS[branch].deadlineSeconds);
    mission.Endings.update(0);
    near(mission.Endings.getStatus().deadline, started.deadline);
    mission.Endings.update(0.25);
    near(mission.Endings.getStatus().deadline, branch === 'bakery' ? started.deadline - 0.25 : 0);
    ai.playerState.dead = true;
    assert.equal(mission.restartFromZone(), true);
    const restarted = mission.Endings.getStatus();
    assert.notEqual(restarted.seed, started.seed);
    assert.equal(restarted.mode, branch); assert.equal(restarted.resolved, false);
    near(restarted.deadline, FINAL_ENCOUNTERS[branch].deadlineSeconds);
    assert.equal(restarted.remaining, FINAL_ENCOUNTERS[branch].waves.flat().length);
  }
});
