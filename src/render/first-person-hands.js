import * as THREE from 'three';
import { WEAPON_DEFS } from '../game/weapon-data.js';
import { createHandDigits, getAuthoredHandGeometry, getHandArmGeometry } from './hand-geometry.js';
import { getHandMaterials } from './hand-materials.js';

export const FIRST_PERSON_PUNCH_SECONDS = WEAPON_DEFS.fists.attackDuration;
export const FIRST_PERSON_PUNCH_CONTACT_PHASE = WEAPON_DEFS.fists.contactPhase;
const UP = new THREE.Vector3(0, 1, 0);
const WRIST = new THREE.Vector3(0, -0.004, 0.092);
const saturate = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const ease = value => value * value * (3 - 2 * value);
function makeHand(root, side, radius = null) {
  const materials = getHandMaterials(), geometry = getHandArmGeometry(), label = side < 0 ? 'left' : 'right';
  const hand = new THREE.Group(); hand.name = `${label}-hand`;
  const surface = new THREE.Mesh(getAuthoredHandGeometry(side, radius), materials.hand);
  surface.name = `${label}-authored-hand`; surface.frustumCulled = false; hand.add(surface);
  const anatomy = createHandDigits(side, radius);
  const sleeve = new THREE.Mesh(geometry.sleeve, materials.sleeve);
  const cuff = new THREE.Mesh(geometry.cuff, materials.cuff);
  sleeve.name = `${label}-sleeved-forearm`; cuff.name = `${label}-wrist-cuff`;
  root.add(hand, sleeve, cuff);
  const rig = {
    side, hand, surface, palm: surface, ...anatomy, sleeve, cuff,
    anchor: new THREE.Vector3(side * 0.34, -0.465, -0.215),
    wrist: new THREE.Vector3(), direction: new THREE.Vector3(),
    lastClench: -1,
  };
  poseDigits(rig, 0);
  return rig;
}

function poseDigits(rig, clench) {
  if (Math.abs(rig.lastClench - clench) < 0.0001) return;
  for (const digit of rig.digits) {
    for (let i = 0; i < digit.joints.length; i++) {
      digit.joints[i].copy(digit.rest[i]);
      digit.joints[i].y -= clench * i * 0.00065;
      digit.joints[i].z += clench * i * 0.0005;
    }
  }
  rig.surface.morphTargetInfluences[0] = clench;
  rig.lastClench = clench;
}

function poseForearm(rig) {
  rig.hand.updateMatrix();
  rig.wrist.copy(WRIST).applyMatrix4(rig.hand.matrix);
  const length = rig.direction.subVectors(rig.wrist, rig.anchor).length();
  rig.direction.multiplyScalar(1 / length);
  rig.sleeve.position.copy(rig.anchor).add(rig.wrist).multiplyScalar(0.5);
  rig.sleeve.quaternion.setFromUnitVectors(UP, rig.direction);
  rig.sleeve.scale.set(1, length, 1);
  rig.cuff.position.copy(rig.wrist).addScaledVector(rig.direction, -0.006);
  rig.cuff.quaternion.copy(rig.sleeve.quaternion);
  rig.cuff.scale.set(0.032, 0.022, 0.031);
}

/** Reach peaks at the shared gameplay contact phase. swingT is only a visual clock. */
export function punchExtension(swingT) {
  const remaining = saturate(swingT);
  if (remaining === 0) return 0;
  const phase = 1 - remaining;
  const contact = FIRST_PERSON_PUNCH_CONTACT_PHASE;
  return phase < contact ? ease(phase / contact) : 1 - ease((phase - contact) / (1 - contact));
}

/** Camera-space meters; this model deliberately has no legacy weapon rotation or scale. */
export function createFirstPersonHands() {
  const root = new THREE.Group(); root.name = 'vm_fists';
  const left = makeHand(root, -1), right = makeHand(root, 1);
  root.userData.firstPersonHands = { left, right, order: [left, right] };
  root.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = false; object.receiveShadow = false;
  });
  poseFirstPersonHands(root);
  return root;
}

/** Pure pose from simulation state: no timers, camera changes, or per-frame geometry allocation. */
export function poseFirstPersonHands(model, swingT = 0, punchIndex = 0, time = 0, moveBlend = 0, reducedMotion = false) {
  const hands = model?.userData.firstPersonHands;
  if (!hands) return;
  const elapsed = Number.isFinite(time) ? time : 0;
  const movement = reducedMotion ? 0 : saturate(moveBlend);
  const extension = punchExtension(swingT);
  const activeSide = (Number.isFinite(punchIndex) ? punchIndex & 1 : 0) ? -1 : 1;
  const bobX = Math.cos(elapsed * 8.5) * movement * 0.005;
  const bobY = Math.sin(elapsed * 17) * movement * 0.006;
  for (const rig of hands.order) {
    const active = rig.side === activeSide;
    const reach = active ? extension : 0;
    const guard = active ? 0 : extension;
    const baseY = rig.side < 0 ? -0.245 : -0.260;
    const baseZ = rig.side < 0 ? -0.54 : -0.52;
    rig.hand.position.set(
      rig.side * (0.235 - reach * 0.16 + guard * 0.007) + bobX,
      baseY + reach * (rig.side < 0 ? 0.115 : 0.130) - guard * 0.008 + bobY,
      baseZ - reach * 0.25 + guard * 0.009,
    );
    rig.hand.rotation.set(0.12 - reach * 0.1, rig.side * (0.14 - reach * 0.08), -rig.side * (0.16 - reach * 0.1));
    poseDigits(rig, reach * 0.6 + guard * 0.10);
    poseForearm(rig);
  }
}

/** Two articulated grips around a +Z handle, using the same pooled anatomy as fists. */
export function createFirstPersonGripHands({ radius = 0.015, lowerGripZ = -0.050, upperGripZ = 0.042 } = {}) {
  const root = new THREE.Group(); root.name = 'two-hand-grip';
  const left = makeHand(root, -1, radius), right = makeHand(root, 1, radius);
  const hands = { left, right, order: [left, right] };
  root.userData.firstPersonGripHands = hands;
  for (const rig of hands.order) {
    rig.gripCenter = new THREE.Vector3(0, -0.010, -0.060);
    rig.gripZ = rig.side < 0 ? lowerGripZ : upperGripZ;
    rig.gripRadius = radius;
    // Fingers span the shaft; a small wrist roll brings both forearms below it.
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rig.side * 0.65)
      .multiply(new THREE.Quaternion().setFromAxisAngle(UP, rig.side * Math.PI / 2));
    const position = rig.gripCenter.clone().applyQuaternion(rotation).negate();
    position.z += rig.gripZ;
    rig.gripLocalMatrix = new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1));
    rig.poseMatrix = new THREE.Matrix4();
    rig.lastClench = -1; poseDigits(rig, 0);
  }
  root.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = false; object.receiveShadow = false;
  });
  poseFirstPersonGripHands(root);
  return root;
}

/** The bat and this root are siblings in camera space; no world/camera state is read. */
export function poseFirstPersonGripHands(model, batTransform = null, tension = 0) {
  const hands = model?.userData.firstPersonGripHands;
  if (!hands) return;
  if (batTransform) batTransform.updateMatrix();
  for (const rig of hands.order) {
    if (batTransform) rig.poseMatrix.multiplyMatrices(batTransform.matrix, rig.gripLocalMatrix);
    else rig.poseMatrix.copy(rig.gripLocalMatrix);
    rig.poseMatrix.decompose(rig.hand.position, rig.hand.quaternion, rig.hand.scale);
    poseDigits(rig, saturate(tension) * 0.08);
    poseForearm(rig);
  }
}
