import * as THREE from 'three';
import { createAuthoredGripHand } from './hand-geometry.js';

const PRIMARY = {
  pistol: [-0.052, -0.060, 0.012], shotgun: [-0.105, -0.020, 0],
  smg: [-0.090, -0.065, 0.006], machinegun: [-0.092, -0.078, 0.005], knife: [-0.047, -0.011, 0.004],
};
const SUPPORT = {
  shotgun: [0.135, -0.013, 0], smg: [0.142, 0.005, 0], machinegun: [0.247, 0.012, 0],
};

/** Flatten owned static hands into the same finish batches as the weapon. */
export function addHeroWeaponHands(root, type) {
  const grips = [];
  function append(side, center, basis, options) {
    const hand = createAuthoredGripHand({ side, ...options });
    hand.position.fromArray(center); hand.quaternion.setFromRotationMatrix(basis);
    hand.updateMatrixWorld(true);
    const wrist = hand.userData.wristAnchor.clone().applyMatrix4(hand.matrixWorld);
    grips.push({ side, center: [...center], wrist: wrist.toArray(), radius: options.radius });
    // No scene parent ever sees the temporary hand group. Each child and its
    // geometry is owned here; the existing material batcher consumes it next.
    for (const mesh of [...hand.children]) {
      const transform = mesh.matrixWorld.clone();
      hand.remove(mesh); transform.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.name = `${side > 0 ? 'primary' : 'support'}-${mesh.name}`;
      root.add(mesh);
    }
  }
  const primary = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0));
  if (type === 'knife') {
    primary.makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0));
    append(1, PRIMARY[type], primary, { radius: 0.022, forearmLength: 0.035, forearmDirection: [-0.7, 0, 1] });
  } else if (type === 'shotgun') {
    // Grasp the narrowed oval neck obliquely. A bore-parallel stack presents
    // four concentric finger bands in ADS; modest yaw exposes the knuckles,
    // while roll moves the wrist down/right without hiding the whole hand.
    const yaw = 25 * Math.PI / 180;
    const along = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    const palm = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).applyAxisAngle(along, 25 * Math.PI / 180);
    const wrist = new THREE.Vector3().crossVectors(along, palm);
    primary.makeBasis(along, palm, wrist);
    const forearmDirection = new THREE.Vector3(-1, 0, 0).transformDirection(primary.clone().invert());
    append(1, PRIMARY[type], primary, { radius: 0.034, forearmLength: 0.14, forearmDirection });
  } else append(1, PRIMARY[type], primary, { radius: type === 'machinegun' ? 0.038 : 0.030,
    forearmLength: 0.14, forearmDirection: [0.55, 0, 1] });
  if (SUPPORT[type]) {
    // Align the finger stack with the foreend axis. Rolling the palm under the
    // stock leaves a clear bore and lets the wrist descend before the sleeve
    // travels rearward, instead of slicing diagonally through the receiver.
    const roll = (type === 'machinegun' ? 75 : 65) * Math.PI / 180;
    const along = new THREE.Vector3(1, 0, 0), palm = new THREE.Vector3(0, -Math.cos(roll), Math.sin(roll));
    const wrist = new THREE.Vector3().crossVectors(along, palm);
    const support = new THREE.Matrix4().makeBasis(along, palm, wrist);
    append(-1, SUPPORT[type], support, { radius: type === 'smg' ? 0.040 : 0.036,
      forearmLength: 0.14, forearmDirection: [-1, 0, 0] });
  }
  if (type === 'knife') {
    // A camera-ready asset pose reveals the ground blade, while the existing
    // controller still owns the exact attack/contact clocks and root motion.
    const pivot = new THREE.Vector3().fromArray(PRIMARY.knife);
    const ready = new THREE.Matrix4().makeTranslation(...pivot.toArray())
      .multiply(new THREE.Matrix4().makeRotationY(25 * Math.PI / 180))
      .multiply(new THREE.Matrix4().makeRotationZ(10 * Math.PI / 180))
      .multiply(new THREE.Matrix4().makeTranslation(...pivot.clone().negate().toArray()));
    for (const mesh of root.children) mesh.applyMatrix4(ready);
    for (const grip of grips) {
      grip.center = new THREE.Vector3().fromArray(grip.center).applyMatrix4(ready).toArray();
      grip.wrist = new THREE.Vector3().fromArray(grip.wrist).applyMatrix4(ready).toArray();
    }
    root.userData.heroWeapon.readyAngle = { side: 25, up: 10 };
  }
  root.userData.heroWeapon.grips = grips;
  return root;
}
