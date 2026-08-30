import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputState } from '../../src/core/input-state.js';
import { createTouchControls } from '../../src/ui/touch-controls.js';

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
    detail: 1, defaultPrevented: false, stopped: false,
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
  getBoundingClientRect() { return { left: 100, top: 100, width: 160, height: 160 }; }
  setPointerCapture(pointerId) { this.captures.add(pointerId); }
  hasPointerCapture(pointerId) { return this.captures.has(pointerId); }
  releasePointerCapture(pointerId) {
    if (this.captures.delete(pointerId)) emit(this, 'lostpointercapture', { pointerId });
  }
}

function fixture(t, { enabled = true, active = true, context } = {}) {
  const viewport = new EventTarget();
  const doc = { body: new Element('body'), createElement: name => new Element(name) };
  doc.body.parentNode = viewport;
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
  let destroyed = false;
  const destroy = () => { if (!destroyed) { controls.destroy(); destroyed = true; } };
  t.after(destroy);
  return {
    input, controls, viewport, doc, elements, destroy, pauses: () => pauses,
    down(action, pointerId = 1, properties = {}) { return emit(elements.get(action), 'pointerdown', { pointerId, ...properties }); },
    move(pointerId, clientX, clientY) { return emit(viewport, 'pointermove', { pointerId, clientX, clientY }); },
    end(pointerId, type = 'pointerup') { return emit(viewport, type, { pointerId }); },
    click(action, detail = 0) { return emit(elements.get(action).querySelector('span'), 'click', { detail }); },
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
  assert.equal(f.input.consumeFrame().leftDown, true);
  f.end(1);
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
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, true);
  assert.equal(frame.dx, 20);
  assert.equal(frame.dy, -10);
  f.controls.setContext({ canAim: true });
  assert.equal(f.input.isAiming(), false, 'equipping another firearm cannot revive the old toggle');
  f.click('aim');
  assert.equal(f.input.isAiming(), true);
  f.controls.setContext({ canAim: false });
  frame = f.input.consumeFrame();
  assert.equal(frame.aimDown, false, 'context loss also clears a toggle whose pointer was already released');
  assert.equal(frame.leftDown, true);
});

test('losing rage eligibility discards a pending press without allowing stale pointers to replay it', t => {
  for (const released of [false, true]) {
    const f = fixture(t, { context: { canRage: true } });
    f.down('rage', 1);
    if (released) f.end(1);
    f.down('fire', 2);
    f.controls.setContext({ canRage: false });
    assert.equal(f.elements.get('rage').hidden, true);
    assert.equal(f.elements.get('rage').disabled, true);
    assert.equal(f.elements.get('rage').hasPointerCapture(1), false);
    f.click('rage');
    const frame = f.input.consumeFrame();
    assert.equal(frame.tPressed, false, `pending ${released ? 'tap' : 'hold'} was canceled`);
    assert.equal(frame.leftPressed, true, 'other pending touch actions survive');
    assert.equal(frame.leftDown, true);
    f.controls.setContext({ canRage: true });
    f.end(1);
    f.click('rage', 1);
    assert.equal(f.input.consumeFrame().tPressed, false, 'stale release and compatibility click cannot reactivate rage');
    f.down('rage', 1);
    assert.equal(f.input.consumeFrame().tPressed, true, 'a fresh available press is accepted');
    assert.equal(f.input.consumeFrame().tPressed, false);
  }
});

test('movement, look, and fire pointers stay independent while held and released', t => {
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
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, true);
  assert.equal(frame.dx, 25);
  assert.equal(frame.dy, -15);
  f.end(1);
  f.move(2, 518, 199);
  frame = f.input.consumeFrame();
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 0);
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.dx, 20);
  assert.equal(frame.dy, 12.5);
  f.end(3);
  f.move(2, 514, 201);
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, false);
  assert.equal(frame.dx, -10);
  assert.equal(frame.dy, 5);
  f.end(2);
  f.move(2, 700, 400);
  assertReleased(f.input);
});

test('dragging held fire rotates the camera without repeating the attack edge', t => {
  const f = fixture(t);
  f.down('fire', 4, { clientX: 600, clientY: 400 });
  f.move(4, 620, 390);
  let frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, true);
  assert.equal(frame.dx, 50);
  assert.equal(frame.dy, -25);
  f.move(4, 614, 396);
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, false);
  assert.equal(frame.dx, -15);
  assert.equal(frame.dy, 15);
  f.end(4);
  f.move(4, 700, 500);
  f.click('fire', 1);
  assertReleased(f.input);
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
    assert.equal(frame.leftPressed, true);
    f.end(1);
    f.move(2, 655, 336);
    frame = f.input.consumeFrame();
    assert.equal(frame.dx, 12.5, `${waiting} starts from its latest position`);
    assert.equal(frame.dy, -10, `${waiting} starts from its latest position`);
    assert.equal(frame.leftDown, waiting === 'fire');
    assert.equal(frame.leftPressed, false);
    f.end(2);
    assertReleased(f.input);
  }
});

test('a second finger cannot steal an owned stick or release an owned fire button', t => {
  const f = fixture(t);
  f.down('move', 1);
  f.move(1, 180, 132);
  f.down('move', 2, { clientX: 228, clientY: 180 });
  f.move(2, 180, 228);
  f.end(2);
  let frame = f.input.consumeFrame();
  assert.equal(frame.moveX, 0);
  assert.equal(frame.moveY, 1);
  assert.equal(f.elements.get('move').hasPointerCapture(1), true);
  assert.equal(f.elements.get('move').hasPointerCapture(2), false);
  f.move(1, 132, 180);
  frame = f.input.consumeFrame();
  assert.equal(frame.moveX, -1);
  assert.equal(Math.abs(frame.moveY), 0);
  f.down('fire', 3);
  assert.equal(f.input.consumeFrame().leftPressed, true);
  f.down('fire', 4);
  f.end(4);
  frame = f.input.consumeFrame();
  assert.equal(frame.leftDown, true);
  assert.equal(frame.leftPressed, false);
  f.end(3);
  assert.equal(f.input.consumeFrame().leftDown, false);
  f.down('fire', 5);
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
    f.move(1, 250, 100);
    f.move(2, 300, 300);
    f.move(3, 300, 300);
    assertReleased(f.input);
    f.down('fire', 3);
    assert.equal(f.input.consumeFrame().leftPressed, true, `${type} frees the old owner`);
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
    f.down('move', 1);
    f.move(1, 228, 132);
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
    f.down('fire', 3);
    assert.equal(f.input.consumeFrame().leftPressed, true, `${reason}: fresh presses work after reset`);
  }
});
