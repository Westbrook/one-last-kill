const RADIANS = Math.PI / 180;
const LOOK_SENSITIVITY = 0.0025;
const SENSOR_TIMEOUT = 2500;
const FLAT_HOLD = Math.cos(20 * RADIANS);
const UPRIGHT_HOLD = Math.cos(35 * RADIANS);
const POLE_RADIUS = Math.sin(2 * RADIANS);
const FULL_YAW_RADIUS = Math.sin(15 * RADIANS);
const TAU = 2 * Math.PI;

function shortAngle(value) {
  value %= TAU;
  return value > Math.PI ? value - TAU : value < -Math.PI ? value + TAU : value;
}

function screenAngle(viewport) {
  const angle = viewport.screen?.orientation?.angle;
  return Number.isFinite(angle) ? angle : Number.isFinite(viewport.orientation) ? viewport.orientation : 0;
}

/** Relative, opt-in motion aiming; camera deltas use the existing mouse scale. */
export function createMotionAim({ window: viewport = window, document: doc = document, onLook = () => {}, onStatus = () => {} } = {}) {
  let status = 'off', enabled = false, active = false, destroyed = false;
  let permissionGranted = false, receivedSample = false, attempt = 0, listening = false, timeout = null;
  let focused = true, pageVisible = true, calibrated = false, calibration = 0, previousAngle = null, previousAbsolute = null;
  // A fixed reference makes panning independent of how the device is rolled,
  // including a sideways phone whose display orientation is locked. Scalar
  // storage also keeps the high-frequency sensor handler allocation-free.
  let upX = 0, upY = 0, upZ = 1, forwardX = 0, forwardY = 1, forwardZ = 0;
  let rightX = 1, rightY = 0, rightZ = 0, previousYaw = 0, previousPitch = 0, previousHorizontal = 1;
  let flatReference = false;
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
    calibrated = false;
    calibration++;
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
    if (!Number.isFinite(event.alpha) || !Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return;
    const angle = screenAngle(viewport);
    // DeviceOrientation is intrinsic Z-X'-Y''. Take its -Z direction: the
    // camera points through the back of the screen. Unlike device-local X/Y
    // increments, this direction is unchanged by roll and cannot swap axes.
    // https://www.w3.org/TR/orientation-event/#device-orientation
    const alpha = event.alpha * RADIANS, beta = event.beta * RADIANS, gamma = event.gamma * RADIANS;
    const sa = Math.sin(alpha), ca = Math.cos(alpha), sb = Math.sin(beta), cb = Math.cos(beta);
    const sg = Math.sin(gamma), cg = Math.cos(gamma);
    const x = -ca * sg - sa * sb * cg, y = -sa * sg + ca * sb * cg, z = -cb * cg;
    const absolute = Boolean(event.absolute);
    // Once a flat-started device is lifted clearly upright, adopt gravity with
    // a fresh baseline. Hysteresis avoids switching frames around one angle.
    const recalibrate = !calibrated || previousAngle !== angle || previousAbsolute !== absolute || (flatReference && Math.abs(z) < UPRIGHT_HOLD);
    if (recalibrate) {
      upX = 0; upY = 0; upZ = 1;
      flatReference = Math.abs(z) > FLAT_HOLD;
      if (flatReference) {
        // Gravity cannot define a useful heading when aiming nearly straight
        // down/up. Calibrate against screen-up instead and retain that frame
        // while held flat, so small posture changes cannot flip the controls.
        const screen = angle * RADIANS, ss = Math.sin(screen), cs = Math.cos(screen);
        upX = ss * (ca * cg - sa * sb * sg) - cs * sa * cb;
        upY = ss * (sa * cg + ca * sb * sg) + cs * ca * cb;
        upZ = -ss * cb * sg + cs * sb;
      }
      const vertical = x * upX + y * upY + z * upZ;
      forwardX = x - upX * vertical; forwardY = y - upY * vertical; forwardZ = z - upZ * vertical;
      const length = Math.hypot(forwardX, forwardY, forwardZ);
      forwardX /= length; forwardY /= length; forwardZ /= length;
      rightX = forwardY * upZ - forwardZ * upY;
      rightY = forwardZ * upX - forwardX * upZ;
      rightZ = forwardX * upY - forwardY * upX;
      previousYaw = 0;
      previousPitch = Math.atan2(vertical, length);
      previousHorizontal = length;
      calibrated = true;
    }
    const reference = calibration;
    previousAngle = angle;
    previousAbsolute = absolute;
    receivedSample = true;
    clearTimeout();
    setStatus('active');
    if (recalibrate || reference !== calibration || !listening) return;

    const horizontalX = -(x * rightX + y * rightY + z * rightZ);
    const horizontalY = x * forwardX + y * forwardY + z * forwardZ;
    const vertical = x * upX + y * upY + z * upZ;
    const horizontal = Math.hypot(horizontalX, horizontalY);
    const heading = Math.atan2(horizontalX, horizontalY), elevation = Math.atan2(vertical, horizontal);
    let yaw = shortAngle(heading - previousYaw), pitch = elevation - previousPitch;
    if (horizontal < POLE_RADIUS) {
      // At a pole heading is undefined. Keep the last heading and measure
      // elevation only, rather than amplifying tiny sensor noise into a turn.
      yaw = 0;
    } else {
      // After crossing a pole the equivalent, inverted spherical branch may
      // look closer to the old reading. Reanchor to gravity instead of keeping
      // that branch: a turn while nearly vertical must not invert later pitch.
      const alternateYaw = shortAngle(heading + Math.PI - previousYaw);
      const alternatePitch = shortAngle(Math.PI - elevation - previousPitch);
      if (previousHorizontal < POLE_RADIUS || alternateYaw * alternateYaw + alternatePitch * alternatePitch < yaw * yaw + pitch * pitch) {
        yaw = 0;
        pitch = 0;
      }
      previousYaw = heading;
    }
    previousPitch = elevation;
    // Fade heading sensitivity near vertical, where a tiny pointing change can
    // imply a large yaw. Updating the baseline at full speed prevents deferred
    // yaw from snapping back when the device leaves the pole cone.
    const confidence = Math.max(0, Math.min(1, (Math.min(horizontal, previousHorizontal) - POLE_RADIUS) / (FULL_YAW_RADIUS - POLE_RADIUS)));
    yaw *= confidence * confidence * (3 - 2 * confidence);
    previousHorizontal = horizontal;
    // Player subtracts mouse deltas from both camera angles.
    const dx = -yaw / LOOK_SENSITIVITY, dy = -pitch / LOOK_SENSITIVITY;
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
