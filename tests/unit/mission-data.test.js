import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZONE_ORDER, CHECKPOINTS, ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS,
  SPAWN_CLEARANCE, MIN_SPAWN_DISTANCE, selectSafeSpawn, createCheckpoint,
} from '../../src/game/mission-data.js';
import { BALCONY, ROOF, SCAFFOLD_LEVELS } from '../../src/world/layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { encounterSpawnRole } from '../../src/game/rear-encounter-rules.js';

const safeContext = overrides => ({
  playerFoot: { x: 0, y: 0, z: 0 },
  enemies: [],
  floorAt: candidate => candidate.y,
  blocked: () => false,
  ...overrides,
});

const validEnemyTypes = new Set(['thug', 'brawler', 'gunman', 'bruiser', 'hitman', 'enforcer']);

test('all eight ordered zones have a finite encounter and a standing checkpoint', () => {
  assert.equal(ZONE_ORDER.length, 8);
  assert.deepEqual(Object.keys(CHECKPOINTS), ZONE_ORDER);
  assert.deepEqual(Object.keys(ZONE_WAVE_CONFIG), ZONE_ORDER);
  for (const zone of ZONE_ORDER) {
    const anchor = CHECKPOINTS[zone];
    for (const key of ['x', 'y', 'z', 'yaw']) assert.ok(Number.isFinite(anchor[key]), `${zone}.${key}`);
    const config = ZONE_WAVE_CONFIG[zone];
    assert.ok(config.waveCount >= 1 && config.waveCount <= 4, zone);
    assert.equal(config.waveCount, config.waves.length);
    assert.ok(config.firstWave > 0 && config.waveInterval >= 4, zone);
    assert.ok(config.maxAlive >= 1 && config.maxAlive <= 5, zone);
    assert.equal(config.totalContacts, config.waves.flat().length);
    assert.ok(config.spawns.length > 0, zone);
    for (const group of config.waves) {
      // A platform group can queue its fourth contact behind a three-NPC cap.
      assert.ok(group.length > 0 && group.length <= 5, zone);
      for (const type of group) assert.ok(validEnemyTypes.has(type), type);
    }
  }
});

test('completed encounters never replenish or escalate into unlimited waves', () => {
  for (const config of Object.values(ZONE_WAVE_CONFIG)) {
    assert.equal(config.composition(0), config.waves[0]);
    assert.deepEqual(config.composition(config.waveCount), []);
    assert.deepEqual(config.composition(1000), []);
    assert.deepEqual(config.composition(-1), []);
  }
});

test('balcony retains three forward pairs and adds two separately capped rear reserves', () => {
  const config = ZONE_WAVE_CONFIG.balcony;
  assert.equal(config.waveCount, 3);
  assert.equal(config.maxAlive, 3);
  assert.equal(config.frontPairSize, 2);
  assert.equal(config.maxRearAlive, 1);
  assert.equal(config.advanceOnFrontClear, true);
  assert.deepEqual(config.rearEntryIndices, [2]);
  assert.deepEqual(config.waves, [['brawler', 'thug'], ['thug', 'brawler', 'thug'], ['brawler', 'thug', 'thug']]);
  assert.equal(config.waves.flat().length, 8);
  assert.deepEqual(config.waves.map(wave => wave.map((_, index) => encounterSpawnRole(index, wave.length, config.rearEntryIndices))),
    [['front', 'front'], ['front', 'front', 'rear'], ['front', 'front', 'rear']]);
  assert.deepEqual(config.stages.map(stage => stage.id), ['east-landing', 'wrap-walkway', 'stair-approach']);
  assert.equal(config.stages.length, config.waveCount);
  assert.ok(config.minRecovery >= 1.25);
  assert.ok(config.waveInterval >= 4.5);
  assert.throws(() => { config.stages[0].spawnIndices.push(0); }, TypeError);
  assert.deepEqual(config.stages[0].preferredSpawnIndices, [11, 12]);
  assert.throws(() => { config.stages[0].preferredSpawnIndices.push(1); }, TypeError);
  assert.throws(() => { config.route.points[0].x = 0; }, TypeError);
  assert.throws(() => { config.rearEntryIndices[0] = 1; }, TypeError);
  for (const stage of config.stages) {
    assert.ok(stage.spawnIndices.length >= config.maxAlive);
    for (const index of stage.spawnIndices) {
      assert.ok(Number.isInteger(index) && index >= 0 && index < config.spawns.length);
      assert.equal(config.spawns[index].y, CHECKPOINTS.balcony.y);
    }
  }
});

test('balcony spawns alternate clear lanes around the shared walkway route', () => {
  const config = ZONE_WAVE_CONFIG.balcony;
  assert.equal(config.route.floorY, BALCONY.floorY);
  assert.equal(config.route.points[1].z, BALCONY.laneZ);
  assert.equal(config.route.points[2].z, BALCONY.laneZ);
  for (const point of config.spawns) {
    assert.equal(point.y, BALCONY.floorY);
    const bounds = point.z < BALCONY.wrap.z1 ? BALCONY.east : BALCONY.wrap;
    assert.ok(point.x > bounds.x1 && point.x < bounds.x2);
    assert.ok(point.z > bounds.z1 && point.z < bounds.z2);
    if (point.z >= BALCONY.wrap.z1) assert.ok([0.62, 1.18].includes(point.z));
  }
  const wrap = config.spawns.filter(point => point.z >= BALCONY.wrap.z1);
  assert.equal(new Set(wrap.map(point => point.z)).size, 2);
  const westApproach = config.spawns.slice(2, 11);
  for (let index = 1; index < westApproach.length; index++) {
    assert.ok(Math.abs(westApproach[index].z - westApproach[index - 1].z) >= 0.55);
  }
  const eastPair = config.stages[0].spawnIndices.slice(0, 2).map(index => config.spawns[index]);
  assert.deepEqual(eastPair.map(point => point.x), [10, 12], 'The south-facing approach staggers across X');
  assert.ok(eastPair.every(point => point.z === 1.18));
  assert.equal(config.rearPressure.stagger, true);
});

test('authored contact budgets grow across all eight checkpoints while live groups remain bounded', () => {
  assert.deepEqual(ZONE_ORDER.map(zone => ZONE_WAVE_CONFIG[zone].totalContacts), [2, 4, 8, 8, 12, 14, 16, 18]);
  assert.deepEqual(ZONE_ORDER.map(zone => ZONE_WAVE_CONFIG[zone].maxAlive), [2, 2, 3, 2, 5, 3, 5, 5]);
});

test('opening combat teaches fists and bats before the first firearm is earned', () => {
  assert.deepEqual(ZONE_WAVE_CONFIG.apartment.waves, [['brawler', 'thug']]);
  assert.deepEqual(ZONE_WAVE_CONFIG.neighbor.waves[0], ['thug', 'brawler']);
  assert.deepEqual(ZONE_WAVE_CONFIG.neighbor.waves[1], ['gunman', 'thug']);
  assert.ok(!ZONE_WAVE_CONFIG.apartment.waves.flat().some(type => ['gunman', 'hitman', 'enforcer'].includes(type)));
});

test('the roof opens with two sentries then mixes reserves with only one machine gunner', () => {
  const roof = ZONE_WAVE_CONFIG.roof;
  assert.deepEqual(roof.waves.map(group => group.length), [2, 4, 3, 3]);
  assert.deepEqual(roof.waves[0], ['gunman', 'thug']);
  assert.deepEqual(new Set(roof.waves.flat()), validEnemyTypes);
  assert.equal(roof.waves.flat().filter(type => type === 'enforcer').length, 1);
  assert.equal(roof.typeCaps.enforcer, 1);
  assert.deepEqual(roof.reinforcements, { afterClearWave: 0, firstDelay: 1.75, interval: 4.5 });
  assert.deepEqual(roof.spawns, ROOF.spawnPockets.map(([x, z]) => ({ x, y: ROOF.floorY, z })));
});

test('authored checkpoints are floor anchors, not airborne trigger coordinates', () => {
  assert.deepEqual(ZONE_ORDER.map(zone => CHECKPOINTS[zone].y), [4, 4, 4, 4, 14, 10, 0.05, 0.08]);
  const scaffold = CHECKPOINTS.scaffolding;
  const upperDeck = SCAFFOLD_LEVELS[0];
  assert.ok(scaffold.x > upperDeck.x1 && scaffold.x < upperDeck.x2);
  assert.ok(scaffold.z > upperDeck.z1 && scaffold.z < upperDeck.z2);
  assert.equal(scaffold.y, upperDeck.y);
  assert.deepEqual(CHECKPOINTS.street, DISTRICT.street.checkpoint);
  assert.deepEqual(CHECKPOINTS.bakery, DISTRICT.bakery.checkpoint);
  assert.ok(CHECKPOINTS.neighbor.x > -2.1, 'neighbor checkpoint must clear the sealed breach');
  assert.ok(CHECKPOINTS.bakery.x > -20.5 && CHECKPOINTS.bakery.x < -17, 'bakery checkpoint uses the open entry corridor');
});

test('four stair pairs use separate authored landings and progressively higher arrival gates', () => {
  const config = ZONE_WAVE_CONFIG.stairwell;
  assert.equal(config.waveCount, 4);
  assert.equal(config.maxAlive, 2);
  assert.deepEqual(config.rearEntryIndices, [1]);
  assert.equal(config.frontPairSize, undefined, 'Stairs retain their individual forward/rear arrival policy');
  assert.equal(config.retireLive, false, 'Living stair contacts keep pursuing after their landing is passed');
  assert.ok(config.waves.every(group => group.length === 2));
  for (const [index, stage] of config.stages.entries()) {
    const landing = STAIRS.landings[index + 1];
    assert.equal(stage.id, landing.id);
    assert.equal(stage.minFootY, STAIRS.landings[index].y - 0.25);
    assert.equal(stage.advanceFootY, STAIRS.landings[index].y + 0.15);
    assert.equal(stage.departAbove, landing.y + 0.25);
    assert.equal(stage.maxFootY, stage.departAbove);
    assert.deepEqual(stage.spawnIndices.map(i => config.spawns[i]), landing.spawnPoints);
    const rear = config.rearSpawns[stage.rearSpawnIndices[0]], flight = STAIRS.flights[index];
    assert.equal(rear.y, flight.fromY, 'rear contact stands on this flight\'s lower landing');
    assert.ok(Math.abs(rear.x - flight.x) < 0.06, 'rear contact uses the correct ascending lane');
    assert.equal(new Set(stage.spawnIndices.map(i => config.spawns[i].y)).size, 1);
    if (index) assert.ok(stage.minFootY > config.stages[index - 1].minFootY);
  }
});

test('scaffold contacts stay on four decks with explicit irreversible departure thresholds', () => {
  const config = ZONE_WAVE_CONFIG.scaffolding;
  assert.equal(config.retireLive, false, 'Dropping from a platform must preserve its living contacts');
  assert.deepEqual(config.waves.map(group => group.length), [3, 4, 3, 4]);
  assert.equal(config.spawns.length, 20);
  for (const [index, stage] of config.stages.entries()) {
    const deck = SCAFFOLD_LEVELS[index];
    assert.equal(stage.minFootY, deck.y - 1);
    assert.equal(stage.maxFootY, deck.y + 1.2);
    assert.equal(stage.departBelow, index < 3 ? deck.y - 1 : undefined);
    for (const i of stage.spawnIndices) {
      const point = config.spawns[i];
      assert.equal(point.y, deck.y);
      assert.ok(point.x > deck.x1 + 0.6 && point.x < deck.x2 - 0.6);
      assert.ok(point.z > deck.z1 + 0.6 && point.z < deck.z2 - 0.6);
    }
  }
});

test('final branches have finite multiwave rosters and a fair shared bakery deadline', () => {
  assert.deepEqual(FINAL_ENCOUNTERS.car.waves.map(group => group.length), [4, 4]);
  assert.deepEqual(FINAL_ENCOUNTERS.bakery.waves.map(group => group.length), [4, 5, 4, 5]);
  assert.equal(FINAL_ENCOUNTERS.car.totalContacts, 8);
  assert.equal(FINAL_ENCOUNTERS.bakery.totalContacts, 18);
  assert.equal(FINAL_ENCOUNTERS.bakery.deadlineSeconds, 180);
  assert.equal(FINAL_ENCOUNTERS.bakery.deadlineSeconds, ZONE_WAVE_CONFIG.bakery.deadlineSeconds);
  assert.deepEqual(FINAL_ENCOUNTERS.bakery.waves, ZONE_WAVE_CONFIG.bakery.waves);
  assert.equal(FINAL_ENCOUNTERS.car.deadlineSeconds, 0);
  assert.ok(Math.hypot(DISTRICT.car.approach.x - DISTRICT.car.x, DISTRICT.car.approach.z - DISTRICT.car.z)
    < FINAL_ENCOUNTERS.car.arrivalRadius);
  for (const config of Object.values(FINAL_ENCOUNTERS)) {
    assert.equal(config.firstWave, 0);
    assert.equal(config.waves[0].length, 4);
    assert.equal(config.maxAlive, 5);
    assert.deepEqual(config.composition(config.waveCount), []);
  }
});

test('encounter and checkpoint authoring data cannot mutate between lives', () => {
  assert.ok(Object.isFrozen(CHECKPOINTS));
  assert.ok(Object.isFrozen(ZONE_WAVE_CONFIG));
  assert.throws(() => { CHECKPOINTS.street.y = 12; }, TypeError);
  assert.throws(() => { ZONE_WAVE_CONFIG.roof.waves[0].push('enforcer'); }, TypeError);
  assert.throws(() => { ZONE_WAVE_CONFIG.roof.spawns[0].x = 0; }, TypeError);
  assert.throws(() => { ZONE_WAVE_CONFIG.roof.reinforcements.interval = 0; }, TypeError);
  assert.throws(() => { ZONE_WAVE_CONFIG.roof.typeCaps.enforcer = 10; }, TypeError);
  assert.throws(() => { ZONE_WAVE_CONFIG.stairwell.rearSpawns[0].y = 100; }, TypeError);
  assert.throws(() => { ZONE_WAVE_CONFIG.stairwell.stages[0].rearSpawnIndices.push(3); }, TypeError);
  assert.throws(() => { ZONE_WAVE_CONFIG.balcony.rearPressure.maxDistance = 100; }, TypeError);
  assert.throws(() => { ZONE_WAVE_CONFIG.balcony.variation.maxFirstDelay = 10; }, TypeError);
  assert.throws(() => { FINAL_ENCOUNTERS.bakery.waves[3].pop(); }, TypeError);
});

test('variation limits reflect each route width without changing rosters or recovery floors', () => {
  for (const [zone, config] of Object.entries(ZONE_WAVE_CONFIG)) {
    assert.equal(config.variation.key, zone);
    assert.equal(config.variation.timingFraction, 0.18);
    assert.ok(Object.isFrozen(config.variation));
  }
  assert.deepEqual([ZONE_WAVE_CONFIG.balcony.variation.jitterX, ZONE_WAVE_CONFIG.balcony.variation.jitterZ], [0.1, 0.025]);
  assert.equal(ZONE_WAVE_CONFIG.balcony.variation.maxFirstDelay, 0.1);
  assert.deepEqual([ZONE_WAVE_CONFIG.stairwell.variation.jitterX, ZONE_WAVE_CONFIG.stairwell.variation.jitterZ], [0.05, 0.05]);
  assert.equal(ZONE_WAVE_CONFIG.roof.variation.jitterX, 0.6);
  assert.equal(ZONE_WAVE_CONFIG.street.variation.jitterX, 0.75);
  assert.equal(ZONE_WAVE_CONFIG.balcony.minRecovery, 1.25);
  assert.equal(ZONE_WAVE_CONFIG.stairwell.minRecovery, 0.25);
  assert.equal(ZONE_WAVE_CONFIG.balcony.totalContacts, 8);
});

test('safe spawn returns a grounded copy without mutating authored data', () => {
  const candidate = Object.freeze({ x: 8, y: 0, z: 0 });
  const point = selectSafeSpawn([candidate], safeContext());
  assert.deepEqual(point, { x: 8, y: SPAWN_CLEARANCE, z: 0 });
  assert.notEqual(point, candidate);
  assert.equal(candidate.y, 0);
});

test('no candidate means no spawn, including when every point is unsafe', () => {
  assert.equal(selectSafeSpawn([], safeContext()), null);
  const points = [{ x: 8, y: 0, z: 0 }, { x: 10, y: 0, z: 4 }];
  assert.equal(selectSafeSpawn(points, safeContext({ blocked: () => true })), null);
  assert.equal(selectSafeSpawn(points, safeContext({ floorAt: () => -Infinity })), null);
  assert.equal(selectSafeSpawn(points, safeContext({ floorAt: () => NaN })), null);
});

test('ground alone never bypasses wall or player clearance checks', () => {
  const points = [{ x: 1, y: 0, z: 1 }, { x: 9, y: 0, z: 0 }];
  const point = selectSafeSpawn(points, safeContext({ blocked: candidate => candidate.x === 9 }));
  assert.equal(point, null);
});

test('point-blank spawns are rejected, including vertically stacked points', () => {
  assert.equal(selectSafeSpawn([{ x: MIN_SPAWN_DISTANCE - 0.01, y: 0, z: 0 }], safeContext()), null);
  assert.equal(selectSafeSpawn([{ x: 0, y: 6, z: 0 }], safeContext()), null);
  assert.ok(selectSafeSpawn([{ x: MIN_SPAWN_DISTANCE, y: 0, z: 0 }], safeContext()));
});

test('living enemies reserve space so a group cannot overlap at one point', () => {
  const points = [{ x: 8, y: 0, z: 0 }, { x: 11, y: 0, z: 0 }];
  const first = selectSafeSpawn(points, safeContext());
  const enemies = [{ alive: true, pos: first }];
  const second = selectSafeSpawn(points, safeContext({ enemies }));
  assert.equal(second.x, 11);
  enemies.push({ alive: true, pos: second });
  assert.equal(selectSafeSpawn(points, safeContext({ enemies })), null);
});

test('a nearby living enemy also blocks the clearance radius', () => {
  const enemies = [{ alive: true, pos: { x: 8.7, y: 0, z: 0.4 } }];
  assert.equal(selectSafeSpawn([{ x: 8, y: 0, z: 0 }], safeContext({ enemies })), null);
});

test('corpses and enemies on a different storey do not block a clear floor', () => {
  const enemies = [
    { alive: false, pos: { x: 8, y: 0, z: 0 } },
    { alive: true, pos: { x: 8, y: 4, z: 0 } },
  ];
  assert.ok(selectSafeSpawn([{ x: 8, y: 0, z: 0 }], safeContext({ enemies })));
});

test('an unavailable deck cannot silently fall back to a much lower floor', () => {
  const point = { x: 8, y: 10, z: 0 };
  assert.equal(selectSafeSpawn([point], safeContext({ floorAt: () => 7 })), null);
  assert.equal(selectSafeSpawn([point], safeContext({ floorAt: () => 11 })), null);
});

test('small sidewalk offsets snap to actual support before checking clearance', () => {
  let inspected;
  const point = selectSafeSpawn([{ x: 8, y: 0.05, z: 0 }], safeContext({
    floorAt: () => 0.14,
    blocked: candidate => { inspected = candidate; return false; },
  }));
  assert.equal(point.y, 0.14 + SPAWN_CLEARANCE);
  assert.equal(inspected.y, point.y);
});

test('height gates keep enemies on the reachable part of a climb', () => {
  const points = [{ x: 8, y: 9, z: 0 }, { x: 8, y: 6.4, z: 0 }];
  const point = selectSafeSpawn(points, safeContext({ playerFoot: { x: 0, y: 4, z: 0 }, maxHeightDifference: 3.2 }));
  assert.equal(point.y, 6.4 + SPAWN_CLEARANCE);
});

test('candidate rotation tests every point once and has no random fallback', () => {
  const points = [{ x: 8, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 12, y: 0, z: 0 }];
  for (const startIndex of [0, 1, 2, 10, -1]) {
    const visited = [];
    const point = selectSafeSpawn(points, safeContext({
      startIndex,
      blocked: candidate => { visited.push(candidate.x); return candidate.x !== 10; },
    }));
    assert.equal(point.x, 10);
    assert.equal(new Set(visited).size, visited.length);
  }
});

test('invalid authored coordinates are skipped rather than sent to the engine', () => {
  const points = [{ x: NaN, y: 0, z: 0 }, { x: 8, y: Infinity, z: 0 }, { x: 8, y: 0, z: 0 }];
  assert.deepEqual(selectSafeSpawn(points, safeContext()), { x: 8, y: SPAWN_CLEARANCE, z: 0 });
});

test('checkpoint loadout preserves exact magazine and reserve across later mutations', () => {
  const weapon = { current: 'pistol', loaded: 4, reserve: 23 };
  const checkpoint = createCheckpoint('roof', weapon);
  weapon.current = 'fists';
  weapon.loaded = 0;
  weapon.reserve = 0;
  assert.deepEqual(checkpoint.weapon, { current: 'pistol', loaded: 4, reserve: 23 });
  assert.equal(checkpoint.anchor, CHECKPOINTS.roof);
  assert.equal(checkpoint.branch, null);
  assert.ok(Object.isFrozen(checkpoint.weapon));
  assert.ok(Object.isFrozen(checkpoint));
});

test('ending checkpoints retain the committed branch and the correct arena', () => {
  const weapon = { current: 'smg', loaded: 7, reserve: 18 };
  assert.equal(createCheckpoint('street', weapon, 'car').branch, 'car');
  assert.equal(createCheckpoint('bakery', weapon, 'bakery').branch, 'bakery');
  assert.throws(() => createCheckpoint('bakery', weapon, 'car'), RangeError);
  assert.throws(() => createCheckpoint('street', weapon, 'bakery'), RangeError);
  assert.throws(() => createCheckpoint('missing', weapon), RangeError);
  assert.throws(() => createCheckpoint('street', weapon, 'missing'), RangeError);
});
