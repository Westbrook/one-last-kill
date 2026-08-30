import * as THREE from 'three';
import { getFurnitureMaterials } from '../render/furniture-materials.js';
import { furnitureBox } from '../render/furniture-geometry.js';
import { applyBoxWorldUV } from '../render/world-uv.js';
import { getInteriorStoryMaterials, INTERIOR_STORY_ATLAS } from '../render/interior-story-materials.js';

const cache = new Map();
function cached(key, build) {
  if (!cache.has(key)) {
    const geometry = build();
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    cache.set(key, geometry);
  }
  return cache.get(key);
}

function mapCell(geometry, cell, predicate = () => true) {
  const { uv, normal } = geometry.attributes;
  for (let i = 0; i < uv.count; i++) {
    if (!predicate(normal, i)) continue;
    uv.setXY(i, THREE.MathUtils.lerp(cell.uMin, cell.uMax, uv.getX(i)),
      THREE.MathUtils.lerp(cell.vMin, cell.vMax, uv.getY(i)));
  }
  return geometry;
}

/** Atlas UVs belong to the shape, never to the unit-box world-UV path. */
export function storyBoxGeometry(kind = 'spine', variant = 0) {
  return cached(`box:${kind}:${variant}`, () => {
    const atlas = INTERIOR_STORY_ATLAS.books;
    const cell = kind === 'spine' || kind === 'cover' ? atlas.spines[variant % atlas.spines.length] : atlas[kind];
    if (!cell) throw new RangeError(`Unknown story atlas cell: ${kind}`);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.type = 'StoryBoxGeometry';
    // Standing books expose page edges above and below a printed spine.
    if (kind === 'spine') {
      mapCell(geometry, atlas.pages, (normal, i) => Math.abs(normal.getY(i)) > 0.5);
      mapCell(geometry, cell, (normal, i) => Math.abs(normal.getY(i)) < 0.5);
    } else mapCell(geometry, cell);
    geometry.userData.story = { kind, variant };
    return geometry;
  });
}

function rugGeometry(variant) {
  return cached(`rug:${variant}`, () => {
    const geometry = mapCell(new THREE.BoxGeometry(1, 1, 1), INTERIOR_STORY_ATLAS.rugs[variant]);
    geometry.type = 'StoryRugGeometry'; geometry.userData.story = { kind: 'rug', variant };
    return geometry;
  });
}

function vesselGeometry(kind) {
  return cached(`vessel:${kind}`, () => {
    const profiles = {
      canister: [[0, 0], [0.045, 0], [0.05, 0.01], [0.05, 0.125], [0.043, 0.14], [0, 0.14]],
      bowl: [[0, 0], [0.027, 0], [0.041, 0.015], [0.069, 0.055], [0.066, 0.06], [0.059, 0.052], [0.036, 0.018], [0, 0.012]],
      lid: [[0, 0], [0.051, 0], [0.055, 0.007], [0.05, 0.014], [0.015, 0.02], [0.011, 0.027], [0, 0.027]],
      rollingPin: [[0, -0.21], [0.014, -0.21], [0.014, -0.145], [0.03, -0.13], [0.03, 0.13], [0.014, 0.145], [0.014, 0.21], [0, 0.21]],
    };
    const geometry = new THREE.LatheGeometry(profiles[kind].map(point => new THREE.Vector2(...point)), 16);
    if (kind === 'rollingPin') {
      const { position, uv } = geometry.attributes;
      for (let i = 0; i < position.count; i++) uv.setXY(i, position.getY(i) / 0.6, uv.getX(i) * Math.PI * 0.06 / 0.6);
      geometry.rotateZ(Math.PI / 2);
    }
    geometry.userData.story = { kind };
    return geometry;
  });
}

function canisterLabelGeometry(kind) {
  return cached(`canister-label:${kind}`, () => {
    const positions = [], normals = [], uv = [], indices = [];
    for (const y of [-0.025, 0.025]) for (let i = 0; i <= 8; i++) {
      const angle = -0.55 + i / 8 * 1.1, x = Math.sin(angle), z = Math.cos(angle);
      positions.push(x * 0.0504, y, z * 0.0504); normals.push(x, 0, z);
      uv.push(i / 8, y < 0 ? 0 : 1);
    }
    for (let i = 0; i < 8; i++) indices.push(i, i + 1, i + 9, i + 1, i + 10, i + 9);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    mapCell(geometry, INTERIOR_STORY_ATLAS.books[kind]);
    geometry.userData.story = { kind: 'canister-label' };
    return geometry;
  });
}

function foldedClothGeometry(width, depth) {
  return cached(`folded:${width}:${depth}`, () => {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, 0);
    for (let i = 0; i <= 12; i++) {
      const x = -width / 2 + width * i / 12;
      shape.lineTo(x, 0.022 + Math.sin(i * Math.PI / 3) * 0.0035 + Math.sin(i * Math.PI / 6) * 0.002);
    }
    shape.lineTo(width / 2, 0); shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
    geometry.translate(0, 0, -depth / 2);
    applyBoxWorldUV(geometry, 0.3);
    geometry.userData.story = { kind: 'folded-cloth', width, depth };
    return geometry;
  });
}

/** Static small groups only. The caller supplies real supporting top heights. */
export function createInteriorStoryDetails({ pushDecor, materials }) {
  const finishes = getFurnitureMaterials(), story = getInteriorStoryMaterials();

  function bookcaseContents(fixture, id) {
    const { width, height, depth, part } = fixture;
    const variant = id?.includes('bedroom') ? 2 : id?.startsWith('neighbor') ? 1 : 0;
    const available = width * 0.84, squeeze = Math.min(1, available / 0.72);
    const shelfHeights = [0.055, 0.275, 0.495, 0.715];
    const actual = (geometry, material, x, y, z, w, h, d) =>
      part(geometry, material, x / width, y / height, z / depth, w / width, h / height, d / depth);
    function uprightGroup(start, bottom, count, seed) {
      let x = start;
      for (let index = 0; index < count; index++) {
        const cover = (index * 3 + seed) % 8;
        const w = [0.029, 0.044, 0.035, 0.051, 0.033, 0.040][index % 6] * squeeze;
        const h = Math.min(height * 0.175, [0.25, 0.285, 0.22, 0.265, 0.30, 0.24][(index + seed) % 6]);
        actual(storyBoxGeometry('spine', cover), story.books, x + w / 2, bottom + h / 2,
          depth * 0.533, w, h, depth * 0.040);
        x += w + 0.004;
      }
      return x;
    }
    function stack(x, bottom, count, seed) {
      let y = bottom;
      for (let index = 0; index < count; index++) {
        const w = Math.min(0.27 - index * 0.018, available * 0.37), h = 0.024 + index * 0.004;
        actual(storyBoxGeometry('cover', (seed + index * 2) % 8), story.books,
          x + index * 0.007, y + 0.002, depth * 0.533, w, 0.004, depth * 0.048);
        actual(storyBoxGeometry('pages'), story.books,
          x + index * 0.007, y + h / 2, depth * 0.533, w - 0.008, h - 0.008, depth * 0.043);
        actual(storyBoxGeometry('cover', (seed + index * 2) % 8), story.books,
          x + index * 0.007, y + h - 0.002, depth * 0.533, w, 0.004, depth * 0.048);
        y += h;
      }
    }
    for (const [row, shelf] of shelfHeights.entries()) {
      const bottom = (shelf + 0.014) * height, mode = (row + variant) % 4;
      const left = -available / 2 + 0.022, right = available / 2 - Math.min(0.145, available * 0.205);
      if (mode === 2) {
        stack(left + Math.min(0.135, available * 0.19), bottom, 3, row + variant);
        uprightGroup(right - 0.07 * squeeze, bottom, 3, row + variant + 2);
      } else {
        uprightGroup(left, bottom, mode === 1 ? 3 : 5, row + variant);
        if (mode === 1) {
          // One small framed landscape, on a wide foot, gives the shelf a
          // civilian purpose without a new image asset or a floating frame.
          actual(storyBoxGeometry('cover', 2), story.books, right, bottom + 0.009, depth * 0.535,
            0.165 * squeeze, 0.018, depth * 0.055);
          actual(storyBoxGeometry('cover', 2), story.books, right, bottom + 0.105, depth * 0.535,
            0.14 * squeeze, 0.174, depth * 0.032);
          actual(storyBoxGeometry('postcard'), story.books, right, bottom + 0.105, depth * 0.552,
            0.119 * squeeze, 0.147, depth * 0.004);
        } else stack(right, bottom, mode === 3 ? 2 : 3, row + variant + 1);
      }
      if (available > 1.25) uprightGroup(-0.13, bottom, 5, row + 5);
    }
  }

  function fridgeNote(fixture, variant) {
    fixture.part(storyBoxGeometry(variant ? 'postcard' : 'note'), story.books,
      0.20, 0.81, 0.543, 0.20, 0.11, 0.002);
  }

  function rug({ x, z, floorY, width, depth, variant = 'warm' }) {
    pushDecor(rugGeometry(variant), story.rugs, x, floorY + 0.009, z, width, 0.012, depth);
  }

  function foldedThrow({ x, z, topY, width, variant = 0 }) {
    const material = variant ? story.upholsteryWarm : finishes.linen;
    pushDecor(foldedClothGeometry(width, 0.35), material, x, topY, z, 1, 1, 1);
    pushDecor(foldedClothGeometry(width - 0.018, 0.22), material, x + 0.006, topY + 0.020, z - 0.045, 1, 0.6, 1);
  }

  function closedBook({ x, z, topY, width = 0.29, depth = 0.21, variant = 0, yaw = 0 }) {
    for (const [kind, y, w, h, d] of [['cover', 0.002, width, 0.004, depth],
      ['pages', 0.015, width - 0.009, 0.022, depth - 0.009], ['cover', 0.028, width, 0.004, depth]]) {
      pushDecor(storyBoxGeometry(kind, variant), story.books, x, topY + y, z, w, h, d, yaw);
    }
  }

  function kitchenStillLife({ x, z, topY, yaw = 0, variant = 0 }) {
    const c = Math.cos(yaw), s = Math.sin(yaw), enamel = materials.enamel ?? finishes.linen;
    const place = (geometry, material, px, py, pz, sx = 1, sy = 1, sz = 1) =>
      pushDecor(geometry, material, x + px * c + pz * s, topY + py, z - px * s + pz * c, sx, sy, sz, yaw);
    // A board, one ceramic bowl and two labelled pantry tins form a single
    // useful work area. Every base is supported, with no loose floor clutter.
    place(furnitureBox(0.30, 0.016, 0.21, 0.006, 0.6), finishes.wood, 0.095, 0.008, 0.025);
    place(vesselGeometry('bowl'), enamel, 0.12, 0.016, 0.025);
    for (const [index, px, pz, scale] of [[0, -0.13, -0.065, 1], [1, -0.21, 0.055, 0.78]]) {
      place(vesselGeometry('canister'), enamel, px, 0, pz, scale, scale, scale);
      place(vesselGeometry('lid'), finishes.hardware, px, 0.14 * scale, pz, scale, scale, scale);
      place(canisterLabelGeometry(index === variant ? 'label' : 'note'), story.books,
        px, 0.074 * scale, pz, scale, scale, scale);
    }
  }

  function bakeryPreparation({ x, z, topY, yaw = 0 }) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const place = (geometry, material, px, py, pz, sx = 1, sy = 1, sz = 1) =>
      pushDecor(geometry, material, x + px * c + pz * s, topY + py, z - px * s + pz * c, sx, sy, sz, yaw);
    place(furnitureBox(0.58, 0.018, 0.34, 0.008, 0.6), finishes.wood, 0, 0.009, 0);
    place(vesselGeometry('rollingPin'), finishes.wood, -0.015, 0.048, -0.095);
    place(vesselGeometry('bowl'), materials.enamel ?? finishes.linen, 0.18, 0.018, 0.075, 1.15, 1.15, 1.15);
    place(storyBoxGeometry('note'), story.books, -0.11, 0.0195, 0.068, 0.18, 0.003, 0.12);
  }

  return { bookcaseContents, fridgeNote, rug, foldedThrow, closedBook, kitchenStillLife, bakeryPreparation, materials: story };
}

export function interiorStoryGeometryBudget() {
  let triangles = 0, bytes = 0;
  for (const geometry of cache.values()) {
    triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    bytes += Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
    bytes += geometry.index?.array.byteLength ?? 0;
  }
  return { geometries: cache.size, triangles, bytes };
}
