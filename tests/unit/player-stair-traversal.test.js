import test from 'node:test';
import assert from 'node:assert/strict';
import { STAIRS } from '../../src/world/stair-layout.js';
import { buildPlayerMovementWorld, createPlayerMovementHarness } from './helpers/player-movement-harness.js';

const world = buildPlayerMovementWorld();
const profiles = [
  { name: 'walk' }, { name: 'sprint', sprint: true }, { name: 'crouch', crouch: true },
  { name: 'aim', aim: true }, { name: 'quarter analog', magnitude: 0.25 },
  { name: 'aim while crouched', aim: true, crouch: true },
  { name: 'slow analog', magnitude: 0.20 },
  { name: 'diagonal keyboard', scheme: 'diagonal' },
  { name: 'strafe keyboard', scheme: 'strafe' },
  { name: 'backward keyboard', scheme: 'backward' },
];
const completeRoute = [...STAIRS.route, STAIRS.roofExit];
const rates = [1 / 120, 1 / 60, 1 / 30];

// The controller cannot pass because a stand-in omitted a troublesome flight
// or a newer prop. Its collision list comes from all eight real builders.
for (const flight of STAIRS.flights) {
  const waist = world.records.get(flight.id + '-waist');
  const colliders = waist?.mesh.userData.colliders;
  assert.equal(colliders?.length, 14, 'The actual merged stair waist retains all 14 physical treads');
  for (const [index, tread] of flight.treads.entries()) {
    const collider = colliders[index];
    assert.ok(world.colliders.includes(collider), 'Actual tread is present: ' + tread.id);
    assert.ok(Math.abs(collider.max.y - tread.topY) < 1e-9, 'Actual tread elevation matches the shared route');
  }
}
assert.equal(world.supplies.list.length, 3, 'All three physical ammo boxes are in the movement fixture');
assert.ok(world.supplies.list.every(entry => world.colliders.includes(entry.collider)));

function assertContinuousAscent(h, label) {
  const airborne = h.trace.filter(frame => !frame.onGround);
  const upward = h.trace.filter(frame => frame.velocity[1] > 1e-6);
  const dips = h.trace.filter((frame, index) => index && frame.position[1] < h.trace[index - 1].position[1] - 0.003);
  assert.equal(h.audio.some(event => event.action === 'jump'), false, 'No jump event is emitted');
  assert.equal(airborne.length, 0, label + ' loses support while climbing: ' + JSON.stringify(airborne.slice(0, 3)));
  assert.equal(upward.length, 0, label + ' converts horizontal motion into an uncommanded upward velocity: '
    + JSON.stringify(upward.slice(0, 3)));
  assert.equal(dips.length, 0, label + ' falls back after an automatic step: ' + JSON.stringify(dips.slice(0, 3)));
}

function assertActualStance(h, profile) {
  assert.equal(h.Player.isCrouching, Boolean(profile.crouch));
  assert.equal(h.Player.aiming, Boolean(profile.aim));
  assert.equal(h.Player.isSprinting, Boolean(profile.sprint));
  assert.ok(Math.abs(h.Player._bodyH - (profile.crouch ? h.Player.crouchBody : h.Player.bodyHeight)) < 0.001);
}

// The full path includes the entry below flight 2, both directions across each
// turning platform, all 56 risers, and the flush threshold onto the rooftop.
for (const profile of profiles) for (const dt of rates) {
  test(`actual player ascends the complete stair route without jumping: ${profile.name} at ${Math.round(1 / dt)} Hz`, () => {
    const h = createPlayerMovementHarness(world, { dt });
    h.spawn(completeRoute[0], { initialProfile: profile });
    for (const [index, target] of completeRoute.slice(1).entries()) {
      h.driveTo(target, profile, { label: profile.name + ' full ascent waypoint ' + (index + 1) });
    }
    assertContinuousAscent(h, profile.name);
    assert.ok(Math.abs(h.feet().y - STAIRS.exitY) < 0.065);
    assertActualStance(h, profile);
  });
}

function advanceAlongFlight(h, flight, targetZ, profile, label) {
  const direction = Math.sign(flight.zEnd - flight.zStart);
  const remaining = Math.max(0, (targetZ - h.Player.pos.z) * direction);
  const speed = h.Player.speedWalk * (profile.magnitude ?? 1);
  const frameLimit = Math.ceil((remaining / speed * 1.8 + 1) / h.dt);
  h.setMovement(profile); h.lookAlong(0, direction);
  for (let frame = 0; frame < frameLimit; frame++) {
    if ((h.Player.pos.z - targetZ) * direction >= 0) return;
    const beforeZ = h.Player.pos.z;
    h.tick();
    assert.ok((h.Player.pos.z - beforeZ) * direction >= -0.003,
      'Forward input cannot repeatedly push the player away from the riser: ' + JSON.stringify(h.diagnostic(null, label)));
  }
  assert.fail('Real input stalled at a riser: ' + JSON.stringify(h.diagnostic([flight.x, null, targetZ], label)));
}

for (const flight of STAIRS.flights) for (const offset of [-0.70, 0, 0.70]) {
  test(`actual player stops and resumes on all 14 treads: ${flight.id}, lateral offset ${offset} m`, () => {
    const h = createPlayerMovementHarness(world);
    const direction = Math.sign(flight.zEnd - flight.zStart);
    const profile = { name: 'slow analog with complete key releases', magnitude: 0.20 };
    h.spawn([flight.x + offset, flight.fromY, flight.zStart - direction * 0.5], { initialProfile: profile });
    let stops = 0;
    for (const tread of flight.treads) {
      // The capsule can bear on a tread while its center is beside its edge.
      // Stop by horizontal progress, not an artificially assigned tread Y.
      advanceAlongFlight(h, flight, (tread.z1 + tread.z2) / 2, profile, tread.id);
      h.stop(0.25); // Let actual acceleration brake before measuring rest drift.
      const index = h.trace.length;
      h.stop(0.75);
      const resting = h.trace.slice(index);
      const heights = resting.map(frame => frame.position[1]);
      assert.ok(Math.max(...heights) - Math.min(...heights) <= 0.003, 'Stationary feet stay on their bearing tread: ' + tread.id);
      assert.ok(Math.abs(resting.at(-1).position[2] - resting[0].position[2]) <= 0.002,
        'A released stick must settle instead of sliding down the flight: ' + tread.id);
      assert.ok(Math.abs(h.Player.pos.x - flight.x - offset) < 0.001, 'The selected usable lane offset is preserved');
      stops++;
    }
    h.driveTo([flight.x + offset, flight.toY, flight.zEnd + direction * 0.65], profile);
    assert.equal(stops, 14, 'Each riser receives a real stop and a subsequent real restart');
    assertContinuousAscent(h, flight.id + ' offset ' + offset);
    assert.ok(Math.abs(h.feet().y - flight.toY) < 0.003, 'The flight ends on its actual top landing');
  });
}

for (const magnitude of [0.02, 0.03]) for (const flight of STAIRS.flights) {
  test(`accepted fine analog ${magnitude} climbs a real first riser from rest: ${flight.id}`, () => {
    const h = createPlayerMovementHarness(world);
    const direction = Math.sign(flight.zEnd - flight.zStart);
    const profile = { name: 'fine analog after the real input dead zone', magnitude };
    h.spawn([flight.x, flight.fromY, flight.zStart - direction * 0.31], { initialProfile: profile });
    h.setMovement(profile);
    assert.ok(Math.abs(h.Input.consumeFrame(h.dt).moveY - magnitude) < 1e-12,
      'The real gamepad dead zone accepts this input; the player must not apply a second movement threshold');
    advanceAlongFlight(h, flight, flight.zStart + direction * 0.1, profile, flight.id + ' fine input');
    h.stop(0.5);
    assert.ok(h.feet().y >= flight.treads[0].topY - 0.003, 'The actual first riser was climbed without jump input');
    assertContinuousAscent(h, flight.id + ' analog ' + magnitude);
  });
}

for (const profile of [profiles[0], profiles[1], profiles[6]]) for (const dt of [rates[0], rates[2]]) {
  test(`actual player descends all flights and turns without jumping: ${profile.name} at ${Math.round(1 / dt)} Hz`, () => {
    const h = createPlayerMovementHarness(world, { dt });
    const descent = [...completeRoute].reverse();
    h.spawn(descent[0], { initialProfile: profile });
    for (const [index, target] of descent.slice(1).entries()) {
      h.driveTo(target, profile, { label: profile.name + ' full descent waypoint ' + (index + 1) });
    }
    h.stop(0.5);
    assert.equal(h.audio.some(event => event.action === 'jump'), false);
    assert.equal(h.Player.onGround, true);
    assert.ok(Math.abs(h.feet().y - STAIRS.entryY) < 0.003);
    // Brief downward falls between descending treads are valid. The capsule
    // clearance oracle runs every tick; this checks the resulting elevation.
    assert.ok(h.trace.every(frame => frame.position[1] >= STAIRS.entryY - 0.003
      && frame.position[1] <= STAIRS.exitY + 0.003), 'Descending never crosses through a floor or launches above the roof');
  });
}
