import * as THREE from 'three';
import { BUILDING, ROOF } from '../world/layout.js';
import { applyRoofMembraneFinish } from './roof-membrane.js';

const ROOF_DECKS = Object.freeze([
  'roof-deck', 'roof-annex-north-deck', 'roof-annex-west-link-deck',
  'roof-annex-east-link-deck', 'roof-annex-east-deck',
]);

// A folded spun-metal hood, not an open chimney. The shallow crown and broad
// drip lip read at roof distance without using many radial segments.
export function createRoofCowlGeometry() {
  const geometry = new THREE.LatheGeometry([
    new THREE.Vector2(0, 0), new THREE.Vector2(0.27, 0),
    new THREE.Vector2(0.41, 0.09), new THREE.Vector2(0.33, 0.22),
    new THREE.Vector2(0, 0.25),
  ], 20);
  geometry.name = 'folded-roof-exhaust-cowl';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Dress existing building faces using the environment's existing batches.
 * Every solid is anchored to a wall or to the service-house cap. No floor
 * clutter, colliders, gameplay lights or transparent layers are introduced.
 */
export function buildExteriorDetail({ world, batches, geometry, metal, pipe, stone, facadeWindows, roofMetal }) {
  const counts = { metalBoxes: 0, stoneBoxes: 0, pipes: 0, cowls: 0 };
  const addMetal = (...args) => { counts.metalBoxes++; metal(...args); };
  const addPipe = (...args) => { counts.pipes++; pipe(...args); };
  const addStone = (...args) => { counts.stoneBoxes++; stone(...args); };

  // The existing timber sash gets a fitted masonry head. Its back embeds
  // into the wall, and the lower edge meets the old frame rather than adding
  // a floating band or covering the glass. All heads share the plaster batch.
  for (const { x, y, z, yaw } of facadeWindows) {
    const nx = Math.sin(yaw), nz = Math.cos(yaw);
    addStone(x + nx * 0.025, y + 1.01, z + nz * 0.025,
      1.40, 0.155, 0.21, 0, yaw, 0, 0xb9b8ab);
  }

  const H = ROOF.serviceHouse, y = ROOF.floorY;
  // A west-facing louver belongs to the mechanical house, which was a large
  // blank brick plane from the stair exit. The dark backing lies behind the
  // sloping slats. The existing house is already solid behind this assembly.
  const vx = H.x1 - 0.025, vy = y + 1.67, vz = H.z2 - 1.72;
  addMetal(vx, vy, vz, 0.035, 1.02, 1.42, 0, 0, 0, 0x424a48);
  for (const dy of [-0.555, 0.555]) {
    addMetal(vx - 0.035, vy + dy, vz, 0.11, 0.085, 1.61, 0, 0, 0, 0xc5ccc3);
  }
  for (const dz of [-0.7625, 0.7625]) {
    addMetal(vx - 0.035, vy, vz + dz, 0.11, 1.025, 0.085, 0, 0, 0, 0xc5ccc3);
  }
  for (let row = 0; row < 8; row++) {
    // The local X/Y rectangle tilts about Z: the outer lip drops as it
    // projects from the wall. No high-frequency grill texture or alpha mask.
    addMetal(vx - 0.056, vy - 0.44 + row * 0.126, vz,
      0.18, 0.035, 1.43, 0, 0, Math.PI / 6, 0xabb8b0);
  }
  // The small disconnect and rigid conduit terminate at the curb and vent.
  // Their furthest wall projection is 15 cm, away from the marked roof lane.
  const ez = H.z2 - 0.50;
  addMetal(H.x1 - 0.055, y + 1.07, ez, 0.11, 0.44, 0.31, 0, 0, 0, 0xa6aea5);
  addMetal(H.x1 - 0.116, y + 1.07, ez, 0.014, 0.35, 0.225, 0, 0, 0, 0xbfc4b9);
  addMetal(H.x1 - 0.138, y + 1.07, ez + 0.073, 0.03, 0.095, 0.025, 0, 0, 0, 0x68736d);
  addPipe(H.x1 - 0.065, y + 0.515, ez, 0.038, 0.67, 0.038);
  addPipe(H.x1 - 0.065, y + 1.48, ez, 0.038, 0.38, 0.038);
  addPipe(H.x1 - 0.065, y + 1.67, (ez + vz + 0.8) / 2,
    0.038, ez - vz - 0.8, 0.038, Math.PI / 2);
  for (const cy of [y + 0.38, y + 1.52]) {
    addMetal(H.x1 - 0.036, cy, ez, 0.095, 0.05, 0.10, 0, 0, 0, 0x919d94);
  }

  // These shallow hoods are supported by the already inaccessible service
  // roof, well inside its edges. They add a useful service-yard silhouette
  // without new masses, unsupported pipes or objects in a walking lane.
  const cowlGeometry = createRoofCowlGeometry();
  const addCowl = batches.add('exterior-service-vent-cowls', cowlGeometry, roofMetal, true);
  const capY = y + H.height + 0.14;
  for (const [x, z] of [[-2.6, -14.25], [4.8, -14.25]]) {
    addPipe(x, capY + 0.04, z, 0.56, 0.08, 0.56, 0, 0, 0, 0xaab1a8);
    addPipe(x, capY + 0.36, z, 0.27, 0.56, 0.27, 0, 0, 0, 0xc2c7bb);
    addPipe(x, capY + 0.60, z, 0.37, 0.08, 0.37, 0, 0, 0, 0x878f87);
    addCowl(x, capY + 0.62, z);
    counts.cowls++;
  }

  // A rainwater head and downpipe break up the otherwise uniform south
  // facade. The pipe meets the canopy at its foot and a real parapet at its
  // head. It stays above the balcony and west of the scaffold opening.
  const dx = BUILDING.main.x2 - 0.42, dz = BUILDING.main.z2 + 0.25;
  const pipeBottom = BUILDING.canopyY, pipeTop = y + 0.08;
  addPipe(dx, (pipeBottom + pipeTop) / 2, dz, 0.095, pipeTop - pipeBottom, 0.095,
    0, 0, 0, 0x89998f);
  addMetal(dx, y + 0.15, dz - 0.045, 0.34, 0.30, 0.22, 0, 0, 0, 0x99a79d);
  addMetal(dx, y + 0.303, dz - 0.045, 0.39, 0.025, 0.26, 0, 0, 0, 0xb4bdb2);
  for (const cy of [8.1, 10.7, 13.3]) {
    addMetal(dx, cy, BUILDING.main.z2 + 0.17, 0.21, 0.06, 0.23, 0, 0, 0, 0x8b968b);
    addPipe(dx, cy, dz, 0.117, 0.07, 0.117, 0, 0, 0, 0xa1aba1);
  }

  const countTriangles = source => (source.index?.count ?? source.attributes.position.count) / 3;
  const geometryBytes = Object.values(cowlGeometry.attributes)
    .reduce((sum, attribute) => sum + attribute.array.byteLength, cowlGeometry.index?.array.byteLength ?? 0);
  return {
    counts, finishedDecks: [], addedDraws: 1,
    addedTriangles: (counts.metalBoxes + counts.stoneBoxes) * countTriangles(geometry.box)
      + counts.pipes * countTriangles(geometry.cylinder) + counts.cowls * countTriangles(cowlGeometry),
    cowlGeometryBytes: geometryBytes,
  };
}

/** Apply only after resolveSurfaceOwnership has processed the stock decks. */
export function finishExteriorMaterials(world) {
  // Reuse the old tar's close-range maps; only the named decks receive the
  // shared large-scale finish. Other tar surfaces and source materials stay
  // untouched. Geometry/UVs and movement support records are not replaced.
  const finishedDecks = [];
  for (const name of ROOF_DECKS) {
    const deck = world.getObjectByName(name);
    if (!deck?.isMesh || Array.isArray(deck.material)) continue;
    deck.material = applyRoofMembraneFinish(deck.material);
    finishedDecks.push(name);
  }
  return finishedDecks;
}
