import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createInputState, GAMEPLAY_KEYS } from '../../src/core/input-state.js';

const source = readFileSync(new URL('../../src/core/input.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '')
  .replace(/^export \{[^}]+\};\s*$/gm, '');
assert.doesNotMatch(source, /^import\s|^export\s/m, 'Keep the explicit input-session bindings current');

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      event.target ??= this;
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
    emit(type, extra = {}) {
      const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
      this.dispatchEvent(event);
      return event;
    },
  };
}

function element(id) {
  const classes = new Set();
  return {
    ...eventTarget(), id, disabled: false,
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    click() { if (!this.disabled) this.emit('click'); },
  };
}

// Run the real session module and input state without constructing a renderer,
// audio device or touch DOM. The touch adapter records its public lifecycle.
function session({ touchEnabled = false } = {}) {
  const calls = { requests: 0, exits: 0, focus: 0, resumes: 0, suspends: 0, ambient: 0, briefings: 0, messages: [], states: [] };
  const elements = new Map(['overlay', 'startbutton', 'audiotoggle', 'endcard', 'deathscreen'].map(id => [id, element(id)]));
  const viewport = eventTarget();
  const document = {
    ...eventTarget(), hidden: false, pointerLockElement: null,
    getElementById: id => elements.get(id) ?? null,
    exitPointerLock() { calls.exits++; this.pointerLockElement = null; },
  };
  document.addEventListener('playstatechange', event => calls.states.push({ ...event.detail }));
  const canvas = {
    ...element('canvas'),
    focus() { calls.focus++; },
    requestPointerLock() { calls.requests++; },
  };
  const settings = new Map([['touchControls', touchEnabled]]);
  const Settings = {
    get: key => settings.get(key),
    set(key, value) { settings.set(key, value); document.emit('settingschange'); },
  };
  const controls = {
    enabled: false, active: false, resets: 0, enabledChanges: [], context: null,
    setEnabled(value) { this.enabled = value; this.enabledChanges.push(value); },
    setActive(value) { this.active = value; },
    setContext(value) { this.context = value; },
    reset() { this.resets++; },
    get visible() { return this.enabled && this.active; },
  };
  let api, briefingOpen = false;
  const IntroCard = {
    isOpen: () => briefingOpen,
    present() { calls.briefings++; briefingOpen = true; },
    dismiss({ engage = true } = {}) {
      if (!briefingOpen) return false;
      briefingOpen = false;
      if (engage) api.engageLock();
      return true;
    },
  };
  api = runInNewContext(source + '\n;({ Input, engageLock });', {
    createInputState, GAMEPLAY_KEYS, canvas, document, Settings, IntroCard,
    addEventListener: viewport.addEventListener,
    navigator: { getGamepads: () => [] },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    createTouchControls: () => controls,
    HUD: { message: (...args) => calls.messages.push(args) },
    FPSMeter: { toggle() {}, startBench() {} },
    Audio: {
      resume() { calls.resumes++; }, suspend() { calls.suspends++; },
      startAmbient() { calls.ambient++; }, isMuted: () => true, isHardMuted: () => false, setMuted() {},
    },
  }, { filename: 'src/core/input.js' });
  const overlay = elements.get('overlay'), start = elements.get('startbutton');
  return {
    ...api, canvas, document, viewport, Settings, IntroCard, controls, calls, overlay, start,
    startPlaying() {
      start.click();
      assert.equal(IntroCard.isOpen(), true, 'the first engagement presents the briefing');
      IntroCard.dismiss();
      assert.equal(api.Input.active, true);
    },
    pointerLock(locked) {
      document.pointerLockElement = locked ? canvas : null;
      document.emit('pointerlockchange');
    },
  };
}

function holdTouch(input) {
  input.setTouchMove(0.6, 0.8);
  input.touchLook(40, -20);
  for (const action of ['fire', 'aim', 'jump', 'sprint', 'crouch', 'use']) input.touchButton(action, true);
}

function assertReleased(input) {
  const frame = input.consumeFrame();
  for (const key of ['dx', 'dy', 'moveX', 'moveY']) assert.equal(frame[key], 0, key);
  for (const key of ['leftDown', 'leftPressed', 'aimDown', 'jumpDown', 'jumpPressed', 'sprintDown', 'crouchDown', 'ePressed']) assert.equal(frame[key], false, key);
}

test('the input adapter forwards authoritative gameplay availability to the touch controller', () => {
  const h = session({ touchEnabled: true });
  const context = { canAim: true, canRage: false };
  h.Input.setTouchContext(context);
  assert.equal(h.controls.context, context);
  h.Input.setTouchContext({ canAim: false, canRage: true });
  assert.deepEqual(h.controls.context, { canAim: false, canRage: true });
});

test('opted-in touch play passes through the briefing and never requests pointer capture', () => {
  const h = session({ touchEnabled: true });
  assert.equal(h.controls.enabled, true);
  assert.equal(h.controls.visible, false);
  h.start.click();
  assert.equal(h.IntroCard.isOpen(), true);
  assert.equal(h.Input.active, false);
  assert.equal(h.controls.visible, false);
  assert.equal(h.calls.requests, 0);
  h.IntroCard.dismiss();
  assert.equal(h.Input.active, true);
  assert.equal(h.Input.locked, false);
  assert.equal(h.controls.visible, true);
  assert.equal(h.overlay.classList.contains('hidden'), true);
  assert.equal(h.calls.focus, 1);
  assert.equal(h.calls.resumes, 1);
  assert.equal(h.calls.ambient, 1);
  assert.deepEqual(h.calls.states.at(-1), { active: true, locked: false, mode: 'touch' });
  h.canvas.click();
  assert.equal(h.calls.requests, 0, 'a gameplay tap cannot enter mouse capture mode');
  assert.deepEqual(h.calls.messages, []);
});

test('the on-screen pause entry point returns to the menu and clears touch state before resume', () => {
  const h = session({ touchEnabled: true });
  h.startPlaying();
  holdTouch(h.Input);
  const resets = h.controls.resets, suspends = h.calls.suspends;
  h.Input.pause();
  assert.equal(h.Input.active, false);
  assert.equal(h.controls.visible, false);
  assert.equal(h.overlay.classList.contains('hidden'), false);
  assert.ok(h.controls.resets > resets, 'pause also resets touch pointer ownership and toggle visuals');
  assert.equal(h.calls.suspends, suspends + 1);
  assert.deepEqual(h.calls.states.at(-1), { active: false, locked: false, mode: 'touch' });
  h.start.click();
  assert.equal(h.Input.active, true);
  assert.equal(h.controls.visible, true);
  assert.equal(h.calls.briefings, 1);
  assert.equal(h.calls.requests, 0);
  assertReleased(h.Input);
});

test('changing touch preferences updates controls and pauses active play before changing modes', () => {
  const h = session();
  h.startPlaying();
  h.pointerLock(true);
  assert.equal(h.Input.locked, true);
  h.Settings.set('touchControls', true);
  assert.equal(h.controls.enabled, true);
  assert.equal(h.controls.visible, false);
  assert.equal(h.Input.active, false);
  assert.equal(h.Input.locked, false);
  assert.equal(h.calls.exits, 1);
  assert.equal(h.overlay.classList.contains('hidden'), false);
  h.start.click();
  assert.equal(h.controls.visible, true);
  assert.equal(h.calls.requests, 1, 'the new touch engagement does not request another capture');
  holdTouch(h.Input);
  h.Settings.set('sensitivity', 1.5);
  assert.equal(h.Input.active, true, 'unrelated preferences preserve play');
  assert.equal(h.Input.leftDown, true);
  assert.deepEqual(h.controls.enabledChanges, [false, true]);
  h.Settings.set('touchControls', false);
  assert.equal(h.controls.enabled, false);
  assert.equal(h.controls.visible, false);
  assert.equal(h.Input.active, false);
  assert.equal(h.overlay.classList.contains('hidden'), false);
  h.start.click();
  assert.equal(h.Input.active, true);
  assert.equal(h.calls.requests, 2, 'disabling touch restores mouse capture on the next engagement');
  assertReleased(h.Input);
});

test('default mouse engagement still requests and accepts capture after the briefing', () => {
  const h = session();
  h.startPlaying();
  assert.equal(h.calls.requests, 1);
  assert.equal(h.controls.visible, false);
  assert.equal(h.Input.locked, false);
  h.pointerLock(true);
  assert.equal(h.Input.active, true);
  assert.equal(h.Input.locked, true);
  assert.deepEqual(h.calls.states.at(-1), { active: true, locked: true, mode: 'mouse' });
  assert.equal(h.calls.exits, 0);
});

test('an open settings panel blocks both initial engagement and resuming touch play', () => {
  const h = session({ touchEnabled: true });
  h.overlay.classList.add('is-panel-open');
  h.start.click();
  h.canvas.click();
  assert.equal(h.Input.active, false);
  assert.equal(h.calls.briefings, 0);
  assert.equal(h.controls.visible, false);
  h.overlay.classList.remove('is-panel-open');
  h.startPlaying();
  h.Input.pause();
  h.overlay.classList.add('is-panel-open');
  h.start.click();
  h.canvas.click();
  assert.equal(h.Input.active, false);
  assert.equal(h.controls.visible, false);
  assert.equal(h.calls.resumes, 1);
  assert.equal(h.calls.requests, 0);
});

test('a delayed pointer-lock event is rejected after switching to touch controls', () => {
  const h = session();
  h.startPlaying();
  assert.equal(h.calls.requests, 1);
  h.Settings.set('touchControls', true);
  h.start.click();
  assert.equal(h.Input.active, true);
  h.pointerLock(true);
  assert.equal(h.calls.exits, 1);
  assert.equal(h.document.pointerLockElement, null);
  assert.equal(h.Input.locked, false);
  assert.equal(h.Input.active, true);
  assert.equal(h.controls.visible, true);
  h.document.emit('pointerlockchange');
  assert.equal(h.Input.active, true, 'the resulting unlock event cannot pause the touch session');
  assert.equal(h.controls.visible, true);
  assert.deepEqual(h.calls.states.at(-1), { active: true, locked: false, mode: 'touch' });
});

test('blur and a hidden document pause touch play and clear held inputs for the next engagement', () => {
  for (const cause of ['blur', 'hidden']) {
    const h = session({ touchEnabled: true });
    h.startPlaying();
    holdTouch(h.Input);
    const resets = h.controls.resets;
    if (cause === 'blur') h.viewport.emit('blur');
    else { h.document.hidden = true; h.document.emit('visibilitychange'); }
    assert.equal(h.Input.active, false, cause);
    assert.equal(h.controls.visible, false, cause);
    assert.equal(h.overlay.classList.contains('hidden'), false, cause);
    assert.ok(h.controls.resets > resets, cause + ' resets the touch adapter');
    if (cause === 'hidden') {
      h.start.click();
      assert.equal(h.Input.active, false, 'hidden tabs reject a new engagement');
      h.document.hidden = false;
      h.document.emit('visibilitychange');
    }
    h.start.click();
    assert.equal(h.Input.active, true, cause);
    assertReleased(h.Input);
    assert.equal(h.calls.requests, 0, cause);
  }
});
