/** Authored spatial contract, in metres. Rendering, encounters and QA share it. */
function freezeTree(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeTree(child);
  }
  return Object.freeze(value);
}

export const BUILDING = freezeTree({
  main: { x1: -15, x2: 13, z1: -10, z2: 0 },
  tower: { x1: -21, x2: -15, z1: -10, z2: 0 },
  floorY: 0,
  apartmentY: 4,
  canopyY: 7.4,
  roofY: 14,
  towerRoofY: 16.6,
  wallThickness: 0.2,
});

export const BALCONY = freezeTree({
  floorY: BUILDING.apartmentY,
  east: { x1: 9, x2: 13, z1: -10, z2: 0 },
  wrap: { x1: -19, x2: 13, z1: 0, z2: 1.8 },
  laneZ: 0.95,
  guardHeight: 2.7,
  railHeight: 1.1,
  edgeInset: 0.05,
});

// Both faces describe the same opening in world space. Width follows +X on a
// Z-normal wall and +Z on an X-normal wall; never negate a door's coordinates
// to draw its other face. Closed leaves remain physical progression barriers.
export const APARTMENT_DOORS = freezeTree({
  playerEntry: {
    id: 'apartment-entry', axis: 'z', x: -5.4, z: BUILDING.main.z2,
    floorY: BUILDING.apartmentY, width: 1.14, height: 2.12,
    wallThickness: BUILDING.wallThickness, frameWidth: 0.07,
    slabThickness: 0.07, handleSide: -1, closed: true, charred: true, number: '4A',
  },
  neighborTerrace: {
    id: 'neighbor-terrace', axis: 'x', x: BALCONY.east.x1, z: -5,
    floorY: BUILDING.apartmentY, width: 4, height: 2.9,
    wallThickness: BUILDING.wallThickness, frameWidth: 0.06,
    slabThickness: 0.07, handleSide: 1, closed: false, charred: false, number: '4B',
  },
});

// A connected service wing carries the expanded roof. The lightwell preserves
// daylight and an honest exterior face for the apartment's north window.
export const ROOF = freezeTree({
  x1: -15, x2: 25, z1: -24, z2: 0, floorY: BUILDING.roofY,
  lightwell: { x1: -12.5, x2: -7.5, z1: -15, z2: -10 },
  serviceHouse: { x1: -4, x2: 7, z1: -16, z2: -10, height: 3.1 },
  exit: { x1: 19, x2: 25, z: 0 },
  route: [[-13.5, 14, -8.4], [-6, 14, -7], [10, 14, -7], [22, 14, -4], [22, 14, -0.5]],
  spawnPockets: [[-11, -19], [-6.5, -20], [2, -20], [12, -20], [20, -20], [20, -12], [13, -5], [22, -4], [4, -5], [-10, -5]],
});

// Offset platforms make each descent leg a playable work area. The third
// deck stays outside the balcony screen; all supports stand on the near apron.
export const SCAFFOLD_LEVELS = freezeTree([
  { y: 10, x1: 14, x2: 28, z1: 0.3, z2: 5.8 },
  { y: 7, x1: 8, x2: 23, z1: 1, z2: 6.4 },
  { y: 4, x1: 17, x2: 32, z1: 1.85, z2: 7.3 },
  { y: 1.5, x1: 10, x2: 26, z1: 2.2, z2: 8 },
]);

export const OPENINGS = freezeTree({
  neighborBalcony: {
    min: [APARTMENT_DOORS.neighborTerrace.x - 0.11, APARTMENT_DOORS.neighborTerrace.floorY,
      APARTMENT_DOORS.neighborTerrace.z - APARTMENT_DOORS.neighborTerrace.width / 2],
    max: [APARTMENT_DOORS.neighborTerrace.x + 0.11, APARTMENT_DOORS.neighborTerrace.floorY + APARTMENT_DOORS.neighborTerrace.height,
      APARTMENT_DOORS.neighborTerrace.z + APARTMENT_DOORS.neighborTerrace.width / 2],
  },
  balconyStair: { min: [-19, 4, -0.11], max: [-17, 6, 0.11] },
  stairRoof: { min: [-15.31, 14, -9.6], max: [-14.87, 16, -7.95] },
  roofScaffold: { min: [19, 14, -0.13], max: [25, 15.2, 0.13] },
  bakery: { min: [-20.5, 0.08, 27.89], max: [-17, 3.3, 28.11] },
});

export const SCAFFOLD_TRIGGER_MIN_Z = BALCONY.wrap.z2 + 0.2;
