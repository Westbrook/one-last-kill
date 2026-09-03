const RADIANS = Math.PI / 180;
const LOOK_SENSITIVITY = 0.0025;
const SENSOR_TIMEOUT = 2500;

function multiply(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function conjugate([x, y, z, w]) { return [-x, -y, -z, w]; }

function screenAngle(viewport) {
  const angle = viewport.screen?.orientation?.angle;
  return Number.isFinite(angle) ? angle : Number.isFinite(viewport.orientation) ? viewport.orientation : 0;
}

function orientationQuaternion(event, angle) {
  // DeviceOrientation uses intrinsic Z-X'-Y'' rotations in the device's
  // natural orientation, even when its display has rotated to landscape.
  // https://www.w3.org/TR/orientation-event/#device-orientation
  const alpha = event.alpha * RADIANS / 2, beta = event.beta * RADIANS / 2;
  const gamma = event.gamma * RADIANS / 2, screen = -angle * RADIANS / 2;
  return multiply(multiply(multiply(
    [0, 0, Math.sin(alpha), Math.cos(alpha)],
    [Math.sin(beta), 0, 0, Math.cos(beta)],
  ), [0, Math.sin(gamma), 0, Math.cos(gamma)]), [0, 0, Math.sin(screen), Math.cos(screen)]);
}

/** Relative, opt-in motion aiming; camera deltas use the existing mouse scale. */
export function createMotionAim({ window: viewport = window, document: doc = document, onLook = () => {}, onStatus = () => {} } = {}) {
  let status = 'off', enabled = false, active = false, destroyed = false;
  let permissionGranted = false, receivedSample = false, attempt = 0, listening = false, timeout = null;
  let focused = true, pageVisible = true, previous = null, previousAngle = null, previousAbsolute = null;
  const displayOrientation = viewport.screen?.orientation;
  const listeners = [];

  function listen(target, type, handler) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  }
  function setStatus(value) {
    if (status === value) return;
    status = value;
    onStatus(value);
  }
  function clearTimeout() {
    if (timeout !== null) viewport.clearTimeout(timeout);
    timeout = null;
  }
  function clearBaseline() {
    previous = null;
    previousAngle = null;
    previousAbsolute = null;
  }
  function stopSensor() {
    if (listening) viewport.removeEventListener('deviceorientation', orientation);
    listening = false;
    clearTimeout();
    clearBaseline();
  }
  function awaitSample() {
    clearTimeout();
    // Some browsers suppress unchanged readings. Once this opt-in has proved
    // the sensor works, a stationary device may safely wait through recenter
    // or resume until its next reading instead of spuriously losing motion aim.
    if (!receivedSample) {
      timeout = viewport.setTimeout(() => {
        timeout = null;
        stopSensor();
        setStatus('unavailable');
      }, SENSOR_TIMEOUT);
    }
    setStatus('waiting');
  }
  function sync() {
    if (destroyed || !enabled || !permissionGranted || status === 'unavailable' || status === 'denied') return;
    if (!active || doc.hidden || !focused || !pageVisible) {
      stopSensor();
      setStatus('waiting');
    } else if (!listening) {
      listening = true;
      viewport.addEventListener('deviceorientation', orientation);
      awaitSample();
    }
  }
  function orientation(event) {
    if (!listening || !enabled || !active || destroyed || doc.hidden || !focused || !pageVisible) return;
    if (![event.alpha, event.beta, event.gamma].every(Number.isFinite)) return;
    const angle = screenAngle(viewport);
    const current = orientationQuaternion(event, angle);
    const absolute = Boolean(event.absolute);
    const baseline = previous;
    const recalibrate = !baseline || previousAngle !== angle || previousAbsolute !== absolute;
    previous = current;
    previousAngle = angle;
    previousAbsolute = absolute;
    receivedSample = true;
    clearTimeout();
    setStatus('active');
    if (recalibrate || previous !== current || !listening) return;

    // Local quaternion increments avoid Euler wraps and work at any holding
    // angle. The shortest rotation vector gives screen X pitch and Y yaw;
    // discard screen Z roll so the horizon stays level.
    const [x, y, z, w] = multiply(conjugate(baseline), current);
    const length = Math.hypot(x, y, z);
    if (length < 1e-12) return;
    const scale = 2 * Math.atan2(length, Math.abs(w)) * (w < 0 ? -1 : 1) / length;
    // The camera faces into the screen (-Z): positive X looks up, positive Y
    // looks left. Player subtracts mouse deltas from both camera angles.
    const dx = -y * scale / LOOK_SENSITIVITY, dy = -x * scale / LOOK_SENSITIVITY;
    if (Math.abs(dx) > 1e-8 || Math.abs(dy) > 1e-8) onLook(dx, dy);
  }
  function recenter() {
    if (destroyed) return;
    clearBaseline();
    if (listening) awaitSample();
  }
  async function enable() {
    if (destroyed) return false;
    if (enabled && ['requesting', 'waiting', 'active'].includes(status)) return permissionGranted;
    const request = ++attempt;
    enabled = true;
    permissionGranted = false;
    receivedSample = false;
    stopSensor();
    const sensor = viewport.DeviceOrientationEvent;
    if (!viewport.isSecureContext || !sensor) {
      setStatus('unavailable');
      return false;
    }
    setStatus('requesting');
    if (!enabled || request !== attempt) return false;
    try {
      // Keep this call before any await: Safari requires the original user
      // gesture. Omitting the argument requests relative orientation only.
      const permission = typeof sensor.requestPermission === 'function' ? await sensor.requestPermission() : 'granted';
      if (destroyed || !enabled || request !== attempt) return false;
      if (permission !== 'granted') {
        setStatus('denied');
        return false;
      }
      permissionGranted = true;
      setStatus('waiting');
      sync();
      return true;
    } catch {
      if (destroyed || !enabled || request !== attempt) return false;
      setStatus('denied');
      return false;
    }
  }
  function disable() {
    attempt++;
    enabled = false;
    permissionGranted = false;
    receivedSample = false;
    stopSensor();
    setStatus('off');
  }

  listen(doc, 'visibilitychange', sync);
  listen(viewport, 'blur', () => { focused = false; sync(); });
  listen(viewport, 'focus', () => { focused = true; sync(); });
  listen(viewport, 'pagehide', () => { pageVisible = false; sync(); });
  listen(viewport, 'pageshow', () => { pageVisible = true; sync(); });
  listen(viewport, 'orientationchange', recenter);
  listen(displayOrientation, 'change', recenter);

  return {
    get status() { return status; },
    get enabled() { return enabled; },
    enable, disable, recenter,
    setActive(value) {
      if (destroyed || active === Boolean(value)) return;
      active = Boolean(value);
      sync();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      disable();
      for (const remove of listeners) remove();
    },
  };
}
