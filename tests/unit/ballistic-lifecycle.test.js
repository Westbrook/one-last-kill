import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { Colliders } from '../../src/core/collision.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { resolveSurfaceOwnership } from '../../src/world/surface-ownership.js';
import { applyBoxWorldUV } from '../../src/render/world-uv.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';

const point = (x, y, z) => new THREE.Vector3(x, y, z);

test('the real late-created breach debris becomes cover and reuses the same indexed surface across resets', () => {
  const fixture = buildWorldSurfaceFixture(), index = fixture.ballistics;
  resolveSurfaceOwnership(fixture.records.values()); index.rebuild(fixture.World);
  const trigger = fixture.triggers.find(value => value.name === 'neighbor');
  assert.equal(typeof trigger.onEnter, 'function'); assert.equal(typeof trigger.onReset, 'function');
  // This line runs alongside the existing narrow breach sill. Only the wider,
  // newly spawned debris can stop it, so a pre-existing wall cannot mask errors.
  const start = point(-3.2, 4.15, -7.4), end = point(-3.2, 4.15, -4.6);
  const direction = end.clone().sub(start), distance = direction.length();
  assert.equal(index.segmentOccluded(start, end, 'bullet'), false);
  const before = index.snapshot();
  trigger.onEnter();
  const debris = fixture.World.getObjectByName('neighbor-breach-debris');
  const collider = debris?.userData.collider;
  assert.ok(debris && collider); assert.equal(Colliders.isEnabled(collider), true);
  const first = index.raycast(start, direction, distance);
  assert.equal(first?.object, debris); assert.equal(first.surfaceKind, 'brick');
  assert.ok(Math.abs(first.point.z + 7.3) < 1e-5);
  assert.equal(index.snapshot().objects, before.objects + 1);
  const active = index.snapshot();
  for (let life = 0; life < 3; life++) {
    trigger.onReset();
    assert.equal(debris.visible, false); assert.equal(Colliders.isEnabled(collider), false);
    assert.equal(index.segmentOccluded(start, end, 'bullet'), false);
    // A full index rebuild while a gate is disabled must keep its identity so
    // re-enabling it works without another geometry registration or allocation.
    index.rebuild(fixture.World);
    trigger.onEnter();
    assert.equal(fixture.World.getObjectByName('neighbor-breach-debris'), debris);
    assert.equal(Colliders.isEnabled(collider), true);
    const reverse = index.raycast(end, direction.clone().negate(), distance);
    assert.equal(reverse?.object, debris); assert.ok(Math.abs(reverse.point.z + 4.7) < 1e-5);
    assert.equal(index.snapshot().objects, active.objects);
    assert.equal(index.snapshot().triangles, active.triangles);
  }
});

test('the actual fire builder keeps its movement barrier out of bullets and sight', () => {
  Colliders.clear();
  const World = new THREE.Group(), WorldState = { smokeSystems: [], fires: [] };
  const source = readFileSync(new URL('../../src/world/world.js', import.meta.url), 'utf8')
    .match(/function spawnFire\([^]*?\n\}/)?.[0];
  assert.ok(source, 'exercise the actual fire registration function');
  const spawnFire = runInNewContext(`${source}\n;spawnFire;`, {
    THREE, World, WorldState, Colliders,
    // Even an opaque replacement material must not make a gameplay fire wall
    // bulletproof. The actual builder owns that policy, not a shader heuristic.
    makeFireMaterial: () => ({ mat: new THREE.MeshBasicMaterial() }),
    makeSmokeSystem: () => ({ points: new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()) }),
    setFireActive() {},
  });
  const fire = spawnFire(0, 0, 0, { width: 2, height: 2, blockHeight: 2, blockWidth: 2 });
  assert.equal(fire.group.userData.ballistics, false);
  assert.equal(Colliders.isEnabled(fire.collider), true);
  assert.ok(fire.collider.containsPoint(point(0, 1, 0)));
  const index = createBallisticWorld(); index.rebuild(World);
  assert.equal(index.raycast(point(0, 1, -3), point(0, 0, 1), 6), null);
  assert.equal(index.segmentOccluded(point(0, 1, -3), point(0, 1, 3)), false);
  assert.equal(index.snapshot().objects, 0);
});

test('the boot sequence indexes final static surfaces and ammo cases before adding live actors', () => {
  const source = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const surface = source.indexOf('finalizeWorldSurfaces();');
  const supplies = source.indexOf('AmmoSupplies.init(');
  const index = source.indexOf('Ballistics.rebuild(World)');
  const mission = source.indexOf('initMission();');
  const actors = source.indexOf('EnemyPool.init();');
  assert.ok(surface >= 0 && surface < supplies && supplies < index && index < mission && mission < actors,
    'final geometry and supplies belong in the index; animated pickups and actors do not');
});

test('the actual decoration batcher preserves chair parts and gaps in one accelerated merged mesh', () => {
  const source = readFileSync(new URL('../../src/render/models.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export \{[^}]+\};\s*$/gm, '');
  assert.doesNotMatch(source, /^import\s/m);
  const { _BG, pushDecor, flushDecor } = runInNewContext(`${source}\n;({ _BG, pushDecor, flushDecor });`, {
    THREE, HUMANOID_GEOMETRY: {}, applyBoxWorldUV,
  });
  const root = new THREE.Group(), wood = new THREE.MeshStandardMaterial(); wood.userData.surfaceKind = 'wood';
  // Same four leg and back dimensions used by the actual apartment builder.
  for (const x of [1.55, 1.85]) for (const z of [-5.15, -4.85]) {
    pushDecor(_BG.unitBox, wood, x, 4.195, z, 0.055, 0.39, 0.055);
  }
  pushDecor(_BG.unitBox, wood, 1.51, 4.72, -5, 0.05, 0.60, 0.4);
  for (let item = 0; item < 500; item++) {
    pushDecor(_BG.unitBox, wood, 10 + item % 25 * 2, 5, -10 - Math.floor(item / 25) * 2, 0.5, 0.5, 0.5);
  }
  flushDecor(root);
  assert.equal(root.children.length, 1, 'real per-material batching remains intact');
  const index = createBallisticWorld({ colliders: null }); index.rebuild(root);
  const hit = index.raycast(point(1.55, 4.195, -5.4), point(0, 0, 1), 0.4);
  assert.equal(hit?.object, root.children[0]); assert.equal(hit.surfaceKind, 'wood');
  assert.ok(Math.abs(hit.point.z + 5.1775) < 1e-5);
  const measured = index.snapshot();
  assert.equal(measured.geometryCount, 1); assert.equal(measured.triangles, 505 * 12);
  assert.ok(measured.lastQuery.triangles < 80, 'query prunes inside the merged material batch too');
  assert.equal(index.segmentOccluded(point(1.7, 4.195, -5.6), point(1.7, 4.195, -4.4), 'bullet'), false);
  assert.equal(index.segmentOccluded(point(1.16, 4.82, -5), point(1.86, 4.82, -5), 'bullet'), true);
});
