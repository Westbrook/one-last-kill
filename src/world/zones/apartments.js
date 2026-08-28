import * as THREE from 'three';

import { MATS } from '../../render/materials.js';
import { _BG, pushDecor } from '../../render/models.js';

import { Colliders } from '../../core/collision.js';
import { Ballistics } from '../../core/ballistics.js';
import { World, Triggers, addBox, addDecor, addWallZ, makeSignTexture, spawnFire, setFireActive, addFlickerLight } from '../world.js';
import { BUILDING, BALCONY, APARTMENT_DOORS } from '../layout.js';
import { createInteriorProps } from '../interior-props.js';
import { createDoorAssemblies } from '../door-assemblies.js';

const interiorProps = createInteriorProps({
  addBox, pushDecor, boxGeometry: _BG.unitBox, pipeGeometry: _BG.pipe, materials: MATS,
});
const doors = createDoorAssemblies({ addBox, pushDecor, boxGeometry: _BG.unitBox, materials: MATS });

// Interior walls stop at the existing ceiling. Their openings have no sill:
// only the authored broken party wall requires a jump in the opening rooms.
function partitionZ({ id, x, zStart, zEnd, doorStart, doorEnd, floorY, ceilingY, floorId, clearHeight = 2.35 }) {
  const height = ceilingY - floorY, thickness = 0.16;
  const jambs = [[zStart, doorStart, 'north'], [doorEnd, zEnd, 'south']];
  for (const [start, end, side] of jambs) {
    addBox(x, floorY + height / 2, (start + end) / 2, thickness, height, end - start, MATS.plaster, {
      architecture: { id: `${id}-${side}`, kind: 'partition', supports: [floorId] },
    });
    for (const face of [-1, 1]) {
      pushDecor(_BG.unitBox, MATS.wood, x + face * 0.09, floorY + 0.065, (start + end) / 2,
        0.025, 0.13, end - start);
    }
  }
  addBox(x, floorY + clearHeight + (height - clearHeight) / 2, (doorStart + doorEnd) / 2,
    thickness, height - clearHeight, doorEnd - doorStart, MATS.plaster, {
      architecture: { id: `${id}-header`, kind: 'lintel', supportKind: 'anchored', supports: jambs.map(([, , side]) => `${id}-${side}`) },
    });
  for (const z of [doorStart, doorEnd]) {
    pushDecor(_BG.unitBox, MATS.wood, x, floorY + clearHeight / 2, z, 0.20, clearHeight, 0.05);
  }
  pushDecor(_BG.unitBox, MATS.wood, x, floorY + clearHeight - 0.025, (doorStart + doorEnd) / 2,
    0.20, 0.05, doorEnd - doorStart);
}

function upholsteredSeat({ id, x, z, floorY, floorId, width, depth }) {
  const baseHeight = 0.5;
  addBox(x, floorY + baseHeight / 2, z, width, baseHeight, depth, MATS.wallpaper, {
    architecture: { id, kind: 'furniture', supports: [floorId] },
  });
  addBox(x, floorY + 0.8, z - depth / 2 + 0.09, width, 0.6, 0.18, MATS.wallpaper, {
    architecture: { id: `${id}-back`, kind: 'furniture', supports: [id] },
  });
  for (const [i, side] of [-1, 1].entries()) {
    addBox(x + side * (width / 2 - 0.065), floorY + 0.64, z, 0.13, 0.28, depth, MATS.wallpaper, {
      architecture: { id: `${id}-arm-${i}`, kind: 'furniture', supports: [id] },
    });
  }
  const cushions = width > 1.2 ? 2 : 1;
  const cushionWidth = (width - 0.30) / cushions;
  for (let i = 0; i < cushions; i++) {
    pushDecor(_BG.unitBox, MATS.wallpaper, x + (i - (cushions - 1) / 2) * cushionWidth,
      floorY + 0.545, z + 0.07, cushionWidth - 0.025, 0.09, depth - 0.23);
  }
}

// ─── ZONE 1: PLAYER'S APARTMENT ────────────────────────────────────────────
// Footprint x∈[-15,-3], z∈[-10,0], floor y=4, ceiling y=7.4.
// East wall (x=-3) has a broken-wall opening to the neighbor's unit.
// South wall (z=0) has the entry door blocked from inside by a wall of fire.
function buildPlayerApartment() {
  const FX1 = BUILDING.main.x1, FX2 = -3, FZ1 = BUILDING.main.z1, FZ2 = BUILDING.main.z2;
  const FY = BUILDING.apartmentY, CY = BUILDING.canopyY, WALL_T = BUILDING.wallThickness;
  const H = CY - FY;
  const cx = (FX1 + FX2) / 2, cz = (FZ1 + FZ2) / 2, w = FX2 - FX1, d = FZ2 - FZ1;

  addBox(cx, FY - 0.1, cz, w, 0.2, d, MATS.wood, {
    cast: false, architecture: { id: 'apartment-floor', kind: 'floor', supports: ['main-ground-north', 'main-ground-south'] },
  });
  addBox(cx, CY + 0.1, cz, w, 0.2, d, MATS.plaster, {
    cast: false, architecture: { id: 'apartment-ceiling', kind: 'slab', supports: ['apartment-north', 'apartment-south', 'apartment-west'] },
  });

  // West wall (solid).
  addBox(FX1, FY + H / 2, cz, WALL_T, H, d, MATS.plaster, {
    architecture: { id: 'apartment-west', kind: 'wall', supports: ['apartment-floor'] },
  });
  // North wall (solid).
  addBox(cx, FY + H / 2, FZ1, w, H, WALL_T, MATS.plaster, {
    architecture: { id: 'apartment-north', kind: 'wall', supports: ['apartment-floor'] },
  });
  // One real closed leaf replaces the old panel pasted on an uncut wall.
  // The gallery sees the other face of this exact door, not a second copy.
  const entry = APARTMENT_DOORS.playerEntry;
  const entryLeft = entry.x - entry.width / 2 - entry.frameWidth;
  const entryRight = entry.x + entry.width / 2 + entry.frameWidth;
  const entryHead = FY + entry.height + entry.frameWidth;
  addBox((FX1 + entryLeft) / 2, FY + H / 2, FZ2, entryLeft - FX1, H, WALL_T, MATS.plaster, {
    architecture: { id: 'apartment-south', kind: 'wall', supports: ['apartment-floor'] },
  });
  addBox((entryRight + FX2) / 2, FY + H / 2, FZ2, FX2 - entryRight, H, WALL_T, MATS.plaster, {
    architecture: { id: 'apartment-south-east', kind: 'wall', supports: ['apartment-floor'] },
  });
  addBox(entry.x, (entryHead + CY) / 2, FZ2, entryRight - entryLeft, CY - entryHead, WALL_T, MATS.plaster, {
    architecture: { id: 'apartment-entry-wall-header', kind: 'wall', supports: [`${entry.id}-header`] },
  });
  doors.closedDoor(entry, { floorId: 'apartment-floor' });
  // East wall (shared with neighbor) with a broken-wall opening.
  addWallZ(FX2, FY, cz, d, H, WALL_T, MATS.plaster, { zStart: -7.5, zEnd: -4.5, headerH: 0.6, sillH: 0.5 });

  // Dark wood baseboard trim along the three solid walls — single thin strip
  // each (decor, shared unit box) reads as a 50s-era apartment skirting board
  // without adding meaningful drawcall pressure to the FPS-tightest zone.
  pushDecor(_BG.unitBox, MATS.wood, cx, FY + 0.07, FZ1 + 0.12, w - 0.2, 0.14, 0.04);
  for (const [start, end] of [[FX1 + 0.1, entryLeft], [entryRight, FX2 - 0.1]]) {
    pushDecor(_BG.unitBox, MATS.wood, (start + end) / 2, FY + 0.07, FZ2 - 0.12, end - start, 0.14, 0.04);
  }
  pushDecor(_BG.unitBox, MATS.wood, FX1 + 0.12, FY + 0.07, cz, 0.04, 0.14, d - 0.2);

  // The entrance hall and sleeping alcove make this a home with distinct
  // rooms. A broad cross-hall at z=-6 keeps the breach and melee route clear.
  partitionZ({ id: 'apartment-hall', x: -7.2, zStart: -9.9, zEnd: -2.3,
    doorStart: -7.35, doorEnd: -4.55, floorY: FY, ceilingY: CY, floorId: 'apartment-floor', clearHeight: 2.6 });
  addBox(-11.65, FY + H / 2, -8.35, 0.16, H, 3.1, MATS.plaster, {
    architecture: { id: 'apartment-bedroom-east', kind: 'partition', supports: ['apartment-floor'] },
  });
  addBox(-13.95, FY + H / 2, -6.8, 1.9, H, 0.16, MATS.plaster, {
    architecture: { id: 'apartment-bedroom-front', kind: 'partition', supports: ['apartment-floor'] },
  });
  addBox(-12.325, FY + 2.2 + (H - 2.2) / 2, -6.8, 1.35, H - 2.2, 0.16, MATS.plaster, {
    architecture: { id: 'apartment-bedroom-header', kind: 'lintel', supportKind: 'anchored',
      supports: ['apartment-bedroom-front', 'apartment-bedroom-east'] },
  });
  for (const x of [-13, -11.65]) pushDecor(_BG.unitBox, MATS.wood, x, FY + 1.1, -6.8, 0.05, 2.2, 0.20);
  pushDecor(_BG.unitBox, MATS.wood, -12.325, FY + 2.18, -6.8, 1.35, 0.05, 0.20);
  for (const x of [-11.74, -11.56]) pushDecor(_BG.unitBox, MATS.wood, x, FY + 0.065, -8.35, 0.025, 0.13, 3.1);
  for (const z of [-6.89, -6.71]) pushDecor(_BG.unitBox, MATS.wood, -13.95, FY + 0.065, z, 1.9, 0.13, 0.025);

  // The bed moves west to leave a full metre of passage beside the alcove wall.
  addBox(-13.8, FY + 0.25, -8.0, 2.1, 0.5, 1.2, MATS.wood, {
    architecture: { id: 'apartment-bed', kind: 'furniture', supports: ['apartment-floor'] },
  });
  const mattress = addBox(-13.8, FY + 0.65, -8.0, 2.0, 0.3, 1.1, MATS.wallpaper, { collide: false });
  mattress.name = 'apartment-mattress';
  addBox(-13.0, FY + 0.78, -8.35, 0.5, 0.12, 0.35, MATS.wallpaper, { collide: false });
  interiorProps.sideboard({ id: 'apartment-bedside', x: -14.5, z: -9.3, floorY: FY, floorId: 'apartment-floor', width: 0.6, depth: 0.44, height: 0.65 });
  interiorProps.bookcase({ id: 'apartment-bedroom-storage', x: -12.3, z: -9.5, floorY: FY, floorId: 'apartment-floor', width: 0.7, depth: 0.45, height: 1.9 });
  pushDecor(_BG.unitBox, MATS.wallpaper, -14.5, FY + 0.676, -9.3, 0.25, 0.03, 0.18);
  pushDecor(_BG.unitBox, MATS.tar, -14.5, FY + 0.704, -9.3, 0.18, 0.026, 0.12);

  upholsteredSeat({ id: 'apartment-loveseat', x: -9.7, z: -7.65, floorY: FY,
    floorId: 'apartment-floor', width: 1.55, depth: 0.85 });
  interiorProps.bookcase({ id: 'apartment-living-shelves', x: -8.2, z: -9.65,
    floorY: FY, floorId: 'apartment-floor', width: 1.15, depth: 0.35, height: 2.0 });
  interiorProps.sideboard({ id: 'apartment-hall-console', x: -3.4, z: -8.75, yaw: -Math.PI / 2,
    floorY: FY, floorId: 'apartment-floor', width: 1.8, depth: 0.6, height: 1.05 });
  interiorProps.bench({ id: 'apartment-entry-bench', x: -3.4, z: -2.9, yaw: -Math.PI / 2,
    floorY: FY, floorId: 'apartment-floor', width: 1.1, depth: 0.6 });
  pushDecor(_BG.unitBox, MATS.wallpaper, -9.8, FY + 0.009, -5.9, 3.8, 0.012, 4.5);

  // Kitchenette: counter + sink slab + cabinets
  const worktopOffset = 0.92, worktopThickness = 0.05;
  // Meet the underside exactly; overlap would leave competing wood and metal
  // triangles on all four flush sides of the worktop.
  const kitchenBaseHeight = worktopOffset - worktopThickness / 2;
  addBox(-14.4, FY + kitchenBaseHeight / 2, -2.5, 1.0, kitchenBaseHeight, 2.4, MATS.wood, {
    architecture: { id: 'apartment-kitchen-base', kind: 'furniture', supports: ['apartment-floor'] },
  });
  const worktop = addBox(-14.4, FY + worktopOffset, -2.5, 1.0, worktopThickness, 2.4, MATS.metal, { collide: false });
  worktop.name = 'apartment-kitchen-top';
  // A recessed basin and tap distinguish this from a second flat metal slab.
  pushDecor(_BG.unitBox, MATS.tar, -14.4, FY + 0.949, -2.5, 0.65, 0.012, 0.80);
  pushDecor(_BG.pipe, MATS.metal, -14.70, FY + 1.065, -2.5, 0.018, 0.24, 0.018);
  pushDecor(_BG.unitBox, MATS.metal, -14.58, FY + 1.18, -2.5, 0.25, 0.028, 0.028);
  // Wall cabinets are shallower than the worktop and actually meet the wall.
  addBox(-14.66, FY + 1.95, -2.5, 0.48, 1.1, 2.4, MATS.wood, {
    architecture: { id: 'apartment-kitchen-wall-cabinet', kind: 'furniture', supportKind: 'anchored', supports: ['apartment-west'] },
  });
  for (const z of [-3.3, -2.5, -1.7]) {
    pushDecor(_BG.unitBox, MATS.wood, -14.405, FY + 1.95, z, 0.018, 0.98, 0.74);
    pushDecor(_BG.unitBox, MATS.metal, -14.38, FY + 1.83, z + 0.23, 0.035, 0.16, 0.025);
    pushDecor(_BG.unitBox, MATS.wood, -13.887, FY + 0.45, z, 0.018, 0.74, 0.74);
  }
  interiorProps.refrigerator({ id: 'apartment-refrigerator', x: -14.44, z: -4.85, yaw: Math.PI / 2,
    floorY: FY, floorId: 'apartment-floor', width: 0.8, depth: 0.9, height: 1.9 });
  interiorProps.stove({ id: 'apartment-stove', x: -14.4, z: -4.08, yaw: Math.PI / 2,
    floorY: FY, floorId: 'apartment-floor', width: 0.7, depth: 1.0 });
  // Extractor and service flue are against the same wall as the cooker.
  pushDecor(_BG.unitBox, MATS.metal, -14.62, FY + 1.78, -4.08, 0.55, 0.18, 0.73);
  pushDecor(_BG.unitBox, MATS.metal, -14.77, FY + 2.635, -4.08, 0.25, 1.53, 0.28);

  // Wooden table (collidable) with a glass on it.
  const coffeeLegs = [[-0.6, -0.35], [0.6, -0.35], [-0.6, 0.35], [0.6, 0.35]];
  addBox(-10.0, FY + 0.45, -5.0, 1.4, 0.06, 0.9, MATS.wood, {
    architecture: { id: 'apartment-coffee-table', kind: 'furniture', supports: coffeeLegs.map((_, i) => `apartment-coffee-leg-${i}`) },
  });
  for (const [i, [lx, lz]] of coffeeLegs.entries()) {
    addBox(-10.0 + lx, FY + 0.21, -5.0 + lz, 0.06, 0.42, 0.06, MATS.wood, {
      collide: false, architecture: { id: `apartment-coffee-leg-${i}`, kind: 'furniture', supports: ['apartment-floor'] },
    });
  }
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.14, 12), MATS.glass);
  glass.position.set(-9.6, FY + 0.55, -5.0); World.add(glass);

  // Locked gear chest (heavy metal box with a glowing keyhole hint).
  addBox(-12.0, FY + 0.4, -3.8, 1.2, 0.8, 0.7, MATS.metal, {
    architecture: { id: 'apartment-gear-chest', kind: 'furniture', supports: ['apartment-floor'] },
  });
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 0.04), new THREE.MeshStandardMaterial({ color: 0x402010, emissive: 0x402010, emissiveIntensity: 0.4, roughness: 0.5, metalness: 0.8 }));
  lock.position.set(-12.0, FY + 0.42, -3.8 + 0.36); World.add(lock);

  // Flickering ceiling lamp.
  const lampBulb = new THREE.PointLight(0xffb86b, 2.6, 11, 1.7);
  lampBulb.position.set(-9.0, CY - 0.4, -5.0);
  // PERF: indoor point lights do not cast shadows (moon is sole shadow caster).
  lampBulb.castShadow = false;
  World.add(lampBulb);
  addFlickerLight(lampBulb, 2.6, 1);
  const lampMesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffaa55, emissiveIntensity: 3.0 }));
  lampMesh.position.copy(lampBulb.position); World.add(lampMesh);
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.35, 6), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 1.0 }));
  cord.position.set(-9.0, CY - 0.2, -5.0); World.add(cord);

  // Fire wall blocking the south-wall entry door (interior side).
  // blockDepth is clamped so the AABB's south face stays at z<=0 (inside the
  // apartment) — otherwise the cube extruded onto the wrap walkway at y=4
  // and shoved the player down through the deck.
  spawnFire(-5.0, FY, -0.9, { width: 2.2, height: 2.4, blockWidth: 4.0, blockDepth: 1.7, blockHeight: 2.6, intensity: 4.4 });
  spawnFire(-7.5, FY, -0.9, { width: 2.0, height: 2.2, blockWidth: 3.8, blockDepth: 1.7, blockHeight: 2.4, intensity: 3.6 });
  // Charred floor scar in front of the fire.
  addDecor(-6.0, FY + 0.02, -1.4, 5.0, 0.04, 1.0, MATS.tar);

  // Zone trigger (covers the playable interior).
  Triggers.add('apartment',
    new THREE.Vector3(FX1 + 0.5, FY,       FZ1 + 0.5),
    new THREE.Vector3(FX2 - 0.5, FY + 2.2, FZ2 - 0.5));
}

// ─── ZONE 2: NEIGHBOR'S APARTMENT ──────────────────────────────────────────
// Footprint x∈[-3,9], z∈[-10,0], floor y=4, ceiling y=7.4.
// East wall (x=9) has a balcony door opening. Decor is plaster + green wallpaper
// alternative, with different furniture set to feel distinct.
function buildNeighborApartment() {
  const FX1 = -3, FX2 = BALCONY.east.x1, FZ1 = BUILDING.main.z1, FZ2 = BUILDING.main.z2;
  const FY = BUILDING.apartmentY, CY = BUILDING.canopyY, WALL_T = BUILDING.wallThickness;
  const H = CY - FY;
  const cx = (FX1 + FX2) / 2, cz = (FZ1 + FZ2) / 2, w = FX2 - FX1, d = FZ2 - FZ1;

  addBox(cx, FY - 0.1, cz, w, 0.2, d, MATS.wood, {
    cast: false, architecture: { id: 'neighbor-floor', kind: 'floor', supports: ['main-ground-north', 'main-ground-south'] },
  });
  addBox(cx, CY + 0.1, cz, w, 0.2, d, MATS.plaster, {
    cast: false, architecture: { id: 'neighbor-ceiling', kind: 'slab', supports: ['neighbor-north', 'neighbor-south'] },
  });

  // North wall (solid).
  addBox(cx, FY + H / 2, FZ1, w, H, WALL_T, MATS.brick, {
    architecture: { id: 'neighbor-north', kind: 'wall', supports: ['neighbor-floor'] },
  });
  // South wall (solid; building front).
  addBox(cx, FY + H / 2, FZ2, w, H, WALL_T, MATS.brick, {
    architecture: { id: 'neighbor-south', kind: 'wall', supports: ['neighbor-floor'] },
  });
  // A single through-wall frame is visible from both the room and terrace.
  // Its clear passage remains z=-7..-3; the wall stops outside its jambs.
  const terraceDoor = APARTMENT_DOORS.neighborTerrace;
  addWallZ(FX2, FY, cz, d, H, WALL_T, MATS.brick, {
    zStart: terraceDoor.z - terraceDoor.width / 2 - terraceDoor.frameWidth,
    zEnd: terraceDoor.z + terraceDoor.width / 2 + terraceDoor.frameWidth,
    headerH: H - terraceDoor.height - terraceDoor.frameWidth, sillH: 0,
  });
  doors.openFrame(terraceDoor, { floorId: 'neighbor-floor' });

  // Painted-wood baseboard along the three solid walls + balcony-door jamb
  // trim (decor, shared unit box). Same cheap pattern as the player's unit
  // but with the wood material reading darker against the brick walls here.
  pushDecor(_BG.unitBox, MATS.wood, cx, FY + 0.07, FZ1 + 0.12, w - 0.2, 0.14, 0.04);
  pushDecor(_BG.unitBox, MATS.wood, cx, FY + 0.07, FZ2 - 0.12, w - 0.2, 0.14, 0.04);
  pushDecor(_BG.unitBox, MATS.wood, FX1 + 0.12, FY + 0.07, cz, 0.04, 0.14, d - 0.2);

  // An entrance hall shields the dining room from the breach. The doorway
  // opens onto the broad aisle south of the table, then turns to the balcony.
  partitionZ({ id: 'neighbor-foyer', x: 1, zStart: -9.9, zEnd: -0.1,
    doorStart: -5.25, doorEnd: -3.2, floorY: FY, ceilingY: CY, floorId: 'neighbor-floor' });
  interiorProps.bench({ id: 'neighbor-entry-bench', x: -2.6, z: -2.1, yaw: Math.PI / 2,
    floorY: FY, floorId: 'neighbor-floor', width: 1.3, depth: 0.5 });
  interiorProps.bookcase({ id: 'neighbor-study-shelves', x: 1.35, z: -8.1, yaw: Math.PI / 2,
    floorY: FY, floorId: 'neighbor-floor', width: 2.2, depth: 0.4, height: 2.1 });
  // Coats hang from a rail fastened to the party wall, not from empty space.
  pushDecor(_BG.unitBox, MATS.wood, -2.85, FY + 1.85, -2.1, 0.07, 0.11, 1.12);
  for (const [i, z] of [-2.46, -2.10, -1.74].entries()) {
    pushDecor(_BG.unitBox, MATS.metal, -2.78, FY + 1.84, z, 0.10, 0.025, 0.025);
    pushDecor(_BG.unitBox, i % 2 ? MATS.wood : MATS.wallpaper, -2.76, FY + 1.48, z,
      0.10, 0.70, 0.23);
  }
  pushDecor(_BG.unitBox, MATS.wallpaper, -0.6, FY + 0.009, -3.4, 1.45, 0.012, 2.2);
  pushDecor(_BG.unitBox, MATS.wallpaper, 6.85, FY + 0.009, -8.0, 3.2, 0.012, 2.7);

  // Dining height is measured at the top surface; the papers use this datum too.
  const diningHeight = 0.74, tabletopThickness = 0.08;
  const legHeight = diningHeight - tabletopThickness;
  const tableLegs = [[-0.9, -0.4], [0.9, -0.4], [-0.9, 0.4], [0.9, 0.4]];
  addBox(3.0, FY + diningHeight - tabletopThickness / 2, -5.0, 2.0, tabletopThickness, 1.0, MATS.wood, {
    architecture: { id: 'neighbor-dining-top', kind: 'furniture', supports: tableLegs.map((_, i) => `neighbor-table-leg-${i}`) },
  });
  for (const [i, [lx, lz]] of tableLegs.entries()) {
    addBox(3.0 + lx, FY + legHeight / 2, -5.0 + lz, 0.08, legHeight, 0.08, MATS.wood, {
      collide: false, architecture: { id: `neighbor-table-leg-${i}`, kind: 'furniture', supports: ['neighbor-floor'] },
    });
  }
  // Chairs face the table, with four feet under each seat instead of floating backs.
  for (const [x, facing] of [[1.7, 1], [4.3, -1]]) {
    addBox(x, FY + 0.415, -5.0, 0.4, 0.05, 0.4, MATS.wood);
    pushDecor(_BG.unitBox, MATS.wood, x - facing * 0.19, FY + 0.72, -5.0, 0.05, 0.60, 0.4);
    for (const dx of [-0.15, 0.15]) {
      for (const dz of [-0.15, 0.15]) pushDecor(_BG.unitBox, MATS.wood, x + dx, FY + 0.195, -5 + dz, 0.055, 0.39, 0.055);
    }
  }

  // A compact kitchen and flush cupboard face occupy the south wall, clear of
  // the breach, enemy spawn anchors and the balcony passage at z=-7..-3.
  addBox(7.75, FY + 0.45, -0.475, 1.90, 0.90, 0.65, MATS.wood, {
    architecture: { id: 'neighbor-kitchen-base', kind: 'furniture', supports: ['neighbor-floor'] },
  });
  pushDecor(_BG.unitBox, MATS.metal, 7.75, FY + 0.925, -0.475, 1.95, 0.05, 0.68);
  pushDecor(_BG.unitBox, MATS.tar, 7.85, FY + 0.957, -0.475, 0.65, 0.012, 0.40);
  addBox(7.75, FY + 1.93, -0.30, 1.90, 0.90, 0.40, MATS.wood, {
    architecture: { id: 'neighbor-kitchen-wall-cabinet', kind: 'furniture', supportKind: 'anchored', supports: ['neighbor-south'] },
  });
  for (const x of [7.30, 8.20]) {
    pushDecor(_BG.unitBox, MATS.wood, x, FY + 1.93, -0.514, 0.83, 0.80, 0.025);
    pushDecor(_BG.unitBox, MATS.metal, x + 0.27, FY + 1.79, -0.54, 0.025, 0.15, 0.025);
  }
  interiorProps.refrigerator({ id: 'neighbor-refrigerator', x: 5.75, z: -0.52, yaw: Math.PI,
    floorY: FY, floorId: 'neighbor-floor', width: 0.8, depth: 0.8, height: 1.88 });
  interiorProps.stove({ id: 'neighbor-stove', x: 6.48, z: -0.475, yaw: Math.PI,
    floorY: FY, floorId: 'neighbor-floor', width: 0.6, depth: 0.65 });
  interiorProps.sideboard({ id: 'neighbor-kitchen-island', x: 3.55, z: -1.5, yaw: Math.PI / 2,
    floorY: FY, floorId: 'neighbor-floor', width: 1.8, depth: 0.65, height: 1.05 });
  pushDecor(_BG.unitBox, MATS.metal, 6.48, FY + 1.79, -0.375, 0.65, 0.16, 0.50);
  pushDecor(_BG.unitBox, MATS.metal, 6.48, FY + 2.635, -0.265, 0.26, 1.53, 0.26);
  pushDecor(_BG.unitBox, MATS.wood, 7.18, FY + 0.989, -0.475, 0.5, 0.05, 0.32);
  pushDecor(_BG.unitBox, MATS.plaster, 3.55, FY + 1.077, -1.2, 0.34, 0.02, 0.25);
  // This is interior storage, not an outside entrance. A shallow carcass,
  // plinth and paired cabinet doors make that distinction visible in the room.
  addBox(-1.4, FY + 1.0, -0.32, 1.38, 2.0, 0.44, MATS.wood, {
    architecture: { id: 'neighbor-linen-cupboard', kind: 'furniture', supports: ['neighbor-floor'] },
  });
  for (const x of [-1.745, -1.055]) {
    pushDecor(_BG.unitBox, MATS.wood, x, FY + 1.03, -0.553, 0.65, 1.84, 0.026);
    for (const y of [FY + 0.54, FY + 1.46]) pushDecor(_BG.unitBox, MATS.wallpaper, x, y, -0.569, 0.51, 0.62, 0.01);
  }
  pushDecor(_BG.unitBox, MATS.tar, -1.4, FY + 0.055, -0.548, 1.24, 0.11, 0.02);
  pushDecor(_BG.unitBox, MATS.wood, -1.4, FY + 2.03, -0.32, 1.44, 0.06, 0.46);
  for (const x of [-1.50, -1.30]) pushDecor(_BG.unitBox, MATS.metal, x, FY + 1.02, -0.585, 0.035, 0.12, 0.025);

  // Living furniture faces one another instead of a television in the hall.
  upholsteredSeat({ id: 'neighbor-sofa', x: 7, z: -9, floorY: FY,
    floorId: 'neighbor-floor', width: 2.2, depth: 0.8 });
  upholsteredSeat({ id: 'neighbor-armchair', x: 3.5, z: -6.9, floorY: FY,
    floorId: 'neighbor-floor', width: 0.8, depth: 0.7 });
  interiorProps.sideboard({ id: 'neighbor-side-table', x: 4.65, z: -8.75,
    floorY: FY, floorId: 'neighbor-floor', width: 0.65, depth: 0.65, height: 0.5 });

  // TV cabinet + dim CRT glow.
  addBox(7, FY + 0.4, -6.95, 1.2, 0.8, 0.5, MATS.wood, {
    architecture: { id: 'neighbor-tv-console', kind: 'furniture', supports: ['neighbor-floor'] },
  });
  addBox(7, FY + 1.105, -6.99, 1.0, 0.59, 0.50, MATS.metal, { collide: false });
  for (const x of [6.67, 7.33]) pushDecor(_BG.unitBox, MATS.metal, x, FY + 0.82, -6.99, 0.10, 0.04, 0.34);
  const crt = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.45, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x051018, emissive: 0x3a4d80, emissiveIntensity: 1.0, roughness: 0.3, metalness: 0.3 }));
  // The dark tube is opaque cover, but its front surface is glass for impacts.
  crt.material.userData.surfaceKind = 'glass';
  crt.position.set(7.05, FY + 1.105, -7.26); World.add(crt);
  for (const y of [FY + 0.99, FY + 1.19]) pushDecor(_BG.unitBox, MATS.wood, 6.58, y, -7.27, 0.055, 0.055, 0.045);
  const crtLight = new THREE.PointLight(0x4a6aa0, 0.7, 4, 2.0);
  crtLight.position.set(7, FY + 1.0, -7.5);
  World.add(crtLight); addFlickerLight(crtLight, 0.7, 7);

  // Framed picture (decorative).
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4),
    new THREE.MeshStandardMaterial({ map: makeSignTexture('FAMIGLIA', { bg: '#3a2a14', fg: '#f0d090', font: 'bold 110px serif' }), roughness: 0.7 }));
  frame.position.set(7.0, FY + 1.7, FZ1 + 0.11); frame.rotation.y = 0; World.add(frame);

  // Ceiling pendant.
  const pend = new THREE.PointLight(0xffd9a0, 1.6, 9, 1.6);
  pend.position.set(3.0, CY - 0.35, -5.0);
  pend.castShadow = false; // PERF: moon-only shadows.
  World.add(pend);
  const pendMesh = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffcc88, emissiveIntensity: 2.2 }));
  pendMesh.position.copy(pend.position); World.add(pendMesh);
  const pendantCord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.27, 6), MATS.metal);
  pendantCord.position.set(3, CY - 0.135, -5); World.add(pendantCord);
  pushDecor(_BG.pipe, MATS.metal, 3, CY - 0.0125, -5, 0.06, 0.025, 0.06);

  // Allocate this gate only on its first use. Full campaign resets hide and
  // disable the same objects; checkpoint retries leave them closed behind us.
  let breachGate = null;
  Triggers.add('neighbor',
    new THREE.Vector3(FX1 + 0.6, FY,       FZ1 + 0.5),
    new THREE.Vector3(FX2 - 0.5, FY + 2.2, FZ2 - 0.5),
    () => {
      if (!breachGate) {
        const fire = spawnFire(-3.0, FY, -6.0, { width: 1.4, height: 1.6, blockWidth: 1.8, blockHeight: 1.9, intensity: 3.0 });
        fire.group.name = 'neighbor-breach-fire';
        fire.light.userData.zone = 'neighbor';
        const debris = addDecor(-3.0, FY + 0.15, -6.0, 0.6, 0.3, 2.6, MATS.brick);
        debris.name = 'neighbor-breach-debris';
        const collider = Colliders.addBoxBySize(-3.0, FY + 0.15, -6.0, 0.6, 0.3, 2.6);
        debris.userData.collider = collider;
        Ballistics.addObject(debris, { collider });
        breachGate = { fire, debris, collider };
      } else {
        setFireActive(breachGate.fire, true);
        breachGate.debris.visible = true;
        Colliders.setEnabled(breachGate.collider, true);
      }
    },
    () => {
      if (!breachGate) return;
      setFireActive(breachGate.fire, false);
      breachGate.debris.visible = false;
      Colliders.setEnabled(breachGate.collider, false);
    });
}

export { buildPlayerApartment, buildNeighborApartment };
