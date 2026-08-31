import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EnemyNavigationPlanner, createNavigationAgent, enemyPoolCapacity, enemyCampaignPoolCapacity, investigationMemorySeconds, MAX_INVESTIGATION_SECONDS, updateSightCache } from '../../src/game/enemy-navigation.js';
import { updateAwareness } from '../../src/game/combat-rules.js';
import { capsuleHasClearance } from '../../src/core/collision.js';
import { ROOF } from '../../src/world/layout.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from '../../src/game/mission-data.js';

const box = (x1, x2, y1, y2, z1, z2) => ({ min: { x: x1, y: y1, z: z1 }, max: { x: x2, y: y2, z: z2 } });
const point = (x, y, z) => ({ x, y, z });
const floor = (x1, x2, z1, z2, y = 0) => box(x1, x2, y - 0.3, y, z1, z2);

function plan(planner, start, goal, now = 0, agent = createNavigationAgent()) {
  assert.equal(planner.request(agent, start, goal, now), true);
  for (let step = 0; step < 300 && agent.pending; step++) {
    const expanded = planner.update(now + step / 30);
    assert.ok(expanded <= planner.expansionsPerSlice, `slice expanded ${expanded}`);
  }
  assert.equal(agent.pending, false, 'search must finish within its bounded total work');
  return agent;
}

function assertSafeRoute(planner, agent, start, goal) {
  assert.equal(agent.status, 'ready');
  assert.ok(agent.path.length > 0);
  let previous = start;
  for (const waypoint of agent.path) {
    assert.equal(planner.segmentClear(previous, waypoint, 0.35, 1.94), true, `unsafe segment ${JSON.stringify(previous)} → ${JSON.stringify(waypoint)}`);
    previous = waypoint;
  }
  assert.ok(Math.hypot(previous.x - goal.x, previous.z - goal.z) < 0.9, 'route reaches the observed goal');
}

function roofFixture(options = {}) {
  const r = ROOF, hole = r.lightwell, house = r.serviceHouse, y = r.floorY;
  const boxes = [
    floor(r.x1, r.x2, r.z1, hole.z1, y),
    floor(r.x1, r.x2, hole.z2, r.z2, y),
    floor(r.x1, hole.x1, hole.z1, hole.z2, y),
    floor(hole.x2, r.x2, hole.z1, hole.z2, y),
    box(house.x1, house.x2, y, y + house.height, house.z1, house.z2),
  ];
  const planner = new EnemyNavigationPlanner({ bounds: { x1: r.x1, x2: r.x2, z1: r.z1, z2: r.z2 }, ...options });
  planner.setGeometry(boxes, 1);
  return { planner, boxes };
}

function bakeryFixture(options = {}) {
  const b = DISTRICT.bakery, y = b.floorY, p = b.partition;
  const obstacle = ({ x, z, width, depth, height }) => box(x - width / 2, x + width / 2, y, y + height, z - depth / 2, z + depth / 2);
  const boxes = [
    floor(b.x1, b.x2, b.z1, b.z2, y),
    box(b.x1, p.doorX1, y, y + 3.5, p.z - 0.11, p.z + 0.11),
    box(p.doorX2, b.x2, y, y + 3.5, p.z - 0.11, p.z + 0.11),
    obstacle(b.counter), obstacle(b.prepTable), obstacle(b.oven),
  ];
  const planner = new EnemyNavigationPlanner({ bounds: b, ...options });
  planner.setGeometry(boxes, 1);
  return { planner, boxes };
}

function makeBody(start, height = 1.94) {
  return { position: new THREE.Vector3(start.x, start.y + 0.02, start.z), velocity: new THREE.Vector3(), radius: 0.35, height, onGround: true };
}

// Exercise the real authored stair builder, including overhead flights and
// balusters. Scene/material stand-ins create no renderer or AudioContext.
function actualStairFixture() {
  const colliders = [];
  const World = new THREE.Group(), material = new THREE.MeshBasicMaterial();
  const Colliders = {
    addBox(min, max) { const value = new THREE.Box3(min.clone(), max.clone()); colliders.push(value); return value; },
    addBoxBySize(x, y, z, sx, sy, sz) {
      return this.addBox(new THREE.Vector3(x - sx / 2, y - sy / 2, z - sz / 2), new THREE.Vector3(x + sx / 2, y + sy / 2, z + sz / 2));
    },
  };
  const addBox = (x, y, z, sx, sy, sz, mat, options = {}) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    mesh.position.set(x, y, z); World.add(mesh);
    if (options.collide !== false) mesh.userData.collider = Colliders.addBoxBySize(x, y, z, sx, sy, sz);
    return mesh;
  };
  const source = readFileSync(new URL('../../src/world/zones/stairwell.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export (?=function )/gm, '');
  assert.doesNotMatch(source, /^import\s/m, 'keep the stair fixture explicit if its imports change');
  const build = runInNewContext(`${source}\n;buildStairwell;`, {
    THREE, mergeGeometries, STAIRS, World, Colliders,
    MATS: new Proxy({}, { get: () => material }), _BG: { unitBox: new THREE.BoxGeometry(1, 1, 1) },
    Architecture: { register() {} }, Triggers: { add() {} },
    addBox, addDecor: (x, y, z, sx, sy, sz, mat) => addBox(x, y, z, sx, sy, sz, mat, { collide: false }),
    addSign: () => new THREE.Object3D(), pushDecor() {},
  });
  build();
  const planner = new EnemyNavigationPlanner({ bounds: { x1: -22, x2: -14, z1: -11, z2: 1 } });
  planner.setGeometry(colliders, 1);
  return { planner, colliders };
}

function moveTo(planner, body, goal, { agent = null, now = 0, steps = 1200 } = {}) {
  const dt = 1 / 120;
  for (let tick = 0; tick < steps; tick++) {
    const remaining = Math.hypot(goal.x - body.position.x, goal.z - body.position.z);
    if (remaining < 0.04 && Math.abs(body.position.y - goal.y) < 0.04 && body.onGround) return true;
    const waypoint = agent ? planner.waypoint(agent, body.position, goal, now + tick * dt) : goal;
    const target = waypoint ?? goal;
    const dx = target.x - body.position.x, dz = target.z - body.position.z;
    const length = Math.hypot(dx, dz);
    const speed = Math.min(2.34, length / dt);
    if (length > 0.04) {
      const probe = Math.min(0.55, length);
      assert.equal(planner.canStep(body.position, dx / length * probe, dz / length * probe, body.radius, body.height), true,
        `lookahead stopped on a valid riser at ${body.position.toArray()}`);
    }
    body.velocity.x = length > 0.001 ? dx / length * speed : 0;
    body.velocity.z = length > 0.001 ? dz / length * speed : 0;
    body.velocity.y = Math.max(-32, body.velocity.y - 22 * dt);
    planner.moveBody(body, dt);
    assert.ok(capsuleHasClearance(body.position, body.radius, body.height, planner.boxes, 1e-5),
      `movement penetrated a collider at ${body.position.toArray()}`);
  }
  return false;
}

test('rooftop route detours around the whole service house instead of local oscillation', () => {
  const { planner } = roofFixture();
  const start = point(-6, ROOF.floorY, -13), goal = point(10, ROOF.floorY, -13);
  assert.equal(planner.segmentClear(start, goal), false);
  const agent = plan(planner, start, goal);
  assertSafeRoute(planner, agent, start, goal);
  const house = ROOF.serviceHouse;
  assert.ok(agent.path.some(value => value.z < house.z1 - 0.35 || value.z > house.z2 + 0.35));
});

test('a rooftop lightwell is an obstacle even with no wall collider around its hole', () => {
  const { planner } = roofFixture();
  const start = point(-14, ROOF.floorY, -13), goal = point(-6, ROOF.floorY, -13);
  assert.equal(planner.segmentClear(start, goal), false);
  const agent = plan(planner, start, goal);
  assertSafeRoute(planner, agent, start, goal);
  const hole = ROOF.lightwell;
  assert.ok(agent.path.some(value => value.z < hole.z1 - 0.35 || value.z > hole.z2 + 0.35));
  assert.equal(Number.isFinite(planner.walkableFloor(-10, -12, ROOF.floorY)), false);
});

test('bakery prep-room pursuit crosses the authored partition opening and avoids furniture', () => {
  const { planner } = bakeryFixture();
  const start = point(-30, 0.08, 41), goal = point(-30, 0.08, 30);
  assert.equal(planner.segmentClear(start, goal), false);
  const agent = plan(planner, start, goal);
  assertSafeRoute(planner, agent, start, goal);
  const partition = DISTRICT.bakery.partition;
  let previous = start, crossed = false;
  for (const next of agent.path) {
    if ((previous.z - partition.z) * (next.z - partition.z) < 0) {
      const t = (partition.z - previous.z) / (next.z - previous.z);
      const x = previous.x + (next.x - previous.x) * t;
      assert.ok(x > partition.doorX1 + 0.35 && x < partition.doorX2 - 0.35, `partition crossed at x=${x}`);
      crossed = true;
    }
    previous = next;
  }
  assert.equal(crossed, true);
});

test('searches are incremental and share a fixed slice budget across queued NPCs', () => {
  const { planner } = roofFixture({ expansionsPerSlice: 7, maxSearchExpansions: 1000 });
  const agents = [createNavigationAgent(), createNavigationAgent(), createNavigationAgent()];
  for (let index = 0; index < agents.length; index++) planner.request(agents[index], point(-6, 14, -13 + index * 0.4), point(12, 14, -13), 0);
  assert.equal(planner.snapshot().searches, 0, 'enqueueing does not run an unbudgeted search');
  for (let step = 0; step < 300 && agents.some(agent => agent.pending); step++) {
    const now = step / 30;
    assert.ok(planner.update(now) <= 7);
    assert.equal(planner.update(now), 0, 'same slice cannot acquire another work budget');
  }
  assert.equal(agents.some(agent => agent.pending), false);
  assert.equal(planner.snapshot().searches, 3);
  assert.ok(planner.snapshot().peakSliceExpansions <= 7);
  assert.ok(agents.every(agent => agent.status === 'ready'));
});

test('a committed route and grid cells are reused without repeated searches', () => {
  const { planner } = roofFixture();
  const start = point(-6, 14, -13), goal = point(10, 14, -13);
  const agent = plan(planner, start, goal);
  const stats = planner.snapshot();
  for (let frame = 0; frame < 90; frame++) assert.ok(planner.waypoint(agent, start, goal, frame / 60));
  assert.equal(planner.snapshot().searches, stats.searches);
  assert.equal(planner.snapshot().cellChecks, stats.cellChecks);
  const pointPool = [...agent.pointPool];
  plan(planner, start, goal, 20, agent);
  assert.equal(planner.snapshot().cellChecks, stats.cellChecks);
  assert.equal(agent.pointPool[0], pointPool[0], 'waypoint objects are reused');
  assert.equal(agent.routeVersion, 2);
});

test('following waypoints at investigation speed does not cut the service-house corners', () => {
  const { planner } = roofFixture();
  const position = point(-6, 14, -13), goal = point(10, 14, -13);
  const agent = plan(planner, position, goal);
  let seconds = 0;
  for (let frame = 0; frame < 900; frame++) {
    seconds = frame / 60;
    const target = planner.waypoint(agent, position, goal, seconds);
    if (!target) break;
    const dx = target.x - position.x, dz = target.z - position.z;
    const length = Math.hypot(dx, dz);
    const step = Math.min(length, 2.34 / 60 * Math.min(1, length / 0.16));
    const sx = dx / length * step, sz = dz / length * step;
    assert.equal(planner.canStep(position, sx, sz, 0.35, 1.94), true, `corner clipped at ${JSON.stringify(position)}`);
    position.x += sx; position.z += sz;
  }
  assert.ok(Math.hypot(position.x - goal.x, position.z - goal.z) < 0.3, 'NPC reaches the remembered position');
  assert.ok(seconds < 12, `detour took ${seconds}s`);
  assert.equal(agent.routeVersion, 1, 'following a good route does not replan it');
});

test('geometry revision invalidates routes and cached cells when a passage closes', () => {
  const { planner, boxes } = bakeryFixture();
  const start = point(-19.5, 0.08, 39), goal = point(-19.5, 0.08, 31);
  const agent = plan(planner, start, goal);
  assertSafeRoute(planner, agent, start, goal);
  assert.equal(planner.setGeometry(boxes, 1), false);
  const p = DISTRICT.bakery.partition;
  boxes.push(box(p.doorX1, p.doorX2, 0.08, 3.5, p.z - 0.11, p.z + 0.11));
  assert.equal(planner.setGeometry(boxes, 2), true);
  assert.equal(planner.waypoint(agent, start, goal, 20), null);
  plan(planner, start, goal, 20, agent);
  assert.equal(agent.status, 'unreachable');
  assert.equal(agent.path.length, 0);
});

test('navigation never bridges an unsupported gap or another storey', () => {
  const planner = new EnemyNavigationPlanner({ bounds: { x1: -6, x2: 6, z1: -4, z2: 4 } });
  planner.setGeometry([floor(-6, -1, -4, 4), floor(1, 6, -4, 4), floor(-6, 6, -4, 4, 4)], 1);
  const lower = plan(planner, point(-3, 0, 0), point(3, 0, 0));
  assert.equal(lower.status, 'unreachable');
  const upper = plan(planner, point(-3, 4, 0), point(3, 4, 0), 20);
  assertSafeRoute(planner, upper, point(-3, 4, 0), point(3, 4, 0));
  assert.equal(planner.snapshot().layers, 2);
});

test('short probes reject a radius crossing a floor edge, not only an unsupported center', () => {
  const planner = new EnemyNavigationPlanner({ bounds: { x1: -5, x2: 5, z1: -5, z2: 5 } });
  planner.setGeometry([floor(-2, 2, -2, 2)], 1);
  assert.equal(planner.canStep(point(1.5, 0, 0), 0.1, 0, 0.35, 1.94), true);
  assert.equal(planner.canStep(point(1.5, 0, 0), 0.3, 0, 0.35, 1.94), false);
  assert.equal(planner.canStep(point(1.5, 0, 0), 0, 0.4, 0.35, 1.94), true);
});

test('a nine-centimetre road/apron curb permits probes, A*, and actual capsule motion', () => {
  const planner = new EnemyNavigationPlanner({ bounds: { x1: -5, x2: 5, z1: -4, z2: 4 } });
  planner.setGeometry([floor(-5, 5, -4, 4, 0.05), box(0, 5, 0.05, 0.14, -4, 4)], 1);
  const start = point(-1, 0.05, 0), goal = point(1, 0.14, 0);
  assert.equal(planner.canStep(point(-0.23, 0.05, 0), 0.03, 0, 0.35, 1.82), true);
  assert.equal(planner.segmentClear(start, goal, 0.35, 1.82), true);
  const agent = plan(planner, start, goal);
  assertSafeRoute(planner, agent, start, goal);
  const body = makeBody(start, 1.82);
  assert.ok(moveTo(planner, body, goal));
  assert.ok(body.position.x > 0.9 && Math.abs(body.position.y - 0.14) < 0.03);
  assert.ok(moveTo(planner, body, start), 'NPC can also step down the curb');
});

test('each real fourteen-riser flight supports tall NPC probes, planned elevation changes, ascent and descent', () => {
  const { planner } = actualStairFixture();
  assert.equal(planner.canStep(point(-19.4, 4, -7.55), 0, 0.55, 0.35, 1.82), true);
  assert.equal(planner.canStep(point(-19.4, 4, -7.45), 0, 0.06, 0.35, 1.82), true);
  for (let index = 0; index < STAIRS.flights.length; index++) {
    const flight = STAIRS.flights[index], direction = Math.sign(flight.zEnd - flight.zStart);
    assert.equal(flight.treads.length, 14);
    const start = point(flight.x, flight.fromY, flight.zStart - direction * 0.5);
    const goal = point(flight.x, flight.toY, flight.zEnd + direction * 1);
    assert.equal(planner.segmentClear(start, goal, 0.35, 1.94), true, flight.id);
    const agent = plan(planner, start, goal, index * 30);
    assertSafeRoute(planner, agent, start, goal);
    assert.equal(agent.floorMin, flight.fromY);
    assert.equal(agent.floorMax, flight.toY);
    const body = makeBody(start);
    assert.ok(moveTo(planner, body, goal, { agent, now: index * 30 }), `${flight.id}: stopped before its top landing`);
    assert.ok(body.position.y >= flight.toY - 0.03, `${flight.id}: did not climb all fourteen risers`);
    assert.equal(planner.segmentClear(goal, start, 0.35, 1.94), true);
    assert.ok(moveTo(planner, body, start), `${flight.id}: stopped during descent`);
  }
});

test('step-aware clearance still rejects a single tall face and insufficient raised headroom', () => {
  const planner = new EnemyNavigationPlanner({ bounds: { x1: -5, x2: 5, z1: -3, z2: 3 } });
  const start = point(-1, 0, 0), end = point(1, 0.5, 0);
  planner.setGeometry([floor(-5, 5, -3, 3), box(0, 5, 0, 0.5, -3, 3)], 1);
  assert.equal(planner.segmentClear(start, end, 0.35, 1.94), false);
  assert.equal(planner.canStep(point(-0.4, 0, 0), 0.5, 0, 0.35, 1.94), false);
  const body = makeBody(start);
  for (let step = 0; step < 180; step++) {
    body.velocity.set(2.34, body.velocity.y - 22 / 120, 0); planner.moveBody(body, 1 / 120);
  }
  assert.ok(body.position.x < 0 && body.position.y < 0.05, 'a wall does not become a step');
  planner.setGeometry([floor(-5, 5, -3, 3), box(0, 5, 0, 0.2, -3, 3), box(-0.7, 3, 2, 2.2, -1, 1)], 2);
  assert.equal(planner.segmentClear(start, point(1, 0.2, 0), 0.35, 1.94), false, 'headroom is checked after lifting the whole capsule');
});

test('thin walls and low ceilings cannot be crossed between walkable grid samples', () => {
  const planner = new EnemyNavigationPlanner({ bounds: { x1: -5, x2: 5, z1: -5, z2: 5 } });
  planner.setGeometry([floor(-5, 5, -5, 5), box(-0.03, 0.03, 0, 3, -5, 5)], 1);
  assert.equal(planner.segmentClear(point(-2, 0, 0), point(2, 0, 0)), false);
  const route = plan(planner, point(-2, 0, 0), point(2, 0, 0));
  assert.equal(route.status, 'unreachable');
  planner.setGeometry([floor(-5, 5, -5, 5), box(-1, 1, 1.5, 2, -1, 1)], 2);
  assert.equal(Number.isFinite(planner.walkableFloor(0, 0, 0)), false);
});

test('a pending request owns a copy of the observed goal rather than a live player reference', () => {
  const { planner } = roofFixture();
  const observed = point(10, 14, -13), agent = createNavigationAgent();
  planner.request(agent, point(-6, 14, -13), observed, 0);
  observed.x = 20; observed.z = -22;
  assert.deepEqual(agent.goal, point(10, 14, -13));
  assert.equal(planner.request(agent, point(-6, 14, -13), observed, 0.2), false);
  planner.cancel(agent);
  assert.equal(planner.snapshot().pending, 0);
  assert.equal(agent.path.length, 0);
});

test('a cached visible result cannot capture a new hidden position or floor height', () => {
  const observer = {
    losTimer: -1, losSampleTime: -Infinity, losCached: false,
    losObservedPosition: point(0, 0, 0), losObservedFootY: 0,
    lastSeenPlayer: false, lastSeenPosition: point(0, 0, 0), timeSinceSeen: Infinity,
  };
  const target = point(0, 5.72, 2);
  let visibleNow = true, probes = 0;
  const probe = () => { probes++; return visibleNow; };
  let visible = updateSightCache(observer, target, 4, 0, probe);
  updateAwareness(observer, observer.losObservedPosition, visible, 1 / 60);
  target.x = 3; target.y = 9.72; visibleNow = false;
  visible = updateSightCache(observer, target, 8, 0.08, probe);
  updateAwareness(observer, observer.losObservedPosition, visible, 1 / 60);
  assert.equal(visible, true, 'the boolean remains cached until the next sample');
  assert.equal(probes, 1);
  assert.deepEqual(observer.lastSeenPosition, point(0, 5.72, 2), 'hidden live coordinates never become an observation');
  assert.equal(observer.losObservedFootY, 4);
  visible = updateSightCache(observer, target, 8, 0.17, probe);
  assert.equal(visible, false);
  assert.equal(updateAwareness(observer, observer.losObservedPosition, visible, 1 / 60), 'investigate');
  assert.equal(probes, 2);
  const age = observer.timeSinceSeen;
  updateSightCache(observer, target, 8, 0.17, probe);
  updateAwareness(observer, observer.losObservedPosition, false, 0);
  assert.equal(probes, 2, 'a paused clock does not run another visibility probe');
  assert.equal(observer.timeSinceSeen, age);
  visibleNow = true;
  visible = updateSightCache(observer, target, 8, 0.34, probe);
  updateAwareness(observer, observer.losObservedPosition, visible, 1 / 60);
  assert.deepEqual(observer.lastSeenPosition, target, 'only a successful fresh observation updates the position');
  assert.equal(observer.losObservedFootY, 8);
});

test('route investigation grants travel time to an unchanged observation with a constant ceiling', () => {
  const { planner } = roofFixture();
  const start = point(-6, 14, -13), observed = point(10, 14, -13);
  const agent = plan(planner, start, observed);
  const seconds = investigationMemorySeconds(agent, observed, 3.6, planner.generation);
  assert.ok(seconds > 4);
  assert.ok(seconds <= MAX_INVESTIGATION_SECONDS);
  assert.equal(MAX_INVESTIGATION_SECONDS, 12);
  assert.equal(investigationMemorySeconds(agent, point(20, 14, -20), 3.6, planner.generation), 4, 'new hidden coordinates cannot extend memory');
  assert.equal(investigationMemorySeconds(agent, observed, 3.6, planner.generation + 1), 4, 'invalid geometry cannot extend memory');
  agent.routeLength = 10000;
  assert.equal(investigationMemorySeconds(agent, observed, 0.1, planner.generation), 12);
});

test('paused investigation does not advance time or replace the observed target', () => {
  const { planner } = roofFixture();
  const observed = point(10, 14, -13), hidden = point(20, 14, -20);
  const agent = plan(planner, point(-6, 14, -13), observed);
  const memory = { lastSeenPlayer: true, lastSeenPosition: { ...observed }, timeSinceSeen: 5 };
  const seconds = investigationMemorySeconds(agent, observed, 3.6, planner.generation);
  for (let frame = 0; frame < 100; frame++) assert.equal(updateAwareness(memory, hidden, false, 0, seconds), 'investigate');
  assert.equal(memory.timeSinceSeen, 5);
  assert.deepEqual(memory.lastSeenPosition, observed);
  updateAwareness(memory, hidden, false, 12, seconds);
  assert.equal(memory.lastSeenPlayer, false);
});

test('replanning cannot reset the memory clock and cancellation clears pooled navigation state', () => {
  const { planner } = roofFixture();
  const start = point(-6, 14, -13), observed = point(10, 14, -13);
  const agent = plan(planner, start, observed);
  const memory = { lastSeenPlayer: true, lastSeenPosition: { ...observed }, timeSinceSeen: 11.9 };
  plan(planner, start, observed, 20, agent);
  const seconds = investigationMemorySeconds(agent, observed, 3.6, planner.generation);
  assert.equal(updateAwareness(memory, point(20, 14, -20), false, 0.2, seconds), 'idle');
  assert.ok(memory.timeSinceSeen >= 12);
  planner.request(agent, start, observed, 30);
  planner.cancel(agent);
  assert.equal(agent.pending, false);
  assert.equal(agent.path.length, 0);
  assert.equal(agent.routeLength, 0);
  assert.equal(agent.generation, -1);
  assert.equal(agent.nextRequestAt, 0);
  assert.equal(investigationMemorySeconds(agent, observed, 3.6), 4);
  assert.equal(planner.snapshot().pending, 0);
});

test('search total work is capped and retries are rate limited when no route is found', () => {
  const { planner } = roofFixture({ maxSearchExpansions: 3, expansionsPerSlice: 2 });
  const start = point(-6, 14, -13), goal = point(10, 14, -13);
  const agent = plan(planner, start, goal);
  assert.equal(agent.status, 'unreachable');
  assert.equal(planner.snapshot().expansions, 3);
  assert.equal(planner.request(agent, start, goal, 0.3), false);
  assert.equal(planner.request(agent, start, goal, 1), true);
});

test('an explicit simulation clock rewind immediately restores navigation work and retry timers', () => {
  const { planner } = roofFixture({ expansionsPerSlice: 4 });
  const start = point(-6, 14, -13), goal = point(10, 14, -13), agent = createNavigationAgent();
  planner.request(agent, start, goal, 180);
  assert.ok(planner.update(180) > 0);
  assert.ok(planner.nextSliceAt > 180);
  assert.ok(planner.update(0) > 0, 'pending work resumes at the new clock origin');
  planner.cancel(agent);
  plan(planner, start, goal, 1, agent);
  planner.waypoint(agent, start, goal, 181);
  assert.ok(planner.waypoint(agent, start, goal, 0));
  assert.ok(agent.nextShortcutAt < 1);
  assert.equal(planner.request(agent, start, goal, 0), true, 'old retry timers do not block a rewound session');
});

test('pool sizes cover overlapping waves, expanded finales, and archetype caps', () => {
  const configs = [
    { maxAlive: 5, waves: [['thug', 'thug'], ['thug', 'thug'], ['thug', 'thug']] },
    { maxAlive: 7, waves: [['hitman'], ['hitman'], ['hitman'], ['hitman'], ['hitman'], ['hitman'], ['hitman']] },
    { maxAlive: 5, typeCaps: { enforcer: 1 }, waves: [['enforcer'], ['enforcer'], ['enforcer']] },
  ];
  assert.equal(enemyPoolCapacity('thug', configs), 7);
  assert.equal(enemyPoolCapacity('hitman', configs), 9, 'waves beyond the sixth are included');
  assert.equal(enemyPoolCapacity('enforcer', configs), 3);
  assert.equal(enemyPoolCapacity('unused', configs), 2);
});

test('campaign pools sum checkpoint survivors but reserve only one finale and one corpse allowance', () => {
  const encounters = [
    { maxAlive: 2, waves: [['thug', 'thug', 'thug'], ['enforcer']] },
    { maxAlive: 3, typeCaps: { enforcer: 1 }, waves: [['thug', 'enforcer', 'enforcer']] },
  ];
  const finales = [
    { maxAlive: 3, waves: [['thug', 'thug']] },
    { maxAlive: 5, typeCaps: { enforcer: 1 }, waves: [['thug', 'thug'], ['thug', 'thug', 'enforcer', 'enforcer']] },
  ];
  assert.equal(enemyCampaignPoolCapacity('thug', encounters, finales), 9, 'three survivors coexist with four finale contacts and two corpses');
  assert.equal(enemyCampaignPoolCapacity('thug', encounters, finales, 0), 7);
  assert.equal(enemyCampaignPoolCapacity('enforcer', encounters, finales), 5, 'each checkpoint keeps its own archetype cap');
  assert.equal(enemyCampaignPoolCapacity('unused', encounters, finales), 2);
});

test('pressure encounters reserve melee rigs for surviving downgraded armed contacts', () => {
  const pressure = { maxAlive: 2, rearPressure: {}, waves: [['gunman', 'brawler'], ['hitman', 'thug']] };
  assert.equal(enemyPoolCapacity('brawler', [pressure], 0), 2);
  assert.equal(enemyPoolCapacity('thug', [pressure], 0), 2);
  assert.equal(enemyPoolCapacity('gunman', [pressure], 0), 1);
  assert.equal(enemyPoolCapacity('bruiser', [pressure], 0), 0);
  assert.equal(enemyPoolCapacity('brawler', [{ ...pressure, rearPressure: null }], 0), 1);
});

test('every authored zone and final encounter fits its derived live pool capacity', () => {
  const configs = [...Object.values(ZONE_WAVE_CONFIG), ...Object.values(FINAL_ENCOUNTERS)];
  const types = new Set(configs.flatMap(config => config.waves.flat()));
  for (const type of types) {
    const capacity = enemyPoolCapacity(type, configs);
    for (const config of configs) {
      const total = config.waves.flat().filter(value => value === type).length;
      const concurrent = Math.min(config.maxAlive, config.typeCaps?.[type] ?? Infinity, total);
      assert.ok(capacity >= concurrent + 2, `${type}: capacity ${capacity} is below ${concurrent} live plus two corpses`);
    }
  }
});
