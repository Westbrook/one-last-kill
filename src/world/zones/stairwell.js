import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MATS } from '../../render/materials.js';
import { _BG, pushDecor } from '../../render/models.js';
import { Colliders } from '../../core/collision.js';
import { Architecture } from '../architecture.js';
import { STAIRS } from '../stair-layout.js';
import { World, Triggers, addBox, addDecor, addSign } from '../world.js';

const UP = new THREE.Vector3(0, 1, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

function boxPart(parts, colliders, x, y, z, width, height, depth) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  parts.push(geometry);
  colliders.push(Colliders.addBoxBySize(x, y, z, width, height, depth));
}

// A sloping member is split into short physical pieces. A single AABB around a
// whole inclined rail would turn the open railing into another invisible wall.
function beamPart(parts, colliders, start, end, width, depth = width) {
  const from = new THREE.Vector3(...start), to = new THREE.Vector3(...end);
  const direction = to.clone().sub(from);
  const geometry = new THREE.BoxGeometry(width, direction.length(), depth);
  const rotation = new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize());
  const midpoint = from.add(to).multiplyScalar(0.5);
  geometry.applyMatrix4(new THREE.Matrix4().compose(midpoint, rotation, UNIT_SCALE));
  geometry.computeBoundingBox();
  colliders.push(Colliders.addBox(geometry.boundingBox.min, geometry.boundingBox.max));
  parts.push(geometry);
}

function addAssembly(id, kind, parts, colliders, material, supports) {
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.colliders = colliders;
  World.add(mesh);
  mesh.updateWorldMatrix(true, false);
  Architecture.register(mesh, null, new THREE.Box3().setFromObject(mesh), {
    id, kind, supports, supportKind: 'anchored',
  });
  return mesh;
}

function buildShell() {
  const { x1, x2, z1, z2 } = STAIRS.footprint;
  const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
  const width = x2 - x1, depth = z2 - z1;
  const capThickness = 0.2;
  const wallTop = STAIRS.towerRoofY - capThickness;
  const eastWallX = STAIRS.interior.x2 + 0.1;
  const wall = (id, x, y, z, sx, sy, sz, supports = []) => addBox(x, y, z, sx, sy, sz, MATS.brick, {
    architecture: { id, kind: 'wall', supports, supportKind: supports.length ? 'anchored' : 'ground' },
  });
  wall('stair-west-wall', x1, wallTop / 2, cz, 0.2, wallTop, depth);
  wall('stair-north-wall', cx, wallTop / 2, z1, width, wallTop, 0.2);
  const entrance = STAIRS.entryDoor;
  const entryBottom = entrance.min[1], entryTop = entrance.max[1];
  wall('stair-ground-south', cx, entryBottom / 2, z2, width, entryBottom, 0.2);
  wall('stair-south-upper', cx, (entryTop + wallTop) / 2, z2, width, wallTop - entryTop, 0.2,
    ['stair-south-door-west', 'stair-south-door-east']);
  wall('stair-south-door-west', (x1 + entrance.min[0]) / 2, (entryBottom + entryTop) / 2, z2,
    entrance.min[0] - x1, entryTop - entryBottom, 0.2, ['stair-ground-south']);
  wall('stair-south-door-east', (entrance.max[0] + x2) / 2, (entryBottom + entryTop) / 2, z2,
    x2 - entrance.max[0], entryTop - entryBottom, 0.2, ['stair-ground-south']);
  const doorway = STAIRS.roofDoor;
  const doorBottom = doorway.min[1], doorTop = doorway.max[1];
  const thresholdBottom = STAIRS.roofThreshold.y - STAIRS.roofThreshold.thickness;
  // Masonry stops under the threshold. Extending it to floor height leaves a
  // second exposed face inside the opening and causes depth-buffer flicker.
  wall('stair-east-wall', eastWallX, thresholdBottom / 2, cz, 0.2, thresholdBottom, depth);
  wall('stair-east-sill-north', eastWallX, (thresholdBottom + doorBottom) / 2, (z1 + doorway.min[2]) / 2,
    0.2, doorBottom - thresholdBottom, doorway.min[2] - z1, ['stair-east-wall']);
  wall('stair-east-sill-south', eastWallX, (thresholdBottom + doorBottom) / 2, (doorway.max[2] + z2) / 2,
    0.2, doorBottom - thresholdBottom, z2 - doorway.max[2], ['stair-east-wall']);
  wall('stair-east-upper-north', eastWallX, (doorBottom + wallTop) / 2, (z1 + doorway.min[2]) / 2,
    0.2, wallTop - doorBottom, doorway.min[2] - z1, ['stair-east-sill-north']);
  wall('stair-east-upper-south', eastWallX, (doorBottom + wallTop) / 2, (doorway.max[2] + z2) / 2,
    0.2, wallTop - doorBottom, z2 - doorway.max[2], ['stair-east-sill-south']);
  // Raising the ceiling must also close the wall above the existing doorway.
  // The opening stays at its authored height; its lintel bears on both jambs.
  wall('stair-roof-door-header', eastWallX, (doorTop + wallTop) / 2, (doorway.min[2] + doorway.max[2]) / 2,
    0.2, wallTop - doorTop, doorway.max[2] - doorway.min[2], ['stair-east-upper-north', 'stair-east-upper-south']);
  addBox(cx, STAIRS.towerRoofY - capThickness / 2, cz, width + 0.12, capThickness, depth + 0.12, MATS.concrete, {
    architecture: {
      id: 'stair-roof-cap', kind: 'slab', supportKind: 'anchored',
      supports: ['stair-west-wall', 'stair-north-wall', 'stair-south-upper', 'stair-east-upper-north', 'stair-east-upper-south', 'stair-roof-door-header'],
    },
  });
}

function buildLandings() {
  for (const landing of STAIRS.landings) {
    const cx = (landing.x1 + landing.x2) / 2;
    const cz = (landing.z1 + landing.z2) / 2;
    const width = landing.x2 - landing.x1;
    const supports = landing.y === STAIRS.exitY
      ? ['stair-west-wall', 'stair-east-sill-north', 'stair-east-sill-south']
      : ['stair-west-wall', 'stair-east-wall'];
    const endWall = landing.side === 'south' ? 'stair-south-upper' : 'stair-north-wall';
    const ledgerZ = landing.side === 'south' ? landing.z2 - 0.1 : landing.z1 + 0.1;
    const ledgerId = `${landing.id}-ledger`;
    addBox(cx, landing.y - landing.thickness - 0.09, ledgerZ, width, 0.18, 0.2, MATS.concrete, {
      architecture: { id: ledgerId, kind: 'beam', supports: [endWall], supportKind: 'anchored' },
    });
    supports.push(ledgerId);
    addBox(cx, landing.y - landing.thickness / 2, cz, width, landing.thickness,
      landing.z2 - landing.z1, MATS.concrete, {
        cast: false,
        architecture: { id: landing.id, kind: 'deck', supports, supportKind: 'anchored' },
      });
  }
  // Both sides of the threshold meet an actual slab, never the open flight.
  const threshold = STAIRS.roofThreshold;
  addBox((threshold.x1 + threshold.x2) / 2, threshold.y - threshold.thickness / 2, (threshold.z1 + threshold.z2) / 2,
    threshold.x2 - threshold.x1, threshold.thickness, threshold.z2 - threshold.z1, MATS.concrete, {
      cast: false,
      architecture: { id: 'stair-roof-threshold', kind: 'deck', supports: ['stair-north-landing-4', 'stair-east-wall'], supportKind: 'anchored' },
    });
}

function buildFlight(flight) {
  const waistParts = [], waistColliders = [];
  const waistId = `${flight.id}-waist`;
  const direction = Math.sign(flight.zEnd - flight.zStart);
  for (const tread of flight.treads) {
    const width = tread.x2 - tread.x1, depth = tread.z2 - tread.z1;
    const height = tread.topY - tread.bottomY, z = (tread.z1 + tread.z2) / 2;
    boxPart(waistParts, waistColliders, flight.x, (tread.topY + tread.bottomY) / 2, z, width, height, depth);
    const leadingZ = direction > 0 ? tread.z1 : tread.z2;
    pushDecor(_BG.unitBox, MATS.metal, flight.x, tread.topY + 0.002, leadingZ + direction * 0.025,
      width - 0.12, 0.004, 0.045);
  }
  addAssembly(waistId, 'stair-waist', waistParts, waistColliders, MATS.concrete,
    [flight.bottomLanding, flight.topLanding]);

  // Slender steel side members follow the pitch. Their colliders are short
  // inclined sections; the old full-height rectangular stringer fillers are gone.
  const stringerParts = [], stringerColliders = [];
  for (const side of [-1, 1]) {
    const x = flight.x + side * (flight.width / 2 + 0.015);
    for (let index = 0; index < flight.steps; index++) {
      const t0 = Math.max(0.06 / flight.run, index / flight.steps);
      const t1 = Math.min(1 - 0.06 / flight.run, (index + 1) / flight.steps);
      const point = t => [x, flight.fromY + (flight.toY - flight.fromY) * t - 0.09,
        flight.zStart + (flight.zEnd - flight.zStart) * t];
      beamPart(stringerParts, stringerColliders, point(t0), point(t1), 0.065, 0.16);
    }
  }
  addAssembly(`${flight.id}-stringers`, 'stair-stringer', stringerParts, stringerColliders, MATS.metal, [waistId]);

  // Open balusters and two sloping rails protect the central gap. Every
  // collider belongs to a visible member, rather than a filled guard panel.
  const guardParts = [], guardColliders = [];
  for (let index = 0; index < flight.treads.length; index++) {
    const tread = flight.treads[index];
    const z = (tread.z1 + tread.z2) / 2;
    boxPart(guardParts, guardColliders, flight.guardX, tread.topY + (STAIRS.guardHeight - 0.005) / 2,
      z, 0.045, STAIRS.guardHeight + 0.005, 0.045);
    if (index === 0) continue;
    const previous = flight.treads[index - 1];
    const previousZ = (previous.z1 + previous.z2) / 2;
    for (const height of [0.54, STAIRS.guardHeight]) {
      beamPart(guardParts, guardColliders,
        [flight.guardX, previous.topY + height, previousZ], [flight.guardX, tread.topY + height, z], 0.045);
    }
  }
  addAssembly(`${flight.id}-central-guard`, 'stair-guard', guardParts, guardColliders, MATS.metal, [waistId]);

  const wallRailParts = [], wallRailColliders = [];
  const west = flight.lane === 'west';
  const wallX = west ? STAIRS.interior.x1 : STAIRS.interior.x2;
  const railX = wallX + (west ? 0.22 : -0.22);
  for (let index = 0; index < flight.treads.length; index++) {
    const tread = flight.treads[index], z = (tread.z1 + tread.z2) / 2;
    if ([1, 6, 12].includes(index)) {
      beamPart(wallRailParts, wallRailColliders, [wallX, tread.topY + 0.96, z], [railX, tread.topY + 0.96, z], 0.035);
    }
    if (index === 0) continue;
    const previous = flight.treads[index - 1];
    beamPart(wallRailParts, wallRailColliders,
      [railX, previous.topY + 0.96, (previous.z1 + previous.z2) / 2], [railX, tread.topY + 0.96, z], 0.045);
  }
  const wallSupports = [west ? 'stair-west-wall' : 'stair-east-wall'];
  if (!west && flight.toY + 0.96 > 14) wallSupports.push('stair-east-upper-south');
  addAssembly(`${flight.id}-wall-handrail`, 'stair-handrail', wallRailParts, wallRailColliders, MATS.metal, wallSupports);
}

function buildRoofLandingGuard() {
  // The roof landing has no next west flight. Guard only that exposed drop;
  // the full turning area behind it and the east route to the door stay open.
  const parts = [], colliders = [];
  const x1 = STAIRS.interior.x1 + 0.07;
  const x2 = STAIRS.lanes.west + STAIRS.laneWidth / 2 + 0.05;
  const z = STAIRS.flightZ.north - 0.04;
  const y = STAIRS.exitY;
  for (let index = 0; index <= 9; index++) {
    const x = x1 + (x2 - x1) * index / 9;
    boxPart(parts, colliders, x, y + STAIRS.guardHeight / 2, z, 0.045, STAIRS.guardHeight, 0.045);
  }
  for (const height of [0.54, STAIRS.guardHeight]) {
    beamPart(parts, colliders, [x1, y + height, z], [x2, y + height, z], 0.045);
  }
  addAssembly('stair-roof-landing-guard', 'stair-guard', parts, colliders, MATS.metal, ['stair-north-landing-4']);
}

function addServiceDetails() {
  const lightMaterial = new THREE.MeshBasicMaterial({ color: 0xf4dec1 });
  for (const landing of STAIRS.landings.slice(1)) {
    const z = landing.side === 'south' ? -0.95 : -8.95;
    const y = landing.y;
    const wall = STAIRS.interior.x1;
    addBox(wall + 0.12, y + 0.85, z, 0.24, 0.7, 0.45, MATS.metal);
    addDecor(wall + 0.023, y + 1.55, z, 0.04, 0.36, 1.12, MATS.metal);
    const label = y === STAIRS.exitY ? 'ROOF ACCESS' : `LEVEL ${String(STAIRS.landings.indexOf(landing) + 1).padStart(2, '0')}`;
    addSign(wall + 0.046, y + 1.55, z, 1.06, 0.3, '+x', label,
      { bg: '#243731', fg: '#d5dccb', font: 'bold 100px sans-serif' });
    const lightY = Math.min(y + 1.92, STAIRS.towerRoofY - 0.36);
    addDecor(wall + 0.04, lightY, z, 0.08, 0.1, 0.65, MATS.metal);
    pushDecor(_BG.unitBox, lightMaterial, wall + 0.085, lightY, z, 0.012, 0.055, 0.55);
    const light = new THREE.PointLight(0xffd6a4, 0.8, 5.5, 1.8);
    light.position.set(wall + 0.35, lightY - 0.1, z);
    World.add(light);
  }
  addDecor(-18.4, 5.55, STAIRS.interior.z1 + 0.006, 2.4, 0.4, 0.012, MATS.metal);
  addSign(-18.4, 5.55, STAIRS.interior.z1 + 0.014, 2.3, 0.34, '+z', '← STAIRS TO ROOF',
    { bg: '#243731', fg: '#d5dccb', font: 'bold 100px sans-serif' });
}

export function buildStairwell() {
  buildShell();
  buildLandings();
  for (const flight of STAIRS.flights) buildFlight(flight);
  buildRoofLandingGuard();
  addServiceDetails();
  const { x1, x2, z1, z2 } = STAIRS.footprint;
  Triggers.add('stairwell', new THREE.Vector3(x1 + 0.3, STAIRS.entryY, z1 + 0.3),
    new THREE.Vector3(x2 - 0.3, 15, z2 - 0.3));
}
