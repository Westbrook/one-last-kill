import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../src/core/touch-zoom.js', import.meta.url), 'utf8');

class Element {
  constructor(tagName, { parent = null, id = '', type = '', href = '', disabled = false } = {}) {
    Object.assign(this, { tagName, parentNode: parent, id, type, href, disabled });
    this.hidden = false;
    this.checked = false;
    this.clicks = [];
    this.focuses = [];
    this.programmaticClicks = 0;
  }
  matches(selector) {
    if (selector === ':disabled') return this.disabled;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector === 'a[href]') return this.tagName === 'a' && Boolean(this.href);
    const input = /^input\[type="([^"]+)"\]$/.exec(selector);
    if (input) return this.tagName === 'input' && this.type === input[1];
    return this.tagName === selector;
  }
  closest(selector) {
    if (selector.split(',').some(part => this.matches(part.trim()))) return this;
    return this.parentNode?.closest(selector) ?? null;
  }
  focus(options) { this.focuses.push({ ...options }); }
  activate(origin) {
    if (this.disabled) return;
    this.clicks.push(origin);
    if (this.tagName === 'input' && this.type === 'checkbox') this.checked = !this.checked;
    if (this.tagName === 'input' && this.type === 'radio') this.checked = true;
    if (this.tagName === 'label') this.control?.activate(origin);
    this.onClick?.();
  }
  click() { this.programmaticClicks++; this.activate('synthetic'); }
}

function touch(identifier = 1, clientX = 40, clientY = 60) {
  return { identifier, clientX, clientY };
}

// Run the actual standalone script with only its document dependency. The
// fixture models cancelable/passive dispatch and the browser's compatibility
// click so a fallback cannot silently lose or duplicate a menu activation.
function fixture() {
  const listeners = new Map();
  const document = {
    addEventListener(type, handler, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ handler, options: { ...options } });
    },
  };
  runInNewContext(source, { document }, { filename: 'src/core/touch-zoom.js' });
  function emit(type, target, properties = {}) {
    const event = {
      type, target, timeStamp: 0, touches: [], changedTouches: [], cancelable: true,
      defaultPrevented: false, preventionCalls: 0, propagationStopped: false,
      preventDefault() {
        this.preventionCalls++;
        if (this.cancelable && !this.passiveListener) this.defaultPrevented = true;
      },
      stopPropagation() { this.propagationStopped = true; },
      ...properties,
    };
    const ordered = [...(listeners.get(type) ?? [])].sort((a, b) => Number(Boolean(b.options.capture)) - Number(Boolean(a.options.capture)));
    for (const { handler, options } of ordered) {
      event.passiveListener = options.passive;
      handler(event);
    }
    delete event.passiveListener;
    return event;
  }
  function start(target, at, contact = touch(), properties = {}) {
    return emit('touchstart', target, { timeStamp: at, touches: [contact], changedTouches: [contact], ...properties });
  }
  function end(target, at, contact = touch(), properties = {}) {
    const event = emit('touchend', target, { timeStamp: at, changedTouches: [contact], ...properties });
    // Native form activation is a platform behavior, not part of the guard.
    if (!event.defaultPrevented) target.closest('button, a[href], label, input, select, summary')?.activate('native');
    return event;
  }
  function tap(target, at, { duration = 30, contact = touch(), ...properties } = {}) {
    start(target, at, contact);
    return end(target, at + duration, contact, properties);
  }
  return { listeners, document, emit, start, end, tap };
}

test('zoom cancellation is installed in non-passive document capture listeners', () => {
  const h = fixture();
  for (const type of ['touchend', 'dblclick']) {
    assert.equal(h.listeners.get(type).length, 1);
    assert.deepEqual(h.listeners.get(type)[0].options, { capture: true, passive: false });
  }
  for (const type of ['touchstart', 'touchmove', 'touchcancel', 'scroll']) {
    assert.deepEqual(h.listeners.get(type)[0].options, { capture: true, passive: true });
  }
  let observed;
  h.document.addEventListener('touchend', event => { observed = event.defaultPrevented; });
  const canvas = new Element('canvas', { id: 'game' });
  const event = h.tap(canvas, 100);
  assert.equal(observed, true, 'later listeners observe cancellation');
  assert.equal(event.propagationStopped, false, 'game input and other handlers still receive the release');
});

test('repeated and triple taps on different nested menu targets activate each action exactly once', () => {
  const h = fixture();
  const first = new Element('button'), second = new Element('button'), third = new Element('button');
  const firstLabel = new Element('span', { parent: first });
  const secondIcon = new Element('path', { parent: new Element('svg', { parent: second }) });
  const thirdLabel = new Element('span', { parent: third });
  assert.equal(h.tap(firstLabel, 0).defaultPrevented, false, 'the first tap uses native activation');
  assert.equal(h.tap(secondIcon, 150, { contact: touch(2, 300, 100) }).defaultPrevented, true);
  assert.equal(h.tap(thirdLabel, 300, { contact: touch(3, 150, 400) }).defaultPrevented, true);
  assert.deepEqual(first.clicks, ['native']);
  assert.deepEqual(second.clicks, ['synthetic']);
  assert.deepEqual(third.clicks, ['synthetic']);
  assert.equal(first.programmaticClicks, 0);
  assert.equal(second.programmaticClicks, 1);
  assert.equal(third.programmaticClicks, 1);
  assert.deepEqual(second.focuses, [{ preventScroll: true }]);
});

test('separated taps remain native and repeated taps on noninteractive content are canceled', () => {
  const h = fixture();
  const button = new Element('button');
  assert.equal(h.tap(button, 100).defaultPrevented, false);
  assert.equal(h.tap(button, 900).defaultPrevented, false);
  assert.deepEqual(button.clicks, ['native', 'native']);
  const copy = new Element('p');
  assert.equal(h.tap(copy, 1000).defaultPrevented, true);
  assert.equal(copy.programmaticClicks, 0);
  assert.deepEqual(copy.focuses, []);
});

test('canvas and nested touch controls cancel every release without synthesizing actions', () => {
  for (const target of [new Element('canvas', { id: 'game' }), new Element('span', {
    parent: new Element('button', { parent: new Element('div', { id: 'touch-controls' }) }),
  })]) {
    const h = fixture();
    for (const at of [100, 200, 300]) {
      const event = h.tap(target, at);
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.propagationStopped, false);
    }
    const button = target.closest('button');
    if (button) {
      assert.deepEqual(button.clicks, []);
      assert.equal(button.programmaticClicks, 0, 'a detail=0 click would replay pointer-driven FIRE');
      assert.deepEqual(button.focuses, []);
    }
  }
});

test('a held second thumb and controls hidden by PAUSE cannot escape release cancellation', () => {
  const h = fixture();
  const controls = new Element('div', { id: 'touch-controls' });
  const pause = new Element('button', { parent: controls });
  const label = new Element('span', { parent: pause });
  const first = touch(1), second = touch(2, 300, 200);
  h.start(label, 100, first, { touches: [first, second] });
  controls.hidden = true; // pointerup can hide the control before touchend arrives.
  const event = h.end(label, 150, first, { touches: [second] });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.end(label, 200, second).defaultPrevented, true);
  assert.equal(h.end(label, 900).defaultPrevented, true, 'untracked releases on game surfaces remain owned by the game');
  assert.deepEqual(pause.clicks, []);
  assert.equal(pause.programmaticClicks, 0);
});

test('a drag that returns to its start does not replay a menu action or prime the next tap', () => {
  const h = fixture();
  const button = new Element('button');
  h.tap(button, 0);
  h.start(button, 100);
  h.emit('touchmove', button, { timeStamp: 120, touches: [touch(1, 80, 60)] });
  h.emit('touchmove', button, { timeStamp: 140, touches: [touch()] });
  assert.equal(h.end(button, 160).defaultPrevented, false);
  assert.equal(h.tap(button, 180).defaultPrevented, false);
  assert.equal(button.programmaticClicks, 0);
});

test('long presses and release displacement cannot be replayed as completed taps', () => {
  for (const gesture of ['hold', 'displacement']) {
    const h = fixture();
    const button = new Element('button');
    h.tap(button, 0);
    h.start(button, 100);
    const endedAt = gesture === 'hold' ? 700 : 150;
    const contact = gesture === 'hold' ? touch() : touch(1, 90, 60);
    assert.equal(h.end(button, endedAt, contact).defaultPrevented, false);
    assert.equal(h.tap(button, endedAt + 40).defaultPrevented, false);
    assert.equal(button.programmaticClicks, 0);
  }
});

test('touch cancellation, panel scrolling and visibility changes clear repeated-tap state', () => {
  for (const type of ['touchcancel', 'scroll', 'visibilitychange']) {
    const h = fixture();
    const button = new Element('button');
    h.tap(button, 0);
    h.start(button, 100);
    h.emit(type, button, { timeStamp: 120 });
    assert.equal(h.end(button, 140).defaultPrevented, false, type);
    assert.equal(h.tap(button, 160).defaultPrevented, false, type);
    assert.equal(button.programmaticClicks, 0, type);
  }
});

test('multitouch and mismatched touch identifiers never replay menu actions', () => {
  for (const gesture of ['multitouch', 'identifier']) {
    const h = fixture();
    const button = new Element('button');
    h.tap(button, 0);
    const first = touch(1), second = touch(2, 300, 200);
    h.start(button, 100, first);
    if (gesture === 'multitouch') {
      h.start(button, 110, second, { touches: [first, second] });
      assert.equal(h.end(button, 130, second, { touches: [first] }).defaultPrevented, false);
    }
    assert.equal(h.end(button, 150, gesture === 'identifier' ? second : first).defaultPrevented, false);
    assert.equal(h.tap(button, 170).defaultPrevented, false);
    assert.equal(button.programmaticClicks, 0);
  }
});

test('checkboxes and associated labels preserve one toggle per repeated tap', () => {
  for (const useLabel of [false, true]) {
    const h = fixture();
    const checkbox = new Element('input', { type: 'checkbox' });
    const label = new Element('label');
    label.control = checkbox;
    const target = useLabel ? new Element('span', { parent: label }) : checkbox;
    h.tap(target, 0);
    assert.equal(checkbox.checked, true);
    assert.equal(h.tap(target, 100).defaultPrevented, true);
    assert.equal(checkbox.checked, false, 'the second tap toggles exactly once');
    assert.equal(h.tap(target, 200).defaultPrevented, true);
    assert.equal(checkbox.checked, true);
    assert.deepEqual(checkbox.clicks, ['native', 'synthetic', 'synthetic']);
    assert.equal((useLabel ? label : checkbox).programmaticClicks, 2);
  }
});

test('links, disclosure summaries and radio inputs retain their repeated native activation', () => {
  for (const control of [new Element('a', { href: '/help' }), new Element('summary'), new Element('input', { type: 'radio' })]) {
    const h = fixture();
    h.tap(control, 0);
    assert.equal(h.tap(control, 100).defaultPrevented, true);
    assert.deepEqual(control.clicks, ['native', 'synthetic']);
  }
});

test('range and select taps never receive a synthetic click or forced focus', () => {
  for (const control of [new Element('input', { type: 'range' }), new Element('select')]) {
    const h = fixture();
    h.tap(control, 0);
    assert.equal(h.tap(control, 100).defaultPrevented, true);
    assert.equal(control.programmaticClicks, 0);
    assert.deepEqual(control.focuses, []);
  }
});

test('disabled and previously handled controls cannot acquire a synthetic activation', () => {
  for (const alreadyHandled of [false, true]) {
    const h = fixture();
    const button = new Element('button', { disabled: !alreadyHandled });
    h.tap(button, 0);
    const before = button.clicks.length;
    const event = h.tap(button, 100, { defaultPrevented: alreadyHandled });
    assert.equal(event.defaultPrevented, true);
    assert.equal(button.clicks.length, before);
    assert.equal(button.programmaticClicks, 0);
    assert.deepEqual(button.focuses, []);
  }
});

test('noncancelable releases are neither prevented nor replayed', () => {
  for (const target of [new Element('canvas', { id: 'game' }), new Element('button')]) {
    const h = fixture();
    h.tap(target, 0);
    const event = h.tap(target, 100, { cancelable: false });
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.preventionCalls, 0);
    assert.equal(target.programmaticClicks, 0);
  }
});

test('dblclick fallback cancels browser default without synthesizing or stopping events', () => {
  const h = fixture();
  const button = new Element('button');
  const event = h.emit('dblclick', button);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, false);
  assert.equal(button.programmaticClicks, 0);
  const noncancelable = h.emit('dblclick', button, { cancelable: false });
  assert.equal(noncancelable.defaultPrevented, false);
  assert.equal(noncancelable.preventionCalls, 0);
});
