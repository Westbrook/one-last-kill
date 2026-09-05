const KEY_ACTIONS = Object.freeze({
  KeyE: 'ePressed', KeyR: 'rPressed', KeyV: 'vPressed', KeyG: 'gPressed', KeyT: 'tPressed',
});
const EDGE_ACTIONS = ['leftPressed', 'jumpPressed', ...Object.values(KEY_ACTIONS)];
const TOUCH_ACTIONS = Object.freeze({
  fire: 'leftPressed', jump: 'jumpPressed', use: 'ePressed', reload: 'rPressed',
  melee: 'vPressed', drop: 'gPressed', rage: 'tPressed',
  aim: null, sprint: null, crouch: null,
});
const PAD_BUTTONS = Object.freeze({
  jump: 1 << 0, crouch: 1 << 1, reload: 1 << 2, use: 1 << 3,
  melee: (1 << 5) | (1 << 11), aim: 1 << 6, fire: 1 << 7,
  sprint: 1 << 10, rage: 1 << 12, drop: 1 << 13,
});
// Only these standard gamepad buttons are mapped to gameplay. A mask avoids
// rebuilding button Sets and edge-query closures on every rendered frame.
const PAD_BUTTON_COUNT = 14;

export const GAMEPLAY_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyQ', 'KeyJ',
  'KeyE', 'KeyR', 'KeyV', 'KeyG', 'KeyT', 'Space',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
]);

/** Circular dead zone keeps diagonal movement consistent and rejects stick drift. */
export function normalizeStick(x = 0, y = 0, deadzone = 0.18, target = {}) {
  const safeX = Number.isFinite(x) ? x : 0;
  const safeY = Number.isFinite(y) ? y : 0;
  const length = Math.hypot(safeX, safeY);
  const threshold = Math.max(0, Math.min(0.95, deadzone));
  if (length <= threshold) {
    target.x = target.y = 0;
    return target;
  }
  const magnitude = (Math.min(length, 1) - threshold) / (1 - threshold);
  target.x = safeX / length * magnitude;
  target.y = safeY / length * magnitude;
  return target;
}

/** DOM-independent input state; pause is the only way out of an active session. */
export function createInputState() {
  const state = {
    keys: new Set(),
    active: false,
    locked: false,
    mouseDX: 0,
    mouseDY: 0,
    leftPressed: false,
    jumpPressed: false,
    ePressed: false,
    rPressed: false,
    vPressed: false,
    gPressed: false,
    tPressed: false,
    gamepadConnected: false,
    _mouseLeft: false,
    _mouseRight: false,
    _aimToggle: false,
    _padButtons: 0,
    _suppressedPadButtons: 0,
    _padMove: { x: 0, y: 0 },
    _padLook: { x: 0, y: 0 },
    _touchMove: { x: 0, y: 0 },
    _touchButtons: new Set(),
    _touchEdges: new Set(),
    _touchDX: 0,
    _touchDY: 0,

    get leftDown() {
      return this.active && (this._mouseLeft || this.keys.has('KeyJ') || (this._padButtons & PAD_BUTTONS.fire) !== 0 || this._touchButtons.has('fire'));
    },
    get rightDown() { return this.isAiming(); },
    isAiming() {
      return this.active && (this._mouseRight || this._aimToggle || (this._padButtons & PAD_BUTTONS.aim) !== 0 || this._touchButtons.has('aim'));
    },
    activate() {
      this.reset();
      this.active = true;
    },
    pause() {
      this.active = false;
      this.locked = false;
      this.reset();
    },
    reset() {
      this.keys.clear();
      this.mouseDX = 0;
      this.mouseDY = 0;
      this._mouseLeft = false;
      this._mouseRight = false;
      this._aimToggle = false;
      // A button held through a pause/capture change must be released before
      // it can trigger again, just like a held keyboard key after focus loss.
      this._suppressedPadButtons |= this._padButtons;
      this._padButtons = 0;
      this._padMove.x = 0;
      this._padMove.y = 0;
      this._padLook.x = 0;
      this._padLook.y = 0;
      for (const action of EDGE_ACTIONS) this[action] = false;
      this.resetTouch();
    },
    resetTouch() {
      this._touchMove.x = this._touchMove.y = 0;
      this._touchDX = this._touchDY = 0;
      this._touchButtons.clear();
      // Touch cancellation must not discard another device's pending actions.
      this._touchEdges.clear();
    },
    setTouchMove(x, y) {
      if (!this.active) return;
      // Touch movement uses positive Y for forward, unlike gamepad stick axes.
      normalizeStick(x, y, 0.12, this._touchMove);
    },
    touchLook(dx, dy) {
      if (!this.active) return;
      if (Number.isFinite(dx)) this._touchDX += dx;
      if (Number.isFinite(dy)) this._touchDY += dy;
    },
    clearTouchLook() {
      this._touchDX = this._touchDY = 0;
    },
    touchButton(action, down) {
      if (!this.active || !Object.hasOwn(TOUCH_ACTIONS, action)) return false;
      if (!down) return this._touchButtons.delete(action);
      if (this._touchButtons.has(action)) return false;
      this._touchButtons.add(action);
      if (TOUCH_ACTIONS[action]) this._touchEdges.add(TOUCH_ACTIONS[action]);
      return true;
    },
    cancelTouchButton(action) {
      if (!Object.hasOwn(TOUCH_ACTIONS, action)) return false;
      const held = this._touchButtons.delete(action);
      const edge = TOUCH_ACTIONS[action];
      const pending = edge ? this._touchEdges.delete(edge) : false;
      return held || pending;
    },
    keyDown(code, repeat = false) {
      if (!this.active || repeat || this.keys.has(code) || !GAMEPLAY_KEYS.has(code)) return false;
      this.keys.add(code);
      if (KEY_ACTIONS[code]) this[KEY_ACTIONS[code]] = true;
      if (code === 'KeyJ') this.leftPressed = true;
      if (code === 'Space') this.jumpPressed = true;
      if (code === 'KeyQ') this._aimToggle = !this._aimToggle;
      return true;
    },
    keyUp(code) { this.keys.delete(code); },
    mouseButton(button, down) {
      if (!this.active) return;
      if (button === 0) {
        if (down && !this._mouseLeft) this.leftPressed = true;
        this._mouseLeft = Boolean(down);
      }
      if (button === 2) this._mouseRight = Boolean(down);
    },
    mouseMove(dx, dy) {
      if (!this.active) return;
      // Browsers occasionally report non-finite deltas while capture changes.
      if (Number.isFinite(dx)) this.mouseDX += dx;
      if (Number.isFinite(dy)) this.mouseDY += dy;
    },
    setGamepad(pad, options) {
      this.gamepadConnected = Boolean(pad && pad.connected !== false);
      if (!this.active || !this.gamepadConnected) {
        this._padButtons = 0;
        this._padMove.x = this._padMove.y = 0;
        this._padLook.x = this._padLook.y = 0;
        return;
      }
      const previous = this._padButtons;
      let pressed = 0;
      for (let index = 0; index < Math.min(PAD_BUTTON_COUNT, pad.buttons?.length ?? 0); index++) {
        const button = pad.buttons[index];
        if (button?.pressed || button?.value > 0.35) pressed |= 1 << index;
      }
      this._suppressedPadButtons &= pressed;
      if (options?.suppressEdges) this._suppressedPadButtons |= pressed;
      pressed &= ~this._suppressedPadButtons;
      const justPressed = pressed & ~previous;
      if (justPressed & PAD_BUTTONS.fire) this.leftPressed = true;
      if (justPressed & PAD_BUTTONS.jump) this.jumpPressed = true;
      if (justPressed & PAD_BUTTONS.reload) this.rPressed = true;
      if (justPressed & PAD_BUTTONS.use) this.ePressed = true;
      if (justPressed & PAD_BUTTONS.melee) this.vPressed = true;
      if (justPressed & PAD_BUTTONS.drop) this.gPressed = true;
      if (justPressed & PAD_BUTTONS.rage) this.tPressed = true;
      this._padButtons = pressed;
      normalizeStick(pad.axes?.[0], pad.axes?.[1], 0.18, this._padMove);
      normalizeStick(pad.axes?.[2], pad.axes?.[3], 0.18, this._padLook);
    },
    // Callers retaining history omit target for an independent snapshot. The
    // player passes its own frame buffer and consumes it within this step.
    consumeFrame(dt = 1 / 60, target = {}) {
      const seconds = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
      const arrowX = Number(this.keys.has('ArrowRight')) - Number(this.keys.has('ArrowLeft'));
      const arrowY = Number(this.keys.has('ArrowDown')) - Number(this.keys.has('ArrowUp'));
      // Pixel-equivalent deltas share the player's mouse sensitivity setting.
      // A quadratic right-stick response preserves small aiming adjustments.
      const lookX = this._padLook.x * Math.abs(this._padLook.x);
      const lookY = this._padLook.y * Math.abs(this._padLook.y);
      const moveX = this._padMove.x + this._touchMove.x;
      const moveY = this._touchMove.y - this._padMove.y;
      const moveLength = Math.max(1, Math.hypot(moveX, moveY));
      const frame = target;
      frame.dx = this.active ? this.mouseDX + this._touchDX + (arrowX * 700 + lookX * 1100) * seconds : 0;
      frame.dy = this.active ? this.mouseDY + this._touchDY + (arrowY * 700 + lookY * 900) * seconds : 0;
      frame.leftDown = this.leftDown;
      frame.rightDown = frame.aimDown = this.isAiming();
      frame.jumpDown = this.active && (this.keys.has('Space') || (this._padButtons & PAD_BUTTONS.jump) !== 0 || this._touchButtons.has('jump'));
      frame.crouchDown = this.active && (this.keys.has('KeyC') || this.keys.has('ControlLeft') || this.keys.has('ControlRight') || (this._padButtons & PAD_BUTTONS.crouch) !== 0 || this._touchButtons.has('crouch'));
      frame.sprintDown = this.active && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || (this._padButtons & PAD_BUTTONS.sprint) !== 0 || this._touchButtons.has('sprint'));
      frame.moveX = this.active ? moveX / moveLength : 0;
      frame.moveY = this.active ? moveY / moveLength : 0;
      this.mouseDX = 0;
      this.mouseDY = 0;
      for (const action of EDGE_ACTIONS) {
        frame[action] = this.active && (this[action] || this._touchEdges.has(action));
        this[action] = false;
      }
      this._touchDX = this._touchDY = 0;
      this._touchEdges.clear();
      return frame;
    },
  };
  return state;
}
