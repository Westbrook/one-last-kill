import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyBoxWorldUV } from './world-uv.js';
import { DISTRICT } from '../world/district-layout.js';

const PRODUCE = Object.freeze([
  [-3.75, 27.12, 0.11, 0xa75736], [-3.45, 27.10, 0.10, 0xc39443],
  [-3.98, 26.97, 0.12, 0x71804b], [-3.20, 27.28, 0.09, 0xad6540],
  [-4.19, 26.74, 0.10, 0xb4793d], [-3.63, 26.70, 0.09, 0xa44b35],
  [-4.48, 26.50, 0.115, 0x647545], [-4.79, 26.25, 0.085, 0xb38143],
  [-4.04, 26.40, 0.09, 0xb77840], [-3.52, 26.17, 0.08, 0xa75339],
  [-4.99, 26.61, 0.09, 0xb88649], [-3.02, 26.75, 0.08, 0x9d4a37],
  [-4.48, 27.18, 0.12, 0x687b47], [-5.13, 25.84, 0.085, 0xb18148],
  [-2.79, 27.06, 0.08, 0xa55637], [-3.86, 27.35, 0.10, 0xc2944b],
]);

/** A closed, bevel-free shard; small thickness avoids flat alpha/decal flicker. */
function shardGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.50, -0.38); shape.lineTo(0.50, -0.15);
  shape.lineTo(0.16, 0.50); shape.lineTo(-0.19, 0.22); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, steps: 1 });
  geometry.translate(0, 0, -0.5);
  return geometry;
}

/**
 * Two fixed incidents on the closed-shop frontage, built once before the
 * ballistic index. The tipped crate is a real movement solid; everything
 * else on the pavement is shallow enough to step over. No lights or timers.
 */
export function buildStreetAftermath({ world, materials, colliders }) {
  if (!world?.add || !colliders?.addBoxBySize || !materials?.wood?.isMaterial
    || !materials?.metal?.isMaterial || !materials?.tar?.isMaterial) {
    throw new TypeError('Street aftermath requires a world, surface materials and movement colliders');
  }
  const floor = DISTRICT.street.farWalk.floorY, front = DISTRICT.street.frontageZ;
  const group = new THREE.Group(); group.name = 'street-aftermath'; group.matrixAutoUpdate = false;
  const glass = new THREE.MeshStandardMaterial({ color: 0x8fa8a0, roughness: 0.24, metalness: 0.12 });
  glass.name = 'street-aftermath-broken-glass'; glass.userData.surfaceKind = 'glass';
  const painted = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, vertexColors: true });
  painted.name = 'street-aftermath-produce-and-painted-sign'; painted.userData.surfaceKind = 'wood';
  const sources = {
    box: new THREE.BoxGeometry(1, 1, 1), sphere: new THREE.SphereGeometry(1, 8, 6), shard: shardGeometry(),
  };
  const batches = new Map(), pieces = [], movement = [], clusters = new Map();
  const transform = new THREE.Object3D(), tint = new THREE.Color();

  function part(cluster, role, source, material, position, scale, rotation = [0, 0, 0], color = null, support = 'pavement') {
    transform.position.fromArray(position); transform.scale.fromArray(scale);
    transform.rotation.set(...rotation); transform.updateMatrix();
    const geometry = source.clone().applyMatrix4(transform.matrix);
    if (source === sources.box && material.userData?.surfaceMeters) applyBoxWorldUV(geometry, material.userData.surfaceMeters);
    if (material.vertexColors) {
      tint.setHex(color ?? 0xffffff);
      const colors = new Float32Array(geometry.attributes.position.count * 3);
      for (let index = 0; index < colors.length; index += 3) tint.toArray(colors, index);
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    if (!geometry.index) geometry.setIndex(Array.from({ length: geometry.attributes.position.count }, (_, index) => index));
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox.clone();
    if (!clusters.has(cluster)) clusters.set(cluster, new THREE.Box3());
    clusters.get(cluster).union(bounds);
    pieces.push({ cluster, role, support, bounds });
    if (!batches.has(material)) batches.set(material, []);
    batches.get(material).push(geometry);
    return bounds;
  }
  const box = (cluster, role, material, position, size, rotation = [0, 0, 0], color = null, support) =>
    part(cluster, role, sources.box, material, position, size, rotation, color, support);

  // The produce display has gone over toward the road. Its open mouth, four
  // surviving corner straps and detached slats explain the directional spill.
  const crate = new THREE.Object3D();
  crate.position.set(-3.42, floor + 0.35, 27.84);
  crate.rotation.set(-Math.PI / 2, 0, -0.22, 'YXZ'); crate.updateMatrix();
  const crateBounds = new THREE.Box3(), local = new THREE.Object3D(), composed = new THREE.Object3D();
  function crateBoard(position, size, material = materials.wood, color = null) {
    local.position.fromArray(position); local.scale.fromArray(size); local.updateMatrix();
    composed.matrix.multiplyMatrices(crate.matrix, local.matrix);
    composed.matrix.decompose(composed.position, composed.quaternion, composed.scale);
    const bounds = box('market-spill', 'overturned-crate', material,
      composed.position.toArray(), composed.scale.toArray(), [composed.rotation.x, composed.rotation.y, composed.rotation.z], color, 'crate');
    crateBounds.union(bounds);
  }
  for (const x of [-0.40, -0.135, 0.135, 0.40]) crateBoard([x, -0.295, 0], [0.25, 0.05, 0.70]);
  for (const y of [-0.19, 0.005, 0.20]) {
    for (const x of [-0.50, 0.50]) crateBoard([x, y, 0], [0.06, 0.145, 0.70]);
    crateBoard([0, y, 0.32], [0.96, 0.145, 0.06]);
    if (y !== 0.20) crateBoard([0, y, -0.32], [0.96, 0.145, 0.06]);
  }
  for (const x of [-0.465, 0.465]) for (const z of [-0.29, 0.29]) {
    crateBoard([x, 0, z], [0.055, 0.60, 0.06]);
    crateBoard([x, -0.12, z - 0.035], [0.075, 0.23, 0.014], materials.metal);
  }
  // The rotated slatted shell fills this small envelope: its mouth cannot
  // admit a player capsule. The collider and visible shell share their bounds.
  const center = crateBounds.getCenter(new THREE.Vector3()), size = crateBounds.getSize(new THREE.Vector3());
  movement.push(colliders.addBoxBySize(center.x, center.y, center.z, size.x, size.y, size.z));
  for (const [x, z, width, yaw] of [[-3.37, 26.92, 0.75, 0.55], [-4.60, 27.34, 1.03, -0.38], [-2.91, 27.58, 0.46, -1.12]]) {
    box('market-spill', 'splintered-slat', materials.wood, [x, floor + 0.020, z], [width, 0.032, 0.09], [0, yaw, 0]);
  }
  for (const [index, [x, z, radius, color]] of PRODUCE.entries()) {
    part('market-spill', 'spilled-produce', sources.sphere, painted,
      [x, floor + radius * 0.85 + 0.004, z], [radius, radius * 0.85, radius], [0, index * 1.1, 0], color);
    box('market-spill', 'produce-stem', painted, [x, floor + radius * 1.7 + 0.006, z],
      [0.023, 0.014, 0.034], [0, index, 0], 0x526143, 'produce');
  }
  // A flattened grocery carton caught under the fruit, with two folded flaps.
  box('market-spill', 'torn-grocery-carton', painted, [-4.18, floor + 0.018, 27.19], [0.62, 0.028, 0.43], [0, 0.23, 0], 0xa28b65);
  box('market-spill', 'carton-fold', painted, [-4.40, floor + 0.048, 27.13], [0.11, 0.056, 0.39], [0, 0.23, 0], 0x8d7758);

  // The deli display has a punched-out pane. Dark interior, a jagged glass
  // rim and a few long cracks replace uniform bullet-hole wallpaper. The
  // original closed-shop mass continues to own collision behind this damage.
  const holePoints = [[-0.44, -0.35], [-0.22, -0.47], [-0.02, -0.37], [0.29, -0.50],
    [0.25, -0.15], [0.51, 0.04], [0.28, 0.16], [0.30, 0.48],
    [0.03, 0.34], [-0.22, 0.51], [-0.20, 0.20], [-0.49, 0.12]];
  const holeShape = new THREE.Shape(holePoints.map(point => new THREE.Vector2(...point)));
  const hole = new THREE.ShapeGeometry(holeShape);
  part('deli-impact', 'broken-display-opening', hole, materials.tar, [-14.15, 1.89, front - 0.095], [1, 1, 1], [0, Math.PI, 0], null, 'storefront-mass-1');
  hole.dispose();
  for (let index = 0; index < holePoints.length; index++) {
    const a = holePoints[index], b = holePoints[(index + 1) % holePoints.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    box('deli-impact', 'fractured-glass-rim', glass,
      [-14.15 - (a[0] + b[0]) / 2, 1.89 + (a[1] + b[1]) / 2, front - 0.100],
      [length, 0.018 + index % 3 * 0.007, 0.025], [0, 0, -Math.atan2(dy, dx)], null, 'storefront-mass-1');
  }
  for (const [x, y, length, angle] of [[-14.7, 2.41, 0.63, -0.66], [-13.53, 2.16, 0.49, 0.18], [-13.93, 1.16, 0.36, -1.2]]) {
    box('deli-impact', 'pane-crack', glass, [x, y, front - 0.097], [length, 0.012, 0.012], [0, 0, angle], null, 'storefront-mass-1');
  }
  for (const [index, [x, z, width, depth]] of [
    [-14.46, 28.47, 0.31, 0.18], [-13.95, 28.31, 0.39, 0.24], [-14.77, 28.07, 0.28, 0.20],
    [-13.80, 27.91, 0.21, 0.15], [-14.35, 27.76, 0.33, 0.18], [-13.47, 28.50, 0.19, 0.23],
    [-14.91, 27.48, 0.23, 0.12], [-13.69, 27.34, 0.16, 0.18], [-15.14, 27.13, 0.17, 0.10],
    [-14.11, 26.92, 0.15, 0.11], [-13.19, 27.02, 0.19, 0.12], [-14.52, 26.59, 0.14, 0.10],
  ].entries()) {
    part('deli-impact', 'fallen-glass', sources.shard, glass, [x, floor + 0.008, z],
      [width, depth, 0.012], [-Math.PI / 2, 0, index * 0.81]);
  }

  // A low, fallen pavement sign completes the same incident. The broken
  // folding leg props its back; painted cup and short chalk rules read as a
  // coffee board without another sign atlas or a per-object texture.
  const signX = -12.97, signZ = 27.88, signYaw = -0.31;
  function signPart(role, material, x, y, z, width, height, depth, color = null) {
    const cs = Math.cos(signYaw), sn = Math.sin(signYaw);
    box('deli-impact', role, material,
      [signX + x * cs + z * sn, floor + y, signZ - x * sn + z * cs],
      [width, height, depth], [0, signYaw, 0], color);
  }
  signPart('fallen-sign-leg', materials.wood, -0.28, 0.029, 0, 0.07, 0.058, 1.06);
  signPart('fallen-sign-leg', materials.wood, 0.28, 0.029, 0, 0.07, 0.058, 1.06);
  signPart('fallen-coffee-sign', materials.tar, 0, 0.082, 0, 0.72, 0.048, 0.92);
  for (const x of [-0.385, 0.385]) signPart('coffee-sign-frame', materials.wood, x, 0.082, 0, 0.055, 0.074, 1.03);
  for (const z of [-0.486, 0.486]) signPart('coffee-sign-frame', materials.wood, 0, 0.082, z, 0.72, 0.074, 0.055);
  signPart('coffee-sign-hinge', materials.metal, -0.20, 0.125, 0.487, 0.11, 0.018, 0.075);
  signPart('coffee-sign-hinge', materials.metal, 0.20, 0.125, 0.487, 0.11, 0.018, 0.075);
  signPart('painted-coffee-cup', painted, -0.04, 0.109, -0.17, 0.22, 0.004, 0.23, 0xc9c5a9);
  signPart('painted-coffee-handle', painted, 0.105, 0.109, -0.17, 0.08, 0.004, 0.13, 0xc9c5a9);
  signPart('painted-coffee-saucer', painted, -0.015, 0.109, -0.005, 0.35, 0.004, 0.035, 0xc9c5a9);
  for (const [z, width] of [[0.17, 0.42], [0.27, 0.29], [0.36, 0.36]]) {
    signPart('coffee-board-chalk', painted, 0, 0.109, z, width, 0.004, 0.020, 0xbcbba4);
  }

  let triangles = 0, geometryBytes = 0;
  for (const [material, geometries] of batches) {
    const geometry = mergeGeometries(geometries, false);
    for (const source of geometries) source.dispose();
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'street-aftermath-' + (material.name || group.children.length);
    mesh.castShadow = false; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
    group.add(mesh);
    triangles += geometry.index.count / 3;
    geometryBytes += geometry.index.array.byteLength + Object.values(geometry.attributes)
      .reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
  }
  for (const geometry of Object.values(sources)) geometry.dispose();
  const summary = { draws: group.children.length, triangles, geometryBytes, addedMaterials: 2,
    addedTextures: 0, addedLights: 0, movementColliders: movement.length,
    clusters: [...clusters].map(([id, bounds]) => ({ id, min: bounds.min.toArray(), max: bounds.max.toArray() })),
  };
  group.userData.streetAftermath = summary;
  world.add(group);
  return { group, pieces, colliders: movement, ...summary };
}
