import * as THREE from 'three';
import { WEAPON_DEFS } from '../game/weapon-data.js';
import { createHandDigits, getAuthoredHandGeometry, getHandArmGeometry } from './hand-geometry.js';
import { getHandMaterials } from './hand-materials.js';

export const FIRST_PERSON_PUNCH_SECONDS = WEAPON_DEFS.fists.attackDuration;
export const FIRST_PERSON_PUNCH_CONTACT_PHASE = WEAPON_DEFS.fists.contactPhase;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const WRIST = new THREE.Vector3(0, -0.004, 0.092);
const GRIP_ARM_LENGTH = 0.5;
const GRIP_FOREARM_LENGTH = 0.16;
const saturate = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const ease = value => value * value * (3 - 2 * value);
let gripSleeveGeometry;

function makeGripSleeve(root, rig) {
  if (!gripSleeveGeometry) {
    // A bat's elbows must follow the two-handed grip. Keep the wrist end rigid
    // with the palm, and let the sleeve bend at the elbow farther down the arm.
    // These pooled skin weights leave the fist/firearm geometry untouched.
    gripSleeveGeometry = getHandArmGeometry().sleeve.clone();
    gripSleeveGeometry.scale(1, GRIP_ARM_LENGTH, 1).translate(0, -GRIP_ARM_LENGTH * 0.5, 0);
    const positions = gripSleeveGeometry.attributes.position;
    const indices = [], weights = [];
    for (let i = 0; i < positions.count; i++) {
      const distance = -positions.getY(i);
      const blend = ease(saturate((distance - GRIP_FOREARM_LENGTH + 0.04) / 0.08));
      indices.push(0, 1, 0, 0); weights.push(1 - blend, blend, 0, 0);
    }
    gripSleeveGeometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    gripSleeveGeometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    gripSleeveGeometry.computeBoundingBox(); gripSleeveGeometry.computeBoundingSphere();
  }
  const sleeve = new THREE.SkinnedMesh(gripSleeveGeometry, rig.sleeve.material);
  sleeve.name = rig.sleeve.name; sleeve.frustumCulled = false;
  const wristBone = new THREE.Bone(), elbowBone = new THREE.Bone();
  elbowBone.position.y = -GRIP_FOREARM_LENGTH;
  wristBone.add(elbowBone); sleeve.add(wristBone);
  sleeve.bind(new THREE.Skeleton([wristBone, elbowBone]));
  root.remove(rig.sleeve); root.add(sleeve); rig.sleeve = sleeve;
  rig.elbowBone = elbowBone;
  rig.elbow = new THREE.Vector3(); rig.upperArmDirection = new THREE.Vector3();
  rig.armBasis = new THREE.Matrix4(); rig.inverseArm = new THREE.Quaternion();
}
function makeHand(root, side, radius = null) {
  const surfaceGeometry = getAuthoredHandGeometry(side, radius), geometry = getHandArmGeometry(), label = side < 0 ? 'left' : 'right';
  const materials = getHandMaterials({ authored: surfaceGeometry.userData.authoredHand?.finish === 'blender-baked-v2' });
  const hand = new THREE.Group(); hand.name = `${label}-hand`;
  const surface = new THREE.Mesh(surfaceGeometry, materials.hand);
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
    // A two-handed stance tucks the arms closer to the torso than the fists'
    // wide guard, keeping the windup's wrists visible at narrow tablet FOVs.
    rig.anchor.x = rig.side * 0.20;
    rig.gripCenter = new THREE.Vector3(0, -0.010, -0.060);
    rig.gripZ = rig.side < 0 ? lowerGripZ : upperGripZ;
    rig.gripRadius = radius;
    rig.gripAnchor = new THREE.Vector3(); rig.shaft = new THREE.Vector3();
    rig.xAxis = new THREE.Vector3(); rig.yAxis = new THREE.Vector3(); rig.zAxis = new THREE.Vector3();
    rig.poseMatrix = new THREE.Matrix4();
    makeGripSleeve(root, rig);
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
    rig.gripAnchor.set(0, 0, rig.gripZ); rig.shaft.set(0, 0, 1);
    if (batTransform) {
      rig.gripAnchor.applyMatrix4(batTransform.matrix);
      rig.shaft.transformDirection(batTransform.matrix);
    }
    // Local X spans the shaft, so both thumbs point toward the barrel. Local
    // +Z runs from knuckles through wrist into the forearm. Roll the grip about
    // the shaft toward its arm instead of hinging the sleeve at a fixed palm.
    rig.xAxis.copy(rig.shaft).multiplyScalar(-rig.side);
    rig.zAxis.subVectors(rig.anchor, rig.gripAnchor);
    rig.zAxis.addScaledVector(rig.shaft, -rig.zAxis.dot(rig.shaft));
    if (rig.zAxis.lengthSq() < 1e-8) {
      rig.zAxis.set(0, -1, 0);
      if (Math.abs(rig.shaft.y) > 0.9) rig.zAxis.set(0, 0, 1);
      rig.zAxis.addScaledVector(rig.shaft, -rig.zAxis.dot(rig.shaft));
    }
    rig.zAxis.normalize(); rig.yAxis.crossVectors(rig.zAxis, rig.xAxis).normalize();
    rig.poseMatrix.makeBasis(rig.xAxis, rig.yAxis, rig.zAxis);
    rig.hand.quaternion.setFromRotationMatrix(rig.poseMatrix);
    rig.hand.position.copy(rig.gripCenter).applyQuaternion(rig.hand.quaternion).negate().add(rig.gripAnchor);
    poseDigits(rig, saturate(tension) * 0.08);
    rig.hand.updateMatrix(); rig.wrist.copy(WRIST).applyMatrix4(rig.hand.matrix);
    rig.elbow.copy(rig.wrist).addScaledVector(rig.zAxis, GRIP_FOREARM_LENGTH);
    rig.direction.copy(rig.zAxis).negate();
    rig.armBasis.makeBasis(rig.xAxis, rig.direction, rig.yAxis);
    rig.sleeve.position.copy(rig.wrist); rig.sleeve.quaternion.setFromRotationMatrix(rig.armBasis);
    rig.upperArmDirection.subVectors(rig.anchor, rig.elbow);
    const upperLength = rig.upperArmDirection.length();
    rig.inverseArm.copy(rig.sleeve.quaternion).invert();
    rig.upperArmDirection.multiplyScalar(1 / upperLength).applyQuaternion(rig.inverseArm);
    rig.elbowBone.quaternion.setFromUnitVectors(DOWN, rig.upperArmDirection);
    rig.elbowBone.scale.y = upperLength / (GRIP_ARM_LENGTH - GRIP_FOREARM_LENGTH);
    rig.cuff.position.copy(rig.wrist).addScaledVector(rig.zAxis, 0.006);
    rig.cuff.quaternion.copy(rig.sleeve.quaternion); rig.cuff.scale.set(0.032, 0.022, 0.031);
  }
}
