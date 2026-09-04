import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getWeaponFinishes } from './weapon-finishes.js';
import { applyHeroWeaponUV } from './hero-weapon-uv.js';
import { reshapeWeaponShell } from './hero-weapon-shell.js';
import { getAuthoredWorldWeaponGeometry } from './authored-world-weapons.js';

// Original reduced profile assets. Construction +X is rotated into the rig's
// existing +Z grip frame; actor, grip and muzzle transforms are never rescaled.
const geometries = new Map(), materialVariants = new WeakMap();
const TYPES = ['pistol', 'shotgun', 'smg', 'machinegun'];
const NPC_FRAME = new THREE.Matrix4().makeRotationY(-Math.PI / 2);

function outline(points, Shape = THREE.Shape) {
  const shape = new Shape(); shape.moveTo(...points[0]);
  for (const point of points.slice(1)) shape.lineTo(...point);
  shape.closePath(); return shape;
}

function makeBuilder(type) {
  const finishes = getWeaponFinishes(), materials = [finishes.metal, type === 'shotgun' ? finishes.wood : finishes.polymer];
  const buckets = [[], []], parts = [[], []];
  function add(name, source, group = 0, tint = 0.58, uvOptions) {
    let geometry = applyHeroWeaponUV(source, materials[group], uvOptions);
    if (geometry !== source) source.dispose();
    if (geometry.index) { const flat = geometry.toNonIndexed(); geometry.dispose(); geometry = flat; }
    const { position, normal } = geometry.attributes, colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const diagonal = 1 - Math.max(Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i)));
      const value = tint * (group === 0 ? 1 + Math.min(0.32, diagonal * 1.4) : 1);
      colors.set([value, value, value], i * 3);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.applyMatrix4(NPC_FRAME);
    buckets[group].push(geometry); parts[group].push({ name, count: position.count });
  }
  function profile(name, points, width, group = 0, { bevel = 0.0013, z = 0, tint = group ? 1 : 0.58, holes = [], crown } = {}) {
    const shape = outline(points);
    for (const hole of holes) shape.holes.push(outline(hole, THREE.Path));
    const edge = Math.min(bevel, width * 0.2), depth = width - 2 * edge;
    let geometry = new THREE.ExtrudeGeometry(shape, { depth, steps: 1, curveSegments: 1,
      bevelEnabled: edge > 0, bevelSegments: 1, bevelSize: edge, bevelThickness: edge });
    geometry.translate(0, 0, z - depth / 2);
    if (crown) {
      const shaped = reshapeWeaponShell(geometry, { width, ...crown }); geometry.dispose(); geometry = shaped;
    }
    add(name, geometry, group, tint);
  }
  function box(name, x, y, z, length, height, width, group = 0, tint = group ? 1 : 0.35) {
    const geometry = new THREE.BoxGeometry(length, height, width); geometry.translate(x, y, z);
    add(name, geometry, group, tint);
  }
  function plate(name, points, z, tint = 0.3, side = 1) {
    const geometry = new THREE.ShapeGeometry(outline(points), 1);
    // Flip winding, not the profile coordinates, for the opposite side.
    if (side < 0) {
      const index = geometry.index;
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i); index.setX(i, index.getX(i + 2)); index.setX(i + 2, a);
      }
      geometry.computeVertexNormals();
    }
    geometry.translate(0, 0, z); add(name, geometry, 0, tint);
  }
  function tube(name, x1, x2, y, radius, bore, tint = 0.36, segments = 12) {
    const half = (x2 - x1) / 2;
    const geometry = new THREE.LatheGeometry([
      new THREE.Vector2(bore, -half), new THREE.Vector2(radius, -half),
      new THREE.Vector2(radius, half), new THREE.Vector2(bore, half), new THREE.Vector2(bore, -half),
    ], segments);
    geometry.rotateZ(-Math.PI / 2).translate((x1 + x2) / 2, y, 0);
    add(name, geometry, 0, tint, { kind: 'tube', y });
  }
  function disk(name, x, y, z, radius, tint = 0.28, axis = 'z', side = 1, segments = 8) {
    const geometry = new THREE.CircleGeometry(radius, segments);
    if (axis === 'x') geometry.rotateY(side * Math.PI / 2);
    else if (side < 0) geometry.rotateY(Math.PI);
    geometry.translate(x, y, z); add(name, geometry, 0, tint);
  }
  function loft(name, sections, group = 1, tint = 1, sides = 8) {
    const positions = [], indices = [];
    for (const section of sections) for (let side = 0; side < sides; side++) {
      const angle = Math.PI * 2 * side / sides;
      positions.push(section.x, (section.low + section.high) / 2 + Math.cos(angle) * (section.high - section.low) / 2,
        Math.sin(angle) * section.width);
    }
    for (let ring = 0; ring < sections.length - 1; ring++) for (let side = 0; side < sides; side++) {
      const a = ring * sides + side, b = ring * sides + (side + 1) % sides;
      indices.push(a, b, b + sides, a, b + sides, a + sides);
    }
    // Separate cap vertices keep the shaped stock and pump ends crisp.
    for (const [ring, reverse] of [[0, true], [sections.length - 1, false]]) {
      const start = positions.length / 3;
      for (let side = 0; side < sides; side++) positions.push(...positions.slice((ring * sides + side) * 3, (ring * sides + side + 1) * 3));
      for (let side = 1; side < sides - 1; side++) {
        indices.push(start, start + (reverse ? side + 1 : side), start + (reverse ? side : side + 1));
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices);
    geometry.computeVertexNormals(); add(name, geometry, group, tint);
  }
  function action(name, points, width, hole, crownBase, top) {
    profile(name, points, width, 0, { bevel: 0.0015, holes: [hole], crown: { top, crownBase, crownDrop: 0.42 } });
    // Real ejection recess, bolt six millimetres behind the near side, and a
    // flush far wall: it is not a painted black square or a through-window.
    plate(`${name}-bolt`, hole, width / 2 - 0.006, 0.86);
    plate(`${name}-far-wall`, hole, -width / 2, 0.58, -1);
  }
  function guard(front = 0.061) {
    profile('open-trigger-guard', [[0.007, -0.006], [front - 0.006, -0.006], [front, -0.021],
      [front - 0.009, -0.053], [0.010, -0.055], [-0.002, -0.029]], 0.012, 0,
    { bevel: 0.0008, tint: 0.27, holes: [[[0.014, -0.014], [front - 0.014, -0.014], [front - 0.009, -0.024],
      [front - 0.016, -0.044], [0.016, -0.046], [0.007, -0.029]]] });
    profile('curved-trigger', [[0.027, -0.007], [0.034, -0.007], [0.031, -0.024], [0.023, -0.035],
      [0.018, -0.034], [0.024, -0.022]], 0.007, 0, { bevel: 0, tint: 0.72 });
  }
  function grip() {
    profile('canted-pistol-grip', [[-0.031, 0.002], [0.012, -0.005], [0.002, -0.080], [-0.010, -0.105],
      [-0.043, -0.098], [-0.040, -0.064]], 0.041, 1, { bevel: 0.0027 });
    profile('magazine-shoe', [[-0.044, -0.098], [-0.008, -0.105], [-0.006, -0.111], [-0.045, -0.105]],
      0.045, 0, { bevel: 0.0007, tint: 0.24 });
  }
  function pins(points, width) {
    for (const [index, [x, y]] of points.entries()) for (const side of [-1, 1]) {
      disk(`receiver-pin-${index}-${side}`, x, y, side * (width / 2 + 0.0002), 0.0028, 0.90, 'z', side);
    }
  }
  function sights(rearX, frontX, rearBottom, frontBottom, top) {
    box('rear-sight-seat', rearX, rearBottom + 0.002, 0, 0.018, 0.004, 0.029, 0, 0.22);
    for (const side of [-1, 1]) profile(`rear-sight-ear-${side}`, [[rearX - 0.008, rearBottom + 0.003],
      [rearX + 0.008, rearBottom + 0.003], [rearX + 0.006, top], [rearX - 0.005, top]],
    0.008, 0, { bevel: 0.0005, z: side * 0.0105, tint: 0.22 });
    profile('front-sight-post', [[frontX - 0.009, frontBottom], [frontX + 0.009, frontBottom],
      [frontX + 0.003, top - 0.002], [frontX - 0.003, top - 0.002]], 0.006, 0, { bevel: 0, tint: 0.22 });
  }
  function finish() {
    const merged = buckets.map(bucket => mergeGeometries(bucket, false));
    const geometry = mergeGeometries(merged, true);
    let start = 0;
    const ranges = parts.flatMap((bucket, materialIndex) => bucket.map(part => {
      const range = { ...part, start, materialIndex }; start += part.count; return range;
    }));
    for (const source of [...buckets.flat(), ...merged]) source.dispose();
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    geometry.userData.npcWeapon = Object.freeze({ version: 1, type, source: 'original-profile-procedural',
      parts: ranges, triangles: start / 3, drawCalls: geometry.groups.length });
    geometry.userData.weaponSurfaceUV = true;
    return geometry;
  }
  return { profile, box, plate, tube, disk, loft, action, guard, grip, pins, sights, finish };
}

function pistol(b) {
  b.action('pistol-slide', [[-0.063, 0.021], [0.174, 0.021], [0.180, 0.034], [0.175, 0.058],
    [0.159, 0.068], [-0.050, 0.068], [-0.064, 0.056]], 0.052,
  [[0.055, 0.032], [0.118, 0.032], [0.120, 0.052], [0.056, 0.052]], 0.054, 0.068);
  b.profile('pistol-frame', [[-0.051, -0.005], [0.068, -0.009], [0.155, 0.006], [0.160, 0.022], [-0.055, 0.022]],
    0.045, 0, { tint: 0.30 });
  b.grip(); b.guard(); b.tube('pistol-hollow-muzzle', 0.163, 0.220, 0.041, 0.012, 0.0075, 0.78);
  b.disk('pistol-bore-depth', 0.188, 0.041, 0, 0.0074, 0.10, 'x');
  for (let i = 0; i < 6; i++) for (const side of [-1, 1]) b.plate(`pistol-slide-serration-${i}-${side}`,
    [[-0.048 + i * 0.008, 0.026], [-0.045 + i * 0.008, 0.026], [-0.040 + i * 0.008, 0.054], [-0.043 + i * 0.008, 0.054]],
    side * 0.0262, 0.27, side);
  b.profile('pistol-slide-stop', [[-0.020, 0.002], [0.020, 0.002], [0.020, 0.007], [-0.013, 0.008]],
    0.003, 0, { bevel: 0, z: -0.024, tint: 0.68 });
  b.pins([[-0.023, -0.018], [-0.029, -0.077]], 0.042); b.sights(-0.040, 0.150, 0.067, 0.066, 0.079);
}

function shotgun(b) {
  b.action('shotgun-action', [[-0.091, -0.007], [0.170, -0.007], [0.199, 0.012], [0.198, 0.064],
    [0.174, 0.079], [-0.067, 0.079], [-0.092, 0.058]], 0.065,
  [[0.064, 0.017], [0.156, 0.017], [0.165, 0.054], [0.064, 0.054]], 0.059, 0.079);
  b.loft('shotgun-shaped-stock', [
    { x: -0.327, low: -0.062, high: 0.043, width: 0.029 },
    { x: -0.292, low: -0.058, high: 0.051, width: 0.030 },
    { x: -0.203, low: -0.044, high: 0.048, width: 0.026 },
    { x: -0.142, low: -0.023, high: 0.029, width: 0.021 },
    { x: -0.076, low: -0.022, high: 0.025, width: 0.021 },
  ]);
  b.loft('shotgun-recoil-pad', [{ x: -0.333, low: -0.063, high: 0.043, width: 0.030 },
    { x: -0.326, low: -0.063, high: 0.043, width: 0.030 }], 0, 0.19);
  b.grip(); b.guard(); b.tube('shotgun-barrel', 0.183, 0.735, 0.041, 0.020, 0.0125, 0.48);
  b.disk('shotgun-bore-depth', 0.699, 0.041, 0, 0.0124, 0.10, 'x');
  b.tube('shotgun-magazine-tube', 0.181, 0.541, 0.003, 0.014, 0.010, 0.27);
  b.disk('shotgun-magazine-cap', 0.541, 0.003, 0, 0.014, 0.60, 'x');
  const pump = [{ x: 0.191, low: -0.020, high: 0.026, width: 0.030 }];
  for (let i = 0; i < 11; i++) {
    const inset = i % 2 ? 0.003 : 0;
    pump.push({ x: 0.201 + i * 0.013, low: -0.031 + inset, high: 0.033 - inset, width: 0.038 - inset });
  }
  pump.push({ x: 0.343, low: -0.020, high: 0.026, width: 0.030 }); b.loft('shotgun-ribbed-pump', pump);
  b.box('shotgun-sighting-rib', 0.458, 0.064, 0, 0.530, 0.003, 0.007, 0, 0.23);
  for (const x of [0.262, 0.420, 0.589]) b.box('shotgun-rib-bridge', x, 0.060, 0, 0.008, 0.008, 0.007, 0, 0.42);
  b.box('shotgun-front-bead', 0.716, 0.068, 0, 0.006, 0.005, 0.005, 0, 1.1);
  b.pins([[-0.049, 0.036], [0.033, 0.003]], 0.065);
}

function automatic(b, machinegun) {
  const type = machinegun ? 'machinegun' : 'smg', end = machinegun ? 0.191 : 0.152;
  const width = machinegun ? 0.066 : 0.057, top = machinegun ? 0.080 : 0.069;
  b.action(`${type}-receiver`, [[-0.080, -0.006], [end - 0.016, -0.006], [end, 0.008], [end, top - 0.019],
    [end - 0.025, top], [-0.057, top], [-0.084, top - 0.022]], width,
  [[0.064, 0.016], [end - 0.016, 0.016], [end - 0.020, 0.050], [0.064, 0.050]], top - 0.020, top);
  b.profile(`${type}-lower-receiver`, [[-0.078, -0.006], [end, -0.006], [end - 0.016, -0.025],
    [0.063, -0.025], [0.030, -0.012], [-0.078, -0.017]], width - 0.003, 0, { tint: 0.29 });
  b.grip(); b.guard();
  if (machinegun) {
    b.loft('machinegun-full-stock', [
      { x: -0.326, low: -0.061, high: 0.045, width: 0.028 },
      { x: -0.292, low: -0.055, high: 0.051, width: 0.028 },
      { x: -0.202, low: -0.017, high: 0.048, width: 0.022 },
      { x: -0.110, low: -0.008, high: 0.032, width: 0.019 },
      { x: -0.073, low: 0.002, high: 0.034, width: 0.022 },
    ]);
    b.loft('machinegun-stock-pad', [{ x: -0.333, low: -0.062, high: 0.045, width: 0.029 },
      { x: -0.325, low: -0.062, high: 0.045, width: 0.029 }], 0, 0.18);
  } else {
    b.profile('smg-folding-stock-frame', [[-0.325, 0.053], [-0.073, 0.050], [-0.073, 0.036],
      [-0.300, 0.037], [-0.304, -0.022], [-0.325, -0.022]], 0.016, 0, { tint: 0.33 });
    b.loft('smg-stock-pad', [{ x: -0.330, low: -0.028, high: 0.056, width: 0.024 },
      { x: -0.319, low: -0.028, high: 0.056, width: 0.024 }], 1);
  }
  const length = machinegun ? 0.175 : 0.144, tip = machinegun ? 0.169 : 0.138;
  b.profile(`${type}-curved-magazine`, [[0.076, -0.019], [0.125, -0.019], [0.132, -0.091],
    [tip + 0.009, -length + 0.018], [tip, -length], [tip - 0.041, -length], [0.085, -0.097]],
  machinegun ? 0.048 : 0.041, 1, { bevel: 0.0018 });
  for (const side of [-1, 1]) for (const x of [0.092, 0.110]) b.plate(`${type}-magazine-flute-${x}-${side}`,
    [[x, -0.033], [x + 0.004, -0.033], [x + 0.011, -0.094], [tip + x - 0.104, -length + 0.009],
      [tip + x - 0.109, -length + 0.009], [x + 0.007, -0.094]], side * (machinegun ? 0.0242 : 0.0207), 0.21, side);
  const front = machinegun ? 0.389 : 0.292, start = machinegun ? 0.167 : 0.143;
  const vents = Array.from({ length: machinegun ? 4 : 3 }, (_, i) => {
    const x = start + 0.013 + i * 0.041;
    return [[x, 0.018], [x + 0.025, 0.018], [x + 0.026, 0.046], [x + 0.002, 0.046]];
  });
  for (const side of [-1, 1]) b.profile(`${type}-vented-handguard-${side}`, [[start, -0.016], [front - 0.010, -0.013],
    [front, 0.049], [start + 0.006, 0.058]], 0.003, 1, { bevel: 0, holes: vents, z: side * 0.032 });
  b.box(`${type}-handguard-floor`, (front + start) / 2, -0.017, 0, front - start, 0.010, 0.063, 1);
  const muzzle = machinegun ? 0.665 : 0.410;
  b.tube(`${type}-barrel`, start - 0.012, muzzle, 0.041, machinegun ? 0.016 : 0.013, 0.008, 0.44);
  b.tube(`${type}-muzzle-collar`, muzzle - 0.038, muzzle, 0.041, machinegun ? 0.022 : 0.019, machinegun ? 0.016 : 0.013, 0.27);
  b.disk(`${type}-bore-depth`, muzzle - 0.036, 0.041, 0, 0.0079, 0.09, 'x');
  b.profile(`${type}-charging-handle`, [[0.020, 0.028], [0.061, 0.028], [0.061, 0.039], [0.026, 0.043]],
    0.018, 0, { bevel: 0.0010, z: width / 2 + 0.006, tint: 0.26 });
  b.profile(`${type}-top-cover`, [[-0.063, top], [end - 0.010, top], [end - 0.019, top + 0.006], [-0.048, top + 0.006]],
    width * 0.51, 0, { bevel: 0.0011, tint: 0.30 });
  b.sights(-0.034, front - 0.008, top + 0.005, 0.051, top + 0.022);
  b.pins([[-0.052, 0.030], [0.019, 0.010]], width);
}

/** Immutable-in-use source buffers shared by every pool slot of a gun type. */
export function getNPCFirearmGeometry(type) {
  if (!TYPES.includes(type)) throw new RangeError(`Unknown NPC firearm: ${type}`);
  const authored = getAuthoredWorldWeaponGeometry(type);
  if (authored) return authored;
  if (!geometries.has(type)) {
    const b = makeBuilder(type);
    if (type === 'pistol') pistol(b);
    else if (type === 'shotgun') shotgun(b);
    else automatic(b, type === 'machinegun');
    geometries.set(type, b.finish());
  }
  return geometries.get(type);
}

/** Reuse finish maps without mutating the supplied shared drop/equipment material. */
export function getNPCFirearmMaterials(type, sourceMaterial) {
  if (!TYPES.includes(type)) throw new RangeError(`Unknown NPC firearm: ${type}`);
  const finishes = getWeaponFinishes(), source = sourceMaterial || finishes.metal;
  let variants = materialVariants.get(source);
  if (!variants) { variants = new Map(); materialVariants.set(source, variants); }
  const furniture = type === 'shotgun' ? 'wood' : 'polymer';
  if (!variants.has(furniture)) {
    // Preserve the supplied hue; authored albedo determines surface brightness.
    const tint = source.color?.clone() || new THREE.Color(1, 1, 1);
    tint.multiplyScalar(1 / Math.max(tint.r, tint.g, tint.b, 0.0001));
    const materials = [finishes.metal.clone(), finishes[furniture].clone()];
    materials[0].color.copy(tint); materials[1].color.copy(tint).lerp(new THREE.Color(1, 1, 1), 0.55);
    for (const material of materials) material.name = `npc-${material.name}`;
    variants.set(furniture, Object.freeze(materials));
  }
  return variants.get(furniture);
}
