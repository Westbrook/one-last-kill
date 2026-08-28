import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { BUILDING, OPENINGS } from '../../src/world/layout.js';
import { Architecture, boxBounds, signYaw } from '../../src/world/architecture.js';
import { Colliders, capsuleHasClearance, moveCapsule, resolveCapsuleAABB } from '../../src/core/collision.js';

const near = (actual, expected, label, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${label}: expected ${expected}, got ${actual}`);

// Build the actual stair module with real Three.js geometry and collision.
// Only canvas-facing material/scene services are injected; no renderer, browser
// or AudioContext is created by these geometry and movement regressions.
function buildFixture() {
  Architecture.clear();
  Colliders.clear();
  const World = new THREE.Group();
  const materials = new Map();
  const MATS = new Proxy({}, { get(_, key) {
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial());
    return materials.get(key);
  } });
  const _BG = { unitBox: new THREE.BoxGeometry(1, 1, 1) };
  function addBox(x, y, z, sx, sy, sz, material, options = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    mesh.position.set(x, y, z);
    World.add(mesh);
    const collider = options.collide === false ? null : Colliders.addBoxBySize(x, y, z, sx, sy, sz);
    mesh.userData.collider = collider;
    if (options.architecture) Architecture.register(mesh, collider, boxBounds(x, y, z, sx, sy, sz), options.architecture);
    return mesh;
  }
  function pushDecor(geometry, material, x, y, z, sx, sy, sz) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
    World.add(mesh);
  }
  function addSign(x, y, z, width, height, normal) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), MATS.metal);
    mesh.position.set(x, y, z); mesh.rotation.y = signYaw(normal);
    World.add(mesh);
    return mesh;
  }
  const source = readFileSync(new URL('../../src/world/zones/stairwell.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export (?=function )/gm, '');
  assert.doesNotMatch(source, /^import\s/m, 'Update the explicit test harness if builder imports become multiline');
  const build = runInNewContext(`${source}\n;buildStairwell;`, {
    THREE, mergeGeometries, MATS, _BG, pushDecor, Colliders, Architecture, STAIRS, World, addBox, addSign,
    Triggers: { add() {} },
    addDecor: (x, y, z, sx, sy, sz, material) => addBox(x, y, z, sx, sy, sz, material, { collide: false }),
  });
  build();
  // This is the receiving edge of the existing roof, outside this builder's
  // ownership. Its envelope is shared with the real roof module.
  addBox(BUILDING.main.x1 + 0.5, BUILDING.roofY - 0.1, -8.75, 1, 0.2, 2, MATS.concrete);
  addBox(-18, STAIRS.entryY - 0.1, 0.45, 2, 0.2, 0.9, MATS.concrete);
  World.updateMatrixWorld(true);
  return { World, records: new Map(Architecture.elements), colliders: [...Colliders.list] };
}

const fixture = buildFixture();
// Run the exact production probe without evaluating enemies.js's browser
// imports. These are the same conservative dimensions passed by the director,
// not the smaller dimensions of whichever enemy rig happens to spawn next.
const enemySource = readFileSync(new URL('../../src/game/enemies.js', import.meta.url), 'utf8');
const probeSource = enemySource.match(/function isBlocked\([^]*?\n\}/)?.[0];
assert.ok(probeSource, 'The production spawn-clearance probe must remain testable');
const directorBlocked = runInNewContext(`${probeSource}\n;isBlocked;`, {
  Colliders: { list: fixture.colliders }, resolveCapsuleAABB,
  _ibBottom: new THREE.Vector3(), _ibTop: new THREE.Vector3(),
});
const DIRECTOR_RADIUS = 0.48, DIRECTOR_HEIGHT = 2.02, DIRECTOR_FOOT_CLEARANCE = 0.03;
const makeBody = (point, radius = 0.32, height = 1.84) => ({
  position: new THREE.Vector3(point[0], point[1] + 0.02, point[2]),
  velocity: new THREE.Vector3(), radius, height, onGround: true,
});

function walkRoute(body, targets, speed = 4.2) {
  const dt = 1 / 120;
  for (const [x, y, z] of targets) {
    const distanceAtStart = Math.hypot(x - body.position.x, z - body.position.z);
    const limit = Math.ceil(distanceAtStart / speed / dt) + 600;
    let reached = false;
    for (let tick = 0; tick < limit; tick++) {
      const dx = x - body.position.x, dz = z - body.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.035 && Math.abs(body.position.y - y) < 0.06 && body.onGround) { reached = true; break; }
      const rate = Math.min(speed, distance / dt);
      body.velocity.x = distance > 0.001 ? dx / distance * rate : 0;
      body.velocity.z = distance > 0.001 ? dz / distance * rate : 0;
      body.velocity.y = Math.max(-32, body.velocity.y - 22 * dt);
      moveCapsule(body, dt, fixture.colliders, true);
    }
    assert.ok(reached, `stuck at ${body.position.toArray()}, expected ${[x, y, z]}`);
    assert.ok(capsuleHasClearance(body.position, body.radius, body.height, fixture.colliders, 1e-5));
  }
}

test('stair descriptors preserve the tower, doors and campaign elevations', () => {
  assert.equal(STAIRS.footprint, BUILDING.tower);
  assert.equal(STAIRS.entryDoor, OPENINGS.balconyStair);
  assert.equal(STAIRS.roofDoor, OPENINGS.stairRoof);
  assert.deepEqual(STAIRS.landings.map(landing => landing.y), [4, 6.4, 9, 11.6, 14]);
  assert.deepEqual(STAIRS.flights.map(flight => flight.x), [-19.4, -16.6, -19.4, -16.6]);
  assert.ok(Object.isFrozen(STAIRS) && Object.isFrozen(STAIRS.flights[0].treads[0]));
  assert.throws(() => { STAIRS.flights[0].treads[0].topY = 100; }, TypeError);
});

test('each flight has fourteen consistent risers, usable treads and a shallow waist', () => {
  for (const flight of STAIRS.flights) {
    assert.equal(flight.steps, 14);
    assert.equal(flight.treads.length, 14);
    near(flight.run, 4.2, 'flight run');
    near(flight.treadDepth, 0.3, 'tread depth');
    assert.ok(flight.rise >= 0.17 && flight.rise <= 0.19);
    near(flight.fromY + flight.rise * flight.steps, flight.toY, 'top landing');
    for (const tread of flight.treads) {
      near(tread.topY - tread.bottomY, flight.rise + STAIRS.waistThickness, 'waist thickness');
      near(tread.z2 - tread.z1, flight.treadDepth, 'consistent going');
      assert.ok(tread.topY - tread.bottomY < 0.37, 'no floor-to-tread rectangular wall');
    }
  }
});

test('every intermediate platform provides a broad clear turn across both lanes', () => {
  for (const landing of STAIRS.landings.slice(1)) {
    near(landing.z2 - landing.z1, 2.8, `${landing.id} depth`);
    const rows = landing.side === 'south' ? [-2.4, -1.6, -0.55] : [-9.45, -8.55, -7.55];
    for (const x of [-20.15, -19.4, -18.7, -18, -17.3, -16.6, -15.85]) {
      for (const z of rows) {
        const foot = new THREE.Vector3(x, landing.y + 0.02, z);
        assert.ok(capsuleHasClearance(foot, 0.32, 1.84, fixture.colliders), `${landing.id} turn blocked at ${x}, ${z}`);
      }
    }
  }
});

test('the entry passage beneath flight two has standing headroom end to end', () => {
  for (const x of [-17.05, -16.6, -16.15]) {
    for (let z = -9.2; z <= -0.65; z += 0.15) {
      assert.ok(capsuleHasClearance(new THREE.Vector3(x, 4.02, z), 0.32, 2.05, fixture.colliders),
        `entry passage blocked at ${x}, ${z}`);
    }
  }
});

test('entry and roof thresholds retain standing clearance beneath real headers', () => {
  const body = makeBody([-18, STAIRS.entryY, 0.65]);
  walkRoute(body, [STAIRS.route[0]]);
  const entry = new THREE.Vector3(-18, STAIRS.entryY + 0.02, 0);
  assert.ok(capsuleHasClearance(entry, 0.32, 1.84, fixture.colliders));
  assert.equal(capsuleHasClearance(entry, 0.32, 2.05, fixture.colliders), false,
    'the header must remain solid above the standing opening');
  const roofZ = (STAIRS.roofDoor.min[2] + STAIRS.roofDoor.max[2]) / 2;
  assert.ok(capsuleHasClearance(new THREE.Vector3(-15.1, STAIRS.exitY + 0.02, roofZ), 0.32, 1.84, fixture.colliders));
  assert.equal(capsuleHasClearance(new THREE.Vector3(-15.1, STAIRS.exitY + 0.02, roofZ), 0.32, 2.05, fixture.colliders), false,
    'the raised roof must retain a physical lintel over the original doorway');
});

test('every stair anchor clears the exact director probe and its conservative standing bounds', () => {
  for (const landing of STAIRS.landings.slice(1)) {
    assert.equal(landing.spawnPoints.length, 2);
    for (const point of landing.spawnPoints) {
      const foot = new THREE.Vector3(point.x, point.y + DIRECTOR_FOOT_CLEARANCE, point.z);
      assert.equal(directorBlocked(foot, 0, 0, DIRECTOR_RADIUS, DIRECTOR_HEIGHT), false,
        `${landing.id} rejects the actual director probe at ${point.x}, ${point.z}`);
      assert.ok(capsuleHasClearance(foot, DIRECTOR_RADIUS, DIRECTOR_HEIGHT, fixture.colliders),
        `${landing.id} spawn intersects real geometry even without the probe's radius tolerance`);
      const standingBounds = new THREE.Box3(
        new THREE.Vector3(foot.x - DIRECTOR_RADIUS, foot.y, foot.z - DIRECTOR_RADIUS),
        new THREE.Vector3(foot.x + DIRECTOR_RADIUS, foot.y + DIRECTOR_HEIGHT, foot.z + DIRECTOR_RADIUS),
      );
      assert.ok(!fixture.colliders.some(collider => collider.intersectsBox(standingBounds)),
        `${landing.id} spawn's full standing bounds intersect the shell`);
    }
    const [a, b] = landing.spawnPoints;
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 2.8);
  }
});

test('top landing has at least 2.3 m of headroom and every shell edge reaches the roof cap', () => {
  const cap = fixture.records.get('stair-roof-cap');
  const topLanding = STAIRS.landings.at(-1);
  near(cap.bounds.max.y, BUILDING.towerRoofY, 'shared tower roof elevation');
  near(cap.bounds.max.y - cap.bounds.min.y, 0.2, 'roof slab thickness');
  assert.ok(cap.bounds.min.y - topLanding.y >= 2.3, 'standing NPC clearance must not depend on a shortened probe');
  const perimeter = ['stair-west-wall', 'stair-north-wall', 'stair-south-upper',
    'stair-east-upper-north', 'stair-east-upper-south', 'stair-roof-door-header'];
  for (const id of perimeter) {
    const wall = fixture.records.get(id);
    assert.ok(wall, `${id} exists`);
    near(wall.bounds.max.y, cap.bounds.min.y, `${id} reaches roof underside`);
    assert.ok(cap.supports.includes(id), `${id} is a declared roof support`);
    const overlapX = Math.min(wall.bounds.max.x, cap.bounds.max.x) - Math.max(wall.bounds.min.x, cap.bounds.min.x);
    const overlapZ = Math.min(wall.bounds.max.z, cap.bounds.max.z) - Math.max(wall.bounds.min.z, cap.bounds.min.z);
    assert.ok(overlapX > 0 && overlapZ > 0, `${id} actually contacts the cap footprint`);
  }
  const header = fixture.records.get('stair-roof-door-header');
  near(header.bounds.min.y, STAIRS.roofDoor.max[1], 'roof-door lintel underside');
  near(header.bounds.min.z, STAIRS.roofDoor.min[2], 'lintel north jamb');
  near(header.bounds.max.z, STAIRS.roofDoor.max[2], 'lintel south jamb');
  for (const id of header.supports) {
    assert.ok(header.bounds.clone().expandByScalar(1e-6).intersectsBox(fixture.records.get(id).bounds), `${id} supports the lintel`);
  }
});

test('walking and sprinting reach all four landings and the roof doorway', () => {
  for (const speed of [4.2, 7]) {
    const body = makeBody(STAIRS.route[0]);
    walkRoute(body, [...STAIRS.route.slice(1), STAIRS.roofExit], speed);
    near(body.position.y, STAIRS.exitY, 'roof exit floor', 0.03);
  }
});

test('the same route supports descent without jumping or teleporting', () => {
  const reversed = [...STAIRS.route].reverse();
  const body = makeBody(reversed[0]);
  walkRoute(body, reversed.slice(1));
  near(body.position.y, STAIRS.entryY, 'entry floor', 0.03);
});

test('central guards stop at flight limits and contain only visible slender members', () => {
  for (const flight of STAIRS.flights) {
    for (const suffix of ['central-guard', 'stringers', 'wall-handrail']) {
      const record = fixture.records.get(`${flight.id}-${suffix}`);
      assert.ok(record);
      assert.ok(record.bounds.min.z >= STAIRS.flightZ.north - 1e-5);
      assert.ok(record.bounds.max.z <= STAIRS.flightZ.south + 1e-5);
      assert.ok(record.mesh.userData.colliders.length > 0);
      if (suffix === 'central-guard') {
        for (const collider of record.mesh.userData.colliders) {
          assert.ok(collider.max.x - collider.min.x < 0.05);
          assert.ok(collider.max.z - collider.min.z < 0.34);
        }
      }
      if (suffix === 'stringers') {
        for (const collider of record.mesh.userData.colliders) assert.ok(collider.max.y - collider.min.y < 0.4);
      }
    }
  }
});

test('a capsule cannot pass sideways through the open central balusters', () => {
  const flight = STAIRS.flights[0];
  const tread = flight.treads[6];
  const body = makeBody([flight.x, tread.topY, (tread.z1 + tread.z2) / 2]);
  const dt = 1 / 120;
  for (let tick = 0; tick < 120; tick++) {
    body.velocity.x = 4.2;
    body.velocity.z = 0;
    body.velocity.y -= 22 * dt;
    moveCapsule(body, dt, fixture.colliders, true);
  }
  assert.ok(body.position.x < flight.guardX - 0.24, `guard failed at x=${body.position.x}`);
  assert.ok(capsuleHasClearance(body.position, body.radius, body.height, fixture.colliders, 1e-5));
});

test('waists, rails, ledgers and decks have visible bounds and connected supports', () => {
  const gap = (a, b) => Math.hypot(
    Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x),
    Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y),
    Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z),
  );
  for (const record of fixture.records.values()) {
    const actual = new THREE.Box3().setFromObject(record.mesh);
    assert.ok(actual.min.distanceTo(record.bounds.min) < 1e-5, `${record.id} visible minimum`);
    assert.ok(actual.max.distanceTo(record.bounds.max) < 1e-5, `${record.id} visible maximum`);
    for (const collider of record.mesh.userData.colliders ?? []) {
      assert.ok(record.bounds.clone().expandByScalar(1e-5).containsBox(collider), `${record.id} collider outside visible assembly`);
    }
    if (record.supportKind === 'ground') assert.ok(record.bounds.min.y <= 0.17);
    else assert.ok(record.supports.length > 0, `${record.id} has no support`);
    for (const supportId of record.supports) {
      const support = fixture.records.get(supportId);
      assert.ok(support, `${record.id} missing support ${supportId}`);
      assert.ok(gap(record.bounds, support.bounds) <= 0.031, `${record.id} detached from ${supportId}`);
    }
  }
});
