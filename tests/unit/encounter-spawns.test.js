import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { effectiveRearWeapon, rearSpawnCandidates, selectEncounterSpawn, selectEncounterFrontPair } from '../../src/game/encounter-spawns.js';
import { EncounterSchedule, routeDistanceAt } from '../../src/game/encounter-rules.js';
import { describeOffscreenThreat } from '../../src/game/offscreen-threats.js';
import { isSegmentOccluded } from '../../src/game/combat-rules.js';
import { CHECKPOINTS, MIN_SPAWN_DISTANCE, SPAWN_CLEARANCE, ZONE_WAVE_CONFIG } from '../../src/game/mission-data.js';
import { hasPairBearingSeparation, isBehindPlayer } from '../../src/game/rear-encounter-rules.js';
import { createEncounterVariation, variedSpawnCandidates } from '../../src/game/encounter-variation.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { createAmmoSupplies } from '../../src/game/ammo-supplies.js';
import { AMMO_SUPPLY_CACHES } from '../../src/game/ammo-supply-rules.js';
import { Architecture, boxBounds } from '../../src/world/architecture.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { Colliders, capsuleHasClearance, resolveCapsuleAABB } from '../../src/core/collision.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';
import { weaponHarness } from './helpers/weapon-harness.js';

const point = (x, z, y = 4) => ({ x, y, z });
const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-6,
  `${label}: ${actual} != ${expected}`);
const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const sourceAt = position => ({ pos: position, radius: 0.48, height: 2.02 });
const sameAnchor = (position, anchor) => Math.abs(position.x - anchor.x) < 1e-6
  && Math.abs(position.z - anchor.z) < 1e-6 && Math.abs(position.y - anchor.y - SPAWN_CLEARANCE) < 1e-6;

function viewAt(foot, yaw = 0, overrides = {}) {
  return { position: { ...foot, y: foot.y + 1.7 }, yaw, pitch: 0, fov: 82, aspect: 16 / 9, zoom: 1, ...overrides };
}

function syntheticConfig({ front = [point(0, -8)], rear = [point(0, 8)], fallbackAfter = 1.5, stagger = true } = {}) {
  return {
    firstWave: 0, waveInterval: 0.5, minRecovery: 0.1, maxAlive: 2, maxHeightDifference: 1.2,
    rearPressure: { fallbackAfter, maxDistance: 12, stagger }, spawns: front, rearSpawns: rear,
    stages: [{ id: 'fixture-stage', minFootY: 3.75, maxFootY: 5.2, departAbove: 5.2,
      spawnIndices: front.map((_, index) => index), rearSpawnIndices: rear.map((_, index) => index) }],
    waves: [['gunman', 'thug']], waveCount: 1,
    composition(index) { return this.waves[index] || []; },
  };
}

function options(config, overrides = {}) {
  const playerFoot = overrides.playerFoot ?? point(0, 0), yaw = overrides.yaw ?? 0;
  return {
    config, waveIndex: 0, entryIndex: 1, waitedSeconds: 0, type: 'hitman',
    playerFoot, yaw, view: viewAt(playerFoot, yaw), weapon: { current: 'fists', loaded: 0, reserve: 0 },
    enemies: [], encounterKey: 'fixture', floorAt: candidate => candidate.y,
    blocked: () => false, occluded: () => false, ...overrides,
  };
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `Keep the explicit CPU fixture aligned with ${name}`);
  return source.slice(start, end + 2);
}

// Execute the production geometry probes with explicit math/scene services.
// No renderer, DOM, input loop or audio object is imported by this fixture.
function missionGeometry(camera) {
  const mission = readFileSync(new URL('../../src/game/mission.js', import.meta.url), 'utf8');
  const enemies = readFileSync(new URL('../../src/game/enemies.js', import.meta.url), 'utf8');
  const start = mission.indexOf('const spawnSightTarget = '), end = mission.indexOf('\nfunction pickFromConfig(', start);
  assert.ok(start >= 0 && end > start, 'Keep the production concealment fixture explicit');
  const api = runInNewContext(`${functionSource(mission, 'surfaceTopAt')}\n${functionSource(enemies, 'isBlocked')}\n`
    + mission.slice(start, end) + '\n;({ surfaceTopAt, isBlocked, spawnConcealed });', {
    THREE, Colliders, Architecture, camera, resolveCapsuleAABB, isSegmentOccluded,
    _ibBottom: new THREE.Vector3(), _ibTop: new THREE.Vector3(),
  });
  return {
    floorAt: candidate => api.surfaceTopAt(candidate.x, candidate.y, candidate.z, 0.28, 0.16),
    blocked: position => api.isBlocked(position, 0, 0, 0.48, 2.02),
    occluded: api.spawnConcealed,
  };
}

function realWorld() {
  const authored = buildWorldSurfaceFixture(), supplies = createAmmoSupplies();
  const game = weaponHarness({ supplies, colliders: Colliders });
  game.Weapons.init();
  supplies.init({ world: authored.World, player: game.Player, canInteract: () => !game.PlayerState.dead });
  return { ...game, authored, supplies, probes: missionGeometry(game.camera) };
}

function placeView(fixture, foot, yaw = 0, overrides = {}) {
  fixture.Player.pos.set(foot.x, foot.y + fixture.Player._eyeH, foot.z);
  fixture.camera.position.copy(fixture.Player.pos);
  return viewAt(foot, yaw, { position: fixture.camera.position, ...overrides });
}

function assertPlacement(selection, args, { fullClearance = false } = {}) {
  assert.ok(selection, 'The positive fixture must produce a placement');
  assert.ok(horizontalDistance(selection.point, args.playerFoot) >= MIN_SPAWN_DISTANCE - 1e-8);
  assert.equal(args.blocked(selection.point), false);
  if (fullClearance) assert.ok(capsuleHasClearance(selection.point, 0.48, 2.02, Colliders.list));
  assert.ok(Math.abs(selection.point.y - SPAWN_CLEARANCE - args.playerFoot.y) <= args.config.maxHeightDifference + 1e-8);
  if (selection.rear || selection.role === 'rear') {
    const projection = describeOffscreenThreat(args.view, sourceAt(selection.point));
    assert.ok(projection && (!projection.visible || args.occluded(sourceAt(selection.point))), 'The entire body is hidden at selection time');
    assert.ok(selection.graceSeconds >= 1);
  }
  if (selection.rear) {
    assert.ok(['brawler', 'thug'].includes(selection.type), 'No rear contact can carry a gun or heavy weapon');
    if (effectiveRearWeapon(args.weapon) === 'fists' || WEAPON_DEFS[effectiveRearWeapon(args.weapon)].kind !== 'ranged') {
      assert.equal(selection.type, 'brawler');
    }
  }
}

function pairEntries(config, waveIndex = 0) {
  return config.waves[waveIndex].slice(0, 2).map((type, entryIndex) => ({ type, entryIndex, waveIndex }));
}

function assertFrontPair(pair, args, fullClearance = false) {
  assert.equal(pair?.length, 2, 'Both forward positions are proposed together');
  for (const selected of pair) {
    assertPlacement(selected, args, { fullClearance });
    assert.equal(selected.role, 'front');
    assert.equal(selected.rear, false);
    assert.equal(selected.usedRearAnchor, false);
    assert.equal(isBehindPlayer(args.playerFoot, args.yaw, selected.point, { minDistance: 0, minRearDot: 0 }), false);
  }
  assert.ok(horizontalDistance(pair[0].point, pair[1].point) >= 1.5);
  assert.equal(hasPairBearingSeparation(args.playerFoot, pair[0].point, pair[1].point), true);
}

test('actual balcony geometry offers two unobscured staggered fronts at every authored stage', () => {
  const fixture = realWorld(), config = ZONE_WAVE_CONFIG.balcony;
  const positions = [CHECKPOINTS.balcony, point(4, 0.95), point(-6, 0.95)];
  for (const [waveIndex, anchor] of positions.entries()) {
    const yaw = waveIndex ? Math.PI / 2 : Math.PI;
    for (const dx of [-0.15, 0, 0.15]) for (const dz of [-0.15, 0, 0.15]) {
      const playerFoot = { x: anchor.x + dx, y: anchor.y, z: anchor.z + dz };
      const view = placeView(fixture, playerFoot, yaw);
      const args = options(config, { ...fixture.probes, playerFoot, yaw, view, waveIndex,
        entries: pairEntries(config, waveIndex), routeProgress: routeDistanceAt(config.route, playerFoot) });
      const pair = selectEncounterFrontPair(args);
      assertFrontPair(pair, args, true);
      for (const selected of pair) {
        assert.equal(describeOffscreenThreat(view, sourceAt(selected.point)).visible, true);
        const head = { ...selected.point, y: selected.point.y + 1.7 };
        assert.equal(isSegmentOccluded(view.position, head, Colliders.list), false,
          `Stage ${waveIndex} must expose both head bearings, not hide one around the corner`);
      }
      if (waveIndex === 0) assert.deepEqual(pair.map(selected => selected.point.x).sort((a, b) => a - b), [10, 12]);
    }
  }
});

test('the east pair retains strict five metre clearance after a tenth-second sprint from the checkpoint', () => {
  const fixture = realWorld(), config = ZONE_WAVE_CONFIG.balcony;
  for (const dx of [-0.15, 0, 0.15]) {
    const schedule = new EncounterSchedule(config);
    let playerFoot;
    for (let tick = 1; tick <= 12; tick++) {
      playerFoot = { x: CHECKPOINTS.balcony.x + dx, y: 4, z: CHECKPOINTS.balcony.z + tick / 120 * 7 };
      schedule.update(1 / 120, { footY: 4, routeProgress: routeDistanceAt(config.route, playerFoot) });
      assert.equal(schedule.pending.length, tick < 12 ? 0 : 2);
    }
    const yaw = Math.PI, view = placeView(fixture, playerFoot, yaw);
    const args = options(config, { ...fixture.probes, playerFoot, yaw, view, entries: schedule.pending,
      routeProgress: routeDistanceAt(config.route, playerFoot) });
    const pair = selectEncounterFrontPair(args);
    assertFrontPair(pair, args, true);
    assert.deepEqual(pair.map(selected => selected.point.x).sort((a, b) => a - b), [10, 12]);
  }
});

test('joint placement backtracks a safe first anchor that leaves no valid second bearing', () => {
  const fixture = realWorld(), config = ZONE_WAVE_CONFIG.balcony, playerFoot = point(4, 0.95), waveIndex = 1;
  const yaw = Math.PI / 2, view = placeView(fixture, playerFoot, yaw);
  const args = options(config, { ...fixture.probes, playerFoot, yaw, view, waveIndex, startIndex: 2,
    entries: pairEntries(config, waveIndex), routeProgress: routeDistanceAt(config.route, playerFoot) });
  assert.equal(config.spawns[config.stages[waveIndex].spawnIndices[2]].x, -12);
  const pair = selectEncounterFrontPair(args);
  assertFrontPair(pair, args, true);
  assert.notEqual(pair[0].point.x, -12, 'A safe single anchor must yield to a jointly valid pair');
  assert.equal(args.enemies.length, 0, 'A proposed pair cannot commit a temporary occupant to the live list');
  assert.deepEqual(args.entries.map(entry => entry.entryIndex), [0, 1]);
});

test('a blocked partner or a camera turn cannot downgrade a forward pair into a singleton or rear group', () => {
  const config = { ...syntheticConfig({ front: [point(-1, -8), point(1, -8)] }), frontPairSize: 2, rearEntryIndices: [2] };
  const entries = pairEntries(config);
  const base = options(config, { entries });
  assertFrontPair(selectEncounterFrontPair(base), base);
  assert.equal(selectEncounterFrontPair({ ...base, blocked: candidate => candidate.x > 0 }), null);
  assert.equal(selectEncounterFrontPair({ ...base, floorAt: candidate => candidate.x > 0 ? -Infinity : candidate.y }), null);
  assert.equal(selectEncounterFrontPair({ ...base, enemies: [{ alive: true, pos: point(1, -8) }] }), null);
  assert.equal(selectEncounterFrontPair({ ...base, yaw: Math.PI, view: viewAt(base.playerFoot, Math.PI) }), null);
  assert.equal(selectEncounterFrontPair({ ...base, yaw: NaN }), null);
  assert.deepEqual(entries, pairEntries(config));
});

test('a pending opening pair can use safe forward wrap pockets after the player has already turned', () => {
  const fixture = realWorld(), config = ZONE_WAVE_CONFIG.balcony;
  for (const playerFoot of [point(11, -2), point(6, 0.95), point(0, 0.95), point(-12, 0.95)]) {
    const yaw = Math.PI / 2, view = placeView(fixture, playerFoot, yaw);
    const args = options(config, { ...fixture.probes, playerFoot, yaw, view, entries: pairEntries(config),
      routeProgress: routeDistanceAt(config.route, playerFoot) });
    assertFrontPair(selectEncounterFrontPair(args), args, true);
  }
  const playerFoot = point(-18, 0.95), yaw = Math.PI / 2;
  assert.equal(selectEncounterFrontPair(options(config, { ...fixture.probes, playerFoot, yaw,
    view: placeView(fixture, playerFoot, yaw), entries: pairEntries(config),
    routeProgress: routeDistanceAt(config.route, playerFoot) })), null, 'Exhausted safe space cannot become an unchecked rear placement');
});

test('only the two distinct authored forward entries can request an atomic pair', () => {
  const config = { ...syntheticConfig({ front: [point(-1, -8), point(1, -8)] }), frontPairSize: 2, rearEntryIndices: [2] };
  const base = options(config, { entries: pairEntries(config), floorAt: () => assert.fail('Invalid roles must fail before probing geometry') });
  for (const entries of [undefined, null, [], [base.entries[0]], [base.entries[0], base.entries[0]],
    [base.entries[0], { ...base.entries[1], waveIndex: 2 }], [base.entries[0], { ...base.entries[1], entryIndex: 2 }]]) {
    assert.equal(selectEncounterFrontPair({ ...base, entries }), null);
  }
  assert.equal(selectEncounterFrontPair({ ...base, config: { ...config, frontPairSize: undefined } }), null);
});

test('usable held ammunition, including reserve, is required to authorize a rear bat', () => {
  for (const [current, definition] of Object.entries(WEAPON_DEFS)) {
    if (definition.kind !== 'ranged') {
      assert.equal(effectiveRearWeapon({ current, loaded: 10, reserve: 20 }), current);
      assert.equal(selectEncounterSpawn(options(syntheticConfig(), { weapon: { current, loaded: 10, reserve: 20 } })).type, 'brawler');
      continue;
    }
    for (const [loaded, reserve] of [[0, 0], [-1, 0], [NaN, 0], [Infinity, 0], [0, -1], [0, NaN], [0, Infinity]]) {
      const weapon = { current, loaded, reserve };
      assert.equal(effectiveRearWeapon(weapon), 'fists');
      assert.equal(selectEncounterSpawn(options(syntheticConfig(), { weapon })).type, 'brawler');
    }
    for (const [loaded, reserve] of [[1, 0], [0, 1], [3, 12]]) {
      const weapon = { current, loaded, reserve }, config = syntheticConfig();
      assert.equal(effectiveRearWeapon(weapon), current);
      for (const type of ['thug', 'gunman', 'hitman', 'bruiser', 'enforcer']) {
        assert.equal(selectEncounterSpawn(options(config, { weapon, type })).type, 'thug');
      }
      assert.equal(selectEncounterSpawn(options(config, { weapon, type: 'brawler' })).type, 'brawler');
    }
  }
  for (const weapon of [undefined, null, {}, { current: '__proto__', loaded: 99 }, { current: 'unknown', reserve: 99 }]) {
    assert.equal(effectiveRearWeapon(weapon), 'fists');
  }
});

test('both later balcony stages offer a separate rear contact on previously passed route ground', () => {
  const fixture = realWorld(), config = ZONE_WAVE_CONFIG.balcony;
  const positions = [point(4, 0.95), point(-6, 0.95)];
  for (const [offset, playerFoot] of positions.entries()) {
    const waveIndex = offset + 1, yaw = Math.PI / 2;
    const view = placeView(fixture, playerFoot, yaw), progress = routeDistanceAt(config.route, playerFoot);
    for (let startIndex = 0; startIndex < config.spawns.length; startIndex++) {
      const args = options(config, { ...fixture.probes, occluded: () => false, waveIndex, playerFoot, yaw, view, startIndex,
        entryIndex: 2, type: config.waves[waveIndex][2], routeProgress: progress });
      const selected = selectEncounterSpawn(args);
      assertPlacement(selected, args, { fullClearance: true });
      assert.equal(selected.usedRearAnchor, true);
      assert.equal(selected.rear, true);
      assert.equal(selected.role, 'rear');
      assert.ok(horizontalDistance(selected.point, playerFoot) <= config.rearPressure.maxDistance);
      assert.ok(config.spawns.some(anchor => sameAnchor(selected.point, anchor)));
      assert.ok(routeDistanceAt(config.route, { ...selected.point, y: config.route.floorY }) < progress - 0.25);
      near(selected.point.y, config.route.floorY + SPAWN_CLEARANCE);
    }
  }
});

test('all four stair rear anchors use this flight lane and lower landing with full real-world clearance', () => {
  const fixture = realWorld(), config = ZONE_WAVE_CONFIG.stairwell;
  for (const [waveIndex, flight] of STAIRS.flights.entries()) {
    const yaw = flight.lane === 'west' ? Math.PI : 0;
    const playerFoot = point(flight.x, flight.lane === 'west' ? -0.65 : -9.2, flight.toY);
    const view = placeView(fixture, playerFoot, yaw);
    const args = options(config, { ...fixture.probes, occluded: () => false, waveIndex, playerFoot, yaw, view });
    const selected = selectEncounterSpawn(args), stage = config.stages[waveIndex];
    assertPlacement(selected, args, { fullClearance: true });
    assert.equal(selected.usedRearAnchor, true);
    assert.deepEqual(rearSpawnCandidates(config, waveIndex, playerFoot), [config.rearSpawns[waveIndex]]);
    assert.ok(sameAnchor(selected.point, config.rearSpawns[waveIndex]));
    near(selected.point.y, flight.fromY + SPAWN_CLEARANCE);
    assert.equal(selected.type, 'brawler');
    for (const y of [stage.minFootY - 0.01, stage.departAbove + 0.01, NaN]) {
      assert.deepEqual(rearSpawnCandidates(config, waveIndex, { ...playerFoot, y }), []);
    }
  }
});

test('stair selection remains safe across flight heights, turns, pitch, aspect and fallback timing', () => {
  const fixture = realWorld(), config = ZONE_WAVE_CONFIG.stairwell;
  let attempts = 0, placements = 0, rearPlacements = 0;
  for (const [waveIndex, flight] of STAIRS.flights.entries()) {
    for (const treadIndex of [0, 6, 11, 13]) {
      const tread = flight.treads[treadIndex], playerFoot = point(flight.x, (tread.z1 + tread.z2) / 2, tread.topY);
      for (const turn of [0, Math.PI]) for (const pitch of [-0.6, 0, 0.6]) for (const aspect of [0.75, 16 / 9, 3]) {
        const yaw = (flight.lane === 'west' ? Math.PI : 0) + turn;
        const view = placeView(fixture, playerFoot, yaw, { pitch, aspect });
        for (const waitedSeconds of [0, config.rearPressure.fallbackAfter]) for (const entryIndex of [0, 1]) {
          const args = options(config, { ...fixture.probes, occluded: () => false, waveIndex, playerFoot, yaw, view,
            waitedSeconds, entryIndex, type: config.waves[waveIndex][entryIndex], weapon: { current: 'pistol', loaded: treadIndex % 2, reserve: 0 } });
          const selected = selectEncounterSpawn(args); attempts++;
          if (!selected) continue;
          placements++; if (selected.rear) rearPlacements++;
          assertPlacement(selected, args, { fullClearance: true });
          const anchors = selected.usedRearAnchor ? [config.rearSpawns[waveIndex]]
            : config.stages[waveIndex].spawnIndices.map(index => config.spawns[index]);
          assert.ok(anchors.some(anchor => sameAnchor(selected.point, anchor)), 'No other floor or stage supplies an emergency spawn');
          if (selected.role === 'rear' && !selected.usedRearAnchor) {
            assert.ok(waitedSeconds >= config.rearPressure.fallbackAfter);
          }
        }
      }
    }
  }
  assert.equal(attempts, 1152);
  assert.ok(placements > 150 && rearPlacements > 50, 'The matrix must exercise successful arrivals, not only rejections');
});

test('a real reserve-only E pickup changes an empty gun rear contact from fists to at most a bat', () => {
  const fixture = realWorld(), config = ZONE_WAVE_CONFIG.balcony, cache = AMMO_SUPPLY_CACHES[0];
  const playerFoot = { ...cache.approach }, yaw = Math.PI / 2;
  const view = placeView(fixture, playerFoot, yaw);
  fixture.supplies.setZone('balcony');
  fixture.Weapons.restore({ current: 'pistol', loaded: 0, reserve: 0 });
  const select = () => selectEncounterSpawn(options(config, { ...fixture.probes, waveIndex: 2, playerFoot, yaw, view,
    entryIndex: 2, type: 'thug', weapon: fixture.Weapons.snapshot() }));
  assert.equal(select().type, 'brawler');
  assert.equal(fixture.Weapons.findNearestPickup(), fixture.supplies.list[0]);
  fixture.Weapons.handleInput({ ePressed: true }, 1 / 120);
  assert.deepEqual({ ...fixture.Weapons.snapshot() }, { current: 'pistol', loaded: 0, reserve: 24 });
  assert.equal(fixture.Weapons.reloading, 0);
  assert.equal(select().type, 'thug');
  assert.equal(fixture.calls.pickups, 1, 'The chime is a counted no-op, never audio playback');
  assert.equal(fixture.supplies.list[0].remainingUnits, 0);
});

test('a front slot that is actually behind the player is hidden, weakened and granted attack grace', () => {
  const config = syntheticConfig({ front: [point(0, 8)] });
  for (const weapon of [{ current: 'bat', loaded: 0, reserve: 0 }, { current: 'pistol', loaded: 0, reserve: 0 },
    { current: 'pistol', loaded: 0, reserve: 1 }]) {
    const args = options(config, { entryIndex: 0, type: 'enforcer', weapon });
    const selected = selectEncounterSpawn(args);
    assertPlacement(selected, args);
    assert.equal(selected.role, 'front'); assert.equal(selected.rear, true); assert.equal(selected.usedRearAnchor, false);
    assert.equal(selected.type, weapon.reserve ? 'thug' : 'brawler');
  }
  const watching = options(config, { entryIndex: 0, view: viewAt(point(0, 0), Math.PI) });
  assert.equal(selectEncounterSpawn(watching), null, 'A current view of that body overrides the intended rear yaw');
});

test('the actual view must hide the complete rear body before placement, including camera-edge overlap', () => {
  const config = syntheticConfig();
  const watching = options(config, { view: viewAt(point(0, 0), Math.PI) });
  assert.equal(describeOffscreenThreat(watching.view, sourceAt(point(0, 8, 4.03))).visible, true);
  assert.equal(selectEncounterSpawn(watching), null);
  for (const view of [null, viewAt(point(0, 0), 0, { pitch: NaN }), viewAt(point(0, 0), 0, { aspect: 0 }),
    viewAt(point(0, 0), 0, { zoom: 0 })]) {
    assert.equal(selectEncounterSpawn(options(config, { view, waitedSeconds: 100, occluded: () => true })), null);
  }
  const edge = syntheticConfig({ front: [point(3.1, -8)], rear: [] });
  const view = viewAt(point(0, 0), 0, { fov: 40, aspect: 1 });
  const body = sourceAt(point(3.1, -8, 4.03));
  assert.equal(describeOffscreenThreat(view, { pos: { ...body.pos, y: body.pos.y + 1 }, radius: 0, height: 0.01 }).visible, false);
  assert.equal(describeOffscreenThreat(view, body).visible, true, 'An exposed shoulder counts even when the center is offscreen');
  assert.equal(selectEncounterSpawn(options(edge, { waitedSeconds: 10, view })), null);
});

test('delayed forward fallback is inclusive at each zone deadline and keeps its original stage', () => {
  for (const zone of ['balcony', 'stairwell']) {
    const fallbackAfter = ZONE_WAVE_CONFIG[zone].rearPressure.fallbackAfter;
    const config = syntheticConfig({ rear: [], fallbackAfter });
    for (const waitedSeconds of [0, fallbackAfter - 0.001]) {
      assert.equal(selectEncounterSpawn(options(config, { waitedSeconds, occluded: () => true })), null);
    }
    for (const waitedSeconds of [fallbackAfter, fallbackAfter + 100]) {
      const args = options(config, { waitedSeconds, occluded: () => true }), selected = selectEncounterSpawn(args);
      assertPlacement(selected, args);
      assert.equal(selected.rear, false); assert.equal(selected.role, 'rear'); assert.equal(selected.usedRearAnchor, false);
      assert.ok(sameAnchor(selected.point, config.spawns[0]));
      assert.equal(selected.type, 'hitman', 'A concealed forward arrival retains its authored forward loadout');
    }
  }
});

test('production concealment rejects exposed head or side corners and accepts a fully covered fallback', () => {
  for (const [name, width, height, expected] of [['none', 0, 0, false], ['head exposed', 4, 1.65, false],
    ['side exposed', 0.06, 3, false], ['fully covered', 4, 3, true]]) {
    Architecture.clear(); Colliders.clear();
    const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 100); camera.position.set(0, 5.7, 0);
    const add = (id, kind, x, y, z, sx, sy, sz) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshStandardMaterial());
      mesh.position.set(x, y, z); mesh.updateMatrixWorld(true);
      Architecture.register(mesh, Colliders.addBoxBySize(x, y, z, sx, sy, sz), boxBounds(x, y, z, sx, sy, sz), { id, kind });
    };
    add('test-floor', 'floor', 0, 3.9, 0, 30, 0.2, 30);
    if (width) add('test-cover', 'wall', 0, 4 + height / 2, -4, width, height, 0.2);
    const probes = missionGeometry(camera), body = sourceAt(point(0, -8, 4.03));
    assert.equal(describeOffscreenThreat(viewAt(point(0, 0)), body).visible, true);
    assert.equal(probes.occluded(body), expected, name);
    const args = options(syntheticConfig({ rear: [] }), { ...probes, waitedSeconds: 1.5 });
    const selected = selectEncounterSpawn(args);
    assert.equal(Boolean(selected), expected, name);
    if (selected) assertPlacement(selected, args, { fullClearance: true });
  }
});

test('separate corner blockers cannot disguise a body visible through the gaps between them', () => {
  Architecture.clear(); Colliders.clear();
  const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 100); camera.position.set(0, 5.7, 0);
  const body = sourceAt(point(0, -8, 4.03)), samples = [], blockers = [];
  for (let corner = 0; corner < 9; corner++) {
    const sample = new THREE.Vector3(body.pos.x + (corner === 8 ? 0 : corner & 1 ? body.radius : -body.radius),
      body.pos.y + (corner === 8 ? body.height / 2 : corner & 2 ? body.height : 0),
      body.pos.z + (corner === 8 ? 0 : corner & 4 ? body.radius : -body.radius));
    samples.push(sample);
    const center = camera.position.clone().lerp(sample, -4 / sample.z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.008, 0.02), new THREE.MeshStandardMaterial());
    mesh.position.copy(center); mesh.updateMatrixWorld(true);
    const bounds = boxBounds(center.x, center.y, center.z, 0.008, 0.008, 0.02);
    Architecture.register(mesh, null, bounds, { id: 'corner-blocker-' + corner, kind: 'wall' });
    blockers.push(bounds);
  }
  assert.ok(samples.every(sample => isSegmentOccluded(camera.position, sample, blockers)), 'All sampled rays hit the collection of small blockers');
  assert.equal(isSegmentOccluded(camera.position, new THREE.Vector3(0.12, 5.545, -8), blockers), false,
    'An unsampled part of the body remains exposed through the gaps');
  assert.equal(missionGeometry(camera).occluded(body), false, 'Only a continuous solid can establish concealed placement');
});

test('hidden parents and nonopaque structural materials do not conceal an arrival', () => {
  Architecture.clear(); Colliders.clear();
  const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 100); camera.position.set(0, 5.7, 0);
  const material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.2), material);
  mesh.position.set(0, 5.5, -4);
  const parent = new THREE.Group(); parent.add(mesh); parent.updateMatrixWorld(true);
  Architecture.register(mesh, null, boxBounds(0, 5.5, -4, 4, 3, 0.2), { id: 'visibility-cover', kind: 'wall' });
  const probe = missionGeometry(camera), body = sourceAt(point(0, -8, 4.03));
  assert.equal(probe.occluded(body), true);
  parent.visible = false;
  assert.equal(probe.occluded(body), false);
  parent.visible = true;
  for (const [key, value] of [['visible', false], ['transparent', true], ['opacity', 0.5],
    ['alphaTest', 0.1], ['alphaHash', true], ['alphaMap', new THREE.Texture()], ['colorWrite', false]]) {
    const previous = material[key]; material[key] = value;
    assert.equal(probe.occluded(body), false, key);
    material[key] = previous;
  }
  assert.equal(probe.occluded(body), true);
});

test('rear attempts and timed fallback never bypass distance, floor, body or crowd safety', () => {
  const config = syntheticConfig();
  const cases = [
    ['no floor', { floorAt: () => -Infinity }],
    ['floor too high', { floorAt: candidate => candidate.y + 0.17 }],
    ['floor too low', { floorAt: candidate => candidate.y - 0.29 }],
    ['wrong level', { playerFoot: point(0, 0, 10) }],
    ['solid collision', { blocked: () => true }],
    ['crowded', { enemies: [point(0, 8, 4.03), point(0, -8, 4.03)].map(pos => ({ pos, alive: true })) }],
  ];
  for (const [label, overrides] of cases) for (const waitedSeconds of [0, 1.5, 120]) {
    assert.equal(selectEncounterSpawn(options(config, { waitedSeconds, occluded: () => true, ...overrides })), null, label);
  }
  const close = syntheticConfig({ rear: [point(0, 4.999)], front: [point(0, -4.999)] });
  assert.equal(selectEncounterSpawn(options(close, { waitedSeconds: 120, occluded: () => true })), null);
  const exact = syntheticConfig({ rear: [point(0, 5)] });
  assert.ok(selectEncounterSpawn(options(exact))?.rear, 'Five metres is allowed without rounding a shorter gap upward');
  assert.equal(selectEncounterSpawn(options(syntheticConfig({ rear: [point(0, 12.001)] }))), null);
});

test('blocked current-stage anchors never fall back to an unrelated stage or lower landing', () => {
  const config = syntheticConfig({ front: [point(0, -8), point(6, -8)], rear: [point(0, 8), point(-6, 8)] });
  config.stages = [
    { id: 'current', spawnIndices: [0], rearSpawnIndices: [0] },
    { id: 'other', spawnIndices: [1], rearSpawnIndices: [1] },
  ];
  config.waves.push(['gunman', 'thug']); config.waveCount = 2;
  const visited = [];
  const args = options(config, { waitedSeconds: 100, floorAt(candidate) { visited.push(candidate); return candidate.y; },
    blocked: candidate => candidate.x === 0, occluded: () => true });
  assert.equal(selectEncounterSpawn(args), null);
  assert.ok(visited.length >= 2 && visited.every(candidate => candidate.x === 0));
  assert.ok(selectEncounterSpawn({ ...args, waveIndex: 1 }), 'The other stage has a safe positive control');
});

test('balcony staggering checks both 0.4 metre lateral separation and 0.04 radian perspective angle', () => {
  const cases = [
    ['collinear', point(0, -8), point(0, -14), false],
    ['lateral shortfall', point(0.38, -8), point(0, -14), false],
    ['angular shortfall', point(0.6, -20), point(0, -40), false],
    ['both clear', point(0.45, -8), point(0, -14), true],
    ['opposite sides', point(0, -8), point(0, 8), true],
  ];
  for (const [label, candidate, other, expected] of cases) {
    const config = syntheticConfig({ front: [candidate], rear: [] });
    const enemy = { alive: true, pos: other, encounterKey: 'fixture', encounterWave: 0 };
    for (const [front, existing] of [[candidate, other], [other, candidate]]) {
      config.spawns = [front];
      const selected = selectEncounterSpawn(options(config, { entryIndex: 0, enemies: [{ ...enemy, pos: existing }] }));
      assert.equal(Boolean(selected), expected, `${label} is symmetric`);
    }
  }
  const config = syntheticConfig({ front: [point(0, -8)] });
  const aligned = { alive: true, pos: point(0, -14), encounterKey: 'fixture', encounterWave: 0 };
  for (const override of [{ alive: false }, { removed: true }, { encounterWave: 1 }, { encounterKey: 'another-zone' }]) {
    assert.ok(selectEncounterSpawn(options(config, { entryIndex: 0, enemies: [{ ...aligned, ...override }] })));
  }
});

test('a blocked front contact cannot starve a safe rear contact or reassign its authored index', () => {
  const config = syntheticConfig(), schedule = new EncounterSchedule(config), attempts = [], spawned = [];
  schedule.update(0, { footY: 4 });
  const blocked = position => position.z < 0;
  const trySpawn = entry => {
    attempts.push(entry.entryIndex);
    const selected = selectEncounterSpawn(options(config, { ...entry, blocked }));
    if (!selected) return false;
    spawned.push(selected); return true;
  };
  assert.equal(schedule.spawnAvailable({ total: 0 }, trySpawn), 1);
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(spawned[0].role, 'rear');
  assert.deepEqual(schedule.pending.map(entry => [entry.entryIndex, entry.waveIndex, entry.type]), [[0, 0, 'gunman']]);
  attempts.length = 0;
  assert.equal(schedule.spawnAvailable({ total: 1 }, trySpawn), 0);
  assert.deepEqual(attempts, [0], 'Every pending entry is tried at most once per call');
  assert.equal(schedule.groups[0].spawned, 1); assert.equal(schedule.groups[0].pending, 1);
  assert.equal(schedule.cleared, false);
});

test('pending wait uses simulation time, survives failed attempts, and resets with checkpoint order', () => {
  const config = syntheticConfig(), schedule = new EncounterSchedule(config);
  schedule.update(0, { footY: 4 });
  assert.deepEqual(schedule.pending.map(entry => [entry.entryIndex, entry.waitedSeconds]), [[0, 0], [1, 0]]);
  schedule.update(0.75, { footY: 4 });
  for (let attempt = 0; attempt < 100; attempt++) {
    schedule.update(0, { footY: 4 });
    schedule.spawnAvailable({ total: 0 }, () => false);
  }
  for (const dt of [-1, NaN, Infinity]) schedule.update(dt, { footY: 4 });
  assert.deepEqual(schedule.pending.map(entry => [entry.entryIndex, entry.waitedSeconds]), [[0, 0.75], [1, 0.75]]);
  schedule.spawnAvailable({ total: 0 }, entry => entry.entryIndex === 0);
  assert.equal(schedule.pending[0].entryIndex, 1, 'Array index zero does not steal the front role');
  assert.equal(schedule.pending[0].waitedSeconds, 0.75);
  schedule.update(0.75, { footY: 4, alive: 1, aliveByWave: [1] });
  near(schedule.pending[0].waitedSeconds, 1.5);
  schedule.reset(); schedule.update(0, { footY: 4 });
  assert.deepEqual(schedule.pending.map(entry => [entry.entryIndex, entry.waitedSeconds, entry.type]),
    [[0, 0, 'gunman'], [1, 0, 'thug']]);
  assert.equal(schedule.spawned, 0); assert.equal(schedule.skipped, 0);
});

test('the live cap and finite roster still bound all successful callbacks after blocked retries', () => {
  for (const zone of ['balcony', 'stairwell']) {
    const config = ZONE_WAVE_CONFIG[zone], schedule = new EncounterSchedule(config);
    const records = [];
    for (let waveIndex = 0; waveIndex < config.waveCount; waveIndex++) {
      const stage = config.stages[waveIndex], footY = zone === 'stairwell' ? STAIRS.flights[waveIndex].fromY : 4;
      for (let tick = 0; !schedule.pending.length && tick < 100; tick++) {
        schedule.update(0.25, { footY, routeProgress: stage.minProgress ?? 0, alive: 0, aliveByWave: [] });
      }
      const groupSize = config.waves[waveIndex].length;
      assert.equal(schedule.pending.length, groupSize, `${zone} wave ${waveIndex} keeps its original roster`);
      let callbacks = 0;
      const countCallback = () => { callbacks++; return true; };
      assert.equal(schedule.spawnAvailable({ total: config.maxAlive }, countCallback, countCallback), 0);
      assert.equal(callbacks, 0, 'A full live cap cannot even acquire another rig');
      schedule.spawnAvailable({ total: 0 }, () => false, () => false);
      assert.equal(schedule.pending.length, groupSize, 'A blocked attempt neither spends nor invents a roster entry');
      const commit = entry => { records.push({ ...entry }); return true; };
      if (config.frontPairSize) {
        assert.equal(schedule.spawnAvailable({ total: 1, rearAlive: 1 }, commit, entries => {
          entries.forEach(commit); return true;
        }), 2);
        assert.equal(schedule.pending.length, groupSize - 2);
        if (groupSize > 2) assert.equal(schedule.spawnAvailable({ total: 2, rearAlive: 0 }, commit), 1);
      } else {
        assert.equal(schedule.spawnAvailable({ total: 1 }, commit), 1);
        assert.equal(schedule.pending.length, 1);
        assert.equal(schedule.spawnAvailable({ total: 1 }, commit), 1);
      }
      assert.equal(schedule.pending.length, 0);
      schedule.update(0, { footY, routeProgress: stage.minProgress ?? 0, alive: 0, aliveByWave: [] });
    }
    assert.equal(schedule.cleared, true);
    assert.equal(records.length, config.totalContacts);
    assert.equal(schedule.spawned, config.totalContacts);
    assert.equal(schedule.skipped, 0);
    assert.equal(new Set(records.map(entry => `${entry.waveIndex}:${entry.entryIndex}`)).size, config.totalContacts);
    for (let tick = 0; tick < 10; tick++) {
      schedule.update(100, { footY: zone === 'stairwell' ? 14 : 4, routeProgress: 100, alive: 0 });
      assert.equal(schedule.spawnAvailable({ total: 0 }, () => assert.fail('The finite encounter cannot repeat')), 0);
    }
  }
});

test('invalid wave or player coordinates cannot reach any placement service', () => {
  const config = syntheticConfig(), never = () => assert.fail('Invalid state must fail before geometry probes');
  for (const waveIndex of [-1, 1, 1.5, NaN, Infinity]) {
    assert.equal(selectEncounterSpawn(options(config, { waveIndex, floorAt: never, blocked: never })), null);
  }
  for (const playerFoot of [null, {}, point(NaN, 0), point(0, Infinity), point(0, 0, NaN)]) {
    assert.equal(selectEncounterSpawn(options(config, { playerFoot, floorAt: never, blocked: never })), null);
  }
});

test('seeded pending entries keep the same placement through cursor changes and failed probes', () => {
  const config = syntheticConfig({ front: [point(-1, -8), point(1, -10), point(3, -12)], rear: [point(-1, 8), point(1, 10)] });
  const variation = createEncounterVariation(config, 0x2827fc03);
  for (const entryIndex of [0, 1]) {
    const base = options(config, { entryIndex, variation });
    const expected = selectEncounterSpawn(base);
    assertPlacement(expected, base);
    for (const startIndex of [0, 1, 2, 3, 17, -1, 1000]) {
      assert.equal(selectEncounterSpawn({ ...base, startIndex, blocked: () => true }), null);
      assert.deepEqual(selectEncounterSpawn({ ...base, startIndex, waitedSeconds: 100 }), expected);
    }
  }
});

test('an unsafe seeded offset falls back to its authored anchor without relaxing any probe', () => {
  const anchor = point(0, -8), config = syntheticConfig({ front: [anchor] });
  const variation = createEncounterVariation(config, 73);
  const isOriginal = candidate => candidate.x === anchor.x && candidate.z === anchor.z;
  const base = options(config, { entryIndex: 0, variation });
  const blockedOffset = selectEncounterSpawn({ ...base, blocked: candidate => !isOriginal(candidate) });
  assert.ok(blockedOffset);
  assert.ok(isOriginal(blockedOffset.point));
  const unsupportedOffset = selectEncounterSpawn({ ...base, floorAt: candidate => isOriginal(candidate) ? 4 : -Infinity });
  assert.ok(isOriginal(unsupportedOffset.point));
  assert.equal(selectEncounterSpawn({ ...base, blocked: () => true }), null);
  assert.equal(selectEncounterSpawn({ ...base, floorAt: () => -Infinity }), null);
  assert.equal(selectEncounterSpawn({ ...base, enemies: [{ alive: true, pos: anchor }] }), null);
});

test('jitter is checked against retained forward progress after a player retreats', () => {
  const anchor = point(10.3, 0);
  const config = { ...syntheticConfig({ front: [anchor] }), rearPressure: null,
    variation: { key: 'progress-fixture', jitterX: 0.6, jitterZ: 0 },
    route: { floorY: 4, maxLateralDistance: 1, points: [{ x: 0, z: 0 }, { x: 20, z: 0 }] } };
  let rejectedOffsets = 0;
  for (let seed = 0; seed < 32; seed++) {
    const variation = createEncounterVariation(config, seed);
    const shifted = variedSpawnCandidates([anchor], variation, { waveIndex: 0, entryIndex: 0 })[0];
    const selected = selectEncounterSpawn(options(config, { variation, entryIndex: 0, yaw: -Math.PI / 2,
      view: viewAt(point(0, 0), -Math.PI / 2), routeProgress: 10 }));
    assert.ok(selected);
    assert.ok(selected.point.x > 10.25, 'A safe floor cannot move an offset behind retained progress');
    if (shifted.x <= 10.25) {
      rejectedOffsets++;
      assert.equal(selected.point.x, anchor.x);
    }
  }
  assert.ok(rejectedOffsets > 5);
});
