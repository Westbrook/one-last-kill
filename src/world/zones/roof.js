import * as THREE from 'three';
import { MATS } from '../../render/materials.js';
import { applyWaterTankStaveUV } from '../../render/water-tank-uv.js';
import { _BG, pushDecor } from '../../render/models.js';
import { Colliders } from '../../core/collision.js';
import { BUILDING, ROOF, OPENINGS } from '../layout.js';
import { STAIRS } from '../stair-layout.js';
import { Architecture, boxBounds } from '../architecture.js';
import { addBeam } from '../structures.js';
import { World, Triggers, addBox, addDecor, addSign } from '../world.js';

const PARAPET_HALF_THICKNESS = 0.13;
const FLASHING_THICKNESS = 0.02;

function rectBox(rect, y, height, material, options) {
  return addBox((rect.x1 + rect.x2) / 2, y + height / 2, (rect.z1 + rect.z2) / 2,
    rect.x2 - rect.x1, height, rect.z2 - rect.z1, material, options);
}

/** Closed occupied wings carry the roof; the apartment lightwell stays open. */
function buildServiceWings() {
  const L = ROOF.lightwell, y = ROOF.floorY;
  const wings = [
    ['north', { x1: ROOF.x1, x2: ROOF.x2, z1: ROOF.z1, z2: L.z1 }],
    ['west-link', { x1: ROOF.x1, x2: L.x1, z1: L.z1, z2: BUILDING.main.z1 }],
    ['east-link', { x1: L.x2, x2: ROOF.x2, z1: L.z1, z2: BUILDING.main.z1 }],
    ['east', { x1: BUILDING.main.x2, x2: ROOF.x2, z1: BUILDING.main.z1, z2: ROOF.z2 }],
  ];
  for (const [name, footprint] of wings) {
    rectBox(footprint, 0, y - 0.2, MATS.brick, {
      architecture: { id: `roof-annex-${name}-volume`, kind: 'building', supportKind: 'ground' },
    });
    rectBox(footprint, y - 0.2, 0.2, MATS.tar, {
      cast: false, architecture: { id: `roof-annex-${name}-deck`, kind: 'deck', supports: [`roof-annex-${name}-volume`] },
    });
  }
  // A discrete masonry face gives scaffold ties a real attachment surface.
  addBox(19, (y - 0.2) / 2, -0.1, 12, y - 0.2, 0.2, MATS.brick, {
    architecture: { id: 'roof-annex-east-south-wall', kind: 'wall', supportKind: 'ground' },
  });
  // Stone belts and shallow pilasters articulate real floor lines below.
  for (const floor of [3.8, 7.2, 10.6, 13.6]) {
    pushDecor(_BG.unitBox, MATS.agedStone, 5, floor, ROOF.z1 - 0.04, 40.3, 0.18, 0.18);
    pushDecor(_BG.unitBox, MATS.agedStone, ROOF.x2 + 0.04, floor, -12, 0.18, 0.18, 24.2);
    // Small end reveals keep stone return faces off the annex's brick planes.
    pushDecor(_BG.unitBox, MATS.agedStone, 19, floor, 0.04, 12 - 0.04, 0.18, 0.18);
  }
  for (const x of [-14.7, -6.8, 1.1, 9, 16.9, 24.7]) {
    pushDecor(_BG.unitBox, MATS.agedStone, x, 6.9, ROOF.z1 - 0.015, 0.3, 13.8, 0.15);
  }
  rectBox(L, -0.18, 0.18, MATS.concrete, {
    architecture: { id: 'lightwell-ground', kind: 'floor', supportKind: 'ground' },
  });
  for (const x of [L.x1 + 0.06, L.x2 - 0.06]) {
    pushDecor(_BG.pipe, MATS.roofMetal, x, 6.8, L.z1 + 0.08, 0.045, 13.6, 0.045);
  }
}

function parapet(id, x1, z1, x2, z2, supports, height = 1.2, join = {}) {
  const horizontal = Math.abs(x2 - x1) > 0.01;
  const width = horizontal ? Math.abs(x2 - x1) : PARAPET_HALF_THICKNESS * 2;
  const depth = horizontal ? PARAPET_HALF_THICKNESS * 2 : Math.abs(z2 - z1);
  const x = (x1 + x2) / 2, z = (z1 + z2) / 2, y = ROOF.floorY;
  // At the stair opening these solids join the wall's exterior face. Their
  // old overhangs crossed the jamb and exposed competing coplanar end faces.
  const joinedSpan = span => {
    const left = Math.max(x - span / 2, join.westX ?? -Infinity);
    const right = x + span / 2;
    return { x: (left + right) / 2, width: right - left };
  };
  const body = joinedSpan(width);
  const coping = joinedSpan(horizontal ? width : 0.40);
  addBox(body.x, y + height / 2, z, body.width, height, depth, MATS.brick, {
    architecture: { id, kind: 'parapet', supports, supportKind: 'anchored' },
  });
  pushDecor(_BG.unitBox, MATS.agedStone, coping.x, y + height + 0.045, z,
    coping.width, 0.09, horizontal ? 0.40 : depth);
  // Flashing is a thin sheet on the roof-facing brick surface, not a box
  // enclosing the masonry. The latter duplicated visible brick undersides.
  // Insets fit perpendicular corners and preserve the stair doorway reveals.
  const side = join.roofSide ?? 1;
  const face = horizontal ? z + side * depth / 2 : body.x + side * body.width / 2;
  const normalCenter = face + side * FLASHING_THICKNESS / 2;
  const flashingStart = (horizontal ? x1 : z1) + (join.flashingStartInset ?? 0);
  const flashingEnd = (horizontal ? x2 : z2) - (join.flashingEndInset ?? 0);
  const tangentCenter = (flashingStart + flashingEnd) / 2;
  pushDecor(_BG.unitBox, MATS.roofMetal,
    horizontal ? tangentCenter : normalCenter, y + 0.08, horizontal ? normalCenter : tangentCenter,
    horizontal ? flashingEnd - flashingStart : FLASHING_THICKNESS, 0.16,
    horizontal ? FLASHING_THICKNESS : flashingEnd - flashingStart);
}

function mechanicalUnit(id, x, z, width = 2.4, depth = 1.8, height = 1.25) {
  const y = ROOF.floorY;
  addBox(x, y + 0.11, z, width + 0.12, 0.22, depth + 0.12, MATS.concrete);
  const unit = addBox(x, y + 0.22 + height / 2, z, width, height, depth, MATS.roofMetal);
  unit.name = id;
  for (const side of [-1, 1]) {
    pushDecor(_BG.unitBox, MATS.rubber, x, y + 0.22 + height * 0.49, z + side * (depth / 2 + 0.005), width * 0.78, height * 0.66, 0.012);
    for (let i = 0; i < 9; i++) {
      pushDecor(_BG.unitBox, MATS.roofMetal, x, y + 0.38 + i * height * 0.074,
        z + side * (depth / 2 + 0.017), width * 0.8, 0.018, 0.025);
    }
  }
  const fanRadius = Math.min(width * 0.24, depth * 0.34);
  const fan = new THREE.Mesh(new THREE.CylinderGeometry(fanRadius, fanRadius, 0.04, 32), MATS.rubber);
  fan.position.set(x, y + height + 0.245, z); World.add(fan);
  for (let ring = 1; ring <= 4; ring++) {
    const guard = new THREE.Mesh(new THREE.TorusGeometry(fanRadius * ring / 4, 0.009, 4, 32), MATS.roofMetal);
    guard.rotation.x = Math.PI / 2; guard.position.set(x, y + height + 0.274, z); World.add(guard);
  }
  for (const angle of [0, Math.PI / 2]) {
    pushDecor(_BG.unitBox, MATS.roofMetal, x, y + height + 0.276, z, fanRadius * 1.9, 0.014, 0.016, angle);
  }
  pushDecor(_BG.unitBox, MATS.metal, x - width * 0.3, y + 0.45, z + depth / 2 + 0.025, 0.17, 0.13, 0.02);
  return unit;
}

function buildMechanicalYard() {
  const H = ROOF.serviceHouse, y = ROOF.floorY;
  const curb = rectBox(H, y, 0.18, MATS.concrete, {
    architecture: { id: 'roof-service-curb', kind: 'curb', supports: ['roof-annex-north-deck', 'roof-annex-east-link-deck'] },
  });
  curb.name = 'mechanical-house-curb';
  rectBox(H, y + 0.18, H.height - 0.18, MATS.brick, {
    architecture: { id: 'roof-service-house', kind: 'building', supports: ['roof-service-curb'] },
  });
  const cap = { x1: H.x1 - 0.16, x2: H.x2 + 0.16, z1: H.z1 - 0.16, z2: H.z2 + 0.16 };
  rectBox(cap, y + H.height, 0.14, MATS.roofMetal, {
    architecture: { id: 'roof-service-cap', kind: 'roof', supports: ['roof-service-house'] },
  });
  // A closed double service door, its frame, hinges, kick plates and hardware.
  for (const x of [0.94, 2.10]) {
    addDecor(x, y + 1.12, H.z2 + 0.014, 1.1, 2.20, 0.025, MATS.roofMetal);
    pushDecor(_BG.unitBox, MATS.metal, x, y + 0.26, H.z2 + 0.035, 1.02, 0.4, 0.015);
    for (const dy of [0.43, 1.15, 1.84]) pushDecor(_BG.unitBox, MATS.metal, x - 0.50, y + dy, H.z2 + 0.05, 0.045, 0.12, 0.045);
    pushDecor(_BG.unitBox, MATS.metal, x + 0.34, y + 1.04, H.z2 + 0.065, 0.10, 0.20, 0.055);
  }
  for (const x of [0.34, 1.52, 2.7]) pushDecor(_BG.unitBox, MATS.metal, x, y + 1.14, H.z2 + 0.04, 0.055, 2.28, 0.09);
  pushDecor(_BG.unitBox, MATS.metal, 1.52, y + 2.27, H.z2 + 0.04, 2.42, 0.07, 0.09);
  addSign(1.52, y + 2.67, H.z2 + 0.025, 3.0, 0.35, '+z', 'MECHANICAL SERVICES', { bg: '#343b37', fg: '#c9c9ae', font: 'bold 90px sans-serif' });
  // Exhaust duct and its hangers are attached to the house, above head height.
  pushDecor(_BG.unitBox, MATS.roofMetal, 5.25, y + 2.52, H.z2 + 0.23, 2.9, 0.32, 0.40);
  for (const x of [4.0, 5.1, 6.45]) {
    pushDecor(_BG.unitBox, MATS.metal, x, y + 2.52, H.z2 + 0.245, 0.035, 0.38, 0.44);
  }
  for (const x of [-1.5, 2, 5.5]) mechanicalUnit(`roof-front-hvac-${x}`, x, -8.8, 2.2, 1.2, 1.0);
  for (const x of [10.5, 14.5, 18.5]) mechanicalUnit(`roof-north-hvac-${x}`, x, -22.05, 2.4, 1.8, 1.25);
  mechanicalUnit('roof-east-air-handler', 16, -13.2, 3.3, 1.9, 1.25);

  // Raised cable trays have short feet. They do not cut through a walk lane.
  pushDecor(_BG.unitBox, MATS.roofMetal, 14.5, y + 0.32, -23.2, 11.0, 0.14, 0.24);
  for (const x of [9.2, 12.7, 16.2, 19.8]) pushDecor(_BG.unitBox, MATS.metal, x, y + 0.13, -23.2, 0.12, 0.26, 0.4);
  for (const x of [10.5, 14.5, 18.5]) pushDecor(_BG.unitBox, MATS.metal, x, y + 0.21, -23.1, 0.12, 0.20, 0.18);
  // Pallets, membrane rolls and a tool case leave the eastern escape lane open.
  for (const [px, pz] of [[23.45, -8], [9.5, -17.7]]) {
    addBox(px, y + 0.105, pz, 1.35, 0.21, 1.1, MATS.wood);
    for (let i = 0; i < 5; i++) pushDecor(_BG.unitBox, MATS.wood, px - 0.56 + i * 0.28, y + 0.24, pz, 0.20, 0.06, 1.1);
    addBox(px, y + 0.61, pz, 1.2, 0.68, 0.9, MATS.roofMetal);
    for (const dx of [-0.4, 0.4]) pushDecor(_BG.unitBox, MATS.metal, px + dx, y + 0.98, pz, 0.025, 0.035, 0.92);
  }
  // Parapet scuppers sit in the gravel perimeter, not in the traversal path.
  for (const x of [-5.7, 6.6, 22.3]) {
    const drain = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.012, 24), MATS.rubber);
    drain.position.set(x, y + 0.008, ROOF.z1 + 0.55); World.add(drain);
    for (let i = -2; i <= 2; i++) pushDecor(_BG.unitBox, MATS.metal, x + i * 0.048, y + 0.017, ROOF.z1 + 0.55, 0.017, 0.01, 0.22);
  }
}

function buildWaterTank() {
  const y = ROOF.floorY, legIds = [];
  for (const [i, [x, z]] of [[-9, -3], [-7, -3], [-9, -1], [-7, -1]].entries()) {
    const foot = `tank-foot-${i}`, leg = `tank-leg-${i}`; legIds.push(leg);
    addBox(x, y + 0.04, z, 0.32, 0.08, 0.32, MATS.metal, {
      architecture: { id: foot, kind: 'footplate', supports: ['roof-deck'] },
    });
    addBox(x, y + 1.1, z, 0.12, 2.04, 0.12, MATS.metal, {
      architecture: { id: leg, kind: 'column', supports: [foot] },
    });
  }
  const cradleIds = [];
  for (const [i, z] of [-3, -1].entries()) {
    const id = `tank-cradle-${i}`; cradleIds.push(id);
    addBox(-8, y + 2.14, z, 2.7, 0.12, 0.16, MATS.metal, {
      architecture: { id, kind: 'beam', supports: legIds.slice(i * 2, i * 2 + 2) },
    });
  }
  for (const [i, x] of [-9, -7].entries()) addBeam(`tank-brace-${i}`, [x, y + 0.1, -3], [x, y + 2.1, -1], 0.055, [legIds[i], legIds[i + 2]]);
  const barrel = new THREE.Mesh(applyWaterTankStaveUV(new THREE.CylinderGeometry(1.4, 1.4, 2.2, 48)), MATS.wood);
  barrel.position.set(-8, y + 3.3, -2); barrel.castShadow = true; barrel.receiveShadow = true; World.add(barrel);
  const bounds = boxBounds(-8, y + 3.3, -2, 2.8, 2.2, 2.8);
  Architecture.register(barrel, Colliders.addBox(bounds.min, bounds.max), bounds, { id: 'water-tank', kind: 'tank', supports: cradleIds });
  for (const dy of [-0.85, -0.3, 0.3, 0.85]) {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(1.42, 0.035, 6, 48), MATS.metal);
    hoop.rotation.x = Math.PI / 2; hoop.position.set(-8, y + 3.3 + dy, -2); World.add(hoop);
  }
  const cap = new THREE.Mesh(new THREE.ConeGeometry(1.55, 0.7, 48), MATS.roofMetal);
  cap.position.set(-8, y + 4.75, -2); cap.castShadow = true; World.add(cap);
  for (const x of [-8.3, -7.7]) pushDecor(_BG.pipe, MATS.metal, x, y + 2.3, -3.48, 0.035, 4.6, 0.035);
  for (let i = 1; i < 15; i++) pushDecor(_BG.unitBox, MATS.metal, -8, y + i * 0.3, -3.48, 0.6, 0.025, 0.025);
  pushDecor(_BG.pipe, MATS.metal, -7.75, y + 1.1, -2, 0.085, 2.2, 0.085);
}

export function buildRoof() {
  buildServiceWings();
  const y = ROOF.floorY, D = OPENINGS.stairRoof, L = ROOF.lightwell;
  rectBox(BUILDING.main, y - 0.2, 0.2, MATS.tar, {
    cast: false, architecture: { id: 'roof-deck', kind: 'deck', supports: ['main-upper-south', 'main-upper-north', 'main-upper-east'], supportKind: 'anchored' },
  });
  // At inner corners the horizontal sheet ends against the vertical sheet;
  // the vertical sheet stops at the perpendicular brick face. No faces cross.
  const sheetCorner = PARAPET_HALF_THICKNESS + FLASHING_THICKNESS;
  parapet('roof-north-parapet', ROOF.x1, ROOF.z1, ROOF.x2, ROOF.z1, ['roof-annex-north-deck'], 1.2,
    { roofSide: 1, flashingStartInset: sheetCorner, flashingEndInset: sheetCorner });
  parapet('roof-west-north-parapet', ROOF.x1, ROOF.z1, ROOF.x1, D.min[2], ['roof-annex-north-deck', 'roof-annex-west-link-deck', 'roof-deck'], 1.2,
    { roofSide: 1, westX: STAIRS.roofThreshold.wallExteriorX, flashingStartInset: PARAPET_HALF_THICKNESS, flashingEndInset: 0.02 });
  parapet('roof-west-south-parapet', ROOF.x1, D.max[2], ROOF.x1, ROOF.z2, ['roof-deck'], 1.2,
    { roofSide: 1, westX: STAIRS.roofThreshold.wallExteriorX, flashingStartInset: 0.02, flashingEndInset: PARAPET_HALF_THICKNESS });
  parapet('roof-east-parapet', ROOF.x2, ROOF.z1, ROOF.x2, ROOF.z2, ['roof-annex-north-deck', 'roof-annex-east-link-deck', 'roof-annex-east-deck'], 1.2,
    { roofSide: -1, flashingStartInset: PARAPET_HALF_THICKNESS });
  parapet('roof-south-parapet', ROOF.x1, ROOF.z2, ROOF.exit.x1, ROOF.z2, ['roof-deck', 'roof-annex-east-deck'], 1.2,
    { roofSide: -1, flashingStartInset: sheetCorner });
  // All four lightwell edges have visible guards, and none covers the opening.
  parapet('lightwell-north-guard', L.x1, L.z1, L.x2, L.z1, ['roof-annex-north-deck'], 1.1, { roofSide: -1 });
  parapet('lightwell-west-guard', L.x1, L.z1, L.x1, L.z2, ['roof-annex-west-link-deck'], 1.1, { roofSide: -1 });
  parapet('lightwell-east-guard', L.x2, L.z1, L.x2, L.z2, ['roof-annex-east-link-deck'], 1.1, { roofSide: 1 });
  parapet('lightwell-south-guard', L.x1, L.z2, L.x2, L.z2, ['roof-deck'], 1.1, { roofSide: 1 });

  addDecor(5, y + 0.008, ROOF.z1 + 0.48, 39.4, 0.014, 0.55, MATS.gravel);
  addDecor(ROOF.x2 - 0.48, y + 0.008, -12, 0.55, 0.014, 23, MATS.gravel);
  addDecor(-14.52, y + 0.008, -17.0, 0.55, 0.014, 12.5, MATS.gravel);
  buildMechanicalYard();
  buildWaterTank();

  // A fitted edge cover bridges the masonry/annex-deck junction. Its folded
  // depth and overlapping ends put a single physical finish in front of the
  // coincident brick and tar edge without changing either structural solid.
  pushDecor(_BG.unitBox, MATS.roofMetal, BUILDING.main.x2, y - 0.1, 0.01, 0.32, 0.24, 0.02);
  addBox(22, y - 0.045, 0.07, 5.8, 0.09, 0.34, MATS.roofMetal, {
    collide: false,
    architecture: {
      id: 'roof-scaffold-threshold', kind: 'threshold', supportKind: 'anchored',
      supports: ['roof-annex-east-deck'],
    },
  });
  addSign(17.6, y + 0.73, -0.145, 2.4, 0.40, '-z', 'SCAFFOLD ACCESS →', { bg: '#483e29', fg: '#e6d5a0', font: 'bold 92px sans-serif' });
  addSign(-11.1, y + 0.64, L.z2 + 0.145, 2.0, 0.31, '+z', 'OPEN LIGHTWELL', { bg: '#40392c', fg: '#ded0a9', font: 'bold 92px sans-serif' });
  const bulbMaterial = new THREE.MeshStandardMaterial({ color: 0xdad3bb, emissive: 0xe1b578, emissiveIntensity: 1.1, roughness: 0.5 });
  for (const [x, z, facing] of [[-14.9, -3.7, 1], [6.4, -9.85, 0]]) {
    addDecor(x, y + 2.0, z, facing ? 0.1 : 0.28, 0.26, facing ? 0.28 : 0.1, MATS.roofMetal);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), bulbMaterial);
    bulb.position.set(x + facing * 0.1, y + 1.99, z + (1 - facing) * 0.1); World.add(bulb);
    const light = new THREE.PointLight(0xe1bb80, 1.5, 12, 1.8); light.position.copy(bulb.position); World.add(light);
  }
  Triggers.add('roof', new THREE.Vector3(ROOF.x1 + 0.3, y, ROOF.z1 + 0.3),
    new THREE.Vector3(ROOF.x2 - 0.3, y + 4, ROOF.z2 - 0.3));
}
