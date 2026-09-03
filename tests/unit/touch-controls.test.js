import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createInputState } from '../../src/core/input-state.js';
import { createTouchControls } from '../../src/ui/touch-controls.js';
import { weaponHarness } from './helpers/weapon-harness.js';

class EventTarget {
  listeners = new Map();

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
    if (!event.stopped) this.parentNode?.dispatchEvent(event);
  }
}

function emit(target, type, properties = {}) {
  const event = {
    type, pointerId: 1, pointerType: 'touch', button: 0, clientX: 180, clientY: 180,
    detail: 1, timeStamp: 0, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...properties,
  };
  target.dispatchEvent(event);
  return event;
}

// The fixture only supplies DOM operations used by the controller. Events
// bubble from nested labels, and releasing capture also emits lost capture.
class Element extends EventTarget {
  children = [];
  attributes = new Map();
  dataset = {};
  style = {};
  captures = new Set();
  hidden = false;

  constructor(tagName) { super(); this.tagName = tagName; }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(element) { this.children.push(element); element.parentNode = this; }
  remove() {
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.getAttribute('class')?.split(' ').includes(selector.slice(1));
    if (selector === '[data-touch]') return this.attributes.has('data-touch');
    if (selector === 'button[data-touch]') return this.tagName === 'button' && this.attributes.has('data-touch');
    return this.tagName === selector;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest?.(selector); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  set innerHTML(markup) {
    const stack = [this];
    for (const match of markup.matchAll(/<(\/)?([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
      if (match[1]) { stack.pop(); continue; }
      const element = new Element(match[2]);
      for (const [, name, value] of match[3].matchAll(/([\w:-]+)="([^"]*)"/g)) element.setAttribute(name, value);
      stack.at(-1).append(element);
      if (!match[3].endsWith('/')) stack.push(element);
    }
  }
  getBoundingClientRect() {
    let left = 100, top = 100;
    for (let element = this; element; element = element.parentNode) {
      const translation = element.style?.transform?.match(/^translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)$/);
      if (translation) { left += Number(translation[1]); top += Number(translation[2]); }
    }
    return { left, top, width: 160, height: 160 };
  }
  setPointerCapture(pointerId) { this.captures.add(pointerId); }
  hasPointerCapture(pointerId) { return this.captures.has(pointerId); }
  releasePointerCapture(pointerId) {
    if (this.captures.delete(pointerId)) emit(this, 'lostpointercapture', { pointerId });
  }
}

function fixture(t, { enabled = true, active = true, context, motion = false, secureContext = true } = {}) {
  const viewport = new EventTarget();
  const timers = new Map();
  let timerId = 0;
  viewport.isSecureContext = secureContext;
  viewport.screen = { orientation: Object.assign(new EventTarget(), { angle: 0 }) };
  viewport.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  viewport.clearTimeout = id => timers.delete(id);
  if (motion) {
    viewport.DeviceOrientationEvent = class {};
    if (motion.requestPermission) viewport.DeviceOrientationEvent.requestPermission = motion.requestPermission;
  }
  const doc = Object.assign(new EventTarget(), { body: new Element('body'), createElement: name => new Element(name) });
  doc.body.parentNode = doc;
  doc.parentNode = viewport;
  const input = createInputState();
  input.activate();
  let pauses = 0;
  const pause = input.pause.bind(input);
  input.pause = () => { pauses++; pause(); };
  const controls = createTouchControls({ input, document: doc, window: viewport });
  const elements = new Map(controls.element.querySelectorAll('[data-touch]').map(element => [element.dataset.touch, element]));
  if (context) controls.setContext(context);
  controls.setEnabled(enabled);
  controls.setActive(active);
  const positions = new Map();
  let timeStamp = 0;
  function pointerEvent(target, type, pointerId, properties) {
    const event = emit(target, type, { pointerId, timeStamp: timeStamp += 16, ...properties });
    timeStamp = event.timeStamp;
    positions.set(pointerId, { clientX: event.clientX, clientY: event.clientY });
    return event;
  }
  let destroyed = false;
  const destroy = () => { if (!destroyed) { controls.destroy(); destroyed = true; } };
  t.after(destroy);
  return {
    input, controls, viewport, doc, elements, destroy, pauses: () => pauses,
    down(action, pointerId = 1, properties = {}) { return pointerEvent(elements.get(action), 'pointerdown', pointerId, properties); },
    move(pointerId, clientX, clientY, properties = {}) { return pointerEvent(viewport, 'pointermove', pointerId, { clientX, clientY, ...properties }); },
    end(pointerId, type = 'pointerup', properties = {}) { return pointerEvent(viewport, type, pointerId, { ...positions.get(pointerId), ...properties }); },
    click(action, detail = 0) { return emit(elements.get(action).querySelector('span'), 'click', { detail }); },
    orient(alpha = 0, beta = 0, gamma = 0, properties = {}) { emit(viewport, 'deviceorientation', { alpha, beta, gamma, ...properties }); },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function assertReleased(input) {
  const frame = input.consumeFrame();
  for (const key of ['leftDown', 'leftPressed', 'aimDown', 'jumpDown', 'jumpPressed', 'crouchDown', 'sprintDown', 'ePressed', 'rPressed', 'vPressed', 'gPressed', 'tPressed']) assert.equal(frame[key], false, key);
  for (const key of ['dx', 'dy', 'moveX', 'moveY']) assert.equal(frame[key], 0, key);
}

test('touch controls require opt-in, a visible play session, and active input', t => {
  const f = fixture(t, { enabled: false, active: false });
  f.down('fire');
  assertReleased(f.input);
  f.controls.setEnabled(true);
  assert.equal(f.controls.element.hidden, true);
  f.down('fire');
  assertReleased(f.input);
  f.controls.setActive(true);
  assert.equal(f.controls.element.hidden, false);
  assert.equal(f.doc.body.dataset.touchControls, 'true');
  f.down('fire');
  assertReleased(f.input);
  f.end(1);
  const frame = f.input.consumeFrame();
  assert.equal(frame.leftPressed, true);
  assert.equal(frame.leftDown, false);
  f.input.pause();
  f.down('fire', 2);
  f.click('jump');
  assertReleased(f.input);
  f.controls.setActive(false);
  assert.equal(f.controls.element.hidden, true);
  assert.equal(f.doc.body.dataset.touchControls, 'false');
});

test('sights and rage start hidden and reject pointer and assistive actions until available', t => {
  const f = fixture(t);
  assert.equal(f.elements.get('aim').getAttribute('aria-label'), 'Toggle weapon sights');
  for (const action of ['aim', 'rage']) {
    const element = f.elements.get(action);
    assert.equal(element.hidden, true, action);
    assert.equal(element.disabled, true, action);
    f.down(action);
    f.end(1);
    f.click(action);
    assert.equal(element.captures.size, 0, action);
    assertReleased(f.input);
  }
  f.controls.setContext({ canAim: true, canRage: true });
  for (const action of ['aim', 'rage']) {
    assert.equal(f.elements.get(action).hidden, false, action);
    assert.equal(f.elements.get(action).disabled, false, action);
  }
});

test('losing firearm sights cancels their held pointer and toggle while other fingers keep playing', t => {
  const f = fixture(t, { context: { canAim: true } });
  f.down('aim', 1);
  f.down('move', 2);
  f.move(2, 228, 180);
  f.down('fire', 3, { clientX: 500, clientY: 200 });
  assert.equal(f.input.isAiming(), true);
  f.controls.setContext({ canAim: false });
  assert.equal(f.input.isAiming(), false);
  assert.equal(f.elements.get('aim').hidden, true);
  assert.equal(f.elements.get('aim').disabled, true);
  assert.equal(f.elements.get('aim').getAttribute('aria-pressed'), 'false');
  assert.equal(f.elements.get('aim').hasPointerCapture(1), false);
  f.end(1);
  f.click('aim');
  f.move(3, 508, 196);
  let frame = f.input.consumeFrame();
  assert.equal(frame.aimDown, false);
  assert.equal(frame.moveX, 1);
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.dx, 20);
  assert.equal(frame.dy, -10);
  f.controls.setContext({ canAim: true });
  assert.equal(f.input.isAiming(), false, 'equipping another firearm cannot revive the old toggle');
  f.click('aim');
  assert.equal(f.input.isAiming(), true);
  f.controls.setContext({ canAim: false });
  frame = f.input.consumeFrame();
  assert.equal(frame.aimDown, false, 'context loss also clears a toggle whose pointer was already released');
  assert.equal(frame.leftDown, false);
  f.end(3);
  assert.equal(f.input.consumeFrame().leftPressed, true, 'the other finger can still complete its fire tap');
});

test('losing rage eligibility discards a pending press without allowing stale pointers to replay it', t => {
  for (const released of [false, true]) {
    const f = fixture(t, { context: { canRage: true } });
    f.down('rage', 1);
    if (released) f.end(1);
    f.down('fire', 2);
    f.end(2);
    f.controls.setContext({ canRage: false });
    assert.equal(f.elements.get('rage').hidden, true);
    assert.equal(f.elements.get('rage').disabled, true);
    assert.equal(f.elements.get('rage').hasPointerCapture(1), false);
    f.click('rage');
    const frame = f.input.consumeFrame();
    assert.equal(frame.tPressed, false, `pending ${released ? 'tap' : 'hold'} was canceled`);
    assert.equal(frame.leftPressed, true, 'other pending touch actions survive');
    assert.equal(frame.leftDown, false);
    f.controls.setContext({ canRage: true });
    f.end(1);
    f.click('rage', 1);
    assert.equal(f.input.consumeFrame().tPressed, false, 'stale release and compatibility click cannot reactivate rage');
    f.down('rage', 1);
    assert.equal(f.input.consumeFrame().tPressed, true, 'a fresh available press is accepted');
    assert.equal(f.input.consumeFrame().tPressed, false);
  }
});

test('the movement stick centers on each touch and remains neutral until that finger drags', t => {
  const f = fixture(t);
  const zone = f.elements.get('move');
  const stick = zone.querySelector('.touch-stick');
  const thumb = zone.querySelector('.touch-stick-thumb');
  assert.ok(stick, 'the visual stick is inside its movement target');
  const assertCenter = (x, y) => {
    const bounds = zone.getBoundingClientRect();
    assert.equal(bounds.left + bounds.width / 2, x, 'the touch centers the activation area');
    assert.equal(bounds.top + bounds.height / 2, y, 'the touch centers the activation area');
    assert.deepEqual(stick.getBoundingClientRect(), bounds, 'the visual stick moves with its activation area');
  };
  f.down('move', 1, { clientX: 127, clientY: 238 });
  assertReleased(f.input);
  assert.equal(zone.style.transform, 'translate(-53px, 58px)');
  assertCenter(127, 238);
  f.move(1, 175, 238);
  let frame = f.input.consumeFrame();
  assert.equal(frame.moveX, 1, '48 pixels from the touch origin reaches the edge');
  assert.equal(Math.abs(frame.moveY), 0);
  f.move(1, 127, 238);
  assertReleased(f.input);
  f.end(1);
  assertCenter(127, 238);
  assert.equal(thumb.style.transform, 'translate(-50%, -50%)');
  f.down('move', 2, { clientX: 192, clientY: 185 });
  assertReleased(f.input);
  assert.equal(zone.style.transform, 'translate(12px, 5px)', 'the offset accounts for the current translated bounds');
  assertCenter(192, 185);
  f.move(2, 192, 137);
  frame = f.input.consumeFrame();
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 1, 'the new touch becomes the new origin');
  f.end(2);
  assertReleased(f.input);
  for (const [clientX, clientY] of [[132, 130], [206, 192], [166, 218]]) {
    const bounds = zone.getBoundingClientRect();
    assert.ok(clientX >= bounds.left && clientX <= bounds.left + bounds.width);
    assert.ok(clientY >= bounds.top && clientY <= bounds.top + bounds.height);
    f.down('move', 3, { clientX, clientY });
    assertReleased(f.input);
    assertCenter(clientX, clientY);
    f.end(3);
    assertCenter(clientX, clientY);
  }
});

test('movement, look, and fire pointers stay independent without firing while panning', t => {
  const f = fixture(t);
  f.down('move', 1);
  f.move(1, 228, 132);
  f.down('look', 2, { clientX: 500, clientY: 200 });
  f.down('fire', 3, { clientX: 650, clientY: 300 });
  f.move(2, 510, 194);
  f.move(3, 680, 330);
  let frame = f.input.consumeFrame();
  assert.ok(frame.moveX > 0 && frame.moveY > 0);
  assert.ok(Math.abs(Math.hypot(frame.moveX, frame.moveY) - 1) < 1e-10);
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.dx, 25);
  assert.equal(frame.dy, -15);
  f.end(1);
  f.move(2, 518, 199);
  frame = f.input.consumeFrame();
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 0);
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.dx, 20);
  assert.equal(frame.dy, 12.5);
  f.move(3, 650, 300);
  f.end(3);
  f.move(2, 514, 201);
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false, 'a fire drag cannot become a tap while another finger owns the camera');
  assert.equal(frame.dx, -10);
  assert.equal(frame.dy, 5);
  f.end(2);
  f.move(2, 700, 400);
  assertReleased(f.input);
});

test('a completed fire tap tolerates small jitter and emits exactly one pulse on release', t => {
  for (const jitter of [false, true]) {
    const f = fixture(t);
    const transitions = [];
    const touchButton = f.input.touchButton.bind(f.input);
    f.input.touchButton = (action, pressed) => {
      if (action === 'fire') transitions.push(pressed);
      touchButton(action, pressed);
    };
    f.down('fire', 4, { clientX: 600, clientY: 400, timeStamp: 1000 });
    assertReleased(f.input);
    if (jitter) {
      f.move(4, 603, 404, { timeStamp: 1100 });
      f.move(4, 606, 408, { timeStamp: 1200 });
      const frame = f.input.consumeFrame();
      assert.equal(frame.leftDown, false);
      assert.equal(frame.leftPressed, false);
      assert.equal(frame.dx, 15);
      assert.equal(frame.dy, 20);
    }
    assert.deepEqual(transitions, [], 'pointerdown and aiming moves cannot issue fire commands');
    f.end(4, 'pointerup', { timeStamp: 1300 });
    const frame = f.input.consumeFrame();
    assert.equal(frame.leftDown, false);
    assert.equal(frame.leftPressed, true, 'a tap at the duration and movement limits is accepted');
    assert.deepEqual(transitions, [true, false]);
    f.end(4);
    f.click('fire', 1);
    assert.deepEqual(transitions, [true, false], 'stale release and compatibility click cannot replay the tap');
    assertReleased(f.input);
  }
});

test('native zoom cancellation preserves every rapid fire tap, including with a second thumb held', t => {
  const zoomSource = readFileSync(new URL('../../src/core/touch-zoom.js', import.meta.url), 'utf8');
  for (const moving of [false, true]) {
    const f = fixture(t);
    runInNewContext(zoomSource, { document: f.doc });
    const fire = f.elements.get('fire');
    const move = { identifier: 1, clientX: 180, clientY: 140 };
    if (moving) {
      f.down('move', 1, move);
      f.move(1, 180, 92);
      emit(f.elements.get('move'), 'touchstart', { touches: [move], timeStamp: 0 });
    }
    for (let index = 0; index < 6; index++) {
      const contact = { identifier: index + 2, clientX: 600, clientY: 300 };
      const down = f.down('fire', contact.identifier, { ...contact, timeStamp: 100 + index * 100 });
      emit(fire, 'touchstart', { touches: moving ? [move, contact] : [contact], timeStamp: down.timeStamp });
      assert.equal(f.input.consumeFrame().leftPressed, false, 'contact alone cannot fire');
      const up = f.end(contact.identifier, 'pointerup', { timeStamp: down.timeStamp + 40 });
      const end = emit(fire.querySelector('span'), 'touchend', {
        touches: moving ? [move] : [], changedTouches: [contact], timeStamp: up.timeStamp, cancelable: true,
      });
      assert.equal(end.defaultPrevented, true, 'every game release must cancel native zoom');
      assert.equal(end.stopped, false, 'touch events can still reach other listeners');
      assert.equal(f.input.consumeFrame().leftPressed, true, 'each completed tap still fires');
      assert.equal(f.input.consumeFrame().leftPressed, false, 'the zoom guard cannot replay an attack');
      if (moving) assert.ok(f.input.consumeFrame().moveY > 0, 'the other thumb keeps moving');
    }
  }
});

test('fire rejects long holds and distant releases even when no pointermove was delivered', t => {
  for (const { reason, duration, dx, dy } of [
    { reason: 'held too long', duration: 301, dx: 0, dy: 0 },
    { reason: 'released too far away', duration: 100, dx: 10.01, dy: 0 },
    { reason: 'released diagonally outside the tap radius', duration: 100, dx: 8, dy: 8 },
  ]) {
    const f = fixture(t);
    f.down('fire', 4, { clientX: 600, clientY: 400, timeStamp: 1000 });
    assertReleased(f.input);
    f.end(4, 'pointerup', { clientX: 600 + dx, clientY: 400 + dy, timeStamp: 1000 + duration });
    const frame = f.input.consumeFrame();
    assert.equal(frame.leftDown, false, reason);
    assert.equal(frame.leftPressed, false, reason);
    f.click('fire', 1);
    assertReleased(f.input);
  }
});

test('dragging fire rotates the camera and cannot fire even after returning to the start', t => {
  const f = fixture(t);
  f.down('fire', 4, { clientX: 600, clientY: 400 });
  assertReleased(f.input);
  f.move(4, 620, 390);
  let frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.dx, 50);
  assert.equal(frame.dy, -25);
  f.move(4, 614, 396);
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.dx, -15);
  assert.equal(frame.dy, 15);
  f.move(4, 600, 400);
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.dx, -35);
  assert.equal(frame.dy, 10);
  f.end(4);
  f.move(4, 700, 500);
  f.click('fire', 1);
  assertReleased(f.input);
});

test('fire gestures cannot spend ammunition while aiming and a completed tap fires only once', t => {
  const f = fixture(t);
  const { Weapons, calls } = weaponHarness();
  Weapons.init();
  Weapons.restore({ current: 'machinegun', loaded: 3, reserve: 0 });
  const step = () => {
    Weapons.tick(1 / 60);
    Weapons.handleInput(f.input.consumeFrame(), 1 / 60);
  };
  f.down('fire', 1, { clientX: 600, clientY: 400 });
  step();
  assert.equal(Weapons.loaded, 3, 'contact cannot fire before the gesture is known');
  for (const [x, y] of [[620, 390], [640, 385], [600, 400]]) {
    f.move(1, x, y);
    step();
    assert.equal(Weapons.loaded, 3, 'targeting cannot fire');
  }
  f.end(1);
  step();
  assert.equal(Weapons.loaded, 3, 'a completed pan cannot fire');
  assert.equal(calls.shots.length, 0);
  f.down('fire', 1);
  step();
  assert.equal(Weapons.loaded, 3);
  f.end(1);
  step();
  assert.equal(Weapons.loaded, 2);
  assert.equal(calls.shots.length, 1);
  for (let frame = 0; frame < 60; frame++) step();
  assert.equal(Weapons.loaded, 2, 'the tap cannot leave an automatic weapon firing');
  assert.equal(calls.shots.length, 1);
});

test('releasing look or fire hands camera control to the other held finger without a jump', t => {
  for (const [owner, waiting] of [['look', 'fire'], ['fire', 'look']]) {
    const f = fixture(t);
    f.down(owner, 1, { clientX: 500, clientY: 200 });
    f.down(waiting, 2, { clientX: 600, clientY: 300 });
    f.move(1, 510, 210);
    f.move(2, 650, 340);
    let frame = f.input.consumeFrame();
    assert.equal(frame.dx, 25);
    assert.equal(frame.dy, 25);
    assert.equal(frame.leftPressed, false);
    f.end(1);
    f.move(2, 655, 336);
    frame = f.input.consumeFrame();
    assert.equal(frame.dx, 12.5, `${waiting} starts from its latest position`);
    assert.equal(frame.dy, -10, `${waiting} starts from its latest position`);
    assert.equal(frame.leftDown, false);
    assert.equal(frame.leftPressed, false);
    f.end(2);
    assertReleased(f.input);
  }
});

test('a second finger cannot steal or recenter an owned stick or complete another finger’s fire tap', t => {
  const f = fixture(t);
  f.down('move', 1, { clientX: 120, clientY: 230 });
  f.move(1, 120, 182);
  f.down('move', 2, { clientX: 170, clientY: 180 });
  f.move(2, 180, 228);
  f.end(2);
  let frame = f.input.consumeFrame();
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 1);
  assert.equal(f.elements.get('move').hasPointerCapture(1), true);
  assert.equal(f.elements.get('move').hasPointerCapture(2), false);
  assert.equal(f.elements.get('move').style.transform, 'translate(-60px, 50px)');
  f.move(1, 72, 230);
  frame = f.input.consumeFrame();
  assert.equal(frame.moveX, -1);
  assert.equal(Math.abs(frame.moveY), 0);
  f.down('fire', 3);
  assert.equal(f.input.consumeFrame().leftPressed, false);
  f.down('fire', 4);
  f.end(4);
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false);
  assert.equal(f.elements.get('fire').hasPointerCapture(3), true);
  assert.equal(f.elements.get('fire').hasPointerCapture(4), false);
  f.end(3);
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, true);
  f.down('fire', 5);
  assert.equal(f.input.consumeFrame().leftPressed, false);
  f.end(5);
  assert.equal(f.input.consumeFrame().leftPressed, true);
});

test('pointer release, cancellation, and lost capture clear held controls and ignore stale moves', t => {
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    const f = fixture(t);
    f.down('move', 1);
    f.move(1, 228, 180);
    f.down('look', 2);
    f.down('fire', 3);
    f.down('jump', 4);
    f.input.consumeFrame();
    for (const [pointerId, action] of [[1, 'move'], [2, 'look'], [3, 'fire'], [4, 'jump']]) {
      if (type === 'lostpointercapture') f.elements.get(action).releasePointerCapture(pointerId);
      else f.end(pointerId, type);
      assert.equal(f.elements.get(action).hasPointerCapture(pointerId), false, `${type}: ${action}`);
    }
    const frame = f.input.consumeFrame();
    assert.equal(frame.leftDown, false);
    assert.equal(frame.leftPressed, type === 'pointerup', `${type}: only a normal release completes the fire tap`);
    f.move(1, 250, 100);
    f.move(2, 300, 300);
    f.move(3, 300, 300);
    assertReleased(f.input);
    f.down('fire', 3);
    assertReleased(f.input);
    f.end(3);
    assert.equal(f.input.consumeFrame().leftPressed, true, `${type} frees the old owner for a fresh tap`);
  }
});

test('aim and stance toggles survive release, ignore compatibility clicks, and cancel safely', t => {
  const f = fixture(t, { context: { canAim: true } });
  f.down('aim');
  f.end(1);
  f.click('aim', 1);
  assert.equal(f.input.isAiming(), true);
  assert.equal(f.elements.get('aim').getAttribute('aria-pressed'), 'true');
  f.down('aim');
  f.end(1);
  assert.equal(f.input.isAiming(), false);
  f.down('sprint');
  f.end(1);
  assert.equal(f.input.consumeFrame().sprintDown, true);
  f.down('crouch');
  f.end(1);
  let frame = f.input.consumeFrame();
  assert.equal(frame.sprintDown, false);
  assert.equal(frame.crouchDown, true);
  assert.equal(f.elements.get('sprint').getAttribute('aria-pressed'), 'false');
  f.down('sprint');
  f.end(1);
  frame = f.input.consumeFrame();
  assert.equal(frame.sprintDown, true);
  assert.equal(frame.crouchDown, false);
  f.down('aim', 2);
  f.end(2, 'pointercancel');
  assert.equal(f.input.isAiming(), false);
  assert.equal(f.elements.get('aim').getAttribute('aria-pressed'), 'false');
  f.down('crouch', 3);
  f.elements.get('crouch').releasePointerCapture(3);
  assertReleased(f.input);
});

test('native keyboard or assistive clicks pulse actions once and support toggles', t => {
  const f = fixture(t, { context: { canAim: true, canRage: true } });
  for (const [action, edge] of [['fire', 'leftPressed'], ['jump', 'jumpPressed'], ['use', 'ePressed'], ['reload', 'rPressed'], ['melee', 'vPressed'], ['drop', 'gPressed'], ['rage', 'tPressed']]) {
    f.click(action);
    const frame = f.input.consumeFrame();
    assert.equal(frame[edge], true, action);
    assert.equal(frame.leftDown, false);
    assert.equal(frame.jumpDown, false);
    f.click(action, 1);
    assertReleased(f.input);
  }
  f.click('aim');
  assert.equal(f.input.isAiming(), true);
  f.click('aim');
  assert.equal(f.input.isAiming(), false);
  f.click('crouch');
  assert.equal(f.input.consumeFrame().crouchDown, true);
  f.click('sprint');
  const frame = f.input.consumeFrame();
  assert.equal(frame.sprintDown, true);
  assert.equal(frame.crouchDown, false);
});

test('pause only activates on a completed press or native click and clears gameplay input', t => {
  const f = fixture(t);
  f.down('fire', 1);
  f.down('pause', 2);
  assert.equal(f.input.active, true);
  f.end(2, 'pointercancel');
  assert.equal(f.pauses(), 0);
  f.down('pause', 2);
  f.end(2);
  assert.equal(f.pauses(), 1);
  assert.equal(f.input.active, false);
  assertReleased(f.input);
  f.controls.setActive(false);
  f.input.activate();
  f.controls.setActive(true);
  f.click('pause', 1);
  assert.equal(f.pauses(), 1);
  f.click('pause');
  assert.equal(f.pauses(), 2);
  assert.equal(f.input.active, false);
});

test('fire released while input is inactive is discarded and a fresh active tap still works', t => {
  const f = fixture(t);
  f.down('fire');
  f.input.pause();
  f.end(1);
  assertReleased(f.input);
  f.input.activate();
  f.end(1);
  assertReleased(f.input);
  f.down('fire');
  assertReleased(f.input);
  f.end(1);
  const frame = f.input.consumeFrame();
  assert.equal(frame.leftPressed, true);
  assert.equal(frame.leftDown, false);
});

test('reset, visibility changes, resize, rotation, and destruction clear touch state and ownership', t => {
  const resets = {
    reset: f => f.controls.reset(),
    disable: f => f.controls.setEnabled(false),
    pause: f => f.controls.setActive(false),
    resize: f => emit(f.viewport, 'resize'),
    rotation: f => emit(f.viewport, 'orientationchange'),
    destroy: f => f.destroy(),
  };
  for (const [reason, reset] of Object.entries(resets)) {
    const f = fixture(t, { context: { canAim: true } });
    f.down('move', 1, { clientX: 130, clientY: 220 });
    f.move(1, 178, 172);
    f.down('look', 2);
    f.move(2, 200, 160);
    f.down('fire', 3);
    f.down('jump', 4);
    f.down('aim', 5);
    f.end(5);
    f.down('sprint', 6);
    f.end(6);
    f.down('use', 7);
    reset(f);
    assertReleased(f.input);
    const zone = f.elements.get('move');
    const stick = zone.querySelector('.touch-stick');
    assert.equal(zone.style.transform, 'translate(0px, 0px)', `${reason}: resets the visual center and activation area`);
    assert.deepEqual(zone.getBoundingClientRect(), { left: 100, top: 100, width: 160, height: 160 });
    assert.equal(stick.querySelector('.touch-stick-thumb').style.transform, 'translate(-50%, -50%)');
    for (const element of f.elements.values()) {
      assert.equal(element.captures.size, 0, `${reason}: no pointer remains captured`);
      assert.equal(element.dataset.pressed, 'false', `${reason}: no control remains pressed`);
    }
    for (const action of ['aim', 'sprint', 'crouch']) assert.equal(f.elements.get(action).getAttribute('aria-pressed'), 'false', reason);
    if (reason === 'disable' || reason === 'pause') {
      assert.equal(f.controls.element.hidden, true);
      assert.equal(f.doc.body.dataset.touchControls, 'false');
    }
    if (reason === 'destroy') {
      assert.equal(f.doc.body.contains(f.controls.element), false);
      f.down('fire', 8);
      assertReleased(f.input);
      continue;
    }
    f.controls.setEnabled(true);
    f.controls.setActive(true);
    f.move(1, 150, 100);
    f.move(2, 300, 400);
    f.end(3);
    assertReleased(f.input);
    f.down('move', 8, { clientX: 210, clientY: 160 });
    assertReleased(f.input);
    assert.equal(zone.style.transform, 'translate(30px, -20px)', `${reason}: the next touch starts from the reset offset`);
    f.end(8);
    f.down('fire', 3);
    assertReleased(f.input);
    f.end(3);
    assert.equal(f.input.consumeFrame().leftPressed, true, `${reason}: fresh taps work after reset`);
  }
});

test('motion fire starts on contact, stays held through jitter, and stops once on release', t => {
  const f = fixture(t, { motion: true });
  f.click('motion');
  const transitions = [];
  const touchButton = f.input.touchButton.bind(f.input);
  f.input.touchButton = (action, pressed) => {
    if (action === 'fire') transitions.push(pressed);
    touchButton(action, pressed);
  };
  f.down('fire', 4, { clientX: 600, clientY: 400, timeStamp: 1000 });
  let frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, true);
  f.move(4, 603, 404, { timeStamp: 1100 });
  f.move(4, 606, 408, { timeStamp: 1200 });
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.dx, 0);
  assert.equal(frame.dy, 0);
  assert.deepEqual(transitions, [true]);
  f.end(4, 'pointerup', { timeStamp: 1300 });
  assertReleased(f.input);
  assert.deepEqual(transitions, [true, false]);
  f.end(4);
  f.click('fire', 1);
  assert.deepEqual(transitions, [true, false], 'stale release and compatibility click cannot replay the attack');
  assertReleased(f.input);
});

test('motion long fire holds and distant releases keep firing until release without moving the camera', t => {
  const f = fixture(t, { motion: true });
  f.click('motion');
  f.down('fire', 4, { clientX: 600, clientY: 400, timeStamp: 1000 });
  let frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, true);
  for (const [x, y] of [[620, 390], [614, 396], [600, 400]]) {
    f.move(4, x, y, { timeStamp: 3000 });
    frame = f.input.consumeFrame();
    assert.equal(frame.leftDown, true);
    assert.equal(frame.leftPressed, false);
    assert.equal(frame.dx, 0);
    assert.equal(frame.dy, 0);
  }
  f.end(4, 'pointerup', { clientX: 100, clientY: 100, timeStamp: 5000 });
  f.move(4, 700, 500);
  f.click('fire', 1);
  assertReleased(f.input);
});

test('motion canceling fire before the next frame discards its pending edge while preserving other actions', t => {
  for (const type of ['pointercancel', 'lostpointercapture']) {
    const f = fixture(t, { motion: true });
    f.click('motion');
    f.down('fire', 1);
    f.down('jump', 2);
    if (type === 'lostpointercapture') f.elements.get('fire').releasePointerCapture(1);
    else f.end(1, type);
    const frame = f.input.consumeFrame();
    assert.equal(frame.leftDown, false, type);
    assert.equal(frame.leftPressed, false, type);
    assert.equal(frame.jumpDown, true, 'the other held finger survives');
    assert.equal(frame.jumpPressed, true, 'the other pending action survives');
    f.end(1);
    f.end(2);
    assertReleased(f.input);
  }
});

function assertAimMode(f, mode) {
  const motion = mode === 'motion';
  assert.equal(f.controls.element.dataset.aimMode, mode);
  assert.equal(f.elements.get('look').hidden, motion, 'only touch mode shows the swipe area');
  assert.equal(f.elements.get('recenter').hidden, !motion, 'only motion mode shows recenter');
  assert.match(f.elements.get('fire').getAttribute('aria-label'), motion ? /hold/i : /drag/i);
}

test('permission is requested from a completed gesture and changes the UI only after being granted', async t => {
  let grant;
  let requests = 0;
  const f = fixture(t, { motion: {
    requestPermission() {
      requests++;
      return new Promise(resolve => { grant = resolve; });
    },
  } });
  assertAimMode(f, 'touch');
  f.down('motion', 1);
  assert.equal(requests, 0, 'contact does not request access');
  f.end(1, 'pointercancel');
  assert.equal(requests, 0, 'canceled presses do not request access');
  f.down('look', 2, { clientX: 500, clientY: 200 });
  f.down('motion', 1);
  f.end(1);
  assert.equal(requests, 1, 'permission is requested synchronously inside pointerup');
  assert.equal(f.controls.element.dataset.motionAim, 'requesting');
  assert.equal(f.elements.get('motion').getAttribute('aria-pressed'), 'true');
  assertAimMode(f, 'touch');
  assert.equal(f.elements.get('look').hasPointerCapture(2), true, 'waiting for consent does not cancel the current swipe');
  f.move(2, 510, 194);
  let frame = f.input.consumeFrame();
  assert.equal(frame.dx, 25);
  assert.equal(frame.dy, -15);
  f.click('motion', 1);
  assert.equal(requests, 1, 'compatibility clicks do not repeat permission requests');
  grant('granted');
  await Promise.resolve();
  assert.equal(f.controls.element.dataset.motionAim, 'waiting');
  assertAimMode(f, 'motion');
  assert.equal(f.elements.get('look').hasPointerCapture(2), false, 'granting motion cancels the old swipe');
  f.move(2, 520, 188);
  f.down('look', 3);
  f.move(3, 240, 220);
  assert.equal(f.elements.get('look').hasPointerCapture(3), false);
  assertReleased(f.input);
  f.down('move', 4, { clientX: 140, clientY: 210 });
  f.move(4, 188, 210);
  f.down('fire', 5);
  f.orient();
  assert.equal(f.controls.element.dataset.motionAim, 'active');
  assertAimMode(f, 'motion');
  f.orient(0, 4, 2);
  frame = f.input.consumeFrame();
  assert.equal(frame.moveX, 1);
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, true);
  assert.ok(Number.isFinite(frame.dx) && Math.abs(frame.dx) > 0);
  assert.ok(Number.isFinite(frame.dy) && Math.abs(frame.dy) > 0);
  f.move(5, 400, 300);
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, true);
  assert.equal(frame.dx, 0, 'fire drag cannot add camera input');
  assert.equal(frame.dy, 0);
});

test('granting motion discards old fire gestures, queued shots, and queued touch look while retaining other actions', async t => {
  for (const pending of ['tap', 'pan']) {
    let grant;
    const f = fixture(t, { motion: {
      requestPermission: () => new Promise(resolve => { grant = resolve; }),
    } });
    f.down('move', 1);
    f.move(1, 228, 180);
    f.down('jump', 2);
    f.down('fire', 3, { clientX: 600, clientY: 400 });
    if (pending === 'tap') {
      f.end(3);
      f.down('look', 4, { clientX: 500, clientY: 200 });
      f.move(4, 520, 210);
      f.down('fire', 3);
    } else {
      f.move(3, 620, 410);
      f.down('look', 4);
    }
    f.click('motion');
    assertAimMode(f, 'touch');
    assert.equal(f.elements.get('fire').hasPointerCapture(3), true);
    assert.equal(f.elements.get('look').hasPointerCapture(4), true);
    grant('granted');
    await Promise.resolve();
    assertAimMode(f, 'motion');
    assert.equal(f.elements.get('fire').hasPointerCapture(3), false, pending);
    assert.equal(f.elements.get('look').hasPointerCapture(4), false, pending);
    assert.equal(f.elements.get('fire').dataset.pressed, 'false', pending);
    const frame = f.input.consumeFrame();
    assert.equal(frame.dx, 0, 'the frame cannot consume touch look queued before consent');
    assert.equal(frame.dy, 0);
    assert.equal(frame.leftDown, false);
    assert.equal(frame.leftPressed, false, 'a queued touch-mode tap cannot fire in motion mode');
    assert.equal(frame.moveX, 1, 'movement survives a mode change');
    assert.equal(frame.jumpDown, true, 'held actions survive a mode change');
    assert.equal(frame.jumpPressed, true, 'pending non-fire actions survive a mode change');
    f.end(1);
    f.end(2);
    f.move(3, 630, 420);
    f.move(4, 230, 220);
    f.end(3);
    f.end(4);
    f.click('fire', 1);
    assertReleased(f.input);
    f.down('fire', 5);
    f.move(5, 250, 250);
    const fresh = f.input.consumeFrame();
    assert.equal(fresh.leftDown, true, 'a fresh motion-mode press starts firing');
    assert.equal(fresh.leftPressed, true);
    assert.equal(fresh.dx, 0);
    assert.equal(fresh.dy, 0);
  }
});

test('requesting and denying permission preserve an in-progress combined fire tap and swipe', async t => {
  let deny;
  const f = fixture(t, { motion: {
    requestPermission: () => new Promise(resolve => { deny = resolve; }),
  } });
  f.down('fire', 1, { clientX: 600, clientY: 400, timeStamp: 1000 });
  f.down('look', 2, { clientX: 500, clientY: 200 });
  f.click('motion');
  assertAimMode(f, 'touch');
  f.move(1, 606, 408);
  let frame = f.input.consumeFrame();
  assert.equal(frame.dx, 15, 'combined aiming remains active while consent is pending');
  assert.equal(frame.dy, 20);
  assert.equal(frame.leftDown, false);
  assert.equal(frame.leftPressed, false);
  deny('denied');
  await Promise.resolve();
  assert.equal(f.controls.element.dataset.motionAim, 'denied');
  assertAimMode(f, 'touch');
  assert.equal(f.elements.get('fire').hasPointerCapture(1), true);
  assert.equal(f.elements.get('look').hasPointerCapture(2), true);
  f.end(1, 'pointerup', { timeStamp: 1300 });
  frame = f.input.consumeFrame();
  assert.equal(frame.leftPressed, true, 'denial does not discard the original tap');
  assert.equal(frame.leftDown, false);
  f.move(2, 510, 194);
  frame = f.input.consumeFrame();
  assert.equal(frame.dx, 25, 'the original swipe can take over after the fire finger lifts');
  assert.equal(frame.dy, -15);
});

test('unavailable or denied motion keeps the original combined fire and touch-aiming UI', async t => {
  for (const { label, options, status, timeout } of [
    { label: 'no sensor', options: {}, status: 'unavailable' },
    { label: 'insecure context', options: { motion: true, secureContext: false }, status: 'unavailable' },
    { label: 'permission denied', options: { motion: { requestPermission: () => Promise.resolve('denied') } }, status: 'denied' },
    { label: 'permission rejected', options: { motion: { requestPermission: () => Promise.reject(new Error('not allowed')) } }, status: 'denied' },
    { label: 'sensor never reports', options: { motion: true }, status: 'unavailable', timeout: true },
  ]) {
    const f = fixture(t, options);
    f.click('motion');
    await Promise.resolve();
    if (timeout) f.runTimers();
    assert.equal(f.controls.element.dataset.motionAim, status, label);
    assert.equal(f.elements.get('motion').getAttribute('aria-pressed'), 'false', label);
    assertAimMode(f, 'touch');
    f.down('look', 1, { clientX: 500, clientY: 200 });
    f.move(1, 510, 194);
    let frame = f.input.consumeFrame();
    assert.equal(frame.dx, 25, label);
    assert.equal(frame.dy, -15, label);
    assert.equal(frame.leftPressed, false, label);
    f.end(1);
    f.down('fire', 2, { clientX: 600, clientY: 400 });
    f.move(2, 620, 410);
    frame = f.input.consumeFrame();
    assert.equal(frame.dx, 50, 'the original combined control still aims');
    assert.equal(frame.dy, 25);
    assert.equal(frame.leftDown, false, label);
    assert.equal(frame.leftPressed, false, label);
    f.end(2);
    assertReleased(f.input);
    f.down('fire', 3);
    assertReleased(f.input);
    f.end(3);
    frame = f.input.consumeFrame();
    assert.equal(frame.leftDown, false);
    assert.equal(frame.leftPressed, true, 'a completed tap still fires once');
  }
});

test('switching out of motion cancels held or queued fire and restores combined aiming only for fresh touches', t => {
  for (const fallback of ['disable', 'timeout']) {
    for (const released of [false, true]) {
      const f = fixture(t, { motion: true });
      f.click('motion');
      assertAimMode(f, 'motion');
      if (fallback === 'disable') {
        f.orient();
        f.orient(0, 4, 2);
      }
      f.down('move', 1);
      f.move(1, 228, 180);
      f.down('jump', 2);
      f.down('fire', 3);
      if (released) f.end(3);
      if (fallback === 'disable') f.click('motion');
      else f.runTimers();
      assert.equal(f.controls.element.dataset.motionAim, fallback === 'disable' ? 'off' : 'unavailable');
      assertAimMode(f, 'touch');
      assert.equal(f.elements.get('fire').hasPointerCapture(3), false);
      let frame = f.input.consumeFrame();
      assert.equal(frame.leftDown, false);
      assert.equal(frame.leftPressed, false, 'switching cannot replay a queued shot');
      assert.equal(frame.dx, 0, 'queued motion delta cannot leak into the restored touch mode');
      assert.equal(frame.dy, 0);
      assert.equal(frame.moveX, 1);
      assert.equal(frame.jumpDown, true);
      assert.equal(frame.jumpPressed, true);
      f.end(1);
      f.end(2);
      f.move(3, 250, 250);
      f.end(3);
      f.click('fire', 1);
      f.orient(90, 30, 40);
      assertReleased(f.input);
      f.down('fire', 4, { clientX: 500, clientY: 200 });
      f.move(4, 520, 190);
      frame = f.input.consumeFrame();
      assert.equal(frame.dx, 50, 'fresh combined-control drags aim again');
      assert.equal(frame.dy, -25);
      assert.equal(frame.leftDown, false);
      assert.equal(frame.leftPressed, false);
      f.end(4);
      assertReleased(f.input);
      f.down('fire', 5);
      assertReleased(f.input);
      f.end(5);
      assert.equal(f.input.consumeFrame().leftPressed, true, 'fresh taps use the original release behavior');
    }
  }
});

test('motion fire operates automatic weapons while touch drags remain disabled before and after calibration', t => {
  const f = fixture(t, { motion: true });
  const { Weapons, calls } = weaponHarness();
  Weapons.init();
  Weapons.restore({ current: 'machinegun', loaded: 20, reserve: 0 });
  const step = () => {
    Weapons.tick(1 / 60);
    const frame = f.input.consumeFrame();
    assert.equal(frame.dx, 0, 'touch cannot move the camera in motion mode');
    assert.equal(frame.dy, 0);
    Weapons.handleInput(frame, 1 / 60);
  };
  f.click('motion');
  f.down('look', 1);
  f.move(1, 250, 250);
  step();
  assert.equal(Weapons.loaded, 20);
  assert.equal(calls.shots.length, 0);
  f.down('fire', 2);
  f.move(2, 250, 250);
  step();
  assert.equal(Weapons.loaded, 19, 'dedicated fire starts on contact during sensor calibration');
  f.orient();
  for (let frame = 0; frame < 30; frame++) step();
  assert.ok(Weapons.loaded < 19, 'holding fire repeats automatic shots');
  f.end(2);
  const remaining = Weapons.loaded;
  const shotCount = calls.shots.length;
  for (let frame = 0; frame < 60; frame++) step();
  assert.equal(Weapons.loaded, remaining, 'releasing fire stops automatic shots');
  assert.equal(calls.shots.length, shotCount);
});

test('recenter keeps motion UI and disables touch aiming while holding fire through a fresh baseline', t => {
  const f = fixture(t, { motion: true });
  f.click('motion');
  f.orient();
  f.orient(0, 3, 2);
  assert.ok(Math.abs(f.input.consumeFrame().dx) > 0);
  f.down('recenter', 1);
  f.down('fire', 2);
  f.orient(0, 30, 30);
  let frame = f.input.consumeFrame();
  assert.equal(frame.dx, 0);
  assert.equal(frame.dy, 0);
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, true);
  f.end(1);
  assert.equal(f.controls.element.dataset.motionAim, 'waiting');
  assertAimMode(f, 'motion');
  f.down('look', 3);
  f.move(3, 250, 250);
  f.move(2, 250, 250);
  frame = f.input.consumeFrame();
  assert.equal(frame.dx, 0, 'touch remains disabled while recenter is waiting for a sample');
  assert.equal(frame.dy, 0);
  assert.equal(frame.leftDown, true, 'recenter is not a mode change and cannot cancel held fire');
  assert.equal(frame.leftPressed, false);
  assert.equal(f.elements.get('fire').hasPointerCapture(2), true);
  assert.equal(f.elements.get('look').hasPointerCapture(3), false);
  f.orient(0, 45, 40);
  frame = f.input.consumeFrame();
  assert.equal(frame.dx, 0, 'the release position establishes a new baseline');
  assert.equal(frame.dy, 0);
  assert.equal(frame.leftDown, true);
  f.orient(0, 46, 41);
  frame = f.input.consumeFrame();
  assert.ok(Math.abs(frame.dx) + Math.abs(frame.dy) > 0, 'aim follows movement after recalibration');
  f.end(2);
  f.click('recenter');
  assertAimMode(f, 'motion');
  f.orient(120, 10, 10);
  assertReleased(f.input);
  assert.equal(f.controls.element.dataset.motionAim, 'active');
});

test('motion pause and resume keep touch aiming disabled and establish a fresh sensor baseline', t => {
  const f = fixture(t, { motion: true });
  f.click('motion');
  f.orient();
  f.orient(0, 5, 0);
  assert.ok(Math.abs(f.input.consumeFrame().dy) > 0);
  f.input.pause();
  f.controls.setActive(false);
  f.orient(100, 40, 40);
  assertReleased(f.input);
  assert.equal(f.elements.get('motion').getAttribute('aria-pressed'), 'true');
  f.input.activate();
  f.controls.setActive(true);
  assert.equal(f.controls.element.dataset.motionAim, 'waiting');
  assertAimMode(f, 'motion');
  f.down('look', 1);
  f.move(1, 250, 250);
  f.down('fire', 2);
  f.move(2, 250, 250);
  let frame = f.input.consumeFrame();
  assert.equal(frame.dx, 0, 'waiting for a resumed sensor never enables touch aiming');
  assert.equal(frame.dy, 0);
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, true);
  f.end(2);
  f.orient(160, 50, 50);
  assertReleased(f.input);
  assert.equal(f.controls.element.dataset.motionAim, 'active');
  f.orient(161, 50, 50);
  frame = f.input.consumeFrame();
  assert.ok(Math.abs(frame.dx) + Math.abs(frame.dy) > 0);
  f.controls.setEnabled(false);
  assert.equal(f.controls.element.dataset.motionAim, 'off');
  f.controls.setEnabled(true);
  f.orient(170, 60, 60);
  assertReleased(f.input);
  assertAimMode(f, 'touch');
});

test('disabling motion while permission is pending preserves touch input and ignores a late grant', async t => {
  let grant;
  const f = fixture(t, { motion: {
    requestPermission: () => new Promise(resolve => { grant = resolve; }),
  } });
  f.down('look', 1, { clientX: 500, clientY: 200 });
  f.click('motion');
  assert.equal(f.controls.element.dataset.motionAim, 'requesting');
  assertAimMode(f, 'touch');
  f.click('motion');
  assert.equal(f.controls.element.dataset.motionAim, 'off');
  assertAimMode(f, 'touch');
  assert.equal(f.elements.get('look').hasPointerCapture(1), true, 'canceling the permission request does not change input modes');
  grant('granted');
  await Promise.resolve();
  f.orient();
  f.orient(40, 30, 20);
  assertReleased(f.input);
  assert.equal(f.controls.element.dataset.motionAim, 'off');
  assert.equal(f.elements.get('motion').getAttribute('aria-pressed'), 'false');
  assertAimMode(f, 'touch');
  f.move(1, 510, 194);
  const frame = f.input.consumeFrame();
  assert.equal(frame.dx, 25);
  assert.equal(frame.dy, -15);
});
