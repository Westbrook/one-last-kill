import * as THREE from 'three';

export const COLLAPSE_DURATION = 0.52;
const LIMB_RELAX_DURATION = 0.34;
const FLOOR_SKIN = 0.004;
const GALLERY_INSET = 0.12;
const _targetEuler = new THREE.Euler();
const _worldBounds = new THREE.Box3();
const smooth = value => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

/** Keep the facing sign while aligning a fall to a narrow gallery's axis. */
export function alignedFallYaw(yaw, axis = null) {
  if (!Number.isFinite(yaw)) return 0;
  if (axis === 'x') return Math.sin(yaw) >= 0 ? Math.PI / 2 : -Math.PI / 2;
  if (axis === 'z') return Math.cos(yaw) >= 0 ? 0 : Math.PI;
  return yaw;
}

export function fitIntervalTranslation(min, max, allowedMin, allowedMax) {
  if (max - min > allowedMax - allowedMin) return (allowedMin + allowedMax - min - max) * 0.5;
  if (min < allowedMin) return allowedMin - min;
  if (max > allowedMax) return allowedMax - max;
  return 0;
}

/** Allocate once with the rig, never in the per-frame collapse path. */
export function createCorpsePoseState(rig) {
  const targets = {};
  const bones = rig.neutral.map(rest => {
    const bone = {
      object: rest.object,
      restPosition: rest.position,
      restQuaternion: rest.quaternion,
      fromPosition: new THREE.Vector3(),
      fromQuaternion: new THREE.Quaternion(),
      targetPosition: new THREE.Vector3(),
      targetQuaternion: new THREE.Quaternion(),
    };
    targets[rest.object.name.slice('joint:'.length)] = bone;
    return bone;
  });
  const bodies = rig.bodyMeshes.map(mesh => {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    return {
      mesh,
      center: mesh.geometry.boundingBox.getCenter(new THREE.Vector3()),
      halfSize: mesh.geometry.boundingBox.getSize(new THREE.Vector3()).multiplyScalar(0.5),
    };
  });
  return {
    active: false, settled: false, bones, targets, bodies,
    floorY: 0, groundOffset: 0, startYaw: 0, targetYaw: 0,
    yawDelta: 0, startPitch: 0, startRoll: 0,
    originX: 0, originZ: 0, offsetX: 0, offsetZ: 0, fallSign: 1,
    hasRegion: false, region: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
  };
}

function targetRotation(state, name, x, y = 0, z = 0) {
  _targetEuler.set(x, y, z, 'XYZ');
  state.targets[name].targetQuaternion.setFromEuler(_targetEuler);
}

/** Capture the current attack pose, then fold it into a compact prone pose. */
export function beginHumanoidCollapse(root, yaw, floorY, axis = null, lean = 0, region = null) {
  const rig = root.userData.rig, state = rig?.collapse;
  if (!state || !Number.isFinite(floorY)) return false;
  state.active = true; state.settled = false; state.groundOffset = 0;
  state.floorY = floorY;
  state.startYaw = Number.isFinite(yaw) ? yaw : root.rotation.y;
  state.targetYaw = alignedFallYaw(state.startYaw, axis);
  state.yawDelta = Math.atan2(Math.sin(state.targetYaw - state.startYaw), Math.cos(state.targetYaw - state.startYaw));
  state.startPitch = root.rotation.x; state.startRoll = root.rotation.z;
  state.originX = root.position.x; state.originZ = root.position.z;
  state.offsetX = 0; state.offsetZ = 0; state.fallSign = 1;
  state.hasRegion = !!region;
  if (region) {
    state.region.minX = region.x1 + GALLERY_INSET;
    state.region.maxX = region.x2 - GALLERY_INSET;
    state.region.minZ = region.z1 + GALLERY_INSET;
    state.region.maxZ = region.z2 - GALLERY_INSET;
    const coordinate = axis === 'x' ? state.originX : state.originZ;
    const min = axis === 'x' ? state.region.minX : state.region.minZ;
    const max = axis === 'x' ? state.region.maxX : state.region.maxZ;
    const forward = axis === 'x' ? Math.sin(state.targetYaw) : Math.cos(state.targetYaw);
    const forwardRoom = forward >= 0 ? max - coordinate : coordinate - min;
    const backwardRoom = forward >= 0 ? coordinate - min : max - coordinate;
    // Near an end cap, fall backward without spinning the whole body around.
    if (forwardRoom < rig.height * 1.05 && backwardRoom > forwardRoom) state.fallSign = -1;
  }
  for (const bone of state.bones) {
    bone.fromPosition.copy(bone.object.position);
    bone.fromQuaternion.copy(bone.object.quaternion);
    bone.targetPosition.copy(bone.restPosition);
    bone.targetQuaternion.copy(bone.restQuaternion);
  }
  const lateral = Math.max(-0.09, Math.min(0.09, lean));
  state.targets.hips.targetPosition.y -= rig.height * 0.012;
  targetRotation(state, 'spine', -0.06);
  targetRotation(state, 'chest', 0.075, 0, lateral);
  targetRotation(state, 'head', -0.055, lateral * 2);
  targetRotation(state, 'shoulderR', 0.10, 0, -0.12);
  targetRotation(state, 'shoulderL', 0.06, 0, 0.10);
  targetRotation(state, 'elbowR', -0.35);
  targetRotation(state, 'elbowL', -0.22);
  targetRotation(state, 'hipL', -0.12, 0, 0.015);
  targetRotation(state, 'hipR', 0.035, 0, -0.015);
  targetRotation(state, 'kneeL', 0.28);
  targetRotation(state, 'kneeR', 0.16);
  targetRotation(state, 'ankleL', 0.75);
  targetRotation(state, 'ankleR', 0.68);
  rig.pose.mode = 'dead'; rig.pose.phase = 'falling';
  return true;
}

// Transform cached box centers/extents, without corners or allocations.
function expandBodyBounds(body, bounds) {
  const e = body.mesh.matrixWorld.elements, c = body.center, h = body.halfSize;
  const x = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
  const y = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
  const z = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
  const hx = Math.abs(e[0]) * h.x + Math.abs(e[4]) * h.y + Math.abs(e[8]) * h.z;
  const hy = Math.abs(e[1]) * h.x + Math.abs(e[5]) * h.y + Math.abs(e[9]) * h.z;
  const hz = Math.abs(e[2]) * h.x + Math.abs(e[6]) * h.y + Math.abs(e[10]) * h.z;
  bounds.min.x = Math.min(bounds.min.x, x - hx); bounds.max.x = Math.max(bounds.max.x, x + hx);
  bounds.min.y = Math.min(bounds.min.y, y - hy); bounds.max.y = Math.max(bounds.max.y, y + hy);
  bounds.min.z = Math.min(bounds.min.z, z - hz); bounds.max.z = Math.max(bounds.max.z, z + hz);
}

/** A short authored collapse, not rigid-body simulation. Age is simulation time. */
export function updateHumanoidCollapse(root, age, sink = 0) {
  const rig = root.userData.rig, state = rig?.collapse;
  if (!state?.active || !Number.isFinite(age) || age < 0) return false;
  const burial = Number.isFinite(sink) ? Math.max(0, sink) : 0;
  if (state.settled) {
    root.position.set(state.originX + state.offsetX, state.floorY + state.groundOffset - burial, state.originZ + state.offsetZ);
    return true;
  }
  const fall = smooth(age / COLLAPSE_DURATION);
  const relax = smooth(age / LIMB_RELAX_DURATION);
  for (const bone of state.bones) {
    bone.object.position.lerpVectors(bone.fromPosition, bone.targetPosition, relax);
    bone.object.quaternion.slerpQuaternions(bone.fromQuaternion, bone.targetQuaternion, relax);
  }
  // Yaw is outside the pitch: a west-facing body falls west, not world-south.
  root.rotation.set(
    state.startPitch + (state.fallSign * Math.PI / 2 - state.startPitch) * fall,
    state.startYaw + state.yawDelta * fall,
    state.startRoll * (1 - fall),
    'YXZ',
  );
  root.position.set(state.originX, state.floorY, state.originZ);
  root.updateMatrixWorld(true);
  _worldBounds.makeEmpty();
  for (const body of state.bodies) expandBodyBounds(body, _worldBounds);
  state.groundOffset = state.floorY - _worldBounds.min.y + FLOOR_SKIN;
  if (state.hasRegion) {
    state.offsetX = fitIntervalTranslation(_worldBounds.min.x, _worldBounds.max.x, state.region.minX, state.region.maxX);
    state.offsetZ = fitIntervalTranslation(_worldBounds.min.z, _worldBounds.max.z, state.region.minZ, state.region.maxZ);
  }
  root.position.set(state.originX + state.offsetX, state.floorY + state.groundOffset - burial, state.originZ + state.offsetZ);
  if (age >= COLLAPSE_DURATION) {
    state.settled = true;
    rig.pose.phase = 'settled';
  }
  return true;
}
