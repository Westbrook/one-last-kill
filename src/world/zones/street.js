import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three';

import { MATS } from '../../render/materials.js';
import { makeHumanoid, HUMANOID_PRESETS, _CG, _BG, pushDecor } from '../../render/models.js';
import { Colliders } from '../../core/collision.js';
import { World, WorldState, Triggers, addBox, addSign, makeSmokeSystem } from '../world.js';
import { BUILDING } from '../layout.js';
import { DISTRICT } from '../district-layout.js';

const boxDetail = (material, x, y, z, width, height, depth, yaw = 0) =>
  pushDecor(_BG.unitBox, material, x, y, z, width, height, depth, yaw);

const BAKERY_WALL_FINISH = Object.freeze({ offset: 0.118, thickness: 0.018 });
const BAKERY_DOOR_CASING = Object.freeze({ width: 0.09, depth: 0.032 });

function pavement(id, bounds, material) {
  const { x1, x2, z1, z2, floorY } = bounds;
  return addBox((x1 + x2) / 2, floorY / 2, (z1 + z2) / 2, x2 - x1, floorY, z2 - z1, material, {
    cast: false, architecture: { id, kind: 'floor', supportKind: 'ground' },
  });
}

/** A full block with playable pavement, closed shop volumes and visible end barriers. */
function buildStreet() {
  const { street, bounds, bakery } = DISTRICT;
  pavement('street-road', street.road, MATS.asphalt);
  pavement('near-apron', street.nearApron, MATS.concrete);
  pavement('far-sidewalk', street.farWalk, MATS.concrete);
  pavement('far-frontage-apron', { x1: bakery.x2, x2: bounds.x2, z1: street.farWalk.z2, z2: street.frontageZ, floorY: street.farWalk.floorY }, MATS.concrete);
  pavement('far-frontage-west', { x1: bounds.x1, x2: bakery.x1, z1: street.farWalk.z2, z2: street.frontageZ, floorY: street.farWalk.floorY }, MATS.concrete);

  const yellowPaint = new THREE.MeshStandardMaterial({ color: 0xb3a05d, roughness: 0.97 });
  const whitePaint = new THREE.MeshStandardMaterial({ color: 0xb7b9ac, roughness: 0.98 });
  for (let x = bounds.x1 + 3; x < bounds.x2 - 2; x += 5.8) {
    for (const z of [16.37, 16.63]) boxDetail(yellowPaint, x, 0.054, z, 2.8, 0.006, 0.11);
  }
  // The crossing leads to the only open shop; paint is not collision geometry.
  for (let z = 8.7; z < 24.5; z += 1.35) boxDetail(whitePaint, -18.75, 0.055, z, 3.2, 0.007, 0.52);
  for (const x of [-35.3, 35.3]) boxDetail(whitePaint, x, 0.055, 16.5, 0.28, 0.007, 15.9);
  for (const z of [8, 25]) boxDetail(MATS.concrete, 0, 0.096, z, 76, 0.09, 0.15);
  for (let x = -36; x < 38; x += 2.8) {
    boxDetail(MATS.tar, x, 0.142, 4, 0.015, 0.003, 7.8);
    boxDetail(MATS.tar, x, 0.142, 26.5, 0.015, 0.003, 2.9);
  }

  buildStreetBoundaries();
  for (const shop of DISTRICT.shops) buildClosedShop(shop);
  buildMainStreetShell();
  buildStreetPracticalDetails();

  for (const parked of street.parkedCars) {
    const car = spawnParkedCar(parked.x, parked.y, parked.z, parked.yaw, parked.color);
    car.name = 'parked-sedan-' + parked.x;
  }
  for (const cover of street.cover) {
    const floor = street.road.floorY;
    addBox(cover.x, floor + cover.height / 2, cover.z, cover.width, cover.height, cover.depth, MATS[cover.material], {
      architecture: { id: cover.id, kind: 'cover', supports: ['street-road'] },
    });
    if (cover.material === 'metal') {
      boxDetail(MATS.metal, cover.x, floor + cover.height + 0.035, cover.z, cover.width + 0.08, 0.07, cover.depth + 0.08);
      for (const offset of [-0.8, 0, 0.8]) boxDetail(MATS.metal, cover.x + offset, floor + cover.height / 2, cover.z - cover.depth / 2 - 0.025, 0.045, cover.height * 0.78, 0.045);
    } else {
      for (const offset of [-0.9, 0.9]) boxDetail(whitePaint, cover.x + offset, floor + 0.63, cover.z - cover.depth / 2 - 0.007, 0.34, 0.14, 0.01);
    }
  }

  Triggers.add('street', new THREE.Vector3(bounds.x1 + 0.3, 0, street.road.z1), new THREE.Vector3(bounds.x2 - 0.3, 3.5, street.farWalk.z2 - 0.2));
}

function buildStreetBoundaries() {
  const { bounds, street } = DISTRICT;
  // The enlarged annex occupies x13..25. Its east service gate begins beyond
  // that wall; the old gate's registry ID is retained without blocking the annex.
  const gateRanges = [
    ['west-service-gate', bounds.x1, BUILDING.tower.x1 - BUILDING.wallThickness / 2],
    ['east-service-gate', 25 + BUILDING.wallThickness / 2, bounds.x2],
  ];
  for (const [id, x1, x2] of gateRanges) {
    const width = x2 - x1, center = (x1 + x2) / 2, floor = street.nearApron.floorY;
    addBox(center, floor + 1.35, 0, width, 2.7, 0.12, MATS.metal, {
      architecture: { id, kind: 'gate', supports: ['near-apron'] },
    });
    for (let x = x1 + 0.1; x < x2; x += 1.5) boxDetail(MATS.metal, x, floor + 1.5, 0.09, 0.09, 3, 0.09);
    for (const y of [floor + 0.3, floor + 2.4]) boxDetail(MATS.wood, center, y, 0.087, width - 0.15, 0.12, 0.045);
    const notice = addSign(center, floor + 1.8, 0.073, 2.8, 0.42, '+z', 'SERVICE ACCESS', { bg: '#292d28', fg: '#c4c5b4', font: 'bold 86px sans-serif' });
    notice.name = id + '-notice';
    notice.userData.mountId = id;
  }

  // Each end is a visible construction closure. There are no invisible x±25
  // or z30 walls left inside the playable district.
  for (const [side, x, facing] of [['west', bounds.x1, '+x'], ['east', bounds.x2, '-x']]) {
    const id = 'street-boundary-' + side;
    addBox(x, 0.65, 14.5, 0.45, 1.2, 29, MATS.concrete, {
      architecture: { id: id + '-base', kind: 'barrier', supportKind: 'ground' },
    });
    addBox(x, 2.35, 14.5, 0.12, 2.2, 29, MATS.metal, {
      architecture: { id: id + '-fence', kind: 'barrier', supports: [id + '-base'] },
    });
    for (let z = 0.4; z < 29; z += 2.4) boxDetail(MATS.metal, x, 1.77, z, 0.23, 3.44, 0.14);
    for (const y of [1.33, 3.2]) boxDetail(MATS.metal, x, y, 14.5, 0.20, 0.09, 29);
    const sign = addSign(x + (side === 'west' ? 0.08 : -0.08), 2.15, 16.5, 4.1, 0.8, facing, 'STREET CLOSED', {
      bg: '#39362b', fg: '#ddd1a9', font: 'bold 95px sans-serif', sub: 'LOCAL ACCESS ONLY', subFont: '26px sans-serif',
    });
    sign.userData.mountId = id + '-fence';
  }
}

function addFacadeWindow(x, y, z, width = 1.25, height = 1.65) {
  boxDetail(MATS.tar, x, y, z - 0.014, width, height, 0.026);
  boxDetail(MATS.glass, x, y, z - 0.044, width - 0.1, height - 0.1, 0.018);
  for (const dx of [-width / 2, width / 2]) boxDetail(MATS.metal, x + dx, y, z - 0.063, 0.065, height + 0.10, 0.075);
  for (const dy of [-height / 2, 0, height / 2]) boxDetail(MATS.metal, x, y + dy, z - 0.067, width + 0.04, 0.055, 0.08);
  boxDetail(MATS.concrete, x, y - height / 2 - 0.08, z - 0.05, width + 0.3, 0.16, 0.3);
  boxDetail(MATS.concrete, x, y + height / 2 + 0.06, z - 0.045, width + 0.24, 0.12, 0.23);
}

function buildClosedShop(shop) {
  const { street, bakery } = DISTRICT;
  const front = street.frontageZ, back = bakery.z2, floor = street.farWalk.floorY;
  const width = shop.x2 - shop.x1, x = (shop.x1 + shop.x2) / 2;
  const id = 'storefront-mass-' + shop.id;
  addBox(x, (floor + shop.height) / 2, (front + back) / 2, width, shop.height - floor, back - front, MATS.brick, {
    architecture: { id, kind: 'building', supportKind: 'ground' },
  });
  const shutterWidth = width > 5 ? width - 3.3 : width - 0.7;
  const shutterX = width > 5 ? shop.x1 + 0.45 + shutterWidth / 2 : x;
  boxDetail(MATS.metal, shutterX, 1.62, front - 0.06, shutterWidth, 2.88, 0.11);
  for (let y = 0.35; y < 3.02; y += 0.18) boxDetail(MATS.metal, shutterX, y, front - 0.13, shutterWidth, 0.035, 0.05);
  for (const sx of [shop.x1 + 0.13, shop.x2 - 0.13]) boxDetail(MATS.concrete, sx, 1.85, front - 0.08, 0.26, 3.5, 0.24);
  if (width > 5) {
    const doorX = shop.x2 - 1.15;
    boxDetail(MATS.wood, doorX, 1.59, front - 0.07, 1.4, 2.9, 0.12);
    boxDetail(MATS.glass, doorX, 2.02, front - 0.144, 1.06, 1.4, 0.025);
    for (const dx of [-0.78, 0.78]) boxDetail(MATS.metal, doorX + dx, 1.66, front - 0.11, 0.09, 3.05, 0.12);
    boxDetail(MATS.metal, doorX + 0.43, 1.4, front - 0.185, 0.045, 0.25, 0.045);
    const closed = addSign(doorX, 2.15, front - 0.165, 0.55, 0.21, '-z', 'CLOSED', { bg: '#322d26', fg: '#b9b7a2', font: 'bold 90px sans-serif' });
    closed.userData.mountId = id;
  }
  boxDetail(MATS.wood, x, 3.7, front - 0.08, width - 0.12, 0.92, 0.18);
  const sign = addSign(x, 3.7, front - 0.19, width - 0.7, 0.68, '-z', shop.name, {
    bg: '#252923', fg: '#c5bd98', font: 'bold 84px serif', sub: shop.sub, subFont: '25px sans-serif',
  });
  sign.userData.mountId = id;
  const columns = width > 5 ? 3 : 1;
  for (let y = 5.7; y < shop.height - 1.1; y += 2.8) {
    for (let i = 0; i < columns; i++) addFacadeWindow(shop.x1 + width * (i + 1) / (columns + 1), y, front, 1.25, 1.65);
  }
  for (const y of [4.3, shop.height - 0.04]) boxDetail(MATS.concrete, x, y, front - 0.10, width + 0.04, 0.2, 0.34);
  boxDetail(MATS.concrete, x, shop.height + 0.12, (front + back) / 2, width, 0.24, back - front);
  const pipeX = shop.x2 - 0.36;
  pushDecor(_BG.pipe, MATS.metal, pipeX, (shop.height + floor) / 2, front - 0.18, 0.055, shop.height - floor, 0.055);
  for (let y = 1.2; y < shop.height; y += 2.7) boxDetail(MATS.metal, pipeX, y, front - 0.14, 0.17, 0.075, 0.19);
  boxDetail(MATS.metal, shop.x1 + 0.5, 2.4, front - 0.18, 0.32, 0.44, 0.2);
}

function buildStreetPracticalDetails() {
  const lightMaterial = new THREE.MeshStandardMaterial({ color: 0xe5cf9a, emissive: 0xffc678, emissiveIntensity: 1.6, roughness: 0.55 });
  const fixtures = [[-31, 7.5, 0.14], [-10, 7.5, 0.14], [2, 26.7, 0.14], [17, 26.7, 0.14], [34, 26.7, 0.14]];
  for (const [x, z, floor] of fixtures) {
    addBox(x, floor + 2.7, z, 0.15, 5.4, 0.15, MATS.metal);
    boxDetail(MATS.metal, x + 0.52, floor + 5.4, z, 1.18, 0.09, 0.1);
    boxDetail(MATS.metal, x + 1.05, floor + 5.3, z, 0.46, 0.17, 0.28);
    boxDetail(lightMaterial, x + 1.05, floor + 5.2, z, 0.36, 0.035, 0.21);
    const light = new THREE.PointLight(0xffc98a, 1.2, 16, 1.7);
    light.position.set(x + 1.05, floor + 5.15, z);
    World.add(light);
  }
  for (const [x, z, support] of [[-35, 5.8, 'near-apron'], [-5, 5.8, 'near-apron'], [-12, 26.6, 'far-sidewalk'], [11, 26.6, 'far-sidewalk']]) {
    addBox(x, 0.65, z, 0.6, 1.02, 0.6, MATS.metal, {
      architecture: { id: 'street-bin-' + x, kind: 'furniture', supports: [support] },
    });
    boxDetail(MATS.metal, x, 1.19, z, 0.64, 0.07, 0.64);
    boxDetail(MATS.tar, x, 1.227, z, 0.38, 0.008, 0.38);
  }
  // Deterministic litter stays along the curb and cannot snag the player capsule.
  for (let i = 0; i < 24; i++) {
    const x = -35 + (i * 13 % 70), z = i % 2 ? 25.42 : 7.52;
    boxDetail(i % 3 ? MATS.plaster : MATS.wood, x, 0.148, z, 0.18 + i % 4 * 0.04, 0.008, 0.13, i * 0.71);
  }
  for (const x of [-28, -8, 13, 31]) {
    boxDetail(MATS.metal, x, 0.054, 8.4, 0.85, 0.006, 0.32);
    for (let dx = -0.32; dx < 0.4; dx += 0.12) boxDetail(MATS.tar, x + dx, 0.059, 8.4, 0.055, 0.005, 0.26);
  }
}

function buildMainStreetShell() {
  // One shell agrees with the roof above. The western tower is built by the
  // traversal module; the eastern apartment-height recess remains a terrace.
  const { main, floorY, apartmentY, canopyY, roofY, wallThickness } = BUILDING;
  const centerX = (main.x1 + main.x2) / 2, centerZ = (main.z1 + main.z2) / 2;
  const mainWidth = main.x2 - main.x1, mainDepth = main.z2 - main.z1;
  const groundHeight = apartmentY - floorY, upperHeight = roofY - canopyY;
  addBox(centerX, floorY - 0.1, centerZ, mainWidth, 0.2, mainDepth, MATS.concrete, {
    cast: false, architecture: { id: 'main-ground-floor', kind: 'floor', supportKind: 'ground' },
  });
  for (const [side, z] of [['south', main.z2], ['north', main.z1]]) {
    addBox(centerX, floorY + groundHeight / 2, z, mainWidth, groundHeight, wallThickness, MATS.brick, {
      architecture: { id: `main-ground-${side}`, kind: 'wall', supports: ['main-ground-floor'] },
    });
    addBox(centerX, canopyY + upperHeight / 2, z, mainWidth, upperHeight, wallThickness, MATS.brick, {
      architecture: { id: `main-upper-${side}`, kind: 'wall', supports: ['apartment-ceiling', 'neighbor-ceiling', 'terrace-canopy'] },
    });
  }
  addBox(main.x2, floorY + groundHeight / 2, centerZ, wallThickness, groundHeight, mainDepth, MATS.brick, {
    architecture: { id: 'main-ground-east', kind: 'wall', supports: ['main-ground-floor'] },
  });
  addBox(main.x2, canopyY + upperHeight / 2, centerZ, wallThickness, upperHeight, mainDepth, MATS.brick, {
    architecture: { id: 'main-upper-east', kind: 'wall', supports: ['terrace-canopy'] },
  });

  // Facade-floor trim bands on the apartment-building south face — two
  // shallow concrete belts visually separate apartment floor and roof level.
  // y=4 is skipped because the wrap-walkway deck sits there; trim at y=7.4
  // and y=13.95 reads from both balcony walkway and street POV. Pure decor
  // (no collider), shared unit box, narrow depth so it doesn't intrude into
  // the walkway clearance.
  for (const ty of [canopyY, roofY - 0.05]) {
    pushDecor(_BG.unitBox, MATS.concrete, centerX, ty, main.z2 + 0.15, mainWidth + 0.2, 0.18, 0.06);
  }
  // Both downpipes stay on the actual shell, flush behind the walkway lane.
  const eastPipeX = main.x2 - 0.4;
  for (const px of [-12.0, eastPipeX]) {
    pushDecor(_BG.pipe, MATS.metal, px, 7.0, 0.20, 0.10, 13.8, 0.10);
    for (const by of [2.5, 6.2, 10.0, 12.8]) {
      pushDecor(_BG.unitBox, MATS.metal, px, by, 0.17, 0.26, 0.10, 0.18);
    }
  }
  pushDecor(_BG.unitBox, MATS.metal, eastPipeX - 0.4, 1.4, 0.17, 0.42, 0.55, 0.22);
  // Vintage hand-painted ghost sign on the apartment building's upper face.
  addSign(-7.0, 11.6, 0.13, 7.0, 1.2, '+z', 'TRATTORIA', { bg: '#2a0e08', fg: '#d8a060', font: 'bold 110px serif', sub: 'VINO & PANE', subFont: 'italic 36px serif' });

}

function spawnParkedCar(x, y, z, rotY, bodyColor, opts = {}) {
  const o = Object.assign({ idling: false, length: 4.4, width: 1.8, height: 1.2 }, opts);
  const car = new THREE.Group();
  car.position.set(x, y, z);
  car.rotation.y = rotY;
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.45, metalness: 0.6 });
  // Darker trim shade derived from bodyColor — used for pillars / lower rocker
  // panel so the side silhouette doesn't read as one flat slab.
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.7, metalness: 0.4 });
  const cabinMat = new THREE.MeshStandardMaterial({ color: 0x26323b, roughness: 0.19, metalness: 0.45, transparent: true, opacity: 0.88 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95, metalness: 0.0 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xb8b8c0, roughness: 0.25, metalness: 0.85 });
  const redMat = new THREE.MeshStandardMaterial({ color: 0x801010, emissive: 0xa01818, emissiveIntensity: o.idling ? 1.4 : 0.25, roughness: 0.4 });

  const body = new THREE.Mesh(new RoundedBoxGeometry(o.length, 0.5, o.width, 3, 0.16), bodyMat);
  body.position.y = 0.55; body.castShadow = true; body.receiveShadow = true; car.add(body);
  // Lower rocker panel — narrow dark strip under the body for visual weight.
  const rocker = new THREE.Mesh(new THREE.BoxGeometry(o.length * 0.98, 0.10, o.width * 1.02), trimMat);
  rocker.position.y = 0.35; car.add(rocker);
  const hood = new THREE.Mesh(new RoundedBoxGeometry(o.length * 0.95, 0.1, o.width * 0.95, 2, 0.04), bodyMat);
  hood.position.y = 0.82; hood.castShadow = true; car.add(hood);
  // Hood vent / ornament — small chrome strip near the front of the hood.
  const hoodOrn = new THREE.Mesh(_CG.unitBox, chromeMat);
  hoodOrn.scale.set(0.18, 0.04, 0.22);
  hoodOrn.position.set(o.length * 0.38, 0.88, 0); car.add(hoodOrn);
  const cabinGeometry = new THREE.BoxGeometry(o.length * 0.55, 0.6, o.width * 0.9);
  const cabinVertices = cabinGeometry.attributes.position;
  for (let i = 0; i < cabinVertices.count; i++) {
    if (cabinVertices.getY(i) > 0) {
      cabinVertices.setX(i, cabinVertices.getX(i) * 0.78);
      cabinVertices.setZ(i, cabinVertices.getZ(i) * 0.86);
    }
  }
  cabinGeometry.computeVertexNormals();
  const cabin = new THREE.Mesh(cabinGeometry, cabinMat);
  cabin.position.set(-0.1, 1.15, 0); cabin.castShadow = true; car.add(cabin);
  // Cabin pillars (A + B) and waistline trim — break up the glass with a few
  // dark struts so the cabin reads as a windowed greenhouse instead of a slab.
  const cabL = o.length * 0.55;
  for (const px of [cabL * 0.46, -cabL * 0.46, cabL * 0.05]) {
    for (const sz of [-1, 1]) {
      const pillar = new THREE.Mesh(_CG.unitBox, trimMat);
      pillar.scale.set(0.06, 0.6, 0.06);
      pillar.rotation.z = Math.atan2(px * 0.22, 0.6);
      pillar.position.set(-0.1 + px * 0.89, 1.15, sz * (o.width * 0.42));
      car.add(pillar);
    }
  }
  // Window-base waistline trim — thin chrome line where glass meets body.
  for (const sz of [-1, 1]) {
    const wb = new THREE.Mesh(_CG.unitBox, chromeMat);
    wb.scale.set(o.length * 0.55, 0.03, 0.025);
    wb.position.set(-0.1, 0.88, sz * (o.width * 0.46));
    car.add(wb);
  }
  const roof = new THREE.Mesh(new RoundedBoxGeometry(o.length * 0.43, 0.05, o.width * 0.77, 2, 0.018), bodyMat);
  roof.position.set(-0.1, 1.48, 0); roof.castShadow = true; car.add(roof);
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, o.width), chromeMat);
  bumperF.position.set(o.length / 2, 0.45, 0); car.add(bumperF);
  const bumperR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, o.width), chromeMat);
  bumperR.position.set(-o.length / 2, 0.45, 0); car.add(bumperR);
  // Front grille — five vertical chrome slats sunk into the body face.
  for (let k = 0; k < 5; k++) {
    const u = (k - 2) / 2;  // -1 .. 1
    const slat = new THREE.Mesh(_CG.grilleSlat, chromeMat);
    slat.position.set(o.length / 2 - 0.02, 0.62, u * (o.width * 0.32));
    car.add(slat);
  }
  // Rear license plate.
  const plate = new THREE.Mesh(_CG.plate, chromeMat);
  plate.position.set(-o.length / 2 - 0.025, 0.55, 0); car.add(plate);
  // Roof antenna — slim cylinder at the rear of the cabin.
  const antenna = new THREE.Mesh(_CG.antenna, chromeMat);
  antenna.position.set(-cabL * 0.45 - 0.1, 1.48 + 0.22, o.width * 0.30);
  car.add(antenna);
  // Wheels — tire + chrome hub + tapered spokes + wheel-well torus.
  for (const [wx, wz] of [[o.length * 0.35, o.width * 0.45], [o.length * 0.35, -o.width * 0.45], [-o.length * 0.35, o.width * 0.45], [-o.length * 0.35, -o.width * 0.45]]) {
    const w = new THREE.Mesh(_CG.wheel, tireMat);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx, 0.35, wz); w.castShadow = true; car.add(w);
    const hub = new THREE.Mesh(_CG.hub, chromeMat);
    hub.rotation.x = Math.PI / 2; hub.position.set(wx, 0.35, wz);
    car.add(hub);
    // Wheel well — torus framing the tire from above for arch detail.
    const well = new THREE.Mesh(_CG.wheelWell, trimMat);
    well.rotation.y = 0;
    well.position.set(wx, 0.40, wz);
    car.add(well);
    // Five lug-nut spheres + five rim spokes on the outboard hub face.
    const sideZ = wz > 0 ? 0.17 : -0.17;
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * Math.PI * 2;
      const lug = new THREE.Mesh(_CG.lug, chromeMat);
      lug.position.set(wx + Math.cos(a) * 0.07, 0.35 + Math.sin(a) * 0.07, wz + sideZ);
      car.add(lug);
      const spoke = new THREE.Mesh(_CG.spoke, chromeMat);
      spoke.rotation.z = a;
      spoke.position.set(wx, 0.35, wz + sideZ * 0.6);
      car.add(spoke);
    }
  }
  // Headlights (forward-facing emissive disks) — slight bezel ring for detail.
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff0c0, emissive: 0xffe8a0, emissiveIntensity: o.idling ? 2.5 : 0.4 });
  for (const wz of [-0.55, 0.55]) {
    const hl = new THREE.Mesh(_CG.headlight, headlightMat);
    hl.rotation.z = Math.PI / 2; hl.position.set(o.length / 2 + 0.02, 0.55, wz); car.add(hl);
    const bezel = new THREE.Mesh(_CG.headBezel, chromeMat);
    bezel.position.set(o.length / 2 + 0.06, 0.55, wz); bezel.rotation.y = Math.PI / 2; car.add(bezel);
  }
  // Taillights — small red disks on the rear corners.
  for (const wz of [-0.55, 0.55]) {
    const tl = new THREE.Mesh(_CG.taillight, redMat);
    tl.rotation.z = Math.PI / 2; tl.position.set(-o.length / 2 - 0.01, 0.62, wz); car.add(tl);
  }
  // Door-handle nub on each side (cheap silhouette breakup).
  for (const sz of [-1, 1]) {
    const dh = new THREE.Mesh(_CG.doorHandle, chromeMat);
    dh.position.set(0.15, 0.95, sz * (o.width / 2 + 0.01));
    car.add(dh);
    // Side mirror — small body-coloured housing on a short chrome arm.
    const arm = new THREE.Mesh(_CG.mirrorArm, chromeMat);
    arm.position.set(cabL * 0.45 - 0.1, 1.20, sz * (o.width / 2 + 0.04));
    car.add(arm);
    const mir = new THREE.Mesh(_CG.mirror, bodyMat);
    mir.position.set(cabL * 0.45 - 0.1, 1.21, sz * (o.width / 2 + 0.10));
    car.add(mir);
  }

  consolidateCar(car);
  World.add(car);
  const cosine = Math.abs(Math.cos(rotY)), sine = Math.abs(Math.sin(rotY));
  Colliders.addBoxBySize(x, y + 0.45, z, cosine * (o.length + 0.2) + sine * (o.width + 0.2), 0.9, sine * (o.length + 0.2) + cosine * (o.width + 0.2));
  Colliders.addBoxBySize(x - 0.1 * Math.cos(rotY), y + 1.15, z + 0.1 * Math.sin(rotY), cosine * o.length * 0.55 + sine * o.width, 0.72, sine * o.length * 0.55 + cosine * o.width);
  return car;
}

/** Keep the articulated vehicle transform while batching static parts by material. */
function consolidateCar(car) {
  const buckets = new Map(), originals = new Set();
  const sharedGeometry = new Set(Object.values(_CG));
  for (const part of car.children) {
    if (!part.isMesh) continue;
    part.updateMatrix();
    const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    geometry.applyMatrix4(part.matrix);
    const bucket = buckets.get(part.material) || [];
    bucket.push(geometry);
    buckets.set(part.material, bucket);
    if (!sharedGeometry.has(part.geometry)) originals.add(part.geometry);
  }
  car.clear();
  for (const [material, geometries] of buckets) {
    const geometry = mergeGeometries(geometries, false);
    if (!geometry) throw new Error('Vehicle geometry attributes must agree before batching.');
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    car.add(mesh);
    for (const temporary of geometries) temporary.dispose();
  }
  for (const geometry of originals) geometry.dispose();
}


/** Retail, preparation and refuge areas fit inside one closed, supported building. */
function buildBakeryAndCar() {
  const b = DISTRICT.bakery;
  const cx = (b.x1 + b.x2) / 2, cz = (b.z1 + b.z2) / 2;
  const width = b.x2 - b.x1, depth = b.z2 - b.z1, height = b.ceilingY - b.floorY;
  const wallY = (b.floorY + b.ceilingY) / 2;
  pavement('bakery-floor', b, MATS.wood);
  addBox(cx, b.ceilingY + 0.08, cz, width, 0.16, depth, MATS.plaster, {
    architecture: { id: 'bakery-ceiling', kind: 'ceiling', supports: ['bakery-west', 'bakery-east', 'bakery-back', 'bakery-header'] },
  });
  for (const [id, x] of [['bakery-west', b.x1], ['bakery-east', b.x2]]) {
    addBox(x, wallY, cz, b.wallThickness, height, depth, MATS.brick, {
      architecture: { id, kind: 'wall', supports: ['bakery-floor'] },
    });
  }
  addBox(cx, wallY, b.z2, width, height, b.wallThickness, MATS.brick, {
    architecture: { id: 'bakery-back', kind: 'wall', supports: ['bakery-floor'] },
  });
  // Thin interior finishes sit against structural walls, not in the walkable aisle.
  boxDetail(MATS.plaster, b.x1 + 0.118, 2.12, cz, 0.018, 3.94, depth - 0.25);
  boxDetail(MATS.plaster, b.x2 - 0.118, 2.12, cz, 0.018, 3.94, depth - 0.25);
  boxDetail(MATS.plaster, cx, 2.12, b.z2 - BAKERY_WALL_FINISH.offset, width - 0.25, 3.94, BAKERY_WALL_FINISH.thickness);
  for (const x of [b.x1 + 0.137, b.x2 - 0.137]) {
    boxDetail(MATS.wood, x, 0.57, cz, 0.02, 0.97, depth - 0.25);
    boxDetail(MATS.wood, x, 1.1, cz, 0.045, 0.07, depth - 0.25);
  }

  addBox((b.x1 - 33) / 2, wallY, b.z1, -33 - b.x1, height, b.wallThickness, MATS.brick, {
    architecture: { id: 'bakery-front-west', kind: 'wall', supports: ['bakery-floor'] },
  });
  addBox((b.door.x2 + b.x2) / 2, wallY, b.z1, b.x2 - b.door.x2, height, b.wallThickness, MATS.brick, {
    architecture: { id: 'bakery-front-east', kind: 'wall', supports: ['bakery-floor'] },
  });
  addBox((-33 + b.door.x2) / 2, (b.door.topY + b.ceilingY) / 2, b.z1, b.door.x2 + 33, b.ceilingY - b.door.topY, b.wallThickness, MATS.brick, {
    architecture: { id: 'bakery-header', kind: 'lintel', supportKind: 'anchored', supports: ['bakery-front-west', 'bakery-front-east'] },
  });
  const sillY = 0.85;
  addBox((-33 + b.door.x1) / 2, (b.floorY + sillY) / 2, b.z1, b.door.x1 + 33, sillY - b.floorY, b.wallThickness, MATS.brick, {
    architecture: { id: 'bakery-window-sill', kind: 'wall', supports: ['bakery-floor'] },
  });
  const windowEdges = [-33, -29, -24.6, b.door.x1];
  for (let i = 0; i < windowEdges.length - 1; i++) {
    const left = windowEdges[i], right = windowEdges[i + 1], wx = (left + right) / 2;
    addBox(wx, (sillY + b.door.topY) / 2, b.z1 - 0.015, right - left - 0.07, b.door.topY - sillY, 0.035, MATS.glass, {
      architecture: { id: 'bakery-display-window-' + i, kind: 'glazing', supportKind: 'anchored', supports: ['bakery-window-sill', 'bakery-header'] },
    });
    // The last window's rails and sill butt against the door casing instead of
    // passing through it and sharing the opening's exposed side plane.
    const trimRight = i === windowEdges.length - 2 ? right - BAKERY_DOOR_CASING.width : right;
    const trimCenter = (left + trimRight) / 2;
    // The lower rail bears on the stone cap instead of being buried inside it.
    for (const y of [sillY + 0.03 + 0.055 / 2, b.door.topY]) boxDetail(MATS.metal, trimCenter, y, b.z1 - 0.045, trimRight - left, 0.055, 0.075);
    boxDetail(MATS.concrete, trimCenter, sillY - 0.03, b.z1 - 0.105, trimRight - left, 0.12, 0.24);
    if (i) boxDetail(MATS.metal, left, (sillY + b.door.topY) / 2, b.z1 - 0.048, 0.075, b.door.topY - sillY, 0.08);
  }
  buildBakeryDoorFrame(b);
  boxDetail(MATS.tar, -18.75, b.floorY + 0.004, b.z1 + 0.75, 2.55, 0.008, 1.15);

  // Two occupied upper storeys give the shop an actual city-building volume.
  const upperBottom = b.ceilingY + 0.16;
  addBox(cx, (upperBottom + b.roofY - 0.2) / 2, cz, width, b.roofY - 0.2 - upperBottom, depth, MATS.brick, {
    architecture: { id: 'bakery-upper-volume', kind: 'building', supports: ['bakery-ceiling'] },
  });
  addBox(cx, b.roofY - 0.1, cz, width + 0.18, 0.2, depth + 0.18, MATS.concrete, {
    architecture: { id: 'bakery-roof', kind: 'roof', supports: ['bakery-upper-volume'] },
  });
  for (const y of [6.4, 9.15]) for (const x of [-31.8, -28.4, -25, -21.6, -18.2]) addFacadeWindow(x, y, b.z1, 1.35, 1.75);
  boxDetail(MATS.concrete, cx, 8.03, b.z1 - 0.1, width + 0.12, 0.16, 0.29);
  boxDetail(MATS.concrete, cx, b.roofY + 0.20, b.z1, width + 0.2, 0.4, 0.26);
  addBox(cx, 4.66, b.z1, width, 1.12, 0.26, MATS.brick, {
    architecture: { id: 'bakery-fascia', kind: 'wall', supports: ['bakery-header', 'bakery-west', 'bakery-east'] },
  });
  buildBakeryFasciaCorners(b);
  boxDetail(MATS.concrete, cx, 5.24, b.z1, width + 0.15, 0.08, 0.34);
  const shopSign = addSign(cx, 4.66, b.z1 - 0.146, 11.5, 0.82, '-z', "AURELIO'S BAKERY", {
    bg: '#302b20', fg: '#e2d0a6', font: 'bold 91px serif', sub: 'FAMILY OWNED · EST. 1948', subFont: '27px serif',
  });
  shopSign.name = 'bakery-shop-sign';
  shopSign.userData.mountId = 'bakery-fascia';
  buildBakeryAwning(b);
  for (const x of [b.x1 + 0.3, b.x2 - 0.3]) {
    pushDecor(_BG.pipe, MATS.metal, x, 2.55, b.z1 - 0.18, 0.065, 4.8, 0.065);
    for (const y of [0.7, 2.6, 4.7]) boxDetail(MATS.metal, x, y, b.z1 - 0.15, 0.22, 0.075, 0.18);
  }

  const partition = b.partition;
  for (const [id, left, right] of [['west', b.x1, partition.doorX1], ['east', partition.doorX2, b.x2]]) {
    addBox((left + right) / 2, wallY, partition.z, right - left, height, 0.18, MATS.plaster, {
      architecture: { id: 'bakery-partition-' + id, kind: 'wall', supports: ['bakery-floor'] },
    });
    boxDetail(MATS.wood, (left + right) / 2, 0.16, partition.z - 0.105, right - left, 0.16, 0.045);
  }
  addBox((partition.doorX1 + partition.doorX2) / 2, (partition.topY + b.ceilingY) / 2, partition.z, partition.doorX2 - partition.doorX1, b.ceilingY - partition.topY, 0.18, MATS.plaster, {
    architecture: { id: 'bakery-partition-lintel', kind: 'lintel', supportKind: 'anchored', supports: ['bakery-partition-west', 'bakery-partition-east'] },
  });
  const prepSign = addSign(-20, 3.68, partition.z - 0.105, 1.8, 0.30, '-z', 'PREPARATION', { bg: '#30372e', fg: '#c9cbb8', font: 'bold 80px sans-serif' });
  prepSign.userData.mountId = 'bakery-partition-lintel';
  addBox(partition.doorX1 + 0.16, b.floorY + 1.5, partition.z + 0.74, 0.12, 3, 1.3, MATS.wood, {
    architecture: { id: 'bakery-prep-door', kind: 'door', supports: ['bakery-floor'] },
  });
  for (const x of [partition.doorX1 - 0.03, partition.doorX2 + 0.03]) boxDetail(MATS.wood, x, b.floorY + 1.62, partition.z, 0.11, 3.24, 0.27);
  boxDetail(MATS.concrete, cx, b.floorY + 0.002, (partition.z + b.z2) / 2, width - 0.23, 0.004, b.z2 - partition.z - 0.12);
  for (let x = b.x1 + 0.7; x < b.x2; x += 1.2) boxDetail(MATS.tar, x, b.floorY + 0.005, 39.25, 0.008, 0.002, 7.1);

  buildBakeryCounter(b);
  buildBakeryPreparation(b);
  buildBakeryLighting(b);

  Triggers.add('bakery', new THREE.Vector3(b.x1 + 0.24, 0, b.z1 + 0.22), new THREE.Vector3(b.x2 - 0.24, 3.5, b.z2 - 0.24));
  buildGnucciCar();
}

function buildBakeryDoorFrame(b) {
  const { width, depth } = BAKERY_DOOR_CASING;
  const wallFront = b.z1 - b.wallThickness / 2;
  const frameZ = wallFront - depth / 2;
  // Applied casing sits on the front of the masonry. Its side faces stop at
  // the facade instead of duplicating the brick reveals inside the opening.
  for (const x of [b.door.x1 - width / 2, b.door.x2 + width / 2]) {
    boxDetail(MATS.metal, x, (b.floorY + b.door.topY) / 2, frameZ, width, b.door.topY - b.floorY, depth);
  }
  // The head casing joins the uprights above the clear 3.3 m doorway.
  boxDetail(MATS.metal, (b.door.x1 + b.door.x2) / 2, b.door.topY + width / 2, frameZ, b.door.x2 - b.door.x1 + width * 2, width, depth);
}

function buildBakeryFasciaCorners(b) {
  // Stone corner returns enclose the slab/fascia seam. The structural boxes
  // keep their original bounds and colliders; one proud finish owns each end.
  for (const x of [b.x1, b.x2]) boxDetail(MATS.concrete, x, b.ceilingY + 0.08, b.z1, 0.06, 0.24, 0.34);
}

function buildBakeryAwning(b) {
  const awning = new THREE.Mesh(new THREE.BoxGeometry(16, 0.10, 1.55),
    new THREE.MeshStandardMaterial({ color: 0x563831, roughness: 0.96 }));
  awning.name = 'bakery-street-awning';
  awning.userData.mountId = 'bakery-fascia';
  awning.position.set(-25, 4.04, b.z1 - 0.8);
  awning.rotation.x = -0.16;
  awning.castShadow = true;
  World.add(awning);
  boxDetail(MATS.wood, -25, 3.86, b.z1 - 1.56, 16.05, 0.15, 0.06);
  for (const x of [-32.4, -28, -22.5, -17.6]) {
    boxDetail(MATS.metal, x, 3.76, b.z1 - 0.13, 0.06, 0.63, 0.075);
    const start = new THREE.Vector3(x, 3.46, b.z1 - 0.14);
    const end = new THREE.Vector3(x, 3.89, b.z1 - 1.53);
    const vector = end.clone().sub(start);
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.047, vector.length(), 0.047), MATS.metal);
    brace.name = 'bakery-awning-diagonal';
    brace.position.copy(start).add(end).multiplyScalar(0.5);
    brace.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vector.normalize());
    World.add(brace);
  }
}

function buildBakeryCounter(b) {
  const c = b.counter, bodyTop = b.floorY + c.height, top = bodyTop + 0.09;
  addBox(c.x, b.floorY + c.height / 2, c.z, c.width, c.height, c.depth, MATS.wood, {
    architecture: { id: 'bakery-counter-base', kind: 'furniture', supports: ['bakery-floor'] },
  });
  addBox(c.x, bodyTop + 0.045, c.z, c.width + 0.12, 0.09, c.depth + 0.12, MATS.concrete, {
    collide: false, architecture: { id: 'bakery-counter-top', kind: 'furniture', supports: ['bakery-counter-base'] },
  });
  const bread = new THREE.SphereGeometry(1, 10, 6);
  for (let i = 0; i < 12; i++) {
    const x = c.x - c.width / 2 + 0.46 + i * 0.61;
    pushDecor(bread, MATS.wood, x, top + 0.085, c.z - 0.15 + i % 2 * 0.30, 0.24, 0.085, 0.13, i * 0.2);
  }
  bread.dispose();
  for (const x of [c.x - 2.8, c.x - 0.7, c.x + 1.4]) {
    addBox(x, top + 0.13, c.z - c.depth / 2 - 0.015, 1.95, 0.26, 0.028, MATS.glass);
    boxDetail(MATS.glass, x, top + 0.28, c.z - 0.17, 1.95, 0.035, 1.05);
    for (const dx of [-0.975, 0.975]) boxDetail(MATS.metal, x + dx, top + 0.14, c.z - 0.68, 0.025, 0.28, 0.035);
  }
  for (const x of [c.x - 3.3, c.x - 1.1, c.x + 1.1, c.x + 3.3]) {
    boxDetail(MATS.wood, x, 0.67, c.z - c.depth / 2 - 0.018, 1.95, 0.79, 0.035);
    boxDetail(MATS.metal, x, 0.71, c.z - c.depth / 2 - 0.042, 0.24, 0.025, 0.02);
  }
  boxDetail(MATS.metal, -24.45, top + 0.26, c.z + 0.12, 0.5, 0.52, 0.42);
  boxDetail(MATS.tar, -24.45, top + 0.39, c.z - 0.1, 0.37, 0.16, 0.025);
  boxDetail(MATS.plaster, -25.1, top + 0.008, c.z + 0.1, 0.31, 0.01, 0.23, -0.15);
  bakeryShelf('bakery-retail-shelf', -30.4, 35.03, 4.3, 0.62, 2.65, b.floorY);
  const menu = addSign(-25.7, 2.38, b.partition.z - 0.107, 2.65, 1.15, '-z', 'DAILY BREAD', {
    bg: '#263029', fg: '#c4c6b0', font: 'bold 80px serif', sub: 'BAKED HERE. EVERY MORNING.', subFont: '25px serif',
  });
  menu.userData.mountId = 'bakery-partition-west';
}

function bakeryShelf(id, x, z, width, depth, height, floor) {
  addBox(x, floor + height / 2, z, width, height, depth, MATS.wood, {
    architecture: { id, kind: 'furniture', supports: ['bakery-floor'] },
  });
  boxDetail(MATS.tar, x, floor + height / 2, z - depth / 2 - 0.005, width - 0.15, height - 0.15, 0.012);
  for (let y = floor + 0.17; y < floor + height; y += 0.58) {
    boxDetail(MATS.wood, x, y, z - depth / 2 - 0.035, width - 0.05, 0.065, 0.16);
    if (y + 0.35 < floor + height) for (let dx = -width / 2 + 0.3; dx < width / 2 - 0.1; dx += 0.62) {
      boxDetail(MATS.wood, x + dx, y + 0.15, z - depth / 2 - 0.065, 0.39, 0.23, 0.18);
      boxDetail(MATS.plaster, x + dx, y + 0.16, z - depth / 2 - 0.161, 0.14, 0.11, 0.012);
    }
  }
  for (const dx of [-width / 2 + 0.05, width / 2 - 0.05]) boxDetail(MATS.wood, x + dx, floor + height / 2, z - depth / 2 - 0.055, 0.10, height, 0.12);
}

function buildBakeryPreparation(b) {
  const table = b.prepTable, oven = b.oven;
  addBox(table.x, b.floorY + table.height / 2, table.z, table.width, table.height, table.depth, MATS.wood, {
    architecture: { id: 'bakery-prep-island-base', kind: 'cover', supports: ['bakery-floor'] },
  });
  addBox(table.x, b.floorY + table.height + 0.035, table.z, table.width + 0.08, 0.07, table.depth + 0.10, MATS.metal, {
    collide: false, architecture: { id: 'bakery-prep-island-top', kind: 'furniture', supports: ['bakery-prep-island-base'] },
  });
  for (const x of [-29.25, -27.75, -26.25]) {
    boxDetail(MATS.plaster, x, 1.279, table.z, 0.78, 0.015, 0.53);
    for (const dx of [-0.22, 0.1]) boxDetail(MATS.wood, x + dx, 1.34, table.z, 0.30, 0.10, 0.20);
    boxDetail(MATS.metal, x, 0.62, table.z - table.depth / 2 - 0.022, 1.29, 0.93, 0.035);
  }

  addBox(oven.x, b.floorY + oven.height / 2, oven.z, oven.width, oven.height, oven.depth, MATS.metal, {
    architecture: { id: 'bakery-deck-ovens', kind: 'furniture', supports: ['bakery-floor'] },
  });
  const ovenFace = new THREE.MeshStandardMaterial({ color: 0x231c14, emissive: 0xb24f21, emissiveIntensity: 0.35, roughness: 0.65 });
  for (const z of [oven.z - 0.85, oven.z + 0.85]) {
    for (const y of [0.58, 1.18, 1.78]) {
      boxDetail(MATS.tar, oven.x + oven.width / 2 + 0.009, y, z, 0.015, 0.38, 1.36);
      boxDetail(ovenFace, oven.x + oven.width / 2 + 0.022, y + 0.03, z, 0.02, 0.20, 1.10);
      boxDetail(MATS.metal, oven.x + oven.width / 2 + 0.075, y - 0.05, z, 0.10, 0.055, 1.13);
    }
  }
  boxDetail(MATS.metal, oven.x, 2.42, oven.z, oven.width + 0.18, 0.27, oven.depth + 0.17);
  pushDecor(_BG.pipe, MATS.metal, oven.x, 3.14, oven.z, 0.14, 1.17, 0.14);
  boxDetail(MATS.metal, -25.5, 3.82, oven.z, 15, 0.24, 0.43);
  for (const x of [-31.4, -26.4, -21.4]) {
    boxDetail(MATS.metal, x, 3.99, oven.z, 0.05, 0.23, 0.52);
    boxDetail(MATS.metal, x, 4.065, oven.z, 0.22, 0.06, 0.65);
  }
  bakeryShelf('bakery-prep-shelf-west', -29, 42.59, 3.6, 0.6, 2.9, b.floorY);
  bakeryShelf('bakery-prep-shelf-center', -24.5, 42.59, 2.3, 0.6, 2.9, b.floorY);
  addBox(-20.2, 0.61, 40.5, 1.2, 1.06, 0.85, MATS.wood, {
    architecture: { id: 'bakery-refuge-cover', kind: 'cover', supports: ['bakery-floor'] },
  });
  for (const x of [-25.1, -24.5]) {
    boxDetail(MATS.plaster, x, 0.3, 40.55, 0.48, 0.44, 0.61);
    boxDetail(MATS.wood, x, 0.46, 40.23, 0.25, 0.06, 0.02);
  }

  // The family has a defined refuge beyond the preparation room, behind cover.
  boxDetail(MATS.wood, -19.2, 0.56, 42.4, 4.2, 0.13, 0.57);
  for (const x of [-20.9, -17.5]) boxDetail(MATS.wood, x, 0.29, 42.4, 0.08, 0.42, 0.45);
  const keeper = makeHumanoid(HUMANOID_PRESETS.shopkeeper);
  keeper.name = 'bakery-shopkeeper';
  keeper.position.set(-18.0, b.floorY, 41.35);
  keeper.rotation.y = Math.PI;
  World.add(keeper);
  const neighbor = makeHumanoid(HUMANOID_PRESETS.woman);
  neighbor.name = 'bakery-neighbor';
  neighbor.position.set(-19.05, b.floorY, 41.82);
  neighbor.rotation.y = Math.PI - 0.28;
  World.add(neighbor);
  // A wooden plaque covers the plaster. Short anchors reach through the finish
  // into the masonry; the printed face sits 2 mm in front of its backing.
  const finishFront = b.z2 - BAKERY_WALL_FINISH.offset - BAKERY_WALL_FINISH.thickness / 2;
  const backingDepth = 0.024, backingRear = finishFront + 0.002;
  const backingFront = backingRear - backingDepth;
  const anchorFront = backingRear - 0.008, anchorRear = b.z2 - b.wallThickness / 2 + 0.03;
  const anchorIds = ['bakery-family-plaque-anchor-left', 'bakery-family-plaque-anchor-right'];
  for (let i = 0; i < anchorIds.length; i++) {
    addBox(-18.8 + (i ? 1.1 : -1.1), 2.63, (anchorFront + anchorRear) / 2, 0.06, 0.06, anchorRear - anchorFront, MATS.metal, {
      collide: false, architecture: { id: anchorIds[i], kind: 'mount', supportKind: 'anchored', supports: ['bakery-back'] },
    });
  }
  addBox(-18.8, 2.63, (backingFront + backingRear) / 2, 2.64, 0.74, backingDepth, MATS.wood, {
    collide: false, architecture: { id: 'bakery-family-plaque', kind: 'sign', supportKind: 'anchored', supports: anchorIds },
  });
  const notice = addSign(-18.8, 2.63, backingFront - 0.002, 2.5, 0.6, '-z', 'FAMILY COMES FIRST', {
    bg: '#524738', fg: '#c6c2a5', font: 'bold 75px serif', sub: 'AURELIO & SONS', subFont: '25px serif',
  });
  notice.name = 'bakery-family-notice';
  notice.userData.mountId = 'bakery-family-plaque';
}

function buildBakeryLighting(b) {
  const lamp = new THREE.MeshStandardMaterial({ color: 0xe1d8ba, emissive: 0xffd8a1, emissiveIntensity: 1.2, roughness: 0.75 });
  for (const [x, z] of [[-28.3, 30.2], [-20.1, 31.1], [-28.3, 37.3], [-20, 38.7]]) {
    boxDetail(MATS.metal, x, 3.97, z, 0.045, b.ceilingY - 3.85, 0.045);
    boxDetail(MATS.metal, x, 3.77, z, 1.3, 0.14, 0.3);
    boxDetail(lamp, x, 3.69, z, 1.15, 0.025, 0.22);
  }
  for (const [x, y, z, intensity, distance, color] of [
    [-27.4, 3.5, 31.8, 2.15, 16, 0xffcd92],
    [-22.9, 3.55, 39.3, 2.05, 15, 0xffd7ac],
    [-31.95, 1.24, 39.8, 0.6, 5, 0xe28e50],
  ]) {
    const light = new THREE.PointLight(color, intensity, distance, 1.6);
    light.position.set(x, y, z);
    World.add(light);
    WorldState.bakeryLights.push(light);
  }
}

function buildGnucciCar() {
  const target = DISTRICT.car;
  const car = spawnParkedCar(target.x, target.y, target.z, target.yaw, 0x111716, { idling: true, length: target.length, width: target.width });
  car.name = 'gnucci-sedan';
  WorldState.car = car;
  const exhaust = makeSmokeSystem(16);
  const tailpipe = new THREE.Vector3(-target.length / 2 - 0.05, 0.34, 0.54).applyAxisAngle(new THREE.Vector3(0, 1, 0), target.yaw);
  exhaust.points.position.copy(tailpipe).add(car.position);
  exhaust.points.material.opacity = 0.26;
  exhaust.points.material.size = 0.45;
  World.add(exhaust.points);
  WorldState.smokeSystems.push(exhaust);
  const idleGlow = new THREE.PointLight(0xe4874c, 0.3, 4, 2);
  idleGlow.position.set(target.x, target.y + 0.2, target.z);
  World.add(idleGlow);

  // A wheel stop and a mounted sign make the reserved bay legible.
  addBox(target.x, target.y + 0.095, target.z + 1.6, target.length + 0.5, 0.19, 0.28, MATS.concrete);
  const p = target.placard;
  addBox(p.x, p.y + 1.13, p.z, 0.10, 2.26, 0.10, MATS.metal, {
    architecture: { id: 'car-placard-post', kind: 'post', supports: ['far-sidewalk'] },
  });
  // Bolt a 30 mm board onto the street side of the post. The post must not
  // protrude through the board or share the printed label's visible plane.
  const placardDepth = 0.03, placardRear = p.z - 0.046;
  const placardFront = placardRear - placardDepth;
  addBox(p.x, 2.03, (placardFront + placardRear) / 2, 2.08, 0.56, placardDepth, MATS.metal, {
    collide: false, architecture: { id: 'car-placard-backing', kind: 'sign', supportKind: 'anchored', supports: ['car-placard-post'] },
  });
  const sign = addSign(p.x, 2.03, placardFront - 0.002, 2.0, 0.48, '-z', "GNUCCI'S", {
    bg: '#252923', fg: '#c7b298', font: 'bold 88px serif', sub: 'PRIVATE PARKING', subFont: '26px serif',
  });
  sign.name = 'car-parking-sign';
  sign.userData.mountId = 'car-placard-backing';
}

export { buildStreet, buildBakeryAndCar };
