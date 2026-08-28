import * as THREE from 'three';
import { MATS } from '../../render/materials.js';
import { _BG, pushDecor } from '../../render/models.js';
import { SCAFFOLD_LEVELS, SCAFFOLD_TRIGGER_MIN_Z } from '../layout.js';
import { addBeam, addProtectiveScreen } from '../structures.js';
import { World, Triggers, addBox, addDecor, addSign } from '../world.js';

// Dense 2.45 m bays carry the offset decks. The x=24 street exit falls
// between standards; the two middle rows limit the transom spans as well.
const FRAME_X = Array.from({ length: 11 }, (_, i) => 7.75 + i * 2.45);
const FRAME_Z = [0.16, 2.2, 5.9, 7.7];
const LANES = [3.2, 4.2, 4.5, 5.2];
const POST_BOTTOM = 0.2, POST_TOP = 13.85;
const GALLERY_LOWER_TOP = 3.65, GALLERY_UPPER_BOTTOM = 6.86;

function buildStandards() {
  const rows = FRAME_Z.map(() => []);
  // Build the outboard rows first: they carry the consoles above the gallery.
  for (const row of [1, 2, 3, 0]) {
    const z = FRAME_Z[row];
    for (const [column, x] of FRAME_X.entries()) {
      const footId = `scaffold-foot-${row}-${column}`;
      const postId = `scaffold-post-${row}-${column}`;
      addBox(x, 0.17, z, 0.32, 0.06, 0.28, MATS.metal, {
        cast: false,
        architecture: { id: footId, kind: 'footplate', supports: ['near-apron'] },
      });
      const post = (id, low, high, supports) => addBox(x, (low + high) / 2, z, 0.1, high - low, 0.1, MATS.metal, {
        cast: false, architecture: { id, kind: 'standard', supports },
      });
      if (row === 0 && x < 13) {
        // The balcony is a real passage through this frame. Its rail extends
        // to y=6.7, so even the console underside must remain above that.
        const lowerId = `${postId}-lower`, upperId = `${postId}-upper`;
        const consoleId = `scaffold-gallery-console-${column}`;
        post(lowerId, POST_BOTTOM, GALLERY_LOWER_TOP, [footId]);
        addBox(x, 6.84, (FRAME_Z[0] + FRAME_Z[1]) / 2, 0.18, 0.18, FRAME_Z[1] - FRAME_Z[0], MATS.metal, {
          cast: false,
          architecture: { id: consoleId, kind: 'transom', supports: [rows[1][column].id], supportKind: 'anchored' },
        });
        post(upperId, GALLERY_UPPER_BOTTOM, POST_TOP, [consoleId]);
        rows[row].push({ id: upperId, lowerId });
      } else {
        post(postId, POST_BOTTOM, POST_TOP, [footId]);
        rows[row].push({ id: postId });
      }
    }
  }
  return rows;
}

function supportColumns(level) {
  let first = 0, last = FRAME_X.length - 1;
  while (first + 1 < FRAME_X.length && FRAME_X[first + 1] <= level.x1) first++;
  while (last > 0 && FRAME_X[last - 1] >= level.x2) last--;
  return { first, last };
}

function addDeck(index, level, rows) {
  const { first, last } = supportColumns(level);
  const ledgers = [];
  for (const [row, z] of FRAME_Z.entries()) {
    const id = `scaffold-ledger-${index}-${row}`;
    const supports = rows[row].slice(first, last + 1).map(post => level.y < 4 ? (post.lowerId ?? post.id) : post.id);
    // One visible member per row keeps draw calls bounded. Couplers at every
    // standard describe the modular sections; no unsupported bay exceeds 2.45 m.
    addBox((FRAME_X[first] + FRAME_X[last]) / 2, level.y - 0.17, z, FRAME_X[last] - FRAME_X[first], 0.14, 0.12, MATS.metal, {
      cast: false,
      architecture: { id, kind: 'ledger', supports, supportKind: 'anchored' },
    });
    ledgers.push(id);
    for (let column = first; column <= last; column++) {
      pushDecor(_BG.unitBox, MATS.metal, FRAME_X[column], level.y - 0.17, z, 0.17, 0.19, 0.17);
    }
  }

  const transoms = [], count = Math.ceil((level.x2 - level.x1 - 0.24) / 2.75);
  for (let i = 0; i <= count; i++) {
    const x = level.x1 + 0.12 + (level.x2 - level.x1 - 0.24) * i / count;
    const id = `scaffold-transom-${index}-${i}`;
    addBox(x, level.y - 0.155, (FRAME_Z[0] + FRAME_Z[3]) / 2, 0.15, 0.15, FRAME_Z[3] - FRAME_Z[0], MATS.metal, {
      cast: false,
      architecture: { id, kind: 'transom', supports: ledgers, supportKind: 'anchored' },
    });
    transoms.push(id);
  }
  const id = `scaffold-deck-${index}`;
  const cx = (level.x1 + level.x2) / 2, cz = (level.z1 + level.z2) / 2;
  addBox(cx, level.y - 0.05, cz, level.x2 - level.x1, 0.1, level.z2 - level.z1, MATS.wood, {
    architecture: { id, kind: 'deck', supports: transoms },
  });
  // Thin flush joins read as supported planks without catchable collision lips.
  for (let z = level.z1 + 0.28; z < level.z2; z += 0.28) {
    pushDecor(_BG.unitBox, MATS.metal, cx, level.y + 0.001, z, level.x2 - level.x1, 0.002, 0.008);
  }
  for (let column = first + 1; column < last; column++) {
    if (FRAME_X[column] <= level.x1 || FRAME_X[column] >= level.x2) continue;
    pushDecor(_BG.unitBox, MATS.metal, FRAME_X[column], level.y + 0.001, cz, 0.009, 0.002, level.z2 - level.z1);
  }

  const guard = (name, from, to) => addProtectiveScreen(`scaffold-guard-${index}-${name}`, from, to, level.y, 1.1, [id], { mesh: false });
  // Roof entry, alternating end drops and the final front exit have actual
  // gaps in both the visible rails and their colliders.
  if (index === 0) {
    guard('rear-west', [level.x1, level.z1], [19, level.z1]);
    guard('rear-east', [25, level.z1], [level.x2, level.z1]);
  } else guard('rear', [level.x1, level.z1], [level.x2, level.z1]);
  if (index === 3) {
    guard('front-west', [level.x1, level.z2], [22.6, level.z2]);
    guard('front-east', [25.4, level.z2], [level.x2, level.z2]);
  } else guard('front', [level.x1, level.z2], [level.x2, level.z2]);
  for (const [side, x] of [['west', level.x1], ['east', level.x2]]) {
    const open = index < 3 && side === (index === 1 ? 'east' : 'west');
    if (open) {
      guard(`${side}-rear`, [x, level.z1], [x, LANES[index] - 1.0]);
      guard(`${side}-front`, [x, LANES[index] + 1.0], [x, level.z2]);
    } else guard(side, [x, level.z1], [x, level.z2]);
  }
  return ledgers;
}

function addWorkbench(index, x, z) {
  const level = SCAFFOLD_LEVELS[index], legs = [];
  for (const [i, [dx, dz]] of [[-0.73, -0.27], [0.73, -0.27], [-0.73, 0.27], [0.73, 0.27]].entries()) {
    const id = `scaffold-workbench-leg-${index}-${i}`;
    addBox(x + dx, level.y + 0.35, z + dz, 0.07, 0.7, 0.07, MATS.metal, {
      architecture: { id, kind: 'leg', supports: [`scaffold-deck-${index}`] },
    });
    legs.push(id);
  }
  addBox(x, level.y + 0.745, z, 1.65, 0.09, 0.72, MATS.wood, {
    architecture: { id: `scaffold-workbench-${index}`, kind: 'worktop', supports: legs },
  });
  pushDecor(_BG.unitBox, MATS.metal, x, level.y + 0.2, z - 0.27, 1.5, 0.07, 0.05);
  pushDecor(_BG.unitBox, MATS.rubber, x - 0.3, level.y + 0.88, z, 0.58, 0.18, 0.38);
  pushDecor(_BG.unitBox, MATS.metal, x - 0.3, level.y + 0.99, z, 0.22, 0.05, 0.07);
  pushDecor(_BG.unitBox, MATS.metal, x + 0.43, level.y + 0.803, z + 0.08, 0.4, 0.026, 0.09, 0.24);
}

function addSupplyPallet(index, suffix, x, z, width = 1.45) {
  const level = SCAFFOLD_LEVELS[index], runners = [];
  for (const [i, dx] of [-width * 0.4, 0, width * 0.4].entries()) {
    const id = `scaffold-pallet-${index}-${suffix}-runner-${i}`;
    addBox(x + dx, level.y + 0.06, z, 0.11, 0.12, 0.74, MATS.wood, {
      cast: false, architecture: { id, kind: 'pallet', supports: [`scaffold-deck-${index}`] },
    });
    runners.push(id);
  }
  const topId = `scaffold-pallet-${index}-${suffix}-top`;
  addBox(x, level.y + 0.15, z, width, 0.06, 0.8, MATS.wood, {
    cast: false, architecture: { id: topId, kind: 'pallet', supports: runners },
  });
  const caseWidth = width - 0.2;
  addBox(x, level.y + 0.43, z, caseWidth, 0.5, 0.63, MATS.rubber, {
    architecture: { id: `scaffold-supplies-${index}-${suffix}`, kind: 'supplies', supports: [topId] },
  });
  for (const dx of [-caseWidth * 0.32, caseWidth * 0.32]) {
    pushDecor(_BG.unitBox, MATS.metal, x + dx, level.y + 0.43, z + 0.321, 0.035, 0.5, 0.012);
    pushDecor(_BG.unitBox, MATS.metal, x + dx, level.y + 0.687, z, 0.035, 0.014, 0.64);
  }
}

function addBracing(rows) {
  const bands = [[0.3, 3.7], [4.3, 6.7], [7.3, 9.7], [10.3, 13.5]];
  for (const [band, [low, high]] of bands.entries()) {
    // The front bay containing x=24 is deliberately unbraced: it is the
    // bottom deck's street exit, not merely a gap in its guard rail.
    for (const column of [0, 3, 5, 8, 9]) {
      const x1 = FRAME_X[column], x2 = FRAME_X[column + 1];
      addBeam(`scaffold-front-brace-${band}-${column}`, [x1, band % 2 ? high : low, FRAME_Z[3]], [x2, band % 2 ? low : high, FRAME_Z[3]], 0.055, [rows[3][column].id, rows[3][column + 1].id]);
    }
    for (const [side, column] of [[0, 0], [1, FRAME_X.length - 1]]) {
      // The west return starts outside the balcony; it never crosses its
      // occupied height even when the diagonal spans y=4..6.7.
      const firstRow = side === 0 ? 1 : 0;
      addBeam(`scaffold-return-brace-${side}-${band}`, [FRAME_X[column], low, FRAME_Z[firstRow]], [FRAME_X[column], high, FRAME_Z[3]], 0.055, [rows[firstRow][column].id, rows[3][column].id]);
    }
  }
  for (const [column, x] of FRAME_X.entries()) {
    if (x > 25) continue; // The return beyond the annex is a grounded frame.
    for (const y of [7.8, 13.3]) {
      addBeam(`scaffold-wall-tie-${column}-${y}`, [x, y, -0.04], [x, y, FRAME_Z[0] + 0.05], 0.12, [x < 13 ? 'main-upper-south' : 'roof-annex-east-south-wall', rows[0][column].id]);
    }
  }
}

function addWorksiteDetails(ledgerIds, rows) {
  // These pockets are clear of all five authored spawn positions on each
  // deck, the entire centre lanes, the checkpoint and every descent landing.
  addWorkbench(0, 25.65, 1.35);
  addSupplyPallet(0, 'front', 18, 4.9, 1.35);
  addSupplyPallet(1, 'rear', 11.4, 1.85, 1.15);
  addWorkbench(2, 28.7, 2.65);
  addSupplyPallet(2, 'front', 20.5, 6.5);
  addSupplyPallet(3, 'rear', 15.1, 3.1);
  addSupplyPallet(3, 'front', 18.8, 7.05);

  const drapeMaterial = new THREE.MeshStandardMaterial({ color: 0x586152, roughness: 0.96, side: THREE.DoubleSide });
  // Mount the cloth 2 cm beyond the outer faces of the 17 cm couplers. The
  // transoms, ledgers and original tie anchors stay fixed; short clips bridge
  // to the hem instead of leaving cloth in a metal end-face plane.
  const drapeZ = FRAME_Z[3] + 0.17 / 2 + 0.02;
  for (const i of [0, 2]) {
    const level = SCAFFOLD_LEVELS[i];
    const x = level.x2 - 1.4;
    const drape = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.3), drapeMaterial);
    drape.name = `scaffold-drape-${i}`;
    drape.position.set(x, level.y - 0.82, drapeZ); World.add(drape);
    const tieId = `scaffold-drape-tie-${i}`;
    addBeam(tieId, [x - 1.2, level.y - 0.17, FRAME_Z[3]], [x + 1.2, level.y - 0.17, FRAME_Z[3]], 0.04, [ledgerIds[i][3]]);
    for (const [side, offset] of [['left', -1.1], ['right', 1.1]]) {
      addBeam(`scaffold-drape-clip-${i}-${side}`, [x + offset, level.y - 0.17, FRAME_Z[3]],
        [x + offset, level.y - 0.17, drapeZ + 0.02], 0.035, [tieId]);
    }
  }
  // Small working lights have visible brackets, share the global practical
  // light budget and cast no additional shadow maps.
  const column = 7, x = FRAME_X[column];
  addDecor(x, 11.55, 0.34, 0.28, 0.18, 0.16, MATS.metal);
  addBeam('scaffold-light-arm', [x, 11.55, FRAME_Z[0]], [x, 11.55, 0.34], 0.04, [rows[0][column].id]);
  const light = new THREE.PointLight(0xffd5a5, 1.0, 11, 1.6);
  light.position.set(x, 11.5, 0.46); World.add(light);

  for (const [i, level] of SCAFFOLD_LEVELS.entries()) {
    // Placards sit on the rear guard, away from openings and firing lanes.
    const xSign = i === 0 ? 16.6 : level.x1 + 1.5;
    addDecor(xSign, level.y + 0.65, level.z1 + 0.045, 1.05, 0.48, 0.035, MATS.metal);
    const sign = addSign(xSign, level.y + 0.65, level.z1 + 0.065, 1.0, 0.43, '+z',
      i === 3 ? 'STREET EXIT →' : `${i === 1 ? 'EAST' : 'WEST'} DROP · ${4 - i}`, { bg: '#343b37', fg: '#d5c892', font: 'bold 25px sans-serif' });
    sign.name = `scaffold-route-sign-${i}`;
  }
}

function buildScaffolding() {
  const rows = buildStandards();
  const ledgerIds = SCAFFOLD_LEVELS.map((level, index) => addDeck(index, level, rows));
  addBracing(rows);
  addWorksiteDetails(ledgerIds, rows);
  Triggers.add('scaffolding', new THREE.Vector3(7.65, 0.5, SCAFFOLD_TRIGGER_MIN_Z), new THREE.Vector3(32.35, 12, 8.1));
}

export { buildScaffolding };
