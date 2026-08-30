import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { getWeaponFinishes } from './weapon-finishes.js';
import { applyHeroWeaponUV } from './hero-weapon-uv.js';
import { reshapeWeaponShell } from './hero-weapon-shell.js';

// Original profile-authored procedural assets. These are source-built meshes,
// not downloaded/scanned models. +X follows the bore, +Y is up and +Z is right.
// Deliberate silhouettes and open mechanical cuts use vertices where they read
// in the first-person view; no subdivision or per-frame geometry work is used.
export const HERO_WEAPON_MUZZLES = Object.freeze({
  pistol: Object.freeze([0.201, 0.04, 0]), shotgun: Object.freeze([0.50, 0.03, 0]),
  smg: Object.freeze([0.28, 0.02, 0]), machinegun: Object.freeze([0.59, 0.03, 0]),
});

const SIGHTS = {
  pistol: {
    rear: { x: -0.05, length: 0.02, width: 0.032, bottom: 0.069, floor: 0.074, top: 0.087, gap: 0.012 },
    front: { x: 0.13, length: 0.012, width: 0.006, bottom: 0.070, top: 0.079 },
  },
  smg: {
    rear: { x: -0.05, length: 0.022, width: 0.030, bottom: 0.0525, floor: 0.0585, top: 0.0775, gap: 0.014 },
    front: { x: 0.16, length: 0.009, width: 0.005, bottom: 0.055, top: 0.061 },
  },
  machinegun: {
    rear: { x: 0.06, length: 0.04, width: 0.040, bottom: 0.065, floor: 0.071, top: 0.095, gap: 0.014 },
    front: { x: 0.46, length: 0.009, width: 0.006, bottom: 0.048, top: 0.090 },
  },
};

function metricUV(geometry, material, options) {
  const mapped = applyHeroWeaponUV(geometry, material, options);
  if (mapped !== geometry) geometry.dispose();
  return mapped;
}

function edgeWear(geometry, material) {
  const finish = material.userData.weaponFinish?.profile;
  const metal = ['metal', 'metalDark', 'blade'].includes(finish);
  const { position, normal } = geometry.attributes;
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const dominant = Math.max(Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i)));
    const bevel = metal ? Math.min(1, Math.max(0, (0.995 - dominant) * 12)) : 0;
    const variation = 0.6 + 0.4 * Math.sin(position.getX(i) * 367 + position.getY(i) * 293 + position.getZ(i) * 211) ** 2;
    const worn = 1 + bevel * variation * (finish === 'metalDark' ? 0.70 : 0.32);
    colors.set([worn, worn, worn], i * 3);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function path(points, Shape = THREE.Shape) {
  const shape = new Shape();
  shape.moveTo(...points[0]);
  for (const point of points.slice(1)) shape.lineTo(...point);
  shape.closePath();
  return shape;
}

function smoothLoftSides(geometry, count) {
  const { position, normal } = geometry.attributes, index = geometry.index;
  const sums = new Map(), keys = Array.from({ length: count }, (_, i) =>
    [position.getX(i), position.getY(i), position.getZ(i)].map(value => Math.round(value * 1e7)).join(','));
  const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], cross = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const vertices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    if (vertices.some(vertex => vertex >= count)) continue;
    vertices.forEach((vertex, corner) => points[corner].fromBufferAttribute(position, vertex));
    cross.crossVectors(points[1].sub(points[0]), points[2].sub(points[0]));
    for (const vertex of vertices) {
      if (!sums.has(keys[vertex])) sums.set(keys[vertex], new THREE.Vector3());
      sums.get(keys[vertex]).add(cross);
    }
  }
  for (let i = 0; i < count; i++) {
    const value = sums.get(keys[i]).normalize(); normal.setXYZ(i, value.x, value.y, value.z);
  }
}

function builder(root, finishes) {
  const details = [];
  function part(name, geometry, finish, uvOptions) {
    const material = finishes[finish];
    geometry = metricUV(geometry, material, uvOptions); edgeWear(geometry, material);
    const mesh = new THREE.Mesh(geometry, material); mesh.name = name;
    root.add(mesh); details.push(name);
    return mesh;
  }
  function profile(name, points, width, finish, { bevel = 0.001, z = 0, holes = [] } = {}) {
    const shape = path(points);
    for (const hole of holes) shape.holes.push(path(hole, THREE.Path));
    const edge = Math.min(bevel, width * 0.2);
    const depth = width - edge * 2;
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth, steps: 1, curveSegments: 1, bevelEnabled: edge > 0,
      bevelSegments: 1, bevelSize: edge, bevelThickness: edge,
    });
    geometry.translate(0, 0, z - depth / 2);
    return part(name, geometry, finish);
  }
  function box(name, x, y, z, length, height, width, finish, bevel = 0.001) {
    const geometry = bevel > 0
      ? new RoundedBoxGeometry(length, height, width, 1, Math.min(bevel, length * 0.2, height * 0.2, width * 0.2))
      : new THREE.BoxGeometry(length, height, width);
    geometry.translate(x, y, z);
    return part(name, geometry, finish);
  }
  function disk(name, x, y, z, radius, finish, axis = 'z', side = -1) {
    const geometry = new THREE.CircleGeometry(radius, 12);
    if (axis === 'x') geometry.rotateY(Math.PI / 2);
    else if (side < 0) geometry.rotateY(Math.PI);
    geometry.translate(x, y, z);
    return part(name, geometry, finish);
  }
  function tube(name, x1, x2, y, radius, bore, finish, z = 0, segments = 16) {
    const half = (x2 - x1) / 2;
    const geometry = new THREE.LatheGeometry([
      new THREE.Vector2(bore, -half), new THREE.Vector2(radius, -half),
      new THREE.Vector2(radius, half), new THREE.Vector2(bore, half), new THREE.Vector2(bore, -half),
    ], segments);
    geometry.rotateZ(-Math.PI / 2).translate((x1 + x2) / 2, y, z);
    return part(name, geometry, finish, { kind: 'tube', y, z });
  }
  // Each side strip shares vertices only along the length. Chamfers therefore
  // retain their own normal break while tapered longitudinal curves stay smooth.
  function loft(name, sections, finish, contour = section => {
    const { low, high, width, bevel = 0.003 } = section;
    const b = Math.min(bevel, (high - low) * 0.25, width * 0.45);
    return [[low + b, -width], [high - b, -width], [high, -width + b], [high, width - b],
      [high - b, width], [low + b, width], [low, width - b], [low, -width + b]];
  }, smoothSides = false) {
    const rings = sections.map(section => contour(section)), sides = rings[0].length;
    const positions = [], indices = [];
    for (let side = 0; side < sides; side++) {
      const start = positions.length / 3;
      for (let ring = 0; ring < rings.length; ring++) {
        for (const point of [rings[ring][side], rings[ring][(side + 1) % sides]]) positions.push(sections[ring].x, ...point);
      }
      for (let ring = 0; ring < rings.length - 1; ring++) {
        const a = start + ring * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const sideVertexCount = positions.length / 3;
    for (const ring of [0, rings.length - 1]) {
      const start = positions.length / 3, polygon = rings[ring];
      const center = polygon.reduce((sum, point) => [sum[0] + point[0] / sides, sum[1] + point[1] / sides], [0, 0]);
      positions.push(sections[ring].x, ...center);
      for (const point of polygon) positions.push(sections[ring].x, ...point);
      for (let side = 0; side < sides; side++) {
        const a = start + 1 + side, b = start + 1 + (side + 1) % sides;
        if (ring === 0) indices.push(start, b, a);
        else indices.push(start, a, b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    if (smoothSides) smoothLoftSides(geometry, sideVertexCount);
    return part(name, geometry, finish);
  }
  function receiver(name, outline, width, port, probe, finish = 'metal', construction = {}) {
    const panels = construction.panels || [];
    const shell = profile(name, outline, width, finish, { holes: [port, ...panels.map(panel => panel.outline)], bevel: 0.0012 });
    const top = Math.max(...outline.map(point => point[1])), shoulder = top - 0.009;
    const previous = shell.geometry;
    shell.geometry = reshapeWeaponShell(previous, { width, top,
      crownBase: construction.crownBase ?? shoulder, crownDrop: construction.crownDrop ?? 0.35,
      rearStart: construction.rearStart, rearEnd: construction.rearEnd, rearScale: construction.rearScale ?? 1 });
    previous.dispose(); shell.geometry = metricUV(shell.geometry, shell.material);
    edgeWear(shell.geometry, shell.material);
    // The visible (-Z) ejection window has real walls and an inset bolt. A
    // thin opposite plate closes the far side instead of making a through-hole.
    profile(`${name}-opposite-wall`, port, 0.002, finish, { bevel: 0, z: width / 2 - 0.001 });
    profile(`${name}-recessed-bolt`, port, 0.002, 'metalDark', { bevel: 0, z: -width / 2 + 0.014 });
    root.userData.heroWeapon.recess = { point: [probe[0], probe[1], -width / 2], depth: 0.012 };
    for (const panel of panels) {
      // A real shallow pocket, closed on both sides of the receiver. Insets
      // stay below the crown so the close-up seam has consistent depth.
      for (const side of [-1, 1]) {
        const floor = profile(`${name}-${panel.name}-floor-${side}`, panel.outline, 0.001,
          panel.finish || finish, { bevel: 0, z: side * (width / 2 - 0.0012 - panel.depth - 0.0005) });
        const oldFloor = floor.geometry;
        floor.geometry = reshapeWeaponShell(oldFloor, { width, top,
          crownBase: construction.crownBase ?? shoulder, crownDrop: construction.crownDrop ?? 0.35,
          rearStart: construction.rearStart, rearEnd: construction.rearEnd, rearScale: construction.rearScale ?? 1 });
        oldFloor.dispose(); floor.geometry = metricUV(floor.geometry, floor.material);
        const color = floor.geometry.attributes.color;
        for (let i = 0; i < color.count; i++) color.setXYZ(i, panel.tint ?? 0.78, panel.tint ?? 0.78, panel.tint ?? 0.78);
      }
      root.userData.heroWeapon.panels ??= [];
      root.userData.heroWeapon.panels.push({ name: panel.name, point: [...panel.probe, -width / 2 + 0.0012], depth: panel.depth });
    }
  }
  function guard(outer, hole, probe) {
    profile('trigger-guard', outer, 0.013, 'metalDark', { holes: [hole], bevel: 0.001 });
    root.userData.heroWeapon.triggerOpening = [...probe, 0];
  }
  function fastener(name, x, y, z, { radius = 0.0023, depth = 0.0007, axis = 'z', side = -1 } = {}) {
    const shape = path(Array.from({ length: 12 }, (_, i) => {
      const angle = i * Math.PI / 6; return [Math.cos(angle) * radius, Math.sin(angle) * radius];
    }));
    shape.holes.push(path(Array.from({ length: 6 }, (_, i) => {
      const angle = i * Math.PI / 3; return [Math.cos(angle) * radius * 0.39, Math.sin(angle) * radius * 0.39];
    }), THREE.Path));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, steps: 1, curveSegments: 1,
      bevelEnabled: true, bevelSize: 0.00015, bevelThickness: 0.00015, bevelSegments: 1 });
    geometry.translate(0, 0, -depth / 2);
    const socket = new THREE.CircleGeometry(radius * 0.40, 6); socket.translate(0, 0, -depth / 2 + 0.00015);
    for (const source of [geometry, socket]) {
      if (axis === 'x') source.rotateY(side * Math.PI / 2);
      else if (axis === 'y') source.rotateX(-side * Math.PI / 2);
      else if (side < 0) source.rotateY(Math.PI);
      source.translate(x, y, z);
    }
    part(`${name}-rim`, geometry, 'metal'); part(`${name}-socket`, socket, 'metalDark');
  }
  function screws(points, sideZ, detailed = false) {
    for (const [index, [x, y, pinZ = sideZ]] of points.entries()) {
      for (const side of [-1, 1]) {
        if (detailed) fastener(`receiver-pin-${index}-${side}`, x, y, side * pinZ, { side });
        else {
          // Grip/handle pins are mostly covered by the hand. Spend socket
          // geometry on the receiver's visible fixings instead.
          disk(`receiver-pin-${index}-${side}`, x, y, side * pinZ, 0.0023, 'metal', 'z', side);
          box(`receiver-pin-slot-${index}-${side}`, x, y, side * (pinZ + 0.0002), 0.0032, 0.0005, 0.0004, 'metalDark', 0);
        }
      }
    }
  }
  function sights(type) {
    const config = SIGHTS[type]; if (!config) return;
    const rear = { ...config.rear }, front = { ...config.front };
    root.userData.ironSights = { rear, front };
    profile('rear-sight-dovetail', [[rear.x - rear.length * 0.52, rear.bottom],
      [rear.x + rear.length * 0.52, rear.bottom], [rear.x + rear.length * 0.48, rear.floor],
      [rear.x - rear.length * 0.48, rear.floor]], rear.width, 'metalDark', { bevel: 0.0007 });
    const ear = (rear.width - rear.gap) / 2;
    for (const side of [-1, 1]) profile(`rear-sight-ear-${side}`, [
      [rear.x - rear.length / 2, rear.floor], [rear.x + rear.length / 2, rear.floor],
      [rear.x + rear.length * 0.33, rear.top - 0.002], [rear.x + rear.length * 0.20, rear.top - 0.0005],
      [rear.x - rear.length * 0.29, rear.top - 0.0005], [rear.x - rear.length / 2, rear.top - 0.003],
    ], ear, 'metalDark', { bevel: 0.0005, z: side * (rear.gap + ear) / 2 });
    box('front-sight-post', front.x, (front.top + front.bottom) / 2, 0,
      front.length, front.top - front.bottom, front.width, 'metalDark', 0);
  }
  function backPlate(name, x, points, thickness, finish) {
    const mesh = profile(name, points, thickness, finish, { bevel: 0.0006 });
    mesh.geometry.rotateY(-Math.PI / 2).translate(x, 0, 0);
    mesh.geometry = metricUV(mesh.geometry, mesh.material); edgeWear(mesh.geometry, mesh.material);
    return mesh;
  }
  return { profile, box, disk, tube, loft, receiver, guard, screws, fastener, sights, backPlate, details };
}

function pistol(b) {
  b.receiver('pistol-slide', [[-0.071, 0.026], [0.147, 0.026], [0.153, 0.033], [0.149, 0.054],
    [0.138, 0.063], [-0.056, 0.063], [-0.072, 0.051]], 0.034,
  [[0.025, 0.034], [0.085, 0.034], [0.090, 0.051], [0.025, 0.051]], [0.055, 0.044], 'metal',
  { crownBase: 0.051, crownDrop: 0.34 });
  b.profile('pistol-frame', [[-0.073, -0.009], [-0.026, -0.025], [0.045, -0.013], [0.115, -0.003],
    [0.123, 0.018], [-0.072, 0.022]], 0.034, 'metalDark');
  const grip = b.loft('pistol-canted-grip', [
    { x: -0.007, low: -0.070, high: -0.026, width: 0.017 },
    { x: 0.028, low: -0.068, high: -0.030, width: 0.018 },
    { x: 0.077, low: -0.076, high: -0.033, width: 0.018 },
    { x: 0.114, low: -0.078, high: -0.037, width: 0.017 },
  ], 'polymer', ({ low, high, width }) => Array.from({ length: 16 }, (_, i) => {
    const angle = -Math.PI + i * Math.PI / 8;
    return [(low + high) / 2 + Math.cos(angle) * (high - low) / 2, Math.sin(angle) * width];
  }));
  grip.geometry.rotateZ(-Math.PI / 2); grip.geometry = metricUV(grip.geometry, grip.material);
  b.guard([[-0.027, -0.013], [0.041, -0.006], [0.052, -0.025], [0.041, -0.050], [-0.022, -0.052]],
    [[-0.018, -0.020], [0.033, -0.015], [0.041, -0.028], [0.033, -0.042], [-0.016, -0.043]], [0.028, -0.031]);
  b.profile('pistol-trigger', [[0.002, -0.014], [0.010, -0.014], [0.010, -0.026], [0.004, -0.036],
    [-0.001, -0.036], [0.004, -0.025]], 0.008, 'metal');
  b.profile('pistol-magazine-shoe', [[-0.081, -0.115], [-0.034, -0.116], [-0.035, -0.122], [-0.080, -0.122]],
    0.044, 'metalDark', { bevel: 0.0004 });
  b.tube('pistol-barrel-crown', 0.14, 0.201, 0.04, 0.013, 0.008, 'metal');
  b.disk('pistol-bore-depth', 0.174, 0.04, 0, 0.0079, 'metalDark', 'x');
  for (let i = 0; i < 7; i++) {
    for (const side of [-1, 1]) b.profile(`slide-serration-${i}-${side}`, [[-0.060 + i * 0.007, 0.026],
      [-0.057 + i * 0.007, 0.026], [-0.054 + i * 0.007, 0.061], [-0.057 + i * 0.007, 0.061]],
    0.0006, 'metalDark', { bevel: 0, z: side * 0.0172 });
  }
  b.box('pistol-sight-seat', -0.050, 0.066, 0, 0.025, 0.006, 0.025, 'metal', 0.001);
  b.profile('pistol-front-dovetail-seat', [[0.119, 0.061], [0.142, 0.061], [0.137, 0.070], [0.123, 0.070]],
    0.012, 'metalDark', { bevel: 0.0005 });
  b.backPlate('pistol-striker-plate-rim', -0.072, [[-0.011, 0.028], [0.011, 0.028],
    [0.011, 0.046], [0.007, 0.053], [-0.007, 0.053], [-0.011, 0.046]], 0.002, 'metalDark');
  b.backPlate('pistol-striker-plate', -0.0732, [[-0.007, 0.031], [0.007, 0.031],
    [0.007, 0.045], [0.004, 0.049], [-0.004, 0.049], [-0.007, 0.045]], 0.0008, 'metal');
  for (let i = 0; i < 3; i++) b.box(`pistol-rear-plate-groove-${i}`, -0.0739, 0.034 + i * 0.004,
    0, 0.0004, 0.0007, 0.012, 'metalDark', 0);
  b.profile('pistol-extractor', [[0.073, 0.048], [0.125, 0.048], [0.125, 0.052], [0.079, 0.052]],
    0.0015, 'metalDark', { bevel: 0.0002, z: -0.0175 });
  b.box('slide-stop', -0.031, 0.006, -0.020, 0.032, 0.005, 0.004, 'metal', 0.0006);
  b.box('magazine-release', -0.034, -0.028, -0.0185, 0.006, 0.004, 0.001, 'metalDark', 0.0003);
  b.screws([[-0.057, -0.043], [-0.063, -0.092]], 0.0185);
  b.sights('pistol');
  const dot = new THREE.SphereGeometry(0.0015, 6, 4);
  dot.translate(0.1238, 0.0772, 0);
  const mesh = new THREE.Mesh(dot, getWeaponFinishes().sight); mesh.name = 'pistol-front-dot';
  return mesh;
}

function shotgun(b) {
  b.loft('shotgun-sculpted-stock', [
    { x: -0.248, low: -0.059, high: 0.018, width: 0.024 },
    { x: -0.212, low: -0.062, high: 0.024, width: 0.024 },
    { x: -0.178, low: -0.061, high: 0.021, width: 0.023 },
    { x: -0.135, low: -0.050, high: 0.011, width: 0.017 },
    { x: -0.112, low: -0.044, high: 0.005, width: 0.0158 },
    { x: -0.085, low: -0.038, high: -0.004, width: 0.0158 },
    { x: -0.064, low: -0.035, high: -0.010, width: 0.0158 },
  ], 'wood', ({ low, high, width }) => Array.from({ length: 16 }, (_, i) => {
    const angle = -Math.PI + i * Math.PI / 8;
    return [(low + high) / 2 + Math.cos(angle) * (high - low) / 2, Math.sin(angle) * width];
  }), true);
  b.box('shotgun-recoil-pad', -0.248, -0.021, 0, 0.004, 0.079, 0.056, 'polymer', 0.001);
  b.receiver('shotgun-action', [[-0.077, -0.023], [0.051, -0.023], [0.078, -0.009], [0.078, 0.032],
    [0.057, 0.048], [-0.060, 0.048], [-0.077, 0.029]], 0.043,
  [[-0.008, 0.004], [0.050, 0.004], [0.059, 0.032], [-0.008, 0.032]], [0.025, 0.018], 'metal', {
    crownBase: 0.032, crownDrop: 0.68, rearStart: -0.076, rearEnd: -0.045, rearScale: 0.82,
    panels: [
      { name: 'rear-cheek-pocket', depth: 0.0012, tint: 0.73, probe: [-0.030, 0.013],
        outline: [[-0.067, -0.002], [-0.022, -0.002], [-0.017, 0.004], [-0.017, 0.025], [-0.060, 0.025], [-0.067, 0.017]] },
      { name: 'trigger-group-pocket', depth: 0.0010, finish: 'metalDark', tint: 1.08, probe: [0.010, -0.013],
        outline: [[-0.058, -0.018], [0.040, -0.018], [0.047, -0.012], [0.040, -0.007], [-0.058, -0.007]] },
    ],
  });
  b.profile('shotgun-stock-tang', [[-0.121, -0.003], [-0.067, -0.002], [-0.067, 0.005], [-0.110, 0.006]],
    0.012, 'metalDark', { bevel: 0.0007 });
  b.backPlate('shotgun-stepped-breech-cap', -0.078, [[-0.014, -0.016], [0.014, -0.016], [0.016, 0.017],
    [0.010, 0.028], [-0.010, 0.028], [-0.016, 0.017]], 0.002, 'metalDark');
  b.backPlate('shotgun-breech-insert', -0.0792, [[-0.010, -0.010], [0.010, -0.010], [0.011, 0.013],
    [0.007, 0.021], [-0.007, 0.021], [-0.011, 0.013]], 0.0008, 'metal');
  b.fastener('shotgun-breech-retainer', -0.0800, 0.005, 0, { axis: 'x', side: -1, radius: 0.0020 });
  b.profile('shotgun-matted-sighting-flat', [[-0.057, 0.0477], [0.059, 0.0477], [0.072, 0.051],
    [0.070, 0.052], [0.058, 0.0492], [-0.055, 0.0492]], 0.007, 'metalDark', { bevel: 0.0003 });
  for (const x of [-0.031, 0.025]) b.fastener('shotgun-crown-plug', x, 0.0476, 0.009,
    { radius: 0.0016, depth: 0.0006, axis: 'y', side: 1 });
  b.tube('shotgun-barrel', 0.058, 0.50, 0.03, 0.021, 0.013, 'metal');
  b.disk('shotgun-bore-depth', 0.472, 0.03, 0, 0.0128, 'metalDark', 'x');
  b.tube('shotgun-magazine-tube', 0.077, 0.426, -0.010, 0.014, 0.011, 'metalDark');
  b.disk('shotgun-tube-end-cap', 0.426, -0.010, 0, 0.014, 'metal', 'x');
  const pumpSections = [{ x: 0.055, low: -0.033, high: 0.007, width: 0.028 }];
  for (let i = 0; i < 17; i++) {
    const inset = i % 2 ? 0.003 : 0;
    pumpSections.push({ x: 0.062 + i * 0.007, low: -0.040 + inset, high: 0.014 - inset, width: 0.034 - inset, bevel: 0.006 });
  }
  pumpSections.push({ x: 0.185, low: -0.033, high: 0.007, width: 0.028 });
  b.loft('shotgun-ribbed-pump', pumpSections, 'wood', ({ low, high, width }) =>
    Array.from({ length: 16 }, (_, i) => {
      const angle = -Math.PI + i * Math.PI / 8;
      return [(low + high) / 2 + Math.cos(angle) * (high - low) / 2, Math.sin(angle) * width];
    }), true);
  for (const [name, x] of [['rear', 0.055], ['front', 0.183]]) {
    b.loft(`shotgun-pump-${name}-ferrule`, [
      { x, low: -0.033, high: 0.007, width: 0.0285 },
      { x: x + 0.003, low: -0.033, high: 0.007, width: 0.0285 },
    ], 'metalDark', ({ low, high, width }) => Array.from({ length: 16 }, (_, i) => {
      const angle = -Math.PI + i * Math.PI / 8;
      return [(low + high) / 2 + Math.cos(angle) * (high - low) / 2, Math.sin(angle) * width];
    }), true);
  }
  b.guard([[-0.071, -0.025], [-0.013, -0.026], [-0.003, -0.044], [-0.015, -0.067], [-0.060, -0.067]],
    [[-0.060, -0.034], [-0.021, -0.035], [-0.014, -0.046], [-0.023, -0.058], [-0.057, -0.057]], [-0.038, -0.049]);
  b.profile('shotgun-trigger', [[-0.021, -0.026], [-0.015, -0.028], [-0.022, -0.046], [-0.029, -0.051],
    [-0.034, -0.049], [-0.024, -0.039]], 0.007, 'metal');
  b.box('shotgun-ventilated-rib', 0.276, 0.052, 0, 0.404, 0.003, 0.008, 'metalDark', 0.0005);
  for (const x of [0.12, 0.23, 0.34, 0.44]) b.box('shotgun-rib-bridge', x, 0.050, 0, 0.007, 0.007, 0.008, 'metal', 0.0005);
  b.box('shotgun-bead-base', 0.488, 0.056, 0, 0.015, 0.007, 0.008, 'metalDark', 0.001);
  const bead = new THREE.SphereGeometry(0.004, 10, 6); bead.translate(0.489, 0.061, 0);
  b.screws([[-0.055, 0.020, 0.0184], [0.003, -0.015, 0.0197]], 0.0210, true);
  return new THREE.Mesh(bead, getWeaponFinishes().metal);
}

function smg(b) {
  b.receiver('smg-stamped-upper', [[-0.111, -0.009], [0.087, -0.009], [0.101, 0.002], [0.101, 0.040],
    [0.087, 0.051], [-0.087, 0.051], [-0.111, 0.032]], 0.037,
  [[-0.002, 0.012], [0.065, 0.012], [0.075, 0.038], [-0.002, 0.038]], [0.035, 0.025], 'metal', {
    crownBase: 0.038, crownDrop: 0.60, rearStart: -0.110, rearEnd: -0.083, rearScale: 0.86,
    panels: [{ name: 'pressed-side-pocket', depth: 0.0012, tint: 0.72, probe: [-0.045, 0.015],
      outline: [[-0.097, -0.002], [-0.025, -0.002], [-0.015, 0.007], [-0.015, 0.027],
        [-0.082, 0.027], [-0.097, 0.017]] }],
  });
  b.profile('smg-lower-receiver', [[-0.104, -0.009], [0.075, -0.009], [0.060, -0.030],
    [-0.052, -0.028], [-0.069, -0.016], [-0.103, -0.020]], 0.036, 'metalDark');
  b.profile('smg-angled-grip', [[-0.108, -0.012], [-0.061, -0.015], [-0.074, -0.098],
    [-0.087, -0.113], [-0.118, -0.103], [-0.113, -0.075]], 0.036, 'polymer', { bevel: 0.002 });
  b.profile('smg-curved-magazine', [[-0.014, -0.013], [0.026, -0.013], [0.027, -0.088], [0.043, -0.146],
    [0.036, -0.159], [0.001, -0.159], [-0.011, -0.105]], 0.039, 'polymer', { bevel: 0.0015 });
  for (const side of [-1, 1]) for (const x of [-0.003, 0.014]) b.profile(`smg-magazine-rib-${side}-${x}`,
    [[x, -0.035], [x + 0.003, -0.035], [x + 0.008, -0.100], [x + 0.021, -0.146], [x + 0.017, -0.146], [x + 0.004, -0.100]],
  0.0015, 'metalDark', { bevel: 0.0003, z: side * 0.020 });
  b.profile('smg-folding-stock', [[-0.190, 0.024], [-0.110, 0.024], [-0.110, 0.015], [-0.174, 0.014],
    [-0.177, -0.027], [-0.188, -0.026]], 0.014, 'metalDark', { bevel: 0.001 });
  b.box('smg-stock-pad', -0.188, -0.004, 0, 0.009, 0.051, 0.033, 'polymer', 0.001);
  const vents = Array.from({ length: 4 }, (_, i) => {
    const x = 0.087 + i * 0.020;
    return [[x, 0.001], [x + 0.012, 0.001], [x + 0.014, 0.020], [x + 0.002, 0.020]];
  });
  for (const side of [-1, 1]) b.profile(`smg-vented-foreend-${side}`,
    [[0.074, -0.017], [0.186, -0.017], [0.193, 0.031], [0.076, 0.031]],
    0.004, 'polymer', { bevel: 0.0006, holes: vents, z: side * 0.031 });
  b.box('smg-foreend-heel', 0.139, -0.017, 0, 0.116, 0.004, 0.060, 'polymer', 0.001);
  b.tube('smg-exposed-barrel', 0.077, 0.280, 0.02, 0.013, 0.008, 'metal');
  b.tube('smg-barrel-collar', 0.183, 0.201, 0.02, 0.020, 0.013, 'metalDark');
  b.disk('smg-bore-depth', 0.254, 0.02, 0, 0.0079, 'metalDark', 'x');
  b.guard([[-0.058, -0.017], [-0.008, -0.017], [0.0, -0.034], [-0.012, -0.060], [-0.051, -0.058]],
    [[-0.049, -0.026], [-0.018, -0.026], [-0.010, -0.035], [-0.018, -0.051], [-0.047, -0.049]], [-0.034, -0.041]);
  b.profile('smg-trigger', [[-0.019, -0.018], [-0.012, -0.019], [-0.018, -0.035], [-0.025, -0.041],
    [-0.028, -0.038], [-0.022, -0.029]], 0.007, 'metal');
  b.box('smg-charging-latch', 0.036, 0.032, -0.026, 0.022, 0.009, 0.018, 'metalDark', 0.001);
  b.profile('smg-top-reinforcement', [[-0.093, 0.050], [0.096, 0.050], [0.091, 0.054], [-0.080, 0.054]],
    0.010, 'metalDark', { bevel: 0.0005 });
  for (const x of [-0.076, -0.017, 0.029, 0.075]) b.box('smg-stamped-crown-rib', x, 0.0515, 0,
    0.0018, 0.0014, 0.018, 'metalDark', 0.0003);
  b.profile('smg-stock-hinge-neck', [[-0.132, 0.008], [-0.106, 0.008], [-0.106, 0.023], [-0.127, 0.023]],
    0.019, 'metalDark', { bevel: 0.0012 });
  for (const side of [-1, 1]) b.fastener('smg-folding-stock-pivot', -0.117, 0.015, side * 0.0104,
    { radius: 0.0031, depth: 0.0011, side });
  b.profile('smg-front-sight-tower', [[0.151, 0.030], [0.169, 0.030], [0.165, 0.055], [0.155, 0.055]],
    0.009, 'metalDark', { bevel: 0.0005 });
  b.backPlate('smg-rear-hinge-cap', -0.112, [[-0.013, -0.004], [0.013, -0.004], [0.013, 0.026],
    [0.008, 0.036], [-0.008, 0.036], [-0.013, 0.026]], 0.003, 'metalDark');
  b.screws([[-0.079, 0.018, 0.0165], [0.07, -0.015, 0.0174]], 0.0180, true);
  b.sights('smg');
}

function machinegun(b) {
  b.receiver('machinegun-receiver', [[-0.130, -0.024], [0.179, -0.024], [0.200, -0.003], [0.198, 0.045],
    [0.167, 0.061], [-0.104, 0.061], [-0.130, 0.041]], 0.047,
  [[0.012, 0.002], [0.096, 0.002], [0.102, 0.039], [0.012, 0.039]], [0.055, 0.021], 'metal', {
    crownBase: 0.042, crownDrop: 0.47, rearStart: -0.129, rearEnd: -0.094, rearScale: 0.87,
    panels: [
      { name: 'rear-stamping-pocket', depth: 0.0013, tint: 0.74, probe: [-0.044, 0.019],
        outline: [[-0.114, 0.001], [-0.017, 0.001], [-0.006, 0.010], [-0.006, 0.032],
          [-0.099, 0.036], [-0.114, 0.026]] },
      { name: 'lower-assembly-pocket', depth: 0.0010, finish: 'metalDark', tint: 1.06, probe: [0.070, -0.014],
        outline: [[-0.112, -0.019], [0.164, -0.019], [0.174, -0.009], [-0.106, -0.009]] },
    ],
  });
  b.loft('machinegun-contoured-stock', [
    { x: -0.190, low: -0.040, high: 0.020, width: 0.021, bevel: 0.009 },
    { x: -0.174, low: -0.034, high: 0.024, width: 0.020, bevel: 0.009 },
    { x: -0.148, low: -0.013, high: 0.016, width: 0.014, bevel: 0.006 },
    { x: -0.120, low: -0.010, high: 0.022, width: 0.018, bevel: 0.005 },
  ], 'polymer');
  b.box('machinegun-stock-pad', -0.190, -0.010, 0, 0.004, 0.062, 0.043, 'metalDark', 0.001);
  b.profile('machinegun-pistol-grip', [[-0.102, -0.019], [-0.056, -0.023], [-0.074, -0.120],
    [-0.089, -0.140], [-0.119, -0.128], [-0.116, -0.100]], 0.039, 'polymer', { bevel: 0.002 });
  b.profile('machinegun-curved-magazine', [[-0.023, -0.020], [0.035, -0.020], [0.041, -0.097], [0.061, -0.144],
    [0.090, -0.177], [0.086, -0.196], [0.037, -0.198], [0.010, -0.162], [-0.013, -0.104]],
  0.047, 'polymer', { bevel: 0.0015 });
  for (const side of [-1, 1]) for (const x of [-0.008, 0.011, 0.030]) b.profile(`machinegun-magazine-flute-${side}-${x}`,
    [[x, -0.042], [x + 0.004, -0.042], [x + 0.015, -0.108], [x + 0.051, -0.175],
      [x + 0.046, -0.180], [x + 0.010, -0.108]], 0.002, 'metalDark', { bevel: 0.0005, z: side * 0.024 });
  b.loft('machinegun-feed-cover', [
    { x: -0.116, low: 0.058, high: 0.063, width: 0.010 },
    { x: -0.100, low: 0.058, high: 0.067, width: 0.0135 },
    { x: -0.044, low: 0.058, high: 0.067, width: 0.0135 },
    { x: 0.025, low: 0.058, high: 0.067, width: 0.0135 },
    { x: 0.040, low: 0.058, high: 0.064, width: 0.012 },
    { x: 0.107, low: 0.058, high: 0.064, width: 0.012 },
    { x: 0.145, low: 0.058, high: 0.061, width: 0.009 },
  ], 'metalDark', ({ low, high, width }) => [[low, -width], [high - 0.0025, -width],
    [high, -width * 0.45], [high, width * 0.45], [high - 0.0025, width], [low, width]]);
  for (const side of [-1, 1]) b.profile(`machinegun-cover-bead-${side}`,
    [[-0.095, 0.0668], [0.023, 0.0668], [0.023, 0.0678], [-0.087, 0.0678]],
    0.0013, 'metalDark', { bevel: 0.0002, z: side * 0.0045 });
  b.box('machinegun-rear-sight-boss', 0.060, 0.0643, 0, 0.044, 0.0020, 0.027, 'metalDark', 0.0004);
  b.fastener('machinegun-cover-release', -0.106, 0.0660, 0, { radius: 0.0025, axis: 'y', side: 1 });
  b.backPlate('machinegun-rear-takedown-cap', -0.131, [[-0.017, -0.018], [0.017, -0.018],
    [0.018, 0.025], [0.011, 0.040], [-0.011, 0.040], [-0.018, 0.025]], 0.003, 'metalDark');
  b.backPlate('machinegun-stock-socket-inset', -0.1330, [[-0.012, -0.014], [0.012, -0.014],
    [0.013, 0.018], [0.007, 0.029], [-0.007, 0.029], [-0.013, 0.018]], 0.0009, 'metal');
  const vents = Array.from({ length: 6 }, (_, i) => {
    const x = 0.211 + i * 0.026;
    return [[x, 0.020], [x + 0.015, 0.020], [x + 0.017, 0.041], [x + 0.002, 0.041]];
  });
  for (const side of [-1, 1]) b.profile(`machinegun-vented-handguard-${side}`,
    [[0.190, 0.003], [0.375, 0.008], [0.381, 0.047], [0.195, 0.052]], 0.004, 'metalDark',
  { bevel: 0.0008, holes: vents, z: side * 0.029 });
  b.box('machinegun-handguard-floor', 0.282, 0.005, 0, 0.185, 0.012, 0.058, 'polymer', 0.002);
  b.tube('machinegun-barrel', 0.182, 0.570, 0.03, 0.016, 0.009, 'metal');
  b.tube('machinegun-flash-hider', 0.550, 0.590, 0.03, 0.023, 0.012, 'metalDark');
  b.disk('machinegun-bore-depth', 0.562, 0.03, 0, 0.0089, 'metalDark', 'x');
  for (const x of [0.207, 0.393, 0.460]) b.tube('machinegun-barrel-collar', x - 0.006, x + 0.006, 0.03,
    x === 0.207 ? 0.022 : 0.019, 0.016, 'metalDark');
  for (const side of [-1, 1]) b.profile(`machinegun-folded-bipod-${side}`,
    [[0.343, -0.006], [0.350, -0.012], [0.512, -0.022], [0.515, -0.015]], 0.008, 'metalDark',
  { bevel: 0.0005, z: side * 0.025 });
  b.guard([[-0.062, -0.022], [-0.007, -0.023], [0.003, -0.041], [-0.012, -0.065], [-0.054, -0.063]],
    [[-0.052, -0.032], [-0.017, -0.032], [-0.007, -0.041], [-0.019, -0.055], [-0.049, -0.053]], [-0.035, -0.043]);
  b.profile('machinegun-trigger', [[-0.020, -0.025], [-0.012, -0.025], [-0.016, -0.042], [-0.027, -0.050],
    [-0.031, -0.047], [-0.022, -0.036]], 0.008, 'metal');
  b.box('machinegun-charging-handle', 0.045, 0.014, -0.031, 0.037, 0.010, 0.024, 'metalDark', 0.001);
  b.screws([[-0.088, 0.023, 0.0214], [-0.073, -0.017, 0.0217], [0.145, 0.008, 0.0227]], 0.0230, true);
  b.sights('machinegun');
}

function knife(b) {
  b.loft('knife-contoured-handle', [
    { x: -0.108, low: -0.029, high: 0.010, width: 0.019, bevel: 0.006 },
    { x: -0.093, low: -0.031, high: 0.011, width: 0.020, bevel: 0.008 },
    { x: -0.073, low: -0.030, high: 0.010, width: 0.019, bevel: 0.007 },
    { x: -0.029, low: -0.030, high: 0.011, width: 0.020, bevel: 0.007 },
    { x: 0.015, low: -0.026, high: 0.010, width: 0.018, bevel: 0.005 },
  ], 'wood', ({ low, high, width }) => Array.from({ length: 16 }, (_, i) => {
    const angle = -Math.PI + i * Math.PI / 8;
    return [(low + high) / 2 + Math.cos(angle) * (high - low) / 2, Math.sin(angle) * width];
  }));
  b.profile('knife-swept-guard', [[0.020, -0.039], [0.026, -0.040], [0.031, -0.026], [0.027, -0.011],
    [0.027, 0.028], [0.021, 0.028], [0.019, 0.003]], 0.042, 'metal', { bevel: 0.0007 });
  b.loft('knife-ground-blade', [
    { x: 0.031, low: -0.012, high: 0.013, width: 0.003 },
    { x: 0.048, low: -0.013, high: 0.014, width: 0.003 },
    { x: 0.151, low: -0.013, high: 0.014, width: 0.0028 },
    { x: 0.185, low: -0.011, high: 0.010, width: 0.0023 },
    { x: 0.220, low: -0.003, high: 0.008, width: 0.0014 },
    { x: 0.239, low: 0.0055, high: 0.0060, width: 0.0001 },
  ], 'blade', ({ low, high, width }) => [
    [low, 0], [low + (high - low) * 0.33, -width], [high - (high - low) * 0.18, -width],
    [high, 0], [high - (high - low) * 0.18, width], [low + (high - low) * 0.33, width],
  ]);
  b.profile('knife-lanyard-pommel', [[-0.115, -0.028], [-0.105, -0.029], [-0.104, 0.010], [-0.115, 0.008]],
    0.041, 'metalDark', { bevel: 0.0007, holes: [[[-0.112, -0.015], [-0.107, -0.015], [-0.107, -0.006], [-0.112, -0.006]]] });
  b.screws([[-0.079, -0.010], [-0.018, -0.010]], 0.0198);
}

/** Build a fresh owned asset; the existing viewmodel cache/batcher owns it next. */
export function createHeroWeapon(type) {
  if (!['knife', 'pistol', 'shotgun', 'smg', 'machinegun'].includes(type)) throw new RangeError(`Unknown hero weapon: ${type}`);
  const root = new THREE.Group(); root.name = `vm_${type}`;
  root.userData.heroWeapon = { version: 1, source: 'original-profile-procedural', type };
  if (HERO_WEAPON_MUZZLES[type]) root.userData.muzzle = [...HERO_WEAPON_MUZZLES[type]];
  const b = builder(root, getWeaponFinishes());
  const accent = ({ knife, pistol, shotgun, smg, machinegun })[type](b);
  if (accent) root.add(accent);
  root.userData.heroWeapon.parts = b.details;
  return root;
}
