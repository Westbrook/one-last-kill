const QUARTER_TURN = Math.PI / 2;

/**
 * Injected, deterministic furniture builders. Positions are floor centres;
 * width/depth/height describe the solid body, with local +Z facing the room.
 * Surface details project at most 9% of depth and 3% of height beyond it.
 */
export function createInteriorProps({ addBox, pushDecor, boxGeometry, pipeGeometry, materials }) {
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
      body,
      box: (mat, ...dimensions) => part(boxGeometry, mat, ...dimensions),
      pipe: (mat, ...dimensions) => part(pipeGeometry, mat, ...dimensions),
    };
  }

  function refrigerator(options) {
    const { body, box } = fixture(options, [0.68, 0.72, 1.85], materials.metal);
    // Dark gaskets separate the freezer, main door, and compressor grille.
    box(materials.tar, 0, 0.50, 0.506, 0.96, 0.94, 0.012);
    box(materials.plaster, 0, 0.365, 0.527, 0.94, 0.55, 0.030);
    box(materials.plaster, 0, 0.805, 0.527, 0.94, 0.31, 0.030);
    for (const y of [0.032, 0.048, 0.064]) {
      box(materials.metal, 0, y, 0.520, 0.88, 0.006, 0.016);
    }
    for (const [y, length] of [[0.365, 0.23], [0.805, 0.12]]) {
      for (const end of [-1, 1]) {
        box(materials.metal, -0.34, y + end * (length / 2 - 0.012), 0.553,
          0.030, 0.024, 0.022);
      }
      box(materials.metal, -0.34, y, 0.575, 0.025, length, 0.022);
    }
    box(materials.wallpaper, 0.20, 0.81, 0.543, 0.20, 0.11, 0.002);
    box(materials.metal, 0.19, 0.85, 0.546, 0.033, 0.018, 0.004);
    return body;
  }

  function stove(options) {
    const { body, box, pipe } = fixture(options, [0.72, 0.68, 0.92], materials.metal);
    box(materials.tar, 0, 0.44, 0.506, 0.92, 0.64, 0.012);
    box(materials.plaster, 0, 0.44, 0.524, 0.88, 0.60, 0.024);
    box(materials.tar, 0, 0.42, 0.539, 0.72, 0.36, 0.006);
    box(materials.metal, 0, 0.68, 0.553, 0.68, 0.035, 0.034);
    box(materials.tar, 0, 0.86, 0.506, 0.91, 0.15, 0.012);
    for (const x of [-0.30, -0.10, 0.10, 0.30]) {
      box(materials.plaster, x, 0.86, 0.536, 0.07, 0.060, 0.048);
      box(materials.metal, x, 0.873, 0.562, 0.008, 0.025, 0.004);
    }
    box(materials.tar, 0, 1.004, 0, 0.94, 0.008, 0.92);
    for (const x of [-0.23, 0.23]) {
      for (const z of [-0.23, 0.23]) {
        // The cached pipe has unit radius, not unit diameter.
        pipe(materials.metal, x, 1.012, z, 0.10, 0.008, 0.10);
        pipe(materials.tar, x, 1.017, z, 0.075, 0.002, 0.075);
        box(materials.metal, x, 1.020, z, 0.22, 0.004, 0.018);
        box(materials.metal, x, 1.020, z, 0.018, 0.004, 0.22);
      }
    }
    box(materials.tar, 0, 0.065, 0.506, 0.88, 0.035, 0.012);
    return body;
  }

  function sideboard(options) {
    const { body, box } = fixture(options, [1.6, 0.42, 1.0], materials.wood);
    box(materials.tar, 0, 0.045, 0.506, 0.94, 0.09, 0.012);
    box(materials.tar, 0, 0.53, 0.506, 0.95, 0.84, 0.012);
    for (const x of [-0.237, 0.237]) {
      box(materials.wood, x, 0.41, 0.524, 0.45, 0.58, 0.024);
      box(materials.wood, x, 0.82, 0.524, 0.45, 0.18, 0.024);
      box(materials.metal, x, 0.82, 0.556, 0.09, 0.026, 0.040);
      box(materials.metal, x * 0.20, 0.59, 0.556, 0.018, 0.09, 0.040);
    }
    // Thin edge trim remains inside the carcass's width and depth.
    box(materials.wood, 0, 1.008, 0, 1, 0.016, 1);
    return body;
  }

  function bookcase(options) {
    const { body, box } = fixture(options, [1.4, 0.36, 2.1], materials.wood);
    // A solid cabinet explains the collision; shallow relief reads as shelves.
    box(materials.tar, 0, 0.50, 0.506, 0.92, 0.90, 0.012);
    for (const x of [-0.46, 0.46]) {
      box(materials.wood, x, 0.50, 0.538, 0.04, 0.94, 0.052);
    }
    const shelfHeights = [0.055, 0.275, 0.495, 0.715, 0.935];
    const covers = [materials.wood, materials.wallpaper, materials.plaster];
    for (const [row, y] of shelfHeights.entries()) {
      box(materials.wood, 0, y, 0.538, 0.94, 0.028, 0.052);
      if (row === shelfHeights.length - 1) continue;
      for (let i = 0; i < 10; i++) {
        const x = -0.38 + i * 0.077;
        const h = 0.12 + ((i * 3 + row) % 5) * 0.012;
        const w = 0.038 + ((i + row) % 3) * 0.008;
        const bottom = y + 0.014;
        box(covers[(i + row) % covers.length], x, bottom + h / 2, 0.530,
          w, h, 0.036);
        box(materials.plaster, x, bottom + h * 0.18, 0.550,
          w * 0.88, 0.006, 0.004);
      }
    }
    return body;
  }

  function bench(options) {
    const { body, box } = fixture(options, [1.2, 0.42, 0.45], materials.wood);
    // A storage bench has a grounded, closed base rather than invisible legs.
    box(materials.tar, 0, 0.46, 0.506, 0.94, 0.64, 0.012);
    for (let i = 0; i < 9; i++) {
      box(materials.wood, -0.40 + i * 0.10, 0.46, 0.524, 0.09, 0.60, 0.024);
    }
    box(materials.tar, 0, 1.003, 0, 1, 0.006, 1);
    for (const z of [-0.375, -0.125, 0.125, 0.375]) {
      box(materials.wood, 0, 1.016, z, 1, 0.020, 0.23);
    }
    for (const x of [-0.30, 0.30]) {
      box(materials.metal, x, 1.028, -0.46, 0.07, 0.004, 0.05);
    }
    box(materials.metal, 0, 0.72, 0.555, 0.18, 0.06, 0.038);
    return body;
  }

  return { refrigerator, stove, sideboard, bookcase, bench };
}
