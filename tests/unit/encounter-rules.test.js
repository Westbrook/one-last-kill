import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EncounterRouteProgress, EncounterSchedule, routeDistanceAt, encounterWaveReady, encounterSpawnCandidates,
} from '../../src/game/encounter-rules.js';
import { CHECKPOINTS, FINAL_ENCOUNTERS, MIN_SPAWN_DISTANCE, ZONE_WAVE_CONFIG, selectSafeSpawn } from '../../src/game/mission-data.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { selectEncounterFrontPair } from '../../src/game/encounter-spawns.js';
import { encounterSpawnRole } from '../../src/game/rear-encounter-rules.js';

const config = ZONE_WAVE_CONFIG.balcony;
const route = config.route;
const laneZ = route.points[1].z;
const feet = (x, z = laneZ, y = route.floorY) => ({ x, y, z });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const ready = (index, timer, progress, footY = route.floorY) => encounterWaveReady(config, index, timer, progress, footY);

function placePair(index, position, progress) {
  const entries = config.composition(index).slice(0, config.frontPairSize)
    .map((type, entryIndex) => ({ type, entryIndex, waveIndex: index }));
  const pair = selectEncounterFrontPair({
    config, waveIndex: index, entries, playerFoot: position, yaw: index ? Math.PI / 2 : Math.PI,
    routeProgress: progress, floorAt: candidate => candidate.y, blocked: () => false,
  });
  assert.ok(pair, `Stage ${index} must have room for both forward contacts`);
  return pair.map(selection => ({ type: selection.type, alive: true, pos: selection.point }));
}

test('route distance follows the east landing and turns west along the wrap', () => {
  const cornerDistance = laneZ - route.points[0].z;
  near(routeDistanceAt(route, feet(11, route.points[0].z)), 0);
  near(routeDistanceAt(route, CHECKPOINTS.balcony), 3.9);
  near(routeDistanceAt(route, feet(11)), cornerDistance);
  near(routeDistanceAt(route, feet(4)), cornerDistance + 7);
  near(routeDistanceAt(route, feet(-12)), cornerDistance + 23);
  near(routeDistanceAt(route, feet(-18)), cornerDistance + 29);
});

test('progress is monotonic through turns, retreats and repeated positions', () => {
  const progress = new EncounterRouteProgress(route);
  const positions = [CHECKPOINTS.balcony, feet(11), feet(4), feet(-6), feet(4), CHECKPOINTS.balcony];
  let previous = 0;
  for (const point of positions) {
    const distance = progress.update(point);
    assert.ok(distance >= previous);
    previous = distance;
  }
  near(progress.distance, routeDistanceAt(route, feet(-6)));
});

test('roof, street and off-route room positions cannot advance balcony encounters', () => {
  const progress = new EncounterRouteProgress(route);
  progress.update(CHECKPOINTS.balcony);
  const initial = progress.distance;
  for (const point of [feet(-18, laneZ, 14), feet(-18, laneZ, 0), feet(-8, -6), feet(50), feet(NaN)]) {
    assert.equal(routeDistanceAt(route, point), null);
    assert.equal(progress.update(point), initial);
  }
});

test('normal balcony jumps preserve route tracking', () => {
  const position = feet(4, laneZ, route.floorY + 0.8);
  near(routeDistanceAt(route, position), routeDistanceAt(route, feet(4)));
});

test('the first contact pair observes its initial delay even deep along the route', () => {
  assert.equal(ready(0, config.firstWave, 0), false);
  assert.equal(ready(0, 0.01, 30), false);
  assert.equal(ready(0, 0, 0), true);
});

test('later pairs require the player to enter their authored route segment', () => {
  for (let index = 1; index < config.waveCount; index++) {
    const stage = config.stages[index];
    assert.equal(ready(index, -100, stage.minProgress - 0.01), false);
    assert.equal(ready(index, 0, stage.minProgress), true);
  }
});

test('holding position grants the whole recovery interval', () => {
  for (let index = 1; index < config.waveCount; index++) {
    const stage = config.stages[index];
    assert.equal(ready(index, config.waveInterval, stage.minProgress), false);
    assert.equal(ready(index, 0.01, stage.minProgress), false);
    assert.equal(ready(index, 0, stage.minProgress), true);
  }
});

test('pushing forward can shorten recovery but never bypasses its minimum', () => {
  const threshold = config.waveInterval - config.minRecovery;
  for (let index = 1; index < config.waveCount; index++) {
    const stage = config.stages[index];
    assert.equal(ready(index, threshold + 0.01, stage.advanceAt), false);
    assert.equal(ready(index, threshold, stage.advanceAt - 0.01), false);
    assert.equal(ready(index, threshold, stage.advanceAt), true);
  }
});

test('spatial pacing cannot create a fourth pair or accept invalid state', () => {
  assert.equal(ready(config.waveCount, -100, 100), false);
  assert.equal(ready(-1, 0, 0), false);
  assert.equal(ready(1, NaN, 100), false);
  assert.equal(ready(1, 0, NaN), false);
  assert.equal(ready(1, 0, 100, NaN), false);
  assert.deepEqual(encounterSpawnCandidates(config, config.waveCount, 0), []);
});

test('each forward stage offers two safe contacts ahead, with no point-blank or overlapping placement', () => {
  const positions = [CHECKPOINTS.balcony, feet(4), feet(-6)];
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index];
    const progress = routeDistanceAt(route, position);
    const pair = placePair(index, position, progress);
    assert.equal(pair.length, 2);
    for (const enemy of pair) {
      assert.ok(Math.hypot(enemy.pos.x - position.x, enemy.pos.z - position.z) >= MIN_SPAWN_DISTANCE);
      assert.ok(routeDistanceAt(route, enemy.pos) > progress);
    }
    assert.ok(Math.hypot(pair[0].pos.x - pair[1].pos.x, pair[0].pos.z - pair[1].pos.z) >= 1.5);
  }
});

test('the initial pair occupies two separate east-landing lanes in front of the checkpoint', () => {
  const position = CHECKPOINTS.balcony;
  const pair = placePair(0, position, routeDistanceAt(route, position));
  assert.deepEqual(pair.map(enemy => enemy.pos.x), [10, 12]);
  assert.ok(pair.every(enemy => enemy.pos.z === 1.18));
  assert.ok(pair[0].pos.x < position.x && pair[1].pos.x > position.x, 'Both faces have distinct horizontal bearings');
});

test('the forward selector keeps its progress gate while rear entries use their own selector', () => {
  const progress = new EncounterRouteProgress(route);
  progress.update(feet(-6));
  progress.update(CHECKPOINTS.balcony);
  for (let index = 0; index < config.waveCount; index++) {
    for (const point of encounterSpawnCandidates(config, index, progress.distance)) {
      assert.ok(routeDistanceAt(route, point) > progress.distance);
    }
  }
});

test('passing the available forward anchors does not turn them into an unchecked rear fallback', () => {
  const distance = routeDistanceAt(route, feet(-18));
  for (let index = 0; index < config.waveCount; index++) {
    assert.deepEqual(encounterSpawnCandidates(config, index, distance), []);
  }
});

test('unsafe stage candidates stay rejected without falling back to another segment', () => {
  const position = feet(4);
  const candidates = encounterSpawnCandidates(config, 1, routeDistanceAt(route, position));
  assert.equal(selectSafeSpawn(candidates, {
    playerFoot: position,
    floorAt: candidate => candidate.y,
    blocked: () => true,
  }), null);
  assert.equal(candidates.length, config.stages[1].spawnIndices.length);
  assert.ok(candidates.every(point => config.stages[1].spawnIndices.some(index => config.spawns[index] === point)));
});

test('a checkpoint retry resets progress and recreates the same initial roster and placements', () => {
  const progress = new EncounterRouteProgress(route);
  progress.update(CHECKPOINTS.balcony);
  const first = placePair(0, CHECKPOINTS.balcony, progress.distance);
  progress.update(feet(-18));
  progress.reset();
  assert.equal(progress.distance, 0);
  progress.update(CHECKPOINTS.balcony);
  const retry = placePair(0, CHECKPOINTS.balcony, progress.distance);
  assert.deepEqual(retry, first);
  assert.equal(ready(1, 0, progress.distance), false);
  assert.equal(ready(2, 0, progress.distance), false);
});

test('arena stages retain arrival timers, authored pockets and stair height gates', () => {
  const roof = ZONE_WAVE_CONFIG.roof;
  assert.equal(encounterWaveReady(roof, 1, 0.1, 100, 14), false);
  assert.equal(encounterWaveReady(roof, 1, 0, 0, 14), true);
  assert.deepEqual(encounterSpawnCandidates(roof, 1, 100), roof.stages[1].spawnIndices.map(i => roof.spawns[i]));
  const stairs = ZONE_WAVE_CONFIG.stairwell;
  for (const [index, stage] of stairs.stages.entries()) {
    assert.equal(encounterWaveReady(stairs, index, -100, 0, stage.minFootY - 0.01), false);
    assert.equal(encounterWaveReady(stairs, index, 0, 0, stage.minFootY), true);
    const points = encounterSpawnCandidates(stairs, index, 0);
    assert.deepEqual(points, stage.spawnIndices.map(i => stairs.spawns[i]));
    assert.equal(points.length, 2);
    assert.equal(points[0].y, points[1].y);
  }
});

// No AI, renderer or wall clock: a confirmed callback represents a successful
// geometry/pool allocation. Retiring a platform removes contacts without kills.
function driveEncounter(settings, defaultFootY, options) {
  const schedule = new EncounterSchedule(settings, options);
  return {
    schedule, alive: [], history: [],
    counts() {
      const aliveByWave = Array(settings.waveCount).fill(0), frontAliveByWave = Array(settings.waveCount).fill(0), byType = {};
      let rearAlive = 0;
      for (const enemy of this.alive) {
        aliveByWave[enemy.waveIndex]++;
        const role = settings.rearPressure
          ? encounterSpawnRole(enemy.entryIndex, settings.waves[enemy.waveIndex].length, settings.rearEntryIndices) : 'front';
        if (role === 'rear') rearAlive++;
        else frontAliveByWave[enemy.waveIndex]++;
        byType[enemy.type] = (byType[enemy.type] || 0) + 1;
      }
      return { alive: this.alive.length, total: this.alive.length, aliveByWave, frontAliveByWave, rearAlive, byType };
    },
    spawn(canSpawn = () => true) {
      const commit = (entry, firstForWave) => {
        this.alive.push({ ...entry });
        this.history.push({ ...entry, firstForWave });
      };
      return schedule.spawnAvailable(this.counts(), (entry, firstForWave) => {
        if (!canSpawn(entry)) return false;
        commit(entry, firstForWave);
        return true;
      }, (entries, firstForWave) => {
        if (!entries.every(canSpawn)) return false;
        entries.forEach((entry, index) => commit(entry, firstForWave && index === 0));
        return true;
      });
    },
    tick(dt, { footY = defaultFootY, routeProgress = 0, grounded = true, spawn = true, canSpawn } = {}) {
      const result = schedule.update(dt, { ...this.counts(), footY, routeProgress, grounded });
      const events = {
        ...result, clearedWaves: [...result.clearedWaves], clearedFrontWaves: [...result.clearedFrontWaves], retiredWaves: [...result.retiredWaves],
      };
      if (settings.retireLive !== false) {
        this.alive = this.alive.filter(enemy => !events.retiredWaves.includes(enemy.waveIndex));
      }
      if (spawn) this.spawn(canSpawn);
      assert.ok(this.alive.length <= settings.maxAlive, 'The live cap applies across all active groups');
      return events;
    },
    clear(index) {
      this.alive = index === undefined ? [] : this.alive.filter(enemy => enemy.waveIndex !== index);
    },
  };
}

function stairPlacement(game, position) {
  const settings = ZONE_WAVE_CONFIG.stairwell;
  return entry => {
    const candidates = encounterSpawnCandidates(settings, entry.waveIndex, 0, position.y);
    const point = selectSafeSpawn(candidates, {
      playerFoot: position,
      enemies: game.alive.map(enemy => ({ alive: true, pos: enemy.pos })),
      maxHeightDifference: settings.maxHeightDifference,
      floorAt: candidate => candidate.y, blocked: () => false,
    });
    if (!point) return false;
    entry.pos = point;
    return true;
  };
}

function tickStairs(game, dt, position, options = {}) {
  return game.tick(dt, { footY: position.y, canSpawn: stairPlacement(game, position), ...options });
}

test('fast ascent retires an unsafe pending stair pair and makes upper groups available', () => {
  const settings = ZONE_WAVE_CONFIG.stairwell;
  const game = driveEncounter(settings, 4), plan = game.schedule;
  const entrance = { x: -19.4, y: 4.02, z: -9.2 };
  tickStairs(game, settings.firstWave, entrance);
  assert.equal(game.alive.length, 2);
  game.clear();
  tickStairs(game, 0, { x: -16.6, y: 6.42, z: -0.65 });
  const secondLanding = { x: -16.6, y: 9.02, z: -9.2 };
  tickStairs(game, 1, secondLanding);
  assert.equal(plan.waveIndex, 2);
  assert.deepEqual(plan.pendingTypes, settings.waves[1]);
  assert.equal(game.alive.length, 0, 'Both landing anchors are too close to place safely');
  tickStairs(game, 120, secondLanding);
  assert.deepEqual(plan.pendingTypes, settings.waves[1], 'Waiting cannot relax the five metre safety rule');

  const thirdLanding = { x: -19.4, y: 11.62, z: -0.65 };
  const originalCandidates = settings.stages[1].spawnIndices.map(index => settings.spawns[index]);
  assert.deepEqual(originalCandidates.filter(point => point.y >= thirdLanding.y - 0.25), []);
  assert.deepEqual(encounterSpawnCandidates(settings, 1, 0, thirdLanding.y), []);
  const event = tickStairs(game, 0, thirdLanding);
  assert.deepEqual(event.retiredWaves, [1]);
  assert.deepEqual(event.clearedWaves, []);
  assert.equal(plan.skipped, 2);
  assert.equal(plan.waveIndex, 3, 'A passed floor cannot block the next group indefinitely');
  assert.deepEqual(plan.pendingTypes, settings.waves[2]);

  const upperFlight = { x: -16.6, y: 11.98, z: -3.6 };
  const nextEvent = tickStairs(game, 0, upperFlight);
  assert.deepEqual(nextEvent.retiredWaves, [2]);
  assert.deepEqual(nextEvent.clearedWaves, []);
  assert.equal(plan.skipped, 4);
  assert.equal(plan.waveIndex, 4);
  assert.equal(game.alive.length, 2);
  assert.ok(game.alive.every(enemy => enemy.waveIndex === 3));
  assert.deepEqual(plan.pendingTypes, []);
  game.clear();
  assert.equal(tickStairs(game, 0, upperFlight).completed, true);
  assert.equal(plan.clearedWaves, 2, 'Only the two fought groups receive clear credit');
  tickStairs(game, 120, upperFlight);
  assert.equal(plan.spawned, 4);
});

test('jumping above a stair landing does not retire its living pair', () => {
  const settings = ZONE_WAVE_CONFIG.stairwell;
  const game = driveEncounter(settings, 4), plan = game.schedule;
  tickStairs(game, settings.firstWave, { x: -19.4, y: 4.02, z: -9.2 });
  const airborne = { x: -19.4, y: settings.stages[0].departAbove + 0.5, z: -0.65 };
  assert.deepEqual(tickStairs(game, 0.25, airborne, { grounded: false }).retiredWaves, []);
  assert.equal(plan.skipped, 0);
  assert.equal(game.alive.length, 2);
  tickStairs(game, 0.25, { ...airborne, y: 6.42 });
  assert.equal(plan.skipped, 0);
  const event = tickStairs(game, 0, { x: -16.6, y: 6.8, z: -3.5 }, { spawn: false });
  assert.deepEqual(event.retiredWaves, [0]);
  assert.deepEqual(event.clearedWaves, []);
  assert.equal(plan.skipped, 0);
  assert.equal(game.alive.length, 2, 'Grounded ascent also preserves both living actors');
});

test('living stair pursuers retain identity and capacity when their landing is passed', () => {
  const settings = ZONE_WAVE_CONFIG.stairwell;
  const game = driveEncounter(settings, 4), plan = game.schedule;
  tickStairs(game, settings.firstWave, { x: -19.4, y: 4.02, z: -9.2 });
  const originalPair = [...game.alive];
  const nextFlight = { x: -16.6, y: 6.8, z: -3.5 };
  const event = tickStairs(game, 0, nextFlight);
  assert.deepEqual(event.retiredWaves, [0]);
  assert.deepEqual(event.clearedWaves, []);
  assert.equal(plan.skipped, 0);
  assert.deepEqual(plan.pendingTypes, settings.waves[1]);
  for (let i = 0; i < 3; i++) {
    tickStairs(game, 40, nextFlight);
    assert.equal(game.alive[0], originalPair[0]);
    assert.equal(game.alive[1], originalPair[1]);
    assert.equal(plan.spawned, 2, 'Passing a living enemy cannot free a spawn slot');
    assert.equal(plan.cleared, false);
  }

  game.alive.shift();
  const afterFirstDeath = tickStairs(game, 0, nextFlight);
  assert.deepEqual(afterFirstDeath.clearedWaves, []);
  assert.equal(game.alive[0], originalPair[1]);
  assert.equal(game.alive.length, 2);
  assert.equal(plan.spawned, 3);
  assert.equal(plan.pendingTypes.length, 1, 'Only one freed slot can be replenished');
  game.alive = game.alive.filter(enemy => enemy !== originalPair[1]);
  tickStairs(game, 0, nextFlight);
  assert.equal(game.alive.length, 2);
  assert.equal(plan.spawned, 4);
  assert.deepEqual(plan.pendingTypes, []);
  assert.equal(plan.skipped, 0);
});

test('passing a partially placed stair pair skips only its unspawned contact', () => {
  const settings = ZONE_WAVE_CONFIG.stairwell;
  const game = driveEncounter(settings, 4), plan = game.schedule;
  const start = { x: -19.4, y: 4.02, z: -9.2 };
  tickStairs(game, settings.firstWave, start, {
    canSpawn: entry => game.alive.length === 0 && stairPlacement(game, start)(entry),
  });
  const survivor = game.alive[0];
  assert.equal(plan.pendingTypes.length, 1);
  const event = tickStairs(game, 0, { x: -16.6, y: 6.8, z: -3.5 });
  assert.deepEqual(event.retiredWaves, [0]);
  assert.deepEqual(event.clearedWaves, []);
  assert.equal(plan.skipped, 1);
  assert.equal(game.alive[0], survivor);
  assert.equal(game.alive.length, 2);
  assert.ok(plan.pending.every(entry => entry.waveIndex === 1));
  assert.equal(plan.spawned, 2);
});

test('retained stair actors must die before an otherwise exhausted schedule can finish', () => {
  const settings = ZONE_WAVE_CONFIG.stairwell;
  const game = driveEncounter(settings, 4), plan = game.schedule;
  tickStairs(game, settings.firstWave, { x: -19.4, y: 4.02, z: -9.2 });
  game.tick(0, { footY: 14.4 });
  assert.equal(plan.waveIndex, 4);
  assert.equal(plan.skipped, 6);
  assert.equal(plan.spawned, 2);
  assert.equal(game.alive.length, 2);
  assert.deepEqual(plan.pendingTypes, []);
  assert.deepEqual(plan.unstartedTypes, []);
  assert.equal(game.tick(120, { footY: 14.4 }).completed, false);
  game.clear();
  const event = game.tick(0, { footY: 14.4 });
  assert.equal(event.completed, true);
  assert.deepEqual(event.clearedWaves, [], 'Retirement never manufactures a clear reward');
  assert.equal(plan.skipped, 6);
});

test('ascending arrival shortens recovery only after the next flight begins', () => {
  const settings = ZONE_WAVE_CONFIG.stairwell;
  for (let index = 1; index < settings.waveCount; index++) {
    const stage = settings.stages[index];
    const threshold = settings.waveInterval - settings.minRecovery;
    assert.equal(encounterWaveReady(settings, index, 0.01, 0, stage.advanceFootY - 0.01), false);
    assert.equal(encounterWaveReady(settings, index, threshold + 0.01, 0, stage.advanceFootY), false);
    assert.equal(encounterWaveReady(settings, index, threshold, 0, stage.advanceFootY), true);
    assert.equal(encounterWaveReady(settings, index, 0, 0, stage.advanceFootY - 0.01), true);
    assert.equal(encounterWaveReady(settings, index, -100, 0, stage.departAbove + 0.01), false);
  }
});

test('walking and sprinting the authored stairs can encounter all four pairs before passing their floors', () => {
  const settings = ZONE_WAVE_CONFIG.stairwell;
  for (const speed of [4.2, 7]) {
    const game = driveEncounter(settings, 4), plan = game.schedule;
    let position = { x: STAIRS.lanes.west, y: 4.02, z: STAIRS.turns.northZ };
    tickStairs(game, settings.firstWave, position);
    for (const [index, flight] of STAIRS.flights.entries()) {
      const startingZ = flight.lane === 'west' ? STAIRS.turns.northZ : STAIRS.turns.southZ;
      const endingZ = flight.lane === 'west' ? STAIRS.turns.southZ : STAIRS.turns.northZ;
      const legs = [
        { x: flight.x, z: startingZ, climbing: false },
        { x: flight.x, z: endingZ, climbing: true },
      ];
      for (const leg of legs) {
        const from = { ...position }, dx = leg.x - from.x, dz = leg.z - from.z;
        const duration = Math.hypot(dx, dz) / speed;
        const steps = Math.ceil(duration * 60);
        for (let step = 1; step <= steps; step++) {
          const fraction = step / steps;
          const z = from.z + dz * fraction;
          const climb = Math.max(0, Math.min(1, (z - flight.zStart) / (flight.zEnd - flight.zStart)));
          const y = leg.climbing ? flight.fromY + Math.ceil(climb * flight.steps) * flight.rise : flight.fromY;
          position = { x: from.x + dx * fraction, y: y + 0.02, z };
          tickStairs(game, duration / steps, position);
        }
      }
      assert.deepEqual(game.history.filter(enemy => enemy.waveIndex === index).map(enemy => enemy.type), settings.waves[index],
        `The pair on landing ${index + 1} must arrive during a ${speed} m/s climb`);
      game.clear(index);
      tickStairs(game, 0, position);
    }
    assert.equal(plan.spawned, 8);
    assert.equal(plan.skipped, 0);
    assert.equal(plan.cleared, true);
  }
});

test('retired stair landings never re-arm on a retreat and checkpoint retry clears retirement', () => {
  const settings = ZONE_WAVE_CONFIG.stairwell;
  const game = driveEncounter(settings, 11.62), plan = game.schedule;
  game.tick(0, { spawn: false });
  assert.equal(plan.skipped, 4);
  assert.equal(plan.waveIndex, 3);
  game.tick(120, { footY: 4.02, canSpawn: () => false });
  assert.equal(plan.waveIndex, 3);
  assert.deepEqual(plan.pending.map(entry => entry.waveIndex), [2, 2]);
  plan.reset();
  assert.equal(plan.skipped, 0);
  assert.deepEqual(plan.groups, []);
  assert.equal(plan.waveIndex, 0);
  tickStairs(game, settings.firstWave, { x: -19.4, y: 4.02, z: -9.2 });
  assert.deepEqual(game.alive.map(enemy => enemy.type), settings.waves[0]);
});

test('roof reserves require both sentries to spawn and clear, regardless of elapsed time', () => {
  const roof = ZONE_WAVE_CONFIG.roof;
  const game = driveEncounter(roof, 14), plan = game.schedule;
  game.tick(roof.firstWave);
  assert.deepEqual(game.alive.map(enemy => enemy.type), roof.waves[0]);
  game.tick(100);
  assert.equal(plan.waveIndex, 1);
  assert.equal(plan.reinforcementsActive, false);
  game.alive.pop();
  game.tick(100);
  assert.equal(plan.waveIndex, 1);
  assert.equal(plan.reinforcementsActive, false);
  game.clear();
  const event = game.tick(0);
  assert.deepEqual(event.clearedWaves, [0]);
  assert.equal(plan.reinforcementsActive, true);
  assert.equal(plan.timer, roof.reinforcements.firstDelay);
  assert.equal(plan.waveIndex, 1);
  game.tick(roof.reinforcements.firstDelay / 2);
  assert.equal(plan.waveIndex, 1);
  game.tick(roof.reinforcements.firstDelay / 2);
  assert.equal(plan.waveIndex, 2);
  assert.deepEqual(game.alive.map(enemy => enemy.type), roof.waves[1]);
});

test('roof reserves overlap surviving response contacts while preserving the global cap and queued roster', () => {
  const roof = ZONE_WAVE_CONFIG.roof;
  const game = driveEncounter(roof, 14), plan = game.schedule;
  game.tick(roof.firstWave);
  game.clear();
  game.tick(0);
  game.tick(roof.reinforcements.firstDelay);
  assert.equal(game.alive.length, 4);
  game.tick(roof.reinforcements.interval - 0.5);
  assert.equal(game.alive.length, 4);
  game.tick(0.5);
  assert.equal(game.alive.length, 5);
  assert.equal(game.alive.filter(enemy => enemy.waveIndex === 1).length, 4);
  assert.equal(game.alive.filter(enemy => enemy.waveIndex === 2).length, 1);
  assert.deepEqual(plan.pendingTypes, roof.waves[2].slice(1));
  assert.deepEqual(plan.unstartedTypes, roof.waves[3]);
  game.tick(100);
  assert.equal(plan.waveIndex, 3, 'An unplaced group cannot be buried beneath another pending group');
  assert.equal(plan.spawned, 7);
  game.clear(1);
  game.tick(0);
  assert.deepEqual(game.alive.map(enemy => enemy.type), roof.waves[2]);
  assert.deepEqual(plan.pendingTypes, []);
  game.tick(0);
  assert.equal(plan.waveIndex, 4);
  assert.equal(game.alive.length, 5);
  assert.deepEqual(plan.pendingTypes, roof.waves[3].slice(2));
  assert.equal(plan.cleared, false);
});

test('blocked or exhausted pools retain the exact pending types and cannot clear a zero-spawn group', () => {
  const roof = ZONE_WAVE_CONFIG.roof;
  const game = driveEncounter(roof, 14), plan = game.schedule;
  game.tick(roof.firstWave, { canSpawn: () => false });
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(game.tick(100, { canSpawn: () => false }).clearedWaves, []);
    assert.deepEqual(plan.pendingTypes, roof.waves[0]);
    assert.equal(plan.spawned, 0);
    assert.equal(plan.cleared, false);
    assert.equal(plan.reinforcementsActive, false);
    assert.equal(plan.waveIndex, 1);
  }
  assert.equal(game.spawn(), 2);
  assert.deepEqual(plan.pendingTypes, []);
  assert.equal(plan.spawned, 2);
});

test('a partially placed sentry pair cannot arm reinforcements after its only living contact dies', () => {
  const roof = ZONE_WAVE_CONFIG.roof;
  const game = driveEncounter(roof, 14), plan = game.schedule;
  game.tick(roof.firstWave, { canSpawn: () => game.alive.length === 0 });
  assert.equal(plan.spawned, 1);
  game.clear();
  game.tick(100, { canSpawn: () => false });
  assert.equal(plan.clearedWaves, 0);
  assert.equal(plan.reinforcementsActive, false);
  assert.deepEqual(plan.pendingTypes, roof.waves[0].slice(1));
});

test('type caps defer excess heavy weapons without blocking other eligible contacts', () => {
  const waves = [['enforcer', 'enforcer', 'gunman']];
  const settings = {
    waves, waveCount: 1, firstWave: 0, waveInterval: 5, maxAlive: 3,
    typeCaps: { enforcer: 1 }, composition: index => waves[index] || [],
  };
  const game = driveEncounter(settings, 0), plan = game.schedule;
  game.tick(0);
  assert.deepEqual(game.alive.map(enemy => enemy.type), ['enforcer', 'gunman']);
  assert.deepEqual(plan.pendingTypes, ['enforcer']);
  game.tick(100);
  assert.equal(plan.spawned, 2);
  game.alive = game.alive.filter(enemy => enemy.type !== 'enforcer');
  game.tick(0);
  assert.deepEqual(game.alive.map(enemy => enemy.type), ['gunman', 'enforcer']);
  assert.equal(plan.spawned, 3);
  assert.deepEqual(plan.pendingTypes, []);
});

test('all roof and final contacts are finite, counted once and exhausted only after every wave clears', () => {
  const encounters = [
    [ZONE_WAVE_CONFIG.roof, 14, 12],
    [FINAL_ENCOUNTERS.car, 0.05, 8],
    [FINAL_ENCOUNTERS.bakery, 0.08, 18],
  ];
  for (const [settings, footY, total] of encounters) {
    const game = driveEncounter(settings, footY), plan = game.schedule;
    game.tick(settings.firstWave);
    for (let tick = 0; tick < 300 && !plan.cleared; tick++) {
      game.clear();
      game.tick(0.25);
    }
    assert.equal(plan.total, total);
    assert.equal(plan.spawned, total);
    assert.equal(plan.skipped, 0);
    assert.equal(plan.cleared, true);
    assert.equal(plan.clearedWaves, settings.waveCount);
    assert.deepEqual(plan.pendingTypes, []);
    assert.deepEqual(plan.unstartedTypes, []);
    for (const [index, group] of settings.waves.entries()) {
      const entries = game.history.filter(entry => entry.waveIndex === index);
      assert.deepEqual(entries.map(entry => entry.type), group);
      assert.deepEqual(entries.map(entry => entry.firstForWave), group.map((_, i) => i === 0));
    }
    game.tick(1000);
    assert.equal(game.history.length, total);
  }
});

test('clearing a final opening group cannot win with future groups still unstarted', () => {
  for (const settings of Object.values(FINAL_ENCOUNTERS)) {
    const game = driveEncounter(settings, 0.08), plan = game.schedule;
    game.tick(0);
    assert.equal(plan.waveIndex, 1);
    assert.equal(plan.spawned, 4);
    assert.deepEqual(plan.unstartedTypes, settings.waves.slice(1).flat());
    game.clear();
    const event = game.tick(0);
    assert.deepEqual(event.clearedWaves, [0]);
    assert.equal(event.completed, false);
    assert.equal(plan.cleared, false);
    assert.equal(plan.timer, settings.waveInterval);
    game.tick(settings.waveInterval / 2);
    assert.equal(plan.waveIndex, 1);
    game.tick(settings.waveInterval / 2);
    assert.equal(plan.waveIndex, 2);
    assert.deepEqual(game.alive.map(enemy => enemy.type), settings.waves[1]);
  }
});

test('retry resets reserve timing and ownership to the exact original pending roster', () => {
  for (const settings of [ZONE_WAVE_CONFIG.roof, ...Object.values(FINAL_ENCOUNTERS)]) {
    const game = driveEncounter(settings, settings === ZONE_WAVE_CONFIG.roof ? 14 : 0.08), plan = game.schedule;
    game.tick(settings.firstWave);
    game.clear();
    game.tick(0);
    game.tick(100);
    assert.ok(plan.waveIndex > 1);
    game.clear();
    plan.reset();
    assert.equal(plan.waveIndex, 0);
    assert.equal(plan.spawned, 0);
    assert.equal(plan.skipped, 0);
    assert.equal(plan.clearedWaves, 0);
    assert.equal(plan.cleared, false);
    assert.equal(plan.wavePending, false);
    assert.equal(plan.reinforcementsActive, false);
    assert.equal(plan.timer, settings.firstWave);
    assert.deepEqual(plan.pendingTypes, []);
    assert.deepEqual(plan.unstartedTypes, settings.waves.flat());
    game.tick(settings.firstWave, { spawn: false });
    assert.deepEqual(plan.pendingTypes, settings.waves[0]);
    const copy = plan.pendingTypes;
    copy.pop();
    assert.deepEqual(plan.pendingTypes, settings.waves[0], 'Inspection cannot mutate a retry roster');
  }
});

test('scheduled balcony pairs keep the full holding breather and minimum advancing recovery', () => {
  for (const advancing of [false, true]) {
    const game = driveEncounter(config, route.floorY), plan = game.schedule;
    game.tick(config.firstWave);
    game.clear();
    const stage = config.stages[1], progress = advancing ? stage.advanceAt : stage.minProgress;
    game.tick(0, { routeProgress: progress });
    const delay = advancing ? config.minRecovery : config.waveInterval;
    game.tick(delay - 0.25, { routeProgress: progress });
    assert.equal(plan.waveIndex, 1);
    game.tick(0.25, { routeProgress: progress });
    assert.equal(plan.waveIndex, 2);
    assert.deepEqual(game.alive.map(enemy => enemy.type), config.waves[1]);
    assert.equal(game.alive.length, 3);
  }
});

test('the opening pair becomes eligible on exactly the twelfth 120 Hz simulation tick', () => {
  const game = driveEncounter(config, route.floorY);
  for (let tick = 1; tick <= 12; tick++) {
    game.tick(1 / 120);
    assert.equal(game.alive.length, tick < 12 ? 0 : 2, `tick ${tick}`);
  }
  assert.equal(game.schedule.spawned, 2);
});

test('a blocked partner keeps both forward slots pending without singleton arrivals or clear credit', () => {
  const game = driveEncounter(config, route.floorY), plan = game.schedule;
  const onlyFirstFits = entry => entry.entryIndex === 0;
  game.tick(config.firstWave, { canSpawn: onlyFirstFits });
  const pending = [...plan.pending];
  for (let attempt = 0; attempt < 10; attempt++) {
    const event = game.tick(20, { routeProgress: 30, canSpawn: onlyFirstFits });
    assert.equal(game.alive.length, 0);
    assert.equal(plan.spawned, 0);
    assert.equal(plan.waveIndex, 1);
    assert.deepEqual(event.clearedFrontWaves, []);
    assert.deepEqual(event.clearedWaves, []);
    assert.equal(plan.pending[0], pending[0]);
    assert.equal(plan.pending[1], pending[1]);
    assert.equal(plan.groups[0].frontPending, 2);
  }
  game.tick(0);
  assert.equal(game.alive.length, 2);
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.groups[0].frontSpawned, 2);
  const second = game.alive[1];
  game.alive.shift();
  assert.deepEqual(game.tick(100, { routeProgress: 30 }).clearedFrontWaves, []);
  assert.equal(game.alive[0], second, 'A quick first kill cannot erase or replace its already committed partner');
  assert.equal(plan.waveIndex, 1);
  assert.equal(plan.spawned, 2);
});

test('a forward pair requires two free slots and an explicit all-or-nothing callback', () => {
  const plan = new EncounterSchedule(config);
  plan.update(config.firstWave, { footY: route.floorY });
  const neverSingle = () => assert.fail('An atomic forward slot cannot fall through to a singleton callback');
  const neverPair = () => assert.fail('One free slot cannot acquire a forward pair');
  assert.equal(plan.spawnAvailable({ total: 2 }, neverSingle, neverPair), 0);
  assert.equal(plan.spawnAvailable({ total: 0 }, neverSingle), 0);
  let attempts = 0;
  assert.equal(plan.spawnAvailable({ total: 0 }, neverSingle, entries => {
    attempts++;
    assert.deepEqual(entries.map(entry => entry.entryIndex), [0, 1]);
    return false;
  }), 0);
  assert.equal(attempts, 1, 'A failed batch is attempted only once per call');
  assert.deepEqual(plan.pendingTypes, config.waves[0]);
  assert.equal(plan.spawned, 0);
  assert.equal(plan.groups[0].frontSpawned, 0);
  assert.equal(plan.spawnAvailable({ total: 1, rearAlive: 1 }, neverSingle, () => true), 2);
  assert.equal(plan.pending.length, 0);
});

test('pending rear reserves never suppress a later forward pair or disappear on front clearance', () => {
  const game = driveEncounter(config, route.floorY), plan = game.schedule;
  const frontOnly = entry => entry.entryIndex < config.frontPairSize;
  game.tick(config.firstWave);
  game.clear();
  game.tick(0, { routeProgress: config.stages[1].advanceAt });
  game.tick(config.minRecovery, { routeProgress: config.stages[1].advanceAt, canSpawn: frontOnly });
  assert.equal(game.alive.length, 2);
  const firstRear = plan.pending[0];
  assert.equal(firstRear.entryIndex, 2);
  assert.equal(firstRear.waveIndex, 1);
  game.clear();
  const event = game.tick(0, { routeProgress: config.stages[2].advanceAt, canSpawn: frontOnly });
  assert.deepEqual(event.clearedFrontWaves, [1]);
  assert.deepEqual(event.clearedWaves, [], 'An unspawned reserve cannot earn health or clear credit');
  assert.equal(plan.pending[0], firstRear);
  game.tick(config.minRecovery, { routeProgress: config.stages[2].advanceAt, canSpawn: frontOnly });
  assert.equal(game.alive.length, 2);
  assert.ok(game.alive.every(enemy => enemy.waveIndex === 2));
  assert.equal(plan.spawned, 6);
  assert.deepEqual(plan.pending.map(entry => [entry.waveIndex, entry.entryIndex]), [[1, 2], [2, 2]]);
  const secondRear = plan.pending[1];
  game.clear();
  for (let tick = 0; tick < 3; tick++) game.tick(100, { routeProgress: 0, canSpawn: frontOnly });
  assert.equal(plan.pending[0], firstRear);
  assert.equal(plan.pending[1], secondRear);
  assert.equal(plan.cleared, false);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.clearedWaves, 1);

  game.tick(0);
  assert.equal(game.alive.length, 1, 'The two retained rear entries cannot occupy both forward slots');
  assert.equal(plan.pending[0], secondRear);
  game.clear();
  game.tick(0);
  assert.equal(game.alive.length, 1);
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.cleared, false);
  game.clear();
  assert.equal(game.tick(0).completed, true);
  assert.equal(plan.spawned, 8);
  assert.equal(plan.clearedWaves, 3);
  assert.equal(new Set(game.history.map(entry => `${entry.waveIndex}:${entry.entryIndex}`)).size, 8);
});

test('a living rear attacker leaves capacity for the next complete forward pair', () => {
  const game = driveEncounter(config, route.floorY), plan = game.schedule;
  game.tick(config.firstWave);
  game.clear();
  game.tick(0, { routeProgress: config.stages[1].advanceAt });
  game.tick(config.minRecovery, { routeProgress: config.stages[1].advanceAt });
  assert.equal(game.alive.length, 3);
  const rear = game.alive.find(enemy => enemy.entryIndex === 2);
  game.alive = [rear];
  const event = game.tick(0, { routeProgress: config.stages[2].advanceAt });
  assert.deepEqual(event.clearedFrontWaves, [1]);
  assert.deepEqual(event.clearedWaves, []);
  game.tick(config.minRecovery - 0.01, { routeProgress: config.stages[2].advanceAt });
  assert.deepEqual(game.alive, [rear]);
  game.tick(0.01, { routeProgress: config.stages[2].advanceAt });
  assert.equal(game.alive[0], rear);
  assert.equal(game.alive.length, 3);
  assert.deepEqual(game.alive.slice(1).map(enemy => [enemy.waveIndex, enemy.entryIndex]), [[2, 0], [2, 1]]);
  assert.deepEqual(plan.pending.map(entry => [entry.waveIndex, entry.entryIndex]), [[2, 2]]);
  assert.equal(plan.spawned, 7);

  const survivor = game.alive[2];
  game.alive.splice(1, 1);
  game.tick(100);
  assert.equal(game.alive.length, 2);
  assert.equal(game.alive[1], survivor);
  assert.equal(plan.pending.length, 1, 'A freed forward slot cannot become a second rear attacker');
  assert.equal(plan.cleared, false);
  game.clear(1);
  game.tick(0);
  assert.equal(game.alive.length, 2);
  assert.equal(plan.spawned, 8);
  assert.equal(plan.pending.length, 0);
  game.clear();
  assert.equal(game.tick(0).completed, true);
});

test('retry discards front-clear timing and restores all authored balcony roles', () => {
  const game = driveEncounter(config, route.floorY), plan = game.schedule;
  game.tick(config.firstWave);
  game.clear();
  game.tick(0, { routeProgress: config.stages[1].advanceAt });
  game.tick(config.minRecovery, { routeProgress: config.stages[1].advanceAt });
  game.clear();
  plan.reset();
  assert.equal(plan.timer, config.firstWave);
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(plan.unstartedTypes, config.waves.flat());
  assert.equal(plan.spawned, 0);
  game.tick(config.firstWave);
  assert.deepEqual(game.alive.map(enemy => [enemy.waveIndex, enemy.entryIndex, enemy.type]), [[0, 0, 'brawler'], [0, 1, 'thug']]);
  assert.equal(plan.groups[0].frontCleared, false);
});

test('a seeded schedule keeps its initial deadline and plan across failed attempts and reset', () => {
  for (const seed of [0, 1, 93, 0xffffffff]) {
    const settings = ZONE_WAVE_CONFIG.roof, plan = new EncounterSchedule(settings, { seed });
    const variation = plan.variation, duration = variation.firstDelay;
    assert.equal(plan.seed, seed);
    assert.equal(plan.timer, duration);
    assert.equal(plan.timerDuration, duration);
    plan.update(duration - 0.001, { footY: 14 });
    for (let attempt = 0; attempt < 30; attempt++) {
      assert.equal(plan.update(0, { footY: 14 }).queuedWave, null);
      assert.equal(plan.spawnAvailable({ total: 0 }, () => false), 0);
      assert.equal(plan.timerDuration, duration);
    }
    assert.equal(plan.update(0.001, { footY: 14 }).queuedWave, 0);
    for (let attempt = 0; attempt < 30; attempt++) {
      plan.update(0.01, { footY: 14 });
      plan.spawnAvailable({ total: 0 }, () => false);
      assert.equal(plan.variation, variation);
      assert.equal(plan.timerDuration, duration);
      assert.deepEqual(plan.pendingTypes, settings.waves[0]);
    }
    plan.reset();
    assert.equal(plan.variation, variation);
    assert.equal(plan.seed, seed);
    assert.equal(plan.timer, duration);
    assert.equal(plan.timerDuration, duration);
    assert.equal(plan.spawned, 0);
    assert.equal(plan.pending.length, 0);
  }
});

test('shorter and longer sampled recoveries cannot bypass the minimum on an advancing route or flight', () => {
  let shorter = 0, longer = 0;
  for (const settings of [config, ZONE_WAVE_CONFIG.stairwell]) {
    for (let seed = 0; seed < 32; seed++) {
      const game = driveEncounter(settings, 4, { seed }), plan = game.schedule;
      game.tick(plan.variation.firstDelay);
      assert.equal(game.alive.length, 2);
      game.clear();
      const stage = settings.stages[1];
      const advancing = { routeProgress: stage.advanceAt ?? 0, footY: stage.advanceFootY ?? 4 };
      game.tick(0, advancing);
      assert.equal(plan.recoveryDelay, plan.variation.recoveryDelays[1]);
      assert.equal(plan.timerDuration, plan.recoveryDelay);
      if (plan.recoveryDelay < settings.waveInterval) shorter++;
      if (plan.recoveryDelay > settings.waveInterval) longer++;
      game.tick(settings.minRecovery - 0.001, advancing);
      assert.equal(plan.waveIndex, 1, `seed ${seed}: no early wave after a shorter sampled breather`);
      assert.equal(plan.timerDuration, plan.recoveryDelay);
      game.tick(0.001, advancing);
      assert.equal(plan.waveIndex, 2);
    }
  }
  assert.ok(shorter > 10 && longer > 10, 'Both sides of the timing range must be exercised');
});

test('holding a balcony segment observes its whole sampled recovery instead of the authored base interval', () => {
  for (let seed = 0; seed < 32; seed++) {
    const game = driveEncounter(config, 4, { seed }), plan = game.schedule;
    game.tick(plan.variation.firstDelay);
    game.clear();
    const holding = { routeProgress: config.stages[1].minProgress };
    game.tick(0, holding);
    const sampled = plan.recoveryDelay;
    game.tick(sampled - 0.001, holding);
    assert.equal(plan.waveIndex, 1);
    game.tick(0.001, holding);
    assert.equal(plan.waveIndex, 2);
    assert.equal(game.alive.length, 3);
  }
});

test('seeded roof reserves still require both sentries to die and obey sampled delays and the five-live cap', () => {
  const roof = ZONE_WAVE_CONFIG.roof;
  for (let seed = 0; seed < 24; seed++) {
    const game = driveEncounter(roof, 14, { seed }), plan = game.schedule;
    game.tick(plan.variation.firstDelay);
    game.tick(100);
    assert.equal(plan.waveIndex, 1);
    assert.equal(game.alive.length, 2);
    game.alive.pop();
    game.tick(100);
    assert.equal(plan.reinforcementsActive, false);
    game.clear();
    game.tick(0);
    assert.equal(plan.reinforcementsActive, true);
    assert.equal(plan.timerDuration, plan.variation.reinforcementFirstDelay);
    game.tick(plan.timerDuration - 0.001);
    assert.equal(plan.waveIndex, 1);
    game.tick(0.001);
    assert.equal(plan.waveIndex, 2);
    assert.equal(game.alive.length, 4);
    assert.equal(plan.timerDuration, plan.variation.reinforcementIntervals[2]);
    game.tick(plan.timerDuration - 0.001);
    assert.equal(game.alive.length, 4);
    game.tick(0.001);
    assert.equal(game.alive.length, 5);
    assert.equal(plan.pending.length, 2);
    game.tick(100);
    assert.equal(plan.waveIndex, 3, 'A full group cannot bury a pending reserve beneath another wave');
    for (let tick = 0; tick < 100 && !plan.cleared; tick++) {
      game.clear();
      game.tick(0.25);
    }
    assert.equal(plan.spawned, 12);
    assert.equal(plan.skipped, 0);
    assert.equal(plan.cleared, true);
    assert.equal(new Set(game.history.map(entry => `${entry.waveIndex}:${entry.entryIndex}`)).size, 12);
  }
});

test('frame subdivision and extra failed probes do not reroll a seeded initial arrival', () => {
  for (const settings of [config, ZONE_WAVE_CONFIG.roof]) {
    const reference = new EncounterSchedule(settings, { seed: 0x3920fbae });
    for (const parts of [1, 7, 60, 120]) {
      const plan = new EncounterSchedule(settings, { seed: reference.seed });
      for (let step = 0; step < parts; step++) {
        plan.update(reference.variation.firstDelay / parts, { footY: settings === config ? 4 : 14 });
        for (let probe = 0; probe < step % 4; probe++) plan.spawnAvailable({ total: 0 }, () => false, () => false);
      }
      assert.deepEqual(plan.variation, reference.variation);
      assert.equal(plan.waveIndex, 1);
      assert.equal(plan.timerDuration, reference.variation.firstDelay);
      assert.deepEqual(plan.pendingTypes, settings.waves[0]);
      assert.ok(plan.pending.every(entry => entry.waitedSeconds === 0));
    }
  }
});

test('scaffold departure retains living contacts and retires only queued arrivals without a reward', () => {
  const settings = ZONE_WAVE_CONFIG.scaffolding;
  const game = driveEncounter(settings, 10), plan = game.schedule;
  game.tick(settings.firstWave);
  assert.equal(game.alive.length, 3);
  const upperContacts = [...game.alive];
  let event = game.tick(0, { footY: 7 });
  assert.deepEqual(event.retiredWaves, [0]);
  assert.deepEqual(event.clearedWaves, []);
  assert.deepEqual(game.alive, upperContacts);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.timer, settings.stageTransitionDelay);
  game.tick(settings.stageTransitionDelay - 0.25, { footY: 7 });
  assert.equal(plan.waveIndex, 1);
  game.tick(0.25, { footY: 7 });
  assert.equal(plan.waveIndex, 2);
  assert.equal(game.alive.length, 3);
  assert.deepEqual(game.alive, upperContacts, 'Survivors keep their slots under the live cap');
  assert.deepEqual(plan.pendingTypes, settings.waves[1]);
  game.clear(0);
  event = game.tick(0, { footY: 7 });
  assert.deepEqual(event.clearedWaves, [], 'Abandoning a platform cannot grant recovery credit later');
  assert.deepEqual(plan.pendingTypes, settings.waves[1].slice(3));
  const middleContacts = [...game.alive];
  event = game.tick(0, { footY: 4 });
  assert.deepEqual(event.retiredWaves, [1]);
  assert.deepEqual(event.clearedWaves, []);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.clearedWaves, 0);
  assert.deepEqual(plan.pendingTypes, []);
  assert.deepEqual(game.alive, middleContacts);
  game.tick(settings.stageTransitionDelay, { footY: 4 });
  assert.deepEqual(game.alive, middleContacts);
  assert.deepEqual(plan.pendingTypes, settings.waves[2]);
  game.clear(1);
  game.tick(0, { footY: 4 });
  assert.deepEqual(game.alive.map(enemy => enemy.type), settings.waves[2]);
});

test('committed descent can abandon unstarted decks but does not report an empty encounter cleared', () => {
  const settings = ZONE_WAVE_CONFIG.scaffolding;
  const game = driveEncounter(settings, 1.5), plan = game.schedule;
  const event = game.tick(0, { spawn: false });
  assert.deepEqual(event.retiredWaves, [0, 1, 2]);
  assert.deepEqual(event.clearedWaves, []);
  assert.equal(plan.skipped, 10);
  assert.equal(plan.spawned, 0);
  assert.equal(plan.cleared, false);
  assert.deepEqual(plan.unstartedTypes, settings.waves[3]);
  game.tick(settings.stageTransitionDelay, { canSpawn: () => false });
  game.tick(100, { canSpawn: () => false });
  assert.deepEqual(plan.pendingTypes, settings.waves[3]);
  assert.equal(plan.waveIndex, 4);
  assert.equal(plan.cleared, false);
});

test('a scaffold group larger than its live cap finishes only after its queued contact also fights', () => {
  const settings = ZONE_WAVE_CONFIG.scaffolding;
  const game = driveEncounter(settings, 7), plan = game.schedule;
  game.tick(0);
  game.tick(settings.stageTransitionDelay);
  assert.equal(game.alive.length, 3);
  assert.equal(plan.pendingTypes.length, 1);
  game.clear();
  const event = game.tick(0);
  assert.deepEqual(event.clearedWaves, []);
  assert.equal(game.alive.length, 1);
  assert.equal(plan.pendingTypes.length, 0);
  game.clear();
  assert.deepEqual(game.tick(0).clearedWaves, [1]);
  assert.equal(plan.clearedWaves, 1);
});

test('scaffold stage height bands reject early queues onto a different deck', () => {
  const settings = ZONE_WAVE_CONFIG.scaffolding;
  for (const [index, stage] of settings.stages.entries()) {
    assert.equal(encounterWaveReady(settings, index, -100, 0, stage.maxFootY + 0.01), false);
    assert.equal(encounterWaveReady(settings, index, -100, 0, stage.minFootY - 0.01), false);
    assert.equal(encounterWaveReady(settings, index, 0, 0, (stage.minFootY + stage.maxFootY) / 2), true);
  }
});

test('invalid simulation deltas cannot consume arrival time or queue an encounter', () => {
  const plan = new EncounterSchedule(ZONE_WAVE_CONFIG.roof);
  const initial = plan.timer;
  for (const dt of [-1, NaN, Infinity]) {
    plan.update(dt, { footY: 14 });
    assert.equal(plan.timer, initial);
    assert.equal(plan.waveIndex, 0);
  }
  plan.update(100, { footY: NaN });
  assert.equal(plan.timer, initial);
  assert.equal(plan.waveIndex, 0);
  plan.update(0, { footY: 14 });
  assert.equal(plan.timer, initial);
});
