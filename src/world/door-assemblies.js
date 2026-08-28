const THRESHOLD_HEIGHT = 0.025;
const SIDES = [['interior', -1], ['exterior', 1]];

/**
 * Build both faces from one immutable clear-opening descriptor. Exterior is
 * always +axis; the width tangent is world +Z for x walls and +X for z walls.
 * Only structural bodies collide. All dimensions and offsets are in metres.
 */
export function createDoorAssemblies({ addBox, pushDecor, boxGeometry, materials }) {
  function readDoor(door) {
    if (!door || typeof door !== 'object') throw new TypeError('A door descriptor is required');
    const { id, axis, x, z, floorY, width, height,
      wallThickness = 0.2, frameWidth = 0.06, slabThickness = 0.07,
      handleSide = 1, charred = false } = door;
    if (axis !== 'x' && axis !== 'z') throw new RangeError('Door axis must be x or z');
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('A door id is required');
    if (![x, z, floorY, width, height, wallThickness, frameWidth, slabThickness].every(Number.isFinite)
      || width <= 0.02 || height <= 0.045 || frameWidth <= 0
      || wallThickness <= 0 || wallThickness >= 0.28
      || slabThickness <= 0 || slabThickness >= 0.2 || slabThickness > wallThickness) {
      throw new RangeError('Invalid door dimensions or position');
    }
    if (handleSide !== -1 && handleSide !== 1) throw new RangeError('Door handleSide must be -1 or 1');
    return { id, axis, x, z, floorY, width, height, wallThickness, frameWidth, slabThickness, handleSide, charred };
  }

  function frame(descriptor, floorId, open) {
    const door = readDoor(descriptor);
    const { id, axis, x, z, floorY, width, height, frameWidth, wallThickness } = door;
    const position = (tangent, y, normal) => axis === 'x'
      ? [x + normal, floorY + y, z + tangent]
      : [x + tangent, floorY + y, z + normal];
    const size = (w, h, d) => axis === 'x' ? [d, h, w] : [w, h, d];

    function body(name, part, tangent, y, normal, w, h, d, material, options = {}, side) {
      const mesh = addBox(...position(tangent, y, normal), ...size(w, h, d), material, options);
      mesh.name = `${id}-${name}`;
      mesh.userData.doorId = id;
      mesh.userData.doorPart = part;
      if (side) mesh.userData.doorSide = side;
      return mesh;
    }
    function decor(material, tangent, y, normal, w, h, d) {
      pushDecor(boxGeometry, material, ...position(tangent, y, normal), ...size(w, h, d));
    }
    const floorSupports = floorId ? [floorId] : [];
    const floorSupportKind = floorId ? 'bearing' : 'ground';
    const jambs = [-1, 1].map((sign, i) => body(`jamb-${i}`, 'jamb',
      sign * (width + frameWidth) / 2, height / 2, 0,
      frameWidth, height, wallThickness, materials.wood, {
        architecture: { id: `${id}-jamb-${i}`, kind: 'jamb', supports: floorSupports, supportKind: floorSupportKind },
      }));
    const header = body('header', 'header', 0, height + frameWidth / 2, 0,
      width + frameWidth * 2, frameWidth, wallThickness, materials.wood, {
        architecture: { id: `${id}-header`, kind: 'lintel', supports: jambs.map(mesh => mesh.name), supportKind: 'bearing' },
      });
    const threshold = body('threshold', 'threshold', 0, (open ? -1 : 1) * THRESHOLD_HEIGHT / 2, 0,
      width, THRESHOLD_HEIGHT, wallThickness, materials.agedStone, {
        collide: !open,
        architecture: {
          id: `${id}-threshold`, kind: 'threshold', supports: floorSupports,
          supportKind: open && floorId ? 'anchored' : floorSupportKind,
        },
      });

    // Face trim never narrows the opening and remains within ±0.14m of the wall centre.
    const trimDepth = Math.min(0.03, 0.14 - wallThickness / 2);
    for (const [, side] of SIDES) {
      const normal = side * (wallThickness / 2 + trimDepth / 2);
      for (const sign of [-1, 1]) {
        decor(materials.wood, sign * (width + frameWidth) / 2, height / 2, normal,
          frameWidth, height, trimDepth);
      }
      decor(materials.wood, 0, height + frameWidth / 2, normal,
        width + frameWidth * 2, frameWidth, trimDepth);
    }
    return { door, body, decor, jambs, header, threshold };
  }

  function closedDoor(descriptor, { floorId } = {}) {
    const { door, body, decor, jambs, header, threshold } = frame(descriptor, floorId, false);
    const { id, width, height, slabThickness, handleSide, charred } = door;
    const leafWidth = width - 0.02, leafHeight = height - THRESHOLD_HEIGHT - 0.02;
    const slab = body('slab', 'slab', 0, THRESHOLD_HEIGHT + leafHeight / 2, 0,
      leafWidth, leafHeight, slabThickness, materials.wood, {
        architecture: { id: `${id}-slab`, kind: 'door', supports: [threshold.name], supportKind: 'bearing' },
      });
    const halfLeaf = slabThickness / 2;
    // Even a thicker custom leaf retains the same maximum normal clearance.
    const depthScale = Math.min(1, (0.1 - halfLeaf) / 0.045);
    const panelDepth = 0.008 * depthScale, plateDepth = 0.006 * depthScale;
    const mountDepth = 0.014 * depthScale, handleDepth = 0.022 * depthScale;
    const handleY = THRESHOLD_HEIGHT + leafHeight * 0.50;
    const handleT = handleSide * (leafWidth / 2 - Math.min(0.12, leafWidth * 0.15));
    const handleWidth = Math.min(0.14, leafWidth * 0.18);
    const panelWidth = leafWidth * 0.76, panelHeight = leafHeight * 0.31;
    const handles = {};

    for (const [side, sign] of SIDES) {
      function detail(name, part, tangent, y, offset, w, h, d, material = materials.metal) {
        return body(`${side}-${name}`, part, tangent, y, sign * (halfLeaf + offset + d / 2),
          w, h, d, material, { collide: false, cast: false }, side);
      }
      for (const [i, fraction] of [0.27, 0.73].entries()) {
        const y = THRESHOLD_HEIGHT + leafHeight * fraction;
        detail(`panel-${i}`, 'panel', 0, y, 0, panelWidth, panelHeight, panelDepth, materials.wood);
        if (charred && side === 'interior') {
          const scorchDepth = 0.003 * depthScale;
          decor(materials.tar, 0, y, -(halfLeaf + panelDepth + scorchDepth / 2),
            panelWidth * 0.94, panelHeight * 0.92, scorchDepth);
        }
      }
      const plateHeight = Math.min(0.24, leafHeight * 0.15);
      detail('lockplate', 'lockplate', handleT, handleY, 0,
        Math.min(0.072, leafWidth * 0.09), plateHeight, plateDepth);
      detail('keyway', 'keyway', handleT, handleY - plateHeight * 0.28, plateDepth,
        Math.min(0.008, leafWidth * 0.01), plateHeight * 0.16, 0.002 * depthScale, materials.tar);
      detail('handle-mount', 'handle-mount', handleT, handleY, plateDepth,
        Math.min(0.026, leafWidth * 0.04), Math.min(0.026, leafHeight * 0.02), mountDepth);
      handles[side] = detail('handle', 'handle', handleT - handleSide * handleWidth * 0.35, handleY,
        plateDepth + mountDepth, handleWidth, Math.min(0.028, leafHeight * 0.02), handleDepth);
      const kickHeight = Math.min(0.24, leafHeight * 0.10);
      detail('kickplate', 'kickplate', 0, THRESHOLD_HEIGHT + leafHeight * 0.015 + kickHeight / 2,
        0, leafWidth * 0.90, kickHeight, 0.006 * depthScale);
      for (const [i, fraction] of [0.16, 0.50, 0.84].entries()) {
        // Each strap spans the leaf-to-jamb gap; neither face mirrors its hinge side.
        detail(`hinge-${i}`, 'hinge', -handleSide * width / 2,
          THRESHOLD_HEIGHT + leafHeight * fraction, 0,
          Math.min(0.06, width * 0.08), Math.min(0.14, leafHeight * 0.10), plateDepth);
      }
    }
    return { slab, jambs, header, threshold, handles };
  }

  function openFrame(descriptor, { floorId } = {}) {
    const { jambs, header, threshold } = frame(descriptor, floorId, true);
    return { jambs, header, threshold };
  }

  return { closedDoor, openFrame };
}
