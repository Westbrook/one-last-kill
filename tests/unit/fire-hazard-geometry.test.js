import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { Colliders, capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { createFireHazards } from '../../src/game/fire-hazards.js';
import { CHECKPOINTS } from '../../src/game/mission-data.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';

const DT = 1 / 60;
const near = (actual, expected, label, epsilon = 1e-5) => assert.ok(Math.abs(actual - expected) < epsilon,
  `${label}: ${actual} differs from ${expected}`);
const source = readFileSync(new URL('../../src/world/world.js', import.meta.url), 'utf8');
function worldFunction(name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `Keep the fire fixture aligned with ${name}`);
  return source.slice(start, end + 2);
}

// Actual world builders call the production fire constructor and activation
// path. Only canvas-backed materials/smoke are replaced; authored flames,
// registered blockers, damage bounds and sources are all real construction.
const fixture = buildWorldSurfaceFixture({
  createFireServices(services) {
    return runInNewContext(`${worldFunction('spawnFire')}\n${worldFunction('setFireActive')}\n`
      + '({ spawnFire, setFireActive });', {
      ...services,
      makeFireMaterial: () => ({ mat: new THREE.MeshBasicMaterial(), phase: 0, _lastPaint: -Infinity }),
    });
  },
});
const fires = fixture.WorldState.fires;
const initialFires = [...fires];
const neighbor = fixture.triggers.find(trigger => trigger.name === 'neighbor');
neighbor.onEnter();
const breach = fires.find(fire => fire.group.name === 'neighbor-breach-fire');
const wreck = fires.find(fire => fire.group.name === 'street-wreck-engine-fire');
const apartment = initialFires.filter(fire => fire.collider);
neighbor.onReset();

function actorAt(foot, { crouch = false, sources = fires, colliders = Colliders.list } = {}) {
  const eye = crouch ? 1.10 : 1.72, height = crouch ? 1.22 : 1.84;
  const player = { pos: new THREE.Vector3(foot.x, foot.y + eye, foot.z), _eyeH: eye, _bodyH: height,
    radius: 0.32, health: 100 };
  const body = { position: new THREE.Vector3(foot.x, foot.y, foot.z), velocity: new THREE.Vector3(),
    radius: player.radius, height, onGround: true };
  const hazards = createFireHazards({ player, fires: sources, colliders,
    isColliderEnabled: box => Colliders.isEnabled(box), canDamage: () => player.health > 0,
    applyDamage(amount) { player.health = Math.max(0, player.health - amount); } });
  return { player, body, hazards };
}

function advance(actor, dx, dz) {
  const { body, player } = actor;
  body.velocity.x = dx; body.velocity.z = dz;
  body.velocity.y = Math.max(-32, body.velocity.y - 22 * DT);
  moveCapsule(body, DT, Colliders.list, true);
  player.pos.copy(body.position); player.pos.y += player._eyeH;
}

function walk(actor, targets, audit = () => {}) {
  for (const [x, y, z] of targets) {
    let reached = false;
    const maxTicks = Math.ceil(Math.hypot(x - actor.body.position.x, z - actor.body.position.z) / 4.2 / DT) + 300;
    for (let tick = 0; tick < maxTicks; tick++) {
      const dx = x - actor.body.position.x, dz = z - actor.body.position.z, distance = Math.hypot(dx, dz);
      if (distance < 0.03 && actor.body.onGround && Math.abs(actor.body.position.y - y) < 0.06) {
        reached = true; break;
      }
      const speed = Math.min(4.2, distance / DT);
      advance(actor, distance > 0.001 ? dx / distance * speed : 0, distance > 0.001 ? dz / distance * speed : 0);
      audit(actor);
    }
    assert.ok(reached, `The real capsule reaches ${x},${y},${z}; stopped at ${actor.body.position.toArray()}`);
  }
}

function push(actor, dx, dz) {
  for (let tick = 0; tick < 60; tick++) advance(actor, dx, dz);
  assert.ok(capsuleHasClearance(actor.body.position, actor.body.radius, actor.body.height, Colliders.list),
    'The collision solver leaves the complete player capsule outside solids');
}

function holdContact(actor) {
  const before = actor.player.health;
  for (let tick = 0; tick < 30; tick++) actor.hazards.update(DT);
  near(before - actor.player.health, 10, 'Half a second of real fire contact causes ten health damage');
}

test('every authored fire registers bounded contact geometry and a source inside its visible flames', () => {
  assert.equal(initialFires.length, 3, 'Two opening fires and the wreck exist at construction');
  assert.equal(fires.length, 4, 'The real neighbor callback adds its one cached fire');
  for (const fire of fires) {
    assert.ok(fire.damageBounds?.isBox3 && fire.damageSource?.isVector3);
    const flame = fire.group.children.find(child => child.isMesh);
    near(fire.damageSource.y, fire.group.position.y + flame.geometry.parameters.height / 2, 'Visible flame center');
    if (fire.collider) {
      assert.notEqual(fire.damageBounds, fire.collider, 'Damage geometry has independent ownership');
      assert.ok(fire.damageBounds.equals(fire.collider), 'Blocking flames hurt at their actual movement surface');
    } else {
      near(fire.damageBounds.max.y, fire.group.position.y + flame.geometry.parameters.height, 'Smoke does not enlarge heat height');
      near(fire.damageBounds.max.x - fire.damageBounds.min.x, flame.geometry.parameters.width, 'Unblocked heat follows flame width');
    }
  }
  assert.equal(wreck.collider, null, 'The hood fire keeps the actual vehicle as movement cover');
  assert.ok(wreck.damageSource.y > 2, 'The source clears the car body instead of starting inside its hood');
});

test('standing and crouching players take damage at the opening fire collision surface and stop after retreat', () => {
  for (const crouch of [false, true]) {
    const actor = actorAt(CHECKPOINTS.apartment, { crouch });
    walk(actor, [[-8.5, 4, -4], [-8.5, 4, -3]]);
    push(actor, 0, 4.2);
    near(actor.body.position.z, -2.07, 'Actual apartment fire tangency');
    holdContact(actor);
    walk(actor, [[-8.5, 4, -2.5]]);
    const before = actor.player.health;
    actor.hazards.update(0.25);
    near(actor.player.health, before, 'Leaving the flame surface ends contact damage immediately');
  }
});

test('the two overlapping opening fires still cause one contact rate at a reachable hall position', () => {
  const actor = actorAt(CHECKPOINTS.apartment);
  walk(actor, [[-8.5, 4, -6], [-6.5, 4, -6], [-6.5, 4, -3]]);
  push(actor, 0, 4.2);
  near(actor.body.position.z, -2.07, 'Shared front face');
  assert.ok(apartment.every(fire => fire.damageBounds.min.x < actor.body.position.x
    && fire.damageBounds.max.x > actor.body.position.x), 'The position reaches both real fire patches');
  holdContact(actor);
});

test('the real neighbor gate damages on approach, deactivates on reset and reuses its original hazard', () => {
  neighbor.onEnter();
  const actor = actorAt(CHECKPOINTS.neighbor);
  push(actor, -4.2, 0);
  near(actor.body.position.x, -1.78, 'The newly active breach stops the player on its east face');
  holdContact(actor);
  neighbor.onReset();
  const before = actor.player.health;
  actor.hazards.update(0.25);
  near(actor.player.health, before, 'Inactive cached flames cause no damage');
  assert.equal(Colliders.isEnabled(breach.collider), false);
  neighbor.onEnter();
  assert.equal(fires.length, 4, 'Reentry reuses the same fire entry');
  holdContact(actor);
  walk(actor, [[-1.2, 4, -6]]);
  near(actor.hazards.update(0.25), 0, 'A real retreat clears the gate hazard');
  neighbor.onReset();
});

test('the unblocked wreck flame is reachable beside the actual car body in both stances', () => {
  for (const crouch of [false, true]) {
    const actor = actorAt({ x: -3.5, y: 0.05, z: 20 }, { crouch });
    walk(actor, [[-3.5, 0.05, 23.75]]);
    push(actor, 4.2, 0);
    near(actor.body.position.x, -2.776464446939299, 'Actual rotated vehicle collision face');
    holdContact(actor);
    walk(actor, [[-3.1, 0.05, 23.75]]);
    near(actor.hazards.update(0.25), 0, 'Moving away from the wreck ends contact');
  }
});

test('actual apartment walls and floors prevent heat across solids even if an authored volume extends past them', () => {
  for (const [label, fire, foot, expand] of [
    ['closed entry door', apartment[0], { x: -5.4, y: 4, z: 0.42 }, bounds => { bounds.max.z = 0.6; }],
    ['apartment floor', apartment[1], { x: -8.5, y: 0.14, z: -0.9 }, bounds => { bounds.min.y = 1.7; }],
  ]) {
    const baseline = actorAt(foot);
    assert.ok(capsuleHasClearance(baseline.body.position, 0.32, 1.84, Colliders.list), `${label}: valid outside position`);
    near(baseline.hazards.update(DT), 0, `${label}: actual fire extent stays inside its space`);
    const extended = { ...fire, damageBounds: fire.damageBounds.clone() };
    expand(extended.damageBounds);
    const sources = fires.map(entry => entry === fire ? extended : entry);
    assert.ok(actorAt(foot, { sources, colliders: [] }).hazards.update(DT) > 0,
      `${label}: positive control proves the oversized heat volume reaches the capsule`);
    near(actorAt(foot, { sources }).hazards.update(DT), 0, `${label}: actual structural collision blocks the heat path`);
  }
});

test('the full scaffold descent and street crossing reach the bakery without entering any fire hazard', () => {
  const actor = actorAt(CHECKPOINTS.scaffolding);
  const untouched = current => {
    near(current.hazards.update(DT), 0, 'The authored exit route stays away from fire contact');
    assert.ok(capsuleHasClearance(current.body.position, 0.32, 1.84, Colliders.list, 0.003));
  };
  walk(actor, [
    [22, 10, 2.4], [15.2, 10, 3.2], [9.5, 7, 3.2], [21.8, 7, 4.2],
    [25, 4, 4.2], [18, 4, 4.5], [13, 1.5, 4.5], [24, 1.5, 5.2],
    [24, 0.05, 10], [24, 0.05, 18.7], [-18.75, 0.05, 18.7],
    ...DISTRICT.bakery.accessRoute.map(point => [point.x, point.y, point.z]),
  ], untouched);
  const bakery = fixture.triggers.find(trigger => trigger.name === 'bakery');
  assert.ok(bakery.bounds.containsPoint(actor.player.pos), 'The physical route enters the real bakery zone');
  near(actor.player.health, 100, 'Safe traversal never needs fixture healing');
});
