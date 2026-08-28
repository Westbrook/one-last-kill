import { BUILDING, OPENINGS } from './layout.js';

function freezeTree(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeTree(child);
  }
  return Object.freeze(value);
}

// Metres. The flight run stops before either turning platform: no stringer,
// guard or stair block is allowed to continue through those platforms.
const stepsPerFlight = 14;
const laneWidth = 2.4;
const waistThickness = 0.18;
const landingThickness = 0.18;
const flightZ = { north: -7.1, south: -2.9 };
const lanes = { west: -19.4, east: -16.6 };
const interior = { x1: -20.9, x2: -15.3, z1: -9.9, z2: -0.1 };

const landings = [
  { id: 'stair-entry-landing', side: 'entry', y: 4, z1: interior.z1, z2: interior.z2 },
  { id: 'stair-south-landing-1', side: 'south', y: 6.4, z1: flightZ.south, z2: interior.z2 },
  { id: 'stair-north-landing-2', side: 'north', y: 9, z1: interior.z1, z2: flightZ.north },
  { id: 'stair-south-landing-3', side: 'south', y: 11.6, z1: flightZ.south, z2: interior.z2 },
  { id: 'stair-north-landing-4', side: 'north', y: 14, z1: interior.z1, z2: flightZ.north },
].map((landing) => ({
  ...landing, x1: interior.x1, x2: interior.x2,
  thickness: landing.side === 'entry' ? 0.2 : landingThickness,
  spawnPoints: landing.side === 'entry' ? [] : [-19.45, -16.55].map(x => ({
    x, y: landing.y, z: landing.side === 'south' ? -0.85 : -9.0,
  })),
}));

const flights = landings.slice(1).map((landing, index) => {
  const previous = landings[index];
  const lane = index % 2 === 0 ? 'west' : 'east';
  const zStart = lane === 'west' ? flightZ.north : flightZ.south;
  const zEnd = lane === 'west' ? flightZ.south : flightZ.north;
  const rise = (landing.y - previous.y) / stepsPerFlight;
  const run = Math.abs(zEnd - zStart);
  const treadDepth = run / stepsPerFlight;
  const x = lanes[lane];
  const id = `stair-flight-${index + 1}`;
  const treads = Array.from({ length: stepsPerFlight }, (_, step) => {
    const a = zStart + (zEnd - zStart) * step / stepsPerFlight;
    const b = zStart + (zEnd - zStart) * (step + 1) / stepsPerFlight;
    const topY = previous.y + rise * (step + 1);
    return {
      id: `${id}-tread-${String(step + 1).padStart(2, '0')}`,
      index: step + 1, x1: x - laneWidth / 2, x2: x + laneWidth / 2,
      z1: Math.min(a, b), z2: Math.max(a, b), topY,
      // Each block is a shallow part of a connected stepped waist, not a
      // floor-to-tread wall. The space underneath stays usable at entry level.
      bottomY: topY - rise - waistThickness,
    };
  });
  return {
    id, lane, x, width: laneWidth, fromY: previous.y, toY: landing.y,
    zStart, zEnd, steps: stepsPerFlight, rise, run, treadDepth,
    bottomLanding: previous.id, topLanding: landing.id,
    guardX: x + (lane === 'west' ? 1 : -1) * (laneWidth / 2 - 0.045),
    treads,
  };
});

const roofDoorZ = (OPENINGS.stairRoof.min[2] + OPENINGS.stairRoof.max[2]) / 2;

/** Rendering, encounter anchors and traversal tests consume this same layout. */
export const STAIRS = freezeTree({
  footprint: BUILDING.tower, interior,
  entryY: 4, exitY: 14, towerRoofY: BUILDING.towerRoofY,
  stepsPerFlight, laneWidth, waistThickness, landingThickness,
  guardHeight: 1.1, flightZ, lanes,
  entryDoor: OPENINGS.balconyStair, roofDoor: OPENINGS.stairRoof,
  // The opening includes clearance around the wall. Its threshold occupies
  // only the gap between slabs, so adjacent floor faces never overlap.
  roofThreshold: {
    x1: interior.x2, x2: BUILDING.main.x1,
    z1: OPENINGS.stairRoof.min[2], z2: OPENINGS.stairRoof.max[2],
    y: BUILDING.roofY, thickness: landingThickness,
    wallExteriorX: interior.x2 + BUILDING.wallThickness,
  },
  landings, flights,
  turns: { southZ: -0.65, northZ: -9.2 },
  roofExit: [-14.4, 14, roofDoorZ],
  // Positions are feet anchors [x, y, z]. The first leg passes below the east
  // flight; turns remain well behind the ends of the stair guards.
  route: [
    [-18, 4, -0.65], [-16.6, 4, -0.65], [-16.6, 4, -9.2], [-19.4, 4, -9.2],
    [-19.4, 6.4, -0.65], [-16.6, 6.4, -0.65], [-16.6, 9, -9.2], [-19.4, 9, -9.2],
    [-19.4, 11.6, -0.65], [-16.6, 11.6, -0.65], [-16.6, 14, -9.2], [-16.6, 14, roofDoorZ],
  ],
});
