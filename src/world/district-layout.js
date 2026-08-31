/** Metre-based contract shared by district geometry, encounters, navigation and QA. */
function freezeTree(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeTree(child);
  return Object.freeze(value);
}

const streetPoint = (x, z) => ({ x, y: 0.05, z });
const bakeryPoint = (x, z) => ({ x, y: 0.08, z });

export const DISTRICT = freezeTree({
  bounds: { x1: -38, x2: 38, z1: 0, z2: 43 },
  street: {
    road: { x1: -38, x2: 38, z1: 8, z2: 25, floorY: 0.05 },
    nearApron: { x1: -38, x2: 38, z1: 0, z2: 8, floorY: 0.14 },
    farWalk: { x1: -38, x2: 38, z1: 25, z2: 28, floorY: 0.14 },
    frontageZ: 29,
    barrierHeight: 3.4,
    checkpoint: { ...streetPoint(24, 12.2), yaw: Math.PI / 2 },
    spawnPockets: [
      streetPoint(-32, 15), streetPoint(-24, 21), streetPoint(-16, 15), streetPoint(-8, 19),
      streetPoint(0, 14), streetPoint(9, 20), streetPoint(18, 15), streetPoint(29, 16),
      streetPoint(28, 23.5), streetPoint(-31, 23), streetPoint(14, 23.6), streetPoint(34, 11.5),
    ],
    parkedCars: [
      { id: 'west', ...streetPoint(-30, 10.6), yaw: 0.28, variant: 'wagon', color: 0x62624c, finish: 'workhorse' },
      { id: 'middle', ...streetPoint(-11.7, 10.2), yaw: Math.PI - 0.17, variant: 'panel-van', color: 0x858276, finish: 'used' },
      { id: 'east', ...streetPoint(1.8, 8), yaw: Math.PI / 12, variant: 'hatchback', color: 0x777366, finish: 'used',
        curb: { side: 'right', floorY: 0.14 } },
      { id: 'far', ...streetPoint(0, 23.35), yaw: Math.PI + 0.28, variant: 'sedan', color: 0x68554b, finish: 'used' },
    ],
    cover: [
      { id: 'street-cover-west', x: -35, z: 19.5, width: 2.4, height: 1.1, depth: 1.3, material: 'metal' },
      { id: 'street-cover-center', x: 5, z: 22.4, width: 2.8, height: 0.95, depth: 0.75, material: 'concrete' },
      { id: 'street-cover-east', x: 34.8, z: 19.5, width: 2.6, height: 1.15, depth: 1.3, material: 'metal' },
    ],
    qa: {
      firstGun: streetPoint(24, 13.4),
      benchmark: [streetPoint(18, 18), streetPoint(24, 18), streetPoint(28, 18), streetPoint(30, 14)],
      wallShot: { x: -33.5, y: 0.14, z: 26, yaw: Math.PI },
    },
  },
  bakery: {
    x1: -34, x2: -16, z1: 28, z2: 43,
    floorY: 0.08, ceilingY: 4.1, roofY: 11.3, wallThickness: 0.22,
    door: { x1: -20.5, x2: -17, z: 28, topY: 3.3 },
    partition: { z: 35.5, doorX1: -22, doorX2: -18, topY: 3.3 },
    checkpoint: { ...bakeryPoint(-18.2, 29.2), yaw: Math.PI },
    counter: { x: -27.8, z: 32.1, width: 8, depth: 1.4, height: 1.08 },
    prepTable: { x: -27.75, z: 38.8, width: 4.5, depth: 1.2, height: 1.12 },
    oven: { x: -32.9, z: 39.8, width: 1.4, depth: 3.6, height: 2.1 },
    spawnPockets: [
      bakeryPoint(-24, 30), bakeryPoint(-28, 29.8), bakeryPoint(-32, 30.2),
      bakeryPoint(-22.5, 33.1), bakeryPoint(-26, 34.4), bakeryPoint(-19.3, 37.2),
      bakeryPoint(-22.6, 39.4), bakeryPoint(-24, 41.5), bakeryPoint(-29.5, 41.2),
      bakeryPoint(-31.5, 36.9), bakeryPoint(-23.5, 36.9),
    ],
    accessRoute: [
      { x: -18.75, y: 0.14, z: 26.5 }, bakeryPoint(-18.75, 28.4),
      bakeryPoint(-18.75, 32.8), bakeryPoint(-19.5, 35.5),
      bakeryPoint(-19.5, 37.2), bakeryPoint(-22.6, 39.4), bakeryPoint(-24, 41.5),
    ],
  },
  car: {
    // The east bay requires a turn away from the scaffold landing and bakery
    // crossing. Walking straight out of the descent cannot choose the car.
    ...streetPoint(32, 23), yaw: Math.PI, length: 4.6, width: 1.9, commitRadius: 4.5,
    approach: streetPoint(32, 20.2),
    placard: { x: 35.2, y: 0.14, z: 26.65 },
    spawnPockets: [
      streetPoint(23, 17.5), streetPoint(24, 24), streetPoint(36, 23.5),
      streetPoint(32, 14.5), streetPoint(27, 16), streetPoint(20, 22),
    ],
  },
  shops: [
    { id: 0, x1: -38, x2: -34, height: 8.6, name: 'REPAIRS', sub: 'SHOES & LEATHER' },
    { id: 1, x1: -16, x2: -7, height: 10.6, name: 'CARMINE DELI', sub: 'GROCERIES & COFFEE' },
    { id: 2, x1: -7, x2: 2, height: 12.8, name: 'PALERMO MARKET', sub: 'FRESH PRODUCE DAILY' },
    { id: 3, x1: 2, x2: 11, height: 9.5, name: 'PHARMACY', sub: 'PRESCRIPTIONS' },
    { id: 4, x1: 11, x2: 20, height: 11.4, name: 'SICILY LAUNDRY', sub: 'WASH · DRY · FOLD' },
    { id: 5, x1: 20, x2: 29, height: 10.1, name: 'VITO & SONS', sub: 'BARBER SHOP' },
    { id: 6, x1: 29, x2: 38, height: 12.3, name: 'HARDWARE', sub: 'TOOLS & SUPPLIES' },
  ],
});
