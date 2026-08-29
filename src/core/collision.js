import * as THREE from 'three';

// Only enabled boxes appear in the shared query list. Disabled progression
// gates retain their original bounds and identity for the next campaign.
const registeredColliders = new Set();
const Colliders = {
  list: [],
  revision: 0,
  addBox(min, max) {
    const b = new THREE.Box3(min.clone(), max.clone());
    registeredColliders.add(b);
    this.list.push(b); this.revision++; return b;
  },
  addFromMesh(mesh, pad = 0) {
    mesh.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (pad) { box.expandByScalar(pad); }
    registeredColliders.add(box);
    this.list.push(box); this.revision++; return box;
  },
  addBoxBySize(cx, cy, cz, sx, sy, sz) {
    return this.addBox(
      new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
      new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
    );
  },
  // Idempotent for owned boxes. Unknown or cleared boxes cannot accidentally
  // re-enter the world through a stale reference from a previous build.
  setEnabled(box, enabled) {
    if (!registeredColliders.has(box)) return false;
    const index = this.list.indexOf(box);
    if (enabled && index < 0) { this.list.push(box); this.revision++; }
    else if (!enabled && index >= 0) { this.list.splice(index, 1); this.revision++; }
    return true;
  },
  isEnabled(box) { return this.list.includes(box); },
  clear() {
    if (registeredColliders.size) this.revision++;
    this.list.length = 0;
    registeredColliders.clear();
  },
};
// Results are pooled by default: consume a hit before calling again. Supplying
// an output object lets tools and tests retain a result without an allocation
// on the normal movement path.
const _sphereResult = { normal: new THREE.Vector3(), depth: 0 };
const _capsuleResult = { normal: new THREE.Vector3(), depth: 0 };
const EPSILON = 1e-8;
const SKIN = 0.001;
const GROUND_PROBE = 0.025;
const MAX_MOVE_DT = 1 / 30;
const MAX_MOVE_STEPS = 8;

function resolveSphereAABB(center, radius, box, result = _sphereResult) {
  if (!(radius > 0)) return null;
  const cxC = center.x < box.min.x ? box.min.x : (center.x > box.max.x ? box.max.x : center.x);
  const cyC = center.y < box.min.y ? box.min.y : (center.y > box.max.y ? box.max.y : center.y);
  const czC = center.z < box.min.z ? box.min.z : (center.z > box.max.z ? box.max.z : center.z);
  const dx = center.x - cxC, dy = center.y - cyC, dz = center.z - czC;
  const dist2 = dx * dx + dy * dy + dz * dz;
  if (dist2 >= radius * radius) return null;
  if (dist2 < EPSILON) {
    const bcx = (box.min.x + box.max.x) * 0.5;
    const bcy = (box.min.y + box.max.y) * 0.5;
    const bcz = (box.min.z + box.max.z) * 0.5;
    const ex = Math.min(center.x - box.min.x, box.max.x - center.x);
    const ey = Math.min(center.y - box.min.y, box.max.y - center.y);
    const ez = Math.min(center.z - box.min.z, box.max.z - center.z);
    const minA = Math.min(ex, ey, ez);
    if (minA === ex)      result.normal.set(center.x < bcx ? -1 : 1, 0, 0);
    else if (minA === ey) result.normal.set(0, center.y < bcy ? -1 : 1, 0);
    else                  result.normal.set(0, 0, center.z < bcz ? -1 : 1);
    result.depth = radius + minA;
    return result;
  }
  const d = Math.sqrt(dist2);
  result.normal.set(dx / d, dy / d, dz / d);
  result.depth = radius - d;
  return result;
}

/** Resolve a vertical capsule, including the cylinder between its end caps. */
function resolveCapsuleAABB(bottom, top, radius, box, result = _capsuleResult) {
  if (!(radius > 0)) return null;
  const low = Math.min(bottom.y, top.y);
  const high = Math.max(bottom.y, top.y);
  const x = bottom.x;
  const z = bottom.z;
  if (x + radius <= box.min.x || x - radius >= box.max.x
    || z + radius <= box.min.z || z - radius >= box.max.z
    || high + radius <= box.min.y || low - radius >= box.max.y) return null;
  const closestX = Math.max(box.min.x, Math.min(box.max.x, x));
  const closestZ = Math.max(box.min.z, Math.min(box.max.z, z));
  const dx = x - closestX;
  const dz = z - closestZ;
  const dy = low > box.max.y ? low - box.max.y : (high < box.min.y ? high - box.min.y : 0);
  const distanceSq = dx * dx + dy * dy + dz * dz;
  if (distanceSq >= radius * radius) return null;

  if (distanceSq > EPSILON) {
    const distance = Math.sqrt(distanceSq);
    result.normal.set(dx / distance, dy / distance, dz / distance);
    result.depth = radius - distance;
    return result;
  }

  // The segment enters the box. Vertical separation must clear the entire
  // capsule, not just whichever end sphere happened to be tested first.
  let depth = x - box.min.x + radius;
  result.normal.set(-1, 0, 0);
  const right = box.max.x - x + radius;
  if (right < depth) { depth = right; result.normal.set(1, 0, 0); }
  const down = high - box.min.y + radius;
  if (down < depth) { depth = down; result.normal.set(0, -1, 0); }
  const up = box.max.y - low + radius;
  if (up < depth) { depth = up; result.normal.set(0, 1, 0); }
  const back = z - box.min.z + radius;
  if (back < depth) { depth = back; result.normal.set(0, 0, -1); }
  const front = box.max.z - z + radius;
  if (front < depth) { depth = front; result.normal.set(0, 0, 1); }
  result.depth = depth;
  return result;
}

const _bottom = new THREE.Vector3();
const _top = new THREE.Vector3();
const _probeFeet = new THREE.Vector3();
const _stepFeet = new THREE.Vector3();
const _stepBottom = new THREE.Vector3();

function capsuleHitAt(feet, radius, height, box) {
  _bottom.set(feet.x, feet.y + radius, feet.z);
  _top.set(feet.x, feet.y + Math.max(radius, height - radius), feet.z);
  return resolveCapsuleAABB(_bottom, _top, radius, box);
}

function capsuleHasClearance(feet, radius, height, boxes, tolerance = EPSILON) {
  for (const box of boxes) {
    const hit = capsuleHitAt(feet, radius, height, box);
    if (hit && hit.depth > tolerance) return false;
  }
  return true;
}

/**
 * Find a walkable riser chain without climbing a single face above maxRise.
 * The authored switchback landings overlap their final treads, so a chain is
 * necessary. Its final position must clear the whole capsule, including torso.
 */
function findStepUp(feet, radius, height, boxes, maxRise = 0.30, referenceY = feet.y) {
  let candidateY = Math.max(feet.y, referenceY);
  const startY = candidateY;
  for (let pass = 0; pass < 6; pass++) {
    let nextY = candidateY;
    _stepBottom.set(feet.x, candidateY + radius, feet.z);
    for (const box of boxes) {
      const rise = box.max.y - candidateY;
      if (rise <= SKIN || rise > maxRise + EPSILON) continue;
      if (resolveSphereAABB(_stepBottom, radius, box)) nextY = Math.max(nextY, box.max.y);
    }
    if (nextY === candidateY) break;
    candidateY = nextY;
  }
  if (candidateY <= startY + SKIN) return null;
  _stepFeet.set(feet.x, candidateY + SKIN, feet.z);
  return capsuleHasClearance(_stepFeet, radius, height, boxes) ? candidateY : null;
}

function hasGroundSupport(feet, radius, height, boxes) {
  _probeFeet.copy(feet);
  _probeFeet.y -= GROUND_PROBE;
  for (const box of boxes) {
    const hit = capsuleHitAt(_probeFeet, radius, height, box);
    if (hit && hit.normal.y > 0.6) return true;
  }
  return false;
}

// Resolve horizontal support before rounded-edge contacts can turn walking
// into a bounce. A grounded body keeps support under its circular footprint:
// auto-step can place the toes on a tread before the body centre crosses it.
// Airborne bodies still need to cross a plane directly under their centre.
// Neither case can raise the body onto an uncrossed or over-height surface.
function crossedFloorHeight(feet, previousY, boxes, supportRadius = 0) {
  let floor = -Infinity;
  for (const box of boxes) {
    if (box.max.y > previousY + EPSILON
      || box.max.y < feet.y - (supportRadius > 0 ? GROUND_PROBE : EPSILON)) continue;
    const dx = Math.max(box.min.x - feet.x, 0, feet.x - box.max.x);
    const dz = Math.max(box.min.z - feet.z, 0, feet.z - box.max.z);
    if (supportRadius > 0 ? dx * dx + dz * dz >= supportRadius * supportRadius : dx > 0 || dz > 0) continue;
    floor = Math.max(floor, box.max.y);
  }
  return floor;
}

/**
 * Move a feet-anchored body: { position, velocity, radius, height, onGround }.
 * Large deltas and travel are bounded; short spatial substeps keep fast falls
 * from crossing thin floors. All state and geometry are independent of DOM.
 */
function moveCapsule(body, dt, boxes, allowStep = false, maxRise = 0.30) {
  body.stepped = 0;
  if (!Number.isFinite(dt) || dt <= 0) return body;
  const { position, velocity, radius, height } = body;
  const speed = velocity.length();
  if (!Number.isFinite(speed) || !(radius > 0)) return body;
  const maxTravel = radius * 0.45;
  const elapsed = Math.min(dt, MAX_MOVE_DT, speed > 0 ? maxTravel * MAX_MOVE_STEPS / speed : MAX_MOVE_DT);
  const steps = Math.max(1, Math.min(MAX_MOVE_STEPS, Math.ceil(speed * elapsed / maxTravel)));
  const stepDt = elapsed / steps;

  for (let step = 0; step < steps; step++) {
    const wasGrounded = body.onGround && velocity.y <= 0;
    const canStep = allowStep && wasGrounded;
    const previousY = position.y;
    position.addScaledVector(velocity, stepDt);
    let grounded = false;

    if (canStep) {
      const stepY = findStepUp(position, radius, height, boxes, maxRise, previousY);
      if (stepY !== null) {
        body.stepped += stepY + SKIN - position.y;
        position.y = stepY + SKIN;
        if (velocity.y < 0) velocity.y = 0;
        grounded = true;
      }
    }

    if (velocity.y <= 0) {
      const floor = crossedFloorHeight(position, previousY, boxes, wasGrounded ? radius : 0);
      if (Number.isFinite(floor)) {
        position.y = floor;
        velocity.y = 0;
        grounded = true;
      }
    }

    for (let pass = 0; pass < 4; pass++) {
      let corrected = false;
      for (const box of boxes) {
        // Rebuild both endpoints after every correction. Updating only one
        // end leaves stale coordinates at corners and can push through walls.
        const hit = capsuleHitAt(position, radius, height, box);
        if (!hit || hit.depth <= EPSILON) continue;
        position.addScaledVector(hit.normal, hit.depth);
        const intoSurface = velocity.dot(hit.normal);
        if (intoSurface < 0) velocity.addScaledVector(hit.normal, -intoSurface);
        if (hit.normal.y > 0.6) grounded = true;
        corrected = true;
      }
      if (!corrected) break;
    }

    body.onGround = velocity.y <= 0.01 && (grounded || hasGroundSupport(position, radius, height, boxes));
  }
  return body;
}

export { Colliders, resolveSphereAABB, resolveCapsuleAABB, capsuleHasClearance, findStepUp, moveCapsule };
