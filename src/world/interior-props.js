import { furnitureBox, furnitureLeg, furniturePiping, furnitureKnob, furnitureCup, furnitureCupHandle } from '../render/furniture-geometry.js';
import { getFurnitureMaterials } from '../render/furniture-materials.js';
import { createInteriorStoryDetails } from './interior-story-details.js';

const QUARTER_TURN = Math.PI / 2;

/**
 * Injected, deterministic furniture builders. Positions are floor centres;
 * width/depth/height describe the solid body, with local +Z facing the room.
 * Surface details project at most 9% of depth and 3% of height beyond it.
 */
export function createInteriorProps({ addBox, pushDecor, boxGeometry, pipeGeometry, materials }) {
  const finishes = getFurnitureMaterials();
  const story = createInteriorStoryDetails({ pushDecor, materials });
  const meters = material => material.userData?.surfaceMeters ?? 1;

  function refineMesh(mesh, { radius = 0.008, segments = 1, material = mesh?.material, leg = false } = {}) {
    if (!mesh?.isMesh || mesh.geometry.type !== 'BoxGeometry') return mesh;
    const { width, height, depth } = mesh.geometry.parameters;
    const original = mesh.geometry;
    mesh.geometry = leg ? furnitureLeg(width, height, depth, meters(material))
      : furnitureBox(width, height, depth, radius, meters(material), segments);
    mesh.material = material;
    mesh.userData.furnitureShape = mesh.geometry.userData.furnitureShape;
    original.dispose(); // addBox created this unshared source, before any GPU upload.
    return mesh;
  }

  function roundedDetail(material, x, y, z, width, height, depth, radius = 0.008, segments = 1) {
    pushDecor(furnitureBox(width, height, depth, radius, meters(material), segments), material, x, y, z, 1, 1, 1);
  }

  function fixture(options, defaults, material) {
    const { id, x, z, floorY, yaw = 0, floorId,
      width = defaults[0], depth = defaults[1], height = defaults[2] } = options;
    if (![x, z, floorY, yaw, width, depth, height].every(Number.isFinite)
      || width <= 0 || depth <= 0 || height <= 0) {
      throw new RangeError('Furniture requires finite positions and positive dimensions');
    }
    const turns = Math.round(yaw / QUARTER_TURN);
    if (Math.abs(yaw - turns * QUARTER_TURN) > 1e-8) {
      throw new RangeError('Furniture yaw must be a multiple of PI / 2');
    }
    if (floorId && !id) throw new TypeError('Supported furniture requires an id');
    const turn = ((turns % 4) + 4) % 4;
    const c = [1, 0, -1, 0][turn], s = [0, 1, 0, -1][turn];
    const body = addBox(x, floorY + height / 2, z,
      turn % 2 ? depth : width, height, turn % 2 ? width : depth, material,
      floorId ? { architecture: { id, kind: 'furniture', supports: [floorId] } } : {});

    // Local dimensions are fractions of the body, so overrides scale details too.
    function part(geometry, mat, px, py, pz, sx, sy, sz) {
      pushDecor(geometry, mat,
        x + px * width * c + pz * depth * s, floorY + py * height,
        z - px * width * s + pz * depth * c,
        sx * width, sy * height, sz * depth, turn * QUARTER_TURN);
    }
    return {
      body, part,
      box: (mat, ...dimensions) => part(boxGeometry, mat, ...dimensions),
      pipe: (mat, ...dimensions) => part(pipeGeometry, mat, ...dimensions),
      knob: (mat, ...dimensions) => part(furnitureKnob(), mat, ...dimensions),
      rounded(mat, px, py, pz, sx, sy, sz, radius = 0.008) {
        part(furnitureBox(sx * width, sy * height, sz * depth, radius, meters(mat), 1, true),
          mat, px, py, pz, sx, sy, sz);
      },
      detail(geometry, mat, px, py, pz) {
        part(geometry, mat, px, py, pz, 1 / width, 1 / height, 1 / depth);
      },
      width, height, depth,
    };
  }

  function refrigerator(options) {
    const enamel = materials.enamel ?? materials.plaster;
    const seal = materials.rubber ?? materials.tar;
    const appliance = fixture(options, [0.68, 0.72, 1.85], enamel);
    const { body, box, rounded, knob } = appliance;
    refineMesh(body, { radius: 0.028, segments: 2 });
    // Dark gaskets separate the freezer, main door, and compressor grille.
    box(seal, 0, 0.50, 0.506, 0.96, 0.94, 0.012);
    rounded(enamel, 0, 0.365, 0.527, 0.94, 0.55, 0.030, 0.015);
    rounded(enamel, 0, 0.805, 0.527, 0.94, 0.31, 0.030, 0.015);
    box(seal, 0, 0.048, 0.516, 0.88, 0.056, 0.008);
    for (const y of [0.025, 0.035, 0.045, 0.055, 0.065]) {
      box(finishes.hardware, 0, y, 0.520, 0.88, 0.004, 0.016);
    }
    for (const [y, length] of [[0.365, 0.23], [0.805, 0.12]]) {
      for (const end of [-1, 1]) {
        rounded(finishes.hardware, -0.34, y + end * (length / 2 - 0.012), 0.553,
          0.030, 0.024, 0.022, 0.004);
      }
      rounded(finishes.hardware, -0.34, y, 0.575, 0.025, length, 0.022, 0.004);
    }
    story.fridgeNote(appliance, options.id?.startsWith('neighbor'));
    knob(finishes.hardware, 0.19, 0.85, 0.546, 0.033, 0.018, 0.004);
    return body;
  }

  function stove(options) {
    const enamel = materials.enamel ?? materials.plaster;
    const seal = materials.rubber ?? materials.tar;
    const { body, box, pipe, rounded, knob } = fixture(options, [0.72, 0.68, 0.92], enamel);
    refineMesh(body, { radius: 0.014 });
    box(seal, 0, 0.44, 0.506, 0.92, 0.64, 0.012);
    rounded(enamel, 0, 0.44, 0.524, 0.88, 0.60, 0.024, 0.012);
    rounded(finishes.glazing, 0, 0.42, 0.539, 0.72, 0.36, 0.006, 0.009);
    rounded(finishes.hardware, 0, 0.68, 0.553, 0.68, 0.035, 0.034, 0.010);
    box(seal, 0, 0.86, 0.506, 0.91, 0.15, 0.012);
    for (const x of [-0.30, -0.10, 0.10, 0.30]) {
      knob(finishes.hardware, x, 0.86, 0.536, 0.07, 0.060, 0.048);
      box(finishes.linen, x, 0.873, 0.562, 0.008, 0.025, 0.004);
    }
    rounded(enamel, 0, 1.004, 0, 0.94, 0.008, 0.92, 0.008);
    for (const x of [-0.32, -0.16, 0, 0.16, 0.32]) box(seal, x, 0.758, 0.541, 0.11, 0.006, 0.006);
    for (const x of [-0.23, 0.23]) {
      for (const z of [-0.23, 0.23]) {
        // The cached pipe has unit radius, not unit diameter.
        pipe(finishes.hardware, x, 1.012, z, 0.10, 0.008, 0.10);
        pipe(seal, x, 1.017, z, 0.075, 0.002, 0.075);
        box(finishes.hardware, x, 1.020, z, 0.22, 0.004, 0.018);
        box(finishes.hardware, x, 1.020, z, 0.018, 0.004, 0.22);
      }
    }
    box(seal, 0, 0.065, 0.506, 0.88, 0.035, 0.012);
    return body;
  }

  function sideboard(options) {
    const { body, box, rounded } = fixture(options, [1.6, 0.42, 1.0], finishes.wood);
    refineMesh(body, { radius: 0.006 });
    box(materials.rubber ?? materials.tar, 0, 0.045, 0.506, 0.94, 0.09, 0.012);
    box(materials.rubber ?? materials.tar, 0, 0.53, 0.506, 0.95, 0.84, 0.012);
    for (const x of [-0.237, 0.237]) {
      rounded(finishes.wood, x, 0.41, 0.524, 0.45, 0.58, 0.024, 0.005);
      rounded(finishes.wood, x, 0.82, 0.524, 0.45, 0.18, 0.024, 0.005);
      rounded(finishes.hardware, x, 0.82, 0.556, 0.09, 0.026, 0.040, 0.004);
      rounded(finishes.hardware, x * 0.20, 0.59, 0.556, 0.018, 0.09, 0.040, 0.004);
    }
    // Thin edge trim remains inside the carcass's width and depth.
    rounded(finishes.wood, 0, 1.008, 0, 1, 0.016, 1, 0.006);
    return body;
  }

  function bookcase(options) {
    const cabinet = fixture(options, [1.4, 0.36, 2.1], finishes.wood);
    const { body, box } = cabinet;
    refineMesh(body, { radius: 0.006 });
    // A solid cabinet explains the collision; shallow relief reads as shelves.
    box(materials.rubber ?? materials.tar, 0, 0.50, 0.506, 0.92, 0.90, 0.012);
    for (const x of [-0.46, 0.46]) {
      box(finishes.wood, x, 0.50, 0.538, 0.04, 0.94, 0.052);
    }
    const shelfHeights = [0.055, 0.275, 0.495, 0.715, 0.935];
    for (const y of shelfHeights) box(finishes.wood, 0, y, 0.538, 0.94, 0.028, 0.052);
    story.bookcaseContents(cabinet, options.id);
    return body;
  }

  function bench(options) {
    const { body, box, rounded } = fixture(options, [1.2, 0.42, 0.45], finishes.wood);
    refineMesh(body, { radius: 0.006 });
    // A storage bench has a grounded, closed base rather than invisible legs.
    box(materials.tar, 0, 0.46, 0.506, 0.94, 0.64, 0.012);
    for (let i = 0; i < 9; i++) {
      box(finishes.wood, -0.40 + i * 0.10, 0.46, 0.524, 0.09, 0.60, 0.024);
    }
    box(materials.tar, 0, 1.003, 0, 1, 0.006, 1);
    for (const z of [-0.375, -0.125, 0.125, 0.375]) {
      rounded(finishes.wood, 0, 1.016, z, 1, 0.020, 0.23, 0.004);
    }
    for (const x of [-0.30, 0.30]) {
      box(finishes.hardware, x, 1.028, -0.46, 0.07, 0.004, 0.05);
    }
    rounded(finishes.hardware, 0, 0.72, 0.555, 0.18, 0.06, 0.038, 0.006);
    return body;
  }

  function upholsteredSeat({ id, x, z, floorY, floorId, width, depth, palette = 'warm', throwSide = -1 }) {
    const cloth = palette === 'cool' ? story.materials.upholsteryCool : story.materials.upholsteryWarm;
    const body = addBox(x, floorY + 0.25, z, width, 0.5, depth, cloth, {
      architecture: { id, kind: 'furniture', supports: [floorId] },
    });
    refineMesh(body, { radius: 0.04, segments: 2 });
    const back = addBox(x, floorY + 0.8, z - depth / 2 + 0.09, width, 0.6, 0.18, cloth, {
      architecture: { id: `${id}-back`, kind: 'furniture', supports: [id] },
    });
    refineMesh(back, { radius: 0.070, segments: 2 });
    for (const [index, side] of [-1, 1].entries()) {
      const arm = addBox(x + side * (width / 2 - 0.065), floorY + 0.64, z, 0.13, 0.28, depth, cloth, {
        architecture: { id: `${id}-arm-${index}`, kind: 'furniture', supports: [id] },
      });
      refineMesh(arm, { radius: 0.055, segments: 2 });
    }
    // A timber plinth, fitted upholstery and separate back cushions explain
    // the closed original carcass; no invisible holes or new movement boxes.
    roundedDetail(finishes.wood, x, floorY + 0.07, z + depth / 2 - 0.004,
      width - 0.08, 0.07, 0.012, 0.004);
    for (const side of [-1, 1]) roundedDetail(finishes.wood, x + side * (width / 2 - 0.004),
      floorY + 0.07, z, 0.012, 0.07, depth - 0.08, 0.004);
    const count = width > 1.2 ? 2 : 1, pitch = (width - 0.30) / count;
    for (let index = 0; index < count; index++) {
      const cx = x + (index - (count - 1) / 2) * pitch, cushionWidth = pitch - 0.025;
      roundedDetail(cloth, cx, floorY + 0.545, z + 0.07, cushionWidth, 0.09, depth - 0.23, 0.04, 2);
      pushDecor(furniturePiping(cushionWidth, depth - 0.23, 0.04, 0.0024, 'xz', meters(finishes.linen)),
        finishes.linen, cx, floorY + 0.548, z + 0.07, 1, 1, 1);
      const padZ = z - depth / 2 + 0.205;
      roundedDetail(cloth, cx, floorY + 0.825, padZ, cushionWidth, 0.47, 0.08, 0.037, 2);
      pushDecor(furniturePiping(cushionWidth - 0.09, 0.38, 0.025, 0.0022, 'xy', meters(finishes.linen)),
        finishes.linen, cx, floorY + 0.825, padZ + 0.0395, 1, 1, 1);
    }
    if (width > 1.2) {
      story.foldedThrow({ x: x + throwSide * pitch / 2, z: z + 0.085, topY: floorY + 0.59,
        width: Math.min(0.32, pitch - 0.08), variant: palette === 'cool' ? 1 : 0 });
    }
    return body;
  }

  function bedding({ name, x, y, z, width, height, depth, radius }) {
    const mesh = addBox(x, y, z, width, height, depth, finishes.linen, { collide: false });
    mesh.name = name;
    refineMesh(mesh, { radius, segments: 2 });
    pushDecor(furniturePiping(width, depth, radius, 0.0023, 'xz', meters(finishes.linen)),
      finishes.linen, x, y, z, 1, 1, 1);
    return mesh;
  }

  function chair({ x, z, floorY, facing }) {
    const seat = addBox(x, floorY + 0.415, z, 0.4, 0.05, 0.4, finishes.wood);
    refineMesh(seat, { radius: 0.018, segments: 2 });
    // Keep the solid back and its middle contact face; rounding and edge rails
    // make the thin board read as a curved dining-chair shell.
    roundedDetail(finishes.wood, x - facing * 0.19, floorY + 0.72, z, 0.05, 0.60, 0.4, 0.023, 2);
    for (const dx of [-0.15, 0.15]) {
      for (const dz of [-0.15, 0.15]) pushDecor(furnitureLeg(0.055, 0.39, 0.055, meters(finishes.wood)),
        finishes.wood, x + dx, floorY + 0.195, z + dz, 1, 1, 1);
    }
    // Stretchers sit below the pre-existing open middle-leg shooting lane.
    for (const dx of [-0.15, 0.15]) roundedDetail(finishes.wood, x + dx, floorY + 0.13, z,
      0.024, 0.024, 0.30, 0.006);
    for (const side of [-1, 1]) roundedDetail(finishes.wood, x - facing * 0.161, floorY + 0.735,
      z + side * 0.164, 0.013, 0.49, 0.025, 0.006);
    return seat;
  }

  function tableSetting({ x, z, topY }) {
    roundedDetail(finishes.wood, x + 0.29, topY + 0.005, z + 0.04, 0.125, 0.010, 0.125, 0.025);
    pushDecor(furnitureCup(), materials.enamel ?? finishes.linen, x + 0.29, topY + 0.010, z + 0.04, 1, 1, 1);
    pushDecor(furnitureCupHandle(), materials.enamel ?? finishes.linen,
      x + 0.3292, topY + 0.067, z + 0.04, 1, 1, 1);
    story.closedBook({ x: x - 0.21, z: z - 0.015, topY, variant: 3 });
  }

  return { refrigerator, stove, sideboard, bookcase, bench, upholsteredSeat, bedding, chair,
    refineMesh, roundedDetail, tableSetting, finishes, story };
}
