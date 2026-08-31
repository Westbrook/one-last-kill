// Install before game initialization so menus and failed WebGL startup are
// protected too. Some Safari versions ignore touch-action for
// double-tap zoom; canceling Pointer Events does not cancel that native gesture.
const TAP_INTERVAL = 500;
const TAP_DISTANCE = 10;
const options = { capture: true, passive: false };
let tap = null;
let lastTapAt = -Infinity;

function reset() {
  tap = null;
  lastTapAt = -Infinity;
}

function touchStart(event) {
  if (event.touches.length !== 1) { reset(); return; }
  const touch = event.touches[0];
  tap = { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: event.timeStamp };
}

function touchMove(event) {
  const touch = event.touches[0];
  if (event.touches.length !== 1 || !tap || touch.identifier !== tap.id
    || Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > TAP_DISTANCE) reset();
}

function touchEnd(event) {
  const touch = event.changedTouches[0];
  const completedTap = tap && event.touches.length === 0 && event.changedTouches.length === 1
    && touch.identifier === tap.id && event.timeStamp >= tap.at && event.timeStamp - tap.at <= TAP_INTERVAL
    && Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) <= TAP_DISTANCE;
  const interval = event.timeStamp - lastTapAt;
  const repeatedTap = completedTap && interval >= 0 && interval <= TAP_INTERVAL;
  tap = null;
  lastTapAt = completedTap ? event.timeStamp : -Infinity;

  // Every release on a game surface is owned by Pointer Events, even when
  // another thumb is still down or PAUSE has just hidden the controls.
  const gameSurface = event.target.closest?.('#game, #touch-controls');
  if ((!gameSurface && !repeatedTap) || !event.cancelable) return;
  const alreadyHandled = event.defaultPrevented;
  event.preventDefault();
  if (gameSurface || alreadyHandled) return;

  // Canceling touchend also suppresses its compatibility click. Preserve the
  // second menu action once, including taps on nested labels/icons. Never
  // replay pointer-driven game buttons, sliders, or a native select picker.
  const control = event.target.closest?.('button, a[href], label, input[type="checkbox"], input[type="radio"], summary');
  if (control && !control.matches(':disabled')) {
    control.focus({ preventScroll: true });
    control.click();
  }
}

document.addEventListener('touchstart', touchStart, { capture: true, passive: true });
document.addEventListener('touchmove', touchMove, { capture: true, passive: true });
document.addEventListener('touchend', touchEnd, options);
document.addEventListener('touchcancel', reset, { capture: true, passive: true });
document.addEventListener('scroll', reset, { capture: true, passive: true });
document.addEventListener('visibilitychange', reset);
document.addEventListener('dblclick', event => {
  if (event.cancelable) event.preventDefault();
}, options);
