import * as THREE from 'three';
import { HUMANOID_GEOMETRY } from './humanoid-geometry.js';
import { createCorpsePoseState } from './corpse-pose.js';
import { createBatAsset, BAT_DIMENSIONS } from './bat-asset.js';
import { sampleBatMotion, NPC_BAT_RELAXED_GUARD, gaitStrideAmplitude, sampleGaitFoot } from './humanoid-motion.js';
import { installHeroCharacter } from './hero-character.js';
import { getNPCFirearmGeometry, getNPCFirearmMaterials } from './npc-firearms.js';
export { getHumanoidVisualBounds } from './hero-character.js';

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mix = (a, b, amount) => a + (b - a) * amount;

export { HUMANOID_GEOMETRY } from './humanoid-geometry.js';

export function humanoidDimensions({ height = 1.78, build = 1, kind = 'adult' } = {}) {
  const h = Number.isFinite(height) ? clamp(height, 0.9, 2.2) : 1.78;
  const width = 1 + (clamp(Number.isFinite(build) ? build : 1, 0.7, 1.5) - 1) * 0.75;
  const headHeight = h * (kind === 'child' ? 0.16 : 0.135);
  const hipY = h * (kind === 'child' ? 0.515 : 0.535);
  const ankleY = h * 0.043;
  const kneeY = ankleY + (hipY - ankleY) * 0.5;
  return {
    height: h, width, hipY, ankleY, kneeY,
    hipSpacing: h * 0.06 * width,
    thighLength: hipY - kneeY, shinLength: kneeY - ankleY,
    thighWidth: h * 0.096 * width, shinWidth: h * 0.077 * width,
    waistY: h * 0.57, shoulderY: h * 0.827,
    shoulderSpacing: h * 0.124 * width,
    chestWidth: h * 0.25 * width, chestDepth: h * 0.147 * width,
    upperArmLength: h * 0.17, forearmLength: h * 0.146,
    upperArmWidth: h * 0.078 * Math.sqrt(width), forearmWidth: h * 0.062 * Math.sqrt(width),
    handWidth: h * 0.043, handLength: h * 0.056, handDepth: h * 0.046,
    bootWidth: h * 0.069 * Math.sqrt(width), bootHeight: h * 0.066, bootLength: h * 0.155,
    headHeight, headWidth: h * (kind === 'child' ? 0.118 : 0.109), headDepth: h * 0.124,
    headChinY: h - headHeight, neckY: h * 0.833, neckHeight: h * 0.055,
  };
}

const DEFAULT_MATERIALS = {
  skin: new THREE.MeshStandardMaterial({ color: 0xbd957e, roughness: 0.77 }),
  face: new THREE.MeshStandardMaterial({ color: 0xbd957e, roughness: 0.79 }),
  shirt: new THREE.MeshStandardMaterial({ color: 0x343b3b, roughness: 0.93 }),
  pants: new THREE.MeshStandardMaterial({ color: 0x24282b, roughness: 0.95 }),
  hair: new THREE.MeshStandardMaterial({ color: 0x201b16, roughness: 0.89 }),
  boots: new THREE.MeshStandardMaterial({ color: 0x16191a, roughness: 0.79 }),
  equipment: new THREE.MeshStandardMaterial({ color: 0x303933, roughness: 0.94 }),
};

const MUZZLE_Z = { pistol: 0.22, shotgun: 0.735, smg: 0.41, machinegun: 0.665 };
// Metres in the weapon's existing grip-local frame. The pistol support cups
// the primary hand; long-gun supports sit under their pump/forward receiver.
const SUPPORT_GRIPS = {
  pistol: [-0.039, -0.016, -0.012],
  shotgun: [0, -0.028, 0.270],
  smg: [0, -0.019, 0.184],
  machinegun: [0, -0.019, 0.220],
};

/** Shared weapon geometry is authored in meters along the grip's +Z axis. */
export function createHeldWeapon(type, material = DEFAULT_MATERIALS.equipment) {
  if (type === 'fists' || !['bat', 'pistol', 'shotgun', 'smg', 'machinegun'].includes(type)) return null;
  if (type === 'bat') return createBatAsset();
  const geometry = getNPCFirearmGeometry(type);
  const mesh = new THREE.Mesh(geometry, getNPCFirearmMaterials(type, material));
  mesh.name = `weapon:${type}`; mesh.castShadow = true;
  mesh.userData.role = 'weapon'; mesh.userData.weaponType = type;
  if (MUZZLE_Z[type]) {
    const muzzle = new THREE.Object3D(); muzzle.name = 'anchor:weaponMuzzle';
    muzzle.position.set(0, 0.041, MUZZLE_Z[type]); mesh.add(muzzle);
    mesh.userData.muzzle = muzzle;
    const supportHand = new THREE.Object3D(); supportHand.name = 'anchor:weaponSupportHand';
    supportHand.position.fromArray(SUPPORT_GRIPS[type]); mesh.add(supportHand);
    mesh.userData.anchors = { muzzle, supportHand };
  }
  return mesh;
}

export function attachHeldWeapon(root, type, material) {
  const grip = root.userData.rig?.anchors.gripR;
  if (!grip) return null;
  const weapon = createHeldWeapon(type, material);
  if (weapon) {
    grip.add(weapon);
    if (weapon.userData.muzzle) root.userData.rig.anchors.weaponMuzzle = weapon.userData.muzzle;
    root.userData.rig.ranged.weapon = weapon.userData.muzzle ? weapon : null;
    if (weapon.userData.muzzle) root.userData.rig.anchors.weaponSupportHand = weapon.userData.anchors.supportHand;
    if (type === 'bat') {
      root.userData.rig.anchors.weaponTip = weapon.userData.anchors.tip;
      root.userData.rig.anchors.weaponStrikeCenter = weapon.userData.anchors.strikeCenter;
    }
  }
  return weapon;
}

/** DOM-free rig builder. The root is at the soles and always has unit scale. */
export function createHumanoidRig(config = {}, suppliedMaterials = {}) {
  const d = humanoidDimensions(config);
  const materials = { ...DEFAULT_MATERIALS, ...suppliedMaterials };
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  root.name = `humanoid:${config.kind || 'adult'}`;
  const joints = {}, anchors = {}, bodyMeshes = [];
  function joint(name, parent, x, y, z = 0) {
    const object = new THREE.Bone(); object.name = `joint:${name}`;
    object.position.set(x, y, z); parent.add(object); joints[name] = object;
    return object;
  }
  function anchor(name, parent, x, y, z = 0) {
    const object = new THREE.Object3D(); object.name = `anchor:${name}`;
    object.position.set(x, y, z); parent.add(object); anchors[name] = object;
    return object;
  }
  function body(name, parent, geometry, material, x, y, z, sx, sy, sz) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name; mesh.userData.role = 'body';
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh); bodyMeshes.push(mesh); return mesh;
  }
  const hips = joint('hips', root, 0, d.hipY);
  const spine = joint('spine', hips, 0, d.waistY - d.hipY);
  const chestOffset = d.height * 0.13;
  const chest = joint('chest', spine, 0, chestOffset);
  const chestY = d.waistY + chestOffset;
  body('pelvis', hips, HUMANOID_GEOMETRY.pelvis, materials.pants, 0, d.height * 0.008, 0,
    d.height * 0.204 * d.width, d.height * 0.116, d.chestDepth * 0.95);
  body('torso', chest, HUMANOID_GEOMETRY.torso, materials.shirt, 0, -chestOffset, 0,
    d.chestWidth, d.height * 0.264, d.chestDepth);
  body('belt', spine, HUMANOID_GEOMETRY.belt, materials.boots, 0, -d.height * 0.009, 0,
    d.chestWidth * 0.72, d.height * 0.021, d.chestDepth * 0.79);
  const neck = joint('neck', chest, 0, d.neckY - chestY);
  body('neck', neck, HUMANOID_GEOMETRY.unitCyl, materials.skin, 0, d.neckHeight * 0.42, 0,
    d.height * 0.056, d.neckHeight, d.height * 0.055);
  const headPivotY = d.neckY + d.neckHeight * 0.46;
  const head = joint('head', neck, 0, headPivotY - d.neckY);
  const headOffset = d.headChinY - headPivotY;
  body('head', head, HUMANOID_GEOMETRY.head, materials.face, 0, headOffset, 0,
    d.headWidth, d.headHeight, d.headDepth);
  body('hair', head, HUMANOID_GEOMETRY.hair, materials.hair, 0, headOffset, 0,
    d.headWidth * 1.014, d.headHeight, d.headDepth * 1.014);
  anchor('headCenter', head, 0, headOffset + d.headHeight * 0.5, 0);
  anchor('crown', head, 0, headOffset + d.headHeight, 0);

  for (const [side, sign] of [['L', -1], ['R', 1]]) {
    const shoulder = joint(`shoulder${side}`, chest, sign * d.shoulderSpacing, d.shoulderY - chestY);
    body(`upper-arm.${side}`, shoulder, HUMANOID_GEOMETRY.upperArm, materials.shirt, 0, 0, 0,
      d.upperArmWidth, d.upperArmLength, d.upperArmWidth * 1.01);
    const elbow = joint(`elbow${side}`, shoulder, 0, -d.upperArmLength);
    body(`forearm.${side}`, elbow, HUMANOID_GEOMETRY.forearm, config.kind === 'brawler' ? materials.skin : materials.shirt, 0, 0, 0,
      d.forearmWidth, d.forearmLength, d.forearmWidth * 1.04);
    const wrist = joint(`wrist${side}`, elbow, 0, -d.forearmLength);
    body(`hand.${side}`, wrist, HUMANOID_GEOMETRY.hand, materials.skin, 0, 0, 0,
      d.handWidth * (side === 'L' ? -1 : 1), d.handLength, d.handDepth);
    const grip = anchor(`grip${side}`, wrist, 0, -d.handLength * 0.43, d.handDepth * 0.06);
    grip.rotation.x = Math.PI / 2;

    const hip = joint(`hip${side}`, hips, sign * d.hipSpacing, 0);
    body(`thigh.${side}`, hip, HUMANOID_GEOMETRY.thigh, materials.pants, 0, 0, 0,
      d.thighWidth, d.thighLength, d.thighWidth * 1.08);
    const knee = joint(`knee${side}`, hip, 0, -d.thighLength);
    body(`shin.${side}`, knee, HUMANOID_GEOMETRY.shin, materials.pants, 0, 0, 0,
      d.shinWidth, d.shinLength, d.shinWidth * 1.01);
    const ankle = joint(`ankle${side}`, knee, 0, -d.shinLength);
    body(`boot.${side}`, ankle, HUMANOID_GEOMETRY.boot, materials.boots, 0, -d.ankleY, d.bootLength * 0.13,
      d.bootWidth, d.bootHeight, d.bootLength);
    anchor(`sole${side}`, ankle, 0, -d.ankleY, d.bootLength * 0.04);
  }

  if (['gunman', 'hitman', 'bruiser', 'player'].includes(config.kind)) {
    body('vest', chest, HUMANOID_GEOMETRY.vest, materials.equipment, 0, -chestOffset * 0.7, d.chestDepth * 0.09,
      d.chestWidth * 0.91, d.height * 0.213, d.chestDepth * 1.025);
    body('chest-pouch', chest, HUMANOID_GEOMETRY.unitBox, materials.equipment, 0, -d.height * 0.01, d.chestDepth * 0.59,
      d.chestWidth * 0.52, d.height * 0.071, d.height * 0.029);
  }

  const neutral = Object.values(joints).map(object => ({ object, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() }));
  const rig = {
    version: 2, height: d.height, dimensions: d, joints, anchors, bodyMeshes, neutral,
    pose: { mode: 'idle', phase: 'idle', gait: 0, clock: 0 },
    motion: { batReady: 0, stance: 0, walk: 0, stride: 0 },
    ranged: { weapon: null, aim: 0 },
    reset: () => resetHumanoidPose(root),
  };
  installHeroCharacter(root, rig, config);
  rig.collapse = createCorpsePoseState({ ...rig, bodyMeshes: rig.visualBoundsProxies });
  root.userData = {
    config: { ...config, height: d.height }, rig,
    parts: { torso: chest, head, armL: joints.shoulderL, armR: joints.shoulderR, legL: joints.hipL, legR: joints.hipR },
    hitZones: { headAnchor: anchors.headCenter, headHalfWidth: d.headWidth * 0.64, headHalfHeight: d.headHeight * 0.54, headHalfDepth: d.headDepth * 0.67 },
  };
  root.updateMatrixWorld(true);
  return root;
}

export function resetHumanoidPose(root) {
  const rig = root.userData.rig;
  if (!rig) return;
  for (const rest of rig.neutral) {
    rest.object.position.copy(rest.position);
    rest.object.quaternion.copy(rest.quaternion);
    rest.object.scale.copy(rest.scale);
  }
  rig.pose.mode = 'idle'; rig.pose.phase = 'idle'; rig.pose.gait = 0; rig.pose.clock = 0;
  rig.motion.batReady = 0; rig.motion.stance = 0; rig.motion.walk = 0; rig.motion.stride = 0;
  rig.ranged.aim = 0;
  rig.collapse.active = false; rig.collapse.settled = false; rig.collapse.groundOffset = 0;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const _target = new THREE.Vector3(), _direction = new THREE.Vector3(), _bend = new THREE.Vector3();
const _upper = new THREE.Vector3(), _lower = new THREE.Vector3();
const _inverse = new THREE.Quaternion(), _combined = new THREE.Quaternion();
const LEG_PHASES = [['L', 0], ['R', Math.PI]];
const _gaitFoot = {}, _legTarget = new THREE.Vector3(), _hipsInverse = new THREE.Quaternion();
const _batMotion = {}, _batGrip = new THREE.Vector3(), _supportGrip = new THREE.Vector3();
const _batDirection = new THREE.Vector3(), _wristOffset = new THREE.Vector3();
const _batRotation = new THREE.Quaternion(), _wristRotation = new THREE.Quaternion();
const _batEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _gripInverse = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const _gunGrip = new THREE.Vector3(), _gunSupportOffset = new THREE.Vector3();
const _gunRotation = new THREE.Quaternion(), _gunEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _gunChestInverse = new THREE.Quaternion();
const _reachR = new THREE.Vector3(), _reachL = new THREE.Vector3();
const _reachAxis = new THREE.Vector3(), _reachCenter = new THREE.Vector3(), _reachRadial = new THREE.Vector3();

// Two-bone IK keeps stance soles on the floor while hips lower and knees flex.
function poseLeg(hip, knee, ankle, x, y, z, thighLength, shinLength) {
  _target.set(x, y, z);
  const distance = clamp(_target.length(), 0.001, thighLength + shinLength - 1e-5);
  _direction.copy(_target).normalize();
  _bend.set(0, 0, 1).addScaledVector(_direction, -_direction.z).normalize();
  const along = (thighLength * thighLength + distance * distance - shinLength * shinLength) / (2 * distance);
  const outward = Math.sqrt(Math.max(0, thighLength * thighLength - along * along));
  _upper.copy(_direction).multiplyScalar(along).addScaledVector(_bend, outward);
  hip.quaternion.setFromUnitVectors(DOWN, _upper.normalize());
  _lower.copy(_direction).multiplyScalar(distance).addScaledVector(_upper, -thighLength).normalize();
  _inverse.copy(hip.quaternion).invert();
  _lower.applyQuaternion(_inverse);
  knee.quaternion.setFromUnitVectors(DOWN, _lower);
  _combined.copy(hip.quaternion).multiply(knee.quaternion).invert();
  // The pelvis turns over the support leg, but a planted boot stays level.
  ankle.quaternion.copy(_combined).multiply(_hipsInverse);
}

function rotateToward(joint, x, y, z, blend) {
  joint.rotation.x = mix(joint.rotation.x, x, blend);
  joint.rotation.y = mix(joint.rotation.y, y, blend);
  joint.rotation.z = mix(joint.rotation.z, z, blend);
}

// Solve in chest space, avoiding a matrix traversal or temporary objects per
// hand. The wrist rotates independently; every bone keeps its authored length.
function poseArmToGrip(shoulder, elbow, wrist, grip, sign, d) {
  _wristOffset.set(0, -d.handLength * 0.43, d.handDepth * 0.06).applyQuaternion(_wristRotation);
  _target.copy(grip).sub(_wristOffset).sub(shoulder.position);
  const distance = clamp(_target.length(), 0.001, d.upperArmLength + d.forearmLength - 1e-5);
  _direction.copy(_target).normalize();
  _bend.set(sign * 0.7, -0.6, -0.12);
  _bend.addScaledVector(_direction, -_bend.dot(_direction)).normalize();
  const along = (d.upperArmLength ** 2 + distance ** 2 - d.forearmLength ** 2) / (2 * distance);
  const outward = Math.sqrt(Math.max(0, d.upperArmLength ** 2 - along ** 2));
  _upper.copy(_direction).multiplyScalar(along).addScaledVector(_bend, outward).normalize();
  shoulder.quaternion.setFromUnitVectors(DOWN, _upper);
  _lower.copy(_direction).multiplyScalar(distance).addScaledVector(_upper, -d.upperArmLength).normalize();
  _inverse.copy(shoulder.quaternion).invert();
  _lower.applyQuaternion(_inverse);
  elbow.quaternion.setFromUnitVectors(DOWN, _lower);
  _combined.copy(shoulder.quaternion).multiply(elbow.quaternion).invert();
  wrist.quaternion.copy(_combined).multiply(_wristRotation);
}

function poseBatHands(j, d, ready) {
  // Even an unalert guard carries the bat beside the shoulder, barrel up and
  // behind the body. Readiness raises the hands rather than aiming it forward.
  const relaxed = NPC_BAT_RELAXED_GUARD;
  _batGrip.set(mix(relaxed.gripX, _batMotion.gripX, ready) * d.height,
    mix(relaxed.gripY, _batMotion.gripY, ready) * d.height,
    mix(relaxed.gripZ, _batMotion.gripZ, ready) * d.height);
  _batEuler.set(mix(relaxed.pitch, _batMotion.pitch, ready), mix(relaxed.yaw, _batMotion.yaw, ready), 0, 'YXZ');
  _batRotation.setFromEuler(_batEuler);
  _batDirection.set(0, 0, 1).applyQuaternion(_batRotation);
  _wristRotation.copy(_batRotation).multiply(_gripInverse);
  // A right-handed swing places the supporting left hand below the right.
  // Shorter rigs need less spacing, not a scaled-down weapon or longer bones.
  const spacing = -Math.min(Math.abs(BAT_DIMENSIONS.npcSupportGripZ), d.handLength * 0.87);
  _supportGrip.copy(_batGrip).addScaledVector(_batDirection, spacing);
  poseArmToGrip(j.shoulderR, j.elbowR, j.wristR, _batGrip, 1, d);
  poseArmToGrip(j.shoulderL, j.elbowL, j.wristL, _supportGrip, -1, d);
}

// Both wrist targets must be reachable before solving either arm. In terms
// of the primary grip, each shoulder defines a sphere of possible positions.
// Constrain to their intersection without scaling bones or traversing matrices.
function constrainRangedGrip(j, d) {
  const reach = (d.upperArmLength + d.forearmLength) * 0.97;
  const foldedReach = Math.abs(d.upperArmLength - d.forearmLength) + 1e-4;
  _wristOffset.set(0, -d.handLength * 0.43, d.handDepth * 0.06).applyQuaternion(_wristRotation);
  _reachR.copy(j.shoulderR.position).add(_wristOffset);
  _reachL.copy(j.shoulderL.position).add(_wristOffset).sub(_gunSupportOffset);
  const rightDistance = _gunGrip.distanceToSquared(_reachR), leftDistance = _gunGrip.distanceToSquared(_reachL);
  if (rightDistance <= reach * reach && leftDistance <= reach * reach
    && rightDistance >= foldedReach * foldedReach && leftDistance >= foldedReach * foldedReach) return;
  _reachAxis.subVectors(_reachR, _reachL);
  const separation = _reachAxis.length();
  _reachAxis.multiplyScalar(1 / Math.max(separation, 1e-6));
  _reachCenter.copy(_reachR).add(_reachL).multiplyScalar(0.5);
  _reachRadial.subVectors(_gunGrip, _reachCenter);
  const originalAlong = _reachRadial.dot(_reachAxis);
  const extent = Math.max(0, reach - separation / 2);
  const along = clamp(originalAlong, -extent, extent);
  _reachRadial.addScaledVector(_reachAxis, -originalAlong);
  const radius = Math.sqrt(Math.max(0, reach * reach - (Math.abs(along) + separation / 2) ** 2));
  _reachRadial.clampLength(0, radius);
  _gunGrip.copy(_reachCenter).addScaledVector(_reachAxis, along).add(_reachRadial);
  // Very short rigs cannot fold unequal upper/forearm lengths to zero.
  if (_gunGrip.distanceToSquared(_reachR) < foldedReach * foldedReach) _gunGrip.copy(_reachR).addScaledVector(_reachAxis, -foldedReach);
  if (_gunGrip.distanceToSquared(_reachL) < foldedReach * foldedReach) _gunGrip.copy(_reachL).addScaledVector(_reachAxis, foldedReach);
}

function poseRangedHands(rig, state, blend, moving) {
  const { joints: j, dimensions: d, ranged, pose } = rig;
  const targetAim = Number.isFinite(state.aim) ? clamp(state.aim, 0, 1) : 0;
  ranged.aim = mix(ranged.aim, targetAim, blend);
  const aim = ranged.aim, pistol = ranged.weapon.userData.weaponType === 'pistol';
  const pitch = (pistol ? 0.76 : 0.50) * (1 - aim);
  const yaw = (pistol ? -0.06 : -0.35) * (1 - aim);
  _gunEuler.set(pitch, yaw, 0, 'YXZ');
  _gunRotation.setFromEuler(_gunEuler);
  // The actor's +Z is its aiming direction. Counter chest breathing/stride
  // locally, so a level aimed barrel does not point across the shot direction.
  _gunChestInverse.copy(j.hips.quaternion).multiply(j.spine.quaternion).multiply(j.chest.quaternion).invert();
  _gunRotation.premultiply(_gunChestInverse);
  _wristRotation.copy(_gunRotation).multiply(_gripInverse);
  _gunGrip.set(
    (pistol ? mix(0.08, 0.025, aim) : 0.078) * d.height,
    (pistol ? mix(-0.015, 0.115, aim) : mix(0.055, 0.090, aim)) * d.height,
    (pistol ? mix(0.125, 0.245, aim) : 0.105) * d.height,
  );
  _gunGrip.y += Math.sin(pose.gait * 2) * moving * (1 - aim) * d.height * 0.002;
  _gunSupportOffset.copy(ranged.weapon.userData.anchors.supportHand.position).applyQuaternion(_gunRotation);
  constrainRangedGrip(j, d);
  _supportGrip.copy(_gunGrip).add(_gunSupportOffset);
  poseArmToGrip(j.shoulderR, j.elbowR, j.wristR, _gunGrip, 1, d);
  poseArmToGrip(j.shoulderL, j.elbowL, j.wristL, _supportGrip, -1, d);
}

const smooth = value => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Pose input: mode, speed, forward, strafe, alert, aim, swingProgress, swingSide, stagger. */
export function updateHumanoidPose(root, state = {}, dt = 1 / 60) {
  const rig = root.userData.rig;
  if (!rig || !Number.isFinite(dt) || dt <= 0) return;
  const { dimensions: d, joints: j, pose, motion } = rig;
  const step = Math.min(dt, 0.1);
  const blend = 1 - Math.exp(-step * 18);
  const speed = Math.max(0, Number.isFinite(state.speed) ? state.speed : 0);
  pose.clock += step;
  pose.mode = state.mode || (speed > 0.1 ? 'walk' : 'idle');
  const swing = Number.isFinite(state.swingProgress) ? state.swingProgress : -1;
  pose.phase = swing < 0 ? 'idle' : swing < 0.4 ? 'windup' : swing < 0.62 ? 'contact' : 'recovery';
  const melee = pose.mode === 'bat' || pose.mode === 'fist';
  const attacking = melee && swing >= 0;
  const targetMoving = attacking ? 0 : clamp(speed / 3.6, 0, 1);
  const targetStride = attacking ? 0 : gaitStrideAmplitude(speed, d.height);
  motion.walk = attacking ? 0 : mix(motion.walk, targetMoving, blend);
  motion.stride = attacking ? 0 : mix(motion.stride, targetStride, blend);
  const moving = motion.walk;
  const alert = attacking ? 1 : clamp(state.alert || 0, 0, 1);
  const poseBlend = attacking ? 1 : blend;
  if (targetStride > 1e-6 && !attacking) pose.gait += speed * step / (4 * targetStride) * TAU;
  motion.batReady = pose.mode === 'bat' && attacking ? 1 : mix(motion.batReady, pose.mode === 'bat' ? alert : 0, blend);
  motion.stance = attacking ? 1 : mix(motion.stance, melee ? alert * (1 - moving) : 0, blend);
  const batReady = pose.mode === 'bat' ? motion.batReady : 0;
  sampleBatMotion(swing < 0 ? 0 : swing, _batMotion);
  const extension = pose.mode !== 'fist' || swing < 0 ? 0
    : swing < 0.5 ? smooth((swing - 0.28) / 0.22) : 1 - smooth((swing - 0.58) / 0.42);
  const stride = motion.stride;
  const gaitSide = Math.sin(pose.gait) * moving;
  const restingWeight = -0.009 * (1 - alert) * (1 - moving);
  // The wider stride needs knee compression at double support. The body
  // rises slightly as it passes over a foot, rather than bobbing arbitrarily.
  const sink = d.height * mix(0.009 + 0.051 * moving + motion.stance * 0.012 + extension * 0.01, _batMotion.sink, batReady * (1 - moving));
  const hipX = d.height * (batReady * _batMotion.hipX - extension * 0.012 - gaitSide * 0.008 + restingWeight);
  const hipZ = d.height * (batReady * _batMotion.hipZ + extension * 0.024);
  j.hips.position.set(hipX, d.hipY - sink - Math.cos(pose.gait * 2) * moving * d.height * 0.0035, hipZ);
  rotateToward(j.hips, 0, gaitSide * 0.035, gaitSide * 0.014, poseBlend);
  _hipsInverse.copy(j.hips.quaternion).invert();
  const rawForward = state.forward === undefined ? 1 : clamp(state.forward, -1, 1);
  const rawStrafe = clamp(state.strafe || 0, -1, 1);
  const directionLength = Math.hypot(rawForward, rawStrafe);
  const forward = directionLength > 1e-6 ? rawForward / directionLength : 1;
  const strafe = directionLength > 1e-6 ? rawStrafe / directionLength : 0;
  for (const [side, offset] of LEG_PHASES) {
    sampleGaitFoot(pose.gait + offset, stride, Math.min(0.09, d.height * 0.047 * moving), _gaitFoot);
    const { travel, lift } = _gaitFoot;
    const stanceX = (side === 'L' ? -1 : 1) * d.height * 0.012 * motion.stance;
    const stanceZ = (side === 'L' ? 0.06 : -0.045) * d.height * motion.stance;
    const hip = j[`hip${side}`];
    _legTarget.set((side === 'L' ? -1 : 1) * d.hipSpacing + travel * strafe + stanceX,
      d.ankleY + lift, travel * forward + stanceZ).sub(j.hips.position).applyQuaternion(_hipsInverse).sub(hip.position);
    poseLeg(j[`hip${side}`], j[`knee${side}`], j[`ankle${side}`],
      _legTarget.x, _legTarget.y, _legTarget.z,
      d.thighLength, d.shinLength);
  }
  const breathing = Math.sin(pose.clock * 2.1) * mix(0.009, 0.003, melee ? alert : 0);
  const chestYaw = batReady * _batMotion.chestYaw + extension * (state.swingSide === 'L' ? 0.17 : -0.17);
  rotateToward(j.spine, 0.035 * moving + motion.stance * 0.015, -gaitSide * 0.055, -j.hips.rotation.z * 0.25, poseBlend);
  rotateToward(j.chest, breathing + (state.stagger ? -0.1 : 0) + extension * 0.065 + batReady * 0.022,
    chestYaw - gaitSide * 0.015, -hipX * 0.3 - j.hips.rotation.z * 0.65, poseBlend);
  // Share gaze stabilization between the neck and skull. This keeps the
  // head settled over a turning chest without a rigid, single-joint swivel.
  const upperPitch = j.spine.rotation.x + j.chest.rotation.x;
  const upperYaw = j.hips.rotation.y + j.spine.rotation.y + j.chest.rotation.y;
  const upperRoll = j.hips.rotation.z + j.spine.rotation.z + j.chest.rotation.z;
  const headPitch = -0.02 - upperPitch * 0.76 + motion.stance * 0.03;
  const headYaw = Math.sin(pose.clock * 0.63) * 0.018 * (1 - alert) - upperYaw * 0.68;
  // The torso angles already ease above. Filtering their inverse again
  // would delay the correction and make the head wag behind every step.
  rotateToward(j.neck, headPitch * 0.38, headYaw * 0.38, -upperRoll * 0.32, 1);
  rotateToward(j.head, headPitch * 0.62, headYaw * 0.62, -upperRoll * 0.52, 1);

  const armPhase = Math.cos(pose.gait);
  const armSwing = -armPhase * moving * 0.30;
  let rx = armSwing, lx = -armSwing;
  let re = -0.13 - Math.max(0, armPhase) * moving * 0.13;
  let le = -0.09 - Math.max(0, -armPhase) * moving * 0.13;
  let rz = -0.055, lz = 0.055;
  if (pose.mode === 'ranged') {
    const aim = clamp(state.aim || 0, 0, 1);
    rx = mix(-0.28, -1.08, aim); re = mix(-0.43, -0.49, aim);
    lx = mix(-0.21, -0.96, aim); le = mix(-0.53, -0.7, aim);
    rz = -0.26 * aim; lz = 0.37 * aim;
  } else if (pose.mode === 'fist') {
    rx = mix(rx, -0.96, alert); lx = mix(lx, -0.87, alert);
    re = mix(re, -1.53, alert); le = mix(le, -1.59, alert);
    rz = -0.1; lz = 0.1;
    if (swing >= 0) {
      const windup = Math.sin(clamp(swing / 0.4, 0, 1) * Math.PI) * 0.16;
      if (state.swingSide === 'L') { lx = mix(-0.87 + windup, -1.49, extension); le = mix(-1.59, -0.09, extension); }
      else { rx = mix(-0.96 + windup, -1.49, extension); re = mix(-1.53, -0.09, extension); }
    }
  }
  if (pose.mode === 'bat') {
    poseBatHands(j, d, batReady);
  } else if (pose.mode === 'ranged' && rig.ranged.weapon) {
    poseRangedHands(rig, state, blend, moving);
  } else {
    rig.ranged.aim = 0;
    const armBlend = attacking ? 1 : 1 - Math.exp(-step * 30);
    rotateToward(j.shoulderR, rx, 0, rz, armBlend);
    rotateToward(j.shoulderL, lx, 0, lz, armBlend);
    rotateToward(j.elbowR, re, 0, 0, armBlend);
    rotateToward(j.elbowL, le, 0, 0, armBlend);
    rotateToward(j.wristR, 0, 0, 0, armBlend);
    rotateToward(j.wristL, 0, 0, 0, armBlend);
  }
}
