// Authored mission data is deliberately independent of Three.js and the DOM.
// Coordinates use FEET, not camera height. Keep these anchors on solid floors
// when changing world geometry; a trigger can fire while the player is falling.
import { BALCONY, ROOF, SCAFFOLD_LEVELS } from '../world/layout.js';
import { STAIRS } from '../world/stair-layout.js';
import { DISTRICT } from '../world/district-layout.js';

const BALCONY_LANE_X = (BALCONY.east.x1 + BALCONY.east.x2) / 2;
const BALCONY_START_Z = -8.4;
const BALCONY_TURN_DISTANCE = BALCONY.laneZ - BALCONY_START_Z;
const stairLandings = STAIRS.landings.slice(1);
const balconyLanes = [0.62, 1.18];
const balconySpawns = [
  { x: BALCONY_LANE_X, y: BALCONY.floorY, z: BALCONY_START_Z },
  { x: BALCONY_LANE_X, y: BALCONY.floorY, z: -0.3 },
  ...[BALCONY_LANE_X, 8, 4, 1, -4, -8, -12, -15, BALCONY.wrap.x1 + 1].map((x, index) => ({
    x, y: BALCONY.floorY, z: balconyLanes[index % balconyLanes.length],
  })),
  // These two east positions expose both actors from the arrival checkpoint.
  // Their extra depth also preserves five metres while the player accelerates.
  { x: BALCONY_LANE_X - 1, y: BALCONY.floorY, z: balconyLanes[1] },
  { x: BALCONY_LANE_X + 1, y: BALCONY.floorY, z: balconyLanes[1] },
  // Late forward choices retain a stagger when the player pushes west before
  // an earlier blocked pair can arrive. They never authorize a closer spawn.
  { x: BALCONY.wrap.x1 + 2, y: BALCONY.floorY, z: balconyLanes[0] },
  { x: BALCONY.wrap.x1 + 0.6, y: BALCONY.floorY, z: balconyLanes[1] },
];
// A rear contact enters from the bottom of the player's current flight, on
// that flight's lane. The other lane can lead under a floor or down a flight.
const stairRearSpawns = STAIRS.flights.map(flight => ({
  x: flight.x + (flight.lane === 'west' ? -0.05 : 0.05), y: flight.fromY,
  z: flight.lane === 'west' ? STAIRS.interior.z1 + 0.9 : STAIRS.interior.z2 - 0.75,
}));
const scaffoldLanes = [3.2, 4.2, 4.5, 5.2];
const scaffoldSpawns = SCAFFOLD_LEVELS.flatMap((level, index) => [
  level.x1 + 1.2, level.x1 + 2.8, (level.x1 + level.x2) / 2, level.x2 - 3.2, level.x2 - 1,
].map(x => ({ x, y: level.y, z: scaffoldLanes[index] })));

export const ZONE_ORDER = Object.freeze([
  'apartment', 'neighbor', 'balcony', 'stairwell',
  'roof', 'scaffolding', 'street', 'bakery',
]);

export const CHECKPOINTS = Object.freeze(Object.fromEntries(Object.entries({
  apartment:   { x: -9,    y: 4,    z: -4,   yaw: -Math.PI / 4 },
  neighbor:    { x: -0.6,  y: 4,    z: -6,   yaw: -Math.PI * 3 / 4 },
  balcony:     { x: BALCONY_LANE_X, y: BALCONY.floorY, z: -4.5, yaw: Math.PI },
  stairwell:   { x: -16.6, y: 4,    z: -3.4, yaw: 0 },
  roof:        { x: -13.5, y: 14,   z: -8.4, yaw: -Math.PI / 2 },
  scaffolding: { x: (ROOF.exit.x1 + ROOF.exit.x2) / 2, y: SCAFFOLD_LEVELS[0].y, z: 2.4, yaw: Math.PI / 2 },
  street:      { ...DISTRICT.street.checkpoint },
  bakery:      { ...DISTRICT.bakery.checkpoint },
}).map(([zone, anchor]) => [zone, Object.freeze(anchor)])));

function encounter({ spawns, waves, route, stages, reinforcements, typeCaps, rearPressure, rearSpawns = [], rearEntryIndices, variation, ...settings }) {
  const groups = Object.freeze(waves.map(group => Object.freeze(group)));
  return Object.freeze({
    firstWave: 1.8,
    waveInterval: 5,
    maxAlive: 3,
    maxHeightDifference: 3.2,
    retireLive: true,
    ...settings,
    variation: Object.freeze({ timingFraction: 0.18, jitterX: 0.18, jitterZ: 0.18, ...variation }),
    spawns: Object.freeze(spawns.map(point => Object.freeze(point))),
    rearSpawns: Object.freeze(rearSpawns.map(point => Object.freeze(point))),
    rearPressure: rearPressure ? Object.freeze({ ...rearPressure }) : null,
    rearEntryIndices: rearEntryIndices ? Object.freeze([...rearEntryIndices]) : undefined,
    route: route ? Object.freeze({
      ...route,
      points: Object.freeze(route.points.map(point => Object.freeze(point))),
    }) : null,
    stages: stages ? Object.freeze(stages.map(stage => Object.freeze({
      ...stage,
      spawnIndices: Object.freeze(stage.spawnIndices),
      ...(stage.preferredSpawnIndices ? { preferredSpawnIndices: Object.freeze(stage.preferredSpawnIndices) } : {}),
      ...(stage.rearSpawnIndices ? { rearSpawnIndices: Object.freeze(stage.rearSpawnIndices) } : {}),
    }))) : null,
    reinforcements: reinforcements ? Object.freeze({ ...reinforcements }) : null,
    typeCaps: typeCaps ? Object.freeze({ ...typeCaps }) : null,
    waves: groups,
    waveCount: groups.length,
    totalContacts: groups.reduce((total, group) => total + group.length, 0),
    // Kept as a method for existing debugging tools. Exhausted encounters do
    // not silently escalate or repeat their last composition.
    composition(index) { return groups[index] || []; },
  });
}

export const ZONE_WAVE_CONFIG = Object.freeze({
  apartment: encounter({
    firstWave: 3.5, maxAlive: 2,
    variation: { key: 'apartment' },
    spawns: [
      { x: -5, y: 4, z: -8.5 },
      { x: -10.6, y: 4, z: -8.8 },
      { x: -13, y: 4, z: -5.35 },
      { x: -5, y: 4, z: -3.45 },
    ],
    waves: [['brawler', 'thug']],
    exitHint: 'MOVE THROUGH THE BREACH',
  }),
  neighbor: encounter({
    maxAlive: 2,
    variation: { key: 'neighbor' },
    spawns: [
      { x: 5.8, y: 4, z: -2.2 },
      { x: 7.5, y: 4, z: -3.2 },
      { x: 3.4, y: 4, z: -8.4 },
      { x: 7, y: 4, z: -7.9 },
    ],
    stages: [
      { id: 'neighbor-foyer', label: 'FOYER CONTACTS', spawnIndices: [0, 1, 2, 3] },
      { id: 'neighbor-dining', label: 'DINING ROOM', spawnIndices: [2, 3, 0, 1] },
    ],
    waves: [['thug', 'brawler'], ['gunman', 'thug']],
    exitHint: 'REACH THE BALCONY DOOR',
  }),
  balcony: encounter({
    firstWave: 0.1, maxAlive: 3, waveInterval: 4.5, minRecovery: 1.25,
    frontPairSize: 2, maxRearAlive: 1, advanceOnFrontClear: true, rearEntryIndices: [2],
    maxHeightDifference: 1.2,
    variation: { key: 'balcony', jitterX: 0.1, jitterZ: 0.025, maxFirstDelay: 0.1 },
    rearPressure: { fallbackAfter: 1.5, maxDistance: 12, stagger: true },
    // The route runs south along the east landing, then west to the stairs.
    // Each stage owns two forward contacts. Later stages add one weaker rear
    // reserve, which cannot occupy either slot reserved for the forward pair.
    route: {
      floorY: BALCONY.floorY, maxHeightDifference: 1.2, maxLateralDistance: 2.3,
      points: [
        { x: BALCONY_LANE_X, z: BALCONY_START_Z },
        { x: BALCONY_LANE_X, z: BALCONY.laneZ },
        { x: BALCONY.wrap.x1 + 1, z: BALCONY.laneZ },
      ],
    },
    spawns: balconySpawns,
    stages: [
      { id: 'east-landing', label: 'EAST LANDING', minProgress: 0, preferredSpawnIndices: [11, 12], spawnIndices: [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14] },
      { id: 'wrap-walkway', label: 'WRAP WALKWAY', minProgress: BALCONY_TURN_DISTANCE + BALCONY_LANE_X - 8, advanceAt: BALCONY_TURN_DISTANCE + BALCONY_LANE_X - 4, spawnIndices: [6, 7, 8, 9, 10, 13, 14] },
      { id: 'stair-approach', label: 'STAIR APPROACH', minProgress: BALCONY_TURN_DISTANCE + BALCONY_LANE_X + 4, advanceAt: BALCONY_TURN_DISTANCE + BALCONY_LANE_X + 6, spawnIndices: [8, 9, 10, 13, 14] },
    ],
    waves: [['brawler', 'thug'], ['thug', 'brawler', 'thug'], ['brawler', 'thug', 'thug']],
    exitHint: 'REACH THE STAIRWELL AT THE WEST END',
  }),
  stairwell: encounter({
    maxAlive: 2, firstWave: 1.2, waveInterval: 4.5, minRecovery: 0.25, stageTransitionDelay: 0,
    retireLive: false,
    variation: { key: 'stairwell', jitterX: 0.05, jitterZ: 0.05 },
    rearEntryIndices: [1],
    rearPressure: { fallbackAfter: 4.5, maxDistance: 10 },
    rearSpawns: stairRearSpawns,
    spawns: stairLandings.flatMap(landing => landing.spawnPoints),
    stages: stairLandings.map((landing, index) => ({
      id: landing.id, label: 'LANDING ' + (index + 1),
      minFootY: STAIRS.landings[index].y - 0.25,
      // Holding a landing grants the full breather. Committing to its next
      // flight brings the pair forward while there is still five metres of
      // safe separation; passing that pair's floor retires only its unspawned
      // contacts. Living enemies keep pursuing and reserve their live slots.
      advanceFootY: STAIRS.landings[index].y + 0.15,
      maxFootY: landing.y + 0.25,
      departAbove: landing.y + 0.25,
      spawnIndices: [index * 2, index * 2 + 1],
      rearSpawnIndices: [index],
    })),
    // Keep the armed forward contact. The second slot can instead become a
    // weaker pursuer from the lower landing; the finite eight-contact budget
    // and two-live cap are unchanged.
    waves: [['gunman', 'brawler'], ['gunman', 'thug'], ['hitman', 'gunman'], ['hitman', 'thug']],
    exitHint: 'CLIMB TO THE ROOF DOOR',
  }),
  roof: encounter({
    maxAlive: 5, waveInterval: 5, maxHeightDifference: 1.2,
    variation: { key: 'roof', jitterX: 0.6, jitterZ: 0.6 },
    typeCaps: { enforcer: 1 },
    reinforcements: { afterClearWave: 0, firstDelay: 1.75, interval: 4.5 },
    spawns: ROOF.spawnPockets.map(([x, z]) => ({ x, y: ROOF.floorY, z })),
    stages: [
      { id: 'roof-sentries', label: 'ROOF SENTRIES', spawnIndices: [8, 0, 9, 1] },
      { id: 'roof-response', label: 'ROOF RESPONSE TEAM', spawnIndices: [6, 5, 7, 3, 2, 1] },
      { id: 'roof-reserves', label: 'REINFORCEMENTS', spawnIndices: [4, 3, 2, 7, 6, 5] },
      { id: 'roof-last-reserve', label: 'LAST RESERVE TEAM', spawnIndices: [7, 5, 6, 4, 3, 2] },
    ],
    waves: [
      ['gunman', 'thug'],
      ['gunman', 'hitman', 'bruiser', 'enforcer'],
      ['brawler', 'gunman', 'thug'],
      ['hitman', 'bruiser', 'thug'],
    ],
    exitHint: 'EAST SCAFFOLDING · DESCEND TO THE STREET',
  }),
  scaffolding: encounter({
    firstWave: 1.2, waveInterval: 4.5, maxAlive: 3, maxHeightDifference: 1.2,
    variation: { key: 'scaffolding', jitterX: 0.3, jitterZ: 0.12 },
    stageTransitionDelay: 0.75,
    spawns: scaffoldSpawns,
    stages: SCAFFOLD_LEVELS.map((level, index) => ({
      id: 'scaffold-deck-' + (index + 1), label: 'PLATFORM ' + (index + 1),
      minFootY: level.y - 1, maxFootY: level.y + 1.2,
      ...(index < SCAFFOLD_LEVELS.length - 1 ? { departBelow: level.y - 1 } : {}),
      spawnIndices: [0, 1, 2, 3, 4].map(offset => index * 5 + offset),
    })),
    waves: [
      ['thug', 'gunman', 'brawler'],
      ['gunman', 'hitman', 'thug', 'gunman'],
      ['bruiser', 'gunman', 'brawler'],
      ['hitman', 'gunman', 'thug', 'gunman'],
    ],
    exitHint: 'DROP TO THE NEXT PLATFORM',
  }),
  street: encounter({
    maxAlive: 5, waveInterval: 5.5, maxHeightDifference: 1.2,
    variation: { key: 'street', jitterX: 0.75, jitterZ: 0.75 },
    typeCaps: { enforcer: 1 },
    spawns: DISTRICT.street.spawnPockets,
    stages: [
      { id: 'street-east', label: 'EAST BLOCK', spawnIndices: [6, 7, 8, 11, 10] },
      { id: 'street-center', label: 'STREET RESPONSE', spawnIndices: [4, 5, 10, 3, 6] },
      { id: 'street-west', label: 'WEST BLOCK', spawnIndices: [2, 1, 0, 9, 3] },
      { id: 'street-last', label: 'LAST STREET TEAM', spawnIndices: [5, 10, 6, 7, 3, 2, 1] },
    ],
    waves: [
      ['thug', 'gunman', 'brawler', 'gunman'],
      ['gunman', 'hitman', 'bruiser', 'thug'],
      ['enforcer', 'gunman', 'brawler', 'hitman'],
      ['bruiser', 'gunman', 'hitman', 'enforcer'],
    ],
    exitHint: 'CHOOSE THE CAR OR THE BAKERY',
  }),
  bakery: encounter({
    maxAlive: 5, waveInterval: 5, maxHeightDifference: 1.2, deadlineSeconds: 180,
    variation: { key: 'bakery', jitterX: 0.3, jitterZ: 0.3 },
    typeCaps: { enforcer: 1 },
    spawns: DISTRICT.bakery.spawnPockets,
    stages: [
      { id: 'bakery-front', label: 'SHOP FLOOR', spawnIndices: [0, 1, 2, 3, 4] },
      { id: 'bakery-response', label: 'BAKERY RAIDERS', spawnIndices: [3, 4, 5, 6, 10, 0, 1] },
      { id: 'bakery-back', label: 'BACK ROOM', spawnIndices: [5, 6, 7, 8, 9, 10] },
      { id: 'bakery-last', label: 'LAST RAIDERS', spawnIndices: [5, 6, 7, 8, 9, 10, 0, 1] },
    ],
    // The normal zone and protector finale share one authored roster.
    waves: [
      ['brawler', 'thug', 'gunman', 'gunman'],
      ['thug', 'gunman', 'hitman', 'bruiser', 'brawler'],
      ['gunman', 'hitman', 'thug', 'bruiser'],
      ['enforcer', 'gunman', 'hitman', 'brawler', 'thug'],
    ],
    exitHint: 'SEARCH THE BACK ROOM',
  }),
});

export const FINAL_ENCOUNTERS = Object.freeze({
  car: encounter({
    firstWave: 0, maxAlive: 5, waveInterval: 5, maxHeightDifference: 1.2, deadlineSeconds: 0, arrivalRadius: 3.2,
    variation: { key: 'car', jitterX: 0.5, jitterZ: 0.5 },
    spawns: DISTRICT.car.spawnPockets,
    waves: [['bruiser', 'hitman', 'gunman', 'gunman'], ['thug', 'gunman', 'hitman', 'bruiser']],
  }),
  bakery: encounter({
    ...ZONE_WAVE_CONFIG.bakery,
    firstWave: 0,
  }),
});

export const SPAWN_CLEARANCE = 0.03;
export const MIN_SPAWN_DISTANCE = 5;

/**
 * Pure candidate selection with injected geometry probes. Every return path
 * enforces the same support, clearance, player-distance and crowding rules.
 * A null result means defer the spawn; it never means bypass safety.
 */
export function selectSafeSpawn(candidates, {
  playerFoot, enemies = [], floorAt, blocked,
  startIndex = 0, minPlayerDistance = MIN_SPAWN_DISTANCE,
  minEnemyDistance = 1.5, maxHeightDifference = Infinity,
}) {
  if (!candidates.length) return null;
  for (let offset = 0; offset < candidates.length; offset++) {
    const index = ((startIndex + offset) % candidates.length + candidates.length) % candidates.length;
    const candidate = candidates[index];
    if (![candidate.x, candidate.y, candidate.z].every(Number.isFinite)) continue;
    const dx = candidate.x - playerFoot.x, dz = candidate.z - playerFoot.z;
    if (dx * dx + dz * dz < minPlayerDistance * minPlayerDistance) continue;
    const floor = floorAt(candidate);
    if (!Number.isFinite(floor)) continue;
    // Do not silently move a spawn down through a deck or up onto furniture.
    if (floor < candidate.y - 0.28 || floor > candidate.y + 0.16) continue;
    if (Math.abs(floor - playerFoot.y) > maxHeightDifference) continue;
    const point = { x: candidate.x, y: floor + SPAWN_CLEARANCE, z: candidate.z };
    if (blocked(point)) continue;
    const occupied = enemies.some(enemy => {
      if (!enemy.alive || Math.abs(enemy.pos.y - point.y) > 2.2) return false;
      const ex = enemy.pos.x - point.x, ez = enemy.pos.z - point.z;
      return ex * ex + ez * ez < minEnemyDistance * minEnemyDistance;
    });
    if (!occupied) return point;
  }
  return null;
}

export function createCheckpoint(zone, weapon, branch = null) {
  if (!CHECKPOINTS[zone]) throw new RangeError(`Unknown checkpoint zone: ${zone}`);
  if (branch !== null && branch !== 'car' && branch !== 'bakery') {
    throw new RangeError(`Unknown ending branch: ${branch}`);
  }
  if ((branch === 'car' && zone !== 'street') || (branch === 'bakery' && zone !== 'bakery')) {
    throw new RangeError('An ending checkpoint must belong to its arena');
  }
  return Object.freeze({
    zone, branch,
    anchor: CHECKPOINTS[zone],
    weapon: Object.freeze({
      current: weapon.current,
      loaded: weapon.loaded,
      reserve: weapon.reserve,
    }),
  });
}
