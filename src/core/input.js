import { Audio } from './audio.js';
import { canvas } from './renderer.js';
import { createInputState, GAMEPLAY_KEYS } from './input-state.js';
import { HUD, IntroCard, FPSMeter } from '../ui/hud.js';

const Input = createInputState();
const overlayEl = document.getElementById('overlay');
const startButton = document.getElementById('startbutton');
const pauseState = Input.pause.bind(Input);
let firstEngage = true;
let lockAttempt = 0;
let fallbackNotified = false;
let previousPadMenu = false, previousPadConfirm = false;

function cardOpen(id) { return document.getElementById(id)?.classList.contains('show') ?? false; }
function modalOpen() { return IntroCard.isOpen() || cardOpen('endcard') || cardOpen('deathscreen'); }
function editableTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}
function readGamepad() {
  try { return Array.from(navigator.getGamepads?.() ?? []).find((value) => value?.connected && value.mapping === 'standard') ?? null; }
  catch { return null; /* Some embed permissions disable the Gamepad API. */ }
}
function notifySession() {
  document.dispatchEvent(new CustomEvent('playstatechange', {
    detail: { active: Input.active, locked: Input.locked, mode: Input.locked ? 'mouse' : Input.gamepadConnected ? 'gamepad' : 'keyboard' },
  }));
}
function showPauseOverlay() {
  if (!modalOpen()) overlayEl?.classList.remove('hidden');
}
function releasePointer() {
  if (document.pointerLockElement !== canvas) return;
  try { document.exitPointerLock(); } catch { /* Capture is already gone. */ }
}
function pauseSession({ showOverlay = true, releaseLock = true } = {}) {
  lockAttempt++;
  pauseState();
  void Audio.suspend();
  if (releaseLock) releasePointer();
  if (showOverlay) showPauseOverlay();
  notifySession();
}
Input.pause = pauseSession;

function pointerFallback(attempt) {
  if (attempt !== lockAttempt || !Input.active || Input.locked) return;
  // A failed capture is a playable keyboard/controller session, not a dead end.
  if (!fallbackNotified) HUD.message(Input.gamepadConnected ? 'CONTROLLER MODE · START TO PAUSE' : 'KEYBOARD MODE · ARROWS LOOK · J FIRE · P PAUSE', 5);
  fallbackNotified = true;
  notifySession();
}
function requestPointer() {
  const attempt = ++lockAttempt;
  if (typeof canvas.requestPointerLock !== 'function') { pointerFallback(attempt); return; }
  try {
    // Do not delay this call: pointer lock requires the original user gesture.
    const request = canvas.requestPointerLock();
    if (request?.catch) request.catch(() => pointerFallback(attempt));
  } catch { pointerFallback(attempt); }
}
function engageLock({ pointerLock = true } = {}) {
  if (document.hidden || overlayEl?.classList.contains('is-panel-open') || startButton?.disabled
    || cardOpen('endcard') || cardOpen('deathscreen')) return false;
  if (firstEngage) {
    firstEngage = false;
    pauseSession({ showOverlay: false });
    overlayEl?.classList.add('hidden');
    IntroCard.present();
    return false;
  }
  if (IntroCard.isOpen()) return false;
  Input.activate();
  Input.setGamepad(readGamepad(), { suppressEdges: true });
  overlayEl?.classList.add('hidden');
  canvas.focus({ preventScroll: true });
  void Audio.resume();
  Audio.startAmbient();
  notifySession();
  if (pointerLock && !Input.locked) requestPointer();
  return true;
}
function engageFromMenu({ gamepad = false } = {}) {
  if (document.hidden || overlayEl?.classList.contains('is-panel-open') || startButton?.disabled) return;
  if (cardOpen('endcard')) { document.getElementById('endrestart')?.click(); return; }
  if (cardOpen('deathscreen')) {
    // The mission owns checkpoint restore; its visible action remains the
    // single route for keyboard, mouse, and controller confirmation.
    if (gamepad) document.getElementById('restartbutton')?.click();
    return;
  }
  if (IntroCard.isOpen()) {
    IntroCard.dismiss({ engage: !gamepad });
    if (gamepad) engageLock({ pointerLock: false });
  } else if (!overlayEl?.classList.contains('hidden')) {
    if (gamepad) engageLock({ pointerLock: false });
    else startButton?.click();
  }
}
function toggleAudio() {
  Audio.setMuted(!Audio.isMuted());
  const label = Audio.isHardMuted() ? 'SILENT SESSION · AUDIO LOCKED OFF' : Audio.isMuted() ? 'AUDIO MUTED' : 'AUDIO ON';
  HUD.message(label, 1.8);
}

addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.metaKey || event.altKey || editableTarget(event.target)) return;
  if (event.ctrlKey && !['ControlLeft', 'ControlRight'].includes(event.code) && !Input.active) return;
  if (event.code === 'Escape' || event.code === 'KeyP') {
    if (Input.active && !event.repeat) { event.preventDefault(); pauseSession(); }
    return;
  }
  if (event.code === 'Enter' && !Input.active && !event.repeat) {
    const control = event.target?.closest?.('button, a, summary');
    if (control && !['startbutton', 'introcontinue'].includes(control.id)) return;
    event.preventDefault();
    engageFromMenu();
    return;
  }
  if (!event.repeat) {
    if (event.code === 'KeyF') { FPSMeter.toggle(); return; }
    if (event.code === 'KeyB') { FPSMeter.startBench(); return; }
    if (event.code === 'KeyM') { toggleAudio(); return; }
  }
  if (!Input.active || modalOpen()) return;
  if (GAMEPLAY_KEYS.has(event.code) || event.code === 'Tab') event.preventDefault();
  Input.keyDown(event.code, event.repeat);
});
addEventListener('keyup', (event) => Input.keyUp(event.code));
addEventListener('mousedown', (event) => {
  if (!Input.active || modalOpen() || (!Input.locked && event.target !== canvas)) return;
  if (event.button === 0 || event.button === 2) event.preventDefault();
  Input.mouseButton(event.button, true);
});
addEventListener('mouseup', (event) => Input.mouseButton(event.button, false));
addEventListener('mousemove', (event) => {
  if (Input.locked && !modalOpen()) Input.mouseMove(event.movementX, event.movementY);
});
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('click', () => {
  if (!Input.active && !modalOpen()) engageLock();
  else if (Input.active && !Input.locked) requestPointer();
});
startButton?.addEventListener('click', engageLock);
document.getElementById('audiotoggle')?.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleAudio();
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) {
    if (!Input.active || document.hidden || modalOpen()) { releasePointer(); return; }
    Input.locked = true;
    Input.reset();
    fallbackNotified = false;
    notifySession();
  } else if (Input.locked) {
    pauseSession({ releaseLock: false });
  } else {
    Input.reset();
  }
});
document.addEventListener('pointerlockerror', () => pointerFallback(lockAttempt));
addEventListener('blur', () => pauseSession());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseSession();
  else Input.reset();
});
addEventListener('pagehide', () => pauseSession({ showOverlay: false }));

/** Poll once per rendered frame, including menus; safe in restricted iframes. */
Input.pollGamepad = function () {
  const pad = readGamepad();
  const menu = Boolean(pad?.buttons?.[9]?.pressed);
  const confirm = Boolean(pad?.buttons?.[0]?.pressed);
  const menuPressed = menu && !previousPadMenu;
  const confirmPressed = confirm && !previousPadConfirm;
  previousPadMenu = menu;
  previousPadConfirm = confirm;
  const wasActive = Input.active;
  Input.setGamepad(pad);
  if (menuPressed) {
    if (Input.active) pauseSession();
    else engageFromMenu({ gamepad: true });
  } else if (!Input.active && confirmPressed) {
    engageFromMenu({ gamepad: true });
  }
  // The confirm press starts play; it should not also jump or fire.
  if (!wasActive && Input.active) Input.setGamepad(pad, { suppressEdges: true });
};

export { Input, engageLock };
