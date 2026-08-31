import * as THREE from 'three';

function tireBottom(group, name) {
  const point = new THREE.Vector3(), bottom = new THREE.Vector3(0, Infinity, 0);
  for (const mesh of group.children) {
    const part = mesh.geometry?.userData.civilianParts?.find(part => part.name === name);
    if (!part) continue;
    const positions = mesh.geometry.attributes.position;
    for (let index = part.vertexStart; index < part.vertexStart + part.vertexCount; index++) {
      point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
      if (point.y < bottom.y) bottom.copy(point);
    }
  }
  if (!Number.isFinite(bottom.y)) throw new Error('Missing civilian tire surface: ' + name);
  return bottom;
}

/** Place shared vehicle geometry on a flat road or with one full side on a curb. */
export function placeCivilianVehicle(vehicle, placement) {
  const { group, profile } = vehicle;
  const supportY = wheel => placement.curb?.side === (wheel.center[2] > 0 ? 'left' : 'right')
    ? placement.curb.floorY : placement.y;
  const left = profile.wheels.find(wheel => wheel.center[2] > 0);
  const right = profile.wheels.find(wheel => wheel.center[2] < 0);
  // All four authored tires share the same profile. A longitudinal roll puts
  // each pair at its support height without stretching wheels or the chassis.
  const roll = Math.asin((supportY(right) - supportY(left)) / (left.center[2] - right.center[2]));
  group.position.set(placement.x, 0, placement.z);
  group.rotation.set(roll, placement.yaw, 0, 'YXZ');
  group.updateMatrixWorld(true);
  const wheelContacts = profile.wheels.map(wheel => ({
    name: wheel.name, surfaceY: supportY(wheel),
    point: tireBottom(group, wheel.surfaceName || 'tire:' + wheel.name),
  }));
  // Use the actual rounded tire triangles: a rolled tire's lowest point is
  // slightly lower than an ideal zero-width wheel's nominal contact circle.
  const lift = Math.max(...wheelContacts.map(contact => contact.surfaceY - contact.point.y));
  group.position.y = lift;
  group.updateMatrixWorld(true);
  for (const contact of wheelContacts) contact.point.y += lift;
  return {
    wheelContacts,
    worldBounds: new THREE.Box3().setFromObject(group, true),
    movementBounds: vehicle.movementBounds.map(bounds => bounds.clone().applyMatrix4(group.matrixWorld)),
  };
}
