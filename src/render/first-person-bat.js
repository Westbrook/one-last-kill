import * as THREE from 'three';
import { WEAPON_DEFS } from '../game/weapon-data.js';
import { BAT_DIMENSIONS, createBatAsset } from './bat-asset.js';
import { createFirstPersonGripHands, poseFirstPersonGripHands } from './first-person-hands.js';

export const FIRST_PERSON_BAT_SECONDS = WEAPON_DEFS.bat.attackDuration;
export const BAT_CONTACT_PHASE = WEAPON_DEFS.bat.contactPhase;
const saturate = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function frame(phase, position, direction) {
  return {
    phase, position: new THREE.Vector3(...position), direction: new THREE.Vector3(...direction).normalize(),
    positionTangent: new THREE.Vector3(), directionTangent: new THREE.Vector3(),
  };
}

// Carry the barrel upright beside the right shoulder, leaning slightly back.
// The tip may leave the upper frame at narrow FOV; the full-size bat is not
// shortened or pushed forward to make its entire silhouette fit on screen.
const GUARD_POSITION = [0.22, -0.290, -0.600], GUARD_DIRECTION = [0.18, 0.974, 0.14];
const FRAMES = [
  frame(0, GUARD_POSITION, GUARD_DIRECTION),
  frame(BAT_CONTACT_PHASE * 0.48, [0.315, -0.255, -0.550], [0.35, 0.87, 0.34]),
  frame(BAT_CONTACT_PHASE * 0.80, [0.190, -0.250, -0.700], [0.40, 0.31, -0.86]),
  frame(BAT_CONTACT_PHASE, [0.045, -0.250, -0.740], [-0.10, 0.17, -0.98]),
  frame(BAT_CONTACT_PHASE + (1 - BAT_CONTACT_PHASE) * 0.40, [-0.210, -0.290, -0.660], [-0.75, -0.09, -0.66]),
  frame(BAT_CONTACT_PHASE + (1 - BAT_CONTACT_PHASE) * 0.72, [0.035, -0.320, -0.640], [0.03, -0.12, -0.993]),
  frame(1, GUARD_POSITION, GUARD_DIRECTION),
];
// The downswing stays to the right until it passes below the sight. Both it
// and contact carry velocity; the raised windup and low recovery can settle.
for (const index of [2, 3]) {
  const before = FRAMES[index - 1], after = FRAMES[index + 1];
  const inverseSpan = 1 / (after.phase - before.phase);
  FRAMES[index].positionTangent.subVectors(after.position, before.position).multiplyScalar(inverseSpan);
  FRAMES[index].directionTangent.subVectors(after.direction, before.direction).multiplyScalar(inverseSpan);
}

function interpolate(target, a, b, tangentA, tangentB, t, span) {
  const t2 = t * t, t3 = t2 * t;
  return target.copy(a).multiplyScalar(2 * t3 - 3 * t2 + 1)
    .addScaledVector(tangentA, (t3 - 2 * t2 + t) * span)
    .addScaledVector(b, -2 * t3 + 3 * t2)
    .addScaledVector(tangentB, (t3 - t2) * span);
}

/** Unit-scale camera-space model. The same wood/grip asset also serves NPCs and drops. */
export function createFirstPersonBat() {
  const model = new THREE.Group(); model.name = 'vm_bat';
  const pivot = new THREE.Group(); pivot.name = 'bat-handle-pivot';
  const asset = createBatAsset({ castShadow: false }); pivot.add(asset);
  const hands = createFirstPersonGripHands({
    radius: BAT_DIMENSIONS.gripRadius,
    lowerGripZ: BAT_DIMENSIONS.lowerGripZ,
    upperGripZ: BAT_DIMENSIONS.upperGripZ,
  });
  model.add(pivot, hands);
  model.userData.firstPersonBat = {
    pivot, asset, hands, phase: 1,
    direction: new THREE.Vector3(), xAxis: new THREE.Vector3(), yAxis: new THREE.Vector3(),
    basis: new THREE.Matrix4(),
  };
  poseFirstPersonBat(model);
  return model;
}

/** Stateless windup, passing contact, follow-through and recovery. swingT counts down 1→0. */
export function poseFirstPersonBat(model, swingT = 0, time = 0, moveBlend = 0, reducedMotion = false) {
  const rig = model?.userData.firstPersonBat;
  if (!rig) return;
  const phase = 1 - saturate(swingT), elapsed = Number.isFinite(time) ? time : 0;
  const movement = reducedMotion ? 0 : saturate(moveBlend);
  let index = 0;
  while (index < FRAMES.length - 2 && phase > FRAMES[index + 1].phase) index++;
  const a = FRAMES[index], b = FRAMES[index + 1], span = b.phase - a.phase;
  const t = saturate((phase - a.phase) / span);
  interpolate(rig.pivot.position, a.position, b.position, a.positionTangent, b.positionTangent, t, span);
  interpolate(rig.direction, a.direction, b.direction, a.directionTangent, b.directionTangent, t, span).normalize();
  const bob = movement * (1 - Math.sin(phase * Math.PI) * 0.75);
  rig.pivot.position.x += Math.cos(elapsed * 8.5) * bob * 0.003;
  rig.pivot.position.y += Math.sin(elapsed * 17) * bob * 0.004;
  // Keep the handle's radial X aligned with camera-right instead of allowing a
  // shortest-arc quaternion to flip the hands when the shaft faces forward.
  rig.xAxis.set(1, 0, 0).addScaledVector(rig.direction, -rig.direction.x).normalize();
  rig.yAxis.crossVectors(rig.direction, rig.xAxis).normalize();
  rig.basis.makeBasis(rig.xAxis, rig.yAxis, rig.direction);
  rig.pivot.quaternion.setFromRotationMatrix(rig.basis);
  poseFirstPersonGripHands(rig.hands, rig.pivot, Math.sin(phase * Math.PI));
  rig.phase = phase;
}
