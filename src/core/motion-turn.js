const RADIANS = Math.PI / 180;
const LOOK_SENSITIVITY = 0.0025;
export const EDGE_AIM_LIMIT = 15 * RADIANS;
export const EDGE_FULL_TURN = 27 * RADIANS;
export const EDGE_TURN_SPEED = 120 * RADIANS;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** A bounded wrist aim sits on top of an independently accumulated turn. */
export function createMotionTurn() {
  let yaw = 0, direct = 0, rate = 0;
  const delta = { dx: 0, dy: 0 };
  return {
    get rate() { return rate; },
    reset() { yaw = direct = rate = 0; },
    update(dx, dy, style = 'hybrid', verticalSensitivity = 1) {
      delta.dx = Number.isFinite(dx) ? dx : 0;
      delta.dy = Number.isFinite(dy) ? dy * verticalSensitivity : 0;
      if (style !== 'edge') { this.reset(); return delta; }
      yaw -= delta.dx * LOOK_SENSITIVITY;
      const next = clamp(yaw, -EDGE_AIM_LIMIT, EDGE_AIM_LIMIT);
      delta.dx = -(next - direct) / LOOK_SENSITIVITY;
      direct = next;
      const amount = clamp((Math.abs(yaw) - EDGE_AIM_LIMIT) / (EDGE_FULL_TURN - EDGE_AIM_LIMIT), 0, 1);
      rate = Math.sign(yaw) * EDGE_TURN_SPEED * amount * amount * (3 - 2 * amount);
      return delta;
    },
    // Called from input consumption, not orientation events: browsers may
    // suppress unchanged readings while the device is held at an edge.
    tick(dt) {
      const seconds = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
      return -rate * seconds / LOOK_SENSITIVITY;
    },
  };
}
