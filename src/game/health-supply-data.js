import { BALCONY, BUILDING, ROOF } from '../world/layout.js';
import { STAIRS } from '../world/stair-layout.js';

function freezeTree(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeTree(child);
  return Object.freeze(value);
}

const roofY = ROOF.floorY;
const westLinkX = (ROOF.x1 + ROOF.lightwell.x1) / 2;
const northLaneZ = ROOF.serviceHouse.z1 - 3;
const escapeX = (ROOF.exit.x1 + ROOF.exit.x2) / 2;

/** Fixed, finite health supplies. Coordinates are supporting floors, not eyes. */
export const HEALTH_SUPPLIES = freezeTree([
  // Preserve every existing supply and amount, including their original order.
  { id: 'apartment-escape', zone: 'apartment', x: -10, y: BUILDING.apartmentY, z: -4, amount: 25 },
  { id: 'neighbor-living-room', zone: 'neighbor', x: 3, y: BUILDING.apartmentY, z: -7, amount: 25 },
  { id: 'balcony-east', zone: 'balcony', x: 11.5, y: BALCONY.floorY, z: -3.5, amount: 25 },
  { id: 'balcony-stair-entry', zone: 'balcony', x: -18, y: BALCONY.floorY, z: BALCONY.laneZ, amount: 25 },
  { id: 'stair-first-landing', zone: 'stairwell', x: -16.55, y: 6.4, z: -0.85, amount: 30 },
  { id: 'roof-front-east', zone: 'roof', x: 13, y: roofY, z: -5, amount: 30, route: 'front' },
  { id: 'roof-front-west', zone: 'roof', x: -10, y: roofY, z: -5, amount: 30, route: 'front' },
  { id: 'scaffold-middle', zone: 'scaffolding', x: 15.5, y: 7, z: 4.2, amount: 25 },
  { id: 'scaffold-lower', zone: 'scaffolding', x: 18, y: 1.5, z: 5.2, amount: 25 },
  { id: 'street-west', zone: 'street', x: 0, y: 0.05, z: 14, amount: 35 },
  { id: 'street-east', zone: 'street', x: 29, y: 0.05, z: 16, amount: 35 },
  { id: 'bakery-counter', zone: 'bakery', x: -22.5, y: 0.08, z: 33.1, amount: 35 },
  { id: 'bakery-prep', zone: 'bakery', x: -22.6, y: 0.08, z: 39.4, amount: 35 },
  // The back crossing follows the west link around the open lightwell, then
  // passes north of the mechanical house. Its two packs match the front's 60 HP.
  { id: 'roof-north-west', zone: 'roof', x: westLinkX, y: roofY, z: ROOF.lightwell.z1 + 0.8, amount: 30, route: 'north' },
  { id: 'roof-north-east', zone: 'roof', x: ROOF.serviceHouse.x2 + 5, y: roofY, z: northLaneZ, amount: 30, route: 'north' },
]);

/**
 * Physical landmark routes for placement checks and presentation. These never
 * select enemy types or move a pack when an encounter roster changes. Views
 * use feet positions and the player's yaw convention: east=-PI/2, north=0.
 */
export const ROOF_HEALTH_ROUTES = freezeTree({
  front: {
    id: 'front', label: 'Front crossing beside the water tank',
    supplyIds: ['roof-front-west', 'roof-front-east'],
    waypoints: [STAIRS.roofExit, [-10, roofY, -5], [13, roofY, -5], [escapeX, roofY, -4], [escapeX, roofY, -0.5]],
    views: [
      { id: 'stair-door-forward', from: [STAIRS.flights.at(-1).x, roofY, STAIRS.roofExit[2]], yaw: -Math.PI / 2, supplyIds: ['roof-front-east'] },
      { id: 'roof-entry-forward', from: STAIRS.roofExit, yaw: -Math.PI / 2, supplyIds: ['roof-front-west'] },
    ],
  },
  north: {
    id: 'north', label: 'North crossing around the lightwell and mechanical house',
    supplyIds: ['roof-north-west', 'roof-north-east'],
    waypoints: [
      STAIRS.roofExit, [westLinkX, roofY, ROOF.lightwell.z2 + 1],
      [westLinkX, roofY, ROOF.lightwell.z1 + 0.8], [westLinkX, roofY, northLaneZ],
      [ROOF.serviceHouse.x2 + 5, roofY, northLaneZ], [escapeX, roofY, northLaneZ],
      [escapeX, roofY, -4], [escapeX, roofY, -0.5],
    ],
    views: [
      { id: 'turn-left-from-roof-door', from: STAIRS.roofExit, yaw: 0, supplyIds: ['roof-north-west'] },
      { id: 'north-mechanical-crossing', from: [ROOF.serviceHouse.x1 + 8, roofY, northLaneZ], yaw: -Math.PI / 2, supplyIds: ['roof-north-east'] },
    ],
  },
});
