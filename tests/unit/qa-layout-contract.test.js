import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Box3, BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import {
  APARTMENT_DOORS, BUILDING, BALCONY, ROOF, SCAFFOLD_LEVELS, OPENINGS, SCAFFOLD_TRIGGER_MIN_Z,
} from '../../src/world/layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { CHECKPOINTS, ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from '../../src/game/mission-data.js';
import { routeDistanceAt } from '../../src/game/encounter-rules.js';
import { resolveSurfaceOwnership } from '../../src/world/surface-ownership.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';
import { Architecture } from '../../src/world/architecture.js';
import { createAmmoSupplies } from '../../src/game/ammo-supplies.js';
import { AMMO_SUPPLY_CACHES } from '../../src/game/ammo-supply-rules.js';

// Keep this suite independent of player/enemy modules, which initialize the
// browser renderer. These are the movement capsule radii, not visual bounds.
const CAPSULES = [{ name: 'player', radius: 0.32 }, { name: 'enemy', radius: 0.35 }];
const STANDING_HEIGHT = 1.84;
const EPSILON = 1e-8;

function assertWithin(rect, point, radius, label) {
  assert.ok(point.x - radius >= rect.x1 - EPSILON, `${label}: west clearance`);
  assert.ok(point.x + radius <= rect.x2 + EPSILON, `${label}: east clearance`);
  assert.ok(point.z - radius >= rect.z1 - EPSILON, `${label}: north clearance`);
  assert.ok(point.z + radius <= rect.z2 + EPSILON, `${label}: south clearance`);
}

function overlap(...rectangles) {
  const x1 = Math.max(...rectangles.map(rect => rect.x1));
  const x2 = Math.min(...rectangles.map(rect => rect.x2));
  const z1 = Math.max(...rectangles.map(rect => rect.z1));
  const z2 = Math.min(...rectangles.map(rect => rect.z2));
  return Math.max(0, x2 - x1) * Math.max(0, z2 - z1);
}

function assertBalconySupport(point, radius, label) {
  // A square envelope is stricter than a circular capsule footprint. Measure
  // its union coverage so crossing the seam between the two slabs is valid.
  const footprint = {
    x1: point.x - radius, x2: point.x + radius,
    z1: point.z - radius, z2: point.z + radius,
  };
  const covered = overlap(footprint, BALCONY.east) + overlap(footprint, BALCONY.wrap)
    - overlap(footprint, BALCONY.east, BALCONY.wrap);
  const area = 4 * radius * radius;
  assert.ok(Math.abs(covered - area) < EPSILON,
    `${label}: footprint at (${point.x}, ${point.z}) leaves the balcony`);
}

function assertRoofSupport(point, radius, label) {
  assertWithin(ROOF, point, radius, label);
  const footprint = {
    x1: point.x - radius, x2: point.x + radius,
    z1: point.z - radius, z2: point.z + radius,
  };
  for (const [name, exclusion] of Object.entries({ lightwell: ROOF.lightwell, serviceHouse: ROOF.serviceHouse })) {
    assert.ok(overlap(footprint, exclusion) < EPSILON, `${label}: footprint must clear the ${name}`);
  }
}

test('checkpoint elevations follow shared floor and opening anchors', () => {
  const floorByZone = {
    apartment: BUILDING.apartmentY,
    neighbor: BUILDING.apartmentY,
    balcony: BALCONY.floorY,
    stairwell: STAIRS.entryY,
    roof: ROOF.floorY,
    scaffolding: SCAFFOLD_LEVELS[0].y,
    street: DISTRICT.street.road.floorY,
    bakery: DISTRICT.bakery.floorY,
  };
  for (const [zone, floorY] of Object.entries(floorByZone)) {
    assert.equal(CHECKPOINTS[zone].y, floorY, `${zone}: feet must start on its authored floor`);
  }
});

test('structural checkpoints leave room for a whole standing player footprint', () => {
  const supportByZone = {
    apartment: BUILDING.main,
    neighbor: BUILDING.main,
    balcony: BALCONY.east,
    stairwell: STAIRS.interior,
    roof: ROOF,
    scaffolding: SCAFFOLD_LEVELS[0],
    street: DISTRICT.street.road,
    bakery: DISTRICT.bakery,
  };
  for (const [zone, footprint] of Object.entries(supportByZone)) {
    assertWithin(footprint, CHECKPOINTS[zone], CAPSULES[0].radius, `${zone} checkpoint`);
  }
});

test('entry checkpoints align with the usable spans of their authored openings', () => {
  const radius = CAPSULES[0].radius;
  const entries = [
    { zone: 'balcony', opening: OPENINGS.neighborBalcony, span: 'z', axis: 2, through: 'x', normalAxis: 0 },
    { zone: 'roof', opening: OPENINGS.stairRoof, span: 'z', axis: 2, through: 'x', normalAxis: 0 },
    { zone: 'bakery', opening: OPENINGS.bakery, span: 'x', axis: 0, through: 'z', normalAxis: 2 },
  ];
  for (const { zone, opening, span, axis, through, normalAxis } of entries) {
    const anchor = CHECKPOINTS[zone];
    assert.equal(anchor.y, opening.min[1], `${zone}: doorway has no step at checkpoint height`);
    assert.ok(anchor.y + STANDING_HEIGHT <= opening.max[1], `${zone}: standing headroom`);
    assert.ok(anchor[span] - radius >= opening.min[axis], `${zone}: first jamb clearance`);
    assert.ok(anchor[span] + radius <= opening.max[axis], `${zone}: second jamb clearance`);
    assert.ok(anchor[through] - radius >= opening.max[normalAxis], `${zone}: checkpoint clears the wall`);
  }
});

test('balcony encounter route shares the floor, centerline and stair doorway', () => {
  const route = ZONE_WAVE_CONFIG.balcony.route;
  assert.ok(route?.points.length >= 3, 'the route must include the landing, turn and stair approach');
  assert.equal(route.floorY, BALCONY.floorY);
  assertWithin(BALCONY.east, route.points[0], CAPSULES[1].radius, 'route entry');
  const wrapPoints = route.points.filter(point => point.z >= BALCONY.wrap.z1);
  assert.ok(wrapPoints.length >= 2, 'the route must cross the wrap walkway');
  for (const point of wrapPoints) assert.equal(point.z, BALCONY.laneZ, 'walkway route uses the shared centerline');

  const end = route.points.at(-1);
  const door = OPENINGS.balconyStair;
  assert.equal(route.floorY, door.min[1], 'stair opening meets the balcony floor');
  assert.ok(route.floorY + STANDING_HEIGHT <= door.max[1], 'stair opening has standing headroom');
  for (const { name, radius } of CAPSULES) {
    assert.ok(end.x - radius >= door.min[0], `${name}: stair west jamb clearance`);
    assert.ok(end.x + radius <= door.max[0], `${name}: stair east jamb clearance`);
    assert.ok(end.z - radius > door.max[2], `${name}: route approaches the exterior side of the doorway`);
  }
  assert.notEqual(routeDistanceAt(route, CHECKPOINTS.balcony), null, 'checkpoint belongs to the encounter route');
});

test('the full balcony centerline supports player and enemy capsules through the corner', () => {
  const route = ZONE_WAVE_CONFIG.balcony.route;
  for (const { name, radius } of CAPSULES) {
    assert.ok(BALCONY.laneZ - radius > BALCONY.wrap.z1 + BUILDING.wallThickness / 2,
      `${name}: centerline clears the building wall`);
    assert.ok(BALCONY.laneZ + radius < BALCONY.wrap.z2 - BALCONY.edgeInset,
      `${name}: centerline clears the outer edge`);
    for (let index = 1; index < route.points.length; index++) {
      const from = route.points[index - 1], to = route.points[index];
      const distance = Math.hypot(to.x - from.x, to.z - from.z);
      const samples = Math.max(1, Math.ceil(distance / 0.1));
      for (let sample = 0; sample <= samples; sample++) {
        const fraction = sample / samples;
        assertBalconySupport({
          x: from.x + (to.x - from.x) * fraction,
          z: from.z + (to.z - from.z) * fraction,
        }, radius + BALCONY.edgeInset, `${name} route segment ${index}`);
      }
    }
  }
});

test('every balcony spawn remains grounded on the authored route with enemy clearance', () => {
  const config = ZONE_WAVE_CONFIG.balcony;
  for (const [index, point] of config.spawns.entries()) {
    assert.equal(point.y, BALCONY.floorY, `balcony spawn ${index}: floor anchor`);
    assertBalconySupport(point, CAPSULES[1].radius + BALCONY.edgeInset, `balcony spawn ${index}`);
    if (point.z >= BALCONY.wrap.z1) {
      assert.ok(Math.abs(point.z - BALCONY.laneZ) >= 0.2 && Math.abs(point.z - BALCONY.laneZ) <= 0.4,
        `balcony spawn ${index}: staggered inside the widened walkway`);
    }
    assert.notEqual(routeDistanceAt(config.route, point), null, `balcony spawn ${index}: route projection`);
  }
});

test('stair encounter anchors occupy shared landing floors with full capsule clearance', () => {
  const anchors = [
    { label: 'stair checkpoint', point: CHECKPOINTS.stairwell, radius: CAPSULES[0].radius },
    ...ZONE_WAVE_CONFIG.stairwell.spawns.map((point, index) => ({
      label: `stair spawn ${index}`, point, radius: CAPSULES[1].radius,
    })),
    ...ZONE_WAVE_CONFIG.stairwell.rearSpawns.map((point, index) => ({
      label: `stair rear spawn ${index}`, point, radius: CAPSULES[1].radius,
    })),
  ];
  for (const { label, point, radius } of anchors) {
    const landing = STAIRS.landings.find(surface => Math.abs(surface.y - point.y) < EPSILON);
    assert.ok(landing, `${label}: floor matches a shared landing`);
    assertWithin(landing, point, radius, label);
  }
  for (const [index, point] of ZONE_WAVE_CONFIG.stairwell.spawns.entries()) {
    assert.ok(STAIRS.landings.some(landing => landing.spawnPoints.some(authored =>
      authored.x === point.x && authored.y === point.y && authored.z === point.z)),
    `stair spawn ${index}: uses an authored landing spawn point`);
  }
});

test('stair route connects balcony and roof floors through their shared openings', () => {
  assert.equal(STAIRS.entryDoor, OPENINGS.balconyStair);
  assert.equal(STAIRS.roofDoor, OPENINGS.stairRoof);
  assert.equal(STAIRS.entryY, BALCONY.floorY);
  assert.equal(STAIRS.exitY, ROOF.floorY);
  const [entryX, entryY, entryZ] = STAIRS.route[0];
  const [lastX, lastY, lastZ] = STAIRS.route.at(-1);
  const [exitX, exitY, exitZ] = STAIRS.roofExit;
  assert.equal(entryY, BALCONY.floorY, 'stair route begins on the balcony floor');
  assert.equal(lastY, ROOF.floorY, 'stair route reaches roof height');
  assert.equal(exitY, ROOF.floorY, 'receiving roof anchor shares the top landing elevation');
  for (const { name, radius } of CAPSULES) {
    assertWithin(STAIRS.landings[0], { x: entryX, z: entryZ }, radius, `${name} stair entry`);
    assert.ok(entryX - radius >= STAIRS.entryDoor.min[0]
      && entryX + radius <= STAIRS.entryDoor.max[0], `${name}: stair entry clears both jambs`);
    assert.ok(entryZ + radius <= STAIRS.entryDoor.min[2], `${name}: stair entry clears the wall inside`);
    assert.ok(lastZ - radius >= STAIRS.roofDoor.min[2]
      && lastZ + radius <= STAIRS.roofDoor.max[2], `${name}: top approach clears both jambs`);
    assert.ok(lastX + radius <= STAIRS.roofDoor.min[0], `${name}: top approach remains inside the tower`);
    assert.ok(exitZ - radius >= STAIRS.roofDoor.min[2]
      && exitZ + radius <= STAIRS.roofDoor.max[2], `${name}: roof exit clears both jambs`);
    assert.ok(exitX - radius >= STAIRS.roofDoor.max[0], `${name}: roof exit clears the tower wall`);
    assertRoofSupport({ x: exitX, z: exitZ }, radius, `${name} roof receiving floor`);
  }
});

test('roof checkpoint, enemy pockets and mission spawns avoid the lightwell and service house', () => {
  assertRoofSupport(CHECKPOINTS.roof, CAPSULES[0].radius, 'roof checkpoint');
  for (const [index, [x, z]] of ROOF.spawnPockets.entries()) {
    assertRoofSupport({ x, z }, CAPSULES[1].radius, `roof spawn pocket ${index}`);
  }
  for (const [index, point] of ZONE_WAVE_CONFIG.roof.spawns.entries()) {
    assert.equal(point.y, ROOF.floorY, `roof spawn ${index}: floor anchor`);
    assertRoofSupport(point, CAPSULES[1].radius, `roof spawn ${index}`);
  }
});

test('the authored roof route crosses supported floor to the shared scaffold exit', () => {
  assert.ok(ROOF.route.length >= 2, 'the roof route connects the stair entrance to the exit');
  const [startX, startY, startZ] = ROOF.route[0];
  assert.deepEqual({ x: startX, y: startY, z: startZ }, {
    x: CHECKPOINTS.roof.x, y: CHECKPOINTS.roof.y, z: CHECKPOINTS.roof.z,
  }, 'the roof route starts at the checkpoint');
  for (const [index, [x, y, z]] of ROOF.route.entries()) {
    assert.equal(y, ROOF.floorY, `roof route ${index}: floor anchor`);
    assertRoofSupport({ x, z }, CAPSULES[0].radius, `roof route ${index}`);
    if (index === 0) continue;
    const [fromX, , fromZ] = ROOF.route[index - 1];
    const samples = Math.max(1, Math.ceil(Math.hypot(x - fromX, z - fromZ) / 0.1));
    for (let sample = 0; sample <= samples; sample++) {
      const fraction = sample / samples;
      assertRoofSupport({
        x: fromX + (x - fromX) * fraction,
        z: fromZ + (z - fromZ) * fraction,
      }, CAPSULES[0].radius, `roof route segment ${index}`);
    }
  }
  const [exitX, , exitZ] = ROOF.route.at(-1);
  const radius = CAPSULES[0].radius;
  assert.ok(exitX - radius >= ROOF.exit.x1 && exitX + radius <= ROOF.exit.x2,
    'the route ends within the usable exit span');
  assert.ok(exitZ + radius <= ROOF.exit.z, 'the last roof waypoint remains supported before the drop');
});

test('district checkpoints and bakery opening match the shared street and shop contract', () => {
  assert.deepEqual(CHECKPOINTS.street, DISTRICT.street.checkpoint);
  assert.deepEqual(CHECKPOINTS.bakery, DISTRICT.bakery.checkpoint);
  const opening = OPENINGS.bakery;
  const bakery = DISTRICT.bakery;
  assert.equal(opening.min[0], bakery.door.x1);
  assert.equal(opening.max[0], bakery.door.x2);
  assert.equal(opening.min[1], bakery.floorY);
  assert.equal(opening.max[1], bakery.door.topY);
  assert.equal(bakery.door.z, bakery.z1, 'the entrance belongs to the shop front');
  assert.ok(opening.min[2] < bakery.door.z && opening.max[2] > bakery.door.z,
    'the entrance opening crosses the front wall');
  assert.ok(opening.min[2] <= bakery.door.z - bakery.wallThickness / 2 + EPSILON
    && opening.max[2] >= bakery.door.z + bakery.wallThickness / 2 - EPSILON,
  'the entrance opening spans the full wall thickness');
});

test('street and final car encounters remain on supported district surfaces', () => {
  const radius = CAPSULES[1].radius;
  const surfaces = [DISTRICT.street.road, DISTRICT.street.nearApron, DISTRICT.street.farWalk];
  const encounters = { street: ZONE_WAVE_CONFIG.street, car: FINAL_ENCOUNTERS.car };
  for (const [name, config] of Object.entries(encounters)) {
    for (const [index, point] of config.spawns.entries()) {
      const support = surfaces.find(surface => Math.abs(surface.floorY - point.y) < EPSILON
        && point.x - radius >= surface.x1 && point.x + radius <= surface.x2
        && point.z - radius >= surface.z1 && point.z + radius <= surface.z2);
      assert.ok(support, `${name} spawn ${index}: full capsule is supported at its declared floor height`);
    }
  }
});

test('bakery encounters fit the expanded shop floor without intersecting authored furniture', () => {
  const bakery = DISTRICT.bakery;
  const obstacles = [bakery.counter, bakery.prepTable, bakery.oven].map(item => ({
    x1: item.x - item.width / 2, x2: item.x + item.width / 2,
    z1: item.z - item.depth / 2, z2: item.z + item.depth / 2,
  }));
  const encounters = { bakery: ZONE_WAVE_CONFIG.bakery, finalBakery: FINAL_ENCOUNTERS.bakery };
  const radius = CAPSULES[1].radius;
  for (const [name, config] of Object.entries(encounters)) {
    for (const [index, point] of config.spawns.entries()) {
      const label = `${name} spawn ${index}`;
      assert.equal(point.y, bakery.floorY, `${label}: floor anchor`);
      assertWithin(bakery, point, radius + bakery.wallThickness / 2, label);
      const footprint = {
        x1: point.x - radius, x2: point.x + radius,
        z1: point.z - radius, z2: point.z + radius,
      };
      assert.ok(obstacles.every(obstacle => overlap(footprint, obstacle) < EPSILON),
        `${label}: capsule must clear counter, prep table and oven`);
      if (Math.abs(point.z - bakery.partition.z) < radius + bakery.wallThickness / 2) {
        assert.ok(point.x - radius >= bakery.partition.doorX1
          && point.x + radius <= bakery.partition.doorX2,
        `${label}: a spawn at the partition must fit its doorway`);
      }
    }
  }
});

test('scaffold checkpoints and encounter spawns stay on an actual authored deck', () => {
  const anchors = [
    { label: 'scaffold checkpoint', point: CHECKPOINTS.scaffolding, radius: CAPSULES[0].radius },
    ...ZONE_WAVE_CONFIG.scaffolding.spawns.map((point, index) => ({
      label: `scaffold spawn ${index}`, point, radius: CAPSULES[1].radius,
    })),
  ];
  for (const { label, point, radius } of anchors) {
    const level = SCAFFOLD_LEVELS.find(deck => Math.abs(deck.y - point.y) < EPSILON);
    assert.ok(level, `${label}: floor height matches a deck`);
    assertWithin(level, point, radius, label);
  }
});

test('successive scaffold decks provide a supported capsule-width drop beyond the upper edge', () => {
  for (let index = 1; index < SCAFFOLD_LEVELS.length; index++) {
    const upper = SCAFFOLD_LEVELS[index - 1], lower = SCAFFOLD_LEVELS[index];
    assert.ok(upper.y - lower.y > STANDING_HEIGHT,
      `scaffold ${index}: receiving floor is below the upper deck with standing space`);
    const sharedX = Math.min(upper.x2, lower.x2) - Math.max(upper.x1, lower.x1);
    const sharedZ = Math.min(upper.z2, lower.z2) - Math.max(upper.z1, lower.z1);
    for (const { name, radius } of CAPSULES) {
      assert.ok(sharedX > 2 * radius && sharedZ > 2 * radius,
        `${name} scaffold ${index}: decks share a full-width approach`);
      const clearSide = lower.x1 + radius < upper.x1 - radius
        || lower.x2 - radius > upper.x2 + radius
        || lower.z1 + radius < upper.z1 - radius
        || lower.z2 - radius > upper.z2 + radius;
      assert.ok(clearSide,
        `${name} scaffold ${index}: receiving deck extends beyond the upper deck by a full capsule width`);
    }
  }
});

test('the roof drop opening leads to the top scaffold checkpoint', () => {
  const opening = OPENINGS.roofScaffold;
  const top = SCAFFOLD_LEVELS[0];
  const anchor = CHECKPOINTS.scaffolding;
  const radius = CAPSULES[0].radius;
  assert.equal(opening.min[1], ROOF.floorY, 'the parapet gap begins at roof level');
  assert.equal(opening.min[0], ROOF.exit.x1, 'opening shares the authored west exit edge');
  assert.equal(opening.max[0], ROOF.exit.x2, 'opening shares the authored east exit edge');
  assert.ok(opening.min[2] < ROOF.exit.z && opening.max[2] > ROOF.exit.z,
    'opening crosses the roof exit wall');
  assert.ok(top.y < opening.min[1], 'the first scaffold deck is a downward drop');
  assert.ok(anchor.x - radius >= opening.min[0], 'drop lane clears the west parapet end');
  assert.ok(anchor.x + radius <= opening.max[0], 'drop lane clears the east parapet end');
  assert.ok(anchor.z - radius > opening.max[2], 'checkpoint is beyond the parapet');
  // This is a gap in a low parapet, not a full-height doorway. Its max Y does
  // not impose an imaginary ceiling on the player moving out onto the deck.
});

test('scaffold decks do not intersect the balcony floor-to-screen envelope', () => {
  const guardTop = BALCONY.floorY + BALCONY.guardHeight;
  for (const [index, level] of SCAFFOLD_LEVELS.entries()) {
    const overlapsBalcony = overlap(level, BALCONY.east) > EPSILON
      || overlap(level, BALCONY.wrap) > EPSILON;
    if (overlapsBalcony) {
      assert.ok(level.y > guardTop || level.y < BALCONY.floorY,
        `scaffold ${index}: overlapping footprint needs vertical separation from the enclosure`);
    }
  }
  const sameFloor = SCAFFOLD_LEVELS.find(level => level.y === BALCONY.floorY);
  assert.ok(sameFloor, 'the descent retains its balcony-height deck');
  assert.ok(sameFloor.z1 > BALCONY.wrap.z2, 'the balcony-height plank starts outside the balcony edge');
});

test('scaffold trigger excludes the balcony while retaining supported entry space', () => {
  assert.ok(SCAFFOLD_TRIGGER_MIN_Z > BALCONY.wrap.z2,
    'walking the balcony must not activate the scaffold volume');
  assert.ok(CHECKPOINTS.scaffolding.z >= SCAFFOLD_TRIGGER_MIN_Z,
    'the top-deck checkpoint must enter the scaffold volume');
  for (const [index, level] of SCAFFOLD_LEVELS.entries()) {
    const radius = CAPSULES[0].radius;
    const firstSupportedZ = Math.max(SCAFFOLD_TRIGGER_MIN_Z, level.z1 + radius);
    assert.ok(firstSupportedZ < level.z2 - radius,
      `scaffold ${index}: trigger leaves a supported player-width landing`);
  }
});

function readQaSurfaceChecks(records, worldState = { surfaceOwnership: null }) {
  // Exercise the exact development QA functions without importing the browser
  // renderer, starting a game, or creating an audio context.
  const source = readFileSync(new URL('../../src/testing/qa.js', import.meta.url), 'utf8');
  const start = source.indexOf('function polygonAreaXZ('), end = source.indexOf('function boxGap(');
  assert.ok(start >= 0 && end > start, 'the signed-surface QA helpers remain independently readable');
  return runInNewContext(`${source.slice(start, end)}; ({
    visibleFloorFaces, assertSurfacePatch, checkFinalizedArchitectureSurfaces, checkFlushThresholdSurfaces,
  });`, {
    Matrix4, Vector3, APARTMENT_DOORS, BUILDING, ROOF, Architecture: { elements: records }, WorldState: worldState,
    assert: (condition, message) => assert.ok(condition, message),
    near(actual, expected, message, tolerance = 1e-6) {
      assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
        `${message}: expected ${expected}, got ${actual}`);
    },
    same: (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message),
  }, { filename: 'qa-surface-helpers.js' });
}

test('visible QA surface regressions reject original overlaps and read the finalized actual world without mutation', () => {
  const fixture = buildWorldSurfaceFixture(), state = { surfaceOwnership: null };
  const qa = readQaSurfaceChecks(fixture.records, state);
  assert.throws(() => qa.checkFinalizedArchitectureSurfaces(), /World boot must have finalized/);
  assert.throws(() => qa.assertSurfacePatch('Original roof-cap overlap',
    { x1: -13.95, x2: -13.45, z1: -10.08, z2: -9.92 }, 14, 1,
    { 'roof-annex-west-link-deck': 0.04, 'roof-deck': 0.04 }), /overlaps/);
  assert.throws(() => qa.assertSurfacePatch('Original downward ceiling overlap',
    { x1: -11.38, x2: -10.88, z1: -10.08, z2: -9.92 }, 7.4, -1,
    { 'apartment-ceiling': 0.04, 'main-upper-north': 0.04 }), /overlaps/);
  assert.throws(() => qa.checkFlushThresholdSurfaces(), /overlaps/);

  // Finalization belongs only to this offline build fixture. The QA functions
  // themselves must read the completed scene and never repair their subject.
  state.surfaceOwnership = resolveSurfaceOwnership(fixture.records.values());
  const report = state.surfaceOwnership, serialized = JSON.stringify(report);
  const geometries = new Map([...fixture.records].map(([id, record]) => [id, record.mesh.geometry]));
  assert.match(qa.checkFinalizedArchitectureSurfaces(), /boot-finalized meshes/);
  assert.match(qa.checkFlushThresholdSurfaces(), /no coplanar overlap or unintended hole/);
  assert.equal(state.surfaceOwnership, report);
  assert.equal(JSON.stringify(report), serialized);
  for (const [id, record] of fixture.records) assert.equal(record.mesh.geometry, geometries.get(id), `${id}: read-only QA`);
  const opening = STAIRS.roofDoor;
  assert.ok(qa.visibleFloorFaces({ x1: STAIRS.interior.x2 - 0.25, x2: ROOF.x1 + 0.25,
    z1: opening.min[2] + 0.05, z2: opening.max[2] - 0.05 }, STAIRS.exitY).length >= 3,
  'the existing upward-facing doorway call retains its default semantics');
});

test('QA signed surfaces honor rendered indices, draw ranges and visibility, and reject holes or wrong owners', () => {
  const geometry = new BoxGeometry(2, 1, 2), mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.position.y = 0.5;
  const parent = new Group(); parent.add(mesh);
  const bounds = new Box3(new Vector3(-1, 0, -1), new Vector3(1, 1, 1));
  const records = new Map([['deck', { id: 'deck', mesh, bounds }]]), qa = readQaSurfaceChecks(records);
  const region = { x1: -1, x2: 1, z1: -1, z2: 1 };
  qa.assertSurfacePatch('Top', region, 1, 1, { deck: 4 });
  qa.assertSurfacePatch('Underside', region, 0, -1, { deck: 4 });
  assert.equal(qa.visibleFloorFaces(region, 0).length, 0, 'the default facing does not count a negative ceiling');
  assert.throws(() => qa.assertSurfacePatch('Wrong finish', region, 1, 1, { brick: 4 }), /intended finish owners/);
  assert.throws(() => qa.visibleFloorFaces(region, 1, 0), /facing sign/);

  const duplicate = new Mesh(geometry, mesh.material); duplicate.position.copy(mesh.position); parent.add(duplicate);
  records.set('duplicate', { id: 'duplicate', mesh: duplicate, bounds });
  assert.throws(() => qa.assertSurfacePatch('Duplicate finish', region, 1, 1, { deck: 4 }), /overlaps/);
  records.delete('duplicate'); parent.remove(duplicate);
  mesh.material.visible = false;
  assert.equal(qa.visibleFloorFaces(region, 1).length, 0);
  mesh.material.visible = true; parent.visible = false;
  assert.equal(qa.visibleFloorFaces(region, 1).length, 0, 'hidden ancestors exclude their geometry');
  parent.visible = true;

  const top = geometry.groups.find(group => geometry.attributes.normal.getY(geometry.index.getX(group.start)) > 0.99);
  assert.ok(top, 'the real box contains an upward-facing material group');
  geometry.setDrawRange(top.start, top.count);
  assert.equal(qa.visibleFloorFaces(region, 1).length, 2);
  assert.equal(qa.visibleFloorFaces(region, 0, -1).length, 0, 'an indexed but undrawn underside is excluded');
  const original = [...geometry.index.array];
  geometry.setIndex([...original.slice(0, top.start), ...original.slice(top.start + top.count)]);
  geometry.setDrawRange(0, geometry.index.count);
  assert.throws(() => qa.assertSurfacePatch('Missing finish', region, 1, 1, { deck: 4 }), /visible indexed area/,
    'unused top vertices cannot conceal a hole in the actual rendered indices');
});

test('QA audits the actual registered ammo-case instances and still detects an overlapping foot', () => {
  const fixture = buildWorldSurfaceFixture();
  const state = { surfaceOwnership: resolveSurfaceOwnership(fixture.records.values()) };
  const supplies = createAmmoSupplies();
  supplies.init({ world: fixture.World, player: { pos: new Vector3(), _eyeH: 1.62 }, canInteract: () => false });
  const qa = readQaSurfaceChecks(Architecture.elements, state);
  const report = JSON.stringify(state.surfaceOwnership), inventory = JSON.stringify(supplies.snapshot());
  assert.match(qa.checkFinalizedArchitectureSurfaces(), /boot-finalized meshes/,
    'the real cache groups may touch a floor without aborting the architecture audit');
  for (const config of AMMO_SUPPLY_CACHES) {
    const owner = `ammo-cache-${config.id}`, record = Architecture.elements.get(owner);
    assert.equal(record.mesh.children.filter(mesh => mesh.isInstancedMesh).length, 4);
    const region = { x1: record.bounds.min.x, x2: record.bounds.max.x, z1: record.bounds.min.z, z2: record.bounds.max.z };
    assert.equal(qa.visibleFloorFaces(region, config.floorY, 1).filter(face => face.owner === owner).length, 0,
      'the case bottom is not an upward floor face');
    const soles = qa.visibleFloorFaces(region, config.floorY, -1).filter(face => face.owner === owner);
    assert.equal(soles.length, 4, 'both real rubber rails contribute their two downward triangles');
    assert.equal(new Set(soles.map(face => face.id)).size, soles.length, 'instance triangles have distinct diagnostics');
    assert.ok(soles.some(face => face.id.includes('instance 0')) && soles.some(face => face.id.includes('instance 1')));
  }

  const config = AMMO_SUPPLY_CACHES.find(cache => cache.id === 'roof-east-reserve');
  const cache = Architecture.elements.get(`ammo-cache-${config.id}`).mesh;
  const feet = cache.getObjectByName('ammo-case-feet-and-seal');
  const original = new Matrix4(); feet.getMatrixAt(0, original);
  const sunken = original.clone(); sunken.elements[13] -= 0.024;
  feet.setMatrixAt(0, sunken);
  const region = { x1: config.position.x - config.width / 2, x2: config.position.x + config.width / 2,
    z1: config.position.z - config.depth / 2, z2: config.position.z + config.depth / 2 };
  assert.throws(() => qa.assertSurfacePatch('Foot embedded at the roof plane', region, config.floorY, 1,
    { [config.support]: config.width * config.depth }), /overlaps/,
  'supporting instancing must not skip a genuine coplanar supply-case face');
  feet.setMatrixAt(0, original);
  assert.match(qa.checkFinalizedArchitectureSurfaces(), /boot-finalized meshes/);
  assert.equal(JSON.stringify(state.surfaceOwnership), report, 'QA does not rewrite the boot surface report');
  assert.equal(JSON.stringify(supplies.snapshot()), inventory, 'QA does not alter the supply ledger');
});

test('QA instance faces compose parent transforms and honor counts, draw ranges, materials and visibility', () => {
  const geometry = new BoxGeometry(), materials = Array.from({ length: 6 }, () => new MeshBasicMaterial());
  const mesh = new InstancedMesh(geometry, materials, 3);
  mesh.name = 'fixture-slabs'; mesh.position.set(0.5, 0, 0.5);
  for (const [index, x] of [-0.5, 0.5, -0.5].entries()) {
    mesh.setMatrixAt(index, new Matrix4().makeScale(1, 0.2, 2).setPosition(x, 0.1, 0));
  }
  mesh.count = 2; // The allocated third instance is intentionally not drawn.
  const child = new Group(); child.position.set(0.5, 0, -1); child.add(mesh);
  const parent = new Group(); parent.position.set(10, 4, -6);
  parent.rotation.y = Math.PI / 2; parent.scale.set(2, 1, 1.5); parent.add(child);
  const bounds = new Box3().setFromObject(parent), owner = 'instanced-deck';
  const records = new Map([[owner, { id: owner, mesh: parent, bounds }]]), qa = readQaSurfaceChecks(records);
  const region = { x1: bounds.min.x, x2: bounds.max.x, z1: bounds.min.z, z2: bounds.max.z };
  qa.assertSurfacePatch('Transformed instance tops', region, 4.2, 1, { [owner]: 12 });
  qa.assertSurfacePatch('Transformed instance undersides', region, 4, -1, { [owner]: 12 });
  const faces = qa.visibleFloorFaces(region, 4.2);
  assert.equal(faces.length, 4);
  assert.equal(new Set(faces.map(face => face.id)).size, faces.length);

  mesh.geometry = geometry.toNonIndexed();
  const top = mesh.geometry.groups.find(group => mesh.geometry.attributes.normal.getY(group.start) > 0.99);
  mesh.geometry.setDrawRange(top.start, top.count);
  assert.equal(qa.visibleFloorFaces(region, 4.2).length, 4, 'nonindexed top triangles retain both instance transforms');
  assert.equal(qa.visibleFloorFaces(region, 4, -1).length, 0, 'draw range excludes the otherwise real underside');
  materials[top.materialIndex].visible = false;
  assert.equal(qa.visibleFloorFaces(region, 4.2).length, 0, 'invisible material groups are not drawn');
  materials[top.materialIndex].visible = true;
  materials[top.materialIndex].transparent = true; materials[top.materialIndex].opacity = 0;
  assert.equal(qa.visibleFloorFaces(region, 4.2).length, 0, 'fully transparent instances contribute no visible face');
  materials[top.materialIndex].opacity = 1;
  child.visible = false;
  assert.equal(qa.visibleFloorFaces(region, 4.2).length, 0, 'hidden descendants stay excluded');
  child.visible = true; parent.visible = false;
  assert.equal(qa.visibleFloorFaces(region, 4.2).length, 0, 'hidden registered ancestors stay excluded');
  parent.visible = true;
  mesh.count = 1;
  assert.equal(qa.visibleFloorFaces(region, 4.2).length, 2);
  assert.throws(() => qa.assertSurfacePatch('Missing instance', region, 4.2, 1, { [owner]: 12 }), /visible indexed area/);
  mesh.count = 3;
  assert.equal(qa.visibleFloorFaces(region, 4.2).length, 6);
  assert.throws(() => qa.assertSurfacePatch('Overlapping instances', region, 4.2, 1, { [owner]: 12 }), /overlaps/);
  mesh.count = 0;
  assert.equal(qa.visibleFloorFaces(region, 4.2).length, 0, 'zero rendered instances contribute no geometry');
});
