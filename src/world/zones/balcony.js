import * as THREE from 'three';

import { MATS } from '../../render/materials.js';
import { _BG, pushDecor } from '../../render/models.js';

import { BUILDING, BALCONY, APARTMENT_DOORS } from '../layout.js';
import { addBeam, addProtectiveScreen } from '../structures.js';
import { World, Triggers, addBox, addDecor, addSign } from '../world.js';

function addApartmentAddresses() {
  const entry = APARTMENT_DOORS.playerEntry;
  const y = entry.floorY + entry.height + entry.frameWidth + 0.23;
  const backing = addBox(entry.x, y, entry.z + 0.117, 0.34, 0.20, 0.035, MATS.roofMetal, {
    collide: false, architecture: { id: `${entry.id}-number-backing`, kind: 'fixture', supportKind: 'anchored', supports: [`${entry.id}-wall-header`] },
  });
  backing.userData.doorId = entry.id;
  const number = addSign(entry.x, y, entry.z + 0.137, 0.27, 0.145, '+z', entry.number,
    { bg: '#38403b', fg: '#d7d0b9', font: 'bold 112px serif' });
  number.name = `${entry.id}-exterior-number`;
  number.userData.doorId = entry.id;
  number.userData.mountId = backing.name;
  for (const dx of [-0.14, 0.14]) pushDecor(_BG.unitBox, MATS.metal, entry.x + dx, y, entry.z + 0.138, 0.014, 0.014, 0.007);

  // Small soot marks belong beside the fire-damaged doorway, not at arbitrary
  // repeated positions along the facade. They do not project into the lane.
  for (const [side, height] of [[-1, 0.58], [1, 0.36]]) {
    const x = entry.x + side * (entry.width / 2 + entry.frameWidth + 0.055);
    pushDecor(_BG.unitBox, MATS.tar, x, entry.floorY + 1.62, entry.z + 0.102, 0.028, height, 0.007);
    pushDecor(_BG.unitBox, MATS.agedStone, x + side * 0.035, entry.floorY + 0.32, entry.z + 0.105, 0.07, 0.16, 0.014);
  }

  const terrace = APARTMENT_DOORS.neighborTerrace;
  const terracePlateHeight = 0.20, terraceMountOverlap = 0.01;
  // Mount onto the upper centimetre of the frame. Its bottom then shares
  // neither the wood's underside nor the masonry lintel's underside plane,
  // while the backing retains a physical contact with its declared support.
  const terraceY = terrace.floorY + terrace.height + terrace.frameWidth - terraceMountOverlap + terracePlateHeight / 2;
  const terracePlate = addBox(terrace.x + 0.122, terraceY, terrace.z, 0.05, terracePlateHeight, 0.94, MATS.roofMetal, {
    collide: false, architecture: { id: `${terrace.id}-number-backing`, kind: 'fixture', supportKind: 'anchored', supports: [`${terrace.id}-header`] },
  });
  terracePlate.userData.doorId = terrace.id;
  const terraceNumber = addSign(terrace.x + 0.150, terraceY, terrace.z, 0.84, 0.14, '+x', `${terrace.number} · TERRACE`,
    { bg: '#38403b', fg: '#d7d0b9', font: 'bold 84px sans-serif' });
  terraceNumber.name = `${terrace.id}-exterior-number`;
  terraceNumber.userData.doorId = terrace.id;
  terraceNumber.userData.mountId = terracePlate.name;
}

// ─── ZONE 3: BALCONY ───────────────────────────────────────────────────────
// A recessed east terrace joins a supported exterior gallery. Construction
// screens explain the boundary while preserving an open-air view of the block.
export function buildBalcony() {
  const { east: E, wrap: W, floorY: y, guardHeight } = BALCONY;
  const eastWidth = E.x2 - E.x1, eastDepth = E.z2 - E.z1;
  const wrapWidth = W.x2 - W.x1, wrapDepth = W.z2 - W.z1;
  const ecx = (E.x1 + E.x2) / 2, ecz = (E.z1 + E.z2) / 2;
  const wcx = (W.x1 + W.x2) / 2, wcz = (W.z1 + W.z2) / 2;
  addBox(ecx, y - 0.3, ecz, eastWidth, 0.2, eastDepth, MATS.concrete, {
    cast: false, architecture: { id: 'balcony-east-beam', kind: 'slab', supports: ['main-ground-east', 'main-ground-north'], supportKind: 'anchored' },
  });
  addBox(ecx, y - 0.1, ecz, eastWidth, 0.2, eastDepth, MATS.concrete, {
    cast: false, architecture: { id: 'balcony-east-deck', kind: 'deck', supports: ['balcony-east-beam'] },
  });
  const brackets = [-18, -14, -10, -6, -2, 2, 6, 10, 12];
  for (const [i, x] of brackets.entries()) {
    addBeam(`balcony-bracket-${i}`, [x, y - 1.6, 0.05], [x, y - 0.35, W.z2 - 0.12], 0.12,
      [x < -15 ? 'stair-ground-south' : 'main-ground-south']);
    pushDecor(_BG.unitBox, MATS.metal, x, y - 1.35, 0.11, 0.28, 0.7, 0.07);
  }
  addBox(wcx, y - 0.3, wcz, wrapWidth, 0.2, wrapDepth, MATS.concrete, {
    cast: false, architecture: { id: 'balcony-wrap-beam', kind: 'slab', supports: brackets.map((_, i) => `balcony-bracket-${i}`), supportKind: 'anchored' },
  });
  addBox(wcx, y - 0.1, wcz, wrapWidth, 0.2, wrapDepth, MATS.concrete, {
    cast: false, architecture: { id: 'balcony-wrap-deck', kind: 'deck', supports: ['balcony-wrap-beam'] },
  });
  // A fitted end band covers the exposed slab/masonry junction. It contacts
  // both concrete layers without extending the collision or walkable floor.
  const endBandThickness = 0.02;
  addBox(W.x2 + endBandThickness / 2, y - 0.2, wcz, endBandThickness, 0.4, wrapDepth, MATS.roofMetal, {
    collide: false,
    architecture: { id: 'balcony-wrap-end-band', kind: 'trim', supportKind: 'anchored',
      supports: ['balcony-wrap-beam', 'balcony-wrap-deck'] },
  });

  // The two upper floors continue over this loggia; columns and a perimeter
  // beam carry the canopy instead of leaving an unexplained four-metre overhang.
  const columnIds = [];
  for (const [i, z] of [-9.65, -6.5, -3.5, -0.35].entries()) {
    const id = `terrace-column-${i}`; columnIds.push(id);
    addBox(12.72, (y + BUILDING.canopyY) / 2, z, 0.3, BUILDING.canopyY - y, 0.3, MATS.concrete, {
      architecture: { id, kind: 'column', supports: ['balcony-east-deck'] },
    });
    pushDecor(_BG.unitBox, MATS.concrete, 12.72, y + 0.12, z, 0.4, 0.24, 0.4);
  }
  addBox(ecx, BUILDING.canopyY + 0.1, ecz, eastWidth, 0.2, eastDepth, MATS.concrete, {
    architecture: { id: 'terrace-canopy', kind: 'slab', supports: columnIds },
  });
  pushDecor(_BG.unitBox, MATS.concrete, 12.72, BUILDING.canopyY - 0.16, ecz, 0.32, 0.32, eastDepth);

  addProtectiveScreen('balcony-screen-north', [E.x1, E.z1 + 0.05], [E.x2, E.z1 + 0.05], y, guardHeight, ['balcony-east-deck']);
  addProtectiveScreen('balcony-screen-east', [E.x2 - 0.05, E.z1], [E.x2 - 0.05, W.z2], y, guardHeight, ['balcony-east-deck', 'balcony-wrap-deck']);
  addProtectiveScreen('balcony-screen-south', [W.x1, W.z2 - 0.05], [W.x2, W.z2 - 0.05], y, guardHeight, ['balcony-wrap-deck']);
  addProtectiveScreen('balcony-screen-west', [W.x1 + 0.05, W.z1], [W.x1 + 0.05, W.z2], y, guardHeight, ['balcony-wrap-deck']);

  // Wall-mounted practical and utility fittings stay above the combat lane.
  addDecor(9.13, 6.5, -0.9, 0.08, 0.45, 0.24, MATS.metal);
  addDecor(9.33, 6.65, -0.9, 0.42, 0.045, 0.045, MATS.metal);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xf0c795, emissive: 0xffbc75, emissiveIntensity: 1.6 }));
  bulb.position.set(9.5, 6.55, -0.9); World.add(bulb);
  const lamp = new THREE.PointLight(0xffbd83, 1.2, 14, 1.7);
  lamp.position.copy(bulb.position); World.add(lamp);
  addDecor(-12, 6.15, 0.15, 0.4, 0.5, 0.09, MATS.metal);
  addSign(-18, 6.35, 0.12, 1.8, 0.3, '+z', 'ROOF ACCESS', { bg: '#1c302b', fg: '#c9d6bd', font: 'bold 105px sans-serif' });
  addSign(5.5, 6.65, 0.12, 2.0, 0.3, '+z', 'FACADE REPAIRS', { bg: '#34352b', fg: '#ded6b8', font: 'bold 100px sans-serif' });
  addApartmentAddresses();

  // An occupied terrace becomes a work staging area; the narrow exterior
  // gallery remains completely clear for movement and close-range combat.
  for (const [i, z] of [-8.9, -1.2].entries()) {
    const x = 9.48;
    addBox(x, y + 0.46, z, 0.68, 0.12, 1.4, MATS.wood, {
      architecture: { id: `terrace-bench-${i}`, kind: 'furniture', supports: [`terrace-bench-leg-${i}-0`, `terrace-bench-leg-${i}-1`] },
    });
    for (const [leg, dz] of [-0.56, 0.56].entries()) {
      addBox(x, y + 0.20, z + dz, 0.5, 0.40, 0.075, MATS.roofMetal, {
        collide: false, architecture: { id: `terrace-bench-leg-${i}-${leg}`, kind: 'furniture-leg', supports: ['balcony-east-deck'] },
      });
      pushDecor(_BG.unitBox, MATS.roofMetal, 9.21, y + 0.60, z + dz, 0.055, 0.64, 0.055);
    }
    for (const by of [0.7, 0.88]) pushDecor(_BG.unitBox, MATS.wood, 9.22, y + by, z, 0.07, 0.13, 1.42);
  }
  addBox(12.0, y + 0.39, -8.9, 0.78, 0.78, 0.9, MATS.roofMetal);
  pushDecor(_BG.unitBox, MATS.metal, 12.0, y + 0.81, -8.9, 0.84, 0.06, 0.95);
  pushDecor(_BG.unitBox, MATS.wood, 12.0, y + 0.97, -8.9, 0.46, 0.26, 0.50);
  // Conduit, drains and repair plates describe a maintained exterior facade.
  pushDecor(_BG.unitBox, MATS.roofMetal, -2, y + 2.26, 0.14, 29, 0.026, 0.026);
  for (let x = -16; x <= 12; x += 4) {
    pushDecor(_BG.unitBox, MATS.metal, x, y + 2.26, 0.12, 0.07, 0.12, 0.07);
    for (let i = 0; i < 6; i++) pushDecor(_BG.unitBox, MATS.metal, x + i * 0.048, y + 0.006, 1.47, 0.018, 0.008, 0.25);
  }

  Triggers.add('balcony',
    new THREE.Vector3(E.x1 + 0.3, y, E.z1 + 0.3),
    new THREE.Vector3(E.x2 - 0.3, y + 2.2, E.z2 - 0.3));
}
