import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Matrix4, MathUtils, Vector3 } from 'three';
import { createMotionAim } from '../../src/core/motion-aim.js';

class EventTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, properties = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, ...properties });
  }
  count(type) { return this.listeners.get(type)?.size ?? 0; }
}

function fixture(t, { active = true, secure = true, sensor = true, permission, angle = 0, legacy = false, hidden = false } = {}) {
  const viewport = new EventTarget(), doc = Object.assign(new EventTarget(), { hidden });
  const screen = Object.assign(new EventTarget(), { angle });
  const timers = new Map(), looks = [], statuses = [];
  let now = 0, nextTimer = 0;
  viewport.isSecureContext = secure;
  if (sensor) {
    viewport.DeviceOrientationEvent = function () {};
    if (permission) viewport.DeviceOrientationEvent.requestPermission = permission;
  }
  if (legacy) viewport.orientation = angle;
  else viewport.screen = { orientation: screen };
  viewport.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; };
  viewport.clearTimeout = id => timers.delete(id);
  const aim = createMotionAim({ window: viewport, document: doc, onLook: (...delta) => looks.push(delta), onStatus: status => statuses.push(status) });
  aim.setActive(active);
  t.after(() => aim.destroy());
  return {
    aim, viewport, doc, screen, timers, looks, statuses,
    sample(alpha = 0, beta = 0, gamma = 0, properties = {}) { viewport.emit('deviceorientation', { alpha, beta, gamma, ...properties }); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function close(actual, expected, message = '') { assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} ≈ ${expected}`); }
function assertTurn(f, yaw, pitch) {
  assert.equal(f.looks.length, 1);
  // Check the resulting camera angle, including the existing mouse signs.
  close(-f.looks[0][0] * 0.0025, MathUtils.degToRad(yaw), 'yaw');
  close(-f.looks[0][1] * 0.0025, MathUtils.degToRad(pitch), 'pitch');
}

// Generate physical rotations with Three's independent rotation-matrix/Euler
// conversion, then pass the resulting browser readings to the public adapter.
function localTurn([alpha, beta, gamma], screenAngle, axis, degrees) {
  const radians = MathUtils.degToRad;
  const pose = new Matrix4().makeRotationFromEuler(new Euler(radians(beta), radians(gamma), radians(alpha), 'ZXY'));
  const screen = new Matrix4().makeRotationZ(-radians(screenAngle));
  pose.multiply(screen)
    .multiply(new Matrix4().makeRotationAxis(new Vector3(...axis), radians(degrees)))
    .multiply(screen.invert());
  const angles = new Euler().setFromRotationMatrix(pose, 'ZXY');
  return [MathUtils.radToDeg(angles.z), MathUtils.radToDeg(angles.x), MathUtils.radToDeg(angles.y)];
}

test('motion aim stays off until opted in and calibrates without moving the camera', async t => {
  const f = fixture(t);
  assert.equal(f.aim.enabled, false);
  assert.equal(f.aim.status, 'off');
  assert.equal(f.viewport.count('deviceorientation'), 0);
  assert.deepEqual(f.statuses, []);
  f.sample(100, 30, 20);
  assert.equal(await f.aim.enable(), true);
  assert.equal(f.aim.enabled, true);
  assert.equal(f.aim.status, 'waiting');
  assert.equal(f.viewport.count('deviceorientation'), 1);
  f.sample(100, 30, 20);
  assert.equal(f.aim.status, 'active');
  assert.deepEqual(f.looks, []);
  assert.equal(f.timers.size, 0);
  f.sample(100, 30, 25);
  assertTurn(f, 5, 0);
  assert.deepEqual(f.statuses, ['requesting', 'waiting', 'active']);
});

test('screen-relative pitch and yaw have the correct signs at flat, upright, and tilted poses', async t => {
  for (const angle of [0, 90, -90, 180]) {
    for (const baseline of [[0, 0, 0], [45, 90, 0], [30, 45, 20]]) {
      for (const [axis, yaw, pitch] of [[[1, 0, 0], 0, 5], [[0, 1, 0], 5, 0], [[0, -1, 0], -5, 0], [[-1, 0, 0], 0, -5]]) {
        const f = fixture(t, { angle });
        await f.aim.enable();
        f.sample(...baseline);
        f.sample(...localTurn(baseline, angle, axis, 5));
        assertTurn(f, yaw, pitch);
      }
    }
  }
});

test('physical screen roll does not move the aim or tilt the horizon', async t => {
  for (const angle of [0, 90, -90]) {
    for (const baseline of [[0, 0, 0], [30, 45, 20]]) {
      const f = fixture(t, { angle });
      await f.aim.enable();
      f.sample(...baseline);
      f.sample(...localTurn(baseline, angle, [0, 0, 1], 10));
      assert.deepEqual(f.looks, []);
    }
  }
});

test('Euler angle wraps and equivalent representations cannot produce camera jumps', async t => {
  for (const { baseline, next, yaw, pitch } of [
    { baseline: [359, 90, 0], next: [1, 90, 0], yaw: 2, pitch: 0 },
    { baseline: [1, 90, 0], next: [359, 90, 0], yaw: -2, pitch: 0 },
    { baseline: [0, 179, 0], next: [0, -179, 0], yaw: 0, pitch: 2 },
  ]) {
    const f = fixture(t);
    await f.aim.enable();
    f.sample(...baseline);
    f.sample(...next);
    assertTurn(f, yaw, pitch);
  }
  const f = fixture(t);
  await f.aim.enable();
  f.sample(20, 90, 30);
  f.sample(50, 90, 0);
  f.sample(410, 90, 0);
  assert.deepEqual(f.looks, [], 'a gimbal representation change or quaternion sign flip is the same physical pose');
});

test('null, missing, nonnumeric, and nonfinite orientation values neither calibrate nor poison aim', async t => {
  const f = fixture(t);
  await f.aim.enable();
  for (const invalid of [null, undefined, NaN, Infinity, -Infinity, '0']) {
    for (const field of ['alpha', 'beta', 'gamma']) f.sample(0, 0, 0, { [field]: invalid });
  }
  assert.equal(f.aim.status, 'waiting');
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.looks, []);
  f.sample();
  f.sample(0, null, 50);
  f.sample(0, 0, 5);
  assertTurn(f, 5, 0);
});

test('permission is requested synchronously in the original gesture and requests no absolute heading', async t => {
  let resolve, calls = 0, args;
  const f = fixture(t, { permission(...parameters) { calls++; args = parameters; return new Promise(done => { resolve = done; }); } });
  const pending = f.aim.enable();
  assert.equal(calls, 1, 'no microtask may run before requesting permission');
  assert.deepEqual(args, []);
  assert.equal(f.aim.status, 'requesting');
  assert.equal(f.viewport.count('deviceorientation'), 0);
  assert.equal(f.timers.size, 0);
  await f.aim.enable();
  assert.equal(calls, 1, 'a pending request is not duplicated');
  resolve('granted');
  assert.equal(await pending, true);
  assert.equal(f.aim.status, 'waiting');
  assert.equal(f.viewport.count('deviceorientation'), 1);
});

test('denied or rejected permission falls back cleanly and an explicit retry can succeed', async t => {
  for (const failure of ['denied', 'throw', 'reject']) {
    let calls = 0;
    const f = fixture(t, { permission() {
      if (++calls > 1) return Promise.resolve('granted');
      if (failure === 'throw') throw new Error('blocked');
      if (failure === 'reject') return Promise.reject(new Error('blocked'));
      return Promise.resolve('denied');
    } });
    assert.equal(await f.aim.enable(), false);
    assert.equal(f.aim.status, 'denied');
    assert.equal(f.aim.enabled, true);
    assert.equal(f.viewport.count('deviceorientation'), 0);
    assert.equal(f.timers.size, 0);
    f.aim.setActive(false);
    f.aim.setActive(true);
    assert.equal(f.aim.status, 'denied');
    assert.equal(await f.aim.enable(), true);
    f.sample();
    assert.equal(f.aim.status, 'active');
  }
});

test('insecure contexts and missing sensor APIs are unavailable without requesting permission', async t => {
  for (const options of [{ secure: false }, { sensor: false }]) {
    let calls = 0;
    const f = fixture(t, { ...options, permission() { calls++; return Promise.resolve('granted'); } });
    assert.equal(await f.aim.enable(), false);
    assert.equal(f.aim.status, 'unavailable');
    assert.equal(calls, 0);
    assert.equal(f.viewport.count('deviceorientation'), 0);
    assert.equal(f.timers.size, 0);
  }
});

test('silence or invalid samples during calibration times out and an explicit retry starts fresh', async t => {
  const f = fixture(t);
  await f.aim.enable();
  f.advance(2499);
  f.sample(null, null, null);
  assert.equal(f.aim.status, 'waiting');
  f.advance(1);
  assert.equal(f.aim.status, 'unavailable');
  assert.equal(f.viewport.count('deviceorientation'), 0);
  assert.equal(f.timers.size, 0);
  f.sample(0, 0, 20);
  f.aim.setActive(false);
  f.aim.setActive(true);
  assert.equal(f.aim.status, 'unavailable');
  await f.aim.enable();
  f.sample(0, 0, 20);
  assert.equal(f.aim.status, 'active');
  assert.deepEqual(f.looks, []);
  f.sample(0, 0, 25);
  assertTurn(f, 5, 0);
});

test('a stationary calibrated device stays active when the browser suppresses unchanged events', async t => {
  const f = fixture(t);
  await f.aim.enable();
  f.sample();
  f.advance(60000);
  assert.equal(f.aim.status, 'active');
  assert.equal(f.viewport.count('deviceorientation'), 1);
  f.sample(0, 0, 5);
  assertTurn(f, 5, 0);
});

test('recenter and resume keep a proven sensor available while waiting for the next changed reading', async t => {
  const resets = [
    f => f.aim.recenter(),
    f => { f.aim.setActive(false); f.aim.setActive(true); },
    f => { f.doc.hidden = true; f.doc.emit('visibilitychange'); f.doc.hidden = false; f.doc.emit('visibilitychange'); },
    f => f.screen.emit('change'),
  ];
  for (const reset of resets) {
    const f = fixture(t);
    await f.aim.enable();
    f.sample();
    reset(f);
    assert.equal(f.aim.status, 'waiting');
    assert.equal(f.timers.size, 0);
    f.advance(60000);
    assert.equal(f.viewport.count('deviceorientation'), 1);
    assert.equal(f.aim.status, 'waiting');
    f.sample(30, 40, 50);
    assert.deepEqual(f.looks, []);
    f.sample(30, 40, 55);
    assertTurn(f, 5, 0);
  }
});

test('inactive or hidden gameplay never subscribes or starts a sensor timeout', async t => {
  for (const options of [{ active: false }, { hidden: true }]) {
    const f = fixture(t, options);
    await f.aim.enable();
    assert.equal(f.aim.status, 'waiting');
    assert.equal(f.viewport.count('deviceorientation'), 0);
    assert.equal(f.timers.size, 0);
    f.advance(10000);
    f.aim.setActive(true);
    f.doc.hidden = false;
    f.doc.emit('visibilitychange');
    assert.equal(f.viewport.count('deviceorientation'), 1);
    assert.equal(f.timers.size, 1);
    f.sample(40, 50, 60);
    assert.equal(f.aim.status, 'active');
    assert.deepEqual(f.looks, []);
  }
});

test('pause, visibility, blur, and page suspension discard movement until a fresh resume baseline', async t => {
  const lifecycles = [
    [f => f.aim.setActive(false), f => f.aim.setActive(true)],
    [f => { f.doc.hidden = true; f.doc.emit('visibilitychange'); }, f => { f.doc.hidden = false; f.doc.emit('visibilitychange'); }],
    [f => f.viewport.emit('blur'), f => f.viewport.emit('focus')],
    [f => f.viewport.emit('pagehide'), f => f.viewport.emit('pageshow')],
  ];
  for (const [pause, resume] of lifecycles) {
    const f = fixture(t);
    await f.aim.enable();
    f.sample();
    pause(f);
    assert.equal(f.aim.status, 'waiting');
    assert.equal(f.viewport.count('deviceorientation'), 0);
    assert.equal(f.timers.size, 0);
    f.sample(50, 50, 50);
    f.advance(3000);
    resume(f);
    assert.equal(f.viewport.count('deviceorientation'), 1);
    f.sample(50, 50, 50);
    assert.deepEqual(f.looks, []);
    f.sample(50, 50, 55);
    assertTurn(f, 5, 0);
  }
});

test('recenter and modern or legacy display rotation reset without a jump', async t => {
  for (const kind of ['recenter', 'modern', 'legacy', 'unannounced']) {
    const f = fixture(t, { legacy: kind === 'legacy' });
    await f.aim.enable();
    f.sample();
    if (kind === 'recenter') f.aim.recenter();
    else if (kind === 'legacy') { f.viewport.orientation = 90; f.viewport.emit('orientationchange'); }
    else { f.screen.angle = 90; if (kind === 'modern') f.screen.emit('change'); }
    f.sample(40, 20, 10);
    assert.deepEqual(f.looks, []);
    const angle = kind === 'recenter' ? 0 : 90;
    f.sample(...localTurn([40, 20, 10], angle, [0, 1, 0], 5));
    assertTurn(f, 5, 0);
    assert.equal(f.timers.size, 0);
  }
});

test('modern screen angle takes precedence and unavailable modern angle falls back to legacy', async t => {
  for (const angle of [90, NaN, undefined]) {
    const f = fixture(t, { angle });
    f.screen.angle = angle;
    f.viewport.orientation = -90;
    await f.aim.enable();
    f.sample();
    f.sample(0, 5, 0);
    assertTurn(f, angle === 90 ? 5 : -5, 0);
  }
});

test('switching the browser orientation reference calibrates again without a heading jump', async t => {
  const f = fixture(t);
  await f.aim.enable();
  f.sample(0, 0, 0, { absolute: false });
  f.sample(100, 40, 30, { absolute: true });
  assert.deepEqual(f.looks, []);
  f.sample(100, 40, 35, { absolute: true });
  assertTurn(f, 5, 0);
});

test('disable or destroy invalidates pending permission and cannot be undone by its completion', async t => {
  for (const action of ['disable', 'destroy']) {
    for (const granted of [true, false]) {
      let resolve, reject;
      const f = fixture(t, { permission() { return new Promise((done, fail) => { resolve = done; reject = fail; }); } });
      const pending = f.aim.enable();
      f.aim[action]();
      if (granted) resolve('granted');
      else reject(new Error('late rejection'));
      assert.equal(await pending, false);
      assert.equal(f.aim.status, 'off');
      assert.equal(f.aim.enabled, false);
      assert.equal(f.viewport.count('deviceorientation'), 0);
      assert.equal(f.timers.size, 0);
    }
  }
});

test('an obsolete permission grant cannot supersede a newer denied request', async t => {
  const pending = [];
  const f = fixture(t, { permission() { return new Promise(resolve => pending.push(resolve)); } });
  const first = f.aim.enable();
  f.aim.disable();
  const second = f.aim.enable();
  pending[1]('denied');
  assert.equal(await second, false);
  pending[0]('granted');
  assert.equal(await first, false);
  assert.equal(f.aim.status, 'denied');
  assert.equal(f.viewport.count('deviceorientation'), 0);
});

test('disable and destruction remove timers and listeners and reject stale sensor callbacks', async t => {
  const f = fixture(t);
  await f.aim.enable();
  const listener = [...f.viewport.listeners.get('deviceorientation')][0];
  f.aim.disable();
  f.advance(10000);
  listener({ alpha: 0, beta: 10, gamma: 10 });
  assert.equal(f.aim.status, 'off');
  assert.deepEqual(f.looks, []);
  assert.equal(f.timers.size, 0);
  await f.aim.enable();
  f.aim.destroy();
  for (const target of [f.viewport, f.doc, f.screen]) {
    for (const handlers of target.listeners.values()) assert.equal(handlers.size, 0);
  }
  assert.equal(f.timers.size, 0);
  assert.equal(await f.aim.enable(), false);
  f.aim.setActive(true);
  f.aim.recenter();
  f.aim.destroy();
  assert.equal(f.aim.status, 'off');
  assert.equal(f.aim.enabled, false);
});
