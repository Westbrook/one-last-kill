import { Box3 } from 'three';

const REST_CLEARANCE = 0.006;
const ROTATIONS = [0, Math.PI / 2, Math.PI, Math.PI * 1.5, Math.PI / 4, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75];
// Small diagonal shifts let a long gun clear both a tread edge and a side wall.
// Every candidate remains within 20 cm of the original drop position.
const OFFSETS = [
  [0, 0], [0, 0.12], [0, -0.12], [0.12, 0], [-0.12, 0],
  [0.12, 0.12], [-0.12, 0.12], [0.12, -0.12], [-0.12, -0.12],
  [0, 0.20], [0, -0.20], [0.20, 0], [-0.20, 0],
];

function floorAt(x, y, z, boxes) {
  let floor = -Infinity;
  for (const box of boxes) {
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue;
    if (box.max.y <= y + 0.2 && box.max.y > floor) floor = box.max.y;
  }
  return floor;
}

/** Place a static pickup on its supporting surface, with its narrow side up. */
export function placeWeaponDrop(mesh, type, { x, y, z }, boxes, yaw = 0) {
  const support = floorAt(x, y, z, boxes), baseFloor = Number.isFinite(support) ? support : y;
  const bounds = new Box3();
  const tilt = type === 'bat' ? 0 : Math.PI / 2;
  const initialYaw = Number.isFinite(yaw) ? yaw : 0;
  let chosenYaw = initialYaw, chosenY = baseFloor + 0.05, settled = false;
  let chosenX = x, chosenZ = z, chosenFloor = baseFloor;
  for (const [ox, oz] of OFFSETS) {
    const px = x + ox, pz = z + oz;
    const sampled = floorAt(px, y, pz, boxes);
    const floor = Number.isFinite(sampled) ? sampled : baseFloor;
    if (Math.abs(floor - baseFloor) > 0.2) continue;
    // Try the authored yaw first, then exact world axes. A random diagonal
    // can never fit a long gun across a 30 cm tread, regardless of translation.
    for (let index = 0; index < ROTATIONS.length + 4; index++) {
      const candidateYaw = index < ROTATIONS.length ? initialYaw + ROTATIONS[index] : (index - ROTATIONS.length) * Math.PI / 2;
      mesh.rotation.set(tilt, candidateYaw, 0, 'YXZ');
      mesh.position.set(px, 0, pz);
      mesh.updateWorldMatrix(true, true);
      bounds.setFromObject(mesh);
      const lift = floor - bounds.min.y + REST_CLEARANCE;
      bounds.min.y += lift; bounds.max.y += lift;
      if (index === 0 && ox === 0 && oz === 0) chosenY = lift;
      if (boxes.some(box => box.max.y > floor + 0.002 && box.intersectsBox(bounds))) continue;
      let supported = true;
      for (const cornerX of [bounds.min.x, bounds.max.x]) for (const cornerZ of [bounds.min.z, bounds.max.z]) {
        if (Math.abs(floorAt(cornerX, floor, cornerZ, boxes) - floor) > 0.035) supported = false;
      }
      if (!supported) continue;
      chosenYaw = candidateYaw; chosenY = lift; settled = true;
      chosenX = px; chosenZ = pz; chosenFloor = floor;
      break;
    }
    if (settled) break;
  }
  mesh.rotation.set(tilt, chosenYaw, 0, 'YXZ');
  mesh.position.set(chosenX, chosenY, chosenZ);
  mesh.updateWorldMatrix(true, true);
  return { floorY: chosenFloor, settled };
}
