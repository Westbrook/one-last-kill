import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { Colliders, capsuleHasClearance } from '../../src/core/collision.js';
import { createAmmoSupplies } from '../../src/game/ammo-supplies.js';
import { isSegmentOccluded } from '../../src/game/combat-rules.js';
import { encounterSpawnCandidates, routeDistanceAt } from '../../src/game/encounter-rules.js';
import { rearSpawnCandidates, selectEncounterFrontPair, selectEncounterSpawn } from '../../src/game/encounter-spawns.js';
import { createEncounterVariation, variedSpawnCandidates } from '../../src/game/encounter-variation.js';
import { CHECKPOINTS, FINAL_ENCOUNTERS, MIN_SPAWN_DISTANCE, SPAWN_CLEARANCE, ZONE_WAVE_CONFIG } from '../../src/game/mission-data.js';
import { describeOffscreenThreat } from '../../src/game/offscreen-threats.js';
import { hasPairBearingSeparation, isBehindPlayer } from '../../src/game/rear-encounter-rules.js';
import { Architecture } from '../../src/world/architecture.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';

// Seed 71 also exercises the narrow gap beside the west balcony screen.
const SEEDS = Object.freeze([...Array.from({ length: 32 }, (_, index) => index), 71]);
const EPSILON = 1e-8;
const RADIUS = 0.48;
const HEIGHT = 2.02;
const point = (x, z, y = 4) => ({ x, y, z });
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= EPSILON,
  `${label}: ${actual} != ${expected}`);
const bodyAt = pos => ({ pos, radius: RADIUS, height: HEIGHT });
const spawnedAt = (position, anchor) => Math.abs(position.x - anchor.x) <= EPSILON
  && Math.abs(position.z - anchor.z) <= EPSILON
  && Math.abs(position.y - anchor.y - SPAWN_CLEARANCE) <= EPSILON;

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `Keep the explicit geometry fixture aligned with ${name}`);
  return source.slice(start, end + 2);
}

function buildGeometryFixture() {
  const authored = buildWorldSurfaceFixture();
  const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 100);
  const supplies = createAmmoSupplies();
  supplies.init({ world: authored.World, player: { pos: new THREE.Vector3(), _eyeH: 1.7 }, canInteract: () => false });

  // Extract only the mission floor/concealment probes and their scratch state.
  // Spawn clearance uses the shared full capsule primitive, without movement
  // skin. Mission startup, controllers, renderers and audio are not evaluated.
  const mission = readFileSync(new URL('../../src/game/mission.js', import.meta.url), 'utf8');
  const start = mission.indexOf('const spawnSightTarget = ');
  const end = mission.indexOf('\nfunction spawnConcealed(', start);
  assert.ok(start >= 0 && end > start, 'Keep the concealment scratch bindings explicit');
  const api = runInNewContext([
    mission.slice(start, end),
    functionSource(mission, 'surfaceTopAt'),
    functionSource(mission, 'spawnConcealed'),
    '({ surfaceTopAt, spawnConcealed });',
  ].join('\n'), {
    THREE, Colliders, Architecture, camera, isSegmentOccluded,
  });
  return {
    authored, camera, supplies,
    floorAt: candidate => api.surfaceTopAt(candidate.x, candidate.y, candidate.z, 0.28, 0.16),
    blocked: position => !capsuleHasClearance(position, RADIUS, HEIGHT, Colliders.list),
    occluded: api.spawnConcealed,
  };
}

// Tests only read this geometry; each placement supplies a fresh camera view
// and an explicit occupant list. No running game or browser is required.
const fixture = buildGeometryFixture();

function placementArgs(config, seed, playerFoot, {
  waveIndex = 0, entryIndex = 0, yaw = playerFoot.yaw ?? 0,
  pitch = 0, aspect = 16 / 9, ...overrides
} = {}) {
  const view = { position: { ...playerFoot, y: playerFoot.y + 1.7 }, yaw, pitch, fov: 82, aspect, zoom: 1 };
  fixture.camera.position.copy(view.position);
  return {
    config, variation: createEncounterVariation(config, seed), waveIndex, entryIndex,
    type: config.waves[waveIndex][entryIndex], waitedSeconds: 0,
    playerFoot, yaw, view, routeProgress: routeDistanceAt(config.route, playerFoot) ?? 0,
    weapon: { current: 'pistol', loaded: 7, reserve: 24 },
    enemies: [], encounterKey: `geometry:${config.variation.key}`,
    floorAt: fixture.floorAt, blocked: fixture.blocked, occluded: fixture.occluded,
    ...overrides,
  };
}

function pairEntries(config, waveIndex) {
  return config.waves[waveIndex].slice(0, 2).map((type, entryIndex) => ({ type, entryIndex, waveIndex }));
}

function assertSelection(selection, args) {
  const label = `${args.config.variation.key}, seed ${args.variation.seed}, wave ${args.waveIndex}, slot ${args.entryIndex}`;
  assert.ok(selection, `${label}: the positive pose must produce a placement`);
  const progress = Math.max(args.routeProgress, routeDistanceAt(args.config.route, args.playerFoot) ?? 0);
  const anchors = selection.usedRearAnchor
    ? rearSpawnCandidates(args.config, args.waveIndex, args.playerFoot)
    : encounterSpawnCandidates(args.config, args.waveIndex, progress, args.playerFoot.y);
  const anchor = anchors.find(candidate => Math.abs(selection.point.x - candidate.x) <= args.variation.jitterX + EPSILON
    && Math.abs(selection.point.z - candidate.z) <= args.variation.jitterZ + EPSILON
    && Math.abs(selection.point.y - candidate.y - SPAWN_CLEARANCE) <= EPSILON);
  assert.ok(anchor, `${label}: placement must stay within the configured offset of an eligible authored anchor`);
  const candidates = variedSpawnCandidates(anchors, args.variation, {
    waveIndex: args.waveIndex, entryIndex: args.entryIndex, channel: selection.usedRearAnchor ? 'rear' : 'forward',
  });
  assert.ok(candidates.some(candidate => spawnedAt(selection.point, candidate)), `${label}: no invented fallback position`);
  near(args.floorAt({ ...selection.point, y: anchor.y }), anchor.y, `${label}: exact authored support`);
  near(selection.point.y, anchor.y + SPAWN_CLEARANCE, `${label}: floor clearance`);
  assert.equal(args.blocked(selection.point), false, `${label}: production capsule probe`);
  assert.equal(capsuleHasClearance(selection.point, RADIUS, HEIGHT, Colliders.list), true, `${label}: full capsule clearance`);
  assert.ok(distance(selection.point, args.playerFoot) >= MIN_SPAWN_DISTANCE - EPSILON, `${label}: five metre exclusion`);
  assert.ok(Math.abs(anchor.y - args.playerFoot.y) <= args.config.maxHeightDifference + EPSILON, `${label}: floor separation`);
  for (const enemy of args.enemies) {
    if (enemy.alive && Math.abs(enemy.pos.y - selection.point.y) <= 2.2) {
      assert.ok(distance(selection.point, enemy.pos) >= 1.5 - EPSILON, `${label}: occupied pockets stay reserved`);
    }
  }
  if (args.config.route) {
    const routePosition = routeDistanceAt(args.config.route, selection.point);
    const margin = args.config.forwardSpawnMargin ?? 0.25;
    assert.notEqual(routePosition, null, `${label}: placement stays on the route`);
    assert.ok(selection.usedRearAnchor
      ? routePosition < routeDistanceAt(args.config.route, args.playerFoot) - margin
      : routePosition > progress + margin, `${label}: route eligibility is checked after jitter`);
  }
  if (selection.rear || selection.role === 'rear') {
    const projection = describeOffscreenThreat(args.view, bodyAt(selection.point));
    assert.ok(projection && (!projection.visible || args.occluded(bodyAt(selection.point))), `${label}: full rear body is concealed`);
    assert.ok(selection.graceSeconds >= 1, `${label}: rear arrival retains attack grace`);
  }
  if (selection.rear) assert.ok(['brawler', 'thug'].includes(selection.type), `${label}: rear attackers stay melee`);
  if (selection.usedRearAnchor) assert.ok(distance(selection.point, args.playerFoot) <= args.config.rearPressure.maxDistance + EPSILON);
  return anchor;
}

function assertFrontPair(pair, args) {
  assert.equal(pair?.length, 2, `Seed ${args.variation.seed}: both forward positions must be available together`);
  for (const [index, selected] of pair.entries()) {
    assertSelection(selected, { ...args, entryIndex: args.entries[index].entryIndex });
    assert.equal(selected.role, 'front');
    assert.equal(selected.rear, false);
    assert.equal(selected.usedRearAnchor, false);
    assert.equal(selected.type, args.entries[index].type);
    assert.equal(isBehindPlayer(args.playerFoot, args.yaw, selected.point, { minDistance: 0, minRearDot: 0 }), false);
  }
  assert.ok(distance(pair[0].point, pair[1].point) >= 1.5 - EPSILON, 'The complete pair retains physical spacing');
  assert.equal(hasPairBearingSeparation(args.playerFoot, pair[0].point, pair[1].point), true);
}

function assertReadablePair(pair, args) {
  for (const selected of pair) {
    assert.equal(describeOffscreenThreat(args.view, bodyAt(selected.point)).visible, true);
    assert.equal(isSegmentOccluded(args.view.position, { ...selected.point, y: selected.point.y + 1.7 }, Colliders.list), false,
      `Seed ${args.variation.seed}, wave ${args.waveIndex}, player ${JSON.stringify(args.playerFoot)}: `
      + `head at ${JSON.stringify(selected.point)} must be unobscured`);
  }
}

test('both seeded slots retain every real supported original immediately after its jittered candidate', () => {
  const scopes = Object.values(ZONE_WAVE_CONFIG).map(config => ({ config, points: config.spawns, channel: 'forward' }));
  scopes.push({ config: FINAL_ENCOUNTERS.car, points: FINAL_ENCOUNTERS.car.spawns, channel: 'forward' },
    { config: ZONE_WAVE_CONFIG.stairwell, points: ZONE_WAVE_CONFIG.stairwell.rearSpawns, channel: 'rear' });
  for (const { config, points, channel } of scopes) for (const seed of SEEDS) for (const entryIndex of [0, 1]) {
    const variation = createEncounterVariation(config, seed);
    const candidates = variedSpawnCandidates(points, variation, { waveIndex: 0, entryIndex, channel });
    for (const anchor of points) {
      assert.equal(candidates.filter(candidate => candidate === anchor).length, 1, 'Every untouched original remains available');
      near(fixture.floorAt(anchor), anchor.y, 'Original fallback rests on its authored floor');
      assert.equal(capsuleHasClearance({ ...anchor, y: anchor.y + SPAWN_CLEARANCE }, RADIUS, HEIGHT, Colliders.list), true);
    }
    for (const [index, candidate] of candidates.entries()) {
      if (points.includes(candidate)) continue;
      const anchor = candidates[index + 1];
      assert.ok(points.includes(anchor), 'A jittered position is immediately followed by its original');
      assert.equal(candidate.y, anchor.y, 'Variation never invents another floor');
      assert.ok(Math.abs(candidate.x - anchor.x) <= variation.jitterX + EPSILON);
      assert.ok(Math.abs(candidate.z - anchor.z) <= variation.jitterZ + EPSILON);
    }
  }
});

const BALCONY_POSES = [CHECKPOINTS.balcony, point(4, 0.95), point(-6, 0.95)];
for (const [waveIndex, pose] of BALCONY_POSES.entries()) {
  test(`seeded balcony stage ${waveIndex + 1} retains two readable, separated forward contacts`, () => {
    const config = ZONE_WAVE_CONFIG.balcony, positions = new Set();
    for (const seed of SEEDS) for (const [dx, dz] of [[0, 0], [-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]]) {
      const playerFoot = { ...pose, x: pose.x + dx, z: pose.z + dz };
      const args = placementArgs(config, seed, playerFoot, {
        waveIndex, yaw: waveIndex ? Math.PI / 2 : Math.PI, entries: pairEntries(config, waveIndex),
      });
      const pair = selectEncounterFrontPair(args);
      assertFrontPair(pair, args);
      assertReadablePair(pair, args);
      if (dx === 0 && dz === 0) positions.add(JSON.stringify(pair.map(selected => selected.point)));
      assert.equal(args.enemies.length, 0, 'A proposal never commits a temporary occupant');
    }
    assert.ok(positions.size > 1, 'Different seeds exercise real variation at the same player pose');
  });
}

test('sampled opening delays preserve both east contacts during a full sprint', () => {
  const config = ZONE_WAVE_CONFIG.balcony, delays = new Set();
  for (const seed of SEEDS) {
    const variation = createEncounterVariation(config, seed);
    assert.ok(variation.firstDelay > 0 && variation.firstDelay <= 0.1);
    delays.add(variation.firstDelay);
    // The simulation samples the timer at 120 Hz with its existing tolerance.
    const elapsed = Math.ceil((variation.firstDelay - 1e-6) * 120) / 120;
    assert.ok(elapsed <= 0.1);
    for (const dx of [-0.15, 0, 0.15]) {
      const playerFoot = { ...CHECKPOINTS.balcony, x: CHECKPOINTS.balcony.x + dx, z: CHECKPOINTS.balcony.z + elapsed * 7 };
      const args = placementArgs(config, seed, playerFoot, { yaw: Math.PI, variation, entries: pairEntries(config, 0) });
      const pair = selectEncounterFrontPair(args);
      assertFrontPair(pair, args);
      assertReadablePair(pair, args);
      const origins = pair.map((selected, entryIndex) => assertSelection(selected, { ...args, entryIndex }));
      assert.deepEqual(origins.map(anchor => anchor.x).sort((a, b) => a - b), [10, 12]);
    }
  }
  assert.ok(delays.size > 1, 'The sprint test must exercise sampled delays, not only the authored value');
});

test('west-screen jitter falls back to the exact original without weakening clearance', () => {
  const base = ZONE_WAVE_CONFIG.balcony;
  const anchorIndex = base.spawns.findIndex(anchor => anchor.x === -18.4 && anchor.z === 1.18);
  assert.ok(anchorIndex >= 0);
  const anchor = base.spawns[anchorIndex], waveIndex = 2;
  const config = { ...base, stages: base.stages.map((stage, index) => index === waveIndex ? { ...stage, spawnIndices: [anchorIndex] } : stage) };
  let rejectedOffsets = 0;
  for (const seed of SEEDS) {
    const args = placementArgs(config, seed, point(-12, 0.95), { waveIndex, yaw: Math.PI / 2 });
    const [offset, original] = variedSpawnCandidates([anchor], args.variation, { waveIndex, entryIndex: 0, channel: 'forward' });
    assert.equal(original, anchor);
    const selected = selectEncounterSpawn(args);
    assertSelection(selected, args);
    if (args.blocked({ ...offset, y: offset.y + SPAWN_CLEARANCE })) {
      rejectedOffsets++;
      assert.ok(spawnedAt(selected.point, anchor), 'A rejected westward offset must retain the safe original');
    }
  }
  assert.ok(rejectedOffsets > 0, 'The fixed seed set exercises a real screen collision');
});

test('a jittered forward pocket cannot cross retained route progress after a retreat', () => {
  const base = ZONE_WAVE_CONFIG.balcony, waveIndex = 2;
  const anchorIndex = base.spawns.findIndex(anchor => anchor.x === -12 && anchor.z === 0.62);
  assert.ok(anchorIndex >= 0);
  const anchor = base.spawns[anchorIndex], progress = routeDistanceAt(base.route, anchor) - 0.26;
  const config = { ...base, stages: base.stages.map((stage, index) => index === waveIndex ? { ...stage, spawnIndices: [anchorIndex] } : stage) };
  let crossedOffsets = 0;
  for (const seed of SEEDS) {
    const args = placementArgs(config, seed, point(-6, 0.95), { waveIndex, yaw: Math.PI / 2, routeProgress: progress });
    const [offset] = variedSpawnCandidates([anchor], args.variation, { waveIndex, entryIndex: 0, channel: 'forward' });
    const selected = selectEncounterSpawn(args);
    assertSelection(selected, args);
    if (routeDistanceAt(base.route, offset) <= progress + (config.forwardSpawnMargin ?? 0.25)) {
      crossedOffsets++;
      assert.ok(spawnedAt(selected.point, anchor), 'Only the still-eligible original can survive the progress filter');
    }
  }
  assert.ok(crossedOffsets > 0, 'The seed set must exercise offsets across the retained route margin');
});

test('blocked or occupied pairs defer without rerolling a seeded placement', () => {
  const config = ZONE_WAVE_CONFIG.balcony, waveIndex = 1;
  for (const seed of SEEDS) {
    const args = placementArgs(config, seed, BALCONY_POSES[waveIndex], {
      waveIndex, yaw: Math.PI / 2, entries: pairEntries(config, waveIndex),
    });
    const baseline = selectEncounterFrontPair(args);
    assertFrontPair(baseline, args);
    assert.equal(selectEncounterFrontPair({ ...args, blocked: () => true }), null);
    assert.equal(selectEncounterFrontPair({ ...args, floorAt: () => -Infinity }), null);
    const enemies = config.spawns.map(anchor => ({ alive: true, pos: { ...anchor, y: anchor.y + SPAWN_CLEARANCE } }));
    assert.equal(selectEncounterFrontPair({ ...args, enemies }), null, 'Originals cannot bypass occupancy either');
    assert.deepEqual(selectEncounterFrontPair({ ...args, startIndex: 999 }), baseline,
      'A failed attempt or a cursor change cannot reroll the same seeded proposal');
  }
});

for (const [waveIndex, flight] of STAIRS.flights.entries()) {
  test(`seeded stair flight ${waveIndex + 1} preserves its forward landing and concealed lower rear lane`, () => {
    const config = ZONE_WAVE_CONFIG.stairwell, west = flight.lane === 'west';
    for (const seed of SEEDS) for (const entryIndex of [0, 1]) {
      const rear = entryIndex === 1;
      const pose = point(flight.x, rear ? (west ? -0.85 : -9.2) : (west ? -9.2 : -0.85), rear ? flight.toY : flight.fromY);
      for (const [dx, dz, pitch, aspect] of [[0, 0, 0, 16 / 9], [-0.15, -0.15, -0.35, 0.75], [0.15, 0.15, 0.35, 3]]) {
        const playerFoot = { ...pose, x: pose.x + dx, z: pose.z + dz };
        const args = placementArgs(config, seed, playerFoot, {
          waveIndex, entryIndex, yaw: west ? Math.PI : 0, pitch, aspect,
          weapon: { current: 'pistol', loaded: 0, reserve: seed % 2 ? 24 : 0 },
        });
        assert.equal(capsuleHasClearance({ ...playerFoot, y: playerFoot.y + SPAWN_CLEARANCE }, RADIUS, HEIGHT, Colliders.list), true);
        const selected = selectEncounterSpawn(args);
        assertSelection(selected, args);
        const landing = STAIRS.landings[waveIndex + (rear ? 0 : 1)];
        near(selected.point.y, landing.y + SPAWN_CLEARANCE, 'The chosen actor stays on the correct authored floor');
        assert.ok(selected.point.x >= landing.x1 && selected.point.x <= landing.x2);
        assert.ok(selected.point.z >= landing.z1 && selected.point.z <= landing.z2);
        assert.equal(selected.usedRearAnchor, rear);
        assert.equal(selected.rear, rear);
        if (rear) {
          assert.ok(Math.abs(selected.point.x - flight.x) + RADIUS < flight.width / 2, 'The rear body stays in this flight lane');
          assert.equal(describeOffscreenThreat(args.view, bodyAt(selected.point)).visible, false);
          assert.equal(selected.graceSeconds, 1);
          assert.equal(selected.type, seed % 2 && config.waves[waveIndex][entryIndex] !== 'brawler' ? 'thug' : 'brawler');
        } else {
          assert.equal(selected.type, config.waves[waveIndex][entryIndex]);
        }
      }
    }
  });
}

const ARENAS = [
  ...['apartment', 'neighbor', 'roof', 'street', 'bakery'].map(zone => ({
    name: zone, config: ZONE_WAVE_CONFIG[zone], pose: () => CHECKPOINTS[zone],
  })),
  { name: 'scaffold', config: ZONE_WAVE_CONFIG.scaffolding,
    pose: waveIndex => ZONE_WAVE_CONFIG.scaffolding.spawns[ZONE_WAVE_CONFIG.scaffolding.stages[waveIndex].spawnIndices[0]] },
  { name: 'car finale', config: FINAL_ENCOUNTERS.car, pose: () => DISTRICT.car.approach },
  { name: 'bakery finale', config: FINAL_ENCOUNTERS.bakery, pose: () => CHECKPOINTS.bakery },
];
for (const { name, config, pose } of ARENAS) {
  test(`seeded ${name} arrivals use only clear, supported stage pockets`, () => {
    let placements = 0;
    for (const seed of SEEDS) for (const [waveIndex, wave] of config.waves.entries()) {
      const enemies = [];
      for (const [entryIndex, type] of wave.entries()) {
        // Groups larger than the live cap need a released slot. Scheduling and
        // death ownership are tested elsewhere; this fixture verifies geometry.
        if (enemies.length === config.maxAlive) enemies.shift();
        const args = placementArgs(config, seed, pose(waveIndex), { waveIndex, entryIndex, type, enemies });
        const selected = selectEncounterSpawn(args);
        assertSelection(selected, args);
        enemies.push({ alive: true, pos: selected.point, encounterWave: waveIndex, encounterKey: args.encounterKey });
        placements++;
      }
    }
    assert.equal(placements, SEEDS.length * config.totalContacts, 'Every authored contact receives a positive geometry check');
  });
}
