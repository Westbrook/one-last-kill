const KEY_ACTIONS = Object.freeze({
  KeyE: 'ePressed', KeyR: 'rPressed', KeyV: 'vPressed', KeyG: 'gPressed', KeyT: 'tPressed',
});
const EDGE_ACTIONS = ['leftPressed', 'jumpPressed', ...Object.values(KEY_ACTIONS)];
const TOUCH_ACTIONS = Object.freeze({
  fire: 'leftPressed', jump: 'jumpPressed', use: 'ePressed', reload: 'rPressed',
  melee: 'vPressed', drop: 'gPressed', rage: 'tPressed',
  aim: null, sprint: null, crouch: null,
});

export const GAMEPLAY_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyQ', 'KeyJ',
  'KeyE', 'KeyR', 'KeyV', 'KeyG', 'KeyT', 'Space',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
]);

/** Circular dead zone keeps diagonal movement consistent and rejects stick drift. */
export function normalizeStick(x = 0, y = 0, deadzone = 0.18) {
  const safeX = Number.isFinite(x) ? x : 0;
  const safeY = Number.isFinite(y) ? y : 0;
  const length = Math.hypot(safeX, safeY);
  const threshold = Math.max(0, Math.min(0.95, deadzone));
  if (length <= threshold) return { x: 0, y: 0 };
  const magnitude = (Math.min(length, 1) - threshold) / (1 - threshold);
  return { x: safeX / length * magnitude, y: safeY / length * magnitude };
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
    _padButtons: new Set(),
    _suppressedPadButtons: new Set(),
    _padMove: { x: 0, y: 0 },
    _padLook: { x: 0, y: 0 },
    _touchMove: { x: 0, y: 0 },
    _touchButtons: new Set(),
    _touchEdges: new Set(),
    _touchDX: 0,
    _touchDY: 0,

    get leftDown() {
      return this.active && (this._mouseLeft || this.keys.has('KeyJ') || this._padButtons.has(7) || this._touchButtons.has('fire'));
    },
    get rightDown() { return this.isAiming(); },
    isAiming() {
      return this.active && (this._mouseRight || this._aimToggle || this._padButtons.has(6) || this._touchButtons.has('aim'));
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
      for (const button of this._padButtons) this._suppressedPadButtons.add(button);
      this._padButtons.clear();
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
      this._touchMove = normalizeStick(x, y, 0.12);
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
    setGamepad(pad, { suppressEdges = false } = {}) {
      this.gamepadConnected = Boolean(pad && pad.connected !== false);
      if (!this.active || !this.gamepadConnected) {
        this._padButtons.clear();
        this._padMove.x = this._padMove.y = 0;
        this._padLook.x = this._padLook.y = 0;
        return;
      }
      const previous = this._padButtons;
      const pressed = new Set();
      for (let index = 0; index < (pad.buttons?.length ?? 0); index++) {
        const button = pad.buttons[index];
        if (button?.pressed || button?.value > 0.35) pressed.add(index);
      }
      for (const button of this._suppressedPadButtons) {
        if (!pressed.has(button)) this._suppressedPadButtons.delete(button);
      }
      if (suppressEdges) for (const button of pressed) this._suppressedPadButtons.add(button);
      for (const button of this._suppressedPadButtons) pressed.delete(button);
      const justPressed = (button) => pressed.has(button) && !previous.has(button);
      if (justPressed(7)) this.leftPressed = true;
      if (justPressed(0)) this.jumpPressed = true;
      if (justPressed(2)) this.rPressed = true;
      if (justPressed(3)) this.ePressed = true;
      if (justPressed(5) || justPressed(11)) this.vPressed = true;
      if (justPressed(13)) this.gPressed = true;
      if (justPressed(12)) this.tPressed = true;
      this._padButtons = pressed;
      const axes = pad.axes ?? [];
      this._padMove = normalizeStick(axes[0], axes[1]);
      this._padLook = normalizeStick(axes[2], axes[3]);
    },
    consumeFrame(dt = 1 / 60) {
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
      const pressed = (action) => this.active && (this[action] || this._touchEdges.has(action));
      const frame = {
        dx: this.active ? this.mouseDX + this._touchDX + (arrowX * 700 + lookX * 1100) * seconds : 0,
        dy: this.active ? this.mouseDY + this._touchDY + (arrowY * 700 + lookY * 900) * seconds : 0,
        leftDown: this.leftDown,
        leftPressed: pressed('leftPressed'),
        rightDown: this.isAiming(),
        aimDown: this.isAiming(),
        ePressed: pressed('ePressed'),
        rPressed: pressed('rPressed'),
        vPressed: pressed('vPressed'),
        gPressed: pressed('gPressed'),
        tPressed: pressed('tPressed'),
        jumpPressed: pressed('jumpPressed'),
        jumpDown: this.active && (this.keys.has('Space') || this._padButtons.has(0) || this._touchButtons.has('jump')),
        crouchDown: this.active && (this.keys.has('KeyC') || this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this._padButtons.has(1) || this._touchButtons.has('crouch')),
        sprintDown: this.active && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this._padButtons.has(10) || this._touchButtons.has('sprint')),
        moveX: this.active ? moveX / moveLength : 0,
        moveY: this.active ? moveY / moveLength : 0,
      };
      this.mouseDX = 0;
      this.mouseDY = 0;
      for (const action of EDGE_ACTIONS) this[action] = false;
      this._touchDX = this._touchDY = 0;
      this._touchEdges.clear();
      return frame;
    },
  };
  return state;
}
