import * as THREE from 'three';
import { DISTRICT } from '../world/district-layout.js';

const ATLAS_SIZE = 1024, ROW_HEIGHT = 128, GUTTER = 8;
const cache = new WeakMap();
const planes = new Map();
const washerPort = new THREE.CircleGeometry(0.5, 16);
washerPort.name = 'storefront-washer-door-disc';

// Reusable construction families, assigned deliberately to the existing shops.
// Floor, mass, entrance collision and mission data remain in district-layout.
export const STOREFRONT_STYLES = Object.freeze([
  { family: 'workshop', finish: 'brick', trim: 'oxblood', signY: 3.64, signHeight: 0.65, signInset: 0.46,
    bg: '#aa9d82', ink: '#473831', font: 'bold 56px Georgia, serif', rows: [6.22], columns: [0.5], window: [1.10, 1.88], sash: 'sash' },
  { family: 'deli', finish: 'brick', trim: 'sage', signY: 3.63, signHeight: 0.76, signInset: 0.65,
    bg: '#3e5046', ink: '#c8c3aa', font: 'bold 58px Georgia, serif', rows: [5.75, 8.38], columns: [0.22, 0.5, 0.78], window: [1.20, 1.78], sash: 'sash' },
  { family: 'market', finish: 'warmBrick', trim: 'sage', signY: 3.82, signHeight: 0.67, signInset: 0.95,
    bg: '#b3aa8b', ink: '#39473b', font: 'bold 58px Arial, sans-serif', rows: [5.85, 8.57, 11.16], columns: [0.22, 0.5, 0.78], window: [1.43, 1.62], sash: 'casement' },
  { family: 'pharmacy', finish: 'plaster', trim: 'ivory', signY: 3.56, signHeight: 0.80, signInset: 0.62,
    bg: '#bac1b0', ink: '#334b43', font: 'bold 60px Arial, sans-serif', rows: [5.67, 8.02], columns: [0.28, 0.72], window: [1.86, 1.65], sash: 'casement' },
  { family: 'laundry', finish: 'coolPlaster', trim: 'ivory', signY: 3.83, signHeight: 0.64, signInset: 0.84,
    bg: '#607b6f', ink: '#c4c5ad', font: 'bold 60px Arial, sans-serif', rows: [5.93, 8.74], columns: [0.21, 0.5, 0.79], window: [1.80, 1.32], sash: 'wide' },
  { family: 'barber', finish: 'brick', trim: 'oxblood', signY: 3.66, signHeight: 0.78, signInset: 1.12,
    bg: '#583e37', ink: '#c7b99d', font: 'bold 58px Georgia, serif', rows: [5.99, 8.53], columns: [0.22, 0.5, 0.78], window: [1.19, 1.72], sash: 'sash' },
  { family: 'hardware', finish: 'warmBrick', trim: 'iron', signY: 3.70, signHeight: 0.73, signInset: 1.65,
    bg: '#464e45', ink: '#c5c0a5', font: 'bold 62px Arial, sans-serif', rows: [6.0, 9.45], columns: [0.28, 0.72], window: [2.30, 1.74], sash: 'industrial' },
].map(style => Object.freeze({ ...style, rows: Object.freeze(style.rows), columns: Object.freeze(style.columns), window: Object.freeze(style.window) })));

function atlasRect(row, column = 0, columns = 1) {
  const width = ATLAS_SIZE / columns;
  return { x: width * column + GUTTER, y: row * ROW_HEIGHT + GUTTER, width: width - GUTTER * 2, height: ROW_HEIGHT - GUTTER * 2 };
}

function drawShopSign(ctx, shop, style) {
  const y = shop.id * ROW_HEIGHT;
  ctx.fillStyle = style.bg; ctx.fillRect(0, y, ATLAS_SIZE, ROW_HEIGHT);
  const ratio = (shop.x2 - shop.x1 - style.signInset) / style.signHeight;
  const typeScaleX = (ATLAS_SIZE / ROW_HEIGHT) / ratio;
  ctx.save(); ctx.translate(ATLAS_SIZE / 2, y); ctx.scale(typeScaleX, 1);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = style.ink;
  ctx.font = style.font;
  ctx.fillText(shop.name, 0, 48, (ATLAS_SIZE - 92) / typeScaleX);
  ctx.font = style.family === 'barber' ? '20px Georgia, serif' : '19px Arial, sans-serif';
  ctx.fillText(shop.sub, 0, 92, (ATLAS_SIZE - 100) / typeScaleX);
  ctx.restore();
  ctx.fillStyle = style.ink;
  if (['deli', 'barber', 'workshop'].includes(style.family)) {
    ctx.fillRect(24, y + 13, 976, 2); ctx.fillRect(24, y + 111, 976, 2);
  } else if (style.family === 'laundry') {
    ctx.fillRect(22, y + 18, 7, 92); ctx.fillRect(995, y + 18, 7, 92);
  } else if (style.family === 'hardware') {
    for (const x of [25, 980]) for (const dy of [20, 103]) ctx.fillRect(x, y + dy, 5, 5);
  }
  // Small flat paint losses, fixed at authoring time. No baked light/shadow,
  // broad random stains, alpha layers or frame-loop canvas updates.
  ctx.globalAlpha = 0.11; ctx.fillStyle = style.ink;
  for (let i = 0; i < 72; i++) {
    const x = 17 + (i * 137 + shop.id * 61) % 987;
    const dy = 16 + (i * 43 + shop.id * 17) % 95;
    ctx.fillRect(x, y + dy, 1 + i % 5, 1 + (i % 13 === 0 ? 1 : 0));
  }
  ctx.globalAlpha = 1;
}

function createAtlas() {
  const canvas = globalThis.document?.createElement('canvas');
  let texture;
  if (canvas) {
    canvas.width = canvas.height = ATLAS_SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      for (const shop of DISTRICT.shops) drawShopSign(ctx, shop, STOREFRONT_STYLES[shop.id]);
      const labels = [
        ['CLOSED', 'BACK IN THE MORNING'], ['Rx', 'PRESCRIPTIONS'], ['WASH', 'DRY · FOLD'], ['EST. 1968', 'WALK-INS WELCOME'],
      ];
      for (const [column, [title, sub]] of labels.entries()) {
        const x = column * 256, y = 7 * ROW_HEIGHT;
        ctx.fillStyle = column === 1 ? '#788d7b' : '#b6ad92'; ctx.fillRect(x, y, 256, ROW_HEIGHT);
        ctx.fillStyle = '#39473e'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = column === 1 ? 'bold 65px Georgia, serif' : 'bold 34px Arial, sans-serif';
        ctx.fillText(title, x + 128, y + 49, 220);
        ctx.font = '14px Arial, sans-serif'; ctx.fillText(sub, x + 128, y + 92, 222);
      }
      texture = new THREE.CanvasTexture(canvas);
    }
  }
  // Geometry fixtures have no DOM. The same opaque material still builds;
  // browser canvas failure also leaves a complete plain painted finish.
  if (!texture) texture = new THREE.DataTexture(new Uint8Array([160, 160, 143, 255]), 1, 1);
  texture.name = 'little-sicily-shared-sign-atlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true; texture.anisotropy = 4; texture.needsUpdate = true;
  return texture;
}

function cloneFinish(source, name, color, roughness) {
  const material = source.clone();
  material.name = 'storefront-' + name;
  material.color.setHex(color); material.roughness = roughness;
  material.envMapIntensity = Math.min(material.envMapIntensity, 0.3);
  return material;
}

export function getStorefrontMaterials(materials) {
  let shared = cache.get(materials);
  if (shared) return shared;
  const sign = new THREE.MeshStandardMaterial({ map: createAtlas(), roughness: 0.9, metalness: 0, envMapIntensity: 0.15 });
  sign.name = 'storefront-shared-painted-signs';
  sign.userData = { surfaceKind: 'wood', staticSurfaceMaps: true, textureBytes: ATLAS_SIZE ** 2 * 4,
    textureBytesWithMipmaps: 5592404, provenance: 'Original code-authored Little Sicily sign atlas; no external image or font download.' };
  const glazing = materials.glass.clone();
  glazing.name = 'storefront-quiet-glazing'; glazing.color.setHex(0x84998f);
  glazing.opacity = 0.27; glazing.roughness = 0.35; glazing.envMapIntensity = 0.44;
  shared = Object.freeze({
    brick: materials.brick,
    warmBrick: cloneFinish(materials.brick, 'warm-brick', 0xd7ccb4, 0.96),
    plaster: cloneFinish(materials.plaster, 'warm-plaster', 0xc6c2af, 0.98),
    coolPlaster: cloneFinish(materials.plaster, 'cool-plaster', 0x9dada3, 0.98),
    sage: cloneFinish(materials.wood, 'sage-painted-timber', 0x738677, 0.94),
    oxblood: cloneFinish(materials.wood, 'oxblood-painted-timber', 0x87675c, 0.93),
    ivory: cloneFinish(materials.concrete, 'ivory-trim', 0xc7c7b6, 0.95),
    iron: cloneFinish(materials.metal, 'painted-iron', 0x69766c, 0.91),
    dark: materials.tar, glass: glazing, sign,
  });
  cache.set(materials, shared);
  return shared;
}

function signPlane(row, column = 0, columns = 1) {
  const key = `${row}:${column}:${columns}`;
  if (!planes.has(key)) {
    const rect = atlasRect(row, column, columns), geometry = new THREE.PlaneGeometry(1, 1);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i,
      (rect.x + uv.getX(i) * rect.width) / ATLAS_SIZE,
      1 - (rect.y + (1 - uv.getY(i)) * rect.height) / ATLAS_SIZE);
    geometry.name = 'storefront-atlas-plane-' + key;
    planes.set(key, geometry);
  }
  return planes.get(key);
}

/**
 * Original shallow shop joinery on the already-solid, inaccessible shop mass.
 * Each part enters the street's existing per-material merge. The kit creates
 * no movement volume, room, light, animation, timer or recurring asset work.
 */
export function buildClosedStorefront({ shop, front, floor, materials, boxGeometry, pipeGeometry, pushDecor }) {
  const style = STOREFRONT_STYLES[shop.id], m = getStorefrontMaterials(materials), trim = m[style.trim];
  const width = shop.x2 - shop.x1, center = (shop.x1 + shop.x2) / 2;
  const counts = { components: 0, triangles: 0, geometryBytes: 0, windows: 0, printedPlanes: 0 };
  const usedMaterials = new Set();
  function part(geometry, material, x, y, z, w, h, d, yaw = 0) {
    pushDecor(geometry, material, x, y, z, w, h, d, yaw);
    counts.components++; counts.triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    counts.geometryBytes += Object.values(geometry.attributes).reduce((sum, a) => sum + a.array.byteLength, geometry.index?.array.byteLength ?? 0);
    usedMaterials.add(material.name || material.type);
  }
  const box = (mat, x, y, w, h, d = 0.12, offset = 0.075) => part(boxGeometry, mat, x, y, front - offset, w, h, d);
  function print(row, x, y, w, h, column = 0, columns = 1, offset = 0.192) {
    part(signPlane(row, column, columns), m.sign, x, y, front - offset, w, h, 1, Math.PI);
    counts.printedPlanes++;
  }

  function frame(x, y, w, h, frameMaterial = trim, middle = true) {
    box(m.dark, x, y, w, h, 0.042, 0.022);
    box(m.glass, x, y, w - 0.08, h - 0.07, 0.012, 0.086);
    for (const dx of [-w / 2, w / 2]) box(frameMaterial, x + dx, y, 0.07, h + 0.10, 0.13, 0.094);
    for (const dy of [-h / 2, h / 2]) box(frameMaterial, x, y + dy, w + 0.07, 0.065, 0.14, 0.095);
    if (middle) box(frameMaterial, x, y + h * 0.19, w, 0.045, 0.13, 0.095);
  }

  function door(x, w = 1.40, doorMaterial = trim) {
    box(doorMaterial, x, 1.61, w, 2.94, 0.11, 0.057);
    box(m.dark, x, 2.0, w - 0.22, 1.55, 0.018, 0.119);
    box(m.glass, x, 2.0, w - 0.25, 1.52, 0.012, 0.135);
    for (const dx of [-w / 2 - 0.045, w / 2 + 0.045]) box(doorMaterial, x + dx, 1.66, 0.09, 3.04, 0.18, 0.09);
    box(doorMaterial, x, 3.14, w + 0.18, 0.10, 0.18, 0.09);
    box(m.ivory, x, 0.64, w - 0.26, 0.65, 0.016, 0.12);
    box(m.iron, x + w * 0.30, 1.38, 0.04, 0.24, 0.06, 0.168);
    print(7, x, 2.1, 0.56, 0.23, 0, 4, 0.148);
  }

  function shutter(x, w, top = 3.05, bottom = floor + 0.03) {
    const h = top - bottom;
    box(m.iron, x, (top + bottom) / 2, w, h, 0.105, 0.061);
    // Broad folded steel courses remain legible in motion without the former
    // densely repeated 18 cm strips across almost every storefront.
    for (let y = bottom + 0.18; y < top - 0.05; y += 0.27) box(m.iron, x, y, w - 0.03, 0.038, 0.04, 0.128);
    for (const dx of [-w / 2, w / 2]) box(trim, x + dx, (top + bottom) / 2, 0.10, h + 0.1, 0.18, 0.09);
    box(trim, x, top + 0.09, w + 0.20, 0.20, 0.24, 0.085);
    box(m.dark, x, bottom + 0.15, 0.32, 0.033, 0.018, 0.119);
  }

  function display(x, w, kind, h = 2.18, y = 1.91) {
    frame(x, y, w, h, trim, true);
    box(trim, x, y - h / 2 - 0.20, w + 0.10, 0.33, 0.18, 0.075);
    box(m.ivory, x, y - h / 2 - 0.012, w + 0.18, 0.075, 0.25, 0.115);
    const glassBack = 0.049;
    if (kind === 'shelves') {
      for (const shelfY of [1.22, 1.81, 2.4]) {
        box(m.oxblood, x, shelfY, w - 0.20, 0.06, 0.054, glassBack);
        for (let i = 0; i < 5; i++) {
          box(i % 2 ? m.sage : m.ivory, x + (i - 2) * w * 0.16, shelfY + 0.15,
            0.14 + (i % 2) * 0.10, 0.23, 0.043, glassBack);
        }
      }
    } else if (kind === 'blind') {
      box(m.ivory, x, y + 0.12, w - 0.15, h - 0.48, 0.016, glassBack);
      for (const dy of [-0.38, 0.06, 0.50]) box(m.sage, x, y + dy, w - 0.18, 0.018, 0.016, glassBack + 0.012);
      print(7, x, y - 0.08, 0.58, 0.42, 1, 4, 0.094);
    } else if (kind === 'laundry') {
      // Closed blinds and a low row of washer-door silhouettes suggest the
      // occupied shop behind glass; they do not create an accessible room.
      box(m.ivory, x, y + 0.61, w - 0.13, 0.84, 0.015, glassBack);
      for (const dx of [-w * 0.25, w * 0.25]) {
        box(m.ivory, x + dx, 1.12, w * 0.40, 0.65, 0.044, glassBack);
        part(washerPort, m.dark, x + dx, 1.13, front - glassBack - 0.035, 0.40, 0.40, 1, Math.PI);
        box(m.iron, x + dx, 1.44, w * 0.20, 0.035, 0.015, glassBack + 0.027);
      }
      print(7, x, y + 0.38, 0.85, 0.30, 2, 4, 0.094);
    } else if (kind === 'barber') {
      box(m.ivory, x, y + 0.67, w - 0.12, 0.72, 0.015, glassBack);
      box(m.oxblood, x, 1.21, 0.61, 0.65, 0.035, glassBack);
      box(m.iron, x, 0.78, 0.12, 0.29, 0.039, glassBack);
      box(m.iron, x, 0.65, 0.61, 0.055, 0.041, glassBack);
      print(7, x, y + 0.38, 0.83, 0.29, 3, 4, 0.094);
    }
  }

  // Ground-floor timber/enamel framing establishes occupied shop widths;
  // every below-head part projects less than the original 30 cm stone sills.
  for (const x of [shop.x1 + 0.15, shop.x2 - 0.15]) box(trim, x, 1.78, 0.30, 3.28, 0.23, 0.067);
  box(trim, center, style.signY, width - style.signInset + 0.15, style.signHeight + 0.13, 0.20, 0.09);
  print(shop.id, center, style.signY, width - style.signInset, style.signHeight);
  if (style.family === 'workshop') {
    shutter(center, width - 0.78);
    box(m.oxblood, center, 0.82, width - 0.78, 0.10, 0.05, 0.15);
  } else if (style.family === 'deli') {
    display(shop.x1 + 2.60, 4.30, 'shelves'); door(shop.x2 - 1.49, 1.42);
    box(trim, shop.x1 + 5.35, 1.72, 0.62, 3.04, 0.16, 0.061);
  } else if (style.family === 'market') {
    door(center, 1.35);
    for (const x of [shop.x1 + 1.9, shop.x2 - 1.9]) {
      frame(x, 2.74, 2.90, 0.70, trim, false); shutter(x, 2.90, 2.31);
    }
    box(trim, center, 3.27, width - 0.36, 0.12, 0.30, 0.09);
  } else if (style.family === 'pharmacy') {
    door(shop.x1 + 1.27, 1.40, m.sage);
    for (const x of [shop.x1 + 4.10, shop.x1 + 6.72]) display(x, 2.23, 'blind', 2.18, 1.91);
  } else if (style.family === 'laundry') {
    door(center, 1.38, m.sage);
    for (const x of [shop.x1 + 1.96, shop.x2 - 1.96]) display(x, 2.75, 'laundry');
  } else if (style.family === 'barber') {
    door(center, 1.40);
    for (const x of [shop.x1 + 2.0, shop.x2 - 2.0]) display(x, 2.50, 'barber');
    for (let i = 0; i < 7; i++) box(i % 2 ? m.oxblood : m.ivory, center + 1.0, 1.73 + i * 0.135, 0.12, 0.135, 0.15, 0.16);
    for (const y of [1.63, 2.65]) box(m.iron, center + 1.0, y, 0.18, 0.07, 0.19, 0.14);
  } else {
    shutter(shop.x1 + 3.32, 5.64); door(shop.x2 - 1.38, 1.4, m.iron);
    box(m.ivory, shop.x1 + 3.32, 1.59, 0.14, 2.88, 0.024, 0.131);
  }

  // Window rhythms belong to each building: tall sash, paired casement or
  // broad industrial glazing. Curtains/blinds vary deterministically within
  // that construction; no random bright emissive windows compete with targets.
  for (const [row, y] of style.rows.entries()) for (const [column, fraction] of style.columns.entries()) {
    const x = shop.x1 + width * fraction, [w, h] = style.window;
    frame(x, y, w, h, style.sash === 'sash' ? trim : m.iron, style.sash === 'sash');
    box(m.ivory, x, y - h / 2 - 0.095, w + 0.27, 0.14, 0.28, 0.105);
    box(m.ivory, x, y + h / 2 + 0.083, w + 0.22, 0.105, 0.19, 0.068);
    if (style.sash !== 'sash') {
      const offsets = style.sash === 'industrial' ? [-w / 6, w / 6] : [0];
      for (const dx of offsets) box(m.iron, x + dx, y, 0.045, h, 0.13, 0.095);
      if (style.sash === 'industrial') box(m.iron, x, y + h * 0.14, w, 0.045, 0.13, 0.095);
    }
    const occupancy = (shop.id + row * 2 + column) % 4;
    if (occupancy === 0 || occupancy === 3) {
      box(occupancy === 0 ? m.ivory : m.sage, x, y + h * 0.18, w - 0.12, h * 0.54, 0.012, 0.053);
    } else if (occupancy === 1) {
      for (const dx of [-w * 0.32, w * 0.32]) box(m.ivory, x + dx, y, w * 0.22, h - 0.09, 0.012, 0.053);
    }
    counts.windows++;
  }
  // Selective vertical masonry and different cornice depths interrupt the
  // old continuous belt. No new volume reaches the pavement or bakery opening.
  const beltY = style.family === 'market' ? 4.45 : style.family === 'laundry' ? 4.39 : 4.20;
  box(m.ivory, center, beltY, width - 0.04, style.family === 'pharmacy' ? 0.22 : 0.13, 0.26, 0.065);
  box(m.ivory, center, shop.height - 0.035, width + 0.02, 0.19, 0.31, 0.085);
  if (style.family === 'pharmacy' || style.family === 'hardware') {
    for (const x of [shop.x1 + 0.17, shop.x2 - 0.17]) box(m.ivory, x, (shop.height + 4.32) / 2, 0.22, shop.height - 4.32, 0.17, 0.054);
  }
  const pipeX = shop.x2 - 0.33;
  part(pipeGeometry, m.iron, pipeX, (shop.height + floor) / 2, front - 0.17, 0.047, shop.height - floor, 0.047);
  for (let y = 1.15; y < shop.height; y += 2.8) box(m.iron, pipeX, y, 0.16, 0.065, 0.18, 0.10);
  box(m.iron, shop.x1 + 0.46, 2.55, 0.27, 0.39, 0.15, 0.105);
  return { family: style.family, ...counts, materials: [...usedMaterials], addedLights: 0, runtimeWork: false };
}
