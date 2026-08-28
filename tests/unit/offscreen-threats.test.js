import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createOffscreenThreatTracker, describeOffscreenThreat } from '../../src/game/offscreen-threats.js';

const baseView = () => ({ position: { x: 0, y: 1, z: 0 }, yaw: 0, pitch: 0, fov: 60, aspect: 1, zoom: 1 });
const actor = (x = 0, z = -5, changes = {}) => ({ pos: { x, y: 0, z }, height: 2, radius: 0.25, alive: true, ...changes });
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected} by more than ${tolerance}`);

test('camera-relative forward, left, right and rear agree after yaw rotations', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
    const view = { ...baseView(), yaw };
    const forward = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const front = actor(forward.x * 5, forward.z * 5);
    assert.equal(describeOffscreenThreat(view, front).visible, true);
    assert.equal(describeOffscreenThreat(view, front).direction, null);
    for (const [side, label] of [[-1, 'LEFT'], [1, 'RIGHT']]) {
      const source = actor(forward.x * 5 + side * right.x * 7, forward.z * 5 + side * right.z * 7);
      const result = describeOffscreenThreat(view, source);
      assert.equal(result.visible, false); assert.equal(result.direction, label);
      near(result.angle, side * Math.PI / 2);
    }
    const rear = describeOffscreenThreat(view, actor(-forward.x * 5, -forward.z * 5));
    assert.equal(rear.visible, false); assert.equal(rear.direction, 'BEHIND');
    near(rear.angle, Math.PI);
  }
});

test('rear arrows retain the correct side while vertical arrows point up or down', () => {
  const view = baseView();
  near(describeOffscreenThreat(view, actor(4, 3)).angle, Math.atan2(4, -3));
  near(describeOffscreenThreat(view, actor(-4, 3)).angle, Math.atan2(-4, -3));
  for (const [y, direction, angle] of [[8, 'ABOVE', 0], [-10, 'BELOW', Math.PI]]) {
    const result = describeOffscreenThreat(view, actor(0, -4, { pos: { x: 0, y, z: -4 } }));
    assert.equal(result.visible, false); assert.equal(result.direction, direction); near(result.angle, angle);
  }
  const diagonal = describeOffscreenThreat(view, actor(8, -5, { pos: { x: 8, y: 0.5, z: -5 } }));
  assert.equal(diagonal.direction, 'RIGHT');
  assert.ok(diagonal.angle > 0 && diagonal.angle < Math.PI / 2, 'A side cue above center points toward that screen edge');
});

test('aspect ratio and perspective zoom change visibility rather than using a fixed yaw cutoff', () => {
  const source = actor(3.5, -5, { radius: 0.2 });
  assert.equal(describeOffscreenThreat({ ...baseView(), fov: 90, aspect: 2 }, source).visible, true);
  const portrait = describeOffscreenThreat({ ...baseView(), fov: 90, aspect: 0.5 }, source);
  assert.equal(portrait.visible, false); assert.equal(portrait.direction, 'RIGHT');
  const mid = actor(3, -5, { radius: 0.2 });
  assert.equal(describeOffscreenThreat({ ...baseView(), fov: 90, zoom: 1 }, mid).visible, true);
  assert.equal(describeOffscreenThreat({ ...baseView(), fov: 90, zoom: 2 }, mid).visible, false);
  const omittedZoom = { ...baseView(), fov: 90 }; delete omittedZoom.zoom;
  assert.deepEqual(describeOffscreenThreat(omittedZoom, mid), describeOffscreenThreat({ ...omittedZoom, zoom: 1 }, mid));
});

test('any partially visible body suppresses a warning at a horizontal or vertical edge', () => {
  const view = { ...baseView(), fov: 90 };
  assert.equal(describeOffscreenThreat(view, actor(5.7, -5, { radius: 0.5 })).visible, true,
    'The center is outside, but the near side of the body is still visible');
  assert.equal(describeOffscreenThreat(view, actor(6.1, -5, { radius: 0.5 })).visible, false);
  const high = actor(0, -5, { pos: { x: 0, y: 5.9, z: -5 }, height: 0.3, radius: 0.2 });
  assert.equal(describeOffscreenThreat(view, high).visible, true, 'Only the low edge intersects the frame');
  high.pos.y = 6.3;
  assert.equal(describeOffscreenThreat(view, high).direction, 'ABOVE');
  const portrait = { ...baseView(), position: { x: 0, y: 1.72, z: 0 }, fov: 80, aspect: 0.5 };
  assert.equal(describeOffscreenThreat(portrait, actor(1.5, -3, { radius: 0.3, height: 1.8 })).visible, true);
  assert.equal(describeOffscreenThreat(portrait, actor(1.8, -3, { radius: 0.3, height: 1.8 })).direction, 'RIGHT');
});

test('a close body filling the image is visible even when none of its eight corners is inside', () => {
  const view = { ...baseView(), position: { x: 0, y: 0.9, z: 0 }, fov: 80 };
  const source = actor(0, -0.65, { radius: 0.3, height: 1.8 });
  const tan = Math.tan(view.fov * Math.PI / 360);
  let insideCorners = 0;
  for (const x of [-0.3, 0.3]) for (const y of [-0.9, 0.9]) for (const depth of [0.35, 0.95]) {
    if (Math.abs(x) <= depth * tan && Math.abs(y) <= depth * tan) insideCorners++;
  }
  assert.equal(insideCorners, 0, 'Fixture would fail an any-corner-inside shortcut');
  assert.equal(describeOffscreenThreat(view, source).visible, true);
  const giant = actor(0, -2, { pos: { x: 0, y: -10, z: -2 }, radius: 10, height: 22 });
  assert.equal(describeOffscreenThreat(baseView(), giant).visible, true);
});

test('a nearby rear body is hidden only when no part reaches the camera frustum', () => {
  const view = { ...baseView(), position: { x: 0, y: 1.6, z: 0 } };
  const behind = describeOffscreenThreat(view, actor(0, 0.45, { radius: 0.3, height: 1.82 }));
  assert.equal(behind.visible, false); assert.equal(behind.direction, 'BEHIND'); near(behind.angle, Math.PI);
  assert.equal(describeOffscreenThreat(view, actor(0, 0.1, { radius: 0.3, height: 1.82 })).visible, true,
    'A body containing the eye also reaches the visible front half-space');
});

test('steep pitch gives vertical cues for yaw-front actors even behind the camera plane', () => {
  const view = { ...baseView(), position: { x: 0, y: 1.72, z: 0 }, fov: 80, aspect: 16 / 9 };
  const below = describeOffscreenThreat({ ...view, pitch: 80 * Math.PI / 180 }, actor(0, -1, { radius: 0.3, height: 1.8 }));
  assert.equal(below.visible, false); assert.equal(below.direction, 'BELOW'); near(below.angle, Math.PI);
  const above = describeOffscreenThreat({ ...view, pitch: -80 * Math.PI / 180 },
    actor(0, -1, { pos: { x: 0, y: 3.5, z: -1 }, radius: 0.3, height: 1.8 }));
  assert.equal(above.visible, false); assert.equal(above.direction, 'ABOVE'); near(above.angle, 0);
  const rearButVisible = describeOffscreenThreat({ ...view, pitch: 80 * Math.PI / 180 },
    actor(0, 1, { pos: { x: 0, y: 4, z: 1 }, radius: 0.3, height: 1.8 }));
  assert.equal(rearButVisible.visible, true, 'Visible bodies win over any horizontal rear classification');
});

test('directly overhead and below sources are not mistaken for rear actors by negative zero', () => {
  const view = baseView();
  const overhead = describeOffscreenThreat(view, actor(0, 0, { pos: { x: 0, y: 4, z: 0 } }));
  const underfoot = describeOffscreenThreat(view, actor(0, 0, { pos: { x: 0, y: -4, z: 0 } }));
  assert.equal(overhead.direction, 'ABOVE'); near(overhead.angle, 0);
  assert.equal(underfoot.direction, 'BELOW'); near(underfoot.angle, Math.PI);
});

test('the corner-plane result agrees with Three.js perspective frustum intersection', () => {
  for (const yaw of [0, 0.9, -2.1]) for (const pitch of [-1.3, 0, 1.3]) {
    for (const aspect of [0.55, 16 / 9]) for (const zoom of [1, 2]) {
      const view = { ...baseView(), yaw, pitch, aspect, zoom, fov: 78 };
      const camera = new THREE.PerspectiveCamera(view.fov, aspect, 1e-8, 100000);
      camera.position.set(view.position.x, view.position.y, view.position.z);
      camera.rotation.set(pitch, yaw, 0, 'YXZ'); camera.zoom = zoom;
      camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4()
        .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      for (const [x, y, z] of [[0, 0, -4], [3, 0, -3], [-7, 0, -2], [0, 5, -1], [0, -6, -3], [0, 4, 1]]) {
        const source = actor(x, z, { pos: { x, y, z } });
        const box = new THREE.Box3(new THREE.Vector3(x - source.radius, y, z - source.radius),
          new THREE.Vector3(x + source.radius, y + source.height, z + source.radius));
        assert.equal(describeOffscreenThreat(view, source).visible, frustum.intersectsBox(box),
          `yaw=${yaw}, pitch=${pitch}, aspect=${aspect}, zoom=${zoom}, body=${x},${y},${z}`);
      }
    }
  }
});

test('descriptions use current source bounds, return center distance and do not mutate inputs', () => {
  const view = baseView(), source = actor(0, 5);
  Object.freeze(view.position); Object.freeze(view); Object.freeze(source.pos); Object.freeze(source);
  const first = describeOffscreenThreat(view, source), second = describeOffscreenThreat(view, source);
  near(first.distance, 5); assert.deepEqual(first, second); assert.notEqual(first, second);
});

test('recent hit timing advances only on valid positive simulation deltas', () => {
  const tracker = createOffscreenThreatTracker({ hitDuration: 1.1 });
  assert.equal(tracker.hit(actor(0, 5)), true);
  assert.equal(tracker.update(0.5, baseView()).phase, 'hit');
  for (const delta of [0, 0, -4, NaN, Infinity]) {
    assert.equal(tracker.update(delta, baseView()).phase, 'hit');
    near(tracker.snapshot().elapsed, 0.5);
  }
  assert.equal(tracker.update(0.599, baseView()).phase, 'hit');
  assert.equal(tracker.update(0.001, baseView()), null);
  assert.equal(tracker.snapshot().pendingHits, 0);
});

test('a full lifetime expires consistently at a 120 Hz simulation rate', () => {
  const tracker = createOffscreenThreatTracker();
  tracker.hit(actor(0, 5));
  for (let frame = 0; frame < 131; frame++) assert.equal(tracker.update(1 / 120, baseView()).phase, 'hit');
  assert.equal(tracker.update(1 / 120, baseView()), null);
});

test('turning to see a hit source acknowledges it and cannot revive an old warning', () => {
  const tracker = createOffscreenThreatTracker(), source = actor(0, 5);
  tracker.hit(source);
  assert.equal(tracker.update(0, baseView()).direction, 'BEHIND');
  assert.equal(tracker.update(0, { ...baseView(), yaw: Math.PI }), null);
  assert.equal(tracker.snapshot().pendingHits, 0);
  assert.equal(tracker.update(0, baseView()), null);
  assert.equal(tracker.update(0, baseView(), [source]).phase, 'windup', 'A fresh current attack can warn again');
});

test('partial visibility also acknowledges a recent hit', () => {
  const tracker = createOffscreenThreatTracker(), source = actor(6.1, -5, { radius: 0.5 });
  tracker.hit(source);
  assert.equal(tracker.update(0, { ...baseView(), fov: 90 }).phase, 'hit');
  source.pos.x = 5.7;
  assert.equal(tracker.update(0, { ...baseView(), fov: 90 }), null);
  source.pos.x = 6.1;
  assert.equal(tracker.update(0, { ...baseView(), fov: 90 }), null);
});

test('hit sources follow their live positions and disappear after death or removal', () => {
  const tracker = createOffscreenThreatTracker(), source = actor(0, 5);
  tracker.hit(source); assert.equal(tracker.update(0, baseView()).direction, 'BEHIND');
  source.pos = { x: -8, y: 0, z: -3 };
  assert.equal(tracker.update(0, baseView()).direction, 'LEFT');
  source.alive = false;
  assert.equal(tracker.update(0, baseView(), [source]), null);
  assert.equal(tracker.snapshot().pendingHits, 0);
  source.alive = true; tracker.hit(source); source.removed = true;
  assert.equal(tracker.update(0, baseView(), [source]), null);
  assert.equal(tracker.snapshot().pendingHits, 0);
  source.removed = false;
  assert.equal(tracker.update(0, baseView()), null, 'A reused actor cannot inherit removed hit history');
});

test('duplicates count once and hits outrank nearer active windups', () => {
  const tracker = createOffscreenThreatTracker();
  const rearHit = actor(0, 8), sideAttack = actor(5, -2), visible = actor(0, -4);
  tracker.hit(rearHit); tracker.hit(rearHit);
  const result = tracker.update(0, baseView(), [rearHit, sideAttack, sideAttack, visible, rearHit]);
  assert.deepEqual(result, { angle: Math.PI, direction: 'BEHIND', phase: 'hit', count: 2 });
  assert.equal(tracker.snapshot().pendingHits, 1);
  assert.equal(tracker.update(1.1, baseView(), [rearHit, sideAttack]).direction, 'RIGHT',
    'Once hits expire, the nearest current attack wins');
});

test('the newest hidden hit wins and refreshing a source renews its priority and lifetime', () => {
  const tracker = createOffscreenThreatTracker({ hitDuration: 1 });
  const left = actor(-7, -3), right = actor(7, -3);
  tracker.hit(left); tracker.update(0.4, baseView()); tracker.hit(right);
  assert.equal(tracker.update(0, baseView()).direction, 'RIGHT');
  tracker.hit(left);
  assert.equal(tracker.update(0, baseView()).direction, 'LEFT');
  assert.equal(tracker.snapshot().pendingHits, 2);
  assert.equal(tracker.update(0.9, baseView()).phase, 'hit');
  assert.equal(tracker.update(0.1, baseView()), null);
});

test('the current attacker list is not retained across updates', () => {
  const tracker = createOffscreenThreatTracker(), source = actor(0, 5);
  assert.deepEqual(tracker.update(0, baseView(), [source, source]),
    { angle: Math.PI, direction: 'BEHIND', phase: 'windup', count: 1 });
  assert.equal(tracker.update(0, baseView()), null);
  assert.equal(tracker.snapshot().pendingHits, 0);
});

test('hit history evicts its oldest source at the configured budget', () => {
  const tracker = createOffscreenThreatTracker({ maxHits: 2 });
  const old = actor(0, 3), middle = actor(-6, -2), newest = actor(6, -2);
  tracker.hit(old); tracker.hit(middle); tracker.hit(newest);
  assert.equal(tracker.snapshot().pendingHits, 2);
  assert.equal(tracker.update(0, baseView()).count, 2);
  middle.alive = false; newest.removed = true;
  assert.equal(tracker.update(0, baseView()), null, 'The evicted old source cannot reappear');
  const excessive = createOffscreenThreatTracker({ maxHits: 1000000, hitDuration: 1000000 });
  for (let i = 0; i < 200; i++) excessive.hit(actor(i, 5));
  assert.equal(excessive.snapshot().pendingHits, 64);
  assert.equal(excessive.snapshot().maxHits, 64);
  assert.equal(excessive.snapshot().hitDuration, 60);
});

test('refreshing a source protects it from eviction before an older unrefreshed hit', () => {
  const tracker = createOffscreenThreatTracker({ maxHits: 2 });
  const refreshed = actor(-6, -2), stale = actor(0, 5), newest = actor(6, -2);
  tracker.hit(refreshed); tracker.hit(stale); tracker.hit(refreshed); tracker.hit(newest);
  newest.alive = false;
  const result = tracker.update(0, baseView());
  assert.equal(result.direction, 'LEFT'); assert.equal(result.count, 1);
  assert.equal(tracker.snapshot().pendingHits, 1);
});

test('a now-visible newest hit falls back to the older hidden hit without inflating the count', () => {
  const tracker = createOffscreenThreatTracker(), older = actor(0, 5), newer = actor(8, -2);
  tracker.hit(older); tracker.hit(newer);
  newer.pos = { x: 0, y: 0, z: -5 };
  const result = tracker.update(0, baseView(), [newer, older, newer]);
  assert.deepEqual(result, { angle: Math.PI, direction: 'BEHIND', phase: 'hit', count: 1 });
  assert.equal(tracker.snapshot().pendingHits, 1);
  const samePositionDifferentActor = actor(0, 5);
  assert.equal(tracker.update(0, baseView(), [older, samePositionDifferentActor]).count, 2,
    'Identity belongs to the actor, not its coordinates');
});

test('clear resets history and simulation age without retaining a prior attacker list', () => {
  const tracker = createOffscreenThreatTracker(), source = actor(0, 5);
  tracker.hit(source); tracker.update(0.4, baseView(), [source]); tracker.clear();
  assert.deepEqual(tracker.snapshot(), { elapsed: 0, pendingHits: 0, maxHits: 8, hitDuration: 1.1 });
  assert.equal(tracker.update(0, baseView()), null);
  tracker.hit(source);
  assert.equal(tracker.update(1, baseView()).phase, 'hit');
  assert.equal(tracker.update(0.1, baseView()), null);
});

test('invalid inputs never create nonfinite alerts and invalid views still allow hits to expire', () => {
  const view = baseView(), source = actor(0, 5), tracker = createOffscreenThreatTracker();
  for (const invalid of [null, undefined, 3, {}, { ...source, pos: null },
    { ...source, pos: { x: NaN, y: 0, z: 3 } }, { ...source, height: 0 },
    { ...source, radius: -1 }, { ...source, radius: Infinity },
    { ...source, alive: false }, { ...source, alive: 0 }, { ...source, removed: true }]) {
    assert.equal(describeOffscreenThreat(view, invalid), null);
    assert.equal(tracker.hit(invalid), false);
  }
  for (const invalid of [null, {}, { ...view, position: null }, { ...view, yaw: NaN },
    { ...view, pitch: Infinity }, { ...view, fov: 0 }, { ...view, fov: 180 },
    { ...view, aspect: 0 }, { ...view, zoom: 0 }, { ...view, zoom: Infinity }]) {
    assert.equal(describeOffscreenThreat(invalid, source), null);
    assert.equal(tracker.update(0, invalid, [source]), null);
  }
  tracker.hit(source);
  assert.equal(tracker.update(2, null), null);
  assert.equal(tracker.snapshot().pendingHits, 0);
  assert.equal(tracker.update(0, view, null), null);
  assert.equal(tracker.update(0, view, { [Symbol.iterator]() { throw new Error('Do not consume arbitrary iterables'); } }), null);
  assert.deepEqual(createOffscreenThreatTracker({ hitDuration: NaN, maxHits: Infinity }).snapshot(),
    { elapsed: 0, pendingHits: 0, maxHits: 8, hitDuration: 1.1 });
  assert.deepEqual(createOffscreenThreatTracker(null).snapshot(), createOffscreenThreatTracker().snapshot());
});

test('explicit zero history options still allow current windup indications', () => {
  const source = actor(0, 5);
  for (const options of [{ maxHits: 0 }, { hitDuration: 0 }]) {
    const tracker = createOffscreenThreatTracker(options);
    assert.equal(tracker.hit(source), false);
    assert.equal(tracker.update(0, baseView(), [source]).phase, 'windup');
    assert.equal(tracker.snapshot().pendingHits, 0);
  }
});
