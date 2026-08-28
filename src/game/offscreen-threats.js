const EPSILON = 1e-8;
const TIME_EPSILON = 1e-9;
const MAX_RETAINED_HITS = 64;
const MAX_HIT_DURATION = 60;

function validPosition(position) {
  return position !== null && typeof position === 'object'
    && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

function validSource(source) {
  return source !== null && typeof source === 'object'
    && (source.alive === undefined || source.alive === true) && !source.removed && validPosition(source.pos)
    && Number.isFinite(source.height) && source.height > 0
    && Number.isFinite(source.radius) && source.radius >= 0;
}

function prepareView(view, out) {
  if (!view || !validPosition(view.position)
    || !Number.isFinite(view.yaw) || !Number.isFinite(view.pitch)
    || !Number.isFinite(view.fov) || view.fov <= 0 || view.fov >= 180
    || !Number.isFinite(view.aspect) || view.aspect <= 0) return false;
  const zoom = view.zoom === undefined ? 1 : view.zoom;
  if (!Number.isFinite(zoom) || zoom <= 0) return false;
  const tanVertical = Math.tan(view.fov * Math.PI / 360) / zoom;
  const tanHorizontal = tanVertical * view.aspect;
  if (!Number.isFinite(tanVertical) || !Number.isFinite(tanHorizontal)
    || tanVertical <= 0 || tanHorizontal <= 0) return false;

  const sy = Math.sin(view.yaw), cy = Math.cos(view.yaw);
  const sp = Math.sin(view.pitch), cp = Math.cos(view.pitch);
  out.x = view.position.x; out.y = view.position.y; out.z = view.position.z;
  out.rightX = cy; out.rightZ = -sy;
  out.horizontalX = -sy; out.horizontalZ = -cy;
  out.forwardX = -sy * cp; out.forwardY = sp; out.forwardZ = -cy * cp;
  out.upX = sy * sp; out.upY = cp; out.upZ = cy * sp;
  out.tanHorizontal = tanHorizontal; out.tanVertical = tanVertical;
  // Normalized planes keep the edge tolerance in world meters even with zoom.
  out.cosHorizontal = 1 / Math.hypot(1, tanHorizontal);
  out.sinHorizontal = tanHorizontal * out.cosHorizontal;
  out.cosVertical = 1 / Math.hypot(1, tanVertical);
  out.sinVertical = tanVertical * out.cosVertical;
  return true;
}

function bearing(right, forward) {
  const angle = Math.atan2(right, forward);
  // One canonical rear angle avoids +PI/-PI flicker on an exactly rearward hit.
  return angle <= -Math.PI + EPSILON ? Math.PI : angle;
}

function describe(frame, source, out) {
  if (!validSource(source)) return null;
  const { pos, height, radius } = source;
  const minX = pos.x - radius, maxX = pos.x + radius;
  const minY = pos.y, maxY = pos.y + height;
  const minZ = pos.z - radius, maxZ = pos.z + radius;
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY)
    || !Number.isFinite(maxY) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) return null;
  const dx = pos.x - frame.x, dy = pos.y + height / 2 - frame.y, dz = pos.z - frame.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(distance)) return null;

  let forwardMax = -Infinity, leftMax = -Infinity, rightMax = -Infinity;
  let topMax = -Infinity, bottomMax = -Infinity;
  // Reject only when all eight corners lie outside one frustum plane. Testing
  // whether any individual corner is visible would incorrectly reject a near
  // body that fills the frame with every corner outside the image.
  for (let corner = 0; corner < 8; corner++) {
    const x = (corner & 1 ? maxX : minX) - frame.x;
    const y = (corner & 2 ? maxY : minY) - frame.y;
    const z = (corner & 4 ? maxZ : minZ) - frame.z;
    const right = x * frame.rightX + z * frame.rightZ;
    const up = x * frame.upX + y * frame.upY + z * frame.upZ;
    const forward = x * frame.forwardX + y * frame.forwardY + z * frame.forwardZ;
    if (!Number.isFinite(right) || !Number.isFinite(up) || !Number.isFinite(forward)) return null;
    forwardMax = Math.max(forwardMax, forward);
    leftMax = Math.max(leftMax, forward * frame.sinHorizontal + right * frame.cosHorizontal);
    rightMax = Math.max(rightMax, forward * frame.sinHorizontal - right * frame.cosHorizontal);
    topMax = Math.max(topMax, forward * frame.sinVertical - up * frame.cosVertical);
    bottomMax = Math.max(bottomMax, forward * frame.sinVertical + up * frame.cosVertical);
  }
  const visible = forwardMax > EPSILON && leftMax >= -EPSILON && rightMax >= -EPSILON
    && topMax >= -EPSILON && bottomMax >= -EPSILON;
  const right = dx * frame.rightX + dz * frame.rightZ;
  const horizontalForward = dx * frame.horizontalX + dz * frame.horizontalZ;
  const up = dx * frame.upX + dy * frame.upY + dz * frame.upZ;
  out.visible = visible; out.distance = distance;
  out.angle = bearing(right, horizontalForward); out.direction = null;
  if (visible) return out;

  if (horizontalForward < -EPSILON) {
    out.direction = 'BEHIND';
  } else if (topMax < -EPSILON || bottomMax < -EPSILON || forwardMax <= EPSILON) {
    // An actor ahead in yaw can be behind the camera plane when looking steeply
    // up/down. That is a vertical cue, not a misleading "behind you" warning.
    const above = topMax < -EPSILON && bottomMax >= -EPSILON
      ? true : bottomMax < -EPSILON && topMax >= -EPSILON ? false : up >= 0;
    out.direction = above ? 'ABOVE' : 'BELOW';
    out.angle = above ? 0 : Math.PI;
  } else {
    out.direction = right < 0 ? 'LEFT' : 'RIGHT';
    // Screen-edge bearing: zero is up, +PI/2 right, and PI down. Aspect and
    // vertical field of view give a diagonal side cue its actual screen angle.
    out.angle = bearing(right / frame.tanHorizontal, up / frame.tanVertical);
  }
  return out;
}

/**
 * Conservative body/frustum intersection, with no near/far distance cutoff.
 * Sources use feet Y and keep their full radius/height. A visible result has
 * direction:null; invalid views, dead/removed actors or malformed bounds return
 * null. Distance is from camera eye to the center of the actor's world AABB.
 */
export function describeOffscreenThreat(view, source) {
  const frame = {};
  return prepareView(view, frame) ? describe(frame, source, {}) : null;
}

/**
 * Recent hits retain source references, not old positions. Active attacks are
 * supplied afresh by the caller and never inferred from an actor's AI state.
 * Malformed options use defaults; explicit zero disables hit history. History
 * is capped at 64 sources / 60 simulation seconds even for excessive options.
 */
export function createOffscreenThreatTracker(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const requestedDuration = settings.hitDuration === undefined ? 1.1 : settings.hitDuration;
  const requestedCapacity = settings.maxHits === undefined ? 8 : settings.maxHits;
  const hitDuration = Number.isFinite(requestedDuration) && requestedDuration >= 0
    ? Math.min(requestedDuration, MAX_HIT_DURATION) : 1.1;
  const maxHits = Number.isFinite(requestedCapacity) && requestedCapacity >= 0
    ? Math.min(Math.floor(requestedCapacity), MAX_RETAINED_HITS) : 8;
  const hits = new Map(), seen = new Set(), frame = {}, description = {};
  let elapsed = 0;

  function hit(source) {
    if (!validSource(source) || hitDuration === 0 || maxHits === 0) return false;
    const record = hits.get(source) || {};
    hits.delete(source);
    if (hits.size >= maxHits) hits.delete(hits.keys().next().value);
    record.expiresAt = elapsed + hitDuration;
    hits.set(source, record); // Refreshing also makes this the newest hit.
    return true;
  }

  function update(dt, view, activeAttacks = []) {
    if (Number.isFinite(dt) && dt > 0) {
      elapsed += dt;
      if (!Number.isFinite(elapsed)) { elapsed = 0; hits.clear(); }
    }
    for (const [source, record] of hits) {
      if (record.expiresAt <= elapsed + TIME_EPSILON || !validSource(source)) hits.delete(source);
    }
    seen.clear();
    if (!prepareView(view, frame)) return null;
    let phase = null, angle = 0, direction = null, nearest = Infinity, count = 0;
    for (const [source] of hits) {
      seen.add(source);
      const threat = describe(frame, source, description);
      if (!threat || threat.visible) {
        // Turning to see the attacker acknowledges the hit. Looking away later
        // cannot resurrect that old cue without a new hit or active attack.
        hits.delete(source);
        continue;
      }
      count++;
      phase = 'hit'; angle = threat.angle; direction = threat.direction;
      // Insertion order selects the newest hidden hit, including a refreshed hit.
    }
    if (Array.isArray(activeAttacks)) {
      for (const source of activeAttacks) {
        if (seen.has(source)) continue;
        seen.add(source);
        const threat = describe(frame, source, description);
        if (!threat || threat.visible) continue;
        count++;
        if (phase !== 'hit' && threat.distance < nearest) {
          phase = 'windup'; angle = threat.angle; direction = threat.direction; nearest = threat.distance;
        }
      }
    }
    seen.clear(); // Do not retain references from the caller's attack list.
    return phase ? { angle, direction, phase, count } : null;
  }

  function clear() {
    hits.clear(); seen.clear(); elapsed = 0;
  }

  function snapshot() {
    return { elapsed, pendingHits: hits.size, maxHits, hitDuration };
  }

  return { hit, update, clear, snapshot };
}
