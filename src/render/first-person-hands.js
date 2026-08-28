import * as THREE from 'three';
import { WEAPON_DEFS } from '../game/weapon-data.js';

export const FIRST_PERSON_PUNCH_SECONDS = WEAPON_DEFS.fists.attackDuration;
export const FIRST_PERSON_PUNCH_CONTACT_PHASE = WEAPON_DEFS.fists.contactPhase;
const UP = new THREE.Vector3(0, 1, 0);
const WRIST = new THREE.Vector3(0, -0.004, 0.092);
const saturate = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const ease = value => value * value * (3 - 2 * value);
let shared = null;

function resources() {
  if (shared) return shared;
  const palm = new THREE.SphereGeometry(1, 14, 10);
  const position = palm.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i), y = position.getY(i);
    // A broad metacarpal arch tapers into the wrist; there is no skin box.
    position.setX(i, position.getX(i) * (0.85 - z * 0.18));
    position.setY(i, Math.sign(y) * Math.pow(Math.abs(y), 0.85));
  }
  palm.computeVertexNormals();
  shared = {
    palm,
    capsule: new THREE.CapsuleGeometry(1, 1, 3, 8),
    sphere: new THREE.SphereGeometry(1, 10, 8),
    sleeve: new THREE.CylinderGeometry(0.030, 0.040, 1, 12, 2),
    cuff: new THREE.CylinderGeometry(1, 1, 1, 12, 1),
    skin: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, envMapIntensity: 0.26 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x303637, roughness: 0.95, metalness: 0, envMapIntensity: 0.16 }),
    cloth: new THREE.MeshStandardMaterial({ color: 0x1d2425, roughness: 0.97, metalness: 0, envMapIntensity: 0.12 }),
    nail: new THREE.MeshStandardMaterial({ color: 0xae9c8c, roughness: 0.72, metalness: 0, envMapIntensity: 0.2 }),
  };
  return shared;
}

function makeDigit(name, points, radius) {
  return {
    name, radius,
    rest: points.map(point => new THREE.Vector3(...point)),
    joints: points.map(point => new THREE.Vector3(...point)),
  };
}

function makeHand(root, side) {
  const assets = resources(), label = side < 0 ? 'left' : 'right';
  const hand = new THREE.Group(); hand.name = `${label}-hand`;
  const palm = new THREE.Mesh(assets.palm, assets.glove);
  palm.name = `${label}-gloved-palm`;
  palm.scale.set(0.042, 0.023, 0.052); palm.position.z = 0.004;
  hand.add(palm);
  const fingers = [
    [-0.027, -0.044, 1], [-0.009, -0.049, 1.04],
    [0.010, -0.046, 0.97], [0.028, -0.040, 0.84],
  ].map(([x, z, length], index) => makeDigit(['index', 'middle', 'ring', 'little'][index], [
    [side * x, 0.015, z],
    [side * x, 0.015 - 0.006 * length, z - 0.014 * length],
    [side * x, 0.015 - 0.027 * length, z - 0.016 * length],
    [side * x, 0.015 - 0.040 * length, z + 0.003 * length],
  ], 0.0085 * Math.sqrt(length)));
  const thumb = makeDigit('thumb', [
    [-side * 0.036, 0.001, 0.019],
    [-side * 0.051, -0.006, -0.012],
    [-side * 0.030, -0.023, -0.038],
  ], 0.011);
  const segments = new THREE.InstancedMesh(assets.capsule, assets.skin, 15);
  const knuckles = new THREE.InstancedMesh(assets.sphere, assets.skin, 15);
  segments.name = `${label}-finger-segments`; knuckles.name = `${label}-knuckles`;
  segments.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  knuckles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // These compact camera-held batches never require a per-frame bounds pass.
  segments.frustumCulled = false; knuckles.frustumCulled = false;
  hand.add(segments, knuckles);
  const nail = new THREE.Mesh(assets.sphere, assets.nail);
  nail.name = `${label}-thumbnail`;
  nail.scale.set(0.0058, 0.0014, 0.008);
  nail.rotation.z = side * 0.45; hand.add(nail);
  const sleeve = new THREE.Mesh(assets.sleeve, assets.cloth);
  const cuff = new THREE.Mesh(assets.cuff, assets.glove);
  sleeve.name = `${label}-sleeved-forearm`; cuff.name = `${label}-wrist-cuff`;
  root.add(hand, sleeve, cuff);
  const rig = {
    side, hand, palm, fingers, thumb, digits: [...fingers, thumb], segments, knuckles, nail, sleeve, cuff,
    anchor: new THREE.Vector3(side * 0.34, -0.465, -0.215),
    wrist: new THREE.Vector3(), direction: new THREE.Vector3(),
    transform: new THREE.Object3D(), color: new THREE.Color(),
    lastClench: -1,
  };
  poseDigits(rig, 0);
  return rig;
}

function poseDigits(rig, clench) {
  if (Math.abs(rig.lastClench - clench) < 0.0001) return;
  const { transform, direction, color } = rig;
  const firstPose = rig.lastClench < 0;
  let segmentIndex = 0, knuckleIndex = 0;
  function capsule(a, b, radius, tint) {
    const length = direction.subVectors(b, a).length();
    direction.multiplyScalar(1 / length);
    transform.position.copy(a).add(b).multiplyScalar(0.5);
    transform.quaternion.setFromUnitVectors(UP, direction);
    transform.scale.set(radius, (length + radius * 1.1) / 3, radius);
    transform.updateMatrix(); rig.segments.setMatrixAt(segmentIndex, transform.matrix);
    if (firstPose) rig.segments.setColorAt(segmentIndex, color.setHex(tint));
    segmentIndex++;
  }
  function joint(position, sx, sy, sz, tint) {
    transform.position.copy(position); transform.quaternion.identity(); transform.scale.set(sx, sy, sz);
    transform.updateMatrix(); rig.knuckles.setMatrixAt(knuckleIndex, transform.matrix);
    if (firstPose) rig.knuckles.setColorAt(knuckleIndex, color.setHex(tint));
    knuckleIndex++;
  }
  for (const digit of rig.digits) {
    for (let i = 0; i < digit.joints.length; i++) {
      digit.joints[i].copy(digit.rest[i]);
      digit.joints[i].y -= clench * i * 0.00065;
      digit.joints[i].z += clench * i * 0.0005;
    }
    for (let i = 0; i < digit.joints.length - 1; i++) {
      const radius = digit.radius * (1 - i * 0.075);
      capsule(digit.joints[i], digit.joints[i + 1], radius, i === 0 ? 0xb5947e : 0xb99a84);
      joint(digit.joints[i], radius * 1.05, radius * 0.85, radius, i === 0 ? 0xc0a08a : 0xb4937e);
    }
  }
  // Thenar pad and a visible wrist bridge keep the thumb and sleeve attached.
  transform.position.set(-rig.side * 0.026, -0.004, 0.019);
  joint(transform.position, 0.020, 0.018, 0.027, 0xb0907b);
  transform.position.set(0, -0.002, 0.041);
  capsule(transform.position, WRIST, 0.022, 0xae8d78);
  rig.nail.position.copy(rig.thumb.joints[2]);
  rig.nail.position.y += 0.0095; rig.nail.position.z += 0.002;
  rig.segments.instanceMatrix.needsUpdate = true;
  rig.knuckles.instanceMatrix.needsUpdate = true;
  if (firstPose) {
    rig.segments.instanceColor.needsUpdate = true; rig.knuckles.instanceColor.needsUpdate = true;
  }
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
  const left = makeHand(root, -1), right = makeHand(root, 1);
  const hands = { left, right, order: [left, right] };
  root.userData.firstPersonGripHands = hands;
  for (const rig of hands.order) {
    rig.gripCenter = new THREE.Vector3(0, -0.010, -0.060);
    rig.gripZ = rig.side < 0 ? lowerGripZ : upperGripZ;
    rig.gripRadius = radius;
    for (const digit of rig.fingers) {
      const centerline = radius + digit.radius - 0.001;
      const angles = [0.72, -0.30, -1.30, -2.35];
      for (let i = 0; i < digit.rest.length; i++) {
        digit.rest[i].y = rig.gripCenter.y + centerline * Math.cos(angles[i]);
        digit.rest[i].z = rig.gripCenter.z + centerline * Math.sin(angles[i]);
      }
    }
    rig.thumb.rest[0].set(-rig.side * 0.035, 0.004, -0.010);
    rig.thumb.rest[1].set(-rig.side * 0.047, -0.012, -0.039);
    rig.thumb.rest[2].set(-rig.side * 0.026, -0.031, -0.073);
    rig.nail.visible = false;
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
