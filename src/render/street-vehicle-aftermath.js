import * as THREE from 'three';

const scorchedGeometry = new WeakMap(), scorchedMaterials = new WeakMap();
const roadRubber = new THREE.MeshBasicMaterial({ color: 0x020302, transparent: true, opacity: 0.78,
  depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
roadRubber.name = 'street-worn-tire-rubber';

/** Darken the existing nose/hood without overlay planes or changing shared cars. */
export function scorchCivilianVehicle(car) {
  for (const mesh of car.children) {
    if (!mesh.isMesh || !mesh.name.endsWith('-paint')) continue;
    const original = mesh.geometry;
    if (!scorchedGeometry.has(original)) {
      const geometry = original.clone(), positions = geometry.attributes.position, colors = geometry.attributes.color;
      for (let index = 0; index < positions.count; index++) {
        const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
        const edge = 0.42 + 0.12 * Math.sin(z * 13 + y * 7);
        const burn = THREE.MathUtils.smoothstep(x, edge, 1.65)
          * THREE.MathUtils.smoothstep(y, 0.24, 0.64);
        const soot = 1 - burn * (0.86 + Math.sin(x * 19 + z * 11) * 0.035);
        colors.setXYZ(index, colors.getX(index) * soot, colors.getY(index) * soot, colors.getZ(index) * soot);
      }
      colors.needsUpdate = true;
      geometry.name = original.name + '-scorched';
      scorchedGeometry.set(original, geometry);
    }
    const originalMaterial = mesh.material;
    if (!scorchedMaterials.has(originalMaterial)) {
      const material = originalMaterial.clone();
      material.name = originalMaterial.name + '-scorched';
      material.roughness = 0.94;
      material.metalness = 0.08;
      material.envMapIntensity = 0.12;
      scorchedMaterials.set(originalMaterial, material);
    }
    mesh.geometry = scorchedGeometry.get(original);
    mesh.material = scorchedMaterials.get(originalMaterial);
  }
}

function groundHeight(district, z) {
  const { street } = district;
  return z < street.road.z1 ? street.nearApron.floorY
    : z > street.road.z2 ? street.farWalk.floorY : street.road.floorY;
}

function buildTireMarks(vehicles, district) {
  const vertices = [], indices = [];
  const addQuad = (a, b, halfWidth, normal) => {
    const ay = groundHeight(district, a.z), by = groundHeight(district, b.z);
    // A break at the curb avoids suspending a paint strip across the riser.
    if (ay !== by) return;
    const first = vertices.length / 3;
    for (const [point, side] of [[a, -1], [a, 1], [b, 1], [b, -1]]) {
      vertices.push(point.x + normal.x * halfWidth * side, ay + 0.003,
        point.z + normal.z * halfWidth * side);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  };
  for (const car of vehicles) {
    const { id, profile } = car.userData.civilianVehicle;
    if (!['east', 'far', 'west'].includes(id)) continue;
    const forward = new THREE.Vector3(1, 0, 0).transformDirection(car.matrixWorld);
    forward.y = 0; forward.normalize();
    const lateral = new THREE.Vector3(-forward.z, 0, forward.x);
    const length = id === 'east' ? 6.8 : id === 'far' ? 5.4 : 3.1;
    const bend = id === 'east' ? 1.5 : id === 'far' ? 2.4 : 0.35;
    for (const wheel of profile.wheels.filter(wheel => wheel.name.startsWith('rear'))) {
      const end = new THREE.Vector3(...wheel.center).applyMatrix4(car.matrixWorld);
      let last = null;
      for (let step = 0; step <= 32; step++) {
        const remaining = 1 - step / 32;
        const point = end.clone().addScaledVector(forward, -length * remaining)
          .addScaledVector(lateral, bend * remaining * remaining);
        if (last && step % 9 !== 2) {
          const tangent = point.clone().sub(last).setY(0).normalize();
          const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
          addQuad(last, point, 0.07 + 0.018 * Math.sin(step * 1.4), normal);
        }
        last = point;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const marks = new THREE.Mesh(geometry, roadRubber);
  marks.name = 'street-curved-skid-marks'; marks.userData.ballistics = false;
  marks.renderOrder = 1;
  return marks;
}

/** One localized engine fire; the car's solid body already blocks its footprint. */
export function buildStreetVehicleAftermath({ world, district, spawnFire }) {
  const vehicles = world.children.filter(object => object.userData.civilianVehicle?.id);
  world.updateMatrixWorld(true);
  const marks = buildTireMarks(vehicles, district);
  world.add(marks);
  const wreck = vehicles.find(car => car.userData.civilianVehicle.id === 'far');
  if (!wreck) return { marks, fire: null };
  scorchCivilianVehicle(wreck);
  const hood = new THREE.Vector3(1.50, 0.79, 0.02).applyMatrix4(wreck.matrixWorld);
  const fire = spawnFire(hood.x, hood.y, hood.z, {
    width: 2.1, height: 2.5, intensity: 5.2, color: 0xff892f, addCollider: false,
  });
  fire.group.name = 'street-wreck-engine-fire';
  fire.group.userData.civilianVehicleId = 'far';
  fire.light.userData.zone = 'street';
  fire.smoke.points.name = 'street-wreck-smoke';
  fire.smoke.points.position.y = 1.42;
  fire.smoke.points.material.color.setHex(0x797b78);
  fire.smoke.points.material.opacity = 0.62;
  fire.smoke.points.material.size = 1.6;
  fire.smoke.points.scale.y = 1.35;
  wreck.userData.streetWreck = { hood: hood.toArray(), fireName: fire.group.name };
  return { marks, fire, wreck };
}
