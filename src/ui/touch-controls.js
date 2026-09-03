import { createMotionAim } from '../core/motion-aim.js';

const TOGGLES = new Set(['aim', 'sprint', 'crouch']);
const LOOK_SCALE = 2.5;
const FIRE_TAP_MAX_DURATION = 300;
const FIRE_TAP_MAX_DISTANCE = 10;

const icons = {
  fire: '<circle cx="12" cy="12" r="6"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
  aim: '<path d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5M9 12h6m-3-3v6"/>',
  jump: '<path d="m6 10 6-6 6 6M12 4v14M5 21h14"/>',
  use: '<path d="M8 12V5a2 2 0 0 1 4 0v6-2a2 2 0 0 1 4 0v3-1a2 2 0 0 1 4 0v5l-4 5H9l-5-7a2 2 0 0 1 3-2l1 1"/>',
  reload: '<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/>',
  melee: '<path d="m5 19 9-9m-3-3 6-4 4 4-4 6-6-6ZM3 17l4 4"/>',
  sprint: '<circle cx="16" cy="4" r="2"/><path d="m4 10 6-3 5 5 5 1M13 10l-4 5-6 2m6-2 5 2v5"/>',
  crouch: '<circle cx="15" cy="4" r="2"/><path d="m5 10 6-3 4 5 5 1M11 7l-3 8 7 2-3 5H6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  motion: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="m3 8-2 4 2 4m18-8 2 4-2 4M11 17h2"/>',
  recenter: '<circle cx="12" cy="12" r="3"/><path d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"/>',
};

function button(action, label, description = label) {
  const icon = icons[action] ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[action]}</svg>` : '';
  return `<button type="button" class="touch-button touch-${action}" data-touch="${action}" aria-label="${description}"${TOGGLES.has(action) ? ' aria-pressed="false"' : ''}>${icon}<span>${label}</span></button>`;
}

function isFireTap(tap, event) {
  if (!tap) return false;
  const duration = event.timeStamp - tap.startedAt;
  return duration >= 0 && duration <= FIRE_TAP_MAX_DURATION
    && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <= FIRE_TAP_MAX_DISTANCE;
}

/** Pointer ownership lets both thumbs move, aim, and attack independently. */
export function createTouchControls({ input, document: doc = document, window: viewport = window } = {}) {
  const root = doc.createElement('div');
  root.id = 'touch-controls';
  root.hidden = true;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'On-screen game controls');
  root.innerHTML = `
    <div class="touch-look" data-touch="look" role="region" aria-label="Look around: drag to aim"><span class="touch-look-hint">DRAG TO LOOK</span></div>
    <div class="touch-utility">${button('drop', 'DROP', 'Drop weapon')}${button('rage', 'RAGE', 'Activate rage')}${button('pause', 'PAUSE', 'Pause game')}</div>
    <div class="touch-motion-controls">${button('motion', 'MOTION', 'Enable motion aiming')}${button('recenter', 'RECENTER', 'Hold to reposition phone, then release to recenter motion aiming')}</div>
    <span class="touch-motion-status" role="status" aria-live="polite"></span>
    <div class="touch-stance">${button('sprint', 'RUN', 'Toggle sprint')}${button('crouch', 'CROUCH', 'Toggle crouch')}</div>
    <div class="touch-move" data-touch="move" role="group" aria-label="Move: touch to center, then drag thumbstick"><div class="touch-stick" aria-hidden="true">
      <span class="touch-stick-ring" aria-hidden="true"></span><span class="touch-stick-thumb" aria-hidden="true"></span><span class="touch-stick-label" aria-hidden="true">MOVE</span>
    </div></div>
    <div class="touch-actions">${button('aim', 'SIGHTS', 'Toggle weapon sights')}${button('fire', 'FIRE', 'Tap to fire or attack; drag to aim')}${button('use', 'USE', 'Interact or pick up')}${button('reload', 'RELOAD', 'Reload weapon')}${button('melee', 'MELEE', 'Melee attack')}${button('jump', 'JUMP', 'Jump')}</div>`;
  doc.body.append(root);

  const thumb = root.querySelector('.touch-stick-thumb');
  const motionStatus = root.querySelector('.touch-motion-status');
  const controls = new Map(Array.from(root.querySelectorAll('[data-touch]'), element => [element.dataset.touch, element]));
  const moveArea = controls.get('move');
  const pointers = new Map();
  const toggled = new Set();
  const available = new Map();
  const listeners = [];
  let enabled = false, active = false;
  let motionMode = false, lookPointer = null;
  let stickOffsetX = 0, stickOffsetY = 0;
  const motionAim = createMotionAim({
    window: viewport,
    document: doc,
    onLook(dx, dy) {
      if (!root.hidden && input.active && !Array.from(pointers.values()).some(record => record.action === 'recenter')) input.touchLook(dx, dy);
    },
    onStatus: showMotionStatus,
  });

  function showMotionStatus(status) {
    const selected = ['requesting', 'waiting', 'active'].includes(status);
    // Waiting starts only after permission is granted. Recalibrating or
    // resuming must never temporarily re-enable touch aiming in motion mode.
    const nextMotionMode = status === 'waiting' || status === 'active';
    if (motionMode !== nextMotionMode) {
      motionMode = nextMotionMode;
      lookPointer = null;
      // A gesture belongs to the mode where it began. A permission result
      // must not turn an in-progress drag into a shot, or replay queued look.
      for (const [pointerId, record] of pointers) {
        if (!['look', 'fire', 'recenter'].includes(record.action)) continue;
        pointers.delete(pointerId);
        releaseCapture(record, pointerId);
      }
      input.cancelTouchButton('fire');
      input.clearTouchLook();
      paint('look', false);
      paint('fire', false);
      paint('recenter', false);
    }
    root.dataset.motionAim = status;
    root.dataset.aimMode = motionMode ? 'motion' : 'touch';
    const motionButton = controls.get('motion');
    motionButton.setAttribute('aria-pressed', String(selected));
    motionButton.setAttribute('aria-label', selected ? 'Disable motion aiming' : 'Enable motion aiming');
    controls.get('recenter').hidden = !motionMode;
    const look = controls.get('look');
    look.hidden = motionMode;
    controls.get('fire').setAttribute('aria-label', motionMode
      ? 'Fire or attack; hold for automatic fire' : 'Tap to fire or attack; drag to aim');
    motionStatus.textContent = {
      off: '',
      requesting: 'Allow motion access to aim',
      waiting: 'Hold comfortably · waiting for motion',
      active: 'MOVE PHONE TO AIM',
      denied: 'Motion access denied · swipe to aim',
      unavailable: 'Motion unavailable · swipe to aim',
    }[status];
  }
  function activateMotionAction(action) {
    if (action === 'recenter') motionAim.recenter();
    else if (['requesting', 'waiting', 'active'].includes(motionAim.status)) motionAim.disable();
    else void motionAim.enable();
  }

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  }
  function paint(action, pressed) {
    const element = controls.get(action);
    element.dataset.pressed = String(pressed);
    if (TOGGLES.has(action)) element.setAttribute('aria-pressed', String(pressed));
  }
  function setToggle(action, pressed) {
    if (pressed) toggled.add(action);
    else toggled.delete(action);
    input.touchButton(action, pressed);
    paint(action, pressed);
  }
  function toggle(action) {
    const pressed = !toggled.has(action);
    // Standing up to run should not leave a hidden crouch toggle behind.
    if (pressed && action === 'sprint') setToggle('crouch', false);
    if (pressed && action === 'crouch') setToggle('sprint', false);
    setToggle(action, pressed);
  }
  function releaseCapture(record, pointerId) {
    try {
      if (record.element.hasPointerCapture?.(pointerId)) record.element.releasePointerCapture(pointerId);
    } catch { /* A canceled or disconnected pointer has already lost capture. */ }
  }
  function setAvailable(action, value) {
    const next = Boolean(value);
    if (available.get(action) === next) return;
    available.set(action, next);
    const element = controls.get(action);
    element.hidden = !next;
    element.disabled = !next;
    if (next) return;
    // Losing eligibility cancels this action alone, including a tap queued
    // between simulation steps. Other fingers keep moving, looking or firing.
    for (const [pointerId, record] of pointers) {
      if (record.action !== action) continue;
      pointers.delete(pointerId);
      releaseCapture(record, pointerId);
    }
    toggled.delete(action);
    input.cancelTouchButton(action);
    paint(action, false);
  }
  function setContext({ canAim = false, canRage = false } = {}) {
    setAvailable('aim', canAim);
    setAvailable('rage', canRage);
  }
  function reset() {
    const held = Array.from(pointers);
    pointers.clear();
    lookPointer = null;
    toggled.clear();
    input.resetTouch();
    motionAim.recenter();
    for (const action of controls.keys()) paint(action, false);
    thumb.style.transform = 'translate(-50%, -50%)';
    stickOffsetX = stickOffsetY = 0;
    moveArea.style.transform = 'translate(0px, 0px)';
    for (const [pointerId, record] of held) releaseCapture(record, pointerId);
  }
  function syncVisibility() {
    const visible = enabled && active;
    if (!visible) reset();
    root.hidden = !visible;
    motionAim.setActive(visible);
    doc.body.dataset.touchControls = String(visible);
  }
  function moveStick(record, event) {
    const x = (event.clientX - record.x) / record.radius;
    const y = (event.clientY - record.y) / record.radius;
    input.setTouchMove(x, -y);
    const length = Math.max(1, Math.hypot(x, y));
    thumb.style.transform = `translate(-50%, -50%) translate(${x / length * record.radius}px, ${y / length * record.radius}px)`;
  }
  function pointerDown(event) {
    if (root.hidden || !input.active || event.defaultPrevented || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const element = event.target.closest?.('[data-touch]');
    if (!element || !root.contains(element)) return;
    event.preventDefault();
    event.stopPropagation();
    const action = element.dataset.touch;
    if (element.hidden || available.get(action) === false || (action === 'look' && motionMode)) return;
    // Never transfer an already-held stick or button to a second finger.
    if (pointers.has(event.pointerId) || Array.from(pointers.values()).some(record => record.action === action)) return;
    const record = { action, element, x: event.clientX, y: event.clientY };
    if (action === 'fire' && !motionMode) record.tap = { x: event.clientX, y: event.clientY, startedAt: event.timeStamp };
    pointers.set(event.pointerId, record);
    try { element.setPointerCapture(event.pointerId); } catch { /* Window listeners still release the pointer. */ }
    if (action === 'move') {
      const bounds = element.getBoundingClientRect();
      record.radius = Math.max(1, Math.min(bounds.width, bounds.height) * 0.3);
      // Move the hit target with the ring, so its visible edges remain usable
      // on the next touch. Bounds already include the previous translation.
      stickOffsetX += record.x - (bounds.left + bounds.width / 2);
      stickOffsetY += record.y - (bounds.top + bounds.height / 2);
      moveArea.style.transform = `translate(${stickOffsetX}px, ${stickOffsetY}px)`;
      moveStick(record, event);
    } else if (TOGGLES.has(action)) {
      toggle(action);
    } else if (action === 'fire') {
      if (motionMode) input.touchButton(action, true);
    } else if (!['look', 'pause', 'motion', 'recenter'].includes(action)) {
      input.touchButton(action, true);
    }
    if (!motionMode && (action === 'look' || action === 'fire') && lookPointer === null) lookPointer = event.pointerId;
    if (!TOGGLES.has(action)) paint(action, true);
  }
  function pointerMove(event) {
    const record = pointers.get(event.pointerId);
    if (!record || root.hidden || !input.active) return;
    event.preventDefault();
    // Touch mode retains the original tap-to-fire / drag-to-look behavior.
    if (record.tap && !isFireTap(record.tap, event)) record.tap = null;
    if (record.action === 'move') moveStick(record, event);
    else {
      if (!motionMode && lookPointer === event.pointerId) input.touchLook((event.clientX - record.x) * LOOK_SCALE, (event.clientY - record.y) * LOOK_SCALE);
      record.x = event.clientX;
      record.y = event.clientY;
    }
  }
  function pointerEnd(event) {
    const record = pointers.get(event.pointerId);
    if (!record) return;
    pointers.delete(event.pointerId);
    if (lookPointer === event.pointerId) {
      lookPointer = Array.from(pointers).find(([, pointer]) => pointer.action === 'look' || pointer.action === 'fire')?.[0] ?? null;
    }
    const canceled = event.type !== 'pointerup';
    if (record.action === 'move') {
      input.setTouchMove(0, 0);
      thumb.style.transform = 'translate(-50%, -50%)';
    } else if (TOGGLES.has(record.action)) {
      if (canceled) setToggle(record.action, false);
    } else {
      if (record.action === 'fire' && !motionMode && !canceled && !root.hidden && input.active && isFireTap(record.tap, event)) {
        input.touchButton('fire', true);
      }
      if (canceled) input.cancelTouchButton(record.action);
      else input.touchButton(record.action, false);
    }
    if (!TOGGLES.has(record.action)) paint(record.action, false);
    releaseCapture(record, event.pointerId);
    if (record.action === 'pause' && !canceled) input.pause();
    if (['motion', 'recenter'].includes(record.action) && !canceled && !root.hidden && input.active) activateMotionAction(record.action);
  }

  listen(root, 'pointerdown', pointerDown);
  listen(viewport, 'pointermove', pointerMove, { passive: false });
  listen(viewport, 'pointerup', pointerEnd);
  listen(viewport, 'pointercancel', pointerEnd);
  listen(root, 'lostpointercapture', pointerEnd);
  listen(root, 'contextmenu', event => event.preventDefault());
  listen(root, 'click', event => {
    event.preventDefault();
    event.stopPropagation();
    // Pointer actions are handled above. Native keyboard/assistive clicks need
    // their own pulse, without replaying the compatibility click after touch.
    if (event.detail !== 0 || root.hidden || !input.active) return;
    const element = event.target.closest?.('button[data-touch]');
    const action = element?.dataset.touch;
    if (!action || !root.contains(element) || element.hidden || available.get(action) === false) return;
    if (action === 'pause') input.pause();
    else if (['motion', 'recenter'].includes(action)) activateMotionAction(action);
    else if (TOGGLES.has(action)) toggle(action);
    else { input.touchButton(action, true); input.touchButton(action, false); }
  });
  listen(viewport, 'resize', reset);
  listen(viewport, 'orientationchange', reset);
  setContext();
  showMotionStatus(motionAim.status);

  return {
    element: root,
    reset,
    setContext,
    setEnabled(value) { enabled = Boolean(value); if (!enabled) motionAim.disable(); syncVisibility(); },
    setActive(value) { active = Boolean(value); syncVisibility(); },
    destroy() {
      reset();
      motionAim.destroy();
      for (const remove of listeners) remove();
      root.remove();
      doc.body.dataset.touchControls = 'false';
    },
  };
}
